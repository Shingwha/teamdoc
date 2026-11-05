# W4-c · 壳、IA 与设置补齐 交接包
> 当前工作区直接修改 / 无分支、无 commit / 2026-11-06

## A. 变更、接口与真实验证

### T1 空间切换器（`js/app.js`、`js/ui.js`、`css/app.css`）
- 顶栏 `#space-switch` 由 `UI.dropdownMenu` 承载自定义面板（`menuCls:'space-switch-menu'`），不再用静态菜单项。
- 浮层两页签：
  - 「我的空间」：逐行色点 + 名称 + 角色徽标 + 当前空间 `check-line` 标记；行尾 `⋯`（`.ss-more`）仅当 `myRole` 为 OWNER/ADMIN 或全局管理员时渲染，点击调 `SpaceSettings.open(proj, proj.id, 'overview')`（签名未变）。
  - 「发现空间」：首次切到页签时请求 `Endpoints.discover()`，逐行名称/描述 + 「加入」或「打开」；加入走 `ProjectsAPI.joinPrompt(id,name,joinRole)`（内部 `join` 刷新 `App.spaces` 并落到 `docs`），已加入直接进空间首页。
- 底部「创建空间」（`SpaceWizard.open`）与「管理空间」（`#/projects`；管理员或任一 OWNER/ADMIN 空间时显示）。
- 打开/关闭沿用 `floatingLayer` 的 Esc、外点、滚动关闭语义；`UI.dropdownMenu` 新增 `opts.menuCls` 与 `open()`（程序化打开，已开则重建）。
- `App.openSpaceSwitcher(tab)` 供首页无空间态调用；窄屏（≤960）下 `.space-switch-menu` 整行贴边（`left/right`，宽度自动）。
- 语法：`js/app.js:185/226/250/264`；`js/ui.js:1206` 起的 `dropdownMenu`；样式 `css/app.css:55`。

### T2 通知（`js/endpoints.js`、`js/app.js`、`css/app.css`）
- `Endpoints.notifications()/notificationsRead()/notificationsReadAll()` 指向 `/api/notifications`、`/read`、`/read-all`（W4-a 已落地，探针用真实接口验证）。
- 顶栏铃铛：
  - `refreshNotifyBadge()` 在 `setupShell` 与打开面板时拉列表，按 `unread` 切换 `#btn-notify.has-unread` 红点（CSS 伪元素）并更新 title。
  - 面板列出 `title/body/createdAt`；未读行高亮 + 实心点；点击先 `POST /read {ids:[id]}`，成功后清红点并跳 `link`（站内 hash；非 hash 走 `location.assign`）。
  - 底部「全部已读」调用 `/read-all`，清空未读并 toast；空态用 `UI.empty`，请求失败用 `UI.error`，全部已读按钮在无未读时 disabled。
- 样式 `css/app.css:143/155`。

### T3 发现/搜索 IA（`js/route.js`、`index.html`、`js/views/home.js`、`js/views/palette.js`）
- 删除 `#/discover`、`#/search` 路由分支与 `views/discover.js`、`views/search.js`；`index.html` 移除两个 script。
- 旧书签落到未知段分支 → `redirect:'#/'`，无死链（浏览器探针实测两路由均回 `#/`）。
- 首页无空间态「发现空间」改为 `App.openSpaceSwitcher('discover')`；文案不再提"发现页"。
- 搜索唯一入口为 Ctrl+K 面板（`views/palette.js` 注释已更新）。

### T4 设置布局与预览联动（`js/views/settings.js`、`js/route.js`、`css/app.css`）
- 设置路由不再套 `page-narrow`（800）；`.settings-page` 自限 `max-width:960px; margin:0 auto`（不动 tokens）。
- 偏好「编辑器」新增「预览滚动联动」checkbox `#pref-preview-link`，写 `UI.pref td:preview-link`：**存字符串 `'true'/'false'`，缺省视为 `true`**（`UI.pref.get('td:preview-link','true') !== 'false'`）。编辑器侧读取须与此约定一致。
- `js/views/settings.js:271/289/352`；`css/app.css:626`。

### T5 初始化安全提示（`js/app.js`）
- 首管理员 bootstrap 表单顶部新增 `UI.banner warn`（盾牌图标）：初始化完成前任何可访问站点的人都可抢注，部署后应立即初始化。`js/app.js:762`。

### T6 文档树定位（`js/views/docs.js`、`js/views/doc-tree.js`）
- `expandAncestors(id)`：按 `UI.walkTree` 的路径从折叠集合移除全部祖先；`renderTree` 渲染前后各展开一次并滚动。
- 新增 `DocTree.reveal(el,id,collapsed)`：只对现有节点清 `hidden`/加 `caret.open`、同步折叠集合、按树容器自身滚动（不用 `scrollIntoView`），不重建树。
- `onChild` 改为 `expandAncestors → setActive → reveal`：切文档只移动高亮；目标在折叠区时原地展开祖先并滚到可见。
- 指针：`js/views/docs.js:54/67/206`；`js/views/doc-tree.js:106/118`。

