// views/home.js — 空间首页(#/ 与 #/p/{pid}/home)、最近、收藏
//   #/ 是"当前空间首页":空间从 localStorage 的记忆或个人空间解析,不跳路由;
//   一个空间都没有时同一页显示空间管理入口。最近/收藏只作用于当前空间。
window.Views = window.Views || {};

// ---------- 收藏(按用户 localStorage;方案未给收藏数据模型,前端本地闭环) ----------
window.Favorites = (function () {
  'use strict';
  const KEY = 'td:favs:';
  function storeKey() { return KEY + ((App.user && App.user.id) || 'anon'); }
  function read() {
    try { return JSON.parse(localStorage.getItem(storeKey()) || '[]') || []; }
    catch (e) { return []; }
  }
  function write(list) {
    try { localStorage.setItem(storeKey(), JSON.stringify(list.slice(0, 200))); } catch (e) { /* 配额满时放弃 */ }
  }
  function list() { return read(); }
  function has(id) { return read().some((x) => x.id === id); }
  function toggle(item) {
    const cur = read();
    const next = cur.some((x) => x.id === item.id)
      ? cur.filter((x) => x.id !== item.id)
      : [{ id: item.id, projectId: item.projectId, title: item.title || '文档', at: new Date().toISOString() }].concat(cur);
    write(next);
  }
  function remove(id) { write(read().filter((x) => x.id !== id)); }
  return { list: list, has: has, toggle: toggle, remove: remove };
})();

