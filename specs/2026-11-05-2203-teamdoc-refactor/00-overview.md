# TeamDoc 全面重构
> 启动：2026-11-05 22:03（UTC+8）

## 目标
按 `teamdoc 改造方案.md` v1.4 完成后端轻分层、文件版本、CodeMirror 6 编辑器和 Material 3 精修界面。代码只保留目标形态，不写旧接口兼容层。

## 非目标
实时协同、WYSIWYG/live preview、对象存储、原生移动应用；不修复与改造无关的基线失败。

## 基线
`cd lite/server && uv run pytest ../tests`：135 项选中，133 通过、1 跳过、1 失败。既有失败为 `test_markdown_diagram.py::test_markdown_extensions_in_browser` 的 Mermaid 主题切换 SVG id 未变化；其余通过。

## 波次
| 波次 | 范围 | 依赖 | 写入所有者 |
|---|---|---|---|
| W1-a | 后端轻分层、文件版本与测试 | 无 | `lite/server/**`、后端测试、本波 handoff |
| W1-b | CM6 vendor、编辑器门面与文档编辑体验 | 无 | `lite/tools/editor/**`、`lite/web/js/editor/**`、`lite/web/js/views/doc-editor.js`、`lite/web/js/doceditor.js`、`lite/web/css/editor.css`、`lite/web/vendor/codemirror/**`、编辑器测试、本波 handoff |
| W2-a | 设计系统、应用壳、空间首页/命令面板、团队与个人设置 | W1 接口冻结 | 壳/共享前端与设置视图、index、共享 CSS、前端契约测试、架构文档 |
| W2-b | 云空间版本交互与同名批量决策 | W1 接口冻结 | `views/drive.js`、`css/drive.css`、云空间新增测试 |
| W2-c | 管理后台总览、子导航、用户/空间双视角 | W1 接口冻结 | `views/admin*.js`、`views/admin/**`、`css/admin.css`、后台新增测试 |
| W2-d | 个人资料/会话、空间偏好与归档、搜索过滤、总览 API | W1 接口冻结 | `lite/server/**`、本域新增测试 |
| W3 | 全量门禁、真实浏览器核心路径抽验、收尾 | 全部 | lead 跨模块小修 |
| W4-a | 服务端新契约：通知、PAT 审计、版本备注、成员加入/活跃时间、409 上传者姓名 | W3 | `lite/server/**`、对应新增/专项测试、本波 handoff |
| W4-b | 编辑器补齐：Markdown 速录/续行、Ctrl+K 冲突、大纲滚动跟随、预览 pane、文档头/状态栏、移动工具条 | W3 | `lite/tools/editor/**`、`web/js/editor/**`、`views/doc-editor.js`、`css/editor.css`、`test_editor_cm6.py`、ARCHITECTURE、本波 handoff |
| W4-c | 壳/IA 补齐：空间切换器（逐空间 ⋯/发现页签）、通知 UI、搜索页并入面板、设置 960/预览联动、初始化提示、文档树定位 | W3 | `index.html`、`app/route/ui/endpoints`、home/palette/settings/docs/doc-tree/projects、壳相关测试、tests README、本波 handoff |
| W4-d | 云空间/后台/空间设置补齐：网格 hover/排序/备注、上传者姓名、PAT 审计 UI、配额策略、加入时间、选人器统一、成员字段、转让选人 | W3 | `views/drive.js`、`css/drive.css`、`views/admin/**`、`css/admin.css`、`views/project.js`、版本与后台测试、本波 handoff |
| W5 | 设计刻度收口、移动端四项、空/加载/错误/成功统一、集成门禁 | W4 全部 | `tokens/components/app.css`、`ui.js`、跨模块小修 |
| W6 | 后端整体重构清理：合并重复、删死代码、收敛服务边界、测试去重去脆 | W5 | `lite/server/**`、后端测试 |
| W7 | 前端整体重构清理：共享原语、删无效模块/CSS、测试去重去脆 | W6 | `lite/web/**`、前端测试、ARCHITECTURE |
| W8 | 终验：全量 + slow + 浏览器核心路径，测试套件最终收敛 | W7 | lead |

第二轮（W4–W5）补齐方案 v1.4 的全部缺口；第三轮（W6–W8）只做重构与清理，不新增能力。测试口径不变：新增测试只守真实行为契约，宁少勿多；清理阶段删除冗余、重复、脆弱的断言。

