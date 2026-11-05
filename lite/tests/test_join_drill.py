"""公开项目"自助加入"的浏览器演练:用一个**未加入**的账号真实点一遍两条入口。

为什么必须真点:这条链路几乎全在浏览器里 —— 切换器页签的选择、卡片点击被弹框拦下
(不该直接跳转)、弹框的两个出口、加入后的三件事(入库 / 侧栏出现该项目 / 落到项目
文档页),以及"同事发来的直链"落到的 403 错误态有没有出路。接口测试覆盖不到这些,
而"点了没反应""拦没拦住"正是这类改动的典型失败形态。

两条入口(mode 参数区分):
  switcher —— 空间切换器 → 发现空间 → 加入:必须弹框询问而**不是**直接进入
              (发现页已并入切换器页签,不再有 #/discover 整页)
  direct   —— 直链打开 #/p/{id}/docs:错误态要给「加入项目」按钮,点了能加入

跑完都断言:落到 #/p/{id}/docs、文档树里看得到文档、侧栏长出该项目(模块导航由此而来)。
"""
import urllib.parse

import pytest

from _chrome import dump_page, error_trap_js, find_chrome, login_js, read_report, temp_page
from _harness import make_user

pytestmark = pytest.mark.browser

JOIN_DRILL_INJECT = '''  <script>
    __LOGIN_JS__
    __ERRTRAP_JS__
  </script>
  <script src="/js/app.js"></script>
  <script>
  (function () {
    var OUT = {};
    var QS = new URLSearchParams(location.search);
    var PID = QS.get('pid') || '';
    var MODE = QS.get('mode') || 'switcher';
    function report() {
      var l = ['hash=' + location.hash, 'errors=' + (window.__errors.join(' | ') || 'none')];
      Object.keys(OUT).forEach(function (k) { l.push(k + '=' + OUT[k]); });
      var el = document.createElement('pre');
      el.id = 'sweep-out';
      el.textContent = l.join(String.fromCharCode(10));
      document.body.appendChild(el);
    }
    function afterJoin() {
      OUT.hashAfterJoin = location.hash;
      OUT.spaceNameText =
        (document.getElementById('space-name') || {}).textContent || '';
      var tree = document.getElementById('doc-tree');
      OUT.docTreeText = tree ? tree.textContent.replace(/\\s+/g, ' ').trim().slice(0, 60) : '(无文档树)';
      report();
    }
    // 两条入口都归结到"点开邀请入口 → 弹框 → 点加入"
    function step1() {
      if (MODE === 'direct') {
        OUT.joinButton = document.querySelector('#proj-join') ? 1 : 0;
        var banner = document.querySelector('.banner');
        OUT.bannerText = banner ? banner.textContent.replace(/\\s+/g, ' ').trim().slice(0, 40) : '(无提示条)';
        var btn = document.querySelector('#proj-join');
        if (!btn) { report(); return; }
        btn.click();
        setTimeout(step2, 800);
        return;
      }
      // 切换器 → 发现空间页签 → 目标空间的「加入」
      var sw = document.getElementById('space-switch');
      if (!sw) { report(); return; }
      sw.click();
      setTimeout(function () {
        OUT.switchOpened = document.querySelector('.space-switcher') ? 1 : 0;
        var tab = document.querySelector('.space-switcher [data-ss-tab="discover"]');
        OUT.discoverTab = tab ? 1 : 0;
        if (!tab) { report(); return; }
        tab.click();
        setTimeout(function () {
          var row = document.querySelector('.space-switcher .ss-disc-row[data-pid="' + PID + '"]');
          OUT.cardFound = row ? 1 : 0;
          if (!row) { report(); return; }
          var join = row.querySelector('.ss-join');
          OUT.joinButton = join ? 1 : 0;
          if (!join) { report(); return; }
          join.click();
          setTimeout(step2, 800);
        }, 1500);
      }, 500);
    }
    function step2() {
      OUT.hashBeforeJoin = location.hash;
      OUT.modalOpen = document.querySelector('.modal-mask') ? 1 : 0;
      var btns = document.querySelectorAll('.modal-foot button');
      OUT.modalActions = btns.length;
      if (btns.length < 2) { report(); return; }
      btns[btns.length - 1].click();   // confirmDialog 的出口是 [取消, 加入]
      setTimeout(afterJoin, 3000);
    }
    window.addEventListener('load', function () {
      setTimeout(function () {
        location.hash = MODE === 'direct' ? ('#/p/' + PID + '/docs') : '#/';
        window.dispatchEvent(new HashChangeEvent('hashchange'));
        setTimeout(step1, 2600);
      }, 150);
    });
  })();
  </script>
'''


