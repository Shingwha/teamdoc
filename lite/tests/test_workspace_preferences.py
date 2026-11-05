"""空间偏好（颜色/配额/归档/转让）、搜索过滤、管理总览与偏好列迁移。

工单要求的最小真实契约：
  * 空间偏好字段可读写；归档默认从空间列表/广场隐藏，直达可读，所有内容/成员写入
    （REST 与 WS）统一 403 SPACE_ARCHIVED，解除归档立即恢复写入。
  * 创建空间同事务邀请成员（任一失败整笔回滚）；owner 转让原子生效，原 owner 降 ADMIN。
  * 搜索的 projectId/updatedBy 是严格过滤，无权空间不泄露；doc 行带更新人。
  * 管理总览聚合计数/今日登录/锁定/存储/备份/配额将满（>=80%）。
  * users/projects 新增列的迁移幂等。
"""
import json
import sqlite3
import urllib.parse
import uuid

import pytest
from sqlalchemy import create_engine, text

import schema
from _harness import ABSENT_ID, Client, make_user

SPACE_ARCHIVED = "SPACE_ARCHIVED"


def _code(resp):
    return ((resp.data or {}).get("detail") or {}).get("code")


def _assert_archived(resp, label):
    assert resp.status == 403, f"{label}:归档空间写入应 403: {resp.status} {resp.data}"
    assert _code(resp) == SPACE_ARCHIVED, f"{label}:错误码应为 {SPACE_ARCHIVED}: {resp.data}"


def _member_roles(admin, pid):
    return {m["userId"]: m["role"] for m in admin.get(f"/api/projects/{pid}/members").data}


def _project_id(admin, name, body=None):
    r = admin.post("/api/projects", {"name": name, **(body or {})})
    assert r.status == 200, f"建空间失败: {r.status} {r.data}"
    return r.data["id"]


