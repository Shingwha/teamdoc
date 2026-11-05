"""FastAPI 依赖与请求适配层：只有路由层可以导入本模块。

服务层只依赖 `security.context` 中的纯业务类型（`Actor`）与权限判定，不接触
Request/Response、依赖注入或 pydantic 路径类型；FastAPI 在本项目里的接触面
收敛为 `main.py`、`routers/**`、`errors.py` 与本模块。
"""
import inspect
import logging
import time
from typing import Annotated

from fastapi import Depends, Request, Response
from pydantic import AfterValidator
from sqlalchemy.orm import Session as DbSession

from db import DB_WARN_SECONDS, SessionLocal, utcnow
from errors import FORBIDDEN, NOT_FOUND, READ_ONLY_TOKEN, UNAUTHORIZED, err
from ids import normalize_id
from models import User
from security import sessions
from security.context import (Actor, ensure_project_role, get_project_or_404,
                              session_context)

logger = logging.getLogger("teamdoc.db")


# ---------- 请求级数据库会话 ----------

def get_db(request: Request):
    """请求级会话；长 I/O 前必须调用 db.release_db。"""
    db = SessionLocal()
    started = time.monotonic()
    try:
        yield db
    finally:
        db.close()
        held = time.monotonic() - started
        if held > DB_WARN_SECONDS:
            logger.warning("数据库会话持有 %.1fs:%s %s", held,
                           request.method, request.url.path)


# ---------- 通用请求字段 ----------

def client_ip(request: Request) -> str:
    return request.client.host if request.client and request.client.host else ""


def client_ua(request: Request) -> str:
    return (request.headers.get("user-agent") or "")[:300]


def declared_bytes(request: Request) -> int:
    """Content-Length；缺省或非法按 0（服务端仍按实际流式字节数校验）。"""
    try:
        return int(request.headers.get("content-length") or 0)
    except ValueError:
        return 0


def set_session_cookie(response: Response, token: str,
                       max_age: int = sessions.SESSION_TTL) -> None:
    response.set_cookie(sessions.SESSION_COOKIE, token, max_age=max_age,
                        httponly=True, samesite="lax", path="/")


# ---------- 路径 id ----------

def _validate_id(value: str) -> str:
    got = normalize_id(value)
    if got is None:
        raise ValueError("id 形状非法")
    return got


IdPath = Annotated[str, AfterValidator(_validate_id)]


# ---------- 认证与权限依赖 ----------

def authenticate(request: Request, db: DbSession = Depends(get_db)) -> Actor | None:
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
            return Actor(user=user, via="pat", scopes=pat.scopes.split(","), pat_id=pat.id)
    return session_context(db, request.cookies.get(sessions.SESSION_COOKIE))


def current_user(request: Request, ctx: Actor | None = Depends(authenticate)) -> Actor:
    if ctx is None:
        err(401, UNAUTHORIZED, "未登录")
    request.state.auth = ctx
    return ctx


def pat_write_guard(request: Request, ctx: Actor | None = Depends(authenticate)) -> None:
    if request.method != "GET" and ctx is not None and ctx.via == "pat" \
            and "write" not in ctx.scopes:
        err(403, READ_ONLY_TOKEN, "令牌缺少 write 权限")


def require_admin(ctx: Actor = Depends(current_user)) -> Actor:
    if not ctx.user.is_admin:
        err(403, FORBIDDEN, "需要管理员权限")
    return ctx


def require_project_role(required: str, *, write: bool = False):
    def dep(project_id: IdPath, ctx: Actor = Depends(current_user),
            db: DbSession = Depends(get_db)) -> Actor:
        get_project_or_404(db, project_id)
        ensure_project_role(db, ctx, project_id, required, write=write)
        return ctx
    return dep


def require_role(model, label: str, required: str, *, path_param: str,
                 for_trash: bool = False, write: bool = False):
    """统一“存在 → 权限 → 删除状态”顺序，避免非成员探测资源状态。"""
    def dep(**kw) -> tuple:
        ctx: Actor = kw["ctx"]
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
                          annotation=Actor, default=Depends(current_user)),
        inspect.Parameter("db", inspect.Parameter.POSITIONAL_OR_KEYWORD,
                          annotation=DbSession, default=Depends(get_db)),
    ])
    return dep
