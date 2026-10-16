"""
System Status API Router
Manages system status checks and model connection tests
"""

import asyncio
from datetime import datetime
import logging
import time
from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field

from cognivoy.multi_user.context import get_current_user
from cognivoy.runtime import memory_probe
from cognivoy.services.config import resolve_search_runtime_config
from cognivoy.services.embedding import get_embedding_client, get_embedding_config
from cognivoy.services.llm import complete as llm_complete
from cognivoy.services.llm import get_llm_config, get_token_limit_kwargs
from cognivoy.services.observability import get_slo_service
from cognivoy.services.search import web_search

router = APIRouter()
logger = logging.getLogger(__name__)


def _safe_status_error(exc: Exception) -> str:
    logger.error(
        "System status check failed",
        exc_info=(type(exc), exc, exc.__traceback__),
        extra={"sink": "server"},
    )
    return "Status check failed. Check the server log."


class TestResponse(BaseModel):
    success: bool
    message: str
    model: str | None = None
    response_time_ms: float | None = None
    error: str | None = None


class SloEventRequest(BaseModel):
    name: Literal[
        "asset_saved",
        "learning_completed",
        "reference_clicked",
        "turn_recovered",
    ]
    amount: int = Field(default=1, ge=1, le=10_000)


@router.get("/slo")
async def get_slo_status(window_seconds: int = 86_400):
    """Return content-free service and product indicators for a bounded window."""
    return get_slo_service().snapshot(window_seconds=window_seconds)


@router.post("/slo/events")
async def record_slo_event(payload: SloEventRequest):
    """Record one allow-listed aggregate product event without user content."""
    get_slo_service().record_business_event(payload.name, amount=payload.amount)
    return {"recorded": True, "name": payload.name, "amount": payload.amount}


def _model_service_dependencies() -> dict[str, dict[str, object]]:
    """Return only non-secret media service readiness from the model catalog."""
    from cognivoy.services.optional_readiness import get_media_readiness

    return get_media_readiness()


def _parser_dependency() -> dict[str, object]:
    try:
        from cognivoy.services.config.runtime_settings import get_runtime_settings_service
        from cognivoy.services.parsing.engines.factory import get_parser

        engine = str(
            get_runtime_settings_service()
            .load_document_parsing(include_process_overrides=True)
            .get("engine")
            or "text"
        )
        parser = get_parser(engine)
        readiness = parser.is_ready(parser.resolve_config())
        return {
            "status": "configured" if readiness.ready else "unavailable",
            "engine": engine,
            "detail": readiness.message or readiness.reason,
        }
    except Exception as exc:
        return {"status": "error", "engine": None, "detail": _safe_status_error(exc)}


def _manim_dependency() -> dict[str, object]:
    try:
        from cognivoy.agents.math_animator.availability import (
            get_math_animator_readiness,
        )

        readiness = get_math_animator_readiness()
        return {
            "status": "configured" if readiness.available else "unavailable",
            "missing_dependencies": list(readiness.missing_dependencies),
            "install_hint": readiness.install_hint,
        }
    except Exception as exc:
        return {"status": "error", "missing_dependencies": [], "detail": _safe_status_error(exc)}


async def _agent_dependency() -> dict[str, object]:
    try:
        from cognivoy.services.subagent.registry import detect_all

        detections = await detect_all()
        available = [item.kind for item in detections if item.available]
        return {
            "status": "configured" if available else "not_configured",
            "available": len(available),
            "total": len(detections),
            "backends": available,
        }
    except Exception as exc:
        return {
            "status": "error",
            "available": 0,
            "total": 0,
            "backends": [],
            "detail": _safe_status_error(exc),
        }


@router.get("/dependencies")
async def get_dependency_status():
    """Dependency topology for user-visible capabilities, without credentials."""
    media = _model_service_dependencies()
    parser = _parser_dependency()
    manim = _manim_dependency()
    agents = await _agent_dependency()
    if not get_current_user().is_admin:
        for service in media.values():
            service.pop("profile", None)
        agents.pop("backends", None)
    return {
        "timestamp": datetime.now().isoformat(),
        "dependencies": {
            "parser": parser,
            "manim": manim,
            "agents": agents,
            "media": media,
        },
    }


@router.get("/runtime-topology")
async def get_runtime_topology():
    """
    Describe the current execution topology.

    This makes the unified runtime explicit for operators and frontend code:
    interactive chat turns should prefer `/api/v1/ws`, while a few routers still
    exist as compatibility or isolated subsystem endpoints.
    """
    return {
        "primary_runtime": {
            "transport": "/api/v1/ws",
            "manager": "TurnRuntimeManager",
            "orchestrator": "ChatOrchestrator",
            "session_store": "SQLiteSessionStore",
            "capability_entry": "CapabilityRegistry",
            "tool_entry": "ToolRegistry",
        },
        "compatibility_routes": [
            {"router": "chat", "mode": "legacy_adapter_target"},
            {"router": "solve", "mode": "legacy_adapter_target"},
            {"router": "question", "mode": "legacy_specialized"},
            {"router": "research", "mode": "legacy_specialized"},
        ],
        "isolated_subsystems": [
            {"router": "co_writer", "mode": "independent_subsystem"},
            {"router": "plugins_api", "mode": "playground_transport"},
        ],
    }


