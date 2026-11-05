# W5 · 设计刻度、移动端与状态统一 交接包
> 分支 `wave/w5-polish`；worktree `C:\Users\shifu\.worktrees\teamdoc\w5-polish`；基线 `f8681a8`；2026-11-06（UTC+8）

## 提交
- `b432449` style(tokens): 收敛三层表面与 8 档字阶，行高 44、按钮默认 sm
- `90c10f9` style(web): 组件/壳/云空间/后台迁移新刻度，补窄屏触控 40 与表格横滚
- `bb21e91` refactor(web): 空态与错误统一使用 UI.empty/UI.error
- 本文件所在 commit（T4：刻度令牌契约 + 交接）

## A. 变更、真实命令与结果

### 基线（开工先跑）
```
cd lite/server && uv run pytest ../tests -q
→ 1 failed, 180 passed, 1 skipped, 3 deselected, 19 warnings in 109.61s
唯一失败：test_markdown_diagram.py::test_markdown_extensions_in_browser（登记的 Mermaid 切主题 SVG id 基线）
```

### T1 令牌收口（`tokens.css` 为主）
- 表面收敛为 3 层：`--md-surface`（画布）/ `--md-surface-container-low`（侧栏、卡槽）/ `--md-surface-container-high`（弹层、抽屉、抬起的输入框）。`lowest / container / highest / dim` 定义与全部消费者删除；grep 0 引用。
- 字阶 8 档并逐档配行高：display 28/34 · headline 22/28 · title-lg 16/24 · title 14/20 · body 14/22 · prose 16/26 · label 13/18 · caption 12/16。所有 `font-size: var(--fs-*)` 声明同一规则内紧跟配对 `line-height: var(--lh-*)`。
- `--row-h: 52px → 44px`；云空间/后台用户表保留显式 44px 局部声明（与全局同档）；`hv-list` 48px 等更高的局部行保持局部覆盖。
- 按钮默认 sm：`.btn` 回退高度 `--ctl-xl(40) → --ctl-m(32)`，主操作由所在容器把 `--ctl-h` 提升到 36/40（`.page-actions`/`.modal-foot`/`.form-inline`）；`.btn-lg` 仍为 48。
- 状态层：hover 8% / pressed 10%；为 `.btn` 各变体、`.btn-icon`、`.side-item`、`.tree-row`、`.menu-item`、`.cmd-row`、`.chip`、`.crumb-item`、`.pp-item`、`.notify-item`、`.home-doc-row`、切换器行、`.admin-nav-item`、`.seg button`、`.tree-caret`、`.doc-tool-btn` 补 `:active`；`.btn-icon:hover` 从旧 10% 改正为 8%。
- 输入 focus ring `0 0 0 1px → 2px`；toast 3200 → **3000ms**。
- 文档树/侧栏选中：`primary-container` 胶囊改为浅灰底（`on-surface` 14% 选中层）+ 左侧 2px 主色条（`inset 2px 0`），圆角降为 `--radius-m`；后台左子导航同规则。

令牌映射（旧 → 新）：
| 旧 | 新 |
|---|---|
| `--md-surface-container-lowest` | `--md-surface-container-high`（弹层/抽屉/登录卡/输入框/瓦片操作条） |
| `--md-surface-container` | 按语义拆到 `-low`（bs-step、df-gap/hunk 头）或 `-high`（模态框、菜单） |
| `--md-surface-container-highest` | `-high`（输入框/badge/tint）、`-low`（seg 轨道、代码语言角标）、`outline-variant`（滚动条/转圈/环形与配额轨道）、state-layer（cmd-row） |
| `--md-surface-dim` | 删除（无消费者） |
| `--fs-title:16px` | `--fs-title-lg:16px` |
| `--fs-subtitle:14px` | `--fs-title:14px` |
| `--fs-sm:13px` | `--fs-label:13px` |
| `--fs-label:12px` | `--fs-caption:12px` |
| `--fs-xs:11px` | `--fs-caption:12px` |
| `--fs-display/headline/body/prose` | 名称不变（prose 仍 16） |
| `--lh-tight/normal/loose` | 删除；改用 8 个配对 `--lh-*`。`--lh-loose` 保留为 `var(--lh-prose)` 别名，因为 `js/editor/theme.js` 仍按此名消费（编辑器内核/主题不在本波写入范围） |
| `--row-h:52px` | `44px` |
| `--focus-ring 1px` | `2px` |
| toast `3200ms` | `3000ms` |

