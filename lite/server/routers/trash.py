"""回收站薄路由，含文件删除恢复与版本恢复的统一入口。"""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session as DbSession

from deps import (IdPath, get_db, pat_write_guard, require_project_role,
                  require_role)
from models import Doc, File, Folder
from security.context import Actor
from services import trash

router = APIRouter(dependencies=[Depends(pat_write_guard)])
DOC_EDIT = require_role(Doc, "文档", "EDITOR", path_param="doc_id", write=True)
DOC_TRASH = require_role(Doc, "文档", "EDITOR", path_param="doc_id", for_trash=True,
                         write=True)
FOLDER_EDIT = require_role(Folder, "文件夹", "EDITOR", path_param="folder_id", write=True)
FOLDER_TRASH = require_role(Folder, "文件夹", "EDITOR", path_param="folder_id",
                            for_trash=True, write=True)
FILE_EDIT = require_role(File, "文件", "EDITOR", path_param="file_id", write=True)
FILE_TRASH = require_role(File, "文件", "EDITOR", path_param="file_id", for_trash=True,
                          write=True)


@router.delete("/api/docs/{doc_id}")
def delete_doc(dep=Depends(DOC_EDIT), db: DbSession = Depends(get_db)):
    removed, _ = trash.soft_delete_tree(db, Doc, dep[1], dep[0])
    return trash._result("doc", removed)


@router.post("/api/docs/{doc_id}/restore")
def restore_doc(dep=Depends(DOC_TRASH), db: DbSession = Depends(get_db)):
    trash._require_in_trash(dep[1], "文档")
    restored, _ = trash.restore_tree(db, Doc, dep[1], dep[0])
    return trash._result("doc", restored)


@router.delete("/api/docs/{doc_id}/permanent")
def permanent_delete_doc(dep=Depends(DOC_TRASH), db: DbSession = Depends(get_db)):
    return trash.permanent_delete_doc(db, dep[1])


@router.delete("/api/files/folders/{folder_id}")
def delete_folder(dep=Depends(FOLDER_EDIT), db: DbSession = Depends(get_db)):
    folders, files = trash.soft_delete_tree(db, Folder, dep[1], dep[0])
    return trash._result("folder", folders + files)


@router.post("/api/files/folders/{folder_id}/restore")
def restore_folder(dep=Depends(FOLDER_TRASH), db: DbSession = Depends(get_db)):
    trash._require_in_trash(dep[1], "文件夹")
    folders, files = trash.restore_tree(db, Folder, dep[1], dep[0])
    return trash._result("folder", folders + files)


@router.delete("/api/files/folders/{folder_id}/permanent")
def permanent_delete_folder(dep=Depends(FOLDER_TRASH), db: DbSession = Depends(get_db)):
    return trash.permanent_delete_folder(db, dep[1])


@router.delete("/api/files/{file_id}")
def delete_file(dep=Depends(FILE_EDIT), db: DbSession = Depends(get_db)):
    return trash.delete_file(db, dep[1], dep[0])


@router.post("/api/files/{file_id}/restore")
def restore_file(payload: dict | None = None, dep=Depends(FILE_TRASH),
                 db: DbSession = Depends(get_db)):
    return trash.restore_file_or_version(db, dep[1], payload or {}, dep[0])


@router.delete("/api/files/{file_id}/permanent")
def permanent_delete_file(dep=Depends(FILE_TRASH), db: DbSession = Depends(get_db)):
    return trash.permanent_delete_file(db, dep[1])


@router.get("/api/projects/{project_id}/trash")
def project_trash(project_id: IdPath,
                  ctx: Actor = Depends(require_project_role("VIEWER")),
                  db: DbSession = Depends(get_db)):
    return trash.project_trash(db, project_id)
