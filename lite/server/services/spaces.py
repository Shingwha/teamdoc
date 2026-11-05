"""空间（沿用 /api/projects 路径）、成员与统计服务。"""
from sqlalchemy import func
from sqlalchemy.orm import Session as DbSession

from db import utcnow
from errors import (CONFLICT, FORBIDDEN, NOT_FOUND, SPACE_ARCHIVED, VALIDATION,
                    bad_request, err)
from http_util import bool_field, color_field, id_field, quota_field, str_field
from models import (Doc, DocVersion, File, FileChange, FileVersion, Folder,
                    Project, ProjectMember, User)
from security.context import (AuthContext, ensure_space_mutable, get_project_or_404,
                              is_project_owner_or_admin,
                              project_role_and_membership)
from serialize import iso
from serialize import project_json as project_shape
from serialize import user_json
from services import notifications, versions
from services.users import login_status

ROLES = ("OWNER", "ADMIN", "EDITOR", "VIEWER")
JOIN_ROLES = ("VIEWER", "EDITOR")
ROLE_HINT = "role 必须为 OWNER/ADMIN/EDITOR/VIEWER"
LAST_OWNER_MSG = "项目至少需要一名所有者,请先转让所有权"
ROLE_LABELS = {"OWNER": "所有者", "ADMIN": "管理员",
               "EDITOR": "编辑者", "VIEWER": "只读成员"}


def batch_stats(db: DbSession, ids) -> dict:
    ids = list(ids)
    if not ids:
        return {}
    member_counts = dict(db.query(ProjectMember.project_id, func.count())
                         .filter(ProjectMember.project_id.in_(ids))
                         .group_by(ProjectMember.project_id).all())
    doc_agg = {pid: (cnt, last) for pid, cnt, last in
               (db.query(Doc.project_id, func.count(), func.max(Doc.updated_at))
                .filter(Doc.project_id.in_(ids), Doc.deleted_at.is_(None))
                .group_by(Doc.project_id).all())}
    file_agg = {pid: (sz, last) for pid, sz, last in
                (db.query(File.project_id, func.coalesce(func.sum(File.size), 0),
                          func.max(File.updated_at))
                 .filter(File.project_id.in_(ids), File.deleted_at.is_(None))
                 .group_by(File.project_id).all())}
    out = {}
    for pid in ids:
        d_cnt, d_last = doc_agg.get(pid, (0, None))
        f_sz, f_last = file_agg.get(pid, (0, None))
        lasts = [x for x in (d_last, f_last) if x is not None]
        out[pid] = {"memberCount": member_counts.get(pid, 0), "docCount": d_cnt,
                    "lastUpdatedAt": max(lasts) if lasts else None,
                    "storageBytes": int(f_sz)}
    return out


def project_json(db: DbSession, p: Project, user: User,
                 stats: dict | None = None) -> dict:
    s = stats if stats is not None else batch_stats(db, [p.id]).get(p.id, {})
    my_role, is_member = project_role_and_membership(db, p.id, user)
    return project_shape(p, face="member", my_role=my_role, is_member=is_member, stats=s)


def visible_project_ids(db: DbSession, user: User, *, site_wide: bool = False) -> set:
    ids = {m.project_id for m in db.query(ProjectMember).filter_by(user_id=user.id).all()}
    if site_wide and user.is_admin:
        ids |= {p for (p,) in db.query(Project.id)
                .filter(Project.is_personal.is_(False)).all()}
    return ids


def _role_label(role: str) -> str:
    return ROLE_LABELS.get(role, role)


def _notify_space_added(db: DbSession, p: Project, user_id: str, role: str,
                        actor_id: str) -> None:
    if user_id == actor_id:
        return
    notifications.notify(
        db, user_id, "space_added",
        f"你已加入空间「{p.name}」（{_role_label(role)}）",
        body=f"你的角色：{_role_label(role)}",
        link=f"#/p/{p.id}/home")


def _member_json(user: User, role: str, *, created_at=None,
                 last_active: str | None = None) -> dict:
    return {"userId": user.id, "role": role,
            "createdAt": iso(created_at), "lastActiveAt": last_active,
            "user": user_json(user, face="member")}


def _require_manageable(p: Project) -> None:
    if p.is_personal:
        err(403, FORBIDDEN, "个人空间不可管理成员")


def _grant_owner_guard(db: DbSession, project_id: str, user: User,
                       becoming_owner: bool) -> None:
    if becoming_owner and not is_project_owner_or_admin(db, project_id, user):
        err(403, FORBIDDEN, "只有项目所有者才能授予所有者")