(function () {
  'use strict';

  const LAST_SPACE_KEY = 'td:last-space';

  function docHref(d) { return App.route.project(d.projectId, 'docs', d.id); }

  /** 文档行:标题可点,行尾收藏星(入口与取消是同一颗星) */
  function docRow(d, sub) {
    const star = Favorites.has(d.id);
    return '<div class="home-doc-row" data-id="' + UI.esc(d.id) + '">' +
      UI.icon('file-text-line', 'fi-doc home-doc-icon') +
      '<a class="home-doc-link" href="' + docHref(d) + '">' +
      '<span class="home-doc-title">' + UI.esc(d.title) + '</span>' +
      '<span class="home-doc-sub">' + sub + '</span></a>' +
      '<button type="button" class="btn-icon btn-sm act-fav" title="' + (star ? '取消收藏' : '收藏') + '"' +
      ' data-id="' + UI.esc(d.id) + '" data-project="' + UI.esc(d.projectId) + '"' +
      ' data-title="' + UI.esc(d.title) + '"><i class="ri-' + (star ? 'star-fill' : 'star-line') + '"></i></button>' +
      '</div>';
  }

  function wireFav(root, opts) {
    if (root._favWired) return;
    root._favWired = true;
    root.addEventListener('click', (e) => {
      const btn = e.target.closest('.act-fav');
      if (!btn) return;
      e.preventDefault();
      Favorites.toggle({ id: btn.dataset.id, projectId: btn.dataset.project, title: btn.dataset.title });
      const on = Favorites.has(btn.dataset.id);
      if (!on && opts && opts.remove) {
        btn.closest('.home-doc-row').remove();
        if (!root.querySelector('.home-doc-row')) {
          root.appendChild(UI.empty({ sm: true, icon: 'star-line', title: '还没有收藏' }));
        }
        UI.toast('已取消收藏', 'success');
        return;
      }
      btn.title = on ? '取消收藏' : '收藏';
      btn.innerHTML = UI.icon(on ? 'star-fill' : 'star-line');
      UI.toast(on ? '已收藏' : '已取消收藏', 'success');
    });
  }

  async function recentDocs(pid, limit) {
    const r = await api(Endpoints.search({ projectId: pid, type: 'docs', limit: limit || 12 })) || {};
    return r.docs || [];
  }

  function fmtSub(d) {
    return UI.esc(UI.fmtDate(d.updatedAt) + (d.projectName ? ' · ' + d.projectName : ''));
  }

  // ==================== 空间首页 ====================
  window.Views.homeLevel = function (r) {
    const explicitPid = r.pid || null;
    return {
      key: 'home' + (explicitPid ? '/' + explicitPid : ''),
      render(ctx) {
        const frag = Scope.html('<div class="home-page"><div id="home-body">' +
          '<div class="home-skel">' + UI.skeleton('lines', 4) + '</div></div></div>');
        const body = frag.querySelector('#home-body');
        load(body, ctx);
        return frag;
      },
    };

    async function load(body, ctx) {
      let pid = explicitPid;
      let proj = r.proj || null;
      if (!pid) {
        try {
          const spaces = await App.loadSpaces(true) || [];
          const remembered = UI.pref.get(LAST_SPACE_KEY, null);
          const hit = spaces.find((p) => p.id === remembered);
          const personal = spaces.find((p) => p.isPersonal);
          pid = (hit && hit.id) || (personal && personal.id) || (spaces[0] && spaces[0].id) || null;
          proj = spaces.find((p) => p.id === pid) || null;
        } catch (e) {
          if (!ctx.alive()) return;
          body.innerHTML = UI.error(e);
          return;
        }
      }
      if (!ctx.alive()) return;
      if (!pid) { renderNoSpace(body); return; }
      App.setSpace(pid, proj);
      if (!proj) {
        try { proj = await api(Endpoints.project(pid)); }
        catch (e) {
          if (!ctx.alive()) return;
          body.innerHTML = UI.error(e) +
            '<div class="form-inline mt-4">' +
            UI.btn({ id: 'home-manage', label: '管理空间', kind: 'tonal' }) + '</div>';
          const m = body.querySelector('#home-manage');
          if (m) m.onclick = () => { location.hash = '#/projects'; };
          return;
        }
        if (!ctx.alive()) return;
        App.setSpace(pid, proj);
      }
      renderHome(body, proj);
    }
  };

  function renderNoSpace(body) {
    body.innerHTML = '';
    body.appendChild(UI.empty({
      icon: 'folder-open-line',
      title: '还没有空间',
      desc: '创建一个空间开始协作,或从空间切换器发现并加入同事的空间',
      action: { label: '创建空间', onClick: () => { if (window.SpaceWizard) SpaceWizard.open(); } },
    }));
    const extra = document.createElement('div');
    extra.className = 'form-inline home-empty-extra';
    extra.innerHTML = UI.btn({ id: 'home-discover', label: '发现空间', kind: 'tonal' });
    body.appendChild(extra);
    extra.querySelector('#home-discover').onclick = () => {
      if (App.openSpaceSwitcher) App.openSpaceSwitcher('discover');
    };
  }

  function renderHome(body, proj) {
    const name = (App.user && (App.user.name || App.user.email)) || '';
    body.innerHTML =
      '<div class="home-hero">' +
      '<div><h1 class="page-title">你好,' + UI.esc(name) + '</h1>' +
      '<p class="home-sub">在「' + UI.esc(proj.name) + '」里继续工作</p></div>' +
      '<div class="home-actions">' +
      UI.btn({ id: 'home-new-doc', label: '新建文档', icon: 'add-line', kind: 'filled' }) +
      UI.btn({ id: 'home-upload', label: '上传文件', icon: 'upload-2-line', kind: 'tonal' }) +
      '<input type="file" id="home-file" multiple hidden>' +
      '</div></div>' +
      '<div class="home-grid">' +
      '<section class="home-section">' +
      UI.sectionTitle({ title: '最近更新', icon: 'time-line' }) +
      '<div id="home-recent" class="home-doc-list">' + UI.skeleton('rows', 4) + '</div>' +
      '</section>' +
      '<section class="home-section">' +
      UI.sectionTitle({ title: '收藏', icon: 'star-line' }) +
      '<div id="home-favs"></div>' +
      '</section>' +
      '</div>';

    body.querySelector('#home-new-doc').onclick = async () => {
      try {
        const d = await api(Endpoints.docsOf(proj.id), { method: 'POST', body: { title: '无标题文档' } });
        location.hash = App.route.project(proj.id, 'docs', d.id);
      } catch (e) { UI.err(e); }
    };
    const fileInput = body.querySelector('#home-file');
    body.querySelector('#home-upload').onclick = () => fileInput.click();
    fileInput.onchange = async () => {
      const files = Array.from(fileInput.files || []);
      if (!files.length) return;
      let ok = 0;
      for (const f of files) {
        try {
          try {
            await apiUpload(FilesAPI.upload({ projectId: proj.id, name: f.name }), f);
          } catch (err) {
            // 云空间默认撞名 409;快捷上传没有行内决策位,问一句再按 keep 重传
            if (!(err && err.code === 'name_exists')) throw err;
            const keep = await UI.confirmDialog(
              '「' + f.name + '」已存在同名文件。保留两个(新文件自动改名)吗?',
              { okText: '保留两个', danger: false });
            if (!keep) continue;
            await apiUpload(FilesAPI.upload({ projectId: proj.id, name: f.name, nameMode: 'keep' }), f);
          }
          ok++;
        } catch (e) { UI.err(e); }
      }
      if (ok) UI.toast('已上传 ' + ok + ' 个文件', 'success');
      fileInput.value = '';
    };

    const box = body.querySelector('#home-recent');
    wireFav(box);
    recentDocs(proj.id, 12).then((docs) => {
      box.innerHTML = docs.length
        ? docs.map((d) => docRow(d, fmtSub(d))).join('')
        : '';
      if (!docs.length) box.appendChild(UI.empty({
        icon: 'file-text-line', title: '还没有文档',
        action: { label: '新建文档', onClick: () => body.querySelector('#home-new-doc').click() },
      }));
    }).catch((e) => { box.innerHTML = UI.error(e); });

    const favBox = body.querySelector('#home-favs');
    const favs = Favorites.list().filter((f) => f.projectId === proj.id).slice(0, 6);
    favBox.innerHTML = favs.length ? favs.map((f) => docRow({
      id: f.id, projectId: f.projectId, title: f.title,
    }, '收藏于 ' + UI.fmtDate(f.at))).join('') : '';
    if (!favs.length) {
      favBox.appendChild(UI.empty({ sm: true, icon: 'star-line', title: '还没有收藏' }));
    }
    wireFav(favBox);
  }

  // ==================== 最近 ====================
  window.Views.recentLevel = function (r) {
    return {
      key: 'p/' + r.pid + '/recent',
      render(ctx) {
        let tab = 'edited';
        const frag = Scope.html(
          UI.pageHead({ title: '最近', sub: '当前空间里的编辑与浏览记录' }) +
          '<div id="recent-seg"></div>' +
          '<div id="recent-list">' + UI.skeleton('rows', 5) + '</div>');
        const segEl = frag.querySelector('#recent-seg');
        const box = frag.querySelector('#recent-list');

        function renderSeg() {
          segEl.innerHTML = UI.seg({
            active: tab, auto: true, role: 'tablist',
            items: [{ key: 'edited', label: '我编辑的', icon: 'edit-line' },
              { key: 'viewed', label: '我浏览的', icon: 'eye-line' }],
          });
        }
        renderSeg();
        UI.segWire(segEl, (key) => { tab = key; renderSeg(); load(); });

        async function load() {
          if (tab === 'viewed') {
            const seen = App.viewed(r.pid);
            box.innerHTML = seen.length
              ? seen.map((x) => docRow({ id: x.id, projectId: x.projectId, title: x.title },
                '浏览于 ' + UI.fmtWhen(x.at))).join('')
              : '';
            if (!seen.length) box.appendChild(UI.empty({ icon: 'eye-line', title: '还没有浏览记录', desc: '打开一篇文档后会记录在这里' }));
            wireFav(box);
            return;
          }
          box.innerHTML = UI.skeleton('rows', 5);
          try {
            const docs = await recentDocs(r.pid, 40);
            const mine = docs.filter((d) => d.updatedBy && App.user && d.updatedBy === App.user.id);
            // updatedBy 过滤在服务端可用时直接用;旧实例没有该字段时退回客户端过滤
            const list = mine.length || docs.some((d) => d.updatedBy) ? mine : docs;
            box.innerHTML = list.length
              ? list.map((d) => docRow(d, fmtSub(d))).join('')
              : '';
            if (!list.length) box.appendChild(UI.empty({ icon: 'edit-line', title: '还没有编辑记录' }));
            wireFav(box);
          } catch (e) { box.innerHTML = UI.error(e); }
        }
        load();
        return frag;
      },
    };
  };

  // ==================== 收藏 ====================
  window.Views.favoritesLevel = function (r) {
    return {
      key: 'p/' + r.pid + '/favorites',
      render(ctx) {
        const frag = Scope.html(
          UI.pageHead({ title: '收藏', sub: '保存在本机的文档收藏' }) +
          '<div id="fav-list"></div>');
        const box = frag.querySelector('#fav-list');
        const list = Favorites.list().filter((f) => f.projectId === r.pid);
        box.innerHTML = list.length
          ? list.map((f) => docRow({ id: f.id, projectId: f.projectId, title: f.title },
            '收藏于 ' + UI.fmtDate(f.at))).join('')
          : '';
        if (!list.length) {
          box.appendChild(UI.empty({
            icon: 'star-line', title: '还没有收藏',
            desc: '在文档树的「更多」菜单里收藏文档',
            action: { label: '去文档', onClick: () => { location.hash = App.route.project(r.pid, 'docs'); } },
          }));
        }
        wireFav(box, { remove: true });
        return frag;
      },
    };
  };
})();
