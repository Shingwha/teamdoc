# W4-c · 壳、IA 与设置补齐
> 写入范围：`lite/web/index.html`、`js/{app,route,ui,endpoints}.js`、`js/views/{home,palette,settings,docs,doc-tree,projects}.js`、删除 `js/views/{search,discover}.js`、`css/app.css`（仅本域新增样式）、`test_{page_assets,visual_sweep,join_drill,render_contract}.py`、`tests/README.md`、本 handoff。无分支/无 commit。

## 目标
按方案 §6.3/§6.6/§6.8/§6.10 收口壳与信息架构：空间切换器、通知、发现/搜索入口、设置布局与预览联动、初始化提示、文档树定位。

## 前置上下文
- 必读：overview → repo-map → interfaces（W4 契约）→ W2-a handoff → 本工单。
- 基线：`cd lite/server && uv run pytest ../tests/test_page_assets.py ../tests/test_render_contract.py ../tests/test_join_drill.py -q`。
- 稳定区：drive/admin/project/doc-editor/editor/**；不得修改。`SpaceSettings.open(projOrNull,pid,tab)` 签名已冻结。
- 测试口径：只更新因路由/壳变化而失效的既有测试；不新增测试文件。

## 工单
### T1 空间切换器升级
- 把当前 dropdown 换成自定义浮层，含两个页签：
  - 「我的空间」：逐行 色点 + 名称 + 当前标记；行尾 `⋯` 仅对 `myRole` 为 OWNER/ADMIN（或全局管理员）显示，点击调 `SpaceSettings.open(proj, pid, 'overview')`；底部「创建空间」「管理空间」（管理空间仅管理员或有可管理空间时显示）。
  - 「发现空间」：拉 `Endpoints.discover()`，列出公开空间；未加入可「加入」（现有 join API，成功后刷新 App.spaces 并进入空间），已加入可「打开」。
- 开关/关闭走现有 floatingLayer/Esc/外点语义；窄屏浮层全宽。
- 只允许改：`index.html`、`app.js`、`route.js`、`ui.js`、`css/app.css`、`views/projects.js`（如需入口）。

### T2 通知
- 顶栏铃铛：未读红点；打开时请求 `Endpoints.notifications()`，列出标题/时间；点击标为已读并跳 `link`；底部「全部已读」；空态用 `UI.empty`；请求失败用 `UI.error`。
- `endpoints.js` 增 `notifications()/notificationsRead()/notificationsReadAll()`；不改既有路径。
- 只允许改：`app.js`、`ui.js`、`endpoints.js`、`css/app.css`。

### T3 发现/搜索 IA
- 删除 `#/discover` 与 `#/search` 路由、视图与 index 脚本；发现只从 T1 页签进入；搜索只从命令面板。
- 首页无空间态/空态的发现入口改为打开切换器「发现空间」页签。
- 更新 `test_visual_sweep.py` 的页面清单与 `test_join_drill.py`：后者改为“切换器 → 发现空间 → 加入 → 可读”。
- 只允许改：`route.js`、`index.html`、`views/home.js`、删除 `views/search.js`/`views/discover.js`、`test_visual_sweep.py`、`test_join_drill.py`、`test_page_assets.py`、`test_render_contract.py`。

### T4 设置布局与预览联动
- 设置页内宽 960px（新增 `settings-page` 类；不改 tokens）。
- 偏好新增「预览滚动联动」开关，写 `UI.pref` 键 `td:preview-link`（默认 true）；编辑器已按该键读取。
- 账号/偏好分段自动保存与 toast 保持；不改后端。
- 只允许改：`views/settings.js`、`css/app.css`。

### T5 初始化安全提示
- bootstrap 第一步加一条可见警示：首管理员创建前任何能访问站点的人都可抢注；部署后应立即初始化。
- 只允许改：`app.js`、`views/settings.js`（如需）、`css/app.css`。

### T6 文档树定位
- 打开文档时展开其全部祖先并滚动到可见；切文档只改高亮不重建树（保持 scope 复用）。
- 只允许改：`views/docs.js`、`views/doc-tree.js`。

## 验收
1. `cd lite/server && uv run pytest ../tests/test_page_assets.py ../tests/test_render_contract.py ../tests/test_layout_contract.py ../tests/test_visual_sweep.py ../tests/test_join_drill.py ../tests/test_doc_move_drill.py ../tests/test_frontend_refs.py -q` 全绿。
2. 真实浏览器抽验：切换器两页签、逐空间 `⋯` 打开设置、铃铛列表与已读、Ctrl+K 面板、`#/search`/`#/discover` 不再可直达但无死链。
3. 普通用户不请求 admin JS（既有 App.loadAdmin 闸不回归）。

## 禁触
server、drive/admin/project/doc-editor/editor/**、tokens/components 全局刻度、其他 worker 测试。无 git 写操作。

## 交接
写 `handoff/W4-c-shell.md`：新路由/入口/函数、测试更新、文件行号、未验项。最终报告按模板。
