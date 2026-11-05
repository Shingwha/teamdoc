# TeamDoc 架构与代码地图

面向要改这份代码的人(以及下一个 AI 会话)。只讲**当下**的设计:没有历史沿革、没有迁移
章节、没有"以前是怎么做的" —— 需要知道过去请查 git 历史。

## 1. 它是什么

小团队自部署的文档 + 云空间服务。单进程、单 worker、SQLite、零构建步骤的前端。
面向 30 人内网规模。

```
cd lite/server && uv sync && uv run uvicorn main:app --host 0.0.0.0 --port 8000   # 必须单 worker
```

部署、环境变量、备份与恢复见 `DEPLOY.md`;Markdown 语法契约见 `MARKDOWN.md`。

## 2. 代码地图

### 后端 `lite/server/`(平铺模块,互相直接 import)

| 模块 | 职责 |
|---|---|
| `config.py` | **全部环境变量的读取与校验**;有效限额字典(管理后台展示它) |
| `errors.py` | **全部 HTTP 错误码常量 + `err()` / `bad_request()`** |
| `serialize.py` | **全部响应形状**:`user_json/project_json/doc_json/file_json/...` 的 face |
| `ids.py` | ULID 生成与形状判定;`IdPath`(路径参数类型) |
| `db.py` | 引擎、请求级会话、`release_db`、`utcnow`、`is_live` |
| `storage.py` | 数据目录 / DB 路径 / 物理名 / 磁盘余量与 INFLIGHT 登记 |
| `treeutil.py` | 文档树构建、子树收集、排序位、位置信息 |
| `http_util.py` | 通用字段解析与 `client_ip/client_ua` |
| `security/` | 密码、会话、PAT、权限上下文(不反向依赖 router/service) |
| `services/` | 业务:spaces/docs/files/versions/trash/search/backup/audit/users |
| `routers/` | 薄 HTTP/WS 入口,只做解析、调用服务与序列化 |
| `schema.py` | 建表 + 迁移补列 + 结构自检(不一致就拒绝启动) |
| `media.py` | mime 判定与 inline 白名单(**安全边界,勿放宽**) |
| `throttle.py` / `logsetup.py` / `watchdog.py` | 节流机制、非阻塞日志、事件循环卡顿转储 |

### 前端 `lite/web/`(静态页,无构建步骤)

`index.html` 里的 `<script>` 顺序**就是依赖图**,加文件要放对位置。

| 文件 | 职责 |
|---|---|
| `js/endpoints.js` | **全部后端路径的构造处**(只有这里出现 `/api/...` 字面量) |
| `js/api.js` | fetch 封装、错误信封解析、401 的全局处理 |
| `js/route.js` | 路由文法:hash ↔ 路由事实(`Route.resolve` 纯解析、`Route.NAV` 模块导航表、`Route.project/settings/admin` 串构造点)。**视图分派只在这里** |
| `js/scopes.js` | 渲染机制:作用域链的复用/重建/卸载与片段挂载(见「渲染契约」) |
| `js/app.js` | 壳(40px 顶栏 + 左栏 + 单一内容面)+ 空间切换器/通知/用户菜单 + 路由入口 + 登录与两步初始化;`App.loadAdmin()` 是 admin 脚本的唯一加载处 |
| `js/ui.js` | 组件与工具库;角色判定镜像 `UI.can*`;`UI.empty/UI.error`/`UI.loadInto`;`UI.drawer`(480 右侧抽屉);`UI.dualPanel`(壳侧栏唯一面板原语);共享原语:转义、UTC 时间解析与日期格式、角色顺序/下拉、最后活跃文案、JSON 偏好读写 |
| `js/ref.js` | 引用契约的前端半边(与 `refs.py` 逐字对齐) |
| `js/markdown.js` | Markdown 渲染栈(本地 vendor:marked / Prism / KaTeX / Mermaid) |
| `js/preview.js` | 站内预览浮层;`Preview.kindOf` 是"怎么预览"的唯一判定 |
| `js/views/home.js` | 空间首页(`#/` 与 `#/p/{pid}/home`)/ 最近 / 收藏与本机收藏存储 |
| `js/views/palette.js` | Ctrl+K 命令面板(动作 + 文档/文件 + 管理员捷径);**站内搜索唯一入口** |
| `js/views/*.js` | 其他视图(= 作用域工厂:`XxxLevel(...)` 返回一层作用域描述) |

