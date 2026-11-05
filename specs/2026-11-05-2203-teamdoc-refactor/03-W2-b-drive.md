# W2-b · 云空间版本体验
> 写入范围：`lite/web/js/views/drive.js`、`lite/web/css/drive.css`、新增 `lite/tests/test_drive_versions.py`、本 handoff。

## 目标
完成 §6.5 与 §3.4 的全部前端流程，保留既有文件夹、预览、分享、移动、zip、拖拽和并发上传能力。

## 前置上下文
读 overview/interfaces/W1-a handoff/W2-a 工单中的集成约束。Endpoints 函数与 dispose 由 W2-a 提供，本工单不得改共享文件。

## 工单
1. 网格为默认，列表行 44；名称下显示 `vN · 大小 · 相对时间`；工具条选中单文件时出现主按钮「上传新版本」。
2. 行操作与右键菜单均有上传新版本/版本历史；隐藏 file input 选文件后 raw body POST versions，保持名称，刷新行和选中态。
3. 版本历史右侧 400px drawer（窄屏全屏由共享 960 规则/组件类实现），时间线显示版本/时间/大小/操作者，支持任意版本下载与恢复；恢复生成新版本并刷新。
4. 普通上传同名 409 不丢弃文件；批量冲突收集后单次弹窗，每行选保留两个/创建新版本，使用 nameMode=keep 或 versionOf 重试。无冲突上传保持并发 3、进度、目录结构。
5. 通过 `dispose` 注册清理；可见时每 15 秒轮询 fileChanges，从返回 nextSeq 继续，变化时刷新当前目录，离页无定时器。
6. 上传失败/空态/错误使用 UI 规范；保留 VIEWER 权限隐藏写操作。新增测试至少静态验证所有入口、409 两分支、版本下载/恢复和定时器清理；可写真实浏览器 fixture，但不得改共享测试。

## 验收
后端文件版本 14 项保持通过；新增测试全绿；明确正常 index 集成需等 W2-a，不伪报整站。无 `/api/` 字面量、无 FastAPI 修改。

## 禁触
index/app/route/ui/endpoints、其他 CSS/JS/views、server、既有共享测试、editor。无 git 写操作。

## 交接
写 `handoff/W2-b-drive.md`：接口使用、冲突队列语义、真实测试、行号、集成注意。
