"""认证、登录与个人 PAT 的薄路由。"""
from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy.orm import Session as DbSession

from db import get_db
from errors import FORBIDDEN, UNAUTHORIZED, bad_request, err
from http_util import bool_field, client_ip, client_ua, str_field
from ids import IdPath
from models import User
from security import sessions
from security.context import AuthContext, current_user, pat_write_guard
from security.passwords import check_password_strength
from serialize import user_json
from services import users

router = APIRouter(dependencies=[Depends(pat_write_guard)])


@router.get("/api/auth/status")
def auth_status(db: DbSession = Depends(get_db)):
    try:
        return {"bootstrapped": db.query(User).count() > 0, "dbReady": True}
    except Exception:
        return {"bootstrapped": False, "dbReady": False}


@router.post("/api/auth/bootstrap")
def bootstrap(payload: dict, request: Request, response: Response,
              db: DbSession = Depends(get_db)):
    if db.query(User).count() > 0:
        err(403, FORBIDDEN, "系统已初始化")
    email, name, password = users.validated_user_fields(payload)
    user = users.create_user_with_personal_space(db, email, name, password, True)
    ip, ua = client_ip(request), client_ua(request)
    token = sessions.create_session(db, user.id, ip=ip, ua=ua)
    sessions.set_session_cookie(response, token)
    sessions.record_login_event(db, user=user, email=email, ip=ip, ua=ua, result="ok")
    return {"user": user_json(user)}


@router.post("/api/auth/login")
def login(payload: dict, request: Request, response: Response,
          db: DbSession = Depends(get_db)):
    email = str_field(payload, "email", 255, required=True).lower()
    password = payload.get("password")
    if not isinstance(password, str):
        bad_request("password 不能为空")
    user = db.query(User).filter_by(email=email).first()
    if not sessions.verify_credentials(request, db, ident=email, password=password, user=user):
        err(401, UNAUTHORIZED, sessions.mismatch_message(db, email))
    if user.is_disabled:
        err(401, UNAUTHORIZED, "账号已被禁用")
    ttl = sessions.REMEMBER_TTL if bool_field(payload, "remember") else sessions.SESSION_TTL
    token = sessions.create_session(db, user.id, ttl,
                                    ip=client_ip(request), ua=client_ua(request))
    sessions.set_session_cookie(response, token, ttl)
    return {"user": user_json(user)}


@router.post("/api/auth/logout")
def logout(response: Response, ctx: AuthContext = Depends(current_user),
           db: DbSession = Depends(get_db)):
    users.revoke_current_session(db, ctx)
    response.delete_cookie(sessions.SESSION_COOKIE, path="/")
    return {"ok": True}


@router.get("/api/auth/me")
def auth_me(response: Response, ctx: AuthContext = Depends(current_user)):
    if ctx.via == "web" and ctx.session_token and ctx.session_lifetime:
        sessions.set_session_cookie(response, ctx.session_token, int(ctx.session_lifetime))
    return {"user": user_json(ctx.user),
            "auth": {"via": ctx.via, "scopes": ctx.scopes}}


@router.patch("/api/users/me")
def patch_me(payload: dict, ctx: AuthContext = Depends(current_user),
             db: DbSession = Depends(get_db)):
    """本人资料：只允许 name/email/avatarColor（静态路由先于 /api/users/{user_id} 注册）。"""
    return users.patch_me(db, ctx, payload)


@router.post("/api/users/me/password")
def change_my_password(payload: dict, request: Request,
                       ctx: AuthContext = Depends(current_user),
                       db: DbSession = Depends(get_db)):
    old, new = payload.get("oldPassword"), payload.get("newPassword")
    if not isinstance(old, str) or not isinstance(new, str):
        bad_request("oldPassword/newPassword 必须为字符串")
    if not sessions.verify_credentials(request, db, ident=ctx.user.email, password=old,
                                       user=ctx.user,
                                       policies=(sessions.LOGIN_ACCOUNT_POLICY,)):
        err(403, FORBIDDEN, "原密码错误")
    check_password_strength(new)
    return users.change_password(db, ctx, new)


@router.get("/api/auth/sessions")
def my_sessions(ctx: AuthContext = Depends(current_user), db: DbSession = Depends(get_db)):
    return users.list_my_sessions(db, ctx)


@router.delete("/api/auth/sessions/{ref}")
def revoke_my_session(ref: str, ctx: AuthContext = Depends(current_user),
                      db: DbSession = Depends(get_db)):
    return users.revoke_my_session(db, ctx, ref)


@router.delete("/api/auth/sessions")
def revoke_other_sessions(ctx: AuthContext = Depends(current_user),
                          db: DbSession = Depends(get_db)):
    return users.revoke_other_sessions(db, ctx)


@router.get("/api/auth/pats")
def list_pats(ctx: AuthContext = Depends(current_user), db: DbSession = Depends(get_db)):
    return users.list_pats(db, ctx.user)


@router.post("/api/auth/pats")
def create_pat(payload: dict, ctx: AuthContext = Depends(current_user),
               db: DbSession = Depends(get_db)):
    return users.create_pat(db, ctx, payload)


@router.delete("/api/auth/pats/{pat_id}")
def revoke_pat(pat_id: IdPath, ctx: AuthContext = Depends(current_user),
               db: DbSession = Depends(get_db)):
    return users.revoke_pat(db, ctx, pat_id)