def test_project_preferences_archive_guards_and_unarchive(base_url, admin):
    m_email, m = make_user(admin, "归档成员", "arch12345")
    _, m2 = make_user(admin, "归档成员二", "arch12345")
    _, m3 = make_user(admin, "归档成员三", "arch12345")
    o_email, _ = make_user(admin, "归档外部", "arch12345")
    outsider = Client(base_url)
    outsider.login(o_email, "arch12345")

    r = admin.post("/api/projects", {
        "name": "归档偏好空间", "description": "d",
        "color": "#112233", "quotaBytes": 1000,
        "members": [{"userId": m["id"], "role": "EDITOR"},
                    {"userId": m2["id"], "role": "VIEWER"}]})
    assert r.status == 200, f"带邀请建空间: {r.status} {r.data}"
    p = r.data
    pid = p["id"]
    assert p["color"] == "#112233" and p["quotaBytes"] == 1000
    assert p["archivedAt"] is None and p["storageBytes"] == 0 and p["memberCount"] == 3

    r = admin.patch(f"/api/projects/{pid}", {"color": "#abcdef", "quotaBytes": 2048})
    assert r.status == 200 and r.data["color"] == "#abcdef" and r.data["quotaBytes"] == 2048
    assert admin.patch(f"/api/projects/{pid}", {"color": "blue"}).status == 400
    assert admin.patch(f"/api/projects/{pid}", {"quotaBytes": -1}).status == 400

    assert admin.patch(f"/api/projects/{pid}", {"isPublic": True}).status == 200
    doc = admin.post(f"/api/projects/{pid}/docs", {"title": "归档文档"}).data
    did = doc["id"]
    assert admin.put(f"/api/docs/{did}/content",
                     {"content": "v1", "baseVersion": 0}).status == 200
    f = admin.upload(pid, "归档文件.txt", b"hello").data
    folder = admin.post("/api/files/folders", {"name": "归档夹", "projectId": pid}).data
    trash_doc = admin.post(f"/api/projects/{pid}/docs", {"title": "待恢复文档"}).data
    assert admin.delete(f"/api/docs/{trash_doc['id']}").status == 200
    trash_file = admin.upload(pid, "待恢复文件.txt", b"trash").data
    assert admin.delete(f"/api/files/{trash_file['id']}").status == 200
    trash_folder = admin.post("/api/files/folders",
                              {"name": "待恢复夹", "projectId": pid}).data
    assert admin.delete(f"/api/files/folders/{trash_folder['id']}").status == 200

    r = admin.patch(f"/api/projects/{pid}", {"archived": True})
    assert r.status == 200 and r.data["archivedAt"], f"归档: {r.status} {r.data}"

    # 默认列表与广场隐藏；archived=1 可专门列出；直达仍可读
    assert pid not in [x["id"] for x in admin.get("/api/projects").data]
    archived_rows = admin.get("/api/projects?archived=1").data
    assert pid in [x["id"] for x in archived_rows]
    assert all(x["archivedAt"] for x in archived_rows)
    assert pid not in [x["id"] for x in admin.get("/api/discover/projects").data]
    detail = admin.get(f"/api/projects/{pid}")
    assert detail.status == 200 and detail.data["archivedAt"]
    assert admin.get(f"/api/projects/{pid}/docs/tree").status == 200
    assert admin.get(f"/api/docs/{did}").status == 200
    assert admin.get(f"/api/files?project_id={pid}").status == 200
    downloaded = admin.get(f"/api/files/{f['id']}/download")
    assert downloaded.status == 200 and downloaded.data == b"hello"
    assert admin.get(f"/api/projects/{pid}/trash").status == 200
    assert admin.get(f"/api/projects/{pid}/members").status == 200

    version = admin.get(f"/api/docs/{did}").data["version"]
    writes = [
        ("建文档", lambda: admin.post(f"/api/projects/{pid}/docs", {"title": "x"})),
        ("改文档", lambda: admin.patch(f"/api/docs/{did}", {"title": "x"})),
        ("写正文", lambda: admin.put(f"/api/docs/{did}/content",
                                     {"content": "x", "baseVersion": version})),
        ("追加正文", lambda: admin.post(f"/api/docs/{did}/append", {"content": "x"})),
        ("删文档", lambda: admin.delete(f"/api/docs/{did}")),
        ("恢复文档", lambda: admin.post(f"/api/docs/{trash_doc['id']}/restore")),
        ("上传文件", lambda: admin.upload(pid, "归档新文件.txt", b"x")),
        ("上传新版", lambda: admin.upload(pid, f["name"], b"v2", version_of=f["id"])),
        ("重命名文件", lambda: admin.patch(f"/api/files/{f['id']}", {"name": "改名.txt"})),
        ("移动文件", lambda: admin.post(f"/api/files/{f['id']}/move", {"projectId": pid})),
        ("删文件", lambda: admin.delete(f"/api/files/{f['id']}")),
        ("恢复文件", lambda: admin.post(f"/api/files/{trash_file['id']}/restore")),
        ("彻底删文件", lambda: admin.delete(f"/api/files/{trash_file['id']}/permanent")),
        ("建文件夹", lambda: admin.post("/api/files/folders",
                                      {"name": "x", "projectId": pid})),
        ("重命名文件夹", lambda: admin.patch(f"/api/files/folders/{folder['id']}",
                                         {"name": "x"})),
        ("移动文件夹", lambda: admin.post(f"/api/files/folders/{folder['id']}/move",
                                      {"projectId": pid})),
        ("删文件夹", lambda: admin.delete(f"/api/files/folders/{folder['id']}")),
        ("恢复文件夹", lambda: admin.post(f"/api/files/folders/{trash_folder['id']}/restore")),
        ("彻底删文件夹", lambda: admin.delete(
            f"/api/files/folders/{trash_folder['id']}/permanent")),
        ("加成员", lambda: admin.post(f"/api/projects/{pid}/members",
                                    {"userId": m3["id"], "role": "VIEWER"})),
        ("改成员", lambda: admin.patch(f"/api/projects/{pid}/members/{m['id']}",
                                    {"role": "VIEWER"})),
        ("移除成员", lambda: admin.delete(f"/api/projects/{pid}/members/{m2['id']}")),
        ("改空间设置", lambda: admin.patch(f"/api/projects/{pid}", {"name": "x"})),
    ]
    for label, call in writes:
        _assert_archived(call(), label)
    _assert_archived(outsider.post(f"/api/projects/{pid}/join"), "自助加入")
    mc = Client(base_url)
    mc.login(m_email, "arch12345")
    _assert_archived(mc.post(f"/api/projects/{pid}/leave"), "退出空间")
    assert _member_roles(admin, pid)[m["id"]] == "EDITOR"
    assert _member_roles(admin, pid)[m2["id"]] == "VIEWER"

    # 解除归档后列表/广场恢复，写入立即恢复
    r = admin.patch(f"/api/projects/{pid}", {"archived": False})
    assert r.status == 200 and r.data["archivedAt"] is None
    assert pid in [x["id"] for x in admin.get("/api/projects").data]
    assert pid in [x["id"] for x in admin.get("/api/discover/projects").data]
    assert admin.put(f"/api/docs/{did}/content",
                     {"content": "v2", "baseVersion": version}).status == 200

    # 个人空间不参与归档
    personal = next(x for x in admin.get("/api/projects").data if x["isPersonal"])
    r = admin.patch(f"/api/projects/{personal['id']}", {"archived": True})
    assert r.status == 403 and _code(r) == "FORBIDDEN"


