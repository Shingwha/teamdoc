# W7 · 前端整体重构清理
> 分支 `wave/w7-frontend-cleanup`；worktree `C:\Users\shifu\.worktrees\teamdoc\w7-frontend-cleanup`；前置 W6 已合并。
> 写入范围：`lite/web/**`、前端测试、`lite/ARCHITECTURE.md`、`lite/tests/README.md`、本 handoff。只做重构与测试收敛，不新增能力。

## 目标
消除前端重复实现、死模块/死 CSS 与脆弱测试。交互、路由、接口调用与视觉契约保持不变；测试数量下降，保留的断言必须是行为级或对外契约。

## 前置上下文
- 必读：overview → repo-map → interfaces → W2/W4/W5 handoff → 本工单 → `05-plan-gap-audit.md` 的前端条目。
- 基线（开工先跑并贴真实输出）：`cd lite/server && uv run pytest ../tests -q` → 期望 181 passed 左右, 1 skipped, 1 failed（仅 Mermaid 基线）, 3 deselected。
- 已知孤儿：`web/js/views/recent.js`（W4-c 删除搜索/发现后无消费者，`Views.recentLevel` 已由 home.js 提供）；其余以 grep 证据为准。
- 测试口径：删除冗余、重复、脆弱的断言；行为覆盖由浏览器/HTTP 测试保留。不新增测试文件。

## 工单
### T1 共享原语收敛
- 盘点并合并重复实现：转义、格式化（大小/时间/日期）、id 形状、pref 读写、DOM 构建、事件委托、错误提示、通知/成员行渲染。
- 只在确实出现 ≥2 处重复时上移；单点逻辑不造抽象。
- 合并后给出 grep 证据：每个被删的本地副本 0 引用。

### T2 死代码与死 CSS
- 删除 `views/recent.js` 及 index 中对应 script（若仍在）；删除 0 引用的视图/函数/导出。
- 删除已下线路由/视图（search/discover）的残留 CSS、旧类名与旧注释引用；grep 证明 0 引用。
- 清理失效注释（doceditor.js、doc-tree-col 等历史引用）。
- 不保留“以防万一”的导出或空实现。

### T3 测试收敛（重点）
先盘点前端测试，再逐项处置并记录理由：
- `test_drive_versions.py`：字符串式静态断言（7 项）与 `test_frontend_refs`/浏览器巡检重复；收敛为最少的行为级覆盖，能由既有浏览器用例覆盖的直接删除。
- `test_layout_contract.py::test_design_scale_is_converged`：精确令牌清单断言，属脆弱静态测试；删除，令牌由视觉/布局契约与浏览器抽验守。
- `test_editor_cm6.py`、`test_admin_sections.py`、`test_visual_sweep.py`、`test_render_contract.py`：保留真实行为断言；删除只钉实现字符串/重复其他文件的断言。
- `test_page_assets.py`、`test_frontend_refs.py`：保留（零外链/资源可达/导出面是真契约）。
- 不新增测试文件；测试总数必须下降；每个删除项在 handoff 写“被哪条既有测试覆盖”。

### T4 文档
- ARCHITECTURE 更新前端文件表与模块边界（含删除项）；tests/README 更新测试清单与“为什么保留”。
- 不写历史，只写当前约束。

## 验收
1. `uv run pytest ../tests -q` → 数量较 W6 下降，唯一失败为 Mermaid 基线；`-m slow` 3 passed。
2. `test_page_assets + test_render_contract + test_visual_sweep + test_join_drill + test_doc_move_drill + test_frontend_refs` 全绿。
3. 真实浏览器抽验：登录→空间首页→文档编辑/预览→云空间版本→设置→管理后台→窄屏，`errors=none`。
4. grep 证据：删除的本地副本/旧类名 0 引用；`views/recent.js` 不存在；无 `/api/` 字面量。

## 禁触
`lite/server/**`、`lite/tools/**`、server 测试、spec 其他文件、基线 Mermaid。不 merge/push/tag。

## 交接
写 `handoff/W7-frontend-cleanup.md`：去重清单（旧→新）、删除的文件/CSS/测试与理由、测试数量前后、浏览器抽验、行号、未决。最终报告按模板。
