"""文档 HTTP 薄路由；正文冲突在此映射为 409 现场。"""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session as DbSession

from deps import (IdPath, get_db, pat_write_guard, require_project_role,
                  require_role)
from errors import CONFLICT, err
from models import Doc
from security.context import Actor
from services import docs

router = APIRouter(dependencies=[Depends(pat_write_guard)])
DOC_VIEW = require_role(Doc, "文档", "VIEWER", path_param="doc_id")
DOC_EDIT = require_role(Doc, "文档", "EDITOR", path_param="doc_id", write=True)


@router.get("/api/projects/{project_id}/docs/tree")
def doc_tree(project_id: IdPath, ctx: Actor = Depends(require_project_role("VIEWER")),
             db: DbSession = Depends(get_db)):
    return docs.doc_tree(db, project_id)


@router.post("/api/projects/{project_id}/docs")
def create_doc(project_id: IdPath, payload: dict,
               ctx: Actor = Depends(require_project_role("EDITOR", write=True)),
               db: DbSession = Depends(get_db)):
    return docs.create_doc(db, project_id, payload, ctx)


@router.get("/api/docs/{doc_id}")
def get_doc(dep=Depends(DOC_VIEW), db: DbSession = Depends(get_db)):
    return docs.get_doc(db, dep[1])


@router.get("/api/docs/{doc_id}/backlinks")
def list_backlinks(dep=Depends(DOC_VIEW), db: DbSession = Depends(get_db)):
    return docs.list_backlinks(db, dep[1], dep[0])


@router.patch("/api/docs/{doc_id}")
def patch_doc(payload: dict, dep=Depends(DOC_EDIT), db: DbSession = Depends(get_db)):
    return docs.patch_doc(db, dep[1], payload, dep[0])


@router.post("/api/docs/{doc_id}/move")
def move_doc(payload: dict, dep=Depends(DOC_EDIT), db: DbSession = Depends(get_db)):
    return docs.move_doc(db, dep[1], payload, dep[0])


@router.get("/api/docs/{doc_id}/move-check")
def move_check(projectId: str = "", parentId: str = "", dep=Depends(DOC_VIEW),
               db: DbSession = Depends(get_db)):
    return docs.move_check(db, dep[1], projectId, parentId, dep[0])


@router.put("/api/docs/{doc_id}/content")
def put_content(payload: dict, dep=Depends(DOC_EDIT), db: DbSession = Depends(get_db)):
    try:
        return docs.put_content(db, dep[1], payload, dep[0])
    except docs.ContentConflict as c:
        err(409, CONFLICT, "文档已被他人修改,本次保存未写入",
            extra={"currentVersion": c.version, "currentContent": c.content,
                   "by": c.by_name})


@router.post("/api/docs/{doc_id}/append")
def append_content(payload: dict, dep=Depends(DOC_EDIT), db: DbSession = Depends(get_db)):
    return docs.append_content(db, dep[1], payload, dep[0])


@router.get("/api/docs/{doc_id}/versions")
def list_versions(dep=Depends(DOC_VIEW), db: DbSession = Depends(get_db)):
    return docs.list_versions(db, dep[1])


@router.get("/api/docs/{doc_id}/versions/{vid}")
def get_version(vid: IdPath, dep=Depends(DOC_VIEW), db: DbSession = Depends(get_db)):
    return docs.get_version(db, dep[1], vid)


@router.post("/api/docs/{doc_id}/versions/{vid}/restore")
def restore_version(vid: IdPath, dep=Depends(DOC_EDIT), db: DbSession = Depends(get_db)):
    return docs.restore_version(db, dep[1], vid, dep[0])