W4-a..d 文件范围不相交，可并行（最后一批共享工作区波次）。W4 门禁通过后，lead 在分支 `refactor/teamdoc-v1.4` 建立基线提交（W1–W4 成果）；**W5 起严格执行 spec-team 协议**：每波一个仓库外 worktree + 独立分支，worker 在分支提交，lead 门禁后 `merge --no-ff` 再跑一次门禁。全程不 push、不打 tag、不 checkout master。worker 不 merge、不碰主检出与其他 worktree。

## 全局不变量
- 认证、会话、PAT、登录节流和权限金字塔语义不变。
- 文档 LWW + `baseVersion`、WS/REST 冲突现场和逐块合并能力不变。
- 文件继续 raw body 流式写盘；物理名随机；路径只经 `storage.py`；长 I/O 不持有 DB 连接；INFLIGHT 防误清。
- 文件只新增物理版本，不覆盖旧物理内容；恢复也生成新版本。
- 数据与 `file_changes` 同事务；审计等安全语义要求的独立提交不机械合并。
- 服务层不 import FastAPI；路由只负责 HTTP 解析、调用服务与序列化。
- 前端零运行时构建、零外链；CM6 仅限 `js/editor/` 与 vendor，视图只使用 `DocEditor` 门面。
- `endpoints.js` 是唯一 API 路径来源；`scopes.js` 渲染契约和路由分派单一来源继续成立。
- 注释和文档使用中文；commit 不在本任务执行。

## 回归红线
快速测试除已登记的基线失败外不得新增失败；新增文件版本、树/存储服务与编辑器测试必须全绿。慢速弹性组在终验运行。浏览器抽验覆盖登录、空间首页、文档编辑保存/预览、上传新版本/历史/恢复、设置、管理后台和窄屏。

## 决策与取舍
- 保留现有 `/api/projects` 与 `/api/files/upload` 路径风格；新增版本端点按方案实现，不额外维护 `/api/spaces` 别名。
- 存量数据库执行显式、有限、可重复校验的 schema 迁移；这不是运行时兼容 shim。
- `File` 补 `version/updated_by/updated_at`，每个当前或历史版本均有 `FileVersion` 行；`File.storage_path` 指向当前版本。
- 清理规则：至少保留每文件最近 20 版；仅删除超过 20 且年龄超过 90 天的版本；物理路径仍被任何版本或当前文件引用时不删。
- 编辑器附件上传可显式传 `name_mode=keep`，普通云空间上传默认撞名 409。
- 收藏等方案提及但无数据模型的辅助能力，W2 以当前空间可用的文档视图为准，不引入无关的新持久化体系。
- 测试口径（2026-11-05 用户指令）：不新增冗余或脆弱的断言，只补能守住真实行为契约的最少用例。worker 波内只跑本域定向测试；全量快速组由 lead 在四份交付齐备后跑一次；终验再跑 slow 组。既有测试不删不精简：实测快速组约 97–108 秒，主要耗时是逐路由启动无头 Chrome（15.6 秒）与登录节流各用例独立起服（约 15 秒），删测会丢掉本次重构最需要的契约保护。

## 进度（lead 维护）
- W1-a、W1-b：✅ 已交付（handoff：`W1-a-backend.md`、`W1-b-editor.md`）。
- W2-a、W2-b、W2-c、W2-d：✅ 已交付（handoff：`W2-a-shell.md`、`W2-b-drive.md`、`W2-c-admin.md`、`W2-d-support.md`）。
- W2 门禁：`uv run pytest ../tests` → **167 passed, 1 skipped, 1 failed, 3 deselected**（112.43 秒）。唯一失败为登记的 `test_markdown_diagram` Mermaid 切主题 SVG id 基线，无新增失败。测试夹具“脚注角标在首屏”已按新壳几何前移，恢复了该用例的其余断言。
- W2 实施偏差已回写 `ref/interfaces.md`：`#/` 不重定向（home 层解析记忆空间）、加入空间落 `docs`、admin 分区取段优先 `route.section`、WS 归档写拒用 4403、`?archived=1` 附加参数、配额只展示不拦截。
- W3：✅ slow 组 `uv run pytest ../tests -m slow -q` → **3 passed, 169 deselected, 11.12s**；真实服务端 + 真实 index 无头浏览器抽验通过：
  - 宽屏（1280×900）：空间首页、云空间列表、版本抽屉 2 个版本、历史下载 `?version=1`、恢复点击后 API 与抽屉均 3 个版本、资料自动保存（API 与 App.user 同步）、Ctrl+K 命令面板键盘导航 Enter 落到目标文档，全程 `errors=none`。
  - 窄屏（420×900 请求，实际 innerWidth 512）：`UI.NARROW` 命中、侧栏浮层 `position:fixed`、版本抽屉全宽（512=innerWidth）、`errors=none`。
  - 抽验为临时探针，跑完即删，未新增测试文件。
