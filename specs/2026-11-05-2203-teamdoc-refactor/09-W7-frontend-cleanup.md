# W7 · 前端整体重构清理
> 依赖：W6 合并。分支 `wave/w7-frontend-cleanup`；worktree `~/.worktrees/teamdoc/w7-frontend-cleanup`。写入范围：`lite/web/**`、前端测试、ARCHITECTURE、本 handoff。worker 在分支提交，lead 门禁后 `merge --no-ff`。

## 目标
只做重构：合并重复的 DOM/事件/格式化/请求原语；删除无效模块、失效 CSS 与死分支；统一状态四态调用；测试去重、删除冗余与字符串式脆弱断言（行为测试已覆盖处）；保持交互与路由契约不变。

## 验收
全量快速组 + 浏览器核心路径抽验；无 JS 错误；无重复实现与死代码（grep 证据）。

## 前置上下文
待 W6 合并后由 lead 补写。
