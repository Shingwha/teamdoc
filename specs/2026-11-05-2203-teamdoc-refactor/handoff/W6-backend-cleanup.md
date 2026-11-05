# W6 后端整体重构清理交接包
> 分支 `wave/w6-backend-cleanup`；worktree `C:\Users\shifu\.worktrees\teamdoc\w6-backend-cleanup`；基线 `03da590`；2026-11-06（UTC+8）
> 范围：`lite/server/**`、后端测试、本 handoff。零行为变更：公开路径/字段/错误码/权限/归档/事务语义未改。

## A. 交付与真实验证

### A0. 基线（开工原样）
```
cd lite/server && uv run pytest ../tests -q
→ 1 failed, 181 passed, 1 skipped, 3 deselected in 116.67s
  唯一失败：test_markdown_diagram.py::test_markdown_extensions_in_browser（登记 Mermaid 主题重画基线）

uv run pytest ../tests -m slow -q
→ 3 passed, 183 deselected in 10.59s
```

### A1. 波末真实验证（全量 + slow）
```
cd lite/server && uv run pytest ../tests -q
→ 1 failed, 178 passed, 1 skipped, 3 deselected in 116.73s
  唯一失败仍为上述 Mermaid 基线；无新增失败。

uv run pytest ../tests -m slow -q
→ 3 passed, 180 deselected in 10.30s

公开契约合并组（smoke/files/versions/doc_conflict/visibility/profile_sessions/
session_audit/backup_restore/workspace_preferences/w4_contracts）
→ 62 passed in 45.79s
```
测试数量由 183 选中降至 180，全部来自 T5 的去重/合并（清单见 A5），未新增测试文件。

### A2. T1 路由薄化：前后对照
| 路由文件 | 基线行数 | 现在行数 | 下沉内容 |
|---|---:|---:|---|
| `routers/auth.py` | 129 | 100 | 初始化/登录/改密流程 → `services/auth.py` |
| `routers/admin.py` | 157 | 126 | 恢复包上传/备份归档 I/O → `services/backup.py` |
| `routers/ws.py` | 206 | 143 | 握手/保存/presence 载荷 → `services/docs.py` |

路由层已无 SQL 与文件写入：
```
grep -rnE "db\.query|\.commit\(\)|open\(|write_text|write_bytes|\.mkdir\(" routers/
→ 0 matches
```

新增/下沉入口：
- `services/auth.py:11/18/28/45`：`bootstrap_status`、`bootstrap`、`login`、`change_password`。路由只解析 `client_ip/client_ua`、签发 Cookie、序列化 `user_json`。
- `services/backup.py:646`：`receive_restore_upload(db, stream, declared_bytes)`，负责 armed 检查、Content-Length 上限、归还 DB、流式落盘、校验与暂存。
- `services/backup.py:225/236`：`build_download_archive`（锁内生成）、`stream_archive`（流式回吐并在结束/中断时清理暂存文件）。
- `services/docs.py:217/231/241/261`：`_ws_access`、`ws_handshake`、`ws_save`、`presence_users`；`WsRejected` 携带 4401/4403/4404。连接循环、协议帧解析、广播与 POOL 仍在 `routers/ws.py`。
- `security/sessions.py::verify_credentials` 由接收 `Request` 改为接收 `ip/ua`（服务层可调用，行为不变）；Cookie 写入移入 `deps.set_session_cookie`。

行为保护：`test_doc_conflict`（WS 冲突/缺基线）、`test_workspace_preferences::test_ws_content_write_rejected_when_archived`（4403）、`test_backup_restore`（5 项含恢复演练）、`test_auth_cookie`、`test_profile_sessions` 全绿。

### A3. T2 依赖方向证据
FastAPI 接触面收敛为 `main.py`、`routers/**`、`errors.py`、`deps.py`：
```
grep -rnE "^(from|import) (fastapi|starlette|pydantic)" --include=*.py \
  services db.py http_util.py security ids.py
→ 0 matches
```
服务层不导入路由/依赖层：
```
grep -rn "from deps\|import deps\|from routers\|import routers" services
→ 0 matches
```
静态传递闭包（解析每个服务模块的本地 import 链，只报告 fastapi/starlette/pydantic）：
```
services.audit/auth/backup/docs/files/notifications/search/spaces/trash/users/versions
  fastapi: services.<name> -> errors
services.refs / services.__init__
  无 FastAPI/starlette/pydantic 依赖
```
即：服务层唯一触达 FastAPI 的链路是 `errors.py`（`HTTPException` 契约错误的唯一出口）；无 starlette、无 pydantic 间接链路。`db.py`、`http_util.py`、`security/context.py`、`security/sessions.py`、`ids.py` 均为纯 Python/SQLAlchemy。

