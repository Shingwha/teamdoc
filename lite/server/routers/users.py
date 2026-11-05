"""用户管理与同事目录的薄路由。"""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session as DbSession

from db import get_db
from ids import IdPath
from security.context import AuthContext, current_user, pat_write_guard, require_admin
from services import users

router = APIRouter(dependencies=[Depends(pat_write_guard)])


@router.delete("/api/users/{user_id}")
def delete_user(user_id: IdPath, ctx: AuthContext = Depends(require_admin),
                db: DbSession = Depends(get_db)):
    return users.delete_user(db, user_id, ctx.user)


@router.get("/api/users")
def list_users(ctx: AuthContext = Depends(require_admin), db: DbSession = Depends(get_db)):
    return users.list_users(db)


@router.get("/api/users/directory")
def user_directory(ctx: AuthContext = Depends(current_user), db: DbSession = Depends(get_db)):
    return users.user_directory(db)


@router.post("/api/users")
def create_user(payload: dict, ctx: AuthContext = Depends(require_admin),
                db: DbSession = Depends(get_db)):
    return users.create_user(db, payload)


@router.patch("/api/users/{user_id}")
def patch_user(user_id: IdPath, payload: dict, ctx: AuthContext = Depends(require_admin),
               db: DbSession = Depends(get_db)):
    return users.patch_user(db, user_id, payload)
