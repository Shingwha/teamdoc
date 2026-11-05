# W10-a · 归档空间搜索策略 交接包
> 分支 `wave/w10-archive-search`；worktree `C:\Users\shifu\.worktrees\teamdoc\w10-archive-search`；基线 `175a83a`（2026-11-06）
> 提交：`034b054`（T1 服务端）、`e445535`（T2 命令面板）、`50e0949`（T3 测试）

## A. 交付

### A1. 服务端过滤语义（`services/search.py`、`routers/search.py`）
- `GET /api/search` 新增查询参数 `includeArchived`；`routers/search.py:12` 的 `_truthy` 只把
  `1/true/yes`（大小写不敏感、去空白）视为真，其余（含空串/0/false）为假。
- 服务层在原有严格 `projectId` 校验之后一次性查询 `Project`，得到 `{id: name}` 与
  `{id: archived}`（`services/search.py:63-65`），同名查询不再多打一次库。
- 过滤分派（`services/search.py:66-70`）：
  - 无 `projectId` 且 `include_archived=false`：从可见集合剔除 `archived_at is not None` 的空间；
    若全部被剔除直接返回空集。
  - 无 `projectId` 且 `include_archived=true`：保留归档空间。
  - 有 `projectId`（用户显式进入）：先过原有可见性严格校验，命中后不做归档过滤。
  - `visible_project_ids` 的既有语义不变（最近模式仅成员空间；关键词模式对全局管理员含
    全部非个人空间）。
- doc/file 结果行新增 `archived: bool`：`_doc_row`（`services/search.py:24-29`）、
  `_file_row`（`:32-34`）；行内值由该空间的 `archived_at` 推导，显式 `projectId` 命中的归档
  空间也返回 `archived=true`。
- 搜索仍不改变归档写守卫；只读语义不变。

### A2. 命令面板（`views/palette.js`）
- 搜索范围判定：`searchPid()`（`palette.js:20-23`）只认**显式空间路由**的 pid
  （`Route.current().pid`）。`#/`、`#/projects`、设置/后台等页面即使 `App.spacePid` 记忆了空间，
  也走全局搜索。原因：首页会自动选中记忆空间/个人空间（`views/home.js`），若沿用
  `App.currentSpaceId()`，「无当前空间」的开关永远不可达，全局归档搜索无法使用。
  面板动作行仍用 `currentPid()`（`App.currentSpaceId()`），`#/` 下的「新建文档/上传文件/
  空间设置」行为不变。
- footer 开关（`palette.js:39`、`:49-50`）：仅 `!searchPid()` 时渲染
  `<input id="cmd-archived">包含归档`，初值读 `UI.pref.get('td:search-archived','0') === '1'`。
  复用现有 `.check-row`，未改 CSS（写入范围不允许）。
- 请求参数（`palette.js:157-159`）：有 pid 时带 `projectId`；无 pid 且开关开启时带
  `includeArchived=1`（经 `Endpoints.search` 统一构造，无 `/api/` 字面量）。
- 开关切换（`palette.js:65-72`）：写 `'1'/'0'` 到 `td:search-archived`，重跑当前输入，
  随后把焦点还给 `#cmd-q` 并恢复选区。
- 结果徽标：doc/file 行映射 `archived: !!d.archived / !!f.archived`（`:202`、`:210`），
  `row()` 在原有类型徽标后追加 `UI.badge({text:'已归档', kind:'warning', cls:'xs'})`（`:192`）。

### A3. 测试（新增 `tests/test_archive_search.py`）
- `test_global_search_excludes_archived_until_included`（`:42`）：归档空间的关键词搜索
  默认无 doc/file；`includeArchived=1` 返回且 `archived=true`、`projectId/projectName` 正确；
  显式 `projectId` 不带开关也可读；解除归档后默认搜索恢复且 `archived=false`。
- `test_recent_search_respects_archived_flag`（`:71`）：q 为空时用 `updatedBy=管理员&limit=100`
  收窄扫描范围，断言最近模式默认排除归档、开关包含、显式 `projectId` 例外。
- 只有这两个行为用例，未加实现字符串/静态断言。

## B. 真实测试结果

- 开工基线（改动前，原样）：
  `cd lite/server && uv run pytest ../tests -q`
  → **172 passed, 1 skipped, 3 deselected, 19 warnings in 113.68s**（与工单期望一致，0 failed）。
- 新增测试单跑：`uv run pytest ../tests/test_archive_search.py -q` → **2 passed in 2.60s**。
- 波末工单验收组：
  `uv run pytest ../tests/test_archive_search.py ../tests/test_w4_contracts.py ../tests/test_workspace_preferences.py ../tests/test_frontend_refs.py ../tests/test_visual_sweep.py ../tests/test_page_assets.py -q`
  → **22 passed in 32.47s**。
- 其余触及 `/api/search` 的既有测试（防行字段变化回归）：
  `test_smoke_endpoints + test_visibility + test_files_paging + test_upload_security + test_archive_search + test_w4_contracts + test_workspace_preferences + test_frontend_refs`
  → **37 passed, 1 skipped in 28.17s**。
- 全量（新增 2 条后）：`uv run pytest ../tests -q`
  → **174 passed, 1 skipped, 3 deselected, 19 warnings in 109.77s**（0 failed）。
- `node --check lite/web/js/views/palette.js` → 通过（退出码 0）。
- 临时无头浏览器探针（跑完即删，未留文件）：在 `#/`（首页已记忆/自动选中个人空间）打开 Ctrl+K，
  确认开关可见；输入归档关键词后默认 0 行、请求串无 `includeArchived`；勾选后请求串出现
  `includeArchived=1`、出现 2 个「已归档」徽标、`document.activeElement.id == "cmd-q"`、
  `td:search-archived == '1'`、关闭重开后开关仍勾选、`window.__errors` 为空。

## C. 决策、偏差与未验项

- **搜索范围以路由 pid 为准**，不是 `App.currentSpaceId()`。后者在 `#/` 会被首页回填为
  记忆空间/个人空间，导致「无当前空间」不可达；`#/` 下做全局搜索才使本工单的归档开关有
  实际使用场景。面板动作仍沿用 `App.currentSpaceId()`，未改变空间内快捷动作。
- footer 开关复用 `.check-row`（36px 控件高度），会让 `.cmd-foot` 在全局搜索时略高于其他
  页面；未改 `css/app.css`（不在写入范围），如需紧凑样式由 lead 在样式波次决定。
- 只验证了 `includeArchived=1`；`true/yes` 的解析在代码中支持，但测试未逐值覆盖（按“宁少勿多”
  只守产品契约参数）。
- 未验证：窄屏（≤960）/深色主题下开关与双徽标的视觉对比度；命令面板在结果很多时的双徽标
  换行；真实鼠标点击 checkbox 的命中区域（探针用程序化 `checked + change`）。
- 未验证管理员的 `site_wide=True` 关键词搜索包含非成员归档空间的行为组合（现有语义是全局
  管理员可搜全部非个人空间，本波只加归档剔除，未改可见性集合）。
- 性能：每次搜索多一次 `Project` 查询（原代码也查一次 Project 取名称，本波复用同一次结果）。

## D. 关键指针
- 服务端：`lite/server/services/search.py:24/32/37/63-70/82-94`；
  `lite/server/routers/search.py:12/19/23`。
- 前端：`lite/web/js/views/palette.js:16/20/39/49/56/65/157-159/192/202/210`。
- 测试：`lite/tests/test_archive_search.py:42/71`。
- 既有契约参考：`ref/interfaces.md` 的 W2 搜索段（`projectId/updatedBy`）与归档只读段。
