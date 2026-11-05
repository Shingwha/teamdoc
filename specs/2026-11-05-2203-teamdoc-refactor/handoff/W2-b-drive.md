# W2-b 云空间版本体验 交接包
> 当前工作区直接修改 / 无分支、无 commit / 2026-11-05 23:55（UTC+8）

## A. 变更、真实命令与结果
- 写入文件（严格范围）：
  - `lite/web/js/views/drive.js`（改写，1322 行）
  - `lite/web/css/drive.css`（新建，173 行）
  - `lite/tests/test_drive_versions.py`（新建，4 项）
  - 本 handoff（唯一范围外例外）
- 范围外零改动：未触 index/app/route/ui/endpoints/scopes、其他 CSS/JS/views、server、tools、editor、既有共享测试。
- 开工基线：`cd lite/server && uv run pytest ../tests/test_file_versions.py ../tests/test_file_version_services.py -q`
  → **14 passed, 19 warnings in 7.63s**（warning 为 `db.py` 的 `utcnow` 弃用，W1 既有）。
- 波末基线重跑：同命令 → **14 passed, 19 warnings in 7.63s**。
- 新增定向：`uv run pytest ../tests/test_drive_versions.py -q` → **4 passed in 0.02s**。
- 合计定向：`uv run pytest ../tests/test_drive_versions.py ../tests/test_file_versions.py ../tests/test_file_version_services.py -q`
  → **18 passed, 19 warnings in 7.65s**。
- drive.css 布局契约定向：
  `uv run pytest "../tests/test_layout_contract.py::test_no_spacing_assignment_in_query_blocks" "../tests/test_layout_contract.py::test_form_breakpoint_only_in_app_css" -q`
  → **2 passed**（≤720 重排块以「契约身份」注释豁免；960 断点未出现在 drive.css）。
- 跨模块静态引用：`uv run pytest ../tests/test_frontend_refs.py -q` → **2 passed**（W2-a 已落 `fileVersions/fileVersionUpload/fileRestore/fileChanges/fileDownload`，`FilesAPI.downloadVersion` 可解析）。
- `node --check lite/web/js/views/drive.js` → `SYNTAX_OK`。
- 未跑全量快速组、未跑真实 index 整站集成（工单明确留给 W2-a/lead）。

### 临时浏览器 fixture 自测（未入库）
在仓库外的临时目录（`%TEMP%/td-drive-probe`）加载真实 `api.js/ui.js/scopes.js/endpoints.js/drive.js` 与真实 CSS，按 W2-a 冻结签名 stub 端点，headless Chrome 实测通过：
- `errors=none`；网格默认；列表 `rowHeight=44px`；名称下 `v3 · 1.2 KB · 刚刚`。
- 选中单文件后工具条 `#btn-version-upload` 出现；工具条发起显式新版 → `POST /api/files/F1/versions`，刷新后选中态保留 1 行。
- 抽屉宽 `400px`、宽屏 `drawerNarrow=false`；800px 视口 `drawerNarrow=true`（全宽）。时间线 3 项、2 个恢复按钮（当前版无恢复）；下载 URL 为 `/api/files/F1/download?inline=0&version=3`；恢复确认后 `POST /api/files/F1/restore`。
- 两个同名文件同批上传：只有 **1 个**弹窗、**2 行**选择；分别选 keep/version 后请求出现 `name_mode=keep` 与 `version_of=F1`。
- 定时器 `15000ms`，调用 dispose 注入的 cleanup 后 `clearInterval` 命中。

