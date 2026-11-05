"""SQLite 引擎、请求会话与时间/可见性基础函数。"""
import logging
import time
from datetime import datetime

from fastapi import Request
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import NullPool

from storage import DB_PATH

logger = logging.getLogger("teamdoc.db")
DB_WARN_SECONDS = 2.0

# SQLite 单写者下连接廉价；NullPool 避免慢上传/下载拖住全站连接队列。
engine = create_engine(
    f"sqlite:///{DB_PATH}",
    connect_args={"check_same_thread": False},
    poolclass=NullPool,
)


@event.listens_for(engine, "connect")
def _set_pragmas(dbapi_conn, _):
    cur = dbapi_conn.cursor()
    cur.execute("PRAGMA busy_timeout=5000")
    cur.execute("PRAGMA journal_mode=WAL")
    cur.execute("PRAGMA foreign_keys=ON")
    cur.close()


SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def get_db(request: Request):
    """请求级会话；长 I/O 前必须调用 release_db。"""
    db = SessionLocal()
    started = time.monotonic()
    try:
        yield db
    finally:
        db.close()
        held = time.monotonic() - started
        if held > DB_WARN_SECONDS:
            logger.warning("数据库会话持有 %.1fs:%s %s", held,
                           request.method, request.url.path)


def release_db(db) -> None:
    """提前归还连接；重复 close 安全，依赖收尾仍可再次调用。"""
    db.close()


def is_live(res) -> bool:
    """REST 与 WS 共用的资源可见性判定。"""
    return res is not None and res.deleted_at is None


def utcnow() -> datetime:
    return datetime.utcnow()
