"""用户、个人空间、PAT 与登录状态业务。"""
from sqlalchemy import func, select
from sqlalchemy.orm import Session as DbSession

import throttle
from db import utcnow
from errors import CONFLICT, FORBIDDEN, NOT_FOUND, bad_request, err
from http_util import bool_field, color_field, str_field
from models import (AuthSession, Doc, DocVersion, File, FileVersion, Folder,
                    LoginEvent, Notification, Pat, Project, ProjectMember, User)
from security import sessions
from security.passwords import check_email, check_password_strength, hash_password
from serialize import iso, session_json, session_ref, user_json

_EMPTY_LOGIN_STATUS = {"lastLoginAt": None, "lastLoginIp": None, "online": False,
                       "sessionCount": 0, "lockedUntil": None}


def user_map(db: DbSession, ids) -> dict[str, User]:
    ids = {i for i in ids if i}
    if not ids:
        return {}
    return {u.id: u for u in db.query(User).filter(User.id.in_(ids)).all()}


def user_names(db: DbSession, ids) -> dict[str, str]:
    return {uid: u.name for uid, u in user_map(db, ids).items()}


def validated_user_fields(payload: dict) -> tuple[str, str, str]:
    email = str_field(payload, "email", 255, required=True).lower()
    check_email(email)
    name = str_field(payload, "name", 50, required=True)
    password = payload.get("password")
    if not isinstance(password, str):
        bad_request("password 必须为字符串")
    check_password_strength(password)
    return email, name, password


def create_personal_project(db: DbSession, user: User):
    p = Project(name="个人空间", is_personal=True, created_by=user.id)
    db.add(p)
    db.flush()
    db.add(ProjectMember(project_id=p.id, user_id=user.id, role="OWNER"))


def create_user_with_personal_space(db: DbSession, email: str, name: str,
                                    password: str, is_admin: bool) -> User:
    user = User(email=email, name=name, password_hash=hash_password(password),
                is_admin=is_admin)
    db.add(user)
    db.flush()
    create_personal_project(db, user)
    db.commit()
    return user


def create_user(db: DbSession, payload: dict) -> dict:
    email, name, password = validated_user_fields(payload)
    is_admin = bool_field(payload, "isAdmin")
    if db.query(User).filter_by(email=email).first():
        err(409, CONFLICT, "该邮箱已被注册")
    user = create_user_with_personal_space(db, email, name, password, is_admin)
    return admin_user_json(db, user)


def login_status(db: DbSession, users: list[User]) -> dict[str, dict]:
    now = utcnow()
    ids = [u.id for u in users]
    out = {uid: dict(_EMPTY_LOGIN_STATUS) for uid in ids}
    if not ids:
        return out
    rn = func.row_number().over(partition_by=LoginEvent.user_id,
                                order_by=LoginEvent.created_at.desc()).label("rn")
    ranked = (select(LoginEvent.user_id.label("uid"), LoginEvent.created_at,
                     LoginEvent.ip, rn)
              .where(LoginEvent.result == "ok", LoginEvent.user_id.isnot(None),
                     LoginEvent.user_id.in_(ids)).subquery())
    for uid, created, ip in db.execute(select(ranked.c.uid, ranked.c.created_at, ranked.c.ip)
                                       .where(ranked.c.rn == 1)):
        st = out.get(uid)
        if st:
            st["lastLoginAt"] = created.isoformat()
            st["lastLoginIp"] = ip
    for uid, seen, created in (db.query(AuthSession.user_id, AuthSession.last_seen_at,
                                        AuthSession.created_at)
                               .filter(AuthSession.expires_at > now,
                                       AuthSession.user_id.in_(ids))):
        st = out.get(uid)
        if st:
            st["sessionCount"] += 1
            if sessions.is_online(seen, created, now):
                st["online"] = True
    locks = throttle.locks_for(db, sessions.LOGIN_ACCOUNT_POLICY, [u.email for u in users])
    for u in users:
        if u.email in locks:
            out[u.id]["lockedUntil"] = locks[u.email]
    return out


