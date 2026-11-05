// views/settings.js — 个人设置(#/settings/{account|security|preferences})
//   左侧子导航 + 右侧内容;账号资料分段自动保存,安全页管 PAT 与自己的会话,
//   偏好页管主题/密度/编辑器字号/语言。账号改动后同步 App.user 与壳。
window.Views = window.Views || {};
(function () {
  'use strict';

  const TABS = [
    { key: 'account', label: '账号', icon: 'user-3-line' },
    { key: 'security', label: '安全', icon: 'shield-check-line' },
    { key: 'preferences', label: '偏好', icon: 'equalizer-line' },
  ];

  function tabOf(r) {
    const t = r && r.settingsTab;
    return TABS.some((x) => x.key === t) ? t : 'account';
  }

  window.Views.settingsLevel = function (r) {
    const tab = tabOf(r);
    return {
      key: 'settings/' + tab,
      render(ctx) {
        const frag = Scope.html(
          '<div class="settings-page">' +
          '<nav class="settings-nav">' + TABS.map((t) =>
            '<a class="side-item' + (t.key === tab ? ' active' : '') + '" href="' + App.route.settings(t.key) + '">' +
            UI.icon(t.icon) + '<span class="side-label">' + t.label + '</span></a>').join('') +
          '</nav>' +
          '<div class="settings-body" id="settings-body"></div>' +
          '</div>');
        const body = frag.querySelector('#settings-body');
        if (tab === 'account') renderAccount(body);
        else if (tab === 'security') renderSecurity(body);
        else renderPreferences(body);
        return frag;
      },
    };
  };

  // ---------- 账号 ----------
  function renderAccount(body) {
    const u = App.user || {};
    body.innerHTML =
      '<h1 class="page-title">账号</h1>' +
      UI.card({
        title: '资料', icon: 'user-3-line',
        note: '修改后自动保存',
        body:
          '<div class="field"><label>姓名</label>' +
          '<input class="input" id="st-name" maxlength="50" value="' + UI.esc(u.name || '') + '"></div>' +
          '<div class="field"><label>邮箱</label>' +
          '<input class="input" id="st-email" type="text" autocomplete="username" value="' + UI.esc(u.email || '') + '"></div>' +
          '<div class="field"><label>头像色</label><div id="st-colors" class="color-dots"></div></div>' +
          '<div class="field"><label>ID</label>' +
          UI.idText({ value: u.id, copy: true, full: true, cls: 'block' }) + '</div>',
      }) +
      UI.card({
        title: '修改密码', icon: 'lock-2-line',
        body:
          '<form id="pwd-form" class="form">' +
          '<div class="field"><label>原密码</label>' +
          '<input type="password" class="input" name="oldPassword" required autocomplete="current-password"></div>' +
          '<div class="field"><label>新密码(至少 8 位)</label>' +
          '<input type="password" class="input" name="newPassword" required minlength="8" autocomplete="new-password"></div>' +
          '<div class="field"><label>确认新密码</label>' +
          '<input type="password" class="input" name="confirmPassword" required minlength="8" autocomplete="new-password"></div>' +
          '<div>' + UI.btn({ label: '保存密码', kind: 'filled', type: 'submit' }) + '</div>' +
          '</form>',
      });

    const nameEl = body.querySelector('#st-name');
    const emailEl = body.querySelector('#st-email');
    const save = UI.debounce(async () => {
      const payload = { name: nameEl.value.trim(), email: emailEl.value.trim() };
      if (!payload.name || !payload.email) return;
      if (payload.name === App.user.name && payload.email === App.user.email) return;
      try {
        const res = await api(Endpoints.me(), { method: 'PATCH', body: payload });
        if (res && res.user) Object.assign(App.user, res.user);
        else Object.assign(App.user, payload);
        App.syncUser();
        UI.toast('资料已保存', 'success');
      } catch (e) { UI.err(e); }
    }, 600);
    nameEl.addEventListener('input', save);
    emailEl.addEventListener('input', save);
    nameEl.addEventListener('blur', save.flush);
    emailEl.addEventListener('blur', save.flush);

    // 头像色:点一下即保存(与主题种子色同一套交互,但这是账号资料,存服务端)
    const AVATAR_COLORS = ['#3370ff', '#7c3aed', '#db2777', '#ea580c',
      '#16a34a', '#0891b2', '#ca8a04', '#1f6feb'];
    const colorsEl = body.querySelector('#st-colors');
    AVATAR_COLORS.forEach((c) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'color-dot' + (u.avatarColor === c ? ' active' : '');
      b.style.background = c;
      b.title = c;
      b.onclick = async () => {
        try {
          const res = await api(Endpoints.me(), { method: 'PATCH', body: { avatarColor: c } });
          if (res && res.user) Object.assign(App.user, res.user);
          App.syncUser();
          colorsEl.querySelectorAll('.color-dot').forEach((x) => x.classList.toggle('active', x === b));
          UI.toast('头像色已保存', 'success');
        } catch (e) { UI.err(e); }
      };
      colorsEl.appendChild(b);
    });

    body.querySelector('#pwd-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const newPassword = String(fd.get('newPassword') || '');
      if (newPassword !== String(fd.get('confirmPassword') || '')) {
        UI.toast('两次输入的新密码不一致', 'warning');
        return;
      }
      try {
        const res = await api(Endpoints.myPassword(), {
          method: 'POST',
          body: { oldPassword: String(fd.get('oldPassword') || ''), newPassword },
        });
        const n = (res && res.revokedSessions) || 0;
        UI.toast(n ? '密码已修改,' + n + ' 个其它会话已失效' : '密码已修改', 'success');
        e.target.reset();
      } catch (err) { UI.err(err); }
    });
  }

  // ---------- 安全(PAT + 会话) ----------
  function renderSecurity(body) {
    body.innerHTML =
      '<h1 class="page-title">安全</h1>' +
      UI.card({
        title: '登录会话', icon: 'computer-line',
        actions: UI.btn({ id: 'st-kick-all', label: '退出其他所有会话', kind: 'danger-outline', size: 'sm' }),
        body: '<div id="st-sessions">' + UI.skeleton('rows', 3) + '</div>',
      }) +
      UI.card({
        title: '访问令牌', icon: 'key-line', between: true,
        actions: UI.btn({ id: 'pat-new', label: '新建令牌', icon: 'add-line', kind: 'filled', size: 'sm' }),
        body: '<div id="pat-list">' + UI.skeleton('rows', 3) + '</div>',
      });

    loadSessions(body.querySelector('#st-sessions'));
    body.querySelector('#st-kick-all').onclick = async () => {
      if (!(await UI.confirmDialog('除当前设备外,其它所有会话将立即失效。确定继续?', { okText: '全部退出' }))) return;
      try {
        const res = await api(Endpoints.mySessions(), { method: 'DELETE' });
        UI.toast('已退出 ' + ((res && res.revoked) || 0) + ' 个会话', 'success');
        loadSessions(body.querySelector('#st-sessions'));
      } catch (e) { UI.err(e); }
    };
    loadPats(body);
  }

  async function loadSessions(box) {
    try {
      const list = await api(Endpoints.mySessions()) || [];
      if (!list.length) {
        box.innerHTML = '';
        box.appendChild(UI.empty({ sm: true, icon: 'computer-line', title: '没有会话记录' }));
        return;
      }
      box.innerHTML = list.map((s) => UI.listRow({
        attrs: 'data-ref="' + UI.esc(s.ref) + '"',
        icon: s.deviceKind === 'mobile' ? 'smartphone-line' : 'computer-line',
        title: UI.esc(s.device || '未知设备') +
          (s.current ? ' ' + UI.badge({ text: '当前设备', kind: 'primary', cls: 'xs' }) : '') +
          (s.online ? ' ' + UI.badge({ text: '在线', kind: 'success', cls: 'xs' }) : ''),
        sub: UI.esc((s.ip || '') + (s.lastSeenAt ? ' · 最近 ' + UI.fmtWhen(s.lastSeenAt) : '')),
        actions: s.current ? '' :
          UI.btn({ label: '退出', kind: 'text', size: 'sm', cls: 'st-kick' }),
      })).join('');
      box.onclick = async (e) => {
        const btn = e.target.closest('.st-kick');
        if (!btn) return;
        const ref = btn.closest('.list-row').dataset.ref;
        if (!(await UI.confirmDialog('该设备的会话将立即失效,需要重新登录。确定退出?', { okText: '退出' }))) return;
        try {
          await api(Endpoints.mySession(ref), { method: 'DELETE' });
          UI.toast('已退出该会话', 'success');
          loadSessions(box);
        } catch (err) { UI.err(err); }
      };
    } catch (e) {
      box.innerHTML = UI.error(e);
    }
  }

  function loadPats(body) {
    const patList = body.querySelector('#pat-list');
    function load() {
      return UI.loadInto(patList, () => api(Endpoints.pats()), {
        empty: (list) => !(list || []).filter((p) => !p.revokedAt).length,
        emptyNode: () => UI.empty({ sm: true, icon: 'key-line', title: '暂无令牌' }),
        errorOpts: { sm: true },
        render: (list) => (list || []).filter((p) => !p.revokedAt).map((p) =>
          UI.listRow({
            attrs: 'data-pid="' + UI.esc(p.id) + '"',
            title: UI.esc(p.name),
            badges: UI.badge({ text: p.scopes || 'read' }),
            sub: p.lastUsedAt ? '最近使用 ' + UI.esc(UI.fmtDate(p.lastUsedAt)) : '从未使用',
            actions: UI.iconBtn({ icon: 'delete-bin-line', title: '吊销', danger: true, cls: 'pat-revoke' }),
          })
        ).join(''),
      });
    }
    load();

    patList.addEventListener('click', async (e) => {
      const btn = e.target.closest('.pat-revoke');
      if (!btn) return;
      await UI.confirmAction('使用该令牌的工具将立即失效。确定吊销?', { okMsg: '已吊销' }, async () => {
        await api(Endpoints.pat(btn.closest('.list-row').dataset.pid), { method: 'DELETE' });
        await load();
      });
    });

    body.querySelector('#pat-new').onclick = () => {
      UI.formModal({
        title: '新建访问令牌',
        okText: '创建',
        fields: [
          { name: 'name', label: '名称', required: true, maxlength: 50, placeholder: '例如:本机 CLI' },
          {
            name: 'scopes', label: '权限范围', type: 'select', value: 'read',
            options: [
              { value: 'read', label: 'read(只读)' },
              { value: 'read,write', label: 'read,write(读写)' },
            ],
          },
        ],
        submit: async (v, { close }) => {
          const res = await api(Endpoints.pats(), { method: 'POST', body: { name: v.name.trim(), scopes: v.scopes } });
          close(true);
          showTokenOnce(res && res.token);
          await load();
        },
      });
    };
  }

  // 明文只显示一次,醒目提示复制
  function showTokenOnce(token) {
    UI.modal({
      title: '令牌创建成功',
      body:
        UI.banner({
          kind: 'warn', icon: 'error-warning-line',
          html: '<span>明文令牌仅此一次显示,关闭后无法再次查看,请立即复制并妥善保存。</span>',
        }) +
        '<div class="secret-box mt-4">' +
        UI.esc(token || '(响应未包含 token 字段,请检查后端创建接口返回值)') + '</div>',
      actions: [
        { label: '复制令牌', kind: 'tonal', onClick: () => { if (token) UI.copyText(token); } },
        { label: '我已保存', kind: 'filled', value: true },
      ],
    });
  }

  // ---------- 偏好 ----------
  function renderPreferences(body) {
    const density = UI.pref.get('td:density') === 'compact' ? 'compact' : 'comfortable';
    const size = Number(UI.pref.get('td:editor-font-size', 16)) || 16;
    const lang = UI.pref.get('td:lang', 'zh-CN');
    // 缺省视为开:编辑器按同一键读取,关闭时才不同步
    const previewLink = UI.pref.get('td:preview-link', 'true') !== 'false';
    body.innerHTML =
      '<h1 class="page-title">偏好</h1>' +
      UI.card({
        title: '外观', icon: 'palette-line',
        body:
          '<div class="pref-row"><span class="pref-label">主题</span><div id="pref-mode"></div></div>' +
          '<div class="pref-row"><span class="pref-label">种子色</span><div id="pref-color" class="color-dots"></div></div>' +
          '<div class="pref-row"><span class="pref-label">密度</span><div id="pref-density"></div></div>',
      }) +
      UI.card({
        title: '编辑器', icon: 'edit-box-line',
        body:
          '<div class="pref-row"><span class="pref-label">正文字号</span>' +
          '<div class="pref-range">' +
          '<input type="range" id="pref-size" min="13" max="20" step="1" value="' + size + '">' +
          '<span id="pref-size-val">' + size + 'px</span></div></div>' +
          '<div class="pref-row"><span class="pref-label">预览滚动联动</span>' +
          '<label class="check-row"><input type="checkbox" id="pref-preview-link"' +
          (previewLink ? ' checked' : '') + '>' +
          '<span>编辑区滚动时同步预览位置</span></label></div>' +
          '<div class="pref-preview" id="pref-preview">' +
          '<p>在文字里慢慢走,让想法有地方落脚。</p>' +
          '<p class="muted">这段文字与文档正文使用同一档字号,拖动滑块即可即时预览。</p></div>',
      }) +
      UI.card({
        title: '语言', icon: 'translate',
        body: '<div class="field flush"><select class="select" id="pref-lang">' +
          '<option value="zh-CN"' + (lang === 'zh-CN' ? ' selected' : '') + '>简体中文</option>' +
          '</select><div class="help">当前版本仅提供简体中文界面。</div></div>',
      });

    // 主题
    const modeEl = body.querySelector('#pref-mode');
    modeEl.innerHTML = UI.seg({
      active: Theme.getMode(),
      items: Theme.MODES.map((m) => ({ key: m.id, label: m.label, icon: m.icon })),
    });
    UI.segWire(modeEl, (key) => Theme.setMode(key));

    // 种子色
    const colorEl = body.querySelector('#pref-color');
    Theme.COLORS.forEach((c) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'color-dot' + (Theme.getColor() === c.id ? ' active' : '');
      b.style.background = c.value;
      b.title = c.label;
      b.onclick = () => {
        Theme.setColor(c.id);
        colorEl.querySelectorAll('.color-dot').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
      };
      colorEl.appendChild(b);
    });

    // 密度
    const densityEl = body.querySelector('#pref-density');
    densityEl.innerHTML = UI.seg({
      active: density,
      items: [{ key: 'comfortable', label: '舒适' }, { key: 'compact', label: '紧凑' }],
    });
    UI.segWire(densityEl, (key) => {
      UI.pref.set('td:density', key);
      document.documentElement.dataset.density = key;
    });

    // 编辑器字号(写 --fs-prose,编辑区与预览同时生效)
    const range = body.querySelector('#pref-size');
    const val = body.querySelector('#pref-size-val');
    const preview = body.querySelector('#pref-preview');
    function applySize() {
      const px = Number(range.value) || 16;
      val.textContent = px + 'px';
      preview.style.fontSize = px + 'px';
      UI.pref.set('td:editor-font-size', String(px));
      Theme.apply();
    }
    range.addEventListener('input', applySize);
    preview.style.fontSize = size + 'px';

    // 预览滚动联动(键 td:preview-link,缺省开):只写偏好,编辑器下次读取时生效
    const linkEl = body.querySelector('#pref-preview-link');
    linkEl.addEventListener('change', () => {
      UI.pref.set('td:preview-link', linkEl.checked ? 'true' : 'false');
    });

    const langEl = body.querySelector('#pref-lang');
    langEl.onchange = () => { UI.pref.set('td:lang', langEl.value); };
  }
})();
