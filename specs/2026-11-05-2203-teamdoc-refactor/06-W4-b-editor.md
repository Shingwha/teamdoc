# W4-b · 编辑器补齐
> 写入范围：`lite/tools/editor/**`、`lite/web/vendor/codemirror/**`、`lite/web/js/editor/**`、`lite/web/js/views/doc-editor.js`、`lite/web/css/editor.css`、`lite/tests/test_editor_cm6.py`、`lite/ARCHITECTURE.md`、本 handoff。无分支/无 commit。

## 目标
补齐方案 §4.5/§4.6/§6.4 的编辑器体验；保存协议、引用/斜杠/上传、门面隔离不变。

## 前置上下文
- 必读：overview → repo-map → interfaces（CM 门面 + W4 前端集成）→ W1-b handoff → 本工单。
- 基线：`cd lite/server && uv run pytest ../tests/test_editor_cm6.py ../tests/test_render_contract.py ../tests/test_layout_contract.py -q`。
- 稳定区：`views/doc-editor.js` 的保存/冲突/逐块合并、`js/editor/panels.js` 的引用/斜杠/上传；只做增量。
- 测试口径：扩展现有 `test_editor_cm6.py`，不新增测试文件；只为新行为补最少断言。

## 工单
### T1 Markdown 续行与速录
- 从 `@codemirror/lang-markdown` 导出并安装 `markdownKeymap`（`insertNewlineContinueMarkup`/`deleteMarkupBackward`），使 `- `、`1. `、`> `、`- [ ] ` 回车续行、Backspace 删除标记可用。
- 输入三连反引号且当前行为空时，自动补闭合围栏并把光标放进代码块（inputHandler；避开 composition，不抢 IME）。
- `# `/`- `/`> ` 在源码模式下本身就是 Markdown 语法，保持原样；在 handoff 说明这一点，不做无意义的文本转换。
- 只允许改：`tools/editor/src/index.js`、`js/editor/{keymap,extensions,markdown}.js`、`web/vendor/codemirror/**`（重新构建）。
- 验证：`npm run build` 成功；node 侧断言续行/围栏函数存在。

### T2 Ctrl+K 冲突
- 编辑器内 `Mod-k` 仍插入链接，但必须阻止按键事件冒泡到全局命令面板；在编辑器 DOM 上以 capture 方式 `stopPropagation`（只对 Mod-k）。
- 不影响编辑器外的 Ctrl+K 打开命令面板。
- 只允许改：`js/editor/extensions.js`（或 keymap）。

### T3 大纲跟随滚动
- 大纲当前高亮改为按预览/编辑器滚动位置计算最近标题；点击跳转保持；编辑态退回按光标行。
- `<1280px` 时隐藏大纲按钮（与 CSS 一致），不再出现“点了没反应”。
- 只允许改：`views/doc-editor.js`、`css/editor.css`。

### T4 宽屏预览 pane
- 保持“同栏切换为默认”；≥1280px 进入预览时显示右侧 pane，并提供独立折叠按钮（记住 `td:doc-split`，默认展开）。
- 增加预览 ↔ 源码双向滚动联动；设置项 `td:preview-link`（默认开）关闭时不同步。W4-c 会提供该开关。
- `setPreviewVisible` 语义保持；销毁时清理监听。
- 只允许改：`views/doc-editor.js`、`css/editor.css`、`js/editor/index.js`（如门面需要）。

### T5 文档头与状态栏
- 保存状态改为“圆点 + 文字”（已保存/保存中/冲突），保存按钮降为文本/tonal；历史入口并入 `⋯` 菜单。
- 元信息行补字数（空间 · 更新时间 · 字数）。
- 底部状态栏五项分开：字数、阅读时长、光标行列、保存状态圆点、空间名；窄屏只缩排不整项消失。
- 只允许改：`views/doc-editor.js`、`css/editor.css`。

### T6 移动端底部工具条
- 门面新增 `runCommand(name)`（暴露 bold/italic/code/link/quote/list/todo 等已有命令）。
- ≤720px 显示固定底部工具条（加粗/斜体/行内代码/链接/引用/列表/待办），触控目标 ≥40px；点击后回焦编辑器。
- 只允许改：`js/editor/index.js`、`views/doc-editor.js`、`css/editor.css`。

### T7 ARCHITECTURE
- 增加 `js/editor/*` 文件表与硬约束：CM6 只在 `js/editor/` 与 vendor；视图只用 `DocEditor` 门面；vendor 构建命令与产物；keymap/theme/extensions 的职责。
- 只允许改：`ARCHITECTURE.md`。

## 验收
1. `cd lite/tools/editor && npm ci --ignore-scripts && npm run build` 成功，bundle 可重复构建。
2. `cd lite/server && uv run pytest ../tests/test_editor_cm6.py ../tests/test_render_contract.py ../tests/test_layout_contract.py ../tests/test_visual_sweep.py -q` 全绿。
3. `node --check` 全部改动 JS；无新增外链/构建期依赖进入运行时。

## 禁触
server、index/app/route/ui/endpoints、drive/admin、其他视图与 CSS、spec 其他文件。无 git 写操作。

## 交接
写 `handoff/W4-b-editor.md`：bundle 哈希/体积、快捷键与命令面、预览/大纲实现、未验项、行号。最终报告按模板。
