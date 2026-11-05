"""会话签发、PAT 秘密散列、登录节流与独立安全审计（不依赖 FastAPI）。"""
import hashlib
import logging
import secrets
import time
from datetime import timedelta

from sqlalchemy.orm import Session as DbSession

import config
import throttle
from db import utcnow
from errors import TOO_MANY_ATTEMPTS, err
from models import AuthSession, LoginEvent, Pat, User
from security.passwords import dummy_hash, verify_password

logger = logging.getLogger("teamdoc.security")
SESSION_COOKIE = "td_sid"
SESSION_TTL_DAYS = config.SESSION_TTL_DAYS
SESSION_TTL = SESSION_TTL_DAYS * 86400
REMEMBER_TTL_DAYS = config.REMEMBER_TTL_DAYS
REMEMBER_TTL = REMEMBER_TTL_DAYS * 86400
LOGIN_ACCOUNT_POLICY = throttle.Policy(
    name="account", max_fails=config.LOGIN_MAX_FAILS,
    window=config.LOGIN_FAIL_WINDOW, lockout=config.LOGIN_LOCKOUT,
    max_lockout=config.LOGIN_LOCKOUT_MAX, clear_on_success=True, idle_reset=7200)
LOGIN_SOURCE_IP_POLICY = throttle.Policy(
    name="source_ip", subject="client_ip", max_fails=config.LOGIN_IP_MAX_FAILS,
    window=config.LOGIN_FAIL_WINDOW, lockout=config.LOGIN_IP_LOCKOUT)
LOGIN_POLICIES = (LOGIN_ACCOUNT_POLICY, LOGIN_SOURCE_IP_POLICY)
LOGIN_EVENT_KEEP_DAYS = config.LOGIN_EVENT_KEEP_DAYS
ONLINE_WINDOW_SECONDS = 300
SEEN_WRITE_INTERVAL_SECONDS = 60
_EVENT_PRUNE_INTERVAL_SECONDS = 3600
_event_pruned_at = 0.0


def is_online(seen_at, created_at, now=None) -> bool:
    return (seen_at or created_at) >= (now or utcnow()) - timedelta(
        seconds=ONLINE_WINDOW_SECONDS)


def pat_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def create_session(db: DbSession, user_id: str, ttl: int = SESSION_TTL, *,
                   ip: str = "", ua: str = "") -> str:
    """签发会话并独立提交：认证凭据的生命周期不等同于业务写事务。"""
    token = secrets.token_hex(32)
    now = utcnow()
    db.add(AuthSession(token=token, user_id=user_id, created_at=now,
                       expires_at=now + timedelta(seconds=ttl),
                       ip=ip or None, user_agent=ua or None, last_seen_at=now))
    db.commit()
    return token


def record_login_event(db: DbSession, *, user: User | None, email: str, ip: str,
                       ua: str, result: str) -> None:
    """安全审计独立提交；口令永不落库，冷却期 429 不放大写入。"""
    db.add(LoginEvent(user_id=user.id if user else None, email=email, ip=ip or None,
                      user_agent=ua or None, result=result))
    _prune_login_events(db)
    db.commit()


def _prune_login_events(db: DbSession, batch: int = 500) -> int:
    global _event_pruned_at
    if LOGIN_EVENT_KEEP_DAYS <= 0 or time.monotonic() - _event_pruned_at < _EVENT_PRUNE_INTERVAL_SECONDS:
        return 0
    _event_pruned_at = time.monotonic()
    cutoff = utcnow() - timedelta(days=LOGIN_EVENT_KEEP_DAYS)
    ids = [i for (i,) in db.query(LoginEvent.id).filter(LoginEvent.created_at < cutoff).limit(batch)]
    if not ids:
        return 0
    return int(db.query(LoginEvent).filter(LoginEvent.id.in_(ids)).delete(
        synchronize_session=False))


def _throttle_subject(policy: throttle.Policy, ident: str, ip: str) -> str:
    return ip if policy.subject == "client_ip" else ident


def verify_credentials(db: DbSession, *, ident: str, password: str,
                       user: User | None, ip: str = "", ua: str = "",
                       policies: tuple[throttle.Policy, ...] = LOGIN_POLICIES) -> bool:
    """冷却检查、恒定耗时校验、失败计数与登录审计的唯一入口。"""
    for p in policies:
        lock = throttle.locked(db, p, _throttle_subject(p, ident, ip))
        if lock:
            logger.warning("登录节流拦截:ident=%s ip=%s 策略=%s 剩余=%ds",
                           ident, ip or "-", p.name, lock.retry_after)
            _too_many(lock.retry_after)
    ok = verify_password(password, user.password_hash if user is not None else dummy_hash())
    if not ok:
        locked = None
        for p in policies:
            lk = throttle.count_failure(db, p, _throttle_subject(p, ident, ip))
            if lk and (locked is None or lk.retry_after > locked.retry_after):
                locked = lk
        record_login_event(db, user=user, email=ident, ip=ip, ua=ua,
                           result="locked" if locked else "bad_password")
        logger.warning("登录失败:ident=%s ip=%s 触发冷却=%s", ident, ip or "-",
                       f"{locked.retry_after}s/{locked.strikes}次" if locked else "否")
        throttle.sweep(db, max(p.window for p in policies))
        if locked:
            _too_many(locked.retry_after)
        return False
    for p in policies:
        if p.clear_on_success:
            throttle.clear(db, p, _throttle_subject(p, ident, ip))
    record_login_event(db, user=user, email=ident, ip=ip, ua=ua,
                       result="disabled" if user.is_disabled else "ok")
    return True


def _too_many(retry_after: int):
    err(429, TOO_MANY_ATTEMPTS, f"登录失败次数过多,请 {retry_after} 秒后重试",
        headers={"Retry-After": str(retry_after)})


def mismatch_message(db: DbSession, email: str) -> str:
    msg = "邮箱或密码错误"
    left = throttle.remaining(db, LOGIN_ACCOUNT_POLICY, email)
    if left is not None and 0 < left <= 2:
        msg += f"(还可尝试 {left} 次)"
    return msg


def new_pat_token() -> str:
    return "tdp_" + secrets.token_hex(24)


def active_pat(db: DbSession, token: str) -> Pat | None:
    return db.query(Pat).filter(Pat.token_hash == pat_hash(token),
                                Pat.revoked_at.is_(None)).first()
