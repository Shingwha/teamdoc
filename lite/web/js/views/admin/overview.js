// views/admin/overview.js — 管理后台·总览区
//   管理员打开后台先看这里:用户/空间/今日登录/锁定 + 存储图形 + 近配额与备份待办。
//   所有数字只有一个来源 /api/admin/overview(服务端聚合),前端不在本地拼第二套
//   统计 —— 两套口径迟早会对不上,而"哪个对"没人说得清。
window.AdminSections = window.AdminSections || {};
(function () {
  'use strict';

  const QUOTA_WARN_PCT = 80;   // 与服务端 nearQuota 的阈值一致(达到 80% 即待办)

  function need(v) {
    return v == null || v === '' ? '—' : String(v);
  }

  function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function storageTotals(storage) {
    const s = storage || {};
    const files = s.files || {};
    const docs = s.docs || {};
    const docsBytes = (num(docs.bytes) || 0) + (num(docs.versionBytes) || 0);
    const active = num(files.activeBytes) || 0;
    const trash = num(files.trashBytes) || 0;
    return { active: active, trash: trash, docs: docsBytes, total: active + trash + docsBytes };
  }

  /** 存储图形:整块磁盘的已用占比环 + 应用自身构成的占比条。
   *  环回答"还剩多少空间可写",构成条回答"空间被什么占了" —— 两个问题不是一个数。 */
  function storageFigure(storage) {
    const s = storage || {};
    const disk = s.disk || {};
    const total = num(disk.total);
    const used = num(disk.used);
    const free = num(disk.free);
    let ring = '';
    if (total > 0) {
      const usedBytes = used != null ? used : (free != null ? total - free : 0);
      const pct = Math.max(0, Math.min(100, (usedBytes / total) * 100));
      const low = free != null && (free < total * 0.1);
      ring = '<div class="admin-storage-figure">' +
        '<div class="admin-ring' + (low ? ' danger' : '') + '" style="--pct:' + pct.toFixed(1) + '">' +
          '<span class="admin-ring-label">' + Math.round(pct) + '%</span>' +
        '</div>' +
        '<div class="admin-ring-legend">' +
          '<div><span class="muted">磁盘已用</span> ' + UI.esc(UI.fmtSize(usedBytes)) + '</div>' +
          '<div><span class="muted">磁盘剩余</span> ' +
            UI.esc(UI.fmtSize(free != null ? free : total - usedBytes)) + '</div>' +
          (low ? '<div class="admin-ring-warn">' + UI.icon('alert-line') + '剩余不足 10%,请尽快清理或扩容</div>' : '') +
        '</div>' +
      '</div>';
    }

    const t = storageTotals(storage);
    let composition = '';
    if (t.total > 0) {
      const pct = (n) => Math.max(n > 0 ? 0.6 : 0, (n / t.total) * 100);
      composition =
        '<div class="seg-bar admin-seg-bar">' +
          '<i class="active" style="width:' + pct(t.active) + '%"></i>' +
          '<i class="trash" style="width:' + pct(t.trash) + '%"></i>' +
          '<i class="other" style="width:' + pct(t.docs) + '%"></i>' +
        '</div>' +
        '<div class="legend">' +
          '<span class="legend-item"><i class="legend-dot active"></i>文件 ' + UI.esc(UI.fmtSize(t.active)) + '</span>' +
          '<span class="legend-item"><i class="legend-dot trash"></i>回收站 ' + UI.esc(UI.fmtSize(t.trash)) + '</span>' +
          '<span class="legend-item"><i class="legend-dot other"></i>文档与版本 ' + UI.esc(UI.fmtSize(t.docs)) + '</span>' +
          '<span class="legend-item">TeamDoc 共占 ' + UI.esc(UI.fmtSize(t.total)) + '</span>' +
        '</div>';
    }

    return ring + composition ||
      '<div class="muted">服务端暂未返回存储数据。</div>';
  }

  function quotaPercent(q) {
    const ratio = num(q.ratio);
    if (ratio != null) return ratio * 100;   // 服务端给 0..1 的精确比值
    const direct = num(q.percent) != null ? num(q.percent) : num(q.usagePercent);
    if (direct != null) return direct;
    const used = num(q.storageBytes) != null ? num(q.storageBytes) : num(q.usedBytes);
    const quota = num(q.quotaBytes);
    return quota > 0 && used != null ? (used / quota) * 100 : 0;
  }

  function spaceHref(q) {
    if (q.id && App.route && typeof App.route.project === 'function') {
      return App.route.project(q.id, 'settings');
    }
    return '';
  }

  function quotaRows(nearQuota) {
    const list = Array.isArray(nearQuota) ? nearQuota : [];
    if (!list.length) return '';
    return '<div class="admin-quota-list">' + list.map((q) => {
      const pct = Math.max(0, Math.min(100, quotaPercent(q)));
      const used = num(q.storageBytes) != null ? num(q.storageBytes) : num(q.usedBytes);
      const quota = num(q.quotaBytes);
      const href = spaceHref(q);
      return '<div class="admin-quota-row" data-quota-pid="' + UI.esc(q.id || '') + '">' +
        '<div class="admin-quota-main">' +
          '<div class="admin-quota-name">' + UI.esc(q.name || q.spaceName || q.projectName || q.id || '未命名空间') + '</div>' +
          '<div class="admin-quota-meta">' +
            (used != null ? UI.esc(UI.fmtSize(used)) : '—') +
            (quota != null && quota > 0 ? ' / ' + UI.esc(UI.fmtSize(quota)) : '') +
            ' · ' + Math.round(pct) + '%' +
          '</div>' +
          '<div class="admin-quota-bar' + (pct >= QUOTA_WARN_PCT ? ' danger' : '') + '">' +
            '<i style="width:' + pct.toFixed(1) + '%"></i>' +
          '</div>' +
        '</div>' +
        (href ? '<a class="btn btn-text btn-sm" href="' + href + '">去处理</a>' : '') +
      '</div>';
    }).join('') + '</div>';
  }

  function backupState(backup) {
    const b = backup || {};
    const cfg = b.config || b;
    const last = b.last || b;
    const enabled = cfg.enabled != null ? !!cfg.enabled : !!b.enabled;
    const lastAt = last.runAt || last.lastRunAt || b.lastRunAt || null;
    const ok = last.ok != null ? !!last.ok : (b.ok != null ? !!b.ok : null);
    const partial = !!(last.partial || b.partial);
    if (!enabled && !lastAt) return { label: '未配置', danger: false, sub: '可下载手动备份' };
    if (!lastAt) return { label: '从未备份', danger: false, sub: '尚未执行过自动/手动备份' };
    if (ok === false || (ok == null && b.error)) {
      return { label: '失败', danger: true, sub: last.error || b.error || '上次备份未完成' };
    }
    if (partial) return { label: '部分成功', danger: true, sub: '有目标目录未写入' };
    return { label: '正常', danger: false, sub: last.trigger === 'scheduled' ? '自动备份' : '最近一次备份成功' };
  }

  function pendingItems(o, ctx) {
    const quotaHtml = quotaRows(o.nearQuota);
    const items = [];
    const locked = num(o.lockedCount) || 0;
    if (locked > 0) {
      items.push(UI.listRow({
        icon: 'lock-line',
        title: locked + ' 个账号处于登录锁定',
        sub: '冷却会自动过期,也可在用户详情中立即解除',
        actions: '<a class="btn btn-text btn-sm" href="#" data-admin-goto="users">查看</a>',
      }));
    }
    const bs = backupState(o.backup);
    if (bs.danger || bs.label === '从未备份' || bs.label === '未配置') {
      items.push(UI.listRow({
        icon: 'save-3-line',
        title: '备份状态:' + bs.label,
        sub: bs.sub,
        actions: '<a class="btn btn-text btn-sm" href="#" data-admin-goto="backup">查看</a>',
      }));
    }
    if (!quotaHtml && !items.length) {
      return UI.emptyHtml({ icon: 'checkbox-circle-line', title: '没有待处理事项', desc: '配额、锁定与备份均正常' });
    }
    return quotaHtml + items.join('');
  }

  function overviewHtml(o, ctx) {
    o = o || {};
    const locked = num(o.lockedCount) || 0;
    const bs = backupState(o.backup);
    return UI.sectionTitle({ title: '总览', icon: 'dashboard-3-line' }) +
      UI.statGrid([
        { label: '用户数', icon: 'team-line', value: need(o.userCount), sub: '全站账号' },
        { label: '空间数', icon: 'folder-3-line', value: need(o.spaceCount), sub: '不含个人空间' },
        { label: '今日登录', icon: 'login-circle-line', value: need(o.todayLoginCount), sub: '今日成功登录' },
        {
          label: '锁定账号', icon: 'lock-line', value: need(o.lockedCount),
          danger: locked > 0, sub: locked > 0 ? '需要关注' : '无账号被锁定',
        },
      ]) +
      '<div class="admin-overview-grid">' +
        UI.card({
          title: '存储用量', icon: 'pie-chart-line',
          body: storageFigure(o.storage),
        }) +
        UI.card({
          title: '待处理', icon: 'error-warning-line',
          body: pendingItems(o, ctx),
        }) +
      '</div>' +
      UI.card({
        title: '备份', icon: 'save-3-line', between: true,
        actions: '<a class="btn btn-text btn-sm" href="#" data-admin-goto="backup">备份与恢复</a>',
        body: UI.statGrid([
          {
            label: '状态', value: bs.label, danger: bs.danger, sub: bs.sub,
          },
          { label: '下次自动备份', value: need(o.backup && o.backup.nextRun), sub: '由服务端调度' },
        ]),
      });
  }

  window.AdminSections.overview = function (ctx) {
    const el = ctx.el;

    function load() {
      return UI.loadInto(el, () => api(Endpoints.adminOverview()), {
        loadingHtml: UI.skeleton('cards', 4),
        render: (o) => overviewHtml(o, ctx),
      });
    }

    el.addEventListener('click', (e) => {
      const a = e.target.closest('[data-admin-goto]');
      if (!a) return;
      e.preventDefault();
      ctx.openSection(a.dataset.adminGoto);
    });

    return { key: 'overview', load };
  };
})();
