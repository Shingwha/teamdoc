// views/project.js — 空间作用域 + 空间内的成员/回收站/设置抽屉/云空间
//   Views.projectLevel          — 空间对象只在这里取一次;模块层由它挂出来
//   Views.membersLevel          — #/p/{id}/members:在空间首页上打开设置抽屉(成员页)
//   Views.trashLevel            — 回收站
//   Views.projectSettingsLevel  — #/p/{id}/settings:在空间首页上打开设置抽屉(概览)
//   Views.filesLevel            — 云空间(主体复用 views/drive.js 的 driveBody)
//   Views.homeLevel / recentLevel / favoritesLevel 在 views/home.js,文档模块在 views/docs.js
//
// 作用域契约见 ARCHITECTURE.md「渲染契约」:render 同步画骨架并返回 Fragment;
// 数据自己异步填;子层用 ctx.mount 交出挂载点;清理用 ctx.dispose 注册。
window.Views = window.Views || {};
(function () {
  'use strict';

  /**
   * 空间作用域。拿到空间对象后才把模块子层挂出来 —— 空间内切模块、切文档都不会
   * 再重取空间对象。打不开时(403/JOIN_REQUIRED/不存在)错误态由本层画,子层不存在:
   * 这份错误路径只有这一处,不必每个模块各写一遍。
   */
  window.Views.projectLevel = function (r) {
    const pid = r.pid;
    let proj = null;

    return {
      key: 'p/' + pid,
      render(ctx) {
        const cur = Route.current() || {};
        const shape = cur.tab === 'docs' ? Views.docsSkeleton() : UI.skeleton('rows', 6);
        const frag = Scope.html('<div id="proj-body">' + shape + '</div>');
        const body = frag.querySelector('#proj-body');
        load(body, ctx);
        return frag;
      },
      // 模块描述在挂载那一刻产出:proj 已经到手,而且读的是**当前**路由 ——
      // 切模块时本层被复用,只有这里会重新执行
      child() {
        const cur = Route.current();
        const nav = Route.navOf(cur.tab) || Route.navOf('home');
        return nav.level(Object.assign({}, cur, { proj: proj }));
      },
    };

    async function load(body, ctx) {
      try {
        proj = await api(Endpoints.project(pid));
      } catch (e) {
        console.error(e);
        const joinable = e.code === 'JOIN_REQUIRED';
        body.innerHTML =
          UI.banner({ kind: 'danger', text: joinable ? '你还不是这个空间的成员,加入后才能查看。'
            : '无法打开该空间:' + (e.message || '未知错误') }) +
          '<div class="form-inline mt-4">' +
          UI.btn({ id: 'proj-back', label: '返回首页', kind: 'tonal' }) +
          (joinable ? UI.btn({ id: 'proj-join', label: '加入空间', kind: 'filled' }) : '') +
          '</div>';
        const back = body.querySelector('#proj-back');
        if (back) back.onclick = () => { location.hash = '#/'; };
        const joinBtn = body.querySelector('#proj-join');
        if (joinBtn) joinBtn.onclick = () => ProjectsAPI.joinPrompt(pid);
        return;   // 不交槽位 = 没有子层
      }
      if (!ctx.alive()) return;
      App.setSpace(pid, proj);
      body.innerHTML = '';
      ctx.mount(body);
    }
  };

  // ==================== 成员 / 空间设置:同一张 480 drawer ====================
  function drawerTabOf(r) { return r.tab === 'members' ? 'members' : (r.tab === 'settings' ? 'overview' : 'overview'); }

  function spaceDrawerLevel(r) {
    const inner = Views.homeLevel(Object.assign({}, r, { proj: r.proj }));
    return {
      key: 'p/' + r.pid + '/space-drawer/' + drawerTabOf(r),
      render(ctx) {
        const frag = inner.render(ctx);
        // 抽屉挂在 body 上,与作用域节点无关;关掉时把地址还原到空间首页,
        // 避免"设置页只剩首页内容"的错位
        setTimeout(() => {
          SpaceSettings.open(r.proj, r.pid, drawerTabOf(r), {
            onClose: () => {
              const h = location.hash;
              if (h.indexOf('/members') >= 0 || h.indexOf('/settings') >= 0) {
                location.replace(App.route.project(r.pid, 'home'));
              }
            },
          });
        }, 0);
        return frag;
      },
      child() { return inner.child ? inner.child() : null; },
    };
  }

  window.Views.membersLevel = function (r) {
    // 个人空间没有成员页:直链落回文档
    if (r.proj && r.proj.isPersonal) {
      location.replace(App.route.project(r.pid, 'docs'));
      return { key: 'p/' + r.pid + '/members-empty', render() { return Scope.html(''); } };
    }
    return spaceDrawerLevel(r);
  };

  window.Views.projectSettingsLevel = function (r) {
    return spaceDrawerLevel(r);
  };

  // ==================== 回收站模块(#/p/{id}/trash) ====================
  // 三类回收项(文档 / 文件 / 文件夹)用 .seg 分段切换分类,避免长列表里翻找;
  // 三类数据一次取回后缓存在内存,切 tab 只重渲染、不重新请求
  window.Views.trashLevel = function (r) {
    const proj = r.proj;
    return {
      key: 'p/' + r.pid + '/trash',
      render(ctx) {
        const frag = Scope.html(
          UI.pageHead({ title: '回收站', sub: '<span id="trash-sub"></span>' }) +
          UI.card({
            body: '<div id="trash-seg"></div>' +
              '<div id="trash-list">' + UI.skeleton('rows', 4) + '</div>',
          }));

        const listEl = frag.querySelector('#trash-list');
        const segEl = frag.querySelector('#trash-seg');
        const subEl = frag.querySelector('#trash-sub');
        const canWrite = UI.canEdit(proj);

        const KIND_URL = { doc: Endpoints.doc, file: Endpoints.file, folder: Endpoints.folder };
        const KIND_ICON = { doc: 'file-text-line', file: 'file-line', folder: 'folder-line' };
        const CATS = [
          { key: 'docs', kind: 'doc', label: '文档', icon: 'file-text-line' },
          { key: 'files', kind: 'file', label: '文件', icon: 'file-line' },
          { key: 'folders', kind: 'folder', label: '文件夹', icon: 'folder-line' },
        ];

        let data = { docs: [], files: [], folders: [] };
        let cat = 'docs';

        function items(key) { return data[key] || []; }

        function renderSeg() {
          segEl.innerHTML = UI.seg({
            auto: true, role: 'tablist', active: cat,
            items: CATS.map((c) => ({
              key: c.key, label: c.label, icon: c.icon,
              count: items(c.key).length, disabled: !items(c.key).length,
            })),
          });
        }

        function rowHtml(item, kind) {
          const isDoc = kind === 'doc';
          const label = isDoc ? item.title : item.name;
          const meta = kind === 'file' && item.size != null ? UI.fmtSize(item.size) + ' · ' : '';
          return UI.listRow({
            attrs: 'data-kind="' + kind + '" data-id="' + UI.esc(item.id) + '"',
            icon: KIND_ICON[kind] || 'file-line',
            title: UI.esc(label),
            sub: meta + '删除于 ' + UI.esc(UI.fmtDate(item.deletedAt)),
            actions: canWrite
              ? UI.btn({ label: '恢复', kind: 'outline', size: 'sm', cls: 'tr-restore' }) +
                UI.iconBtn({ icon: 'delete-bin-line', title: '彻底删除', danger: true, size: 'sm', cls: 'tr-purge' })
              : '',
          });
        }

        function renderList() {
          const rows = items(cat);
          if (!rows.length) {
            listEl.innerHTML = '';
            const total = items('docs').length + items('files').length + items('folders').length;
            listEl.appendChild(total
              ? UI.empty({ icon: 'inbox-line', title: '该分类下没有内容' })
              : UI.empty({ icon: 'delete-bin-line', title: '回收站为空' }));
            return;
          }
          const kind = CATS.find((c) => c.key === cat).kind;
          listEl.innerHTML = rows.map((it) => rowHtml(it, kind)).join('');
        }

        async function load() {
          try {
            data = await api(Endpoints.projectTrash(proj.id)) || {};
            const total = items('docs').length + items('files').length + items('folders').length;
            if (!items(cat).length) {
              const first = CATS.find((c) => items(c.key).length);
              if (first) cat = first.key;
            }
            subEl.textContent = proj.name + ' · 共 ' + total + ' 项' +
              (total ? ' · 已删除的项可在此恢复;彻底删除不可恢复' : '');
            renderSeg();
            renderList();
          } catch (e) {
            listEl.innerHTML = UI.error(e);
          }
        }
        load();

        UI.segWire(segEl, (key) => {
          if (key === cat) return;
          cat = key;
          renderSeg();
          renderList();
        });

        listEl.addEventListener('click', async (e) => {
          const row = e.target.closest('.list-row');
          if (!row) return;
          const id = row.dataset.id, kind = row.dataset.kind;
          const url = (KIND_URL[kind] || Endpoints.file)(id);
          if (e.target.closest('.tr-restore')) {
            try {
              const res = await api(url + '/restore', { method: 'POST' });
              UI.toast('已恢复 ' + ((res && res.count) || 1) + ' 项', 'success');
              await load();
            } catch (err) { UI.err(err); }
            return;
          }
          if (e.target.closest('.tr-purge')) {
            const name = row.querySelector('.list-row-title').textContent;
            const tail = kind === 'doc' ? '将连同子文档与历史版本一起清除,'
              : kind === 'folder' ? '将连同其中的子文件夹与文件一起彻底清除(物理文件会被删除),'
                : '物理文件将被删除,';
            const ok = await UI.confirmDialog('彻底删除「' + name + '」?' + tail + '此操作不可恢复。');
            if (!ok) return;
            try {
              const res = await api(url + '/permanent', { method: 'DELETE' });
              UI.toast('已彻底删除 ' + ((res && res.count) || 1) + ' 项', 'success');
              await load();
            } catch (err) { UI.err(err); }
          }
        });
        return frag;
      },
    };
  };

  // ==================== 云空间模块(#/p/{id}/files;主体复用 drive.js) ====================
  window.Views.filesLevel = function (r) {
    return {
      key: 'p/' + r.pid + '/files' + (r.qs ? '?' + r.qs : ''),
      render(ctx) {
        return Views.driveBody({
          projectId: r.pid,
          proj: r.proj,
          folderId: r.query.get('folder') || null,
          highlight: r.query.get('highlight') || null,
          dispose: ctx.dispose,
        });
      },
    };
  };
})();

