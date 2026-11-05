# W4-a 服务端新增契约交接包
> 当前工作区直接修改 / 无分支、无 commit / 2026-11-06（UTC+8）

## A. 变更、接口与真实验证
- 基线（开工先跑）：`cd lite/server && uv run pytest ../tests/test_smoke_endpoints.py ../tests/test_file_versions.py ../tests/test_profile_sessions.py -q` → **11 passed in 13.75s**。
- T1 通知数据模型与迁移
  - `models.Notification(id,user_id,kind,title,body,link,created_at,read_at)`，索引 `ix_notifications_user_created(user_id,created_at)`；新表由 `create_all` 建立。
  - `FileVersion.note` 可空 `String(200)`；旧库由 `schema._add_columns` 幂等补列（`init()` 中调用 `_migrate_file_version_note`）。
  - 新库 create_all、旧库连续 `schema.init()` 两次均验证 `check_drift == []`（见测试 `test_notifications_table_and_version_note_migration_are_idempotent`）。
- T2 通知服务与 API（新文件 `services/notifications.py`、`routers/notifications.py`，`main.py` 注册）
  - `GET /api/notifications?limit=20` → `{items:[{id,kind,title,body,link,createdAt,readAt}], unread}`；按 `created_at` 倒序；`limit` 取值 1..100，越界 400；`unread` 为该用户全部未读数（不受 limit 截断）。
  - `POST /api/notifications/read {ids:[...]}` → `{ok,updated}`；只改本人未读，重复标记 `updated=0`；他人的 id 静默跳过（不泄露存在性）；`ids` 非数组/单项形状非法/超过 500 项 → 400。
  - `POST /api/notifications/read-all` → `{ok,updated}`，只改本人。
  - 生产者均与业务变更同一事务提交：
    - `create_project` 邀请成员、`add_member` → `space_added`；
    - `patch_member` 角色实际变化 → `role_changed`（同角色重复提交不产生通知）；
    - `transfer_project` → 新旧 owner 各一条 `owner_transferred`（新建库中操作者本人也收到，这是工单明确的例外）。
    - 其余场景不通知操作者自己；自助加入/退出不产生通知。
    - 标题用空间名与角色中文标签（所有者/管理员/编辑者/只读成员），`link='#/p/{pid}/home'`。
- T3 PAT 审计（只读）
  - `GET /api/admin/pats?userId=&limit=100` → `{items:[{id,userId,userName,userEmail,name,scopes,createdAt,lastUsedAt,revokedAt}]}`；管理员依赖。
  - 按 `last_used_at` 倒序、空值靠后；`userId` 形状非法 400，不存在用户返回空列表；不返回 token/token_hash。
- T4 版本备注与 409 上传者姓名
  - `POST /api/files/{id}/versions?name=&note=`：note 去首尾空白、≤200 字（超长 400），落 `FileVersion.note`；`GET /api/files/{id}/versions` 每项新增 `note`。
  - `POST /api/files/{id}/restore {version,note?}`：显式 note 优先，缺省/空白记 `恢复自 v{n}`；回收站恢复分支不受影响（不写备注）。
  - 上传 409 `detail.existing` 新增 `updatedByName`（按 `File.updated_by` 查用户展示名，查不到为空字符串），其余字段不变。
- T5 成员字段
  - `GET /api/projects/{id}/members` 与 `POST .../members` 返回项新增 `createdAt`（ProjectMember.created_at）与 `lastActiveAt`（复用 `users.login_status` 的最近一次成功登录，可空）；`userId/role/user` 骨架与加入时间排序不变。
- T6 测试（新文件 `lite/tests/test_w4_contracts.py`，7 个行为用例）
  - 通知生产/列表/unread/limit/标记/越权；PAT 字段完整性、无凭据、权限与过滤；版本备注上传/恢复/超长；409 上传者姓名；成员加入时间与最后活跃；新表与备注列迁移幂等。
- 真实验证
  - 新增测试单跑：`uv run pytest ../tests/test_w4_contracts.py -q` → **7 passed in 7.12s**。
  - 波末验收组：`uv run pytest ../tests/test_w4_contracts.py ../tests/test_smoke_endpoints.py ../tests/test_file_versions.py ../tests/test_profile_sessions.py ../tests/test_workspace_preferences.py -q` → **24 passed, 1 failed in 25.59s**。唯一失败是既有 `test_file_versions.py::test_duplicate_409_keep_and_version_of` 对 `detail.existing` 做全等断言，不含本工单新增的 `updatedByName`（见 B 节）；排除该用例后同一命令 **24 passed, 1 deselected in 22.48s**。
  - 相关后端回归：`test_files_paging + test_upload_security + test_admin_storage + test_file_version_services + test_join_drill + test_session_audit + test_directory + test_avatar_color + test_visibility + test_folder_recycle` → **43 passed, 1 skipped in 26.91s**。
  - 服务层 FastAPI 正则 `^(from fastapi|import fastapi|from starlette|import starlette)` → **0 匹配**。

