"""逐页巡检 + 交互断言:真实 app.js 驱动每个路由,收集 JS 错误;末尾做真实点击断言。

它用一个临时校验页(注入到 web/ 下,跑完自动删除)完成:
  同步 XHR 登录 → 等 app.js 的路由跑完 → 切到目标 hash → 收集 window.onerror
  与 console.error → 把结果写进 DOM 供本文件读取。

交互断言为什么必须有:静态渲染正常 ≠ 交互正常。"点侧栏项目行没反应""折叠箭头点不动"
这类缺陷既不报错也不让页面崩,只有真实点击 + 断言状态变化才抓得到(资源 id 整数化后
侧栏与文档树各坏过一次,都是这么漏过去的)。

注意两个坑(都踩过):
  * 必须在 window load 之后再改 hash:app.js 的 DOMContentLoaded 处理器会按
    当时的 hash 路由一次,提前改会被覆盖回 #/。
  - URL 里的 # 必须 percent-encode,否则它会被当成 URL 的 fragment 截断。

项目与文档由 proj_doc fixture 提供(协作项目:个人空间没有成员页)。
"""
import urllib.parse

import pytest

from _chrome import dump_page, error_trap_js, find_chrome, login_js, read_report, temp_page
from _harness import ADMIN_EMAIL, ADMIN_PASSWORD
from test_editor_cm6 import EDITOR_SCRIPTS

LOGIN_STATUS_JS = (
    "(function () {\n"
    "      var x = new XMLHttpRequest();\n"
    "      x.open('POST', '/api/auth/login', false);\n"
    "      x.setRequestHeader('Content-Type', 'application/json');\n"
    f"      x.send(JSON.stringify({{ email: '{ADMIN_EMAIL}', password: '{ADMIN_PASSWORD}' }}));\n"
    "      window.__loginStatus = x.status;\n"
    "    })();"
)

pytestmark = pytest.mark.browser

# 巡检页:每个路由跑一遍,报告 hash / 页面标题 / JS 错误 / 渲染字节量(诊断信息)
SWEEP_INJECT = '''  <script>
    __LOGIN_JS__
    __ERRTRAP_JS__
  </script>
  <script src="/js/app.js"></script>
  <script>
    var HASH = (new URLSearchParams(location.search)).get('h') || '#/';
    function report() {
      var l = ['hash=' + location.hash, 'errors=' + (window.__errors.join(' | ') || 'none')];
      var t = document.querySelector('.page-title');
      l.push('title=' + (t ? t.textContent : '(无)'));
      var el = document.createElement('pre');
      el.id = 'sweep-out';
      el.textContent = l.join(String.fromCharCode(10));
      document.body.appendChild(el);
    }
    window.addEventListener('load', function () {
      setTimeout(function () {
        location.hash = HASH;
        window.dispatchEvent(new HashChangeEvent('hashchange'));
        setTimeout(report, 2600);
      }, 150);
    });
  </script>
'''

# 交互断言页:空间切换器弹层(菜单行)+ 进文档页点折叠箭头(子层 hidden 应切换)
INTERACT_INJECT = '''  <script>
    __LOGIN_JS__
    __ERRTRAP_JS__
  </script>
  <script src="/js/app.js"></script>
  <script>
  (function () {
    var OUT = {};
    var PID = (new URLSearchParams(location.search)).get('pid') || '';
    function report() {
      var l = ['hash=' + location.hash, 'errors=' + (window.__errors.join(' | ') || 'none')];
      Object.keys(OUT).forEach(function (k) { l.push(k + '=' + OUT[k]); });
      var el = document.createElement('pre');
      el.id = 'sweep-out';
      el.textContent = l.join(String.fromCharCode(10));
      document.body.appendChild(el);
    }
    function step2() {
      location.hash = '#/p/' + PID + '/docs';
      setTimeout(function () {
        var caret = document.querySelector('#doc-tree .tree-caret:not(.leaf)');
        if (!caret) { OUT.docTreeChecked = 0; report(); return; }
        var row = caret.closest('.doc-row');
        var id = row.dataset.id;
        var before = row.parentElement.querySelector('.tree-children');
        if (!before) { OUT.docTreeChecked = 0; report(); return; }
        OUT.docTreeChecked = 1;
        OUT.docChildrenHiddenBefore = before.hasAttribute('hidden') ? 1 : 0;
        caret.click();
        setTimeout(function () {
          var row2 = document.querySelector('#doc-tree .doc-row[data-id="' + id + '"]');
          var after = row2 ? row2.parentElement.querySelector('.tree-children') : null;
          OUT.docChildrenHiddenAfterClick = (after && after.hasAttribute('hidden')) ? 1 : 0;
          report();
        }, 500);
      }, 2600);
    }
    window.addEventListener('load', function () {
      setTimeout(function () {
        // 左栏:当前空间导航 + 文档树槽位 + 云空间/回收站
        OUT.sidebarRows = document.querySelectorAll('#side-nav .side-item').length;
        OUT.footRows = document.querySelectorAll('#side-foot .side-item').length;
        if (!OUT.sidebarRows) { step2(); return; }
        // 空间切换器:点开应给出「我的空间/发现空间」两个页签、逐空间行与底部入口
        document.getElementById('space-switch').click();
        setTimeout(function () {
          var panel = document.querySelector('.space-switcher');
          OUT.spacePanel = panel ? 1 : 0;
          OUT.spaceTabs = panel ? panel.querySelectorAll('[data-ss-tab]').length : 0;
          OUT.spaceRows = panel ? panel.querySelectorAll('.ss-space-row').length : 0;
          OUT.spaceFoot = panel ? panel.querySelectorAll('.ss-foot .btn').length : 0;
          UI.closeOpenMenu();
          // 命令面板:Ctrl+K 打开,空输入给出动作/最近文档;Esc 关闭
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
          setTimeout(function () {
            OUT.cmdPanel = document.querySelector('.cmd-panel') ? 1 : 0;
            OUT.cmdRows = document.querySelectorAll('.cmd-row').length;
            var inp = document.getElementById('cmd-q');
            if (inp) inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            OUT.cmdClosed = document.querySelector('.cmd-panel') ? 0 : 1;
            step2();
          }, 1000);
        }, 400);
      }, 2200);
    });
  })();
  </script>
'''


