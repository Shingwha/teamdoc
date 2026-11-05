"""CodeMirror 6 vendor、门面与文档编辑主路径契约。"""
import functools
import http.server
import json
import re
import subprocess
import threading
import urllib.parse

import pytest

from _chrome import (dump_page, error_trap_js, find_chrome, login_js, read_report,
                     run_chrome, temp_page)
from _harness import WEB_DIR

ROOT = WEB_DIR.parent
EDITOR_SCRIPTS = """  <script src="/vendor/codemirror/editor.bundle.js"></script>
  <script src="/js/editor/markdown.js"></script>
  <script src="/js/editor/keymap.js"></script>
  <script src="/js/editor/theme.js"></script>
  <script src="/js/editor/extensions.js"></script>
  <script src="/js/editor/panels.js"></script>
  <script src="/js/editor/index.js"></script>
"""


def test_vendor_is_real_offline_iife_with_pinned_dependencies():
    bundle = WEB_DIR / "vendor" / "codemirror" / "editor.bundle.js"
    assert bundle.is_file() and bundle.stat().st_size > 100_000
    package = json.loads((ROOT / "tools" / "editor" / "package.json").read_text(encoding="utf-8"))
    assert (ROOT / "tools" / "editor" / "package-lock.json").is_file()
    for section in ("dependencies", "devDependencies"):
        assert all(not version.startswith(("^", "~")) for version in package[section].values())
    probe = """
const fs = require('fs'), vm = require('vm');
const context = {};
vm.createContext(context);
vm.runInContext(fs.readFileSync(process.argv[1], 'utf8'), context);
if (!context.CM6 || !context.CM6.EditorView || !context.CM6.EditorState ||
    !context.CM6.markdownLanguage || !context.CM6.closeBrackets || !context.CM6.search) {
  throw new Error('CM6 导出不完整');
}
if (!Array.isArray(context.CM6.markdownKeymap) ||
    !context.CM6.markdownKeymap.some(function (b) { return b.key === 'Enter'; }) ||
    typeof context.CM6.insertNewlineContinueMarkup !== 'function' ||
    typeof context.CM6.deleteMarkupBackward !== 'function') {
  throw new Error('markdownKeymap 未导出');
}
console.log('CM6_OK');
"""
    result = subprocess.run(
        ["node", "-e", probe, str(bundle)], capture_output=True, text=True, timeout=30, check=True,
    )
    assert "CM6_OK" in result.stdout


def test_view_uses_only_facade_and_old_textarea_enhancer_is_gone():
    source = (WEB_DIR / "js" / "views" / "doc-editor.js").read_text(encoding="utf-8")
    assert "DocEditor.mount" in source
    assert "DocEditor.enhance" not in source
    assert "CM6" not in source
    assert "<textarea" not in source and "ta.value" not in source
    assert not (WEB_DIR / "js" / "doceditor.js").exists()


def test_pure_markdown_transforms_in_node():
    script = """
const assert = require('assert');
const md = require(process.argv[1]);
let r = md.inline('hello world', 0, 5, 'bold');
assert.equal(r.text, '**hello** world');
assert.equal(r.from, 2);
assert.equal(r.to, 7);
r = md.inline('**hello** world', 2, 7, 'bold');
assert.equal(r.text, 'hello world');
r = md.lines('plain', 0, 5, 'heading', 2);
assert.equal(r.text, '## plain');
r = md.lines('one\\ntwo', 0, 7, 'todo');
assert.equal(r.text, '- [ ] one\\n- [ ] two');
r = md.tableRowAtEnter('|a|b|', 5, 5);
assert.equal(r.text, '| a | b |\\n| --- | --- |\\n|    |    |');
assert.deepEqual(md.headings('# A\\n## B').map(h => h.id), ['heading-1', 'heading-2']);
assert.equal(md.stats('你好 world').words, 3);
console.log('TRANSFORMS_OK');
"""
    result = subprocess.run(
        ["node", "-e", script, str(WEB_DIR / "js" / "editor" / "markdown.js")],
        capture_output=True, text=True, timeout=30, check=True,
    )
    assert "TRANSFORMS_OK" in result.stdout