def test_ws_content_write_rejected_when_archived(base_url, admin):
    ws_sync = pytest.importorskip("websockets.sync.client")
    from websockets.exceptions import ConnectionClosed

    pid = _project_id(admin, "归档 WS 空间")
    did = admin.post(f"/api/projects/{pid}/docs", {"title": "归档 WS 文档"}).data["id"]
    assert admin.put(f"/api/docs/{did}/content",
                     {"content": "v1", "baseVersion": 0}).status == 200
    assert admin.patch(f"/api/projects/{pid}", {"archived": True}).status == 200
    uri = base_url.replace("https://", "wss://").replace("http://", "ws://") + f"/ws/docs/{did}"
    try:
        with ws_sync.connect(uri, additional_headers={"Cookie": "td_sid=" + admin.sid},
                             open_timeout=10, max_queue=None, legacy=True) as ws:
            first = json.loads(ws.recv(timeout=10))
            assert first.get("type") == "presence", f"归档空间仍可建立只读 WS: {first}"
            ws.send(json.dumps({"type": "content", "content": "归档后写入",
                                "baseVersion": 1}))
            while True:
                msg = json.loads(ws.recv(timeout=10))
                assert msg.get("type") != "saved", f"归档空间不应回 saved: {msg}"
    except ConnectionClosed as exc:
        assert exc.rcvd is not None and exc.rcvd.code == 4403, \
            f"归档空间 WS 写应以 4403 关闭: {exc.rcvd and exc.rcvd.code}"
    else:
        pytest.fail("归档空间 WS content 写入后连接未被关闭")
    assert admin.get(f"/api/docs/{did}").data["content"] == "v1", "归档期间正文未被写入"
    assert admin.patch(f"/api/projects/{pid}", {"archived": False}).status == 200


def test_transfer_owner_is_atomic(base_url, admin):
    m_email, m = make_user(admin, "受让者", "trans12345")
    _, outsider = make_user(admin, "非成员", "trans12345")
    pid = _project_id(admin, "转让空间")
    assert admin.post(f"/api/projects/{pid}/members",
                      {"userId": m["id"], "role": "EDITOR"}).status == 200
    admin_id = admin.get("/api/auth/me").data["user"]["id"]

    r = admin.post(f"/api/projects/{pid}/transfer", {"userId": m["id"]})
    assert r.status == 200, f"转让 → 200: {r.status} {r.data}"
    assert r.data["myRole"] == "ADMIN", "原 owner 降 ADMIN"
    roles = _member_roles(admin, pid)
    assert roles[m["id"]] == "OWNER" and roles[admin_id] == "ADMIN"

    mc = Client(base_url)
    mc.login(m_email, "trans12345")
    # 原 owner（现在 ADMIN）不再能转让；目标非成员/自己/不存在都拒绝
    assert admin.post(f"/api/projects/{pid}/transfer",
                      {"userId": outsider["id"]}).status == 403
    assert mc.post(f"/api/projects/{pid}/transfer", {"userId": outsider["id"]}).status == 409
    assert mc.post(f"/api/projects/{pid}/transfer", {"userId": m["id"]}).status == 400
    assert mc.post(f"/api/projects/{pid}/transfer", {"userId": ABSENT_ID}).status == 404
    roles = _member_roles(admin, pid)
    assert roles[m["id"]] == "OWNER" and roles[admin_id] == "ADMIN", "失败不得部分改角色"

    r = mc.post(f"/api/projects/{pid}/transfer", {"userId": admin_id})
    assert r.status == 200, f"新 owner 转让回: {r.status} {r.data}"
    roles = _member_roles(admin, pid)
    assert roles[admin_id] == "OWNER" and roles[m["id"]] == "ADMIN"

    personal = next(x for x in admin.get("/api/projects").data if x["isPersonal"])
    assert admin.post(f"/api/projects/{personal['id']}/transfer",
                      {"userId": m["id"]}).status == 403