# 路由生成点断言页:App.route.project 的各种形态与期望串逐字比对
# (21 处手拼收敛到这一处后,字符串等价性就是全部行为 —— 由真实页面里的真实函数判定)
ROUTE_INJECT = '''  <script>
    __LOGIN_JS__
    __ERRTRAP_JS__
  </script>
  <script src="/js/app.js"></script>
  <script>
  (function () {
    function report() {
      var cases = [
        ['bare', App.route.project(10001), '#/p/10001'],
        ['tab', App.route.project(10001, 'docs'), '#/p/10001/docs'],
        ['doc', App.route.project(10001, 'docs', 10002), '#/p/10001/docs/10002'],
        ['queryOne', App.route.project(10001, 'files', null, { folder: 10003 }),
         '#/p/10001/files?folder=10003'],
        ['queryTwo', App.route.project(10001, 'files', null, { folder: 10003, highlight: 10004 }),
         '#/p/10001/files?folder=10003&highlight=10004'],
        ['querySkipNull', App.route.project(10001, 'files', null, { folder: null, highlight: 10004 }),
         '#/p/10001/files?highlight=10004'],
      ];
      var l = ['errors=' + (window.__errors.join(' | ') || 'none')];
      cases.forEach(function (c) { l.push(c[0] + '=' + c[1] + (c[1] === c[2] ? '' : ' EXPECT ' + c[2])); });
      var el = document.createElement('pre');
      el.id = 'sweep-out';
      el.textContent = l.join(String.fromCharCode(10));
      document.body.appendChild(el);
    }
    window.addEventListener('load', function () { setTimeout(report, 800); });
  })();
  </script>
'''


