# W7 · 前端整体重构清理 交接包
> 分支 `wave/w7-frontend-cleanup`；worktree `C:\Users\shifu\.worktrees\teamdoc\w7-frontend-cleanup`；基线 `da997a4`；2026-11-06（UTC+8）
> 范围：`lite/web/**`、前端测试、`lite/ARCHITECTURE.md`、`lite/tests/README.md`、本 handoff。零交互/路由/接口/视觉契约变更（唯一例外见 B1 路由引用修复）。

## 提交
- `94018c7` refactor(web): 收敛角色/日期/偏好/活跃时间重复原语（T1）
- `bc00c14` refactor(web): 删除最近动态孤儿模块与失效导出/CSS（T2）
- `a9d3518` test(web): 删除脆弱静态断言，云空间版本改为行为巡检（T3）
- `f777014` docs(web): 更新前端模块边界与测试保留口径（T4）
- 本 handoff 所在 commit

## A. 交付与真实验证

### A0. 基线（开工，原样）
```
cd lite/server && uv run pytest ../tests -q
→ 1 failed, 178 passed, 1 skipped, 3 deselected, 19 warnings in 112.20s
  唯一失败：test_markdown_diagram.py::test_markdown_extensions_in_browser（登记的 Mermaid 切主题 SVG id 基线）

uv run pytest ../tests -m slow -q
→ 3 passed, 180 deselected in 9.85s
```

### A1. T1 共享原语收敛（旧 → 新）

| 旧副本 | 新唯一实现 | 调用点 |
|---|---|---|
| `views/project.js` 本地 `ROLE_RANK = {VIEWER:1,…}`（降级判断 2 处） | `UI.roleRank`（已存在，原仅内部用） | `project.js:566/607` |
| `admin/users.js`、`admin/projects.js` 各自 `ROLES = ['OWNER',…]` | `UI.ROLES` | `admin/users.js`、`admin/projects.js:10` |
| 4 处手写角色 `<option>`（`project.js` 2、`admin/users.js` 2、`admin/projects.js` 1） | `UI.roleOptions(selected, roles)` | `project.js:526/547`、`admin/users.js:354/588`、`admin/projects.js:50` |
| `views/drive.js` 本地 `parseWhen`（UTC naive 解析正则） | `UI.parseDate`（原为 ui.js 私有） | `drive.js:49` |
| `views/project.js` 本地 `lastActiveText` 与 `admin/users.js memberMeta` 内联判定 | `UI.lastActiveText`（有值/显式 null/缺字段三态） | `project.js:534`、`admin/users.js:573` |
| `app.js` 最近浏览、`home.js` 收藏各自 `JSON.parse/stringify(localStorage)` + try/catch | `UI.pref.getJSON / setJSON` | `app.js:570/573/577`、`home.js:11-12` |
| `views/project.js` 成员行 44px 与权限卡 sticky 的内联 style | `app.css` 的 `.ss-member` / `.ss-perms` | `app.css:643/645` |

grep 证据（定义只剩 ui.js 一份）：
```
grep -rn "function parseWhen\|hasTz\|function lastActiveText\|JSON.parse(localStorage" lite/web/js
→ 仅 ui.js:parseDate(hasTz) / lastActiveText / pref.getJSON

grep -rn "\['OWNER', 'ADMIN', 'EDITOR', 'VIEWER'\]\|ROLE_RANK\s*=" lite/web/js
→ 仅 ui.js:ROLE_RANK / ROLES
```

**盘点后不合并的项（避免造抽象/改视觉）**：
- 成员行：空间设置（复选框 + 44px + 角色下拉/徽章 + sticky 权限卡）、管理后台成员抽屉（UI.listRow + 角色下拉/移出）、用户详情「所属空间」（空间名 + 加入/活跃副行）三处结构不同、能力不同；已共用 `UI.listRow/avatar/badge/roleOptions/lastActiveText`，不再强行合并 DOM。
- 事件委托：通用层已有 `UI.floatingLayer/dropdownMenu/segWire/sortHead/crumbsWire/closeOpenMenu`；剩余各视图的 `closest()` 处理器都是业务动作，没有第二份通用实现。
- DOM 构建/错误提示：全部走 `UI.*` 工厂与 `UI.err/UI.error/UI.errorBanner`，无本地副本。
- 字数/阅读时长：`views/doc-editor.js:198-206` 与 `editor/markdown.js:117-127` 仍是两份算法。视图按架构约束只能用 `DocEditor` 门面，直接读 `DocEditorKit.markdown` 会破坏边界；给门面加 `getStats()` 属新增能力，不在 W7（见 C1）。

### A2. T2 死代码/死 CSS/失效注释

