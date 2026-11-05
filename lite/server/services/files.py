"""云空间、流式上传与文件夹业务；不依赖 FastAPI 请求对象。"""
import secrets
import tempfile
import zipfile
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path

from sqlalchemy import func
from sqlalchemy.orm import Session as DbSession

import config
from db import release_db, utcnow
from errors import CONFLICT, NAME_EXISTS, NOT_FOUND, VALIDATION, bad_request, err
from http_util import id_csv_field, opt_int, query_id, str_field
from models import Doc, File, FileChange, FileVersion, Folder
from security.context import (AuthContext, ensure_move_allowed, ensure_project_role,
                              get_project_or_404, load_live, validate_parent)
from serialize import file_json, folder_json, historical_file_json, iso
from services import refs, versions
from services.users import user_map
from storage import (FILES_DIR, INFLIGHT_STORAGE, disk_free_bytes, disk_total_bytes,
                     file_abspath, unlink_quiet)
from treeutil import build_tree, collect_subtree, location_json

MAX_UPLOAD_MB = config.MAX_UPLOAD_MB
MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024
CHUNK = 1024 * 1024
STORAGE_RESERVE_MB = config.STORAGE_RESERVE_MB
ATTACH_FOLDER_NAME = "文档附件"
_FILE_SORTS = {"name": File.name, "time": File.created_at, "size": File.size}
_FOLDER_SORTS = {"name": Folder.name, "time": Folder.created_at}
_SORTS = tuple(sorted(set(_FILE_SORTS) | set(_FOLDER_SORTS)))
_DIRECTIONS = ("asc", "desc")
ZIP_MAX_FILES = 1000
ZIP_MAX_FOLDERS = 200
ZIP_MAX_BYTES = config.ZIP_MAX_MB * 1024 * 1024


def ensure_file_access(db: DbSession, ctx: AuthContext, f: File):
    ensure_project_role(db, ctx, f.project_id, "VIEWER")


def list_files(db: DbSession, ctx: AuthContext, project_id: str, folder_id: str,
               offset: int, limit: int, sort: str, direction: str) -> dict:
    project_id = query_id(project_id, "project_id", required=True)
    folder_id = query_id(folder_id, "folderId")
    get_project_or_404(db, project_id)
    ensure_project_role(db, ctx, project_id, "VIEWER")
    if folder_id:
        validate_parent(db, Folder, folder_id, project_id, label="父文件夹")
    if sort not in _SORTS:
        bad_request(f"sort 必须为 {'/'.join(_SORTS)}")
    if direction not in _DIRECTIONS:
        bad_request(f"dir 必须为 {'/'.join(_DIRECTIONS)}")
    if not 1 <= limit <= 500:
        bad_request("limit 必须在 1..500 之间")
    if not 0 <= offset <= 2 ** 31 - 1:
        bad_request("offset 必须在 0..2147483647 之间")
    descending = direction == "desc"
    fcol = _FOLDER_SORTS.get(sort, Folder.name)
    icol = _FILE_SORTS.get(sort, File.name)
    fq = db.query(Folder).filter_by(project_id=project_id)
    iq = db.query(File).filter_by(project_id=project_id)
    if folder_id:
        fq = fq.filter(Folder.parent_id == folder_id)
        iq = iq.filter(File.folder_id == folder_id)
    else:
        fq = fq.filter(Folder.parent_id.is_(None))
        iq = iq.filter(File.folder_id.is_(None))
    fq_live = fq.filter(Folder.deleted_at.is_(None))
    iq_live = iq.filter(File.deleted_at.is_(None))
    folder_total, file_total = fq_live.count(), iq_live.count()
    folders = fq_live.order_by(fcol.desc() if descending else fcol.asc(),
                               Folder.id.asc()).limit(2000).all()
    files = (iq_live.order_by(icol.desc() if descending else icol.asc(), File.id.asc())
             .offset(offset).limit(limit).all())
    page_ids = {f.id for f in files}
    referenced_ids: set[str] = set()
    if page_ids:
        for (content,) in db.query(Doc.content).filter(
                Doc.deleted_at.is_(None), refs.sql_prefilter(Doc.content)).all():
            referenced_ids |= refs.file_ids_in(content) & page_ids
    creators = user_map(db, (f.created_by for f in files))
    return {"folders": [folder_json(f) for f in folders],
            "files": [file_json(f, face="list", referenced=f.id in referenced_ids,
                                created_by=creators.get(f.created_by)) for f in files],
            "total": {"folders": folder_total, "files": file_total},
            "offset": offset, "limit": limit,
            "hasMore": offset + len(files) < file_total}