def admin_user_json(db: DbSession, u: User) -> dict:
    d = user_json(u, face="admin")
    d.update(login_status(db, [u]).get(u.id, dict(_EMPTY_LOGIN_STATUS)))
    return d


def enabled_admin_count(db: DbSession) -> int:
    return db.query(User).filter_by(is_admin=True, is_disabled=False).count()


def busy_user_ids(db: DbSession) -> set[str]:
    busy: set[str] = set()
    for col in (Doc.created_by, Doc.updated_by, DocVersion.created_by,
                File.created_by, File.updated_by, FileVersion.created_by):
        for (uid,) in db.query(col).filter(col.isnot(None)).distinct():
            busy.add(uid)
    for (uid,) in (db.query(Project.created_by)
                   .filter(Project.created_by.isnot(None), Project.is_personal.is_(False))
                   .distinct()):
        busy.add(uid)
    for (uid,) in (db.query(ProjectMember.user_id)
                   .join(Project, Project.id == ProjectMember.project_id)
                   .filter(ProjectMember.role == "OWNER", Project.is_personal.is_(False))
                   .distinct()):
        busy.add(uid)
    owner_of = {p.id: p.created_by for p in db.query(Project).filter(Project.is_personal.is_(True))}
    if owner_of:
        ids = list(owner_of)
        for model in (Doc, File, Folder):
            column = model.project_id
            for (pid,) in db.query(column).filter(column.in_(ids)).distinct():
                if owner_of.get(pid):
                    busy.add(owner_of[pid])
    return busy


def deletion_blockers(db: DbSession, user: User) -> list[str]:
    if user.id not in busy_user_ids(db):
        return []
    counts = {
        "文档": db.query(Doc).filter((Doc.created_by == user.id) | (Doc.updated_by == user.id)).count(),
        "文档历史版本": db.query(DocVersion).filter_by(created_by=user.id).count(),
        "云空间文件": db.query(File).filter((File.created_by == user.id) |
                                      (File.updated_by == user.id)).count(),
        "文件历史版本": db.query(FileVersion).filter_by(created_by=user.id).count(),
        "项目": db.query(Project).filter(Project.created_by == user.id,
                                      Project.is_personal.is_(False)).count(),
    }
    parts = [f"{n} 个{d}" for d, n in counts.items() if n]
    return parts or ["其个人空间内已有内容"]


def list_users(db: DbSession) -> list[dict]:
    rows = db.query(User).order_by(User.created_at.asc()).all()
    busy = busy_user_ids(db)
    last_admin = enabled_admin_count(db) <= 1
    status = login_status(db, rows)
    out = []
    for u in rows:
        d = user_json(u, face="admin")
        d.update(status.get(u.id, dict(_EMPTY_LOGIN_STATUS)))
        d["canDelete"] = (u.id not in busy
                          and not (u.is_admin and not u.is_disabled and last_admin))
        out.append(d)
    return out


def user_directory(db: DbSession) -> list[dict]:
    rows = (db.query(User).filter_by(is_disabled=False)
            .order_by(User.name.asc(), User.created_at.asc()).all())
    return [user_json(u, face="dir") for u in rows]


def patch_user(db: DbSession, user_id: str, payload: dict) -> dict:
    user = db.get(User, user_id)
    if not user:
        err(404, NOT_FOUND, "用户不存在")
    if user.is_admin and not user.is_disabled:
        losing_admin = (("isAdmin" in payload and not payload["isAdmin"]) or
                        ("isDisabled" in payload and payload["isDisabled"]))
        if losing_admin and enabled_admin_count(db) <= 1:
            err(409, CONFLICT, "系统至少需要一名可用管理员")
    if "name" in payload:
        user.name = str_field(payload, "name", 50, required=True)
    if "email" in payload:
        email = str_field(payload, "email", 255, required=True).lower()
        check_email(email)
        if email != user.email:
            if db.query(User).filter(User.email == email, User.id != user.id).first():
                err(409, CONFLICT, "该邮箱已被注册")
            user.email = email
    if "avatarColor" in payload:
        user.avatar_color = color_field(payload, "avatarColor")
    if "isAdmin" in payload:
        user.is_admin = bool_field(payload, "isAdmin")
    if "isDisabled" in payload:
        user.is_disabled = bool_field(payload, "isDisabled")
    if "unlock" in payload and bool_field(payload, "unlock"):
        throttle.clear(db, sessions.LOGIN_ACCOUNT_POLICY, user.email)
    if "password" in payload:
        password = payload["password"]
        if not isinstance(password, str):
            bad_request("password 必须为字符串")
        check_password_strength(password)
        user.password_hash = hash_password(password)
        db.query(AuthSession).filter(AuthSession.user_id == user.id).delete(synchronize_session=False)
        now = utcnow()
        for pat in db.query(Pat).filter(Pat.user_id == user.id, Pat.revoked_at.is_(None)).all():
            pat.revoked_at = now
    db.commit()
    return admin_user_json(db, user)


