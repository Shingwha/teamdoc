# W4-d 云空间 / 管理后台 / 空间设置 交接包
> 当前工作区直接修改 / 无分支、无 commit / 2026-11-06（UTC+8）

## A. 变更、真实命令与结果

### 写入文件（严格范围）
- `lite/web/js/views/drive.js`（T1）
- `lite/web/css/drive.css`（T1）
- `lite/web/js/views/admin/security.js`、`storage.js`、`users.js`、`projects.js`（T2）
- `lite/web/css/admin.css`（T2 的配额行/PAT 卡布局）
- `lite/web/js/views/project.js`（T3）
- `lite/tests/test_drive_versions.py`（4 → 7 项）
- `lite/tests/test_admin_sections.py`（扩展同一浏览器用例）
- 本 handoff（唯一范围外例外）

范围外零改动：未触 server、index/app/route/ui/endpoints、editor/doc-editor、home/palette/settings/docs、tokens/components、其他 worker 测试、`views/admin.js`（分区注册未变）。未执行任何 git 写操作。

### 基线（开工）
`cd lite/server && uv run pytest ../tests/test_file_versions.py ../tests/test_admin_sections.py ../tests/test_smoke_endpoints.py -q`
→ **10 passed in 11.58s**

### 波末验收
`cd lite/server && uv run pytest ../tests/test_drive_versions.py ../tests/test_admin_sections.py ../tests/test_file_versions.py ../tests/test_admin_storage.py ../tests/test_session_audit.py ../tests/test_frontend_refs.py -q`
→ **28 passed in 12.50s**

### 附加定向
- `uv run pytest ../tests/test_layout_contract.py ../tests/test_render_contract.py ../tests/test_frontend_refs.py ../tests/test_page_assets.py -q` → **12 passed in 5.71s**
- `uv run pytest ../tests/test_visual_sweep.py -q` → **3 passed in 19.28s**
- 六个改动 JS 文件 `node --check` → 全部 `SYNTAX_OK`
- `grep "'/api/\|\"/api/"` 六个视图 → `NO_API_LITERALS`

### 临时浏览器抽验（未入库，跑完已删）
临时页放在 `lite/web/_w4d_*_probe.html`（脚本在系统临时目录，跑完删除），真实加载 api/endpoints/ui/route/scopes/drive、api/endpoints/ui/project 与真实 CSS，`api` 只桩数据层；headless Chrome 结果：
- 云空间 1280×900：`errors=none`；网格 2 瓦片、每瓦片 3 个 hover 操作按钮；工具条排序「名称」发出 `sort=name`、方向按钮再发 `dir=desc`；瓦片版本历史抽屉 3 项、备注「修复表格排版」仅渲染 1 条；「更多」菜单为 `上传新版本|版本历史|下载`；`dispose()` 正常。
- 云空间 500×900：`narrowAtLoad=1`、列表 2 行、网格按钮 disabled、行内仍有两个版本入口；抽屉 3 项、备注可见；`errors=none`。
- 空间设置 1280×900：成员 3 行、计算高度 **44px**；次行分别为 `zhang@t.local · 最后活跃 11/5 17:00`、`li@t.local · 最后活跃 11/3 17:00`、`wang@t.local · 从未活跃`；角色下拉 3 个；`.ss-perms` 计算 `position=sticky`；移除确认含「3 篇文档、7 个文件」；转让选人只剩「李四,王五」（OWNER 自己被排除），`/api/users/directory` 调用 0 次；`errors=none`。

## B. 接口使用（与 `ref/interfaces.md` W4 契约一致）

