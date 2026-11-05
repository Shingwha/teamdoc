// route.js — 路由文法:hash ↔ 路由事实,以及"路由 → 作用域"的唯一分派处
//
// 三件事,各只有一处:
//   Route.resolve(hash)  纯解析:返回作用域描述(或重定向)。重定向/坏 id 在**碰 DOM
//                        之前**判定完 —— 先清空页面再跳转,用户就会看到一帧空白
//   Route.NAV            空间内模块导航(模块分派 / 深链白名单 / tab 记忆共用)
//   Route.project(...)   '#/p/…' 的唯一构造点(视图不手拼路由串)
//   Route.settings(tab) / Route.admin(section)  对应命名空间的唯一构造点
//
// Route.current() 是"当前路由事实"的唯一来源。作用域**不要**把路由快照进闭包:
// 复用的层不会重建,闭包里的 docId 会停留在第一次的值。闭包只留常量(pid、tab
// 这类在自己 key 里的东西),更深的路由片段在用到的那一刻现读。
window.Route = (function () {
  'use strict';

  // 页面模式:宿主类名只在映射表里出现一次(视图不得自己加类)
  const MODE_CLASS = { fill: 'view-fill', narrow: 'page-narrow' };

  /**
   * 空间内模块导航。tab 深链、默认落点与模块分派共用这张表。
   *   level(r)    模块的作用域工厂;r = 当前路由事实(+ 由项目层补上的 proj)
   *   mode        页面模式:'fill' 满高填充 / 'narrow' 窄页 / 缺省默认页宽
   *   visible(p)  该项目下是否显示
   *   side        是否出现在左栏导航(文档树/云空间/回收站另有位置,成员与设置走抽屉)
   */
  const NAV = [
    { key: 'home', icon: 'home-5-line', label: '首页',
      level: function (r) { return Views.homeLevel(r); }, visible: function () { return true; } },
    { key: 'recent', icon: 'history-line', label: '最近',
      level: function (r) { return Views.recentLevel(r); }, visible: function () { return true; } },
    { key: 'favorites', icon: 'star-line', label: '收藏',
      level: function (r) { return Views.favoritesLevel(r); }, visible: function () { return true; } },
    { key: 'docs', icon: 'file-text-line', label: '文档', mode: 'fill',
      level: function (r) { return Views.docsLevel(r); }, visible: function () { return true; } },
    { key: 'files', icon: 'folder-line', label: '云空间',
      level: function (r) { return Views.filesLevel(r); }, visible: function () { return true; } },
    { key: 'members', icon: 'team-line', label: '成员', mode: 'narrow',
      level: function (r) { return Views.membersLevel(r); },
      visible: function (p) { return !p || !p.isPersonal; } },
    // 回收站含"删了什么"这类空间内部信息,只对真成员与全局管理员显示
    { key: 'trash', icon: 'delete-bin-line', label: '回收站', mode: 'narrow',
      level: function (r) { return Views.trashLevel(r); },
      visible: function (p) { return !p || UI.canRead(p); } },
    { key: 'settings', icon: 'settings-4-line', label: '空间设置', mode: 'narrow',
      level: function (r) { return Views.spaceSettingsLevel(r); },
      visible: function () { return true; } },
  ];
  const NAV_KEYS = NAV.map(function (n) { return n.key; });
  const TAB_KEY = 'td:lastTab:';

  const SETTINGS_TABS = ['account', 'security', 'preferences'];
  const ADMIN_SECTIONS = ['overview', 'users', 'projects', 'storage', 'backup', 'security'];

  /** 解析 hash → 路由事实。query 只在这里构造一次,消费方读 r.query */
  function parse(hash) {
    const h = String(hash || '').replace(/^#/, '') || '/';
    const qi = h.indexOf('?');
    const path = qi >= 0 ? h.slice(0, qi) : h;
    return {
      hash: h,
      segs: path.split('/').filter(Boolean),
      qs: qi >= 0 ? h.slice(qi + 1) : '',
      query: new URLSearchParams(qi >= 0 ? h.slice(qi + 1) : ''),
    };
  }

  /** '#/p/…' 的唯一构造点(视图/视图外都从这里取串,免得 esc 口径各写各的) */
  function project(pid, tab, docId, query) {
    let h = '#/p/' + encodeURIComponent(pid);
    if (tab) h += '/' + encodeURIComponent(tab);
    if (docId != null) h += '/' + encodeURIComponent(docId);
    if (query) {
      const qs = Object.keys(query)
        .filter(function (k) { return query[k] != null; })
        .map(function (k) { return k + '=' + encodeURIComponent(query[k]); }).join('&');
      if (qs) h += '?' + qs;
    }
    return h;
  }

  /** 个人设置命名空间的唯一构造点 */
  function settings(tab) {
    return '#/settings' + (SETTINGS_TABS.indexOf(tab) >= 0 ? '/' + tab : '');
  }

  /** 管理后台命名空间的唯一构造点(缺省总览) */
  function admin(section) {
    return '#/admin' + (ADMIN_SECTIONS.indexOf(section) >= 0 && section !== 'overview'
      ? '/' + section : '');
  }

  /** 空间路失效时落回哪一页:上次访问的模块(白名单校验,缺省首页) */
  function lastTab(pid) {
    const tab = UI.pref.get(TAB_KEY + pid, 'home');
    return NAV_KEYS.indexOf(tab) < 0 ? 'home' : tab;
  }

  function navOf(key) {
    return NAV.find(function (n) { return n.key === key; }) || null;
  }

  /**
   * 路由 → 作用域描述。返回 {spec, hostClass, route} 或 {redirect, notice} 或 {login:true}。
   * 纯函数:不碰 DOM、不写存储(记住 tab 由调用方按 route 写)。
   */
  function resolve(hash) {
    const r = parse(hash);
    const segs = r.segs;

    if (segs[0] === 'login') return { login: true };
    // '#/' 是"当前空间首页":空间由 views/home.js 从记忆或个人空间解析;
    // 没有任何空间时同一层显示空间管理入口
    if (!segs.length) return { spec: Views.homeLevel(r), route: r };
    if (segs[0] === 'projects') return { spec: Views.projectsLevel(r), route: r };
    // 发现与搜索不再有独立页面:发现只在空间切换器的「发现空间」页签里,
    // 搜索只在命令面板(Ctrl+K)里;旧书签落到首页,不保留兼容路由。
    if (segs[0] === 'settings') {
      r.settingsTab = SETTINGS_TABS.indexOf(segs[1]) >= 0 ? segs[1] : 'account';
      return { spec: Views.settingsLevel(r), route: r };
    }
    if (segs[0] === 'admin') {
      // 管理视图由 app.js 在管理员校验后动态加载;这里只负责形状与默认分区
      r.section = ADMIN_SECTIONS.indexOf(segs[1]) >= 0 ? segs[1] : 'overview';
      return { spec: Views.adminLevel(r), route: r };
    }

    if (segs[0] !== 'p' || !segs[1]) return { redirect: '#/' };
    // 路由边界只做形状判定:形状不对 = 这条链接坏了(旧书签、手工改短的地址),
    // 给一句可见的提示再回列表页 —— 静默回退会让人以为"点了没反应"
    const pid = UI.idOf(segs[1]);
    if (!pid) return { redirect: '#/', notice: '链接里的空间 id 无效,已回到首页' };
    r.pid = pid;
    // 再次进入空间默认落在上次访问的模块(localStorage 记忆,白名单校验)
    if (segs.length === 2) return { redirect: project(pid, lastTab(pid)) };
    const nav = navOf(segs[2]);
    if (!nav) return { redirect: project(pid, 'home') };
    r.tab = nav.key;
    r.docId = segs[3] ? UI.idOf(segs[3]) : null;
    // 空间页只有一层"空间作用域",模块层由它挂出来(child() 在拿到 proj 后才产出)
    return {
      spec: Views.projectLevel(r),
      hostClass: nav.mode ? MODE_CLASS[nav.mode] : null,
      route: r,
    };
  }

  // 当前路由事实:由 app.js 在每次路由时设入,作用域在需要更深的路由片段时现读
  let current = null;
  function setCurrent(r) { current = r; }
  function currentRoute() { return current; }

  return {
    NAV: NAV,
    resolve: resolve,
    parse: parse,
    project: project,
    settings: settings,
    admin: admin,
    navOf: navOf,
    lastTab: lastTab,
    current: currentRoute,
    setCurrent: setCurrent,
  };
})();