# 管理后台:六个分区的子导航 + 真实切区(总览 → 用户 → 安全)+ 用户详情抽屉开合。
# 壳变了(admin 改为动态加载 + 左子导航),这里守的是"分区真的切、抽屉真的开"。
ADMIN_INJECT = '''  <script>
    __LOGIN_STATUS_JS__
    __ERRTRAP_JS__
  </script>
  <script src="/js/app.js"></script>
  <script>
  (function () {
    var OUT = {};
    function report() {
      var l = ['errors=' + (window.__errors.join(' | ') || 'none'), 'loginStatus=' + window.__loginStatus];
      Object.keys(OUT).forEach(function (k) { l.push(k + '=' + OUT[k]); });
      var el = document.createElement('pre');
      el.id = 'sweep-out';
      el.textContent = l.join(String.fromCharCode(10));
      document.body.appendChild(el);
    }
    function go(section, next) {
      var a = document.querySelector('.admin-nav-item[data-section="' + section + '"]');
      if (!a) { OUT['nav_' + section] = 'no-link'; report(); return; }
      a.click();
      setTimeout(next, 1800);
    }
    window.addEventListener('load', function () {
      // 与巡检页同款 150ms 延后:等 DOMContentLoaded 触发的首路由(含 /api/auth/me)落定,
      // 否则首路由与本次导航并发,首路由后完成者会用旧渲染覆盖本页
      setTimeout(function () {
        location.hash = '#/admin';
        window.dispatchEvent(new HashChangeEvent('hashchange'));
        setTimeout(function () {
        OUT.navItems = document.querySelectorAll('.admin-nav-item').length;
        OUT.overviewSection = document.querySelector('#admin-section[data-admin-section="overview"]') ? 1 : 0;
        go('users', function () {
          OUT.usersSection = document.querySelector('#admin-section[data-admin-section="users"]') ? 1 : 0;
          OUT.userRows = document.querySelectorAll('#admin-section .data-table-row').length;
          var access = document.querySelector('#admin-section .u-access');
          if (!access) { OUT.drawer = 'no-btn'; go('security', afterSecurity); return; }
          access.click();
          setTimeout(function () {
            var box = document.querySelector('.modal-box');
            OUT.drawer = box && box.textContent.indexOf('用户详情') >= 0 ? 1 : 0;
            UI.closeAllModals();
            go('security', afterSecurity);
          }, 1200);
        });
      }, 3000);
      }, 150);
    });
    function afterSecurity() {
      OUT.securitySection = document.querySelector('#admin-section[data-admin-section="security"]') ? 1 : 0;
      OUT.secFilterBtns = document.querySelectorAll('#sec-filter button').length;
      OUT.secRowsBefore = document.querySelectorAll('#sec-body .data-table-row').length;
      var failBtn = document.querySelector('#sec-filter button[data-key="fail"]');
      if (!failBtn) { OUT.failToggle = 'no-btn'; report(); return; }
      var before = document.querySelector('#sec-body').innerHTML;
      failBtn.click();
      setTimeout(function () {
        OUT.failToggleChanged = document.querySelector('#sec-body').innerHTML !== before ? 1 : 0;
        report();
      }, 500);
    }
  })();
  </script>
'''


def _inject(tpl):
    return EDITOR_SCRIPTS + tpl.replace("__LOGIN_JS__", login_js()).replace("__ERRTRAP_JS__", error_trap_js())


def test_visual_sweep_all_routes(base_url, proj_doc):
    chrome = find_chrome()
    if not chrome:
        pytest.skip("未找到 Chrome/Edge,跳过逐页巡检")
    pid, doc_id = proj_doc
    pages = [
        ("首页", "#/"),
        ("空间管理", "#/projects"),
        ("个人设置", "#/settings"),
        ("设置·安全", "#/settings/security"),
        ("设置·偏好", "#/settings/preferences"),
        ("管理后台", "#/admin"),
        # 项目内页面(巡检项目有父子文档,覆盖得到文档树折叠)
        ("文档", f"#/p/{pid}/docs"),
        ("云空间", f"#/p/{pid}/files"),
        ("成员", f"#/p/{pid}/members"),
        ("回收站", f"#/p/{pid}/trash"),
        ("项目设置", f"#/p/{pid}/settings"),
        # 编辑器是最重的页面(WS、自动保存、浮动工具栏),权限改动最容易在这里出问题
        ("文档详情", f"#/p/{pid}/docs/{doc_id}"),
    ]

    failures = []
    with temp_page("_visual_sweep.html", _inject(SWEEP_INJECT)) as page_name:
        for name, hash_ in pages:
            enc = urllib.parse.quote(hash_, safe="")
            info = read_report(dump_page(chrome, base_url, page_name, f"h={enc}"))
            if info is None:
                failures.append(f"{name}: 未产出巡检结果(页面可能整块崩了)")
                continue
            errs = info.get("errors", "?")
            if errs != "none" or info.get("hash") != hash_:
                failures.append(f"{name}: errors={errs} hash={info.get('hash')}"
                                f"(期望 {hash_}) title={info.get('title', '?')}")

    # === 交互断言(静态渲染正常 ≠ 交互正常) ===
    info = None
    with temp_page("_visual_sweep.html", _inject(INTERACT_INJECT)) as page_name:
        info = read_report(dump_page(chrome, base_url, page_name,
                                     f"pid={urllib.parse.quote(str(pid), safe='')}",
                                     budget=30000))
    assert info is not None, "未产出交互结果(页面可能整块崩了)"
    assert info.get("errors", "?") == "none", f"交互页 JS 错误: {info.get('errors')}"

    problems = []
    if info.get("sidebarRows", "0") == "0":
        problems.append("左栏没有空间导航项,交互断言没有真正执行")
    else:
        if info.get("footRows", "0") == "0":
            problems.append("左栏没有云空间/回收站入口")
        if info.get("spacePanel") != "1":
            problems.append("空间切换器浮层没有打开")
        elif info.get("spaceTabs") != "2":
            problems.append("空间切换器没有「我的空间/发现空间」两个页签")
        elif int(info.get("spaceRows", "0")) < 1:
            problems.append("空间切换器没有列出可切换的空间")
        elif int(info.get("spaceFoot", "0")) < 1:
            problems.append("空间切换器底部没有创建/管理空间入口")
        if info.get("cmdPanel") != "1":
            problems.append("Ctrl+K 没有打开命令面板")
        elif int(info.get("cmdRows", "0")) < 1:
            problems.append("命令面板空输入没有给出动作或最近文档")
        if info.get("cmdClosed") != "1":
            problems.append("命令面板按 Esc 没有关闭")
    # 文档树折叠:巡检项目必有子文档,这条必须真的执行
    if info.get("docTreeChecked", "0") != "1":
        problems.append("文档树折叠断言未执行(没找到带子层的折叠箭头)")
    elif info.get("docChildrenHiddenBefore") == info.get("docChildrenHiddenAfterClick"):
        problems.append("文档树折叠箭头无效(子层 hidden 未切换)")

    assert not failures, f"{len(failures)} 个页面异常:\n" + "\n".join("  - " + f for f in failures)
    assert not problems, "交互断言失败:\n" + "\n".join("  - " + p for p in problems)


