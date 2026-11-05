# 仓库地图

## 目录职责
- `lite/server/`：FastAPI + SQLAlchemy + SQLite 后端，当前平铺模块。
- `lite/web/`：原生 JS SPA、CSS 和本地 vendor，无运行时构建。
- `lite/tests/`：pytest 隔离实例、HTTP/WS/浏览器契约测试。
- `lite/tools/editor/`：CM6 开发期打包工程，产物提交到 `web/vendor/codemirror/`。
- `specs/2026-11-05-2203-teamdoc-refactor/`：本次实施契约与交接。

## 入口与核心模块
- 服务端 `server/main.py`：恢复 → schema → 路由 → 静态托管 → 调度。
- ORM 当前在 `server/models.py`；目标为 `db.py`、纯 ORM `models.py`、`storage.py`、`treeutil.py`。
- 通用 HTTP 参数从 `auth.py` 拆至 `http_util.py`；认证拆至 `security/`。
- 文档保存 `docs.py::save_doc_content` 同时服务 REST 与 WS。
- 前端 `index.html` 脚本顺序即依赖图；`app.js` 壳，`route.js` 分派，`scopes.js`  keyed scope 复用。
- 编辑器业务在 `views/doc-editor.js`，旧 textarea 增强器为 `doceditor.js`；预览栈 `markdown.js` 独立。
- 响应形状集中在 `serialize.py`，API 路径集中在 `web/js/endpoints.js`。

## 真实命令
```bash
cd lite/server
uv sync
uv run pytest ../tests
uv run pytest ../tests -m "slow or not slow"
uv run pytest ../tests/test_smoke_endpoints.py ../tests/test_files_paging.py ../tests/test_upload_security.py
uv run uvicorn main:app --host 127.0.0.1 --port 8000  # 单 worker

cd lite/tools/editor
npm install
npm run build  # 输出 ../../web/vendor/codemirror/editor.bundle.js
```

## 关键类型与数据流
- 所有资源 id 为 26 位 ULID；错误信封 `{detail:{code,message}}`。
- `AuthContext` 提供用户、PAT 与项目角色；全局 ADMIN 是项目角色下限。
- `File` 当前只有创建字段；W1 增加版本和更新字段。上传先写临时随机物理文件，再提交 DB；失败删新文件。
- `DocEditor.mount(container, options)` 返回门面；业务视图只经门面取值、设值、插入、焦点和事件。
- `Route.resolve()` 是路由事实唯一来源；`Scope.apply` 以 key 决定复用，挂载路径同步。

## 约定
- 中文注释只描述当前约束，不写历史或兼容说明。
- 服务层不 import FastAPI；视图不出现 `/api/` 字面量或 CodeMirror 包。
- 不留旧接口 shim；迁移仅限数据库结构升级。
- 样式媒体查询遵守 `test_layout_contract.py`；960 形态断点只在 `app.css` 与 `UI.NARROW`。
- 浏览器测试使用既有 harness，不新增测试框架。

## 环境陷阱
- Windows + Git Bash；路径使用非 ASCII 方案文件名，命令中用引号。
- `uv` 已创建 `lite/server/.venv`；该目录不得纳入交付。
- 测试自建临时数据目录和空闲端口；并行 worker 不起固定端口服务。
- Node/npm 可用；CM 依赖只在开发期安装，运行时只加载本地 IIFE bundle。
- 基线 Mermaid 主题 SVG id 断言已失败，禁止把它误算为重构回归。
- 长 I/O 前 `release_db()`；测试直接用中文 HTTP body，不用 Windows curl。
- 快速组全量约 100 秒：`test_visual_sweep_all_routes` 15.6s（逐路由启动无头 Chrome）、`test_login_throttle` 约 15s（用例各自起隔离实例）、`test_smoke_endpoints` 4.5s；其余 112 项约 18s。改单域只跑定向文件（5–30 秒），全量留给波末/终验。

## 找 X 去哪
- 参数/认证：`http_util.py`、`security/`（W1 后）。
- 文件版本：`services/versions.py`、`services/files.py`、`routers/files.py`。
- 文档冲突：`services/docs.py`、`routers/docs.py`、`ws.py`。
- 备份/孤儿：`services/backup.py`、`services/files.py`、`routers/admin.py`。
- CM 键位/主题/扩展：`web/js/editor/`。
- 壳与导航：`app.js`、`route.js`、`views/`。
- 设计刻度：`css/tokens.css`；组件：`components.css`；布局：`app.css`。
- 测试用途索引：`lite/tests/README.md`。
