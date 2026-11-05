window.DocEditor = (function () {
  'use strict';

  const NS = window.DocEditorKit;
  if (NS) NS.markdown = window.DocEditorMarkdown;
  const programmatic = NS && window.CM6 ? CM6.Annotation.define() : null;

  function mount(host, options) {
    options = options || {};
    if (!host || host.tagName === 'TEXTAREA') throw new Error('DocEditor.mount 需要 div 容器');
    if (!window.CM6 || !NS) throw new Error('CodeMirror 6 本地资源未加载');
    const C = CM6;
    let destroyed = false;
    let view;
    let panels;
    let previewVisible = false;
    host.replaceChildren();
    host.classList.add('cm-doc-editor');

    function apply(change) {
      if (!change || destroyed) return;
      view.dispatch({
        changes: change.changes,
        selection: { anchor: change.from, head: change.to },
        scrollIntoView: true,
        userEvent: 'input',
      });
    }

    const commands = {
      apply,
      run: function (name) {
        if (destroyed) return;
        const range = view.state.selection.main;
        const source = view.state.doc.toString();
        let change = null;
        if (['bold', 'italic', 'underline', 'strike', 'code'].includes(name)) {
          change = NS.markdown.inline(source, range.from, range.to, name);
        } else if (name === 'link') {
          UI.inputDialog({ title: '插入链接', label: '链接地址', placeholder: 'https://…' }).then(function (url) {
            if (destroyed || !url) return;
            const current = view.state.selection.main;
            apply(NS.markdown.link(view.state.doc.toString(), current.from, current.to, Ref.url(url)));
            view.focus();
          });
          return;
        } else if (/^heading[1-4]$/.test(name)) {
          change = NS.markdown.lines(source, range.from, range.to, 'heading', Number(name.slice(-1)));
        } else if (['quote', 'ordered', 'unordered', 'todo'].includes(name)) {
          change = NS.markdown.lines(source, range.from, range.to, name);
        } else if (name === 'codeBlock') {
          change = NS.markdown.codeBlock(source, range.from, range.to);
        } else if (name === 'table') {
          change = NS.markdown.table(source, range.from, range.to);
        }
        apply(change);
      },
      help: function () {
        UI.modal({
          title: 'Markdown 快捷键',
          body: '<div class="editor-shortcuts">' +
            '<span>加粗 / 斜体 / 下划线</span><kbd>Ctrl+B / I / U</kbd>' +
            '<span>行内代码 / 链接</span><kbd>Ctrl+E / K</kbd>' +
            '<span>一至四级标题</span><kbd>Ctrl+1…4</kbd>' +
            '<span>表格 / 代码块</span><kbd>Ctrl+T / Ctrl+Shift+K</kbd>' +
            '<span>引用 / 列表 / 待办</span><kbd>Ctrl+Shift+Q / [ / ] / X</kbd>' +
            '<span>搜索替换 / 选中当前词</span><kbd>Ctrl+F / Ctrl+D</kbd>' +
            '<span>保存</span><kbd>Ctrl+S</kbd></div>',
          actions: [{ kind: 'filled', label: '知道了', value: true }],
        });
      },
    };

    const io = {
      apply,
      command: function (name) { commands.run(name); },
      replace: function (from, to, text, cursor) {
        const offset = cursor == null ? text.length : cursor;
        apply({ changes: { from, to, insert: text }, from: from + offset, to: from + offset });
      },
      insertText: function (text) { insertText(text); },
    };

    const updateListener = C.EditorView.updateListener.of(function (update) {
      if (destroyed) return;
      if (update.docChanged) {
        const external = update.transactions.every(function (tr) { return tr.annotation(programmatic); });
        if (!external && options.onChange) options.onChange(view.state.doc.toString());
      }
      if (update.selectionSet || update.docChanged) {
        if (options.onCursor) options.onCursor(getCursor());
      }
      if (update.focusChanged) {
        if (update.view.hasFocus && options.onFocus) options.onFocus();
        if (!update.view.hasFocus && options.onBlur) options.onBlur();
      }
      if (panels) panels.update(update);
    });

    const state = C.EditorState.create({
      doc: String(options.value == null ? '' : options.value),
      extensions: NS.createExtensions(C, options, io).concat([
        updateListener,
        NS.createKeymap(C, function () { return view; }, commands, options),
      ], NS.createTheme(C)),
    });
    view = new C.EditorView({ state, parent: host });
    panels = NS.createPanels(view, options, io);

    function getValue() { return view.state.doc.toString(); }

    function setValue(value, settings) {
      if (destroyed) return;
      settings = settings || {};
      const next = String(value == null ? '' : value);
      const old = view.state.selection.main;
      const anchor = settings.preserveSelection ? Math.min(old.anchor, next.length) : 0;
      const head = settings.preserveSelection ? Math.min(old.head, next.length) : 0;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: next },
        selection: { anchor, head },
        annotations: programmatic.of(true),
      });
    }

    function insertText(text) {
      if (destroyed) return;
      const range = view.state.selection.main;
      const insert = String(text == null ? '' : text);
      apply({ changes: { from: range.from, to: range.to, insert }, from: range.from + insert.length, to: range.from + insert.length });
    }

    function insertRef(item) {
      if (!item) return;
      let markdown = item.md;
      if (!markdown && item.title && item.id) markdown = Ref.docChip(item.title, item.id);
      if (!markdown && item.name && item.id) markdown = Ref.fileMarkdown(item);
      if (markdown) insertText(markdown + ' ');
    }

    function getCursor() {
      const head = view.state.selection.main.head;
      const line = view.state.doc.lineAt(head);
      return { line: line.number, column: head - line.from + 1 };
    }

    function getHeadings() { return NS.markdown.headings(getValue()); }

    function scrollToHeading(id) {
      const heading = getHeadings().find(function (item) { return item.id === id; });
      if (!heading) return false;
      view.dispatch({
        selection: { anchor: heading.pos },
        effects: C.EditorView.scrollIntoView(heading.pos, { y: 'start' }),
      });
      return true;
    }

    function setPreviewVisible(visible) {
      const next = !!visible;
      if (previewVisible !== next && options.onModeChange) options.onModeChange(next ? 'preview' : 'edit');
      previewVisible = next;
      host.classList.toggle('cm-preview-visible', previewVisible);
    }

    /** 执行一条文档命令(bold/italic/code/link/quote/ordered/unordered/todo/…)。
     *  窄屏底部工具条与视图按钮共用这一入口,视图不直接操作编辑器状态。 */
    function runCommand(name) {
      if (destroyed) return false;
      commands.run(String(name || ''));
      return true;
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      panels.destroy();
      view.destroy();
      host.replaceChildren();
      host.classList.remove('cm-doc-editor', 'cm-preview-visible');
    }

    return {
      getValue,
      setValue,
      insertText,
      insertRef,
      focus: function () { view.focus(); },
      getCursor,
      getHeadings,
      scrollToHeading,
      setPreviewVisible,
      runCommand,
      destroy,
    };
  }

  return { mount };
})();
