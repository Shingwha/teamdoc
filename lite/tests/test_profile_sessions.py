"""本人资料与登录会话：字段边界、颜色一致性、会话吊销与 PAT 隔离。

只测真实契约，不重复冒烟已覆盖的状态码：
  * PATCH /api/users/me 只接受 name/email/avatarColor，邮箱唯一/格式沿用，颜色落库并在
    本人、同事目录、管理列表一致；管理 patch 同样支持颜色，清空回落 id 派生色。
  * 自己的会话列表只给 ref（sha256），当前会话不能被单条接口误踢，其他会话可单条/批量
    吊销；只能操作自己的会话；PAT 不能管理 Web 会话。
"""
import json

from _harness import Client, make_user, rand_email


def _me(client):
    return client.get("/api/auth/me").data["user"]


def test_self_profile_fields_color_and_scope(base_url, admin):
    email, user = make_user(admin, "资料甲", "prof12345")
    c = Client(base_url)
    c.login(email, "prof12345")
    initial_color = _me(c)["avatarColor"]
    assert initial_color, "未设置时仍返回 id 派生色"

    new_email = rand_email("changed")
    r = c.patch("/api/users/me", {"name": "资料甲改", "email": new_email,
                                  "avatarColor": "#123ABC"})
    assert r.status == 200, f"本人改资料 → 200: {r.status} {r.data}"
    got = r.data["user"]
    assert got["name"] == "资料甲改" and got["email"] == new_email
    assert got["avatarColor"] == "#123ABC" and got["isAdmin"] is False
    assert _me(c)["name"] == "资料甲改" and _me(c)["email"] == new_email

    # 颜色在所有用户面孔一致（本人 / 同事目录 / 管理列表）
    directory = next(u for u in c.get("/api/users/directory").data if u["id"] == user["id"])
    admin_row = next(u for u in admin.get("/api/users").data if u["id"] == user["id"])
    assert directory["avatarColor"] == "#123ABC"
    assert admin_row["avatarColor"] == "#123ABC"

    # 管理 patch 同步支持颜色；清空后回落到最初的 id 派生色
    r = admin.patch(f"/api/users/{user['id']}", {"avatarColor": "#00ff00"})
    assert r.status == 200 and r.data["avatarColor"] == "#00ff00"
    assert _me(c)["avatarColor"] == "#00ff00"
    r = admin.patch(f"/api/users/{user['id']}", {"avatarColor": None})
    assert r.status == 200 and r.data["avatarColor"] == initial_color

    # 格式/唯一性沿用：非法颜色、非法邮箱 400；他人邮箱 409
    assert c.patch("/api/users/me", {"avatarColor": "red"}).status == 400
    assert c.patch("/api/users/me", {"avatarColor": "#12345"}).status == 400
    assert c.patch("/api/users/me", {"email": "not-an-email"}).status == 400
    admin_email = _me(admin)["email"]
    assert c.patch("/api/users/me", {"email": admin_email}).status == 409

    # “只允许”是硬边界：附带 isAdmin 等字段直接 400，且没有提权
    r = c.patch("/api/users/me", {"isAdmin": True})
    assert r.status == 400, f"越界字段 → 400: {r.status} {r.data}"
    assert _me(c)["isAdmin"] is False
    # 普通用户不能改别人（管理接口仍要求管理员）
    admin_id = _me(admin)["id"]
    assert c.patch(f"/api/users/{admin_id}", {"name": "越权"}).status == 403


def test_my_sessions_list_revoke_and_pat_isolation(base_url, admin):
    email, user = make_user(admin, "会话甲", "sess12345")
    a, b = Client(base_url), Client(base_url)
    a.login(email, "sess12345")
    b.login(email, "sess12345")

    r = a.get("/api/auth/sessions")
    assert r.status == 200, f"会话列表 → 200: {r.status} {r.data}"
    rows = r.data
    assert len(rows) == 2 and sum(1 for x in rows if x["current"]) == 1
    expected = {"ref", "ip", "device", "deviceKind", "createdAt", "lastSeenAt",
                "expiresAt", "online", "current"}
    assert all(set(x) == expected for x in rows), f"字段面固定且不含原始 token: {rows}"
    assert all(len(x["ref"]) == 64 for x in rows)
    assert a.sid not in json.dumps(rows) and b.sid not in json.dumps(rows)
    current = next(x for x in rows if x["current"])
    other = next(x for x in rows if not x["current"])
    assert other["device"] and other["deviceKind"] in ("desktop", "mobile")

    # 当前会话不可经单条接口误踢（走 logout）
    r = a.delete(f"/api/auth/sessions/{current['ref']}")
    assert r.status == 409 and r.data["detail"]["code"] == "CONFLICT"
    assert a.get("/api/auth/me").status == 200

    # 单条吊销其他会话：被踢的立刻 401，本会话不受影响
    assert a.delete(f"/api/auth/sessions/{other['ref']}").status == 200
    assert b.get("/api/auth/me").status == 401
    assert a.get("/api/auth/me").status == 200
    assert a.delete(f"/api/auth/sessions/{other['ref']}").status == 404, "已失效 ref → 404"

    # 批量吊销其他全部会话，保留当前会话
    c = Client(base_url)
    c.login(email, "sess12345")
    r = a.delete("/api/auth/sessions")
    assert r.status == 200 and r.data["revoked"] == 1
    assert c.get("/api/auth/me").status == 401 and a.get("/api/auth/me").status == 200

    # 只操作 ctx.user：拿别人的 ref 来删永远 404，且对方会话不受影响
    email2, _ = make_user(admin, "会话乙", "sess12345")
    d = Client(base_url)
    d.login(email2, "sess12345")
    other_ref = d.get("/api/auth/sessions").data[0]["ref"]
    assert a.delete(f"/api/auth/sessions/{other_ref}").status == 404
    assert d.get("/api/auth/me").status == 200

    # PAT 不能管理 Web 会话：列表/单条/批量一律 403
    pat = a.post("/api/auth/pats", {"name": "会话令牌", "scopes": "read,write"})
    assert pat.status == 200, f"建 PAT: {pat.status} {pat.data}"
    pc = Client(base_url, bearer=pat.data["token"])
    assert pc.get("/api/auth/sessions").status == 403
    assert pc.delete(f"/api/auth/sessions/{current['ref']}").status == 403
    assert pc.delete("/api/auth/sessions").status == 403
    assert a.get("/api/auth/me").status == 200, "PAT 的拒绝不能影响 Web 会话"