- `Endpoints.fileVersionUpload(id, name, note)`：显式新版本带 `note`（可选、≤200）；`name` 传 `undefined` 由服务端沿用原文件名。
- `Endpoints.fileVersions(id)`：时间线读每项 `note`；无备注不渲染。
- 上传 409：冲突项 `existing.updatedByName` 有值才追加「由 X 上传」。
- `Endpoints.adminPats({ limit: 100 })`：安全区 PAT 审计，读 `{items:[{id,userId,userName,userEmail,name,scopes,createdAt,lastUsedAt,revokedAt}]}`。
- `Endpoints.adminOverview().nearQuota`：存储区配额策略卡；点击行调用本域共享的成员抽屉 `window.AdminSections.memberDrawer(proj, onChanged)`。
- `Endpoints.projectMembers(pid)`：成员 `createdAt/lastActiveAt` 用于用户详情的「所属空间」；空间设置成员次行同样读 `lastActiveAt`。
- `Endpoints.projectStorage(pid).active.fileCount`：移除确认的文件数；`proj.docCount` 为文档数；任一取不到写「数量未知」。
- `Route.current().query`（回落 `Route.parse(location.hash)`）：用户区 `?q=` 过滤、`?user=` 自动打开详情。

依赖现状：W4-a 的后端字段与端点、W4-c 的 `Endpoints.adminPats`/`fileVersionUpload(...,note)` 均已落地并通过上述定向；本轮没有因并行未落地而绕路。

## C. 关键实现

### T1 云空间
- 网格瓦片操作条：`.tile-acts` 位于缩略图右下角，含「上传新版本 / 版本历史 / 更多」；前两者复用 `pickVersionFile`/`openVersionDrawer`，「更多」复用 `fileMenuItems`（与右键菜单同一份）。触屏由 `(hover: none), (pointer: coarse)` 常显。
- 工具条排序：`drive-sort-seg`（名称/时间/大小）+ `btn-sort-dir`（升/降），与表头共用 `applySort`，统一写 `td:drive-sort`/`td:drive-dir`。表头排序保持。
- 备注：选完文件后弹 `UI.formModal`（textarea `maxlength:200`，可留空/取消），`task.note` 随上传提交；时间线 `.drive-v-note` 仅在 `v.note` 非空时渲染。
- 窄屏：`prefView` 记住用户主动选的形态，`viewMode = isNarrow() ? 'list' : prefView`；MQL 变化 `applyNarrowView` 切换并禁用网格按钮，离开时恢复偏好；`cleanup()` 摘除该监听。
- 冲突窗：`existing.updatedByName` 非空时显示「由 X 上传」（空串按契约省略）。

### T2 管理后台
- 安全区 PAT 审计卡：六列（用户/名称/权限/创建/最近使用/状态）、用户/名称搜索、独立取数。四态为骨架 / 数据 / 空态 / 错误横幅；PAT 接口失败只影响本卡。`scopes` 兼容后端实际的逗号字符串（如 `"read,write"`）与数组。
- 存储区配额策略卡：说明「按空间 quotaBytes，80% 预警，只提示不拦截」；近配额行显示用量/配额/占比条，点击/键盘 Enter 打开该空间成员抽屉。`adminOverview` 失败或缺少 `nearQuota` 时显示「近配额数据暂不可用」，不伪装成空列表。
- 用户区：`load()` 读 `?q=` 写入搜索并过滤；`?user={id}` 在用户列表到货后打开 480 抽屉。同一分区内仅 query 变化（再次从命令面板跳用户）用 `hashchange` + 延后一轮同步，避开 `_route` 的 `closeAllModals`。
- 所属空间卡：次行改为「加入于 … · 最后活跃 …」；`lastActiveAt` 为 null 显示「从未活跃」，字段缺失显示「最后活跃未知」；不再用空间创建时间冒充加入时间。
- 空间区：配额用量列与成员直达不变；成员抽屉实现提到模块级并导出 `AdminSections.memberDrawer`，供存储区复用，读写仍走同一组成员接口。

### T3 空间设置抽屉
- 成员行 44px（`height/min-height:44px` + 去上下内边距）；次行「邮箱 · 最后活跃 X」。
- 只读角色徽章按 OWNER=primary / ADMIN=warning / EDITOR=success / VIEWER=默认区分；可管理时仍是行内下拉。
- 降级确认：单行与批量都在目标角色低于当前角色时先确认，取消则恢复原下拉值。
- 移除/批量移出：先 `loadImpact()` 取 `proj.docCount` 与 `projectStorage.active.fileCount`，确认文案写明「N 篇文档、N 个文件」；失败显示「文档数量未知、文件数量未知」。
- 转让选人：只列本空间 `role !== 'OWNER'`、未禁用、非当前登录人的成员，不再调用目录选人器。
- 权限说明卡：`position:sticky; bottom:0` 常驻抽屉底部；概览颜色/配额条未改。

