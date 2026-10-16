"""
ArXiv search tool for preprint discovery.

This utility searches arXiv and returns lightweight metadata suitable for
tool usage in chat / playground flows.
"""

import asyncio
from datetime import date, datetime
import logging
import re

import arxiv

from cognivoy.services.config.network_policy import require_outbound_network

logger = logging.getLogger(__name__)

_FETCH_MULTIPLIER = 2
_MAX_FETCH_CAP = 30
_REQUEST_TIMEOUT_S = 30
_MAX_RETRIES = 2


def _search_arxiv_worker(
    *,
    query: str,
    max_results: int,
    fetch_count: int,
    sort_by: str,
    start_date: str | None,
    end_date: str | None,
    years_limit: int | None,
) -> list[dict]:
    """Spawn-safe blocking arXiv request and normalization."""

    criterion = (
        arxiv.SortCriterion.SubmittedDate if sort_by == "date" else arxiv.SortCriterion.Relevance
    )
    search = arxiv.Search(
        query=query,
        max_results=fetch_count,
        sort_by=criterion,
        sort_order=arxiv.SortOrder.Descending,
    )
    client = arxiv.Client(page_size=20, delay_seconds=3.0, num_retries=_MAX_RETRIES)
    # The client already performs bounded retries. Let terminal failures reach
    # the wrapper; an unavailable provider is not a successful zero-hit search.
    results = list(client.results(search))

    lower = _parse_iso_date(start_date)
    upper = _parse_iso_date(end_date)
    current_year = datetime.now().year
    papers: list[dict] = []
    for result in results:
        published_date = result.published
        paper_year = published_date.year
        if lower and published_date.date() < lower:
            continue
        if upper and published_date.date() > upper:
            continue
        if years_limit and (current_year - paper_year) > years_limit:
            continue
        arxiv_id = result.entry_id.split("/")[-1]
        if "v" in arxiv_id:
            arxiv_id = arxiv_id.split("v")[0]
        papers.append(
            {
                "title": result.title,
                "authors": [author.name for author in result.authors],
                "year": paper_year,
                "abstract": " ".join((result.summary or "").split()),
                "url": result.entry_id,
                "arxiv_id": arxiv_id,
                "published": published_date.isoformat(),
            }
        )
        if len(papers) >= max_results:
            break
    return papers


def _parse_iso_date(value: str | None) -> date | None:
    if value is None or not str(value).strip():
        return None
    try:
        return date.fromisoformat(str(value).strip())
    except ValueError as exc:
        raise ValueError(f"Invalid ISO date: {value!r}") from exc


class ArxivSearchTool:
    """Search arXiv preprints and return normalized metadata."""

    def __init__(self, *, isolated_runner=None):
        """Initialize search tool"""
        self.client = arxiv.Client(
            page_size=20,
            delay_seconds=3.0,
            num_retries=_MAX_RETRIES,
        )
        self._isolated_runner = isolated_runner

    async def search_papers(
        self,
        query: str,
        max_results: int = 3,
        years_limit: int | None = 3,
        sort_by: str = "relevance",
        date_from: str | None = None,
        date_to: str | None = None,
    ) -> list[dict]:
        """
        Search ArXiv papers

        Args:
            query: Search query keywords
            max_results: Number of papers to return
            years_limit: Paper year limit (last N years), None means no limit
            sort_by: Sort method - "relevance" or "date"
            date_from: Inclusive publication start date (YYYY-MM-DD)
            date_to: Inclusive publication end date (YYYY-MM-DD)

        Returns:
            List of papers, each paper contains:
                - title: Title
                - authors: Author list
                - year: Publication year
                - abstract: Abstract
                - url: Paper URL
                - arxiv_id: ArXiv ID
                - published: Publication date (ISO format)
        """
        query = (query or "").strip()
        if not query:
            return []

        network_policy = require_outbound_network("paper_search")
        request_timeout_s = min(_REQUEST_TIMEOUT_S, network_policy.timeout_seconds)

        max_results = max(1, min(int(max_results), 20))
        start_date = _parse_iso_date(date_from)
        end_date = _parse_iso_date(date_to)
        if start_date and end_date and start_date > end_date:
            raise ValueError("date_from must not be after date_to")

        fetch_count = min(max_results * _FETCH_MULTIPLIER, _MAX_FETCH_CAP)
        from cognivoy.services.process_isolation import (
            current_user_context_payload,
            run_in_killable_process,
        )

        runner = self._isolated_runner or run_in_killable_process
        try:
            return await runner(
                module=__name__,
                qualname="_search_arxiv_worker",
                kwargs={
                    "query": query,
                    "max_results": max_results,
                    "fetch_count": fetch_count,
                    "sort_by": sort_by,
                    "start_date": start_date.isoformat() if start_date else None,
                    "end_date": end_date.isoformat() if end_date else None,
                    "years_limit": years_limit,
                },
                timeout_seconds=request_timeout_s,
                user_context=current_user_context_payload(),
            )
        except TimeoutError:
            logger.warning("arXiv search timed out after %ss", request_timeout_s)
            raise
        except Exception:
            logger.warning("arXiv search provider failed")
            raise

    def format_paper_citation(self, paper: dict) -> str:
        """
        Format paper citation

        Args:
            paper: Paper information dictionary

        Returns:
            Citation string: (FirstAuthor et al., Year)
        """
        if not paper["authors"]:
            return f"(Unknown, {paper['year']})"

        first_author = paper["authors"][0].split()[-1]  # Extract surname

        if len(paper["authors"]) > 1:
            return f"({first_author} et al., {paper['year']})"
        return f"({first_author}, {paper['year']})"

    def extract_arxiv_id_from_url(self, url: str) -> str | None:
        """
        Extract ArXiv ID from URL

        Args:
            url: ArXiv URL

        Returns:
            ArXiv ID or None
        """
        match = re.search(r"arxiv\.org/(?:abs|pdf)/(\d+\.\d+)", url)
        if match:
            return match.group(1)
        return None


# ========== Usage Example ==========


async def main():
    """Test function"""
    tool = ArxivSearchTool()

    # Test search
    print("Search: transformer attention mechanism")
    papers = await tool.search_papers(
        query="transformer attention mechanism", max_results=3, years_limit=3, sort_by="relevance"
    )

    print(f"\nFound {len(papers)} papers:\n")

    for i, paper in enumerate(papers, 1):
        print(f"{i}. {paper['title']}")
        print(f"   Authors: {', '.join(paper['authors'][:3])}")
        print(f"   Year: {paper['year']}")
        print(f"   Citation: {tool.format_paper_citation(paper)}")
        print(f"   URL: {paper['url']}")
        print(f"   ArXiv ID: {paper['arxiv_id']}")
        print()


if __name__ == "__main__":
    asyncio.run(main())


# Backward compatibility for existing imports.
PaperSearchTool = ArxivSearchTool
