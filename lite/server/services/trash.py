"""回收站树操作、文件版本恢复分发与彻底删除。"""
from sqlalchemy.orm import Session as DbSession

from db import utcnow
from errors import CONFLICT, err
from http_util import int_field
from models import Doc, DocVersion, File, FileVersion, Folder
from security.context import AuthContext
from serialize import file_json, iso
from services import versions
from treeutil import collect_subtree, next_sort


def _result(kind: str, count: int) -> dict:
    return {"ok": True, "kind": kind, "count": count}


def soft_delete_tree(db: DbSession, model, root, ctx: AuthContext) -> tuple:
    ids = collect_subtree(db, model, root)
    now = utcnow()
    main = db.query(model).filter(model.id.in_(ids), model.deleted_at.is_(None)).update(
        {"deleted_at": now}, synchronize_session=False)
    files = []
    if model is Folder:
        files = db.query(File).filter(File.folder_id.in_(ids), File.deleted_at.is_(None)).all()
        for f in files:
            f.deleted_at = now
            f.updated_by = ctx.user.id
            f.updated_at = now
            versions.record_change(db, f, "delete", at=now)
    db.commit()
    return main, len(files)


def restore_tree(db: DbSession, model, root, ctx: AuthContext) -> tuple:
    ids = collect_subtree(db, model, root)
    main = db.query(model).filter(model.id.in_(ids), model.deleted_at.isnot(None)).update(
        {"deleted_at": None}, synchronize_session=False)
    files = []
    if model is Folder:
        now = utcnow()
        files = db.query(File).filter(File.folder_id.in_(ids), File.deleted_at.isnot(None)).all()
        for f in files:
            f.deleted_at = None
            f.updated_by = ctx.user.id
            f.updated_at = now
            versions.record_change(db, f, "upsert", at=now)
    if root.parent_id and root.parent_id not in set(ids) \
            and _parent_gone(db, model, root.parent_id, root.project_id):
        patch = {"parent_id": None}
        if model is Doc:
            patch["sort"] = next_sort(db, model, root.project_id, None)
        db.query(model).filter(model.id == root.id).update(patch, synchronize_session=False)
    db.commit()
    return main, len(files)


def _require_in_trash(obj, kind: str) -> None:
    if obj.deleted_at is None:
        err(409, CONFLICT, f"{kind}不在回收站")


def _parent_gone(db: DbSession, model, parent_id, project_id) -> bool:
    if not parent_id:
        return False
    parent = db.get(model, parent_id)
    return (parent is None or parent.deleted_at is not None
            or parent.project_id != project_id)


def permanent_delete_doc(db: DbSession, doc: Doc) -> dict:
    _require_in_trash(doc, "文档")
    ids = collect_subtree(db, Doc, doc)
    db.query(DocVersion).filter(DocVersion.doc_id.in_(ids)).delete(synchronize_session=False)
    db.query(Doc).filter(Doc.id.in_(ids)).delete(synchronize_session=False)
    db.commit()
    return _result("doc", len(ids))


def permanent_delete_folder(db: DbSession, folder: Folder) -> dict:
    _require_in_trash(folder, "文件夹")
    ids = collect_subtree(db, Folder, folder)
    files = db.query(File).filter(File.folder_id.in_(ids)).all()
    file_ids = [f.id for f in files]
    paths = versions.file_paths(db, file_ids)
    if file_ids:
        db.query(FileVersion).filter(FileVersion.file_id.in_(file_ids)).delete(
            synchronize_session=False)
        db.query(File).filter(File.id.in_(file_ids)).delete(synchronize_session=False)
    db.query(Folder).filter(Folder.id.in_(ids)).delete(synchronize_session=False)
    db.commit()
    versions.unlink_unreferenced(db, paths)
    return _result("folder", len(ids) + len(files))


def delete_file(db: DbSession, f: File, ctx: AuthContext) -> dict:
    now = utcnow()
    f.deleted_at = now
    f.updated_by = ctx.user.id
    f.updated_at = now
    versions.record_change(db, f, "delete", at=now)
    db.commit()
    return _result("file", 1)


def restore_deleted_file(db: DbSession, f: File, ctx: AuthContext) -> dict:
    _require_in_trash(f, "文件")
    if _parent_gone(db, Folder, f.folder_id, f.project_id):
        f.folder_id = None
    now = utcnow()
    f.deleted_at = None
    f.updated_by = ctx.user.id
    f.updated_at = now
    versions.record_change(db, f, "upsert", at=now)
    db.commit()
    return _result("file", 1)


def restore_file_or_version(db: DbSession, f: File, payload: dict | None,
                            ctx: AuthContext) -> dict:
    """同一路由按删除状态区分回收站恢复与文件版本恢复。"""
    if f.deleted_at is not None:
        return restore_deleted_file(db, f, ctx)
    number = int_field(payload, "version", required=True)
    versions.restore_version(db, f, number, ctx.user.id, note=payload.get("note"))
    return file_json(f)


def permanent_delete_file(db: DbSession, f: File) -> dict:
    _require_in_trash(f, "文件")
    paths = versions.file_paths(db, [f.id])
    db.query(FileVersion).filter_by(file_id=f.id).delete(synchronize_session=False)
    db.delete(f)
    db.commit()
    versions.unlink_unreferenced(db, paths)
    return _result("file", 1)


def project_trash(db: DbSession, project_id: str) -> dict:
    docs = (db.query(Doc).filter_by(project_id=project_id).filter(Doc.deleted_at.isnot(None))
            .order_by(Doc.deleted_at.desc()).limit(500).all())
    files = (db.query(File).filter_by(project_id=project_id).filter(File.deleted_at.isnot(None))
             .order_by(File.deleted_at.desc()).limit(500).all())
    folders = (db.query(Folder).filter_by(project_id=project_id).filter(Folder.deleted_at.isnot(None))
               .order_by(Folder.deleted_at.desc()).limit(500).all())
    deleted_doc_ids = {d.id for d in docs}
    docs = [d for d in docs if not d.parent_id or d.parent_id not in deleted_doc_ids]
    deleted_folder_ids = {fid for (fid,) in db.query(Folder.id)
                          .filter_by(project_id=project_id)
                          .filter(Folder.deleted_at.isnot(None)).all()}
    folders = [f for f in folders if not f.parent_id or f.parent_id not in deleted_folder_ids]
    files = [f for f in files if not f.folder_id or f.folder_id not in deleted_folder_ids]
    return {"docs": [{"id": d.id, "title": d.title, "deletedAt": iso(d.deleted_at)} for d in docs],
            "files": [{**file_json(f), "deletedAt": iso(f.deleted_at)} for f in files],
            "folders": [{"id": f.id, "name": f.name, "deletedAt": iso(f.deleted_at)}
                        for f in folders]}
