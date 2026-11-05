"""空间与成员 HTTP 薄路由，公开路径保持 /api/projects。"""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session as DbSession

from deps import (IdPath, current_user, get_db, pat_write_guard,
                  require_project_role)
from security.context import Actor
from services import spaces

router = APIRouter(dependencies=[Depends(pat_write_guard)])


@router.get("/api/discover/projects")
def discover_projects(ctx: Actor = Depends(current_user), db: DbSession = Depends(get_db)):
    return spaces.discover_projects(db, ctx)


@router.post("/api/projects")
def create_project(payload: dict, ctx: Actor = Depends(current_user),
                   db: DbSession = Depends(get_db)):
    return spaces.create_project(db, payload, ctx)


@router.get("/api/projects")
def list_projects(all: str = "", archived: str = "",
                  ctx: Actor = Depends(current_user),
                  db: DbSession = Depends(get_db)):
    return spaces.list_projects(db, all, archived, ctx)


@router.get("/api/projects/{project_id}")
def get_project(project_id: IdPath, ctx: Actor = Depends(require_project_role("VIEWER")),
                db: DbSession = Depends(get_db)):
    return spaces.get_project(db, project_id, ctx)


@router.patch("/api/projects/{project_id}")
def patch_project(project_id: IdPath, payload: dict,
                  ctx: Actor = Depends(require_project_role("ADMIN")),
                  db: DbSession = Depends(get_db)):
    return spaces.patch_project(db, project_id, payload, ctx)


@router.delete("/api/projects/{project_id}")
def delete_project(project_id: IdPath, ctx: Actor = Depends(require_project_role("ADMIN")),
                   db: DbSession = Depends(get_db)):
    return spaces.delete_project(db, project_id, ctx)


@router.post("/api/projects/{project_id}/transfer")
def transfer_project(project_id: IdPath, payload: dict,
                     ctx: Actor = Depends(require_project_role("ADMIN", write=True)),
                     db: DbSession = Depends(get_db)):
    return spaces.transfer_project(db, project_id, payload, ctx)


@router.get("/api/projects/{project_id}/members")
def list_members(project_id: IdPath, ctx: Actor = Depends(require_project_role("VIEWER")),
                 db: DbSession = Depends(get_db)):
    return spaces.list_members(db, project_id)


@router.post("/api/projects/{project_id}/members")
def add_member(project_id: IdPath, payload: dict,
               ctx: Actor = Depends(require_project_role("ADMIN", write=True)),
               db: DbSession = Depends(get_db)):
    return spaces.add_member(db, project_id, payload, ctx)


@router.patch("/api/projects/{project_id}/members/{user_id}")
def patch_member(project_id: IdPath, user_id: IdPath, payload: dict,
                 ctx: Actor = Depends(require_project_role("ADMIN", write=True)),
                 db: DbSession = Depends(get_db)):
    return spaces.patch_member(db, project_id, user_id, payload, ctx)


@router.delete("/api/projects/{project_id}/members/{user_id}")
def remove_member(project_id: IdPath, user_id: IdPath,
                  ctx: Actor = Depends(require_project_role("ADMIN", write=True)),
                  db: DbSession = Depends(get_db)):
    return spaces.remove_member(db, project_id, user_id)


@router.post("/api/projects/{project_id}/join")
def join_project(project_id: IdPath, ctx: Actor = Depends(current_user),
                 db: DbSession = Depends(get_db)):
    return spaces.join_project(db, project_id, ctx)


@router.post("/api/projects/{project_id}/leave")
def leave_project(project_id: IdPath, ctx: Actor = Depends(require_project_role("VIEWER")),
                  db: DbSession = Depends(get_db)):
    return spaces.leave_project(db, project_id, ctx)
