"""空间配额计量与硬限制。

用量口径是**去重物理占用**：同一空间内 File 当前路径与全部 FileVersion 路径
按 storage_path 去重后求和。两处去重是必须的：

- File.storage_path 恒等于某个版本的路径，两张表天然重复；不按路径去重会把
  每个文件当前版算两遍。
- 恢复历史版本不复制物理文件，多个版本行共享同一路径；按路径去重后只算一次。

回收站里的文件（deleted_at 非空）仍占磁盘，所以计量不按 deleted_at 过滤；
彻底删除释放空间后用量自然回落。

本模块只 import models/errors：files/spaces 会 import 本模块调用守卫，
反向依赖会成环。
"""
from sqlalchemy import func
from sqlalchemy.orm import Session as DbSession

from errors import QUOTA_EXCEEDED, err
from models import File, FileVersion


def _fmt_bytes(n: int) -> str:
    """错误文案里的可读大小；配额常以 GB 计，纯字节数没法读。"""
    size = float(int(n or 0))
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            return (f"{int(size)}{unit}" if unit == "B" else f"{size:.1f}{unit}")
        size /= 1024
    return f"{size:.1f}GB"


def usage_map(db: DbSession, project_ids) -> dict[str, int]:
    """批量计算多个空间的去重物理占用，返回 `{project_id: bytes}`（缺省 0）。

    File 与 FileVersion 用 union 后按 `(project_id, storage_path)` 分组取 max：
    同路径在不同行上的 size 应当一致，取 max 是只可能高估的保守兜底。
    """
    ids = list(project_ids)
    if not ids:
        return {}
    files = (db.query(File.project_id.label("pid"),
                      File.storage_path.label("path"),
                      File.size.label("size"))
             .filter(File.project_id.in_(ids)))
    versions = (db.query(File.project_id.label("pid"),
                         FileVersion.storage_path.label("path"),
                         FileVersion.size.label("size"))
                .join(File, File.id == FileVersion.file_id)
                .filter(File.project_id.in_(ids)))
    union = files.union_all(versions).subquery()
    rows = (db.query(union.c.pid, union.c.path, func.max(union.c.size))
            .group_by(union.c.pid, union.c.path).all())
    out = {pid: 0 for pid in ids}
    for pid, path, size in rows:
        if path:
            out[pid] = out.get(pid, 0) + int(size or 0)
    return out


def used_bytes(db: DbSession, project_id: str) -> int:
    return usage_map(db, [project_id]).get(project_id, 0)


def file_bytes(db: DbSession, file_ids) -> int:
    """一批文件的去重物理占用（当前路径 + 全部历史版本），供跨空间移动计量。"""
    ids = list(file_ids)
    if not ids:
        return 0
    files = (db.query(File.storage_path.label("path"), File.size.label("size"))
             .filter(File.id.in_(ids)))
    versions = (db.query(FileVersion.storage_path.label("path"),
                         FileVersion.size.label("size"))
                .filter(FileVersion.file_id.in_(ids)))
    union = files.union_all(versions).subquery()
    rows = (db.query(union.c.path, func.max(union.c.size))
            .group_by(union.c.path).all())
    return sum(int(size or 0) for path, size in rows if path)


def ensure_quota(db: DbSession, project, additional_bytes: int) -> None:
    """写入前校验空间配额；超出时抛 403 QUOTA_EXCEEDED。

    个人空间与未设配额（空/0）的空间直接放行；全局磁盘余量保护由上传路径的
    `_check_reserve` 单独负责，两者错误语义互不覆盖。
    """
    if project is None or project.is_personal:
        return
    quota = project.quota_bytes
    if not quota or quota <= 0:
        return
    additional = max(0, int(additional_bytes or 0))
    used = used_bytes(db, project.id)
    required = used + additional
    if required <= quota:
        return
    err(403, QUOTA_EXCEEDED,
        f"空间「{project.name}」存储配额不足：已用 {_fmt_bytes(used)} / 上限 "
        f"{_fmt_bytes(quota)}，本次需要 {_fmt_bytes(additional)}。"
        "可彻底删除回收站中的文件，或联系管理员调整配额。",
        extra={"quotaBytes": int(quota), "usedBytes": used,
               "requiredBytes": required})
