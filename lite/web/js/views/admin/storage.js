// views/admin/storage.js — 管理后台·存储区(占用总览 / 孤儿清理)
// 由 views/admin.js 协调器装配;"操作后刷哪些区"走 ctx.refresh(...) 显式声明。
// 事件委托挂在本节容器上(容器由所在作用域创建、随它被换掉而销毁,监听器随之消失)。
window.AdminSections = window.AdminSections || {};
(function () {
  'use strict';

  /** 占比条 + 图例:TeamDoc 自身占用的构成(文件 / 回收站 / 文档+版本)。
   *  分母只用本应用占的空间,不含系统其它文件 —— 否则小团队的数据量下
   *  整条几乎全是空白,看不出构成。 */
  function occupancyBar(s) {
    const docsBytes = s.docs.bytes + s.docs.versionBytes;
    const total = s.files.activeBytes + s.files.trashBytes + docsBytes;
    if (total <= 0) return '';
    const pct = (n) => Math.max(n > 0 ? 0.6 : 0, (n / total) * 100); // 极小值留一丝可见
    return '<div class="seg-bar">' +
      '<i class="active" style="width:' + pct(s.files.activeBytes) + '%"></i>' +
      '<i class="trash" style="width:' + pct(s.files.trashBytes) + '%"></i>' +
      '<i class="other" style="width:' + pct(docsBytes) + '%"></i>' +
      '</div>' +
      '<div class="legend">' +
      '<span class="legend-item"><i class="legend-dot active"></i>文件 ' + UI.esc(UI.fmtSize(s.files.activeBytes)) + '</span>' +
      '<span class="legend-item"><i class="legend-dot trash"></i>回收站 ' + UI.esc(UI.fmtSize(s.files.trashBytes)) + '</span>' +
      '<span class="legend-item"><i class="legend-dot other"></i>文档与历史版本 ' + UI.esc(UI.fmtSize(docsBytes)) + '</span>' +
      '<span class="legend-item">TeamDoc 共占 ' + UI.esc(UI.fmtSize(total)) + '</span>' +
      '</div>';
  }

  function storeHtml(s) {
    const disk = s.disk, o = s.orphans;
    // 磁盘剩余不足 10% 或不足 5GB 时标红:这是"该清理了"的可执行信号。
    // 注意这是**整块磁盘**的余量,不是 TeamDoc 的占用 —— 副标题写明,免得误读
    const lowFree = disk.free < disk.total * 0.1 || disk.free < 5 * 1024 * 1024 * 1024;
    return UI.sectionTitle({
      title: '存储', icon: 'database-2-line',
    }) +
      UI.card({
        body:
        UI.statGrid([
          {
            // 告警语义在这里:整块磁盘剩余不足 10% 或不足 5GB 时标红
            label: '磁盘剩余', icon: 'hard-drive-3-line', danger: lowFree,
            value: UI.fmtSize(disk.free),
            sub: '整块磁盘 ' + UI.fmtSize(disk.total) + ',已用 ' +
              Math.round((disk.used / disk.total) * 100) + '%',
          },
          // 生效中的限制(只读):这些值来自部署时的环境变量,界面上原先看不到 ——
          // 用户传大文件被拒才知道有上限。放在这里让"上限是多少"一眼可查。
          {
            label: '单文件上限', icon: 'upload-2-line',
            value: UI.fmtSize((s.limits ? s.limits.maxUploadMb : 0) * 1024 * 1024),
            sub: '磁盘保留 ' +
              UI.fmtSize((s.limits ? s.limits.storageReserveMb : 0) * 1024 * 1024) +
              ',低于它拒绝上传',
          },
          {
            label: '云空间文件', value: UI.fmtSize(s.files.activeBytes),
            sub: s.files.activeCount + ' 个 · ' + s.files.folderCount + ' 个文件夹',
          },
          {
            label: '回收站占用', muted: true, value: UI.fmtSize(s.files.trashBytes),
            sub: s.files.trashCount + ' 个,仍占磁盘',
          },
          {
            label: '文档与历史版本', value: UI.fmtSize(s.docs.bytes + s.docs.versionBytes),
            sub: s.docs.count + ' 篇 · 版本 ' + s.docs.versionCount + ' 条',
          },
        ]) +
        occupancyBar(s) +
        (o.orphans > 0
          ? UI.banner({
              kind: 'warn', icon: 'alert-line', sm: true,
              text: '发现 ' + o.orphans + ' 个无主文件(' + UI.fmtSize(o.orphanBytes) +
                '):磁盘上有、数据库里没有引用,通常是上传中断或删项目留下的,占空间但界面上看不见。',
              action: { label: '清理', id: 'btn-cleanup' },
            })
          : '') +
        (o.missing > 0
          ? UI.banner({
              kind: 'danger', icon: 'error-warning-line', sm: true,
              text: '有 ' + o.missing + ' 条文件记录在磁盘上找不到内容(可能被手动删除或磁盘故障)。' +
                '建议从备份恢复,不建议直接删记录。',
            })
          : ''),
    });
  }

  /** 配额策略卡:说明按空间 quotaBytes 计,80% 预警;近配额空间来自
   *  adminOverview().nearQuota(服务端按 ratio 降序),点击直接打开该空间的成员抽屉。 */
  function quotaCard(nearQuota, unavailable) {
    if (unavailable) {
      return UI.card({
        id: 'admin-quota-policy', title: '配额策略', icon: 'pie-chart-2-line',
        note: '按空间设置配额(quotaBytes);用量达到 80% 时进入预警。配额只提示,不拦截上传。',
        body: UI.banner({ kind: 'warn', icon: 'alert-line', sm: true, text: '近配额数据暂不可用,请稍后刷新。' }),
      });
    }
    const rows = (nearQuota || []).map((p) => {
      const used = Number(p.storageBytes) || 0;
      const quota = Number(p.quotaBytes) || 0;
      const pct = Number(p.percent) || (quota > 0 ? Math.round(used / quota * 100) : 0);
      return '<div class="admin-quota-row clickable" role="button" tabindex="0"' +
        ' data-pid="' + UI.esc(p.id) + '" data-name="' + UI.esc(p.name) + '"' +
        ' title="打开「' + UI.esc(p.name) + '」的成员管理">' +
        '<div class="admin-quota-main">' +
          '<div class="admin-quota-name">' + UI.esc(p.name) + '</div>' +
          '<div class="admin-quota-meta">' + UI.esc(UI.fmtSize(used) + ' / ' + UI.fmtSize(quota) +
            ' · ' + pct + '%') + '</div>' +
          '<div class="admin-quota-bar' + (pct >= 90 ? ' danger' : '') + '">' +
            '<i style="width:' + Math.max(0, Math.min(100, pct)) + '%"></i></div>' +
        '</div>' +
        '<span class="muted small">管理成员</span>' +
        '</div>';
    }).join('');
    return UI.card({
      id: 'admin-quota-policy', title: '配额策略', icon: 'pie-chart-2-line', between: true,
      note: '按空间设置配额(quotaBytes);用量达到 80% 时进入预警。配额只提示,不拦截上传。',
      body: rows || UI.emptyHtml({
        icon: 'pie-chart-line', title: '暂无接近配额的空间',
        desc: '任意协作空间用量达到配额的 80% 后会出现在这里', sm: true,
      }),
    });
  }

  window.AdminSections.storage = function (ctx) {
    const el = ctx.el;

    function load() {
      return UI.loadInto(el, () => Promise.all([
        api(Endpoints.adminStorage()),
        // 近配额是增强信息:总览接口失败不应让整张存储卡变成错误态
        api(Endpoints.adminOverview()).catch(() => null),
      ]), {
        loadingHtml: UI.skeleton('cards', 2),
        render: ([s, overview]) => {
          const near = overview && Array.isArray(overview.nearQuota) ? overview.nearQuota : null;
          return storeHtml(s) + quotaCard(near, near === null);
        },
      });
    }

    el.addEventListener('click', async (e) => {
      const quotaRow = e.target.closest('.admin-quota-row');
      if (quotaRow) {
        const drawer = window.AdminSections && window.AdminSections.memberDrawer;
        if (typeof drawer === 'function') {
          drawer({ id: quotaRow.dataset.pid, name: quotaRow.dataset.name }, load);
        } else {
          UI.toast('成员抽屉尚未加载,请刷新页面重试', 'warning');
        }
        return;
      }
      if (e.target.closest('#btn-cleanup')) {
        // 先 dry-run 预览:告诉管理员"将删掉什么、多少字节",再让他确认。
        // 原来是一句话弹窗直接删 —— 破坏性操作不该让人在看不到范围的情况下点确定。
        let pv;
        try {
          pv = await api(Endpoints.adminCleanup({ dryRun: 1 }), { method: 'POST' });
        } catch (err) { UI.err(err); return; }
        if (!pv.orphans) {
          UI.toast('没有可清理的无主文件', 'info');
          await load();
          return;
        }
        if (pv.breakerTripped) {
          // 熔断:磁盘上绝大多数文件都被判为孤儿,多半是库不对而不是垃圾多。
          // 用 modal 而非 confirmDialog —— 这里只需要"知道了",不给"继续"的口子。
          UI.modal({
            title: '已阻止清理',
            body: UI.banner({
              kind: 'danger', icon: 'error-warning-line',
              html: '<span>检测到 <b>' + pv.orphans + '/' + pv.filesOnDisk +
                '</b> 个文件都被判为无主(超过 2/3)。</span>',
            }) +
              '<p class="modal-text mt-4">这通常意味着数据库为空、指向了错的数据目录,或恢复了一份' +
              '旧备份 —— 此时清理会删光磁盘上的文件,因此已阻止。</p>' +
              '<p class="modal-text mt-2">请先确认数据目录与数据库是否匹配。确实要清理时,' +
              '可直接调用接口并显式带上 force=1。</p>',
            actions: [{ label: '我知道了', kind: 'filled', value: true }],
          });
          return;
        }
        const ok = await UI.confirmDialog(
          '将删除 ' + pv.orphans + ' 个无主文件,释放 ' + UI.fmtSize(pv.orphanBytes) +
          '。这些文件在界面上看不到(数据库无引用),删除不影响任何文档与云空间内容。确定清理?',
          { okText: '清理' });
        if (!ok) return;
        try {
          const r = await api(Endpoints.adminCleanup(), { method: 'POST' });
          UI.toast('已清理 ' + r.removed + ' 个文件,释放 ' + UI.fmtSize(r.freedBytes), 'success');
          await load();
        } catch (err) { UI.err(err); }
      }
    });

    // 配额行是 role=button,键盘 Enter/空格与鼠标点击同一条路径
    el.addEventListener('keydown', (e) => {
      const row = e.target.closest('.admin-quota-row');
      if (!row || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      row.click();
    });

    return { key: 'storage', load };
  };
})();