def project_storage(db: DbSession, project_id: str) -> dict:
    totals = file_storage_totals(db, project_id)
    active_bytes, active_count = totals["active"]
    trash_bytes, trash_count = totals["trash"]
    folder_count = db.query(Folder).filter_by(project_id=project_id).filter(
        Folder.deleted_at.is_(None)).count()
    doc_bytes = db.query(func.coalesce(func.sum(func.length(Doc.content)), 0)).filter_by(
        project_id=project_id).filter(Doc.deleted_at.is_(None)).scalar() or 0
    return {"active": {"bytes": active_bytes or 0, "fileCount": active_count,
                       "folderCount": folder_count},
            "trash": {"bytes": trash_bytes or 0, "fileCount": trash_count},
            "docs": {"bytes": doc_bytes},
            "disk": {"total": disk_total_bytes(), "free": disk_free_bytes()}}


def dedupe_name(existing: set, name: str) -> str:
    if name not in existing:
        return name
    stem, dot, ext = name.rpartition(".")
    base, suffix = (stem, "." + ext) if dot else (name, "")
    n = 2
    while f"{base}({n}){suffix}" in existing:
        n += 1
    return f"{base}({n}){suffix}"


def _names_in_folder(db: DbSession, project_id: str, folder_id: str | None,
                     exclude_file: str | None = None,
                     exclude_folder: str | None = None) -> tuple[set, set]:
    fq = db.query(File.name).filter_by(project_id=project_id).filter(File.deleted_at.is_(None))
    oq = db.query(Folder.name).filter_by(project_id=project_id).filter(Folder.deleted_at.is_(None))
    fq = fq.filter(File.folder_id == folder_id) if folder_id else fq.filter(File.folder_id.is_(None))
    oq = oq.filter(Folder.parent_id == folder_id) if folder_id else oq.filter(Folder.parent_id.is_(None))
    if exclude_file:
        fq = fq.filter(File.id != exclude_file)
    if exclude_folder:
        oq = oq.filter(Folder.id != exclude_folder)
    return {n for (n,) in fq.all()}, {n for (n,) in oq.all()}


def _user_name_conflict(existing: set, existing_dirs: set, name: str, kind: str):
    if name in existing:
        err(409, CONFLICT, f"同目录下已有同名{kind}「{name}」,请换一个名称")
    if name in existing_dirs:
        err(409, CONFLICT, f"同目录下已有同名文件夹「{name}」,请换一个名称")


def _name_exists(db: DbSession, existing: File):
    updated_by_name = ""
    if existing.updated_by:
        author = user_map(db, [existing.updated_by]).get(existing.updated_by)
        updated_by_name = author.name if author else ""
    err(409, NAME_EXISTS, f"同目录下已有同名文件「{existing.name}」",
        extra={"existing": {"id": existing.id, "name": existing.name,
                            "size": existing.size, "updatedAt": iso(existing.updated_at),
                            "updatedBy": existing.updated_by,
                            "updatedByName": updated_by_name}})


def _attach_folder(db: DbSession, project_id: str) -> str:
    folder = (db.query(Folder).filter_by(project_id=project_id, parent_id=None,
                                         name=ATTACH_FOLDER_NAME)
              .filter(Folder.deleted_at.is_(None)).first())
    if folder is None:
        folder = Folder(name=ATTACH_FOLDER_NAME, project_id=project_id, parent_id=None)
        db.add(folder)
        db.flush()
    return folder.id


def create_folder(db: DbSession, payload: dict, ctx: AuthContext) -> dict:
    name = str_field(payload, "name", 100, required=True)
    from http_util import id_field, opt_id
    project_id = id_field(payload, "projectId", required=True)
    parent_id = opt_id(payload.get("parentId"))
    get_project_or_404(db, project_id)
    ensure_project_role(db, ctx, project_id, "EDITOR", write=True)
    if parent_id:
        validate_parent(db, Folder, parent_id, project_id, label="父文件夹")
    file_names, dir_names = _names_in_folder(db, project_id, parent_id)
    _user_name_conflict(file_names, dir_names, name, "文件夹")
    folder = Folder(name=name, project_id=project_id, parent_id=parent_id)
    db.add(folder)
    db.commit()
    return folder_json(folder)