_ME_FIELDS = frozenset({"name", "email", "avatarColor"})


def patch_me(db: DbSession, ctx, payload: dict) -> dict:
    """本人资料修改：只认 name/email/avatarColor，其他字段明确拒绝而非静默忽略。"""
    unknown = sorted(set(payload) - _ME_FIELDS)
    if unknown:
        bad_request("仅支持修改 name/email/avatarColor，不支持:" + "、".join(unknown))
    user = db.get(User, ctx.user.id)
    if not user:
        err(404, NOT_FOUND, "用户不存在")
    if "name" in payload:
        user.name = str_field(payload, "name", 50, required=True)
    if "email" in payload:
        email = str_field(payload, "email", 255, required=True).lower()
        check_email(email)
        if email != user.email:
            if db.query(User).filter(User.email == email, User.id != user.id).first():
                err(409, CONFLICT, "该邮箱已被注册")
            user.email = email
    if "avatarColor" in payload:
        user.avatar_color = color_field(payload, "avatarColor")
    db.commit()
    return {"user": user_json(user)}


def _require_web_session(ctx) -> None:
    if ctx.via != "web":
        err(403, FORBIDDEN, "仅 Web 会话可管理登录会话")


def list_my_sessions(db: DbSession, ctx) -> list[dict]:
    _require_web_session(ctx)
    now = utcnow()
    rows = (db.query(AuthSession)
            .filter(AuthSession.user_id == ctx.user.id, AuthSession.expires_at > now)
            .order_by(AuthSession.created_at.desc()).all())
    return [session_json(s, online=sessions.is_online(s.last_seen_at, s.created_at),
                         current_token=ctx.session_token)
            for s in rows]


def revoke_my_session(db: DbSession, ctx, ref: str) -> dict:
    """吊销自己的一个非当前会话；当前会话只能走 logout。"""
    _require_web_session(ctx)
    now = utcnow()
    for sess in (db.query(AuthSession)
                 .filter(AuthSession.user_id == ctx.user.id,
                         AuthSession.expires_at > now).all()):
        if session_ref(sess.token) != ref:
            continue
        if sess.token == ctx.session_token:
            err(409, CONFLICT, "当前会话不能在此下线,请使用退出登录")
        db.delete(sess)
        db.commit()
        return {"ok": True, "revoked": 1}
    err(404, NOT_FOUND, "会话不存在或已失效")


def revoke_other_sessions(db: DbSession, ctx) -> dict:
    _require_web_session(ctx)
    q = db.query(AuthSession).filter(AuthSession.user_id == ctx.user.id)
    if ctx.session_token:
        q = q.filter(AuthSession.token != ctx.session_token)
    n = q.delete(synchronize_session=False)
    db.commit()
    return {"ok": True, "revoked": int(n)}