## B. 接口使用（与 `ref/interfaces.md` 一致）
- `Endpoints.fileVersions(id)`：GET 版本列表（服务端降序，首项视为当前版）。
- `Endpoints.fileVersionUpload(id)`：POST raw body（`apiUpload`，浏览器自动 Content-Length/进度）；文件名由服务端沿用 target.name。
- `Endpoints.fileRestore(id)`：POST `{version}`，返回最新 `file_json`；恢复后重载时间线与列表。
- `Endpoints.fileDownload(id, false, version)`：历史版本下载（W2-a 已实现第三参，实际 `?inline=…&version=n`）。
- `Endpoints.fileChanges(pid, since)`：变更轮询；使用返回的 `nextSeq` 作为下一次 `since`。
- `FilesAPI.upload(opts)`：新增 `nameMode/versionOf`，映射为 query `name_mode/version_of`。
- `Views.driveBody({projectId, proj, folderId, highlight, dispose})`：`dispose(cleanup)` 注册清理；W2-a 已在 `lite/web/js/views/project.js:249` 传 `ctx.dispose`，`index.html:30` 已引入 drive.css。
- 依赖的既有 UI 组件：`UI.tableHead/tableRow/cellName/iconBtn/badge/btn/seg/toolbar/modal/skeleton/emptyState/errorBanner/fmtWhen/fmtSize/fmtDateShort/floatingLayer/closeOpenMenu/NARROW`；未使用 `/api/` 字面量。

## C. 409 同名冲突队列语义
1. 普通上传返回 409 `code=name_exists` 且 `detail.existing` 存在时：任务标 `conflicted=true`，进度行显示「同名,待选择」，文件对象留在 `conflicts` 队列，不丢、不计完成数；其他错误照旧标红。
2. 整批队列完全空闲（`activeUploads===0`）后 `afterUpIdle()`：有冲突 → `resolveConflicts()` **只弹一次**；无冲突 → `load({keepSelection:true})`。
3. 弹窗逐行 `<select>`：
   - `version`（默认，创建为新版本）→ 重试带 `version_of=existing.id`；
   - `keep`（保留两个）→ 重试带 `name_mode=keep`。
   重试沿用原进度行（不新增行），并发 3/进度/目录结构（`folderId`）保持。
4. 关闭/Esc/跳过按钮 = 明确跳过：行标「已跳过」，计数补齐并 toast 警告；只有这个显式动作会放弃文件。
5. 重试再次 409 仍回流队列；弹窗关闭后若还有残留冲突会再走一轮（避免静默遗留）。
6. VIEWER 在 `enqueue` / `enqueueWithPaths` / drop 三处有 `canWrite` 守卫，不会进入队列；空态快捷上传也不渲染。

## D. 抽屉、轮询与清理实现要点
- 抽屉是 `document.body` 级节点（`.drive-drawer` + `.scrim.drive-drawer-scrim`），不随作用域节点移除，因此 `cleanup()` 显式 `closeVersionDrawer()`。
- 宽 `min(400px, 100vw)`；窄屏由 `UI.NARROW.matches`（ui.js 的 960 MQL）加 `.is-narrow`，并监听 MQL change 跟随；不新增 960 media 查询（布局契约）。scrim 复用 `.scrim` 基类。
- 时间线：版本号、`UI.fmtWhen` 时间（title 为完整时间）、大小、`createdByName`（缺失显示「未知用户」）；当前版（降序首项）带「当前」徽标且不显示恢复；任意版本可下载；恢复先 confirm，POST 后 toast + 刷新列表与时间线。
- 轮询：`setInterval(pollChanges, 15000)`；请求 `Endpoints.fileChanges(projectId, changeSeq)`，`changeSeq = r.nextSeq`；有 `changes` 时 `load({keepSelection:true})`；页面不可见、上传在飞、冲突待处理时跳过；请求失败静默、下一轮同游标重试。
- `cleanup()`：`clearInterval` + 移除 `visibilitychange` + 关闭抽屉 + 移除 Esc/MQL 监听；若上层漏接 dispose，下一 tick 用 `rowsEl.isConnected` 自清。
- `keepSelection`：`load` 非追加时只重置分页游标，不清 `selected`；行按集合重绘勾选态，`updateBatchBar` 同步工具条按钮显隐。

