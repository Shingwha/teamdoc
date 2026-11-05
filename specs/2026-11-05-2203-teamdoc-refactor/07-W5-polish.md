# W5 · 设计刻度、移动端与状态统一
> 依赖：W4-a..d 全部合并；基线分支 `refactor/teamdoc-v1.4`。分支 `wave/w5-polish`；worktree `~/.worktrees/teamdoc/w5-polish`（lead 创建）。写入范围：`web/css/{tokens,components,app,drive,admin,editor}.css`、`web/js/ui.js`、跨模块小修、相关布局/视觉测试、本 handoff。worker 在分支提交，lead 门禁后 `merge --no-ff`。

## 目标
收口方案 §6.2/§6.11/§6.12：三层表面、44px 列表行、按钮默认 sm、pressed 10%、输入 focus 2px、树选中浅灰+2px 左条、toast 3000ms；移动端触控 ≥40、表格横向滚动、文件区窄屏列表、状态四态统一。

## 验收
全量快速组 + 布局/视觉契约 + 真实浏览器宽/窄屏抽验；无 960 断点扩散；设计令牌无旧档残留。

## 前置上下文
待 W4 合并后由 lead 补写。