### T2 移动端
- ≤960 统一触控目标 ≥40px：`.btn`、`.btn-icon`、`.menu-item`、`.tree-row`、`.cmd-row`、`.side-item`、`.seg button`、`.chip`、`.pp-item`、`.crumb-item`、切换器/通知行、`.admin-nav-item`；`.btn-icon` 宽高取 `max(40px, …)`，行内操作列宽 `--col-acts` 同步按 40px 重算，避免按钮撑破列宽。
- 表格横向滚动容器：`.data-table` 自身改为 `overflow-x:auto; overflow-y:hidden`，表头/数据行 `min-width: var(--table-min, 640px)`；云空间 860、后台用户/空间 720。删除 components.css 与 drive.css 的 ≤720 纵向堆叠重排，列语义保留（窄屏 512px：clientWidth 479 / scrollWidth 860，表头 `display:grid`）。
- 云空间窄屏列表、编辑器底部工具条（7 键、高 40）、版本抽屉全屏（512=innerWidth）、设置抽屉全屏（512=innerWidth）均以临时浏览器探针验证；宽屏版本抽屉 400、设置抽屉 480。
- 修复历史遗留顺序问题：设置抽屉的 `width:100%` 原先写在基础 `.drawer-box` 之前被覆盖；本波移到文末 960 块并补 `border-radius:0`。

### T3 状态统一
- `doc-editor` 历史版本：空态改 `UI.emptyHtml`（列表 sm / 预览带引导），catch 改 `UI.error`；大纲空态、编辑器资源失败、文档打不开也用统一原语。
- `admin/users`：删除 `.admin-table-empty` 包裹；会话/登录记录空态改 `UI.emptyHtml`；空间选人器 `pp-empty` 改 `UI.emptyHtml`。`admin/projects` 同步去掉私有包裹。
- 其他 grep 命中：`admin/security` 锁定冷却空态、`admin/overview` 存储数据缺失、`admin/storage` 缺文件记录错误、`admin.js` 分区脚本缺失、`preview.js` 预览失败、`ui.js` 成员选人器空态/错误。
- 删除私有空态类 `.pp-empty`、`.admin-table-empty`、`.doc-outline-empty` 及重复样式；空/加载/错误/成功文案与主操作语义未改。

### T4 测试收敛
- 四个受保护测试文件中没有因本波刻度/类名变化失效的断言（`test_layout_contract`/`test_render_contract`/`test_visual_sweep`/`test_page_assets` 未改任何旧断言，全部原样通过）。
- 四个文件中原本也没有“只钉旧像素/旧类名”的脆弱断言可删；`test_drive_versions.py` 的 `height:44px` 与 `test_admin_sections.py` 的 44px 行高断言仍然成立，且文件不在本波写入范围，未动。
- 作为 T4 的持久化契约，在 `test_layout_contract.py:106` 新增 `test_design_scale_is_converged`：机器校验表面恰好 3 层、字阶恰好 8 档且每档有配对行高、旧表面/字阶/行高令牌 0 回流。替代一次性 grep 证据，不新增测试文件。

### 门禁（真实输出）
```
cd lite/server && uv run pytest ../tests -q
→ 1 failed, 181 passed, 1 skipped, 3 deselected, 19 warnings in 106.97s
唯一失败仍为 test_markdown_diagram.py::test_markdown_extensions_in_browser（Mermaid 基线）

uv run pytest ../tests -m slow -q
→ 3 passed, 183 deselected in 10.52s

uv run pytest ../tests/test_layout_contract.py ../tests/test_render_contract.py \
  ../tests/test_visual_sweep.py ../tests/test_page_assets.py -q
→ 14 passed in 22.11s
```

### grep 证据
```
grep -rn -e "surface-container-lowest" -e "surface-container-highest" \
  -e "--md-surface-container)" -e "--md-surface-dim" \
  -e "--fs-subtitle" -e "--fs-sm" -e "--fs-xs" \
  -e "--lh-tight" -e "--lh-normal" lite/web --include=*.css --include=*.js
→ 0 匹配

grep -rn "max-width: 960" lite/web/css lite/web/js
→ app.css:341（既有壳形态块）、app.css:694（本波新增触控块）、
  app.css:653（既有 .settings-page max-width，非媒体查询）、ui.js:1626（UI.NARROW）
→ 没有扩散到其他 CSS/视图
```

### 临时浏览器抽验（跑完已删，未入库）
临时页 `_w5_probe.html` + 临时 pytest 用例，真实 app.js/CSS、真实服务端；窗口 1280×900 与 390×844（headless 实际 innerWidth 1258 / 512），每档均 `errors=none`：
- 宽屏（1258）：`narrow=0`；`.btn` 32、`.btn-icon` 36、`.menu-item` 36px；表格不横滚（962/962）；版本抽屉 400、设置抽屉 480；编辑器工具条隐藏；树行 32。
- 窄屏（512）：`narrow=1`；`.btn` 40、`.btn-icon` 40、`.menu-item` 40px、`.tree-row` 40px、`.cmd-row` 40px、行内版本按钮 40；表格横滚（client 479 / scroll 860）且表头 `display:grid`；版本抽屉 512=`innerWidth` 且 `is-narrow`；设置抽屉 512、圆角 0；编辑器底部工具条 `display:flex`、7 键、每键 40；保存圆点存在且非透明；树选中行 `box-shadow` 为 `… 2px 0 0 0 inset`。

