// views/admin.js — 管理后台作用域(#/admin/<section>,仅 is_admin)
//   本文件只做装配:左侧子导航、当前分区容器、跨区共享状态与 refresh 注册表。
//   分区实现拆在 views/admin/*.js,各自导出工厂 {key, load};切区只挂当前分区,
//   不会把六个分区叠成一整页。当前分区来自 Route.current().segs[2](缺省 overview),
//   路由事实只读一次,不把分区快照进可复用的闭包里。
//   "操作后刷哪些区"仍由调用点显式声明(ctx.refresh('users','security')) ——
//   只有当前挂载的分区需要重取,未挂载区的键是空操作。
window.Views = window.Views || {};
(function () {
  'use strict';

  // 子导航即分区注册表:顺序、图标、文案只有这一份。分区脚本按 App.loadAdmin()
  // 的动态加载顺序挂到 window.AdminSections.<key>(见 W2-a 的 index 装配)。
  const SECTIONS = [
    { key: 'overview', label: '总览', icon: 'dashboard-3-line' },
    { key: 'users', label: '用户', icon: 'team-line' },
    { key: 'projects', label: '空间', icon: 'folder-3-line' },
    { key: 'storage', label: '存储', icon: 'database-2-line' },
    { key: 'backup', label: '备份', icon: 'save-3-line' },
    { key: 'security', label: '安全', icon: 'shield-keyhole-line' },
  ];
  const KEYS = SECTIONS.map((s) => s.key);

  /** 从一条路由事实里取分区:优先 route 自带的 section(route.js 在 resolve 时算好),
   *  再兼容 segs[2]/segs[1]。规范写的是 segs[2];实际 `#/admin/{section}` 经
   *  Route.parse 后分区在 segs[1],故两者都认。 */
  function sectionOf(fact) {
    if (!fact) return null;
    if (KEYS.indexOf(fact.section) >= 0) return fact.section;
    const segs = fact.segs || [];
    if (segs[0] !== 'admin') return null;
    const raw = [segs[2], segs[1]].filter((k) => KEYS.indexOf(k) >= 0)[0];
    return raw || 'overview';
  }

  /** 当前分区。**先看 resolve 传进来的 route**:route.js 在 Route.setCurrent 之前
   *  就调用 Views.adminLevel(r),此刻 Route.current() 还是上一条路由;只读 current
   *  会让分区永远慢一拍(点"用户"却渲染总览)。route 不在时才回落到当前路由事实。 */
  function currentSection(route) {
    const fromRoute = sectionOf(route);
    if (fromRoute) return fromRoute;
    if (window.Route && typeof Route.current === 'function') {
      return sectionOf(Route.current()) || 'overview';
    }
    return 'overview';
  }

  /** 分区 hash 的构造点。Route.admin 由 W2-a 提供;未接线时用同一文法兜底,
   *  保证 admin.js 可独立加载/测试,也避免视图里散落 '#/admin/...' 字面量。 */
  function sectionHash(key) {
    if (window.Route && typeof Route.admin === 'function') return Route.admin(key);
    return '#/admin/' + encodeURIComponent(key);
  }

  // 命令面板/测试可读的分区元数据(只读约定:消费方不得原地改)
  Views.adminSections = SECTIONS.map((s) => ({ key: s.key, label: s.label, icon: s.icon }));

  window.Views.adminLevel = function (route) {
    const section = currentSection(route);
    const def = SECTIONS.filter((s) => s.key === section)[0] || SECTIONS[0];

    return {
      // 分区是页面身份的一部分:键带分区名,切区才会重建这一层(否则 Scope 会复用
      // 旧 DOM,内容与地址栏脱节)
      key: 'admin:' + section,
      render() {
        if (!App.user || !App.user.isAdmin) {
          UI.toast('仅管理员可访问管理后台', 'warning');
          location.replace('#/');
          return Scope.html('');
        }

        const frag = Scope.html(
          UI.pageHead({
            title: '管理后台',
            sub: '用户、空间、存储、备份与登录安全',
          }) +
          '<div class="admin-layout">' +
            '<nav class="admin-nav" aria-label="管理后台分区">' +
              SECTIONS.map((s) =>
                '<a class="admin-nav-item' + (s.key === section ? ' active' : '') + '"' +
                ' data-section="' + s.key + '" href="' + sectionHash(s.key) + '">' +
                UI.icon(s.icon) + '<span>' + UI.esc(s.label) + '</span></a>'
              ).join('') +
            '</nav>' +
            '<section class="admin-content" id="admin-section"' +
              ' data-admin-section="' + section + '"></section>' +
          '</div>');

        const el = frag.querySelector('#admin-section');
        // 跨区共享状态:分区工厂加载数据时写入,事件处理器读取(如项目区给用户区
        // 提供"唯一所有者"提醒)。只保存跨分区仍有意义的数据。
        const state = {};
        const mounted = {};   // key → 已挂载分区实例;refresh 只重取它们
        const ctx = {
          state,
          section,
          refresh: (...keys) => Promise.all(
            keys.map((k) => (mounted[k] ? mounted[k].load() : Promise.resolve()))),
          /** 分区内跳转到另一分区(总览的待办入口用它,不手拼 hash) */
          openSection(key) {
            const target = KEYS.indexOf(key) >= 0 ? key : 'overview';
            if (location.hash === sectionHash(target)) return;
            location.hash = sectionHash(target);
          },
        };

        const factory = window.AdminSections && window.AdminSections[section];
        if (!factory) {
          el.innerHTML = UI.error({ message: '管理分区「' + def.label + '」的脚本未加载,请刷新页面重试。' });
          return frag;
        }

        mounted[section] = factory(Object.assign({}, ctx, { el: el }));
        // 分区自己负责加载态/错误态;晚到的失败只提示,不打断整个后台
        Promise.resolve()
          .then(() => mounted[section].load())
          .catch((e) => { if (el.isConnected) el.innerHTML = UI.errorBanner(e); });
        return frag;
      },
    };
  };
})();
