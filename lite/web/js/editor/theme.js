window.DocEditorKit = window.DocEditorKit || {};
(function (NS) {
  'use strict';

  NS.createTheme = function (C) {
    const highlight = C.HighlightStyle.define([
      { tag: [C.tags.heading1, C.tags.heading2, C.tags.heading3, C.tags.heading4], color: 'var(--md-primary)', fontWeight: '600' },
      { tag: [C.tags.heading5, C.tags.heading6], color: 'var(--md-primary)', fontWeight: '600' },
      { tag: [C.tags.emphasis], fontStyle: 'italic' },
      { tag: [C.tags.strong], fontWeight: '600' },
      { tag: [C.tags.strikethrough], textDecoration: 'line-through' },
      { tag: [C.tags.link, C.tags.url], color: 'var(--md-primary)' },
      { tag: [C.tags.monospace], color: 'color-mix(in srgb, var(--md-primary) 65%, var(--md-on-surface))' },
      { tag: [C.tags.quote], color: 'var(--md-on-surface-variant)' },
      { tag: [C.tags.processingInstruction, C.tags.punctuation], color: 'var(--md-on-surface-variant)' },
      { tag: [C.tags.contentSeparator], color: 'var(--md-outline)', fontWeight: '600' },
      { tag: [C.tags.comment], color: 'var(--md-on-surface-variant)', fontStyle: 'italic' },
      { tag: [C.tags.keyword, C.tags.tagName], color: 'var(--md-primary)' },
      { tag: [C.tags.string, C.tags.number, C.tags.bool], color: 'color-mix(in srgb, var(--md-primary) 55%, var(--md-error))' },
      { tag: [C.tags.function(C.tags.variableName), C.tags.propertyName], color: 'color-mix(in srgb, var(--md-primary) 70%, var(--md-on-surface))' },
    ]);
    const theme = C.EditorView.theme({
      '&': {
        color: 'var(--md-on-surface)',
        backgroundColor: 'transparent',
        fontSize: 'var(--fs-prose)',
      },
      '.cm-content': {
        fontFamily: 'var(--font)',
        lineHeight: 'var(--lh-loose)',
        caretColor: 'var(--md-primary)',
        padding: '0 0 45vh',
      },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--md-primary)' },
      '&.cm-focused': { outline: 'none' },
      '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
        backgroundColor: 'color-mix(in srgb, var(--md-primary) 22%, transparent)',
      },
      '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--md-primary) 14%, transparent)' },
      '.cm-panels': {
        color: 'var(--md-on-surface)',
        backgroundColor: 'var(--md-surface-container-low)',
        borderColor: 'var(--md-outline-variant)',
      },
      '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--md-outline-variant)' },
      '.cm-search': { padding: 'var(--sp-2)', gap: 'var(--sp-1)' },
      '.cm-search input, .cm-search button': { font: 'inherit', fontSize: 'var(--fs-label)' },
      '.cm-search input': {
        color: 'var(--md-on-surface)',
        backgroundColor: 'var(--md-surface)',
        border: '1px solid var(--md-outline-variant)',
        borderRadius: 'var(--radius-s)',
        padding: 'var(--sp-1) var(--sp-2)',
      },
      '.cm-search button': {
        color: 'var(--md-on-surface)',
        backgroundColor: 'var(--md-surface-container-high)',
        border: 'none',
        borderRadius: 'var(--radius-s)',
      },
      '.cm-tooltip': {
        color: 'var(--md-on-surface)',
        backgroundColor: 'var(--md-surface-container-high)',
        border: '1px solid var(--md-outline-variant)',
        borderRadius: 'var(--radius-m)',
      },
    });
    return [theme, C.syntaxHighlighting(highlight, { fallback: true })];
  };
})(window.DocEditorKit);
