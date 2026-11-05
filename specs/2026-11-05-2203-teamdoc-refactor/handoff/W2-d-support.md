# W2-d 服务端交接包
> 当前工作区直接修改 / 无分支、无 commit / 2026-11-05 23:46（UTC+8）
> 范围：`lite/server/**`、新增 `lite/tests/test_profile_sessions.py`、`lite/tests/test_workspace_preferences.py`、本 handoff。

## A. 交付接口与错误码

### A1. 用户资料与头像色
- `User` 新增可空列 `avatar_color VARCHAR(7)`（`models.py:25`）。未设置时仍由 `id` 哈希派生；
  `serialize.avatar_color_for()`（`serialize.py:39`）是唯一取色入口，REST 五个用户面孔与 WS presence 已统一。
- `PATCH /api/users/me`（`routers/auth.py:76`，服务 `services/users.py:218`）
  - body 只接受 `{name?, email?, avatarColor?}`；出现其它字段 → 400 `VALIDATION`（含 `isAdmin` 提权尝试）。
  - `name` 去空白且非空；`email` 复用 `check_email` 与唯一性，冲突 409 `CONFLICT`。
  - `avatarColor` 为 `#RRGGBB`，`null`/空串清除并回落派生色；非法值 400。
  - 返回 `{"user": user_json(self)}`。
- 管理 `PATCH /api/users/{id}`（`services/users.py:175`）同步支持 `avatarColor`，语义一致。
- 静态路由 `/api/users/me` 在 `auth.router` 中注册，且 `main.py` 先 include `auth.router`，不会被
  `/api/users/{user_id}` 吞掉。

### A2. 本人登录会话
- `GET /api/auth/sessions`（`routers/auth.py:98`）→ 当前用户未过期会话列表，字段恰为
  `{ref, ip, device, deviceKind, createdAt, lastSeenAt, expiresAt, online, current}`。
  `ref = sha256(token)`（`serialize.session_ref`，`serialize.py:69`），原始 token 不下发。
- `DELETE /api/auth/sessions/{ref}`（`routers/auth.py:103`）：
  - 只查 `ctx.user` 的会话；别人的 ref → 404。
  - 命中当前会话 → 409 `CONFLICT`（提示走 logout），会话保留。
  - 成功 → `{"ok": true, "revoked": 1}`；已失效 ref → 404。
- `DELETE /api/auth/sessions`（`routers/auth.py:109`）：删除除当前会话外的全部本人会话，
  返回 `{"ok": true, "revoked": n}`。
- 三个端点均要求 `ctx.via == "web"`；PAT 调用 → 403 `FORBIDDEN`（只读 PAT 在写守卫先得到
  `READ_ONLY_TOKEN`，同样 403）。管理端原有 `/api/admin/sessions*` 不动。

### A3. 空间偏好、创建邀请与转让
- `Project` 新增列（`models.py:83-85`）：`color VARCHAR(7)?`、`quota_bytes INTEGER?`、`archived_at DATETIME?`。
- 成员与管理两种响应均新增 `color/quotaBytes/archivedAt/storageBytes`（`serialize.py:137-167`）；
  管理面保留 `owners`。
- `PATCH /api/projects/{id}` 接受：
  - `color`: `#RRGGBB` 或 null/空串清除；非法 400。
  - `quotaBytes`: 非负整数；null/空串/0 表示不限额（0 归一为 null）；负数 400。
  - `archived`: 布尔；个人空间归档 → 403 `FORBIDDEN`。
- `POST /api/projects`（`services/spaces.py:136`）接受可选
  `members:[{userId, role}]`：role 缺省 VIEWER、值域 OWNER/ADMIN/EDITOR/VIEWER；
  userId 必须存在且未禁用；重复 400；创建者固定 OWNER（邀请列表里重复出现时静默跳过）。
  任一校验失败整笔不落库（同一事务）。
- `POST /api/projects/{id}/transfer`（`routers/projects.py:51`，服务 `services/spaces.py:213`）
  body `{userId}`：仅实际 OWNER 成员可发起；目标须存在、未禁用、已是本空间成员且不是 OWNER；
  自己/非成员/已是 OWNER 分别 400/409/409，不存在用户 404。
  成功时目标升 OWNER、原 OWNER 降 ADMIN，单事务提交，返回最新项目 JSON（发起者视角 myRole=ADMIN）。