FACADE_PROBE = EDITOR_SCRIPTS + """  <script>
__ERRTRAP_JS__
  </script>
  <script>
  window.addEventListener('load', function () {
    var out = {};
    var host = document.createElement('div');
    document.body.appendChild(host);
    var changes = 0, saves = 0;
    var editor = DocEditor.mount(host, {
      value: 'initial', projectId: 'test', upload: function () {},
      onChange: function () { changes++; }, onSave: function () { saves++; }
    });
    editor.setValue('abc', {preserveSelection: true});
    out.programmaticChanges = changes;
    out.valueAfterSet = editor.getValue();
    var content = host.querySelector('.cm-content');
    content.focus();
    document.execCommand('selectAll');
    var transfer = new DataTransfer();
    transfer.setData('text/plain', '用户输入');
    content.dispatchEvent(new ClipboardEvent('paste', {clipboardData: transfer, bubbles: true, cancelable: true}));
    setTimeout(function () {
      out.userChanges = changes;
      out.userValue = editor.getValue();
      content.dispatchEvent(new KeyboardEvent('keydown', {key: 's', ctrlKey: true, bubbles: true, cancelable: true}));
      out.saves = saves;
      content.focus();
      document.execCommand('selectAll');
      setTimeout(function () {
        editor.runCommand('bold');
        out.runCommand = editor.getValue().indexOf('**用户输入**') >= 0;
        var globalCtrlK = 0;
        document.addEventListener('keydown', function (e) {
          if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) globalCtrlK++;
        });
        content.focus();
        content.dispatchEvent(new KeyboardEvent('keydown', {key: 'k', ctrlKey: true, bubbles: true, cancelable: true}));
        setTimeout(function () {
          out.modKGlobal = globalCtrlK;
          out.modKDialog = !!document.querySelector('.modal-box');
          out.modKModals = document.querySelectorAll('.modal-box').length;
          UI.closeAllModals();
          out.headings = (editor.setValue('# A\\n## B'), editor.getHeadings().length);
          out.previewClass = (editor.setPreviewVisible(true), host.classList.contains('cm-preview-visible'));
          editor.destroy();
          out.destroyed = host.children.length;
          var pre = document.createElement('pre');
          pre.id = 'sweep-out';
          pre.textContent = ['errors=' + (window.__errors.join(' | ') || 'none')].concat(
            Object.keys(out).map(function (key) { return key + '=' + out[key]; })).join('\\n');
          document.body.appendChild(pre);
        }, 120);
      }, 120);
    }, 250);
  });
  </script>
"""


@pytest.mark.browser
def test_facade_browser_contract(base_url):
    chrome = find_chrome()
    if not chrome:
        pytest.skip("未找到 Chrome/Edge，跳过 CM6 门面巡检")
    with temp_page("_cm6_facade.html", FACADE_PROBE.replace("__ERRTRAP_JS__", error_trap_js())) as page:
        info = read_report(dump_page(chrome, base_url, page, budget=6000))
    assert info is not None
    assert info.get("errors") == "none"
    assert info.get("programmaticChanges") == "0"
    assert info.get("valueAfterSet") == "abc"
    assert info.get("userChanges") == "1"
    assert info.get("userValue") == "用户输入"
    assert info.get("saves") == "1"
    assert info.get("runCommand") == "true"
    assert info.get("modKGlobal") == "0", "编辑器内 Mod-k 冒泡到了全局命令面板"
    assert info.get("modKDialog") == "true", "编辑器内 Mod-k 没有走链接插入"
    assert info.get("modKModals") == "1", f"Mod-k 被重复处理: {info}"
    assert info.get("headings") == "2"
    assert info.get("previewClass") == "true"
    assert info.get("destroyed") == "0"


MARKDOWN_TYPE_PROBE = EDITOR_SCRIPTS + """  <script>
__ERRTRAP_JS__
  </script>
  <script>
  window.addEventListener('load', function () {
    var out = {};
    var host = document.createElement('div');
    document.body.appendChild(host);
    var editor = DocEditor.mount(host, { value: '', projectId: 'test' });
    var content = host.querySelector('.cm-content');
    function type(text, next) {
      content.focus();
      document.execCommand('insertText', false, text);
      setTimeout(next, 120);
    }
    function enter(next) {
      content.focus();
      content.dispatchEvent(new KeyboardEvent('keydown',
        {key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true}));
      setTimeout(next, 120);
    }
    function report() {
      var pre = document.createElement('pre');
      pre.id = 'sweep-out';
      pre.textContent = ['errors=' + (window.__errors.join(' | ') || 'none')].concat(
        Object.keys(out).map(function (key) { return key + '=' + out[key]; })).join('\\n');
      document.body.appendChild(pre);
    }
    setTimeout(function () {
      type('- item', function () {
        enter(function () {
          out.continued = editor.getValue() === '- item\\n- ';
          out.continuedValue = encodeURIComponent(editor.getValue());
          editor.setValue('');
          type('`', function () {
            type('`', function () {
              type('`', function () {
                out.fence = editor.getValue() === '```\\n\\n```';
                out.fenceCursor = editor.getCursor().line;
                editor.runCommand('todo');
                out.command = editor.getValue().indexOf('- [ ]') >= 0;
                report();
              });
            });
          });
        });
      });
    }, 200);
  });
  </script>
"""

