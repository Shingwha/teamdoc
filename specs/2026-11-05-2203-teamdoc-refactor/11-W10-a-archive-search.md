# W10-a · 归档空间搜索策略
> 分支 `wave/w10-archive-search`；worktree `C:\Users\shifu\.worktrees\teamdoc\w10-archive-search`；基线 `refactor/teamdoc-v1.4`。写入范围：`lite/server/services/search.py`、`lite/server/routers/search.py`、`lite/web/js/views/palette.js`、新增 `lite/tests/test_archive_search.py`、本 handoff。

## 目标
归档空间内容默认不出现在全局搜索；提供"包含归档"开关；显式进入归档空间的搜索仍可读。只改搜索与命令面板，不动归档写守卫。

## 契约
- `GET /api/search` 新增 `includeArchived=1`（缺省 0）。
- 无 `projectId`：默认排除 `archived_at` 非空的 space；`includeArchived=1` 包含。
- 有 `projectId`：不做归档过滤（用户已显式进入该空间），保持可读。
- doc/file 结果行增加 `archived: bool`。
- 前端命令面板：无当前空间时显示"包含归档"开关（`UI.pref` 键 `td:search-archived`，`'1'/'0'`），开启后请求带 `includeArchived=1`；结果带"已归档"徽标；开关切换后重跑当前查询且不丢输入焦点。

## 工单
### T1 服务端过滤
- `services/search.py`：查询一次 `Project` 得到 `{id: (name, archived)}`；显式 `projectId` 不过滤；全局且未 include 时从 visible 剔除归档 id；`_doc_row/_file_row` 增加 `archived`。
- `routers/search.py`：解析 `includeArchived`（`1/true/yes` 为真），传入服务。
- 只允许改：`services/search.py`、`routers/search.py`。

### T2 命令面板
- `views/palette.js`：footer 加开关；`query()` 仅在无 pid 且开启时加 `includeArchived=1`；`row()` 增加归档徽标；开关状态持久化。
- 只允许改：`views/palette.js`。

### T3 测试
- 新增 `tests/test_archive_search.py`，2 个行为用例：
  1. 归档空间：全局 q 搜索默认无结果；`includeArchived=1` 有结果且 `archived=true`；显式 `projectId` 有结果；解除归档后默认恢复。
  2. 最近模式（q 为空）同样遵守开关。
- 只允许改：新增测试文件。

## 验收
- `uv run pytest ../tests/test_archive_search.py ../tests/test_w4_contracts.py ../tests/test_workspace_preferences.py ../tests/test_frontend_refs.py -q` 全绿。
- `test_visual_sweep.py`、`test_page_assets.py` 不回归。
- 前端无 `/api/` 字面量；`node --check palette.js`。

## 禁触
quota/上传/空间写路径、其他视图、其他 worker 文件、spec 其他文件。不 merge/push/tag。

## 交接
写 `handoff/W10-a-archive-search.md`：过滤语义、开关与徽标、真实测试结果、行号、未验项。最终报告按模板。