删除文件：
- `lite/web/js/views/recent.js`（`window.Recent`，W4-c 后无消费者）与 `index.html` 对应 script。
- `test_frontend_refs.py` 的 `Recent` 模块与 `must_have` 项同步移除。

删除 0 引用导出/赋值（均给 0 引用 grep）：
| 符号 | 处理 | 证据 |
|---|---|---|
| `Endpoints.docAppend` | 删除 | 全仓 0 调用 |
| `UI.panelOpenByDefault` | 从导出面删除，内部函数保留（`dualPanel` 仍用） | `UI.panelOpenByDefault` 0 |
| `Route.lastTab` | 从导出面删除，内部函数保留（`resolve` 仍用） | `Route.lastTab` 0 |
| `window.ApiError` | 删除全局赋值，`ApiError` 类仍在 api.js 内部使用 | `window.ApiError` 0 |
| `AdminSections.RESULT_META` | 删除导出赋值，`RESULT_META` 仍在本文件内用 | `AdminSections.RESULT_META` 0 |
| `Ref` 生成函数 `doc/file/fileChip/image/attachment/mustId/openDoc/openFile` | 从导出面删除，内部函数保留；`Ref.parse/downloadUrl/docChip/fileMarkdown/text/url` 保留 | `Ref.fileChip` 外部 0 |

删除死 CSS/令牌：
- `components.css`：`.result-list`、`.toolbar-title`、`.data-table.acts-6`、`.list-row.raised`/`.hoverable`/`.clamp-2`（含 `listRow` 的 `raised/hoverable/tag/href/subClamp` 参数）。
- `base.css`：`.p-2` / `.p-4`。
- `app.css`：`.drive-table` 的 `--acts-n: 6`（`drive.css` 已声明 8）。
- `editor.css`：`.editor-head .head-more` / `.head-more.conflict`（按钮从未挂该类；`head-more-status/presence` 保留）。
- `tokens.css`：`--w-read`、`--motion-slow`、`--ease-decelerate`（0 消费）。
- 注：`--w-read` 删除后，ARCHITECTURE 的阅读列宽改为实际值 `minmax(0, 800px)`。

失效注释/残留引用：
- `markdown.js` 的 `doceditor.js` → `ref.js` + editor.css chip。
- `palette.js` 的“原 #/search 整页”历史说明 → 当前“搜索唯一入口”。
- `drive.js` 的“搜索页/搜索结果跳进来” → 命令面板；`ui.js`/`projects.js` 的发现页措辞改为“发现空间页签”。
- `doc-tree-col`、`onTreeToggle` 等旧引用已在 W4 清理，本次 grep 0。

grep 证据：
```
grep -rn "window.Recent\|Recent\.\|views/recent\|spaceSettingsLevel" lite/web lite/tests → 0 matches
ls lite/web/js/views/recent.js → No such file
grep -rnE "\.data-table\.acts-6|\.(result-list|toolbar-title|p-2|p-4)\s*\{|\.list-row\.(raised|hoverable)|\.clamp-2|\.editor-head \.head-more(\.conflict)?\s*\{" lite/web/css → 0 matches
grep -rn "docAppend\|window.ApiError\|AdminSections.RESULT_META\|Ref.fileChip\|Route.lastTab\|lastTab: lastTab\|panelOpenByDefault: panelOpenByDefault" lite/web/js lite/tests → 0 matches
grep -rn -- "--w-read\|--motion-slow\|--ease-decelerate" lite/web/css → 0 matches
grep -rn "'/api/\|\"/api/" lite/web/js | grep -v endpoints.js → 0 matches（视图无路径字面量；仅注释存在 /api 文本）
```

### A3. T3 测试收敛

测试总数：**180 选中 → 173 选中（-7）**；快速组 **178 passed → 171 passed**，唯一失败仍为 Mermaid 基线。