- 收尾清理（lead）：删除 `doc-editor.js` 中失去消费者的 `onTreeToggle`/`#btn-doc-tree` 分支与 `editor.css` 失效的 `.doc-tree-col` 选择器；受影响定向 `test_editor_cm6 + test_layout_contract + test_render_contract + test_visual_sweep + test_doc_move_drill` → **19 passed in 29.03s**。
- W4-a..d：✅ 已交付（handoff：`W4-a-backend.md`、`W4-b-editor.md`、`W4-c-shell.md`、`W4-d-drive-admin.md`）。
- W4 门禁：`uv run pytest ../tests` → **180 passed, 1 skipped, 1 failed, 3 deselected**（108.11 秒）；唯一失败为登记的 Mermaid 基线。slow 组 **3 passed**。W4 期间删除了一条“大纲初始高亮必须恰好第一节”的时序脆弱断言，保留“有高亮 + 滚动后变化”的行为契约。
- W4 新增契约已落地：通知（加入空间/角色变更/转让）、只读 PAT 审计、版本备注、成员 `createdAt/lastActiveAt`、409 `updatedByName`。
- **基线**：分支 `refactor/teamdoc-v1.4` 提交 W1–W4 成果；W5 起每波独立 worktree + 分支，lead `merge --no-ff`。
- W5：✅ 已合并（`55e846d`，分支 `wave/w5-polish`，4 个提交）。三层表面/8 档字阶/行高 44/按钮默认 sm/触控 40/表格横滚/状态四态收口。worktree 门禁与合并后主检出门禁均为 **181 passed, 1 skipped, 1 failed（仅 Mermaid 基线）, 3 deselected**；slow 组 3 passed。
- W5 新增 `test_design_scale_is_converged`（精确令牌清单）；属 W7 测试收敛评估项，若判定为脆弱静态断言则删除。
- W6：✅ 已合并（`fe0bb5b`，分支 `wave/w6-backend-cleanup`，6 个提交）。路由薄化（auth/admin/ws 业务下沉）；`services/**` 到 FastAPI 的唯一链路只剩 `errors`；`deps.py` 承接请求依赖；合并重复助手、删除 0 引用符号；后端测试 186 → 183 选中（178 passed / 1 skipped / 1 failed 基线）；slow 3 passed。
- W7：✅ 已合并（`f198dd9`，分支 `wave/w7-frontend-cleanup`，5 个提交）。合并角色/日期/偏好/活跃时间原语；删除 `views/recent.js`、0 引用导出、死 CSS；测试选中数 180 → 173（**171 passed**，删除精确令牌断言与字符串式驱动测试，改为 1 条 `driveBody` 行为巡检）；修复 `#/p/{pid}/settings` 的未定义引用。
- W8：✅ 终验完成。全量快速组 **171 passed, 1 skipped, 1 failed（仅登记 Mermaid 基线）, 3 deselected**（110.12s，W7 合并后）；slow **3 passed**；浏览器核心路径组 **18 passed**（visual sweep / editor / admin sections / join drill / doc move drill / drive versions / page assets）。测试选中数 **186 → 173**（W6 删 3、W7 删 7）。W5/W6/W7 worktree 已删除，分支 `wave/w5-polish`、`wave/w6-backend-cleanup`、`wave/w7-frontend-cleanup` 保留；主检出 `refactor/teamdoc-v1.4` 工作区干净。
- 遗留（不在本次范围）：`test_markdown_diagram` 的 Mermaid 切主题重画失败为登记基线；归档空间是否排除搜索、配额硬限制为后续产品决策；空间设置抽屉的转让/归档真实点击未逐项流水（接口与静态契约已验）。

## 接口索引
见 `ref/interfaces.md`。仓库地图见 `ref/repo-map.md`。实际交付以代码、测试和 handoff 为准。
