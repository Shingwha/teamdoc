# W8 · 终验与测试收敛
> 依赖：W7 已合并（`f198dd9`）。lead 在基线分支 `refactor/teamdoc-v1.4` 执行；不开新 worktree。

## 目标
最终验证交付状态，清理 worktree，固化测试清单与遗留项。不再新增能力或大改代码；只允许跨模块小修与测试套件最终收敛。

## 终验清单
1. 全量快速组：`cd lite/server && uv run pytest ../tests -q` → 仅登记 Mermaid 基线失败。
2. slow 组：`-m slow` → 3 passed。
3. 核心路径浏览器抽验（真实服务端 + 真实 index）：
   - 登录 → 空间首页 → 文档编辑/预览 → 云空间版本抽屉/恢复 → 个人设置 → 空间设置抽屉 → 管理后台六区 → 窄屏；
   - 通知铃铛、命令面板、空间切换器两页签、发现加入；
   - 全程 `errors=none`，普通用户不请求 admin JS。
4. 测试清单：统计选中数、文件职责、保留理由；确认无字符串式/重复/冗余断言残留；记录基线失败。
5. 代码卫生：
   - `git status` 干净；无未跟踪临时页/数据目录；
   - grep：`views/recent.js` 不存在、无 `/api/` 字面量、无旧令牌/旧类名回流；
   - `ARCHITECTURE.md` / `tests/README.md` 与现状一致。
6. 清理 worktree：W5/W6/W7 三个 worktree 删除（保留分支）；主检出保留在 `refactor/teamdoc-v1.4`，工作区干净。
7. 更新 overview 最终状态；输出交付报告：波次、提交图、门禁数字、方案缺口闭环情况、遗留与需用户决策项。

## 验收
- 上述 1–6 全部通过；最终报告贴真实命令与数字。
