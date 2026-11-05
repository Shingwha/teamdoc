# 目标接口契约（W2 已回写）

## 后端分层
- `db.py`：`engine/SessionLocal/get_db/release_db/utcnow/is_live`。
- `models.py`：仅 SQLAlchemy ORM；`FileVersion`、`FileChange` 为新增表。
- `storage.py`：`FILES_DIR/DB_PATH/INFLIGHT_STORAGE/storage_basename/file_abspath/disk_* /unlink_quiet`。
- `treeutil.py`：`build_tree/collect_subtree/next_sort/ancestor_names/location_json`。
- `http_util.py`：通用字段解析、`client_ip/client_ua`。
- `security/`：`passwords.py`、`sessions.py`、`context.py`，不反向依赖 router/service。
- `services/` 不 import FastAPI；`routers/` 持有 APIRouter。

## 文件模型与序列化
`File` 增加 `version:int`、`updated_by:str?`、`updated_at:datetime`。`FileVersion`：
`id, file_id, version, storage_path, size, created_by, created_at`，唯一 `(file_id, version)`。
`FileChange`：`seq, file_id, space_id, op, at`，其中 ORM 的 `space_id` 映射现有 `projects.id`。

`file_json` 增加 camelCase `version/updatedBy/updatedAt`，保留现有响应字段。版本项返回：
`{version,size,createdAt,createdBy,createdByName}`；创建者展示名可由序列化上下文提供。

## 上传与版本 API
- `POST /api/files/upload?projectId=&folderId=&docId=&name=`
  - 默认同目录同名返回 409，错误 `code=name_exists`，`detail.existing` 含 `{id,name,size,updatedAt,updatedBy}`。
  - `name_mode=keep`：使用现有 dedupe 规则保留两个。
  - `version_of={fileId}`：为指定文件创建 version+1，忽略上传显示名且保持原文件名。
- `POST /api/files/{id}/versions?name=`：raw body 流式上传，文件名不变，返回最新 `file_json`。
- `GET /api/files/{id}/versions`：按 version 降序。
- `POST /api/files/{id}/restore`，JSON `{version:int}`：登记为 version+1，返回最新 `file_json`。
- `GET /api/files/{id}/download?version=n` 与 `GET /api/files/{id}?version=n`：历史版本内容/元数据按已有下载语义处理；分享链接始终下载当前版本。
- `GET /api/projects/{id}/file-changes?since=0&limit=200`：`{changes:[{seq,fileId,spaceId,op,at}],nextSeq}`。

EDITOR 可上传与恢复；VIEWER 可列表和下载。只有未删除资源可见。非法版本 404，越权沿用统一 403/404 规则。

## 事务与物理清理
上传分“落盘前校验 / 无 DB 连接的长 I/O / 最终事务”三段；最终事务同时更新 File、插入 FileVersion、插入 FileChange。恢复不复制物理文件。彻底删除文件/空间先提交 DB，再删除所有不再被引用的版本物理文件。备份与孤儿扫描必须包含全部版本路径。

## DocEditor 门面
全局唯一入口 `window.DocEditor`，视图禁止直接引用 `CM6`。
```js
const editor = DocEditor.mount(host, {
  value, projectId, readOnly, upload,
  onChange(value), onSave(), onFocus(), onBlur(), onCursor({line,column}),
  onModeChange(mode)
});
editor.getValue();
editor.setValue(value, {preserveSelection:true});
editor.insertText(text);
editor.insertRef(item);
editor.focus();
editor.getCursor();
editor.getHeadings();
editor.scrollToHeading(id);
editor.setPreviewVisible(boolean); // 宽屏 pane；窄屏由视图模式控制
editor.destroy();
```
挂载 host 使用 `#md-source`，但它是 div 而非 textarea。程序化 `setValue` 不触发 `onChange`；用户编辑触发一次。保存快捷键只回调，不自行写 API。`destroy` 清理所有 DOM/全局监听。

