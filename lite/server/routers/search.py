"""搜索 HTTP 薄路由。"""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session as DbSession

from db import get_db
from security.context import AuthContext, current_user, pat_write_guard
from services import search as search_service

router = APIRouter(dependencies=[Depends(pat_write_guard)])


@router.get("/api/search")
def search(q: str = "", type: str = "all", limit: int = 0,
           projectId: str = "", updatedBy: str = "",
           ctx: AuthContext = Depends(current_user), db: DbSession = Depends(get_db)):
    return search_service.search(db, ctx, q, type, limit,
                                 project_id=projectId, updated_by=updatedBy)