搜索、最近动态与发现空间都没有独立整页模块:搜索在 `views/palette.js`,最近/收藏在
`views/home.js`,发现空间是 `app.js` 空间切换器的页签。新增入口不得再建同名整页。

### 编辑器 `js/editor/`(CM6 的唯一入口)

`index.html` 按固定顺序加载:vendor bundle → `markdown` → `keymap` → `theme` → `extensions` → `panels` → `index`。顺序即依赖图,不可换。

| 文件 | 职责 |
|---|---|
| `js/editor/markdown.js` | **纯文本变换**(无 DOM/无 CM):行内格式、块格式、链接、代码块、表格、标题解析、字数统计。Node 可直接 require(测试用它) |
| `js/editor/keymap.js` | 编辑器键位:保存/格式化快捷键 + `markdownKeymap`(列表/引用/待办回车续行、Backspace 删标记)。自定义绑定在前,表格回车优先认领 Enter |
| `js/editor/theme.js` | CM6 主题与高亮样式(颜色全部取自 `tokens.css` 的 `--md-*` 令牌,亮/暗自动跟随) |
| `js/editor/extensions.js` | 基础扩展(历史、选区、括号、搜索、只读/可编辑)、三连反引号补闭合围栏(inputHandler,绕开 IME 组字)、编辑器内 Mod-k 截获(链接插入由门面执行,不冒泡到全局命令面板) |
| `js/editor/panels.js` | 编辑器内浮层与交互:`@`/`[[` 引用候选、`/` 插入菜单、附件上传与拖放、选区浮动工具条 |
| `js/editor/index.js` | **`DocEditor` 门面**:`mount(host, options)` 返回 `getValue/setValue/insertText/insertRef/focus/getCursor/getHeadings/scrollToHeading/setPreviewVisible/runCommand/destroy` |

硬约束:

- **CodeMirror 只出现在 `js/editor/` 与 `web/vendor/codemirror/`**。视图、壳、其他模块不得出现 `CM6` 字样或直接 import/引用 CM 包。
- **视图只用 `DocEditor` 门面**。文档视图(`views/doc-editor.js`)不碰编辑器状态;窄屏工具条也经 `runCommand(name)`,不自己拼结论文本。程序化 `setValue` 不触发 `onChange`;用户编辑一次事务一次回调。
- **vendor 是构建产物,不是运行时依赖**:`cd lite/tools/editor && npm ci --ignore-scripts && npm run build` 生成 `web/vendor/codemirror/editor.bundle.js`(esbuild IIFE,`--global-name=CM6`),产物提交入库;运行时只加载本地 IIFE,无 CDN、无外链、无浏览器内构建。
- `tools/editor/package.json` 的依赖全部锁死精确版本(无 `^`/`~`),`package-lock.json` 一并提交;升级 CM 必须同时重建 bundle 并跑 `tests/test_editor_cm6.py`。

### 启动顺序(`main.py`,改动前先读那一段)

日志装配 → `apply_pending_restore()`(替换库文件,**必须在建表之前**)→ `schema.init()`
→ 路由注册 → 静态托管(必须最后,否则 `/` 吃掉所有 API 路径)→ 备份线程。

## 3. 单一来源清单

改这些地方时,只需要改一处 —— 这是本仓库最重要的约定。