- `GET /api/projects`（`routers/projects.py:26`）默认隐藏归档；新增可选 `archived=1` 只列归档；
  管理员 `all=1` 的管理口径包含归档（带 `archivedAt`）。
- `GET /api/discover/projects` 排除归档空间；`GET /api/admin/projects` 不排除并带 `archivedAt`。

### A4. 归档规则（服务端强制，非前端隐藏）
- 直达读全部可用：项目详情、文档树/正文/版本、文件列表/元数据/下载、回收站、成员列表、搜索；
  WS 握手/presence 也可用。**搜索不做归档过滤**（只有空间列表与广场隐藏归档）。
- 写路径统一 403 `SPACE_ARCHIVED`（`errors.py:34`，`security/context.py:130`）：
  - 文档：建/改标题/移动/写正文/追加/恢复版本/删除/回收站恢复/彻底删除。
  - 文件：上传新文件/新版/恢复版本、改名/移动/分享/取消分享/删除/回收站恢复/彻底删除/打包是读不受限。
  - 文件夹：新建/改名/移动/删除/回收站恢复/彻底删除。
  - 成员：添加/改角色/移除、自助加入/退出。
  - 空间设置：除 `{"archived": false}` 解除归档外，任何 PATCH 都 403（含改名/颜色/配额/公开设置）。
  - WS `content` 写：写库前检测归档，直接以 **4403** 关闭连接（不回 saved），正文不变。
- 权限判定先于归档判定：非成员仍得到 403 `FORBIDDEN`/`JOIN_REQUIRED`，不会泄露“已归档”。
- 解除归档：`PATCH /api/projects/{id}` `{"archived": false}` 立即恢复写入与列表/广场可见。
- 实现位置：`ensure_project_role(..., write=True)` + `require_project_role(..., write=True)` /
  `require_role(..., write=True)`（`security/context.py:137/178/194`）；路由写依赖见
  `routers/docs.py:15,26`、`routers/files.py:20,21`、`routers/trash.py:12-20`、`routers/projects.py:53-80`；
  上传另在服务层 `services/files.py:164,281,290,296,338,348` 前后各查一次；WS 在
  `routers/ws.py:112`。

### A5. 搜索过滤
- `GET /api/search` 新增可选 `projectId`、`updatedBy`（`routers/search.py:14`，服务 `services/search.py:37`）。
- `projectId` 严格：不在当前用户可见集合 → 直接返回 `{"docs":[],"files":[]}`，不泄露空间存在性；
  合法且可见时只查该空间。`updatedBy` 精确匹配文档/文件的 `updated_by`，可与 `projectId`、
  q 为空（最近动态）组合。非法 id 形状仍 400。
- doc 搜索结果行新增 `updatedBy`、`updatedByName`（`services/search.py:24`）；文件行沿用
  `file_json` 已有 `updatedBy`。

### A6. 管理总览
- `GET /api/admin/overview`（`routers/admin.py:27`，服务 `services/audit.py:127`）返回：
  ```
  {userCount, spaceCount, todayLoginCount, lockedCount,
   storage: <原 /api/admin/storage 完整结构>,
   nearQuota: [{id,name,quotaBytes,storageBytes,ratio}],
   backup: <原 /api/admin/backup/status 完整结构>}
  ```
  - `userCount` 全用户；`spaceCount` 非个人空间数；`todayLoginCount` 当日 `result=ok` 登录事件数；
    `lockedCount` 当前仍在冷却的**账号维度**节流键数（`account:*`，不含来源 IP 桶）；
    `nearQuota` 为非个人、配额>0 且用量/配额 >= 0.8，按 ratio 降序。
  - 长 I/O 不持锁：`storage_overview` 先完成全部 SQL、取到引用名集合后 `release_db(db)`，
    再扫描磁盘/孤儿/计算目录大小；之后才读 `backup.status()` 的状态文件。`scan_orphans(db)`
    对外行为不变（`services/audit.py:44/68/81`）。

## B. 迁移
- `schema.init` 顺序：`create_all` → `_migrate_file_versions` → **`_migrate_preferences`** → 漂移校验
  （`schema.py:8-12`）。
- `_add_columns`（`schema.py:73`）只对已存在表补缺失列；`_migrate_preferences`（`schema.py:83`）：
  `users.avatar_color VARCHAR(7)`；`projects.color VARCHAR(7)`、`projects.quota_bytes INTEGER`、
  `projects.archived_at DATETIME`。不重写存量数据、重复执行无副作用；新库由 `create_all` 直接建成。
