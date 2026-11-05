# W1-a · 后端轻分层与文件版本
> 写入范围：`lite/server/**`、`lite/tests/**`（仅后端及对应契约测试）、`specs/2026-11-05-2203-teamdoc-refactor/handoff/W1-a-backend.md`

## 目标
完成 §5 目标结构和 §3 文件版本全链路。不是只搬工具文件：路由必须变薄，核心业务进入无 FastAPI 的 services。保留认证、权限、文档冲突、上传安全与备份恢复语义，不留旧 import 兼容层。

## 前置上下文
- 必读：根目录方案 §3/§5 → `ref/repo-map.md` → `ref/interfaces.md` → `00-overview.md` → 本工单。
- 基线：`cd lite/server && uv run pytest ../tests`，真实结果 133 passed / 1 skipped / 1 既有 Mermaid 失败。
- 稳定区：`lite/web/**` 禁触。
- 已知坑：无 doc_changes；File 无更新字段；schema 原本拒绝迁移；长 I/O 前 release_db；备份按快照库收集物理名。

## 工单
### T1 基础设施与认证拆分
- 建 `db.py/storage.py/treeutil.py/http_util.py/security/`，models 只留 ORM；全仓更新 import，无 shim。
- `security/context.py` 保持权限判定单一来源，services 可复用纯权限函数但不得依赖 FastAPI 请求对象。
- 建 `services/` 与 `routers/`；将 docs/files/projects/trash/search/users/audit/backup 等业务下沉，main 注册新 router。
- 写路径数据与 file_changes 同事务；安全审计保留必要独立提交。access log/响应增加请求 ID（如现有日志体系允许，保持非阻塞）。

### T2 版本模型、迁移与 API
- File 加版本/更新字段，新增 FileVersion/FileChange；schema 提供明确、幂等、带结构校验的存量迁移。
- 完成同名 409、keep、version_of、显式上传新版本、列表、恢复、历史下载、轮询变更。
- 所有文件响应和错误形状遵守 interfaces；保留 docId 附件入口和权限语义。

### T3 清理、备份与删除
- 每日版本清理：至少留 20，90 天以外且超出 20 才删；恢复造成的共享物理路径不得误删。
- 文件/文件夹/空间彻底删除、孤儿扫描、备份快照、恢复完整性包含版本文件。
- INFLIGHT 覆盖所有新物理版本；失败上传不留 DB 记录或孤儿。

### T4 测试与文档
- 更新旧重名测试为目标行为；新增服务层与 HTTP 版本测试：迁移、显式新版本、409 两分支、恢复新增版本、历史下载、权限、变更日志、20/90 清理、共享路径、彻底删除、备份孤儿。
- 只修改因目标契约必须变化的测试，不删除安全断言。

## 验收
1. `uv run pytest ../tests/test_smoke_endpoints.py ../tests/test_files_paging.py ../tests/test_upload_security.py ../tests/test_admin_storage.py ../tests/test_backup_restore.py` 全绿。
2. 新增文件版本及服务测试全绿。
3. `uv run pytest ../tests` 除登记的 Mermaid 基线失败外无新增失败。
4. 服务层 grep 无 FastAPI import；旧顶层路由文件不再作为 shim 残留。

## 禁触
`lite/web/**`、`lite/tools/**`、根方案文件、其他 spec；不执行任何 git 写操作。

## 诚实出口
若完整 routers/services 搬迁阻塞版本功能，不得悄悄留下新旧双实现；停止并报告具体循环依赖或行为冲突，由 lead 调整契约。

## 交接包
写 `handoff/W1-a-backend.md`：A 变更地图/公开接口/真实命令结果；B 偏差/坑/约束；C 文件行号指针。无需 commit。

## 最终报告
状态表、真实测试结论、偏差与取舍、探索审计、未决问题。
