# W6 · 后端整体重构清理
> 依赖：W5 合并。分支 `wave/w6-backend-cleanup`；worktree `~/.worktrees/teamdoc/w6-backend-cleanup`。写入范围：`lite/server/**`、后端测试、本 handoff。worker 在分支提交，lead 门禁后 `merge --no-ff`。

## 目标
只做重构，不新增能力：合并跨 service/router 的重复逻辑；删除死代码与失去消费者的 shim；收敛参数解析/序列化/权限守卫的单一来源；薄化仍含业务的路由；测试去重、删除脆弱/重复断言；保持全部行为与错误码不变。

## 验收
全量快速组 + slow 组全绿（基线 Mermaid 除外）；服务层 FastAPI import = 0；公开契约无变化。

## 前置上下文
待 W5 合并后由 lead 补写。
