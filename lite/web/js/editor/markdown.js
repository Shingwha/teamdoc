(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.DocEditorMarkdown = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function result(source, from, to, replacement, selectFrom, selectTo) {
    return {
      text: source.slice(0, from) + replacement + source.slice(to),
      from: from + selectFrom,
      to: from + (selectTo == null ? selectFrom : selectTo),
      changes: { from, to, insert: replacement },
    };
  }

  function wrap(source, from, to, before, after, placeholder) {
    const selected = source.slice(from, to);
    if (from >= before.length && source.slice(from - before.length, from) === before &&
        source.slice(to, to + after.length) === after) {
      const outerFrom = from - before.length;
      const outerTo = to + after.length;
      return result(source, outerFrom, outerTo, selected, before.length ? 0 : 0,
        selected.length);
    }
    const inner = selected || placeholder || '';
    return result(source, from, to, before + inner + after,
      before.length, before.length + inner.length);
  }

  function inline(source, from, to, kind) {
    const styles = {
      bold: ['**', '**', '加粗文字'],
      italic: ['*', '*', '斜体文字'],
      underline: ['<u>', '</u>', '下划线文字'],
      strike: ['~~', '~~', '删除线'],
      code: ['`', '`', '代码'],
    };
    const style = styles[kind];
    if (!style) throw new Error('未知行内格式: ' + kind);
    return wrap(source, from, to, style[0], style[1], style[2]);
  }

  function link(source, from, to, url) {
    const label = source.slice(from, to) || '链接';
    const cleanUrl = String(url || '').replace(/[\s()]/g, '');
    if (!cleanUrl) return null;
    const replacement = '[' + label.replace(/[[\]()\r\n]/g, ' ') + '](' + cleanUrl + ')';
    return result(source, from, to, replacement, replacement.length);
  }

  function selectedLines(source, from, to) {
    const start = source.lastIndexOf('\n', Math.max(0, from - 1)) + 1;
    let end = source.indexOf('\n', to);
    if (end < 0) end = source.length;
    return { start, end, text: source.slice(start, end) };
  }

  function lines(source, from, to, kind, value) {
    const range = selectedLines(source, from, to);
    const output = range.text.split('\n').map(function (line) {
      const plain = line.replace(/^\s*(?:#{1,6}\s+|>\s?|[-+]\s+\[.\]\s+|[-+]\s+|\d+\.\s+)/, '');
      if (kind === 'heading') return '#'.repeat(value) + ' ' + plain;
      if (kind === 'quote') return '> ' + plain;
      if (kind === 'ordered') return '1. ' + plain;
      if (kind === 'unordered') return '- ' + plain;
      if (kind === 'todo') return '- [ ] ' + plain;
      throw new Error('未知块格式: ' + kind);
    }).join('\n');
    return result(source, range.start, range.end, output, 0, output.length);
  }

  function codeBlock(source, from, to) {
    const selected = source.slice(from, to);
    const replacement = '```\n' + selected + '\n```';
    return result(source, from, to, replacement, 4, 4 + selected.length);
  }

  function table(source, from, to) {
    const selected = source.slice(from, to).trim();
    let cells = ['列 1', '列 2'];
    if (selected) {
      const row = selected.split('\n')[0].replace(/^\||\|$/g, '');
      cells = row.split('|').map(function (cell) { return cell.trim() || '列'; });
    }
    const header = '| ' + cells.join(' | ') + ' |';
    const separator = '| ' + cells.map(function () { return '---'; }).join(' | ') + ' |';
    const empty = '| ' + cells.map(function () { return '  '; }).join(' | ') + ' |';
    const replacement = header + '\n' + separator + '\n' + empty;
    return result(source, from, to, replacement, header.length + separator.length + 3,
      header.length + separator.length + 3);
  }

  function tableRowAtEnter(source, from, to) {
    if (from !== to) return null;
    const range = selectedLines(source, from, to);
    if (from !== range.end || !/^\s*\|.+\|\s*$/.test(range.text) || /\n/.test(range.text)) return null;
    if (/\|\s*:?-{3,}:?\s*(?:\||$)/.test(range.text)) return null;
    return table(source, range.start, range.end);
  }

  function headings(source) {
    const found = [];
    const re = /^(#{1,6})\s+(.+?)\s*#*\s*$/gm;
    let match;
    while ((match = re.exec(source))) {
      found.push({
        id: 'heading-' + (found.length + 1),
        level: match[1].length,
        text: match[2].trim(),
        pos: match.index,
      });
    }
    return found;
  }

  function stats(source) {
    const text = String(source || '');
    const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
    const words = (text.replace(/[\u3400-\u9fff\uf900-\ufaff]/g, ' ').match(/[\w'-]+/g) || []).length;
    const count = cjk + words;
    return {
      words: count,
      characters: text.replace(/\s/g, '').length,
      minutes: count ? Math.max(1, Math.ceil(count / 300)) : 0,
    };
  }

  return {
    inline,
    link,
    lines,
    codeBlock,
    table,
    tableRowAtEnter,
    headings,
    stats,
  };
});
