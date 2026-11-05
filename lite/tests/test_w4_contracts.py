"""W4 服务端新增契约：通知、PAT 审计、版本备注、成员字段与 409 上传者姓名。

按行为分组，只守本工单新增的真实契约；成员/上传/版本既有语义由既有测试覆盖，
这里不重复。
"""
import json
import sqlite3
import urllib.parse
import uuid

from sqlalchemy import create_engine, text

import schema
from _harness import ABSENT_ID, Client, make_user


def _project(admin, name, members=None):
    body = {"name": name}
    if members is not None:
        body["members"] = members
    r = admin.post("/api/projects", body)
    assert r.status == 200, f"建空间失败: {r.status} {r.data}"
    return r.data["id"]


def _items(client, limit=20):
    r = client.get(f"/api/notifications?limit={limit}")
    assert r.status == 200, f"通知列表失败: {r.status} {r.data}"
    return r.data


def _login(base_url, email, password):
    c = Client(base_url)
    c.login(email, password)
    return c


# ---------- 通知 ----------

def test_notifications_for_invite_add_role_change_and_transfer(base_url, admin):
    name = "通知空间-" + uuid.uuid4().hex[:6]
    a_email, a = make_user(admin, "通知甲", "notify12345")
    b_email, b = make_user(admin, "通知乙", "notify12345")
    c_email, c = make_user(admin, "通知丙", "notify12345")
    pid = _project(admin, name, [
        {"userId": a["id"], "role": "EDITOR"},
        {"userId": b["id"], "role": "ADMIN"}])
    link = f"#/p/{pid}/home"
    ac = _login(base_url, a_email, "notify12345")
    bc = _login(base_url, b_email, "notify12345")
    cc = _login(base_url, c_email, "notify12345")

    # 创建邀请：被邀者各一条 space_added，标题/正文带空间名与角色中文标签
    rows = [n for n in _items(ac)["items"] if n["link"] == link]
    assert len(rows) == 1 and rows[0]["kind"] == "space_added"
    assert name in rows[0]["title"] and "编辑者" in rows[0]["title"]
    assert "编辑者" in (rows[0]["body"] or "")
    assert rows[0]["createdAt"] and rows[0]["readAt"] is None
    assert [n for n in _items(admin)["items"] if n["link"] == link] == [], \
        "创建者不给自己发邀请通知"

    # 管理员加成员：被加者收到；操作者自己不收
    r = bc.post(f"/api/projects/{pid}/members",
                {"userId": c["id"], "role": "VIEWER"})
    assert r.status == 200, r.data
    crow = [n for n in _items(cc)["items"] if n["link"] == link]
    assert len(crow) == 1 and crow[0]["kind"] == "space_added"
    assert "只读成员" in crow[0]["title"]
    brow = [n for n in _items(bc)["items"] if n["link"] == link]
    assert [n["kind"] for n in brow] == ["space_added"], "操作者加人后不应收到通知"

    # 改角色：被改者收到 role_changed；重复提交同角色不产生新通知
    assert admin.patch(f"/api/projects/{pid}/members/{a['id']}",
                       {"role": "VIEWER"}).status == 200
    arows = [n for n in _items(ac)["items"] if n["link"] == link]
    assert [n["kind"] for n in arows] == ["role_changed", "space_added"]
    assert "只读成员" in arows[0]["title"]
    assert admin.patch(f"/api/projects/{pid}/members/{a['id']}",
                       {"role": "VIEWER"}).status == 200
    assert len([n for n in _items(ac)["items"] if n["link"] == link]) == 2

    # 转让：新旧 owner 各一条；操作者本人也收到（转让是明确例外）
    assert admin.post(f"/api/projects/{pid}/transfer",
                      {"userId": b["id"]}).status == 200
    brows = [n for n in _items(bc)["items"] if n["link"] == link]
    assert [n["kind"] for n in brows] == ["owner_transferred", "space_added"]
    assert "所有者" in brows[0]["title"]
    admin_rows = [n for n in _items(admin)["items"] if n["link"] == link]
    assert [n["kind"] for n in admin_rows] == ["owner_transferred"]
    assert "管理员" in admin_rows[0]["title"]