## D. 偏差与取舍
1. 网格操作条只给文件瓦片；文件夹瓦片点击即进入，不提供版本操作。文件夹的写操作仍在列表行/右键（右键菜单原本也只处理文件），未新增文件夹网格菜单。
2. 「更多」菜单沿用原有右键菜单的三个条目（上传新版本/版本历史/下载），没有在本次工单里扩成完整的行操作全集。
3. 44px 行高与 sticky 权限卡用 `views/project.js` 内的内联样式实现：T3 的写入范围只有 `project.js`（`app.css` 归 W5），避免越界改共享样式表。
4. PAT 权限列按后端实际存法显示原始 scope 令牌（read/write），未做中文别名映射。
5. 用户区同分区 query 同步只处理 `#/admin/users` 前缀；从其他分区/页面进入时仍由 `load()` 的深链分支负责，两条路径用 `openedDeepLink` 去重。
6. 存储区近配额行打开成员抽屉时只带 `{id,name}`（接口返回的就是轻量对象），抽屉内再取成员；归档态由该对象的 `archivedAt` 判定，近配额项没有该字段时按未归档处理。

## E. 关键行号（当前文件）
- `lite/web/js/views/drive.js`：`applySort:253`、`tileActsHtml:341`、`askVersionNote:551`、时间线备注 `:609`、`fileMenuItems:701`、`applyNarrowView:1050`、冲突上传者 `:1199`、清理 `:1426-1427`
- `lite/web/css/drive.css`：`.tile-acts:39`、hover/focus `:55`、coarse pointer `:60`、`.drive-v-note:65`、排序紧凑 `:74`
- `lite/web/js/views/admin/security.js`：`scopeBadges:25`、PAT 表 `:121`、`loadPats:153`、`patsCard:182`
- `lite/web/js/views/admin/storage.js`：`quotaCard:90`、并行取数与渲染 `:129-138`、点击行 `:143`
- `lite/web/js/views/admin/users.js`：`routeQuery:84`、深链 `load:289-304`、`onRouteHash:317`、`memberMeta`（所属空间卡次行）
- `lite/web/js/views/admin/projects.js`：模块级 `memberDrawer:62`、导出 `:151`
- `lite/web/js/views/project.js`：`roleBadge:275`、`lastActiveText:284`、sticky 权限卡 `:456`、`loadImpact:474`、`impactText:488`、成员行 `:539`、降级 `:577`、批量降级 `:617`、批量移出 `:635`、`pickTransferTarget:713`
- `lite/web/css/admin.css`：配额行 `:221-231`、PAT 卡搜索 `:234-235`
- 测试：`lite/tests/test_drive_versions.py` 新增 3 项；`test_admin_sections.py` 新增深链/PAT 四态/配额卡断言与同一分区 hash 变化步骤。

## F. 未验项与集成注意
- 未跑全量快速组与 slow 组（按工单口径由 lead 统一跑）；本域定向、静态契约与真实浏览器探针全绿。
- 版本备注的「选文件 → 备注弹窗 → 上传」只做了源码接线与静态断言，未在无头浏览器里走完文件选择（Chrome 需要 CDP 注入文件）；真实服务端上传/备注由 W4-a 的接口测试覆盖。
- 冲突窗「由 X 上传」依赖 409 `existing.updatedByName`；后端已落地，前端在字段为空串时按契约省略。
- 菜单/操作入口在 VIEWER 下保持只读：瓦片操作条只出「版本历史/更多」，不出上传新版本；行内与工具条原有守卫不变。
- 若后续把 `app.css` 的 `.ss-member` 密度或权限卡样式收进共享表（W5），可删掉 `project.js` 的内联样式，选择器与本文件保持一致。
- 团队若把命令面板用户捷径从 `?q=` 改成 `?user={id}`，本域两条路径都已支持，不需要再改用户区。
