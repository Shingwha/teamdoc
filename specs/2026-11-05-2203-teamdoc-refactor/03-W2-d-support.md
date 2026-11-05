# W2-d · 界面所需服务端契约
> 写入范围：`lite/server/**`、新增 `lite/tests/test_workspace_preferences.py` 与 `lite/tests/test_profile_sessions.py`、本 handoff。

## 目标
补齐界面真实需要的个人资料/会话、空间色彩/配额/归档/转让、空间搜索过滤与管理总览；保持轻分层和安全语义，不碰前端。

## 前置上下文
读 overview/interfaces/W1-a handoff。版本、上传、认证、WS 是稳定区，除归档写守卫外不重写。并行前端按 interfaces 调 API。

## 工单
1. User 增加可选 avatarColor（或等价单一事实），默认仍 id 派生；实现 PATCH users/me，只允许本人 name/email/avatarColor，邮箱唯一与强度/格式校验沿用。管理 patch 同步支持颜色。
2. 实现自己的会话列表、单条吊销和其他会话吊销；只操作 ctx.user，ref 不暴露 token，当前会话不可经单条接口误踢（用 logout）。PAT 不可管理 web 会话。
3. Project 增加 color/quotaBytes/archivedAt，schema 做幂等加法迁移；响应 member/admin 带 storageBytes 等字段。创建空间同事务邀请 members。实现 owner 原子 transfer。
4. 归档：默认列表过滤，发现/管理口径明确；直达可读，文档/文件/文件夹/回收站/成员写路径统一 403 `SPACE_ARCHIVED`，解除归档可执行，GET/下载/WS 读不受影响，WS content 写也被拒。不能用仅前端隐藏代替。
5. search 增加严格 projectId/updatedBy 过滤；无权空间不泄数据。doc row 增加 updatedBy/updatedByName，必要时位置信息可复用现有树工具。
6. admin overview 聚合计数、今日成功登录、锁定、存储、备份状态与 nearQuota（达到 80%）；长 I/O 不持锁，服务无 FastAPI。
7. 新测试覆盖本人权限/会话安全、颜色、归档 REST+WS 写拒与解除、转让、邀请事务、搜索过滤、配额总览和迁移幂等；跑后端快速组。

## 验收
新测试全绿；后端 smoke/files/doc conflict/visibility/session/backup 不回归；服务层无 FastAPI。接口偏差立即写 handoff，不能悄悄改形状。

## 禁触
所有 web/tools、既有前端测试、spec 其他文件。无 git 写操作；不修复基线 Mermaid。

## 交接
写 `handoff/W2-d-support.md`：精确接口/错误码/真实测试、归档规则、迁移与文件行号。