@router.get("/status")
async def get_system_status():
    """
    Get overall system status including backend and model configurations

    Returns:
        Dictionary containing status of backend, LLM, embeddings, and search
    """
    result = {
        "backend": {"status": "online", "timestamp": datetime.now().isoformat()},
        "llm": {"status": "unknown", "model": None, "testable": True},
        "embeddings": {"status": "unknown", "model": None, "testable": True},
        "search": {"status": "optional", "provider": None, "testable": True},
    }

    # Check backend status (this endpoint itself proves backend is online)
    result["backend"]["status"] = "online"

    # Check LLM configuration
    try:
        llm_config = get_llm_config()
        result["llm"]["model"] = llm_config.model
        result["llm"]["status"] = "configured"
    except ValueError as e:
        result["llm"]["status"] = "not_configured"
        result["llm"]["error"] = _safe_status_error(e)
    except Exception as e:
        result["llm"]["status"] = "error"
        result["llm"]["error"] = _safe_status_error(e)

    # Check Embeddings configuration
    try:
        embedding_config = get_embedding_config()
        result["embeddings"]["model"] = embedding_config.model
        result["embeddings"]["status"] = "configured"
    except ValueError as e:
        result["embeddings"]["status"] = "not_configured"
        result["embeddings"]["error"] = _safe_status_error(e)
    except Exception as e:
        result["embeddings"]["status"] = "error"
        result["embeddings"]["error"] = _safe_status_error(e)

    try:
        search_config = resolve_search_runtime_config()
        if search_config.requested_provider:
            result["search"]["provider"] = search_config.provider
            if search_config.unsupported_provider:
                result["search"]["status"] = "unsupported"
                result["search"]["error"] = (
                    f"{search_config.requested_provider} is deprecated/unsupported. "
                    "Switch to brave/tavily/jina/searxng/duckduckgo/perplexity."
                )
            elif search_config.deprecated_provider:
                result["search"]["status"] = "deprecated"
                result["search"]["error"] = (
                    f"{search_config.requested_provider} is deprecated. "
                    "Switch to brave/tavily/jina/searxng/duckduckgo/perplexity."
                )
            elif search_config.missing_credentials:
                result["search"]["status"] = "not_configured"
                result["search"]["error"] = (
                    f"{search_config.requested_provider} requires api_key. "
                    "Set profile.api_key in Settings > Catalog."
                )
            elif search_config.provider == "none":
                result["search"]["status"] = "disabled"
                result["search"]["testable"] = False
            else:
                result["search"]["status"] = "configured"
                if search_config.fallback_reason:
                    result["search"]["status"] = "fallback"
                    result["search"]["error"] = search_config.fallback_reason
    except Exception as e:
        result["search"]["status"] = "error"
        result["search"]["error"] = _safe_status_error(e)

    # Non-admin users have no need to know which model the admin configured;
    # exposing the name leaks operational detail and would let curious users
    # fingerprint the deployment. Strip the identifying fields.
    if not get_current_user().is_admin:
        for section in ("llm", "embeddings"):
            result[section].pop("model", None)
        result["search"].pop("provider", None)

    return result


@router.get("/memory")
async def get_memory_usage():
    """Resident memory of the running Cognivoy process tree.

    Deliberately separate from ``/status``: that snapshot resolves the LLM,
    embedding and search configs and is fetched once per settings mount, while
    this one is cheap enough for the status strip to poll.

    Admin-only, for the same reason ``/status`` strips model names from
    non-admins — process composition and host memory are operational detail a
    tenant has no need for.
    """
    if not get_current_user().is_admin:
        return {"available": False}

    snapshot = await asyncio.to_thread(memory_probe.capture)
    if not snapshot.processes:
        return {"available": False}

    # Fold the tree into one row per role, largest first, so the tooltip stays
    # readable when capabilities have spawned a dozen short-lived sandboxes.
    grouped: dict[str, dict[str, int]] = {}
    for proc in snapshot.processes:
        row = grouped.setdefault(proc.label, {"count": 0, "rss_bytes": 0})
        row["count"] += 1
        row["rss_bytes"] += proc.rss_bytes
    ranked = sorted(grouped.items(), key=lambda item: item[1]["rss_bytes"], reverse=True)

    processes = [
        {"label": label, "count": row["count"], "rss_bytes": row["rss_bytes"]}
        for label, row in ranked[: memory_probe.MAX_REPORTED_PROCESSES]
    ]
    overflow = ranked[memory_probe.MAX_REPORTED_PROCESSES :]
    if overflow:
        processes.append(
            {
                "label": "other",
                "count": sum(row["count"] for _label, row in overflow),
                "rss_bytes": sum(row["rss_bytes"] for _label, row in overflow),
            }
        )

    return {
        "available": True,
        "total_rss_bytes": snapshot.total_rss_bytes,
        "limit_bytes": snapshot.limit_bytes,
        "available_bytes": snapshot.available_bytes,
        "limit_source": snapshot.limit_source,
        "usage_ratio": snapshot.usage_ratio,
        "partial": snapshot.partial,
        "processes": processes,
    }