def test_route_generation(base_url):
    """App.route.project 是 '#/p/…' 的唯一生成点(此前 20+ 处手拼):
    全部形态在真实页面里与期望串逐字比对,收敛行为不许变。"""
    chrome = find_chrome()
    if not chrome:
        pytest.skip("未找到 Chrome/Edge,跳过路由生成点巡检")
    with temp_page("_route_check.html", _inject(ROUTE_INJECT)) as page_name:
        info = read_report(dump_page(chrome, base_url, page_name))
    assert info is not None, "未产出路由巡检结果(页面可能整块崩了)"
    assert info.get("errors", "?") == "none", f"路由页 JS 错误: {info.get('errors')}"
    bad = {k: v for k, v in info.items() if k != "errors" and "EXPECT" in v}
    assert not bad, "App.route 生成结果与期望不符:\n" + \
        "\n".join(f"  - {k}: {v}" for k, v in bad.items())


def test_admin_sections_and_interactions(base_url):
    """管理后台五区拆分(views/admin/*.js)后的行为冒烟:
    静态渲染(五区各有内容)+ 真实点击(仅失败过滤切换、用户详情抽屉开合)。
    拆分最怕的是事件委托/refresh 注册表静默断裂 —— 必须由真实点击断言。"""
    chrome = find_chrome()
    if not chrome:
        pytest.skip("未找到 Chrome/Edge,跳过管理后台巡检")
    with temp_page("_admin_check.html", _inject(ADMIN_INJECT).replace("__LOGIN_STATUS_JS__", LOGIN_STATUS_JS)) as page_name:
        info = read_report(dump_page(chrome, base_url, page_name, budget=30000))
    assert info is not None, "未产出管理后台巡检结果(页面可能整块崩了)"
    assert info.get("loginStatus") == "200", \
        f"巡检页登录失败(HTTP {info.get('loginStatus')}):管理员账号被锁/被禁时会话建立不起来"
    assert info.get("errors", "?") == "none", f"管理后台 JS 错误: {info.get('errors')}"

    problems = []
    if int(info.get("navItems", "0")) != 6:
        problems.append("管理后台左子导航没有六个分区")
    if info.get("overviewSection") != "1":
        problems.append("默认分区不是总览")
    if info.get("usersSection") != "1":
        problems.append("切到「用户」分区没有生效")
    if int(info.get("userRows", "0")) < 1:
        problems.append("用户分区没有用户行(初始化管理员应至少一条)")
    if info.get("securitySection") != "1":
        problems.append("切到「安全」分区没有生效")
    if int(info.get("secFilterBtns", "0")) != 2:
        problems.append("登录动态的 全部/仅失败 过滤段没渲染")
    if int(info.get("secRowsBefore", "0")) < 1:
        problems.append("登录动态默认(全部)没有行 —— 初始化登录事件应至少一条")
    if info.get("failToggle") == "no-btn":
        problems.append("找不到'仅失败'按钮,过滤切换未执行")
    elif info.get("failToggleChanged") != "1":
        problems.append("点'仅失败'后登录动态内容没有变化 —— 过滤切换断了")
    if info.get("drawer") == "no-btn":
        problems.append("找不到'用户详情'按钮,抽屉断言未执行")
    elif info.get("drawer") != "1":
        problems.append("点'用户详情'没有弹出用户详情抽屉")

    assert not problems, "管理后台交互断言失败:\n" + "\n".join("  - " + p for p in problems)
