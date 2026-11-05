"""云空间 HTTP 薄路由；文件响应与流式响应只在此组装。"""
from urllib.parse import quote

from fastapi import APIRouter, Depends, Request
from fastapi.responses import FileResponse, StreamingResponse
from sqlalchemy.orm import Session as DbSession

from db import release_db
from deps import (IdPath, current_user, declared_bytes, get_db, pat_write_guard,
                  require_project_role, require_role)
from http_util import clamp_int
from media import can_inline, guess_mime
from models import File, Folder
from security.context import Actor, load_live
from serialize import file_json
from services import files, versions

router = APIRouter(dependencies=[Depends(pat_write_guard)])
FILE_VIEW = require_role(File, "文件", "VIEWER", path_param="file_id")
FILE_EDIT = require_role(File, "文件", "EDITOR", path_param="file_id", write=True)
FOLDER_EDIT = require_role(Folder, "文件夹", "EDITOR", path_param="folder_id", write=True)


def _file_response(db: DbSession, name: str, path, inline: str):
    mime = guess_mime(name)
    if inline == "1" and can_inline(mime):
        disposition, media = "inline", mime
    else:
        disposition = "attachment"
        media = mime if can_inline(mime) else "application/octet-stream"
    cd = f"{disposition}; filename*=UTF-8''{quote(name)}"
    release_db(db)
    return FileResponse(str(path), media_type=media,
                        headers={"Content-Disposition": cd,
                                 "X-Content-Type-Options": "nosniff"})


@router.get("/api/files")
def list_files(project_id: str = "", folder_id: str = "", offset: int = 0,
               limit: int = 100, sort: str = "name", dir: str = "asc",
               ctx: Actor = Depends(current_user), db: DbSession = Depends(get_db)):
    return files.list_files(db, ctx, project_id, folder_id, offset, limit, sort, dir)


@router.get("/api/projects/{project_id}/storage")
def project_storage(project_id: IdPath,
                    ctx: Actor = Depends(require_project_role("VIEWER")),
                    db: DbSession = Depends(get_db)):
    return files.project_storage(db, project_id)


@router.post("/api/files/folders")
def create_folder(payload: dict, ctx: Actor = Depends(current_user),
                  db: DbSession = Depends(get_db)):
    return files.create_folder(db, payload, ctx)


@router.patch("/api/files/folders/{folder_id}")
def rename_folder(payload: dict, dep=Depends(FOLDER_EDIT), db: DbSession = Depends(get_db)):
    return files.rename_folder(db, dep[1], payload)


@router.post("/api/files/folders/{folder_id}/move")
def move_folder(payload: dict, dep=Depends(FOLDER_EDIT), db: DbSession = Depends(get_db)):
    return files.move_folder(db, dep[1], payload, dep[0])


@router.post("/api/files/upload")
async def upload_file(request: Request, projectId: str = "", folderId: str = "",
                      docId: str = "", name: str = "", name_mode: str = "",
                      version_of: str = "", ctx: Actor = Depends(current_user),
                      db: DbSession = Depends(get_db)):
    plan = files.prepare_upload(db, ctx, project_id=projectId, folder_id=folderId,
                                doc_id=docId, name=name, name_mode=name_mode,
                                version_of=version_of)
    f = await files.store_upload(db, ctx, plan, request.stream(),
                                 declared_bytes(request))
    return file_json(f)


@router.get("/api/projects/{project_id}/folders/tree")
def folder_tree(project_id: IdPath,
                ctx: Actor = Depends(require_project_role("VIEWER")),
                db: DbSession = Depends(get_db)):
    return files.folder_tree(db, project_id)


@router.get("/api/projects/{project_id}/file-changes")
def file_changes(project_id: IdPath, since: int = 0, limit: int = 200,
                 ctx: Actor = Depends(require_project_role("VIEWER")),
                 db: DbSession = Depends(get_db)):
    limit = clamp_int(limit, 1, 500, "limit")
    return versions.list_changes(db, project_id, since, limit)


@router.get("/api/files/zip")
def zip_files(ids: str = "", folderIds: str = "",
              ctx: Actor = Depends(current_user), db: DbSession = Depends(get_db)):
    (spool, total), _declared = files.prepare_zip(db, ctx, ids, folderIds)

    def gen():
        try:
            yield from files.chunked_file(spool)
        finally:
            spool.close()

    cd = "attachment; filename*=UTF-8''" + quote("文件打包.zip")
    return StreamingResponse(gen(), media_type="application/zip",
                             headers={"Content-Disposition": cd,
                                      "Content-Length": str(total)})


@router.post("/api/files/{file_id}/versions")
async def upload_version(file_id: IdPath, request: Request, name: str = "",
                         note: str = "", ctx: Actor = Depends(current_user),
                         db: DbSession = Depends(get_db)):
    plan = files.prepare_upload(db, ctx, name=name, version_of=file_id, note=note)
    f = await files.store_upload(db, ctx, plan, request.stream(),
                                 declared_bytes(request))
    return file_json(f)


@router.get("/api/files/{file_id}/versions")
def list_file_versions(dep=Depends(FILE_VIEW), db: DbSession = Depends(get_db)):
    return versions.list_versions(db, dep[1])


@router.post("/api/files/{file_id}/move")
def move_file(payload: dict, dep=Depends(FILE_EDIT), db: DbSession = Depends(get_db)):
    return files.move_file(db, dep[1], payload, dep[0])


@router.get("/api/files/{file_id}/download")
def download_file(file_id: IdPath, inline: str = "", version: int | None = None,
                  ctx: Actor = Depends(current_user), db: DbSession = Depends(get_db)):
    f = load_live(db, File, file_id, "文件")
    files.ensure_file_access(db, ctx, f)
    name, path = files.download_source(db, f, version)
    return _file_response(db, name, path, inline)


@router.get("/api/share/{token}")
def shared_download(token: str, inline: str = "", db: DbSession = Depends(get_db)):
    f = files.shared_file(db, token)
    name, path = files.download_source(db, f)
    return _file_response(db, name, path, inline)


@router.post("/api/files/{file_id}/share")
def share_file(payload: dict, dep=Depends(FILE_EDIT), db: DbSession = Depends(get_db)):
    return files.share_file(db, dep[1], payload)


@router.delete("/api/files/{file_id}/share")
def unshare_file(dep=Depends(FILE_EDIT), db: DbSession = Depends(get_db)):
    return files.unshare_file(db, dep[1])


@router.get("/api/files/{file_id}/meta")
def file_meta(file_id: IdPath, ctx: Actor = Depends(current_user),
              db: DbSession = Depends(get_db)):
    f = load_live(db, File, file_id, "文件")
    files.ensure_file_access(db, ctx, f)
    return files.file_meta(db, f)


@router.get("/api/files/{file_id}")
def file_detail(file_id: IdPath, version: int | None = None,
                ctx: Actor = Depends(current_user), db: DbSession = Depends(get_db)):
    f = load_live(db, File, file_id, "文件")
    files.ensure_file_access(db, ctx, f)
    return files.file_meta(db, f, version)


@router.patch("/api/files/{file_id}")
def rename_file(payload: dict, dep=Depends(FILE_EDIT), db: DbSession = Depends(get_db)):
    return files.rename_file(db, dep[1], payload, dep[0])