def rename_folder(db: DbSession, folder: Folder, payload: dict) -> dict:
    name = str_field(payload, "name", 100, required=True)
    if name != folder.name:
        file_names, dir_names = _names_in_folder(
            db, folder.project_id, folder.parent_id, exclude_folder=folder.id)
        _user_name_conflict(file_names, dir_names, name, "文件夹")
    folder.name = name
    db.commit()
    return folder_json(folder)


def move_folder(db: DbSession, folder: Folder, payload: dict, ctx: AuthContext) -> dict:
    from http_util import id_field, opt_id
    target_id = id_field(payload, "projectId", required=True)
    src_id = folder.project_id
    ensure_move_allowed(db, ctx, src_id, target_id)
    ids = collect_subtree(db, Folder, folder)
    parent_id = opt_id(payload.get("parentId"))
    validate_parent(db, Folder, parent_id, target_id, moving=folder, label="父文件夹")
    affected = db.query(File).filter(File.folder_id.in_(ids)).all() if target_id != src_id else []
    folder.parent_id = parent_id
    if target_id != src_id:
        now = utcnow()
        for f in affected:
            db.add(FileChange(file_id=f.id, space_id=src_id, op="delete", at=now))
        folder.project_id = target_id
        db.query(Folder).filter(Folder.id.in_(ids)).update(
            {"project_id": target_id}, synchronize_session=False)
        db.query(File).filter(File.folder_id.in_(ids)).update(
            {"project_id": target_id}, synchronize_session=False)
        for f in affected:
            f.project_id = target_id
            versions.record_change(db, f, "upsert", at=now)
    db.commit()
    return {"id": folder.id, "projectId": folder.project_id,
            "parentId": folder.parent_id, "movedFolders": len(ids)}


def _reserve_breached(extra_needed: int = 0) -> bool:
    return disk_free_bytes() - extra_needed < STORAGE_RESERVE_MB * 1024 * 1024


def _check_reserve(extra_needed: int = 0):
    if _reserve_breached(extra_needed):
        err(400, VALIDATION,
            f"服务器存储空间不足(需保留 {STORAGE_RESERVE_MB}MB 余量),请联系管理员清理")


async def save_request_body(stream, path, max_bytes: int, *, on_progress=None) -> tuple:
    """异步字节流写盘并清理所有失败半成品，返回状态与已收字节数。"""
    total = 0
    try:
        with open(path, "wb") as out:
            async for chunk in stream:
                if not chunk:
                    continue
                total += len(chunk)
                if total > max_bytes:
                    unlink_quiet(path)
                    return "too_large", total
                out.write(chunk)
                if on_progress is not None and not on_progress(total):
                    unlink_quiet(path)
                    return "aborted", total
    except Exception:
        unlink_quiet(path)
        return "interrupted", total
    if total == 0:
        unlink_quiet(path)
        return "empty", 0
    return "ok", total


def raise_for_body_status(status: str, *, kind: str = "文件") -> None:
    if status == "too_large":
        err(400, VALIDATION, f"{kind}过大(上限 {MAX_UPLOAD_MB}MB)")
    if status == "aborted":
        err(400, VALIDATION,
            f"服务器存储空间不足(需保留 {STORAGE_RESERVE_MB}MB 余量),请联系管理员清理")
    if status == "interrupted":
        err(400, VALIDATION, "上传中断,请重试")
    if status == "empty":
        err(400, VALIDATION, f"请求体为空,未收到{kind}内容")


@dataclass
class UploadPlan:
    project_id: str
    folder_id: str | None
    display_name: str
    keep: bool = False
    doc_id: str | None = None
    version_of: str | None = None
    note: str | None = None


