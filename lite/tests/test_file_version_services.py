"""文件版本服务、存量迁移与存储/树工具的直接测试。"""
import sqlite3
from datetime import timedelta

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session

import schema
import storage
from db import utcnow
from ids import new_id
from models import Base, File, FileVersion, Project, User
from services import versions
from storage import file_abspath
from treeutil import build_tree, collect_subtree, next_sort


def _session(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'service.db'}")
    Base.metadata.create_all(engine)
    return engine, Session(engine)


def _file(db, name="versions.bin", count=1):
    user = User(email=f"{new_id().lower()}@t.local", name="作者", password_hash="x")
    project = Project(name="服务测试")
    db.add_all([user, project])
    db.flush()
    now = utcnow()
    f = File(name=name, project_id=project.id, storage_path=f"{new_id()}-current",
             size=1, created_by=user.id, updated_by=user.id,
             created_at=now, updated_at=now, version=count)
    db.add(f)
    db.flush()
    for number in range(1, count + 1):
        db.add(FileVersion(file_id=f.id, version=number,
                           storage_path=f"{f.id}-{number}", size=number,
                           created_by=user.id, created_at=now))
    db.commit()
    return f


def test_prune_20_and_90_days_with_real_files(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "FILES_DIR", tmp_path)
    engine, db = _session(tmp_path)
    try:
        f = _file(db, count=25)
        now = utcnow()
        rows = db.query(FileVersion).filter_by(file_id=f.id).order_by(FileVersion.version).all()
        for row in rows:
            row.created_at = now - timedelta(days=100) if row.version <= 5 else now
            file_abspath(row.storage_path).write_bytes(bytes([row.version]))
        db.commit()
        result = versions.prune_old_versions(db, file_id=f.id, now=now)
        left = [v.version for v in db.query(FileVersion).filter_by(file_id=f.id).order_by(
            FileVersion.version)]
        assert left == list(range(6, 26))
        assert result["removedVersions"] == 5 and result["removedFiles"] == 5
        assert all(not file_abspath(f"{f.id}-{n}").exists() for n in range(1, 6))
        assert file_abspath(f"{f.id}-6").exists(), "超出 90 天但仍在最近 20 内必须保留"
        again = versions.prune_old_versions(db, file_id=f.id, now=now)
        assert again["removedVersions"] == 0, "清理幂等"
    finally:
        db.close()
        engine.dispose()


def test_prune_never_unlinks_shared_restored_path(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "FILES_DIR", tmp_path)
    engine, db = _session(tmp_path)
    try:
        f = _file(db, count=21)
        first = db.query(FileVersion).filter_by(file_id=f.id, version=1).one()
        current = db.query(FileVersion).filter_by(file_id=f.id, version=21).one()
        current.storage_path = first.storage_path
        f.storage_path = first.storage_path
        first.created_at = utcnow() - timedelta(days=100)
        shared = file_abspath(first.storage_path)
        shared.write_bytes(b"shared")
        db.commit()
        result = versions.prune_old_versions(db, file_id=f.id)
        assert result["removedVersions"] == 1
        assert db.query(FileVersion).filter_by(file_id=f.id, version=1).first() is None
        assert shared.exists(), "旧记录清理后仍被当前/恢复版本引用的物理文件不能删"
    finally:
        db.close()
        engine.dispose()


def test_exactly_twenty_old_versions_are_all_kept(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "FILES_DIR", tmp_path)
    engine, db = _session(tmp_path)
    try:
        f = _file(db, count=20)
        old = utcnow() - timedelta(days=365)
        for row in db.query(FileVersion).filter_by(file_id=f.id):
            row.created_at = old
        db.commit()
        assert versions.prune_old_versions(db, file_id=f.id)["removedVersions"] == 0
        assert db.query(FileVersion).filter_by(file_id=f.id).count() == 20
    finally:
        db.close()
        engine.dispose()


def test_legacy_schema_migrates_and_is_idempotent(tmp_path):
    path = tmp_path / "legacy.db"
    conn = sqlite3.connect(path)
    conn.execute("""CREATE TABLE files (
        id VARCHAR(26) PRIMARY KEY, name VARCHAR(255) NOT NULL,
        project_id VARCHAR(26) NOT NULL, folder_id VARCHAR(26),
        size INTEGER NOT NULL, storage_path VARCHAR(300) UNIQUE NOT NULL,
        share_token VARCHAR(64) UNIQUE, share_expires_at DATETIME,
        created_by VARCHAR(26), created_at DATETIME NOT NULL, deleted_at DATETIME)""")
    fid = new_id()
    conn.execute("INSERT INTO files VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                 (fid, "old.txt", new_id(), None, 7, "legacy-physical", None, None,
                  new_id(), "2026-01-01 00:00:00", None))
    conn.commit()
    conn.close()
    engine = create_engine(f"sqlite:///{path}")
    try:
        schema.init(engine)
        schema.init(engine)
        with engine.connect() as db:
            row = db.execute(text(
                "SELECT version,updated_by,updated_at FROM files WHERE id=:id"), {"id": fid}).one()
            assert row[0] == 1 and row[1] and row[2] == "2026-01-01 00:00:00"
            versions_rows = db.execute(text(
                "SELECT version,storage_path,size FROM file_versions WHERE file_id=:id"),
                {"id": fid}).all()
            assert versions_rows == [(1, "legacy-physical", 7)]
            assert db.execute(text("SELECT COUNT(*) FROM file_versions")).scalar() == 1
        assert schema.check_drift(engine) == []
    finally:
        engine.dispose()


def test_tree_and_storage_services(tmp_path):
    class Node:
        def __init__(self, id, parent_id=None):
            self.id, self.parent_id = id, parent_id
    a, b, c = Node("a"), Node("b", "a"), Node("c", "a")
    tree = build_tree([a, b, c], lambda n: {"id": n.id, "children": []})
    assert tree[0]["id"] == "a" and [n["id"] for n in tree[0]["children"]] == ["b", "c"]
    assert storage.storage_basename("../../unsafe") == "unsafe"
    assert storage.file_abspath("../../unsafe").parent == storage.FILES_DIR


def test_exact_ninety_day_boundary_is_not_pruned(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "FILES_DIR", tmp_path)
    engine, db = _session(tmp_path)
    try:
        f = _file(db, count=21)
        now = utcnow()
        oldest = db.query(FileVersion).filter_by(file_id=f.id, version=1).one()
        oldest.created_at = now - timedelta(days=90)
        db.commit()
        assert versions.prune_old_versions(db, file_id=f.id, now=now)["removedVersions"] == 0
    finally:
        db.close()
        engine.dispose()