def _drill(base_url, admin, chrome, *, mode):
    """造一个公开项目 + 一个未加入的同事,跑一遍演练,返回报告 dict。"""
    pid = admin.post("/api/projects", {"name": "演练公开项目", "description": "d"}).data["id"]
    admin.patch(f"/api/projects/{pid}", {"isPublic": True})
    admin.post(f"/api/projects/{pid}/docs", {"title": "加入后可读的文档"})
    email, _ = make_user(admin, "演练同事", "drill12345")

    inject = JOIN_DRILL_INJECT.replace("__LOGIN_JS__", login_js(email, "drill12345")) \
                              .replace("__ERRTRAP_JS__", error_trap_js())
    qs = f"pid={urllib.parse.quote(str(pid), safe='')}&mode={mode}"
    with temp_page("_join_drill.html", inject) as page_name:
        info = read_report(dump_page(chrome, base_url, page_name, qs, budget=40000))
    assert info is not None, "未产出演练结果(页面可能整块崩了)"
    info["pid"] = str(pid)
    return info


def _assert_joined(info):
    """两条入口共用的后半段:真的加入了,而且落地处能读。"""
    assert info.get("hashBeforeJoin"), "弹框出现前就跳走了"
    assert info.get("modalOpen") == "1", "没有弹出加入询问框"
    assert info.get("modalActions") == "2", f"弹框出口数异常: {info.get('modalActions')}"
    assert (info.get("hashAfterJoin") or "").endswith(f"/p/{info['pid']}/docs"), \
        f"加入后应落到该项目的文档页: {info.get('hashAfterJoin')}"
    assert "加入后可读的文档" in (info.get("docTreeText") or ""), \
        f"加入后文档树里应看得到文档: {info.get('docTreeText')}"
    assert "演练公开项目" in (info.get("spaceNameText") or ""), \
        f"加入后顶栏没有切到该空间: {info.get('spaceNameText')}"


def test_join_drill_from_space_switcher(base_url, admin):
    """未加入者从空间切换器的「发现空间」页签加入:先问一句,加入后立即可读。"""
    chrome = find_chrome()
    if not chrome:
        pytest.skip("未找到 Chrome/Edge,跳过自助加入演练")

    info = _drill(base_url, admin, chrome, mode="switcher")
    assert info.get("errors", "?") == "none", f"演练页 JS 错误: {info.get('errors')}"
    assert info.get("switchOpened") == "1", "空间切换器没有打开"
    assert info.get("discoverTab") == "1", "空间切换器缺少「发现空间」页签"
    assert info.get("cardFound") == "1", "发现页签里没有这个公开空间的条目"
    assert info.get("joinButton") == "1", "发现条目上没有「加入」按钮"
    assert info.get("hashBeforeJoin") == "#/", \
        f"未加入者点「加入」不该直接进入(应弹框询问): {info.get('hashBeforeJoin')}"
    _assert_joined(info)


def test_join_drill_from_direct_link(base_url, admin):
    """同事发来的项目直链:403 错误态要给得出「加入项目」,点了能进去。"""
    chrome = find_chrome()
    if not chrome:
        pytest.skip("未找到 Chrome/Edge,跳过自助加入演练")

    info = _drill(base_url, admin, chrome, mode="direct")
    # 直链打开必然先吃一次 403(这正是本演练要走的路径),路由层会 console.error 记一笔。
    # 除它之外不允许有任何 JS 错误 —— 用文案白名单,别放宽成"忽略所有错误"
    unexpected = [e for e in (info.get("errors") or "").split(" | ")
                  if e and "需先加入才能查看" not in e]
    assert not unexpected, f"演练页出现预期外的 JS 错误: {unexpected}"
    assert info.get("joinButton") == "1", \
        f"错误态没有给「加入项目」按钮: {info.get('bannerText')}"
    _assert_joined(info)
