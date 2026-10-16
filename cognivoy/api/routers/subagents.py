"""Subagent connections API.

Backs the "My Agents → connected agents" feature: detect which local agent CLIs
(Claude Code, Codex, Gemini CLI, Kimi CLI, opencode, MiMo Code) are installed on
this machine, connect one as a pointer KB the chat composer can select, and
configure the consult budget. Connections are
stored as ``type: subagent`` knowledge bases (per-user, via the KB manager), so
they ride the same selection/persistence path as the other connected KB types —
the subagent capability drives them live, nothing is indexed.

The CLIs run on the host with the host user's own credentials, so detection is
machine-global; whether a connection is usable is simply "is the CLI installed
here". If it isn't, the UI just doesn't offer it.
"""

from __future__ import annotations

import asyncio
from dataclasses import replace
import json
import logging

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from cognivoy.api.errors import internal_http_error
from cognivoy.api.routers.auth import require_admin
from cognivoy.knowledge.kb_types import SUBAGENT_KB_TYPE
from cognivoy.multi_user.context import get_current_user
from cognivoy.multi_user.knowledge_access import current_kb_manager
from cognivoy.multi_user.partner_access import assert_partner_allowed, visible_partner_cards
from cognivoy.services.rag.linked_kb import assert_path_allowed
from cognivoy.services.subagent import (
    PARTNER_BACKEND_KIND,
    detect_all,
    list_backend_kinds,
    load_subagent_settings,
    save_subagent_settings,
    settings_from_dict,
)

logger = logging.getLogger(__name__)
router = APIRouter()


def _require_local_cli_admin(agent_kind: str) -> None:
    """Keep host-local agent CLIs and their credentials admin-only."""

    if agent_kind != PARTNER_BACKEND_KIND and not get_current_user().is_admin:
        raise HTTPException(status_code=403, detail="Admin access required for local agent CLIs")


class ConnectSubagentRequest(BaseModel):
    name: str
    agent_kind: str
    cwd: str = ""
    # For the partner backend (``agent_kind == "partner"``): which partner to
    # consult. Ignored by the local-CLI backends, which use ``cwd`` instead.
    partner_id: str = ""
    agent_profile: str = Field(default="", max_length=128, pattern=r"^[\w. -]*$")


class KimiHistoryRequest(BaseModel):
    session_ids: list[str] = Field(default_factory=list, max_length=500)


class OpenCodeHistoryRequest(BaseModel):
    session_ids: list[str] = Field(default_factory=list, max_length=500)


class SubagentSettingsPayload(BaseModel):
    consult_budget: int | None = None
    backends: dict[str, dict] | None = Field(default=None)


class SubagentMessageRequest(BaseModel):
    chat_session_id: str = ""
    message: str
    timeout_seconds: int | None = Field(default=None, ge=30, le=3600)


@router.get("/detect", dependencies=[Depends(require_admin)])
async def detect_subagents():
    """Report which agent CLIs are installed and usable on this machine."""
    detections = await detect_all()
    return {"backends": [d.to_dict() for d in detections]}


@router.get("/backends/options", dependencies=[Depends(require_admin)])
async def backend_options():
    """Synced model + reasoning-effort options per backend (settings page sync)."""
    from cognivoy.services.subagent.models import list_backend_options

    options = await list_backend_options()
    return {"backends": [o.to_dict() for o in options]}


@router.post("/backends/{kind}/sync", dependencies=[Depends(require_admin)])
async def sync_backend(kind: str):
    """Re-pull one backend's model catalog (the settings "sync" button).

    For Claude Code this scrapes its ``/model`` TUI live and caches the result;
    for Codex it re-reads the CLI-maintained cache.
    """
    from cognivoy.services.subagent import get_backend
    from cognivoy.services.subagent.models import sync_backend_options

    backend = get_backend(kind)
    if backend is None or not getattr(backend, "local_cli", True):
        # Only local CLIs have a model catalog to sync; partners run their own.
        raise HTTPException(status_code=400, detail=f"Unknown agent kind: {kind!r}")
    options = await sync_backend_options(kind)
    return options.to_dict()


@router.get("/partners")
async def list_visible_partners():
    """Partners the current user can connect & consult.

    Returns every partner for an admin, or just the ones an admin has assigned
    for a non-admin. The partner CRUD API (``/api/v1/partners``) stays fully
    admin-gated; this is the read surface the connect flow and the partner list
    page use, so a non-admin sees their assigned partners without a 403.
    """
    return {"partners": visible_partner_cards()}


