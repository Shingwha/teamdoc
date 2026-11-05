# W4-b · 编辑器补齐 交接包
> 当前工作区直接修改 / 无分支、无 commit / 2026-11-06

## A. 变更、接口与真实验证

### T1 Markdown 续行与速录（`tools/editor/src/index.js`、`js/editor/{keymap,extensions}.js`、`web/vendor/codemirror/**`）
- bundle 新增导出：`markdownKeymap`、`insertNewlineContinueMarkup`、`deleteMarkupBackward`、`ViewPlugin`。
- `js/editor/keymap.js:38-49` 安装 `C.markdownKeymap`，位置在自定义绑定之后（表格回车先由本文件的 Enter 认领，其余 Enter/Backspace 交给它）。`- `、`1. `、`> `、`- [ ] ` 回车续行，Backspace 删标记可用。
- `js/editor/extensions.js:9-23` 三连反引号：`inputHandler` 在「行内恰好已有两个反引号 + 光标在行尾」时一次写成 ```` ```\n\n``` ```` 并把光标放到第 2 行；`view.composing` 为真直接放行，不抢 IME。测试实测值 `'```\n\n```'`、`getCursor().line === 2`。
- `# ` / `- ` / `> ` 在源码模式本就是 Markdown 语法，**不做文本转换**（本波保持原样，只补 Enter 续行）。表格回车仍由 `markdown.js::tableRowAtEnter` 处理，先于 markdownKeymap。

### T2 Ctrl+K 冲突（`js/editor/extensions.js:28-43`）
- `ViewPlugin` 在 `view.dom`（`.cm-editor`）上以 **capture** 监听 keydown；只认不带 Shift/Alt 的 Mod-k。
- 命中时 `preventDefault + stopPropagation`，事件不再到达 `document` 上的全局命令面板；链接插入由门面 `io.command('link')` 执行（capture 截住后 CM 的 target/keymap 不再收到，所以必须由守卫自己派发同一命令，避免二次弹窗）。只读编辑器不拦，Mod-k 仍交给全局面板。
- keymap 里保留 `Mod-k → link` 作为直接使用 keymap 时的绑定；正常挂载路径被守卫遮蔽（实测只弹 1 个链接对话框 `modKModals=1`）。
- 编辑器外 Mod-k 不变（真实验证见测试页 `modKGlobal=0`）。

### T3 大纲跟随滚动（`js/views/doc-editor.js:219-288`、`css/editor.css:510-513`）
- 高亮来源：预览态按滚动位置判定（`offsetTop` 内容内位置 + 滚动容器当前 `scrollTop`，阈值 24px）；分栏时若最后由源码侧滚动驱动，则按字符比例取最近标题；**编辑态仍退回光标行**（`activeOutlineId`）。
- 刷新用 rAF 节流（`scheduleOutlineActive`），并加一次 100ms 兜底（后台标签页/无渲染帧环境 rAF 不触发时高亮不会停在旧位置）。
- 点击跳转保留：编辑态走门面 `scrollToHeading`；预览态直接滚预览容器到对应标题。
- `<1280` 大纲按钮与大纲一起 `display:none`，不再出现“点了没反应”。
- 测试实测：1400px 下点开大纲 → 首节高亮「小节 1」；滚动到底后高亮变化（`outlineMoved=1`）。

### T4 宽屏预览 pane（`js/views/doc-editor.js:290-390`、`css/editor.css:484-507`、`js/editor/index.js`）
- 默认仍是同栏切换；`≥1280px` 且预览态时显示右侧 pane（`.preview-split`），源码继续可编辑。
- 新增独立折叠按钮 `#btn-doc-split`（编辑头，宽屏预览时可见）：收起后预览独占内容列、源码隐藏；偏好 `td:doc-split`（`'0'` = 收起，缺省展开）。`setPreviewVisible` 语义不变（传“是否分栏”）。
- 双向滚动联动按比例：源码侧真实滚动容器是 CM 的 `.cm-scroller`（不是外层 `.md-source`，后者只给几何），预览侧是 `#md-preview`；两边互相驱动并用单帧锁防回环。`td:preview-link` 读法按 W4-c 契约：`UI.pref.get('td:preview-link','true') !== 'false'`，关闭时不同步。
- 销毁时移除 scroll 监听、取消 outline rAF（`ctx.dispose`）。
- 测试实测（1400×900）：分栏 `split=1`、源码可见、折叠按钮可见；折叠后 `previewStill=1`、`td:doc-split='0'`、可再展开；关闭联动时源码滚动预览不动（`linkOffTop=0`），开启后源码→预览 `linkOnTop=202`、预览→源码 `reverseTop=240`。

