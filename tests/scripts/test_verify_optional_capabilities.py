from __future__ import annotations

import asyncio
import importlib.util
from pathlib import Path
from types import SimpleNamespace

import pytest

_spec = importlib.util.spec_from_file_location(
    "verify_optional_capabilities_gate",
    Path(__file__).resolve().parents[2] / "scripts" / "verify_optional_capabilities.py",
)
assert _spec and _spec.loader
gate = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gate)


def _ready():
    return {
        name: {"status": "configured", "verification": "not_run"} for name in gate.MEDIA_SERVICES
    }


def test_preflight_never_counts_as_complete_acceptance(monkeypatch):
    monkeypatch.setattr(gate, "get_media_readiness", _ready)
    result = asyncio.run(gate.verify(services=("tts",)))
    assert result["status"] == "incomplete"
    assert result["services"]["tts"]["status"] == "not_verified"


def test_missing_configuration_does_not_call_paid_provider(monkeypatch):
    monkeypatch.setattr(gate, "get_media_readiness", lambda: {"tts": {"status": "not_configured"}})

    async def unexpected(*args):
        pytest.fail("Unconfigured provider must not be called")

    monkeypatch.setattr(gate, "_run_live", unexpected)
    result = asyncio.run(gate.verify(live=True, services=("tts",)))
    assert result["services"]["tts"]["status"] == "blocked"


def test_live_failure_never_passes_or_exposes_provider_secrets(monkeypatch):
    monkeypatch.setattr(gate, "get_media_readiness", _ready)

    async def failure(*args):
        raise RuntimeError("Authorization: Bearer secret-should-not-escape")

    monkeypatch.setattr(gate, "_run_live", failure)
    result = asyncio.run(gate.verify(live=True, services=("imagegen",)))
    assert result["status"] == "incomplete"
    assert result["services"]["imagegen"]["status"] == "failed"
    assert "secret-should-not-escape" not in repr(result)


def test_all_requested_live_results_required_for_pass(monkeypatch):
    monkeypatch.setattr(gate, "get_media_readiness", _ready)

    async def success(name, speech):
        return {"bytes": 50}, speech

    monkeypatch.setattr(gate, "_run_live", success)
    result = asyncio.run(gate.verify(live=True, services=("imagegen", "videogen")))
    assert result["status"] == "passed"
    assert set(result["services"]) == {"imagegen", "videogen"}


def test_stt_cannot_pass_without_known_tts_sample(monkeypatch):
    monkeypatch.setattr(gate, "get_media_readiness", _ready)
    result = asyncio.run(gate.verify(live=True, services=("stt",)))
    assert result["services"]["stt"]["status"] == "blocked"


def test_media_decoder_rejects_empty_payload():
    with pytest.raises(ValueError, match="Empty"):
        gate._check_media(b"", "audio")


def test_image_decoder_rejects_html_masquerading_as_image():
    from PIL import UnidentifiedImageError

    with pytest.raises(UnidentifiedImageError):
        gate._check_media(b"<html>provider error</html>", "image")


def test_video_header_without_decodable_frames_cannot_pass(monkeypatch):
    monkeypatch.setattr(gate.shutil, "which", lambda name: "/usr/bin/ffprobe")
    monkeypatch.setattr(
        gate.subprocess,
        "run",
        lambda *args, **kwargs: SimpleNamespace(
            stdout=b'{"streams":[{"codec_type":"video","nb_read_frames":"0"}]}'
        ),
    )
    with pytest.raises(ValueError, match="decodable frames"):
        gate._check_media(b"container header only", "video")


def test_cli_exits_nonzero_for_unverified_preflight(monkeypatch, capsys):
    monkeypatch.setattr(gate, "get_media_readiness", _ready)
    monkeypatch.setattr("sys.argv", ["verify_optional_capabilities", "--services", "tts"])
    assert gate.main() == 2
    assert '"status": "not_verified"' in capsys.readouterr().out
