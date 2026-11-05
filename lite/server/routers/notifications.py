"""站内通知 HTTP 薄路由。"""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session as DbSession

from deps import current_user, get_db, pat_write_guard
from security.context import Actor
from services import notifications

router = APIRouter(dependencies=[Depends(pat_write_guard)])


@router.get("/api/notifications")
def list_notifications(limit: int = 20, ctx: Actor = Depends(current_user),
                       db: DbSession = Depends(get_db)):
    return notifications.list_for_user(db, ctx.user.id, limit)


@router.post("/api/notifications/read")
def mark_read(payload: dict, ctx: Actor = Depends(current_user),
              db: DbSession = Depends(get_db)):
    return notifications.mark_read(db, ctx.user.id, payload.get("ids"))


@router.post("/api/notifications/read-all")
def mark_all_read(ctx: Actor = Depends(current_user),
                  db: DbSession = Depends(get_db)):
    return notifications.mark_all_read(db, ctx.user.id)
