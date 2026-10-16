"""Reject incomplete/metadata-only HTML without excluding supported fragments."""

import pytest

from cognivoy.agents.visualize.utils import is_valid_html_document, validate_visualization


@pytest.mark.parametrize(
    "html",
    [
        "",
        "An explanation rather than HTML",
        "<!DOCTYPE html>",
        "<!-- <html><body><div>not an element</div></body></html> -->",
        "<html></html>",
        "<html><head><title>Diagram</title></head><body></body></html>",
        "<head><style>body { color: red; }</style></head>",
        "<style>body::before { content: '<div>not markup</div>'; }</style>",
        "<script>document.body.innerHTML = '<div>not static markup</div>';</script>",
        "<template><div>A hidden template</div></template>",
        "<noscript><div>Not shown with scripting enabled</div></noscript>",
        '<meta charset="utf-8"><link rel="stylesheet" href="diagram.css">',
        "<html><head><title>Diagram</title></head><body><div>truncated",
        "<html><body><div>Diagram</div></body>",
        "<html><body><div>Diagram</div></html>",
        "<div><span>Missing span close</div>",
        "<div>Text</div><script>unfinished = true;",
        "<div>Text</div><style>body { color:",
    ],
)
def test_rejects_incomplete_or_non_renderable_html(html: str) -> None:
    valid, error = validate_visualization(html, "html")
    assert not valid
    assert error
    assert not is_valid_html_document(html)


def test_rejects_observed_truncated_model_output() -> None:
    # Real generation ended its first fenced block here and was previously
    # accepted solely because it contained <!DOCTYPE> and <html>.
    html = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>
  :root { --ink: #1e293b; }
  body { color: var(--ink); }
  ...
</style>"""
    valid, error = validate_visualization(html, "html")
    assert not valid
    assert "incomplete" in error


@pytest.mark.parametrize(
    "html",
    [
        "<div>可见文本</div>",
        "<p>A paragraph fragment</p>",
        "<section><h2>Learning phases</h2><p>Explanation...</p></section>",
        '<div>Truncate a title to 57 characters + "...".</div>',
        "<div>第一步 → 第二步 → ... → 第 n 步</div>",
        "<!DOCTYPE html><html><head><title>Diagram</title></head>"
        "<body><div>Visible card</div></body></html>",
        "<HTML><BODY><DIV>Case-insensitive HTML</DIV></BODY></HTML>",
        "<body>Visible text without a container element</body>",
        '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="20"/></svg>',
        '<div><svg viewBox="0 0 100 100"><path d="M0 0 L100 100"/></svg></div>',
        '<canvas id="chart"></canvas><script>'
        'document.querySelector("#chart").getContext("2d").fillRect(0,0,20,20);'
        "</script>",
        '<div id="root"></div><script>'
        'document.querySelector("#root").textContent="Interactive diagram";'
        "</script>",
        "<style>.shape { width: 20px; height: 20px; background: red; }</style>"
        '<div class="shape"></div>',
        '<div><img src="data:image/svg+xml,test" alt="Illustration"><br>Caption</div>',
        "<ul><li>First<li>Second</ul>",
        "<table><thead><tr><th>Stage<tbody><tr><td>Learning</table>",
        "<select><option>First<option>Second</select>",
        "<div><p>Optional paragraph end tag</div>",
        "<div><!-- <head>not real markup -->Visible</div>",
    ],
)
def test_preserves_renderable_html_documents_and_fragments(html: str) -> None:
    assert validate_visualization(html, "html") == (True, "")
    assert is_valid_html_document(html)


def test_non_html_render_validation_is_unchanged() -> None:
    assert validate_visualization('<svg viewBox="0 0 100 100"/>', "svg") == (True, "")
    assert validate_visualization("graph TD\nA-->B", "mermaid") == (True, "")
    assert validate_visualization('{"type":"bar","data":{}}', "chartjs") == (True, "")
