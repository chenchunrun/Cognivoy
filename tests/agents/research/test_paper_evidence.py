from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from cognivoy.agents.research.utils.citation_manager import CitationManager, paper_evidence_records

PAPER = {"title": "Evidence study", "url": "https://arxiv.org/abs/1234.5678", "authors": ["Ada"]}


@pytest.mark.parametrize(
    "metadata",
    [
        {"papers": []},
        {"papers": [{}]},
        {"papers": "malformed"},
        {"papers": [PAPER], "error": True},
        {"papers": [PAPER], "success": False},
    ],
)
def test_empty_or_failed_paper_metadata_is_authoritative(tmp_path, metadata):
    manager = CitationManager("empty-paper", cache_dir=tmp_path)
    trace = SimpleNamespace(query="query", summary="summary", timestamp="now")
    # Even a legacy-looking textual payload cannot override explicit no hits.
    raw_answer = json.dumps({"papers": [PAPER]})

    assert paper_evidence_records(metadata, raw_answer) == []
    assert not manager.add_citation("CIT-1-01", "paper_search", trace, raw_answer, metadata)
    assert manager.get_all_citations() == {}


def test_paper_citation_supports_identifiable_legacy_json(tmp_path):
    manager = CitationManager("legacy-paper", cache_dir=tmp_path)
    trace = SimpleNamespace(query="query", summary="summary", timestamp="now")

    assert manager.add_citation("CIT-1-01", "paper_search", trace, json.dumps({"papers": [PAPER]}))
    citation = manager.get_all_citations()["CIT-1-01"]
    assert citation["total_papers"] == 1
    assert citation["papers"][0]["url"] == PAPER["url"]
