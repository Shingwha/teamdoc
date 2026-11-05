"""认证上下文、FastAPI 鉴权依赖与全站权限判定。"""
import inspect
from dataclasses import dataclass, field
from datetime import timedelta

from fastapi import Depends, Request
from sqlalchemy.orm import Session as DbSession

from db import get_db, is_live, utcnow
from errors import (CONFLICT, FORBIDDEN, JOIN_REQUIRED, NOT_FOUND,
                    READ_ONLY_TOKEN, SPACE_ARCHIVED, UNAUTHORIZED, err)
from ids import IdPath
from models import AuthSession, Project, ProjectMember, User
from security import sessions
from treeutil import collect_subtree

ROLE_RANK = {"OWNER": 3, "ADMIN": 2, "EDITOR": 1, "VIEWER": 0}


@dataclass
class AuthContext:
    user: User
    via: str
    scopes: list = field(default_factory=list)
    session_token: str | None = None
    pat_id: str | None = None
    session_lifetime: float | None = None


def authenticate(request: Request, db: DbSession = Depends(get_db)) -> AuthContext | None:
    authz = request.headers.get("authorization", "")
    if authz.startswith("Bearer "):
        token = authz[7:].strip()
        if token.startswith("tdp_"):
            pat = sessions.active_pat(db, token)
            if not pat:
                return None
            user = db.get(User, pat.user_id)
            if not user or user.is_disabled:
                return None
            now = utcnow()
            if pat.last_used_at is None or (now - pat.last_used_at).total_seconds() > 60:
                pat.last_used_at = now
                db.commit()
            return AuthContext(user=user, via="pat", scopes=pat.scopes.split(","), pat_id=pat.id)
    return session_context(db, request.cookies.get(sessions.SESSION_COOKIE))


def session_context(db: DbSession, token: str | None) -> AuthContext | None:
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
    return AuthContext(user=user, via="web", scopes=["read", "write"],
                       session_token=token, session_lifetime=lifetime)


def current_user(request: Request, ctx: AuthContext | None = Depends(authenticate)) -> AuthContext:
    if ctx is None:
        err(401, UNAUTHORIZED, "未登录")
    request.state.auth = ctx
    return ctx


def pat_write_guard(request: Request, ctx: AuthContext | None = Depends(authenticate)) -> None:
    if request.method != "GET" and ctx is not None and ctx.via == "pat" \
            and "write" not in ctx.scopes:
        err(403, READ_ONLY_TOKEN, "令牌缺少 write 权限")


def require_admin(ctx: AuthContext = Depends(current_user)) -> AuthContext:
    if not ctx.user.is_admin:
        err(403, FORBIDDEN, "需要管理员权限")
    return ctx


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


def is_project_member(db: DbSession, project_id: str, user: User) -> bool:
    return project_role_and_membership(db, project_id, user)[1]


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


def ensure_project_role(db: DbSession, ctx: AuthContext, project_id: str,
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


def ensure_move_allowed(db: DbSession, ctx: AuthContext,
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


def require_project_role(required: str, *, write: bool = False):
    def dep(project_id: IdPath, ctx: AuthContext = Depends(current_user),
            db: DbSession = Depends(get_db)) -> AuthContext:
        get_project_or_404(db, project_id)
        ensure_project_role(db, ctx, project_id, required, write=write)
        return ctx
    return dep


def load_live(db: DbSession, model, res_id: str, label: str):
    res = db.get(model, res_id)
    if not is_live(res):
        err(404, NOT_FOUND, f"{label}不存在")
    return res


def require_role(model, label: str, required: str, *, path_param: str,
                 for_trash: bool = False, write: bool = False):
    """统一“存在 → 权限 → 删除状态”顺序，避免非成员探测资源状态。"""
    def dep(**kw) -> tuple:
        ctx: AuthContext = kw["ctx"]
        db: DbSession = kw["db"]
        res = db.get(model, kw[path_param])
        if not res:
            err(404, NOT_FOUND, f"{label}不存在")
        ensure_project_role(db, ctx, res.project_id, required, write=write)
        if res.deleted_at is not None and not for_trash:
            err(404, NOT_FOUND, f"{label}不存在")
        return ctx, res
    dep.__signature__ = inspect.Signature(parameters=[
        inspect.Parameter(path_param, inspect.Parameter.POSITIONAL_OR_KEYWORD,
                          annotation=IdPath),
        inspect.Parameter("ctx", inspect.Parameter.POSITIONAL_OR_KEYWORD,
                          annotation=AuthContext, default=Depends(current_user)),
        inspect.Parameter("db", inspect.Parameter.POSITIONAL_OR_KEYWORD,
                          annotation=DbSession, default=Depends(get_db)),
    ])
    return dep
