# W1-b · CodeMirror 6 编辑器
> 写入范围：`lite/tools/editor/**`、`lite/web/js/editor/**`、`lite/web/js/views/doc-editor.js`、`lite/web/js/views/docs.js`、`lite/web/js/doceditor.js`、`lite/web/css/editor.css`、`lite/web/vendor/codemirror/**`、`lite/tests/**`（仅编辑器相关）、`specs/2026-11-05-2203-teamdoc-refactor/handoff/W1-b-editor.md`

## 目标
以本地 vendor 的 CodeMirror 6 完整替换 textarea 增强器，保留保存/冲突/引用/上传业务；提供方案快捷键、选区浮动条、斜杠菜单、引用面板、搜索、Markdown 高亮、宽屏预览、大纲、状态栏和专注模式。视图只认识 DocEditor 门面。

## 前置上下文
- 必读：根方案 §4 → `ref/repo-map.md` → `ref/interfaces.md` → `00-overview.md` → 本工单。
- 基线：`cd lite/server && uv run pytest ../tests/test_frontend_refs.py ../tests/test_render_contract.py ../tests/test_visual_sweep.py`。
- 稳定区：`markdown.js/ref.js/diff.js/preview.js` 原则上不改；后端与其他前端禁触。
- 已知坑：setValue 不得触发脏；中文 composition 不触发 @/斜杠；保存 Ctrl+S 不得双触发；现冲突 enterConflict 有 `serverContent` 未定义问题，本波按正确语义修复。
- `index.html` 属 W2；本波在 handoff 精确列出需替换/新增的 script 标签，W2 统一接线。为让本波浏览器自测可运行，可在授权测试临时页中显式加载 vendor 和 editor 模块，不改 index。

## 工单
### T1 可重复 vendor 构建
- `lite/tools/editor/` 固定 npm 依赖与 lock，esbuild IIFE 全局 `CM6`，输出单文件 `web/vendor/codemirror/editor.bundle.js`。
- 包含 state/view/commands/language/search/autocomplete/lang-markdown 及所需 lezer 依赖；运行时无网络、无 Node。
- 核心样式可随包注入，自定义主题在 `js/editor/theme.js`。

### T2 门面与独立模块
- `js/editor/` 分门面、键位、扩展、主题、面板/浮动条等；旧 `doceditor.js` 删除，不保留 enhance。
- 按 interfaces 实现 mount/getValue/setValue/insertText/insertRef/focus/cursor/headings/preview/destroy。
- closeBrackets、undo/redo、search 面板、Markdown 高亮、快捷键帮助和表格/标题等 Markdown 变换。
- @/[[ 与 / 复用 Ref、Endpoints、UI；粘贴/拖拽继续走注入 upload；选区浮动条用 coordsAtPos；IME 安全。

### T3 文档视图集成
- 将 views/doc-editor.js 所有 textarea 直操作改为门面，保持 WS + baseVersion + 409 逐块合并、presence、离开守卫、历史、反链。
- 修正冲突状态错误，程序赋值不脏，远端覆盖尽量保留选区。
- 28px 标题、800px 纸面、底部状态栏（字数/阅读时长/行列/保存/空间）、宽屏大纲与可折叠预览、滚动联动、专注模式；窄屏编辑/预览整栏切换。
- docs.js 可删除主区树列与 btn-doc-tree 接线，但若与 W2 壳耦合，保留最小结构并在 handoff 说明，不能保留双树目标形态。

### T4 测试
- 更新 render contract 的编辑器探针；添加 Node 可验证的纯 Markdown 变换/门面契约测试，浏览器可验证 CM 加载、输入、保存回调、预览、引用/浮动条至少覆盖主路径。
- 不修改 index.html；W2 后由 lead 做完整浏览器终验。

## 验收
1. `npm run build` 可重复生成本地 bundle，无外链。
2. 编辑器相关测试全绿；快速套件除 Mermaid 基线失败外无新增失败（index 未接线导致的限制必须明确报告，不得伪报）。
3. 视图无 `CM6`/textarea 直操作；旧 doceditor.js 无残留消费者。

## 禁触
`lite/server/**`、`lite/web/index.html`、`app.js/route.js/ui.js/theme.js/endpoints.js`、其他 views、tokens/app/components CSS；不执行 git 写操作，不新增兼容 shim。

## 交接包
写 `handoff/W1-b-editor.md`，必须列 index 精确接线清单、bundle 大小、真实测试、接口偏差和未验场景。无需 commit。

## 最终报告
状态表、真实命令结果、偏差与取舍、探索审计、未决问题。