def test_create_project_with_members_is_transactional(admin):
    _, u1 = make_user(admin, "邀请一", "invite12345")
    _, u2 = make_user(admin, "邀请二", "invite12345")
    name = "邀请事务空间-" + uuid.uuid4().hex[:6]
    r = admin.post("/api/projects", {
        "name": name,
        "members": [{"userId": u1["id"], "role": "EDITOR"},
                    {"userId": u2["id"], "role": "VIEWER"}]})
    assert r.status == 200, f"创建带成员空间: {r.status} {r.data}"
    assert r.data["memberCount"] == 3
    roles = _member_roles(admin, r.data["id"])
    assert roles[u1["id"]] == "EDITOR" and roles[u2["id"]] == "VIEWER"

    names = lambda: {p["name"] for p in admin.get("/api/projects?all=1").data}
    bad_name = name + "-坏"
    r = admin.post("/api/projects", {
        "name": bad_name,
        "members": [{"userId": u1["id"], "role": "EDITOR"},
                    {"userId": ABSENT_ID, "role": "VIEWER"}]})
    assert r.status == 404, f"邀请不存在的用户 → 404: {r.status} {r.data}"
    assert bad_name not in names(), "失败时空间不得落库（同事务回滚）"

    r = admin.post("/api/projects", {
        "name": bad_name,
        "members": [{"userId": u1["id"], "role": "EDITOR"},
                    {"userId": u1["id"], "role": "VIEWER"}]})
    assert r.status == 400 and bad_name not in names(), "重复成员 400 且不落库"
    r = admin.post("/api/projects", {
        "name": bad_name,
        "members": [{"userId": u1["id"], "role": "BOSS"}]})
    assert r.status == 400 and bad_name not in names(), "非法角色 400 且不落库"


def test_search_filters_updated_by_and_permission(base_url, admin):
    e_email, e = make_user(admin, "搜索编辑", "search12345")
    admin_id = admin.get("/api/auth/me").data["user"]["id"]
    p1 = _project_id(admin, "搜索空间甲")
    p2 = _project_id(admin, "搜索空间乙")
    assert admin.post(f"/api/projects/{p1}/members",
                      {"userId": e["id"], "role": "EDITOR"}).status == 200
    d1 = admin.post(f"/api/projects/{p1}/docs", {"title": "过滤目标文档"}).data
    d2 = admin.post(f"/api/projects/{p2}/docs", {"title": "过滤目标文档"}).data
    keyword = "过滤关键词"
    assert admin.put(f"/api/docs/{d1['id']}/content",
                     {"content": keyword + " 甲", "baseVersion": 0}).status == 200
    assert admin.put(f"/api/docs/{d2['id']}/content",
                     {"content": keyword + " 乙", "baseVersion": 0}).status == 200

    ec = Client(base_url)
    ec.login(e_email, "search12345")
    version = admin.get(f"/api/docs/{d1['id']}").data["version"]
    assert ec.put(f"/api/docs/{d1['id']}/content",
                  {"content": keyword + " 编辑版", "baseVersion": version}).status == 200
    f1 = ec.upload(p1, "过滤文件.txt", b"one").data
    f2 = admin.upload(p2, "过滤文件.txt", b"two").data

    q = urllib.parse.quote("过滤目标")
    # 未加入的空间不泄数据：不带 projectId 的普通搜索与显式 projectId 都为空
    hits = ec.get(f"/api/search?q={q}").data
    assert {d["projectId"] for d in hits["docs"]} == {p1}
    for suffix in ("", f"&q={q}"):
        r = ec.get(f"/api/search?projectId={p2}{suffix}")
        assert r.status == 200 and r.data == {"docs": [], "files": []}

    # projectId + updatedBy 严格过滤；doc 行带更新人 id 与展示名
    r = ec.get(f"/api/search?q={q}&projectId={p1}&updatedBy={e['id']}")
    rows = r.data["docs"]
    assert [x["id"] for x in rows] == [d1["id"]]
    assert rows[0]["updatedBy"] == e["id"] and rows[0]["updatedByName"] == "搜索编辑"
    assert ec.get(f"/api/search?q={q}&projectId={p1}&updatedBy={admin_id}").data["docs"] == []

    qf = urllib.parse.quote("过滤文件")
    r = ec.get(f"/api/search?q={qf}&projectId={p1}&updatedBy={e['id']}")
    assert [x["id"] for x in r.data["files"]] == [f1["id"]]
    assert ec.get(f"/api/search?q={qf}&projectId={p2}&updatedBy={e['id']}").data["files"] == []

    # 最近动态（q 为空）同样支持两个过滤条件
    r = admin.get(f"/api/search?projectId={p2}&updatedBy={admin_id}")
    doc_ids = [x["id"] for x in r.data["docs"]]
    assert d2["id"] in doc_ids and d1["id"] not in doc_ids
    assert f2["id"] in [x["id"] for x in r.data["files"]]

    assert admin.get("/api/search?projectId=abc").status == 400


