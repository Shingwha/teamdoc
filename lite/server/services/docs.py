"""文档树、正文保存、冲突判定与历史版本服务。"""
import config
from sqlalchemy import func
from sqlalchemy.orm import Session as DbSession

from db import utcnow
from errors import CONFLICT, NOT_FOUND, bad_request, err
from http_util import id_field, int_field, opt_id, query_id, str_field
from models import Doc, DocVersion, File, Project, User
from security.context import (AuthContext, ensure_move_allowed, get_project_or_404,
                              validate_parent)
from serialize import doc_json, version_json
from services import refs
from services.spaces import visible_project_ids
from services.users import user_names
from treeutil import build_tree, collect_subtree, location_json, next_sort

VERSION_MERGE_MINUTES = config.VERSION_MERGE_MINUTES
VERSION_KINDS = ("save", "restore")
_DAY = 86400
_HOUR = 3600


class ContentConflict(Exception):
    def __init__(self, version: int, content: str, by_name: str):
        super().__init__(f"content conflict at version {version}")
        self.version = version
        self.content = content
        self.by_name = by_name


def _user_name(db: DbSession, user_id: str | None) -> str:
    if not user_id:
        return ""
    u = db.get(User, user_id)
    return u.name if u else ""


def str_content(payload: dict) -> str | None:
    content = payload.get("content")
    return content if isinstance(content, str) else None


def doc_brief(doc: Doc) -> dict:
    return doc_json(doc, face="brief")


def doc_tree(db: DbSession, project_id: str) -> list:
    docs = (db.query(Doc).filter_by(project_id=project_id).filter(Doc.deleted_at.is_(None))
            .order_by(Doc.sort.asc(), Doc.id.asc()).all())
    return build_tree(docs, lambda d: doc_json(d, face="tree"))


def create_doc(db: DbSession, project_id: str, payload: dict, ctx: AuthContext) -> dict:
    get_project_or_404(db, project_id)
    title = str_field(payload, "title", 200) or "无标题文档"
    parent_id = opt_id(payload.get("parentId"))
    validate_parent(db, Doc, parent_id, project_id)
    doc = Doc(project_id=project_id, parent_id=parent_id, title=title,
              sort=next_sort(db, Doc, project_id, parent_id),
              created_by=ctx.user.id, updated_by=ctx.user.id)
    db.add(doc)
    db.commit()
    return doc_brief(doc)


def get_doc(db: DbSession, doc: Doc) -> dict:
    return doc_json(doc, face="full",
                    location=location_json(db, doc.project_id, Doc, doc.parent_id, "title"))


def list_backlinks(db: DbSession, doc: Doc, ctx: AuthContext) -> list:
    visible = visible_project_ids(db, ctx.user)
    rows = (db.query(Doc).filter(Doc.deleted_at.is_(None), Doc.id != doc.id,
                                 Doc.project_id.in_(visible),
                                 refs.sql_prefilter(Doc.content))
            .order_by(Doc.updated_at.desc()).limit(200).all())
    hits = [d for d in rows if doc.id in refs.doc_ids_in(d.content)]
    projects = {p.id: p.name for p in
                db.query(Project).filter(Project.id.in_({d.project_id for d in hits})).all()}
    return [doc_json(d, face="backlink", project_name=projects.get(d.project_id, ""))
            for d in hits[:100]]


def patch_doc(db: DbSession, doc: Doc, payload: dict, ctx: AuthContext) -> dict:
    if "title" in payload:
        doc.title = str_field(payload, "title", 200, required=True)
    if "parentId" in payload:
        parent_id = opt_id(payload["parentId"])
        validate_parent(db, Doc, parent_id, doc.project_id, moving=doc, label="父文档")
        if parent_id != doc.parent_id:
            doc.sort = next_sort(db, Doc, doc.project_id, parent_id)
        doc.parent_id = parent_id
    doc.updated_by = ctx.user.id
    doc.updated_at = utcnow()
    db.commit()
    return doc_brief(doc)


def move_doc(db: DbSession, doc: Doc, payload: dict, ctx: AuthContext) -> dict:
    target_id = id_field(payload, "projectId", required=True)
    parent_id = opt_id(payload.get("parentId"))
    src_id = doc.project_id
    ensure_move_allowed(db, ctx, src_id, target_id)
    validate_parent(db, Doc, parent_id, target_id, moving=doc, label="父文档")
    subtree = collect_subtree(db, Doc, doc)
    doc.parent_id = parent_id
    doc.sort = next_sort(db, Doc, target_id, parent_id)
    moved = subtree
    if target_id != src_id:
        moved = [d.id for d in db.query(Doc.id)
                 .filter(Doc.id.in_(subtree), Doc.deleted_at.is_(None)).all()]
        doc.project_id = target_id
        db.query(Doc).filter(Doc.id.in_(moved)).update(
            {"project_id": target_id}, synchronize_session=False)
    db.commit()
    return {**doc_brief(doc), "fromProjectId": src_id, "movedDocs": len(moved)}


