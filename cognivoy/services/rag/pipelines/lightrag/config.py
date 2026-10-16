"""Bridge Cognivoy's runtime config into LightRAG / RAG-Anything.

LightRAG (HKUDS/LightRAG) is a text knowledge-graph RAG engine; its multimodal
story is RAG-Anything (HKUDS/RAG-Anything), built on top of LightRAG. The
``lightrag`` provider uses RAG-Anything so multimodal content (the parse layer's
``content_list``) becomes graph entities, while text-only documents fall back to
a plain text insert.

This module is the decoupling seam: it exposes availability + mode helpers and
builds the three adapters LightRAG needs from Cognivoy's already-resolved LLM /
embedding clients. It imports neither RAG-Anything nor LightRAG at module load —
the adapter builders import ``lightrag.utils`` lazily (only the embedding wrapper
needs it), and engine construction lives in ``engine.py``.

Decoupling notes:
* ``llm_model_func`` / ``vision_model_func`` wrap Cognivoy's unified model
  callables and DROP LightRAG's internal kwargs (``hashing_kv``,
  ``keyword_extraction``, …) so they never leak into ``factory.complete``.
* ``embedding_func`` reuses Cognivoy's embedding client, wrapped in LightRAG's
  ``EmbeddingFunc`` with the active model's dimension.
"""

from __future__ import annotations

import importlib.util
import inspect
import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .worker import OwnerLoopBridge

logger = logging.getLogger(__name__)

# LightRAG's native retrieval modes. ``hybrid`` (KG + vector) is the safest
# general default and matches the shared per-KB ``search_mode`` default.
SUPPORTED_MODES = ("naive", "local", "global", "hybrid", "mix")
DEFAULT_MODE = "hybrid"

# Conservative cap for the embedding wrapper when the model doesn't advertise one.
_DEFAULT_MAX_TOKEN_SIZE = 8192


class LightRagNotAvailableError(RuntimeError):
    """Raised when the optional ``raganything`` dependency is not installed."""


class LightRagNotConfiguredError(RuntimeError):
    """Raised when Cognivoy's LLM / embedding config can't back LightRAG."""


def is_lightrag_available() -> bool:
    """True when RAG-Anything (which bundles LightRAG) can be imported.

    The local provider stays hidden unless a manually managed environment has
    both RAG-Anything and patched versions of its vulnerable transitive stack.
    """
    if importlib.util.find_spec("raganything") is None:
        return False
    # RAG-Anything currently pins vulnerable Transformers/Gradio generations
    # through MinerU. Refuse to activate such an environment even when those
    # packages were installed manually; use the isolated LightRAG Server path.
    from importlib.metadata import PackageNotFoundError, version

    try:
        from packaging.version import Version

        return Version(version("transformers")) >= Version("5.5.0") and Version(
            version("gradio")
        ) >= Version("6.16.0")
    except (PackageNotFoundError, ValueError):
        return False


def normalize_mode(mode: str | None) -> str:
    """Coerce a stored ``search_mode`` to a valid LightRAG query mode.

    The per-KB ``search_mode`` field is shared across engines; anything that
    isn't a LightRAG mode falls back to :data:`DEFAULT_MODE`.
    """
    candidate = (mode or "").strip().lower()
    return candidate if candidate in SUPPORTED_MODES else DEFAULT_MODE


def query_kwargs_from_settings() -> dict:
    """Extra ``aquery`` kwargs (top_k, response_type) from runtime settings.

    Returned as a dict so the engine can pass them through to LightRAG's
    ``QueryParam`` and gracefully drop them if an older RAG-Anything rejects a
    kwarg. Empty on any read error.
    """
    try:
        from cognivoy.services.config import load_lightrag_settings

        settings = load_lightrag_settings()
        return {
            "top_k": int(settings.get("top_k", 60)),
            "response_type": str(settings.get("response_type") or "Multiple Paragraphs"),
        }
    except Exception:
        return {}


def build_llm_model_func(*, io_bridge: OwnerLoopBridge | None = None):
    """Wrap Cognivoy's unified LLM callable for LightRAG.

    Drops LightRAG's internal kwargs while preserving explicit ``messages``.
    """
    from cognivoy.services.llm import get_llm_client

    base = get_llm_client().get_model_func()

    async def llm_model_func(
        prompt="",
        system_prompt=None,
        history_messages=None,
        messages=None,
        **_ignored,
    ):
        async def request():
            return await base(
                prompt or "",
                system_prompt=system_prompt,
                history_messages=history_messages or [],
                messages=messages,
            )

        return await io_bridge.run(request) if io_bridge is not None else await request()

    return llm_model_func


def build_vision_model_func(*, io_bridge: OwnerLoopBridge | None = None):
    """Wrap Cognivoy's vision-capable callable for RAG-Anything's image step."""
    from cognivoy.services.llm import get_llm_client

    base = get_llm_client().get_vision_model_func()

    async def vision_model_func(
        prompt="",
        system_prompt=None,
        history_messages=None,
        image_data=None,
        messages=None,
        **_ignored,
    ):
        async def request():
            return await base(
                prompt or "",
                system_prompt=system_prompt,
                history_messages=history_messages or [],
                image_data=image_data,
                messages=messages,
            )

        return await io_bridge.run(request) if io_bridge is not None else await request()

    return vision_model_func


def build_embedding_func(*, io_bridge: OwnerLoopBridge | None = None):
    """Wrap Cognivoy's embedding client in LightRAG's ``EmbeddingFunc``."""
    from lightrag.utils import EmbeddingFunc

    from cognivoy.services.embedding import get_embedding_client, get_embedding_config

    cfg = get_embedding_config()
    dim = int(getattr(cfg, "dim", 0) or 0)
    if not dim:
        raise LightRagNotConfiguredError(
            "No active embedding model with a known dimension. Configure one under "
            "Settings → Embedding before using a LightRAG knowledge base."
        )

    client = get_embedding_client()

    async def embedding_func(texts, context=None, **_ignored):
        import numpy as np

        # No context means no role, which is what the pinned LightRAG always
        # passes — defaulting to "document" would label queries as passages.
        input_type = {
            "query": "search_query",
            "document": "search_document",
        }.get(str(context or "").strip().lower())

        async def request():
            return await client.embed(texts, input_type=input_type)

        vectors = await io_bridge.run(request) if io_bridge is not None else await request()
        return np.asarray(vectors, dtype=np.float32)

    constructor = {
        "embedding_dim": dim,
        "max_token_size": int(getattr(cfg, "max_tokens", 0) or _DEFAULT_MAX_TOKEN_SIZE),
        "func": embedding_func,
    }
    if "supports_asymmetric" in inspect.signature(EmbeddingFunc).parameters:
        constructor["supports_asymmetric"] = True
    return EmbeddingFunc(
        **constructor,
    )


__all__ = [
    "SUPPORTED_MODES",
    "DEFAULT_MODE",
    "LightRagNotAvailableError",
    "LightRagNotConfiguredError",
    "is_lightrag_available",
    "normalize_mode",
    "query_kwargs_from_settings",
    "build_llm_model_func",
    "build_vision_model_func",
    "build_embedding_func",
]
