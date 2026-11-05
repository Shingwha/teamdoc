"""云空间版本入口与历史时间线的行为契约。

旧的逐字符串静态断言(函数名/类名/正则)已删除:它们只钉实现写法,改个变量名就红,
却抓不到"按钮点了没反应"。这里用真实 driveBody + 桩数据层跑一遍用户会走的动作:
文件瓦片有三个版本入口 -> 打开历史抽屉 -> 时间线显示备注 -> 行右键菜单同源 ->
工具条排序真的带 sort/dir 重新取数 -> 选中文件后工具条出现「上传新版本」。

服务端版本语义(上传新版本/恢复/下载)由 test_file_versions.py 与
test_file_version_services.py 守;页面整体无 JS 错误由 test_visual_sweep.py 守。
"""
import os

import pytest

from _chrome import dump_page, find_chrome, read_report
from _harness import WEB_DIR

pytestmark = pytest.mark.browser

PAGE_HTML = """<!DOCTYPE html>
<html lang="zh-CN" data-theme="light" data-color="blue">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/vendor/remixicon/remixicon.css">
<link rel="stylesheet" href="/css/tokens.css">
<link rel="stylesheet" href="/css/base.css">
<link rel="stylesheet" href="/css/components.css">
<link rel="stylesheet" href="/css/app.css">
<link rel="stylesheet" href="/css/drive.css">
</head>
<body>
<div id="view"></div>
<div id="toast-root"></div>
<script>
  window.__errors = [];
  window.onerror = function (m, s, l) { window.__errors.push(m + ' @line' + l); return false; };
</script>
<script src="/js/api.js"></script>
<script src="/js/endpoints.js"></script>
<script src="/js/theme.js"></script>
<script src="/js/ui.js"></script>
<script src="/js/route.js"></script>
<script src="/js/scopes.js"></script>
<script src="/js/ref.js"></script>
<script src="/js/views/drive.js"></script>
<script>
(function () {
  var OUT = {};
  var calls = [];
  var lastFilesQuery = '';
  var F1 = '01M6PGAFNDBNWN073XNJXK0VNS';
  var F2 = '01M6PGAFQ5JVNJ9PYFJK9NK3MZ';
  var FILES = {
    folders: [],
    files: [
      { id: F1, name: '方案.md', mime: 'text/markdown', size: 3072, version: 2,
        createdAt: '2026-11-04T09:00:00', updatedAt: '2026-11-05T10:00:00',
        canInline: true, isText: true, folderId: null, referenced: false, shared: false },
      { id: F2, name: '截图.png', mime: 'image/png', size: 4096, version: 1,
        createdAt: '2026-11-05T09:00:00', updatedAt: '2026-11-05T09:00:00',
        canInline: true, isText: false, folderId: null, referenced: false, shared: false },
    ],
    hasMore: false,
    total: { folders: 0 },
  };
  var STORAGE = {
    active: { bytes: 7168, fileCount: 2, folderCount: 0 },
    trash: { bytes: 0, fileCount: 0 },
    disk: { free: 1000000 },
  };
  var VERSIONS = [
    { version: 2, size: 3072, createdAt: '2026-11-05T10:00:00', createdByName: '张三',
      note: '修复表格排版' },
    { version: 1, size: 2048, createdAt: '2026-11-04T09:00:00', createdByName: '张三',
      note: null },
  ];

  function ok(v) { return Promise.resolve(v); }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // 只桩数据层:路径仍由 Endpoints 真实构造,顺带守住"调了哪个端点"。
  window.api = function (path) {
    calls.push(path);
    if (path.indexOf('/versions') > 0) return ok(VERSIONS);
    if (path.indexOf('/api/files?') === 0) {
      lastFilesQuery = path;
      return ok(FILES);
    }
    if (path === '/api/projects/P1/storage') return ok(STORAGE);
    if (path.indexOf('/file-changes') > 0) return ok({ changes: [], nextSeq: 0 });
    return ok({});
  };
  window.App = { route: Route, user: { id: 'u1', isAdmin: true } };
  // 下载只记录 URL,不真的触发浏览器下载
  UI.download = function (href) { OUT.downloadHref = href; };

  function report() {
    var lines = ['errors=' + (window.__errors.join(' | ') || 'none')];
    Object.keys(OUT).forEach(function (k) { lines.push(k + '=' + OUT[k]); });
    var el = document.createElement('pre');
    el.id = 'sweep-out';
    el.textContent = lines.join(String.fromCharCode(10));
    document.body.appendChild(el);
  }

  window.addEventListener('load', function () {
    var NARROW = new URLSearchParams(location.search).get('mode') === 'narrow';
    setTimeout(async function () {
      try {
        Route.setCurrent({
          segs: ['p', 'P1', 'files'], hash: '#/p/P1/files', pid: 'P1', tab: 'files',
          query: new URLSearchParams(''),
        });
        var disposers = [];
        var frag = Views.driveBody({
          projectId: 'P1', proj: { id: 'P1', name: '项目', myRole: 'OWNER' },
          folderId: null, highlight: null,
          dispose: function (fn) { disposers.push(fn); },
        });
        document.getElementById('view').appendChild(frag);
        await wait(600);

        // 1) 宽屏网格瓦片:文件有 3 个版本入口;窄屏强制列表且网格按钮禁用
        OUT.narrow = NARROW ? 1 : 0;
        OUT.tiles = document.querySelectorAll('#drive-rows .tile').length;
        OUT.initialRows = document.querySelectorAll('#drive-rows .data-table-row').length;
        var gridBtn = document.querySelector('#drive-view-seg button[data-key="grid"]');
        OUT.gridDisabled = gridBtn && gridBtn.disabled ? 1 : 0;
        var acts = document.querySelector('#drive-rows .tile .tile-acts');
        OUT.tileActs = acts ? acts.querySelectorAll('button').length : 0;

        // 2) 点版本历史 -> 抽屉时间线;备注只在有值时出现
        var versionBtn = document.querySelector(
          '#drive-rows .tile .act-versions, #drive-rows .data-table-row .act-versions');
        if (versionBtn) versionBtn.click();
        await wait(400);
        OUT.drawer = document.querySelector('.drive-drawer') ? 1 : 0;
        OUT.versions = document.querySelectorAll('.drive-v-item').length;
        OUT.currentBadge = document.querySelectorAll('.drive-v-item.current').length;
        OUT.note = (document.querySelector('.drive-v-note') || {}).textContent || '';
        OUT.restoreOffered = document.querySelectorAll('.drive-v-restore').length;
        var dl = document.querySelector('.drive-v-item .drive-v-dl');
        if (dl) dl.click();
        await wait(80);
        var close = document.querySelector('.drive-drawer-close');
        if (close) close.click();
        await wait(120);
        OUT.drawerClosed = document.querySelector('.drive-drawer') ? 0 : 1;

        // 3) 列表形态:行内也有版本入口,右键菜单与瓦片「更多」同源
        var listTab = document.querySelector('#drive-view-seg button[data-key="list"]');
        if (listTab) listTab.click();
        await wait(400);
        OUT.rows = document.querySelectorAll('#drive-rows .data-table-row').length;
        OUT.rowActs = document.querySelectorAll('#drive-rows .data-table-row .act-versions').length;
        OUT.nameSub = (document.querySelector('.drive-name-sub') || {}).textContent || '';
        var row = document.querySelector('#drive-rows .data-table-row');
        if (row) {
          row.dispatchEvent(new MouseEvent('contextmenu', {
            bubbles: true, cancelable: true, clientX: 20, clientY: 20,
          }));
        }
        await wait(200);
        OUT.contextVersions = ((document.querySelector('.menu') || {}).textContent || '')
          .indexOf('版本历史') >= 0 ? 1 : 0;
        UI.closeOpenMenu();

        // 4) 工具条排序:网格没有表头,必须真的带 sort/dir 重新取数
        var sortName = document.querySelector('#drive-sort-seg button[data-key="name"]');
        if (sortName) sortName.click();
        await wait(400);
        OUT.sortQuery = lastFilesQuery;
        var dirBtn = document.getElementById('btn-sort-dir');
        if (dirBtn) dirBtn.click();
        await wait(400);
        OUT.dirQuery = lastFilesQuery;

        // 5) 选中单个文件 -> 工具条出现「上传新版本」主入口
        var box = document.querySelector('#drive-rows .data-table-row .sel-box');
        if (box) box.click();
        await wait(120);
        OUT.versionBtnVisible = document.getElementById('btn-version-upload') &&
          !document.getElementById('btn-version-upload').hasAttribute('hidden') ? 1 : 0;

        // 6) 离开本层:dispose 收回定时器与抽屉
        disposers.forEach(function (fn) { fn(); });
        OUT.disposedClose = document.querySelector('.drive-drawer') ? 0 : 1;
      } catch (e) {
        OUT.exception = (e && e.message) || String(e);
      }
      report();
    }, 120);
  });
})();
</script>
</body>
</html>
"""


