# W2-a · 设计系统、应用壳与功能页
> 写入范围：`lite/web/index.html`、`js/{app,route,ui,theme,endpoints,scopes}.js`、`js/views/{home,palette,projects,project,docs,doc-tree,recent,search,discover,settings}.js`、`css/{tokens,base,components,app}.css`、既有前端契约测试与本域新增测试、`lite/ARCHITECTURE.md`、`lite/tests/README.md`、本 handoff。

## 目标
完成 §6.1–6.4 壳、§6.6–6.8、§6.10–6.12，并接入 CM6 与 W2-b/c 的集成点。只保留目标 UI，不做旧壳开关。

## 前置上下文
按序读 overview、repo-map、interfaces、W1 两份 handoff、本工单。关键门禁 26 passed。稳定区：server、editor 内核、drive/admin 专属文件均禁触。并行 worker 会提供 drive.css/admin.css 和 admin section 实现。

## 工单
1. index 替换旧 doceditor 为 7 个 CM script；加入 home/palette 与 drive.css/admin.css；删除全部 admin script，管理员经 `App.loadAdmin()` 动态按序加载 overview/storage/backup/projects/users/security/admin。
2. 重写壳：40px 顶栏（空间切换/命令面板/通知/设置/头像），左栏只含当前空间首页/最近/收藏、唯一 DocTree、云空间/回收站；折叠仅图标列，无 72px 双树特例；删除主区树列和 btn-doc-tree。保持 scope 节点复用与离开守卫。
3. `#/` 记忆并进入当前空间 home；空间切换器含我的空间/发现/管理/创建。home 为欢迎+最近文档流+快捷新建/上传；recent 分我编辑/我浏览（浏览可本地记录）；favorites 可用按用户 localStorage，入口/取消/列表闭环。搜索为 Ctrl+K 命令面板，动作+文档文件分组、空输入最近、键盘导航、管理员捷径。
4. project.js 空间设置改右侧 480 drawer：概览/成员/危险区；成员搜索、角色过滤、多选批量角色/移除、统一 personPicker、权限说明、资源计数确认；复用真实 color/quota/archive/transfer API。创建空间向导支持统一选人。
5. settings 改 account/security/preferences 左子导航+右内容：资料自动保存、改密、PAT、自己的会话当前设备/踢除、主题种子色/密度/编辑器字号与预览联动/语言；账号修改后同步 App.user。
6. tokens 按方案三层表面、4/6/10/14 圆角、8 档字阶、密度、低饱和六色、150/200/300 动效；组件 filled input、44 行、36 菜单、统一 focus/toast/dialog；实现 `UI.empty()/UI.error()` 并在新代码使用。登录品牌卡与 bootstrap 第二步首空间/邀请。
7. 960 形态断点与触控/抽屉全屏/移动单栏；更新 ARCHITECTURE、测试 README 和受壳影响的 render/layout/visual/page/join/doc-move 测试。不要为通过静态测试保留旧 DOM 假节点。

## 集成约束
- `Views.driveBody({projectId,proj,folderId,highlight,dispose})` 调 ctx.dispose；drive 由另一 worker 改。
- Admin 路由必须先 await App.loadAdmin 再 resolve/render；非管理员不加载。Admin 使用 Route.admin。
- 不改 `views/doc-editor.js`，如壳接口必须调整，在 handoff 给 lead 精确小修建议。
- 新增 Endpoints 按 interfaces，不改变既有路径。

## 验收
相关前端契约、page assets、CM6、后端 smoke 全绿；正常 index 可登录，空间首页→文档保存→云空间→设置→管理员页面无 JS 错误；普通用户无 admin 请求；窄屏单栏。跑快速全量并区分基线 Mermaid 失败。

## 禁触
server、tools、editor 内核、doc-editor.js、drive.js、admin 视图、drive.css/admin.css、其他工单测试。无 git 写操作。

## 交接
写 `handoff/W2-a-shell.md`：真实命令、路由/DOM/接口变化、并行集成偏差、文件行号、未验项。
