"""站内通知：同事务写入、本人列表与已读标记。"""
from sqlalchemy.orm import Session as DbSession

from db import utcnow
from errors import bad_request
from ids import normalize_id
from models import Notification
from serialize import iso

KINDS = ("space_added", "role_changed", "owner_transferred")
MAX_READ_IDS = 500


def notify(db: DbSession, user_id: str, kind: str, title: str,
           body: str | None = None, link: str | None = None) -> Notification:
    """只 add 不 commit：与触发它的成员/角色变更落在同一事务。"""
    if kind not in KINDS:
        raise ValueError(f"未知通知类型: {kind}")
    row = Notification(user_id=user_id, kind=kind, title=title[:200],
                       body=(body or None), link=(link or None))
    db.add(row)
    return row


def _item_json(n: Notification) -> dict:
    return {"id": n.id, "kind": n.kind, "title": n.title, "body": n.body,
            "link": n.link, "createdAt": iso(n.created_at),
            "readAt": iso(n.read_at)}


def list_for_user(db: DbSession, user_id: str, limit: int) -> dict:
    if not 1 <= limit <= 100:
        bad_request("limit 必须在 1..100 之间")
    rows = (db.query(Notification).filter_by(user_id=user_id)
            .order_by(Notification.created_at.desc(), Notification.id.desc())
            .limit(limit).all())
    unread = (db.query(Notification)
              .filter(Notification.user_id == user_id,
                      Notification.read_at.is_(None)).count())
    return {"items": [_item_json(n) for n in rows], "unread": unread}


def _read_ids(ids) -> list[str]:
    if not isinstance(ids, list):
        bad_request("ids 必须为数组")
    if len(ids) > MAX_READ_IDS:
        bad_request(f"ids 一次最多 {MAX_READ_IDS} 项")
    out: list[str] = []
    for raw in ids:
        got = normalize_id(raw)
        if got is None:
            bad_request("ids 每项必须是合法的 id")
        out.append(got)
    return list(dict.fromkeys(out))


def mark_read(db: DbSession, user_id: str, ids) -> dict:
    """只改本人未读；别人的 id 静默跳过，不泄露其存在性。"""
    target_ids = _read_ids(ids)
    if not target_ids:
        return {"ok": True, "updated": 0}
    updated = (db.query(Notification)
               .filter(Notification.user_id == user_id,
                       Notification.id.in_(target_ids),
                       Notification.read_at.is_(None))
               .update({"read_at": utcnow()}, synchronize_session=False))
    db.commit()
    return {"ok": True, "updated": int(updated)}


def mark_all_read(db: DbSession, user_id: str) -> dict:
    updated = (db.query(Notification)
               .filter(Notification.user_id == user_id,
                       Notification.read_at.is_(None))
               .update({"read_at": utcnow()}, synchronize_session=False))
    db.commit()
    return {"ok": True, "updated": int(updated)}
