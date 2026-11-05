// views/admin/users.js — 管理后台·用户区
//   列表(44px 行 / 搜索 / 全部·管理员·禁用·7 日活跃 chips / 多选批量启禁用)
//   + 新建 / 编辑 / 重置密码 / 禁用 / 删除 + 用户详情抽屉(480px):
//   身份 / 所属空间(就地改角色、移出、加入) / 锁定 / 会话 / 登录事件。
//   详情里的"所属空间"与空间区行内的"成员"是同一段成员关系的双视角 ——
//   两处都调用同一组成员 API,不各自维护一份数据。
window.AdminSections = window.AdminSections || {};
(function () {
  'use strict';

  const ROLES = ['OWNER', 'ADMIN', 'EDITOR', 'VIEWER'];
  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

  // 结果码 → 徽标。服务端给稳定代码,文案只在前端映射(与 roleLabel 同一分工)。
  const RESULT_META = {
    ok: { label: '成功', kind: 'success', icon: 'check-line' },
    bad_password: { label: '密码错误', kind: 'danger', icon: 'close-line' },
    disabled: { label: '已禁用账号', kind: 'warn', icon: 'forbid-2-line' },
    locked: { label: '触发锁定', kind: 'danger', icon: 'lock-line' },
  };
  function resultBadge(r) {
    return UI.badge({ text: (RESULT_META[r] || {}).label || r || '未知',
                      kind: (RESULT_META[r] || {}).kind || '' });
  }
  function deviceIcon(kind) { return kind === 'mobile' ? 'smartphone-line' : 'computer-line'; }
  // security 区复用登录结果徽标;它按 App.loadAdmin 的顺序在本文件之后加载
  window.AdminSections.RESULT_META = RESULT_META;
  window.AdminSections.resultBadge = resultBadge;

  /** 锁定徽标:文案只写「已锁定」,完整时间进 title —— 列表里那列曾被
   *  「锁定至 9/12 09:23」撑到 148px 宽;精确到分的时间是排查信息,归详情 */
  function lockBadge(u) {
    return u.lockedUntil
      ? UI.badge({ text: '已锁定', kind: 'danger', title: '锁定至 ' + UI.fmtDate(u.lockedUntil) })
      : '';
  }

  function roleBadge(u) {
    return u.isAdmin
      ? UI.badge({ text: '管理员', kind: 'primary' })
      : UI.badge({ text: '成员', cls: 'muted' });
  }

  function stateBadges(u) {
    return roleBadge(u) +
      (u.isDisabled ? UI.badge({ text: '已禁用', kind: 'danger' }) : '') +
      lockBadge(u);
  }

  function statusCell(u) {
    if (u.isDisabled) return UI.badge({ text: '已禁用', kind: 'danger' });
    if (u.lockedUntil) {
      return UI.badge({ text: '已锁定', kind: 'warning', title: '锁定至 ' + UI.fmtDate(u.lockedUntil) });
    }
    return UI.badge({ text: '正常', kind: 'success' });
  }

  function activeWithinWeek(u) {
    if (!u.lastLoginAt) return false;
    const t = new Date(u.lastLoginAt).getTime();
    return Number.isFinite(t) && Date.now() - t <= SEVEN_DAYS;
  }

  // 列:选择框 / 用户(弹性) / 所属空间 / 状态 / 最后活跃(弹性) / 操作(派生固定宽)
  const TPL = 'var(--col-check) minmax(0, 1.35fr) 72px 82px minmax(0, 0.75fr) var(--col-acts)';
  const HEADS = [
    { html: '用户' }, { html: '所属空间' }, { html: '状态' },
    { html: '最后活跃' }, { html: '' },
  ];

  window.AdminSections.users = function (ctx) {
    const el = ctx.el;
    let users = [];
    let q = '';
    let filter = 'all';
    let selected = new Set();
    let index = null;          // userId → [{space, role, createdAt, lastActiveAt}]
    let indexPromise = null;
    let openedDeepLink = null; // 路由 ?user= 只自动打开一次(刷新/角色变更不重开)

    function findUser(uid) { return users.find((u) => u.id === uid); }

    /** 当前路由的查询参数:命令面板的 `#/admin/users?user={id}` 与手写的 ?q= 都从这里读。 */
    function routeQuery() {
      const cur = window.Route && typeof Route.current === 'function' ? Route.current() : null;
      if (cur && cur.query) return cur.query;
      return window.Route ? Route.parse(location.hash).query : new URLSearchParams();
    }

    function filtered() {
      const needle = q.trim().toLowerCase();
      return users.filter((u) => {
        if (filter === 'admin' && !u.isAdmin) return false;
        if (filter === 'disabled' && !u.isDisabled) return false;
        if (filter === 'active7' && !activeWithinWeek(u)) return false;
        if (!needle) return true;
        return (u.name || '').toLowerCase().indexOf(needle) >= 0 ||
          (u.email || '').toLowerCase().indexOf(needle) >= 0;
      });
    }

    // ---------- 所属空间索引(一次拉全站空间与成员,按用户归并) ----------
    // 服务端没有"按用户列成员关系"的端点;管理端可用 /api/projects?all=1 拿到
    // 全部协作空间,再逐个取成员。只用于列表的"所属空间数"和详情卡,
    // 失败时宁可不显示计数,也不在本地猜一个数。
    function invalidateIndex() { index = null; indexPromise = null; }

    function ensureIndex() {
      if (index) return Promise.resolve(index);
      if (indexPromise) return indexPromise;
      indexPromise = (async () => {
        const projects = (await api(Endpoints.projects({ all: 1 }))) || [];
        const spaces = projects.filter((p) => !p.isPersonal);
        const out = {};
        await Promise.all(spaces.map(async (p) => {
          try {
            const members = (await api(Endpoints.projectMembers(p.id))) || [];
            members.forEach((m) => {
              (out[m.userId] = out[m.userId] || []).push({
                space: p, role: m.role,
                createdAt: m.createdAt, lastActiveAt: m.lastActiveAt,
              });
            });
          } catch (e) { /* 单个空间失败不影响其它空间的计数 */ }
        }));
        return out;
      })();
      return indexPromise.then((idx) => {
        index = idx;
        indexPromise = null;
        return idx;
      }, (e) => {
        indexPromise = null;
        throw e;
      });
    }

    function refreshSpaceCounts() {
      if (!index) return;
      el.querySelectorAll('[data-space-count]').forEach((node) => {
        const list = index[node.getAttribute('data-space-count')] || [];
        node.textContent = String(list.length);
        node.title = list.length ? list.map((x) => x.space.name).join('、') : '未加入任何协作空间';
      });
    }

    // ---------- 列表 ----------
    function chipCounts() {
      return {
        all: users.length,
        admin: users.filter((u) => u.isAdmin).length,
        disabled: users.filter((u) => u.isDisabled).length,
        active7: users.filter(activeWithinWeek).length,
      };
    }

    function paintShell() {
      const counts = chipCounts();
      el.innerHTML =
        UI.sectionTitle({
          title: '用户', icon: 'team-line',
          actions: UI.btn({ id: 'btn-new-user', label: '新建用户', icon: 'user-add-line', kind: 'filled' }),
        }) +
        UI.toolbar({
          left: '<div class="admin-search">' + UI.icon('search-line') +
            '<input class="input" id="admin-user-q" type="text" autocomplete="off"' +
            ' placeholder="搜索姓名或邮箱" value="' + UI.esc(q) + '"></div>',
          right: UI.seg({
            id: 'admin-user-filter', auto: true, active: filter,
            items: [
              { key: 'all', label: '全部', count: counts.all || null },
              { key: 'admin', label: '管理员', count: counts.admin || null },
              { key: 'disabled', label: '禁用', count: counts.disabled || null },
              { key: 'active7', label: '7 日活跃', count: counts.active7 || null },
            ],
          }),
        }) +
        '<div id="admin-users-table" class="mt-3"></div>';
      const seg = el.querySelector('#admin-user-filter');
      if (seg) {
        UI.segWire(seg, (key) => {
          filter = key;
          paintTable();
        });
      }
    }

    function paintTable() {
      const tableEl = el.querySelector('#admin-users-table');
      if (!tableEl) return;
      const list = filtered();
      const head = UI.tableHead(HEADS, {
        tpl: TPL,
        cls: 'admin-users-table acts-5',
        headId: 'admin-users-head',
        checkAll: '<input type="checkbox" id="admin-user-check-all" class="sel-box" title="全选当前列表">',
        batch:
          '<span class="batch-info" id="admin-user-batch-info"></span>' +
          UI.btn({ id: 'admin-user-enable', label: '启用', icon: 'play-circle-line', kind: 'tonal', size: 'sm' }) +
          UI.btn({ id: 'admin-user-disable', label: '禁用', icon: 'forbid-2-line', kind: 'danger-outline', size: 'sm' }) +
          UI.btn({ id: 'admin-user-cancel', label: '取消', kind: 'text', size: 'sm' }),
      });
      const rows = list.map((u) => {
        const spaces = index && index[u.id];
        return UI.tableRow([
          {
            html: UI.cellId({
              avatar: UI.avatar({ name: u.name || u.email, seed: u.id, size: 'lg', color: u.avatarColor }),
              title: UI.esc(u.name),
              sub: UI.esc(u.email),
              badges: stateBadges(u),
            }),
          },
          {
            html: UI.cellMeta('<span data-space-count="' + UI.esc(u.id) + '" title="' +
              (spaces ? UI.esc(spaces.map((x) => x.space.name).join('、') || '未加入任何协作空间')
                      : '统计中…') + '">' +
              (spaces ? spaces.length : '—') + '</span>'),
          },
          { html: statusCell(u) },
          {
            html: UI.cellId({
              title: u.lastLoginAt ? UI.esc(UI.fmtDateShort(u.lastLoginAt))
                                   : '<span class="muted">从未登录</span>',
              badges: u.lastLoginAt
                ? (u.online ? UI.badge({ text: '在线', kind: 'success' })
                            : UI.badge({ text: '离线', cls: 'muted' }))
                : '',
            }),
          },
        ], {
          check: '<input type="checkbox" class="sel-box u-check"' +
            (selected.has(u.id) ? ' checked' : '') + '>',
          selected: selected.has(u.id),
          attrs: 'data-uid="' + UI.esc(u.id) + '"',
          acts:
            UI.iconBtn({ icon: 'user-search-line', title: '用户详情(身份 / 所属空间 / 会话 / 事件)',
                         cls: 'u-access' }) +
            UI.iconBtn({ icon: 'edit-line', title: '编辑', cls: 'u-edit' }) +
            UI.iconBtn({ icon: 'key-2-line', title: '重置密码', cls: 'u-reset' }) +
            UI.iconBtn({
              icon: u.isDisabled ? 'play-circle-line' : 'forbid-2-line',
              title: u.isDisabled ? '启用' : '禁用',
              danger: !u.isDisabled, cls: 'u-toggle',
            }) +
            (u.canDelete
              ? UI.iconBtn({ icon: 'delete-bin-line', title: '删除(仅限无数据的账号)',
                             danger: true, cls: 'u-delete' })
              : ''),
        });
      }).join('');
      tableEl.innerHTML = head + rows +
        (list.length ? '' : '<div class="admin-table-empty">' +
          UI.emptyHtml({
            icon: 'user-line',
            title: users.length ? '没有匹配的用户' : '暂无用户',
            desc: users.length ? '换个关键词或筛选条件试试' : '新建账号后成员即可登录',
          }) + '</div>');
      updateBatchBar();
    }

    function updateBatchBar() {
      const tableEl = el.querySelector('#admin-users-table');
      if (!tableEl) return;
      const headEl = tableEl.querySelector('#admin-users-head');
      const info = tableEl.querySelector('#admin-user-batch-info');
      const checkAll = tableEl.querySelector('#admin-user-check-all');
      const n = selected.size;
      if (headEl) headEl.classList.toggle('selecting', n > 0);
      if (info) info.textContent = '已选 ' + n + ' 项';
      const boxes = [...tableEl.querySelectorAll('.u-check')];
      if (checkAll) {
        checkAll.checked = boxes.length > 0 && boxes.every((b) => b.checked);
        checkAll.indeterminate = !checkAll.checked && boxes.some((b) => b.checked);
      }
    }

    function setRowSelected(row, on) {
      const uid = row.dataset.uid;
      if (on) selected.add(uid); else selected.delete(uid);
      row.classList.toggle('selected', on);
      const cb = row.querySelector('.u-check');
      if (cb) cb.checked = on;
    }

    function load() {
      el.innerHTML = UI.skeleton('rows', 6);
      // 深链:?q= 直接过滤列表,?user= 在数据到货后打开该用户详情。
      const query = routeQuery();
      const deepQ = query.get('q');
      if (deepQ != null) q = deepQ;
      const deepUser = query.get('user');
      return api(Endpoints.users()).then((list) => {
        users = list || [];
        const alive = new Set(users.map((u) => u.id));
        selected = new Set([...selected].filter((id) => alive.has(id)));
        paintShell();
        paintTable();
        // 计数是增强信息:先画表,索引到货后原地补数字(不重新取用户列表)
        ensureIndex().then(refreshSpaceCounts).catch(() => {});
        if (deepUser && deepUser !== openedDeepLink) {
          openedDeepLink = deepUser;
          const target = findUser(deepUser);
          if (target) userDrawer(target);
          else UI.toast('未找到该用户', 'warning');
        }
        return users;
      }).catch((e) => {
        el.innerHTML = UI.errorBanner(e);
      });
    }

    /** 同一分区内的 query 变化(再次从命令面板跳用户)不会重建作用域:补一次同步。
     *  延后一轮再读 —— app 的 _route 会先 closeAllModals 再 Scope.apply,
     *  在这里立刻开抽屉会被随后的清理关掉。数据未到时交给 load 的深链分支处理。 */
    let routeSyncTimer = null;
    function onRouteHash() {
      if (!el.isConnected) {
        window.removeEventListener('hashchange', onRouteHash);
        return;
      }
      clearTimeout(routeSyncTimer);
      routeSyncTimer = setTimeout(() => {
        if (!el.isConnected || !users.length) return;
        if ((location.hash || '').indexOf('#/admin/users') !== 0) return;
        const query = Route.parse(location.hash).query;
        const nextQ = query.get('q');
        if (nextQ != null && nextQ !== q) {
          q = nextQ;
          const input = el.querySelector('#admin-user-q');
          if (input) input.value = q;
          paintTable();
        }
        const deepUser = query.get('user');
        if (deepUser && deepUser !== openedDeepLink) {
          openedDeepLink = deepUser;
          const target = findUser(deepUser);
          if (target) userDrawer(target);
          else UI.toast('未找到该用户', 'warning');
        }
      }, 0);
    }
    window.addEventListener('hashchange', onRouteHash);

    // ---------- 所属空间选择器(与选人器同一套浮层语言) ----------
    function pickSpace(opts) {
      opts = opts || {};
      const excluded = {};
      (opts.excludeIds || []).forEach((id) => { excluded[id] = 1; });
      const m = UI.modal({
        title: opts.title || '加入空间',
        body:
          '<div class="field flush"><input class="input" id="sp-q" type="text"' +
          ' placeholder="搜索空间名称" autocomplete="off"></div>' +
          '<div class="field mt-3"><label>加入角色</label>' +
            '<select class="select" id="sp-role">' +
              ROLES.map((r) => '<option value="' + r + '"' +
                (r === 'EDITOR' ? ' selected' : '') + '>' + UI.esc(UI.roleLabel(r)) + '</option>').join('') +
            '</select></div>' +
          '<div id="sp-list" class="pp-list">' + UI.loadingRow() + '</div>',
        actions: [
          { label: '取消', kind: 'text', value: null },
          { label: '加入', kind: 'filled', value: '__ok__' },
        ],
      });
      const qEl = m.body.querySelector('#sp-q');
      const roleEl = m.body.querySelector('#sp-role');
      const listEl = m.body.querySelector('#sp-list');
      let all = [];
      let picked = null;

      function render() {
        const needle = (qEl.value || '').trim().toLowerCase();
        const rows = all.filter((p) => !needle || (p.name || '').toLowerCase().indexOf(needle) >= 0);
        if (!rows.length) {
          listEl.innerHTML = '<div class="pp-empty">' +
            (all.length ? '没有匹配的空间' : '没有可加入的空间') + '</div>';
          return;
        }
        listEl.innerHTML = rows.map((p) =>
          '<div class="pp-item' + (picked && picked.id === p.id ? ' selected' : '') + '"' +
          ' data-pid="' + UI.esc(p.id) + '">' +
            UI.avatar({ name: p.name, seed: p.id, size: 'lg' }) +
            '<span class="pp-main"><span class="pp-name">' + UI.esc(p.name) + '</span>' +
            '<span class="pp-mail">' + UI.esc((p.memberCount || 0) + ' 位成员') + '</span></span>' +
            (picked && picked.id === p.id ? '<i class="ri-checkbox-circle-fill"></i>' : '') +
          '</div>').join('');
      }

      listEl.addEventListener('click', (e) => {
        const b = e.target.closest('.pp-item');
        if (!b) return;
        picked = all.filter((p) => p.id === b.dataset.pid)[0] || null;
        render();
      });
      qEl.addEventListener('input', render);
      qEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const first = listEl.querySelector('.pp-item');
          if (first) first.click();
        }
      });
      api(Endpoints.projects({ all: 1 })).then((list) => {
        all = (list || []).filter((p) => !p.isPersonal && !excluded[p.id]);
        render();
        qEl.focus();
      }).catch((e) => { listEl.innerHTML = UI.errorBanner(e, { sm: true }); });

      return m.result.then((v) => {
        if (v !== '__ok__' || !picked) return null;
        return { space: picked, role: roleEl.value };
      });
    }

    // ---------- 列表操作 ----------
    function openNewUser() {
      UI.formModal({
        title: '新建用户',
        okText: '创建',
        fields: [
          { name: 'email', label: '邮箱', type: 'email', required: true, autocomplete: 'username' },
          { name: 'password', label: '初始密码(至少 8 位)', type: 'password', required: true, autocomplete: 'new-password' },
          { name: 'name', label: '姓名', required: true, maxlength: 50, autocomplete: 'name' },
          { name: 'isAdmin', type: 'checkbox', checkbox: '设为管理员' },
        ],
        submit: async (v, { close }) => {
          if (v.password.length < 8) { UI.toast('密码至少 8 位', 'warning'); return; }
          await api(Endpoints.users(), {
            method: 'POST',
            body: { email: v.email.trim(), name: v.name.trim(), password: v.password, isAdmin: v.isAdmin },
          });
          close(true);
          UI.toast('用户已创建', 'success');
          invalidateIndex();
          await load();
        },
      });
    }

    function openEditUser(u) {
      UI.formModal({
        title: '编辑用户',
        okText: '保存',
        fields: [
          { name: 'email', label: '邮箱', type: 'text', value: u.email, required: true },
          { name: 'name', label: '姓名', value: u.name, maxlength: 50 },
          { name: 'isAdmin', type: 'checkbox', checkbox: '管理员', value: u.isAdmin },
        ],
        submit: async (v, { close }) => {
          await api(Endpoints.user(u.id), {
            method: 'PATCH',
            body: { email: v.email.trim(), name: v.name.trim(), isAdmin: v.isAdmin },
          });
          close(true);
          UI.toast('已保存', 'success');
          await load();
        },
      });
    }

    async function resetPassword(u) {
      const pwd = await UI.inputDialog({
        title: '重置密码',
        label: '新密码(至少 8 位)',
        type: 'password',
        // 密码框不能靠默认的 autocomplete="off":浏览器会忽略密码框上的 off,可能把管理员
        // 自己的密码回填进"给他人设密码"的框。new-password 令牌才挡得住回填
        autocomplete: 'new-password',
        help: '为「' + u.email + '」设置新密码;该用户的登录会话与访问令牌会一并失效',
      });
      if (!pwd) return;
      if (pwd.length < 8) { UI.toast('密码至少 8 位', 'warning'); return; }
      try {
        await api(Endpoints.user(u.id), { method: 'PATCH', body: { password: pwd } });
        UI.toast('密码已重置', 'success');
      } catch (err) { UI.err(err); }
    }

    async function soleOwnedHint(list) {
      if (!list.length) return '';
      let projects = [];
      try { projects = (await api(Endpoints.adminProjects())) || []; } catch (e) { return ''; }
      const ids = new Set(list.map((u) => u.id));
      const owned = projects.filter((p) => !p.isPersonal && (p.owners || []).length === 1 &&
        p.owners[0] && ids.has(p.owners[0].id));
      if (!owned.length) return '';
      const names = owned.slice(0, 3).map((p) => p.name).join('、');
      return '注意:' + (owned.length > 3 ? names + ' 等 ' + owned.length + ' 个空间' : '「' + names + '」') +
        '的唯一所有者是' + (list.length === 1 ? '该用户' : '所选用户') +
        ',禁用后请到「空间」区先转让所有权,否则空间将无人可管理。';
    }

    async function toggleUser(u) {
      const disabling = !u.isDisabled;
      if (disabling && App.user && App.user.id === u.id) {
        UI.toast('不能禁用当前登录的账号', 'warning');
        return;
      }
      const hint = disabling ? await soleOwnedHint([u]) : '';
      const ok = await UI.confirmDialog(
        (disabling ? '禁用后该用户将立即无法访问系统。' : '') + hint +
        '确定' + (disabling ? '禁用' : '启用') + '「' + u.email + '」?',
        { danger: disabling, okText: disabling ? '禁用' : '启用' });
      if (!ok) return;
      try {
        await api(Endpoints.user(u.id), { method: 'PATCH', body: { isDisabled: disabling } });
        UI.toast(disabling ? '已禁用' : '已启用', 'success');
        await load();
      } catch (err) { UI.err(err); }
    }

    async function batchToggle(disable) {
      const list = users.filter((u) => selected.has(u.id));
      if (!list.length) return;
      const targets = disable
        ? list.filter((u) => !(App.user && App.user.id === u.id))
        : list;
      if (!targets.length) {
        UI.toast('不能禁用当前登录的账号', 'warning');
        return;
      }
      const hint = disable ? await soleOwnedHint(targets) : '';
      const ok = await UI.confirmDialog(
        (disable ? '将禁用 ' : '将启用 ') + targets.length + ' 个账号。' + hint + '确定继续?',
        { danger: disable, okText: disable ? '禁用' : '启用' });
      if (!ok) return;
      const r = await UI.eachOk(targets, (u) =>
        api(Endpoints.user(u.id), { method: 'PATCH', body: { isDisabled: disable } }));
      selected.clear();
      UI.toast((disable ? '已禁用 ' : '已启用 ') + r.ok + ' 个' +
        (r.failed.length ? ',' + r.failed.length + ' 个失败' : ''),
        r.failed.length ? 'warning' : 'success');
      await load();
    }

    // ---------- 用户详情抽屉 ----------
    function identityCard(u, d) {
      const spaces = index && index[u.id];
      return UI.card({
        title: '账号标识', icon: 'fingerprint-line',
        body: UI.detailList([
          { label: '用户 ID', html: UI.idText({ value: u.id, copy: true, full: true }) },
          { label: '邮箱', html: UI.esc(u.email) },
          { label: '加入时间', html: UI.esc(UI.fmtDate(u.createdAt)) },
          { label: '角色', html: roleBadge(u) },
          {
            label: '所属空间',
            html: spaces ? UI.esc(spaces.length + ' 个') : '<span class="muted">统计中…</span>',
          },
          {
            label: '状态',
            html: (u.isDisabled ? UI.badge({ text: '已禁用', kind: 'danger' })
                                : UI.badge({ text: '正常', kind: 'success' })) +
              (u.lockedUntil ? ' <span class="muted">锁定至 ' + UI.esc(UI.fmtDate(u.lockedUntil)) + '</span>' : ''),
          },
          {
            label: '最近登录',
            html: u.lastLoginAt
              ? UI.esc(UI.fmtDate(u.lastLoginAt)) +
                (u.lastLoginIp ? ' <span class="muted">来自 ' + UI.esc(u.lastLoginIp) + '</span>' : '')
              : '<span class="muted">从未登录</span>',
          },
        ]),
      });
    }

    /** 所属空间行的次行:成员加入时间 + 该用户最近成功登录。
     *  字段缺失(后端尚未接线)时明说"未知",不拿空间创建时间冒充成员加入时间。 */
    function memberMeta(entry) {
      const joined = entry.createdAt
        ? '加入于 ' + UI.fmtDateShort(entry.createdAt)
        : '加入时间未知';
      const hasActive = Object.prototype.hasOwnProperty.call(entry, 'lastActiveAt');
      const active = entry.lastActiveAt
        ? '最后活跃 ' + UI.fmtDateShort(entry.lastActiveAt)
        : (hasActive ? '从未活跃' : '最后活跃未知');
      return joined + ' · ' + active;
    }

    /** 所属空间:空间名 + 角色(行内直接改)+ 移出;加入空间走统一的空间选择浮层。
     *  与空间区成员抽屉读写同一组 /api/projects/{id}/members 接口。 */
    function spacesCard(u, list) {
      const rows = list.map((entry) =>
        UI.listRow({
          icon: 'folder-3-line',
          title: UI.esc(entry.space.name),
          badges: UI.badge({ text: UI.roleLabel(entry.role), kind: entry.role === 'OWNER' ? 'primary' : '' }),
          sub: UI.esc(memberMeta(entry)),
          actions:
            '<select class="select admin-space-role" data-pid="' + UI.esc(entry.space.id) + '"' +
            ' title="在「' + UI.esc(entry.space.name) + '」中的角色">' +
              ROLES.map((r) => '<option value="' + r + '"' +
                (r === entry.role ? ' selected' : '') + '>' + UI.esc(UI.roleLabel(r)) + '</option>').join('') +
            '</select>' +
            UI.iconBtn({
              icon: 'delete-bin-line', title: '移出空间', danger: true,
              cls: 'admin-space-remove', attrs: 'data-pid="' + UI.esc(entry.space.id) + '"',
            }),
        })).join('');
      return UI.card({
        title: '所属空间(' + list.length + ')', icon: 'folder-3-line', between: true,
        actions: UI.btn({ label: '加入空间', icon: 'add-line', kind: 'tonal', size: 'sm', cls: 'admin-add-space' }),
        body: rows || UI.emptyHtml({ icon: 'folder-line', title: '尚未加入任何协作空间', sm: true }),
      });
    }

    function wireSpaceCard(u, box, repaint) {
      const add = box.querySelector('.admin-add-space');
      if (add) add.addEventListener('click', async () => {
        const list = index && index[u.id] || [];
        const picked = await pickSpace({ excludeIds: list.map((x) => x.space.id) });
        if (!picked) return;
        try {
          await api(Endpoints.projectMembers(picked.space.id), {
            method: 'POST', body: { userId: u.id, role: picked.role },
          });
          UI.toast('已加入「' + picked.space.name + '」', 'success');
          invalidateIndex();
          await Promise.all([repaint(), ctx.refresh('users')]);
        } catch (err) { UI.err(err); }
      });
      box.querySelectorAll('.admin-space-role').forEach((sel) => {
        sel.addEventListener('change', async () => {
          try {
            await api(Endpoints.projectMember(sel.dataset.pid, u.id), {
              method: 'PATCH', body: { role: sel.value },
            });
            UI.toast('已更新角色', 'success');
            invalidateIndex();
            await Promise.all([repaint(), ctx.refresh('users')]);
          } catch (err) {
            UI.err(err);
            await repaint();
          }
        });
      });
      box.querySelectorAll('.admin-space-remove').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const entry = (index && index[u.id] || []).filter((x) => x.space.id === btn.dataset.pid)[0];
          const name = entry ? entry.space.name : '该空间';
          const ok = await UI.confirmAction(
            '将「' + (u.name || u.email) + '」移出「' + name + '」?其在该空间的成员权限立即失效。',
            { okText: '移出', okMsg: '已移出' },
            async () => {
              await api(Endpoints.projectMember(btn.dataset.pid, u.id), { method: 'DELETE' });
            });
          if (!ok) return;
          invalidateIndex();
          await Promise.all([repaint(), ctx.refresh('users')]);
        });
      });
    }

    async function paintSpaces(u, root, repaint) {
      const box = root.querySelector('#admin-user-spaces');
      if (!box) return;
      let list;
      try {
        const idx = await ensureIndex();
        list = idx[u.id] || [];
      } catch (e) {
        box.innerHTML = UI.card({ title: '所属空间', icon: 'folder-3-line',
          body: UI.errorBanner(e, { sm: true }) });
        return;
      }
      box.innerHTML = spacesCard(u, list);
      wireSpaceCard(u, box, repaint);
    }

    /** 登录限制:锁着就给"解除锁定"入口,没锁但有失败计数就说明还差几次被锁。 */
    function lockCard(d) {
      const lock = d.lock || {};
      const max = d.maxFails || 5;
      if (lock.lockedUntil) {
        return UI.card({
          title: '登录限制', icon: 'lock-line',
          body: '<div class="muted">该账号连续登录失败,已进入冷却(第 ' + (lock.strikes || 1) +
                ' 次触发)。冷却会自行过期,也可以立即解除。</div>',
          actions: UI.btn({ label: '解除锁定', kind: 'tonal', size: 'sm', id: 'acc-unlock' }),
        });
      }
      if (lock.failCount > 0) {
        return UI.card({
          title: '登录限制', icon: 'shield-keyhole-line',
          body: '<div class="muted">窗口内已失败 ' + lock.failCount + ' 次,再失败 ' +
                Math.max(0, max - lock.failCount) + ' 次将自动锁定(上限 ' + max + ' 次)。</div>',
        });
      }
      return UI.card({
        title: '登录限制', icon: 'shield-check-line',
        body: '<div class="muted">无限制:窗口内没有失败记录。</div>',
      });
    }

    function sessionsCard(d) {
      const list = d.sessions || [];
      const rows = list.map((s) => UI.listRow({
        icon: deviceIcon(s.deviceKind),
        title: UI.esc(s.device) +
          (s.online ? ' ' + UI.badge({ text: '在线', kind: 'success' }) : '') +
          (s.current ? ' ' + UI.badge({ text: '当前会话', cls: 'tint' }) : ''),
        // 登录时间与最近活跃都给:前者回答"这是谁什么时候登的",
        // 后者回答"它现在还在动吗"(会话有效期 7/30 天,只看创建时间会误判)
        sub: UI.esc([s.ip || '未知来源',
                     '登录 ' + UI.fmtDateShort(s.createdAt),
                     '最近活跃 ' + UI.fmtDateShort(s.lastSeenAt || s.createdAt)].join(' · ')),
        actions: UI.btn({ label: '强制下线', kind: 'danger-outline', size: 'sm',
                          cls: 'acc-kick', attrs: 'data-ref="' + UI.esc(s.ref) + '"' }),
      })).join('');
      return UI.card({
        title: '活跃会话(' + list.length + ')', icon: 'computer-line',
        body: rows || '<div class="muted">没有未过期的会话。</div>',
        actions: list.length
          ? UI.btn({ label: '全部下线', kind: 'danger-outline', size: 'sm', id: 'acc-kick-all' })
          : '',
      });
    }

    function eventsCard(d) {
      const list = d.events || [];
      const rows = list.map((e) => UI.listRow({
        icon: (RESULT_META[e.result] || {}).icon || 'question-line',
        title: resultBadge(e.result) + ' <span class="muted">' +
               UI.esc(UI.fmtDate(e.createdAt)) + '</span>',
        sub: UI.esc([e.ip || '未知来源', e.device || '未知设备'].join(' · ')),
      })).join('');
      return UI.card({
        title: '登录记录(最近 ' + list.length + ' 条)', icon: 'history-line',
        note: '含密码错误与触发锁定;冷却期内被拦下的请求不落记录(它们在"登录限制"里体现)',
        body: rows || '<div class="muted">暂无登录记录。</div>',
      });
    }

    function wireAccess(root, u, repaint) {
      const unlock = root.querySelector('#acc-unlock');
      if (unlock) unlock.addEventListener('click', async () => {
        try {
          await api(Endpoints.user(u.id), { method: 'PATCH', body: { unlock: true } });
          UI.toast('已解除登录锁定', 'success');
          // 抽屉自身重画 + 用户表/登录动态的状态徽标也要跟上
          await Promise.all([repaint(), ctx.refresh('users', 'security')]);
        } catch (e) { UI.err(e); }
      });
      root.querySelectorAll('.acc-kick').forEach((b) => b.addEventListener('click', async () => {
        try {
          await api(Endpoints.adminRevokeSession(b.dataset.ref), { method: 'DELETE' });
          UI.toast('该会话已下线', 'success');
          await Promise.all([repaint(), ctx.refresh('users', 'security')]);
        } catch (e) { UI.err(e); }
      }));
      const all = root.querySelector('#acc-kick-all');
      if (all) all.addEventListener('click', () => UI.confirmAction(
        '强制下线「' + (u.name || u.email) + '」的全部会话?该用户在所有设备上都需要重新登录。',
        { okText: '全部下线', okMsg: '已全部下线', danger: true },
        async () => {
          await api(Endpoints.adminRevokeUserSessions(u.id), { method: 'DELETE' });
          await Promise.all([repaint(), ctx.refresh('users', 'security')]);
        }));
    }

    async function userDrawer(u) {
      const m = UI.modal({
        title: '用户详情 · ' + (u.name || u.email),
        body: UI.loadingRow(),
        wide: true,
      });
      // 480px 右侧抽屉:复用 modal 的 Esc/遮罩/堆栈语义,只换几何;
      // 窄屏由 admin.css 拉成全屏(契约身份 1)。
      m.box.classList.add('admin-drawer-box');
      m.el.classList.add('admin-drawer-mask');

      const paint = async () => {
        let d;
        try { d = await api(Endpoints.adminAccess(u.id)); }
        catch (e) { m.body.innerHTML = UI.errorBanner(e); return; }
        m.body.innerHTML = identityCard(u, d) +
          '<div id="admin-user-spaces">' + UI.loadingRow('加载所属空间…') + '</div>' +
          lockCard(d) + sessionsCard(d) + eventsCard(d);
        wireAccess(m.body, u, paint);
        paintSpaces(u, m.body, paint);
      };
      await paint();
    }

    // ---------- 事件委托 ----------
    el.addEventListener('input', (e) => {
      if (e.target.closest('#admin-user-q')) {
        q = e.target.value;
        paintTable();
      }
    });

    el.addEventListener('change', (e) => {
      if (e.target.closest('#admin-user-check-all')) {
        const on = e.target.checked;
        const tableEl = el.querySelector('#admin-users-table');
        if (tableEl) tableEl.querySelectorAll('.data-table-row[data-uid]').forEach((row) => {
          setRowSelected(row, on);
        });
        updateBatchBar();
        return;
      }
      const cb = e.target.closest('.u-check');
      if (cb) {
        const row = cb.closest('.data-table-row[data-uid]');
        if (row) setRowSelected(row, cb.checked);
        updateBatchBar();
      }
    });

    el.addEventListener('click', async (e) => {
      if (e.target.closest('#btn-new-user')) { openNewUser(); return; }
      if (e.target.closest('#admin-user-cancel')) {
        selected.clear();
        paintTable();
        return;
      }
      if (e.target.closest('#admin-user-enable')) { await batchToggle(false); return; }
      if (e.target.closest('#admin-user-disable')) { await batchToggle(true); return; }

      const row = e.target.closest('.data-table-row[data-uid]');
      if (!row) return;
      const u = findUser(row.dataset.uid);
      if (!u) return;

      if (e.target.closest('.u-access')) {
        await userDrawer(u);
      } else if (e.target.closest('.u-edit')) {
        openEditUser(u);
      } else if (e.target.closest('.u-reset')) {
        await resetPassword(u);
      } else if (e.target.closest('.u-delete')) {
        await UI.confirmAction(
          '永久删除「' + u.email + '」?该账号从未产生任何文档、文件或项目,删除后不可恢复。',
          { okText: '删除', okMsg: '用户已删除' },
          async () => {
            await api(Endpoints.user(u.id), { method: 'DELETE' });
            invalidateIndex();
            await load();
          });
      } else if (e.target.closest('.u-toggle')) {
        await toggleUser(u);
      }
    });

    return { key: 'users', load };
  };
})();
