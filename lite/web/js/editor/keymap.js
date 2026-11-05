window.DocEditorKit = window.DocEditorKit || {};
(function (NS) {
  'use strict';

  NS.createKeymap = function (C, getView, commands, options) {
    function run(command) {
      return function () { commands.run(command); return true; };
    }
    function mod(key, command) { return { key: 'Mod-' + key, run: command }; }
    const bindings = [
      mod('s', function () { if (options.onSave) options.onSave(); return true; }),
      mod('b', run('bold')),
      mod('i', run('italic')),
      mod('u', run('underline')),
      mod('e', run('code')),
      mod('k', run('link')),
      mod('1', run('heading1')),
      mod('2', run('heading2')),
      mod('3', run('heading3')),
      mod('4', run('heading4')),
      mod('t', run('table')),
      mod('Shift-k', run('codeBlock')),
      mod('Shift-q', run('quote')),
      mod('Shift-]', run('ordered')),
      mod('Shift-[', run('unordered')),
      mod('Shift-x', run('todo')),
      mod('/', function () { commands.help(); return true; }),
      mod('d', C.selectNextOccurrence),
      { key: 'Enter', run: function () {
        const view = getView();
        const range = view.state.selection.main;
        const change = NS.markdown.tableRowAtEnter(view.state.doc.toString(), range.from, range.to);
        if (!change) return false;
        commands.apply(change);
        return true;
      } },
    ];
    return C.keymap.of(bindings.concat(
      // Markdown 续行:Enter 续列表/引用/待办/围栏,Backspace 删标记。
      // 放在自定义绑定之后:表格回车先由上面的 Enter 认领,其余交给它
      C.markdownKeymap,
      C.closeBracketsKeymap,
      C.historyKeymap,
      C.foldKeymap,
      C.completionKeymap,
      C.searchKeymap,
      C.defaultKeymap,
      [C.indentWithTab]
    ));
  };
})(window.DocEditorKit);
