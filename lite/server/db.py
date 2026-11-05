"""SQLite 引擎、会话工厂与时间/可见性基础函数（不依赖 FastAPI）。"""
from datetime import datetime

from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import NullPool

from storage import DB_PATH

# 请求会话持有时间超过该阈值时记录告警；读取在 deps.get_db。
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


def release_db(db) -> None:
    """提前归还连接；重复 close 安全，依赖收尾仍可再次调用。"""
    db.close()


def is_live(res) -> bool:
    """REST 与 WS 共用的资源可见性判定。"""
    return res is not None and res.deleted_at is None


def utcnow() -> datetime:
    return datetime.utcnow()