@pytest.mark.browser
def test_markdown_continuation_and_fence_typing(base_url):
    chrome = find_chrome()
    if not chrome:
        pytest.skip("未找到 Chrome/Edge，跳过 Markdown 速录巡检")
    probe = MARKDOWN_TYPE_PROBE.replace("__ERRTRAP_JS__", error_trap_js())
    with temp_page("_cm6_typing.html", probe) as page:
        info = read_report(dump_page(chrome, base_url, page, budget=8000))
    assert info is not None
    assert info.get("errors") == "none"
    assert info.get("continued") == "true", f"列表回车没有续行: {info}"
    assert info.get("fence") == "true", f"三连反引号没有补闭合围栏: {info}"
    assert info.get("fenceCursor") == "2"
    assert info.get("command") == "true"


@pytest.mark.browser
def test_offline_fixture_panels_and_commands():
    chrome = find_chrome()
    if not chrome:
        pytest.skip("未找到 Chrome/Edge，跳过 CM6 离线交互巡检")
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        url = f"http://127.0.0.1:{server.server_address[1]}"
        dom = dump_page(chrome, url, "tests/fixtures/cm6-facade.html", budget=8000)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
    match = re.search(r'<pre id="result">(.*?)</pre>', dom, re.S)
    assert match and match.group(1) == "PASS", "离线 CM6 fixture 失败"


APP_PROBE = EDITOR_SCRIPTS + """  <script>
__LOGIN_JS__
__ERRTRAP_JS__
    window.__wsLog = [];
    window.WebSocket = new Proxy(window.WebSocket, {construct: function (Target, args) {
      var socket = new Target(...args), send = socket.send;
      socket.send = function (data) { window.__wsLog.push('send:' + data); return send.call(socket, data); };
      socket.addEventListener('message', function (event) { window.__wsLog.push('recv:' + event.data); });
      return socket;
    }});
  </script>
  <script src="/js/app.js"></script>
  <script>
  window.addEventListener('load', function () {
    var out = {}, doc = new URLSearchParams(location.search).get('doc');
    function report() {
      out.wsLog = window.__wsLog.join(' | ');
      out.saved = window.__wsLog.some(function (line) { return line.indexOf('recv:{"type":"saved"') === 0; });
      out.statusItems = document.querySelectorAll('.doc-statusbar > span').length;
      out.toolButtons = document.querySelectorAll('#doc-toolbar .doc-tool-btn').length;
      out.saveDot = document.querySelector('#save-status .status-dot') ? 1 : 0;
      out.metaWords = /字$/.test((document.querySelector('#doc-meta').textContent || '').trim()) ? 1 : 0;
      var pre = document.createElement('pre');
      pre.id = 'sweep-out';
      pre.textContent = ['errors=' + (window.__errors.join(' | ') || 'none')].concat(
        Object.keys(out).map(function (key) { return key + '=' + out[key]; })).join('\\n');
      document.body.appendChild(pre);
    }
    setTimeout(function () {
      location.hash = '#/p/' + new URLSearchParams(location.search).get('pid') + '/docs/' + doc;
      setTimeout(function () {
        out.realEditor = !!document.querySelector('#md-source .cm-editor');
        out.noTextarea = !document.querySelector('#md-source textarea');
        out.hash = location.hash;
        out.sourceHost = !!document.querySelector('#md-source');
        out.editorText = (document.querySelector('#doc-editor-col') || {}).textContent || '(missing)';
        out.editorText = out.editorText.slice(0, 120).replace(/\\n/g, ' ');
        var content = document.querySelector('#md-source .cm-content');
        if (!content) { report(); return; }
        content.focus();
        document.execCommand('selectAll');
        var transfer = new DataTransfer();
        transfer.setData('text/plain', '# 新标题\\n\\n浏览器输入');
        content.dispatchEvent(new ClipboardEvent('paste', {clipboardData: transfer, bubbles: true, cancelable: true}));
        setTimeout(function () {
          out.dirty = document.querySelector('#btn-save').disabled ? 0 : 1;
          document.querySelector('#btn-save').click();
          setTimeout(function () {
            out.saveStatus = document.querySelector('#save-status').textContent;
            out.saved = out.saveStatus.indexOf('已保存') >= 0;
            document.querySelector('#doc-mode-seg [data-key="preview"]').click();
            setTimeout(function () {
              out.preview = document.querySelector('#md-preview').textContent.indexOf('浏览器输入') >= 0;
              document.querySelector('#doc-mode-seg [data-key="edit"]').click();
              content = document.querySelector('#md-source .cm-content');
              content.focus();
              document.execCommand('selectAll');
              setTimeout(function () {
                document.execCommand('insertText', false, '@');
                setTimeout(function () {
                  out.refPanel = !!document.querySelector('.td-editor-panel');
                  var firstRef = document.querySelector('.td-editor-panel .menu-item');
                  if (firstRef) firstRef.click();
                  out.refInserted = document.querySelector('#md-source').textContent.indexOf('teamdoc://') >= 0;
                  report();
                }, 700);
              }, 100);
            }, 900);
          }, 6000);
        }, 250);
      }, 2800);
    }, 150);
  });
  </script>
"""


