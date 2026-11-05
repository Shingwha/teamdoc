// views/projects.js — 空间管理页(#/projects):空间卡片网格 + 创建空间向导
window.Views = window.Views || {};
// 公开空间的加入入口**只有这一份**(发现页卡片询问与空间页的 403 错误态共用)。
window.ProjectsAPI = (function () {
  'use strict';

  /** 执行加入;返回是否成功。落地模块交给路由决定(它会按 tab 记忆/默认 home 重定向) */
  async function join(pid, name) {
    try {
      await api(Endpoints.projectJoin(pid), { method: 'POST' });
    } catch (e) {
      UI.err(e);
      return false;
    }
    UI.toast('已加入' + (name ? '「' + name + '」' : '空间'), 'success');
    App.loadSpaces(true).catch(() => {});
    // 加入后直接落文档页:新成员的第一件事通常是看内容(空间首页的空态给不出这份确认)
    location.hash = App.route.project(pid, 'docs');
    // 刚加入这一条路由的作用域**可能已经在屏幕上**(直链打开时那是一个"你还不是成员"
    // 的错误态,而且它的键没变),不强制重建就会停在错误态上
    App.refresh();
    return true;
  }

  async function joinPrompt(pid, name, joinRole) {
    const ok = await UI.confirmDialog(
      '加入' + (name ? '「' + name + '」' : '这个空间') + '?加入后你可以查看本空间的文档与云空间,' +
      (joinRole === 'EDITOR' ? '并可编辑文档、上传文件' : '编辑权限需空间管理员另行授予') + '。',
      { title: '加入空间', okText: '加入', danger: false });
    if (ok) await join(pid, name);
  }

  return { join: join, joinPrompt: joinPrompt };
})();

(function () {
  'use strict';

  /** 空间管理页作用域(#/projects):卡片网格 + 创建向导 */
  window.Views.projectsLevel = function () {
    return {
      key: 'projects',
      render(ctx) {
        const frag = Scope.html(
          UI.pageHead({
            title: '空间管理',
            sub: '我参与的全部空间',
            actions: UI.btn({ id: 'btn-new-proj', label: '创建空间', icon: 'add-line', kind: 'filled' }),
          }) +
          '<div class="card-grid" id="proj-grid">' + UI.skeleton('cards') + '</div>');

        const grid = frag.querySelector('#proj-grid');

        function load() {
          return UI.loadInto(grid, () => api(Endpoints.projects()), {
            empty: (list) => !(list || []).length,
            emptyNode: () => UI.empty({
              icon: 'folder-open-line',
              title: '还没有空间',
              desc: '创建第一个空间,开始团队协作',
              action: { label: '创建空间', onClick: () => SpaceWizard.open() },
            }),
            render: (list) => list.map((p) => UI.cardLink({
              href: App.route.project(p.id, 'home'),
              name: p.name,
              badges: p.isPersonal ? UI.badge({ text: '个人' }) : '',
              desc: p.description || (p.isPersonal ? '我的私有文档与文件' : '暂无描述'),
              meta: p.isPersonal
                ? [{ text: (p.docCount != null ? p.docCount : '-') + ' 文档' }]
                : UI.projectCountMeta(p),
              metaHtml: p.myRole ? UI.badge({ text: UI.roleLabel(p.myRole), kind: 'primary' }) : '',
            })).join(''),
          });
        }

        frag.querySelector('#btn-new-proj').onclick = () => SpaceWizard.open();
        load();
        return frag;
      },
    };
  };
})();
