"""管理端存储、孤儿、项目总览与登录审计服务。"""
import hashlib
import os
import threading
from datetime import datetime
from pathlib import Path

from sqlalchemy import func
from sqlalchemy.orm import Session as DbSession

import config
import throttle
import watchdog
from db import engine, release_db, utcnow
from errors import NOT_FOUND, VALIDATION, err
from models import (AuthSession, Doc, DocVersion, File, FileVersion, Folder,
                    LoginEvent, Project, ProjectMember, ThrottleState, User)
from security import sessions
from serialize import describe_ua, iso, session_json, user_json
from serialize import project_json as project_shape
from services import backup
from services.files import file_storage_totals
from services.spaces import batch_stats
from services.users import user_names
from services.versions import referenced_storage_names
from storage import (DB_PATH, FILES_DIR, INFLIGHT_STORAGE, disk_free_bytes,
                     disk_total_bytes, unlink_quiet)


def _dir_size(path: Path) -> int:
    total = 0
    try:
        for entry in os.scandir(path):
            if entry.is_file(follow_symlinks=False):
                try:
                    total += entry.stat().st_size
                except OSError:
                    pass
    except OSError:
        pass
    return total


def _scan_orphans(known: set[str]) -> dict:
    """纯磁盘扫描：known 已由调用方查好，避免扫描期间占用数据库会话。"""
    victims = []
    on_disk_names = set()
    inflight = 0
    for entry in os.scandir(FILES_DIR):
        if not entry.is_file(follow_symlinks=False):
            continue
        on_disk_names.add(entry.name)
        if entry.name in known:
            continue
        if entry.name in INFLIGHT_STORAGE:
            inflight += 1
            continue
        try:
            victims.append((entry.path, entry.stat().st_size))
        except OSError:
            pass
    tripped = len(on_disk_names) > 0 and len(victims) > len(on_disk_names) * 2 / 3
    return {"victims": victims, "onDisk": len(on_disk_names),
            "missing": len(known - on_disk_names), "inflight": inflight,
            "breakerTripped": tripped}


def scan_orphans(db: DbSession) -> dict:
    """当前与全部历史版本路径都属于有效引用，在传文件单独跳过。"""
    return _scan_orphans(referenced_storage_names(db))


def _orphan_report(scan: dict) -> dict:
    return {"orphans": len(scan["victims"]),
            "orphanBytes": sum(s for _, s in scan["victims"]),
            "missing": scan["missing"], "filesOnDisk": scan["onDisk"],
            "filesOnDiskBytes": _dir_size(FILES_DIR),
            "inflightSkipped": scan["inflight"]}


def storage_overview(db: DbSession) -> dict:
    """数据库统计先做完，磁盘扫描前归还会话；长 I/O 不持有数据库连接。"""
    totals = file_storage_totals(db)
    active_bytes, active_files = totals["active"]
    trash_bytes, trash_files = totals["trash"]
    doc_bytes = db.query(func.sum(func.length(Doc.content))).filter(
        Doc.deleted_at.is_(None)).scalar() or 0
    ver_bytes = db.query(func.sum(func.length(DocVersion.content))).scalar() or 0
    folder_count = db.query(Folder).filter(Folder.deleted_at.is_(None)).count()
    doc_count = db.query(Doc).filter(Doc.deleted_at.is_(None)).count()
    doc_version_count = db.query(DocVersion).count()
    file_version_count = db.query(FileVersion).count()
    known = referenced_storage_names(db)
    release_db(db)
    scan = _scan_orphans(known)
    return {"files": {"activeBytes": active_bytes, "activeCount": active_files,
                      "trashBytes": trash_bytes, "trashCount": trash_files,
                      "folderCount": folder_count,
                      "versionCount": file_version_count},
            "docs": {"bytes": doc_bytes, "count": doc_count,
                     "versionBytes": ver_bytes, "versionCount": doc_version_count},
            "disk": {"total": disk_total_bytes(), "free": disk_free_bytes(),
                     "used": disk_total_bytes() - disk_free_bytes(),
                     "dataDirBytes": _dir_size(FILES_DIR)},
            "limits": config.limits_json(), "orphans": _orphan_report(scan)}


def _near_quota(db: DbSession, threshold: float = 0.8) -> list[dict]:
    rows = (db.query(Project).filter(Project.is_personal.is_(False),
                                     Project.quota_bytes.isnot(None),
                                     Project.quota_bytes > 0).all())
    if not rows:
        return []
    stats = batch_stats(db, [p.id for p in rows])
    out = []
    for p in rows:
        used = int(stats.get(p.id, {}).get("storageBytes", 0))
        ratio = used / p.quota_bytes if p.quota_bytes else 0
        if ratio >= threshold:
            out.append({"id": p.id, "name": p.name,
                        "quotaBytes": p.quota_bytes, "storageBytes": used,
                        "ratio": round(ratio, 4)})
    out.sort(key=lambda x: x["ratio"], reverse=True)
    return out


def admin_overview(db: DbSession) -> dict:
    """管理总览：计数与配额在库内完成，存储磁盘扫描与备份状态读取在归还连接之后。"""
    now = utcnow()
    today = datetime(now.year, now.month, now.day)
    locked_accounts = db.query(ThrottleState).filter(
        ThrottleState.key.like(sessions.LOGIN_ACCOUNT_POLICY.name + ":%"),
        ThrottleState.locked_until > now).count()
    data = {
        "userCount": db.query(User).count(),
        "spaceCount": db.query(Project).filter(Project.is_personal.is_(False)).count(),
        "todayLoginCount": db.query(LoginEvent).filter(
            LoginEvent.result == "ok", LoginEvent.created_at >= today).count(),
        "lockedCount": locked_accounts,
        "nearQuota": _near_quota(db),
    }
    data["storage"] = storage_overview(db)   # 内部先归还数据库会话，再做磁盘 I/O
    data["backup"] = backup.status()
    return data


