# W1-a 后端交接包
> 当前工作区直接修改 / 无分支、无 commit / 2026-11-05 23:03（UTC+8）

## A. 变更、接口与真实验证
- 轻分层完成：新增 `db.py`、`storage.py`、`treeutil.py`、`http_util.py`、`security/`，业务进入 `services/`，HTTP/WS 进入 `routers/`。旧顶层 `admin/auth/backup/docs/files/projects/refs/search/trash/ws.py` 已删除或迁走，无兼容 shim；`models.py` 仅余 ORM。
- 文件模型：`File.version/updated_by/updated_at`，新增 `FileVersion(file_id,version)` 唯一约束与 `FileChange(space_id,seq)` 索引；启动迁移补列、回填当前版本并可重复执行，随后仍做结构漂移校验。
- `POST /api/files/upload`：普通云空间撞名 409 `detail.code=name_exists`，`detail.existing={id,name,size,updatedAt,updatedBy}`；`name_mode=keep` 走 dedupe；`version_of={fileId}` 忽略显示名并写 version+1。两者同传为 400。
- `POST /api/files/{id}/versions?name=` raw body 显式新版；`GET .../versions` 降序返回 `{version,size,createdAt,createdBy,createdByName}`；`POST .../restore {version:int}` 登记 version+1，不复制物理文件。
- `GET /api/files/{id}/download?version=n`、`GET /api/files/{id}?version=n` 支持历史；分享链接始终当前版。`GET /api/projects/{id}/file-changes?since=0&limit=200` 返回 `{changes,nextSeq}`。
- 所有 `file_json` 面孔增加 `version/updatedBy/updatedAt`。EDITOR 可上传/恢复，VIEWER 可列表/下载，未删除资源才可见，非法/不存在版本 404。
- 上传为预检 → 关闭 DB 后异步流式写盘 → 最终重验并单事务写 File/FileVersion/FileChange；INFLIGHT 覆盖新版，断连/失败不留记录或孤儿。跨空间移动写源 delete + 目标 upsert；彻底删除保留 delete 轮询日志。
- 每日 20+90 清理：每文件至少留 20，只删排名 20 外且严格超过 90 天的版本。备份、孤儿扫描收集当前与全部历史路径；文件/文件夹/空间彻底删除均先提交 DB，再按全库引用删除物理文件。
- 请求响应增加 `X-Request-ID`，应用 access log 记录同一 ID，仍经非阻塞日志队列。
- 基线：`uv run pytest ../tests/test_smoke_endpoints.py ../tests/test_files_paging.py` → **6 passed**。
- 工单验收：`uv run pytest ../tests/test_smoke_endpoints.py ../tests/test_files_paging.py ../tests/test_upload_security.py ../tests/test_admin_storage.py ../tests/test_backup_restore.py` → **17 passed, 1 skipped**（既有上传限额跳过）。
- 新增：`uv run pytest ../tests/test_file_versions.py ../tests/test_file_version_services.py` → **14 passed**。
- 后端快速组（18 个后端测试文件）→ **91 passed, 1 skipped, 2 deselected**。
- 最终 `uv run pytest ../tests` → **151 passed, 1 skipped, 3 deselected, 3 failed**。失败为登记的 `test_markdown_diagram.py::test_markdown_extensions_in_browser`（本次表现为未取回报告），以及并行前端范围的 `test_layout_contract.py::test_no_spacing_assignment_in_query_blocks`（`editor.css`）和 `test_page_assets.py::test_page_assets_complete`（`/js/doceditor.js` 404）；未介入这些范围。
- 服务层正则检查 `^(from fastapi|import fastapi|from starlette|import starlette)` → **0 匹配**。

## B. 偏差、坑与后续约束
- `POST /api/files/{id}/restore` 与回收站恢复同路径：已删除文件走原回收站语义（无 body 也可），未删除文件要求 JSON `version`；不要重复注册第二个同路径路由。
- 为保留既有编辑器附件行为，`docId` 上传默认 dedupe；普通项目/文件夹上传默认 409，只有显式 `keep` 才保留两个。
- 原备份线程仅在配置备份时启动；现唯一维护线程始终启动以执行每日版本清理，备份仍只在配置有效时执行，语义不变。
- `createdBy/updatedBy` 是用户 id，版本展示名另用 `createdByName`；文档版本的既有对象形状未改。
- 物理清理不得在 DB 提交前执行，也不得只看当前 File：恢复会产生多个版本行共享同一路径，必须提交后重新查 File + FileVersion 全库引用。
- 探索审计：仅读指定 spec/根方案 §3/§5、原后端模块、后端测试与测试底座；未读或修改 `lite/web/**`、`lite/tools/**`、前端契约/编辑器测试。完整 pytest 的输出暴露了上述并行前端失败。`git status` 仅用于边界核对，未执行任何 git 写操作。
- 未决：完整快速组仍需 lead 在并行前端 worker 收尾后复跑；本后端授权范围无已知未决缺陷。未跑慢速弹性组（非本工单验收命令）。

## C. 关键指针
- ORM：`lite/server/models.py:131`（File）、`:149`（FileVersion）、`:164`（FileChange）；迁移：`lite/server/schema.py:30`。
- 上传三段式：`lite/server/services/files.py:270`、`:314`；版本登记/恢复：`lite/server/services/versions.py:45`、`:63`；轮询：`:70`。
- 20+90 与共享路径清理：`lite/server/services/versions.py:100`、`:110`；备份快照：`lite/server/services/backup.py:168`；每日维护：`:456`。
- 孤儿：`lite/server/services/audit.py:42`；文件夹/文件彻底删除：`lite/server/services/trash.py:80`、`:129`；空间删除：`lite/server/services/spaces.py:147`。
- HTTP：`lite/server/routers/files.py:75`、`:95`、`:120`、`:130`、`:140`、`:174`；恢复分发：`lite/server/services/trash.py:119`；序列化：`lite/server/serialize.py:181`、`:216`。
- 请求 ID：`lite/server/main.py:70`；权限唯一来源：`lite/server/security/context.py`；WS 共享保存：`lite/server/routers/ws.py`。
- 测试：`lite/tests/test_file_versions.py:20`（HTTP 全链路）、`:123`（备份/孤儿/物理删除）、`:192`（新版断连）；`lite/tests/test_file_version_services.py:44`（20+90）、`:69`（共享路径）、`:107`（迁移）。
- 稳定区：上述后端专项、工单验收组及 18 个后端快速测试文件已验证；前端留给对应 worker/lead 终验。
