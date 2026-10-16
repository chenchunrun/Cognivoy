from __future__ import annotations

import httpx
import pytest

from cognivoy.services.mcp.pinned_transport import PinnedMcpAsyncTransport
from cognivoy.utils.network.public_url import PinnedHttpTarget


def _target() -> PinnedHttpTarget:
    return PinnedHttpTarget(
        original_url="https://mcp.example/mcp",
        connect_url="https://93.184.216.34/mcp",
        host_header="mcp.example",
        sni_hostname="mcp.example",
        resolved_ip="93.184.216.34",
    )


@pytest.mark.asyncio
async def test_transport_connects_to_pinned_ip_and_preserves_origin_identity() -> None:
    captured: dict[str, object] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        captured.update(
            url=str(request.url),
            host=request.headers.get("Host"),
            sni=request.extensions.get("sni_hostname"),
        )
        return httpx.Response(200, content=b"ok", request=request)

    transport = PinnedMcpAsyncTransport(_target())
    await transport._transport.aclose()
    transport._transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        response = await client.get("https://mcp.example/mcp?session=one")

    assert response.content == b"ok"
    assert captured == {
        "url": "https://93.184.216.34/mcp?session=one",
        "host": "mcp.example",
        "sni": "mcp.example",
    }


@pytest.mark.asyncio
async def test_transport_refuses_cross_origin_requests() -> None:
    transport = PinnedMcpAsyncTransport(_target())
    await transport._transport.aclose()
    transport._transport = httpx.MockTransport(lambda request: httpx.Response(200, request=request))
    async with httpx.AsyncClient(transport=transport) as client:
        with pytest.raises(httpx.UnsupportedProtocol, match="cross-origin"):
            await client.get("https://other.example/mcp")
