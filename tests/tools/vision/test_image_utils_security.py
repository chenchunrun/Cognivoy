from __future__ import annotations

import pytest

from cognivoy.services.config.network_policy import OutboundNetworkPolicy
from cognivoy.tools.vision.image_utils import ImageError, fetch_image_from_url
from cognivoy.utils.network.public_url import PinnedHttpTarget


class _Response:
    def __init__(self, *, url: str, status: int, headers=None, body: bytes = b"image") -> None:
        self.url = url
        self.status_code = status
        self.headers = headers or {"content-type": "image/png"}
        self._body = body

    async def aiter_bytes(self):
        yield self._body


class _Client:
    def __init__(self, responses: list[_Response]) -> None:
        self.responses = responses
        self.urls: list[str] = []
        self.request_kwargs: list[dict[str, object]] = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    def stream(self, _method: str, url: str, **kwargs):
        assert kwargs.get("follow_redirects") is False
        self.urls.append(url)
        self.request_kwargs.append(kwargs)
        outer = self

        class _Context:
            async def __aenter__(self):
                return outer.responses.pop(0)

            async def __aexit__(self, exc_type, exc, tb):
                return False

        return _Context()


@pytest.fixture(autouse=True)
def _network_enabled(monkeypatch) -> None:
    monkeypatch.setattr(
        "cognivoy.tools.vision.image_utils.require_outbound_network",
        lambda _feature: OutboundNetworkPolicy(True, 30, None),
    )


@pytest.mark.asyncio
async def test_private_redirect_is_blocked_before_request() -> None:
    client = _Client(
        [
            _Response(
                url="https://example.com/image",
                status=302,
                headers={"location": "http://127.0.0.1/secret.png"},
            )
        ]
    )

    with pytest.raises(ImageError, match="Redirect blocked"):
        await fetch_image_from_url(
            "https://example.com/image",
            client_factory=lambda **_kwargs: client,
            host_validator=lambda host: host == "127.0.0.1",
        )

    assert client.urls == ["https://example.com/image"]


@pytest.mark.asyncio
async def test_image_body_is_streamed_with_hard_size_cap(monkeypatch) -> None:
    monkeypatch.setattr("cognivoy.tools.vision.image_utils.MAX_IMAGE_SIZE", 4)
    client = _Client([_Response(url="https://example.com/image.png", status=200, body=b"12345")])

    with pytest.raises(ImageError, match="size limit"):
        await fetch_image_from_url(
            "https://example.com/image.png",
            client_factory=lambda **_kwargs: client,
            host_validator=lambda _host: False,
        )


@pytest.mark.asyncio
async def test_image_fetch_uses_pinned_connection_identity() -> None:
    client = _Client([_Response(url="https://93.184.216.34/image.png", status=200, body=b"png")])
    content, mime = await fetch_image_from_url(
        "https://images.example/image.png",
        client_factory=lambda **_kwargs: client,
        host_validator=lambda _host: False,
        target_pinner=lambda _url: (
            PinnedHttpTarget(
                original_url="https://images.example/image.png",
                connect_url="https://93.184.216.34/image.png",
                host_header="images.example",
                sni_hostname="images.example",
                resolved_ip="93.184.216.34",
            ),
            "",
        ),
    )
    assert content == b"png"
    assert mime == "image/png"
    assert client.urls == ["https://93.184.216.34/image.png"]
    assert client.request_kwargs[0]["headers"]["Host"] == "images.example"
    assert client.request_kwargs[0]["extensions"]["sni_hostname"] == "images.example"
