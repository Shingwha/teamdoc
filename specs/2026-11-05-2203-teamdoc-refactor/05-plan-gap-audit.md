# 方案 v1.4 落地差距审计
> 2026-11-06；方法：按 `teamdoc 改造方案.md` §3–§6 逐条对照当前工作区代码与测试（不采信 handoff 自述）；只读审计。

## 结论
四块“换血”主干均已落地并可运行：文件版本、后端轻分层、CM6 编辑器、界面壳/云空间/管理后台。但方案中的**约 20 项明确交付项缺失或只完成一半**，其中 3 项是用户可直接撞见的交互缺陷。所有改动仍未 git 提交。

## 已实现的核心
- §3 文件版本：表结构、存量迁移、显式新版本、同名 409 双分支、历史列表、恢复登记新版本、20+90 清理、孤儿/备份/INFLIGHT 覆盖；后端 14 项专项测试。
- §5 轻分层：目标目录与文件齐全；services 直接 import FastAPI/starlette = 0；`X-Request-ID`；file_changes 与数据同事务。
- §4 CM6：vendor IIFE、`DocEditor` 门面隔离（views 0 处 CM 引用）、旧 `doceditor.js` 删除、保存/冲突逐块合并、引用/斜杠/浮动条/粘贴拖拽、大部分快捷键。
- §6：40px 顶栏、空间首页/最近/收藏、Ctrl+K 命令面板、云空间版本抽屉与三处入口、管理后台六分区与懒加载、登录/两步初始化。

## 缺口（按影响排序）

