# W2-c 管理后台分区交接包
> 当前工作区直接修改 / 无分支、无 commit / 2026-11-05 23:51（UTC+8）

## A. 交付与公开接口

### 分区装配（`lite/web/js/views/admin.js`）
- `SECTIONS`（`:14`）：`overview / users / projects / storage / backup / security`，子导航顺序、图标、文案唯一来源。
- `Views.adminSections`（`:56`）：只读元数据 `[{key,label,icon}]`，命令面板管理员直达可直接用 `Route.admin(key)` + 这份列表。
- `Views.adminLevel(route)`（`:58`）：作用域工厂。`key: 'admin:<section>'`，切区由 Scope 重建这一层，不会把六区叠成长页。
- 分区解析（`:27`–`:47`）：`route.section`（W2-a 在 `Route.resolve` 里算好）→ `segs[2]`（规范写法）→ `segs[1]`（`#/admin/{section}` 的真实语法），非法/旧书签回落 `overview`。
- 每区仍是工厂 `{key, load}`；`ctx.refresh(...keys)`（`:98`）只重取已挂载分区（未挂载键为空操作），`ctx.state` 保留跨区共享；新增 `ctx.openSection(key)`（`:101`）供总览待办跳转。
- 分区脚本缺失时给出可见错误横幅，不静默白屏。

### 新增总览（`lite/web/js/views/admin/overview.js`）
- 唯一数据源 `Endpoints.adminOverview()`（`:205`），不在前端另算统计。
- 用户数/空间数/今日登录/锁定 `UI.statGrid`；磁盘占比环 + 应用构成条（`:32`）；近配额待办（`:95`，服务端 `ratio` 优先）；锁定/备份待办（`:137`）。
- 备份状态兼容 `backup.status()` 的 `{config,last,nextRun}` 形状。

### 用户区（`lite/web/js/views/admin/users.js`）
- 44px 行（CSS `admin.css:76`）、搜索姓名/邮箱、chips 全部/管理员/禁用/7 日活跃、多选批量启禁用（`:459`）。
- 新建/编辑/重置密码/禁用/删除保留；禁用前会按需取 `adminProjects` 找“唯一所有者”空间并提示。
- 用户详情改为 480px 右侧抽屉（`:695`，复用 `UI.modal` 的 Esc/遮罩/堆栈，仅换几何）：身份/所属空间/锁定/会话/事件。
- 所属空间卡（`:516`）：行内改角色、移出、加入空间（统一 `pp-item` 选择浮层 + 角色选择，`:292`）；与空间区成员抽屉读写同一组 `/api/projects/{id}/members`。
- “所属空间数”由 `ensureIndex()`（`:100`）拉 `/api/projects?all=1` 后逐空间取成员归并；失败显示 `—`，不伪造 0。

### 空间区（`lite/web/js/views/admin/projects.js`）
- 列：空间/所有者/成员数/用量（配额百分比）/创建时间；搜索名称、描述、所有者。
- 新建（`:127`）、归档/解除归档（`:145`，校验响应确实带回 `archivedAt`，避免前端假成功）、删除、转让（`:206`）。
- 成员入口打开本域 480px 成员抽屉（`:265`）：加成员（统一 personPicker 多选 + 每人角色）、改角色、移出；归档空间显示警告并禁用写操作。
- 转让只列该空间现有、未禁用的非 OWNER 成员（`:167`），并在非真实 OWNER 发起时直接提示 —— 与服务端“仅真实 OWNER 可转让、目标必须已是成员”的规则一致。

### 存储/备份/安全
- `storage.js:93`、`backup.js:137` 仅补统一骨架加载，原有能力/流水线不动。
- `security.js`（`:17`）保留登录动态与仅失败过滤；新增节流状态卡（`:78`）：当前锁定账号（可解锁）、`diagnostics.loginLocks`、登录事件总量。

### 样式（`lite/web/css/admin.css`）
- 左子导航 + 分区两栏（`:7`）；44px 用户行（`:76`）；480px 右侧抽屉（`:87`–`:104`）；总览环/配额条；`acts-4`。
- 窄屏单列 + 横向单子导航 + 抽屉全屏（`:232` 起的形态块，已按布局契约标注“契约身份 1”）。

## B. 真实测试结果

- 基线（开工）：`cd lite/server && uv run pytest ../tests/test_smoke_endpoints.py -q` → **1 passed in 7.45s**。
- 波末验收：`uv run pytest ../tests/test_smoke_endpoints.py ../tests/test_session_audit.py ../tests/test_admin_storage.py ../tests/test_admin_sections.py -q` → **12 passed**（首跑 29.74s，最终复跑 13.22s）。
- 额外静态契约：`test_frontend_refs.py`、`test_layout_contract.py` 与本域一起跑 → **19 passed in 26.57s**。
- 新增 `lite/tests/test_admin_sections.py`（1 个浏览器用例，无 Chrome 时按既有惯例 skip）：真实 DOM 中验证
  - 6 个分区注册与缺省 `overview`、切区只挂一层；
  - 总览只请求 `/api/admin/overview` 且渲染服务端字段/存储环/近配额；
  - 用户 44px 行、搜索、4 chips、多选、所属空间数、480 drawer + 所属空间卡/角色/加入入口；
  - 空间区搜索/成员入口、成员抽屉 480 与成员行；
  - 未知分区回落 overview；
  - 回归钉住“resolve 传入的 route 优先于尚未更新的 Route.current”（否则切区慢一拍）。