def move_check(db: DbSession, doc: Doc, project_id: str, parent_id: str,
               ctx: AuthContext) -> dict:
    target = query_id(project_id, "projectId") or doc.project_id
    parent = opt_id(parent_id)
    ensure_move_allowed(db, ctx, doc.project_id, target)
    validate_parent(db, Doc, parent, target, moving=doc, label="父文档")
    subtree = [d.id for d in db.query(Doc.id).filter(
        Doc.id.in_(collect_subtree(db, Doc, doc)), Doc.deleted_at.is_(None)).all()]
    files = []
    if target != doc.project_id:
        contents = db.query(Doc.content).filter(Doc.id.in_(subtree)).all()
        fids = set()
        for (content,) in contents:
            fids |= refs.file_ids_in(content)
        if fids:
            rows = db.query(File).filter(File.id.in_(fids), File.deleted_at.is_(None),
                                         File.project_id == doc.project_id).all()
            files = [{"id": f.id, "name": f.name} for f in rows]
    proj = db.get(Project, target)
    return {"docId": doc.id, "fromProjectId": doc.project_id,
            "targetProject": {"id": target, "name": proj.name if proj else ""},
            "docs": len(subtree), "foreignFiles": files,
            "note": "跨项目移动只搬文档,正文引用的文件仍留在源项目" if files else ""}


def _prune_versions(db: DbSession, doc_id: str) -> int:
    rows = (db.query(DocVersion.id, DocVersion.created_at)
            .filter_by(doc_id=doc_id)
            .order_by(DocVersion.created_at.desc(), DocVersion.id.desc()).all())
    now = utcnow()
    seen: set = set()
    drop: list = []
    for vid, created in rows:
        age = (now - created).total_seconds()
        if age < _HOUR:
            continue
        if age < _DAY:
            bucket = ("h", created.strftime("%Y-%m-%d %H"))
        elif age < 30 * _DAY:
            bucket = ("d", created.strftime("%Y-%m-%d"))
        elif age < 365 * _DAY:
            bucket = ("w", created.strftime("%Y-%W"))
        else:
            bucket = ("m", created.strftime("%Y-%m"))
        if bucket in seen:
            drop.append(vid)
        else:
            seen.add(bucket)
    if drop:
        for i in range(0, len(drop), 500):
            db.query(DocVersion).filter(DocVersion.id.in_(drop[i:i + 500])).delete(
                synchronize_session=False)
    return len(drop)


def save_doc_content(db: DbSession, doc: Doc, content: str, user_id: str,
                     kind: str = "save", *, base_version: int | None = None) -> tuple:
    """REST 与 WS 共用；不提交事务，基线冲突在任何改动前抛出。"""
    if doc.content == content:
        return False, doc.version
    if base_version is not None and base_version != doc.version:
        raise ContentConflict(doc.version, doc.content, _user_name(db, doc.updated_by))
    now = utcnow()
    last = (db.query(DocVersion).filter_by(doc_id=doc.id)
            .order_by(DocVersion.created_at.desc(), DocVersion.id.desc()).first())
    within_window = (VERSION_MERGE_MINUTES > 0 and last is not None
                     and last.kind == kind and last.created_by == user_id
                     and (now - last.created_at).total_seconds() < VERSION_MERGE_MINUTES * 60)
    if not within_window and doc.content:
        db.add(DocVersion(doc_id=doc.id, content=doc.content, kind=kind,
                          created_by=user_id, created_at=now))
    doc.content = content
    doc.version += 1
    doc.updated_by = user_id
    doc.updated_at = now
    db.flush()
    _prune_versions(db, doc.id)
    return True, doc.version


def _save_content(db: DbSession, doc: Doc, content: str, user_id: str,
                  kind: str = "save", *, base_version: int | None = None) -> dict:
    _, version = save_doc_content(db, doc, content, user_id, kind,
                                  base_version=base_version)
    db.commit()
    return {"version": version}


def resolve_base_version(ctx: AuthContext, payload: dict, *,
                         read_modify_write: bool = False) -> int | None:
    if read_modify_write:
        return None
    base = int_field(payload, "baseVersion")
    if base is None and ctx.via == "web":
        bad_request("baseVersion 不能为空")
    return base


def put_content(db: DbSession, doc: Doc, payload: dict, ctx: AuthContext) -> dict:
    content = str_content(payload)
    if content is None:
        bad_request("content 必须为字符串")
    return _save_content(db, doc, content, ctx.user.id,
                         base_version=resolve_base_version(ctx, payload))


def append_content(db: DbSession, doc: Doc, payload: dict, ctx: AuthContext) -> dict:
    content = str_content(payload)
    if content is None:
        bad_request("content 必须为字符串")
    new_content = (doc.content + "\n\n" + content) if doc.content else content
    return _save_content(db, doc, new_content, ctx.user.id,
                         base_version=resolve_base_version(ctx, payload, read_modify_write=True))


def list_versions(db: DbSession, doc: Doc) -> list:
    rows = (db.query(DocVersion.id, DocVersion.kind, DocVersion.created_at,
                     DocVersion.created_by, func.length(DocVersion.content))
            .filter_by(doc_id=doc.id)
            .order_by(DocVersion.created_at.desc(), DocVersion.id.desc()).limit(100).all())
    authors = user_names(db, (r[3] for r in rows))
    return [version_json(r, author_name=authors.get(r[3])) for r in rows]


def get_version(db: DbSession, doc: Doc, vid: str) -> dict:
    v = db.query(DocVersion).filter_by(id=vid, doc_id=doc.id).first()
    if not v:
        err(404, NOT_FOUND, "版本不存在")
    return {"content": v.content}


def restore_version(db: DbSession, doc: Doc, vid: str, ctx: AuthContext) -> dict:
    v = db.query(DocVersion).filter_by(id=vid, doc_id=doc.id).first()
    if not v:
        err(404, NOT_FOUND, "版本不存在")
    return _save_content(db, doc, v.content, ctx.user.id, kind="restore",
                         base_version=resolve_base_version(ctx, {}, read_modify_write=True))