def delete_user(db: DbSession, user_id: str, actor: User) -> dict:
    user = db.get(User, user_id)
    if not user:
        err(404, NOT_FOUND, "用户不存在")
    if user.id == actor.id:
        bad_request("不能删除自己的账号")
    if user.is_admin and not user.is_disabled and enabled_admin_count(db) <= 1:
        err(409, CONFLICT, "系统至少需要一名可用管理员")
    blockers = deletion_blockers(db, user)
    if blockers:
        err(409, CONFLICT,
            "该账号已产生数据(" + "、".join(blockers) + "),删除会留下无主的文档与文件。"
            "请改用「禁用」:账号立即失去访问,数据保留。")
    db.query(AuthSession).filter_by(user_id=user.id).delete()
    db.query(Pat).filter_by(user_id=user.id).delete()
    db.query(Notification).filter_by(user_id=user.id).delete()
    personal_ids = [p.id for p in db.query(Project).filter_by(created_by=user.id, is_personal=True)]
    if personal_ids:
        db.query(ProjectMember).filter(ProjectMember.project_id.in_(personal_ids)).delete(
            synchronize_session=False)
        db.query(Project).filter(Project.id.in_(personal_ids)).delete(synchronize_session=False)
    db.query(ProjectMember).filter_by(user_id=user.id).delete()
    db.delete(user)
    db.commit()
    return {"ok": True}


def change_password(db: DbSession, ctx, new: str) -> dict:
    check_password_strength(new)
    user = db.get(User, ctx.user.id)
    user.password_hash = hash_password(new)
    q = db.query(AuthSession).filter(AuthSession.user_id == user.id)
    if ctx.session_token:
        q = q.filter(AuthSession.token != ctx.session_token)
    revoked = q.delete(synchronize_session=False)
    db.commit()
    return {"ok": True, "revokedSessions": revoked}


def list_pats(db: DbSession, user: User) -> list[dict]:
    rows = (db.query(Pat).filter_by(user_id=user.id)
            .filter(Pat.revoked_at.is_(None)).order_by(Pat.created_at.desc()).all())
    return [{"id": p.id, "name": p.name, "scopes": p.scopes,
             "lastUsedAt": p.last_used_at.isoformat() if p.last_used_at else None,
             "createdAt": p.created_at.isoformat()} for p in rows]


def create_pat(db: DbSession, ctx, payload: dict) -> dict:
    if ctx.via != "web":
        err(403, FORBIDDEN, "仅 Web 会话可创建访问令牌")
    name = str_field(payload, "name", 50, required=True)
    scopes = str_field(payload, "scopes", 20, default="read")
    if scopes not in ("read", "read,write"):
        bad_request('scopes 仅支持 "read" 或 "read,write"')
    token = sessions.new_pat_token()
    pat = Pat(user_id=ctx.user.id, name=name, token_hash=sessions.pat_hash(token), scopes=scopes)
    db.add(pat)
    db.commit()
    return {"id": pat.id, "name": pat.name, "scopes": pat.scopes, "token": token,
            "createdAt": pat.created_at.isoformat()}


def revoke_pat(db: DbSession, ctx, pat_id: str) -> dict:
    if ctx.via != "web":
        err(403, FORBIDDEN, "仅 Web 会话可吊销访问令牌")
    pat = db.query(Pat).filter_by(id=pat_id, user_id=ctx.user.id).first()
    if not pat or pat.revoked_at is not None:
        err(404, NOT_FOUND, "令牌不存在")
    pat.revoked_at = utcnow()
    db.commit()
    return {"ok": True}


def admin_list_pats(db: DbSession, user_id: str | None = None,
                    limit: int = 100) -> list[dict]:
    """管理端 PAT 审计：只读字段面，绝不返回 token 或 hash。"""
    q = db.query(Pat, User).join(User, User.id == Pat.user_id)
    if user_id:
        q = q.filter(Pat.user_id == user_id)
    rows = (q.order_by(Pat.last_used_at.is_(None).asc(),
                       Pat.last_used_at.desc(), Pat.created_at.desc())
            .limit(limit).all())
    return [{"id": p.id, "userId": p.user_id, "userName": u.name,
             "userEmail": u.email, "name": p.name, "scopes": p.scopes,
             "createdAt": iso(p.created_at), "lastUsedAt": iso(p.last_used_at),
             "revokedAt": iso(p.revoked_at)} for p, u in rows]


def revoke_current_session(db: DbSession, ctx) -> None:
    if ctx.session_token:
        db.query(AuthSession).filter_by(token=ctx.session_token).delete()
        db.commit()