### T5 文档头与状态栏（`js/views/doc-editor.js:27-73/147-207`、`css/editor.css:413-445`）
- 保存状态改为「圆点 + 文字」：`#save-status`/`#doc-save-state` 内含 `.status-dot`，`data-state=ok|busy|warn|error` 决定颜色（文字仍是唯一人读事实：已保存/保存中…/保存失败/未保存/只读/有冲突未解决）。
- 保存按钮降为 `tonal`；历史按钮从编辑头移除，统一收进 `⋯` 菜单（`buildMoreMenu` 的「历史版本」）。
- 元信息行 = 空间 · 更新时间 · 字数（`renderMeta`）。
- 底部状态栏五项分开：`#doc-words` / `#doc-read` / `#doc-cursor` / `#doc-save-state`(圆点+文字) / `#doc-space`；窄屏只收紧间距与空间名宽度，不隐藏任何项（`css/editor.css:549-555`，块内注明密度契约身份）。

### T6 移动端底部工具条（`js/editor/index.js:168-172`、`js/views/doc-editor.js:62-73/788-799`、`css/editor.css:515-555`）
- 门面新增 `runCommand(name)`，直接复用既有 `commands.run`（bold/italic/code/link/quote/ordered/unordered/todo/heading/table/codeBlock）。
- `#doc-toolbar` 只在可编辑文档、`≤720px` 显示（CSS `display:flex`），固定浮在状态栏之上；七个按钮：加粗/斜体/行内代码/链接/引用/无序列表/待办。
- 触控目标 `max(40px, var(--ctl-xl))`，紧凑密度下也不低于 40；`mousedown` 阻止默认以保持选区与焦点；点击后（除 link 走地址对话框）回焦编辑器。
- 测试实测（390×844）：`toolbarDisplay=flex`、7 个按钮、按钮高度 40、状态栏 5 项全部可见、`#btn-doc-outline` 隐藏。

### T7 ARCHITECTURE（`lite/ARCHITECTURE.md`）
- 新增「编辑器 `js/editor/`（CM6 的唯一入口）」：六个模块职责表 + 硬约束（CM6 只在 `js/editor/` 与 vendor；视图只用 `DocEditor` 门面；vendor 用 `cd lite/tools/editor && npm ci --ignore-scripts && npm run build` 生成 `web/vendor/codemirror/editor.bundle.js` 并提交；依赖精确锁版本）。
- 单一来源清单新增「编辑器 → `DocEditor` 门面」。

### 构建与真实验证
- 基线（开工）：`cd lite/server && uv run pytest ../tests/test_editor_cm6.py ../tests/test_render_contract.py ../tests/test_layout_contract.py -q` → **15 passed in 8.09s**。
- `cd lite/tools/editor && npm ci --ignore-scripts` → 25 packages、0 vulnerabilities；`npm run build` → bundle **390,904 bytes**、source map **1,845,247 bytes**。
- 重复构建两次 SHA-256 均为 `c6655e41ca2c98006060f9fb2e32c9f3b678e5953c0d079a21bd6dd535f13f18`（可重复构建）。
- 波末定向：上述三文件 → **18 passed in 10.73s**；加 `test_visual_sweep.py` → **21 passed in 28.13s**（9+4+5+3）。
- 相邻契约：`test_frontend_refs + test_page_assets + test_doc_move_drill + test_join_drill` → **6 passed in 8.36s**。
- `node --check`：`js/editor/*.js` 与 `views/doc-editor.js` 全部通过。
- 浏览器验证全部来自项目既有 headless Chrome harness；宽屏/窄屏用 `--window-size=1400,900` / `390,844`。

