# W5 · 设计刻度、移动端与状态统一
> 分支 `wave/w5-polish`；worktree `C:\Users\shifu\.worktrees\teamdoc\w5-polish`；前置 W4 已合并（基线 `ca3e3cc`）。
> 写入范围：`lite/web/css/{tokens,components,app,drive,admin,editor}.css`、`lite/web/js/ui.js`、跨模块小修（仅状态替换/类名迁移）、受影响的布局/渲染/视觉/页面测试、本 handoff。

## 目标
收口方案 §6.2/§6.11/§6.12。只改样式、共享原语与状态呈现，不改业务逻辑与接口。

## 前置上下文
- 必读顺序：overview → repo-map → interfaces → `handoff/W4-{a,b,c,d}*.md` → 本工单。
- 基线（开工先跑并贴真实输出）：`cd lite/server && uv run pytest ../tests -q` → 期望 **180 passed, 1 skipped, 1 failed（仅 Mermaid 基线）, 3 deselected**。
- worktree 测试：`lite/server/.venv` 已 junction 到主检出 venv，直接 `uv run pytest` 即可；若 uv 仍尝试建环境，改用 `../server/.venv/Scripts/python.exe -m pytest ../tests -q`。
- 稳定区：server、drive/admin/editor 业务逻辑、doc-editor 保存/冲突；只做样式与状态替换。
- 已知：W4 已强制云空间窄屏列表、编辑器窄屏底部工具条；W5 只验证，不重写。
- 测试口径：只更新因刻度/类名变化失效的断言；删除只钉旧像素/旧类名的脆弱断言；不新增测试文件。

## 工单
### T1 令牌收口（tokens.css 为主）
- 表面收敛为 3 层：`--md-surface`（画布）/ `--md-surface-container-low`（侧栏、卡槽）/ `--md-surface-container-high`（弹层、抽屉）。把 `lowest`/`highest` 等消费者的语义迁移到这三层，删除旧变量；grep 证明 0 引用。
- 字阶收敛为 8 档并配对行高：display / headline / title-lg / title / body / prose / label / caption；删除多余中间档，逐个迁移消费者。
- 圆角保持 4/6/10/14（full 仅头像）；动效 150/200/300 与两条曲线保持。
- `--row-h` 52 → 44；个别需要更高的行（用户卡/危险区）用局部覆盖，不改回全局。
- 按钮默认 sm：调整 `UI.btn`/组件默认档，主操作显式可用更大档；不要一刀切把所有按钮压小。
- 状态层：hover 8% / pressed 10%，为 `.btn/.icon-btn/.side-item/.menu-item/.tree-row/.cmd-row` 等补 `:active`；输入 focus ring 2px；toast 3000ms。
- 文档树/侧栏选中：浅灰底 + 左侧 2px 主色条，替换 primary-container 胶囊。

### T2 移动端
- ≤960：按钮/图标钮/菜单项/树行/命令面板行触控目标 ≥40px（只加窄屏覆盖，不动桌面密度）。
- 表格横向滚动：统一滚动容器（优先在共享渲染处包一层，不逐视图复制）；窄屏不再把表格压成纵向堆叠（若保留现有重排，需证明不破坏列语义）。
- 验证 W4 的云空间窄屏列表与编辑器底部工具条：不遮挡、可点击、≥40px。
- 版本/设置/空间设置抽屉窄屏全屏保持。

### T3 状态统一
- 用 `UI.empty()` / `UI.error()` 替换残留手写空态/错误：至少 `doc-editor` 历史版本、`admin/users` 的私有空态、其他 grep 命中的视图。
- 四态（空/加载/错误/成功）文案与主操作语义保持；删除私有空态类与重复样式。
- toast 统一底部居中 3000ms；不新增全局事件。

### T4 测试收敛
- 更新 `test_layout_contract.py`、`test_render_contract.py`、`test_visual_sweep.py`、`test_page_assets.py` 中因令牌/行高/类名变化失效处。
- 删除只断言旧类名、旧像素、旧档位的断言；行为契约由浏览器/视觉测试保留。
- 不新增测试文件。

## 验收
1. `cd lite/server && uv run pytest ../tests -q` → 180+ passed，唯一失败为登记 Mermaid 基线；`-m slow` → 3 passed。
2. `test_layout_contract + test_render_contract + test_visual_sweep + test_page_assets` 全绿。
3. 真实浏览器抽验（可用临时页）：宽屏/窄屏无 JS 错误；触控目标、表格横滚、抽屉全屏、文档树选中条、保存状态圆点可见。
4. grep 证据：旧表面/字阶变量 0 引用；无新增 960 断点扩散。

## 禁触
`lite/server/**`、drive/admin/doc-editor 业务逻辑、editor 内核/vendor、Endpoints/路由文案。无 push/tag；worker 不 merge。

## 交接
写 `handoff/W5-polish.md`：真实命令与结果、令牌映射表（旧→新）、删除的断言与理由、浏览器抽验结论、行号、未验项。最终报告按 spec-team 模板。