## B. 偏差、坑与未验项
- **提交拆分**：T1 的令牌定义在 commit 1；T1 的组件/视图消费者与 T2 的窄屏规则同处 app/components/drive/admin/editor 五个 CSS 文件，无法按文件再拆，故合并为 commit 2（message 同时写明 T1 消费者迁移与 T2）。T3/T4 各自独立 commit。
- **`--lh-loose` 别名保留**：`js/editor/theme.js`（编辑器主题，禁触）仍消费该名；值为 `var(--lh-prose)`，语义等同新 prose 配对行高。删除它会静默丢掉 CM 行高。
- **prose 行高用比例**：`--lh-prose: 1.625`（默认 16/26），因为个人设置允许把 `--fs-prose` 调到 13–20；其余 7 档为 px。`.pref-preview` 同理保留 `line-height:1.6` 以跟随字号滑块。
- **表格滚动实现**：没有新增包裹 div（视图在 tableHead 之后继续拼行，包裹层会割裂 `--tpl` 继承）；改为让 `.data-table` 自身成为滚动容器，表头/行用 `--table-min` 撑最小宽度。这是共享组件层的一处改动，不是逐视图复制。窄屏不再重排为纵向卡片，列语义由横向滚动保留。
- **抽屉断点**：`UI.drawer`（设置/空间设置）与版本抽屉在 ≤960 全屏；后台 `admin-drawer-box` 仍按 W4 契约在 ≤720 全屏，800px 下保持 480（`test_admin_sections` 明确断言 480，且该测试不在本波写入范围）。
- **微信/移动端触控**：仅无头 Chrome 的 `--window-size` 模拟，未上真实触屏/移动浏览器；`(hover:none)` 常显的瓦片操作条未重复验证（W4 已验）。
- **主题对比度**：浅/深主题下新选中态、2px 主色条、按钮 active 层未逐主题截图核对；仅验证计算样式与无 JS 错误。
- **表格长内容**：未用超长文件名/26 位 ULID 在 512px 下逐列核对横向滚动观感；`--table-min` 的 640/720/860 为固定档，极端窄容器仍依赖横滚。
- **T4 未删除任何旧断言**：四个受保护文件里本就没有旧像素/旧类名断言；新增的令牌契约测试是唯一测试改动。
- 未执行 merge/push/tag；未触碰主检出、`.venv` 目标、`lite/server/**`、editor 内核/vendor、Endpoints/路由文案、其他 worker handoff。

## C. 关键指针（当前文件行号）
- 令牌：`lite/web/css/tokens.css:44`（row-h）、`:52-59`（8 档字阶）、`:62-69`（配对行高）、`:72`（--lh-loose 别名）、`:93`（2px focus ring）、`:198-200`/`:227-229`（浅/深三层表面）。
- 组件：`lite/web/css/components.css:25-33`（.btn 默认 32）、`:46`（.btn-sm）、`:83-104`（.btn-icon + active）、`:127`（输入框 high）、`:414-423`（模态 high）、`:515-527`（菜单 high）、`:580-596`（空态字阶）、`:733-754`（表格滚动容器 + min-width）。
- 壳/移动端：`lite/web/css/app.css:287-295`（侧栏选中）、`:498-505`（树选中）、`:517-518`（树箭头 hover/active）、`:691-723`（≤960 触控与抽屉全屏）。
- 云空间/后台：`lite/web/css/drive.css:7`（44px 行）、`:11`（--table-min 860）、`:95`（版本抽屉全屏）；`lite/web/css/admin.css:47-57`（后台导航选中）、`:82-88`（用户 44px + 表格 min-width）。
- 编辑器：`lite/web/css/editor.css:111-113`（h1/h2/h3 配对行高）、`:511-545`（底部工具条 40px）。
- 原语与状态：`lite/web/js/ui.js:637`（toast 3000）、`:281`（emptyState）、`:1372`（error）、`:1002-1010`（选人器空态）、`:1075`（选人器错误）。
- 视图状态：`lite/web/js/views/doc-editor.js:215`（大纲空态）、`:893`/`:935`（错误）、`:994-1000`（历史版本空态）、`:1055`（历史版本错误）；`views/admin/users.js:253`/`:375`/`:715`/`:733`；`views/admin/projects.js:221`；`views/admin/security.js:97`；`views/admin/overview.js:75`；`views/admin/storage.js:79`；`views/admin.js:110`；`preview.js:76`。
- 测试：`lite/tests/test_layout_contract.py:106`（新增刻度收敛契约）。
