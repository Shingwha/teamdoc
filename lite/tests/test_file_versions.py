"""文件版本 HTTP 全链路：上传、历史、权限、变更、备份与物理删除。"""
import io
import sqlite3
import zipfile

from _harness import Client, make_user


def _project(admin, name):
    r = admin.post("/api/projects", {"name": name})
    assert r.status == 200, r.data
    return r.data["id"]


def _new_version(client, fid, content):
    return client.post(f"/api/files/{fid}/versions?name=ignored.bin", raw_body=content,
                       ctype="application/octet-stream")


def test_upload_restore_history_and_changes(admin):
    pid = _project(admin, "文件版本主链路")
    first = admin.upload(pid, "data.txt", b"v1")
    assert first.status == 200, first.data
    fid = first.data["id"]
    assert first.data["version"] == 1
    assert first.data["updatedBy"] and first.data["updatedAt"]

    second = _new_version(admin, fid, b"version-two")
    assert second.status == 200, second.data
    assert second.data["version"] == 2 and second.data["name"] == "data.txt"
    assert second.data["size"] == len(b"version-two")

    rows = admin.get(f"/api/files/{fid}/versions")
    assert rows.status == 200, rows.data
    assert [v["version"] for v in rows.data] == [2, 1]
    me = admin.get("/api/auth/me").data["user"]
    assert rows.data[0]["createdBy"] == me["id"]
    assert rows.data[0]["createdByName"] == me["name"]
    assert rows.data[0]["size"] == len(b"version-two")

    assert admin.get(f"/api/files/{fid}/download").data == b"version-two"
    assert admin.get(f"/api/files/{fid}/download?version=1").data == b"v1"
    old_meta = admin.get(f"/api/files/{fid}?version=1")
    assert old_meta.status == 200 and old_meta.data["version"] == 1
    assert old_meta.data["size"] == 2
    assert admin.get(f"/api/files/{fid}/download?version=999").status == 404
    assert admin.get(f"/api/files/{fid}?version=999").status == 404

    restored = admin.post(f"/api/files/{fid}/restore", {"version": 1})
    assert restored.status == 200, restored.data
    assert restored.data["version"] == 3 and restored.data["size"] == 2
    assert admin.get(f"/api/files/{fid}/download").data == b"v1"
    assert [v["version"] for v in admin.get(f"/api/files/{fid}/versions").data] == [3, 2, 1]

    changes = admin.get(f"/api/projects/{pid}/file-changes?since=0&limit=200")
    assert changes.status == 200, changes.data
    assert len(changes.data["changes"]) == 3, changes.data
    assert [c["op"] for c in changes.data["changes"]] == ["upsert"] * 3
    assert all(c["fileId"] == fid and c["spaceId"] == pid and c["at"]
               for c in changes.data["changes"])
    assert changes.data["nextSeq"] == changes.data["changes"][-1]["seq"]
    since = changes.data["nextSeq"]
    empty = admin.get(f"/api/projects/{pid}/file-changes?since={since}").data
    assert empty == {"changes": [], "nextSeq": since}


def test_duplicate_409_keep_and_version_of(admin):
    pid = _project(admin, "文件撞名两分支")
    first = admin.upload(pid, "same.bin", b"one").data
    conflict = admin.upload(pid, "same.bin", b"bad")
    assert conflict.status == 409
    detail = conflict.data["detail"]
    assert detail["code"] == "name_exists"
    assert detail["existing"] == {"id": first["id"], "name": "same.bin", "size": 3,
                                  "updatedAt": first["updatedAt"],
                                  "updatedBy": first["updatedBy"],
                                  "updatedByName": "管理员"}

    kept = admin.upload(pid, "same.bin", b"keep", name_mode="keep")
    assert kept.status == 200 and kept.data["name"] == "same(2).bin"
    versioned = admin.upload(pid, "new-display-name.bin", b"two", version_of=first["id"])
    assert versioned.status == 200, versioned.data
    assert versioned.data["id"] == first["id"] and versioned.data["version"] == 2
    assert versioned.data["name"] == "same.bin", "version_of 忽略上传显示名"
    names = [f["name"] for f in admin.get(f"/api/files?project_id={pid}").data["files"]]
    assert sorted(names) == ["same(2).bin", "same.bin"]
    assert admin.upload(pid, "same.bin", b"x", name_mode="keep",
                        version_of=first["id"]).status == 400


def test_version_permissions_and_share_always_current(base_url, admin):
    pid = _project(admin, "文件版本权限")
    fid = admin.upload(pid, "roles.txt", b"v1").data["id"]
    assert _new_version(admin, fid, b"v2").status == 200
    viewer_email, _ = make_user(admin, "版本只读", "viewer12345")
    editor_email, _ = make_user(admin, "版本编辑", "editor12345")
    outsider_email, _ = make_user(admin, "版本外部", "outsider12345")
    users = admin.get("/api/users").data
    ids = {u["email"]: u["id"] for u in users}
    for email, role in ((viewer_email, "VIEWER"), (editor_email, "EDITOR")):
        assert admin.post(f"/api/projects/{pid}/members",
                          {"userId": ids[email], "role": role}).status == 200
    viewer, editor, outsider = Client(base_url), Client(base_url), Client(base_url)
    viewer.login(viewer_email, "viewer12345")
    editor.login(editor_email, "editor12345")
    outsider.login(outsider_email, "outsider12345")

    assert viewer.get(f"/api/files/{fid}/versions").status == 200
    assert viewer.get(f"/api/files/{fid}/download?version=1").data == b"v1"
    assert _new_version(viewer, fid, b"denied").status == 403
    assert viewer.post(f"/api/files/{fid}/restore", {"version": 1}).status == 403
    assert outsider.get(f"/api/files/{fid}/versions").status == 403
    assert outsider.get(f"/api/files/{fid}/download?version=1").status == 403

    assert _new_version(editor, fid, b"v3").status == 200
    restored = editor.post(f"/api/files/{fid}/restore", {"version": 1})
    assert restored.status == 200 and restored.data["version"] == 4
    share = admin.post(f"/api/files/{fid}/share", {})
    assert share.status == 200
    anonymous = Client(base_url)
    assert anonymous.get(share.data["url"]).data == b"v1", "分享链接始终取当前版本"