| 知识 | 唯一来源 | 谁在消费 |
|---|---|---|
| 表结构 | `models.py` | `schema.init` 建表与自检、备份校验 |
| 环境变量与限额 | `config.py` | 所有模块、管理后台「存储」的 limits |
| 错误码 | `errors.py` 的常量 | 后端全部错误路径、前端按 code 分支 |
| 响应形状 | `serialize.py` 的 face | 所有端点 |
| 时间戳格式 | `serialize.iso()` | 所有响应的日期字段 |
| ULID 生成与形状 | `ids.py` | 表主键默认值、`IdPath`、取参校验 |
| 权限判定 | `security/context.py` 的 `project_role`(+ `has_role`/`ensure_project_role`/`require_project_role`) | 全部端点、WS、前端 `UI.can*` 镜像 |
| "已删即不存在" | `db.is_live` | REST(404)与 WS(4404) |
| 前端转义 | `UI.esc` | 全部动态文本拼接 |
| 服务端时间解析/格式化 | `UI.parseDate` / `UI.fmtDate*` / `UI.fmtWhen` | 列表、详情、版本历史 |
| 角色顺序与下拉 | `UI.ROLES` / `UI.roleOptions` | 空间设置、管理后台用户/空间区 |
| 最后活跃文案 | `UI.lastActiveText` | 空间设置成员行、用户详情「所属空间」 |
| 本地 JSON 偏好 | `UI.pref.getJSON/setJSON` | 最近浏览、收藏 |
| 引用语法 | `services/refs.py` / `ref.js` | 反链、被引用标记、移动前提示、编辑器插入 |
| 文件物理名 | `storage.storage_basename` | 下载、孤儿扫描、备份打包 |
| 磁盘余量 | `storage.disk_free_bytes` | 上传前预检、写盘复查、存储总览、恢复前检查 |
| 预览方式 | `Preview.kindOf` | 云空间预览按钮、文档 @引用浮层 |
| 空间统计 | `services/spaces.batch_stats` | 空间列表、广场、管理后台 |
| 后端路径 | `endpoints.js` | 全部视图 |
| 视图分派 | `route.js` 的 `Route.resolve` + `Route.NAV` | `app.js` 的路由入口、左栏导航、后台项目区的模块直达按钮 |
| 命名空间路由 | `Route.project/settings/admin` | 视图、左栏、空间切换器、命令面板;视图不手拼路由串 |
| Admin 脚本 | `App.loadAdmin()` 的按序列表 | 仅管理员路由调用;普通用户不请求 admin JS |
| 文档树 | `views/docs.js` 写入 `#side-doc-tree` | 左栏唯一树;主区不再有第二棵树 |
| 编辑器 | `js/editor/index.js` 的 `DocEditor` 门面 | 文档视图;取值、设值、插入、命令、预览可见性都不绕过门面 |
| 作用域身份/复用边界 | 各视图 `XxxLevel(...)` 的 `key` | `scopes.js`(比对键决定复用还是重建) |
| 页面模式(窄页/满高) | `route.js` 的 `MODE_CLASS` | `scopes.js` 在换层时设到宿主上;视图不得自己加类 |
| 面板初始开/关 | `ui.js` 的 `panelOpenByDefault` | `UI.dualPanel`(壳侧栏唯一消费方) |
| 回收站响应 | `services/trash._result()` | 九个变更端点 |
| 登录节流策略 | `security/sessions.LOGIN_*_POLICY` | 登录、自助改密、管理后台解锁 |

## 4. 契约

### id

ULID 字符串(26 位 Crockford base32)。**只有一种形态**:不是数字、不带前缀。
路径参数走 `ids.IdPath`(形状不对 → 400),payload 走 `auth.id_field`/`opt_id`。
不合法就是 400,不会"悄悄归一成另一种写法"。

### 引用(正文里指向站内资源)

两种形态,都是普通 Markdown 链接,**两种都要认**:

```
chip     [@标题](teamdoc://doc/{docId})    文档
         [@名称](teamdoc://file/{fileId})   文件
附件/内嵌 [名称](/api/files/{fileId}/download)
         ![名称](/api/files/{fileId}/download?inline=1)
```

- chip 是编辑器 @ 菜单给出的形态;下载链接是手写附件与内嵌图片的形态。只认一种,
  另一种引用的文件在删除时就得不到"被 N 篇文档引用"的提醒。
- 引用里**只出现资源自己的 id**(不带项目 id):项目归属会变(文档可跨项目移动),
  引用必须跟着资源走。
- 判定必须同源:服务端 `refs.py`,前端 `ref.js`;消费方(反链 / 被引用标记 / 移动前提示)
  不得各写一份正则。

### 错误

响应信封固定为 `{"detail": {"code": ..., "message": ...}}`。

- **code 是机器判据** —— 前端与 CLI 按它分支(`READ_ONLY_TOKEN` 决定提示"换个令牌",
  `JOIN_REQUIRED` 决定提示"去发现页加入")。改 code 等于改契约。
- **message 是人话** —— 文案随时可改,调用方不得嗅探其中的字样。
- 401 一律附带清会话 Cookie:会话失效后浏览器仍会重放死 Cookie,不清掉就是每个视图
  撞一次 401,而它自己不会消失。

