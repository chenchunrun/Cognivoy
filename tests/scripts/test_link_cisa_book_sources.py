import importlib.util
from pathlib import Path

from cognivoy.book.models import SourceAnchor

SCRIPT_PATH = Path(__file__).parents[2] / "scripts" / "link_cisa_book_sources.py"
SPEC = importlib.util.spec_from_file_location("link_cisa_book_sources", SCRIPT_PATH)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
anchors_for_order = MODULE.anchors_for_order
merge_anchors = MODULE.merge_anchors


def test_cisa_domain_one_source_locators_include_both_books() -> None:
    refs = [anchor.ref for anchor in anchors_for_order(3)]
    assert any("Review Manual" in anchor.snippet for anchor in anchors_for_order(3))
    assert any("pdf-pages=22-62" in ref for ref in refs)
    assert any("book-pages=97-160" in ref for ref in refs)


def test_cisa_domain_five_source_locators_use_current_outline_first() -> None:
    anchors = anchors_for_order(16)
    assert anchors[0].ref.endswith("official-exam-outline-2026.md")
    assert any("pdf-pages=205-end" in anchor.ref for anchor in anchors)


def test_merge_anchors_is_idempotent() -> None:
    anchor = SourceAnchor(kind="kb", ref="cisa-official:source", snippet="source")
    merged, added = merge_anchors([anchor], [anchor])
    assert merged == [anchor]
    assert added == 0
