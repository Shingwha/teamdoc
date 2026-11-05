# W4-a · 服务端新增契约
> 写入范围：`lite/server/**`、新增 `lite/tests/test_w4_contracts.py`、本 handoff。无分支/无 commit。

## 目标
补齐方案 v1.4 落地缺口所需的服务端契约；对外行为只增不改。轻分层与安全语义不变。

## 前置上下文
- 必读：overview → repo-map → `ref/interfaces.md` 的「W4 新增契约」→ W1-a handoff。
- 基线：`cd lite/server && uv run pytest ../tests/test_smoke_endpoints.py ../tests/test_file_versions.py ../tests/test_profile_sessions.py -q`（开工先跑并贴真实输出）。
- 稳定区：认证/会话/WS/上传三段式/版本清理；除本工单列出的点外不重写。
- 测试口径：只补本工单新增契约的行为测试，集中在一个新文件；不复制既有覆盖。

## 工单
### T1 通知数据模型与迁移
- `models.Notification`：`id/user_id/kind/title/body/link/created_at/read_at`，`ix_notifications_user_created(user_id, created_at)`；新表由 create_all 建立，无需改存量表。
- `FileVersion.note` 可空 String(200)；`schema._add_columns` 幂等补列（旧库）。
- 只允许改：`models.py`、`schema.py`。
- 验证：新库 create_all；旧库连续 `schema.init()` 两次 `check_drift == []`。

### T2 通知服务与 API
- 新增 `services/notifications.py`：`notify(db, user_id, kind, title, body=None, link=None)`、`list_for_user(db, user_id, limit)`、`mark_read(db, user_id, ids)`、`mark_all_read(db, user_id)`；不 import FastAPI。
- 新增 `routers/notifications.py` 并注册：
  - `GET /api/notifications?limit=20` → `{items:[{id,kind,title,body,link,createdAt,readAt}], unread}`
  - `POST /api/notifications/read` `{ids}` → `{ok,updated}`
  - `POST /api/notifications/read-all` → `{ok,updated}`
- 生产者（同一事务内写）：
  - `spaces.create_project` 邀请成员、`add_member` → `space_added`；`patch_member` 改角色 → `role_changed`；`transfer_project` → 新旧 owner 各一条 `owner_transferred`。
  - 标题用空间名与角色中文标签；`link='#/p/{pid}/home'`。不要通知操作者自己（转让除外）。
- 只允许改：`services/notifications.py`（新）、`services/spaces.py`、`routers/notifications.py`（新）、`main.py`。

### T3 PAT 审计（只读）
- `services/users.py` 增 `admin_list_pats(db, user_id=None, limit=100)`：join User，返回 `id/userId/userName/userEmail/name/scopes/createdAt/lastUsedAt/revokedAt`，按 `last_used_at` 倒序、空值靠后；不返回 token/hash。
- `routers/admin.py` 增 `GET /api/admin/pats?userId=&limit=100`，管理员依赖；`userId` 形状非法 400，不存在用户返回空列表。
- 只允许改：`services/users.py`、`routers/admin.py`。

### T4 版本备注与 409 上传者姓名
- `versions.append_version(..., note=None)`、`restore_version(..., note=None)`；`file_version_json` 增加 `note`。
- `POST /api/files/{id}/versions?name=&note=`：note 去空白、≤200，超长 400；`files.store_upload` 透传到登记。
- `POST /api/files/{id}/restore {version,note?}`：显式 note 优先，缺省 `恢复自 v{n}`；回收站恢复分支不受影响。
- 上传 409 `detail.existing` 增加 `updatedByName`（查不到时为空字符串）。
- 只允许改：`services/versions.py`、`services/files.py`、`serialize.py`、`routers/files.py`、`routers/trash.py`、`services/trash.py`。

### T5 成员加入时间与最后活跃
- `spaces._member_json` / `list_members` / `add_member` / `project_json` 的成员/所有者列表增加 `createdAt`（ProjectMember.created_at）与 `lastActiveAt`（该用户最近一次成功登录，复用 `users.login_status`，可空）。
- 保持现有 `userId/role/user` 骨架与排序不变。
- 只允许改：`services/spaces.py`、`serialize.py`（如需）。

### T6 测试（一个新文件）
`lite/tests/test_w4_contracts.py`，按行为分组，避免逐字段重复：
1. 通知：加成员/改角色/转让各产生一条且对象正确；本人列表与 unread；标记单条/全部；他人不能读改；limit 生效。
2. PAT：管理员可见字段完整且无 token/hash；非管理员 403；按 userId 过滤。
3. 版本备注：带 note 上传后列表可见；restore 默认“恢复自 vN”；超长 400。
4. 409 `updatedByName` 为真实姓名。
5. 成员列表含 `createdAt`/`lastActiveAt`（登录一次后非空）。

## 验收
1. `cd lite/server && uv run pytest ../tests/test_w4_contracts.py ../tests/test_smoke_endpoints.py ../tests/test_file_versions.py ../tests/test_profile_sessions.py ../tests/test_workspace_preferences.py -q` 全绿（贴用例数）。
2. 服务层正则 `^(from fastapi|import fastapi|from starlette|import starlette)` → 0 匹配。
3. 归档/回收站/版本既有语义不回归（上述组已覆盖）。

## 禁触
`lite/web/**`、`lite/tools/**`、既有测试文件、spec 其他文件、基线 Mermaid。无 git 写操作。

## 交接
写 `handoff/W4-a-backend.md`：精确接口/字段/错误码、迁移、真实测试结果、文件行号、未验项。最终报告按 spec-team 模板。
