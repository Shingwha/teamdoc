# W4-d · 云空间、管理后台与空间设置补齐
> 写入范围：`lite/web/js/views/drive.js`、`web/css/drive.css`、`views/admin/{security,users,storage,projects}.js`、`css/admin.css`、`views/project.js`、`tests/test_drive_versions.py`、`tests/test_admin_sections.py`、本 handoff。无分支/无 commit。

## 目标
按方案 §6.5/§6.7/§6.9 补齐版本体验、后台审计与空间设置细节；既有能力不回归。

## 前置上下文
- 必读：overview → repo-map → interfaces（W4 契约）→ W2-b/W2-c handoff → 本工单。
- 基线：`cd lite/server && uv run pytest ../tests/test_file_versions.py ../tests/test_admin_sections.py ../tests/test_smoke_endpoints.py -q`。
- 依赖：W4-a 的 `note`/`createdAt`/`lastActiveAt`/`updatedByName` 与 `GET /api/admin/pats` 按 interfaces 已冻结；W4-c 的 `Endpoints.adminPats()` 与 `fileVersionUpload(id,name,note)` 按契约调用，若运行时尚未落地则按契约编码并在 handoff 标注。
- 测试口径：只扩展现有两个测试文件的对应用例；不新建测试文件。

## 工单
### T1 云空间
- 网格瓦片 hover 出操作条：上传新版本、版本历史、更多（沿用行操作/右键菜单同源处理函数）；触控设备点击也可见。
- 工具条增加排序控件（名称/时间/大小 + 升降序），网格与列表都可用；表头排序保持。
- 显式上传新版本：选文件后弹可选备注输入（≤200），随 `note` 提交；时间线展示备注（无则留空）。
- 同名冲突弹窗展示 `existing.updatedByName`（有则“由 X 上传”，无则省略）。
- 窄屏（`UI.NARROW`）强制列表视图，监听 MQL 变化；离开时清理监听。
- 只允许改：`views/drive.js`、`css/drive.css`。

### T2 管理后台
- 安全区新增「PAT 审计」卡：`Endpoints.adminPats()`，表列 用户/名称/权限/创建/最近使用/状态；搜索用户；空/加载/错误态统一。
- 存储区新增「配额策略」卡：说明按空间 `quotaBytes`、80% 预警；列出近配额空间（`adminOverview().nearQuota`），点击可打开该空间成员抽屉（本域已有）。
- 用户区：读路由 `?q=` 过滤列表、`?user={id}` 加载后直接打开该用户详情抽屉；所属空间卡显示成员 `createdAt`（加入时间）与 `lastActiveAt`（最后活跃），不再用空间创建时间冒充。
- 空间区：配额用量列保持；成员直达不变。
- 只允许改：`views/admin/security.js`、`users.js`、`storage.js`、`projects.js`、`css/admin.css`；`views/admin.js` 仅必要时。

### T3 空间设置抽屉
- 成员行：44px；次行 `邮箱 · 最后活跃 X`；角色徽章区分 OWNER/ADMIN/EDITOR/VIEWER；降级角色前确认。
- 移除/批量移出确认带后果数字：文档数（`proj.docCount`）与文件数（`Endpoints.projectStorage(pid).active.fileCount`）；取不到时明确写“数量未知”，不猜。
- 转让 owner 的选人只列当前空间内非 OWNER 成员（不再用目录选人器）。
- 权限说明卡改为抽屉底部常驻（sticky）；概览颜色/配额条保持。
- 只允许改：`views/project.js`。

## 验收
1. `cd lite/server && uv run pytest ../tests/test_drive_versions.py ../tests/test_admin_sections.py ../tests/test_file_versions.py ../tests/test_admin_storage.py ../tests/test_session_audit.py ../tests/test_frontend_refs.py -q` 全绿。
2. 真实浏览器抽验（可用临时页，不入库）：网格 hover 版本入口、排序、备注上传/展示、冲突上传者姓名、窄屏强制列表；后台 PAT 卡、加入时间、配额卡；空间设置成员字段与转让选人。
3. 不新增 `/api/` 字面量；scope 清理（MQL/定时器/抽屉）不回归。

## 禁触
server、index/app/route/ui/endpoints、editor/doc-editor、home/palette/settings/docs、tokens/components、其他 worker 测试、spec 其他文件。无 git 写操作。

## 交接
写 `handoff/W4-d-drive-admin.md`：接口使用、测试结果、文件行号、集成注意、未验项。最终报告按模板。
