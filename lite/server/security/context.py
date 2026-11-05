"""认证上下文与全站权限判定（纯业务，不依赖 FastAPI）。

路由层的认证依赖在 `deps.py`；服务层只接收这里的 `Actor` 并调用权限判定，
因此 `services/**` 不会经本模块间接接触 Request/Depends。
"""
from dataclasses import dataclass, field
from datetime import timedelta

from sqlalchemy.orm import Session as DbSession

from db import is_live, utcnow
from errors import (CONFLICT, FORBIDDEN, JOIN_REQUIRED, NOT_FOUND,
                    SPACE_ARCHIVED, err)
from models import AuthSession, Project, ProjectMember, User
from security import sessions
from treeutil import collect_subtree

ROLE_RANK = {"OWNER": 3, "ADMIN": 2, "EDITOR": 1, "VIEWER": 0}


@dataclass
class Actor:
    """一次调用的身份快照；会话字段只在 Web 会话路径上有值。"""
    user: User
    via: str
    scopes: list = field(default_factory=list)
    session_token: str | None = None
    pat_id: str | None = None
    session_lifetime: float | None = None


def session_context(db: DbSession, token: str | None) -> Actor | None:
    """解析会话并按需滑动续期。

    续期是一次独立提交：它是会话自身的过期语义，不属于任何业务写路径；业务代码
    不应把“请求里有没有发生滑动续期”混进自己的事务边界。
    """
    if not token:
        return None
    sess = db.get(AuthSession, token)
    if not sess or sess.expires_at <= utcnow():
        return None
    user = db.get(User, sess.user_id)
    if not user or user.is_disabled:
        return None
    now = utcnow()
    dirty = False
    if (now - (sess.last_seen_at or sess.created_at)).total_seconds() > sessions.SEEN_WRITE_INTERVAL_SECONDS:
        sess.last_seen_at = now
        dirty = True
    lifetime = (sess.expires_at - sess.created_at).total_seconds()
    if (sess.expires_at - now).total_seconds() < lifetime / 2:
        sess.expires_at = now + timedelta(seconds=lifetime)
        dirty = True
    if dirty:
        db.commit()
    return Actor(user=user, via="web", scopes=["read", "write"],
                 session_token=token, session_lifetime=lifetime)


def project_role_and_membership(db: DbSession, project_id: str,
                                user: User) -> tuple[str | None, bool]:
    m = db.query(ProjectMember).filter_by(project_id=project_id, user_id=user.id).first()
    is_member = m is not None
    if m and (not user.is_admin or has_role(m.role, "ADMIN")):
        return m.role, is_member
    p = db.get(Project, project_id) if user.is_admin else None
    if p is not None and p.is_personal and p.created_by != user.id:
        return None, is_member
    if user.is_admin:
        return "ADMIN", is_member
    return None, is_member


def project_role(db: DbSession, project_id: str, user: User) -> str | None:
    return project_role_and_membership(db, project_id, user)[0]


def is_project_owner_or_admin(db: DbSession, project_id: str, user: User) -> bool:
    if user.is_admin:
        return True
    return db.query(ProjectMember).filter_by(
        project_id=project_id, user_id=user.id, role="OWNER").first() is not None


def has_role(role: str | None, required: str) -> bool:
    return role is not None and ROLE_RANK.get(role, -1) >= ROLE_RANK[required]


def space_archived(db: DbSession, project_id: str) -> bool:
    p = db.get(Project, project_id)
    return p is not None and p.archived_at is not None


def ensure_space_mutable(db: DbSession, project_id: str) -> None:
    """归档空间：读与直达可用，所有内容/成员写入统一 403 SPACE_ARCHIVED。"""
    p = db.get(Project, project_id)
    if p is not None and p.archived_at is not None:
        err(403, SPACE_ARCHIVED, "空间已归档，请先解除归档再修改内容")


def ensure_project_role(db: DbSession, ctx: Actor, project_id: str,
                        required: str, *, write: bool = False) -> str | None:
    """权限先于归档判定：非成员永远看不到“空间已归档”，避免泄露空间状态。"""
    role = project_role(db, project_id, ctx.user)
    if not has_role(role, required):
        p = db.get(Project, project_id)
        if p is not None and p.visibility == "public":
            err(403, JOIN_REQUIRED, "本项目需先加入才能查看")
        err(403, FORBIDDEN, f"需要 {required} 及以上权限")
    if write:
        ensure_space_mutable(db, project_id)
    return role


def get_project_or_404(db: DbSession, project_id: str) -> Project:
    p = db.get(Project, project_id)
    if not p:
        err(404, NOT_FOUND, "项目不存在")
    return p


def ensure_move_allowed(db: DbSession, ctx: Actor,
                        src_project_id: str, target_project_id: str) -> None:
    ensure_project_role(db, ctx, src_project_id,
                        "ADMIN" if target_project_id != src_project_id else "EDITOR",
                        write=True)
    get_project_or_404(db, target_project_id)
    ensure_project_role(db, ctx, target_project_id, "EDITOR", write=True)


def validate_parent(db: DbSession, model, parent_id: str | None, project_id: str,
                    *, moving=None, label: str = "父级") -> None:
    if parent_id is None:
        return
    parent = db.get(model, parent_id)
    if not parent or parent.project_id != project_id or parent.deleted_at is not None:
        err(404, NOT_FOUND, f"{label}不存在")
    if moving is not None and parent_id in set(collect_subtree(db, model, moving)):
        err(409, CONFLICT, "不能移动到自己的子层级下")


def load_live(db: DbSession, model, res_id: str, label: str):
    res = db.get(model, res_id)
    if not is_live(res):
        err(404, NOT_FOUND, f"{label}不存在")
    return res