def test_admin_overview_aggregates_and_near_quota(base_url, admin):
    email, _ = make_user(admin, "总览普通", "over12345")
    normal = Client(base_url)
    normal.login(email, "over12345")
    assert normal.get("/api/admin/overview").status == 403

    before = admin.get("/api/admin/overview").data
    for key in ("userCount", "spaceCount", "todayLoginCount", "lockedCount",
                "storage", "nearQuota", "backup"):
        assert key in before, f"总览缺少 {key}: {list(before)}"
    assert {"files", "docs", "disk", "orphans"} <= set(before["storage"])
    assert {"config", "last", "nextRun"} <= set(before["backup"])

    _, _u = make_user(admin, "总览用户", "over12345")
    pid = _project_id(admin, "总览配额空间", {"quotaBytes": 100})
    up = admin.upload(pid, "quota.bin", b"x" * 90)
    assert up.status == 200, f"配额测试上传: {up.status} {up.data}"

    after = admin.get("/api/admin/overview").data
    assert after["userCount"] == before["userCount"] + 1
    assert after["spaceCount"] == before["spaceCount"] + 1
    assert after["todayLoginCount"] >= 1
    assert isinstance(after["lockedCount"], int) and after["lockedCount"] >= 0
    entry = next((x for x in after["nearQuota"] if x["id"] == pid), None)
    assert entry, f"达到 80% 的空间应进入 nearQuota: {after['nearQuota']}"
    assert entry["quotaBytes"] == 100 and entry["storageBytes"] == 90
    assert entry["ratio"] >= 0.8


def test_preference_columns_migration_is_idempotent(tmp_path):
    path = tmp_path / "legacy-prefs.db"
    conn = sqlite3.connect(path)
    conn.execute("""CREATE TABLE users (
        id VARCHAR(26) PRIMARY KEY, email VARCHAR(255) NOT NULL UNIQUE,
        name VARCHAR(50) NOT NULL, password_hash VARCHAR(200) NOT NULL,
        is_admin BOOLEAN, is_disabled BOOLEAN, created_at DATETIME NOT NULL)""")
    conn.execute("""CREATE TABLE projects (
        id VARCHAR(26) PRIMARY KEY, name VARCHAR(100) NOT NULL, description TEXT,
        is_personal BOOLEAN, visibility VARCHAR(10), join_role VARCHAR(10),
        created_by VARCHAR(26), created_at DATETIME NOT NULL)""")
    uid, pid = "u" + "0" * 25, "p" + "0" * 25
    conn.execute("INSERT INTO users VALUES (?,?,?,?,?,?,?)",
                 (uid, "old@t.local", "旧用户", "x", 0, 0, "2026-01-01 00:00:00"))
    conn.execute("INSERT INTO projects VALUES (?,?,?,?,?,?,?,?)",
                 (pid, "旧空间", "", 0, "private", "VIEWER", uid,
                  "2026-01-01 00:00:00"))
    conn.commit()
    conn.close()

    engine = create_engine(f"sqlite:///{path}")
    try:
        schema.init(engine)
        schema.init(engine)  # 第二次必须无副作用
        with engine.connect() as db:
            user_cols = {r[1] for r in db.execute(text("PRAGMA table_info(users)"))}
            project_cols = {r[1] for r in db.execute(text("PRAGMA table_info(projects)"))}
            assert "avatar_color" in user_cols
            assert {"color", "quota_bytes", "archived_at"} <= project_cols
            assert db.execute(text("SELECT name,avatar_color FROM users WHERE id=:id"),
                              {"id": uid}).one() == ("旧用户", None)
            assert db.execute(text("SELECT name,color,quota_bytes,archived_at "
                                   "FROM projects WHERE id=:id"),
                              {"id": pid}).one() == ("旧空间", None, None, None)
        assert schema.check_drift(engine) == []
    finally:
        engine.dispose()
