from __future__ import annotations

import socket

import pytest

from cognivoy.services.config.network_policy import OutboundNetworkPolicy
from cognivoy.utils.network.public_url import pin_public_http_url
from cognivoy.utils.network.safe_http import (
    PublicHttpError,
    fetch_public_bytes,
    fetch_public_bytes_sync,
    put_public_bytes_sync,
)


class _Response:
    def __init__(self, *, status=200, headers=None, body=b"ok") -> None:
        self.status_code = status
        self.headers = headers or {"content-type": "application/octet-stream"}
        self.body = body

    async def aiter_bytes(self):
        yield self.body


class _Client:
    def __init__(self, responses: list[_Response]) -> None:
        self.responses = responses
        self.requests: list[dict[str, object]] = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    def stream(self, method, url, **kwargs):
        self.requests.append({"method": method, "url": url, **kwargs})
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
        "cognivoy.utils.network.safe_http.require_outbound_network",
        lambda _feature: OutboundNetworkPolicy(True, 30, None),
    )


def _resolver(addresses: dict[str, str]):
    def resolve(host, _port, _family, _socktype):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (addresses[host], 0))]

    return resolve


def _pinner(addresses: dict[str, str]):
    resolver = _resolver(addresses)
    return lambda url: pin_public_http_url(url, resolver=resolver)


@pytest.mark.asyncio
async def test_request_connects_to_pinned_ip_with_original_host_and_sni() -> None:
    client = _Client([_Response(body=b"payload")])
    result = await fetch_public_bytes(
        "https://files.example/a.bin",
        feature="test",
        max_bytes=100,
        client_factory=lambda **_kwargs: client,
        host_validator=lambda _host: False,
        target_pinner=_pinner({"files.example": "93.184.216.34"}),
    )

    request = client.requests[0]
    assert request["url"] == "https://93.184.216.34/a.bin"
    assert request["headers"]["Host"] == "files.example"
    assert request["extensions"]["sni_hostname"] == "files.example"
    assert result.content == b"payload"
    assert result.final_url == "https://files.example/a.bin"


@pytest.mark.asyncio
async def test_cross_origin_redirect_drops_credentials_and_repins() -> None:
    client = _Client(
        [
            _Response(status=302, headers={"location": "https://cdn.example/final"}),
            _Response(body=b"done"),
        ]
    )
    await fetch_public_bytes(
        "https://files.example/start",
        feature="test",
        max_bytes=100,
        headers={"Authorization": "Bearer secret", "X-Trace": "yes"},
        client_factory=lambda **_kwargs: client,
        host_validator=lambda _host: False,
        target_pinner=_pinner({"files.example": "93.184.216.34", "cdn.example": "1.1.1.1"}),
    )

    first, second = client.requests
    assert first["headers"]["Authorization"] == "Bearer secret"
    assert "Authorization" not in second["headers"]
    assert second["headers"]["X-Trace"] == "yes"
    assert second["headers"]["Host"] == "cdn.example"
    assert second["url"] == "https://1.1.1.1/final"


@pytest.mark.asyncio
async def test_private_redirect_is_blocked_before_second_request() -> None:
    client = _Client([_Response(status=302, headers={"location": "http://127.0.0.1/admin"})])
    with pytest.raises(PublicHttpError, match="Redirect blocked"):
        await fetch_public_bytes(
            "https://files.example/start",
            feature="test",
            max_bytes=100,
            client_factory=lambda **_kwargs: client,
            host_validator=lambda host: host == "127.0.0.1",
        )
    assert len(client.requests) == 1


def test_sync_downloader_uses_same_pinned_transport_contract() -> None:
    class SyncResponse:
        status_code = 200
        headers = {"content-type": "application/zip"}

        def iter_bytes(self):
            yield b"archive"

    class SyncClient:
        def __init__(self) -> None:
            self.request: dict[str, object] = {}

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def stream(self, method, url, **kwargs):
            self.request = {"method": method, "url": url, **kwargs}

            class Context:
                def __enter__(self):
                    return SyncResponse()

                def __exit__(self, exc_type, exc, tb):
                    return False

            return Context()

    client = SyncClient()
    result = fetch_public_bytes_sync(
        "https://results.example/archive.zip",
        feature="test",
        max_bytes=100,
        client_factory=lambda **_kwargs: client,
        host_validator=lambda _host: False,
        target_pinner=_pinner({"results.example": "93.184.216.34"}),
    )

    assert result.content == b"archive"
    assert client.request["url"] == "https://93.184.216.34/archive.zip"
    assert client.request["headers"]["Host"] == "results.example"
    assert client.request["extensions"]["sni_hostname"] == "results.example"


def test_sync_uploader_uses_pinned_target_and_refuses_redirects() -> None:
    class SyncResponse:
        status_code = 200
        headers: dict[str, str] = {}

        def iter_bytes(self):
            return iter(())

    class SyncClient:
        def __init__(self) -> None:
            self.request: dict[str, object] = {}

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def stream(self, method, url, **kwargs):
            self.request = {"method": method, "url": url, **kwargs}

            class Context:
                def __enter__(self):
                    return SyncResponse()

                def __exit__(self, exc_type, exc, tb):
                    return False

            return Context()

    client = SyncClient()
    status = put_public_bytes_sync(
        "https://uploads.example/object",
        b"document",
        feature="test upload",
        client_factory=lambda **_kwargs: client,
        target_pinner=_pinner({"uploads.example": "93.184.216.34"}),
    )

    assert status == 200
    assert client.request["method"] == "PUT"
    assert client.request["url"] == "https://93.184.216.34/object"
    assert client.request["content"] == b"document"
    assert client.request["headers"]["Host"] == "uploads.example"
    assert client.request["extensions"]["sni_hostname"] == "uploads.example"