结构变化：
- 新增 `deps.py:29` `get_db`、`:45/49` `client_ip/client_ua`、`:53` `declared_bytes`、`:61` `set_session_cookie`、`:76` `IdPath`、`:81-149` 认证/权限依赖。
- `security/context.py:22` 新增纯业务 `Actor(user, via, scopes, session_token, pat_id, session_lifetime)`；`:32` `session_context` 只返回 Actor，不再依赖 FastAPI。
- `db.get_db`、`http_util.client_ip/client_ua`、`security.sessions.set_session_cookie`、`ids.IdPath` 均从原模块移除（无兼容 shim），路由统一从 `deps` 取。
- `ids.py` 不再 import pydantic；`test_id_contract` 改为 `deps.IdPath`（仅 Python 符号位置变化，HTTP 契约不变）。

### A4. T3 去重与死代码
合并：
1. `services/docs._user_name` → `services.users.user_names`（同一姓名映射）。`grep -rn "\b_user_name\b" server tests` → 0。
2. `services/files._name_exists` 的手查作者 → `user_names`。
3. `services/audit.revoke_session` 内联 `hashlib.sha256` → `serialize.session_ref`（会话 ref 唯一实现）。
4. `services/users.list_pats/create_pat` 的 `isoformat()` → `serialize.iso`（时间格式唯一入口）。
5. `services/files` 三处函数内 `from http_util import id_field, opt_id` → 顶部统一导入。
6. `routers/files._declared_bytes` 与 `routers/admin.restore_upload` 内联 Content-Length 解析 → `deps.declared_bytes`。
7. `services/files.move_folder/move_file` 直接 `FileChange(...)` → `versions.record_change(..., space_id=src_id)`；变更行构造只留 `services/versions.py:31`。`grep "FileChange(" services/files.py` → 0。
8. `services/backup._db_counts` 去掉 key/table 同名的冗余映射。

删除（均给出 0 引用证据）：
| 符号 | 位置 | 引用数（server+tests） |
|---|---|---:|
| `refs.doc_ref/file_ref/download_url` | `services/refs.py` | 0（唯一消费者是已删除的 `test_refs_generation_round_trips`） |
| `is_project_member` | `security/context.py` | 0 |
| `VERSION_KINDS` | `services/docs.py` | 0 |
| `env_bool` | `config.py` | 0 |
| `_declared_bytes` | `routers/files.py` | 0 |
| `_user_name` | `services/docs.py` | 0 |
| 未使用导入 | `admin.CONFLICT`、`audit.File`、`docs.CONFLICT`、`files.FILES_DIR`、`users` 的 `hashlib` 等 | AST 扫描 0 使用 |

### A5. T4 事务与一致性
写路径复核（数据与 `file_changes` 同事务）：
- 上传最终事务：`services/files.py:374-375` 同一次 commit 写 File + FileVersion + FileChange。
- 显式新版：`versions.append_version` 只 `flush`（`services/versions.py:59-73`），由 `files.store_upload`、`versions.restore_version:83` 提交。
- 文件夹/文件跨空间移动：源 `delete` 与目标 `upsert` 在同一次 commit（`files.py:199-208`、`:400-406`）。
- 删除/恢复/改名：`trash.py:30-31/47-54/101-102/114-115`、`files.py:462-463` 均为变更行与数据同 commit。
- 文档保存：`save_doc_content` 不提交（`services/docs.py:181`）；REST 在 `_save_content:211` 提交，WS 在 `ws_save:257` 提交，版本快照与正文同事务。
- 彻底删除：先提交 DB，再按全库引用清理物理文件（`spaces.py:300-301`、`trash.py:76/91/134`）。

保留的认证边界提交（不并入业务事务）：
- `security/sessions.py:54 create_session`、`:64 record_login_event`：会话与登录审计。
- `security/context.py:51` 会话滑动续期：会话过期语义。
- `deps.py:95` PAT `last_used_at`：凭据最近使用时间。
这些均为安全语义要求的独立提交，业务写路径不依赖它们的中间状态。

`file_changes.seq` 不改为 SQL `AUTOINCREMENT`：
- 现状是 SQLite `INTEGER PRIMARY KEY`（rowid 别名，`autoincrement=True` 只表示由 DB 分配）。
- 变更行只在空间彻底删除时整批清理（`spaces.delete_project`）；rowid 分配为“现有最大 +1”。即使删除过最大行，复用号也必大于本空间仍存在的最大 seq；客户端 `since` 只取本空间已见的最大 seq，因此 `seq > since` 的过滤仍单调。
- 改 AUTOINCREMENT 需要重建表；按工单“不强行迁移”，理由与风险边界写在 `models.py:185-190`。若未来开始删除单个空间的变更行或截断表，需重新评估。

### A6. T5 测试收敛
盘点范围：后端行为测试（smoke/files/versions/doc_conflict/visibility/session/backup/workspace/notifications/PAT/迁移/登录/日志/弹性等）全部保留；未新增测试文件，测试数 183 → 180。