def _owner_count(db: DbSession, project_id: str) -> int:
    return db.query(ProjectMember).filter_by(project_id=project_id, role="OWNER").count()


def _is_last_owner(db: DbSession, project_id: str, m: ProjectMember) -> bool:
    return m.role == "OWNER" and _owner_count(db, project_id) <= 1


def _create_membership(db: DbSession, project_id: str, user: User, role: str,
                       *, project: Project | None = None,
                       actor_id: str | None = None):
    if db.query(ProjectMember).filter_by(project_id=project_id, user_id=user.id).first():
        err(409, CONFLICT, "该用户已是项目成员")
    row = ProjectMember(project_id=project_id, user_id=user.id, role=role)
    db.add(row)
    if project is not None:
        _notify_space_added(db, project, user.id, role, actor_id or "")
    db.commit()
    return row


def discover_projects(db: DbSession, ctx: AuthContext) -> list:
    rows = db.query(Project).filter(Project.visibility == "public",
                                    Project.is_personal.is_(False),
                                    Project.archived_at.is_(None)).all()
    stats = batch_stats(db, [p.id for p in rows])
    items = [project_json(db, p, ctx.user, stats.get(p.id)) for p in rows]
    items.sort(key=lambda x: x.get("lastUpdatedAt") or "", reverse=True)
    return items


def _invites(db: DbSession, payload: dict) -> list[tuple[User, str]]:
    """创建空间时的批量邀请：全部校验通过后才建空间，失败整笔回滚。"""
    raw = payload.get("members")
    if raw is None:
        return []
    if not isinstance(raw, list):
        bad_request("members 必须为数组")
    if len(raw) > 200:
        bad_request("members 一次最多 200 人")
    out: list[tuple[User, str]] = []
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, dict):
            bad_request("members 每项必须为 {userId, role}")
        user_id = id_field(item, "userId", required=True)
        role = str_field(item, "role", 10, default="VIEWER") or "VIEWER"
        if role not in ROLES:
            bad_request(ROLE_HINT)
        if user_id in seen:
            bad_request("members 中用户重复")
        seen.add(user_id)
        user = db.get(User, user_id)
        if not user:
            err(404, NOT_FOUND, "用户不存在")
        if user.is_disabled:
            bad_request("不能邀请已禁用用户")
        out.append((user, role))
    return out


def create_project(db: DbSession, payload: dict, ctx: AuthContext) -> dict:
    name = str_field(payload, "name", 100, required=True)
    description = str_field(payload, "description", 5000)
    color = color_field(payload, "color") if "color" in payload else None
    quota = quota_field(payload) if "quotaBytes" in payload else None
    invites = _invites(db, payload)
    p = Project(name=name, description=description, created_by=ctx.user.id,
                color=color, quota_bytes=quota)
    db.add(p)
    db.flush()
    db.add(ProjectMember(project_id=p.id, user_id=ctx.user.id, role="OWNER"))
    for user, role in invites:
        if user.id == ctx.user.id:
            continue  # 创建者固定 OWNER，邀请列表里重复出现时不降级也不报错
        db.add(ProjectMember(project_id=p.id, user_id=user.id, role=role))
        _notify_space_added(db, p, user.id, role, ctx.user.id)
    db.commit()
    return project_json(db, p, ctx.user)


def list_projects(db: DbSession, all_flag: str, archived_flag: str,
                  ctx: AuthContext) -> list:
    ids = visible_project_ids(db, ctx.user, site_wide=all_flag == "1" and ctx.user.is_admin)
    if not ids:
        return []
    q = db.query(Project).filter(Project.id.in_(ids))
    if archived_flag == "1":
        q = q.filter(Project.archived_at.isnot(None))
    elif not (all_flag == "1" and ctx.user.is_admin):
        # 默认列表隐藏归档空间；管理员 all=1 的管理口径包含它们。
        q = q.filter(Project.archived_at.is_(None))
    rows = q.order_by(Project.is_personal.desc(), Project.created_at.asc()).all()
    stats = batch_stats(db, [p.id for p in rows])
    return [project_json(db, p, ctx.user, stats.get(p.id)) for p in rows]


def get_project(db: DbSession, project_id: str, ctx: AuthContext) -> dict:
    return project_json(db, get_project_or_404(db, project_id), ctx.user)


