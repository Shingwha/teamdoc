// views/admin/projects.js — 管理后台·空间区
//   全站协作空间总览(owner / 成员数 / 用量 / 创建时间),带搜索、新建、归档、
//   删除与所有权转让。行内「成员」打开本域成员抽屉(480px):增删成员、改角色,
//   不跳回主应用长表单;抽屉与用户详情的「所属空间」读写同一组成员接口。
//   个人空间对管理员保密,服务端本就不返回。
window.AdminSections = window.AdminSections || {};
(function () {
  'use strict';

  const ROLES = ['OWNER', 'ADMIN', 'EDITOR', 'VIEWER'];
  const ROLE_OPTIONS = ROLES.map((r) => ({ value: r, label: UI.roleLabel(r) }));

  const TPL = 'minmax(0, 1.35fr) minmax(0, 1fr) 64px minmax(0, 0.85fr) 104px var(--col-acts)';
  const HEADS = [
    { html: '空间' }, { html: '所有者' }, { html: '成员' },
    { html: '用量' }, { html: '创建时间' }, { html: '' },
  ];

  function ownerHtml(p) {
    const owners = p.owners || [];
    if (!owners.length) return '<span class="muted">—</span>';
    return owners.map((o) => UI.esc(o.name || o.email) +
      (o.isDisabled ? ' ' + UI.badge({ text: '已禁用', kind: 'danger' }) : '')).join('、');
  }

  function usageHtml(p) {
    const used = Number(p.storageBytes) || 0;
    const quota = Number(p.quotaBytes) || 0;
    if (quota > 0) {
      const pct = Math.round((used / quota) * 100);
      return UI.cellMeta(UI.fmtSize(used) + ' / ' + UI.fmtSize(quota) +
        ' ' + UI.badge({ text: pct + '%', kind: pct >= 80 ? 'warning' : '' }));
    }
    return UI.cellMeta(UI.fmtSize(used));
  }

  // ---------- 成员抽屉(本域,不跳回主应用) ----------
  // 存储区的「近配额空间」也打开这一张抽屉:成员关系的读写只有这一份实现。
  function memberRow(p, m, archived) {
    const u = m.user || {};
    return UI.listRow({
      avatar: UI.avatar({ name: u.name || u.email, seed: u.id, size: 'lg', color: u.avatarColor }),
      title: UI.esc(u.name || u.email) +
        (u.isDisabled ? ' ' + UI.badge({ text: '已禁用', kind: 'danger' }) : ''),
      sub: UI.esc(u.email || ''),
      cls: 'admin-member-row',
      attrs: 'data-member-uid="' + UI.esc(m.userId) + '"',
      actions:
        '<select class="select admin-member-role" data-uid="' + UI.esc(m.userId) + '"' +
        (archived ? ' disabled' : '') + '>' +
          ROLE_OPTIONS.map((r) => '<option value="' + r.value + '"' +
            (r.value === m.role ? ' selected' : '') + '>' + UI.esc(r.label) + '</option>').join('') +
        '</select>' +
        (archived ? '' : UI.iconBtn({
          icon: 'user-minus-line', title: '移出空间', danger: true,
          cls: 'admin-member-remove', attrs: 'data-uid="' + UI.esc(m.userId) + '"',
        })),
    });
  }

  /** 打开空间成员抽屉。onChanged 用于操作成功后刷新调用方(空间列表/存储区)。 */
  function memberDrawer(p, onChanged) {
    const m = UI.modal({
      title: '成员 · ' + p.name,
      body: UI.loadingRow(),
      wide: true,
    });
    m.box.classList.add('admin-drawer-box');
    m.el.classList.add('admin-drawer-mask');
    const afterChange = () => Promise.all([
      paint(), onChanged ? Promise.resolve(onChanged()) : Promise.resolve(),
    ]);

    const paint = async () => {
      let members;
      try { members = (await api(Endpoints.projectMembers(p.id))) || []; }
      catch (e) { m.body.innerHTML = UI.errorBanner(e); return; }
      const archived = !!p.archivedAt;
      m.body.innerHTML =
        (archived ? UI.banner({
          kind: 'warn', icon: 'inbox-archive-line', sm: true,
          text: '该空间已归档:成员写操作会被服务端拒绝,解除归档后才能调整成员。',
        }) : '') +
        UI.card({
          title: '成员(' + members.length + ')', icon: 'team-line', between: true,
          actions: archived ? '' : UI.btn({
            label: '添加成员', icon: 'user-add-line', kind: 'tonal', size: 'sm', cls: 'admin-add-member',
          }),
          body: members.length
            ? members.map((x) => memberRow(p, x, archived)).join('')
            : UI.emptyHtml({ icon: 'team-line', title: '暂无成员', sm: true }),
        }) +
        '<div class="help mt-3">' +
          '改动立即生效。空间至少需要一名所有者;移除/降级最后一名所有者会被服务端拒绝。' +
        '</div>';

      const add = m.body.querySelector('.admin-add-member');
      if (add) add.addEventListener('click', async () => {
        const picked = await UI.personPicker({
          title: '添加成员 · ' + p.name,
          multi: true,
          confirmLabel: '添加',
          excludeIds: members.map((x) => x.userId),
          roleSelect: { options: ROLE_OPTIONS, value: 'EDITOR' },
        });
        if (!picked || !picked.length) return;
        const r = await UI.eachOk(picked, (u) =>
          api(Endpoints.projectMembers(p.id), {
            method: 'POST', body: { userId: u.id, role: u.role || 'EDITOR' },
          }));
        UI.toast('已添加 ' + r.ok + ' 位成员' +
          (r.failed.length ? ',' + r.failed.length + ' 位失败' : ''),
          r.failed.length ? 'warning' : 'success');
        await afterChange();
      });

      m.body.querySelectorAll('.admin-member-role').forEach((sel) => {
        sel.addEventListener('change', async () => {
          try {
            await api(Endpoints.projectMember(p.id, sel.dataset.uid), {
              method: 'PATCH', body: { role: sel.value },
            });
            UI.toast('已更新角色', 'success');
            await afterChange();
          } catch (e) {
            UI.err(e);
            await paint();
          }
        });
      });
      m.body.querySelectorAll('.admin-member-remove').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const target = members.filter((x) => x.userId === btn.dataset.uid)[0];
          const name = target && target.user ? (target.user.name || target.user.email) : '该成员';
          const ok = await UI.confirmAction(
            '将「' + name + '」移出「' + p.name + '」?其成员权限立即失效。',
            { okText: '移出', okMsg: '已移出' },
            async () => {
              await api(Endpoints.projectMember(p.id, btn.dataset.uid), { method: 'DELETE' });
            });
          if (!ok) return;
          await afterChange();
        });
      });
    };
    paint();
    return m;
  }

  // 存储区的近配额空间行点击时调用(本文件先于 storage.js 加载,但点击发生在装配完成之后)
  window.AdminSections.memberDrawer = memberDrawer;

  window.AdminSections.projects = function (ctx) {
    const el = ctx.el;
    let projects = [];
    let q = '';

    function findProject(pid) { return projects.find((p) => p.id === pid); }

    function filtered() {
      const needle = q.trim().toLowerCase();
      if (!needle) return projects;
      return projects.filter((p) => {
        const owners = (p.owners || []).map((o) => (o.name || '') + ' ' + (o.email || '')).join(' ');
        return (p.name || '').toLowerCase().indexOf(needle) >= 0 ||
          (p.description || '').toLowerCase().indexOf(needle) >= 0 ||
          owners.toLowerCase().indexOf(needle) >= 0;
      });
    }

    function paintShell() {
      el.innerHTML =
        UI.sectionTitle({
          title: '空间', icon: 'folder-3-line',
          actions: UI.btn({ id: 'btn-new-project', label: '新建空间', icon: 'add-line', kind: 'filled' }),
        }) +
        UI.toolbar({
          left: '<div class="admin-search">' + UI.icon('search-line') +
            '<input class="input" id="admin-project-q" type="text" autocomplete="off"' +
            ' placeholder="搜索空间名 / 描述 / 所有者" value="' + UI.esc(q) + '"></div>',
          right: '<span class="muted" id="admin-project-count"></span>',
        }) +
        '<div id="admin-projects-table" class="mt-3"></div>';
    }

    function paintTable() {
      const tableEl = el.querySelector('#admin-projects-table');
      if (!tableEl) return;
      const list = filtered();
      const countEl = el.querySelector('#admin-project-count');
      if (countEl) countEl.textContent = list.length + ' 个空间';
      const rows = list.map((p) => UI.tableRow([
        {
          html: UI.cellId({
            icon: 'folder-3-line',
            title: UI.esc(p.name),
            sub: p.description ? UI.esc(p.description) : '',
            badges: (p.archivedAt ? UI.badge({ text: '已归档', kind: 'warning' }) : '') +
              (p.isPublic ? UI.badge({ text: '公开', kind: 'primary' }) : ''),
          }),
        },
        { html: ownerHtml(p) },
        { html: UI.cellMeta(String(p.memberCount == null ? '—' : p.memberCount)) },
        { html: usageHtml(p) },
        { html: UI.cellMeta(p.createdAt ? UI.esc(UI.fmtDateShort(p.createdAt)) : '—') },
      ], {
        attrs: 'data-pid="' + UI.esc(p.id) + '"',
        acts: p.isPersonal ? '' :
          UI.iconBtn({ icon: 'team-line', title: '成员管理', cls: 'p-members' }) +
          UI.iconBtn({
            icon: p.archivedAt ? 'inbox-unarchive-line' : 'inbox-archive-line',
            title: p.archivedAt ? '解除归档' : '归档',
            cls: 'p-archive',
          }) +
          UI.iconBtn({ icon: 'exchange-line', title: '转让所有权', cls: 'p-transfer' }) +
          UI.iconBtn({ icon: 'delete-bin-line', title: '删除空间', danger: true, cls: 'p-delete' }),
      })).join('');
      tableEl.innerHTML = UI.tableHead(HEADS, {
        tpl: TPL, cls: 'admin-projects-table acts-4', headId: 'admin-projects-head',
      }) + rows +
        (list.length ? '' : '<div class="admin-table-empty">' + UI.emptyHtml({
          icon: 'folder-line',
          title: projects.length ? '没有匹配的空间' : '暂无协作空间',
          desc: projects.length ? '换个关键词试试' : '新建空间后即可邀请成员',
        }) + '</div>');
    }

    function load() {
      if (!el.querySelector('#admin-projects-table')) paintShell();
      const tableEl = el.querySelector('#admin-projects-table');
      tableEl.innerHTML = UI.skeleton('rows', 5);
      return api(Endpoints.adminProjects()).then((list) => {
        projects = list || [];
        ctx.state.projects = projects;   // 用户区禁用前的唯一所有者提醒会读它
        paintTable();
        return projects;
      }).catch((e) => { tableEl.innerHTML = UI.errorBanner(e); });
    }

    // ---------- 新建 / 归档 / 删除 / 转让 ----------
    function openNewProject() {
      UI.formModal({
        title: '新建空间',
        okText: '创建',
        fields: [
          { name: 'name', label: '空间名称', required: true, maxlength: 100 },
          { name: 'description', label: '描述', type: 'textarea', rows: 2, maxlength: 5000 },
        ],
        submit: async (v, { close }) => {
          await api(Endpoints.projects(), {
            method: 'POST',
            body: { name: v.name.trim(), description: v.description.trim() },
          });
          close(true);
          UI.toast('空间已创建', 'success');
          await load();
        },
      });
    }

    async function toggleArchive(p) {
      const archiving = !p.archivedAt;
      await UI.confirmAction(
        archiving
          ? '归档后「' + p.name + '」默认从空间列表与发现页隐藏,成员的文件/文档写操作会被拒绝;数据和成员关系保留,可随时解除归档。'
          : '解除归档后「' + p.name + '」恢复可写,并重新出现在空间列表与发现页。',
        { okText: archiving ? '归档' : '解除归档', okMsg: archiving ? '已归档' : '已解除归档', danger: archiving },
        async () => {
          const r = await api(Endpoints.project(p.id), {
            method: 'PATCH', body: { archived: archiving },
          });
          // 归档状态由 W2-d 的服务端契约提供;响应里没有 archivedAt 说明后端尚未接线,
          // 不能只在前端显示"已归档"而实际没归档。
          if (!r || !Object.prototype.hasOwnProperty.call(r, 'archivedAt')) {
            throw new Error('服务端暂未返回归档状态,归档未生效(等待 W2-d 接线)');
          }
          await load();
        });
    }

    /** 转让目标只能选该空间里现有的非 OWNER 成员:服务端要求目标已是成员、
     *  且只有真实 OWNER 可发起转让。从目录里随便选一个人,必然撞 403/409。 */
    function pickTransferTarget(p, members) {
      const candidates = members.filter((m) =>
        m.role !== 'OWNER' && m.user && !m.user.isDisabled);
      if (!candidates.length) {
        UI.toast('没有可接手的成员:转让目标必须是空间内已加入且未禁用的非所有者', 'warning');
        return Promise.resolve(null);
      }
      const m = UI.modal({
        title: '选择接手人 · ' + p.name,
        body: '<div class="help mb-3">只能转让给空间现有成员;转让后原所有者降为管理员。</div>' +
          '<div id="tm-list" class="pp-list">' + candidates.map((x) =>
            '<div class="pp-item" data-uid="' + UI.esc(x.userId) + '">' +
              UI.avatar({ name: x.user.name || x.user.email, seed: x.userId, size: 'lg',
                          color: x.user.avatarColor }) +
              '<span class="pp-main"><span class="pp-name">' + UI.esc(x.user.name || x.user.email) + '</span>' +
              '<span class="pp-mail">' + UI.esc(x.user.email || '') + ' · ' + UI.esc(UI.roleLabel(x.role)) +
              '</span></span><i class="ri-checkbox-blank-circle-line"></i>' +
            '</div>').join('') + '</div>',
        actions: [
          { label: '取消', kind: 'text', value: null },
          { label: '转让', kind: 'filled', value: '__ok__' },
        ],
      });
      let picked = null;
      const listEl = m.body.querySelector('#tm-list');
      listEl.addEventListener('click', (e) => {
        const row = e.target.closest('.pp-item');
        if (!row) return;
        picked = candidates.filter((x) => x.userId === row.dataset.uid)[0] || null;
        listEl.querySelectorAll('.pp-item').forEach((r) => {
          const on = picked && r.dataset.uid === picked.userId;
          r.classList.toggle('selected', !!on);
          const icon = r.querySelector('i');
          if (icon) icon.className = on ? 'ri-checkbox-circle-fill' : 'ri-checkbox-blank-circle-line';
        });
      });
      return m.result.then((v) => (v === '__ok__' && picked ? picked.user : null));
    }

    function transferProject(p) {
      if (typeof Endpoints.projectTransfer !== 'function') {
        UI.toast('所有权转让接口尚未接线(等待 W2-a Endpoints)', 'warning');
        return;
      }
      const isOwner = (p.owners || []).some((o) => App.user && o.id === App.user.id);
      if (!isOwner) {
        UI.toast('仅空间所有者可转让所有权;全局管理员需先成为该空间所有者', 'warning');
        return;
      }
      api(Endpoints.projectMembers(p.id)).then(async (members) => {
        const u = await pickTransferTarget(p, members || []);
        if (!u) return;
        await UI.confirmAction(
          '将「' + p.name + '」的所有权转让给「' + (u.name || u.email) +
          '」?你将成为该空间的管理员,原所有者不会被移出空间。',
          { okText: '转让', okMsg: '所有权已转让' },
          async () => {
            await api(Endpoints.projectTransfer(p.id), {
              method: 'POST', body: { userId: u.id },
            });
            await load();
          });
      }).catch((e) => UI.err(e));
    }

    async function deleteProject(p) {
      await UI.confirmAction(
        '删除「' + p.name + '」将同时删除其全部文档、文件与成员关系,且不可恢复。确定删除?',
        { okText: '删除', okMsg: '空间已删除' },
        async () => {
          await api(Endpoints.project(p.id), { method: 'DELETE' });
          await load();
        });
    }

    // 成员抽屉的实现提到模块级:存储区的近配额行也打开同一张抽屉
    function openMemberDrawer(p) { return memberDrawer(p, load); }

    // ---------- 事件 ----------
    el.addEventListener('input', (e) => {
      if (e.target.closest('#admin-project-q')) {
        q = e.target.value;
        paintTable();
      }
    });

    el.addEventListener('click', async (e) => {
      if (e.target.closest('#btn-new-project')) { openNewProject(); return; }
      const row = e.target.closest('.data-table-row[data-pid]');
      if (!row) return;
      const p = findProject(row.dataset.pid);
      if (!p) return;
      if (e.target.closest('.p-members')) {
        openMemberDrawer(p);
      } else if (e.target.closest('.p-archive')) {
        await toggleArchive(p);
      } else if (e.target.closest('.p-transfer')) {
        transferProject(p);
      } else if (e.target.closest('.p-delete')) {
        await deleteProject(p);
      }
    });

    return { key: 'projects', load };
  };
})();