def prepare_upload(db: DbSession, ctx: AuthContext, *, project_id: str = "",
                   folder_id: str = "", doc_id: str = "", name: str = "",
                   name_mode: str = "", version_of: str = "",
                   note: str = "") -> UploadPlan:
    """落盘前鉴权与撞名预检；不创建文件或附件目录记录。"""
    if name_mode not in ("", "keep"):
        bad_request("name_mode 仅支持 keep")
    note_text = versions.normalize_note(note) if note not in ("", None) else None
    version_of = query_id(version_of, "version_of")
    if version_of and name_mode:
        bad_request("version_of 与 name_mode 不能同时使用")
    if version_of:
        target = load_live(db, File, version_of, "文件")
        ensure_project_role(db, ctx, target.project_id, "EDITOR", write=True)
        return UploadPlan(target.project_id, target.folder_id, target.name,
                          version_of=target.id, note=note_text)
    display_name = (name or "").strip()[:255] or "未命名文件"
    if doc_id:
        doc_id = query_id(doc_id, "docId", required=True)
        doc = load_live(db, Doc, doc_id, "文档")
        project_id, folder_id = doc.project_id, None
        get_project_or_404(db, project_id)
        ensure_project_role(db, ctx, project_id, "EDITOR", write=True)
        keep = True  # 编辑器同名附件沿用既有 dedupe 行为
    else:
        project_id = query_id(project_id, "projectId", required=True)
        folder_id = query_id(folder_id, "folderId")
        get_project_or_404(db, project_id)
        ensure_project_role(db, ctx, project_id, "EDITOR", write=True)
        if folder_id:
            validate_parent(db, Folder, folder_id, project_id, label="父文件夹")
        keep = name_mode == "keep"
    if not keep:
        names, _ = _names_in_folder(db, project_id, folder_id)
        if display_name in names:
            q = db.query(File).filter_by(project_id=project_id, name=display_name).filter(
                File.deleted_at.is_(None))
            q = q.filter(File.folder_id == folder_id) if folder_id else q.filter(File.folder_id.is_(None))
            _name_exists(db, q.first())
    else:
        names, _ = _names_in_folder(db, project_id, folder_id)
        display_name = dedupe_name(names, display_name)
    return UploadPlan(project_id, folder_id, display_name, keep=keep,
                      doc_id=doc_id or None)


async def store_upload(db: DbSession, ctx: AuthContext, plan: UploadPlan, stream,
                       declared_bytes: int = 0) -> File:
    """关闭会话流式写盘，最终事务重验并登记当前版本与 file_changes。"""
    if declared_bytes:
        if declared_bytes > MAX_UPLOAD_BYTES:
            err(400, VALIDATION, f"文件过大(上限 {MAX_UPLOAD_MB}MB)")
        if declared_bytes > disk_free_bytes():
            err(400, VALIDATION, "服务器存储空间不足,请联系管理员清理")
    _check_reserve()
    storage_name = secrets.token_hex(16)
    path = file_abspath(storage_name)
    release_db(db)
    INFLIGHT_STORAGE.add(storage_name)

    def _reserve_ok(total):
        return not (total % (16 * CHUNK) < CHUNK and _reserve_breached())

    try:
        status, total = await save_request_body(stream, path, MAX_UPLOAD_BYTES,
                                                on_progress=_reserve_ok)
        raise_for_body_status(status)
        now = utcnow()
        if plan.version_of:
            f = load_live(db, File, plan.version_of, "文件")
            ensure_project_role(db, ctx, f.project_id, "EDITOR", write=True)
            versions.append_version(db, f, storage_name, total, ctx.user.id,
                                    at=now, note=plan.note)
        else:
            project_id = plan.project_id
            folder_id = plan.folder_id
            if plan.doc_id:
                doc = load_live(db, Doc, plan.doc_id, "文档")
                project_id = doc.project_id
                folder_id = _attach_folder(db, project_id)
            get_project_or_404(db, project_id)
            ensure_project_role(db, ctx, project_id, "EDITOR", write=True)
            if folder_id:
                validate_parent(db, Folder, folder_id, project_id, label="父文件夹")
            names, _ = _names_in_folder(db, project_id, folder_id)
            display_name = plan.display_name
            if display_name in names:
                if plan.keep:
                    display_name = dedupe_name(names, display_name)
                else:
                    q = db.query(File).filter_by(project_id=project_id, name=display_name).filter(
                        File.deleted_at.is_(None))
                    q = q.filter(File.folder_id == folder_id) if folder_id else q.filter(
                        File.folder_id.is_(None))
                    _name_exists(db, q.first())
            f = File(name=display_name, project_id=project_id, folder_id=folder_id,
                     created_by=ctx.user.id, updated_by=ctx.user.id,
                     created_at=now, updated_at=now, version=1,
                     storage_path=storage_name, size=total)
            db.add(f)
            db.flush()
            db.add(FileVersion(file_id=f.id, version=1, storage_path=storage_name,
                               size=total, created_by=ctx.user.id, created_at=now))
            versions.record_change(db, f, "upsert", at=now)
        db.commit()
        return f
    except Exception:
        unlink_quiet(path)
        db.rollback()
        raise
    finally:
        INFLIGHT_STORAGE.discard(storage_name)


