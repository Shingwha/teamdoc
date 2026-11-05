"""登录、初始化与本人密码变更的编排层；路由只做请求解析与响应组装。"""
from sqlalchemy.orm import Session as DbSession

from errors import FORBIDDEN, UNAUTHORIZED, bad_request, err
from http_util import bool_field, str_field
from models import User
from security import sessions
from services import users


def bootstrap_status(db: DbSession) -> dict:
    try:
        return {"bootstrapped": db.query(User).count() > 0, "dbReady": True}
    except Exception:
        return {"bootstrapped": False, "dbReady": False}


def bootstrap(db: DbSession, payload: dict, *, ip: str, ua: str) -> tuple[User, str]:
    if db.query(User).count() > 0:
        err(403, FORBIDDEN, "系统已初始化")
    email, name, password = users.validated_user_fields(payload)
    user = users.create_user_with_personal_space(db, email, name, password, True)
    token = sessions.create_session(db, user.id, ip=ip, ua=ua)
    sessions.record_login_event(db, user=user, email=email, ip=ip, ua=ua, result="ok")
    return user, token


def login(db: DbSession, payload: dict, *, ip: str, ua: str) -> tuple[User, str, int]:
    """校验口令并签发会话；节流、失败审计与恒定耗时校验都在 sessions 内。"""
    email = str_field(payload, "email", 255, required=True).lower()
    password = payload.get("password")
    if not isinstance(password, str):
        bad_request("password 不能为空")
    user = db.query(User).filter_by(email=email).first()
    if not sessions.verify_credentials(db, ident=email, password=password, user=user,
                                       ip=ip, ua=ua):
        err(401, UNAUTHORIZED, sessions.mismatch_message(db, email))
    if user.is_disabled:
        err(401, UNAUTHORIZED, "账号已被禁用")
    ttl = sessions.REMEMBER_TTL if bool_field(payload, "remember") else sessions.SESSION_TTL
    token = sessions.create_session(db, user.id, ttl, ip=ip, ua=ua)
    return user, token, ttl


def change_password(db: DbSession, ctx, payload: dict, *, ip: str, ua: str) -> dict:
    old, new = payload.get("oldPassword"), payload.get("newPassword")
    if not isinstance(old, str) or not isinstance(new, str):
        bad_request("oldPassword/newPassword 必须为字符串")
    if not sessions.verify_credentials(db, ident=ctx.user.email, password=old,
                                       user=ctx.user, ip=ip, ua=ua,
                                       policies=(sessions.LOGIN_ACCOUNT_POLICY,)):
        err(403, FORBIDDEN, "原密码错误")
    return users.change_password(db, ctx, new)
