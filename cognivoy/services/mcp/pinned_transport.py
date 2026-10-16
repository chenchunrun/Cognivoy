"""DNS-pinned HTTP transport for user-owned remote MCP servers."""

from __future__ import annotations

from urllib.parse import urlparse

import httpx

from cognivoy.utils.network.public_url import PinnedHttpTarget


def _effective_port(scheme: str, port: int | None) -> int:
    if port is not None:
        return port
    return 443 if scheme.lower() == "https" else 80


def _origin(url: str) -> tuple[str, str, int]:
    parsed = urlparse(url)
    scheme = parsed.scheme.lower()
    return scheme, (parsed.hostname or "").lower().rstrip("."), _effective_port(scheme, parsed.port)


class PinnedMcpAsyncTransport(httpx.AsyncBaseTransport):
    """Keep one MCP session on its connect-time validated public address."""

    def __init__(self, target: PinnedHttpTarget, *, proxy: str | None = None) -> None:
        self._target = target
        self._origin = _origin(target.original_url)
        self._transport = httpx.AsyncHTTPTransport(
            proxy=proxy,
            trust_env=False,
            limits=httpx.Limits(max_connections=10, max_keepalive_connections=5),
        )

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        if _origin(str(request.url)) != self._origin:
            raise httpx.UnsupportedProtocol(
                "Self-service MCP transport refused a cross-origin request"
            )

        original_url = request.url
        original_host = request.headers.get("Host")
        had_sni = "sni_hostname" in request.extensions
        original_sni = request.extensions.get("sni_hostname")
        try:
            request.url = request.url.copy_with(host=self._target.resolved_ip)
            request.headers["Host"] = self._target.host_header
            request.extensions["sni_hostname"] = self._target.sni_hostname
            return await self._transport.handle_async_request(request)
        finally:
            request.url = original_url
            if original_host is None:
                request.headers.pop("Host", None)
            else:
                request.headers["Host"] = original_host
            if had_sni:
                request.extensions["sni_hostname"] = original_sni
            else:
                request.extensions.pop("sni_hostname", None)

    async def aclose(self) -> None:
        await self._transport.aclose()


__all__ = ["PinnedMcpAsyncTransport"]
