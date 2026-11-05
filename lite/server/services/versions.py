"""文件版本登记、历史查询、变更轮询与 20/90 物理清理。"""
from datetime import timedelta
from pathlib import Path

from sqlalchemy.orm import Session as DbSession

from db import SessionLocal, utcnow
from errors import NOT_FOUND, bad_request, err
from models import File, FileChange, FileVersion
from serialize import file_version_json, iso
from services.users import user_names
from storage import file_abspath, storage_basename, unlink_quiet

KEEP_VERSIONS = 20
MAX_VERSION_AGE_DAYS = 90
MAX_NOTE_LEN = 200


def normalize_note(note) -> str | None:
    """版本备注：去首尾空白、空串归 None、超过 200 字拒绝。"""
    if note is None:
        return None
    if not isinstance(note, str):
        bad_request("note 必须为字符串")
    text = note.strip()
    if len(text) > MAX_NOTE_LEN:
        bad_request(f"note 不能超过 {MAX_NOTE_LEN} 个字符")
    return text or None


def record_change(db: DbSession, file: File, op: str = "upsert", *, at=None) -> FileChange:
    if op not in ("upsert", "delete"):
        raise ValueError(f"未知文件变更类型: {op}")
    change = FileChange(file_id=file.id, space_id=file.project_id, op=op,
                        at=at or utcnow())
    db.add(change)
    return change


def get_version(db: DbSession, file: File, number: int) -> FileVersion:
    if isinstance(number, bool) or not isinstance(number, int):
        bad_request("version 必须为整数")
    if number < 1:
        err(404, NOT_FOUND, "文件版本不存在")
    row = db.query(FileVersion).filter_by(file_id=file.id, version=number).first()
    if row is None:
        err(404, NOT_FOUND, "文件版本不存在")
    return row


def list_versions(db: DbSession, file: File) -> list[dict]:
    rows = (db.query(FileVersion).filter_by(file_id=file.id)
            .order_by(FileVersion.version.desc()).all())
    names = user_names(db, (v.created_by for v in rows))
    return [file_version_json(v, author_name=names.get(v.created_by)) for v in rows]


def append_version(db: DbSession, file: File, storage_path: str, size: int,
                   user_id: str, *, at=None, note: str | None = None) -> FileVersion:
    """只登记并 flush；调用方在同一最终事务里提交文件、版本和变更。"""
    now = at or utcnow()
    number = file.version + 1
    row = FileVersion(file_id=file.id, version=number, storage_path=storage_path,
                      size=size, note=note, created_by=user_id, created_at=now)
    file.version = number
    file.storage_path = storage_path
    file.size = size
    file.updated_by = user_id
    file.updated_at = now
    db.add(row)
    record_change(db, file, "upsert", at=now)
    db.flush()
    return row


def restore_version(db: DbSession, file: File, number: int, user_id: str,
                    *, note=None) -> FileVersion:
    source = get_version(db, file, number)
    text = normalize_note(note) or f"恢复自 v{number}"
    row = append_version(db, file, source.storage_path, source.size, user_id,
                         note=text)
    db.commit()
    return row


def list_changes(db: DbSession, project_id: str, since: int, limit: int) -> dict:
    if since < 0:
        bad_request("since 不能为负")
    rows = (db.query(FileChange).filter(FileChange.space_id == project_id,
                                        FileChange.seq > since)
            .order_by(FileChange.seq.asc()).limit(limit).all())
    return {"changes": [{"seq": c.seq, "fileId": c.file_id, "spaceId": c.space_id,
                         "op": c.op, "at": iso(c.at)} for c in rows],
            "nextSeq": rows[-1].seq if rows else since}


def file_paths(db: DbSession, file_ids) -> set[Path]:
    """收集当前与全部历史物理路径；调用方须在记录删除提交后再 unlink。"""
    ids = list(file_ids)
    if not ids:
        return set()
    paths = {file_abspath(p) for (p,) in
             db.query(File.storage_path).filter(File.id.in_(ids)).all() if p}
    paths |= {file_abspath(p) for (p,) in
              db.query(FileVersion.storage_path)
              .filter(FileVersion.file_id.in_(ids)).all() if p}
    return paths


def referenced_storage_names(db: DbSession) -> set[str]:
    names = {storage_basename(p) for (p,) in db.query(File.storage_path).all() if p}
    names |= {storage_basename(p) for (p,) in db.query(FileVersion.storage_path).all() if p}
    return names


def unlink_unreferenced(db: DbSession, paths) -> int:
    """物理清理前重新查全库引用，恢复产生的共享路径不会被误删。"""
    known = referenced_storage_names(db)
    removed = 0
    for path in {Path(p) for p in paths}:
        if storage_basename(str(path)) not in known and unlink_quiet(path):
            removed += 1
    return removed


def prune_old_versions(db: DbSession, *, file_id: str | None = None, now=None,
                       commit: bool = True) -> dict:
    """每文件至少留 20 版；仅清理排名 20 以外且年龄超过 90 天的版本。"""
    now = now or utcnow()
    cutoff = now - timedelta(days=MAX_VERSION_AGE_DAYS)
    query = db.query(File.id)
    if file_id is not None:
        query = query.filter(File.id == file_id)
    ids = [fid for (fid,) in query.all()]
    drop_ids: list[str] = []
    candidates: set[Path] = set()
    for fid in ids:
        current = db.get(File, fid)
        rows = (db.query(FileVersion).filter_by(file_id=fid)
                .order_by(FileVersion.version.desc()).all())
        for row in rows[KEEP_VERSIONS:]:
            if row.created_at < cutoff and row.version != current.version:
                drop_ids.append(row.id)
                candidates.add(file_abspath(row.storage_path))
    if drop_ids:
        db.query(FileVersion).filter(FileVersion.id.in_(drop_ids)).delete(
            synchronize_session=False)
    if commit:
        db.commit()
        removed = unlink_unreferenced(db, candidates)
    else:
        db.flush()
        removed = 0
    return {"files": len(ids), "removedVersions": len(drop_ids),
            "removedFiles": removed if commit else 0}


def prune_all_versions() -> dict:
    """每日维护线程入口；短事务提交后才做物理 I/O。"""
    with SessionLocal() as db:
        return prune_old_versions(db)
