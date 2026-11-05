"""管理端薄路由：存储、审计、备份与恢复。"""
from urllib.parse import quote

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session as DbSession

from db import get_db, release_db
from routers import ws as ws_mod
from errors import CONFLICT, VALIDATION, err
from http_util import clamp_int, query_id
from ids import IdPath
from security.context import AuthContext, pat_write_guard, require_admin
from services import audit, backup, users

router = APIRouter(dependencies=[Depends(pat_write_guard)])


@router.get("/api/admin/storage")
def storage_overview(ctx: AuthContext = Depends(require_admin),
                     db: DbSession = Depends(get_db)):
    return audit.storage_overview(db)


@router.get("/api/admin/overview")
def admin_overview(ctx: AuthContext = Depends(require_admin),
                   db: DbSession = Depends(get_db)):
    return audit.admin_overview(db)


@router.get("/api/admin/diagnostics")
def diagnostics(ctx: AuthContext = Depends(require_admin), db: DbSession = Depends(get_db)):
    return audit.diagnostics(db, ws_mod.POOL)


@router.get("/api/admin/users/{user_id}/access")
def user_access(user_id: IdPath, ctx: AuthContext = Depends(require_admin),
                db: DbSession = Depends(get_db)):
    return audit.user_access(db, user_id, ctx.session_token)


@router.delete("/api/admin/sessions/{ref}")
def revoke_session(ref: str, ctx: AuthContext = Depends(require_admin),
                   db: DbSession = Depends(get_db)):
    return audit.revoke_session(db, ref)


@router.delete("/api/admin/users/{user_id}/sessions")
def revoke_user_sessions(user_id: IdPath, ctx: AuthContext = Depends(require_admin),
                         db: DbSession = Depends(get_db)):
    return audit.revoke_user_sessions(db, user_id)


@router.get("/api/admin/login-events")
def login_events(limit: int = 100, ctx: AuthContext = Depends(require_admin),
                 db: DbSession = Depends(get_db)):
    return audit.login_events(db, clamp_int(limit, 1, 500, "limit"))


@router.get("/api/admin/pats")
def admin_pats(userId: str = "", limit: int = 100,
               ctx: AuthContext = Depends(require_admin),
               db: DbSession = Depends(get_db)):
    user_id = query_id(userId, "userId")
    return {"items": users.admin_list_pats(
        db, user_id, clamp_int(limit, 1, 500, "limit"))}


@router.post("/api/admin/storage/cleanup")
def cleanup_orphans(dryRun: bool = False, force: bool = False,
                    ctx: AuthContext = Depends(require_admin),
                    db: DbSession = Depends(get_db)):
    return audit.cleanup_orphans(db, dryRun, force)


@router.get("/api/admin/projects")
def admin_projects(ctx: AuthContext = Depends(require_admin),
                   db: DbSession = Depends(get_db)):
    return audit.admin_projects(db)


@router.get("/api/admin/backup")
def download_backup(ctx: AuthContext = Depends(require_admin),
                    db: DbSession = Depends(get_db)):
    release_db(db)
    archive, size = backup.build_download_archive()
    cd = "attachment; filename*=UTF-8''" + quote(archive.name)
    return StreamingResponse(backup.stream_archive(archive), media_type="application/zip",
                             headers={"Content-Disposition": cd,
                                      "Content-Length": str(size)})


@router.get("/api/admin/backup/status")
def backup_status(ctx: AuthContext = Depends(require_admin)):
    return backup.status()


@router.post("/api/admin/backup/run")
def backup_run_now(ctx: AuthContext = Depends(require_admin)):
    return backup.run_backup(trigger="manual")


@router.get("/api/admin/restore/status")
def restore_status(ctx: AuthContext = Depends(require_admin)):
    return backup.restore_status()


@router.post("/api/admin/restore/upload")
async def restore_upload(request: Request, ctx: AuthContext = Depends(require_admin),
                         db: DbSession = Depends(get_db)):
    try:
        declared = int(request.headers.get("content-length") or 0)
    except ValueError:
        declared = 0
    return await backup.receive_restore_upload(db, request.stream(), declared)


@router.post("/api/admin/restore/arm")
def restore_arm(ctx: AuthContext = Depends(require_admin)):
    ok, msg = backup.arm_restore()
    if not ok:
        err(400, VALIDATION, msg)
    return {"ok": True, "armed": True}


@router.delete("/api/admin/restore")
def restore_cancel(ctx: AuthContext = Depends(require_admin)):
    backup.clear_restore()
    return {"ok": True}
