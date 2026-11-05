# W10-b 空间配额硬限制交接包
> 分支 `wave/w10-quota`；worktree `C:\Users\shifu\.worktrees\teamdoc\w10-quota`；基线 `175a83a`；2026-11-06（UTC+8）
> 写入范围：`lite/server/{errors.py,serialize.py}`、`lite/server/services/{quota.py(新),files.py,spaces.py,audit.py}`、`lite/web/js/views/project.js`、`views/admin/{projects,storage}.js`、新增 `lite/tests/test_quota_limits.py`、本 handoff。

## A. 用量口径、错误码与接入点

### A1. 用量口径（去重物理占用）
`quotaUsedBytes` = 该空间全部 `File.storage_path`（含回收站，即 `deleted_at` 非空）
与全部 `FileVersion.storage_path` 按 **storage_path 去重** 后的大小之和。
去重是必须的，原因有两条：
- `File.storage_path` 恒等于其某个版本的路径，两张表天然重复；不去重会把每个文件当前版算两遍。
- 恢复历史版本不复制物理文件，多个 `FileVersion` 行共享同一路径；去重后只算一次。

实现：`services/quota.py:33 usage_map` 用 `File ∪ FileVersion` 的 `union_all` 子查询
按 `(project_id, storage_path)` 分组取 `MAX(size)`（同路径 size 应一致，取 max 是保守兜底）。
版本行通过 `FileVersion JOIN File ON File.id = FileVersion.file_id` 归属到文件**当前**
所在空间，因此跨空间移动时历史版本字节随文件一起迁移。`deleted_at` 不参与过滤。

### A2. 错误码
`errors.py:37 QUOTA_EXCEEDED = "QUOTA_EXCEEDED"`（HTTP 403）。
`detail = {code, message, quotaBytes, usedBytes, requiredBytes}`；`requiredBytes = usedBytes + 本次新增字节`。
message 含空间名与可读大小（`quota.py:23 _fmt_bytes`），前端直接 toast 服务端文案，不新增分支。

### A3. 服务入口（`services/quota.py`，只 import models/errors，无环）
- `usage_map(db, project_ids) -> {pid: bytes}`：批量；无 id 返回 `{}`。
- `used_bytes(db, pid)`：单空间。
- `file_bytes(db, file_ids)`：一批文件（当前 + 全部历史版本）的去重物理占用，供移动计量。
- `ensure_quota(db, project, additional_bytes)`：个人空间、`quota_bytes` 为空/0 直接放行；
  否则 `used + additional > quota` 抛 403。

### A4. 写路径接入（`services/files.py`）
| 路径 | 位置 | 计量 |
|---|---|---|
| 新上传（含 docId 附件、`name_mode=keep`） | `files.py:375`（撞名判定之后、建 File 之前） | 本次 `total` |
| 显式新版本（`version_of` 与 `POST /files/{id}/versions` 共用 `store_upload`） | `files.py:350` | 本次 `total`（旧版物理文件保留） |
| 跨空间移动文件 | `files.py:410`（权限/父级校验后、写库前） | `file_bytes([f.id])` |
| 跨空间移动文件夹 | `files.py:199`（子树 ids 收集后、任何 update 之前） | 子树全部文件（含回收站文件）的去重字节 |

落盘后校验失败的临时物理文件由 `store_upload` 现有 `except` 路径 `unlink_quiet` + `rollback` 清掉；
移动失败时尚未改动任何记录（源/目标列表与用量均不变，测试已断言）。

放行路径（按契约未加检查）：读取/下载/分享、软删、彻底删除、清空回收站、恢复历史版本、
同空间移动、`quotaBytes` 空/0、个人空间。全局磁盘 `_check_reserve`/`STORAGE_RESERVE_MB` 未改动。

### A5. 展示字段
- `spaces.py:45` 在 `batch_stats` 中调用 `usage_map`，`spaces.py:54` 输出 `quotaUsedBytes`；
  `storageBytes` 语义保持"活跃文件"（`deleted_at is null`）。
- `serialize.project_json` member 与 admin 两种 face 均输出 `quotaUsedBytes`（`serialize.py:156`、`:169`）。
- `audit._near_quota`（`audit.py:119`）改用 `quotaUsedBytes` 计 ratio，输出新增 `usedBytes`，
  保留 `storageBytes`（活跃口径）兼容；nearQuota 排序与阈值不变。
- 前端：空间设置配额条 `views/project.js:326` 用 `quotaUsedBytes` 回退 `storageBytes`，
  卡片备注（`:345`）注明含历史版本与回收站；后台空间列表 `views/admin/projects.js:27`、
  存储区近配额卡 `views/admin/storage.js:100` 优先 `usedBytes`，配额策略文案（`:94`、`:118`）
  改为"80% 预警、达上限拦截"。