### 权限金字塔

```
project_role          有效角色 = max(成员角色, 全局管理员兜底 ADMIN);都不是 → None
  └ has_role          角色比较只此一处
      └ ensure_project_role   不足则 403(公开项目给 JOIN_REQUIRED)
          └ require_project_role / require_role   路径参数端点用
```

- 全局管理员是有效角色的**下限**:加入一个 `join_role=VIEWER` 的项目不会把管理能力降级。
- **公开项目不产生读权限**:公开只等于"可发现 + 可自助加入",加入前一律 403。
- 个人空间对管理员也关闭(列表、搜索、按 id 直连都不给)。
- 前端 `UI.canRead/canEdit/canAdmin/canOwn` 是这套判定的镜像;视图不得自己比角色。

### 文档写入

- `PUT /content` 是整篇覆盖:**web 会话必须带 `baseVersion`**(浏览器手里有缓冲,
  不声明就会让陈旧标签页静默盖回去);PAT 缺省即覆盖(程序化写入不持有缓冲)。
- `append` 与 `versions/restore` 是服务端读-改-写,不需要基线。
- 这条规则只在 `docs.resolve_base_version` 一处判定,端点不得自己决定。
- 冲突返回 409,并把服务端当前正文(`currentVersion`/`currentContent`/`by`)一并带回;
  WS 的 `conflict` 消息同形 —— "冲突现场"是一个契约,两个传输层共用形状。

### 参数

**严格**:取值域外的参数一律 400,不静默回退默认值。整型就是 JSON 整数,布尔就是
JSON true/false。静默回退会让"传错了却看不出"的调用方一直传错,而服务端一切正常 ——
这类静默的数据偏差比一个明确的 400 难查得多。

### 布局契约(响应式的唯一规矩)

四轮重构收敛出的铁律,改任何布局前读这段。历史教训:锁宽错位、视口断点猜列宽、
边距阶梯突变、面板状态双布尔 —— 全是"用错机制表达概念"。每个概念有且只有一种合法机制:

**几何(间距/宽度)只有两种存在形式,media query 里禁止出现间距/宽度赋值:**
1. **令牌** —— `tokens.css` 的 `--w-*`(区域宽)/ `--sp-*`(间距档)/ `--g-*`(连续边距)
2. **连续函数** —— `clamp(min, 参照, max)`,参照是 `vw`(视口驱动面,如 `--g-page`)或
   `cqw`(容器驱动面,如 `--editor-x`)。拖动时值逐帧连续,物理上没有突变点。
   注意 `cqw`/容器查询要设在**消费子元素**上:容器元素自身的容器单位/查询条件解析到外层。

**断点只有三种身份,新增断点必须在块注释里注明身份:**
1. **形态** —— 960,唯一:内联 ↔ 浮层抽屉(唯一物理离散的切换)。CSS 侧在 app.css,
   JS 侧唯一来源 `UI.NARROW`(ui.js)
2. **密度** —— 控件收纳/重排:编辑器容器查询 600/380、列表页 720(`.row-time`、
   表格重排)。右缘锚定,不引起边距跳变
3. **body 挂载浮层** —— 不在容器内只能按视口:`.menu.panel` 宽度

**面板状态只有 `UI.dualPanel` 一个原语**:一个用户意图 = 一个布尔 = 一个类;
「开」的宽屏形态是内联、「开」的窄屏形态是抽屉,各一条 CSS 规则,断点两侧零同步代码;
拖窗口**只换形态不换开/关**。新面板 = 一次 `dualPanel` 调用 + 两条渲染规则 + 下表加一行,
不得自造第二套状态变量。当前只有壳侧栏一个消费方:文档树已在左栏内,不是独立面板。

**区域几何盘点(唯一来源):**