## W2 路由与壳（已按真实代码回写）
- `#/` 不重定向：home 层解析 localStorage 记忆空间并渲染首页；无空间时同页显示空间管理/创建入口。`#/projects` 是空间管理页。
- 空间内：`home/recent/favorites/docs/files/members/trash/settings`；成员与空间设置深链在首页上打开同一 480px 抽屉。
- `#/settings/{account|security|preferences}`；`#/admin/{overview|users|projects|storage|backup|security}`。
- 管理代码仅管理员动态加载，普通用户不请求 admin JS；`App.loadAdmin()` 按 overview→storage→backup→projects→users→security→admin 顺序注入。
- 分区取段：优先 `route.section`（`Route.resolve` 在 `setCurrent` 之前算好），回落 `segs[2]`，再回落 `segs[1]`（真实文法 `#/admin/{section}` 是 `segs[1]`）；非法值回落 overview。不要退回“只读 `Route.current()`”。
- `Views.adminSections` 是分区元数据（`[{key,label,icon}]`）唯一来源；命令面板/深链用 `Route.admin(key)`，不手拼 hash。
- 顶栏提供空间切换器、命令面板、通知、设置和头像菜单；文档树只在左栏 `#side-doc-tree`，主区不再有树列。
- 加入空间后落点保持 `docs`（新成员先看内容），不落 home。

W1 已完成并回写：上述文件接口与真实代码一致；`docId` 附件默认 dedupe，普通上传默认 409。回收站恢复与版本恢复共用 `/api/files/{id}/restore`，按删除状态分派。CM 的 7 个 script 顺序为 vendor bundle → editor/markdown → keymap → theme → extensions → panels → index。

## W2 补充服务端契约
- `PATCH /api/users/me`：`{name?,email?,avatarColor?}`，返回 `{user}`；颜色为 `#RRGGBB`，缺省沿用 id 派生色。其它字段（含 `isAdmin`）400。
- `GET /api/auth/sessions`：当前用户会话 `[{ref,ip,device,deviceKind,createdAt,lastSeenAt,expiresAt,online,current}]`；`ref=sha256(token)`，原始 token 不下发，PAT 不可管理 web 会话。
- `DELETE /api/auth/sessions/{ref}`：吊销自己的一个非当前会话（当前会话 409，别人的 ref 404）；`DELETE /api/auth/sessions`：吊销其他全部会话。
- Project 响应新增 `color/quotaBytes/archivedAt/storageBytes`。`PATCH /api/projects/{id}` 接受 `color/quotaBytes/archived`；`quotaBytes` 的 0/null/空串归一为不限额，负数 400；个人空间不可归档。归档默认从空间列表隐藏，`GET /api/projects?archived=1` 只列归档，管理员 `all=1` 含归档。
- 归档是服务端只读态：文档/文件/文件夹/回收站/成员写路径统一 403 `SPACE_ARCHIVED`；空间级 PATCH 在解除归档前也 403，唯一例外是 `{"archived": false}`。GET/下载/搜索/WS 读不受影响。WS `content` 写以关闭码 **4403** 拒绝（不发 saved）。
- `POST /api/projects/{id}/transfer`，`{userId}`：仅实际 OWNER 成员可发起；目标须存在、未禁用、已是成员且非 OWNER。原子转让，原 owner 降为 ADMIN。
- 创建空间接受可选 `members:[{userId,role}]`，与空间在同一事务创建；role 缺省 VIEWER。
- `GET /api/search` 新增可选 `projectId/updatedBy`；不可见 `projectId` 返回空集而非 403，不泄露空间存在性；doc 行新增 `updatedBy/updatedByName`。
- `GET /api/admin/overview` 返回 `{userCount,spaceCount,todayLoginCount,lockedCount,storage,nearQuota,backup}`；`nearQuota` 为非个人、配额>0 且用量/配额 ≥ 0.8，按 ratio 降序；storage 复用管理存储总览，backup 为现有状态摘要。
- 迁移：`users.avatar_color`、`projects.color/quota_bytes/archived_at` 为幂等加法迁移，不改存量数据。