@router.get("/connections")
async def list_connections():
    """List the current user's connected subagents."""
    manager = current_kb_manager()
    connections = []
    for name in manager.list_knowledge_bases():
        meta = manager.get_metadata(name)
        if not isinstance(meta, dict) or meta.get("type") != SUBAGENT_KB_TYPE:
            continue
        if meta.get("agent_kind") != PARTNER_BACKEND_KIND and not get_current_user().is_admin:
            continue
        connections.append(
            {
                "name": name,
                "agent_kind": meta.get("agent_kind", ""),
                "cwd": meta.get("cwd", ""),
                "partner_id": meta.get("partner_id", ""),
                "agent_profile": meta.get("agent_profile", ""),
                "description": meta.get("description", ""),
                "created_at": meta.get("created_at"),
                "updated_at": meta.get("updated_at"),
            }
        )
    return {"connections": connections}


@router.post("/connections")
async def create_connection(payload: ConnectSubagentRequest):
    """Connect a subagent (a local CLI, or one of the user's partners) as a selectable KB.

    A partner connection (``agent_kind == "partner"``) binds a ``partner_id``
    instead of a working directory: consulting it opens a fresh session on that
    partner, exactly as if the user started one from the partner page. Every
    consult within one Cognivoy chat lands in that one partner session.
    """
    name = (payload.name or "").strip()
    agent_kind = (payload.agent_kind or "").strip()
    if not name or not agent_kind:
        raise HTTPException(status_code=400, detail="Both name and agent_kind are required.")
    if agent_kind not in list_backend_kinds():
        raise HTTPException(status_code=400, detail=f"Unknown agent kind: {agent_kind!r}")
    _require_local_cli_admin(agent_kind)

    resolved_cwd = ""
    partner_id = ""
    if agent_kind == PARTNER_BACKEND_KIND:
        partner_id = (payload.partner_id or "").strip()
        if not partner_id:
            raise HTTPException(
                status_code=400, detail="A partner_id is required to connect a partner."
            )
        # Partners are admin-managed, but an admin can assign one to a user via
        # the grant system. An admin may connect any partner; a non-admin only a
        # partner assigned to them (403 otherwise). The partner still runs in its
        # own isolated scope — connecting just lets the user consult it in chat.
        assert_partner_allowed(partner_id)
        from cognivoy.services.partners import get_partner_manager

        if not get_partner_manager().partner_exists(partner_id):
            raise HTTPException(status_code=400, detail=f"No partner named {partner_id!r}.")
    else:
        raw_cwd = (payload.cwd or "").strip()
        if raw_cwd:
            try:
                resolved_cwd = str(assert_path_allowed(raw_cwd))
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc

    try:
        manager = current_kb_manager()
        entry = manager.register_subagent_connection(
            name,
            agent_kind,
            cwd=resolved_cwd,
            partner_id=partner_id,
            agent_profile=(payload.agent_profile or "").strip() if agent_kind == "kimi" else "",
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # pragma: no cover - defensive
        logger.error("Error connecting subagent: %s", exc)
        raise internal_http_error(exc, operation="subagents.connect") from exc

    return {
        "status": "connected",
        "name": name,
        "agent_kind": entry["agent_kind"],
        "cwd": entry["cwd"],
        "partner_id": entry.get("partner_id", ""),
        "agent_profile": entry.get("agent_profile", ""),
    }


@router.get("/kimi/history", dependencies=[Depends(require_admin)])
async def list_kimi_history(cwd: str = ""):
    """List safe metadata for local kimi-code 0.34 sessions."""
    from cognivoy.services.subagent.kimi_history import scan_kimi_sessions

    resolved = ""
    if cwd.strip():
        try:
            resolved = str(assert_path_allowed(cwd.strip()))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    sessions = scan_kimi_sessions(cwd=resolved)
    profiles = sorted({item["profile"] for item in sessions if item.get("profile")})
    return {"sessions": sessions, "profiles": profiles}


@router.post("/kimi/history/parse", dependencies=[Depends(require_admin)])
async def parse_kimi_history(payload: KimiHistoryRequest):
    """Parse selected Kimi sessions into the normal chat import envelope."""
    from cognivoy.services.subagent.kimi_history import parse_kimi_session

    sessions = []
    for session_id in dict.fromkeys(payload.session_ids):
        parsed = parse_kimi_session(session_id)
        if parsed:
            parsed.pop("profile", None)
            sessions.append(parsed)
    return {"sessions": sessions}


@router.get("/opencode/history", dependencies=[Depends(require_admin)])
async def list_opencode_history():
    """List safe metadata from the current user's local opencode database."""
    from cognivoy.services.subagent.opencode_history import scan_opencode_sessions

    return {"sessions": scan_opencode_sessions()}


@router.post("/opencode/history/parse", dependencies=[Depends(require_admin)])
async def parse_opencode_history(payload: OpenCodeHistoryRequest):
    """Parse selected opencode sessions into the normal chat import envelope."""
    from cognivoy.services.subagent.opencode_history import parse_opencode_session

    sessions = []
    for session_id in dict.fromkeys(payload.session_ids):
        parsed = parse_opencode_session(session_id)
        if parsed:
            sessions.append(parsed)
    return {"sessions": sessions}


@router.delete("/connections/{name}")
async def delete_connection(name: str):
    """Disconnect a subagent (removes the pointer KB; touches no files)."""
    manager = current_kb_manager()
    meta = manager.get_metadata(name)
    if not isinstance(meta, dict) or meta.get("type") != SUBAGENT_KB_TYPE:
        raise HTTPException(status_code=404, detail=f"No connected subagent named {name!r}.")
    _require_local_cli_admin(str(meta.get("agent_kind") or ""))
    try:
        manager.delete_knowledge_base(name, confirm=True)
    except Exception as exc:  # pragma: no cover - defensive
        logger.error("Error disconnecting subagent: %s", exc)
        raise internal_http_error(exc, operation="subagents.disconnect") from exc
    # Drop any remembered live-session ids for this connection.
    from cognivoy.services.subagent.sessions import forget_connection

    forget_connection(name)
    return {"status": "disconnected", "name": name}


def _ndjson(obj: dict) -> str:
    return json.dumps(obj, ensure_ascii=False) + "\n"


@router.post("/connections/{name}/message")
async def message_connection(name: str, payload: SubagentMessageRequest):
    """Send a message straight to a connected subagent and stream its run.

    This is the sidebar's "talk to the agent directly" path: it resumes the same
    live session Cognivoy consults (shared via the cross-turn registry, keyed by
    chat session + connection), so the agent keeps full context. Streams the
    native run as newline-delimited JSON, in the same channel shape the chat WS
    uses, so the sidebar transcript renders it identically.
    """
    message = (payload.message or "").strip()
    if not message:
        raise HTTPException(status_code=400, detail="A non-empty 'message' is required.")

    manager = current_kb_manager()
    meta = manager.get_metadata(name)
    if not isinstance(meta, dict) or meta.get("type") != SUBAGENT_KB_TYPE:
        raise HTTPException(status_code=404, detail=f"No connected subagent named {name!r}.")

    from cognivoy.services.subagent import (
        SubagentCapacityError,
        SubagentOutputLimitError,
        SubagentQueueTimeoutError,
        SubagentTimeoutError,
        consult_with_timeout,
        get_backend,
    )
    from cognivoy.services.subagent.sessions import get_session, remember_session, session_key

    kind = str(meta.get("agent_kind") or "")
    _require_local_cli_admin(kind)
    cwd = str(meta.get("cwd") or "")
    partner_id = str(meta.get("partner_id") or "")
    agent_profile = str(meta.get("agent_profile") or "")
    backend = get_backend(kind)
    if backend is None:
        raise HTTPException(status_code=400, detail=f"Unknown agent kind: {kind!r}")

    config = load_subagent_settings().backend(kind)
    if payload.timeout_seconds is not None:
        config = replace(config, runtime_timeout_seconds=payload.timeout_seconds)
    skey = session_key(payload.chat_session_id, name) if payload.chat_session_id else ""
    resume_id = get_session(skey) if skey else None

    async def event_stream():
        queue: asyncio.Queue = asyncio.Queue()

        async def on_event(event) -> None:
            await queue.put(("event", event))

        async def run() -> None:
            try:
                kwargs = dict(
                    on_event=on_event,
                    cwd=cwd or None,
                    session_id=resume_id,
                    config=config,
                    partner_id=partner_id or None,
                )
                if kind == "kimi":
                    kwargs["agent_profile"] = agent_profile or None
                res = await consult_with_timeout(backend, message, **kwargs)
                await queue.put(("done", res))
            except SubagentTimeoutError as exc:
                logger.warning(
                    "subagent message timed out kind=%s timeout_seconds=%s",
                    kind,
                    exc.timeout_seconds,
                )
                await queue.put(("timeout", exc))
            except SubagentCapacityError as exc:
                await queue.put(("capacity", exc))
            except SubagentQueueTimeoutError as exc:
                await queue.put(("queue_timeout", exc))
            except SubagentOutputLimitError as exc:
                await queue.put(("output_limit", exc))
            except Exception as exc:  # pragma: no cover - defensive
                logger.warning("subagent message failed: %s", exc, exc_info=True)
                await queue.put(("fail", None))

        task = asyncio.create_task(run())
        # The user's own message heads the exchange.
        yield _ndjson({"channel": "user_question", "text": message})
        try:
            while True:
                kind_, item = await queue.get()
                if kind_ == "event":
                    line = {"channel": item.kind, "text": item.text}
                    merge_id = (item.meta or {}).get("merge_id")
                    if merge_id:
                        # Namespace away from the chat turn's consult merge ids.
                        line["merge_id"] = f"side:{merge_id}"
                    yield _ndjson(line)
                elif kind_ == "done":
                    if skey and item.session_id:
                        remember_session(skey, item.session_id, kind=kind, cwd=cwd)
                    yield _ndjson(
                        {"done": True, "success": item.success, "session_id": item.session_id or ""}
                    )
                    break
                elif kind_ == "timeout":
                    yield _ndjson(
                        {
                            "channel": "error",
                            "text": (
                                f"The agent reached its {item.timeout_seconds}-second runtime "
                                "limit. Completed output is preserved; retry or increase the "
                                "limit in Agent settings."
                            ),
                            "code": "subagent_timeout",
                            "retryable": True,
                            "timeout_seconds": item.timeout_seconds,
                        }
                    )
                    yield _ndjson(
                        {
                            "done": True,
                            "success": False,
                            "reason": "timeout",
                            "retryable": True,
                        }
                    )
                    break
                elif kind_ == "capacity":
                    yield _ndjson(
                        {
                            "channel": "error",
                            "text": "All Agent run slots and queue positions are busy. Retry shortly.",
                            "code": "subagent_capacity_full",
                            "retryable": True,
                        }
                    )
                    yield _ndjson(
                        {"done": True, "success": False, "reason": "capacity", "retryable": True}
                    )
                    break
                elif kind_ == "queue_timeout":
                    yield _ndjson(
                        {
                            "channel": "error",
                            "text": (
                                f"The Agent waited {item.timeout_seconds:g} seconds for an "
                                "execution slot. Retry when capacity is available."
                            ),
                            "code": "subagent_queue_timeout",
                            "retryable": True,
                            "timeout_seconds": item.timeout_seconds,
                        }
                    )
                    yield _ndjson(
                        {
                            "done": True,
                            "success": False,
                            "reason": "queue_timeout",
                            "retryable": True,
                        }
                    )
                    break
                elif kind_ == "output_limit":
                    if item.preserved_text:
                        yield _ndjson({"channel": "text", "text": item.preserved_text})
                    yield _ndjson(
                        {
                            "channel": "error",
                            "text": (
                                f"The Agent reached the deployment output limit of "
                                f"{item.limit_chars} characters. Completed output is preserved."
                            ),
                            "code": "subagent_output_limit",
                            "retryable": True,
                            "limit_chars": item.limit_chars,
                        }
                    )
                    yield _ndjson(
                        {
                            "done": True,
                            "success": False,
                            "reason": "output_limit",
                            "retryable": True,
                        }
                    )
                    break
                else:  # fail
                    yield _ndjson(
                        {
                            "channel": "error",
                            "text": "The agent run failed. Retry or inspect the server log.",
                            "code": "subagent_execution_failed",
                            "retryable": True,
                        }
                    )
                    yield _ndjson({"done": True, "success": False})
                    break
        finally:
            if not task.done():
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass

    return StreamingResponse(event_stream(), media_type="application/x-ndjson")


@router.get("/settings", dependencies=[Depends(require_admin)])
async def get_settings():
    """Read the consult budget and per-backend run config."""
    return load_subagent_settings().to_dict()


@router.put("/settings", dependencies=[Depends(require_admin)])
async def update_settings(payload: SubagentSettingsPayload):
    """Update the subagent settings (admin-gated; deployment-wide)."""
    if payload.backends is not None:
        from cognivoy.services.subagent import get_backend

        invalid_kinds = sorted(
            kind
            for kind in payload.backends
            if (backend := get_backend(str(kind))) is None
            or not getattr(backend, "local_cli", True)
        )
        if invalid_kinds:
            raise HTTPException(
                status_code=400,
                detail={
                    "code": "unknown_agent_kind",
                    "message": "One or more agent backend kinds are not configurable.",
                    "invalid_kinds": invalid_kinds,
                },
            )
    merged = load_subagent_settings().to_dict()
    if payload.consult_budget is not None:
        merged["consult_budget"] = payload.consult_budget
    if payload.backends is not None:
        # Merge per backend (and per field) so saving one backend's settings
        # never clobbers the other's or any unsent field.
        backends = dict(merged.get("backends") or {})
        for kind, cfg in payload.backends.items():
            backends[str(kind)] = {**(backends.get(str(kind)) or {}), **(cfg or {})}
        merged["backends"] = backends
    settings = settings_from_dict(merged)
    save_subagent_settings(settings)
    return settings.to_dict()


__all__ = ["router"]