def folder_tree(db: DbSession, project_id: str) -> list:
    folders = (db.query(Folder).filter_by(project_id=project_id)
               .filter(Folder.deleted_at.is_(None))
               .order_by(Folder.name.asc()).limit(2000).all())
    return build_tree(folders, lambda f: folder_json(f, face="tree"))


def move_file(db: DbSession, f: File, payload: dict, ctx: AuthContext) -> dict:
    from http_util import id_field, opt_id
    target_id = id_field(payload, "projectId", required=True)
    folder_id = opt_id(payload.get("folderId"))
    src_id = f.project_id
    ensure_move_allowed(db, ctx, src_id, target_id)
    validate_parent(db, Folder, folder_id, target_id, label="目标文件夹")
    now = utcnow()
    if target_id != src_id:
        db.add(FileChange(file_id=f.id, space_id=src_id, op="delete", at=now))
    f.project_id = target_id
    f.folder_id = folder_id
    f.updated_by = ctx.user.id
    f.updated_at = now
    versions.record_change(db, f, "upsert", at=now)
    db.commit()
    return {"id": f.id, "projectId": f.project_id, "folderId": f.folder_id}


def download_source(db: DbSession, f: File, number: int | None = None) -> tuple[str, Path]:
    row = versions.get_version(db, f, number) if number is not None else None
    path = file_abspath(row.storage_path if row else f.storage_path)
    if not path.is_file():
        err(404, NOT_FOUND, "文件内容不存在")
    return f.name, path


def shared_file(db: DbSession, token: str) -> File:
    f = db.query(File).filter(File.share_token == token).first() if token else None
    if not f or f.deleted_at is not None:
        err(404, NOT_FOUND, "分享链接无效")
    if f.share_expires_at is not None and f.share_expires_at < utcnow():
        err(404, NOT_FOUND, "分享链接已过期")
    return f


def share_file(db: DbSession, f: File, payload: dict) -> dict:
    days = opt_int(payload.get("expireDays"))
    if days is not None and days < 0:
        bad_request("expireDays 不能为负")
    f.share_token = secrets.token_urlsafe(32)
    f.share_expires_at = utcnow() + timedelta(days=days) if days else None
    db.commit()
    return {"token": f.share_token, "url": f"/api/share/{f.share_token}",
            "expiresAt": iso(f.share_expires_at)}


def unshare_file(db: DbSession, f: File) -> dict:
    f.share_token = None
    f.share_expires_at = None
    db.commit()
    return {"ok": True}


def file_meta(db: DbSession, f: File, number: int | None = None) -> dict:
    if number is not None:
        return historical_file_json(f, versions.get_version(db, f, number))
    return file_json(f, face="meta",
                     location=location_json(db, f.project_id, Folder, f.folder_id, "name"))


def rename_file(db: DbSession, f: File, payload: dict, ctx: AuthContext) -> dict:
    if "name" in payload:
        name = str_field(payload, "name", 255, required=True)
        if name != f.name:
            file_names, dir_names = _names_in_folder(
                db, f.project_id, f.folder_id, exclude_file=f.id)
            _user_name_conflict(file_names, dir_names, name, "文件")
        f.name = name
        f.updated_by = ctx.user.id
        f.updated_at = utcnow()
        versions.record_change(db, f, "upsert", at=f.updated_at)
    db.commit()
    return file_json(f)


def chunked_file(fh, chunk: int = CHUNK):
    while True:
        data = fh.read(chunk)
        if not data:
            return
        yield data


