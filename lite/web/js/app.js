// app.js — 壳(40px 顶栏 + 左栏 + 单一内容面)+ 登录视图 + 路由入口
//   路由的文法(解析/串构造/模块表)在 route.js,界面怎么被挂出来在 scopes.js ——
//   本文件只做三件事:拿当前 hash、把路由事实交给作用域链、处理"不渲染任何东西"的分支
//   (登录页 / 重定向),以及壳自身的空间切换、命令面板入口与用户菜单。
(function () {
  'use strict';

  window.Views = window.Views || {};

  // ---------- 全局状态 ----------
  const App = {
    user: null,       // 当前登录用户 {id,email,name,isAdmin,avatarColor}
    auth: null,       // /api/auth/me 的 auth 段 {via,scopes}
    spaces: null,     // 可见空间列表缓存(壳与切换器共用;数据本身仍由各页自己取)
    spacePid: null,   // 当前空间 id(路由里的 pid,或 #/ 解析出的记忆空间)
    space: null,      // 当前空间对象(能取到时)
    // 离开守卫:视图在"有未保存内容"时拦下路由切换。**机制在此,策略由视图给** ——
    // 注册的 fn(target) 返回 Promise<boolean>,false = 不许离开。同时只有一个
    // (同一时刻只有一个编辑器视图活着),所以用单槽而不是数组。
    leaveGuard: null,
    onLeaveGuard(fn) { this.leaveGuard = fn; },
    clearLeaveGuard() { this.leaveGuard = null; },
    // 路由串生成点(实现在 route.js:各命名空间的唯一构造处,视图不手拼路由串)
    route: { project: Route.project, settings: Route.settings, admin: Route.admin },
  };
  window.App = App;

  const LAST_SPACE_KEY = 'td:last-space';
  const VIEWED_KEY = 'td:viewed';

  // ---------- 壳 ----------
  function showShell() {
    document.getElementById('shell').hidden = false;
    document.getElementById('login-root').hidden = true;
  }
  function hideShell() {
    document.getElementById('shell').hidden = true;
    document.getElementById('login-root').hidden = false;
  }

  /** 当前空间 id:路由里的 pid 优先,其次是 #/ 解析/记忆出来的空间 */
  App.currentSpaceId = function () {
    const cur = Route.current();
    if (cur && cur.pid) return cur.pid;
    return App.spacePid || null;
  };

  /** 记忆并激活一个空间(不负责取项目对象;调用方拿到后再传一次) */
  App.setSpace = function (pid, proj) {
    pid = UI.idOf(pid);
    if (!pid) return;
    App.spacePid = pid;
    UI.pref.set(LAST_SPACE_KEY, pid);
    if (proj) App.space = proj;
    else if (App.spaces) App.space = App.spaces.find((p) => p.id === pid) || App.space;
    renderSideNav(pid);
    syncSpaceChrome();
    markSidebarActive();
  };

  /** 空间列表(壳/切换器/首页共用;失败不抛给壳) */
  App.loadSpaces = async function (force) {
    if (App.spaces && !force) return App.spaces;
    App.spaces = (await api(Endpoints.projects())) || [];
    syncSpaceChrome();
    return App.spaces;
  };

  /** 账号资料改动后同步壳上的头像/菜单(App.user 是同一份事实) */
  App.syncUser = function () {
    const u = App.user;
    const btn = document.getElementById('btn-user');
    if (u && btn) {
      const name = u.name || u.email || '?';
      btn.innerHTML = UI.avatar({ name: name, seed: u.id, color: u.avatarColor, size: 28 });
      btn.title = name + '(' + (u.email || '') + ')';
    }
    syncSpaceChrome();
  };

  function syncSpaceChrome() {
    const nameEl = document.getElementById('space-name');
    const dotEl = document.getElementById('space-dot');
    if (!nameEl) return;
    let proj = App.space;
    if (!proj && App.spacePid && App.spaces) proj = App.spaces.find((p) => p.id === App.spacePid);
    nameEl.textContent = proj ? proj.name : (App.spacePid ? '空间' : '选择空间');
    const color = (proj && proj.color) || '';
    dotEl.style.background = color || 'var(--md-primary)';
  }

  // ---------- 左栏:当前空间导航 + 文档树槽位 + 云空间/回收站 ----------
  // 文档树不由壳渲染:文档模块在自己的 render 里写进 #side-doc-tree,离开即清空。
  // 这里只负责导航与空间上下文 —— 单一树、单一来源。
  let navPid = null;

  function navLink(key, label, icon, href, extra) {
    return '<a class="side-item" data-route="' + key + '" href="' + href + '"' +
      (extra || '') + '>' + UI.icon(icon) + '<span class="side-label">' + UI.esc(label) + '</span></a>';
  }
  function navDisabled(key, label, icon, reason) {
    return '<span class="side-item disabled" data-route="' + key + '" title="' + UI.esc(reason) + '">' +
      UI.icon(icon) + '<span class="side-label">' + UI.esc(label) + '</span></span>';
  }

  function renderSideNav(pid) {
    if (navPid === pid) return;
    navPid = pid;
    const nav = document.getElementById('side-nav');
    const foot = document.getElementById('side-foot');
    if (!nav || !foot) return;

    nav.innerHTML = navLink('home', '首页', 'home-5-line', '#/') +
      (pid
        ? navLink('recent', '最近', 'history-line', App.route.project(pid, 'recent')) +
          navLink('favorites', '收藏', 'star-line', App.route.project(pid, 'favorites'))
        : navDisabled('recent', '最近', 'history-line', '进入一个空间后可用') +
          navDisabled('favorites', '收藏', 'star-line', '进入一个空间后可用'));

    foot.innerHTML = pid
      ? navLink('files', '云空间', 'folder-line', App.route.project(pid, 'files')) +
        navLink('trash', '回收站', 'delete-bin-line', App.route.project(pid, 'trash'))
      : navDisabled('files', '云空间', 'folder-line', '进入一个空间后可用') +
        navDisabled('trash', '回收站', 'delete-bin-line', '进入一个空间后可用');
  }

  /** 左栏高亮:只动 class,不重绘(路由切换重绘会丢节点身份) */
  function markSidebarActive() {
    const cur = Route.current();
    const segs = currentSegs();
    let active = '';
    if (!segs.length) active = 'home';
    else if (segs[0] === 'p' && cur && cur.tab) active = cur.tab;
    document.querySelectorAll('#sidebar .side-item.active').forEach((a) => a.classList.remove('active'));
    if (!active) return;
    const el = document.querySelector('#sidebar .side-item[data-route="' + active + '"]');
    if (el) el.classList.add('active');
  }

  App.switchSpace = function (pid) {
    pid = UI.idOf(pid);
    if (!pid) return;
    App.setSpace(pid);
    location.hash = App.route.project(pid, 'home');
  };

  // ---------- 用户菜单 ----------
  function buildAppearancePanel() {
    const wrap = document.createElement('div');
    wrap.className = 'menu-header';
    wrap.innerHTML = '<div class="small muted mb-2 fw-semi">外观</div>';
    const segEl = document.createElement('div');
    segEl.innerHTML = UI.seg({
      active: Theme.getMode(),
      items: Theme.MODES.map((m) => ({ key: m.id, label: m.label, icon: m.icon })),
    });
    const seg = segEl.firstElementChild;
    UI.segWire(seg, (key) => Theme.setMode(key));
    wrap.appendChild(seg);
    const dots = document.createElement('div');
    dots.className = 'color-dots mt-3';
    Theme.COLORS.forEach((c) => {
      const d = document.createElement('button');
      d.type = 'button';
      d.className = 'color-dot' + (Theme.getColor() === c.id ? ' active' : '');
      d.style.background = c.value;
      d.title = c.label;
      d.addEventListener('click', () => {
        Theme.setColor(c.id);
        dots.querySelectorAll('.color-dot').forEach((x) => x.classList.remove('active'));
        d.classList.add('active');
      });
      dots.appendChild(d);
    });
    wrap.appendChild(dots);
    return wrap;
  }

  function setupTopbar() {
    if (setupTopbar.wired) return;
    setupTopbar.wired = true;
    spaceSwitchMenu = UI.dropdownMenu(document.getElementById('space-switch'),
      () => [{ custom: buildSpaceSwitcher() }], { align: 'start', menuCls: 'space-switch-menu' });
    // 首页无空间态的「发现空间」入口:打开切换器并直接落到发现页签
    App.openSpaceSwitcher = function (tab) {
      if (tab) spaceSwitchTab = tab;
      if (spaceSwitchMenu) spaceSwitchMenu.open();
    };
    document.getElementById('cmd-open').addEventListener('click', () => {
      if (window.Palette) Palette.open();
    });
    UI.dropdownMenu(document.getElementById('btn-notify'),
      () => [{ custom: buildNotifyPanel() }], { align: 'end', menuCls: 'notify-menu' });
    document.getElementById('btn-settings').setAttribute('href', App.route.settings('account'));

    UI.dropdownMenu(document.getElementById('btn-user'), () => {
      const u = App.user || {};
      const items = [{
        custom: (() => {
          const el = document.createElement('div');
          el.className = 'menu-header';
          el.innerHTML =
            '<div class="cell-id">' +
            UI.avatar({ name: u.name || u.email, seed: u.id || u.email, size: 'lg', color: u.avatarColor }) +
            '<div class="cell-id-main"><div class="cell-id-name truncate">' + UI.esc(u.name || '') + '</div>' +
            '<div class="small muted truncate">' + UI.esc(u.email || '') + '</div></div></div>';
          return el;
        })(),
      }, { divider: true },
      { icon: 'settings-3-line', label: '个人设置', onClick: () => { location.hash = App.route.settings('account'); } }];
      if (u.isAdmin) {
        items.push({ icon: 'shield-user-line', label: '管理后台', onClick: () => { location.hash = App.route.admin('overview'); } });
      }
      items.push({ custom: buildAppearancePanel() }, { divider: true });
      items.push({ icon: 'logout-box-line', label: '退出登录', danger: true, onClick: doLogout });
      return items;
    }, { direction: 'down', align: 'end' });

    setupNarrowSidebar();
  }

  // ---------- 空间切换器(自定义浮层:我的空间 / 发现空间) ----------
  let spaceSwitchMenu = null;
  let spaceSwitchTab = 'mine';

  function canManageSpace(p) {
    return !!p && ((App.user && App.user.isAdmin) || p.myRole === 'OWNER' || p.myRole === 'ADMIN');
  }
  function anyManageableSpace() {
    return !!(App.user && App.user.isAdmin) ||
      (App.spaces || []).some((p) => p.myRole === 'OWNER' || p.myRole === 'ADMIN');
  }

  function spaceMenuRow(p) {
    const current = p.id === App.spacePid;
    return '<div class="ss-space-row' + (current ? ' current' : '') + '" role="button" tabindex="0"' +
      ' data-pid="' + UI.esc(p.id) + '">' +
      '<span class="space-dot sm" style="background:' + UI.esc(p.color || 'var(--md-primary)') + '"></span>' +
      '<span class="ss-space-main">' +
        '<span class="ss-space-name">' + UI.esc(p.name) + '</span>' +
        (p.isPersonal ? UI.badge({ text: '个人', cls: 'xs' })
          : (p.myRole ? UI.badge({ text: UI.roleLabel(p.myRole), cls: 'xs' }) : '')) +
      '</span>' +
      (current ? UI.icon('check-line', 'ss-current') : '') +
      // 逐空间设置入口:只有能管理这个空间的人才看得到
      (canManageSpace(p) ? UI.iconBtn({ icon: 'more-fill', title: '空间设置', size: 'sm', cls: 'ss-more' }) : '') +
      '</div>';
  }

  function discoverMenuRow(p) {
    return '<div class="ss-disc-row" data-pid="' + UI.esc(p.id) + '">' +
      '<span class="space-dot sm" style="background:' + UI.esc(p.color || 'var(--md-primary)') + '"></span>' +
      '<span class="ss-space-main">' +
        '<span class="ss-space-name">' + UI.esc(p.name) + '</span>' +
        '<span class="ss-disc-desc">' + UI.esc(p.description || '暂无描述') + '</span>' +
      '</span>' +
      (p.isMember
        ? '<button type="button" class="btn btn-text btn-sm ss-open">打开</button>'
        : '<button type="button" class="btn btn-tonal btn-sm ss-join">加入</button>') +
      '</div>';
  }

  /** 每次打开都重建:空间列表与公开空间都以点击这一刻的事实为准 */
  function buildSpaceSwitcher() {
    const panel = document.createElement('div');
    panel.className = 'space-switcher';
    panel.innerHTML =
      '<div class="ss-tabs" role="tablist">' +
      '<button type="button" class="ss-tab" role="tab" data-ss-tab="mine">我的空间</button>' +
      '<button type="button" class="ss-tab" role="tab" data-ss-tab="discover">发现空间</button>' +
      '</div>' +
      '<div class="ss-body" id="ss-body"></div>' +
      '<div class="ss-foot" id="ss-foot"></div>';
    const body = panel.querySelector('#ss-body');
    const foot = panel.querySelector('#ss-foot');
    let active = spaceSwitchTab;
    let discover = null;      // {loading,error,items}
    let loadingSpaces = false;

    function alive() { return document.body.contains(panel); }
    function closeMenu() { UI.closeOpenMenu(); }

    function paintTabs() {
      panel.querySelectorAll('[data-ss-tab]').forEach((b) => {
        const on = b.dataset.ssTab === active;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
    }

    function paintFoot() {
      foot.innerHTML =
        UI.btn({ id: 'ss-create', label: '创建空间', icon: 'add-line', kind: 'text', size: 'sm' }) +
        (anyManageableSpace()
          ? UI.btn({ id: 'ss-manage', label: '管理空间', icon: 'layout-grid-line', kind: 'text', size: 'sm' })
          : '');
    }

    function paintBody() {
      if (active === 'mine') {
        const spaces = App.spaces;
        if (!spaces) {
          body.innerHTML = UI.loadingRow('加载空间…');
          if (!loadingSpaces) {
            loadingSpaces = true;
            App.loadSpaces().then(() => {
              loadingSpaces = false;
              if (alive() && active === 'mine') paintBody();
            }).catch((e) => {
              loadingSpaces = false;
              if (alive() && active === 'mine') body.innerHTML = UI.error(e, { sm: true });
            });
          }
          paintFoot();
          return;
        }
        body.innerHTML = spaces.length
          ? spaces.map(spaceMenuRow).join('')
          : UI.empty({ sm: true, icon: 'folder-open-line', title: '还没有空间', desc: '创建空间开始协作' }).outerHTML;
        paintFoot();
        return;
      }
      if (!discover || discover.loading) {
        body.innerHTML = UI.loadingRow('加载公开空间…');
      } else if (discover.error) {
        body.innerHTML = UI.error(discover.error, { sm: true });
      } else {
        const list = discover.items || [];
        body.innerHTML = list.length
          ? list.map(discoverMenuRow).join('')
          : UI.empty({
            sm: true, icon: 'compass-3-line', title: '还没有公开空间',
            desc: '空间管理员把空间公开后,同事就能在这里发现并加入',
          }).outerHTML;
      }
      paintFoot();
    }

    function loadDiscover() {
      discover = { loading: true, error: null, items: [] };
      paintBody();
      api(Endpoints.discover()).then((items) => {
        discover = { loading: false, error: null, items: items || [] };
        if (alive() && active === 'discover') paintBody();
      }).catch((e) => {
        discover = { loading: false, error: e, items: [] };
        if (alive() && active === 'discover') paintBody();
      });
    }

    panel.addEventListener('click', (e) => {
      const tab = e.target.closest('[data-ss-tab]');
      if (tab) {
        active = tab.dataset.ssTab === 'discover' ? 'discover' : 'mine';
        spaceSwitchTab = active;
        paintTabs();
        if (active === 'discover' && !discover) loadDiscover();
        else paintBody();
        return;
      }
      if (e.target.closest('#ss-create')) {
        closeMenu();
        if (window.SpaceWizard) SpaceWizard.open();
        return;
      }
      if (e.target.closest('#ss-manage')) {
        closeMenu();
        location.hash = '#/projects';
        return;
      }
      const more = e.target.closest('.ss-more');
      if (more) {
        const row = more.closest('.ss-space-row');
        const proj = (App.spaces || []).find((x) => x.id === row.dataset.pid);
        closeMenu();
        if (proj && window.SpaceSettings) SpaceSettings.open(proj, proj.id, 'overview');
        return;
      }
      const spaceRow = e.target.closest('.ss-space-row');
      if (spaceRow) {
        closeMenu();
        App.switchSpace(spaceRow.dataset.pid);
        return;
      }
      const openBtn = e.target.closest('.ss-open');
      if (openBtn) {
        closeMenu();
        location.hash = App.route.project(openBtn.closest('.ss-disc-row').dataset.pid, 'home');
        return;
      }
      const joinBtn = e.target.closest('.ss-join');
      if (joinBtn) {
        const p = ((discover && discover.items) || [])
          .find((x) => x.id === joinBtn.closest('.ss-disc-row').dataset.pid);
        closeMenu();
        if (p && window.ProjectsAPI) ProjectsAPI.joinPrompt(p.id, p.name, p.joinRole);
      }
    });

    paintTabs();
    paintBody();
    if (active === 'discover') loadDiscover();
    return panel;
  }

  // ---------- 通知 ----------
  /** 未读红点:壳启动时与已读操作后各刷一次;接口失败只收起点,不打扰用户 */
  function refreshNotifyBadge() {
    const btn = document.getElementById('btn-notify');
    if (!btn || !App.user) return;
    api(Endpoints.notifications()).then((r) => {
      const unread = (r && r.unread) || 0;
      btn.classList.toggle('has-unread', unread > 0);
      btn.title = unread > 0 ? '通知(' + unread + ' 条未读)' : '通知';
    }).catch(() => {
      btn.classList.remove('has-unread');
    });
  }

  function buildNotifyPanel() {
    const panel = document.createElement('div');
    panel.className = 'notify-panel';
    panel.innerHTML =
      '<div class="notify-head"><span class="notify-title">通知</span></div>' +
      '<div class="notify-list" id="notify-list">' + UI.loadingRow('加载通知…') + '</div>' +
      '<div class="notify-foot">' +
      '<button type="button" class="btn btn-text btn-sm" id="notify-read-all">全部已读</button></div>';
    const list = panel.querySelector('#notify-list');
    const readAll = panel.querySelector('#notify-read-all');
    let items = [];

    function setBadge(unread) {
      const btn = document.getElementById('btn-notify');
      if (!btn) return;
      btn.classList.toggle('has-unread', unread > 0);
      btn.title = unread > 0 ? '通知(' + unread + ' 条未读)' : '通知';
    }

    function paint() {
      const unread = items.filter((x) => !x.readAt).length;
      readAll.disabled = unread === 0;
      if (!items.length) {
        list.innerHTML = '';
        list.appendChild(UI.empty({ sm: true, icon: 'notification-3-line', title: '暂无通知' }));
        return;
      }
      list.innerHTML = items.map((n) =>
        '<button type="button" class="notify-item' + (n.readAt ? '' : ' unread') + '" data-nid="' + UI.esc(n.id) + '">' +
        '<span class="notify-dot"></span>' +
        '<span class="notify-main">' +
        '<span class="notify-item-title">' + UI.esc(n.title) + '</span>' +
        (n.body ? '<span class="notify-body">' + UI.esc(n.body) + '</span>' : '') +
        '<span class="notify-time">' + UI.esc(UI.fmtWhen(n.createdAt)) + '</span>' +
        '</span></button>').join('');
    }

    api(Endpoints.notifications()).then((r) => {
      items = (r && r.items) || [];
      setBadge((r && r.unread) || items.filter((x) => !x.readAt).length);
      paint();
    }).catch((e) => {
      list.innerHTML = UI.error(e, { sm: true });
      readAll.disabled = true;
      setBadge(0);
    });

    list.addEventListener('click', async (e) => {
      const btn = e.target.closest('.notify-item');
      if (!btn) return;
      const n = items.find((x) => x.id === btn.dataset.nid);
      if (!n) return;
      if (!n.readAt) {
        try {
          await api(Endpoints.notificationsRead(), { method: 'POST', body: { ids: [n.id] } });
        } catch (err) { UI.err(err); return; }
        n.readAt = new Date().toISOString();
        setBadge(items.filter((x) => !x.readAt).length);
        paint();
      }
      UI.closeOpenMenu();
      if (n.link && n.link.charAt(0) === '#') location.hash = n.link;
      else if (n.link) location.assign(n.link);
    });

    readAll.addEventListener('click', async () => {
      try {
        await api(Endpoints.notificationsReadAll(), { method: 'POST', body: {} });
      } catch (err) { UI.err(err); return; }
      items.forEach((x) => { if (!x.readAt) x.readAt = new Date().toISOString(); });
      setBadge(0);
      paint();
      UI.toast('已全部标记为已读', 'success');
    });

    return panel;
  }

  // 窄屏左栏是抽屉:顶栏的菜单钮打开它,导航后自动收起
  function setupNarrowSidebar() {
    const shell = document.getElementById('shell');
    const collapseBtn = document.getElementById('btn-side');
    const sidePanel = UI.dualPanel({
      el: shell,
      openCls: 'side-open',
      prefKey: 'td:side-open',
      onChange: (p) => { if (collapseBtn) collapseBtn.title = p.isOpen() ? '收起导航' : '打开导航'; },
    });
    if (collapseBtn) collapseBtn.addEventListener('click', () => sidePanel.toggle());
    document.getElementById('side-scrim').addEventListener('click', sidePanel.close);
    document.getElementById('sidebar').addEventListener('click', (e) => {
      if (sidePanel.isNarrow() && e.target.closest('.side-item')) sidePanel.close();
    });
    // 宽屏折叠按钮在左栏底部;窄屏收起由遮罩与导航完成
    const collapseWide = document.getElementById('side-collapse');
    if (collapseWide) collapseWide.addEventListener('click', () => sidePanel.toggle());
    App.closeNavDrawer = function () { if (sidePanel.isNarrow()) sidePanel.close(); };
    App.toggleSidebar = sidePanel.toggle;
  }

  async function doLogout() {
    try { await api(Endpoints.authLogout(), { method: 'POST' }); } catch (e) { /* 忽略 */ }
    App.user = null;
    App.auth = null;
    App.spaces = null;
    App.space = null;
    App.spacePid = null;
    navPid = null;
    setupShell._uid = null;
    if (location.hash === '#/login') route();
    else location.hash = '#/login';
  }

  // ---------- 管理后台动态加载(普通用户永不请求这些脚本) ----------
  const ADMIN_SCRIPTS = [
    '/js/views/admin/overview.js',
    '/js/views/admin/storage.js',
    '/js/views/admin/backup.js',
    '/js/views/admin/projects.js',
    '/js/views/admin/users.js',
    '/js/views/admin/security.js',
    '/js/views/admin.js',
  ];
  let adminPromise = null;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('管理模块加载失败:' + src));
      document.body.appendChild(s);
    });
  }

  App.loadAdmin = function () {
    if (!App.user || !App.user.isAdmin) return Promise.resolve(false);
    if (adminPromise) return adminPromise;
    adminPromise = (async () => {
      for (const src of ADMIN_SCRIPTS) await loadScript(src);
      return true;
    })().catch((e) => { adminPromise = null; throw e; });
    return adminPromise;
  };

  // ---------- 最近浏览(本地记录) ----------
  App.recordView = function (pid, docId, title) {
    pid = UI.idOf(pid);
    docId = UI.idOf(docId);
    if (!pid || !docId) return;
    let list = [];
    try { list = JSON.parse(localStorage.getItem(VIEWED_KEY) || '[]') || []; } catch (e) { list = []; }
    list = list.filter((x) => !(x.projectId === pid && x.id === docId));
    list.unshift({ id: docId, projectId: pid, title: title || '文档', at: new Date().toISOString() });
    try { localStorage.setItem(VIEWED_KEY, JSON.stringify(list.slice(0, 60))); } catch (e) { /* 配额满时放弃 */ }
  };

  App.viewed = function (pid) {
    let list = [];
    try { list = JSON.parse(localStorage.getItem(VIEWED_KEY) || '[]') || []; } catch (e) { list = []; }
    return list.filter((x) => x.projectId === pid);
  };

  // ---------- 路由 ----------
  function currentSegs() { return Route.parse(location.hash).segs; }

  let forceNext = false;
  function route(force) {
    forceNext = forceNext || !!force;
    Promise.resolve(_route()).catch((e) => {
      console.error(e);
      UI.err(e);
    });
  }
  App.refresh = () => route(true);

  function hashOf(url) {
    if (!url) return '';
    const i = url.indexOf('#');
    return i < 0 ? '' : url.slice(i);
  }

  let restoredTo = null;
  async function guardedRoute(ev) {
    if (restoredTo !== null && location.hash === restoredTo) { restoredTo = null; return; }
    const fromHash = hashOf(ev && ev.oldURL);
    if (!App.leaveGuard || location.hash.startsWith('#/login')) { route(); return; }
    let allow = true;
    try { allow = await App.leaveGuard(location.hash); }
    catch (e) { allow = true; }
    if (allow) { route(); return; }
    restoredTo = fromHash || '#/';
    location.replace(restoredTo);
  }

  async function ensureUser() {
    if (App.user) return true;
    try {
      const me = await api(Endpoints.authMe());
      App.user = me.user;
      App.auth = me.auth || null;
      setupShell();
      return true;
    } catch (e) {
      return false;
    }
  }

  function setupShell() {
    if (!App.user) return;
    // 同一页换账号(退出后登录 / 会话失效后重新登录):空间缓存属于上一个用户,
    // 必须丢掉;记忆键(上次空间)保留,由新账号自己的可见列表校验
    if (setupShell._uid !== App.user.id) {
      setupShell._uid = App.user.id;
      App.spaces = null;
      App.space = null;
      navPid = null;
    }
    setupTopbar();
    App.syncUser();
    renderSideNav(App.spacePid || UI.pref.get(LAST_SPACE_KEY, null));
    App.loadSpaces().catch(() => { /* 空间列表失败不阻塞壳 */ });
    refreshNotifyBadge();
  }

  function shellError(view, message) {
    Scope.clear();
    view.innerHTML = UI.error({ message: message, action: { label: '返回首页', id: 'boot-back' } });
    const back = view.querySelector('#boot-back');
    if (back) back.onclick = () => { location.hash = '#/'; };
  }

  async function _route() {
    UI.closeOpenMenu();
    UI.closeAllModals();
    if (App.closeNavDrawer) App.closeNavDrawer();
    const view = document.getElementById('view');

    const pre = Route.parse(location.hash);
    if (pre.segs[0] === 'login') { Scope.clear(); await renderLogin(); return; }

    if (!(await ensureUser())) {
      if (location.hash !== '#/login') location.replace('#/login');
      else { Scope.clear(); await renderLogin(); }
      return;
    }

    // 管理后台:先过管理员闸,再按序加载独立的 admin 脚本;普通用户不会发起这些请求
    if (pre.segs[0] === 'admin') {
      if (!App.user.isAdmin) {
        UI.toast('仅管理员可访问管理后台', 'warning');
        location.replace('#/');
        return;
      }
      try { await App.loadAdmin(); }
      catch (e) { console.error(e); shellError(view, e.message); return; }
    }

    const out = Route.resolve(location.hash);

    if (out.redirect) {
      if (out.notice) UI.err(out.notice);
      location.replace(out.redirect);
      return;
    }

    Route.setCurrent(out.route);
    if (out.route.tab) UI.pref.set('td:lastTab:' + out.route.pid, out.route.tab);
    // 空间上下文:路由里带 pid 就切过去;'#/' 由 home 视图解析记忆空间后回填
    if (out.route.pid) App.setSpace(out.route.pid);
    else renderSideNav(App.spacePid);
    showShell();
    markSidebarActive();
    Scope.apply(view, out.spec, { hostClass: out.hostClass, force: forceNext });
    forceNext = false;
  }

  // ---------- 登录 / 初始化视图(#/login,无壳;含两步初始化向导) ----------
  async function renderLogin() {
    hideShell();
    const root = document.getElementById('login-root');
    root.innerHTML = '<div class="login-page"><div class="login-card">' + UI.loadingRow() + '</div></div>';

    try {
      const me = await api(Endpoints.authMe());
      if (me && me.user) {
        App.user = me.user;
        App.auth = me.auth || null;
        setupShell();
        location.replace('#/');
        return;
      }
    } catch (e) { /* 未登录,继续渲染登录页 */ }

    let status = { bootstrapped: true, dbReady: true };
    try { status = await api(Endpoints.authStatus()); }
    catch (e) { status = { bootstrapped: true, dbReady: false }; }

    if (!status.bootstrapped) renderAuthForm(root, { status, mode: 'bootstrap' });
    else renderAuthForm(root, { status, mode: 'login', email: rememberedEmail() });
  }

  const REMEMBER_EMAIL_KEY = 'td:login-email';
  function rememberedEmail() { return UI.pref.get(REMEMBER_EMAIL_KEY, ''); }

  function dbWarning(status) {
    return status && status.dbReady === false
      ? UI.banner({ kind: 'info', icon: 'database-2-line', cls: 'mb-4', text: '数据库未就绪,请稍后刷新重试' }) : '';
  }

  function brandCard(inner, subtitle) {
    return '<div class="login-page"><div class="login-card">' +
      '<div class="login-brand">' +
      '<span class="login-logo">' + UI.icon('file-text-line') + '</span>' +
      '<span class="login-brand-name">TeamDoc</span></div>' +
      '<div class="login-sub">' + UI.esc(subtitle || '小团队自部署文档与知识库') + '</div>' +
      inner + '</div></div>';
  }

  function renderAuthForm(root, { status, mode, email = '' }) {
    const isBootstrap = mode === 'bootstrap';
    // 刻意用 type="text":浏览器原生格式校验比服务端严,格式判定统一交给服务端
    const emailField =
      '<div class="field"><label>邮箱</label>' +
      '<input type="text" class="input" name="email" required autocomplete="username" value="' + UI.esc(email) + '"></div>';
    const passwordField = '<div class="field"><label>密码' + (isBootstrap ? '(至少 8 位)' : '') + '</label>' +
      '<input type="password" class="input" name="password" required' + (isBootstrap ? ' minlength="8"' : '') +
      ' autocomplete="' + (isBootstrap ? 'new-password' : 'current-password') + '"></div>';
    const nameField = isBootstrap
      ? '<div class="field"><label>姓名</label>' +
        '<input type="text" class="input" name="name" required maxlength="50" autocomplete="name"></div>'
      : '';
    const rememberField = isBootstrap
      ? ''
      : '<div class="field"><label class="check-row"><input type="checkbox" name="remember">' +
        '记住我(延长登录有效期)</label></div>';

    root.innerHTML = brandCard(
      dbWarning(status) +
      // 初始化是"先到先得"的管理员注册窗口:站点一上线就能被抢注,提示必须显眼
      (isBootstrap ? UI.banner({
        kind: 'warn', icon: 'shield-keyhole-line', cls: 'mb-4',
        text: '安全提示:初始化完成前,任何能访问本站的人都可以抢先创建管理员账号。请在部署后立即完成初始化。',
      }) : '') +
      UI.banner({ id: 'login-err', kind: 'danger', cls: 'mb-4', hidden: true, html: '<span></span>' }) +
      // 字段顺序即机制:邮箱紧贴密码框,姓名殿后并标 autocomplete="name"
      '<form id="auth-form">' + emailField + passwordField + nameField + rememberField +
      '<button type="submit" class="btn btn-filled btn-lg btn-block" id="auth-btn">' +
      (isBootstrap ? '创建管理员并继续' : '登 录') + '</button>' +
      '</form>',
      isBootstrap ? '初始化 · 创建管理员账号' : '小团队自部署文档与知识库');

    const form = root.querySelector('#auth-form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const body = {
        email: String(fd.get('email') || '').trim(),
        password: String(fd.get('password') || ''),
      };
      if (isBootstrap) body.name = String(fd.get('name') || '').trim();
      else body.remember = fd.get('remember') != null;
      const btn = root.querySelector('#auth-btn');
      btn.disabled = true;
      try {
        const r = await api(isBootstrap ? Endpoints.authBootstrap() : Endpoints.authLogin(),
          { method: 'POST', body });
        if (!isBootstrap) UI.pref.set(REMEMBER_EMAIL_KEY, body.email);
        App.user = r.user;
        App.auth = null;
        setupShell();
        if (isBootstrap) renderFirstSpaceStep(root);
        else location.replace('#/');
      } catch (err2) {
        btn.disabled = false;
        const errBox = root.querySelector('#login-err');
        errBox.querySelector('span').textContent = err2.message || (isBootstrap ? '初始化失败' : '登录失败');
        errBox.hidden = false;
      }
    });
  }

  /** 初始化第二步:创建第一个空间并邀请成员;跳过后直接进首页(个人空间) */
  function renderFirstSpaceStep(root) {
    let members = [];
    root.innerHTML = brandCard(
      '<div class="bootstrap-steps"><span class="bs-step done">1 管理员</span><span class="bs-step current">2 第一个空间</span></div>' +
      '<div class="field"><label>空间名</label><input class="input" id="bs-space-name" maxlength="100" placeholder="例如:产品设计"></div>' +
      '<div class="field"><label>描述(可选)</label><input class="input" id="bs-space-desc" maxlength="200" placeholder="这个空间用来做什么"></div>' +
      '<div class="field"><label>邀请成员(可选)</label>' +
      '<div id="bs-members" class="chip-row"></div>' +
      UI.btn({ id: 'bs-pick', label: '选择成员', icon: 'user-add-line', kind: 'tonal', size: 'sm' }) + '</div>' +
      '<div class="form-inline mt-4">' +
      UI.btn({ id: 'bs-create', label: '创建并进入', kind: 'filled', size: 'lg' }) +
      UI.btn({ id: 'bs-skip', label: '稍后再说', kind: 'text' }) + '</div>',
      '初始化 · 第一个空间');

    const membersEl = root.querySelector('#bs-members');
    function renderMembers() {
      membersEl.innerHTML = members.map((m) =>
        '<span class="chip selected" data-uid="' + UI.esc(m.id) + '">' +
        UI.esc(m.name || m.email) + UI.icon('close-line') + '</span>').join('');
    }
    membersEl.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      members = members.filter((m) => m.id !== chip.dataset.uid);
      renderMembers();
    });
    root.querySelector('#bs-pick').onclick = async () => {
      const picked = await UI.personPicker({
        title: '邀请同事加入空间', multi: true,
        excludeIds: members.map((m) => m.id),
        roleSelect: { label: '加入角色', value: 'EDITOR',
          options: [{ value: 'EDITOR', label: '编辑者' }, { value: 'VIEWER', label: '只读成员' }] },
        confirmLabel: '邀请',
      });
      if (!picked || !picked.length) return;
      members = members.concat(picked);
      renderMembers();
    };
    root.querySelector('#bs-skip').onclick = () => { location.replace('#/'); };
    root.querySelector('#bs-create').onclick = async () => {
      const name = root.querySelector('#bs-space-name').value.trim();
      if (!name) { UI.toast('空间名不能为空', 'warning'); return; }
      const btn = root.querySelector('#bs-create');
      btn.disabled = true;
      try {
        const p = await api(Endpoints.projects(), {
          method: 'POST',
          body: {
            name,
            description: root.querySelector('#bs-space-desc').value.trim(),
            members: members.map((m) => ({ userId: m.id, role: m.role || 'EDITOR' })),
          },
        });
        App.spaces = null;
        location.replace(App.route.project(p.id, 'home'));
      } catch (e) {
        btn.disabled = false;
        UI.err(e);
      }
    };
    root.querySelector('#bs-space-name').focus();
  }

  // ---------- 启动 ----------
  document.addEventListener('DOMContentLoaded', () => {
    setupTopbar();
    App.syncUser();
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        if (window.Palette) Palette.open();
      }
    });
    window.addEventListener('hashchange', guardedRoute);
    route();
  });
})();
