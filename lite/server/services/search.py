"""搜索与最近动态服务。"""
from sqlalchemy import or_
from sqlalchemy.orm import Session as DbSession

from errors import bad_request
from http_util import query_id
from models import Doc, File, Project
from security.context import Actor
from serialize import file_json, iso
from services.spaces import visible_project_ids
from services.users import user_names

TYPES = ("all", "docs", "files")


def _snippet(content: str, q: str) -> str:
    idx = content.find(q)
    if idx < 0:
        return content[:120]
    start = max(0, idx - 60)
    return content[start:idx + len(q) + 60]


def _doc_row(d: Doc, project_name: str, snippet: str = "",
             updated_by_name: str | None = None) -> dict:
    return {"id": d.id, "projectId": d.project_id, "title": d.title,
            "projectName": project_name, "updatedAt": iso(d.updated_at),
            "updatedBy": d.updated_by, "updatedByName": updated_by_name,
            "snippet": snippet}


def _file_row(f: File, project_name: str) -> dict:
    return {**file_json(f), "projectId": f.project_id, "folderId": f.folder_id,
            "projectName": project_name}


def search(db: DbSession, ctx: Actor, q: str, type: str, limit: int,
           *, project_id: str = "", updated_by: str = "") -> dict:
    q = (q or "").strip()
    if type not in TYPES:
        bad_request(f"type 必须为 {'/'.join(TYPES)}")
    project_id = query_id(project_id, "projectId")
    updated_by = query_id(updated_by, "updatedBy")
    recent_mode = not q
    if recent_mode:
        if not 1 <= (limit or 20) <= 100:
            bad_request("limit 必须在 1..100 之间")
        limit = limit or 20
        visible = visible_project_ids(db, ctx.user)
    else:
        if not 1 <= (limit or 100) <= 500:
            bad_request("limit 必须在 1..500 之间")
        limit = limit or 100
        visible = visible_project_ids(db, ctx.user, site_wide=True)
    # 显式 projectId 是严格过滤：无权/不存在时返回空集，不泄露空间是否存在或内容。
    if project_id:
        if project_id not in visible:
            return {"docs": [], "files": []}
        visible = {project_id}
    if not visible:
        return {"docs": [], "files": []}
    names = {p.id: p.name for p in db.query(Project).filter(Project.id.in_(visible)).all()}
    like = f"%{q}%"
    docs_out, files_out = [], []
    if type in ("all", "docs"):
        qy = db.query(Doc).filter(Doc.deleted_at.is_(None), Doc.project_id.in_(visible))
        if not recent_mode:
            qy = qy.filter(or_(Doc.title.like(like), Doc.content.like(like)))
        if updated_by:
            qy = qy.filter(Doc.updated_by == updated_by)
        docs = qy.order_by(Doc.updated_at.desc()).limit(limit).all()
        authors = user_names(db, (d.updated_by for d in docs))
        for d in docs:
            docs_out.append(_doc_row(d, names.get(d.project_id, ""),
                                     "" if recent_mode else _snippet(d.content, q),
                                     authors.get(d.updated_by)))
    if type in ("all", "files"):
        qy = db.query(File).filter(File.deleted_at.is_(None), File.project_id.in_(visible))
        if not recent_mode:
            qy = qy.filter(File.name.like(like))
        if updated_by:
            qy = qy.filter(File.updated_by == updated_by)
        for f in qy.order_by(File.updated_at.desc()).limit(limit).all():
            files_out.append(_file_row(f, names.get(f.project_id, "")))
    return {"docs": docs_out, "files": files_out}
