"""空间配额硬限制：去重物理占用计量与上传/新版本/跨空间移动拦截。

工单守的四个行为契约：
  * 达到配额后新上传 403 QUOTA_EXCEEDED（detail 带够差额数据）；回收站仍占用，
    彻底删除释放后可再传。
  * 新版本按本次写入的完整字节计量（旧版物理文件保留）；恢复历史版本共享路径，
    不新增字节也不被拦截。
  * 跨空间移动文件与文件夹都先校验目标空间配额，失败时源/目标均未变。
  * quotaUsedBytes 含当前 + 历史 + 回收站且按物理路径去重；未设配额与个人空间不受限。
"""
from _harness import Client

QUOTA_EXCEEDED = "QUOTA_EXCEEDED"


def _space(admin, name, quota=None):
    body = {"name": name}
    if quota is not None:
        body["quotaBytes"] = quota
    r = admin.post("/api/projects", body)
    assert r.status == 200, f"建空间失败: {r.status} {r.data}"
    return r.data["id"]


def _project(admin, pid):
    r = admin.get(f"/api/projects/{pid}")
    assert r.status == 200, f"取空间失败: {r.status} {r.data}"
    return r.data


def _new_version(client, fid, content):
    return client.post(f"/api/files/{fid}/versions?name=ignored.bin", raw_body=content,
                       ctype="application/octet-stream")


def _quota_detail(resp):
    assert resp.status == 403, f"超配额应 403: {resp.status} {resp.data}"
    detail = resp.data["detail"]
    assert detail["code"] == QUOTA_EXCEEDED, f"错误码应为 {QUOTA_EXCEEDED}: {detail}"
    assert detail["message"], f"配额错误应带可读文案: {detail}"
    return detail


def _file_names(client, pid):
    return [f["name"] for f in client.get(f"/api/files?project_id={pid}").data["files"]]


def test_upload_blocked_at_quota_and_released_after_permanent_delete(admin):
    pid = _space(admin, "配额上传拦截", 10)
    first = admin.upload(pid, "a.bin", b"123456")
    assert first.status == 200, first.data
    assert _project(admin, pid)["quotaUsedBytes"] == 6

    blocked = admin.upload(pid, "b.bin", b"abcdef")
    detail = _quota_detail(blocked)
    assert detail["quotaBytes"] == 10
    assert detail["usedBytes"] == 6
    assert detail["requiredBytes"] == 12
    assert "b.bin" not in _file_names(admin, pid), "被拒的上传不得留下记录"

    # 软删除进回收站仍占磁盘，因此仍然拦截
    assert admin.delete(f"/api/files/{first.data['id']}").status == 200
    assert _project(admin, pid)["quotaUsedBytes"] == 6
    still_blocked = admin.upload(pid, "c.bin", b"12345")
    assert _quota_detail(still_blocked)["usedBytes"] == 6

    # 彻底删除释放物理路径后可以再传
    assert admin.delete(f"/api/files/{first.data['id']}/permanent").status == 200
    assert _project(admin, pid)["quotaUsedBytes"] == 0
    retried = admin.upload(pid, "c.bin", b"12345")
    assert retried.status == 200, retried.data
    assert _project(admin, pid)["quotaUsedBytes"] == 5


def test_version_bytes_count_and_restore_is_allowed(admin):
    pid = _space(admin, "配额版本计量", 10)
    fid = admin.upload(pid, "v.bin", b"123456").data["id"]

    over = _new_version(admin, fid, b"abcdef")
    detail = _quota_detail(over)
    assert detail["usedBytes"] == 6 and detail["requiredBytes"] == 12

    # 老版本物理文件不会释放，所以新版按完整字节累加；恰好等于配额可以写入
    ok = _new_version(admin, fid, b"wxyz")
    assert ok.status == 200, ok.data
    assert ok.data["version"] == 2
    assert _project(admin, pid)["quotaUsedBytes"] == 10

    via_version_of = admin.upload(pid, "ignored.bin", b"x", version_of=fid)
    detail = _quota_detail(via_version_of)
    assert detail["usedBytes"] == 10 and detail["requiredBytes"] == 11

    # 恢复历史版本复用 v1 物理路径，不新增字节，必须放行
    restored = admin.post(f"/api/files/{fid}/restore", {"version": 1})
    assert restored.status == 200, restored.data
    assert restored.data["version"] == 3
    assert _project(admin, pid)["quotaUsedBytes"] == 10
    assert admin.get(f"/api/files/{fid}/download?version=1").data == b"123456"