## B. 偏差、坑与后续约束
- **既有测试断言需 W4-d 同步（当前唯一红项）**：`lite/tests/test_file_versions.py:74` 用全等字典断言 `detail.existing`。本工单按冻结契约新增 `updatedByName` 后该断言必然失败，需在该用例中补 `"updatedByName": <最后上传者姓名>`。该文件属 W4-d「版本与后台测试」范围，本 worker 未改；不能为迁就旧断言删字段。后续 lead 合并时以 W4-d 更新后的版本为准。
- `services/users.py` 的 `delete_user` 增加了 `Notification` 行清理：`notifications.user_id` 是 FK，不清理会在启用外键的 SQLite 上阻断删用户；该文件本就在 T3 允许范围内，属必要的完整性收口。
- T5 工单文字提到 `project_json` 的成员/所有者列表，但当前 `serialize.project_json` 不携带成员列表；管理项目总览的 `owners` 由 `services/audit.admin_projects` 用 `user_json(face="member")` 组装（audit.py 不在 T5 允许文件内）。因此本轮字段落在真实成员接口 `list_members` / `add_member` 返回上；admin owners 仍是用户对象，不含 `ProjectMember.created_at`。
- 恢复备注把“显式空白”也视为缺省，落 `恢复自 v{n}`；只有非空 note 才覆盖默认值。
- `note` 只在 `/api/files/{id}/versions` 透传；通用 `/api/files/upload?version_of=` 未新增 note 参数（冻结契约未要求）。
- 通知 `limit` 上限取 100（契约只给默认 20）；如前端需要更大分页需另立契约。
- 未执行任何 git 写操作；未触碰 `lite/web/**`、`lite/tools/**`、既有测试文件、spec 其他文件与基线 Mermaid；未进入或修改 `lite/server/.venv`。
- 探索审计：只读实现了工单指定 spec、`ref/interfaces.md`、W1-a handoff、后端服务/路由/序列化/迁移、pytest 底座与相关既有测试；为确认角色中文标签与前端调用路径，只读 grep 了 `web/js/ui.js`、`views/project.js`、`views/admin/users.js`、`endpoints.js`，未写入。`git status/diff` 仅用于边界核对。
- 未验项：通知/PAT 前端 UI（W4-c/W4-d 并行在飞）、全量快速组与浏览器抽验（lead 在四份交付后跑）、W4-d 对 `test_file_versions.py` 的同步。

## C. 关键指针
- ORM：`lite/server/models.py:52`（Notification）、`:168`/`:180`（FileVersion.note）。
- 迁移：`lite/server/schema.py:13`（init 调用）、`:95`（幂等补 note 列）。
- 通知服务：`lite/server/services/notifications.py:14`（notify）、`:31`（list_for_user）、`:57`（mark_read）、`:71`（mark_all_read）。
- 通知路由：`lite/server/routers/notifications.py:12`、`:18`、`:24`；注册：`lite/server/main.py:64`。
- 通知生产者：`lite/server/services/spaces.py:74`（格式化/去自我）、`:111`（成员创建+通知同事务）、`:164`（创建空间邀请）、`:242`（转让）、`:305`（list_members）、`:315`（add_member）、`:333`（patch_member）。
- PAT 审计：`lite/server/services/users.py:357`、`lite/server/routers/admin.py:62`；删用户清理通知 `lite/server/services/users.py:299`。
- 版本备注：`lite/server/services/versions.py:19`（normalize_note）、`:58`（append_version）、`:76`（restore_version 默认备注）；序列化 `lite/server/serialize.py:251`；上传透传 `lite/server/services/files.py:276`、`:348`；HTTP `lite/server/routers/files.py:120`；回收站恢复 `lite/server/services/trash.py:125`。
- 409 上传者姓名：`lite/server/services/files.py:140`（查展示名）、`:149`（extra.existing）。
- 测试：`lite/tests/test_w4_contracts.py:40`（通知生产者）、`:93`（limit/unread/越权）、`:135`（PAT）、`:170`（版本备注）、`:200`（409 上传者）、`:219`（成员字段）、`:244`（迁移幂等）。
- 冲突待改：`lite/tests/test_file_versions.py:74`（W4-d 范围）。
