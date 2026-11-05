# W2-a · 设计系统、应用壳与功能页 交接包
> 当前工作区直接修改 / 无分支、无 commit / 2026-11-05

## A. 变更、接口与真实验证

### 壳与装配
- `lite/web/index.html`:删除 `/js/doceditor.js`,按 W1-b C 节顺序接 7 个 CM script。
- 新增 `views/home.js`、`views/palette.js`;新增 `css/drive.css`、`css/admin.css` 两个 link。
- 删除全部静态 admin script;`App.loadAdmin()` 按序注入 overview/storage/backup/projects/users/security/admin。
- 40px 顶栏(空间切换/命令面板/通知/设置/头像)+ 左栏(首页/最近/收藏 → 唯一 `#side-doc-tree` → 云空间/回收站)。
- 折叠态纯图标列 64px;窄屏左栏变抽屉;删除主区树列、`btn-doc-tree` 与 72px rail 特例。
- 壳 API:`App.setSpace/loadSpaces/renderSideNav/setupTopbar/buildSpaceMenu` 见 `js/app.js:49/62/106/179/222`。
### 路由与页面
- `#/` = 当前空间首页(记忆空间;无空间显示管理入口),`#/projects` = 空间管理。
- 空间内:`home/recent/favorites/docs/files/members/trash/settings`;成员与设置深链在空间首页上打开抽屉。
- `#/settings/{account|security|preferences}`、`#/admin/{section}`;`Route.settings/admin` 为唯一构造点(`js/route.js:82/87`)。
- `lastTab` 缺省 home;`Route.resolve` 见 `js/route.js:106`。
- 文档树:由 `views/docs.js:149` 写入 `#side-doc-tree`,离开文档模块 dispose 清空;主区只剩编辑列。
- scope 复用/离开守卫保持:切文档树节点与折叠态不重建,离开文档模块再回来重建。
- 首页:`views/home.js:85`,欢迎、最近文档流、快捷新建/上传;最近分“我编辑的(updatedBy)/我浏览的(本地记录)”。
- 收藏:`Favorites`(`views/home.js:7`)按用户 localStorage;文档树「更多」可收藏/取消,收藏页可移除,闭环。
- 命令面板:`views/palette.js:26`,动作 + 文档/文件分组、空输入最近、↑↓/Enter/Esc、管理员用户/空间捷径。
- 空间设置抽屉:`SpaceSettings.open`(`views/project.js:257`)480px 右侧抽屉。
- 抽屉概览:名称/描述/颜色/配额条/可见性;成员:搜索、角色筛选、多选批量改角色/移出、统一 personPicker、权限说明、带资源计数确认。
- 抽屉危险区:转让(仅真实 OWNER)/归档/解除归档/输入空间名删除/退出。
- `SpaceWizard`(`views/project.js:705`)创建空间统一选人;`#/p/{pid}/members|settings` 同一抽屉。
- 设置页:`views/settings.js:19` 左子导航 + 右内容;资料(姓名/邮箱/头像色)自动保存并同步 App.user。
- 设置页还包括改密、PAT、本人会话(当前设备/逐条踢/全部踢)、主题/种子色/密度/编辑器字号(`--fs-prose`,编辑与预览联动)/语言。

### 设计系统与初始化
- `tokens.css`:三层表面、4/6/10/14 圆角、8 档字阶、低饱和六色、150/200/300 动效、密度块(`:338`)、`--topbar-h/--drawer-w`。
- `components.css`:M3 filled 输入、44px 列表行、卡片发丝线。
- `ui.js`:新增 `UI.empty`(`:300`)、`UI.error`(`:1363`)、`UI.drawer`(`:764`),新代码已使用。
- 登录品牌卡与两步初始化:建管理员 → 首空间/邀请(`app.js:557`)。