@pytest.mark.browser
def test_document_editor_browser_main_path(base_url, admin):
    chrome = find_chrome()
    if not chrome:
        pytest.skip("未找到 Chrome/Edge，跳过 CM6 文档主路径")
    project = admin.post("/api/projects", {"name": "CM6 浏览器契约", "description": "编辑器主路径"})
    assert project.status == 200
    pid = project.data["id"]
    doc = admin.post(f"/api/projects/{pid}/docs", {"title": "CM6 文档", "content": "初始"})
    assert doc.status == 200
    try:
        inject = APP_PROBE.replace("__LOGIN_JS__", login_js()).replace("__ERRTRAP_JS__", error_trap_js())
        query = urllib.parse.urlencode({"pid": pid, "doc": doc.data["id"]})
        with temp_page("_cm6_app.html", inject) as page:
            info = read_report(dump_page(chrome, base_url, page, query, budget=16000))
        saved = admin.get(f"/api/docs/{doc.data['id']}")
    finally:
        admin.delete(f"/api/projects/{pid}")
    assert info is not None
    assert info.get("errors") == "none"
    for key in ("realEditor", "noTextarea", "dirty", "saved", "preview", "refPanel", "refInserted"):
        assert info.get(key) in ("1", "true"), f"{key} 未通过: {info}"
    assert info.get("statusItems") == "5", f"状态栏五项未分开: {info}"
    assert info.get("toolButtons") == "7", f"窄屏工具条按钮缺失: {info}"
    assert info.get("saveDot") == "1", "保存状态没有圆点"
    assert info.get("metaWords") == "1", "元信息行没有字数"
    assert saved.status == 200 and "浏览器输入" in saved.data["content"]