删除/收敛清单与覆盖来源：
| 删除项 | 原断言 | 覆盖来源 |
|---|---|---|
| `test_layout_contract.py::test_design_scale_is_converged` | 精确表面/字阶令牌清单 | 机制约束由同文件其余 5 项布局契约 + `test_visual_sweep` 浏览器巡检守；令牌仍被 shared CSS 消费 |
| `test_drive_versions.py` 7 项静态字符串 | 函数名/类名/正则/`height:44px`/`width:min(400px…)` | 收敛为 1 条 `test_drive_version_actions_and_timeline`（真实 `driveBody` + 桩数据层）：宽屏瓦片 3 个版本入口、窄屏强制列表且网格按钮禁用、行内版本入口、抽屉 2 版且备注“修复表格排版”、当前版徽标、非当前版恢复入口、版本下载 URL 带 `version=2`、右键菜单复用入口、排序点击带 `sort=name`/`dir=desc` 重新取数、选中单文件后工具条出现“上传新版本”、`dispose` 关闭抽屉 |
| 同上：同名 409 两个重试分支（`name_mode=keep` / `version_of`） | 源码字符串 | `test_file_versions.py::test_duplicate_409_keep_and_version_of`（服务端两分支 + 互斥 400）；前端 409 弹窗未再做浏览器文件选择（见 C2） |
| 同上：变更轮询 `nextSeq`/`setInterval`/`clearInterval` | 源码字符串 | `test_file_versions.py::test_file_changes_cover_delete_restore_rename_and_cross_project_move`、`test_permanent_delete_preserves_delete_change_for_polling`（服务端变更流）；前端 `dispose` 行为由新用例守 |
| 同上：`updatedByName` 冲突窗文案 | 源码字符串 | 服务端 409 字段由 `test_file_versions`/`test_smoke_endpoints` 守；前端渲染未做浏览器断言（见 C2） |
| `test_editor_cm6.py::test_view_uses_only_facade…` 的 `lastSaved = conflict.content`、`runCommand/doc-toolbar/td:doc-split/td:preview-link/状态栏五 id` | 实现字符串 | 同文件浏览器用例已覆盖：facade 的 `runCommand`、宽屏分栏/折叠与联动、窄屏工具条 7 键与状态栏 5 项；静态只留“视图不得绕过 DocEditor 门面” |
| `test_visual_sweep.py::test_admin_sections_and_interactions` 的分区导航/默认分区/用户抽屉断言 | 与 `test_admin_sections.py` 重复 | `test_admin_sections.py` 的行为用例（子导航 6 分区、路由取段、用户/空间抽屉、深链、PAT、配额）；visual sweep 仅保留真实 app.js 动态加载下的“仅失败”过滤（重命名 `test_admin_security_failure_filter`） |

保留（明确不删）：`test_page_assets.py`（零外链/资源可达）、`test_frontend_refs.py`（导出面）、`test_layout_contract.py` 其余 5 项、`test_render_contract.py` 3 静态 + 1 浏览器、`test_editor_cm6.py` 8 行为、`test_admin_sections.py`、`test_visual_sweep.py` 逐页/路由/过滤、`test_join_drill.py`、`test_doc_move_drill.py`。

测试基础设施：`_chrome.dump_page` 新增可选 `window_size`（宽屏网格用例需要），无头模式改为 `--headless=new`。旧 `--headless` 在本机存在普通 Chrome 进程时会吞掉 URL（dump 出 new-tab 页），导致 browser 用例整体假红；新无头在同样环境稳定。

### A4. T4 文档
- `ARCHITECTURE.md`：
  - 前端文件表补 `UI` 共享原语职责，明确搜索=`views/palette.js`、最近/收藏=`views/home.js`、发现=空间切换器页签，无独立整页模块。
  - 单一来源清单新增：`UI.esc`、`UI.parseDate/fmtDate*/fmtWhen`、`UI.ROLES/roleOptions`、`UI.lastActiveText`、`UI.pref.getJSON/setJSON`。
  - 阅读列宽由不存在的 `--w-read 880` 改为实际 `minmax(0, 800px)`；代码约定补“共享原语只走 ui.js”。
- `tests/README.md`：新增 `test_editor_cm6`、`test_layout_contract`、`test_drive_versions`、`test_admin_sections` 行；`test_visual_sweep` 描述改为真实动态加载 + 失败过滤；新增「前端测试保留口径」说明行为/契约/架构三类保留理由。

### A5. 波末验收（真实输出）
```
cd lite/server && uv run pytest ../tests -q
→ 1 failed, 171 passed, 1 skipped, 3 deselected, 19 warnings in 110.09s
  唯一失败：test_markdown_diagram.py::test_markdown_extensions_in_browser（Mermaid 基线）

uv run pytest ../tests -m slow -q
→ 3 passed, 173 deselected in 10.48s

uv run pytest ../tests/test_page_assets.py ../tests/test_render_contract.py \
  ../tests/test_visual_sweep.py ../tests/test_join_drill.py \
  ../tests/test_doc_move_drill.py ../tests/test_frontend_refs.py -q
→ 13 passed in 27.67s
```