def diagnostics(db: DbSession, ws_pool: dict) -> dict:
    def _size(p: Path) -> int:
        try:
            return p.stat().st_size
        except OSError:
            return -1
    return {"uptimeSeconds": round(watchdog.uptime_seconds(), 1), "pid": os.getpid(),
            "pool": engine.pool.status(),
            "dbFiles": {"db": _size(DB_PATH), "wal": _size(Path(str(DB_PATH) + "-wal")),
                        "shm": _size(Path(str(DB_PATH) + "-shm"))},
            "threads": {"count": threading.active_count(),
                        "names": sorted(t.name for t in threading.enumerate())},
            "inflightUploads": len(INFLIGHT_STORAGE),
            "ws": {"perDoc": {str(k): len(v) for k, v in ws_pool.items()},
                   "total": sum(len(v) for v in ws_pool.values())},
            "sessions": db.query(AuthSession).count(),
            "loginLocks": throttle.active_count(db),
            "loginEvents": db.query(LoginEvent).count()}


def _session_json(sess: AuthSession, *, current_token: str | None = None) -> dict:
    return session_json(sess, include_user_agent=True,
                        online=sessions.is_online(sess.last_seen_at, sess.created_at),
                        current_token=current_token)


def _event_json(e: LoginEvent, user_name: str | None = None) -> dict:
    label, kind = describe_ua(e.user_agent or "")
    return {"id": e.id, "createdAt": iso(e.created_at), "result": e.result,
            "email": e.email, "ip": e.ip, "device": label, "deviceKind": kind,
            "userAgent": e.user_agent, "userName": user_name}


def user_access(db: DbSession, user_id: str, current_token: str | None) -> dict:
    user = db.get(User, user_id)
    if not user:
        err(404, NOT_FOUND, "用户不存在")
    now = utcnow()
    rows = (db.query(AuthSession).filter(AuthSession.user_id == user.id,
                                         AuthSession.expires_at > now)
            .order_by(AuthSession.created_at.desc()).all())
    events = (db.query(LoginEvent).filter(LoginEvent.user_id == user.id)
              .order_by(LoginEvent.created_at.desc()).limit(50).all())
    return {"user": user_json(user, face="access"),
            "lock": throttle.state(db, sessions.LOGIN_ACCOUNT_POLICY, user.email),
            "maxFails": sessions.LOGIN_ACCOUNT_POLICY.max_fails,
            "sessions": [_session_json(s, current_token=current_token) for s in rows],
            "events": [_event_json(e) for e in events]}


def revoke_session(db: DbSession, ref: str) -> dict:
    for sess in db.query(AuthSession).all():
        if hashlib.sha256(sess.token.encode("utf-8")).hexdigest() == ref:
            db.delete(sess)
            db.commit()
            return {"ok": True, "revoked": 1}
    err(404, NOT_FOUND, "会话不存在或已失效")


def revoke_user_sessions(db: DbSession, user_id: str) -> dict:
    user = db.get(User, user_id)
    if not user:
        err(404, NOT_FOUND, "用户不存在")
    n = db.query(AuthSession).filter(AuthSession.user_id == user.id).delete(
        synchronize_session=False)
    db.commit()
    return {"ok": True, "revoked": int(n)}


def login_events(db: DbSession, limit: int) -> list:
    rows = db.query(LoginEvent).order_by(LoginEvent.created_at.desc()).limit(limit).all()
    names = user_names(db, (r.user_id for r in rows))
    return [_event_json(r, names.get(r.user_id)) for r in rows]


def cleanup_orphans(db: DbSession, dry_run: bool, force: bool) -> dict:
    scan = scan_orphans(db)
    victims, on_disk = scan["victims"], scan["onDisk"]
    blocked = scan["breakerTripped"] and not force
    if dry_run:
        return {"dryRun": True, "orphans": len(victims),
                "orphanBytes": sum(s for _, s in victims), "filesOnDisk": on_disk,
                "inflightSkipped": scan["inflight"],
                "breakerTripped": scan["breakerTripped"], "blocked": blocked}
    if blocked:
        err(400, VALIDATION,
            f"磁盘上 {on_disk} 个文件里有 {len(victims)} 个在库中无记录(超过 2/3),"
            "已拒绝清理 —— 这个比例更像是库是空的或指错了数据目录,而不是垃圾多。"
            "确认无误请显式传 force=1。")
    removed, freed, failed = 0, 0, 0
    for path, size in victims:
        if unlink_quiet(path):
            removed += 1
            freed += size
        else:
            failed += 1
    return {"ok": True, "removed": removed, "freedBytes": freed, "failed": failed,
            "orphans": len(victims), "filesOnDisk": on_disk,
            "inflightSkipped": scan["inflight"]}


def admin_projects(db: DbSession) -> list:
    ps = db.query(Project).filter(Project.is_personal.is_(False)).order_by(Project.name.asc()).all()
    stats = batch_stats(db, [p.id for p in ps])
    owners: dict = {}
    for pid, u in (db.query(ProjectMember.project_id, User)
                   .join(User, User.id == ProjectMember.user_id)
                   .filter(ProjectMember.project_id.in_([p.id for p in ps]),
                           ProjectMember.role == "OWNER").all()):
        owners.setdefault(pid, []).append(user_json(u, face="member"))
    return [project_shape(p, face="admin", stats=stats.get(p.id, {}),
                          owners=owners.get(p.id, [])) for p in ps]