| 区域 | 宽 | 形态(宽/窄) | 边距 | 来源 |
|---|---|---|---|---|
| 顶栏 | 40,全宽 | 单行 | sp-3 | app.css + `--topbar-h` |
| 壳侧栏 | 240 / 折叠 64 | 内联 / 图标列;窄屏抽屉 | sp-2 | app.css + `--sidebar-w*` |
| 左栏文档树 | 随侧栏 | 侧栏内嵌;折叠态隐藏 | 行 sp-3,缩进 `--tree-indent` | app.css + `views/docs.js` |
| 页面 #view | ≤ `--w-page` 1120 / narrow 800 | 单页 | `--g-page` 连续 | app.css + tokens |
| 设置页 | 180 + 内容 | 两栏;窄屏单栏 | sp-6 | app.css |
| 抽屉 | `--drawer-w` 480 | 右侧;窄屏全屏 | sp-4 | app.css + `UI.drawer` |
| 编辑器列 | 弹性 | — | `--editor-x` 连续(4cqw) | editor.css |
| 阅读列 | 中列 `minmax(0, 800px)`,居中 | — | 列-gap sp-8 | editor.css |

违例检测仪:`tests/test_layout_contract.py`(静态扫描:媒体查询块须带身份注释,或零间距/宽度赋值)。

### 渲染契约(切页面时谁被重建的唯一规矩)

要改路由、加页面、动视图挂载方式之前读这段。历史教训:整块销毁重建 —— 切一篇文档也要
把侧栏、文档树、项目对象全部重来一遍,用户看到"旧页消失 → 转圈 → 空两栏 → 内容"。
根因不是某个函数写错了,是**渲染单元太粗**:系统里没有任何东西能说"这还是同一个项目"。

**一个界面 = 一串作用域,键不变即复用:**

```
#/p/x/docs/D  →  [ p/x(空间:空间对象) → p/x/docs(文档模块:左栏树) → p/x/docs/D(文档位:编辑器) ]
#/              →  [ home #/ (解析记忆空间;无空间时显示管理入口) ]
#/settings/T    →  [ settings/T ]
```

每个作用域是 `{key, render(ctx, props), child(), onChild(props)}`;walker(`scopes.js`)比
对键:**键相同的那几层原样留着**(DOM、闭包状态、监听、WebSocket 全不动),键变了才重建那
一层及其子树。规约八条:

1. **键要含本层渲染依赖的一切路由输入**。父层不变而更深的路由片段变了(切文档),用
   `Route.current()` 现读,不闭包快照 —— 复用的层不会重建,闭包里的 docId 会停在第一次的值。
2. **只交节点、不套壳**:`render` 返回 `DocumentFragment`,节点直接落进上层槽位。DOM 层级与
   "视图直接写容器"时逐字相同 —— 布局契约里的直接子选择器(`#view.view-fill #proj-body`、
   `#proj-body > .docs-wrap`)靠这条继续成立。**禁止中间包裹元素**。
3. **挂载路径上没有 await**:`render` 同步画出骨架(含最终几何)并返回,数据由本层自己的
   异步填充负责。等待期只能出现在新层自己的区域内,永不把已有内容换成加载态。
   骨架用 `UI.skeleton`(转圈行只用于区域内部的短等待)。
4. **父层决定子层**:`ctx.mount(slot)` 交出子层挂载点(可以晚到 —— 数据到手再调;不调用就
   没有子层),子层描述由 `child()` 在挂载那一刻产出,拿到的自然是父层当前状态。权限不足 /
   加载失败时父层画错误态、不挂子层,这条错误路径不必每个模块各写一遍。
5. **槽位永远有层**:没有"子层走了父层要恢复什么"这种事(未选文档也是一个层)。少一个特例,
   就少一处会忘的恢复代码。
6. **晚到的响应写进的是脱离文档的节点**:`ctx.alive()` / `node.isConnected` 一问就知道要不要
   继续。作用域被换掉后,旧响应物理上不可能污染新页面 —— 竞态由结构消灭,不靠散点守卫。
   片段在挂载时会被搬空:渲染后还要用的元素在同步段抓好引用,或用 `ctx.query(sel)` 现查。
7. **清理归本层**:`ctx.dispose(fn)` 注册(WS、全局监听、离开守卫),随本层被换掉时执行。
   没有全局清理注册表。
8. **页面模式是路由表的事实**(`Route.NAV` 的 `mode`),由 walker 设到宿主上;视图不得自己
   往容器上加 `view-fill`/`page-narrow`。

**数据的生命期 = 显示它的区域的生存期**(不引入客户端缓存):离开就丢、回来重新取。多用户
下"别人改了什么"不可枚举,缓存必然引出失效策略这个新的失败面 —— 这一层的价值是渲染粒度,
不是请求次数。代价:空间对象是**进入空间时的快照**,空间内的计数(成员数/文档数)在停留期间
可能偏旧;改空间自身的入口(设置抽屉)改完当场 `App.refresh()` 或重取当前层。