def _safe_seg(name: str) -> str:
    return name.replace("/", "_").replace("\\", "_").replace("..", "_").strip() or "未命名"


def _ensure_zip_count(n: int) -> None:
    if n > ZIP_MAX_FILES:
        err(400, VALIDATION, f"一次最多打包 {ZIP_MAX_FILES} 个文件(含文件夹展开),请减少选择")


def file_storage_totals(db: DbSession, project_id: str | None = None) -> dict:
    base = db.query(func.coalesce(func.sum(File.size), 0), func.count(File.id))
    if project_id is not None:
        base = base.filter(File.project_id == project_id)
    active = base.filter(File.deleted_at.is_(None)).one()
    trash = base.filter(File.deleted_at.isnot(None)).one()
    return {"active": (active[0] or 0, active[1]), "trash": (trash[0] or 0, trash[1])}


def _collect_zip_targets(db: DbSession, ctx: AuthContext, file_ids: list[str],
                         folder_ids: list[str]) -> list[tuple[str, File]]:
    wanted: list[tuple[str, File]] = []
    for f in db.query(File).filter(File.id.in_(file_ids), File.deleted_at.is_(None)).all():
        ensure_project_role(db, ctx, f.project_id, "VIEWER")
        wanted.append(("", f))
    for fid in folder_ids:
        folder = load_live(db, Folder, fid, "文件夹")
        ensure_project_role(db, ctx, folder.project_id, "VIEWER")
        ids = collect_subtree(db, Folder, folder)
        folders = {x.id: x for x in db.query(Folder).filter(Folder.id.in_(ids)).all()}
        rel: dict[str, str] = {folder.id: _safe_seg(folder.name)}
        children_of: dict[str, list] = {}
        for x in folders.values():
            children_of.setdefault(x.parent_id, []).append(x)
        pending = [folder.id]
        while pending:
            cur = pending.pop(0)
            for child in children_of.get(cur, ()):
                if child.id == folder.id:
                    continue
                rel[child.id] = rel[cur] + "/" + _safe_seg(child.name)
                pending.append(child.id)
        files = (db.query(File).filter(File.folder_id.in_(ids), File.deleted_at.is_(None))
                 .order_by(File.created_at.asc()).all())
        for f in files:
            wanted.append((rel.get(f.folder_id, _safe_seg(folder.name)), f))
        _ensure_zip_count(len(wanted))
    return wanted


def prepare_zip(db: DbSession, ctx: AuthContext, ids: str, folder_ids: str) -> tuple[list, int]:
    file_ids = id_csv_field(ids, "ids")
    folder_id_list = id_csv_field(folder_ids, "folderIds")
    if not file_ids and not folder_id_list:
        bad_request("ids 与 folderIds 不能同时为空")
    if len(file_ids) > ZIP_MAX_FILES or len(folder_id_list) > ZIP_MAX_FOLDERS:
        err(400, VALIDATION,
            f"一次最多打包 {ZIP_MAX_FILES} 个文件 / {ZIP_MAX_FOLDERS} 个文件夹,请减少选择")
    targets = _collect_zip_targets(db, ctx, file_ids, folder_id_list)
    if not targets:
        err(404, NOT_FOUND, "没有可下载的文件")
    _ensure_zip_count(len(targets))
    declared = sum(f.size or 0 for _prefix, f in targets)
    if declared > ZIP_MAX_BYTES:
        err(400, VALIDATION,
            f"所选文件合计 {declared // (1024 * 1024)}MB,超过单次打包上限 "
            f"{ZIP_MAX_BYTES // (1024 * 1024)}MB,请分批下载")
    entries = [(prefix, str(file_abspath(f.storage_path)), _safe_seg(f.name))
               for prefix, f in targets]
    release_db(db)
    spool = tempfile.SpooledTemporaryFile(max_size=64 * 1024 * 1024)
    used: set = set()
    with zipfile.ZipFile(spool, "w", zipfile.ZIP_DEFLATED) as z:
        for prefix, stored, base in entries:
            path = Path(stored)
            if not path.is_file():
                continue
            arc = dedupe_name(used, (prefix + "/" + base) if prefix else base)
            used.add(arc)
            z.write(stored, arcname=arc)
    spool.seek(0, 2)
    total = spool.tell()
    spool.seek(0)
    return (spool, total), declared