| # | 方案要求 | 实际 | 证据 |
|---|---|---|---|
| 1 | §4.5 Markdown 速录：`# 空格`、`- 空格`、`> 空格`、``` 围栏、表格回车 | 仅表格回车；未安装 `markdownKeymap`，列表回车也不会续行 | `web/js/editor/keymap.js:29-36`、`extensions.js:19` |
| 2 | Ctrl+K 在编辑器内插入链接（§4.5），全局 Ctrl+K 开命令面板（§6.6） | 两个绑定同时响应：CM 只 preventDefault 不 stopPropagation，全局监听未检查 defaultPrevented | `keymap.js:16`、`app.js:624-629` |
| 3 | §6.6 命令面板输入用户名直达**该用户详情** | 跳 `#/admin/users?q=`，用户区从不读路由 query，只落到未筛选列表 | `palette.js:108`、`admin/users.js:74` |
| 4 | §6.6 发现并入切换器页签；原搜索页降级为面板内嵌 | `#/discover`、`#/search` 仍是独立整页；仅从切换器/首页空态进入 | `route.js:115-118`、`index.html:108` |
| 5 | §6.3 顶栏通知 | 空壳：固定“暂无通知”，无数据源/接口 | `app.js:186-193` |
| 6 | §6.9 安全区含 PAT 审计 | 前后端均无管理员 PAT 审计 | `admin/security.js:78-90`、`routers/admin.py` 无 pat |
| 7 | §6.9 存储区含配额策略 | 只有磁盘/孤儿/清理 | `admin/storage.js:44-83` |
| 8 | §6.7③/§6.9 用户详情「所属空间」含**加入时间** | 显示空间创建时间；成员关系 `created_at` 未序列化 | `admin/users.js:522`、`serialize.py:110-112` |
| 9 | §6.7① 统一选人器三处复用 | 后台“把用户加入空间”另写 `pickSpace`；空间设置无 chip 预览 | `admin/users.js:292-360`、`project.js:580` |
| 10 | §6.7② 空间设置入口为“空间行 ⋯”，仅 owner/管理员 | 弹层底部单条“当前空间设置”，无角色门槛；转让用目录选人器，非本空间成员 | `app.js:246-250`、`project.js:643` |
| 11 | §6.7② 成员行“用户名·最后活跃”、44px、角色徽章区分、移除后果含文件数 | 无最后活跃（后端也未返回）、48px、EDITOR/VIEWER 徽章无区分、后果只有文档数 | `project.js:493/499/544`、`serialize.py:110-112` |
| 12 | §6.4 保存状态小圆点+文字；保存降级文本按钮；历史/更多收进 ⋯；元信息含字数 | 纯文本状态、保存仍 filled、历史独立按钮、元信息无字数 | `doc-editor.js:29/37/39/623` |
| 13 | §6.4 大纲跟随**滚动**高亮 | 只按光标行高亮；<1280 按钮仍显示但 CSS 隐藏 | `doc-editor.js:454-466`、`editor.css:491-493` |
| 14 | §4.6/§6.4 宽屏右侧预览 pane 可折叠、滚动联动 | 仅 preview 模式分栏；无 pane 级折叠；联动仅源码→预览单向；默认仍是纯源码 | `doc-editor.js:117/175-184/217-225` |
| 15 | §6.5 网格瓦片 hover 出操作 | 瓦片无操作节点，版本入口在网格只靠右键 | `drive.js:302-321` |
| 16 | §6.5 版本时间线含“备注” | 无 note 数据模型，未渲染 | `drive.js:525-547` |
| 17 | §6.5 单行工具条含排序 | 排序只在表头，网格默认下表头隐藏 | `drive.js:113-136`、`app.css:342` |
| 18 | §3.4 冲突弹窗“3.2 MB，昨天 14:32 由张三上传” | `detail.existing` 只有 `updatedBy` id，前端不显示上传者 | `services/files.py:140-144`、`drive.js:1084-1085` |
| 19 | §6.11 触控 ≥40、表格横向滚动、文件区网格→列表、编辑工具条底部浮动 | 均未落地（窄屏只做抽屉与行高） | `tokens.css:36-39`、`components.css:724-727`、`drive.js:91` |
| 20 | §6.2 三层表面、列表行 44、按钮默认 sm、pressed 10%、输入 focus 2px、树选中 2px 左条 | 表面仍 5 档、通用行 52、按钮默认 40、无 `:active`、输入 focus 1px、树选中胶囊 | `tokens.css:186-195/44`、`components.css:31/139`、`app.css:313` |
| 21 | §6.10 初始化窗口安全提示 | 初始化页只有标题，无抢注警示 | `app.js:524` |
| 22 | §4.2 约束写进 ARCHITECTURE.md | 全文 0 处 CM6/js/editor | `ARCHITECTURE.md` |
| 23 | §5.1/§5.2 补 service 层单测 | 只有 versions/refs/schema 有直接单测；files/spaces/trash/backup/audit/docs 与配额判定无 service 级测试 | `test_file_version_services.py`、`test_id_contract.py` |

## 属已记录决策 / 非功能缺口
- API 路径保留 `/api/projects`、`/api/files/upload`；`file-changes` 在 projects 下，不新增 `/api/spaces` 别名。
- `GET /api/files/{id}?version=n` 返回元数据，内容下载走 `/api/files/{id}/download?version=n`；功能齐全，但与方案文字契约不一致。
- 恢复与回收站恢复共用 `POST /api/files/{id}/restore`，按删除状态分派。
- 不做旧壳开关、不做 WYSIWYG/live preview、不做对象存储。
- 未执行 git 提交（本次操作约定），因此 vendor/新模块尚未“提交入库”。

## 建议补齐批次
- **P0（交互缺陷，改动小）**：Markdown 速录、Ctrl+K 冲突、命令面板用户直达。
- **P1（方案明确项）**：发现/搜索 IA、文档顶栏与元信息、大纲滚动跟随、预览 pane、网格 hover/排序、成员加入时间与最后活跃、空间设置入口与转让选人、初始化安全提示、ARCHITECTURE 约束、移动端四项、设计刻度收口。
- **P2（需要产品决策/新契约）**：通知数据模型、PAT 审计端点、版本备注字段、存储配额策略、冲突弹窗上传者姓名。
