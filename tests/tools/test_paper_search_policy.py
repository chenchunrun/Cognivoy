from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from cognivoy.services.config.network_policy import (
    OutboundNetworkDisabledError,
    OutboundNetworkPolicy,
)
from cognivoy.tools.paper_search_tool import ArxivSearchTool, _search_arxiv_worker


@pytest.mark.asyncio
async def test_arxiv_search_stops_before_client_when_network_is_disabled(
    monkeypatch,
) -> None:
    tool = ArxivSearchTool()
    called = False

    def results(_search):
        nonlocal called
        called = True
        return []

    tool.client.results = results  # type: ignore[method-assign]
    monkeypatch.setattr(
        "cognivoy.tools.paper_search_tool.require_outbound_network",
        lambda _feature: (_ for _ in ()).throw(OutboundNetworkDisabledError("network disabled")),
    )
    with pytest.raises(OutboundNetworkDisabledError, match="network disabled"):
        await tool.search_papers("graph learning")
    assert called is False


@pytest.mark.asyncio
async def test_arxiv_search_uses_global_timeout(monkeypatch) -> None:
    calls: list[dict] = []

    async def isolated_runner(**kwargs):
        calls.append(kwargs)
        return []

    tool = ArxivSearchTool(isolated_runner=isolated_runner)
    monkeypatch.setattr(
        "cognivoy.tools.paper_search_tool.require_outbound_network",
        lambda _feature: OutboundNetworkPolicy(True, 4, None),
    )
    assert await tool.search_papers("graph learning") == []
    assert calls[0]["timeout_seconds"] == 4
    assert calls[0]["qualname"] == "_search_arxiv_worker"


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", [TimeoutError("timeout"), RuntimeError("provider failure")])
async def test_arxiv_search_propagates_terminal_failures(monkeypatch, failure) -> None:
    async def isolated_runner(**kwargs):
        raise failure

    monkeypatch.setattr(
        "cognivoy.tools.paper_search_tool.require_outbound_network",
        lambda _feature: OutboundNetworkPolicy(True, 4, None),
    )
    with pytest.raises(type(failure), match=str(failure)):
        await ArxivSearchTool(isolated_runner=isolated_runner).search_papers("graph learning")


@pytest.mark.asyncio
async def test_arxiv_search_preserves_cancellation(monkeypatch) -> None:
    async def isolated_runner(**kwargs):
        raise asyncio.CancelledError

    monkeypatch.setattr(
        "cognivoy.tools.paper_search_tool.require_outbound_network",
        lambda _feature: OutboundNetworkPolicy(True, 4, None),
    )
    with pytest.raises(asyncio.CancelledError):
        await ArxivSearchTool(isolated_runner=isolated_runner).search_papers("graph learning")


def test_arxiv_worker_does_not_convert_provider_failure_to_no_results(monkeypatch) -> None:
    def results(_search):
        raise ConnectionError("provider connection failed")

    monkeypatch.setattr(
        "cognivoy.tools.paper_search_tool.arxiv.Client",
        lambda **_kwargs: SimpleNamespace(results=results),
    )
    with pytest.raises(ConnectionError, match="provider connection failed"):
        _search_arxiv_worker(
            query="graph learning",
            max_results=3,
            fetch_count=6,
            sort_by="relevance",
            start_date=None,
            end_date=None,
            years_limit=None,
        )
