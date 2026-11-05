# W9 · Mermaid 切主题基线修复
> 分支 `wave/w9-mermaid-fix`；基线 `04d8a78`；2026-11-06（UTC+8）。测试与测试底座修复，无产品逻辑变更。

## A. 根因与改动
- 根因：无头浏览器默认复用本机 Chrome profile，`localStorage` 会跨用例残留主题。若上次已是 dark，`Theme.setMode('dark')` 不产生配置变化，Mermaid 不会重画，SVG id 不变 —— 断言假红。产品侧“签名变化 → 重新 initialize → 重新 render”的链路本身正常。
- 改动：
  - `lite/tests/_chrome.py`：新增 `run_chrome()`，每次 Chrome 调用使用独立临时 `--user-data-dir`，结束清理（Windows 锁目录重试）；`dump_page` 改用它。
  - `lite/tests/test_editor_cm6.py`：`_dump_sized` 改用 `run_chrome`，与 `dump_page` 同一 profile 策略。
  - `lite/tests/test_markdown_diagram.py`：注入页先 `Theme.setMode('light')`，给“切深色”一个确定起点（防御性，不依赖 profile 默认值）。
- 无 `lite/web/**`、`lite/server/**` 产品代码改动。

## B. 真实验证
- 浏览器组：`test_markdown_diagram + test_editor_cm6 + test_visual_sweep + test_render_contract + test_join_drill + test_doc_move_drill + test_admin_sections` → **21 passed in 33.80s**。
- 全量：**172 passed, 1 skipped, 0 failed, 3 deselected in 106.99s**（此前唯一基线失败已消失）。
- 无新增测试；测试数量不变。

## C. 指针
- `_chrome.py` `run_chrome`；`dump_page`；`test_editor_cm6._dump_sized`；`test_markdown_diagram.DIAGRAM_DRILL_INJECT`。