`App.refresh()` = 丢掉现有链整条按当前路由重建(页面身份变了才用它,例如刚加入一个空间 ——
错误态的键没变,只让那一层自己重取不够,因为"能不能看"是上游层的数据)。只是本层数据变了的
场合,让那一层自己重取更轻。

违例检测仪:`tests/test_render_contract.py`(静态:#view 只许路由层碰、分派只在路由表、视图
不得加页面模式类;浏览器:切文档后左栏导航与文档树的**节点身份**不变、不重新取空间对象与文档树;
离开文档模块再回来,文档树重建)。

## 5. 代码约定

1. **注释只讲当下的约束**("为什么必须这样"),不讲"以前如何""为了兼容谁"。需要历史查 git。
2. **不留兼容分支**:同一个东西不接受第二种写法。契约变了就同步改两端 —— 两端都是我们的。
3. **不留迁移代码**:结构与 `models.py` 不一致的库拒绝启动,不做就地改造。
4. **不存派生值**:表里只放无法重算的事实(例如文件类型由名字推导,不落列)。
5. **错误与响应形状**从 `errors.py` / `serialize.py` 取,不在端点里手拼。
6. **路径**从 `endpoints.js` 取,视图里不出现 `/api/` 字面量。
7. 前端组件优先复用 `UI.loadInto`(加载/错误/空态三态)与 `UI.confirmAction`(确认后执行),
   而不是每个视图各写一遍;转义/时间/角色/最后活跃/JSON 偏好也只走 `ui.js` 的单一实现。
8. **视图就是一个作用域工厂**(`XxxLevel(...)` 返回 `{key, render, child}`):渲染与挂载的
   规矩见「渲染契约」。加一个页面/模块 = 在 `Route.resolve` 或 `Route.NAV` 里挂一个工厂,
   不在 `app.js` 里加分派。

## 6. 已知边界

- 单 worker:SQLite 单写者。并发上传会排队;长 I/O 前必须 `release_db()`。
- 云空间列表已分页(100/页,服务端排序),单目录文件夹上限 2000。
- 单次打包上限 1000 个文件 / `ZIP_MAX_BYTES_MB`(默认 4GB)。
- 搜索与回收站单次 500 条截断(超出会少结果/少列)。
- `referenced`(被引用徽标)每次列目录都扫本项目文档正文;文档上千后应改成引用索引表。
- 文档版本按年龄分层保留(稳态约 124 条/文档),不需要手工清理。
- 不做两步验证(内网自部署 + 30 人规模,价值低于"禁用账号 + 可吊销 PAT")。
- 前端不留活作用域:切走再回来会重建(数据重新取)。文档树的折叠态按空间记着(与左栏
  展开态同口径),但树的滚动位置不保留;跨模块 keep-alive 是另一套机制,不做。
- 收藏与"我浏览的"存 localStorage(方案未给数据模型),换设备/换浏览器不同步。
- 管理后台脚本由 `App.loadAdmin()` 按需注入;普通用户不会请求 admin JS,但没有独立构建产物。
- 首屏(登录页/未登录探测)不在作用域机制里:它是另一条根(`#login-root`)且与登录态同生共死。

## 7. 测试

```bash
cd lite/server
uv run pytest ../tests              # 默认跳过 slow 组
uv run pytest ../tests -m slow      # 弹性/压测
```

脚手架(`tests/_harness.py`)每次会话自建隔离实例:临时数据目录 + 空闲端口 + 真实子进程,
所以测试可以随便造数据、也能测"重启后生效"这类行为。浏览器类用例需要无头 Chrome,
环境缺失时自动跳过。

改契约前先看对应测试:它们是契约的第二次声明(`test_auth_cookie` 盯会话边界,
`test_id_contract` 盯 id 与引用,`test_smoke_endpoints` 打全部路由,`test_doc_conflict`
盯写入基线,`test_frontend_refs` 静态盯"前端调了没导出的函数",`test_render_contract`
盯"切页面只重建该重建的那一层",`test_layout_contract` 盯布局契约)。测试文件与
`lite/tests/README.md` 是同一份信息的两个粒度。