// ==================== 空间设置抽屉(480px) ====================
window.SpaceSettings = (function () {
  'use strict';

  const ROLE_LABEL = UI.roleLabel;
  const COLORS = ['#3370ff', '#7558f0', '#1d8a4e', '#b85a19', '#bf2f63', '#007888'];
  const QUOTAS = [
    { value: 0, label: '不限制' },
    { value: 1, label: '1 GB' },
    { value: 5, label: '5 GB' },
    { value: 10, label: '10 GB' },
    { value: 20, label: '20 GB' },
  ];
  const GB = 1024 * 1024 * 1024;
  // 角色强弱只用于"降级前确认":数字越小权限越低
  const ROLE_RANK = { VIEWER: 1, EDITOR: 2, ADMIN: 3, OWNER: 4 };
  // 四种角色用不同色的现有徽标档位区分(不再只有 OWNER 有颜色)
  const ROLE_BADGE_KIND = { OWNER: 'primary', ADMIN: 'warning', EDITOR: 'success', VIEWER: '' };

  function roleBadge(role) {
    return UI.badge({
      text: ROLE_LABEL(role),
      kind: ROLE_BADGE_KIND[role] || '',
      cls: 'ss-role-badge',
    });
  }

  /** 成员次行的最后活跃:有值给日期;显式 null = 从未登录;字段缺失 = 未知。 */
  function lastActiveText(value) {
    if (value) return '最后活跃 ' + UI.fmtDateShort(value);
    return value === null ? '从未活跃' : '最后活跃未知';
  }

  /**
   * 打开空间设置。proj 为 null 时先取空间对象。
   * @param {object|null} proj
   * @param {string} pid
   * @param {'overview'|'members'|'danger'} tab
   * @param {{onClose?:Function}} [opts]
   */
  async function open(proj, pid, tab, opts) {
    pid = UI.idOf(pid) || (proj && proj.id);
    if (!pid) return;
    if (!proj) {
      try { proj = await api(Endpoints.project(pid)); }
      catch (e) { UI.err(e); return; }
    }
    opts = opts || {};
    let cur = tab || 'overview';
    if (proj.isPersonal && cur === 'members') cur = 'overview';

    const body =
      '<div id="ss-tabs" class="ss-tabs"></div>' +
      '<div id="ss-body" class="ss-body"></div>';
    const d = UI.drawer({ title: (proj.name || '空间') + ' · 设置', body: body, cls: 'space-drawer', onClose: opts.onClose });
    const tabsEl = d.body.querySelector('#ss-tabs');
    const bodyEl = d.body.querySelector('#ss-body');

    function renderTabs() {
      const items = [{ key: 'overview', label: '概览' }, { key: 'members', label: '成员' },
        { key: 'danger', label: '危险区' }].filter((x) => !(proj.isPersonal && x.key === 'members'));
      tabsEl.innerHTML = UI.seg({ active: cur, auto: true, role: 'tablist', items: items });
    }
    renderTabs();
    UI.segWire(tabsEl, (key) => { cur = key; renderTabs(); renderBody(); });

    function renderBody() {
      if (cur === 'members') renderMembers();
      else if (cur === 'danger') renderDanger();
      else renderOverview();
    }

    // ---------- 概览 ----------
    function renderOverview() {
      const canAdmin = UI.canAdmin(proj);
      const dis = canAdmin ? '' : ' disabled';
      const used = Number(proj.storageBytes || 0);
      const quota = Number(proj.quotaBytes || 0);
      const pct = quota > 0 ? Math.min(100, Math.round(used / quota * 100)) : 0;
      const color = proj.color || COLORS[0];
      bodyEl.innerHTML =
        UI.card({
          body:
            '<div class="field"><label>空间名</label>' +
            '<input class="input" id="ss-name" maxlength="100" value="' + UI.esc(proj.name) + '"' + dis + '></div>' +
            '<div class="field"><label>描述</label>' +
            '<textarea class="textarea" id="ss-desc" rows="2"' + dis + '>' + UI.esc(proj.description || '') + '</textarea></div>' +
            '<div class="ss-color-row"><span class="small muted">空间颜色</span>' +
            COLORS.map((c) => '<button type="button" class="color-dot ss-color' + (c === color ? ' active' : '') +
              '" data-color="' + c + '" style="background:' + c + '" title="' + c + '"' + (canAdmin ? '' : ' disabled') + '></button>').join('') +
            '</div>' +
            (canAdmin ? '<div class="form-inline mt-4">' + UI.btn({ id: 'ss-save', label: '保存', kind: 'filled' }) + '</div>' : ''),
        }) +
        UI.card({
          title: '存储配额', icon: 'hard-drive-3-line',
          body:
            '<div class="ss-quota-line"><span>' + UI.fmtSize(used) + ' / ' +
            (quota > 0 ? UI.fmtSize(quota) : '不限制') + '</span>' +
            (quota > 0 ? '<span class="muted small">' + pct + '%</span>' : '') + '</div>' +
            '<div class="ss-quota-bar"><span style="width:' + pct + '%"></span></div>' +
            (canAdmin
              ? '<div class="field mt-3"><label>配额上限</label><select class="select" id="ss-quota">' +
                QUOTAS.map((q) => '<option value="' + q.value + '"' +
                  (Math.round(quota / GB) === q.value ? ' selected' : '') + '>' + q.label + '</option>').join('') +
                '</select></div>'
              : ''),
        }) +
        (proj.isPersonal ? '' : UI.card({
          title: '可见性', icon: proj.isPublic ? 'global-line' : 'lock-line',
          body: canAdmin
            ? '<label class="check-row"><input type="checkbox" id="ss-public"' + (proj.isPublic ? ' checked' : '') + '>' +
              '公开到「发现」广场(任何同事都能发现并自助加入)</label>' +
              '<div class="field mt-3"><label>自助加入后的角色</label>' +
              '<select class="select" id="ss-join-role">' +
              [['VIEWER', '只读成员'], ['EDITOR', '编辑者']].map((o) =>
                '<option value="' + o[0] + '"' + (proj.joinRole === o[0] ? ' selected' : '') + '>' + o[1] + '</option>').join('') +
              '</select></div>'
            : (proj.isPublic ? UI.badge({ text: '公开', kind: 'primary' }) : UI.badge({ text: '私有' })),
        }));

      const save = bodyEl.querySelector('#ss-save');
      if (save) save.onclick = async () => {
        const name = bodyEl.querySelector('#ss-name').value.trim();
        if (!name) { UI.toast('空间名不能为空', 'warning'); return; }
        save.disabled = true;
        try {
          const updated = await api(Endpoints.project(proj.id), {
            method: 'PATCH', body: { name, description: bodyEl.querySelector('#ss-desc').value },
          });
          Object.assign(proj, updated || { name, description: bodyEl.querySelector('#ss-desc').value });
          App.setSpace(proj.id, proj);
          App.loadSpaces(true).catch(() => {});
          UI.toast('已保存', 'success');
        } catch (e) { UI.err(e); }
        save.disabled = false;
      };
      bodyEl.querySelectorAll('.ss-color').forEach((b) => {
        b.onclick = async () => {
          try {
            const updated = await api(Endpoints.project(proj.id), { method: 'PATCH', body: { color: b.dataset.color } });
            proj.color = (updated && updated.color) || b.dataset.color;
            App.setSpace(proj.id, proj);
            bodyEl.querySelectorAll('.ss-color').forEach((x) => x.classList.toggle('active', x === b));
            UI.toast('已更新空间颜色', 'success');
          } catch (e) { UI.err(e); }
        };
      });
      const quotaSel = bodyEl.querySelector('#ss-quota');
      if (quotaSel) quotaSel.onchange = async () => {
        try {
          const bytes = Number(quotaSel.value) * GB;
          const updated = await api(Endpoints.project(proj.id), { method: 'PATCH', body: { quotaBytes: bytes } });
          proj.quotaBytes = (updated && updated.quotaBytes) || bytes;
          UI.toast('已更新配额', 'success');
        } catch (e) { UI.err(e); }
      };
      const pub = bodyEl.querySelector('#ss-public');
      if (pub) pub.onchange = async () => {
        const want = pub.checked;
        if (want) {
          const ok = await UI.confirmDialog(
            '公开后,任何登录用户都能在「发现」里看到本空间并自助加入。加入后按你设定的角色获得权限。确定公开?',
            { okText: '公开', danger: false });
          if (!ok) { pub.checked = false; return; }
        }
        try {
          const updated = await api(Endpoints.project(proj.id), { method: 'PATCH', body: { isPublic: want } });
          proj.isPublic = (updated && updated.isPublic) != null ? updated.isPublic : want;
          UI.toast(want ? '已公开到广场' : '已设为私有', 'success');
        } catch (e) { pub.checked = !want; UI.err(e); }
      };
      const joinRole = bodyEl.querySelector('#ss-join-role');
      if (joinRole) joinRole.onchange = async () => {
        try {
          const updated = await api(Endpoints.project(proj.id), { method: 'PATCH', body: { joinRole: joinRole.value } });
          proj.joinRole = (updated && updated.joinRole) || joinRole.value;
          UI.toast('已更新加入角色', 'success');
        } catch (e) { UI.err(e); }
      };
    }

    // ---------- 成员 ----------
    function renderMembers() {
      const canAdmin = UI.canAdmin(proj);
      const canOwn = UI.canOwn(proj);
      const ROLE_CHOICES = (canOwn ? ['OWNER'] : []).concat(['ADMIN', 'EDITOR', 'VIEWER']);
      let members = [];
      let filterRole = 'all';
      let query = '';
      const selected = new Set();

      bodyEl.innerHTML =
        '<div class="ss-member-head">' +
        '<input class="input" id="ss-mq" type="text" placeholder="搜索本空间成员" autocomplete="off">' +
        (canAdmin ? UI.btn({ id: 'ss-add', label: '添加成员', icon: 'user-add-line', kind: 'filled', size: 'sm' }) : '') +
        '</div>' +
        '<div id="ss-role-filter" class="chip-row"></div>' +
        '<div id="ss-batch" class="ss-batch" hidden></div>' +
        '<div id="ss-members">' + UI.skeleton('rows', 4) + '</div>' +
        // 权限说明常驻抽屉底部:列表再长也不用先滚到底才能查角色含义
        '<details class="ss-perms" style="position:sticky;bottom:0;z-index:1;' +
          'background:var(--md-surface-container-high)">' +
        '<summary>权限说明</summary>' +
        '<div class="ss-perm-grid">' +
        '<div><b>VIEWER</b><span>查看文档、下载文件</span></div>' +
        '<div><b>EDITOR</b><span>编辑文档、上传与移动文件、恢复回收站</span></div>' +
        '<div><b>ADMIN</b><span>管理成员、空间设置、删除内容</span></div>' +
        '<div><b>OWNER</b><span>转让所有权、归档与删除空间</span></div>' +
        '</div></details>';

      const listEl = bodyEl.querySelector('#ss-members');
      const filterEl = bodyEl.querySelector('#ss-role-filter');
      const batchEl = bodyEl.querySelector('#ss-batch');

      // ---------- 移出后果的量化(文档数 + 文件数) ----------
      // 文件数只能来自 projectStorage.active.fileCount;取不到时明写"数量未知",不猜。
      let impact = null;
      let impactPromise = null;
      function loadImpact() {
        if (impact) return Promise.resolve(impact);
        if (impactPromise) return impactPromise;
        const docs = Number.isFinite(Number(proj.docCount)) ? Number(proj.docCount) : null;
        impactPromise = api(Endpoints.projectStorage(proj.id)).then((s) => {
          const n = s && s.active ? Number(s.active.fileCount) : NaN;
          impact = { docs, files: Number.isFinite(n) ? n : null };
          return impact;
        }).catch(() => {
          impact = { docs, files: null };
          return impact;
        }).finally(() => { impactPromise = null; });
        return impactPromise;
      }
      function impactText(i) {
        return (i && i.docs != null ? i.docs + ' 篇文档' : '文档数量未知') + '、' +
          (i && i.files != null ? i.files + ' 个文件' : '文件数量未知');
      }

      function renderFilter() {
        const roles = ['all'].concat(canOwn ? ['OWNER'] : []).concat(['ADMIN', 'EDITOR', 'VIEWER']);
        filterEl.innerHTML = roles.map((r) =>
          '<button type="button" class="chip' + (r === filterRole ? ' selected' : '') + '" data-role="' + r + '">' +
          (r === 'all' ? '全部' : ROLE_LABEL(r)) + '</button>').join('');
      }
      renderFilter();
      filterEl.addEventListener('click', (e) => {
        const chip = e.target.closest('.chip');
        if (!chip) return;
        filterRole = chip.dataset.role;
        renderFilter();
        renderList();
      });
      bodyEl.querySelector('#ss-mq').addEventListener('input', (e) => {
        query = e.target.value.trim().toLowerCase();
        renderList();
      });

      function visible() {
        return members.filter((m) => {
          if (filterRole !== 'all' && m.role !== filterRole) return false;
          if (!query) return true;
          const u = m.user || {};
          return (u.name || '').toLowerCase().indexOf(query) >= 0 ||
            (u.email || '').toLowerCase().indexOf(query) >= 0;
        });
      }

      function renderList() {
        const rows = visible();
        if (!rows.length) {
          listEl.innerHTML = '';
          listEl.appendChild(UI.empty({ sm: true, icon: 'team-line', title: '没有匹配的成员' }));
          syncBatch();
          return;
        }
        listEl.innerHTML = rows.map((m) => {
          const u = m.user || {};
          const checked = selected.has(m.userId) ? ' checked' : '';
          const roleCell = canAdmin
            ? '<select class="select ss-role" data-uid="' + UI.esc(m.userId) + '">' +
              ROLE_CHOICES.map((rr) => '<option value="' + rr + '"' + (rr === m.role ? ' selected' : '') + '>' +
                ROLE_LABEL(rr) + '</option>').join('') + '</select>'
            : roleBadge(m.role);
          // 44px 定高(§6.7②):次行 = 邮箱 · 最后活跃,两行在 44px 内居中
          return '<div class="list-row ss-member" data-uid="' + UI.esc(m.userId) + '"' +
            ' style="height:44px;min-height:44px;padding-top:0;padding-bottom:0">' +
            (canAdmin ? '<input type="checkbox" class="sel-box ss-check" data-uid="' + UI.esc(m.userId) + '"' + checked + '>' : '') +
            UI.avatar({ name: u.name || u.email, seed: m.userId, color: u.avatarColor }) +
            '<div class="list-row-main"><div class="list-row-title">' + UI.esc(u.name || '-') +
            (u.isDisabled ? ' ' + UI.badge({ text: '已禁用', kind: 'danger' }) : '') + '</div>' +
            '<div class="list-row-sub">' + UI.esc([u.email || '未设置邮箱', lastActiveText(m.lastActiveAt)].join(' · ')) + '</div></div>' +
            '<div class="list-row-acts">' + roleCell +
            (canAdmin ? UI.iconBtn({ icon: 'user-unfollow-line', title: '移除成员', danger: true, cls: 'ss-remove' }) : '') +
            '</div></div>';
        }).join('');
        syncBatch();
      }

      function syncBatch() {
        if (!canAdmin) return;
        batchEl.hidden = selected.size === 0;
        if (!selected.size) return;
        batchEl.innerHTML = '<span class="batch-info">已选 ' + selected.size + ' 人</span>' +
          '<select class="select" id="ss-batch-role">' +
          ROLE_CHOICES.map((r) => '<option value="' + r + '">' + ROLE_LABEL(r) + '</option>').join('') +
          '</select>' + UI.btn({ id: 'ss-batch-apply', label: '批量改角色', kind: 'tonal', size: 'sm' }) +
          UI.btn({ id: 'ss-batch-remove', label: '批量移出', kind: 'danger-outline', size: 'sm' });
      }

      listEl.addEventListener('change', async (e) => {
        if (e.target.closest('.ss-check')) {
          const uid = e.target.dataset.uid;
          if (e.target.checked) selected.add(uid); else selected.delete(uid);
          syncBatch();
          return;
        }
        const sel = e.target.closest('.ss-role');
        if (!sel) return;
        const uid = sel.dataset.uid;
        const member = members.find((m) => m.userId === uid);
        const prevRole = member ? member.role : null;
        const nextRole = sel.value;
        // 降级是权限收缩,先确认;取消则把下拉恢复到原值(控件状态与数据保持一致)
        if (prevRole && nextRole !== prevRole &&
            (ROLE_RANK[nextRole] || 0) < (ROLE_RANK[prevRole] || 0)) {
          const name = (member.user && (member.user.name || member.user.email)) || '该成员';
          const ok = await UI.confirmDialog(
            '将「' + name + '」从 ' + ROLE_LABEL(prevRole) + ' 降级为 ' + ROLE_LABEL(nextRole) +
            '?对方会立即失去该角色独有的权限。确定降级?',
            { okText: '降级', danger: true });
          if (!ok) { sel.value = prevRole; return; }
        }
        try {
          await api(Endpoints.projectMember(proj.id, uid), { method: 'PATCH', body: { role: nextRole } });
          if (member) member.role = nextRole;
          UI.toast('已更新角色', 'success');
          renderFilter();
          renderList();
        } catch (err) { UI.err(err); renderList(); }
      });
      listEl.addEventListener('click', async (e) => {
        const btn = e.target.closest('.ss-remove');
        if (!btn) return;
        const uid = btn.closest('.ss-member').dataset.uid;
        const member = members.find((m) => m.userId === uid);
        const name = (member && member.user && (member.user.name || member.user.email)) || '该成员';
        const impact = await loadImpact();
        const ok = await UI.confirmDialog(
          '移除「' + name + '」后,对方将失去对本空间 ' + impactText(impact) + ' 的访问权。确定移除?',
          { okText: '移除' });
        if (!ok) return;
        try {
          await api(Endpoints.projectMember(proj.id, uid), { method: 'DELETE' });
          UI.toast('已移除', 'success');
          await loadMembers();
        } catch (err) { UI.err(err); }
      });

      batchEl.addEventListener('click', async (e) => {
        if (e.target.closest('#ss-batch-apply')) {
          const role = batchEl.querySelector('#ss-batch-role').value;
          const ids = Array.from(selected);
          // 批量降级与单行降级同口径:先确认权限收缩
          const downgrades = ids.filter((uid) => {
            const m = members.find((x) => x.userId === uid);
            return m && (ROLE_RANK[role] || 0) < (ROLE_RANK[m.role] || 0);
          });
          if (downgrades.length && !(await UI.confirmDialog(
            '将把 ' + downgrades.length + ' 名成员降级为 ' + ROLE_LABEL(role) +
            ';降级后其独有权限立即失效。确定继续?', { okText: '降级', danger: true }))) return;
          const res = await UI.eachOk(ids, (uid) =>
            api(Endpoints.projectMember(proj.id, uid), { method: 'PATCH', body: { role } }));
          UI.toast('已更新 ' + res.ok + ' 人' + (res.failed.length ? ',' + res.failed.length + ' 人失败' : ''),
            res.failed.length ? 'warning' : 'success');
          selected.clear();
          await loadMembers();
          return;
        }
        if (e.target.closest('#ss-batch-remove')) {
          const ids = Array.from(selected);
          const impact = await loadImpact();
          if (!(await UI.confirmDialog(
            '确定把选中的 ' + ids.length + ' 名成员移出本空间?他们将失去对本空间 ' +
            impactText(impact) + ' 的访问权。', { okText: '移出' }))) return;
          const res = await UI.eachOk(ids, (uid) =>
            api(Endpoints.projectMember(proj.id, uid), { method: 'DELETE' }));
          UI.toast('已移出 ' + res.ok + ' 人' + (res.failed.length ? ',' + res.failed.length + ' 人失败' : ''),
            res.failed.length ? 'warning' : 'success');
          selected.clear();
          await loadMembers();
        }
      });

      if (canAdmin) {
        bodyEl.querySelector('#ss-add').onclick = async () => {
          const picked = await UI.personPicker({
            title: '从同事目录选择', multi: true, excludeIds: members.map((m) => m.userId),
            roleSelect: { label: '加入角色', value: 'EDITOR',
              options: ROLE_CHOICES.map((r) => ({ value: r, label: ROLE_LABEL(r) })) },
            confirmLabel: '添加',
          });
          if (!picked || !picked.length) return;
          const res = await UI.eachOk(picked, (p) =>
            api(Endpoints.projectMembers(proj.id), { method: 'POST', body: { userId: p.id, role: p.role || 'EDITOR' } }));
          UI.toast('已添加 ' + res.ok + ' 人' + (res.failed.length ? ',' + res.failed.length + ' 人失败' : ''),
            res.failed.length ? 'warning' : 'success');
          await loadMembers();
        };
      }

      async function loadMembers() {
        try {
          members = await api(Endpoints.projectMembers(proj.id)) || [];
          renderList();
        } catch (e) { listEl.innerHTML = UI.error(e); }
      }
      loadMembers();
    }

    // ---------- 危险区 ----------
    function renderDanger() {
      const canOwn = UI.canOwn(proj);
      // 转让比归档/删除更严:服务端只接受真实所有者(全局管理员不能代转),故按 myRole 判
      const isOwner = proj.myRole === 'OWNER';
      const personal = proj.isPersonal;
      const archived = !!proj.archivedAt;
      bodyEl.innerHTML =
        (personal ? UI.banner({ kind: 'info', text: '这是个人空间:仅本人可见,不可转让、归档或删除。' }) : '') +
        (personal ? '' :
          (isOwner
            ? UI.card({
              danger: true, title: '转让所有权', icon: 'user-shared-line',
              note: '转让后你将降为管理员(ADMIN),原所有者成为 OWNER。',
              body: UI.btn({ id: 'ss-transfer', label: '转让所有权', kind: 'danger-outline' }),
            })
            : '') +
          (canOwn
            ? UI.card({
              danger: true, title: archived ? '解除归档' : '归档空间', icon: 'archive-line',
              note: '归档后空间会从空间列表隐藏,成员仍可读取,写操作被拒绝。',
              body: UI.btn({ id: 'ss-archive', label: archived ? '解除归档' : '归档空间', kind: 'tonal' }),
            }) +
            UI.card({
              danger: true, title: '删除空间', icon: 'delete-bin-line',
              note: '删除空间将同时删除其全部文档、文件物理版本与成员关系,且不可恢复。',
              body: UI.btn({ id: 'ss-delete', label: '删除空间', kind: 'danger-outline' }),
            })
            : UI.banner({ kind: 'info', text: '只有空间所有者可以归档或删除空间。' }))) +
        (proj.isMember && !personal
          ? UI.card({
            danger: true, title: '退出空间', icon: 'logout-box-r-line',
            note: '退出后你将无法再访问本空间的文档与云空间。',
            body: UI.btn({ id: 'ss-leave', label: '退出空间', kind: 'danger-outline' }),
          })
          : '');

      // 转让接手人只能来自本空间(服务端要求目标已是成员、未禁用且非 OWNER);
      // 用目录选人器会让人选到空间外的同事,提交必然 403/409。
      async function pickTransferTarget() {
        let members = [];
        try { members = (await api(Endpoints.projectMembers(proj.id))) || []; }
        catch (e) { UI.err(e); return null; }
        const candidates = members.filter((m) => m.role !== 'OWNER' && m.user && !m.user.isDisabled &&
          (!App.user || m.userId !== App.user.id));
        if (!candidates.length) {
          UI.toast('没有可接手的成员:转让目标必须是空间内已加入且未禁用的非所有者', 'warning');
          return null;
        }
        const m = UI.modal({
          title: '选择新的所有者',
          body: '<div class="help mb-3">只能转让给本空间的现有成员;转让后原所有者降为管理员。</div>' +
            '<div id="ss-transfer-list" class="pp-list">' + candidates.map((x) =>
              '<div class="pp-item" data-uid="' + UI.esc(x.userId) + '">' +
                UI.avatar({ name: x.user.name || x.user.email, seed: x.userId, size: 'lg',
                            color: x.user.avatarColor }) +
                '<span class="pp-main"><span class="pp-name">' +
                  UI.esc(x.user.name || x.user.email) + '</span>' +
                '<span class="pp-mail">' + UI.esc((x.user.email || '') + ' · ' + ROLE_LABEL(x.role)) +
                '</span></span><i class="ri-checkbox-blank-circle-line"></i>' +
              '</div>').join('') + '</div>',
          actions: [
            { label: '取消', kind: 'text', value: null },
            { label: '转让', kind: 'filled', value: '__ok__' },
          ],
        });
        let picked = null;
        const listEl = m.body.querySelector('#ss-transfer-list');
        listEl.addEventListener('click', (e) => {
          const row = e.target.closest('.pp-item');
          if (!row) return;
          picked = candidates.filter((x) => x.userId === row.dataset.uid)[0] || null;
          listEl.querySelectorAll('.pp-item').forEach((r) => {
            const on = picked && r.dataset.uid === picked.userId;
            r.classList.toggle('selected', !!on);
            const ic = r.querySelector('i');
            if (ic) ic.className = on ? 'ri-checkbox-circle-fill' : 'ri-checkbox-blank-circle-line';
          });
        });
        return m.result.then((v) => (v === '__ok__' && picked ? picked.user : null));
      }

      const transfer = bodyEl.querySelector('#ss-transfer');
      if (transfer) transfer.onclick = async () => {
        const picked = await pickTransferTarget();
        if (!picked) return;
        if (!(await UI.confirmDialog('确定把空间转让给「' + (picked.name || picked.email) + '」?你将降为管理员。', { okText: '转让' }))) return;
        try {
          await api(Endpoints.projectTransfer(proj.id), { method: 'POST', body: { userId: picked.id } });
          UI.toast('已转让所有权', 'success');
          d.close(true);
          App.refresh();
        } catch (e) { UI.err(e); }
      };
      const archive = bodyEl.querySelector('#ss-archive');
      if (archive) archive.onclick = async () => {
        const want = !archived;
        if (!(await UI.confirmDialog(want ? '归档后空间会从列表隐藏,写操作被拒绝。确定归档?'
          : '解除归档后空间恢复可见与可写。确定解除?', { okText: want ? '归档' : '解除归档' }))) return;
        try {
          await api(Endpoints.project(proj.id), { method: 'PATCH', body: { archived: want } });
          UI.toast(want ? '已归档' : '已解除归档', 'success');
          d.close(true);
          App.loadSpaces(true).catch(() => {});
          if (want) location.hash = '#/';
          else App.refresh();
        } catch (e) { UI.err(e); }
      };
      const del = bodyEl.querySelector('#ss-delete');
      if (del) del.onclick = async () => {
        const name = await UI.inputDialog({
          title: '删除空间', label: '输入空间名「' + proj.name + '」以确认',
          okText: '删除',
        });
        if (name !== proj.name) { if (name != null) UI.toast('空间名不一致,未删除', 'warning'); return; }
        try {
          await api(Endpoints.project(proj.id), { method: 'DELETE' });
          UI.toast('空间已删除', 'success');
          d.close(true);
          App.loadSpaces(true).catch(() => {});
          location.hash = '#/';
        } catch (e) { UI.err(e); }
      };
      const leave = bodyEl.querySelector('#ss-leave');
      if (leave) leave.onclick = async () => {
        const ownerHint = proj.myRole === 'OWNER'
          ? '你是空间所有者:若你是唯一所有者,需先转让所有权才能退出。' : '';
        if (!(await UI.confirmDialog('退出「' + proj.name + '」后,你将不再能访问它的文档与云空间。' +
          ownerHint + '确定退出?', { okText: '退出' }))) return;
        try {
          await api(Endpoints.projectLeave(proj.id), { method: 'POST' });
          UI.toast('已退出「' + proj.name + '」', 'success');
          d.close(true);
          App.loadSpaces(true).catch(() => {});
          location.hash = '#/';
        } catch (e) { UI.err(e); }
      };
    }

    renderBody();
  }

  return { open: open };
})();

