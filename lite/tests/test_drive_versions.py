"""云空间版本交互的前端接线契约(W2-b)。

只钉真实行为契约,不做逐按钮/逐文案的字符串断言:
  1. 版本入口三处可达(行操作 / 右键菜单 / 选中单文件时的工具条主按钮)
  2. 同名 409 的两个重试分支(name_mode=keep 与 version_of)
  3. 历史版本下载与恢复的端点接线
  4. 变更轮询从 nextSeq 继续,离页由 dispose 清掉定时器
"""
import re
from pathlib import Path

from _harness import WEB_DIR

DRIVE = WEB_DIR / "js" / "views" / "drive.js"
CSS = WEB_DIR / "css" / "drive.css"


def _src():
    return DRIVE.read_text(encoding="utf-8")


def test_version_entries_and_drive_layout():
    src = _src()
    css = CSS.read_text(encoding="utf-8")
    # 三处入口:文件行操作、右键菜单、工具条(选中单文件时显示)
    assert "act-version-upload" in src and "act-versions" in src
    assert "contextmenu" in src and "btn-version-upload" in src
    # 显式新版本走 /files/{id}/versions,文件名由服务端保持
    assert "Endpoints.fileVersionUpload" in src
    # 交付形态:视图模式可持久化、列表行 44、右侧 400px 抽屉
    assert "td:drive-view" in src
    assert re.search(r"\.drive-table \.data-table-row\s*\{[^}]*height:\s*44px", css)
    assert re.search(r"\.drive-drawer\s*\{[^}]*width:\s*min\(400px, 100vw\)", css)


def test_same_name_conflict_offers_keep_and_new_version_retry():
    src = _src()
    # 只有带 existing 的 409 才进冲突队列;其余失败照常标红
    assert "name_exists" in src and "detail.existing" in src
    # 两个重试分支:保留两个 → name_mode=keep;创建为新版本 → version_of=id
    assert re.search(r"name_mode\s*:\s*opts\.nameMode", src)
    assert re.search(r"version_of\s*:\s*opts\.versionOf", src)
    assert "nameMode: mode === 'keep'" in src and "versionOf: mode === 'version'" in src
    # 批次内收集、队列清空后统一弹一次(不是每个文件各弹一次)
    assert "conflicts.push" in src and "function resolveConflicts" in src


def test_history_download_and_restore_are_wired():
    src = _src()
    assert "Endpoints.fileVersions" in src
    # 任意版本下载:fileDownload 的第三参
    assert "Endpoints.fileDownload(id, false, version)" in src
    # 恢复:POST {version},生成新版本后刷新时间线与列表
    assert re.search(r"Endpoints\.fileRestore[\s\S]{0,400}?version", src)


def test_change_polling_continues_from_next_seq_and_is_disposed():
    src = _src()
    assert "Endpoints.fileChanges(projectId, changeSeq)" in src
    assert re.search(r"setInterval\(\s*pollChanges\s*,\s*15000\s*\)", src)
    # 从服务端返回的 nextSeq 继续,不重复拉已看过的变更
    assert "r.nextSeq" in src
    # 离开本层:注册到上层 scope 的 dispose,定时器必须真的清掉
    assert "dispose(cleanup)" in src and "clearInterval(pollTimer)" in src


def test_grid_tiles_expose_version_actions_and_toolbar_sort():
    src = _src()
    css = CSS.read_text(encoding="utf-8")
    # 网格瓦片操作条:上传新版本 / 版本历史 / 更多,且与行操作/右键菜单同源
    assert "function tileActsHtml" in src and "act-tile-more" in src
    assert "function fileMenuItems" in src
    assert re.search(r"openRowMenu\(0,\s*0,\s*fileMenuItems\(f\),", src)
    assert re.search(r"\.tile:hover \.tile-acts", css)
    # 触屏没有 hover:coarse pointer 常显,否则版本入口不可达
    assert re.search(r"@media \(hover: none\), \(pointer: coarse\)", css)
    # 工具条排序(网格没有表头)+ 升降序:与列头共用 applySort 与偏好
    assert "drive-sort-seg" in src and "btn-sort-dir" in src
    assert "function applySort" in src and re.search(r"UI\.segWire\(sortSeg", src)
    assert src.count("applySort(") >= 4


def test_version_note_is_optional_and_rendered_in_timeline():
    src = _src()
    # 备注可选、≤200,随显式新版本上传一起提交
    assert "maxlength: 200" in src
    assert re.search(r"fileVersionUpload\(task\.target\.id,\s*undefined,\s*task\.note\)", src)
    # 时间线展示备注(无备注不渲染该行)
    assert "v.note" in src and "drive-v-note" in src
    # 同名冲突窗展示上传者姓名(服务端契约 existing.updatedByName)
    assert "updatedByName" in src


def test_narrow_view_forces_list_and_unregisters_mql():
    src = _src()
    # 初始即按 MQL 决定形态;窄屏期间偏好形态另存,不改写用户偏好
    assert re.search(r"isNarrow\(\)\s*\?\s*'list'", src)
    assert "prefView" in src and re.search(r"gridBtn\.disabled\s*=\s*narrow", src)
    # 进入/离开窄屏都跟随,离页时摘掉监听
    assert re.search(r"UI\.NARROW\.addEventListener\('change',\s*applyNarrowView\)", src)
    assert re.search(r"UI\.NARROW\.removeEventListener\('change',\s*applyNarrowView\)", src)