### 跨 worker 端点补齐（`js/endpoints.js`）
- 新增 `adminPats(params)`，并把 `fileVersionUpload(id,name,note)` 扩为三参，配合并行在飞的 W4-d（`views/admin/security.js` 已调用，`views/drive.js:1129` 已传 note）。`test_frontend_refs` 因此转绿。

### 测试更新（只改失效处）
- `tests/test_page_assets.py`：新增 `#btn-notify` 探针。
- `tests/test_visual_sweep.py`：页面清单删除「发现/搜索」；切换器交互改为断言 `.space-switcher`、两个 `[data-ss-tab]`、`.ss-space-row`、`.ss-foot .btn`。
- `tests/test_join_drill.py`：首条演练改为「空间切换器 → 发现空间页签 → 加入 → 弹框确认 → 落 docs 可读」；直链 403 入口保持。
- `tests/test_render_contract.py`：新增第三篇顶层文档；折叠父文档后先切到顶层文档（断言折叠态保留、高亮/标题跟随），再点折叠区里的子文档（断言原地展开祖先、树节点身份不变、高亮/标题跟随）。
- `tests/README.md` 同步三份测试职责描述。

### 真实验证
- 开工基线：`cd lite/server && uv run pytest ../tests/test_page_assets.py ../tests/test_render_contract.py ../tests/test_join_drill.py -q` → **7 passed in 9.19s**。
- 波末验收：`uv run pytest ../tests/test_page_assets.py ../tests/test_render_contract.py ../tests/test_layout_contract.py ../tests/test_visual_sweep.py ../tests/test_join_drill.py ../tests/test_doc_move_drill.py ../tests/test_frontend_refs.py -q` → **18 passed in 30.15s**（同组复跑 27.63–30.15s，均 18 passed）。
- 临时无头浏览器探针（跑完即删，未留测试文件；headless 默认 800×600，形态断点 <960 生效）：
  - 管理员：`panel=1 tabs=2 rows=3 moreRows=3`；点行尾 ⋯ 打开空间设置抽屉（`drawer=1`，概览可读）；发现页签 `discRows=1`；铃铛 `unreadDot=1 → notifyItems=1/unread=1`，点击后 `hash=#/p/{pid}/home`、红点清除；`#/search`、`#/discover` 均回 `#/`；Ctrl+K 面板可开；`errors=none`。
  - 只读成员：共享空间行存在但 `sharedMore=0`（无 ⋯），个人空间行 `personalMore=1`；铃铛「全部已读」后 `unread=0`、红点清除；`errors=none`。
- `node --check` 覆盖改动 JS；Python 测试文件 `ast.parse` 通过。

## B. 偏差、并行集成与未验项
- W4-a 的通知路由在波内落地，UI 直接对真实接口验证；无 fallback/shim。
- W4-d 并行改动调用 `Endpoints.adminPats` 与 `fileVersionUpload(id,undefined,note)`；这两处在本波补齐，属 `endpoints.js` 唯一路径源的职责。
- `td:preview-link` 的取值约定为本波决定（`'true'/'false'`）。W4-b 如用其它约定（如 `'0'`）需统一，建议以其 handoff 为准再对齐。
- `views/recent.js`（`window.Recent`）在 discover/search 删除后已无消费者；不在本工单写入范围，留给 W7 清理（index 中 script 仍在）。
- 通知红点只在壳启动、打开铃铛与已读操作后刷新，无轮询/实时推送；未读仅红点，无数字角标（方案只要求红点）。
- 「管理空间」的判定包含个人空间 OWNER，因此拥有个人空间的用户都会看到该入口；若产品要求只统计团队空间，需再收紧 `anyManageableSpace`。
- 未验：通知列表超长滚动、`link` 指向已删除/无权限空间时的兜底；窄屏切换器/通知只经 headless 默认视口（800×600）结构验证，未做人工视觉；浅色/深色下新浮层的对比度未逐主题截图核对。

## C. 关键指针
- 壳与浮层：`web/js/app.js:182/185/264/351/408/420`；`web/js/ui.js:1206`（`dropdownMenu` 的 `menuCls/open`）。
- 路由：`web/js/route.js:113`（删除发现/搜索 + 设置不再 narrow）；`web/index.html:98-109`。
- 首页/面板：`web/js/views/home.js:136-150`；`web/js/views/palette.js:1-4`。
- 设置/文档树：`web/js/views/settings.js:19/266-356`；`web/js/views/docs.js:53-83/203-212`；`web/js/views/doc-tree.js:97-136`。
- 样式：`web/css/app.css:55/143/155/352/626`。
- 端点：`web/js/endpoints.js:80/101-103/107`。
- 测试：`tests/test_page_assets.py:119-133`；`tests/test_visual_sweep.py:241-310`；`tests/test_join_drill.py:23-166`；`tests/test_render_contract.py:23-113/158-222`；`tests/README.md:42-45`。
