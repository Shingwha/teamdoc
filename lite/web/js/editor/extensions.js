window.DocEditorKit = window.DocEditorKit || {};
(function (NS) {
  'use strict';

  /** 三连反引号补闭合围栏:在空行上敲下第三个反引号时,一次写成
   *  ``` / 空行 / ```,并把光标放进代码块。
   *  只在"行内恰好已有两个反引号 + 光标在行尾"时触发 —— 任何别的位置都是
   *  正常输入。`view.composing` 为真时不介入:输入法组字期间的输入不能被改写。 */
  NS.createFenceInput = function (C) {
    return C.EditorView.inputHandler.of(function (view, from, to, text) {
      if (view.composing) return false;
      if (text !== '`' || from !== to) return false;
      const line = view.state.doc.lineAt(from);
      if (from !== line.to || line.text !== '``') return false;
      const insert = '```\n\n```';
      view.dispatch({
        changes: { from: line.from, to: line.to, insert },
        selection: { anchor: line.from + 4 },
        userEvent: 'input',
      });
      return true;
    });
  };

  /** 编辑器内的 Mod-k 归门面:链接插入由这里执行,capture 阶段截住按键,
   *  事件不再冒泡到 document 的全局命令面板。编辑器外的 Mod-k 照旧打开面板。
   *  只认不带 Shift/Alt 的 Mod-k,Mod-Shift-k(代码块)不受影响。 */
  NS.createModKGuard = function (C, io, options) {
    return C.ViewPlugin.define(function (view) {
      function onKeydown(event) {
        if (options.readOnly) return;   // 只读编辑器不拦:Mod-k 交给全局命令面板
        if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
        if (event.key !== 'k' && event.key !== 'K') return;
        event.preventDefault();
        event.stopPropagation();
        if (io && io.command) io.command('link');
      }
      view.dom.addEventListener('keydown', onKeydown, true);
      return {
        destroy: function () { view.dom.removeEventListener('keydown', onKeydown, true); },
      };
    });
  };

  NS.createExtensions = function (C, options, io) {
    const list = [
      C.history(),
      C.drawSelection(),
      C.dropCursor(),
      C.rectangularSelection(),
      C.crosshairCursor(),
      C.highlightSelectionMatches(),
      C.EditorView.lineWrapping,
      C.EditorView.contentAttributes.of({
        spellcheck: 'false',
        'aria-label': 'Markdown 文档正文',
      }),
      C.bracketMatching(),
      C.closeBrackets(),
      new C.LanguageSupport(C.markdownLanguage),
      C.search({ top: true }),
      C.EditorState.readOnly.of(!!options.readOnly),
      C.EditorView.editable.of(!options.readOnly),
      NS.createFenceInput(C),
    ];
    if (io && io.command) list.push(NS.createModKGuard(C, io, options));
    return list;
  };
})(window.DocEditorKit);
