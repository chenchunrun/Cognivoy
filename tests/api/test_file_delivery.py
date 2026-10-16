from pathlib import Path

from cognivoy.api.file_delivery import content_disposition, untrusted_file_policy


def test_uploaded_html_and_svg_are_never_inline() -> None:
    for name in ("page.html", "drawing.svg", "payload.xhtml", "script.js"):
        media_type, disposition, headers = untrusted_file_policy(Path(name))
        assert media_type == "application/octet-stream"
        assert disposition == "attachment"
        assert headers["X-Content-Type-Options"] == "nosniff"


def test_passive_documents_remain_previewable() -> None:
    media_type, disposition, _headers = untrusted_file_policy(Path("report.pdf"))
    assert media_type == "application/pdf"
    assert disposition == "inline"


def test_content_disposition_cannot_inject_headers() -> None:
    value = content_disposition('bad"\\name.svg', "attachment")
    assert 'filename="bad__name.svg"' in value
    assert "filename*=UTF-8''bad%22%5Cname.svg" in value
