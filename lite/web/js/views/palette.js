// views/palette.js — Ctrl+K 命令面板:动作 + 文档/文件结果 + 管理员捷径
//   顶部输入、中部候选、键盘上下/回车/Esc;空输入显示最近文档。搜索只有这一处入口
//   (原 #/search 整页已并入面板),发现空间在空间切换器的页签里。
window.Palette = (function () {
  'use strict';

  let mask = null;
  let input = null;
  let listEl = null;
  let rows = [];       // 当前扁平候选(键盘导航按它移动)
  let active = 0;
  let seq = 0;         // 异步查询序号:只渲染最后一次
  let adminUsers = null;

  function currentPid() { return App.currentSpaceId(); }

  function close() {
    if (!mask) return;
    mask.remove();
    mask = null;
    input = null;
    listEl = null;
    rows = [];
  }

  function open() {
    if (mask) { input.focus(); input.select(); return; }
    mask = document.createElement('div');
    mask.className = 'cmd-mask';
    mask.innerHTML =
      '<div class="cmd-panel" role="dialog" aria-label="命令面板">' +
      '<div class="cmd-input-row">' + UI.icon('search-line') +
      '<input id="cmd-q" class="cmd-input" type="text" placeholder="搜索文档、文件,或输入命令" autocomplete="off">' +
      '<kbd>Esc</kbd></div>' +
      '<div id="cmd-list" class="cmd-list"></div>' +
      '<div class="cmd-foot"><span>↑↓ 选择</span><span>Enter 打开</span><span>Esc 关闭</span></div>' +
      '</div>';
    document.body.appendChild(mask);
    input = mask.querySelector('#cmd-q');
    listEl = mask.querySelector('#cmd-list');
    mask.addEventListener('pointerdown', (e) => { if (e.target === mask) close(); });
    input.addEventListener('input', () => query(input.value.trim()));
    input.addEventListener('keydown', onKey);
    input.focus();
    query('');
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); return; }
    if (e.key === 'Enter') { e.preventDefault(); run(active); }
  }

  function move(d) {
    if (!rows.length) return;
    active = (active + d + rows.length) % rows.length;
    paintActive();
  }

  function paintActive() {
    const btns = listEl.querySelectorAll('.cmd-row');
    btns.forEach((b, i) => b.classList.toggle('active', i === active));
    const cur = btns[active];
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }

  function run(i) {
    const row = rows[i];
    if (!row) return;
    close();
    try { row.run(); } catch (e) { UI.err(e); }
  }

  function actionRows(q) {
    const pid = currentPid();
    const out = [];
    const has = (text) => !q || text.toLowerCase().indexOf(q.toLowerCase()) >= 0;
    if (pid) {
      if (has('新建文档')) out.push({ group: '动作', icon: 'add-line', label: '新建文档', run: async () => {
        try {
          const d = await api(Endpoints.docsOf(pid), { method: 'POST', body: { title: '无标题文档' } });
          location.hash = App.route.project(pid, 'docs', d.id);
        } catch (e) { UI.err(e); }
      } });
      if (has('上传文件')) out.push({ group: '动作', icon: 'upload-2-line', label: '上传文件', run: () => {
        location.hash = App.route.project(pid, 'files');
      } });
      if (has('空间设置')) out.push({ group: '动作', icon: 'settings-4-line', label: '空间设置', run: () => {
        if (window.SpaceSettings) SpaceSettings.open(App.space, pid, 'overview');
      } });
    }
    if (has('个人设置')) out.push({ group: '动作', icon: 'settings-3-line', label: '个人设置', run: () => {
      location.hash = App.route.settings('account');
    } });
    if (has('管理空间')) out.push({ group: '动作', icon: 'layout-grid-line', label: '管理空间', run: () => {
      location.hash = '#/projects';
    } });
    if (App.user && App.user.isAdmin) {
      if (has('管理后台')) out.push({ group: '管理', icon: 'shield-user-line', label: '管理后台', run: () => {
        location.hash = App.route.admin('overview');
      } });
      if (q) {
        (adminUsers || []).forEach((u) => {
          const hit = (u.name || '').indexOf(q) >= 0 || (u.email || '').toLowerCase().indexOf(q.toLowerCase()) >= 0;
          if (!hit) return;
          out.push({ group: '管理', icon: 'user-settings-line', label: '用户 · ' + (u.name || u.email),
            run: () => { location.hash = '#/admin/users?q=' + encodeURIComponent(u.name || u.email); } });
        });
        (App.spaces || []).forEach((p) => {
          if (p.name.indexOf(q) < 0) return;
          out.push({ group: '管理', icon: 'team-line', label: '空间成员 · ' + p.name,
            run: () => { location.hash = App.route.project(p.id, 'members'); } });
        });
      }
    }
    return out;
  }

  function matches(q, text) { return (text || '').toLowerCase().indexOf(q.toLowerCase()) >= 0; }

  async function query(q) {
    const mySeq = ++seq;
    active = 0;
    const actions = actionRows(q);
    render(actions, [], [], q, null, true);

    const pid = currentPid();
    try {
      const params = { limit: 8 };
      if (q) params.q = q;
      if (pid) params.projectId = pid;
      const res = await api(Endpoints.search(q ? Object.assign({}, params, { type: 'all' }) : params)) || {};
      if (mySeq !== seq || !mask) return;
      let docs = res.docs || [];
      let files = res.files || [];
      if (q) {
        docs = docs.filter((d) => matches(q, d.title));
        files = files.filter((f) => matches(q, f.name));
      }
      render(actions, docs, files, q, res, false);
    } catch (e) {
      if (mySeq !== seq || !mask) return;
      render(actions, [], [], q, e, false);
    }
  }

  function render(actions, docs, files, q, res, pending) {
    rows = [];
    let html = '';
    let lastGroup = '';
    function group(name) {
      if (name === lastGroup) return;
      lastGroup = name;
      html += '<div class="cmd-group">' + UI.esc(name) + '</div>';
    }
    function row(r) {
      const i = rows.length;
      rows.push(r);
      html += '<button type="button" class="cmd-row' + (i === active ? ' active' : '') + '" data-i="' + i + '">' +
        UI.icon(r.icon || 'arrow-right-line', 'cmd-row-icon') +
        '<span class="cmd-row-main"><span class="cmd-row-label">' + UI.esc(r.label) + '</span>' +
        (r.sub ? '<span class="cmd-row-sub">' + r.sub + '</span>' : '') + '</span>' +
        (r.kind ? UI.badge({ text: r.kind, cls: 'xs' }) : '') + '</button>';
    }

    const filteredActions = actions;
    filteredActions.forEach((a) => { group(a.group); row(a); });

    if (docs.length) {
      group('文档');
      docs.forEach((d) => row({
        icon: 'file-text-line', kind: '文档', label: d.title,
        sub: UI.esc(d.projectName ? d.projectName + ' · ' + UI.fmtDate(d.updatedAt) : UI.fmtDate(d.updatedAt)),
        run: () => { location.hash = App.route.project(d.projectId, 'docs', d.id); },
      }));
    }
    if (files.length) {
      group('文件');
      files.forEach((f) => row({
        icon: UI.fileIcon(f.mime).icon, kind: '文件', label: f.name,
        sub: UI.esc((f.projectName || '') + ' · ' + UI.fmtSize(f.size)),
        run: () => {
          location.hash = App.route.project(f.projectId, 'files', null,
            f.folderId ? { folder: f.folderId } : null);
        },
      }));
    }

    if (!rows.length) {
      html = pending ? UI.skeleton('rows', 3)
        : UI.empty({ sm: true, icon: 'search-line', title: q ? '没有匹配结果' : '输入关键词开始搜索' }).outerHTML;
    } else if (res instanceof Error) {
      html += UI.error(res);
    }
    listEl.innerHTML = html;
    if (rows.length) {
      active = Math.min(active, rows.length - 1);
      paintActive();
    }
  }

  // 面板内点击选中
  document.addEventListener('click', (e) => {
    if (!mask) return;
    const btn = e.target && e.target.closest ? e.target.closest('.cmd-row') : null;
    if (!btn) return;
    run(Number(btn.dataset.i));
  });

  function openWithAdminData() {
    open();
    if (App.user && App.user.isAdmin && !adminUsers) {
      api(Endpoints.users()).then((list) => {
        adminUsers = (list || []).map((u) => u.user || u);
        if (mask && input) query(input.value.trim());
      }).catch(() => { adminUsers = []; });
    }
    App.loadSpaces().catch(() => {});
  }

  return { open: openWithAdminData, close: close };
})();
