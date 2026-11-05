"""归档空间的搜索策略。

工单要求的两个真实行为契约：
  * 全局搜索（无 projectId）默认排除 archived_at 非空的 space；includeArchived=1 包含，
    显式 projectId（用户已进入该空间）不做归档过滤；解除归档后默认搜索恢复。
  * 最近动态（q 为空）与关键词搜索遵守同一套归档开关。

搜索结果行（doc/file）都带 archived 布尔，前端据此显示「已归档」徽标。
"""
import urllib.parse
import uuid


def _project(admin, name):
    r = admin.post("/api/projects", {"name": name})
    assert r.status == 200, f"建空间失败: {r.status} {r.data}"
    return r.data["id"]


def _ids(rows):
    return {row["id"] for row in rows}


def _row(rows, row_id):
    hit = [row for row in rows if row["id"] == row_id]
    assert hit, f"结果中缺少 {row_id}: {[r['id'] for r in rows]}"
    return hit[0]


def _seed_archived_space(admin, name):
    """建一个带文档/文件的空间并归档，返回 (pid, doc, file, keyword)。"""
    keyword = "归档搜索" + uuid.uuid4().hex[:8]
    pid = _project(admin, name + uuid.uuid4().hex[:6])
    doc = admin.post(f"/api/projects/{pid}/docs", {"title": keyword}).data
    assert admin.put(f"/api/docs/{doc['id']}/content",
                     {"content": keyword + " 正文", "baseVersion": 0}).status == 200
    file_row = admin.upload(pid, keyword + ".txt", b"archived").data
    assert admin.patch(f"/api/projects/{pid}", {"archived": True}).status == 200
    return pid, doc, file_row, keyword


def test_global_search_excludes_archived_until_included(admin):
    pid, doc, file_row, keyword = _seed_archived_space(admin, "归档搜索空间")
    q = urllib.parse.quote(keyword)

    # 默认全局搜索：归档空间的文档与文件都不出现。
    default = admin.get(f"/api/search?q={q}").data
    assert doc["id"] not in _ids(default["docs"])
    assert file_row["id"] not in _ids(default["files"])

    # 打开开关：结果回来且归档标记为 true。
    included = admin.get(f"/api/search?q={q}&includeArchived=1").data
    drow = _row(included["docs"], doc["id"])
    frow = _row(included["files"], file_row["id"])
    assert drow["archived"] is True and drow["projectId"] == pid
    assert drow["projectName"]
    assert frow["archived"] is True and frow["projectId"] == pid

    # 显式 projectId 表示用户已进入该空间，即使不带开关也可读。
    explicit = admin.get(f"/api/search?q={q}&projectId={pid}").data
    assert _row(explicit["docs"], doc["id"])["archived"] is True
    assert _row(explicit["files"], file_row["id"])["archived"] is True

    # 解除归档后默认搜索恢复，且行上的归档标记回到 false。
    assert admin.patch(f"/api/projects/{pid}", {"archived": False}).status == 200
    after = admin.get(f"/api/search?q={q}").data
    assert _row(after["docs"], doc["id"])["archived"] is False
    assert _row(after["files"], file_row["id"])["archived"] is False


def test_recent_search_respects_archived_flag(admin):
    admin_id = admin.get("/api/auth/me").data["user"]["id"]
    pid, doc, file_row, _ = _seed_archived_space(admin, "归档最近空间")
    base = f"/api/search?updatedBy={admin_id}&limit=100"

    # 最近动态（q 为空）与关键词搜索同口径：默认排除归档空间。
    default = admin.get(base).data
    assert doc["id"] not in _ids(default["docs"])
    assert file_row["id"] not in _ids(default["files"])

    included = admin.get(base + "&includeArchived=1").data
    assert _row(included["docs"], doc["id"])["archived"] is True
    assert _row(included["files"], file_row["id"])["archived"] is True

    # 显式空间上下文同样不受归档过滤。
    explicit = admin.get(f"/api/search?projectId={pid}&limit=100").data
    assert _row(explicit["docs"], doc["id"])["archived"] is True
    assert _row(explicit["files"], file_row["id"])["archived"] is True
