# W2-c · 管理后台分区
> 写入范围：`lite/web/js/views/admin.js`、`lite/web/js/views/admin/**`、`lite/web/css/admin.css`、新增 `lite/tests/test_admin_sections.py`、本 handoff。

## 目标
完成 §6.9：同应用强隔离、左侧子导航、总览/用户/空间/存储/备份/安全分区，保留 refresh 注册表和现有备份恢复流水线。

## 前置上下文
读 overview/interfaces/W1 handoff/W2-a 工单。App.loadAdmin 动态加载和 Route.admin 由 W2-a 提供；adminOverview 由 W2-d 提供。普通 index 不再静态加载本域脚本。

## 工单
1. admin.js 根据 Route.current().segs[2] 渲染左子导航+当前分区；缺省 overview。每区保留工厂 `{key,load}` 与 ctx.refresh，切区不叠成全站长页。
2. 新增 overview：用户数/空间数/存储图形/今日登录/锁定/备份/近配额待办；数据来自 adminOverview，不在前端拼一套伪统计。
3. users：44 行、搜索、全部/管理员/禁用/7日活跃 chips、多选批量启禁用、新建/重置密码；详情改 480 drawer，身份/所属空间/锁定/会话/事件。所属空间可改角色/移出，加入空间复用统一选择交互并就地刷新。
4. projects：owner/成员/用量/创建时间、搜索、新建/归档/删除/转让、成员直达空间设置或本域成员抽屉；不跳回主应用长表单。
5. storage/backup/security 现有能力保留并收进独立分区，安全含登录动态与节流状态。命令面板管理员直达所需的视图 API 在 handoff 声明。
6. 全部空/加载/错误/成功状态统一；移动单子导航，drawer 窄屏全屏；新测试验证分区注册、非竖排、总览与双视角入口，不能依赖静态 index 已加载 admin。

## 验收
新增测试全绿；可运行既有后端 admin/session 测试；正常 index 集成等待 W2-a 后由 lead 复验。普通用户不下载 admin 代码由 W2-a 测试负责，本域不得往全局注入自动加载。

## 禁触
index/app/route/ui/endpoints、共享 CSS、server、drive/editor、既有共享测试。无 git 写操作。

## 交接
写 `handoff/W2-c-admin.md`：分区/公开函数、真实测试、集成要求、文件行号与未验项。