### 测试变更（只扩 `tests/test_editor_cm6.py`，未新建文件）
- node 探针：断言 bundle 导出 `markdownKeymap`（含 Enter 绑定）与续行/删标记函数。
- `test_view_uses_only_...`：补门面 `runCommand`、`#doc-toolbar`、`td:doc-split`/`td:preview-link`、状态栏五项标识的静态断言。
- facade 浏览器契约：补 `runCommand('bold')` 生效、编辑器内 Mod-k 不冒泡且只弹 1 个链接框。
- 新增 3 个浏览器用例：`test_markdown_continuation_and_fence_typing`（列表回车续行、三反引号围栏、命令）、`test_wide_preview_pane_split_and_fold`（分栏/折叠/双向联动/大纲跟随）、`test_narrow_toolbar_and_status_items`（工具条、触控 40、状态栏五项、大纲按钮隐藏）。

## B. 偏差、坑与未验项
- **capture 截住 Mod-k 后 CM 的 keymap 收不到事件**：守卫自己调用 `io.command('link')`，这是 T2“capture stopPropagation”与“仍插入链接”同时成立的唯一写法；已断言只处理一次。
- markdownKeymap 的 Enter 在**空列表项**上会删掉标记（CM 标准行为，等价于退出列表），因此续行用例用非空条目 `- item` 断言。
- headless + `--virtual-time-budget` 不产帧：原生 `scroll` 事件不派发、rAF 不触发。宽屏用例对滚动位置补发同形 `scroll` 事件；大纲刷新因此加了 100ms 兜底（真实浏览器仍以 rAF 为主）。这属于环境限制，不是实现绕行。
- 原 W1-b 的源码联动监听读的是外层 `.md-source` 的 `scrollTop`，实际从不滚动（真正滚动的是 `.cm-scroller`）；本波已改到 `.cm-scroller`。
- `td:doc-split` 是编辑器自有偏好（`'0'` 收起、缺省展开）；`td:preview-link` 按 W4-c 的 `'true'/'false'` 契约读取。
- 未验：真实中文 IME 下三连反引号（代码按 `view.composing` 明确绕开组字，但没有人工输入法实测）；真实触屏/移动浏览器；专注模式与分栏的组合视觉；大纲在真实原生滚动下的像素精度（只验证了合成事件下的跟随与切换）；浅/深主题下新增圆点与工具条的对比度未逐主题截图核对。
- 未做任何 git 写操作；`lite/server/.venv` 未触碰。

## C. 关键指针
- 键位/扩展：`web/js/editor/keymap.js:38-49`；`web/js/editor/extensions.js:9-23`（围栏）、`:28-43`（Mod-k）、`:45-68`（扩展装配）。
- 门面：`web/js/editor/index.js:168-172`（`runCommand`）、`:183-196`（返回值导出）。
- bundle 构建：`lite/tools/editor/src/index.js:1-56`。
- 文档视图：`web/js/views/doc-editor.js:27-73`（头/状态栏/工具条结构）、`:147-207`（状态/统计/元信息）、`:219-288`（大纲）、`:290-342`（分栏/折叠/模式）、`:361-390`（双向联动）、`:788-799`（工具条事件）。
- 样式：`web/css/editor.css:412-446`（状态栏与圆点）、`:484-507`（分栏）、`:510-513`（<1280 大纲按钮）、`:515-555`（底部工具条与窄屏缩排）。
- 测试：`lite/tests/test_editor_cm6.py:26`（node）、`:56`（视图静态）、`:159`（facade）、`:234`（速录）、`:347`（真实文档主路径）、`:475`（宽屏）、`:550`（窄屏）。
- 架构：`lite/ARCHITECTURE.md` §2「编辑器 `js/editor/`」与 §3 单一来源表。