### 真实验证
- 开工基线:`uv run pytest ../tests/test_frontend_refs.py ../tests/test_render_contract.py ../tests/test_layout_contract.py ../tests/test_editor_cm6.py -q` → **17 passed in 8.06s**。
- 波末定向(最终复跑):`uv run pytest ../tests/test_frontend_refs.py ../tests/test_render_contract.py ../tests/test_layout_contract.py ../tests/test_page_assets.py ../tests/test_editor_cm6.py ../tests/test_visual_sweep.py ../tests/test_join_drill.py ../tests/test_doc_move_drill.py -q` → **24 passed in 34.50s**(同组多次复跑 34.50–64.72s,均为 24 passed)。
- 单域复核:`test_page_assets` 1 passed(5.0s);`test_visual_sweep` 3 passed(19.6s);`test_join_drill + test_doc_move_drill + test_render_contract` 7 passed(8.6s)。
- 未跑全量快速组(按用户口径留给 lead);未跑 `test_markdown_diagram`(既有 Mermaid SVG id 基线失败不修)。

## B. 偏差、并行集成与未验项
- 并行在飞已落地:`css/drive.css`、`css/admin.css`、`views/admin/overview.js` 在波内出现,`test_page_assets` 转绿。
- admin 改为 W2-c 的六分区左子导航;`test_visual_sweep` 管理后台脚本改为“六子导航 + 切 users/security + 用户详情抽屉”。
- 管理后台用户抽屉由 W2-c 用 `UI.modal + .admin-drawer-box` 实现;空间设置抽屉用本工单 `UI.drawer`。
- W2-d 端点波内落地且契约匹配:`PATCH /api/users/me` 返回 `{user}` 只收 name/email/avatarColor;`DELETE /api/auth/sessions` 返回 `{ok,revoked}`。
- W2-d 的 `Project` 带 color/quotaBytes/archivedAt/storageBytes;`search` 带 projectId/updatedBy;创建空间接收 `members`。
- W2-b `drive.js` 已调用 `Endpoints.fileVersions/fileVersionUpload/fileRestore/fileChanges` 与 `fileDownload(id,inline,version)`;路径按 interfaces 增补。
- `Views.filesLevel` 已透传 `dispose: ctx.dispose`(`views/project.js:240`)。
- 测试更新(只改壳/路由真的变了处):`test_render_contract` 探针 `#side-projects` → `#side-nav`。
- `test_layout_contract` dualPanel 消费方只剩 `app.js`;`test_page_assets` 探针改顶栏/空间切换/左栏导航/树槽位。
- `test_visual_sweep` 左栏交互改为空间切换器 + Ctrl+K + 文档树折叠,并加分页 `#/projects`、设置两页。
- `test_join_drill` 改为看顶栏空间名;加入后落点保留 `docs`(新成员先看内容)。
- 未验:空间设置抽屉的成员批量/色彩/配额/归档/转让只有路由与无 JS 错误巡检,没有真实点击流水。
- 未验:设置资料自动保存、头像色、会话踢除、PAT 新建未做浏览器流水;命令面板 Enter 与管理员捷径未端到端。
- 未验:窄屏只经无头 Chrome 默认视口(≤960)验证结构与无错,未做人工视觉。
- 禁触遗留:`views/doc-editor.js` 的可选 `onTreeToggle` 分支仍在(本工单不传,`#btn-doc-tree` 不渲染)。
- 禁触遗留:`editor.css` 的 `body.doc-focus-mode .doc-tree-col` 变为无效选择器(专注模式仍隐藏 `#sidebar`);建议 lead 后续清理。

## C. 关键指针
- 壳/路由:`js/app.js:49/106/179/315/411/557`;`js/route.js:26/82/87/93/106`。
- 首页/收藏/面板:`js/views/home.js:7/52/85/219/272`;`js/views/palette.js:26/122/148/211`。
- 文档树:`js/views/docs.js:21/27/149`;`js/views/doc-tree.js` 的 `setActive` 容忍空树。
- 空间抽屉/向导:`js/views/project.js:72/96/105/257/708`;云空间 `:240`。
- 设置:`js/views/settings.js:19/42/134/160/266`。
- UI/主题/端点:`js/ui.js:300/764/1364`;`js/theme.js:52/104`;`js/endpoints.js:33/35/50/52/79-83/101`。
- 样式:`css/app.css:15/90/151/163/253/345/395/455`;`css/tokens.css:104/107/338`;`css/components.css` 输入/列表行/卡片段。
- 测试:`tests/test_render_contract.py`、`test_layout_contract.py`、`test_page_assets.py`、`test_visual_sweep.py`、`test_join_drill.py`;`test_doc_move_drill.py` 未改仍绿。