def test_versions_survive_orphan_scan_and_backup_then_permanent_delete(admin, data_dir):
    pid = _project(admin, "版本备份与彻底删除")
    before = set((data_dir / "files").iterdir())
    fid = admin.upload(pid, "physical.txt", b"old").data["id"]
    assert _new_version(admin, fid, b"new").status == 200
    assert admin.post(f"/api/files/{fid}/restore", {"version": 1}).status == 200
    paths = set((data_dir / "files").iterdir()) - before
    assert len(paths) == 2, "恢复共享首版路径，不复制第三份物理文件"
    assert admin.post("/api/admin/storage/cleanup?force=1").status == 200
    assert all(p.exists() for p in paths), "历史与当前路径都不是孤儿"

    response = admin.get("/api/admin/backup")
    assert response.status == 200
    with zipfile.ZipFile(io.BytesIO(response.data)) as archive:
        names = set(archive.namelist())
        assert {f"files/{p.name}" for p in paths} <= names
        with archive.open("teamdoc.db") as src:
            raw = src.read()
    import tempfile
    from pathlib import Path
    with tempfile.TemporaryDirectory() as tmp:
        snapshot = Path(tmp) / "snapshot.db"
        snapshot.write_bytes(raw)
        conn = sqlite3.connect(snapshot)
        count = conn.execute("SELECT COUNT(*) FROM file_versions WHERE file_id=?", (fid,)).fetchone()[0]
        conn.close()
    assert count == 3

    assert admin.delete(f"/api/files/{fid}").status == 200
    assert admin.delete(f"/api/files/{fid}/permanent").status == 200
    assert not any(p.exists() for p in paths), "彻底删除清除全部不再引用的版本物理文件"


def test_folder_and_project_delete_include_versions(admin, data_dir):
    files_dir = data_dir / "files"
    pid = _project(admin, "目录版本删除")
    folder = admin.post("/api/files/folders", {"projectId": pid, "name": " versions "}).data
    fid = admin.upload(pid, "nested.bin", b"1", folder_id=folder["id"]).data["id"]
    assert _new_version(admin, fid, b"2").status == 200
    assert admin.delete(f"/api/files/folders/{folder['id']}").status == 200
    assert admin.delete(f"/api/files/folders/{folder['id']}/permanent").status == 200
    assert admin.get(f"/api/files/{fid}/versions").status == 404

    pid2 = _project(admin, "空间版本删除")
    fid2 = admin.upload(pid2, "space.bin", b"1").data["id"]
    before = set(files_dir.iterdir())
    assert _new_version(admin, fid2, b"2").status == 200
    new_paths = set(files_dir.iterdir()) - before
    assert len(new_paths) == 1
    assert admin.delete(f"/api/projects/{pid2}").status == 200
    assert not any(p.exists() for p in new_paths)


def test_file_changes_cover_delete_restore_rename_and_cross_project_move(admin):
    src = _project(admin, "文件变更来源")
    dst = _project(admin, "文件变更目标")
    fid = admin.upload(src, "changes.txt", b"1").data["id"]
    assert admin.delete(f"/api/files/{fid}").status == 200
    assert admin.post(f"/api/files/{fid}/restore").status == 200
    assert admin.patch(f"/api/files/{fid}", {"name": "renamed.txt"}).status == 200
    assert admin.post(f"/api/files/{fid}/move", {"projectId": dst}).status == 200
    source_ops = [c["op"] for c in admin.get(
        f"/api/projects/{src}/file-changes").data["changes"]]
    target_ops = [c["op"] for c in admin.get(
        f"/api/projects/{dst}/file-changes").data["changes"]]
    assert source_ops == ["upsert", "delete", "upsert", "upsert", "delete"]
    assert target_ops == ["upsert"]


def test_aborted_version_upload_keeps_current_and_leaves_no_orphan(base_url, admin, data_dir):
    import time
    from _harness import abort_raw_upload

    pid = _project(admin, "新版上传断连")
    fid = admin.upload(pid, "stable.bin", b"stable").data["id"]
    before = set((data_dir / "files").iterdir())
    assert abort_raw_upload(base_url, admin.sid, pid, "ignored.bin",
                            total_bytes=5 * 1024 * 1024, send_bytes=512 * 1024,
                            version_file_id=fid)
    extra = None
    for _ in range(20):
        time.sleep(0.25)
        extra = set((data_dir / "files").iterdir()) - before
        if not extra:
            break
    assert not extra, f"新版断连不得留下孤儿: {extra}"
    assert [v["version"] for v in admin.get(f"/api/files/{fid}/versions").data] == [1]
    assert admin.get(f"/api/files/{fid}/download").data == b"stable"


def test_permanent_delete_preserves_delete_change_for_polling(admin):
    pid = _project(admin, "彻底删除轮询")
    fid = admin.upload(pid, "gone.txt", b"x").data["id"]
    assert admin.delete(f"/api/files/{fid}").status == 200
    assert admin.delete(f"/api/files/{fid}/permanent").status == 200
    changes = admin.get(f"/api/projects/{pid}/file-changes").data["changes"]
    assert [(c["fileId"], c["op"]) for c in changes] == [(fid, "upsert"), (fid, "delete")]
