"""搜索 HTTP 薄路由。"""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session as DbSession

from deps import current_user, get_db, pat_write_guard
from security.context import Actor
from services import search as search_service

router = APIRouter(dependencies=[Depends(pat_write_guard)])


def _truthy(value: str) -> bool:
    """查询串布尔：1/true/yes 为真，其余（含空串）为假。"""
    return (value or "").strip().lower() in ("1", "true", "yes")


@router.get("/api/search")
def search(q: str = "", type: str = "all", limit: int = 0,
           projectId: str = "", updatedBy: str = "", includeArchived: str = "",
           ctx: Actor = Depends(current_user), db: DbSession = Depends(get_db)):
    return search_service.search(db, ctx, q, type, limit,
                                 project_id=projectId, updated_by=updatedBy,
                                 include_archived=_truthy(includeArchived))
