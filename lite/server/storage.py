"""数据目录、物理文件名解析与磁盘操作。"""
import shutil
from pathlib import Path

from config import DATA_DIR

BASE_DIR = Path(__file__).resolve().parent
FILES_DIR = DATA_DIR / "files"
DATA_DIR.mkdir(parents=True, exist_ok=True)
FILES_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = DATA_DIR / "teamdoc.db"

# 单 worker 下登记“已落盘、尚未提交”的物理名，孤儿清理必须跳过。
INFLIGHT_STORAGE: set[str] = set()


def storage_basename(storage_path: str) -> str:
    """storage_path 只表示物理文件名；basename 阻止目录穿越。"""
    return Path(storage_path).name


def file_abspath(storage_path: str) -> Path:
    return FILES_DIR / storage_basename(storage_path)


def disk_total_bytes(path=None) -> int:
    return shutil.disk_usage(str(path or DATA_DIR)).total


def disk_free_bytes(path=None) -> int:
    return shutil.disk_usage(str(path or DATA_DIR)).free


def unlink_quiet(path) -> bool:
    """记录提交后的物理清理解失败不抛错，残留交给孤儿清理。"""
    if not path:
        return False
    try:
        Path(path).unlink(missing_ok=True)
        return True
    except OSError:
        return False