WIDE_PROBE = EDITOR_SCRIPTS + """  <script>
__LOGIN_JS__
__ERRTRAP_JS__
  </script>
  <script src="/js/app.js"></script>
  <script>
  window.addEventListener('load', function () {
    var out = {};
    function report() {
      var pre = document.createElement('pre');
      pre.id = 'sweep-out';
      pre.textContent = ['errors=' + (window.__errors.join(' | ') || 'none')].concat(
        Object.keys(out).map(function (key) { return key + '=' + out[key]; })).join('\\n');
      document.body.appendChild(pre);
    }
    setTimeout(function () {
      var q = new URLSearchParams(location.search);
      location.hash = '#/p/' + q.get('pid') + '/docs/' + q.get('doc');
      setTimeout(function () {
        out.width = window.innerWidth;
        out.outlineBtn = document.querySelector('#btn-doc-outline') ? 1 : 0;
        document.querySelector('#doc-mode-seg [data-key="preview"]').click();
        setTimeout(function () {
          var canvas = document.querySelector('#editor-canvas');
          var splitBtn = document.querySelector('#btn-doc-split');
          out.split = canvas.classList.contains('preview-split') ? 1 : 0;
          out.sourceVisible = document.querySelector('#md-source').hidden ? 0 : 1;
          out.splitBtn = splitBtn ? (splitBtn.hidden ? 0 : 1) : 'missing';
          if (!splitBtn) { report(); return; }
          splitBtn.click();
          setTimeout(function () {
            out.collapsed = canvas.classList.contains('preview-split') ? 0 : 1;
            out.previewStill = document.querySelector('#md-preview').hidden ? 0 : 1;
            out.collapsePref = UI.pref.get('td:doc-split');
            out.expandBtn = document.querySelector('#btn-doc-split').hidden ? 0 : 1;
            document.querySelector('#btn-doc-split').click();
            setTimeout(function () {
              var src = document.querySelector('#md-source .cm-scroller');
              var prev = document.querySelector('#md-preview');
              // 虚拟时间不产帧:程序化 scrollTop 不会派发原生 scroll,这里补同形事件
              function scrollSrc(top) {
                src.scrollTop = top;
                src.dispatchEvent(new Event('scroll'));
              }
              UI.pref.set('td:preview-link', 'false');
              prev.scrollTop = 0;
              scrollSrc(200);
              setTimeout(function () {
                out.linkOffTop = Math.round(prev.scrollTop);
                UI.pref.set('td:preview-link', 'true');
                scrollSrc(0);
                setTimeout(function () {
                  scrollSrc(240);
                  setTimeout(function () {
                    out.linkOnTop = Math.round(prev.scrollTop);
                    prev.scrollTop = 400;
                    prev.dispatchEvent(new Event('scroll'));
                    setTimeout(function () {
                      out.reverseTop = Math.round(src.scrollTop);
                      document.querySelector('#btn-doc-outline').click();
                      prev.scrollTop = 0;
                      prev.dispatchEvent(new Event('scroll'));
                      setTimeout(function () {
                        var first = document.querySelector('#doc-outline-list button.active');
                        out.outlineFirst = first ? first.textContent : '(none)';
                        prev.scrollTop = prev.scrollHeight - prev.clientHeight;
                        prev.dispatchEvent(new Event('scroll'));
                        setTimeout(function () {
                          var last = document.querySelector('#doc-outline-list button.active');
                          out.outlineLast = last ? last.textContent : '(none)';
                          out.outlineMoved = out.outlineLast !== out.outlineFirst ? 1 : 0;
                          report();
                        }, 300);
                      }, 300);
                    }, 300);
                  }, 300);
                }, 200);
              }, 300);
            }, 400);
          }, 500);
        }, 1200);
      }, 2800);
    }, 150);
  });
  </script>
"""


def _dump_sized(chrome, base_url, page, query, width, height, budget):
    """按指定视口跑一次无头 Chrome(宽屏 pane 的 matchMedia 依赖真实窗口宽度)。"""
    url = f"{base_url}/{page}?{query}"
    return run_chrome(chrome, [
        "--headless=new", "--disable-gpu", "--no-sandbox",
        f"--window-size={width},{height}", f"--virtual-time-budget={budget}",
        "--dump-dom", url,
    ]).decode("utf-8", "replace")


@pytest.mark.browser
def test_wide_preview_pane_split_and_fold(base_url, admin):
    chrome = find_chrome()
    if not chrome:
        pytest.skip("未找到 Chrome/Edge，跳过宽屏预览 pane 巡检")
    project = admin.post("/api/projects", {"name": "CM6 宽屏契约", "description": "预览分栏"})
    assert project.status == 200
    pid = project.data["id"]
    doc = admin.post(f"/api/projects/{pid}/docs", {"title": "宽屏文档"})
    assert doc.status == 200
    long_md = "\n\n".join(f"## 小节 {i}\n\n" + "正文段落。" * 8 for i in range(1, 41))
    saved = admin.put(f"/api/docs/{doc.data['id']}/content", {"content": long_md, "baseVersion": 0})
    assert saved.status == 200
    try:
        inject = WIDE_PROBE.replace("__LOGIN_JS__", login_js()).replace("__ERRTRAP_JS__", error_trap_js())
        query = urllib.parse.urlencode({"pid": pid, "doc": doc.data["id"]})
        with temp_page("_cm6_wide.html", inject) as page:
            info = read_report(_dump_sized(chrome, base_url, page, query, 1400, 900, 16000))
    finally:
        admin.delete(f"/api/projects/{pid}")
    assert info is not None
    assert info.get("errors") == "none"
    assert int(info.get("width", "0")) >= 1280, f"宽屏视口未生效: {info}"
    assert info.get("outlineBtn") == "1", "≥1280 大纲按钮应可见"
    assert info.get("split") == "1" and info.get("sourceVisible") == "1", f"宽屏预览未分栏: {info}"
    assert info.get("splitBtn") == "1", "分栏折叠按钮不可见"
    assert info.get("collapsed") == "1" and info.get("previewStill") == "1", f"折叠未生效: {info}"
    assert info.get("collapsePref") == "0", "折叠偏好没有记住"
    assert info.get("expandBtn") == "1", "折叠后应可再展开"
    assert int(info.get("linkOffTop", "-1")) == 0, f"关闭联动后预览仍被带动: {info}"
    assert int(info.get("linkOnTop", "0")) > 0, f"开启联动后预览未跟随: {info}"
    assert int(info.get("reverseTop", "0")) > 0, f"预览滚动未反向带动源码: {info}"
    # 只钉行为契约:顶部有大纲高亮,滚动后高亮确实变化。具体落在哪一节受布局/时序影响,
    # 不作为断言(单跑绿、整组偶尔落到第二节,属于脆弱断言)。
    assert (info.get("outlineFirst") or "") not in ("", "(none)", "None"), \
        f"大纲没有初始高亮: {info}"
    assert info.get("outlineMoved") == "1", f"大纲未跟随预览滚动: {info}"