真实浏览器抽验（临时探针，跑完删；真实服务端 + 真实 index/app.js；宽 1280×900、窄 500×900）：
- 宽屏：`errors=none`；首页 `.home-page=1`；文档源码 `# 抽验标题 这是一段正文`、预览可见且文本为“抽验标题”；云空间网格 1 个文件瓦片、版本抽屉 2 版、备注“第二版备注”；个人设置 `.settings-page=1`；空间设置抽屉打开（`#/p/{pid}/settings` 路由引用修复生效）；管理后台 6 个子导航项。
- 窄屏：`errors=none`；同上首页/编辑/预览/云空间列表 1 行/版本抽屉 2 版/设置/空间设置/管理后台；编辑器底部工具条 `display:flex`、状态栏 5 项。
- 两种宽度均无 `window.onerror`/`console.error`。

## B. 偏差、取舍与未验项

**B1. 路由引用修复（唯一行为修复）**
- `route.js` 的空间设置 NAV 项原调用不存在的 `Views.spaceSettingsLevel`（实际定义是 `Views.projectSettingsLevel`）。`#/p/{pid}/settings` 会落进壳错误态但 hash 正确，因此旧巡检只查 hash/errors 没发现。已改为 `Views.projectSettingsLevel`；浏览器抽验 `spaceSettings=1`。这是恢复既有路由契约，不是新增交互。

**B2. `--headless=new`**
- 测试底座从旧 `--headless` 改为 `--headless=new`。原因：本机有普通 Chrome 进程时旧无头会把 URL 吞掉，dump 出 new-tab 页（所有 browser 用例假红）。新无头下 `test_visual_sweep`/`test_render_contract`/`test_editor_cm6`/`test_admin_sections`/`test_drive_versions` 全绿；对无 Chrome 环境仍是自动 skip。

**B3. `UI.panelOpenByDefault` / `Route.lastTab` 只删导出面**
- 两者仍在模块内部被 `dualPanel` / `resolve` 使用；删除的是 0 外部引用的导出键。ARCHITECTURE 的单一来源表述仍指向内部函数。

**B4. 成员行没有合并成一个通用渲染器**
- 三处成员/空间行的能力与几何不同（复选框/44px/sticky 权限卡 vs 抽屉行 vs 所属空间行）；强行统一会改 DOM 与视觉契约。已统一其共享原语（`UI.listRow/avatar/badge/roleOptions/lastActiveText`）。

**B5. 未验/已知缺口**
- 云空间同名 409 的前端冲突弹窗（保留两个/创建新版本）没有浏览器文件选择流水；服务端两分支由 `test_file_versions` 覆盖，前端只确认了入口与端点（见 A3）。
- 版本恢复按钮的确认弹窗未在自动化中点击（抽屉中已断言“非当前版恰好一个恢复入口”）；服务端恢复语义由 `test_file_versions` 覆盖。
- 变更轮询的前端 15s 定时器不再有源码字符串断言；`dispose` 关闭抽屉已测，定时器清理依赖同一 `cleanup`（服务端变更流由 `test_file_versions` 覆盖）。
- 浏览器抽验窄屏为 500×900（`UI.NARROW` 命中 `<960`）；未做 390 手机宽的真实触屏流水。
- `test_markdown_diagram` Mermaid 切主题 SVG id 失败仍为登记基线，不属本波范围。

## C. 关键指针（当前行号）
- 共享原语：`web/js/ui.js:71`（parseDate）、`:101`（lastActiveText）、`:147`（ROLES）、`:151`（roleOptions）、`:1498`（pref）、`:1506`（getJSON）。
- 消费点：`views/project.js:433/526/534/547/566/607`；`views/admin/users.js:354/573/588`；`views/admin/projects.js:10/50`；`views/drive.js:49`；`app.js:570-577`；`views/home.js:11-12`。
- 路由修复：`web/js/route.js:45`。
- 样式：`web/css/app.css:643`（.ss-member）、`:645`（.ss-perms）。
- 测试：`tests/test_drive_versions.py:197`（行为用例，宽/窄两次 dump）；`tests/test_visual_sweep.py:306`（失败过滤）；`tests/test_editor_cm6.py:56`（门面边界）；`tests/_chrome.py:80`（dump_page/window_size/新无头）。
- 文档：`lite/ARCHITECTURE.md` §2 前端文件表、§3 单一来源、§4 布局契约阅读列；`lite/tests/README.md`「前端测试保留口径」。

## D. 未决（留给 W8/后续）
- 是否给 `DocEditor` 门面增加 `getStats()`，以消除 doc-editor 与 editor/markdown.js 的字数/阅读时长双实现（属新增能力，W7 未做）。
- 云空间 409 冲突弹窗、版本恢复确认的前端真实文件/点击流水（需要 CDP 注入文件或额外 harness 能力），可在 W8 核心路径抽验中补。
- `--headless=new` 已在本机验证；若 W8 机器 Chrome 版本过旧（<112）需回退或加能力探测。