删除/合并清单与覆盖来源：
1. **删除** `test_id_contract.py::test_refs_generation_round_trips`（随 `refs.doc_ref/file_ref/download_url` 一起删）。
   覆盖：`test_refs_recognizes_both_forms` 已用两种规范字面量验证解析；`test_refs_ignores_non_id_candidates` 验证非法候选；构建函数已无生产消费者。
2. **删除** `test_id_contract.py::test_numeric_shape_is_invalid_not_absent`。
   覆盖：`test_is_id_rejects_bad_shapes` 已断言 `999999` 非法、`"0"*26` 形状合法；HTTP 语义由 `test_auth_cookie.py::test_invalid_id_is_rejected_by_shape`（400）与 `test_smoke_endpoints.py`（非法 id 400 / `ABSENT_ID` 404）覆盖。
3. **合并** `test_directory.py::test_directory_readable_and_field_surface` + `test_plain_user_can_read_directory` → `test_directory_access_and_field_surface`（断言全部保留：管理员可读、字段恰为 `id/name/email/avatarColor`、普通用户可读、`/api/users` 403、未登录 401）。

保留的边界/行为覆盖（明确不删）：20/90 版本清理与 90 天精确边界、file_changes 轮询、WS 冲突与 4403 归档、恢复演练、PAT/通知、归档写矩阵、迁移幂等、`check_drift` 类型/缺列、登录节流重启后仍锁。

## B. 偏差、坑与后续约束
- **Actor 无“路由层转换”步骤**：工单允许“为 service 提供 FastAPI-free 的 Actor，路由层把 AuthContext 转成 Actor”。本实现直接把原 `AuthContext` 替换为 `security.context.Actor`（字段含 user/via/scopes 及 Web 会话所需 token 字段），由 `deps` 产出，不再保留第二个上下文类型；语义与字段完全一致。若后续要求严格只暴露 user/via/scopes，可在服务边界再收窄，当前会话/PAT 端点需要 token 字段。
- `IdPath` 从 `ids.py` 移到 `deps.py`：`test_id_contract` 内部导入随之调整；接口路径校验行为与错误码不变。
- `security.sessions.verify_credentials` 签名由 `(request, db, ...)` 改为 `(db, ..., ip=, ua=)`；调用点只有 `services/auth.py`（登录/改密）。
- `services/backup.py` 现在 import `services.files` 的流式助手（`save_request_body/chunked_file/...`）与 `db.release_db`；章节职责仍是备份/恢复，未形成循环。
- `routers/admin.py` 仍 import `routers.ws.POOL` 供诊断快照使用；POOL 是连接注册表（传输态），没有下沉到 service。
- 未改任何公开路径、字段、错误码、权限/归档/事务语义；未触碰 `lite/web/**`、`lite/tools/**`、spec 其他文件与 Mermaid 基线。
- 范围核对：`git diff --name-only 03da590..HEAD` 仅含 `lite/server/**`、`lite/tests/**` 与本 handoff。相对 `55e846d` 还会看到 `00-overview.md`/`08-W6-backend-cleanup.md` 的差异——它们来自基线提交 `03da590`（lead 的 W6 工单/看板更新），不是本 worker 改动。
- 未 merge/push/tag/checkout 主分支；未进入或修改 `.venv`。

## C. 关键指针
- 依赖适配层：`lite/server/deps.py:29`（get_db）、`:53`（declared_bytes）、`:76`（IdPath）、`:81`（authenticate）、`:120/129`（权限依赖）。
- 纯业务上下文：`lite/server/security/context.py:22`（Actor）、`:32`（session_context）、`:102`（ensure_project_role）。
- 登录/初始化：`lite/server/services/auth.py:11/18/28/45`；路由 `lite/server/routers/auth.py:16/21/30/39/47/55/62`。
- 恢复包/备份下载：`lite/server/services/backup.py:646/225/236`；路由 `lite/server/routers/admin.py:83/109`。
- WS 业务：`lite/server/services/docs.py:217/231/241/261`；路由 `lite/server/routers/ws.py:56`（连接循环）。
- 版本变更行：`lite/server/services/versions.py:31`（record_change 唯一构造点）、`:59`（append_version）。
- seq 不变式说明：`lite/server/models.py:185-190`。
- 去重后的姓名/时间入口：`lite/server/services/users.py:26`（user_names）、`lite/server/serialize.py:22`（iso）、`lite/server/serialize.py:69`（session_ref）。
- 测试：`lite/tests/test_directory.py:19`（合并后）、`lite/tests/test_id_contract.py:63`（IdPath 改为 deps）。

## D. 未决
- `test_markdown_diagram::test_markdown_extensions_in_browser` 的 Mermaid 切主题 SVG id 失败仍为登记基线，不属本波范围。
- 浏览器核心路径未另行手工抽验：全量快速组已包含 visual sweep / join drill / doc move drill，且本次未改前端；波末验收按工单命令执行。
- `file_changes.seq` 维持现有 rowid 语义；若产品未来要求跨删除的全局不可复用游标，应单独立项重建表并迁移。