def patch_project(db: DbSession, project_id: str, payload: dict,
                  ctx: AuthContext) -> dict:
    p = get_project_or_404(db, project_id)
    archived_flag = None
    if "archived" in payload:
        archived_flag = bool_field(payload, "archived")
    # 归档空间的唯一写入口是 "archived": false（解除归档）；其余字段即使与它同批
    # 提交，也只在这条解除归档路径上生效。不能只靠前端隐藏。
    if p.archived_at is not None and archived_flag is not False:
        err(403, SPACE_ARCHIVED, "空间已归档，请先解除归档再修改")
    if archived_flag is not None:
        if p.is_personal:
            err(403, FORBIDDEN, "个人空间不可归档")
        if archived_flag and p.archived_at is None:
            p.archived_at = utcnow()
        elif not archived_flag:
            p.archived_at = None
    if "name" in payload:
        p.name = str_field(payload, "name", 100, required=True)
    if "description" in payload:
        p.description = str_field(payload, "description", 5000)
    if "color" in payload:
        p.color = color_field(payload, "color")
    if "quotaBytes" in payload:
        p.quota_bytes = quota_field(payload)
    if "isPublic" in payload:
        if p.is_personal:
            err(403, FORBIDDEN, "个人空间不可公开")
        p.visibility = "public" if payload["isPublic"] else "private"
    if "joinRole" in payload:
        role = str_field(payload, "joinRole", 10, required=True)
        if role not in JOIN_ROLES:
            bad_request("joinRole 必须为 VIEWER/EDITOR")
        p.join_role = role
    db.commit()
    return project_json(db, p, ctx.user)


def transfer_project(db: DbSession, project_id: str, payload: dict,
                     ctx: AuthContext) -> dict:
    """原子转让：目标升 OWNER、原 OWNER 降 ADMIN，同一事务提交。"""
    p = get_project_or_404(db, project_id)
    if p.is_personal:
        err(403, FORBIDDEN, "个人空间不可转让")
    target_id = id_field(payload, "userId", required=True)
    if target_id == ctx.user.id:
        bad_request("不能把空间转让给自己")
    caller = db.query(ProjectMember).filter_by(
        project_id=project_id, user_id=ctx.user.id).first()
    if not caller or caller.role != "OWNER":
        err(403, FORBIDDEN, "仅空间所有者可转让所有权")
    target = db.get(User, target_id)
    if not target:
        err(404, NOT_FOUND, "用户不存在")
    if target.is_disabled:
        err(400, VALIDATION, "不能转让给已禁用用户")
    membership = db.query(ProjectMember).filter_by(
        project_id=project_id, user_id=target_id).first()
    if not membership:
        err(409, CONFLICT, "目标用户不是空间成员")
    if membership.role == "OWNER":
        err(409, CONFLICT, "该用户已是空间所有者")
    membership.role = "OWNER"
    caller.role = "ADMIN"
    link = f"#/p/{project_id}/home"
    notifications.notify(
        db, target_id, "owner_transferred",
        f"你已成为「{p.name}」的所有者", body="空间所有权已转让给你", link=link)
    notifications.notify(
        db, ctx.user.id, "owner_transferred",
        f"「{p.name}」已转让，你现在的角色是{_role_label('ADMIN')}",
        body=f"你现在的角色：{_role_label('ADMIN')}", link=link)
    db.commit()
    return project_json(db, p, ctx.user)


def delete_project(db: DbSession, project_id: str, ctx: AuthContext) -> dict:
    p = get_project_or_404(db, project_id)
    if p.is_personal:
        err(403, FORBIDDEN, "个人空间不可删除")
    if not is_project_owner_or_admin(db, project_id, ctx.user):
        err(403, FORBIDDEN, "仅项目所有者或全局管理员可删除项目")
    doc_ids = [d.id for d in db.query(Doc.id).filter_by(project_id=project_id).all()]
    if doc_ids:
        db.query(DocVersion).filter(DocVersion.doc_id.in_(doc_ids)).delete(synchronize_session=False)
        db.query(Doc).filter(Doc.id.in_(doc_ids)).delete(synchronize_session=False)
    file_ids = [fid for (fid,) in db.query(File.id).filter_by(project_id=project_id).all()]
    paths = versions.file_paths(db, file_ids)
    if file_ids:
        db.query(FileVersion).filter(FileVersion.file_id.in_(file_ids)).delete(synchronize_session=False)
        db.query(FileChange).filter(FileChange.file_id.in_(file_ids)).delete(synchronize_session=False)
        db.query(File).filter(File.id.in_(file_ids)).delete(synchronize_session=False)
    db.query(FileChange).filter_by(space_id=project_id).delete(synchronize_session=False)
    db.query(Folder).filter_by(project_id=project_id).delete(synchronize_session=False)
    db.query(ProjectMember).filter_by(project_id=project_id).delete(synchronize_session=False)
    db.delete(p)
    db.commit()
    versions.unlink_unreferenced(db, paths)
    return {"ok": True, "removedFiles": len(file_ids)}