@router.post("/test/llm", response_model=TestResponse)
async def test_llm_connection():
    """
    Test LLM model connection by sending a simple completion request

    Returns:
        Test result with success status and response time
    """
    start_time = time.time()

    try:
        llm_config = get_llm_config()
        model = llm_config.model
        base_url = llm_config.base_url.rstrip("/")

        # Sanitize Base URL (remove /chat/completions suffix if present)
        for suffix in ["/chat/completions", "/completions"]:
            if base_url.endswith(suffix):
                base_url = base_url[: -len(suffix)]

        # Handle API Key (inject dummy if missing for local LLMs)
        api_key = llm_config.api_key
        if not api_key:
            api_key = "sk-no-key-required"

        # Send a minimal test request with a prompt that guarantees output
        test_prompt = "Say 'OK' to confirm you are working. Do not produce long output."
        token_kwargs = get_token_limit_kwargs(model, max_tokens=200)

        response = await llm_complete(
            model=model,
            prompt=test_prompt,
            system_prompt="You are a helpful assistant. Respond briefly.",
            binding=llm_config.binding,
            api_key=api_key,
            base_url=base_url,
            temperature=0.1,
            **token_kwargs,
        )

        response_time = (time.time() - start_time) * 1000

        if response and len(response.strip()) > 0:
            return TestResponse(
                success=True,
                message="LLM connection successful",
                model=model,
                response_time_ms=round(response_time, 2),
            )
        return TestResponse(
            success=False,
            message="LLM connection failed: Empty response",
            model=model,
            error="Empty response from API",
        )

    except ValueError as e:
        return TestResponse(success=False, message=f"LLM configuration error: {e!s}", error=str(e))
    except Exception as e:
        response_time = (time.time() - start_time) * 1000
        return TestResponse(
            success=False,
            message=f"LLM connection failed: {e!s}",
            response_time_ms=round(response_time, 2),
            error=str(e),
        )


@router.post("/test/embeddings", response_model=TestResponse)
async def test_embeddings_connection():
    """
    Test Embeddings model connection by sending a simple embedding request

    Returns:
        Test result with success status and response time
    """
    start_time = time.time()

    try:
        embedding_config = get_embedding_config()
        embedding_client = get_embedding_client()

        model = embedding_config.model
        binding = embedding_config.binding

        # Probe a tiny batch so "connection OK" also exercises the path RAG
        # uses for multi-chunk indexing.
        test_texts = ["test", "retrieval batch probe"]
        embeddings = await embedding_client.embed(test_texts)

        response_time = (time.time() - start_time) * 1000

        if (
            embeddings is not None
            and len(embeddings) == len(test_texts)
            and all(len(vector) > 0 for vector in embeddings)
            and len({len(vector) for vector in embeddings}) == 1
        ):
            return TestResponse(
                success=True,
                message=f"Embeddings connection successful ({binding} provider)",
                model=model,
                response_time_ms=round(response_time, 2),
            )
        return TestResponse(
            success=False,
            message="Embeddings connection failed: Invalid response",
            model=model,
            error="Embedding response must contain one non-empty vector per input",
        )

    except ValueError as e:
        return TestResponse(
            success=False, message=f"Embeddings configuration error: {e!s}", error=str(e)
        )
    except Exception as e:
        response_time = (time.time() - start_time) * 1000
        return TestResponse(
            success=False,
            message=f"Embeddings connection failed: {e!s}",
            response_time_ms=round(response_time, 2),
            error=str(e),
        )


@router.post("/test/search", response_model=TestResponse)
async def test_search_connection():
    start_time = time.time()

    try:
        search_config = resolve_search_runtime_config()
        if search_config.provider == "none":
            return TestResponse(
                success=False,
                message="Search is disabled",
                error="Set a Search provider in Settings > Catalog.",
            )
        if search_config.unsupported_provider:
            return TestResponse(
                success=False,
                message=(
                    f"Search provider `{search_config.requested_provider}` is deprecated/unsupported."
                ),
                error="Switch to brave/tavily/jina/searxng/duckduckgo/perplexity",
            )
        if search_config.missing_credentials:
            return TestResponse(
                success=False,
                message=f"Search provider `{search_config.requested_provider}` missing credentials.",
                error="Set profile.api_key in Settings > Catalog.",
            )
        result = web_search("Cognivoy health check", provider=search_config.provider)
        response_time = (time.time() - start_time) * 1000
        answer = result.get("answer") or result.get("search_results")
        if not answer:
            raise ValueError("Search provider returned no content")
        return TestResponse(
            success=True,
            message="Search connection successful",
            model=search_config.provider,
            response_time_ms=round(response_time, 2),
        )

    except ValueError as e:
        return TestResponse(
            success=False, message=f"Search configuration error: {e!s}", error=str(e)
        )
    except Exception as e:
        response_time = (time.time() - start_time) * 1000
        return TestResponse(
            success=False,
            message=f"Search connection check failed: {e!s}",
            response_time_ms=round(response_time, 2),
            error=str(e),
        )