def test_notifications_limit_unread_and_owner_scope(base_url, admin):
    u_email, u = make_user(admin, "通知收件", "notify12345")
    v_email, v = make_user(admin, "通知他人", "notify12345")
    for _ in range(3):
        _project(admin, "通知批量-" + uuid.uuid4().hex[:6],
                 [{"userId": u["id"], "role": "VIEWER"}])
    _project(admin, "通知他人空间-" + uuid.uuid4().hex[:6],
             [{"userId": v["id"], "role": "VIEWER"}])
    uc = _login(base_url, u_email, "notify12345")
    vc = _login(base_url, v_email, "notify12345")

    page = _items(uc, limit=2)
    assert len(page["items"]) == 2 and page["unread"] == 3
    assert page["items"][0]["createdAt"] >= page["items"][1]["createdAt"]
    assert set(page["items"][0]) == {"id", "kind", "title", "body", "link",
                                     "createdAt", "readAt"}
    assert uc.get("/api/notifications?limit=0").status == 400

    target = page["items"][0]["id"]
    r = uc.post("/api/notifications/read", {"ids": [target]})
    assert r.data == {"ok": True, "updated": 1}
    assert uc.post("/api/notifications/read", {"ids": [target]}).data["updated"] == 0
    after = _items(uc)
    assert after["unread"] == 2
    assert next(n for n in after["items"] if n["id"] == target)["readAt"]

    # 只能改自己的：拿他人的通知 id 静默跳过，对方仍未读
    vrow = _items(vc)["items"][0]
    assert uc.post("/api/notifications/read", {"ids": [vrow["id"]]}).data["updated"] == 0
    assert _items(vc)["unread"] == 1

    assert uc.post("/api/notifications/read-all").data == {"ok": True, "updated": 2}
    final = _items(uc)
    assert final["unread"] == 0 and all(n["readAt"] for n in final["items"])
    assert uc.post("/api/notifications/read-all").data["updated"] == 0

    assert uc.post("/api/notifications/read", {"ids": ["bad-id"]}).status == 400
    assert uc.post("/api/notifications/read", {}).status == 400


# ---------- PAT 审计 ----------

def test_admin_pat_audit_is_readonly_and_filtered(base_url, admin):
    email, user = make_user(admin, "令牌审计", "pat12345678")
    client = _login(base_url, email, "pat12345678")
    created = client.post("/api/auth/pats",
                          {"name": "审计令牌", "scopes": "read,write"})
    assert created.status == 200, created.data
    token = created.data["token"]

    r = admin.get(f"/api/admin/pats?userId={user['id']}")
    assert r.status == 200, r.data
    items = r.data["items"]
    assert len(items) == 1, f"按用户过滤只返回该用户的令牌: {items}"
    row = items[0]
    assert set(row) == {"id", "userId", "userName", "userEmail", "name", "scopes",
                        "createdAt", "lastUsedAt", "revokedAt"}
    assert row["userId"] == user["id"] and row["userName"] == "令牌审计"
    assert row["userEmail"] == email and row["name"] == "审计令牌"
    assert row["scopes"] == "read,write" and row["createdAt"]
    assert row["lastUsedAt"] is None and row["revokedAt"] is None
    raw = json.dumps(r.data, ensure_ascii=False)
    assert token not in raw and "tokenHash" not in raw and "token_hash" not in raw

    # 非管理员不可见；形状非法 400；不存在用户返回空列表
    assert client.get("/api/admin/pats").status == 403
    assert admin.get("/api/admin/pats?userId=abc").status == 400
    assert admin.get(f"/api/admin/pats?userId={ABSENT_ID}").data["items"] == []

    # 使用一次令牌后 lastUsedAt 落库，审计可见
    assert Client(base_url, bearer=token).get("/api/auth/me").status == 200
    used = admin.get(f"/api/admin/pats?userId={user['id']}").data["items"][0]
    assert used["lastUsedAt"]


# ---------- 版本备注 ----------

