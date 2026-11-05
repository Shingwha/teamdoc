// views/drive.js — 云空间视图(飞书式统一列表:文件夹在前、文件在后,单个列表)
//   统一以项目上下文工作(scope 已随"个人空间并入个人项目"从契约中移除);
//   个人云空间 = 个人项目(isPersonal)的 files tab,与项目云空间复用同一视图。
//   上传:XHR 进度 + 并发 3 队列 + 右下角上传面板;支持文件夹(选择/拖拽,保留目录结构)。
//   多选:行首 checkbox,批量打包下载(zip)/ 删除;删除 = 进项目回收站。
//   视图:列表 / 网格(图片墙),分页「加载更多」,文本与 Markdown 站内预览。
//   Views.driveBody — 渲染体(返回 DocumentFragment),由 views/project.js 的云空间模块调用
window.Views = window.Views || {};
(function () {
  'use strict';

  // 文件类型图标与配色已提到组件库(命令面板/项目页等都要用,见 ui.js 的 UI.fileIcon)
  const fileIcon = UI.fileIcon;

  // 预览能力由服务端判定(行内带 canInline / isText,见 files.py 的 _INLINE_MIME 与 ui.js 的判定家族):
  // 前端不本地按 mime 前缀猜 —— 白名单一收紧就会出现"预览按钮在、点了却下载"。
  // canInline/isText 由服务端 file_json 单出口恒带(列表/搜索/上传/meta 全有),直接信标志位。

  // 文件两类的资源地址与上传地址:路径字面量归 Endpoints(前端唯一的路径来源),
  // 这里只保留"按 kind 取哪个"这一层语义。
  // 下载地址的构造归 Ref.downloadUrl(引用契约的唯一真相源,与正文里的链接同形)。
  window.FilesAPI = {
    url(kind, id) { return kind === 'folder' ? Endpoints.folder(id) : Endpoints.file(id); },
    download(id, inline) { return Ref.downloadUrl(id, inline); },
    /** 历史版本下载:版本号是 fileDownload 的可选第三参(见 ref/interfaces.md)。 */
    downloadVersion(id, version) { return Endpoints.fileDownload(id, false, version); },
    /** 上传地址。opts 二选一:
     *  {projectId, folderId?, name} 云空间"传到当前目录";
     *  {docId, name}               文档附件 —— 项目与「文档附件」目录由服务端按文档归属
     *                              推导(文档可能刚被移到别的项目,前端手里的 projectId 会过期)。
     *  nameMode/versionOf 只在撞名 409 之后的重试里出现:keep = 保留两个(服务端 dedupe),
     *  versionOf = 为已有文件登记新版本。两者互斥(服务端 400)。
     */
    upload(opts) {
      return Endpoints.fileUpload({
        name: opts.name,
        docId: opts.docId || undefined,
        projectId: opts.docId ? undefined : opts.projectId,
        folderId: opts.folderId || undefined,
        name_mode: opts.nameMode || undefined,
        version_of: opts.versionOf || undefined,
      });
    },
  };

  /** 相对时间(名称下的元信息行用):近处给"刚刚/N 分钟前/N 小时前/N 天前",
      超过一个月退回短日期。解析失败时退回 UI.fmtDate,不吞掉原始值。 */
  function relTime(s) {
    const d = UI.parseDate(s);
    if (!d) return UI.fmtDate(s);
    const diff = Date.now() - d.getTime();
    if (diff < 60 * 1000) return '刚刚';
    if (diff < 3600 * 1000) return Math.floor(diff / (60 * 1000)) + ' 分钟前';
    if (diff < 24 * 3600 * 1000) return Math.floor(diff / (3600 * 1000)) + ' 小时前';
    if (diff < 30 * 24 * 3600 * 1000) return Math.floor(diff / (24 * 3600 * 1000)) + ' 天前';
    return UI.fmtDateShort(s);
  }

  /** 文件行的版本标签:历史数据的 version 缺失时按 1 处理(服务端每个文件至少一版)。 */
  const versionNo = (f) => 'v' + (Number(f.version) || 1);

  /**
   * 云空间主体:返回交给上层的 DocumentFragment(不套壳)。
   * 上层给的槽位就是 #proj-body,这里的节点必须直接落进去 —— 中间多一层 div 就改掉了
   * #proj-body 的直接子结构(布局契约不许)。
   */
  window.Views.driveBody = function ({ projectId, proj, folderId: initialFolder, highlight, dispose }) {
    // 写/移动一律 UI.canEdit(EDITOR+),与文档 tab 同口径:自己另写一套角色比较会让
    // "非成员全局管理员在云空间没有写按钮、在文档 tab 却能建文档"这类不一致重新出现。
    // VIEWER 天然过不了 EDITOR。
    const canMove = UI.canEdit(proj);
    const canWrite = UI.canEdit(proj);
    // 路径栈 = "当前目录"的唯一来源:栈顶即当前目录(根目录的 id 为 null)。
    // 刷新/深链时由 resolveStack 从服务端文件夹树重建(以前父链只在会话内,刷新就回根目录)。
    // 不再另存一份 folderId:那是同一事实的第二份副本,下钻/回跳/深链三处各要手写同步。
    let stack = [{ id: null, name: '全部文件' }];
    const curFolderId = () => stack[stack.length - 1].id;
    // 排序与视图形态都记忆在 localStorage:云空间是高频重复访问的页面,
    // 每次进来都回到默认值会让人反复重设。
    // 网格是默认形态(§6.5);只有用户主动选过列表才停在列表。
    const savedSort = UI.pref.get('td:drive-sort', null);
    const savedDir = UI.pref.get('td:drive-dir', null);
    // 窄屏强制列表(§6.11):prefView 记住用户主动选的形态,离开窄屏后恢复;
    // 窄屏期间的 viewMode 恒为 list,不写回偏好 —— 否则一次手机访问会永久改掉桌面形态。
    const isNarrow = () => !!(UI.NARROW && UI.NARROW.matches);
    let prefView = UI.pref.get('td:drive-view') === 'list' ? 'list' : 'grid';
    let viewMode = isNarrow() ? 'list' : prefView;
    let sortKey = savedSort || (viewMode === 'grid' ? 'time' : 'name'); // name | time | size
    let sortDir = savedDir
      ? (savedDir === 'desc' ? -1 : 1)
      : (viewMode === 'grid' ? -1 : 1);
    const PAGE = 100;      // 单页文件数,与「加载更多」配合
    let loadedFiles = 0;   // 已加载的文件条数(分页游标 = offset)
    let loadedRows = [];   // 已加载的文件行(追加渲染用;不靠读 DOM 反推,免得丢字段)
    let hasMore = false;
    // 行对象的唯一构造点:服务端的 folders/files 是两个数组,只有"拍平成统一列表"
    // 这一刻才知道类型 —— 所以类型由 rowOf 打进行对象自身,key 也从行派生(keyOf)。
    // 消费端(点击/多选/批量/移动)一律读 row.kind:类型若靠 isFolder 布尔参数、
    // data-kind、key 前缀各写一遍,迟早有一处读不到,于是文件夹被当成文件下载 /
    // 改名 / 删除(id 撞车时命中的是另一个真实文件)。
    const rowOf = (kind, dto) => ({ ...dto, kind });
    const keyOf = (row) => row.kind + ':' + row.id;
    // "kind:id" → 行 的索引:点击/多选据此取回完整对象,dataset 只留 kind/id 做命中测试。
    // 不要把字段序列化进 dataset 再读回来重建对象:id 在往返途中变成字符串,是"id
    // 一会儿是数字一会儿是字符串"这类补丁的根源。
    const itemIndex = new Map();

    const root = Scope.html(
      UI.toolbar({
        left: '<nav class="crumb" id="drive-crumb"></nav>',
        right:
          UI.seg({
            id: 'drive-view-seg', cls: 'drive-view-seg',
            active: viewMode,
            items: [
              { key: 'list', label: '列表', icon: 'list-check-2' },
              { key: 'grid', label: '网格', icon: 'grid-fill' },
            ],
          }) +
          // 排序在网格下也必须可达(网格没有表头),与列头读写同一组偏好
          UI.seg({
            id: 'drive-sort-seg', cls: 'drive-sort-seg', auto: true, active: sortKey,
            items: [{ key: 'name', label: '名称' }, { key: 'time', label: '时间' }, { key: 'size', label: '大小' }],
          }) +
          UI.iconBtn({
            id: 'btn-sort-dir', cls: 'drive-sort-dir',
            icon: sortDir === 1 ? 'sort-asc' : 'sort-desc',
            title: sortDir === 1 ? '升序,点击切换为降序' : '降序,点击切换为升序',
          }) +
          (canWrite
            ? UI.btn({ id: 'btn-mkdir', label: '新建文件夹', icon: 'folder-add-line', kind: 'tonal', size: 'sm' }) +
              UI.btn({ id: 'btn-upload-dir', label: '上传文件夹', icon: 'folder-upload-line', kind: 'tonal', size: 'sm' }) +
              // 选中单个文件时才出现(updateBatchBar 切换 hidden):主入口,不需要先删旧文件
              UI.btn({ id: 'btn-version-upload', label: '上传新版本', icon: 'upload-cloud-2-line',
                       kind: 'filled', size: 'sm', attrs: 'hidden',
                       title: '为选中的文件上传新版本(文件名保持不变)' }) +
              UI.btn({ id: 'btn-upload', label: '上传', icon: 'upload-2-line', kind: 'filled', size: 'sm' })
            : '') +
          '<input type="file" id="version-input" hidden>' +
          '<input type="file" id="upload-input" multiple hidden>' +
          '<input type="file" id="upload-dir-input" webkitdirectory hidden>',
      }) +
      '<div id="drive-storage" class="card-note"></div>' +
      UI.tableHead(
        [
          { html: UI.sortHead('名称', 'name', { key: sortKey, dir: sortDir }) },
          { html: UI.sortHead('大小', 'size', { key: sortKey, dir: sortDir }) },
          { html: UI.sortHead('时间', 'time', { key: sortKey, dir: sortDir }), cls: 'dh-time' },
          { html: '' },
        ],
        {
          id: 'drive-table', headId: 'drive-head',
          cls: 'drive-table',
          checkAll: '<input type="checkbox" id="drive-check-all" class="sel-box" title="全选">',
          batch:
            '<span class="batch-info" id="drive-batch-info"></span>' +
            UI.btn({ id: 'batch-dl', label: '打包下载', icon: 'download-2-line', kind: 'tonal', size: 'sm' }) +
            (canWrite ? UI.btn({ id: 'batch-del', label: '删除', icon: 'delete-bin-line', kind: 'danger-outline', size: 'sm' }) : '') +
            UI.btn({ id: 'batch-cancel', label: '取消', kind: 'text', size: 'sm' }),
        }
      ) +
      '<div id="drive-rows">' + UI.skeleton(viewMode === 'grid' ? 'cards' : 'rows', 6) + '</div>' +
      '<div id="drive-more" class="mt-3" hidden></div>' +
      '<div id="drive-trunc" hidden></div>' +
      '<div class="up-panel" id="up-panel" hidden>' +
      '<div class="up-head"><span id="up-title">上传</span>' +
      UI.iconBtn({ id: 'up-close', icon: 'close-line', title: '收起', size: 'sm' }) + '</div>' +
      '<div class="up-list" id="up-list"></div>' +
      '</div>');

    const crumbEl = root.querySelector('#drive-crumb');
    const tableEl = root.querySelector('#drive-table');
    const rowsEl = root.querySelector('#drive-rows');
    const moreEl = root.querySelector('#drive-more');
    const storageEl = root.querySelector('#drive-storage');
    const uploadInput = root.querySelector('#upload-input');
    const uploadDirInput = root.querySelector('#upload-dir-input');
    const uploadBtn = root.querySelector('#btn-upload');
    const headEl = root.querySelector('#drive-head');
    const batchInfo = root.querySelector('#drive-batch-info');
    const checkAll = root.querySelector('#drive-check-all');
    const upPanel = root.querySelector('#up-panel');
    const upList = root.querySelector('#up-list');
    const upTitle = root.querySelector('#up-title');
    const truncEl = root.querySelector('#drive-trunc');
    const viewSeg = root.querySelector('#drive-view-seg');
    const sortSeg = root.querySelector('#drive-sort-seg');
    const sortDirBtn = root.querySelector('#btn-sort-dir');
    const versionBtn = root.querySelector('#btn-version-upload');
    const versionInput = root.querySelector('#version-input');
    // 批量栏三个按钮在渲染期抓好引用:updateBatchBar 是晚于挂载运行的,
    // 那时片段已被搬空(root.querySelector 会拿到 null)
    const batchDlBtn = root.querySelector('#batch-dl');
    const batchCancelBtn = root.querySelector('#batch-cancel');
    const selected = new Set(); // 多选状态:"{kind}:{id}"
    let activeUploads = 0;      // 进行中上传数(>0 时上传面板不可收起)
    let lastFolders = [];       // 最近一次加载的文件夹行(网格视图重绘用)
    let singleVersionTarget = null; // 工具条「上传新版本」作用的对象(恰好选中一个文件)
    let versionTarget = null;   // 版本输入框这次为哪个文件选文件
    let conflicts = [];         // 同名 409 收集队列:整批队列清空后只弹一次窗口
    let conflictModal = null;   // 当前冲突窗口(避免并行批次弹第二个)

    /** 面包屑是 stack(路径栈)的投影,**唯一绘制点在 load()** —— 改了 stack 的每一步
     *  (gotoFolder 下钻 / 面包屑回跳 / resolveStack 深链解析)都必经 load()。
     *  别在这里的调用方补第二次渲染:以前它只在视图初始化时画一次,点进文件夹后
     *  面包屑停在根路径(整条路径只剩一个不可点的 current),等于没有返回上一级的入口。 */
    function renderCrumb() {
      // UI.crumbs 只返回条目:容器就是这个 nav.crumb 本身(#drive-crumb),别再套一层
      crumbEl.innerHTML = UI.crumbs(stack.map((s) => ({ label: s.name })));
    }

    /** 把当前目录同步进 URL(?folder=),使刷新与"从别处跳进某目录"都能定位。
     *  用 replaceState 而非改 hash:云空间这一层的键里带着 query,改 hash 会让
     *  整层重建(列表、选中、滚动位置全重来)—— 一次普通的下钻不该是这个代价。 */
    function syncUrl() {
      const id = curFolderId();
      const base = App.route.project(projectId, 'files', null, id ? { folder: id } : null);
      if (location.hash !== base) history.replaceState(null, '', base);
    }

    /** 进入某目录(下钻/回跳共用),同时同步 URL */
    async function gotoFolder(id, name) {
      // 下钻 = 压栈;当前目录随之变成栈顶(没有第二份 folderId 要同步)
      if (stack[stack.length - 1].id !== id) stack.push({ id, name });
      syncUrl();
      await load();
    }

    function renderHeadSorts() {
      UI.sortHeadSet(tableEl, { key: sortKey, dir: sortDir });
    }

    /** 排序控件的唯一绘制点:表头图标、工具条分段与方向按钮同源同步。
     *  三处(表头 / 工具条 / 方向)都经 applySort 改状态,不各自写一份偏好。 */
    function paintSortControls() {
      if (sortSeg) UI.segSet(sortSeg, sortKey);
      if (sortDirBtn) {
        sortDirBtn.innerHTML = UI.icon(sortDir === 1 ? 'sort-asc' : 'sort-desc');
        sortDirBtn.title = sortDir === 1 ? '升序,点击切换为降序' : '降序,点击切换为升序';
      }
      renderHeadSorts();
    }

    async function applySort(nextKey, nextDir) {
      sortKey = nextKey;
      sortDir = nextDir;
      UI.pref.set('td:drive-sort', sortKey);
      UI.pref.set('td:drive-dir', sortDir === 1 ? 'asc' : 'desc');
      paintSortControls();
      await load();
    }

    // 行/瓦片共用的命中测试属性:只留 kind 与 id(行本体在 itemIndex 里)
    function attrsFor(row) {
      return 'data-kind="' + row.kind + '" data-id="' + UI.esc(row.id) + '"';
    }

    // 删除确认文案:文件夹(整棵可恢复)/被引用文件/普通文件三档
    function deleteTip(f) {
      return f.kind === 'folder'
        ? '删除会连同文件夹里的全部内容一起进回收站(整棵可恢复)。确定删除「' + f.name + '」?'
        : f.referenced
          ? '「' + f.name + '」正被文档引用,删除后引用将失效(恢复前)。仍要删除?'
          : '删除后进入项目回收站,可随时恢复。确定删除「' + f.name + '」?';
    }

    function rowHtml(row) {
      const isFolder = row.kind === 'folder'; // 局部派生:类型只来自行对象,不由调用方传参
      const fi = isFolder ? { icon: 'folder-fill', cls: 'folder' } : fileIcon(row.mime);
      const referenced = !isFolder && row.referenced;
      // 服务端已判定可否 inline(白名单,file_json 恒带 canInline)
      const canPreview = !isFolder && !!row.canInline;
      const key = keyOf(row);
      const check = '<input type="checkbox" class="sel-box"' + (selected.has(key) ? ' checked' : '') + '>';
      // 操作列:声明式列表生成 —— folder/file 的差异只在条目取舍与文案。两套三元
      // 表达式互抄的话,加一个新操作要记得改两处,而漏的那处不会有人发现
      const acts = [
        isFolder && { icon: 'download-2-line', title: '打包下载', cls: 'act-download-dir' },
        !isFolder && canPreview && { icon: 'eye-line', title: '预览', cls: 'act-preview' },
        !isFolder && { icon: 'download-2-line', title: '下载', cls: 'act-download' },
        // 显式上传新版本是日常迭代文件的主入口;VIEWER 只能看历史,不能上传
        !isFolder && canWrite && { icon: 'upload-cloud-2-line',
                                   title: '上传新版本(文件名保持不变)', cls: 'act-version-upload' },
        !isFolder && { icon: 'history-line', title: '版本历史', cls: 'act-versions' },
        canWrite && { icon: 'edit-line', title: '重命名', cls: 'act-rename' },
        !isFolder && canWrite && {
          icon: row.shared ? 'link' : 'share-line',
          title: row.shared ? '已建立分享链接:复制 / 吊销'
            : '分享此文件(生成一条无需登录的下载链接)',
          cls: 'act-share',
        },
        canMove && { icon: 'share-forward-line', title: '移动', cls: 'act-move' },
        canWrite && { icon: 'delete-bin-line', title: isFolder ? '删除(含内容)' : '删除',
                      danger: true, cls: 'act-del' },
      ].filter(Boolean)
        .map((a) => UI.iconBtn({ icon: a.icon, title: a.title, danger: a.danger, size: 'sm', cls: a.cls }))
        .join('');
      // 名称下第二行只在文件行出现:版本号 + 大小 + 相对时间(窄屏隐藏时间列后仍然可见)
      const nameLink = '<span class="drive-name-stack">' +
        '<button class="row-link" type="button" title="' + UI.esc(row.name) + '">' + UI.esc(row.name) + '</button>' +
        (isFolder ? '' : '<span class="drive-name-sub">' + UI.esc(versionNo(row) + ' · ' +
          UI.fmtSize(row.size) + ' · ' + relTime(row.updatedAt || row.createdAt)) + '</span>') +
        '</span>';
      return UI.tableRow(
        [
          {
            html: UI.cellName({
              icon: fi.icon, iconCls: fi.cls,
              link: nameLink,
              badges: (referenced
                ? '<span class="badge" title="有文档引用了此文件,删除后引用将失效">被引用</span>' : '') +
                (!isFolder && row.shared
                  ? '<span class="badge primary" title="已建立分享链接,持有链接即可下载">已分享</span>' : ''),
            }),
          },
          { html: UI.cellMeta(isFolder ? '—' : UI.esc(UI.fmtSize(row.size)), 'row-size') },
          { html: UI.cellMeta(UI.esc(UI.fmtDate(row.createdAt)), 'row-time') },
        ],
        {
          check: check,
          acts: acts,
          selected: selected.has(key),
          attrs: attrsFor(row),
        }
      );
    }

    /** 网格瓦片 hover 操作条:版本是文件的主操作,网格下不能只靠右键。
     *  与行操作/右键菜单共用同一组处理函数(pickVersionFile / openVersionDrawer / fileMenuItems),
     *  不另写一套入口逻辑。文件夹的点击即进入,不需要版本操作。
     *  触屏没有 hover,常显由 drive.css 的 (pointer: coarse) 规则负责。 */
    function tileActsHtml(row) {
      if (row.kind !== 'file') return '';
      return '<div class="tile-acts">' +
        (canWrite ? UI.iconBtn({
          icon: 'upload-cloud-2-line', title: '上传新版本(文件名保持不变)',
          size: 'sm', cls: 'act-version-upload',
        }) : '') +
        UI.iconBtn({ icon: 'history-line', title: '版本历史', size: 'sm', cls: 'act-versions' }) +
        UI.iconBtn({ icon: 'more-2-line', title: '更多操作', size: 'sm', cls: 'act-tile-more' }) +
        '</div>';
    }

    /** 网格/图片墙瓦片。图片用原图 + CSS 缩放 + lazy loading —— 不引 Pillow 生成缩略图:
     *  内网带宽够,零后端依赖更值。多选在网格下同样可用(左上角选择框)。 */
    function tileHtml(row) {
      const isFolder = row.kind === 'folder'; // 同上:类型来自行对象
      const fi = isFolder ? { icon: 'folder-fill', cls: 'folder' } : fileIcon(row.mime);
      const key = keyOf(row);
      const isImg = !isFolder && UI.isEmbedImage(row.mime, row.canInline);
      const thumb = isImg
        ? '<img src="' + FilesAPI.download(row.id, true) + '" alt="" loading="lazy">'
        : UI.icon(fi.icon, fi.cls);
      return '<div class="tile' + (isFolder ? ' is-folder' : '') + (selected.has(key) ? ' selected' : '') + '"' +
        ' ' + attrsFor(row) + ' title="' + UI.esc(row.name) + '">' +
        '<input type="checkbox" class="sel-box tile-check"' + (selected.has(key) ? ' checked' : '') + '>' +
        '<div class="tile-thumb">' + thumb +
        tileActsHtml(row) +
        (!isFolder && row.shared ? '<span class="badge xs primary tile-pub" title="已建立分享链接">已分享</span>' : '') +
        '</div>' +
        '<div class="tile-name">' + UI.esc(row.name) + '</div>' +
        '<div class="tile-meta">' + (isFolder ? '文件夹'
          : UI.esc(versionNo(row) + ' · ' + UI.fmtSize(row.size) + ' · ' +
                   relTime(row.updatedAt || row.createdAt))) + '</div>' +
        '</div>';
    }

    function renderGrid(folders, files, appendRows) {
      // 加载更多时只追加新到的一页:原来是每次全量重建 DOM,
      // 翻到第 N 页的总工作量是 O(N²),上千文件的目录会明显卡顿
      if (appendRows && rowsEl.className === 'file-grid') {
        rowsEl.insertAdjacentHTML('beforeend', appendRows.map((r) => tileHtml(r)).join(''));
        return;
      }
      rowsEl.className = 'file-grid';
      // 列头是给列表用的(名称/大小/时间),网格下没有对应语义,隐藏掉
      tableEl.classList.add('drive-grid-mode');
      rowsEl.innerHTML = folders.map((r) => tileHtml(r)).join('') +
        files.map((r) => tileHtml(r)).join('');
    }

    function renderList(folders, files, appendRows) {
      // 同上:追加新页而非重建全部行
      if (appendRows && !rowsEl.className) {
        rowsEl.insertAdjacentHTML('beforeend', appendRows.map((r) => rowHtml(r)).join(''));
        return;
      }
      rowsEl.className = '';
      tableEl.classList.remove('drive-grid-mode');
      // 统一列表:文件夹在前、文件在后(排序已由服务端完成,前端不再重排)
      rowsEl.innerHTML = folders.map((r) => rowHtml(r)).join('') +
        files.map((r) => rowHtml(r)).join('');
    }

    /** 「加载更多」按钮:文件分页游标推进(文件夹一次取全,不参与分页) */
    function renderMore() {
      if (!hasMore) {
        moreEl.hidden = true;
        moreEl.innerHTML = '';
        return;
      }
      moreEl.hidden = false;
      moreEl.innerHTML = UI.btn({ id: 'btn-more', label: '加载更多', kind: 'tonal', size: 'sm' });
      const b = moreEl.querySelector('#btn-more');
      b.disabled = false;
      b.onclick = async () => {
        b.disabled = true;
        await load({ append: true });
      };
    }

    /** 目录占用一行提示(活跃 + 回收站分列,见 files.py project_storage 的说明) */
    async function loadStorage() {
      try {
        const s = await api(Endpoints.projectStorage(projectId));
        storageEl.innerHTML = UI.icon('hard-drive-3-line') + ' 本项目占用 ' +
          UI.esc(UI.fmtSize(s.active.bytes)) + '(' + s.active.fileCount + ' 个文件 · ' +
          s.active.folderCount + ' 个文件夹)' +
          (s.trash.fileCount
            ? ' · 回收站另有 ' + UI.esc(UI.fmtSize(s.trash.bytes)) + '(' + s.trash.fileCount + ' 个,仍占磁盘)'
            : '') +
          ' · 磁盘剩余 ' + UI.esc(UI.fmtSize(s.disk.free));
      } catch (e) {
        storageEl.textContent = ''; // 占用是辅助信息,拿不到就不显示,不打断主流程
      }
    }

    async function load(opts) {
      const append = opts && opts.append;
      const keepSelection = opts && opts.keepSelection;
      // 导航状态 → DOM 的唯一投影点:面包屑只依赖 stack(调用方在进来之前已更新),
      // 与请求结果无关,所以放在取数之前 —— 请求失败也不会把导航停在过期路径上。
      renderCrumb();
      // keepSelection:上传新版本/轮询刷新时保留多选;换目录/普通首屏仍清空
      if (!append) {
        loadedFiles = 0;
        if (!keepSelection) selected.clear();
      }
      const dir = curFolderId();
      const params = {
        project_id: projectId,
        offset: loadedFiles,
        limit: PAGE,
        sort: sortKey,
        dir: sortDir === 1 ? 'asc' : 'desc',
        folder_id: dir || undefined,
      };
      try {
        const data = await api(Endpoints.files(params));
        // 两条数据路径(首屏 / 加载更多)都在这里成行:类型标签只有这一处出生点
        const pageRows = (data.files || []).map((f) => rowOf('file', f));
        // 文件夹只在首屏取一次(不参与分页);文件按页追加到已加载列表
        if (!append) {
          lastFolders = (data.folders || []).map((f) => rowOf('folder', f));
          loadedRows = [];
          itemIndex.clear();
        }
        loadedRows = loadedRows.concat(pageRows);
        loadedFiles = loadedRows.length;
        hasMore = !!data.hasMore;
        lastFolders.forEach((r) => itemIndex.set(keyOf(r), r));
        loadedRows.forEach((r) => itemIndex.set(keyOf(r), r));
        paintSortControls();
        // 文件夹数受服务端 2000 上限:真的超出才提示(文件走分页,不再是问题)
        const folderExtra = Math.max(0, (data.total.folders || 0) - lastFolders.length);
        if (folderExtra > 0) {
          truncEl.hidden = false;
          truncEl.className = 'banner warn sm mt-3';
          truncEl.innerHTML = UI.icon('alert-line') +
            '<span>当前目录有 ' + data.total.folders + ' 个文件夹,仅显示前 ' + lastFolders.length +
            ' 个。建议拆分到子文件夹。</span>';
        } else {
          truncEl.hidden = true;
          truncEl.innerHTML = '';
        }
        if (!lastFolders.length && !loadedRows.length) {
          rowsEl.className = '';
          rowsEl.innerHTML = '';
          rowsEl.appendChild(UI.emptyState({
            icon: 'cloud-line',
            title: '这里还是空的',
            // VIEWER 不出现写入口:空态的快捷上传与工具条按钮同口径隐藏
            desc: canWrite ? '上传文件或新建文件夹,也可以直接把文件拖进来'
              : '等待编辑者上传文件或新建文件夹',
            action: canWrite ? { label: '上传文件', onClick: () => uploadInput.click() } : undefined,
          }));
          renderMore();
          updateBatchBar(); // 空目录也要把工具条的「上传新版本」收回去
          return;
        }
        if (viewMode === 'grid') renderGrid(lastFolders, loadedRows, append ? pageRows : null);
        else renderList(lastFolders, loadedRows, append ? pageRows : null);
        renderMore();
        updateBatchBar();
      } catch (e) {
        rowsEl.innerHTML = UI.errorBanner(e);
      }
    }

    /** 由文件夹树重建路径栈(刷新/深链用)。
     *  以前父链只存在会话内,刷新就回"全部文件" —— 现在从服务端的树里查出祖先链,
     *  并顺带把 URL 里的 ?folder= 深链(搜索结果跳进来时带)解析成栈。 */
    async function resolveStack(targetFolderId) {
      if (!targetFolderId) return;
      targetFolderId = UI.idOf(targetFolderId); // URL 深链进来先过形状(非法 → null)
      try {
        const tree = await api(Endpoints.folderTree(projectId)) || [];
        let path = null;
        UI.walkTree(tree, (n, trail) => {
          if (n.id === targetFolderId) { path = trail.map((x) => ({ id: x.id, name: x.name })); return false; }
          return true;
        });
        // 目标文件夹可能已被删掉/不属于本项目:那就留在根目录,不要造出半截面包屑
        if (path) stack = [{ id: null, name: '全部文件' }].concat(path);
      } catch (e) { /* 拿不到树就保持根目录,列表本身仍可用 */ }
    }

    // 行/瓦片共用一个"元素选择器":列表用 .data-table-row,网格用 .tile。
    // 加新视图形态必须同步它,否则多选静默失效。
    const ITEM_SEL = '.data-table-row, .tile';

    /** 命中测试 → 完整对象(来自 itemIndex,不读 DOM 反推字段) */
    function itemOf(el) {
      const row = el.closest(ITEM_SEL);
      return row ? itemIndex.get(row.dataset.kind + ':' + row.dataset.id) || null : null;
    }

    function triggerDownload(f) { UI.download(FilesAPI.download(f.id, false), { filename: f.name || '' }); }

    // ---------- 版本:显式上传新版本 / 历史抽屉 ----------
    /** 「上传新版本」的选文件入口:三处(行操作/右键/工具条)共用。
     *  上传的是文件内容,文件名由服务端沿用 target.name —— 不需要先删旧文件。 */
    function pickVersionFile(f) {
      if (!canWrite || !f || f.kind !== 'file') return;
      versionTarget = f;
      versionInput.value = '';
      versionInput.click();
    }

    /** 显式新版本的备注(可选,≤200):上传前弹一次,留空即不写备注。
     *  返回 null = 取消上传,空串 = 不写备注。 */
    function askVersionNote(f) {
      return UI.formModal({
        title: '上传新版本 · ' + f.name,
        okText: '开始上传',
        fields: [{
          name: 'note', label: '版本备注(可选)', type: 'textarea', rows: 2, maxlength: 200,
          help: '最多 200 字;备注会显示在版本时间线上,便于同事理解这次改了什么',
        }],
        submit: (v, { close }) => close(String(v.note || '').trim().slice(0, 200)),
      }).result;
    }

    versionInput.addEventListener('change', async () => {
      const picked = (versionInput.files || [])[0];
      const target = versionTarget;
      versionTarget = null;
      versionInput.value = '';
      if (!picked || !target) return;
      const note = await askVersionNote(target);
      if (note === null) return; // 取消 = 不上传
      // 与普通上传共用队列/进度面板:大文件同样有进度,且并发 3 的上限一致
      enqueue([{ file: picked, target, note }]);
    });

    if (versionBtn) versionBtn.onclick = () => { if (singleVersionTarget) pickVersionFile(singleVersionTarget); };

    // 版本历史抽屉:右侧 400px(窄屏全屏)。生命周期挂在本视图上 —— dispose 时关抽屉、
    // 摘全局监听,不留孤儿节点。
    let versionDrawer = null;
    function onDrawerKey(e) {
      if (e.key === 'Escape') closeVersionDrawer();
    }

    function closeVersionDrawer() {
      const d = versionDrawer;
      if (!d) return;
      versionDrawer = null;
      if (UI.NARROW && d.onNarrow) UI.NARROW.removeEventListener('change', d.onNarrow);
      document.removeEventListener('keydown', onDrawerKey, true);
      d.scrim.remove();
      d.el.remove();
    }

    /** 版本时间线的一行:版本号/时间/大小/操作者;当前版带徽标,非当前版可恢复。 */
    function versionItemHtml(v, current) {
      const num = Number(v.version) || 0;
      const isCurrent = num === current;
      const who = v.createdByName || '未知用户';
      return '<div class="drive-v-item' + (isCurrent ? ' current' : '') + '" data-version="' + num + '">' +
        '<span class="drive-v-dot"></span>' +
        '<div class="drive-v-main">' +
          '<div class="drive-v-head">' +
            '<span class="drive-v-no">v' + num + '</span>' +
            (isCurrent ? UI.badge({ text: '当前', kind: 'primary', cls: 'xs' }) : '') +
            '<span class="drive-v-when" title="' + UI.esc(UI.fmtDate(v.createdAt)) + '">' +
              UI.esc(UI.fmtWhen(v.createdAt)) + '</span>' +
          '</div>' +
          '<div class="drive-v-meta">' + UI.esc(UI.fmtSize(v.size)) + ' · ' + UI.esc(who) + '</div>' +
          (v.note ? '<div class="drive-v-note">' + UI.esc(v.note) + '</div>' : '') +
          '<div class="drive-v-acts">' +
            UI.btn({ label: '下载', kind: 'text', size: 'sm', cls: 'drive-v-dl' }) +
            (canWrite && !isCurrent
              ? UI.btn({ label: '恢复此版本', kind: 'tonal', size: 'sm', cls: 'drive-v-restore' })
              : '') +
          '</div>' +
        '</div>' +
      '</div>';
    }

    /** 只画抽屉本体;数据由 loadVersions 异步填(骨架已在 render 段给出)。 */
    function openVersionDrawer(f) {
      closeVersionDrawer();
      const scrim = document.createElement('div');
      scrim.className = 'scrim drive-drawer-scrim';
      const el = document.createElement('aside');
      el.className = 'drive-drawer';
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-label', '版本历史');
      el.innerHTML =
        '<div class="drive-drawer-head">' +
          '<div class="drive-drawer-heading">' +
            '<div class="drive-drawer-title">版本历史</div>' +
            '<div class="drive-drawer-sub" id="drive-v-sub">' + UI.esc(f.name) + '</div>' +
          '</div>' +
          UI.iconBtn({ icon: 'close-line', title: '关闭', size: 'sm', cls: 'drive-drawer-close' }) +
        '</div>' +
        '<div class="drive-drawer-body" id="drive-v-body">' + UI.skeleton('lines', 6) + '</div>';
      document.body.appendChild(scrim);
      document.body.appendChild(el);
      const onNarrow = () => el.classList.toggle('is-narrow', !!(UI.NARROW && UI.NARROW.matches));
      onNarrow();
      if (UI.NARROW) UI.NARROW.addEventListener('change', onNarrow);
      versionDrawer = { el, scrim, file: f, onNarrow };
      scrim.onclick = closeVersionDrawer;
      el.querySelector('.drive-drawer-close').onclick = closeVersionDrawer;
      document.addEventListener('keydown', onDrawerKey, true);
      el.querySelector('#drive-v-body').addEventListener('click', onVersionAction);
      loadVersions(f);
    }

    async function loadVersions(f) {
      const d = versionDrawer;
      if (!d || d.file !== f) return;
      const body = d.el.querySelector('#drive-v-body');
      try {
        const versions = await api(Endpoints.fileVersions(f.id)) || [];
        if (!versionDrawer || versionDrawer !== d) return; // 抽屉在请求期间被关掉/换了文件
        const current = versions.length ? Number(versions[0].version) : 0;
        const sub = d.el.querySelector('#drive-v-sub');
        if (sub) sub.textContent = f.name + ' · 共 ' + versions.length + ' 个版本';
        if (!versions.length) {
          body.innerHTML = '';
          body.appendChild(UI.emptyState({ icon: 'history-line', title: '暂无版本记录', sm: true }));
          return;
        }
        body.innerHTML = '<div class="drive-timeline">' +
          versions.map((v) => versionItemHtml(v, current)).join('') + '</div>';
      } catch (e) {
        if (versionDrawer === d) body.innerHTML = UI.errorBanner(e);
      }
    }

    async function onVersionAction(e) {
      const d = versionDrawer;
      const item = e.target.closest('.drive-v-item');
      if (!d || !item) return;
      const num = Number(item.dataset.version) || 0;
      if (e.target.closest('.drive-v-dl')) {
        UI.download(FilesAPI.downloadVersion(d.file.id, num), { filename: d.file.name || '' });
        return;
      }
      if (!e.target.closest('.drive-v-restore')) return;
      const ok = await UI.confirmDialog(
        '恢复 v' + num + ' 会把该版本的内容登记为一个新版本,现有历史全部保留。确定恢复?',
        { okText: '恢复', danger: false });
      if (!ok || !versionDrawer) return;
      try {
        const updated = await api(Endpoints.fileRestore(d.file.id), {
          method: 'POST', body: { version: num },
        });
        const newNo = updated && updated.version ? ' v' + updated.version : '';
        UI.toast('已从 v' + num + ' 恢复' + (newNo ? ',' + newNo + ' 已生成' : ''), 'success');
        if (updated) versionDrawer.file = Object.assign({}, versionDrawer.file, updated);
        await load({ keepSelection: true });
        if (versionDrawer) await loadVersions(versionDrawer.file);
      } catch (err) { UI.err(err); }
    }

    // 文件菜单:行右键与网格瓦片「更多」共用同一份条目(处理函数也同一份)。
    // trigger 传元素时按元素右缘对齐;右键传坐标时按坐标定位。
    function fileMenuItems(f) {
      const items = [];
      if (canWrite) {
        items.push({ icon: 'upload-cloud-2-line', label: '上传新版本', onClick: () => pickVersionFile(f) });
      }
      items.push({ icon: 'history-line', label: '版本历史', onClick: () => openVersionDrawer(f) });
      items.push({ divider: true });
      items.push({ icon: 'download-2-line', label: '下载', onClick: () => triggerDownload(f) });
      return items;
    }

    function openRowMenu(x, y, items, trigger) {
      UI.closeOpenMenu();
      const menu = document.createElement('div');
      menu.className = 'menu';
      items.forEach((it) => {
        if (it.divider) {
          const dv = document.createElement('div');
          dv.className = 'menu-divider';
          menu.appendChild(dv);
          return;
        }
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'menu-item' + (it.danger ? ' danger' : '');
        b.innerHTML = UI.icon(it.icon) + '<span>' + UI.esc(it.label) + '</span>';
        b.addEventListener('click', () => {
          layer.close();
          if (it.onClick) it.onClick();
        });
        menu.appendChild(b);
      });
      const layer = trigger
        ? UI.floatingLayer(menu, { trigger, align: 'end' })
        : UI.floatingLayer(menu, { rect: { left: x, right: x, top: y, bottom: y } });
      return layer;
    }

    rowsEl.addEventListener('contextmenu', (e) => {
      const f = itemOf(e.target);
      if (!f || f.kind !== 'file') return;
      e.preventDefault();
      openRowMenu(e.clientX, e.clientY, fileMenuItems(f));
    });


    // ---------- 多选与批量操作 ----------
    function selectedRows() {
      // 选中集以 "kind:id" 为键,对象本体在 itemIndex —— 与 DOM 无关
      return [...selected].map((k) => itemIndex.get(k)).filter(Boolean);
    }

    function updateBatchBar() {
      const rows = selectedRows();
      // 表头变身:有选择时同一行原地切换为批量操作(Gmail 式),列表不位移
      headEl.classList.toggle('selecting', rows.length > 0);
      const fileCount = rows.filter((r) => r.kind === 'file').length;
      const folderCount = rows.length - fileCount;
      batchInfo.textContent = '已选 ' + rows.length + ' 项' +
        (folderCount ? '(含 ' + folderCount + ' 个文件夹,将保留目录结构)' : '');
      // 文件夹也能打包(服务端递归展开),所以只要有选择按钮就可用
      batchDlBtn.disabled = rows.length === 0;
      // 版本是单个文件的事实:只有恰好选中一个文件时才出现「上传新版本」主按钮
      singleVersionTarget = canWrite && rows.length === 1 && rows[0].kind === 'file' ? rows[0] : null;
      if (versionBtn) versionBtn.hidden = !singleVersionTarget;
      const boxes = [...rowsEl.querySelectorAll('.sel-box')];
      checkAll.checked = boxes.length > 0 && boxes.every((b) => b.checked);
      checkAll.indeterminate = !checkAll.checked && boxes.some((b) => b.checked);
    }

    function setRowSelected(row, on) {
      const key = row.dataset.kind + ':' + row.dataset.id;
      if (on) selected.add(key); else selected.delete(key);
      row.classList.toggle('selected', on);
      row.querySelector('.sel-box').checked = on;
    }

    checkAll.addEventListener('change', () => {
      rowsEl.querySelectorAll(ITEM_SEL).forEach((r) => setRowSelected(r, checkAll.checked));
      updateBatchBar();
    });

    batchCancelBtn.onclick = () => {
      selected.clear();
      rowsEl.querySelectorAll(ITEM_SEL).forEach((r) => setRowSelected(r, false));
      updateBatchBar();
    };

    batchDlBtn.onclick = () => {
      const rows = selectedRows();
      if (!rows.length) return;
      const files = rows.filter((r) => r.kind === 'file');
      const folders = rows.filter((r) => r.kind === 'folder');
      if (rows.length === 1 && files.length === 1) { triggerDownload(files[0]); return; }
      // 与单文件下载同一套锚点机制:window.open 对附件流可能被拦/开空白页。
      // 文件夹交给服务端递归展开并保留目录结构(见 files.py 的 _collect_zip_targets)
      UI.download(Endpoints.filesZip({
        ids: files.map((f) => f.id).join(','),
        folderIds: folders.map((f) => f.id).join(','),
      }), { filename: '文件打包.zip' });
    };

    const batchDelBtn = root.querySelector('#batch-del');
    if (batchDelBtn) batchDelBtn.onclick = async () => {
      const rows = selectedRows();
      if (!rows.length) return;
      const folders = rows.filter((r) => r.kind === 'folder');
      const tip = '将删除 ' + rows.length + ' 项(可在项目「回收站」恢复)。' +
        (folders.length ? '文件夹会连同其中的内容一起删除(整棵可恢复)。' : '') +
        '确定删除?';
      if (!(await UI.confirmDialog(tip))) return;
      const r = await UI.eachOk(rows, (row) => api(FilesAPI.url(row.kind, row.id), { method: 'DELETE' }));
      selected.clear();
      UI.toast('已删除 ' + r.ok + ' 项' + (r.failed.length ? ',' + r.failed.length + ' 项失败' : ''),
        r.failed.length ? 'warning' : 'success');
      await load();
    };

    // ---------- 预览 ----------
    /** 判断预览方式:图片/PDF 开新标签(浏览器原生渲染器最好用);
     *  文本与 Markdown 走**站内模态框** —— 否则看一个 .md 要先下载到本地,
     *  而全站已有 Markdown 渲染栈,预览成本几乎为零。 */
    // 预览方式的判定归 Preview.kindOf(全站唯一),这里只把它翻译成"开新标签还是开浮层"
    function previewKind(f) {
      const kind = Preview.kindOf(f);
      if (kind === 'none') return null;
      return (kind === 'image' || kind === 'pdf') ? 'native' : 'inline';
    }

    async function openPreview(f) {
      const kind = previewKind(f);
      if (kind === 'native') { window.open(FilesAPI.download(f.id, true), '_blank'); return; }
      const isMd = UI.isMarkdown(f.mime, f.name);
      // 文本/Markdown 的站内模态框已收拢到共享组件 preview.js(@文档/@文件 引用浮层同源复用)
      Preview.open({
        title: f.name,
        meta: Preview.meta([{ iconName: 'file-text-line',
                              text: (f.mime || '') + ' · ' + UI.fmtSize(f.size) }]),
        actions: [
          { id: 'pv-download', label: '下载', icon: 'download-2-line', onClick: () => triggerDownload(f) },
          // "存为文档":把上传的 .md/.txt 变成项目文档(否则只能下载→改→再传,还是新建不是新版本)
          { id: 'pv-to-doc', label: '存为文档', icon: 'file-add-line', onClick: ({ close }) => convertToDoc(f, { close }) },
        ],
        preview: {
          kind: isMd ? 'markdown' : 'text',
          url: FilesAPI.download(f.id, true),
          text: apiText(FilesAPI.download(f.id, true)),
        },
      });
    }

    /** 把文本类文件转为项目文档(内容直接落进新文档,原文件保留) */
    async function convertToDoc(f, modalRef) {
      const title = f.name.replace(/\.[^.]+$/, '') || '未命名文档';
      const ok = await UI.confirmDialog(
        '将「' + f.name + '」的内容创建为项目文档「' + title + '」?原文件保留不动。', { okText: '创建' });
      if (!ok) return;
      try {
        const text = await apiText(FilesAPI.download(f.id, true));
        const created = await api(Endpoints.docsOf(projectId),
          { method: 'POST', body: { title } });
        // 基线取建文档时返回的 version:新文档没有并发写入者,但保存契约要求带基线
        await api(Endpoints.docContent(created.id),
          { method: 'PUT', body: { content: text, baseVersion: created.version || 0 } });
        if (modalRef) modalRef.close(true);
        UI.toast('已创建文档,可在「文档」中编辑', 'success');
        location.hash = App.route.project(projectId, 'docs', created.id);
      } catch (e) { UI.err(e); }
    }

    /** 分享链接面板:复制链接 / 重新生成 / 吊销。
     *  token 是凭据 —— 面板是它唯一露出的地方,列表只带 shared 布尔(见 files.file_json),
     *  所以从列表进来时先补一次详情,把链接本身取回来。 */
    function showShareDialog(f) {
      if (!f.shareUrl) {
        api(Endpoints.fileMeta(f.id)).then((meta) => {
          if (meta.shareUrl) showShareDialog(Object.assign({}, f, meta));
          else { UI.toast('这个文件当前没有有效的分享链接', 'warning'); load(); }
        }).catch(UI.err);
        return;
      }
      const url = location.origin + f.shareUrl;
      const fi = UI.fileIcon(f.mime);
      const exp = f.shareExpiresAt ? '有效期至 ' + UI.fmtDate(f.shareExpiresAt) : '长期有效';
      const m = UI.modal({
        title: '分享链接',
        body:
          '<div class="pub-file">' +
            UI.icon(fi.icon, 'row-icon ' + fi.cls) +
            '<span class="pub-file-name" title="' + UI.esc(f.name) + '">' + UI.esc(f.name) + '</span>' +
          '</div>' +
          UI.banner({
            kind: 'info', icon: 'information-line',
            text: '持有链接的人无需登录即可下载(' + exp + ')。吊销或删除文件后,链接立刻失效。',
          }) +
          '<button type="button" class="pub-link" id="pub-link" title="点击复制链接">' +
            '<code>' + UI.esc(url) + '</code>' + UI.icon('file-copy-line') +
          '</button>' +
          '<div class="field flush mt-3"><label>重新生成(旧链接立即失效)</label>' +
          '<select class="select" id="share-exp">' +
            '<option value="">长期有效</option>' +
            '<option value="1">1 天后过期</option>' +
            '<option value="7">7 天后过期</option>' +
            '<option value="30">30 天后过期</option>' +
          '</select></div>',
        actions: [
          { label: '吊销链接', kind: 'danger-outline', onClick: ({ close }) => {
            close(true);
            UI.confirmAction('吊销后,已发出的链接立刻失效(文件本身不受影响)。确定吊销?',
              { okText: '吊销', okMsg: '已吊销分享链接' },
              () => api(Endpoints.fileShare(f.id), { method: 'DELETE' }).then(load));
          } },
          { label: '重新生成', kind: 'filled', onClick: async ({ body, btn }) => {
            btn.disabled = true;
            try {
              const days = body.querySelector('#share-exp').value;
              const r = await api(Endpoints.fileShare(f.id),
                { method: 'POST', body: days ? { expireDays: Number(days) } : {} });
              UI.copyText(location.origin + r.url);
              UI.toast('已生成新链接(旧的已失效),已复制到剪贴板', 'success');
              await load();
            } catch (err) { UI.err(err); }
            btn.disabled = false;
          } },
        ],
      });
      m.body.querySelector('#pub-link').onclick = () => UI.copyText(url);
    }

    // 列表交互(事件委托)
    rowsEl.addEventListener('click', async (e) => {
      const f = itemOf(e.target);
      if (!f) return;

      if (e.target.classList.contains('sel-box')) {
        e.stopPropagation(); // 网格瓦片整块可点:勾选不应触发"打开"
        setRowSelected(e.target.closest(ITEM_SEL), e.target.checked);
        updateBatchBar();
        return;
      }
      if (e.target.closest('.act-rename')) {
        const name = await UI.inputDialog({
          title: f.kind === 'folder' ? '重命名文件夹' : '重命名文件',
          label: '名称', value: f.name,
        });
        if (!name) return;
        try {
          await api(FilesAPI.url(f.kind, f.id), { method: 'PATCH', body: { name } });
          UI.toast('已重命名', 'success');
          await load();
        } catch (err) { UI.err(err); }
        return;
      }
      if (e.target.closest('.act-del')) {
        const ok = await UI.confirmAction(deleteTip(f), { okMsg: '已删除(可在回收站恢复)' }, async () => {
          await api(FilesAPI.url(f.kind, f.id), { method: 'DELETE' });
          selected.delete(f.kind + ':' + f.id);
          await load();
        });
        return;
      }
      if (e.target.closest('.act-preview')) { await openPreview(f); return; }
      if (e.target.closest('.act-download')) { triggerDownload(f); return; }
      if (e.target.closest('.act-version-upload')) { pickVersionFile(f); return; }
      if (e.target.closest('.act-versions')) { openVersionDrawer(f); return; }
      // 文件夹的下载图标 = 打包下载整棵子树(保留目录结构)
      if (e.target.closest('.act-download-dir')) {
        UI.download(Endpoints.filesZip({ folderIds: f.id }),
          { filename: (f.name || '文件夹') + '.zip' });
        return;
      }
      if (e.target.closest('.act-share')) {
        // 已分享:图标是分享面板入口(复制链接 / 吊销都在面板里)
        if (f.shared) { showShareDialog(f); return; }
        await UI.confirmAction(
          '分享后,任何拿到链接的人无需登录即可下载「' + f.name + '」。' +
          '适合"把这一份发给不在本项目里的同事",但请注意它不再受项目权限保护。确定分享?',
          { okText: '分享', okMsg: '已建立分享链接' },
          async () => {
            const r = await api(Endpoints.fileShare(f.id), { method: 'POST', body: {} });
            await load();
            showShareDialog(Object.assign({}, f, { shared: true, shareUrl: r.url, shareExpiresAt: r.expiresAt }));
          });
        return;
      }
      if (e.target.closest('.act-move')) {
        MoveTarget.open({ item: f, kind: f.kind === 'folder' ? 'folder' : 'file',
          projectId, parentId: curFolderId(), onDone: load });
        return;
      }
      // 网格瓦片的「更多」:与右键菜单同一份条目
      if (e.target.closest('.act-tile-more')) {
        openRowMenu(0, 0, fileMenuItems(f), e.target.closest('.act-tile-more'));
        return;
      }
      // 操作条自身的空白区不落到"打开/下载"
      if (e.target.closest('.tile-acts')) return;

      // 点击名称 / 网格瓦片:按类型穷举 —— 文件夹下钻、可预览的打开预览、其余下载。
      // 未知类型什么都不做:绝不能让"类型不认识"静默退化成一次下载(那会打到同 id 的文件)
      if (e.target.closest('.row-link') || e.target.closest('.tile')) {
        if (f.kind === 'folder') {
          await gotoFolder(f.id, f.name);
        } else if (f.kind !== 'file') {
          console.error('云空间:未知行类型,已忽略点击', f);
        } else if (previewKind(f)) {
          await openPreview(f);
        } else {
          triggerDownload(f);
        }
      }
    });

    // 列头排序(升序再点切降序)。排序走服务端并记忆 —— 分页与排序必须在一起,
    // 客户端只排当前页会得到"每页内部有序"这种看似正确实则错误的结果
    tableEl.querySelectorAll('.dh-sort').forEach((b) => {
      b.addEventListener('click', async () => {
        const nextKey = b.dataset.sort;
        await applySort(nextKey, nextKey === sortKey ? -sortDir : 1);
      });
    });

    // 工具条排序:网格没有表头,这里是网格下唯一的排序入口;与列头同一组状态
    if (sortSeg) UI.segWire(sortSeg, async (key) => {
      if (key === sortKey) return;
      await applySort(key, 1);
    });
    if (sortDirBtn) sortDirBtn.onclick = async () => {
      await applySort(sortKey, -sortDir);
    };

    // 视图切换:列表 / 网格(记忆)。窄屏强制列表(§6.11):网格按钮禁用,
    // 形态由 MQL 决定而非点击 —— 离开窄屏后恢复用户此前主动选择的形态。
    if (viewSeg) UI.segWire(viewSeg, async (key) => {
      if (key === 'grid' && isNarrow()) { UI.segSet(viewSeg, 'list'); return; }
      prefView = key;
      viewMode = key;
      UI.pref.set('td:drive-view', prefView);
      // 切到网格而用户从未主动选过排序时,用"最新在前"(图片墙的用途);
      // 一旦用户点过列头排序(savedSort 有值),就尊重他的选择
      if (viewMode === 'grid' && !UI.pref.get('td:drive-sort', null)) {
        sortKey = 'time';
        sortDir = -1;
        paintSortControls();
      }
      await load();
    });

    /** 窄屏形态切换:强制列表并禁用网格按钮;离开时恢复偏好形态。 */
    function applyNarrowView() {
      const narrow = isNarrow();
      const gridBtn = viewSeg && viewSeg.querySelector('button[data-key="grid"]');
      if (gridBtn) gridBtn.disabled = narrow;
      const want = narrow ? 'list' : prefView;
      if (want === viewMode) {
        if (viewSeg) UI.segSet(viewSeg, viewMode);
        return;
      }
      viewMode = want;
      if (viewSeg) UI.segSet(viewSeg, viewMode);
      load();
    }
    applyNarrowView();
    if (UI.NARROW) UI.NARROW.addEventListener('change', applyNarrowView);

    // 面包屑回跳:裁剪栈,当前目录随栈顶一起回退
    UI.crumbsWire(crumbEl, async (idx) => {
      stack = stack.slice(0, idx + 1);
      syncUrl();
      await load();
    });

    // 新建文件夹:{name, projectId, parentId?}
    const mkdirBtn = root.querySelector('#btn-mkdir');
    if (mkdirBtn) mkdirBtn.onclick = async () => {
      const name = await UI.inputDialog({ title: '新建文件夹', label: '文件夹名称' });
      if (!name) return;
      try {
        const body = { name, projectId };
        const parent = curFolderId();
        if (parent) body.parentId = parent;
        await api(Endpoints.folders(), { method: 'POST', body });
        UI.toast('已创建文件夹', 'success');
        await load();
      } catch (err) { UI.err(err); }
    };

    // ---------- 上传:队列(并发 3)+ 进度面板 + 文件夹结构保留 ----------
    const CONCURRENCY = 3;
    // 不做"离开视图即 abort":切标签/切页面时在传的大文件应当继续传完,
    // 中途取消等于让用户白传;真正要兜底的"永远挂着不动"由 apiUpload 的
    // 空闲超时覆盖(见 api.js 的说明)。
    const upQueue = [];
    let upRunning = 0, upDone = 0, upTotal = 0;

    function updateUpTitle() {
      if (!upRunning && !upQueue.length && conflicts.length) {
        upTitle.textContent = '有 ' + conflicts.length + ' 个同名文件待处理';
        return;
      }
      upTitle.textContent = upRunning || upQueue.length
        ? '上传中 ' + upDone + '/' + upTotal : '上传完成';
    }

    function addUpRow(name) {
      const row = document.createElement('div');
      row.className = 'up-row';
      row.innerHTML = '<div class="up-info"><span class="up-name" title="' + UI.esc(name) + '">' + UI.esc(name) +
        '</span><span class="up-state">等待中</span></div>' +
        '<div class="up-bar"><i style="width:0%"></i></div>';
      upList.appendChild(row);
      return row;
    }

    function setUpState(row, pct, text, cls) {
      row.querySelector('.up-bar i').style.width = Math.max(0, Math.min(100, pct)) + '%';
      const st = row.querySelector('.up-state');
      st.textContent = text;
      st.className = 'up-state' + (cls ? ' ' + cls : '');
    }

    // XHR 上传(fetch 拿不到上传进度);凭据走同源 Cookie,与 api() 一致。
    // 请求体 = 文件本身(raw body),元数据走 query string —— 见 files.py upload_file
    // 的注释:multipart 会让 >1MB 的文件在服务端落两次盘(先 spool 再拷),
    // 传大文件要两倍空间与 IO。
    // task.target 非空 = 显式上传新版本:走 /files/{id}/versions,文件名由服务端保持。
    function xhrUpload(task, onProgress) {
      const url = task.target
        ? Endpoints.fileVersionUpload(task.target.id, undefined, task.note)
        : FilesAPI.upload({
            projectId,
            folderId: task.folderId,
            name: task.file.name,
            nameMode: task.nameMode,
            versionOf: task.versionOf,
          });
      return apiUpload(url, task.file, { onProgress });
    }

    /** 普通上传撞同目录同名的 409:服务端只做预检、未写任何数据,文件还在内存的
     *  File 对象里。收集到 conflicts 队列,整批队列清空后只弹一次窗口。 */
    function isNameConflict(err) {
      return !!(err && err.code === 'name_exists' && err.detail && err.detail.existing);
    }

    function pumpQueue() {
      while (upRunning < CONCURRENCY && upQueue.length) {
        const task = upQueue.shift();
        upRunning++;
        updateUpTitle();
        xhrUpload(task, (pct) => setUpState(task.row, pct, pct + '%'))
          .then(() => setUpState(task.row, 100, '完成', 'ok'))
          .catch((err) => {
            if (!task.target && isNameConflict(err)) {
              // 计入冲突而不是失败:行停在"待选择",用户选完再重试
              task.conflicted = true;
              setUpState(task.row, 0, '同名,待选择', 'warn');
              conflicts.push({ task, existing: err.detail.existing });
              return;
            }
            setUpState(task.row, 100, err.message, 'fail');
          })
          .finally(() => {
            upRunning--;
            if (!task.conflicted) upDone++;
            activeUploads = upRunning + upQueue.length;
            updateUpTitle();
            if (!activeUploads) afterUpIdle();
            pumpQueue();
          });
      }
    }

    /** 队列清空 ≠ 批次结束:还有同名冲突就先弹批量选择器,否则统一刷新当前目录
     *  (keepSelection 让"上传新版本"之后的行选中态不丢)。 */
    function afterUpIdle() {
      if (conflicts.length) resolveConflicts();
      else load({ keepSelection: true });
    }

    /** 批量同名冲突:一次弹窗、逐行选择。选择后按行用 name_mode=keep 或
     *  version_of=existing.id 重试;关闭窗口 = 明确跳过(不静默丢文件)。 */
    function resolveConflicts() {
      if (!conflicts.length || conflictModal) return;
      const batch = conflicts.slice();
      let submitted = false;
      conflictModal = UI.modal({
        title: '同名文件处理',
        body: '<p class="modal-text">本次上传有 ' + batch.length +
          ' 个文件与当前目录中的文件同名。请逐个选择处理方式;关闭窗口会跳过这些文件。</p>' +
          '<div class="drive-conflicts">' + batch.map((c, i) => {
            const ex = c.existing || {};
            return '<div class="drive-conflict">' +
              '<div class="drive-conflict-main">' +
                '<div class="drive-conflict-name" title="' + UI.esc(c.task.file.name) + '">' +
                  UI.esc(c.task.file.name) + '</div>' +
                '<div class="drive-conflict-tip">已存在同名文件 · ' + UI.esc(UI.fmtSize(ex.size)) +
                  ' · ' + UI.esc(UI.fmtWhen(ex.updatedAt)) +
                  (ex.updatedByName ? ' · 由 ' + UI.esc(ex.updatedByName) + ' 上传' : '') + '</div>' +
              '</div>' +
              '<select class="select drive-conflict-mode" data-i="' + i + '">' +
                '<option value="version">创建为新版本</option>' +
                '<option value="keep">保留两个(自动改名)</option>' +
              '</select>' +
            '</div>';
          }).join('') + '</div>',
        actions: [
          { label: '跳过这些文件', kind: 'text', onClick: ({ close }) => close() },
          { label: '继续上传', kind: 'filled', onClick: ({ body, close, btn }) => {
            btn.disabled = true;
            const choices = batch.map((c, i) => {
              const sel = body.querySelector('.drive-conflict-mode[data-i="' + i + '"]');
              return { conflict: c, mode: sel ? sel.value : 'version' };
            });
            submitted = true;
            conflicts = conflicts.filter((c) => batch.indexOf(c) < 0);
            close();
            retryConflicts(choices);
          } },
        ],
        onClose: () => {
          conflictModal = null;
          if (!submitted) skipConflicts(batch);
          if (conflicts.length) resolveConflicts(); // 弹窗期间又上传出的冲突,再走一轮
        },
      });
    }

    function skipConflicts(batch) {
      batch.forEach((c) => setUpState(c.task.row, 100, '已跳过', 'warn'));
      conflicts = conflicts.filter((c) => batch.indexOf(c) < 0);
      upDone += batch.length;
      updateUpTitle();
      UI.toast('已跳过 ' + batch.length + ' 个同名文件(未上传)', 'warning');
      if (!conflicts.length) load({ keepSelection: true });
    }

    /** 冲突重试:沿用原任务的行(进度条不新增一行),选择决定重试参数。 */
    function retryConflicts(choices) {
      if (!choices.length) return;
      upPanel.hidden = false;
      choices.forEach(({ conflict, mode }) => {
        const task = conflict.task;
        setUpState(task.row, 0, '等待中');
        upQueue.push({
          file: task.file,
          folderId: task.folderId,
          row: task.row,
          nameMode: mode === 'keep' ? 'keep' : undefined,
          versionOf: mode === 'version' ? conflict.existing.id : undefined,
        });
      });
      activeUploads = upRunning + upQueue.length;
      updateUpTitle();
      pumpQueue();
    }

    // 入队一组任务:{file, folderId} 普通上传;{file, target} 显式上传新版本
    function enqueue(tasks) {
      if (!canWrite || !tasks.length) return;
      upPanel.hidden = false;
      tasks.forEach((t) => {
        t.row = addUpRow(t.target ? '新版本 · ' + t.target.name : t.file.name);
        upQueue.push(t);
      });
      upTotal += tasks.length;
      activeUploads = upRunning + upQueue.length;
      updateUpTitle();
      pumpQueue();
    }

    root.querySelector('#up-close').onclick = () => {
      if (activeUploads) return; // 上传中不收起,避免误解为取消
      upPanel.hidden = true;
      upList.innerHTML = '';
      upDone = 0; upTotal = 0;
    };

    // 目录上传:按相对路径逐级建文件夹(路径→folderId 会话内缓存,整批先串行建好再传,避免并发建重名)
    const dirCache = new Map(); // "{parentId|''}/{路径}" → folderId
    async function ensureDirPath(parts) {
      let parentId = curFolderId(); // 起点 = 当前目录
      let prefix = (parentId || '') + '/';
      for (const part of parts) {
        prefix += part + '/';
        if (dirCache.has(prefix)) { parentId = dirCache.get(prefix); continue; }
        const body = { name: part, projectId };
        if (parentId) body.parentId = parentId;
        const created = await api(Endpoints.folders(), { method: 'POST', body });
        dirCache.set(prefix, created.id);
        parentId = created.id;
      }
      return parentId;
    }

    // 入队带相对路径的文件(来自 webkitdirectory / 拖拽目录)
    async function enqueueWithPaths(items) {
      if (!canWrite) return;
      const tasks = [];
      try {
        for (const it of items) {
          const parts = (it.relPath || '').split('/').filter(Boolean);
          const dir = parts.length ? await ensureDirPath(parts.slice(0, -1)) : curFolderId();
          tasks.push({ file: it.file, folderId: dir });
        }
      } catch (err) { UI.err(err); return; }
      enqueue(tasks);
    }

    if (uploadBtn) uploadBtn.onclick = () => uploadInput.click();
    const upDirBtn = root.querySelector('#btn-upload-dir');
    if (upDirBtn) upDirBtn.onclick = () => uploadDirInput.click();
    uploadInput.addEventListener('change', () => {
      const files = Array.from(uploadInput.files || []);
      uploadInput.value = '';
      enqueue(files.map((f) => ({ file: f, folderId: curFolderId() })));
    });
    uploadDirInput.addEventListener('change', () => {
      const files = Array.from(uploadDirInput.files || []);
      uploadDirInput.value = '';
      enqueueWithPaths(files.map((f) => ({ file: f, relPath: f.webkitRelativePath || f.name })));
    });

    // 拖拽:优先走 webkitGetAsEntry 递归目录(保留结构),降级为纯文件列表
    function readEntry(entry, prefix) {
      return new Promise((resolve) => {
        if (entry.isFile) {
          entry.file((file) => resolve([{ file, relPath: prefix + file.name }]), () => resolve([]));
        } else if (entry.isDirectory) {
          const reader = entry.createReader();
          const entries = [];
          const readBatch = () => {
            // readEntries 每次最多 100 项,必须循环读到空为止
            reader.readEntries((batch) => {
              if (!batch.length) {
                Promise.all(entries.map((en) => readEntry(en, prefix + entry.name + '/')))
                  .then((groups) => resolve(groups.flat()));
              } else {
                entries.push(...batch);
                readBatch();
              }
            }, () => resolve([]));
          };
          readBatch();
        } else resolve([]);
      });
    }

    ['dragenter', 'dragover'].forEach((ev) => {
      tableEl.addEventListener(ev, (e) => {
        e.preventDefault();
        if (canWrite) tableEl.classList.add('dragover'); // VIEWER 不给"可以放进来"的暗示
      });
    });
    tableEl.addEventListener('dragleave', (e) => {
      if (!tableEl.contains(e.relatedTarget)) tableEl.classList.remove('dragover');
    });
    tableEl.addEventListener('drop', async (e) => {
      e.preventDefault();
      tableEl.classList.remove('dragover');
      if (!canWrite) return;
      const items = Array.from((e.dataTransfer && e.dataTransfer.items) || []);
      const entries = items.map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null)).filter(Boolean);
      if (entries.length) {
        const groups = await Promise.all(entries.map((en) => readEntry(en, '')));
        await enqueueWithPaths(groups.flat());
      } else {
        const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
        if (files.length) enqueue(files.map((f) => ({ file: f, folderId: curFolderId() })));
      }
    });

    // 深链/刷新:把目标文件夹解析成完整路径栈(面包屑随 load() 一起重绘)。
    // 不 await:骨架已经画在页面上了,数据到了就地替换(见 ARCHITECTURE「渲染契约」)。
    // 失败只报一声就够 —— 这一层的容器是本层自己的,写进废弃节点也不会污染别处
    resolveStack(initialFolder).then(load).then(() => {
      loadStorage(); // 占用是辅助信息,不阻塞主列表渲染
      // 深链高亮:从文档里 @文件 引用跳转过来(?highlight=文件ID),滚动定位并闪烁提示
      if (highlight) {
        const row = rowsEl.querySelector('[data-id="' + CSS.escape(highlight) + '"]');
        if (row) {
          row.scrollIntoView({ block: 'center' });
          row.classList.add('row-flash');
          setTimeout(() => row.classList.remove('row-flash'), 2500);
        }
      }
    }).catch((e) => UI.err(e));

    // ---------- 变更轮询与离开清理 ----------
    // 同一空间的其他人上传/改版本后,当前目录自动刷新:游标从服务端返回的 nextSeq
    // 继续;只在页面可见、且没有上传在飞时请求(上传中的重绘会打断进度观感)。
    let changeSeq = 0;
    let pollBusy = false;
    let pollTimer = null;
    let disposed = false;

    async function pollChanges() {
      if (disposed) return;
      // 没接 dispose 时的兜底:行容器已经离开文档 = 本层被换掉,立刻停表
      if (!rowsEl.isConnected) { cleanup(); return; }
      if (document.visibilityState !== 'visible' || pollBusy || activeUploads || conflicts.length) return;
      pollBusy = true;
      try {
        const r = await api(Endpoints.fileChanges(projectId, changeSeq)) || {};
        if (disposed) return;
        const changes = r.changes || [];
        changeSeq = Number(r.nextSeq) || changeSeq;
        if (changes.length) await load({ keepSelection: true });
      } catch (e) {
        // 轮询是辅助刷新:失败静默,下一轮从同一个 nextSeq 重试
      } finally {
        pollBusy = false;
      }
    }

    const onVisibility = () => { if (document.visibilityState === 'visible') pollChanges(); };

    /** 离开本层:定时器、全局监听与抽屉全部回收(抽屉挂在 body 上,不随作用域节点移除)。
     *  dispose 由 filesLevel 的 ctx.dispose 注入(见 ref/interfaces.md);漏接时下一轮
     *  tick 发现行容器已脱离文档也会自清。 */
    function cleanup() {
      if (disposed) return;
      disposed = true;
      clearInterval(pollTimer);
      pollTimer = null;
      document.removeEventListener('visibilitychange', onVisibility);
      if (UI.NARROW) UI.NARROW.removeEventListener('change', applyNarrowView);
      closeVersionDrawer();
    }

    pollTimer = setInterval(pollChanges, 15000);
    document.addEventListener('visibilitychange', onVisibility);
    if (typeof dispose === 'function') dispose(cleanup);

    return root;
  };

  // 移动文件 / 文件夹:选择器由 views/move-target.js 提供(与文档移动同一套 UI,
  // 见那里的说明);这里只负责"移动完刷新当前目录"。
})();
