"""认证、登录与个人 PAT 的薄路由。"""
from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy.orm import Session as DbSession

from db import get_db
from http_util import client_ip, client_ua
from ids import IdPath
from security import sessions
from security.context import AuthContext, current_user, pat_write_guard
from serialize import user_json
from services import auth, users

router = APIRouter(dependencies=[Depends(pat_write_guard)])


@router.get("/api/auth/status")
def auth_status(db: DbSession = Depends(get_db)):
    return auth.bootstrap_status(db)


@router.post("/api/auth/bootstrap")
def bootstrap(payload: dict, request: Request, response: Response,
              db: DbSession = Depends(get_db)):
    user, token = auth.bootstrap(db, payload,
                                 ip=client_ip(request), ua=client_ua(request))
    sessions.set_session_cookie(response, token)
    return {"user": user_json(user)}


@router.post("/api/auth/login")
def login(payload: dict, request: Request, response: Response,
          db: DbSession = Depends(get_db)):
    user, token, ttl = auth.login(db, payload,
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
    return auth.change_password(db, ctx, payload,
                                ip=client_ip(request), ua=client_ua(request))


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