## E. 关键行号（当前文件）
- `FilesAPI` / 版本下载 / nameMode·versionOf：`lite/web/js/views/drive.js:22`、`:25`、`:38-40`
- 相对时间 / 版本号：`:57`、`:69`
- `Views.driveBody` 签名（含 dispose）：`:76`；dispose 注册：`:1319`
- 工具条主按钮与隐藏 input：`:128-134`、`:181`
- 行内版本元信息与两个入口：`:239-288`（name-sub `:273`；act-version-upload/act-versions `:252-255`）
- 网格瓦片元信息：`:302-319`
- `load(keepSelection)`：`:383-392`
- 选文件 / 显式新版入队：`:488-505`
- 版本抽屉：`:550-627`（打开 `:550`、加载 `:580`、下载/恢复 `:602`）
- 右键菜单：`:629-666`
- 工具条按钮显隐：`:675-685`
- 上传队列 / 409 / 冲突弹窗 / 重试：`:1015-1160`（`xhrUpload:1015`、`isNameConflict:1030`、`afterUpIdle:1064`、`resolveConflicts:1071`、`skipConflicts:1116`、`retryConflicts:1126`、`enqueue:1146`）
- 轮询 / 清理：`:1284-1319`（`pollChanges:1284`、`cleanup:1308`、`setInterval:1317`）
- CSS：`lite/web/css/drive.css:7`（44px）、`:11`（8 个操作位）、`:19-35`（名称两行）、`:39-139`（抽屉/时间线）、`:142-164`（冲突行）、`:166-173`（≤720 行重排让位）
- 新增测试：`lite/tests/test_drive_versions.py:1-64`

## F. 偏差与取舍
1. 「名称下 `vN · 大小 · 相对时间`」同时用于列表行与网格瓦片；列表仍保留原有「大小/时间」列（列头排序继续可用）。相对时间取 `updatedAt || createdAt`，而「时间」列与 `time` 排序仍按 `created_at`（服务端 `_FILE_SORTS` 未改，本域不能改），因此上传新版本后名称下显示「刚刚」而时间列仍是创建时间。
2. 列表 44px 是 §6.5 固定契约；W2-a 新增的 density（comfortable 48 / compact 42）不影响云空间列表。若 lead 希望密度生效，把 `drive.css:7` 改为按 `html[data-density]` 覆盖即可。
3. 时间线「备注」无数据模型（W1 `FileVersion` 无 note 字段），未渲染；现有列为版本/时间/大小/操作者。
4. 冲突弹窗只展示已有文件的大小与更新时间；`detail.existing` 只带 `updatedBy` 用户 id、无展示名，未额外拉目录接口。
5. 显式上传新版本复用右下角上传面板（进度/并发 3），行标签为「新版本 · 文件名」。
6. 空态/错误沿用 `UI.emptyState` / `UI.errorBanner`（W2-a 新增 `UI.empty/UI.error` 未替换旧 API，旧 API 仍在 ui.js 导出）。
7. 网格默认下瓦片没有 hover 操作条（既有实现也没有）；网格内的版本入口走右键菜单，列表/工具条如工单所述。

## G. 未验项与集成注意
- 未跑全量快速组、未跑真实 index 整站/浏览器巡检（工单留给 W2-a/lead 复验）；本域只有临时 fixture 的组件级运行证据，未伪报整站。
- 未做真实服务端联调（版本端点由 W1-a 的 14 项后端测试覆盖；前端接线由新增静态测试 + 临时 fixture 覆盖）。
- `test_layout_contract.py` 整文件当前有 1 项并行在飞失败：`docs.js` 重写后不再含 `UI.dualPanel`（W2-a 范围），不是本文件引入；本文件相关的两条静态契约已单独跑绿。
- W2-a 已接线（开工时尚未落地，波末复查已就绪）：`index.html:30` 引入 drive.css、`views/project.js:249` 传 `dispose: ctx.dispose`、`endpoints.js:52/75/79/80/83` 提供 fileChanges/fileDownload/fileVersions/fileVersionUpload/fileRestore。
- 若 W2-a 再调整 `UI.NARROW` 名称/类型，`drive.js:558/562` 的窄屏跟随需同步。
- VIEWER 写操作隐藏做了工具条/行操作/空态/拖拽/队列守卫；未做 VIEWER 的浏览器级回归，建议 lead 在整站抽验时补一眼。
- 浏览器能力沿用既有依赖：`DataTransfer`、`webkitGetAsEntry`、`color-mix`；未引入新外链或构建步骤。
