"""Adversarial text must not cause repeated suffix scans."""

import time

import pytest

from cognivoy.agents.math_animator.renderer import YON_IMAGE_PATTERN
from cognivoy.services.memory.consolidator.parse import _extract_json_object
from cognivoy.services.persona.service import PersonaService
from cognivoy.services.skill.service import SkillService
from cognivoy.services.voice.base import strip_markdown_for_speech


@pytest.mark.parametrize("service", [PersonaService, SkillService])
def test_unterminated_frontmatter_is_linear(service):
    text = "---\n" + "\n\t" * 30000
    started = time.monotonic()
    assert service._parse_frontmatter(text) == ({}, text)
    assert time.monotonic() - started < 1


@pytest.mark.parametrize("unit", ["<", "![", "[](", "~~!"])
def test_speech_markup_does_not_rescan_unterminated_spans(unit):
    text = unit * 30000
    started = time.monotonic()
    strip_markdown_for_speech(text)
    assert time.monotonic() - started < 1


def test_json_extraction_does_not_rescan_whitespace_suffix():
    text = '{"ok": true}' + "\t" * 30000 + "x"
    started = time.monotonic()
    assert _extract_json_object(text) == '{"ok": true}'
    assert time.monotonic() - started < 1


def test_manim_anchor_does_not_rescan_whitespace():
    text = "###yon_image_0_start###" + "\t" * 30000
    started = time.monotonic()
    assert not list(YON_IMAGE_PATTERN.finditer(text))
    assert YON_IMAGE_PATTERN.sub("", text) == text
    assert time.monotonic() - started < 1
    match = YON_IMAGE_PATTERN.search("### YON_IMAGE_0_START ###\n code \n### YON_IMAGE_0_END ###")
    assert match is not None
    assert match.group(2).strip() == "code"