def list_members(db: DbSession, project_id: str) -> list:
    rows = (db.query(ProjectMember, User).join(User, User.id == ProjectMember.user_id)
            .filter(ProjectMember.project_id == project_id)
            .order_by(ProjectMember.created_at.asc()).all())
    status = login_status(db, [u for _m, u in rows])
    return [_member_json(u, m.role, created_at=m.created_at,
                         last_active=status.get(u.id, {}).get("lastLoginAt"))
            for m, u in rows]


def add_member(db: DbSession, project_id: str, payload: dict, ctx: AuthContext) -> dict:
    p = get_project_or_404(db, project_id)
    _require_manageable(p)
    user_id = id_field(payload, "userId", required=True)
    role = str_field(payload, "role", 10, default="VIEWER") or "VIEWER"
    if role not in ROLES:
        bad_request(ROLE_HINT)
    _grant_owner_guard(db, project_id, ctx.user, role == "OWNER")
    user = db.query(User).filter_by(id=user_id).first()
    if not user:
        err(404, NOT_FOUND, "用户不存在")
    m = _create_membership(db, project_id, user, role,
                           project=p, actor_id=ctx.user.id)
    status = login_status(db, [user])
    return _member_json(user, role, created_at=m.created_at,
                        last_active=status.get(user.id, {}).get("lastLoginAt"))


def patch_member(db: DbSession, project_id: str, user_id: str, payload: dict,
                 ctx: AuthContext) -> dict:
    p = get_project_or_404(db, project_id)
    _require_manageable(p)
    m = db.query(ProjectMember).filter_by(project_id=project_id, user_id=user_id).first()
    if not m:
        err(404, NOT_FOUND, "成员不存在")
    role = str_field(payload, "role", 10, required=True)
    if role not in ROLES:
        bad_request(ROLE_HINT)
    _grant_owner_guard(db, project_id, ctx.user, role == "OWNER" and m.role != "OWNER")
    if _is_last_owner(db, project_id, m) and role != "OWNER":
        err(409, CONFLICT, LAST_OWNER_MSG)
    changed = role != m.role
    m.role = role
    if changed and user_id != ctx.user.id:
        notifications.notify(
            db, user_id, "role_changed",
            f"你在空间「{p.name}」中的角色已变更为{_role_label(role)}",
            body=f"新角色：{_role_label(role)}",
            link=f"#/p/{project_id}/home")
    db.commit()
    return {"userId": user_id, "role": role}


def remove_member(db: DbSession, project_id: str, user_id: str) -> dict:
    _require_manageable(get_project_or_404(db, project_id))
    m = db.query(ProjectMember).filter_by(project_id=project_id, user_id=user_id).first()
    if not m:
        err(404, NOT_FOUND, "成员不存在")
    if _is_last_owner(db, project_id, m):
        err(409, CONFLICT, LAST_OWNER_MSG)
    db.delete(m)
    db.commit()
    return {"ok": True}


def join_project(db: DbSession, project_id: str, ctx: AuthContext) -> dict:
    p = get_project_or_404(db, project_id)
    if p.visibility != "public":
        err(403, FORBIDDEN, "该项目未公开,无法自助加入")
    ensure_space_mutable(db, p.id)
    _create_membership(db, project_id, ctx.user, p.join_role)
    return project_json(db, p, ctx.user)


def leave_project(db: DbSession, project_id: str, ctx: AuthContext) -> dict:
    p = get_project_or_404(db, project_id)
    if p.is_personal:
        err(403, FORBIDDEN, "个人空间不可退出")
    m = db.query(ProjectMember).filter_by(project_id=project_id, user_id=ctx.user.id).first()
    if not m:
        err(404, NOT_FOUND, "你不是该项目成员")
    ensure_space_mutable(db, p.id)
    if _is_last_owner(db, project_id, m):
        err(409, CONFLICT, LAST_OWNER_MSG)
    db.delete(m)
    db.commit()
    return {"ok": True}
