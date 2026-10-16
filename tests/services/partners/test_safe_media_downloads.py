from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from cognivoy.partners.bus.queue import MessageBus
from cognivoy.partners.channels.dingtalk import DingTalkChannel, DingTalkConfig
from cognivoy.partners.channels.napcat import NapcatChannel, NapcatConfig


@pytest.mark.asyncio
async def test_dingtalk_remote_media_uses_pinned_safe_downloader(monkeypatch) -> None:
    channel = DingTalkChannel(DingTalkConfig(enabled=True), MagicMock(spec=MessageBus))
    channel._http = MagicMock()
    captured: dict[str, object] = {}

    async def safe_fetch(url: str, **kwargs):
        captured["url"] = url
        captured.update(kwargs)
        return SimpleNamespace(
            content=b"image",
            content_type="image/png",
            final_url="https://cdn.example/image.png",
        )

    monkeypatch.setattr("cognivoy.partners.channels.dingtalk.fetch_public_bytes", safe_fetch)
    content, filename, content_type = await channel._read_media_bytes(
        "https://files.example/download"
    )

    assert content == b"image"
    assert filename == "image.png"
    assert content_type == "image/png"
    assert captured["feature"] == "DingTalk remote media"
    assert captured["max_bytes"] == channel._MAX_REMOTE_MEDIA_BYTES


@pytest.mark.asyncio
async def test_napcat_inbound_image_uses_pinned_safe_downloader(tmp_path, monkeypatch) -> None:
    channel = NapcatChannel(
        NapcatConfig(enabled=True, allow_from=["*"]), MagicMock(spec=MessageBus)
    )
    channel._http = MagicMock()
    captured: dict[str, object] = {}

    async def safe_fetch(url: str, **kwargs):
        captured["url"] = url
        captured.update(kwargs)
        return SimpleNamespace(content=b"image")

    monkeypatch.setattr(
        "cognivoy.partners.channels.napcat.validate_url_target",
        lambda _url: (True, ""),
    )
    monkeypatch.setattr("cognivoy.partners.channels.napcat.fetch_public_bytes", safe_fetch)
    monkeypatch.setattr(
        "cognivoy.partners.channels.napcat.get_media_dir", lambda _channel: tmp_path
    )

    saved = await channel._download_image(
        {"url": "https://files.example/image", "file": "photo.png", "file_size": "5"}
    )

    assert saved == str(tmp_path / "photo.png")
    assert (tmp_path / "photo.png").read_bytes() == b"image"
    assert captured["feature"] == "NapCat inbound image"
    assert captured["max_bytes"] == channel.config.max_image_bytes