## W2 前端集成函数（已按真实代码回写）
- `Endpoints.me()`、`mySessions()`、`mySession(ref)`、`projectTransfer(pid)`、`adminOverview()`。
- `Endpoints.fileVersions(id)`、`fileVersionUpload(id,name)`、`fileRestore(id)`、`fileChanges(pid,since,limit)`；`fileDownload(id,inline,version)` 第三参可选。
- `FilesAPI.upload(opts)` 透传 `nameMode/versionOf`；`Views.driveBody` 接受 `dispose(fn)`，用于清理轮询/抽屉。
- `App.loadAdmin()` 返回 Promise，仅管理员路由调用；普通用户不得请求 admin JS。
- `Route.admin(section)` 与 `Route.settings(tab)` 为对应 hash 构造点；`App.route` 同时暴露 project/settings/admin 三个构造器。
- 新 `css/drive.css`、`css/admin.css` 由 index 引入；admin JS 仍按需加载，CSS 可共享。


## W4 新增契约（先冻结，前后端并行）
### 通知
- 表 `notifications(id, user_id, kind, title, body, link, created_at, read_at)`；kind 取值 `space_added | role_changed | owner_transferred`。
- `GET /api/notifications?limit=20` → `{items:[{id,kind,title,body,link,createdAt,readAt}], unread}`；只返回本人，按时间倒序。
- `POST /api/notifications/read` `{ids:[...]}` → `{ok,updated}`；只改本人未读。
- `POST /api/notifications/read-all` → `{ok,updated}`。
- 生产者：加入空间（单加/邀请/后台加入）、角色变更、owner 转让；通知受影响用户，`link` 为前端 hash（如 `#/p/{pid}/home`）。
### PAT 审计（只读）
- `GET /api/admin/pats?userId=&limit=100` → `{items:[{id,userId,userName,userEmail,name,scopes,createdAt,lastUsedAt,revokedAt}]}`；管理员；不返回 token/hash。
### 文件版本备注
- `FileVersion.note` 可空、≤200；`POST /api/files/{id}/versions?name=&note=`；`POST /api/files/{id}/restore {version, note?}`，note 缺省为 `恢复自 v{n}`。
- `GET /api/files/{id}/versions` 每项增加 `note`（可空）。
### 成员字段
- 成员列表项增加 `createdAt`（成员加入时间）与 `lastActiveAt`（该用户最近成功登录，可空）。成员行仍以 `userId/role/user` 为骨架。
### 同名冲突
- 上传 409 的 `detail.existing` 增加 `updatedByName`（可空字符串）；其余字段不变。
### 前端集成
- 新增 `Endpoints.notifications()`、`notificationsRead()`、`notificationsReadAll()`、`adminPats(params)`；`fileVersionUpload(id,name,note)`。
- 空间切换器逐空间设置入口调用 `SpaceSettings.open(projOrNull, pid, tab)`（签名不变）；`App.spaces` 项含 `myRole`。
- 命令面板用户捷径改为 `#/admin/users?user={id}`；管理用户区读 `user` 打开详情，读 `q` 过滤列表。

## W6/W7 分层与前端收口（最终）
- FastAPI 适配层集中在 `deps.py`（get_db/鉴权/请求头/IdPath）；`security/context.py` 只含纯业务 `Actor` 与权限判定；`services/**` 触达 FastAPI 的唯一链路是 `errors.py`。
- 路由只做参数解析 → service → serialize；登录/初始化、恢复包 I/O、WS 保存/presence 已下沉 service。
- 前端已删除 `views/recent.js` 与 `#/search`、`#/discover` 路由；搜索只走命令面板，发现只在空间切换器「发现空间」页签。
- 测试保留口径：行为/HTTP/浏览器契约优先；静态测试只保留架构契约（layout/render/page assets/frontend refs），不再保留精确令牌清单或实现字符串断言。
