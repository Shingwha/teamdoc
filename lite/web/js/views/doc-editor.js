// views/doc-editor.js — 文档位作用域(#/p/{id}/docs/{docId}):编辑器与历史版本模态
//   DocEditorView.level({docId, pid, canEdit, onTreeChanged, docTitle})
//     → 作用域描述(见 ARCHITECTURE「渲染契约」):编辑器是**唯一随切文档重建的那一层**,
//     外面的侧栏、文档树、项目对象都不动。功能:手动保存(按钮 / Ctrl+S)、编辑/预览切换、
//     WS 实时协同、反链栏、粘贴拖拽上传、离开前未保存提示、冲突逐块合并
//   DocEditorView.openHistoryModal(docId, canEdit, onRestored, hasUnsaved) — 历史版本模态
//   本模块只被 views/docs.js 调用;App/api/MdRender/Preview/DocEditor 均为运行时引用。
window.DocEditorView = (function () {
  'use strict';

  // WS 保存的等待上限:超过就按失败处理(状态栏说"保存失败",不放行"保存并离开")。
  // 宁可让用户重试,也不要给出"已保存"的假象
  const SAVE_TIMEOUT_MS = 5000;

  /** 文档位:一篇文档的编辑器。骨架同步画出,正文随后填 */
  function level(o) {
    return {
      key: 'p/' + o.pid + '/docs/' + o.docId,
      props: { docId: o.docId },   // 父层(文档模块)用它在树上移动高亮行
      render(ctx) { return open(ctx, o); },
    };
  }

  // ---------- 编辑器 + 实时协同 ----------
  function open(ctx, { docId, pid: projectId, canEdit, docTitle, onTreeChanged }) {
    const frag = Scope.html(
      '<div class="editor-head">' +
      '<div class="head-tools">' +
      '<span class="save-status" id="save-status"><span class="status-dot" aria-hidden="true"></span><span id="save-status-text"></span></span>' +
      (canEdit ? UI.seg({
        id: 'doc-mode-seg', active: null,
        items: [
          { key: 'edit', label: '编辑', icon: 'edit-line' },
          { key: 'preview', label: '预览', icon: 'eye-line' },
        ],
      }) : '') +
      (canEdit ? UI.iconBtn({ id: 'btn-doc-split', icon: 'layout-right-line', title: '收起预览栏', attrs: 'hidden' }) : '') +
      (canEdit ? UI.btn({ id: 'btn-save', label: '保存', icon: 'save-line', kind: 'tonal', size: 'sm', disabled: true }) : '') +
      '<span id="presence-inline" class="presence-inline"></span>' +
      UI.iconBtn({ id: 'btn-doc-outline', icon: 'list-unordered', title: '大纲' }) +
      UI.iconBtn({ id: 'btn-doc-focus', icon: 'focus-3-line', title: '专注模式' }) +
      UI.iconBtn({ id: 'btn-head-more', icon: 'more-fill', title: '更多' }) +
      '</div></div>' +
      UI.banner({
        kind: 'primary', icon: 'information-line', id: 'remote-bar', cls: 'remote-bar', hidden: true,
        html: '<span id="remote-msg"></span>',
        action: { id: 'btn-load-latest', label: '比较并合并', kind: 'tonal' },
      }) +
      '<div class="editor-scroll" id="editor-scroll"><div class="editor-canvas" id="editor-canvas">' +
      '<div class="doc-content">' +
      '<input id="doc-title" class="doc-title-input" placeholder="无标题文档" maxlength="200"' + (canEdit ? '' : ' disabled') + '>' +
      '<div class="doc-meta" id="doc-meta"></div>' +
      '<div id="doc-loading">' + UI.skeleton('lines', 8) + '</div>' +
      '<div class="doc-body" id="doc-body">' +
      '<div id="md-source" class="md-source" hidden></div>' +
      '<div id="md-preview" class="markdown-body doc-preview" hidden></div>' +
      '</div>' +
      '<div class="doc-backlinks" id="doc-backlinks" hidden></div>' +
      '</div>' +
      '<aside class="doc-outline" id="doc-outline" hidden><div class="doc-outline-title">大纲</div><div id="doc-outline-list"></div></aside>' +
      '</div></div>' +
      '<div class="doc-statusbar">' +
      '<span id="doc-words">0 字</span><span id="doc-read">0 分钟</span>' +
      '<span id="doc-cursor">行 1，列 1</span>' +
      '<span id="doc-save-state"><span class="status-dot" aria-hidden="true"></span><span id="doc-save-state-text"></span></span>' +
      '<span class="doc-space" id="doc-space"></span></div>' +
      (canEdit ? '<div class="doc-toolbar" id="doc-toolbar" role="toolbar" aria-label="Markdown 编辑工具">' +
        [['bold', 'bold', '加粗'], ['italic', 'italic', '斜体'], ['code', 'code-line', '行内代码'],
          ['link', 'link', '链接'], ['quote', 'double-quotes-l', '引用'], ['unordered', 'list-unordered', '无序列表'],
          ['todo', 'checkbox-line', '待办']].map((item) =>
          '<button type="button" class="doc-tool-btn" data-command="' + item[0] + '" title="' + item[2] + '" aria-label="' + item[2] + '">' +
          UI.icon(item[1]) + '</button>').join('') +
        '</div>' : ''));


    const titleEl = frag.querySelector('#doc-title');
    const statusEl = frag.querySelector('#save-status');
    const statusTextEl = frag.querySelector('#save-status-text');
    const saveBtn = frag.querySelector('#btn-save');
    const splitBtn = frag.querySelector('#btn-doc-split');
    const moreBtn = frag.querySelector('#btn-head-more');
    const remoteBar = frag.querySelector('#remote-bar');
    const remoteMsg = frag.querySelector('#remote-msg');
    const sourceHost = frag.querySelector('#md-source');
    const previewEl = frag.querySelector('#md-preview');
    const loadingEl = frag.querySelector('#doc-loading');
    const presenceEl = frag.querySelector('#presence-inline');
    const scrollEl = frag.querySelector('#editor-scroll');
    const canvasEl = frag.querySelector('#editor-canvas');
    const outlineEl = frag.querySelector('#doc-outline');
    const outlineList = frag.querySelector('#doc-outline-list');
    const wordsEl = frag.querySelector('#doc-words');
    const readEl = frag.querySelector('#doc-read');
    const metaEl = frag.querySelector('#doc-meta');
    const cursorEl = frag.querySelector('#doc-cursor');
    const footerStatusEl = frag.querySelector('#doc-save-state');
    const footerStatusTextEl = frag.querySelector('#doc-save-state-text');
    const spaceEl = frag.querySelector('#doc-space');
    const toolbarEl = frag.querySelector('#doc-toolbar');
    const wideQuery = window.matchMedia('(min-width: 1280px)');

    let ws = null;
    let wsReady = false;
    let destroyed = false;
    let loading = true;
    let lastSaved = '';
    let lastTitle = '';
    let editorFocused = false;
    let pendingRemote = null;
    let wsRetries = 0;
    let editor = null;
    let wsRetryTimer = null;
    let leavePromptOpen = false;
    let onBeforeUnload = null;
    let presenceHtml = '';
    let baseVersion = 0;
    let conflict = null;
    let conflictModal = null;
    let focusMode = false;
    let splitCollapsed = UI.pref.get('td:doc-split', '1') === '0';
    let scrollSyncTarget = null;
    let outlineScrollSource = '';
    let outlineRaf = 0;
    let spaceName = '';
    let updatedAt = '';
    let wordCount = 0;

    ctx.dispose(() => {
      destroyed = true;
      App.clearLeaveGuard();
      document.body.classList.remove('doc-focus-mode');
      if (onBeforeUnload) { window.removeEventListener('beforeunload', onBeforeUnload); onBeforeUnload = null; }
      if (wsRetryTimer) { clearTimeout(wsRetryTimer); wsRetryTimer = null; }
      if (outlineRaf) { cancelAnimationFrame(outlineRaf); outlineRaf = 0; }
      sourceHost.removeEventListener('scroll', onSourceScroll, true);
      previewEl.removeEventListener('scroll', onPreviewScroll, true);
      scrollEl.removeEventListener('scroll', scheduleOutlineActive);
      if (editor) { editor.destroy(); editor = null; }
      wideQuery.removeEventListener('change', onWideChange);
      try { if (ws) ws.close(); } catch (e) { /* 忽略 */ }
    });
    let mode = canEdit ? (UI.pref.get('td:doc-mode') || 'edit') : 'preview';
    let saving = false;
    let saveError = false;
    let savedAt = '';

    const value = () => editor ? editor.getValue() : '';
    /** 保存状态 = 圆点 + 文字。state 决定圆点配色(ok/busy/warn/error),
     *  文字本身仍是唯一的人读事实(窄屏、无障碍、测试都靠它)。 */
    const setStatus = (text, state) => {
      statusTextEl.textContent = text;
      footerStatusTextEl.textContent = text;
      statusEl.dataset.state = state || '';
      footerStatusEl.dataset.state = state || '';
    };
    const dirty = () => value() !== lastSaved || (titleEl.value.trim() || '') !== lastTitle;

    function renderStatus() {
      if (conflict) setStatus('有冲突未解决', 'error');
      else if (saving) setStatus('保存中…', 'busy');
      else if (saveError) setStatus('保存失败', 'error');
      else if (dirty()) setStatus('未保存', 'warn');
      else if (!canEdit) setStatus('只读', '');
      else if (savedAt) setStatus('已保存', 'ok');
      else setStatus('', '');
      statusEl.classList.toggle('conflict', !!conflict);
      footerStatusEl.classList.toggle('conflict', !!conflict);
      statusEl.title = conflict ? '点击重新打开冲突处理' : (savedAt ? '保存于 ' + savedAt : '');
      if (moreBtn) moreBtn.classList.toggle('conflict', !!conflict);
      if (saveBtn) {
        saveBtn.disabled = conflict ? false : !dirty();
        saveBtn.title = conflict ? '有冲突未解决，点击处理' : '保存(Ctrl+S)';
      }
    }

    const markSaved = () => {
      savedAt = new Date().toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
      renderStatus();
    };

    function renderPreview() {
      return Promise.resolve(MdRender.mount(previewEl, value())).then(() => {
        scheduleOutlineActive();
      }).catch((e) => {
        previewEl.innerHTML = UI.errorBanner({ message: '预览渲染失败:' + (e.message || '未知错误') });
      });
    }

    /** 元信息行 = 空间 · 更新时间 · 字数(有哪项说哪项) */
    function renderMeta() {
      const bits = [];
      if (spaceName) bits.push(spaceName);
      if (updatedAt) bits.push('更新于 ' + UI.fmtDate(updatedAt));
      bits.push(wordCount + ' 字');
      metaEl.textContent = bits.join(' · ');
    }

    function renderStats() {
      const text = value();
      const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
      const latin = (text.replace(/[\u3400-\u9fff\uf900-\ufaff]/g, ' ').match(/[\w'-]+/g) || []).length;
      wordCount = cjk + latin;
      const minutes = wordCount ? Math.max(1, Math.ceil(wordCount / 300)) : 0;
      wordsEl.textContent = wordCount + ' 字';
      readEl.textContent = minutes + ' 分钟';
      renderMeta();
    }

    function renderOutline() {
      if (!editor) return;
      const headings = editor.getHeadings();
      outlineList.innerHTML = headings.length ? headings.map((heading) =>
        '<button type="button" class="outline-level-' + heading.level + '" data-id="' + heading.id + '">' +
        UI.esc(heading.text) + '</button>'
      ).join('') : '<span class="doc-outline-empty">暂无标题</span>';
      paintOutlineActive();
    }

    // ---------- 大纲高亮:预览/源码按滚动位置,编辑态退回光标行 ----------
    /** 按内容比例取最近标题(源码滚动、预览尚未画出标题时使用) */
    function activeFromRatio(headings, ratio) {
      const total = Math.max(1, value().length);
      let active = headings[0].id;
      headings.forEach((heading) => {
        if (heading.pos / total <= ratio) active = heading.id;
      });
      return active;
    }

    /** 预览态:按标题在预览内容里的纵向位置判定"读到哪一节"。
     *  用 offsetTop(内容内位置)而不是 getBoundingClientRect:后者要等滚动后的
     *  视口布局,滚动与重绘不同步时会读到上一帧;阈值取滚动容器当前位置 + 24。 */
    function activeFromPreviewDom(headings) {
      const nodes = previewEl.querySelectorAll('h1,h2,h3,h4,h5,h6');
      if (nodes.length !== headings.length) return headings[0].id;
      const split = splitPreview();
      const scroller = split ? previewEl : scrollEl;
      const base = (split ? previewEl : scrollEl).offsetTop;
      const top = scroller.scrollTop + 24;
      let active = headings[0].id;
      for (let i = 0; i < nodes.length; i++) {
        if (nodes[i].offsetTop - base <= top) active = headings[i].id;
      }
      return active;
    }

    function activeOutlineId() {
      if (!editor) return null;
      const headings = editor.getHeadings();
      if (!headings.length) return null;
      if (mode === 'preview') {
        if (splitPreview() && outlineScrollSource === 'source') {
          const src = sourceScrollEl();
          const ratio = src.scrollHeight > src.clientHeight
            ? src.scrollTop / (src.scrollHeight - src.clientHeight) : 0;
          return activeFromRatio(headings, ratio);
        }
        return activeFromPreviewDom(headings);
      }
      const cursor = editor.getCursor();
      let active = null;
      headings.forEach((heading) => {
        const line = editor.getValue().slice(0, heading.pos).split('\n').length;
        if (line <= cursor.line) active = heading.id;
      });
      return active;
    }

    function paintOutlineActive() {
      if (!outlineList || outlineEl.hidden) return;
      const active = activeOutlineId();
      outlineList.querySelectorAll('button').forEach((button) => {
        button.classList.toggle('active', button.dataset.id === active);
      });
    }

    /** rAF 节流:滚动事件一帧只算一次高亮。后台标签页/无渲染帧的环境里 rAF
     *  可能长期不触发,再用一次 100ms 兜底,保证高亮不会停在旧位置。 */
    function scheduleOutlineActive() {
      if (outlineRaf) return;
      outlineRaf = requestAnimationFrame(() => { outlineRaf = 0; paintOutlineActive(); });
      setTimeout(() => {
        if (!outlineRaf) return;
        cancelAnimationFrame(outlineRaf);
        outlineRaf = 0;
        paintOutlineActive();
      }, 100);
    }

    function widePreview() { return canEdit && mode === 'preview' && wideQuery.matches && !focusMode; }
    function splitPreview() { return widePreview() && !splitCollapsed; }
    // 设置页写入的偏好值是字符串 'true'/'false',缺省视为开启(W4-c 契约)
    function previewLinkEnabled() { return UI.pref.get('td:preview-link', 'true') !== 'false'; }

    function showPanes() {
      const wide = widePreview();
      const split = wide && !splitCollapsed;
      sourceHost.hidden = loading || (mode === 'preview' && !split);
      previewEl.hidden = loading || mode !== 'preview';
      loadingEl.hidden = !loading;
      canvasEl.classList.toggle('preview-split', split);
      if (editor) editor.setPreviewVisible(split);
      if (splitBtn) {
        splitBtn.hidden = !wide;
        splitBtn.title = splitCollapsed ? '展开预览栏' : '收起预览栏';
        splitBtn.innerHTML = UI.icon(splitCollapsed ? 'layout-right-2-line' : 'layout-right-line');
      }
    }

    function setMode(m) {
      mode = m;
      if (canEdit) UI.pref.set('td:doc-mode', m);
      if (segEl) UI.segSet(segEl, m);
      showPanes();
      if (loading) return;
      if (m === 'preview') renderPreview();
      else if (editor) { editor.focus(); scheduleOutlineActive(); }
    }

    function onWideChange() { showPanes(); if (mode === 'preview') renderPreview(); }
    wideQuery.addEventListener('change', onWideChange);

    const segEl = frag.querySelector('#doc-mode-seg');
    if (segEl) UI.segWire(segEl, (key) => { if (key !== mode) setMode(key); });

    frag.querySelector('#btn-doc-outline').addEventListener('click', () => {
      outlineEl.hidden = !outlineEl.hidden;
      if (!outlineEl.hidden) renderOutline();
    });
    frag.querySelector('#btn-doc-focus').addEventListener('click', (event) => {
      focusMode = !focusMode;
      document.body.classList.toggle('doc-focus-mode', focusMode);
      canvasEl.classList.toggle('focus-mode', focusMode);
      event.currentTarget.title = focusMode ? '退出专注模式' : '专注模式';
      if (focusMode && mode === 'preview') setMode('edit'); else showPanes();
    });
    if (splitBtn) splitBtn.addEventListener('click', () => {
      splitCollapsed = !splitCollapsed;
      UI.pref.set('td:doc-split', splitCollapsed ? '0' : '1');
      showPanes();
      if (!splitCollapsed && mode === 'preview') renderPreview();
    });
    outlineList.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-id]');
      if (!button || !editor) return;
      // 预览态:滚预览里的同名标题(源码可能根本不可见);编辑态仍走门面定位光标
      if (mode === 'preview') {
        const headings = editor.getHeadings();
        const index = headings.findIndex((heading) => heading.id === button.dataset.id);
        const node = previewEl.querySelectorAll('h1,h2,h3,h4,h5,h6')[index];
        if (node) {
          const scroller = splitPreview() ? previewEl : scrollEl;
          scroller.scrollTop += node.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 24;
          scheduleOutlineActive();
          return;
        }
      }
      editor.scrollToHeading(button.dataset.id);
    });

    /** 预览 ↔ 源码双向滚动联动(按比例)。设置项 td:preview-link 关闭时不同步。
     *  源码真正的滚动容器是 CM 的 .cm-scroller(外层 .md-source 只给几何);
     *  取元素而不是缓存:门面销毁重建后节点会换。 */
    function sourceScrollEl() { return sourceHost.querySelector('.cm-scroller') || sourceHost; }

    function syncScroll(from, to) {
      if (!splitPreview() || !previewLinkEnabled() || scrollSyncTarget === from) return;
      if (!from || from.scrollHeight <= from.clientHeight) return;
      const ratio = from.scrollTop / (from.scrollHeight - from.clientHeight);
      scrollSyncTarget = to;
      to.scrollTop = ratio * Math.max(0, to.scrollHeight - to.clientHeight);
      requestAnimationFrame(() => { if (scrollSyncTarget === to) scrollSyncTarget = null; });
    }

    function onSourceScroll() {
      outlineScrollSource = 'source';
      syncScroll(sourceScrollEl(), previewEl);
      scheduleOutlineActive();
    }

    function onPreviewScroll() {
      outlineScrollSource = 'preview';
      syncScroll(previewEl, sourceScrollEl());
      scheduleOutlineActive();
    }

    sourceHost.addEventListener('scroll', onSourceScroll, true);
    previewEl.addEventListener('scroll', onPreviewScroll, true);
    scrollEl.addEventListener('scroll', scheduleOutlineActive);

    function applyRemote(content, version) {
      const c = content || '';
      if (editor) editor.setValue(c, { preserveSelection: true });
      loading = false;
      showPanes();
      renderStats();
      renderOutline();
      if (mode === 'preview') renderPreview();
      lastSaved = c;
      if (version != null) baseVersion = version;
      saveError = false;
      markSaved();
    }

    // ---------- 内容冲突:服务端拒绝时不静默覆盖,逐块交给用户合并 ----------
    let mergePlan = null;   // Diff.build(...) 的产物(冲突期间才有)
    let picks = {};         // {块序号: 'mine' | 'theirs' | 'both'},缺省 mine

    /** 进入冲突态:保存暂停、状态栏常驻提示、弹出逐块合并弹窗。
     *  payload 是"服务端冲突现场"契约:{currentContent, currentVersion, by} ——
     *  WS conflict 消息与 REST 409 detail 服务端已统一为同形;远端刷新(remote)与
     *  "比较并合并"(GET 文档)在各自调用点换算成此形状,这里不做宽容兼容。 */
    function enterConflict(p) {
      conflict = { content: p.currentContent || '', version: p.currentVersion, by: p.by || '' };
      // 服务端那份才是"已保存"的事实:把 lastSaved 拉回它 —— 界面不再显示假成功,
      // dirty() 也恢复为真(本地确实有没写进去的内容)
      lastSaved = conflict.content;
      pendingRemote = null;
      remoteBar.hidden = true;
      renderStatus();
      openConflictModal();
    }

    /** 冲突未解决期间又有人保存:把"服务端那一侧"刷新到最新并重画,不打断用户。
     *  已做的选择按**块序号**保留:序号是稳定标识(行号会变),而且重画后每个块的
     *  seg 仍显示着当前选择,用户看得见自己选了什么,不存在"悄悄沿用"的情况。 */
    function refreshConflict(p) {
      if (!conflict) return;
      conflict.content = p.currentContent || '';
      conflict.version = p.currentVersion;
      if (p.by) conflict.by = p.by;
      lastSaved = conflict.content;
      renderStatus();
      if (conflictModal) paintConflict();
    }

    function clearConflictState() {
      conflict = null;
      conflictModal = null;
      mergePlan = null;
      picks = {};
      renderStatus();
    }

    /** 画出弹窗内容(首次与"现场又变了"共用):说明一句 + 图例一行 + 逐块差异 */
    function paintConflict() {
      const plan = Diff.build(value(), conflict.content);
      mergePlan = plan;
      // 现场变了之后块数可能变少,丢掉越界的选择;其余按序号保留
      Object.keys(picks).forEach((k) => { if (Number(k) >= plan.count) delete picks[k]; });

      const who = conflict.by ? UI.esc(conflict.by) + ' ' : '其他人';
      const body = conflictModal.body;
      body.innerHTML = '';
      const note = document.createElement('p');
      note.className = 'pv-note conflict-note';
      note.innerHTML = who + '在你编辑期间也保存了这篇文档。保存已暂停,逐处选择要保留的内容。';
      const legend = document.createElement('div');
      legend.className = 'df-legend';
      legend.innerHTML = '共 ' + plan.count + ' 处差异 · <b class="cn-del">−</b> 你的版本 · ' +
        '<b class="cn-add">+</b> 服务端版本';
      const diffEl = document.createElement('div');
      diffEl.innerHTML = plan.render(picks);
      // 一次事件委托管所有块 —— 逐块绑监听会在重画时漏掉新块
      diffEl.addEventListener('click', (e) => {
        const b = e.target.closest('.df-hunk .seg button[data-key]');
        if (!b) return;
        picks[b.closest('.df-hunk').dataset.hunk] = b.dataset.key;
        plan.applyPicks(diffEl, picks);
      });
      body.appendChild(note);
      body.appendChild(legend);
      body.appendChild(diffEl);
      conflictModal.diffEl = diffEl;
    }

    function setAllPicks(kind) {
      if (!mergePlan) return;
      for (let i = 0; i < mergePlan.count; i++) picks[i] = kind;
      mergePlan.applyPicks(conflictModal.diffEl, picks);
    }

    function openConflictModal() {
      if (!conflict || destroyed) return;
      if (conflictModal) { paintConflict(); return; }
      conflictModal = { body: null, diffEl: null, handle: null };
      const modal = UI.modal({
        title: '文档已被他人修改',
        wide: true,
        body: '<div class="conflict-body"></div>',
        actions: [
          { id: 'cf-all-mine', kind: 'text', label: '全部用我的',
            onClick: () => setAllPicks('mine') },
          { id: 'cf-all-theirs', kind: 'text', label: '全部用服务端',
            onClick: () => setAllPicks('theirs') },
          { id: 'cf-apply', kind: 'filled', label: '保存合并结果',
            onClick: ({ close }) => { close(null); applyMerge(); } },
        ],
        // Esc / 遮罩 / 右上角关闭 = 暂不处理:弹窗关掉但保存仍然暂停,
        // 状态栏留着可点入口。绝不静默继续 —— 再写一次就是又一次整篇覆盖
        onClose: () => { conflictModal = null; renderStatus(); },
      });
      conflictModal.handle = modal;
      conflictModal.body = modal.body.querySelector('.conflict-body');
      paintConflict();
    }

    /** 应用合并结果。结果与服务端现场完全一致时直接本地采用、不写库
     *  (省掉一次无意义的写入与版本 +1;全选"服务端"会走到这条路)。 */
    function applyMerge() {
      if (!conflict || !mergePlan) return;
      const merged = mergePlan.merge(picks);
      const serverContent = conflict.content;
      const version = conflict.version;
      clearConflictState();
      if (merged === serverContent) {
        applyRemote(serverContent, version);
        UI.toast('已采用服务端版本', 'success');
        return;
      }
      if (editor) editor.setValue(merged, { preserveSelection: true });
      renderStats();
      renderOutline();
      if (mode === 'preview') renderPreview();
      baseVersion = version;   // 我们就是基于现场这一版合并的,写回去不会再撞
      // null 而不是 '':内容被清空时 '' 会让 saveContent 误判成"没有变化"而不发请求
      lastSaved = null;
      saveContent();
    }

    // ---------- 手动保存 ----------
    // 保存只在这个入口发生(保存按钮 / Ctrl+S / 保存并离开 / 应用合并结果后)。
    // 自动保存已整体移除:写一次就少一次撞冲突的机会,而每次写入都是用户的明确决定。
    // 传输不变:WS 已连走 content 消息,未连上降级 PUT /content(§8);两条都带 baseVersion。
    let pendingSave = null;   // WS 在途的那次保存(由回包或超时兑现)

    /**
     * 保存正文 + 标题。返回 Promise<boolean>:true = 都落库了,false = 有失败
     * (状态栏已说明原因)。「保存并离开」必须等它真成功才能放行,所以 WS 那条路
     * 也要等回包:发出去就算已保存的话,放行时可能根本没落库。
     */
    function saveContent() {
      if (!canEdit || destroyed) return Promise.resolve(false);
      if (conflict) { openConflictModal(); return Promise.resolve(false); }
      const title = titleEl.value.trim();
      const needTitle = title !== lastTitle && !!title;
      const content = value();
      const needContent = content !== lastSaved;
      if (!needTitle && !needContent) { renderStatus(); return Promise.resolve(true); }
      saving = true;
      saveError = false;
      renderStatus();
      const jobs = [];
      if (needTitle) jobs.push(saveTitle(title));
      if (needContent) jobs.push(sendContent(content));
      return Promise.all(jobs).then((rs) => {
        saving = false;
        renderStatus();
        return rs.every((ok) => ok !== false);
      });
    }

    function saveTitle(title) {
      return api(Endpoints.doc(docId), { method: 'PATCH', body: { title } })
        .then(() => {
          lastTitle = title;
          if (onTreeChanged) onTreeChanged();   // 树上的标题要跟着变
          return true;
        })
        .catch((e) => { saveError = true; UI.err(e); return false; });
    }

    function sendContent(content) {
      if (wsReady && ws && ws.readyState === WebSocket.OPEN) {
        return new Promise((resolve) => {
          const piece = { content, resolve, timer: null };
          // 回包可能永远不来(服务端卡住、链路半死)。等不到就按失败处理:不推进
          // lastSaved、不放行"保存并离开" —— 宁可让用户看到"保存失败"再试一次,
          // 也不要给出一个"已保存"的假象
          piece.timer = setTimeout(() => {
            if (pendingSave !== piece) return;
            pendingSave = null;
            saveError = true;
            renderStatus();
            resolve(false);
          }, SAVE_TIMEOUT_MS);
          pendingSave = piece;
          try { ws.send(JSON.stringify({ type: 'content', content, baseVersion })); }
          catch (e) { clearTimeout(piece.timer); pendingSave = null; saveError = true; UI.err(e); resolve(false); }
        });
      }
      return api(Endpoints.docContent(docId), { method: 'PUT', body: { content, baseVersion } })
        .then((r) => {
          lastSaved = content;
          if (r && r.version != null) baseVersion = r.version;
          return true;
        })
        .catch((e) => {
          if (e.status === 409 && e.detail) { enterConflict(e.detail); return false; }
          saveError = true;
          UI.err(e);
          return false;
        });
    }

    // 标题与正文共用同一个保存动作(只有正文手动、标题自动会造成"标题悄悄存了、
    // 正文没存"的错位)。输入只更新脏态,不发起写入。
    titleEl.addEventListener('input', () => { saveError = false; renderStatus(); });

    function onEditorChange() {
      saveError = false;
      renderStats();
      renderOutline();
      renderStatus();
      if (mode === 'preview') renderPreview();
      sendEditingTrue();
    }
    function onEditorCursor(cursor) {
      cursorEl.textContent = '行 ' + cursor.line + '，列 ' + cursor.column;
      // 预览态的高亮归滚动(见 scheduleOutlineActive);编辑态才跟光标
      if (mode !== 'preview') paintOutlineActive();
    }

    // presence:编辑中标记(§8)
    function sendEditing(editing) {
      if (wsReady && ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: 'presence', editing })); } catch (e) { /* 忽略 */ }
      }
    }
    const sendEditingTrue = UI.debounce(() => sendEditing(true), 200);

    function updatePresence(users) {
      presenceHtml = (users || []).map((u) =>
        UI.avatar({
          name: u.name, seed: u.userId, size: 26, editing: u.editing, color: u.avatarColor,
          title: (u.name || '') + (u.editing ? '(编辑中)' : ''),
        })
      ).join('');
      presenceEl.innerHTML = presenceHtml;
    }

    // 服务端会主动关闭连接的"不可恢复"关闭码:身份/文档状态不会因为重连而改变,
    // 继续重连只是每 3 秒打一次服务端
    const WS_FATAL = {
      4401: { text: '登录已失效,请重新登录', kind: 'danger', toLogin: true },
      4403: { text: '你已不在该项目中或权限已变更,实时协作已断开', kind: 'warning' },
      4404: { text: '文档不存在或已被删除', kind: 'warning' },
    };

    function connectWs() {
      if (destroyed) return;  // 视图已销毁:失败重试的定时器/在途 init 都可能走到这里
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      // 同源连接,浏览器自动带 Cookie(§8)
      ws = new WebSocket(proto + '://' + location.host + '/ws/docs/' + docId);
      ws.onopen = () => { wsReady = true; };
      ws.onmessage = (ev) => {
        // 收到任何消息 = 这条连接真的被服务端接纳了(服务端在注册后立刻广播
        // presence),此时才清零重试计数。不能写在 onopen:服务端是"先 accept 再
        // 鉴权/出错关闭",被踢的连接也会触发 onopen —— 那样"最多重连 3 次"永不
        // 生效,变成每 3 秒无限重连,每次重连又去查库,反过来把服务端拖住。
        wsRetries = 0;
        let msg;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        if (msg.type === 'presence') {
          updatePresence(msg.users || []);
        } else if (msg.type === 'saved') {
          // 兑现这次在途的保存:确认落库后才推进 lastSaved / 基线
          if (pendingSave) {
            const piece = pendingSave;
            pendingSave = null;
            clearTimeout(piece.timer);
            lastSaved = piece.content;
            markSaved();
            piece.resolve(true);
          }
          if (msg.version != null) baseVersion = msg.version;
        } else if (msg.type === 'conflict') {
          // 服务端拒绝了这次保存(基线过期)。已有冲突时只刷新"服务端那一侧"
          if (pendingSave) {
            const piece = pendingSave;
            pendingSave = null;
            clearTimeout(piece.timer);
            piece.resolve(false);
          }
          // remote 是"文档状态"消息(content/version),在此换算成冲突现场形状
          const server = { currentContent: msg.content, currentVersion: msg.version, by: msg.by };
          if (conflict) refreshConflict(server); else enterConflict(server);
        } else if (msg.type === 'remote') {
          // 冲突未解决期间:别人再保存只更新现场,不打扰(remote 换算成冲突现场形状)
          if (conflict) {
            refreshConflict({ currentContent: msg.content, currentVersion: msg.version, by: msg.by });
            return;
          }
          // §8 客户端行为:编辑器无焦点且没有未保存改动 → 直接 setValue;否则提示条
          if (!canEdit || (!editorFocused && !dirty())) {
            pendingRemote = null;
            remoteBar.hidden = true;
            applyRemote(msg.content, msg.version);
          } else {
            pendingRemote = msg;
            remoteMsg.textContent = (msg.by || '其他成员') + ' 更新了文档';
            remoteBar.hidden = false;
          }
        }
      };
      ws.onclose = (ev) => {
        wsReady = false;
        if (destroyed) return;
        const fatal = WS_FATAL[ev.code];
        if (fatal) {
          UI.toast(fatal.text, fatal.kind);
          if (fatal.toLogin) location.hash = '#/login';
          return;
        }
        // 异常断开:最多重连 3 次,指数退避 + 抖动(多标签同时断线时别一起打服务端)。
        // 断开期间保存自动降级为 PUT /content,功能不受影响;超过 3 次就停,不再空转。
        if (wsRetries < 3) {
          wsRetries++;
          const delay = Math.min(30000, 3000 * Math.pow(2, wsRetries - 1)) + Math.random() * 1000;
          if (wsRetryTimer) clearTimeout(wsRetryTimer);
          wsRetryTimer = setTimeout(() => { wsRetryTimer = null; if (!destroyed) connectWs(); }, delay);
        }
      };
      ws.onerror = () => { try { ws.close(); } catch (e) { /* 忽略 */ } };
    }

    frag.querySelector('#btn-load-latest').onclick = () => {
      const r = pendingRemote;
      pendingRemote = null;
      remoteBar.hidden = true;
      if (!r) return;
      // 有未保存改动时不是"覆盖",而是打开逐块合并(基线用最新的远端版本,写完不会再撞)。
      // 旧文案「加载最新」是个静默丢改动的按钮:点一下自己的字就没了
      // GET 文档返回的是"文档状态"形状(content/version),在此换算成冲突现场形状
      if (dirty()) { enterConflict({ currentContent: r.content, currentVersion: r.version, by: r.by }); return; }
      applyRemote(r.content, r.version);
    };

    /** 「···」菜单 = 文档级杂项的唯一收纳处(历史版本在此,状态摘要也在)。
     *  items 用函数形态:每次打开取实时的状态文案 —— 状态行是只读事实(走 custom),
     *  冲突时附一条可点的处理入口。 */
    function buildMoreMenu() {
      const head = document.createElement('div');
      head.className = 'menu-header';
      head.innerHTML =
        '<div class="head-more-status">' + UI.esc(statusEl.textContent || '—') + '</div>' +
        (presenceHtml ? '<div class="head-more-presence">' + presenceHtml + '</div>' : '');
      const items = [{ custom: head }];
      if (conflict) items.push({
        icon: 'error-warning-line', label: '处理正文冲突', danger: true,
        onClick: openConflictModal,
      });
      items.push({
        icon: 'history-line', label: '历史版本',
        onClick: () => openHistoryModal(docId, canEdit, () => reloadDoc(), () => dirty()),
      });
      return items;
    }
    if (moreBtn) UI.dropdownMenu(moreBtn, buildMoreMenu, { align: 'end' });

    // 状态栏在冲突态下是重开弹窗的入口(弹窗用 Esc/遮罩关掉后从这里回来)
    statusEl.addEventListener('click', () => { if (conflict) openConflictModal(); });

    async function reloadDoc() {
      try {
        const doc = await api(Endpoints.doc(docId));
        // 走到这里 = 用户刚做了一次显式的服务端动作(如恢复历史版本),
        // 本地那份已被放弃,冲突随之消解(否则保存会一直卡在暂停态)
        clearConflictState();
        applyRemote(doc.content, doc.version);
        titleEl.value = doc.title || '';
        lastTitle = doc.title || '';
        spaceName = (doc.location && doc.location.projectName) || '';
        updatedAt = doc.updatedAt || '';
        spaceEl.textContent = spaceName;
        renderMeta();
        renderStatus();
        loadBacklinks();
        if (onTreeChanged) onTreeChanged();
      } catch (e) { UI.err(e); }
    }

    // ---------- 手动保存与"离开前提示"的入口 ----------
    if (saveBtn) saveBtn.addEventListener('click', () => saveContent());

    // 窄屏底部工具条(≤720 由 CSS 显示):命令统一走门面 runCommand,视图不碰编辑器状态。
    // mousedown 阻止默认:按钮不抢走编辑器焦点,选区与光标保持原样(链接在对话框里收地址)
    if (toolbarEl) {
      toolbarEl.addEventListener('mousedown', (event) => {
        if (event.target.closest('button')) event.preventDefault();
      });
      toolbarEl.addEventListener('click', (event) => {
        const button = event.target.closest('button[data-command]');
        if (!button || !editor) return;
        editor.runCommand(button.dataset.command);
        if (button.dataset.command !== 'link') editor.focus();
      });
    }

    // CM 内由门面键位处理；标题、预览等区域仍由文档视图接住保存快捷键。
    function onKeydown(e) {
      if (sourceHost.contains(e.target)) return;
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        saveContent();
      }
    }
    document.addEventListener('keydown', onKeydown);

    /** 没保存就别走。机制在 app.js(hashchange 先问守卫),这里只给策略。
     *  同一套拦截覆盖:点文档树切文档、点侧栏切路由,以及关闭标签/刷新(beforeunload)。 */
    App.onLeaveGuard(async () => {
      if (destroyed || !canEdit || !dirty()) return true;
      if (leavePromptOpen) return false;   // 已经问过一次,别叠弹窗
      leavePromptOpen = true;
      try {
        const choice = await UI.modal({
          title: '有未保存的改动',
          body: '<p class="pv-note">这篇文档的改动还没有保存到服务器。</p>',
          actions: [
            { kind: 'text', label: '取消', value: 'cancel' },
            { kind: 'text', label: '放弃改动并离开', value: 'discard' },
            { kind: 'filled', label: '保存并离开', value: 'save' },
          ],
        }).result;
        if (choice === 'discard') {
          // 先把脏态清掉再放行,否则下一次守卫还会再问一遍
          lastSaved = value();
          lastTitle = titleEl.value.trim() || '';
          return true;
        }
        if (choice !== 'save') return false;    // 取消 / Esc / 遮罩
        return !!(await saveContent());         // 存成功才放行:失败与冲突都不放
      } finally { leavePromptOpen = false; }
    });

    // 关闭标签 / 刷新:浏览器只认这一种拦截方式(提示文案由浏览器给,改不了)
    onBeforeUnload = (e) => {
      if (destroyed || !canEdit || !dirty()) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    ctx.dispose(() => { document.removeEventListener('keydown', onKeydown); });

    // ---------- 反链栏:引用了本文档的文档(正文里的 teamdoc://doc/{id}) ----------
    // 引用不带项目归属,所以来源**可能是别的项目**(文档被移走后尤其如此):
    // 每条带自己的 projectId,点击按它跳转;跨项目的额外标出来源项目名。
    const backlinksEl = frag.querySelector('#doc-backlinks');
    async function loadBacklinks() {
      try {
        const rows = await api(Endpoints.docBacklinks(docId));
        if (destroyed) return;
        if (!rows || !rows.length) { backlinksEl.hidden = true; return; }
        backlinksEl.hidden = false;
        backlinksEl.innerHTML = '<span>被引用</span>' + rows.map((d) => {
          const other = d.projectId !== projectId;
          return '<button type="button" class="bl-chip" data-id="' + UI.esc(d.id) +
            '" data-pid="' + UI.esc(d.projectId) + '" title="' +
            UI.esc((other ? d.projectName + ' / ' : '') + '更新于 ' + UI.fmtDate(d.updatedAt)) + '">' +
            UI.esc(d.title) + (other ? '<span class="bl-proj">' + UI.esc(d.projectName) + '</span>' : '') +
            '</button>';
        }).join('');
      } catch (e) { if (!destroyed) backlinksEl.hidden = true; }
    }
    backlinksEl.addEventListener('click', (e) => {
      const b = e.target.closest('.bl-chip');
      if (!b) return;
      location.hash = App.route.project(b.dataset.pid || projectId, 'docs', b.dataset.id);
    });

    // 上传:POST /api/files/upload(带 docId),图片带 inline=1 便于预览直显。
    // 只报"这是某篇文档的附件",落到哪个项目、哪个目录由服务端决定 ——
    // 文档可能刚被移动到别的项目,前端手里的 projectId 会过期;而「文档附件」
    // 这个目录名是服务端的约定,客户端不该按名字去猜(见 files.upload_file)。
    async function uploadFile(f) {
      // raw body 上传:元数据走 query string,URL 构造收在 FilesAPI.upload
      // 走 apiUpload 而不是 api():api() 的 30 秒总超时对上传是错的,稍大的附件
      // 必然在传完之前被 abort;apiUpload 只做"空闲超时"(见 api.js)
      const rec = await apiUpload(FilesAPI.upload({ docId, name: f.name }), f);
      const meta = rec && (rec.file || rec);
      const fid = meta && meta.id;
      if (!fid) throw new Error('上传响应缺少文件 id');
      // 是否插成原生 ![](...) = 图片类型 且 服务端 inline 白名单(UI.isEmbedImage):
      // canInline 单独不够 —— 白名单还覆盖 PDF 与全部文本类,插 ![](...) 只会得到坏图;
      // 不加 inline=1 的类型走附件链接(强制下载),语义也一致
      const embedImage = UI.isEmbedImage(meta.mime, meta.canInline);
      return { name: f.name, url: FilesAPI.download(fid, embedImage), isImage: embedImage };
    }

    async function init() {
      if (!window.DocEditor) {
        scrollEl.innerHTML = UI.banner({ kind: 'danger', icon: 'error-warning-line', text: '编辑器资源未加载' });
        return;
      }
      editor = DocEditor.mount(sourceHost, {
        value: '', projectId, readOnly: !canEdit, upload: uploadFile,
        onChange: onEditorChange,
        onSave: saveContent,
        onFocus: () => { editorFocused = true; sendEditing(true); },
        onBlur: () => { editorFocused = false; sendEditing(false); },
        onCursor: onEditorCursor,
      });
      setMode(mode);
      try {
        const doc = await api(Endpoints.doc(docId));
        if (destroyed) return;
        // 路由纠正:文档已被移动到别的项目(书签/同事发的链接还是旧的)。
        // 当前页面的项目上下文已经不对 —— 左侧树里没有它、附件上传也会落到旧项目。
        // 用 replaceState 改地址再重渲:纠正而不是在错的项目里显示。
        // 这里必须整条链重建(页面身份变了),所以用 App.refresh 而不是本层自刷
        if (doc.projectId && doc.projectId !== projectId) {
          const name = (doc.location && doc.location.projectName) || '其他项目';
          UI.toast('这篇文档已移动到「' + name + '」,已切换到它的项目', 'info');
          history.replaceState(null, '', App.route.project(doc.projectId, 'docs', doc.id));
          App.refresh();
          return;
        }
        applyRemote(doc.content, doc.version);
        titleEl.value = doc.title || '';
        lastTitle = doc.title || '';
        spaceName = (doc.location && doc.location.projectName) || '';
        updatedAt = doc.updatedAt || '';
        spaceEl.textContent = spaceName;
        renderMeta();
        renderStatus();
        loadBacklinks();
      } catch (e) {
        renderStatus();
        UI.err(e);
        // 深链/旧书签指向一篇已删除或无权限的文档:编辑器区给一个说得清的出口,
        // 而不是留一片空白让人猜(左侧树仍在,可以点别的文档)
        // innerHTML 而不是 replaceChildren:后者的参数是**节点**,传字符串会把它当
        // 纯文本插进去 —— 页面上就会出现一段 <div class="banner">…</div> 源码。
        scrollEl.innerHTML = UI.banner({
          kind: 'danger', icon: 'error-warning-line',
          text: '打不开这篇文档:' + (e.message || '未知错误') + '(可能已被删除,或链接已失效)',
        });
        return;
      }
      connectWs();
    }

    // 标题先用文档树里的名字顶上(树里已有这份事实):切文档时第一帧就能看出打开的是
    // 哪一篇,而不是先看一秒"无标题文档"。它同时是脏判定的基线 —— 服务端那份标题就是它
    const knownTitle = docTitle ? docTitle() : '';
    if (knownTitle) { titleEl.value = knownTitle; lastTitle = knownTitle; }
    renderStatus();
    init();
    return frag;
  }

  // ---------- 历史版本模态框(左列表右预览;预览区复用 preview.js,与引用浮层同源) ----------

  /** 版本记录的**展示用词**。kind 是机制层的事实(models.DocVersion.kind),怎么称呼归界面:
   *  普通保存(默认档)不给注解 —— 整张列表通篇都是它,逐行标注只是噪音;
   *  只有回退点值得标出来,因为时间线里出现异常时用户得知道为什么。 */
  const VERSION_TAGS = {
    restore: { text: '回退前', title: '这里发生过一次版本回退,这一条是回退前的现场' },
  };

  /** 一版的展示事实,**唯一来源**:列表行与预览头部都只用它,不许各拼一套(会漂)。
   *  字数在挑版本时比时间更好认 —— "我删掉那一段之前是多大"一眼就能对上。 */
  function versionFacts(v) {
    const tag = VERSION_TAGS[v.kind];
    return {
      when: UI.fmtWhen(v.createdAt),
      size: Number(v.contentChars || 0).toLocaleString('zh-CN') + ' 字',
      who: (v.createdBy && v.createdBy.name) || '—',
      badge: tag ? UI.badge({ text: tag.text, title: tag.title, kind: 'primary', cls: 'xs' }) : '',
    };
  }

  /**
   * @param onRestored  恢复成功后的回调(编辑器侧传 reloadDoc)
   * @param hasUnsaved  可选:返回"当前是否有未保存改动"。恢复会覆盖本地内容,
   *                    有脏改动时确认框必须点明这一点(服务端存的是"还原前"的**已保存**内容)
   */
  async function openHistoryModal(docId, canEdit, onRestored, hasUnsaved) {
    const m = UI.modal({
      title: '历史版本',
      wide: true,
      body:
        '<div class="hv-layout">' +
        '<div class="hv-list" id="hv-list">' + UI.loadingRow() + '</div>' +
        '<div class="hv-preview" id="hv-preview"></div>' +
        '</div>',
    });
    const listEl = m.body.querySelector('#hv-list');
    const previewEl = m.body.querySelector('#hv-preview');
    let versions = null;

    try {
      // 作者名由服务端解析(与文件列表同一形状):静态页不做跨接口 join
      versions = (await api(Endpoints.docVersions(docId))) || [];
      if (!versions.length) {
        listEl.innerHTML = '<div class="muted small p-2">暂无历史版本</div>';
        previewEl.innerHTML = '<div class="muted small p-4">该文档还没有历史版本。</div>';
        return;
      }
      listEl.innerHTML = versions.map((v) => {
        const f = versionFacts(v);
        return UI.listRow({
          // 悬停给秒级完整时间:列表按分钟显示(便于扫读),同一分钟内那几条靠副文本区分
          attrs: 'data-vid="' + UI.esc(v.id) + '" title="' + UI.esc(UI.fmtDate(v.createdAt)) + '"',
          title: UI.esc(f.when),
          badges: f.badge,
          sub: UI.esc(f.who) + ' · ' + f.size,
        });
      }).join('');

      async function showVersion(vid) {
        // vid 可能来自 dataset(字符串),也可能来自 versions[i].id(数字),统一按 id 判定
        listEl.querySelectorAll('.list-row').forEach((x) =>
          x.classList.toggle('selected', x.dataset.vid === vid));
        const f = versionFacts(versions.find((x) => x.id === UI.idOf(vid)) || {});
        // 事实只在一处说(选中的那一行),这里只放"做了什么"与"能做什么":
        // 同一句话在列表与预览各写一遍,迟早会漂,而且窄栏里必然折行
        previewEl.innerHTML =
          '<div class="hv-actions">' +
            f.badge +
            (canEdit ? UI.btn({ id: 'hv-restore', label: '恢复到此版本', icon: 'restart-line', kind: 'filled', size: 'sm' }) : '') +
          '</div>' +
          '<div class="pv-body hv-body"></div>';
        // 预览与正文预览同一条渲染路径(preview.js:raw HTML 已转义防 XSS)
        Preview.fill(previewEl.querySelector('.hv-body'), {
          kind: 'markdown',
          text: api(Endpoints.docVersion(docId, vid)).then((r) => r.content || ''),
        });
        const btn = previewEl.querySelector('#hv-restore');
        if (btn) btn.addEventListener('click', async () => {
          // 服务端会把"还原前"的现场存成历史版本,所以你手上的**已保存**内容不会丢;
          // 但本地未保存的改动会被 reloadDoc 覆盖掉,这一点必须说清
          const extra = hasUnsaved && hasUnsaved() ? '\n你还有没保存的改动,恢复后会丢失。' : '';
          const ok = await UI.confirmDialog('恢复到此版本?当前内容会先自动存为历史版本。' + extra,
            { danger: false, okText: '恢复' });
          if (!ok) return;
          try {
            await api(Endpoints.docRestore(docId, vid), { method: 'POST' });
            m.close(true);
            UI.toast('已恢复到该版本', 'success');
            onRestored && onRestored();
          } catch (err) { UI.err(err); }
        });
      }

      listEl.addEventListener('click', (e) => {
        const item = e.target.closest('.list-row');
        if (item && item.dataset.vid) showVersion(item.dataset.vid);
      });
      // 打开即预览最新一个版本,不用再手点一下
      showVersion(versions[0].id);
    } catch (e) {
      listEl.innerHTML = UI.banner({ kind: 'danger', icon: 'error-warning-line', text: e.message, sm: true });
    }
  }

  return { level: level, openHistoryModal: openHistoryModal };
})();