NARROW_PROBE = EDITOR_SCRIPTS + """  <script>
__LOGIN_JS__
__ERRTRAP_JS__
  </script>
  <script src="/js/app.js"></script>
  <script>
  window.addEventListener('load', function () {
    var out = {};
    function report() {
      var pre = document.createElement('pre');
      pre.id = 'sweep-out';
      pre.textContent = ['errors=' + (window.__errors.join(' | ') || 'none')].concat(
        Object.keys(out).map(function (key) { return key + '=' + out[key]; })).join('\\n');
      document.body.appendChild(pre);
    }
    setTimeout(function () {
      var q = new URLSearchParams(location.search);
      location.hash = '#/p/' + q.get('pid') + '/docs/' + q.get('doc');
      setTimeout(function () {
        out.width = window.innerWidth;
        var bar = document.querySelector('#doc-toolbar');
        var btn = bar && bar.querySelector('.doc-tool-btn');
        out.toolbarDisplay = bar ? getComputedStyle(bar).display : 'missing';
        out.touch = btn ? Math.round(btn.getBoundingClientRect().height) : 0;
        out.toolButtons = bar ? bar.querySelectorAll('.doc-tool-btn').length : 0;
        var items = document.querySelectorAll('.doc-statusbar > span');
        out.statusCount = items.length;
        var visible = 0;
        items.forEach(function (item) { if (item.getBoundingClientRect().width > 0) visible++; });
        out.statusVisible = visible;
        out.outlineHidden = getComputedStyle(document.querySelector('#btn-doc-outline')).display === 'none' ? 1 : 0;
        report();
      }, 2800);
    }, 150);
  });
  </script>
"""


@pytest.mark.browser
def test_narrow_toolbar_and_status_items(base_url, admin):
    chrome = find_chrome()
    if not chrome:
        pytest.skip("未找到 Chrome/Edge，跳过窄屏工具条巡检")
    project = admin.post("/api/projects", {"name": "CM6 窄屏契约", "description": "底部工具条"})
    assert project.status == 200
    pid = project.data["id"]
    doc = admin.post(f"/api/projects/{pid}/docs", {"title": "窄屏文档", "content": "正文"})
    assert doc.status == 200
    try:
        inject = NARROW_PROBE.replace("__LOGIN_JS__", login_js()).replace("__ERRTRAP_JS__", error_trap_js())
        query = urllib.parse.urlencode({"pid": pid, "doc": doc.data["id"]})
        with temp_page("_cm6_narrow.html", inject) as page:
            info = read_report(_dump_sized(chrome, base_url, page, query, 390, 844, 14000))
    finally:
        admin.delete(f"/api/projects/{pid}")
    assert info is not None
    assert info.get("errors") == "none"
    assert int(info.get("width", "0")) <= 720, f"窄屏视口未生效: {info}"
    assert info.get("toolbarDisplay") == "flex", f"窄屏底部工具条未显示: {info}"
    assert info.get("toolButtons") == "7"
    assert int(info.get("touch", "0")) >= 40, f"触控目标不足 40px: {info}"
    assert info.get("statusCount") == "5" and info.get("statusVisible") == "5", f"窄屏状态栏项被隐藏: {info}"
    assert info.get("outlineHidden") == "1", "<1280 大纲按钮应隐藏"