def test_version_notes_upload_restore_and_length_limit(admin):
    pid = _project(admin, "版本备注空间")
    fid = admin.upload(pid, "notes.txt", b"v1").data["id"]
    note = urllib.parse.quote("  第二版说明  ")
    v2 = admin.post(f"/api/files/{fid}/versions?name=ignored&note={note}",
                    raw_body=b"v2", ctype="application/octet-stream")
    assert v2.status == 200, v2.data
    rows = admin.get(f"/api/files/{fid}/versions").data
    assert rows[0]["version"] == 2 and rows[0]["note"] == "第二版说明"
    assert rows[1]["note"] is None, "旧版本无备注"

    restored = admin.post(f"/api/files/{fid}/restore", {"version": 1})
    assert restored.status == 200 and restored.data["version"] == 3
    assert admin.get(f"/api/files/{fid}/versions").data[0]["note"] == "恢复自 v1"

    explicit = admin.post(f"/api/files/{fid}/restore",
                          {"version": 2, "note": "  回滚到二版  "})
    assert explicit.status == 200 and explicit.data["version"] == 4
    assert admin.get(f"/api/files/{fid}/versions").data[0]["note"] == "回滚到二版"

    too_long = "x" * 201
    assert admin.post(f"/api/files/{fid}/versions?note={too_long}",
                      raw_body=b"x", ctype="application/octet-stream").status == 400
    assert admin.post(f"/api/files/{fid}/restore",
                      {"version": 1, "note": too_long}).status == 400
    assert admin.get(f"/api/files/{fid}").data["version"] == 4, "超长备注不得登记新版本"


# ---------- 409 上传者姓名 ----------

def test_upload_conflict_reports_last_uploader_name(base_url, admin):
    email, editor = make_user(admin, "冲突上传者", "conflict12345")
    pid = _project(admin, "冲突上传者空间")
    assert admin.post(f"/api/projects/{pid}/members",
                      {"userId": editor["id"], "role": "EDITOR"}).status == 200
    c = _login(base_url, email, "conflict12345")
    first = c.upload(pid, "conflict.txt", b"one")
    assert first.status == 200, first.data

    conflict = admin.upload(pid, "conflict.txt", b"two")
    assert conflict.status == 409, conflict.data
    existing = conflict.data["detail"]["existing"]
    assert existing["id"] == first.data["id"]
    assert existing["updatedBy"] == editor["id"]
    assert existing["updatedByName"] == "冲突上传者"


# ---------- 成员加入时间与最后活跃 ----------

def test_member_created_and_last_active_fields(base_url, admin):
    email, user = make_user(admin, "活跃成员", "active12345")
    pid = _project(admin, "成员时间空间",
                   [{"userId": user["id"], "role": "EDITOR"}])
    row = next(r for r in admin.get(f"/api/projects/{pid}/members").data
               if r["userId"] == user["id"])
    assert row["role"] == "EDITOR" and row["user"]["name"] == "活跃成员"
    assert row["createdAt"], "成员加入时间必须返回"
    assert row["lastActiveAt"] is None, "从未登录的用户最后活跃为空"

    _login(base_url, email, "active12345")
    row = next(r for r in admin.get(f"/api/projects/{pid}/members").data
               if r["userId"] == user["id"])
    assert row["lastActiveAt"], "成功登录后最后活跃应有值"

    _, fresh = make_user(admin, "新加成员", "active12345")
    added = admin.post(f"/api/projects/{pid}/members",
                       {"userId": fresh["id"], "role": "VIEWER"})
    assert added.status == 200, added.data
    assert added.data["createdAt"] and added.data["lastActiveAt"] is None
    assert added.data["user"]["id"] == fresh["id"]


# ---------- 迁移 ----------

def test_notifications_table_and_version_note_migration_are_idempotent(tmp_path):
    path = tmp_path / "legacy-w4.db"
    conn = sqlite3.connect(path)
    conn.execute("""CREATE TABLE file_versions (
        id VARCHAR(26) PRIMARY KEY,
        file_id VARCHAR(26) NOT NULL,
        version INTEGER NOT NULL,
        storage_path VARCHAR(300) NOT NULL,
        size INTEGER NOT NULL,
        created_by VARCHAR(26) NOT NULL,
        created_at DATETIME NOT NULL)""")
    conn.commit()
    conn.close()

    engine = create_engine(f"sqlite:///{path}")
    try:
        schema.init(engine)
        schema.init(engine)  # 第二次必须无副作用
        with engine.connect() as db:
            cols = {r[1] for r in db.execute(text("PRAGMA table_info(file_versions)"))}
            assert "note" in cols
            tables = {r[0] for r in db.execute(
                text("SELECT name FROM sqlite_master WHERE type='table'"))}
            assert "notifications" in tables
        assert schema.check_drift(engine) == []
    finally:
        engine.dispose()