def test_cross_space_moves_are_blocked_by_target_quota(admin):
    src = _space(admin, "配额移动源")
    dst = _space(admin, "配额移动目标", 10)
    first = admin.upload(src, "a.bin", b"123456").data
    moved = admin.post(f"/api/files/{first['id']}/move", {"projectId": dst})
    assert moved.status == 200 and moved.data["projectId"] == dst
    assert _project(admin, dst)["quotaUsedBytes"] == 6

    second = admin.upload(src, "b.bin", b"abcdef").data
    blocked = admin.post(f"/api/files/{second['id']}/move", {"projectId": dst})
    detail = _quota_detail(blocked)
    assert detail["usedBytes"] == 6 and detail["requiredBytes"] == 12
    assert second["id"] in [f["id"] for f in
                            admin.get(f"/api/files?project_id={src}").data["files"]], \
        "被拒的文件应留在源空间"
    assert second["id"] not in [f["id"] for f in
                                admin.get(f"/api/files?project_id={dst}").data["files"]]
    assert _project(admin, dst)["quotaUsedBytes"] == 6

    # 文件夹跨空间移动按子树去重字节计量
    folder = admin.post("/api/files/folders", {"name": "配额子树", "projectId": src}).data
    admin.upload(src, "c.bin", b"12345", folder_id=folder["id"])
    blocked_folder = admin.post(f"/api/files/folders/{folder['id']}/move",
                               {"projectId": dst})
    detail = _quota_detail(blocked_folder)
    assert detail["usedBytes"] == 6 and detail["requiredBytes"] == 11
    roots = [x["id"] for x in admin.get(f"/api/files?project_id={src}").data["folders"]]
    assert folder["id"] in roots, "被拒的文件夹应留在源空间"
    assert _project(admin, dst)["quotaUsedBytes"] == 6


def test_quota_used_bytes_counts_history_and_trash(admin):
    pid = _space(admin, "配额口径", 100)
    fid = admin.upload(pid, "h.bin", b"123456").data["id"]
    assert _project(admin, pid)["quotaUsedBytes"] == 6
    assert _new_version(admin, fid, b"wxyz").status == 200
    assert _project(admin, pid)["quotaUsedBytes"] == 10

    # 恢复共享 v1 路径：物理占用仍是 6 + 4，不因多一个版本行翻倍
    assert admin.post(f"/api/files/{fid}/restore", {"version": 1}).status == 200
    assert _project(admin, pid)["quotaUsedBytes"] == 10

    # 回收站计入配额；活跃口径 storageBytes 不再包含它
    assert admin.delete(f"/api/files/{fid}").status == 200
    p = _project(admin, pid)
    assert p["quotaUsedBytes"] == 10 and p["storageBytes"] == 0

    admin_row = next(x for x in admin.get("/api/admin/projects").data if x["id"] == pid)
    assert admin_row["quotaUsedBytes"] == 10, "管理面空间总览也要给 quotaUsedBytes"

    # 不限额空间与个人空间都不受配额约束
    free_pid = _space(admin, "不限额空间")
    assert admin.upload(free_pid, "big.bin", b"x" * 64).status == 200
    personal = next(p for p in admin.get("/api/projects").data if p["isPersonal"])
    assert admin.patch(f"/api/projects/{personal['id']}",
                       {"quotaBytes": 1}).status == 200
    assert admin.upload(personal["id"], "personal.bin", b"x" * 64).status == 200
    # 还原个人空间配额，避免影响同会话的其他用例
    assert admin.patch(f"/api/projects/{personal['id']}",
                       {"quotaBytes": 0}).status == 200
