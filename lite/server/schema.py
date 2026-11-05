"""建表、有限的文件版本迁移与模型/数据库结构自检。"""
import models
from ids import new_id
from sqlalchemy import Integer, String, Text, text
from storage import DB_PATH


def init(engine) -> None:
    """先补缺失表，再执行幂等加法迁移，最后拒绝未处理的结构漂移。"""
    models.Base.metadata.create_all(engine)
    _migrate_file_versions(engine)
    _migrate_preferences(engine)
    _migrate_file_version_note(engine)
    problems = check_drift(engine)
    if problems:
        lines = []
        for p in problems:
            if p["kind"] == "extra":
                risk = ("NOT NULL 且无默认值,会阻断插入" if p["blocking"]
                        else "可空/有默认值,无害但应清理")
                lines.append(f"  · {p['table']}.{p['column']} 库里多出此列({p['type']})—— {risk}")
            elif p["kind"] == "type":
                lines.append(f"  · {p['table']}.{p['column']} 库里是 {p['type']},"
                             f"模型要求 {p['want']} —— 两边的值对不上")
            else:
                lines.append(f"  · {p['table']}.{p['column']} 模型有但库里缺此列 —— 读写会报 no such column")
        raise RuntimeError(
            "数据库结构与 models.py 不一致:\n" + "\n".join(lines) +
            f"\n\n请备份并修复 {DB_PATH} 后再启动；不会自动删除或重建业务数据。")


def _migrate_file_versions(engine) -> None:
    """升级旧 files 表并为每个文件补齐当前版本行；重复执行不重复插入。"""
    with engine.begin() as conn:
        if not _table_exists(conn, "files"):
            return
        cols = {r[1] for r in conn.execute(text("PRAGMA table_info(files)"))}
        additions = (
            ("version", "INTEGER NOT NULL DEFAULT 1"),
            ("updated_by", "VARCHAR(26)"),
            ("updated_at", "DATETIME"),
        )
        for name, decl in additions:
            if name not in cols:
                conn.execute(text(f"ALTER TABLE files ADD COLUMN {name} {decl}"))
        conn.execute(text(
            "UPDATE files SET version=COALESCE(version,1), "
            "updated_by=COALESCE(updated_by,created_by), "
            "updated_at=COALESCE(updated_at,created_at)"))
        rows = conn.execute(text(
            "SELECT id,version,storage_path,size,created_by,created_at "
            "FROM files ORDER BY id")).all()
        for file_id, version, storage_path, size, created_by, created_at in rows:
            if not isinstance(version, int) or version < 1 or not storage_path:
                raise RuntimeError(f"文件 {file_id} 的版本或物理路径无效，拒绝迁移")
            versions = conn.execute(text(
                "SELECT version,storage_path FROM file_versions WHERE file_id=:fid"),
                {"fid": file_id}).all()
            if not versions:
                conn.execute(text(
                    "INSERT INTO file_versions "
                    "(id,file_id,version,storage_path,size,created_by,created_at) "
                    "VALUES (:id,:fid,:ver,:path,:size,:by,:at)"),
                    {"id": new_id(), "fid": file_id, "ver": version,
                     "path": storage_path, "size": size or 0,
                     "by": created_by or "", "at": created_at})
                continue
            current = [path for ver, path in versions if ver == version]
            if len(current) != 1 or current[0] != storage_path:
                raise RuntimeError(
                    f"文件 {file_id} 的当前版本与 file_versions 不一致，拒绝启动")


def _add_columns(conn, table: str, additions: tuple[tuple[str, str], ...]) -> None:
    """幂等加法迁移：只补缺失列，不改写存量数据。"""
    if not _table_exists(conn, table):
        return
    cols = {r[1] for r in conn.execute(text(f"PRAGMA table_info({table})"))}
    for name, decl in additions:
        if name not in cols:
            conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {name} {decl}"))


def _migrate_preferences(engine) -> None:
    """用户/空间偏好列：avatarColor、color/quotaBytes/archivedAt。"""
    with engine.begin() as conn:
        _add_columns(conn, "users", (("avatar_color", "VARCHAR(7)"),))
        _add_columns(conn, "projects", (
            ("color", "VARCHAR(7)"),
            ("quota_bytes", "INTEGER"),
            ("archived_at", "DATETIME"),
        ))


def _migrate_file_version_note(engine) -> None:
    """W1 建出的旧 file_versions 表补版本备注列；新库由 create_all 直接带列。"""
    with engine.begin() as conn:
        _add_columns(conn, "file_versions", (("note", "VARCHAR(200)"),))


def check_drift(engine) -> list[dict]:
    """返回 {table,column,type,want,kind,blocking} 结构差异。"""
    problems: list[dict] = []
    with engine.begin() as conn:
        for table in models.Base.metadata.sorted_tables:
            if not _table_exists(conn, table.name):
                continue
            model_cols = {c.name for c in table.columns}
            rows = conn.execute(text(f"PRAGMA table_info({table.name})")).all()
            actual = {r[1]: {"type": r[2], "notnull": bool(r[3]), "default": r[4]} for r in rows}
            for name, info in actual.items():
                if name in model_cols:
                    continue
                problems.append({
                    "table": table.name, "column": name, "type": info["type"], "want": "",
                    "kind": "extra",
                    "blocking": info["notnull"] and info["default"] is None,
                })
            for name in sorted(model_cols - set(actual)):
                problems.append({
                    "table": table.name, "column": name, "type": "", "want": "",
                    "kind": "missing", "blocking": False,
                })
            for name in sorted(model_cols & set(actual)):
                want = _declared_type(table.columns[name])
                got = _type_word(actual[name]["type"])
                if not want or not got or want == got:
                    continue
                problems.append({"table": table.name, "column": name,
                                 "type": actual[name]["type"], "want": want,
                                 "kind": "type", "blocking": False})
    return problems


def _table_exists(conn, name: str) -> bool:
    return conn.execute(
        text("SELECT 1 FROM sqlite_master WHERE type='table' AND name=:n"), {"n": name}
    ).first() is not None


def _type_word(decl: str) -> str:
    return (decl or "").upper().split("(")[0].strip()


def _declared_type(col) -> str:
    if isinstance(col.type, Text):
        return "TEXT"
    if isinstance(col.type, String):
        return "VARCHAR"
    if isinstance(col.type, Integer):
        return "INTEGER"
    return ""