- 单测 `test_preference_columns_migration_is_idempotent` 连跑两次 `schema.init` 并断言
  `check_drift == []` 与旧值不丢。

## C. 真实测试结果
- 开工基线（原样）：
  `cd lite/server && uv run pytest ../tests/test_smoke_endpoints.py ../tests/test_files_paging.py ../tests/test_doc_conflict.py -q`
  → **16 passed in 15.67s**。
- 工单验收组（原样）：
  `uv run pytest ../tests/test_workspace_preferences.py ../tests/test_profile_sessions.py ../tests/test_smoke_endpoints.py ../tests/test_files_paging.py ../tests/test_doc_conflict.py ../tests/test_visibility.py ../tests/test_session_audit.py -q`
  → **42 passed in 74.19s**（最终一次；同命令此前 38.11s / 37.98s，耗时受并行前端与机器负载影响）。
- 新测试单跑：`test_profile_sessions.py` → **2 passed**；`test_workspace_preferences.py` → **7 passed**。
- 拖网回归（后端相关既有文件）：
  `test_backup_restore/admin_storage/file_versions/file_version_services/folder_recycle/doc_move/
  doc_move_drill/upload_security/join_drill/auth_cookie/directory/avatar_color/id_contract`
  → **51 passed, 1 skipped, 2 failed**。两项失败均为 `test_join_drill.py` 的无头浏览器
  “加入后 hash 应落到 `/p/{pid}/docs`，实际 `/home`”，属于并行前端路由改动，后端 join 返回 200
  且本域测试覆盖同一接口；未介入前端范围。
- 服务层正则：
  `grep -rEn "^(from fastapi|import fastapi|from starlette|import starlette)" services/`
  → **0 匹配**。

## D. 取舍与偏差（显式记录）
- **配额只展示不拦截上传**：工单只要求 `quotaBytes` 字段、`storageBytes` 与 nearQuota 总览；
  未新增未定义的超配额错误码。若产品要硬限制，应另立契约（错误码/按版本占用计算）。
- `quotaBytes = 0` 归一为不限额（便于前端“清空”），负数额拒绝。
- 归档空间仍可被**删除空间**（危险区管理动作，未在“内容/成员写路径”清单内）；
  归档空间的设置修改只允许解除归档那一次 PATCH。
- 个人空间不可归档（与不可公开/不可删除一致）。
- 转让要求发起者是实际 OWNER 成员；全局管理员若不在成员表内需先授自己 OWNER，再转让。
- 归档对整个空间是只读态，**空间级 PATCH 在未解除归档前也 403**；解除归档是唯一例外。
- 搜索仍会返回可见归档空间的内容（只有空间列表/广场隐藏）；若后续要“归档不进搜索”，
  在 `services/search.visible_project_ids` 后加过滤即可。
- `GET /api/projects?archived=1` 是新增的附加查询参数（interfaces 未列，前端可选用）。

## E. 关键指针
- ORM：`lite/server/models.py:25`、`:83-85`；迁移：`lite/server/schema.py:73/83`。
- 错误码：`lite/server/errors.py:34`；归档守卫：`lite/server/security/context.py:125/130/137/158/178/194`。
- 资料/会话：`lite/server/services/users.py:175/218/246/257/274`；路由：`lite/server/routers/auth.py:76/98/103/109`。
- 空间：`lite/server/services/spaces.py:106/136/155/175/213/318/327`；路由：`lite/server/routers/projects.py:26/51`。
- 上传写守卫：`lite/server/services/files.py:164/281/290/296/338/348`。
- WS：`lite/server/routers/ws.py:97/112`。
- 搜索：`lite/server/services/search.py:24/37`；路由：`lite/server/routers/search.py:14`。
- 总览：`lite/server/services/audit.py:44/68/81/108/127`；路由：`lite/server/routers/admin.py:27`。
- 序列化：`lite/server/serialize.py:39/69/74/137-167`。
- 测试：`lite/tests/test_profile_sessions.py:18/63`；
  `lite/tests/test_workspace_preferences.py:44/158/187/222/255/307/336`。

## F. 未验项
- 全量快速组与 slow 组留给 lead；浏览器端设置/空间抽屉/管理总览对新字段的实际渲染未抽验。
- 只在合成旧库上验证了幂等迁移，未对真实生产数据目录做演练。
- 配额硬限制、归档空间搜索排除均为未实现的产品决策（见 D）。