## B. 真实测试结果（原样）
- 开工基线：`cd lite/server && uv run pytest ../tests -q`
  → **172 passed, 1 skipped, 3 deselected, 19 warnings in 113.24s (0:01:53)**。
- 新增单跑：`uv run pytest ../tests/test_quota_limits.py -q` → **4 passed in 3.61s**。
- 工单验收组（波末重跑）：
  `uv run pytest ../tests/test_quota_limits.py ../tests/test_file_versions.py ../tests/test_file_version_services.py ../tests/test_w4_contracts.py ../tests/test_workspace_preferences.py ../tests/test_smoke_endpoints.py -q`
  → **33 passed, 19 warnings in 23.02s**。
- 移动/文件/存储回归：
  `uv run pytest ../tests/test_folder_recycle.py ../tests/test_files_paging.py ../tests/test_upload_security.py ../tests/test_admin_storage.py -q`
  → **12 passed, 1 skipped in 9.22s**。
- 前端桩与配额：`test_admin_sections + test_drive_versions + test_quota_limits` → **6 passed in 5.89s**。
- 全量快速组：`uv run pytest ../tests -q` → **176 passed, 1 skipped, 3 deselected, 19 warnings in 113.45s**（基线 172 + 新增 4，0 失败）。
- 服务层 FastAPI 正则 `^(from fastapi|import fastapi|from starlette|import starlette)` → **0 匹配**。
- `node --check`：`views/project.js`、`views/admin/projects.js`、`views/admin/storage.js` → **3 个均 OK**。

新测试 `lite/tests/test_quota_limits.py`（4 个用例）：
1. `:48` 配额 10B：6B 成功 → 再传 6B 403 且 detail 完整 → 软删仍占 6B 继续拦截 → 彻底删除后归零并可再传。
2. `:75` 版本计量：6B + 6B 超限 403；6B + 4B = 10 成功；`version_of` 再 +1B 403；
   恢复 v1（共享路径）200 且 `quotaUsedBytes` 仍为 10。
3. `:101` 跨空间移动：目标 10B 已用 6B；移入 6B 文件 403 且源/目标未变；
   含 5B 文件的文件夹移入 403，文件夹仍留源空间。
4. `:132` `quotaUsedBytes` 口径：当前 6 + 历史 4 = 10；恢复共享路径不翻倍；回收站仍计 10
   而 `storageBytes` 归 0；管理面 `/api/admin/projects` 同字段；不限额空间与个人空间（临时配额 1B）
   上传 64B 均放行，测试末尾还原个人空间配额。

## C. 偏差、取舍与后续约束
- 工单只列了 `usage_map/used_bytes/ensure_quota`；实际额外导出 `file_bytes`（跨空间移动按文件/子树
  去重计量必须用它）与私有 `_fmt_bytes`（错误文案）。均在 `services/quota.py` 内，未扩到其他模块。
- `create_project` 的局部变量 `quota` 改名 `quota_bytes`，避免与 `from services import quota` 同名遮蔽。
- `nearQuota` 的 `storageBytes` 保留为活跃文件口径（既有 `test_workspace_preferences` 断言 90B 不变），
  新增 `usedBytes` 才是配额口径；前端一律优先 `usedBytes`。
- 配额检查是请求级"读后写"：两个并发上传可能在各自事务里都通过检查，最终一起略超配额。
  SQLite 单写者保证提交串行，但不做配额行锁。工单未要求严格原子性；如需硬并发保证应另立契约。
- 恢复历史版本按契约不检查配额：管理员下调配额后即使已超限，恢复仍放行（不新增物理字节）。
- 上传撞名 409 优先于配额 403（撞名先判定）；被拒上传不落记录、不留物理文件（由现有失败清理保证）。
- 未改 `search/palette`、归档守卫、其他视图与其他 worker 文件；未 merge/push/tag；未 checkout 主检出。

## D. 关键指针
- 服务：`lite/server/services/quota.py:33/61/65/81`；错误码 `lite/server/errors.py:37`。
- 接入：`lite/server/services/files.py:20`（import）、`:199`（文件夹移动）、`:350`（新版本）、
  `:375`（新上传）、`:410`（文件移动）。
- 字段：`lite/server/services/spaces.py:45/54`、`lite/server/serialize.py:156/169`、
  `lite/server/services/audit.py:119-124`。
- 前端：`lite/web/js/views/project.js:326/345`、`views/admin/projects.js:27`、
  `views/admin/storage.js:94/100/118`。
- 测试：`lite/tests/test_quota_limits.py:48/75/101/132`。

## E. 未验项
- 配额 403 的真实浏览器抽验（上传 toast 用服务端 message，前端无新增分支）；后台空间列表/存储区
  配额列只在桩数据测试与 `node --check` 下验证，未做真实点击。
- slow 组（`-m slow`）未跑，按协议留给 lead。
- 未对生产数据的跨版本共享路径做超大规模计时；`usage_map` 为一次 union 聚合查询，属请求级开销。
