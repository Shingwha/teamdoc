# W1-b · CodeMirror 6 交接包
> 当前工作区直接修改；未创建分支/worktree，未执行 commit。日期：2026-11-05。

## A. 自动事实
### 接口与变更
- `window.CM6` 是 esbuild 产出的真实 IIFE，导出 `EditorState/EditorView`、commands/language/search/autocomplete、GFM `markdownLanguage` 与高亮 tags；无 Node/网络运行时依赖。
- `window.DocEditor.mount(host, options)`：`host` 必须是 div；options 为 `value/projectId/readOnly/upload/onChange/onSave/onFocus/onBlur/onCursor/onModeChange`。
- 返回 `getValue()`、`setValue(value,{preserveSelection})`、`insertText(text)`、`insertRef(item)`、`focus()`、`getCursor()`、`getHeadings()`、`scrollToHeading(id)`、`setPreviewVisible(boolean)`、`destroy()`。
- `getCursor()` 返回 1 起始 `{line,column}`；标题为 `{id:'heading-N',level,text,pos}`；预览回调为 `onModeChange('edit'|'preview')`。
- 程序 `setValue` 用私有 Annotation 标记，不触发 `onChange`；一次用户事务触发一次。`setPreviewVisible` 同步 host CSS 类，实际 `MdRender` 仍由文档视图管理。
- 新增 `lite/tools/editor/{package.json,package-lock.json,.gitignore,src/index.js}`；新增 `lite/web/js/editor/{markdown,keymap,theme,extensions,panels,index}.js`。
- 删除 `lite/web/js/doceditor.js`；改造 `lite/web/js/views/doc-editor.js` 与 `lite/web/css/editor.css`；`docs.js` 未改。
- 新增 `lite/tests/test_editor_cm6.py`、`lite/tests/fixtures/cm6-facade.html`；既有 render/visual 临时页显式加载编辑器资源。

### 构建与测试
- 工单基线：`uv run pytest ../tests/test_frontend_refs.py ../tests/test_render_contract.py ../tests/test_visual_sweep.py` → **9 passed**。
- `npm ci --ignore-scripts && npm run build` → 成功，25 packages，0 vulnerabilities。
- 重复 `npm run build` → 成功；bundle **385,536 bytes**，source map **1,835,630 bytes**。
- 两次 bundle SHA-256 均为 `780273ea75603fe50f3aa442cce9f978abd6c65f6fb47a4dbd0b8cb8d22afd84`。
- 编辑器相关：`uv run pytest ../tests/test_frontend_refs.py ../tests/test_render_contract.py ../tests/test_visual_sweep.py ../tests/test_editor_cm6.py -q` → **15 passed**。
- 布局：`uv run pytest ../tests/test_layout_contract.py -q` → **5 passed**。
- WS 后端抽验：`uv run pytest ../tests/test_doc_conflict.py -q` → **10 passed**。
- 全量：`uv run pytest ../tests -q` → **152 passed, 1 skipped, 2 failed, 3 deselected**；两个失败均由 index 未接线导致，见下节。

## B. 偏差、坑与未决
- **W2 阻塞项**：`index.html` 仍引用已删除的 `/js/doceditor.js`。正常入口尚无 CM6；`test_page_assets.py` 因此 404，`test_markdown_diagram.py` 因编辑器资源缺失而不产出报告。它们不是可隐藏通过的测试，W2 接线后必须重跑；Mermaid 原有 SVG id 基线问题仍需单独判断。
- 已验证的是显式注入脚本的真实无头 Chrome 页面：CM 输入、保存 WS 回包与服务端内容、预览、引用候选插入、斜杠、浮动条、搜索均通过。未验证正常 index 入口、真实中文 IME、实际上传文件选择/拖传、冲突弹窗手工交互及窄屏人工视觉。
- 内置浏览器在 subagent 中未启用，不能用于交互验收；浏览器结论全部来自项目既有无头 Chrome harness，未改用其他真实浏览器控制工具。
- `--virtual-time-budget` 会先于真实 WS 回包快进 5 秒保存超时。主路径探针因此断言实际 `saved` 回包和 API 内容，不用快进后的“保存失败”误判保存协议；生产超时尚未改变。
- `DocumentFragment` 挂载后为空，异步阶段必须缓存 DOM 引用，不能再 `frag.querySelector`；本波已修复 `#doc-meta` 的此问题。
- `UI.menuList` 的外部关闭不一定经过包装后的 `onClose`；panels 以 `panel.closed` 归一化状态，避免浮动条永久被旧面板抑制。
- 为控制体积，只打 GFM Markdown 语言本体，不打 `lang-markdown` 的多语言代码围栏依赖；源码围栏无多语言高亮，预览 Prism 不受影响。bundle 高于方案估算但为真实完整内核。
- 保留现有 `docs.js` 主区树，因为 `test_doc_move_drill.py/test_join_drill.py/test_render_contract.py` 仍以其验证跨模块契约，且 W2 拥有壳与这些测试。**双树最终拆除未完成**，W2 必须一并处理，不能把本波中间态当目标形态。
- 未提交任何 git 写操作；后端及其他 worker 的同区变更不属于本交接。

## C. 指针与 W2 index 清单
- 门面：`lite/web/js/editor/index.js:8`，`setValue` 在同文件 `:112`，预览/销毁在 `:159`。
- 键位：`lite/web/js/editor/keymap.js:5`；扩展：`extensions.js:5`；主题：`theme.js:5`。
- 引用：`lite/web/js/editor/panels.js:78`；斜杠 `:132`；上传 `:182`；浮动条 `:227`；清理 `:300`。
- 纯 Markdown 变换：`lite/web/js/editor/markdown.js:31`，标题解析 `:102`。
- 文档视图：`lite/web/js/views/doc-editor.js:25`；远端赋值 `:228`；冲突修复 `:250`；逐块合并 `:347`；保存 `:379`；mount 初始化 `:729`。
- CM 布局：`lite/web/css/editor.css:401`；状态栏 `:413`；大纲 `:429`；分栏 `:465`；专注 `:487`。
- 测试：`lite/tests/test_editor_cm6.py:26`（静态/Node）、`:87`（门面）、`:168`（真实文档主路径）；离线交互 fixture 为 `lite/tests/fixtures/cm6-facade.html`。
- 稳定区：上述 editor 模块与测试已由 15 项门禁覆盖；W2 不必重读旧 textarea 实现，文件已删除。

将 `index.html` 中 `/js/doceditor.js` 的**单个 script 标签**替换为以下 7 个，位置保持在 `ref.js` 之后、`route.js` 之前，顺序不可变：
```html
<script src="/vendor/codemirror/editor.bundle.js"></script>
<script src="/js/editor/markdown.js"></script>
<script src="/js/editor/keymap.js"></script>
<script src="/js/editor/theme.js"></script>
<script src="/js/editor/extensions.js"></script>
<script src="/js/editor/panels.js"></script>
<script src="/js/editor/index.js"></script>
```
