window.DocEditorKit = window.DocEditorKit || {};
(function (NS) {
  'use strict';

  const SLASH_ITEMS = [
    { key: 'h1', icon: 'h-1', label: '一级标题', command: 'heading1' },
    { key: 'h2', icon: 'h-2', label: '二级标题', command: 'heading2' },
    { key: 'h3', icon: 'h-3', label: '三级标题', command: 'heading3' },
    { key: 'ul', icon: 'list-unordered', label: '无序列表', command: 'unordered' },
    { key: 'ol', icon: 'list-ordered', label: '有序列表', command: 'ordered' },
    { key: 'todo', icon: 'list-check-3', label: '待办事项', command: 'todo' },
    { key: 'quote', icon: 'double-quotes-l', label: '引用', command: 'quote' },
    { key: 'code', icon: 'code-box-line', label: '代码块', command: 'codeBlock' },
    { key: 'table', icon: 'table-line', label: '表格', command: 'table' },
    { key: 'mermaid', icon: 'flow-chart', label: '图表(Mermaid)', snippet: '```mermaid\nflowchart LR\n  A[开始] --> B[结束]\n```\n', cursorBack: 5 },
    { key: 'hr', icon: 'separator', label: '分割线', snippet: '\n---\n' },
    { key: 'upload', icon: 'image-add-line', label: '上传图片 / 附件', upload: true },
  ];

  NS.createPanels = function (view, options, io) {
    let openPanel = null;
    let slash = null;
    let destroyed = false;
    let floatbar = null;
    let floatTimer = null;
    let searchSequence = 0;

    function rectAt(pos) {
      return view.coordsAtPos(Math.max(0, Math.min(pos, view.state.doc.length))) || view.dom.getBoundingClientRect();
    }

    function normalizePanel() {
      if (openPanel && openPanel.closed) { openPanel = null; slash = null; }
    }

    function closePanel() {
      if (openPanel) {
        const panel = openPanel;
        openPanel = null;
        panel.close();
      }
      slash = null;
    }

    function docItem(doc) {
      return {
        kind: '文档', kindLabel: '文档', icon: 'file-text-line',
        name: doc.title || '无标题文档', md: Ref.docChip(doc.title, doc.id),
      };
    }

    function fileItem(file) {
      const image = UI.isEmbedImage(file.mime, file.canInline);
      return {
        kind: '文件', kindLabel: image ? '图片' : '文件',
        icon: image ? 'image-line' : 'attachment-2', name: file.name, md: Ref.fileMarkdown(file),
      };
    }

    function loadDefaults() {
      return Promise.all([
        api(Endpoints.docTree(options.projectId)),
        api(Endpoints.files({ project_id: options.projectId })),
      ]).then(function (responses) {
        const flat = [];
        (function walk(nodes) {
          (nodes || []).forEach(function (node) { flat.push(node); walk(node.children); });
        })(responses[0]);
        const docs = flat.sort(function (a, b) { return a.updatedAt < b.updatedAt ? 1 : -1; })
          .slice(0, 6).map(docItem);
        const files = ((responses[1] && responses[1].files) || []).slice()
          .sort(function (a, b) { return a.createdAt < b.createdAt ? 1 : -1; })
          .slice(0, 4).map(fileItem);
        return docs.concat(files);
      });
    }

    function openRef(start) {
      closePanel();
      let defaults = null;
      const panel = UI.menuList({
        rect: rectAt(view.state.selection.main.head),
        cls: 'td-editor-panel',
        search: { placeholder: '搜索文档 / 文件…' },
        items: [],
        groupOf: function (item) { return item.kind; },
        itemHtml: function (item) {
          return UI.icon(item.icon) + '<span class="menu-name">' + UI.esc(item.name) + '</span>' +
            '<span class="menu-kind">' + UI.esc(item.kindLabel) + '</span>';
        },
        emptyHtml: function () { return UI.emptyHtml({ sm: true, title: '输入关键词，引用项目文档或云空间文件' }); },
        onPick: function (item) {
          const end = view.state.selection.main.head;
          io.replace(start, end, item.md + ' ');
          view.focus();
        },
        onBackspaceEmpty: function () {
          io.replace(start, view.state.selection.main.head, '');
          view.focus();
        },
        onInput: function (query) {
          const current = ++searchSequence;
          if (!query) { showDefaults(); return; }
          api(Endpoints.search({ q: query, type: 'all' })).then(function (response) {
            if (destroyed || panel.closed || current < searchSequence) return;
            const docs = ((response && response.docs) || []).slice(0, 6).map(docItem);
            const files = ((response && response.files) || []).slice(0, 4).map(fileItem);
            panel.render(docs.concat(files));
          }).catch(function () { if (!panel.closed) panel.render([]); });
        },
        onClose: function () { if (openPanel === panel) openPanel = null; },
      });
      function showDefaults() {
        const current = ++searchSequence;
        if (defaults) { panel.render(defaults); return; }
        loadDefaults().then(function (items) {
          if (destroyed || panel.closed || current < searchSequence) return;
          defaults = items;
          panel.render(items);
        }).catch(function () { if (!panel.closed) panel.render([]); });
      }
      openPanel = panel;
      showDefaults();
    }

    function slashQuery() {
      if (!slash) return '';
      const head = view.state.selection.main.head;
      return view.state.doc.sliceString(slash.start + 1, head);
    }

    function openSlash(start) {
      closePanel();
      slash = { start };
      const panel = UI.menuList({
        rect: rectAt(view.state.selection.main.head),
        cls: 'td-editor-panel',
        keyTarget: view.dom,
        tabPicks: true,
        items: SLASH_ITEMS,
        itemHtml: function (item) {
          return UI.icon(item.icon) + '<span class="menu-name">' + UI.esc(item.label) + '</span>';
        },
        emptyHtml: function () { return UI.emptyHtml({ sm: true, title: '无匹配组件' }); },
        onPick: function (item) {
          const from = slash ? slash.start : start;
          const to = view.state.selection.main.head;
          openPanel = null;
          slash = null;
          if (item.upload) {
            io.replace(from, to, '');
            pickFile();
            return;
          }
          if (item.snippet != null) {
            io.replace(from, to, item.snippet, item.snippet.length - (item.cursorBack || 0));
          } else {
            io.replace(from, to, '');
            io.command(item.command);
          }
          view.focus();
        },
        onClose: function () { if (openPanel === panel) { openPanel = null; slash = null; } },
      });
      openPanel = panel;
    }

    function filterSlash() {
      if (!slash || !openPanel) return;
      const head = view.state.selection.main.head;
      if (head < slash.start + 1 || view.state.doc.sliceString(slash.start, slash.start + 1) !== '/') {
        closePanel();
        return;
      }
      const query = slashQuery().toLowerCase();
      if (/\s/.test(query)) { closePanel(); return; }
      openPanel.render(SLASH_ITEMS.filter(function (item) {
        return !query || item.label.toLowerCase().includes(query) || item.key.startsWith(query);
      }));
    }

    function uploadFiles(files) {
      if (options.readOnly || !options.upload) return;
      Array.from(files || []).forEach(function (file) {
        options.upload(file).then(function (record) {
          if (destroyed) return;
          const markdown = (record.isImage ? '!' : '') + '[' + Ref.text(record.name) + '](' + Ref.url(record.url) + ')';
          io.insertText(markdown);
          view.focus();
        }).catch(function (error) {
          if (!destroyed) UI.toast('上传失败：' + file.name + '（' + (error.message || '') + '）', 'danger');
        });
      });
    }

    function pickFile() {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.addEventListener('change', function () { uploadFiles(input.files); });
      input.click();
    }

    function buildFloatbar() {
      const commands = [
        ['bold', 'bold', '加粗'], ['italic', 'italic', '斜体'],
        ['strike', 'strikethrough', '删除线'], ['code', 'code-line', '行内代码'],
        ['link', 'link', '链接'],
      ];
      const bar = document.createElement('div');
      bar.className = 'td-floatbar';
      bar.hidden = true;
      commands.forEach(function (item) {
        const wrap = document.createElement('span');
        wrap.innerHTML = UI.iconBtn({ icon: item[1], title: item[2], cls: 'float-btn' });
        const button = wrap.firstElementChild;
        button.addEventListener('mousedown', function (event) { event.preventDefault(); });
        button.addEventListener('click', function () { io.command(item[0]); hideFloat(); view.focus(); });
        bar.appendChild(button);
      });
      document.body.appendChild(bar);
      return bar;
    }

    function hideFloat() { if (floatbar) floatbar.hidden = true; }

    function scheduleFloat() {
      normalizePanel();
      clearTimeout(floatTimer);
      floatTimer = setTimeout(function () {
        if (destroyed || openPanel || view.composing || !view.hasFocus || view.state.selection.main.empty) {
          hideFloat();
          return;
        }
        const range = view.state.selection.main;
        const rect = rectAt(range.from);
        if (!floatbar) floatbar = buildFloatbar();
        floatbar.hidden = false;
        const width = floatbar.offsetWidth;
        const height = floatbar.offsetHeight;
        const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
        let top = rect.top - height - 8;
        if (top < 8) top = Math.min(rect.bottom + 8, window.innerHeight - height - 8);
        floatbar.style.left = left + 'px';
        floatbar.style.top = Math.max(8, top) + 'px';
      }, 80);
    }

    function onPaste(event) {
      const files = event.clipboardData && event.clipboardData.files;
      if (files && files.length) { event.preventDefault(); uploadFiles(files); }
    }
    function onDrop(event) {
      const files = event.dataTransfer && event.dataTransfer.files;
      if (!files || !files.length) return;
      event.preventDefault();
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos != null) view.dispatch({ selection: { anchor: pos } });
      uploadFiles(files);
    }
    function onDragOver(event) {
      if (event.dataTransfer && Array.from(event.dataTransfer.types || []).includes('Files')) event.preventDefault();
    }
    function onCompositionStart() { if (slash) closePanel(); hideFloat(); }
    function onDocumentDown(event) {
      if (floatbar && !floatbar.contains(event.target) && !view.dom.contains(event.target)) hideFloat();
    }
    function onScroll(event) { if (!floatbar || !floatbar.contains(event.target)) hideFloat(); }

    view.dom.addEventListener('paste', onPaste);
    view.dom.addEventListener('drop', onDrop);
    view.dom.addEventListener('dragover', onDragOver);
    view.dom.addEventListener('compositionstart', onCompositionStart);
    document.addEventListener('pointerdown', onDocumentDown, true);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);

    return {
      update: function (update) {
        if (destroyed) return;
        normalizePanel();
        if (update.docChanged || update.selectionSet || update.focusChanged) scheduleFloat();
        if (update.docChanged && !view.composing && !options.readOnly) {
          const typed = update.transactions.some(function (tr) { return tr.isUserEvent('input.type'); });
          if (slash) filterSlash();
          if (!typed) return;
          const head = view.state.selection.main.head;
          const text = view.state.doc.toString();
          if (slash) return;
          if (text.slice(head - 2, head) === '[[') openRef(head - 2);
          else if (text.charAt(head - 1) === '@') openRef(head - 1);
          else if (text.charAt(head - 1) === '/') {
            const line = view.state.doc.lineAt(head);
            if (/^\s*$/.test(line.text.slice(0, head - line.from - 1))) openSlash(head - 1);
          }
        }
      },
      command: function (name) { if (name === 'upload') pickFile(); },
      close: closePanel,
      destroy: function () {
        destroyed = true;
        clearTimeout(floatTimer);
        closePanel();
        view.dom.removeEventListener('paste', onPaste);
        view.dom.removeEventListener('drop', onDrop);
        view.dom.removeEventListener('dragover', onDragOver);
        view.dom.removeEventListener('compositionstart', onCompositionStart);
        document.removeEventListener('pointerdown', onDocumentDown, true);
        document.removeEventListener('scroll', onScroll, true);
        window.removeEventListener('resize', onScroll);
        if (floatbar) floatbar.remove();
        floatbar = null;
      },
    };
  };
})(window.DocEditorKit);
