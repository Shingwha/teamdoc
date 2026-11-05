// views/admin/security.js — 管理后台·安全区
//   登录动态(全站最近登录事件,含不存在账号的失败 = 撞库痕迹)
//   + 节流状态(当前锁定账号、登录节流桶、事件总量)
//   + PAT 审计(个人访问令牌的元数据,不返回 token/哈希)。
//   结果徽标复用 users 区暴露的共享件;若加载顺序变化则退化为原样文本。
window.AdminSections = window.AdminSections || {};
(function () {
  'use strict';

  const SEC_TPL = 'minmax(0, 1fr) minmax(0, 1.2fr) 88px minmax(0, 1.4fr)';
  const PAT_TPL = 'minmax(0, 1.05fr) minmax(0, 1fr) minmax(0, 1.1fr) 96px 96px 76px';
  const PAT_HEADS = [
    { html: '用户' }, { html: '名称' }, { html: '权限' },
    { html: '创建' }, { html: '最近使用' }, { html: '状态' },
  ];

  function badgeFor(result) {
    return (window.AdminSections && window.AdminSections.resultBadge)
      ? window.AdminSections.resultBadge(result)
      : UI.badge({ text: result || '未知' });
  }

  /** 权限串:服务端存的是逗号分隔字符串("read"/"read,write"),也兼容数组;
   *  空值显示破折号,不伪装成"全部权限"。 */
  function scopeBadges(scopes) {
    const list = Array.isArray(scopes)
      ? scopes
      : (typeof scopes === 'string' && scopes.trim() ? scopes.split(',') : []);
    const clean = list.map((s) => String(s).trim()).filter(Boolean);
    if (!clean.length) return '<span class="muted">—</span>';
    return clean.map((s) => UI.badge({ text: s, cls: 'tint' })).join(' ');
  }

  window.AdminSections.security = function (ctx) {
    const el = ctx.el;
    let secFilter = 'all';
    let events = [];
    let users = [];
    let diag = {};
    // PAT 审计的四种状态:加载中 / 有数据 / 空 / 错误。与登录动态分开取数 ——
    // 审计接口晚到或不可用不能拖垮整个安全区。
    let pats = [];
    let patsQ = '';
    let patsLoading = false;
    let patsError = null;

    function filteredEvents() {
      return secFilter === 'fail' ? events.filter((e) => e.result !== 'ok') : events;
    }

    function secTable() {
      const rows = filteredEvents();
      if (!rows.length) {
        return UI.emptyHtml({
          icon: 'shield-keyhole-line',
          title: secFilter === 'fail' ? '暂无失败记录' : '暂无登录记录',
        });
      }
      return UI.tableHead(
        [{ html: '时间' }, { html: '账号' }, { html: '结果' }, { html: '来源' }],
        { tpl: SEC_TPL }
      ) + rows.map((e) => UI.tableRow([
        { html: UI.cellMeta(UI.esc(UI.fmtDate(e.createdAt))) },
        // 账号不存在时把邮箱显示在标题上并标注出来 —— 那正是"有人在拿不存在的邮箱扫"的信号
        { html: e.userName
            ? UI.cellId({ title: UI.esc(e.userName), sub: UI.esc(e.email) })
            : UI.cellId({ title: UI.esc(e.email),
                          sub: '<span class="muted">账号不存在</span>' }) },
        { html: badgeFor(e.result) },
        { html: UI.cellId({ title: UI.esc(e.ip || '未知来源'),
                            sub: UI.esc(e.device || '未知设备') }) },
      ])).join('');
    }

    function lockedCard() {
      const locked = users.filter((u) => u.lockedUntil);
      const rows = locked.map((u) => UI.listRow({
        avatar: UI.avatar({ name: u.name || u.email, seed: u.id, size: 'lg', color: u.avatarColor }),
        title: UI.esc(u.name || u.email),
        badges: UI.badge({ text: '已锁定', kind: 'danger' }),
        sub: UI.esc(u.email + ' · 锁定至 ' + UI.fmtDate(u.lockedUntil)),
        actions: UI.btn({
          label: '解除锁定', kind: 'tonal', size: 'sm',
          cls: 'sec-unlock', attrs: 'data-uid="' + UI.esc(u.id) + '"',
        }),
      })).join('');
      return UI.card({
        title: '节流状态', icon: 'shield-keyhole-line', between: true,
        body:
          UI.statGrid([
            { label: '当前锁定账号', value: String(locked.length), danger: locked.length > 0,
              sub: locked.length ? '登录失败冷却中' : '没有账号被锁定' },
            { label: '登录节流桶', value: String(diag.loginLocks == null ? '—' : diag.loginLocks),
              sub: '账号维度与来源维度的活跃计数' },
            { label: '登录事件总量', value: String(diag.loginEvents == null ? '—' : diag.loginEvents),
              sub: '含成功与失败' },
          ]) + (rows || '<div class="muted mt-3">当前没有处于锁定冷却的账号。</div>'),
      });
    }

    // ---------- PAT 审计(只读) ----------
    function filteredPats() {
      const needle = patsQ.trim().toLowerCase();
      if (!needle) return pats;
      return pats.filter((p) =>
        (p.userName || '').toLowerCase().indexOf(needle) >= 0 ||
        (p.userEmail || '').toLowerCase().indexOf(needle) >= 0 ||
        (p.name || '').toLowerCase().indexOf(needle) >= 0);
    }

    function patsTable() {
      const rows = filteredPats();
      if (!rows.length) {
        return UI.emptyHtml({
          icon: 'key-2-line',
          title: pats.length ? '没有匹配的令牌' : '暂无访问令牌',
          desc: pats.length ? '换个用户或令牌名称试试' : '用户创建个人访问令牌后会在此汇总',
          sm: true,
        });
      }
      return UI.tableHead(PAT_HEADS, { tpl: PAT_TPL, headId: 'admin-pats-head' }) +
        rows.map((p) => UI.tableRow([
          {
            html: UI.cellId({
              title: UI.esc(p.userName || p.userEmail || '未知用户'),
              sub: UI.esc(p.userEmail || ''),
            }),
          },
          { html: UI.cellMeta(UI.esc(p.name || '—'), 'admin-pat-name') },
          { html: UI.cellMeta(scopeBadges(p.scopes)) },
          { html: UI.cellMeta(p.createdAt ? UI.esc(UI.fmtDateShort(p.createdAt)) : '—') },
          {
            html: UI.cellMeta(p.lastUsedAt ? UI.esc(UI.fmtDateShort(p.lastUsedAt))
              : '<span class="muted">从未使用</span>'),
          },
          {
            html: p.revokedAt
              ? UI.badge({ text: '已吊销', kind: 'danger' })
              : UI.badge({ text: '有效', kind: 'success' }),
          },
        ], { attrs: 'data-pat="' + UI.esc(p.id) + '"' })).join('');
    }

    function paintPatsBody() {
      const box = el.querySelector('#admin-pats-body');
      if (!box) return;
      if (patsLoading) { box.innerHTML = UI.skeleton('rows', 3); return; }
      if (patsError) { box.innerHTML = UI.errorBanner(patsError, { sm: true }); return; }
      box.innerHTML = patsTable();
    }

    /** 独立取数:接口未接线/失败只让这一张卡进入错误态,登录动态照常显示。 */
    function loadPats() {
      patsLoading = true;
      patsError = null;
      paintPatsBody();
      let path;
      try {
        if (typeof Endpoints.adminPats !== 'function') {
          throw new Error('PAT 审计接口尚未就绪');
        }
        path = Endpoints.adminPats({ limit: 100 });
      } catch (e) {
        patsLoading = false;
        patsError = e;
        paintPatsBody();
        return Promise.resolve();
      }
      return api(path).then((r) => {
        pats = (r && r.items) || [];
        patsLoading = false;
        paintPatsBody();
      }).catch((e) => {
        patsLoading = false;
        patsError = e;
        paintPatsBody();
      });
    }

    function patsCard() {
      return UI.card({
        id: 'admin-pats', title: 'PAT 审计', icon: 'key-2-line', between: true,
        note: '个人访问令牌只展示元数据,不返回 token 或哈希;默认列出最近 100 条。',
        actions: '<div class="admin-search">' + UI.icon('search-line') +
          '<input class="input" id="admin-pats-q" type="text" autocomplete="off"' +
          ' placeholder="搜索用户 / 令牌名称" value="' + UI.esc(patsQ) + '"></div>',
        body: '<div id="admin-pats-body">' + UI.skeleton('rows', 3) + '</div>',
      });
    }

    function securityHtml() {
      return UI.sectionTitle({
        title: '安全', icon: 'shield-keyhole-line',
        actions: UI.seg({
          id: 'sec-filter', auto: true, active: secFilter,
          items: [{ key: 'all', label: '全部' }, { key: 'fail', label: '仅失败' }],
        }),
      }) +
        lockedCard() +
        patsCard() +
        UI.card({
          title: '登录动态(最近 ' + events.length + ' 条)', icon: 'history-line',
          body: '<div id="sec-body">' + secTable() + '</div>',
        });
    }

    function load() {
      return UI.loadInto(el, () => Promise.all([
        api(Endpoints.adminLoginEvents({ limit: 100 })),
        api(Endpoints.adminDiagnostics()),
        api(Endpoints.users()),
      ]), {
        loadingHtml: UI.skeleton('cards', 2),
        render: ([list, diagnostics, userList]) => {
          events = list || [];
          diag = diagnostics || {};
          users = userList || [];
          return securityHtml();
        },
      }).then(() => loadPats());
    }

    el.addEventListener('input', (e) => {
      if (!e.target.closest('#admin-pats-q')) return;
      patsQ = e.target.value;
      paintPatsBody();
    });

    el.addEventListener('click', async (e) => {
      const filterBtn = e.target.closest('#sec-filter button[data-key]');
      if (filterBtn) {
        secFilter = filterBtn.dataset.key;
        UI.segSet(el.querySelector('#sec-filter'), secFilter);
        const body = el.querySelector('#sec-body');
        if (body) body.innerHTML = secTable();
        return;
      }
      const unlock = e.target.closest('.sec-unlock');
      if (unlock) {
        try {
          await api(Endpoints.user(unlock.dataset.uid), {
            method: 'PATCH', body: { unlock: true },
          });
          UI.toast('已解除登录锁定', 'success');
          await load();
        } catch (err) { UI.err(err); }
      }
    });

    return { key: 'security', load };
  };
})();
