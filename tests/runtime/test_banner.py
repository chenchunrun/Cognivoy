from __future__ import annotations

from rich.console import Console

from cognivoy.runtime.banner import render_banner


def _plain_banner(language: str) -> str:
    console = Console(record=True, width=100, color_system=None)
    console.print(render_banner(language))
    return console.export_text()


def test_banner_uses_cognivoy_brand_without_upstream_affiliation() -> None:
    text = _plain_banner("en")

    assert "Cognivoy" in text
    assert "Your agent-native learning journey." in text
    assert "Personal intelligent learning companion" in text
    assert "DeepTutor" not in text
    assert "HKU" not in text


def test_banner_uses_chinese_product_subtitle() -> None:
    assert "个人智能学习伙伴" in _plain_banner("zh")