def test_drive_version_actions_and_timeline(base_url):
    chrome = find_chrome()
    if not chrome:
        pytest.skip("未找到 Chrome/Edge,跳过云空间版本交互巡检")

    page = WEB_DIR / ("_drive_versions_check_%s.html" % os.getpid())
    page.write_text(PAGE_HTML, encoding="utf-8")
    try:
        # 宽屏才有网格瓦片;窄屏验证强制列表与网格按钮禁用。
        wide = read_report(dump_page(chrome, base_url, page.name,
                                     budget=25000, window_size="1280,900"))
        narrow = read_report(dump_page(chrome, base_url, page.name, "mode=narrow",
                                       budget=25000, window_size="500,900"))
    finally:
        if page.exists():
            page.unlink()

    for label, info in (("宽屏", wide), ("窄屏", narrow)):
        assert info is not None, f"{label}测试页没有产出报告(云空间脚本整块崩了?)"
        assert info.get("errors") == "none", f"{label}云空间版本页 JS 错误: {info.get('errors')}"
        assert not info.get("exception"), f"{label}测试步骤抛错: {info.get('exception')}"

    problems = []

    # 宽屏网格形态
    if wide.get("narrow") != "0":
        problems.append("宽屏误判为窄屏形态")
    if wide.get("tiles") != "2":
        problems.append(f"宽屏网格瓦片数不对: {wide.get('tiles')}")
    if wide.get("initialRows") != "0":
        problems.append(f"宽屏不应以列表起步: {wide.get('initialRows')}")
    if wide.get("tileActs") != "3":
        problems.append(f"文件瓦片应有 3 个版本入口: {wide.get('tileActs')}")

    # 窄屏强制列表、网格按钮禁用(版本入口仍在行内可达)
    if narrow.get("narrow") != "1":
        problems.append("窄屏没有命中 NARROW 形态")
    if narrow.get("tiles") != "0":
        problems.append(f"窄屏不应渲染网格瓦片: {narrow.get('tiles')}")
    if narrow.get("initialRows") != "2":
        problems.append(f"窄屏应以列表显示两行: {narrow.get('initialRows')}")
    if narrow.get("gridDisabled") != "1":
        problems.append("窄屏网格按钮应禁用")

    # 两种形态共同的版本行为
    for label, info in (("宽屏", wide), ("窄屏", narrow)):
        if info.get("drawer") != "1":
            problems.append(f"{label}:点版本历史没有打开抽屉")
        if info.get("versions") != "2":
            problems.append(f"{label}:版本时间线行数不对: {info.get('versions')}")
        if info.get("currentBadge") != "1":
            problems.append(f"{label}:当前版本徽标数不对: {info.get('currentBadge')}")
        if "修复表格排版" not in info.get("note", ""):
            problems.append(f"{label}:版本备注没有渲染: {info.get('note')!r}")
        if info.get("restoreOffered") != "1":
            problems.append(f"{label}:非当前版本应且仅应提供恢复: {info.get('restoreOffered')}")
        if "/download" not in info.get("downloadHref", "") or "version=2" not in info.get("downloadHref", ""):
            problems.append(f"{label}:版本下载没有带版本号: {info.get('downloadHref')}")
        if info.get("drawerClosed") != "1":
            problems.append(f"{label}:版本抽屉关不掉")
        if info.get("rows") != "2":
            problems.append(f"{label}:列表行数不对: {info.get('rows')}")
        if info.get("rowActs") != "2":
            problems.append(f"{label}:每个文件行应有版本入口: {info.get('rowActs')}")
        if "v2" not in info.get("nameSub", ""):
            problems.append(f"{label}:文件行没有版本标签: {info.get('nameSub')!r}")
        if info.get("contextVersions") != "1":
            problems.append(f"{label}:右键菜单没有复用版本历史入口")
        if "sort=name" not in info.get("sortQuery", ""):
            problems.append(f"{label}:工具条排序没有带 sort: {info.get('sortQuery')}")
        if "dir=desc" not in info.get("dirQuery", ""):
            problems.append(f"{label}:方向按钮没有带 dir: {info.get('dirQuery')}")
        if info.get("versionBtnVisible") != "1":
            problems.append(f"{label}:选中单个文件后工具条没有出现「上传新版本」")
        if info.get("disposedClose") != "1":
            problems.append(f"{label}:dispose 没有关闭版本抽屉")

    assert not problems, "云空间版本契约失败:\n" + "\n".join("  - " + p for p in problems)
