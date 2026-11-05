# W6 · 后端整体重构清理
> 分支 `wave/w6-backend-cleanup`；worktree `C:\Users\shifu\.worktrees\teamdoc\w6-backend-cleanup`；前置 W5 已合并（`55e846d`）。
> 写入范围：`lite/server/**`、后端测试、本 handoff。只做重构，不新增能力，不改公开契约。

## 目标
消除 W1–W5 遗留的结构问题：路由内业务、服务层到 FastAPI 的间接依赖、跨模块重复助手、死代码、重复/脆弱测试。对外行为、响应形状、错误码、权限语义保持不变。

## 前置上下文
- 必读：overview → repo-map → interfaces → W1-a/W2-d/W4-a handoff → 本工单 → `05-plan-gap-audit.md` 的后端条目。
- 基线（开工先跑并贴真实输出）：`cd lite/server && uv run pytest ../tests -q` → **181 passed, 1 skipped, 1 failed（仅 Mermaid 基线）, 3 deselected**；`-m slow` → 3 passed。
- worktree 测试：`lite/server/.venv` 已 junction 到主 venv，直接 `uv run pytest`。
- 稳定区：公开 API 路径/字段/错误码、认证/WS 冲突协议、上传三段式、版本清理语义。不得借重构改行为。
- 测试口径：只合并/删除重复与脆弱断言，不降低真实行为覆盖；不新增测试文件。

## 工单
### T1 路由薄化
- 把 `routers/auth.py` 的登录/初始化/PAT/会话内联流程移入 `services/`（可新增 `services/auth.py` 或并入 users/sessions），路由只做参数解析 → 调 service → 序列化。
- `routers/admin.py` 的恢复包暂存文件 I/O 移入 `services/backup.py`。
- `routers/ws.py` 的保存/presence 业务下沉到 `services/docs.py`（连接循环与协议帧仍留路由）。
- 验证：路由文件不再出现 SQLAlchemy 查询/文件写入；行为测试全绿。

### T2 依赖方向
- 目标：`services/**` 只允许通过 `errors` 触达 FastAPI；消除经 `db.py`/`http_util.py`/`security/context.py` 的间接依赖。
- 可行手段（按最小改动）：把 `db.py` 中的 FastAPI 专用部分移出；为 service 提供 FastAPI-free 的 `Actor`（user/via/scopes）类型，路由层把 AuthContext 转成 Actor；`http_util` 的请求解析留在路由层。
- 给 grep 证据：`services/` 直接/间接 import FastAPI 的链路为 0（errors 除外，需在 handoff 说明）。

### T3 去重与死代码
- 合并跨文件重复助手：用户查找/姓名映射、`iso`/时间格式化、字段解析、权限守卫、存储路径/引用收集。
- 删除无消费者函数/导入/常量；用 grep/静态扫描列出证据。
- 不保留“以防万一”的导出；删掉的公开符号必须有 0 引用证据。

### T4 事务与一致性
- 复核写路径：数据与 `file_changes` 同事务；消除可安全删除的中间提交。
- 认证依赖的会话/PAT 提交属安全语义，允许保留；在 handoff 写明边界。
- `file_changes.seq` 的 `since` 游标单调性：若不能安全改为 AUTOINCREMENT，给出不改的理由与风险边界，不强行迁移。

### T5 测试收敛
- 盘点后端测试：合并重复场景、删除只重复既有断言/只钉实现字符串的脆弱用例；保留权限、事务、版本清理、归档、通知、PAT、迁移等行为覆盖。
- 不新增测试文件；测试数量不得增加。
- 记录删除清单与理由（哪些断言被哪条既有测试覆盖）。

## 验收
1. `uv run pytest ../tests -q` → 181 passed 左右（数量可因去重下降），唯一失败为 Mermaid 基线；`-m slow` → 3 passed。
2. 公开契约不变：smoke/files/doc_conflict/visibility/session/backup/workspace/preferences/通知/PAT 全绿。
3. 服务层 FastAPI 依赖 grep 证据（直接+间接）。
4. `git diff --stat 55e846d..HEAD` 只含 server 与后端测试；无 web/tools 改动。

## 禁触
`lite/web/**`、`lite/tools/**`、spec 其他文件、基线 Mermaid。不 merge/push/tag。

## 交接
写 `handoff/W6-backend-cleanup.md`：路由薄化前后对照、依赖方向证据、去重清单、删除的测试与理由、真实命令结果、行号、未决。最终报告按模板。
