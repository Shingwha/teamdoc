// views/docs.js — 文档模块作用域(#/p/{id}/docs[/{docId}]):唯一文档树(左栏)+ 编辑区
//   两层作用域各管一件事:
//     p/{pid}/docs        文档模块层 —— 切文档时它**原样留着**:树不重取、不重绘,
//                         折叠态与滚动位置都在
//     p/{pid}/docs/{id|}  文档位层 —— 唯一随文档切换重建的那一层:编辑器(views/doc-editor.js)
//                         或"未选文档"空态
//
//   文档树只出现在壳的左栏(#side-doc-tree),主区不再有第二棵树;离开文档模块时
//   本层把左栏槽位清空(数据的生命期 = 区域的生存期)。
//
//   作用域契约见 ARCHITECTURE.md「渲染契约」。
window.Views = window.Views || {};
(function () {
  'use strict';

  // 折叠态按项目记(与侧栏展开态同一口径):离开文档模块再回来不收回。
  // 它是用户的选择,不是可以被重新渲染出来的派生值
  const collapsedByProject = new Map();

  /** 文档模块的骨架:主区只有编辑位(树在左栏,由本模块的 render 填充) */
  window.Views.docsSkeleton = function () {
    return '<div class="doc-editor-col"><div class="editor-canvas"><div class="doc-content">' +
      UI.skeleton('lines', 8) +
      '</div></div></div>';
  };

  window.Views.docsLevel = function (r) {
    const pid = r.pid;
    const proj = r.proj;
    const canEdit = UI.canEdit(proj);   // EDITOR 及以上可写;VIEWER 只读
    const collapsed = collapsedByProject.get(pid) || new Set();
    collapsedByProject.set(pid, collapsed);

    let treeData = [];
    let treeEl = null;
    let sideHost = null;

    /** 当前打开的文档 id:**现读当前路由**,不闭包快照 */
    function docId() {
      const cur = Route.current();
      return cur && cur.pid === pid ? cur.docId : null;
    }

    /** 按文档 id 找节点(「更多」菜单要拿标题回显) */
    function findNode(id) {
      let hit = null;
      UI.walkTree(treeData, (n) => {
        if (n.id === id) { hit = n; return false; }
      });
      return hit;
    }

    /** 打开文档时展开其全部祖先:从收藏/命令面板/直链打开的深层文档也必须可见 */
    function expandAncestors(id) {
      if (id == null) return;
      let trail = null;
      UI.walkTree(treeData, (n, t) => {
        if (n.id === id) { trail = t; return false; }
      });
      if (!trail) return;
      trail.slice(0, -1).forEach((n) => collapsed.delete(n.id));
    }

    function renderTree() {
      if (!treeEl) return;
      const active = docId();
      expandAncestors(active);
      DocTree.renderTreeInto(treeEl, {
        treeData, activeId: active, collapsed, canEdit,
        callbacks: {
          onNav: (id) => {
            if (id === docId()) return;
            const node = findNode(id);
            App.recordView(pid, id, node && node.title);
            location.hash = App.route.project(pid, 'docs', id);
          },
          onAdd: (parentId) => createDoc(parentId),
          onMenu: (btn, id) => openDocMenu(btn, id),
        },
      });
      // 高亮行可能落在树的折叠区或滚动区外:展开祖先并滚到可见
      DocTree.reveal(treeEl, active, collapsed);
    }

    async function loadTree() {
      try {
        treeData = await api(Endpoints.docTree(pid)) || [];
        renderTree();
      } catch (e) {
        if (treeEl) treeEl.innerHTML = UI.error(e, { sm: true, cls: 'm-2' });
      }
    }

    async function createDoc(parentId) {
      try {
        const body = { title: '无标题文档' };
        if (parentId) body.parentId = parentId;
        const d = await api(Endpoints.docsOf(pid), { method: 'POST', body: body });
        await loadTree();
        location.hash = App.route.project(pid, 'docs', d.id);
      } catch (e) { UI.err(e); }
    }

    /** 「更多」下拉:收藏 / 重命名 / 移动到… / 删除;id 已由 DocTree 用 UI.idOf 过形状 */
    function openDocMenu(btn, id) {
      const node = findNode(id);
      const title = node ? node.title : '';
      UI.dropdownMenu(btn, [
        {
          icon: Favorites.has(id) ? 'star-fill' : 'star-line',
          label: Favorites.has(id) ? '取消收藏' : '收藏',
          onClick: () => {
            Favorites.toggle({ id, projectId: pid, title });
            UI.toast(Favorites.has(id) ? '已收藏' : '已取消收藏', 'success');
          },
        },
        {
          icon: 'ri-edit-line', label: '重命名', onClick: async () => {
            const next = await UI.inputDialog({ title: '重命名文档', label: '标题', value: title });
            if (!next) return;
            try {
              await api(Endpoints.doc(id), { method: 'PATCH', body: { title: next } });
              await loadTree();
              if (id === docId()) {
                const t = document.querySelector('#doc-title');
                if (t) t.value = next;
              }
            } catch (err) { UI.err(err); }
          },
        },
        {
          icon: 'ri-folder-transfer-line', label: '移动到…', onClick: () => {
            MoveTarget.open({
              item: { id, name: title }, kind: 'doc', projectId: pid,
              parentId: (node && node.parentId) || null,
              onDone: async (res) => {
                if (!res || res.projectId === pid) { await loadTree(); return; }
                window.location.hash = App.route.project(res.projectId, 'docs', res.id);
                App.loadSpaces(true).catch(() => {});
              },
            });
          },
        },
        {
          icon: 'ri-delete-bin-line', label: '删除', danger: true, onClick: async () => {
            const ok = await UI.confirmDialog('删除后进入回收站,可在空间「回收站」中恢复。确定删除「' + title + '」?');
            if (!ok) return;
            try {
              await api(Endpoints.doc(id), { method: 'DELETE' });
              UI.toast('已删除(可在回收站恢复)', 'success');
              Favorites.remove(id);
              await loadTree();
              if (id === docId()) location.hash = App.route.project(pid, 'docs');
            } catch (err) { UI.err(err); }
          },
        },
      ], { align: 'end' });
      btn.click();
    }

    return {
      key: 'p/' + pid + '/docs',
      render(ctx) {
        sideHost = document.getElementById('side-doc-tree');
        const frag = Scope.html('<div class="doc-editor-col" id="doc-editor-col"></div>');
        const editorCol = frag.querySelector('#doc-editor-col');

        if (sideHost) {
          sideHost.innerHTML =
            '<div class="side-doc-head">' +
            '<span class="side-doc-title">文档</span>' +
            (canEdit ? UI.iconBtn({ id: 'btn-new-doc', icon: 'add-line', title: '新建文档' }) : '') +
            '</div>' +
            '<div id="doc-tree" class="doc-tree">' + UI.skeleton('rows', 6) + '</div>';
          treeEl = sideHost.querySelector('#doc-tree');
          const newDocBtn = sideHost.querySelector('#btn-new-doc');
          if (newDocBtn) newDocBtn.onclick = () => createDoc(null);
          ctx.dispose(() => {
            sideHost.innerHTML = '';
            sideHost = null;
            treeEl = null;
          });
        } else {
          treeEl = null;
        }

        loadTree();
        // 文档位立刻挂上:编辑器骨架(或空态)这一帧就位,正文到了就地填
        ctx.mount(editorCol);
        return frag;
      },
      // 文档位描述在挂载那一刻产出:读当前路由拿 docId,并带上本层的运行时
      child() {
        const id = docId();
        App.recordView(pid, id, (findNode(id) || {}).title);
        const shared = {
          pid, canEdit, createDoc, onTreeChanged: loadTree,
          // 标题的即取值:文档树里已经有它,编辑器第一帧就能显示正确的标题
          docTitle: () => (findNode(id) || {}).title,
        };
        return id
          ? DocEditorView.level(Object.assign({ docId: id }, shared))
          : unopenedSlot(Object.assign({}, shared, { docId: null }));
      },
      // 子层换人:只移动高亮行;若目标在折叠区里,顺带展开祖先并滚到可见(不重建树)
      onChild(props) {
        const id = props && props.docId != null ? props.docId : null;
        if (id != null) expandAncestors(id);
        DocTree.setActive(treeEl, id);
        DocTree.reveal(treeEl, id, collapsed);
      },
    };
  };

  /**
   * 未选文档时的文档位。它是"文档位"的另一半而不是特例分支 —— 槽位永远有层,
   * 于是"子层被换掉之后父层要恢复什么"这个问题根本不存在。
   */
  function unopenedSlot(o) {
    return {
      key: 'p/' + o.pid + '/docs/-',
      props: { docId: null },
      render() {
        const frag = Scope.html('');
        frag.appendChild(UI.empty({
          icon: 'edit-box-line',
          title: '选择一篇文档',
          desc: o.canEdit ? '或者从左侧文档树新建一篇' : '',
          action: o.canEdit ? { label: '新建文档', onClick: () => o.createDoc(null) } : null,
        }));
        return frag;
      },
    };
  }
})();
