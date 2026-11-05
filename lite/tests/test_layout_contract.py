"""布局契约静态巡检(ARCHITECTURE.md「布局契约」节的机器化 —— 违例即红)。

契约三条,各对应一组断言:
1. 几何:media/@container 查询块内不得出现间距/宽度赋值(间距只允许令牌或 clamp
   连续函数);带「契约身份」注释的块豁免(密度/功能/body 挂载三种身份)
2. 断点:960(形态)只允许出现在 app.css;JS 侧只允许 ui.js 持有 960 字面量(UI.NARROW)
3. 面板状态:UI.dualPanel 是唯一面板状态原语;旧双状态类名不得回潮
另锚住两个连续边距的定义本身(--g-page / --editor-x),防止被改回断点阶梯。
"""
import re
from pathlib import Path

import pytest

from _harness import WEB_DIR

CSS_DIR = WEB_DIR / "css"
JS_DIR = WEB_DIR / "js"

# 查询块内禁止赋值的属性(几何层契约:这些量只许令牌或 clamp 连续函数)
SPACING_PROP = re.compile(
    r"(?:^|[;{}\n])\s*[a-z-]*(?:width|height|padding|margin|gap|inset|left|right|top|bottom)\s*:",
    re.M,
)
IDENTITY_MARK = "契约身份"
BP_FORM = "960"  # 形态断点:内联 ↔ 浮层,唯一物理离散切换,查询块整体豁免


def _query_blocks(css_text):
    """拆出所有 @media / @container 块:(条件, 前置窗口含块头注释, 块体)。"""
    blocks = []
    for m in re.finditer(r"@(media|container)\s*([^,{]+)\{", css_text):
        i = m.end()
        depth = 1
        while depth and i < len(css_text):
            if css_text[i] == "{":
                depth += 1
            elif css_text[i] == "}":
                depth -= 1
            i += 1
        prelude = css_text[max(0, m.start() - 200):m.start()]
        blocks.append((m.group(2).strip(), prelude, css_text[m.end():i - 1]))
    return blocks


def test_no_spacing_assignment_in_query_blocks():
    violations = []
    for path in sorted(CSS_DIR.glob("*.css")):
        for cond, prelude, body in _query_blocks(path.read_text(encoding="utf-8")):
            if "960px" in cond or "961px" in cond:
                continue  # 形态块:position/visibility/宽度切换是身份本身,整体豁免
            if IDENTITY_MARK in prelude or IDENTITY_MARK in body:
                continue  # 密度/功能/body 挂载:块注释已注明身份
            for prop in SPACING_PROP.finditer(body):
                violations.append(f"{path.name} [{cond}] …{prop.group(0).strip()}")
    assert not violations, "查询块内出现间距/宽度赋值(须改令牌/clamp,或为块注明契约身份):\n" + \
        "\n".join("  - " + v for v in violations)


def test_form_breakpoint_only_in_app_css():
    stray = []
    for path in sorted(CSS_DIR.glob("*.css")):
        if path.name == "app.css":
            continue
        for cond, _, _ in _query_blocks(path.read_text(encoding="utf-8")):
            if BP_FORM in cond:
                stray.append(f"{path.name}: @… ({cond})")
    assert not stray, "960 形态断点只允许出现在 app.css:\n" + "\n".join("  - " + s for s in stray)


def test_js_breakpoint_single_source():
    offenders = []
    for path in sorted(JS_DIR.rglob("*.js")):
        text = path.read_text(encoding="utf-8")
        if "max-width: 960" in text and path.name != "ui.js":
            offenders.append(path.name)
    assert not offenders, "960 字面量只允许在 ui.js(UI.NARROW):\n" + "\n".join("  - " + o for o in offenders)


def test_dual_panel_is_the_only_panel_state_primitive():
    ui_text = (JS_DIR / "ui.js").read_text(encoding="utf-8")
    assert "dualPanel" in ui_text and "NARROW" in ui_text
    # 面板只剩一个:壳侧栏(app.js);文档树已在左栏内,不再是独立面板
    usages = [
        p.name for p in JS_DIR.rglob("*.js")
        if p.name != "ui.js" and "UI.dualPanel" in p.read_text(encoding="utf-8")
    ]
    assert sorted(usages) == ["app.js"], \
        f"面板状态原语的消费方应只有壳侧栏,实际: {usages}"
    all_text = "\n".join(p.read_text(encoding="utf-8") for p in JS_DIR.rglob("*.js"))
    for css in ("side-collapsed", "tree-collapsed", "nav-open", "carryOpen"):
        assert css not in all_text, f"旧双状态痕迹回潮:JS 里出现 {css}"
    all_css = "\n".join(p.read_text(encoding="utf-8") for p in CSS_DIR.glob("*.css"))
    for cls in ("side-collapsed", "tree-collapsed", "nav-open"):
        assert cls not in all_css, f"旧双状态类名回潮:CSS 里出现 {cls}"


def test_continuous_gutters_are_functions_not_steps():
    tokens = (CSS_DIR / "tokens.css").read_text(encoding="utf-8")
    editor = (CSS_DIR / "editor.css").read_text(encoding="utf-8")
    assert re.search(r"--g-page:\s*clamp\(", tokens), "--g-page 必须是 clamp 连续函数"
    assert re.search(r"--editor-x:\s*clamp\([^;]*cqw", editor), "--editor-x 必须是含 cqw 的 clamp 连续函数"
    assert "--editor-x: var(--sp-" not in editor, "--editor-x 不得退回令牌阶梯"


def test_design_scale_is_converged():
    """W5 设计刻度的机器化:表面 3 层、字阶 8 档且每档有配对行高;旧档位不得回流。

    只钉令牌契约(语义),不钉具体像素消费者 —— 布局行为由浏览器用例守。
    """
    tokens = (CSS_DIR / "tokens.css").read_text(encoding="utf-8")
    surfaces = sorted(set(re.findall(r"^\s*(--md-surface[\w-]*):", tokens, re.M)))
    assert surfaces == ["--md-surface", "--md-surface-container-high", "--md-surface-container-low"], \
        f"表面必须收敛为 3 层: {surfaces}"
    fs = sorted(set(re.findall(r"^\s*(--fs-[\w-]+):", tokens, re.M)))
    expected_fs = sorted({
        "--fs-display", "--fs-headline", "--fs-title-lg", "--fs-title",
        "--fs-body", "--fs-prose", "--fs-label", "--fs-caption",
    })
    assert fs == expected_fs, f"字阶必须恰好 8 档: {fs}"
    lh = set(re.findall(r"^\s*(--lh-[\w-]+):", tokens, re.M))
    expected_lh = {name.replace("--fs-", "--lh-") for name in expected_fs}
    assert expected_lh <= lh, f"8 档字阶缺少配对行高: {sorted(expected_lh - lh)}"
    all_css = "\n".join(p.read_text(encoding="utf-8") for p in CSS_DIR.glob("*.css"))
    for old in ("--md-surface-container-lowest", "--md-surface-container-highest",
                "--md-surface-container:", "--md-surface-dim",
                "--fs-subtitle", "--fs-sm", "--fs-xs", "--lh-tight", "--lh-normal"):
        assert old not in all_css, f"旧刻度令牌回流: {old}"
