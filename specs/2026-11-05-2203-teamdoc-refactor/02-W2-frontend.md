# W2 · 界面整体重构（占位）

## 目标
完成 §6 的 Material 3 精修、顶栏与单空间壳、空间首页/最近、命令面板、云空间版本交互、团队管理、个人设置、同应用强隔离管理后台、登录向导、移动端和统一状态。

## 范围
`lite/web/index.html`、除 W1-b 已交付编辑器内部以外的 JS/CSS、相关浏览器与布局测试、`lite/ARCHITECTURE.md`、`lite/tests/README.md`。接入 W1-b handoff 的 script 清单和 W1-a 的真实 API。

## 验收
所有新路由与核心操作可用；普通用户不下载 admin 代码；文档树仅左栏一份；文件可显式上传新版本、处理同名冲突、查看/下载/恢复历史；设置/管理子导航和窄屏可用；前端契约与全量测试通过。

## 依赖
W1-a、W1-b 完成，handoff 通过质量门禁，`ref/interfaces.md` 回写真实接口。

## 前置上下文
- 必读：`handoff/W1-a-backend.md` 与 `handoff/W1-b-editor.md`；lead 已复跑全量：**152 passed, 1 skipped, 2 failed, 3 deselected**（失败为已登记 Mermaid 基线与 `/js/doceditor.js` 404，后者由 W2-a T1 接线消除）。
- W1 实际路径与门面以 `ref/interfaces.md` 为准；index 的 7 个 CM 脚本按 W1-b C 节顺序接入。
- 稳定区：`server/services/versions.py`、`server/services/files.py`、`web/js/editor/**`、`tools/editor/**`；除 W2-d 的新增契约外不得重写。
- 已知坑：旧 doceditor.js 已删除，主区树仍在；普通 index 尚未接 CM；Mermaid SVG id 是基线失败，不在本波修复。
- W2 细分为 a/b/c/d 四份工单，写入文件严格不相交；共享集成函数在 interfaces 中冻结。