- 真实 app.js 动态加载手工抽验（临时页，未提交）：`#/admin/users` 用户行/抽屉/所属空间卡、`#/admin/projects`、storage、backup、security 均渲染，`errors=none`。普通 index 的完整回归仍由 W2-a/lead 复验。

## C. 集成要求 / 依赖现状

- W2-a 已提供并实测可用：`App.loadAdmin()`（脚本顺序 overview→storage→backup→projects→users→security→admin）、`Route.admin(section)`、`Endpoints.adminOverview()`、index 已引入 `css/admin.css`。
- W2-d 已提供并实测可用：`/api/admin/overview`、`POST /api/projects/{id}/transfer`、`archivedAt/quotaBytes` 与归档写守卫。
- **分区取段的关键坑**：W2-a 的 `Route.resolve` 在 `Route.setCurrent` **之前**调用 `Views.adminLevel(r)`；只读 `Route.current()` 会拿到上一条路由，导致每次切区渲染慢一拍。当前实现优先使用传入 route（`route.section` 已在 W2-a 的 resolve 中算好），再回落 `Route.current()`。后续改路由时不要退回“只读 current”。
- 命令面板管理员直达：使用 `Views.adminSections` + `Route.admin(key)`，不要手拼 hash。
- 既有 `lite/tests/test_visual_sweep.py::test_admin_sections_and_interactions` 仍按“一屏竖排五区”断言（`#admin-store`/`#admin-backup`/`#admin-projects`/`#admin-body`/`#admin-security` 同时在 `#/admin`）。本工单禁触该文件；实测其为 **登录 200、JS errors=none，但旧选择器全部落空**。需由 W2-a/lead 改为逐区导航后断言（建议：默认 `#/admin` 查 `.admin-storage-figure`/统计卡；再依次 `#/admin/storage|backup|projects|users|security`，用户详情按钮 `.u-access`、抽屉 `.admin-drawer-box`；`#sec-filter`/`#sec-body` 保留不变）。
- 普通用户不下载 admin 代码由 W2-a 的测试负责；本域未往全局注入自动加载。

## D. 偏差与取舍

1. 规范写 `Route.current().segs[2]`；实际 `#/admin/{section}` 是 `segs[1]`，且 spec 构造早于 `setCurrent`。实现按 `route.section → segs[2] → segs[1]` 解析，并优先传参 route；这是功能正确所必需，已用测试钉住。
2. 服务端没有“按用户列成员关系”接口，用户列表的所属空间数与详情卡由管理端 `?all=1` + 逐空间成员请求归并（30 人规模可接受）。失败只显示 `—`，不猜数。
3. 成员接口不返回加入时间，抽屉显示“空间创建于 …”而非成员加入时间；如需真实加入时间，需 W2-d 在 `_member_json` 增加 `createdAt`。
4. 转让严格对齐服务端：非真实 OWNER（含仅在权限上等效的全局管理员）不能发起；目标必须是现有非 OWNER 成员。若产品要求“管理员可强制转让”，需 W2-d 放宽服务端语义。
5. 新建空间用紧凑表单（名称/描述），成员在抽屉里邀请；`formModal` 内嵌统一选人器会破坏单层表单语义，未做。
6. 安全区未加 PAT 审计（没有管理端 PAT 读取接口）；现有登录动态 + 节流状态已覆盖工单要求。
7. 批量启禁用逐用户 PATCH（服务端无批量端点），`UI.eachOk` 汇总成功/失败。

## E. 关键指针

- 装配/取段：`lite/web/js/views/admin.js:14`、`:27`、`:39`、`:56`、`:58`。
- 总览：`lite/web/js/views/admin/overview.js:32`、`:95`、`:137`、`:200`。
- 用户：`lite/web/js/views/admin/users.js:100`、`:146`、`:177`、`:292`、`:459`、`:516`、`:695`。
- 空间：`lite/web/js/views/admin/projects.js:112`、`:145`、`:167`、`:206`、`:265`。
- 安全：`lite/web/js/views/admin/security.js:78`、`:93`。
- 存储/备份骨架：`storage.js:93`、`backup.js:137`。
- 样式：`lite/web/css/admin.css:7`、`:76`、`:87`、`:232`。
- 测试：`lite/tests/test_admin_sections.py:23`（页面）、`:169`（取段回归）、`:236`（用例）。

## F. 未验项

- 未跑全量快速组（按用户口径由 lead 统一跑）；未跑 slow 组。
- 真实 index 下的归档/转让/加成员写操作只做了代码与接口对照，未在浏览器里逐项点击（W2-a/lead 复验）。
- 窄屏 480→全屏抽屉与横向子导航仅按 CSS/布局契约静态验证，未做移动端截图抽验。
- `test_visual_sweep.py` 的旧管理后台断言仍红（原因见 C），等待 W2-a/lead 更新后复跑。
- 浏览器用例在无 Chrome/Edge 环境按 `pytest.mark.browser` 惯例 skip。
