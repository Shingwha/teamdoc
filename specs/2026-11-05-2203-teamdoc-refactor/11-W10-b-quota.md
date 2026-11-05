# W10-b · 空间配额硬限制
> 分支 `wave/w10-quota`；worktree `C:\Users\shifu\.worktrees\teamdoc\w10-quota`；基线 `refactor/teamdoc-v1.4`。写入范围：`lite/server/{errors.py,serialize.py}`、`lite/server/services/{quota.py(新),files.py,spaces.py,audit.py}`、`lite/web/js/views/project.js`、`views/admin/{projects,storage}.js`、新增 `lite/tests/test_quota_limits.py`、本 handoff。

## 目标
按物理占用实施每空间硬配额：80% 预警（已有展示），100% 阻止新增字节的写路径；读取/下载/删除/清空回收站/恢复历史版本允许。全局磁盘余量保护沿用现有 `_check_reserve`，不改其错误语义。

## 契约
- 用量 `quotaUsedBytes` = 该空间全部 File（含回收站）与全部 FileVersion 引用的**去重物理路径**大小之和；按 `storage_path` 去重（恢复产生的共享路径只算一次）。
- Project 成员/管理响应增加 `quotaUsedBytes`；`storageBytes` 语义保持不变（活跃文件）。
- 新错误码 `QUOTA_EXCEEDED`（403）：
  `detail = {code, message, quotaBytes, usedBytes, requiredBytes}`。
- 拦截：新上传、显式新版本（`version_of`/`/versions`）、跨空间文件移动、跨空间文件夹移动（按子树去重字节）。
- 放行：读取/下载、软删/彻底删除/清空回收站、恢复历史版本（复用物理路径，不新增字节）、同空间移动、`quotaBytes` 为空/0 的空间（不限额）、个人空间（不限额；全局磁盘保护仍在）。
- 管理员通过现有 `PATCH /api/projects/{id}` 调整配额，无附加绕过。

## 工单
### T1 用量与守卫
- 新增 `services/quota.py`：`usage_map(db, project_ids) -> {pid: bytes}`、`used_bytes(db, pid)`、`ensure_quota(db, project, additional_bytes)`；不 import files/spaces（避免环）。
- 查询：File(project_id, storage_path, size) 与 FileVersion join File；按 `(pid, storage_path)` 去重取 size（冲突取 max）；包含 `deleted_at` 非空的文件（回收站计入）。
- `spaces.batch_stats` 增加 `quotaUsedBytes`；`serialize.project_json` 两种 face 输出。
- `audit._near_quota` 用 `quotaUsedBytes` 计算 ratio（输出增加 `usedBytes`，保留 `storageBytes` 兼容）。
- 只允许改：`services/quota.py`（新）、`services/spaces.py`、`services/audit.py`、`serialize.py`、`errors.py`。

### T2 写路径接入
- `files.store_upload`：落盘后、登记前，对目标 project 调 `ensure_quota(..., total)`；版本上传用目标文件 project；失败由现有 `except` 删除临时物理文件。
- `files.move_file` / `move_folder`：目标空间不同时，按被移动文件的去重物理字节检查目标配额；失败在改动前抛出。
- 恢复版本不加配额检查（不新增字节）。
- 只允许改：`services/files.py`（必要时 `services/trash.py` 仅读）。

### T3 前端展示
- 空间设置概览配额条用 `quotaUsedBytes`（回退 `storageBytes`），文案注明“含历史版本与回收站”。
- 后台空间列表配额列用 `quotaUsedBytes`；存储区近配额卡用 `nearQuota[].usedBytes` 回退 `storageBytes`。
- 上传 403 时沿用现有错误 toast，文案由服务端 message 提供；不新增前端分支。
- 只允许改：`views/project.js`、`views/admin/projects.js`、`views/admin/storage.js`。

### T4 测试
- 新增 `tests/test_quota_limits.py`，4 个行为用例：
  1. 配额 10B：上传 6B 成功，再传 6B → 403 `QUOTA_EXCEEDED` 且 detail 完整；删入回收站后仍占用；彻底删除后可再传。
  2. 版本占用：6B + 新版本 6B 超限 → 403；恢复历史版本仍 200。
  3. 跨空间移动：目标配额不足 → 403，源/目标均未变。
  4. `quotaUsedBytes` 反映当前 + 历史 + 回收站；不限额空间不受影响。
- 只允许改：新增测试文件。

## 验收
- `uv run pytest ../tests/test_quota_limits.py ../tests/test_file_versions.py ../tests/test_file_version_services.py ../tests/test_w4_contracts.py ../tests/test_workspace_preferences.py ../tests/test_smoke_endpoints.py -q` 全绿。
- 服务层无 FastAPI import；`node --check` 改动的三个 JS。
- 现有全局磁盘 reserve 行为不变（`STORAGE_RESERVE_MB`）。

## 禁触
search/palette、归档守卫、其他视图、其他 worker 文件、spec 其他文件。不 merge/push/tag。

## 交接
写 `handoff/W10-b-quota.md`：用量口径与去重、接入点、错误码、真实测试结果、行号、未验项。最终报告按模板。
