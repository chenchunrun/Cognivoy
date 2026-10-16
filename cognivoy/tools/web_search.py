"""
Web Search Tool - Simple entry point for agents

This module provides a simple interface to the web search service.
All search logic is implemented in cognivoy/services/search/.

Usage:
    from cognivoy.tools.web_search import web_search

    # Simple usage
    result = web_search("What is AI?")

    # With provider
    result = web_search("What is AI?", provider="tavily")

Configuration:
    Search profiles live in data/user/settings/model_catalog.json.

Available Providers:
    - brave: Brave web search API
    - tavily: Research-focused with optional answers
    - jina: SERP with full content extraction
    - searxng: Self-hosted SearXNG endpoint
    - duckduckgo: Zero-config search
    - perplexity: AI-powered search with answers
"""

from typing import Any

from cognivoy.services.config.network_policy import OutboundNetworkDisabledError

# Re-export from services layer
from cognivoy.services.search import (
    PROVIDER_TEMPLATES,
    SEARCH_API_KEY_ENV,
    AnswerConsolidator,
    BaseSearchProvider,
    Citation,
    SearchProvider,
    SearchResult,
    WebSearchResponse,
    get_available_providers,
    get_current_config,
    get_default_provider,
    get_provider,
    get_providers_info,
    list_providers,
)
from cognivoy.services.search import (
    web_search as _service_web_search,
)
from cognivoy.services.search.resilience import SearchProviderError


def web_search(*args: Any, **kwargs: Any) -> dict[str, Any]:
    """Keep known failures structured across the isolated worker boundary.

    Raw worker exceptions are deliberately flattened by process isolation. By
    serializing safe provider diagnostics here, callers retain the failure
    category without parsing a traceback or exposing provider bodies/secrets.
    """
    try:
        return _service_web_search(*args, **kwargs)
    except SearchProviderError as exc:
        category = exc.category
        provider = exc.provider
        attempts = exc.attempts
        answer = (
            "The search provider returned no usable results. Try a different query or search provider."
            if category == "no_results"
            else "Web search could not be completed. Check the search provider and outbound-network settings."
        )
    except OutboundNetworkDisabledError:
        category, provider, attempts = "network_disabled", "disabled", 0
        answer = "Web search is disabled by the outbound-network policy."
    except (ValueError, ImportError):
        category, provider, attempts = "configuration", "", 0
        answer = "Web search is not configured correctly. Check the search provider settings."
    return {
        "success": False,
        "error": True,
        "error_type": category,
        "provider": provider,
        "search_attempts": attempts,
        "retryable": category in {"connection", "timeout", "unavailable"},
        "answer": answer,
        "citations": [],
        "search_results": [],
    }


__all__ = [
    # Main function
    "web_search",
    "get_current_config",
    # Provider management
    "get_provider",
    "list_providers",
    "get_available_providers",
    "get_default_provider",
    "get_providers_info",
    # Types
    "WebSearchResponse",
    "Citation",
    "SearchResult",
    # Consolidation
    "AnswerConsolidator",
    "PROVIDER_TEMPLATES",
    # Base class
    "BaseSearchProvider",
    "SearchProvider",
    "SEARCH_API_KEY_ENV",
]
