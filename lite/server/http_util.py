"""通用 HTTP 字段解析（纯函数，不依赖 FastAPI）。"""
import re

from errors import bad_request
from ids import normalize_id

_HEX_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")


def int_field(payload: dict, key: str, required: bool = False,
              default: int | None = None) -> int | None:
    v = payload.get(key)
    if v is None or v == "":
        if required:
            bad_request(f"{key} 不能为空")
        return default
    if isinstance(v, bool) or not isinstance(v, int):
        bad_request(f"{key} 必须为整数")
    return v


def opt_int(value, key: str = "id") -> int | None:
    if value is None or value == "":
        return None
    return int_field({key: value}, key)


def id_field(payload: dict, key: str, required: bool = False) -> str | None:
    v = payload.get(key)
    if v is None or v == "":
        if required:
            bad_request(f"{key} 不能为空")
        return None
    got = normalize_id(v)
    if got is None:
        bad_request(f"{key} 不是合法的 id")
    return got


def opt_id(value, key: str = "id") -> str | None:
    if value is None or value == "":
        return None
    return id_field({key: value}, key)


def query_id(value, key: str, required: bool = False) -> str | None:
    return id_field({key: value}, key, required=required)


def id_csv_field(value, key: str, *, max_items: int = 2000) -> list[str]:
    parts = [p for p in (value or "").split(",") if p]
    if len(parts) > max_items:
        bad_request(f"{key} 一次最多 {max_items} 项")
    out = []
    for one in parts:
        got = normalize_id(one)
        if got is None:
            bad_request(f"{key} 必须为逗号分隔的 id")
        out.append(got)
    return out


def clamp_int(value: int, low: int, high: int, key: str) -> int:
    if value < low or value > high:
        bad_request(f"{key} 必须在 {low}..{high} 之间")
    return value


def str_field(payload: dict, key: str, max_len: int, required: bool = False,
              default: str = "") -> str:
    v = payload.get(key)
    if v is None:
        if required:
            bad_request(f"{key} 不能为空")
        return default
    if not isinstance(v, str):
        bad_request(f"{key} 必须为字符串")
    v = v.strip()
    if required and not v:
        bad_request(f"{key} 不能为空")
    return v[:max_len]


def bool_field(payload: dict, key: str, default: bool = False) -> bool:
    v = payload.get(key)
    if v is None:
        return default
    if not isinstance(v, bool):
        bad_request(f"{key} 必须为布尔值")
    return v


def color_field(payload: dict, key: str) -> str | None:
    """可选颜色：#RRGGBB；null/空串表示清除（回落到默认呈现色）。"""
    v = payload.get(key)
    if v is None or v == "":
        return None
    if not isinstance(v, str) or not _HEX_COLOR.match(v):
        bad_request(f"{key} 必须为 #RRGGBB")
    return v


def quota_field(payload: dict, key: str = "quotaBytes") -> int | None:
    """可选配额（字节）：null/空串/0 表示不限额，负数拒绝。"""
    v = int_field(payload, key)
    if v is not None and v < 0:
        bad_request(f"{key} 不能为负")
    return v or None