// ==================== 创建空间向导(统一选人器) ====================
window.SpaceWizard = (function () {
  'use strict';

  function open() {
    let members = [];
    const m = UI.modal({
      title: '创建空间',
      body:
        '<div class="field"><label>空间名</label>' +
        '<input class="input" id="sw-name" maxlength="100" placeholder="例如:产品设计"></div>' +
        '<div class="field"><label>描述(可选)</label>' +
        '<input class="input" id="sw-desc" maxlength="500" placeholder="这个空间用来做什么"></div>' +
        '<div class="field"><label>邀请成员(可选)</label>' +
        '<div id="sw-members" class="chip-row"></div>' +
        UI.btn({ id: 'sw-pick', label: '选择成员', icon: 'user-add-line', kind: 'tonal', size: 'sm' }) + '</div>',
      actions: [
        { label: '取消', kind: 'text', value: null },
        {
          label: '创建空间', kind: 'filled',
          onClick: async (ctx) => {
            const name = ctx.body.querySelector('#sw-name').value.trim();
            if (!name) { UI.toast('空间名不能为空', 'warning'); return; }
            ctx.btn.disabled = true;
            try {
              const p = await api(Endpoints.projects(), {
                method: 'POST',
                body: {
                  name,
                  description: ctx.body.querySelector('#sw-desc').value.trim(),
                  members: members.map((x) => ({ userId: x.id, role: x.role || 'EDITOR' })),
                },
              });
              ctx.close(true);
              App.spaces = null;
              App.loadSpaces(true).catch(() => {});
              UI.toast('空间已创建', 'success');
              location.hash = App.route.project(p.id, 'home');
            } catch (e) {
              ctx.btn.disabled = false;
              UI.err(e);
            }
          },
        },
      ],
    });

    const box = m.body.querySelector('#sw-members');
    function renderMembers() {
      box.innerHTML = members.map((x) =>
        '<span class="chip selected" data-uid="' + UI.esc(x.id) + '">' +
        UI.esc(x.name || x.email) + UI.icon('close-line') + '</span>').join('');
    }
    box.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      members = members.filter((x) => x.id !== chip.dataset.uid);
      renderMembers();
    });
    m.body.querySelector('#sw-pick').onclick = async () => {
      const picked = await UI.personPicker({
        title: '邀请同事加入空间', multi: true, excludeIds: members.map((x) => x.id),
        roleSelect: { label: '加入角色', value: 'EDITOR',
          options: [{ value: 'EDITOR', label: '编辑者' }, { value: 'VIEWER', label: '只读成员' }] },
        confirmLabel: '邀请',
      });
      if (!picked || !picked.length) return;
      members = members.concat(picked);
      renderMembers();
    };
    m.body.querySelector('#sw-name').focus();
    return m;
  }

  return { open: open };
})();
