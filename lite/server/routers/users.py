"""用户管理与同事目录的薄路由。"""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session as DbSession

from deps import IdPath, current_user, get_db, pat_write_guard, require_admin
from security.context import Actor
from services import users

router = APIRouter(dependencies=[Depends(pat_write_guard)])


@router.delete("/api/users/{user_id}")
def delete_user(user_id: IdPath, ctx: Actor = Depends(require_admin),
                db: DbSession = Depends(get_db)):
    return users.delete_user(db, user_id, ctx.user)


@router.get("/api/users")
def list_users(ctx: Actor = Depends(require_admin), db: DbSession = Depends(get_db)):
    return users.list_users(db)


@router.get("/api/users/directory")
def user_directory(ctx: Actor = Depends(current_user), db: DbSession = Depends(get_db)):
    return users.user_directory(db)


@router.post("/api/users")
def create_user(payload: dict, ctx: Actor = Depends(require_admin),
                db: DbSession = Depends(get_db)):
    return users.create_user(db, payload)


@router.patch("/api/users/{user_id}")
def patch_user(user_id: IdPath, payload: dict, ctx: Actor = Depends(require_admin),
               db: DbSession = Depends(get_db)):
    return users.patch_user(db, user_id, payload)
