"""管理后台分区契约:子导航 / 路由取段 / 总览数据源 / 用户与空间双视角入口。

为什么是这个口径:
  - 管理后台从"一屏竖排五区"改成"左子导航 + 单分区",最容易静默坏掉的是
    **当前分区没有跟着路由走**(切区不重绘、或六区一起挂成长页);
  - 总览只允许有一个数据源(/api/admin/overview):前端另算一套统计迟早与
    服务端对不上,而页面上看不出哪个数才是真的;
  - 用户详情的「所属空间」与空间区的「成员」是同一段成员关系的两个入口,
    两处都要真的能打开并读到成员。

测试页自己按依赖顺序加载 admin 脚本,不依赖 index.html 静态引入(? W2-a 之后
admin 是动态加载的),也不走 app.js 路由 —— 只把真实 Route 事实设进 Route.setCurrent,
然后调用真实的 Views.adminLevel/Scope 渲染。数据层用 window.api 桩隔离服务端;
服务端行为由 test_smoke_endpoints / test_session_audit / test_admin_storage 守。
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
<link rel="stylesheet" href="/css/admin.css">
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
<script src="/js/views/admin/overview.js"></script>
<script src="/js/views/admin/storage.js"></script>
<script src="/js/views/admin/backup.js"></script>
<script src="/js/views/admin/projects.js"></script>
<script src="/js/views/admin/users.js"></script>
<script src="/js/views/admin/security.js"></script>
<script src="/js/views/admin.js"></script>
<script>
(function () {
  var OUT = {};
  var calls = [];

  var USER_1 = {
    id: 'u1', email: 'zhang@t.local', name: '张三', isAdmin: true, isDisabled: false,
    avatarColor: '#3370ff', createdAt: '2026-01-01T08:00:00', lastLoginAt: '2026-11-05T09:00:00',
    lastLoginIp: '127.0.0.1', online: true, sessionCount: 1, lockedUntil: null, canDelete: false,
  };
  var USER_2 = {
    id: 'u2', email: 'li@t.local', name: '李四', isAdmin: false, isDisabled: true,
    avatarColor: '#7c3aed', createdAt: '2026-02-01T08:00:00', lastLoginAt: null,
    lastLoginIp: null, online: false, sessionCount: 0, lockedUntil: null, canDelete: true,
  };
  var PROJECT_1 = {
    id: 'p1', name: '研发空间', description: '产品研发', isPersonal: false, isPublic: true,
    createdAt: '2026-01-02T08:00:00', lastUpdatedAt: '2026-11-04T08:00:00',
    memberCount: 2, docCount: 3, storageBytes: 2048, quotaBytes: 10240,
    owners: [{ id: 'u1', name: '张三', email: 'zhang@t.local', isDisabled: false }],
  };
  var PROJECT_2 = {
    id: 'p2', name: '产品空间', description: '需求与规划', isPersonal: false, isPublic: false,
    createdAt: '2026-03-02T08:00:00', lastUpdatedAt: '2026-10-04T08:00:00',
    memberCount: 2, docCount: 1, storageBytes: 512, quotaBytes: 0,
    owners: [{ id: 'u2', name: '李四', email: 'li@t.local', isDisabled: true }],
  };
  var MEMBERS = [
    { userId: 'u1', role: 'OWNER', createdAt: '2026-01-05T08:00:00',
      lastActiveAt: '2026-11-05T09:00:00',
      user: { id: 'u1', name: '张三', email: 'zhang@t.local', isDisabled: false, avatarColor: '#3370ff' } },
    { userId: 'u2', role: 'EDITOR', createdAt: '2026-03-05T08:00:00',
      lastActiveAt: null,
      user: { id: 'u2', name: '李四', email: 'li@t.local', isDisabled: true, avatarColor: '#7c3aed' } },
  ];
  var PATS = {
    items: [
      { id: 'pat1', userId: 'u1', userName: '张三', userEmail: 'zhang@t.local', name: 'CI 令牌',
        scopes: 'read,write', createdAt: '2026-09-01T08:00:00',
        lastUsedAt: '2026-11-01T08:00:00', revokedAt: null },
      { id: 'pat2', userId: 'u2', userName: '李四', userEmail: 'li@t.local', name: '旧脚本',
        scopes: 'read', createdAt: '2026-08-01T08:00:00',
        lastUsedAt: null, revokedAt: '2026-10-01T08:00:00' },
    ],
  };
  var ACCESS = {
    user: { id: 'u1', email: 'zhang@t.local', name: '张三', isAdmin: true, isDisabled: false },
    lock: { failCount: 0, lockedUntil: null }, maxFails: 5, sessions: [], events: [],
  };
  var OVERVIEW = {
    userCount: 137, spaceCount: 29, todayLoginCount: 11, lockedCount: 4,
    storage: {
      files: { activeBytes: 4096, trashBytes: 1024, activeCount: 5, trashCount: 1, folderCount: 2, versionCount: 3 },
      docs: { bytes: 2048, versionBytes: 512, count: 4, versionCount: 2 },
      disk: { total: 1000000, used: 750000, free: 250000 },
      limits: { maxUploadMb: 100, storageReserveMb: 1024 },
      orphans: { orphans: 0, orphanBytes: 0, missing: 0 },
    },
    nearQuota: [{ id: 'p1', name: '研发空间', storageBytes: 900, quotaBytes: 1000, percent: 90 }],
    backup: {
      config: { enabled: true, intervalHours: 24 },
      last: { runAt: '2026-11-04T02:00:00', ok: true },
      nextRun: '2026-11-05T02:00:00',
    },
  };

  function ok(v) { return Promise.resolve(v); }

  // 只桩数据层:路径仍是 Endpoints 的真实产物,能同时守住"视图调了哪个端点"。
  window.api = function (path) {
    calls.push(path);
    if (path === '/api/admin/overview') return ok(OVERVIEW);
    if (path === '/api/admin/storage') return ok(OVERVIEW.storage);
    if (path === '/api/admin/login-events?limit=100') return ok([]);
    if (path === '/api/admin/diagnostics') return ok({ loginLocks: 2, loginEvents: 9 });
    if (path.indexOf('/api/admin/pats') === 0) {
      if (window.__patMode === 'error') return Promise.reject(new Error('PAT 接口失败'));
      if (window.__patMode === 'empty') return ok({ items: [] });
      return ok(PATS);
    }
    if (path === '/api/users') return ok([USER_1, USER_2]);
    if (path === '/api/projects?all=1' || path === '/api/admin/projects') return ok([PROJECT_1, PROJECT_2]);
    if (/^\\/api\\/projects\\/[^/]+\\/members$/.test(path)) return ok(MEMBERS);
    if (/^\\/api\\/admin\\/users\\/[^/]+\\/access$/.test(path)) return ok(ACCESS);
    if (path === '/api/users/directory') return ok([USER_1, USER_2]);
    return ok([]);
  };

  window.App = {
    user: { id: 'u1', email: 'zhang@t.local', name: '张三', isAdmin: true },
    route: { project: Route.project },
  };

  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function render(segs, qs) {
    qs = qs || '';
    Route.setCurrent({
      segs: segs,
      hash: '#/' + segs.join('/') + (qs ? '?' + qs : ''),
      query: new URLSearchParams(qs),
    });
    Scope.clear();
    Scope.apply(document.getElementById('view'), Views.adminLevel(), {});
  }

  function report() {
    var lines = ['errors=' + (window.__errors.join(' | ') || 'none')];
    Object.keys(OUT).forEach(function (k) { lines.push(k + '=' + OUT[k]); });
    var el = document.createElement('pre');
    el.id = 'sweep-out';
    el.textContent = lines.join(String.fromCharCode(10));
    document.body.appendChild(el);
  }

  window.addEventListener('load', function () {
    setTimeout(async function () {
      try {
        // ---------- 1) 缺省分区 + 总览数据源 ----------
        render(['admin']);
        await wait(350);
        OUT.navCount = document.querySelectorAll('.admin-nav a').length;
        OUT.navKeys = Array.prototype.map.call(
          document.querySelectorAll('.admin-nav a'),
          function (a) { return a.dataset.section; }).join(',');
        OUT.overviewActive = (document.querySelector('[data-admin-section]') || { getAttribute: function () { return ''; } })
          .getAttribute('data-admin-section');
        OUT.overviewSections = document.querySelectorAll('[data-admin-section]').length;
        var ovText = (document.querySelector('.admin-content') || {}).textContent || '';
        OUT.overview137 = ovText.indexOf('137') >= 0 ? 1 : 0;
        OUT.overview29 = ovText.indexOf('29') >= 0 ? 1 : 0;
        OUT.overview11 = ovText.indexOf('11') >= 0 ? 1 : 0;
        OUT.overviewStorageFigure = document.querySelectorAll('.admin-content .admin-storage-figure').length;
        OUT.overviewQuota = document.querySelectorAll('.admin-content .admin-quota-row').length;
        OUT.overviewCalls = calls.filter(function (p) { return p === '/api/admin/overview'; }).length;
        OUT.overviewForeignCalls = calls.filter(function (p) {
          return p.indexOf('/api/users') === 0 || p.indexOf('/api/admin/storage') === 0 ||
            p.indexOf('/api/admin/projects') === 0;
        }).length;
        // route.js 在 Route.setCurrent 之前就调用 Views.adminLevel(r):此时 current
        // 还是上一条路由,分区必须认传进来的 route,否则每次切区都慢一拍。
        OUT.routeArgKey = Views.adminLevel({ segs: ['admin', 'users'], section: 'users' }).key;

        // ---------- 2) 用户区:搜索/chips/多选 + 所属空间抽屉 ----------
        calls.length = 0;
        render(['admin', 'users']);
        await wait(600);
        OUT.usersActive = document.querySelector('[data-admin-section]').getAttribute('data-admin-section');
        OUT.usersSections = document.querySelectorAll('[data-admin-section]').length;
        OUT.usersRows = document.querySelectorAll('#admin-users-table .data-table-row').length;
        var userRow = document.querySelector('#admin-users-table .data-table-row');
        OUT.usersRowHeight = userRow ? Math.round(parseFloat(getComputedStyle(userRow).height)) : 0;
        OUT.usersSearch = document.querySelector('#admin-user-q') ? 1 : 0;
        OUT.usersChips = document.querySelectorAll('#admin-user-filter button').length;
        OUT.usersCheckboxes = document.querySelectorAll('#admin-users-table .sel-box').length;
        OUT.spaceCounts = Array.prototype.map.call(
          document.querySelectorAll('[data-space-count]'),
          function (x) { return x.getAttribute('data-space-count') + ':' + x.textContent.trim(); }).join('|');
        var acc = document.querySelector('#admin-users-table .u-access');
        OUT.usersAccessBtn = acc ? 1 : 0;
        if (acc) { acc.click(); await wait(500); }
        var ud = document.querySelector('.admin-drawer-box');
        OUT.userDrawer = ud ? 1 : 0;
        OUT.userDrawerWidth = ud ? Math.round(parseFloat(getComputedStyle(ud).width)) : 0;
        OUT.userSpaceCard = ud && ud.textContent.indexOf('所属空间') >= 0 ? 1 : 0;
        OUT.userAddSpace = ud && ud.querySelector('.admin-add-space') ? 1 : 0;
        OUT.userRoleSelects = ud ? ud.querySelectorAll('.admin-space-role').length : 0;
        UI.closeAllModals();
        await wait(80);

        // ---------- 3) 空间区:成员抽屉(与用户详情互为双视角) ----------
        calls.length = 0;
        render(['admin', 'projects']);
        await wait(400);
        OUT.projActive = document.querySelector('[data-admin-section]').getAttribute('data-admin-section');
        OUT.projRows = document.querySelectorAll('#admin-projects-table .data-table-row').length;
        OUT.projSearch = document.querySelector('#admin-project-q') ? 1 : 0;
        OUT.projMemberBtns = document.querySelectorAll('#admin-projects-table .p-members').length;
        var pb = document.querySelector('#admin-projects-table .p-members');
        if (pb) { pb.click(); await wait(400); }
        var pd = document.querySelector('.admin-drawer-box');
        OUT.projDrawer = pd ? 1 : 0;
        OUT.projDrawerMembers = pd ? pd.querySelectorAll('.admin-member-row').length : 0;
        OUT.projDrawerWidth = pd ? Math.round(parseFloat(getComputedStyle(pd).width)) : 0;

        // ---------- 4) 未知分区回落总览 ----------
        UI.closeAllModals();
        render(['admin', 'no-such-section']);
        await wait(250);
        OUT.fallbackActive = document.querySelector('[data-admin-section]').getAttribute('data-admin-section');

        // ---------- 5) 用户区深链:?q= 过滤 / ?user= 直接开详情 ----------
        calls.length = 0;
        render(['admin', 'users'], 'q=li%40');
        await wait(700);
        OUT.usersDeepQValue = document.querySelector('#admin-user-q')
          ? document.querySelector('#admin-user-q').value : '';
        OUT.usersDeepQRows = document.querySelectorAll('#admin-users-table .data-table-row').length;

        UI.closeAllModals();
        await wait(80);
        render(['admin', 'users'], 'user=u1');
        await wait(900);
        var dd = document.querySelector('.admin-drawer-box');
        OUT.deepUserDrawer = dd ? 1 : 0;
        var dh = document.querySelector('.modal-head h3');
        OUT.deepUserTitle = dh ? dh.textContent : '';
        var dt = dd ? dd.textContent : '';
        OUT.deepUserJoin = dt.indexOf('加入于') >= 0 ? 1 : 0;
        OUT.deepUserLastActive = dt.indexOf('最后活跃') >= 0 ? 1 : 0;
        OUT.deepUserRoleBadges = dd ? dd.querySelectorAll('.admin-space-role').length : 0;
        UI.closeAllModals();
        await wait(80);

        // 同一分区内的 query 变化(再次从命令面板跳用户)不重建作用域,也要生效
        render(['admin', 'users']);
        await wait(700);
        location.hash = '#/admin/users?user=u2';
        await wait(300);
        var hd = document.querySelector('.admin-drawer-box');
        OUT.hashChangeDrawer = hd ? 1 : 0;
        OUT.hashChangeTitle = (document.querySelector('.modal-head h3') || {}).textContent || '';
        location.hash = '#/admin/users';
        UI.closeAllModals();
        await wait(80);

        // ---------- 6) 安全区:PAT 审计卡(搜索 + 空/错误态) ----------
        calls.length = 0;
        window.__patMode = 'ok';
        render(['admin', 'security']);
        await wait(700);
        OUT.secActive = document.querySelector('[data-admin-section]').getAttribute('data-admin-section');
        OUT.secPatsCard = document.querySelector('#admin-pats') ? 1 : 0;
        OUT.secPatRows = document.querySelectorAll('#admin-pats-body .data-table-row').length;
        var patHeads = document.querySelector('#admin-pats-head');
        OUT.secPatHeads = patHeads ? patHeads.textContent.replace(/\\s+/g, '') : '';
        OUT.secPatRevoked = document.querySelectorAll('#admin-pats-body .badge.danger').length;
        var pq = document.querySelector('#admin-pats-q');
        if (pq) {
          pq.value = 'li@';
          pq.dispatchEvent(new Event('input', { bubbles: true }));
          await wait(120);
        }
        OUT.secPatFiltered = document.querySelectorAll('#admin-pats-body .data-table-row').length;
        OUT.secPatCalls = calls.filter(function (p) { return p.indexOf('/api/admin/pats') === 0; }).length;

        window.__patMode = 'empty';
        UI.closeAllModals();
        render(['admin', 'security']);
        await wait(500);
        OUT.secPatEmpty = document.querySelector('#admin-pats-body') &&
          document.querySelector('#admin-pats-body').textContent.indexOf('暂无访问令牌') >= 0 ? 1 : 0;

        window.__patMode = 'error';
        UI.closeAllModals();
        render(['admin', 'security']);
        await wait(500);
        OUT.secPatError = document.querySelectorAll('#admin-pats-body .banner.danger').length;
        window.__patMode = 'ok';

        // ---------- 7) 存储区:配额策略卡 -> 打开空间成员抽屉 ----------
        UI.closeAllModals();
        render(['admin', 'storage']);
        await wait(600);
        OUT.storeQuotaCard = document.querySelector('#admin-quota-policy') ? 1 : 0;
        OUT.storeQuotaRows = document.querySelectorAll('#admin-quota-policy .admin-quota-row').length;
        OUT.storeQuotaText = (document.querySelector('#admin-quota-policy .admin-quota-meta') || {}).textContent || '';
        var qr = document.querySelector('#admin-quota-policy .admin-quota-row');
        if (qr) { qr.click(); await wait(500); }
        var qd = document.querySelector('.admin-drawer-box');
        OUT.quotaDrawer = qd ? 1 : 0;
        OUT.quotaDrawerMembers = qd ? qd.querySelectorAll('.admin-member-row').length : 0;
        UI.closeAllModals();
        await wait(80);
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


def _assert(problems, cond, message):
    if not cond:
        problems.append(message)


def test_admin_sections_route_drawers(base_url):
    chrome = find_chrome()
    if not chrome:
        pytest.skip("未找到 Chrome/Edge,跳过管理后台分区契约巡检")

    page = WEB_DIR / ("_admin_sections_check_%s.html" % os.getpid())
    page.write_text(PAGE_HTML, encoding="utf-8")
    try:
        dom = dump_page(chrome, base_url, page.name, budget=25000)
    finally:
        if page.exists():
            page.unlink()

    info = read_report(dom)
    assert info is not None, "测试页没有产出报告(管理脚本整块崩了?)"
    assert info.get("errors") == "none", f"管理后台分区页 JS 错误: {info.get('errors')}"
    assert not info.get("exception"), f"测试步骤抛错: {info.get('exception')}"

    problems = []
    _assert(problems, info.get("navCount") == "6", f"子导航应有 6 个分区: {info.get('navCount')}")
    _assert(problems,
            info.get("navKeys") == "overview,users,projects,storage,backup,security",
            f"分区注册顺序/键不对: {info.get('navKeys')}")

    # 缺省路由(segs[2] 缺失)= overview,且只有这一个分区被挂载
    _assert(problems, info.get("overviewActive") == "overview",
            f"#/admin 缺省分区应为 overview: {info.get('overviewActive')}")
    _assert(problems, info.get("overviewSections") == "1",
            f"同一时刻只能挂一个分区: {info.get('overviewSections')}")
    _assert(problems, info.get("overviewCalls") == "1",
            f"总览应只请求 /api/admin/overview 一次: {info.get('overviewCalls')}")
    _assert(problems, info.get("overviewForeignCalls") == "0",
            f"总览不得另取 users/storage/projects 拼统计: 外来调用={info.get('overviewForeignCalls')}")
    _assert(problems, info.get("routeArgKey") == "admin:users",
            f"分区必须认 resolve 传入的 route(否则切区慢一拍): {info.get('routeArgKey')}")
    for key in ("overview137", "overview29", "overview11"):
        _assert(problems, info.get(key) == "1", f"总览未渲染服务端字段({key}): {info.get('overviewText')}")
    _assert(problems, int(info.get("overviewStorageFigure", "0")) >= 1,
            "总览缺少存储图形(磁盘占比环)")
    _assert(problems, int(info.get("overviewQuota", "0")) >= 1,
            "总览未列出近配额待办")

    # 用户区:切区重建为一层,列表/搜索/chips/多选都在
    _assert(problems, info.get("usersActive") == "users",
            f"#/admin/users 应渲染用户区: {info.get('usersActive')}")
    _assert(problems, info.get("usersSections") == "1",
            f"切区后仍只能有一个分区: {info.get('usersSections')}")
    _assert(problems, info.get("usersRows") == "2", f"用户表行数: {info.get('usersRows')}")
    _assert(problems, info.get("usersRowHeight") == "44",
            f"用户列表应为 44px 行: {info.get('usersRowHeight')}")
    _assert(problems, info.get("usersSearch") == "1", "用户区缺少搜索框")
    _assert(problems, info.get("usersChips") == "4",
            f"用户筛选 chips 应为 全部/管理员/禁用/7日活跃: {info.get('usersChips')}")
    _assert(problems, int(info.get("usersCheckboxes", "0")) >= 3,
            f"用户表缺少多选(行 + 全选): {info.get('usersCheckboxes')}")
    _assert(problems, info.get("spaceCounts") == "u1:2|u2:2",
            f"所属空间数未按成员关系归并: {info.get('spaceCounts')}")

    # 用户详情(480 drawer)必须有「所属空间」卡 + 行内角色 + 加入入口
    _assert(problems, info.get("usersAccessBtn") == "1", "用户行缺少详情入口")
    _assert(problems, info.get("userDrawer") == "1", "用户详情抽屉没有打开")
    _assert(problems, info.get("userDrawerWidth") == "480",
            f"用户详情抽屉宽度应为 480: {info.get('userDrawerWidth')}")
    _assert(problems, info.get("userSpaceCard") == "1", "用户详情缺少所属空间卡")
    _assert(problems, info.get("userAddSpace") == "1", "所属空间卡缺少加入空间入口")
    _assert(problems, int(info.get("userRoleSelects", "0")) >= 2,
            f"所属空间每行应可改角色: {info.get('userRoleSelects')}")

    # 空间区:成员入口打开本域抽屉,且与用户详情看到同一组成员
    _assert(problems, info.get("projActive") == "projects",
            f"#/admin/projects 应渲染空间区: {info.get('projActive')}")
    _assert(problems, info.get("projRows") == "2", f"空间表行数: {info.get('projRows')}")
    _assert(problems, info.get("projSearch") == "1", "空间区缺少搜索框")
    _assert(problems, info.get("projMemberBtns") == "2", f"每个空间应有成员入口: {info.get('projMemberBtns')}")
    _assert(problems, info.get("projDrawer") == "1", "空间成员抽屉没有打开")
    _assert(problems, info.get("projDrawerMembers") == "2",
            f"成员抽屉行数: {info.get('projDrawerMembers')}")
    _assert(problems, info.get("projDrawerWidth") == "480",
            f"成员抽屉宽度应为 480: {info.get('projDrawerWidth')}")

    # 旧书签/手改地址里的未知分区回落总览,不能白屏
    _assert(problems, info.get("fallbackActive") == "overview",
            f"未知分区应回落 overview: {info.get('fallbackActive')}")

    # 用户区深链:?q= 直接过滤,?user= 数据到货后打开该用户详情
    _assert(problems, info.get("usersDeepQValue") == "li@",
            f"路由 ?q= 未写入搜索框: {info.get('usersDeepQValue')}")
    _assert(problems, info.get("usersDeepQRows") == "1",
            f"路由 ?q= 未过滤用户列表: {info.get('usersDeepQRows')}")
    _assert(problems, info.get("deepUserDrawer") == "1",
            f"路由 ?user= 未打开用户详情: {info.get('deepUserDrawer')}")
    _assert(problems, info.get("deepUserTitle", "").find("张三") >= 0,
            f"用户详情打开的不是目标用户: {info.get('deepUserTitle')}")
    # 所属空间卡:成员加入时间与最后活跃(不再拿空间创建时间冒充)
    _assert(problems, info.get("deepUserJoin") == "1", "所属空间卡缺少成员加入时间")
    _assert(problems, info.get("deepUserLastActive") == "1", "所属空间卡缺少最后活跃")
    _assert(problems, int(info.get("deepUserRoleBadges", "0")) >= 2,
            f"所属空间每行应可改角色: {info.get('deepUserRoleBadges')}")
    _assert(problems, info.get("hashChangeDrawer") == "1",
            f"同一分区内 ?user= 变化未打开详情: {info.get('hashChangeDrawer')}")
    _assert(problems, info.get("hashChangeTitle", "").find("李四") >= 0,
            f"query 变化打开的详情不是目标用户: {info.get('hashChangeTitle')}")

    # 安全区:PAT 审计卡(六列 + 已吊销状态 + 搜索 + 空/错误态)
    _assert(problems, info.get("secActive") == "security",
            f"#/admin/security 应渲染安全区: {info.get('secActive')}")
    _assert(problems, info.get("secPatsCard") == "1", "安全区缺少 PAT 审计卡")
    _assert(problems, info.get("secPatRows") == "2",
            f"PAT 审计行数: {info.get('secPatRows')}")
    for col in ("用户", "名称", "权限", "创建", "最近使用", "状态"):
        _assert(problems, col in info.get("secPatHeads", ""),
                f"PAT 审计缺少列「{col}」: {info.get('secPatHeads')}")
    _assert(problems, info.get("secPatRevoked") == "1",
            f"已吊销令牌应有醒目状态: {info.get('secPatRevoked')}")
    _assert(problems, info.get("secPatFiltered") == "1",
            f"PAT 审计搜索未过滤: {info.get('secPatFiltered')}")
    _assert(problems, info.get("secPatCalls") == "1",
            f"安全区应只请求一次 PAT 审计: {info.get('secPatCalls')}")
    _assert(problems, info.get("secPatEmpty") == "1", "PAT 审计空态未渲染")
    _assert(problems, int(info.get("secPatError", "0")) >= 1, "PAT 审计错误态未渲染")

    # 存储区:配额策略卡列出近配额空间,点击打开该空间成员抽屉
    _assert(problems, info.get("storeQuotaCard") == "1", "存储区缺少配额策略卡")
    _assert(problems, info.get("storeQuotaRows") == "1",
            f"近配额空间行数: {info.get('storeQuotaRows')}")
    _assert(problems, "90%" in info.get("storeQuotaText", ""),
            f"近配额行未显示占比: {info.get('storeQuotaText')}")
    _assert(problems, info.get("quotaDrawer") == "1", "点击近配额空间未打开成员抽屉")
    _assert(problems, info.get("quotaDrawerMembers") == "2",
            f"近配额抽屉的成员行数: {info.get('quotaDrawerMembers')}")

    assert not problems, "管理后台分区契约失败:\n" + "\n".join("  - " + p for p in problems)
