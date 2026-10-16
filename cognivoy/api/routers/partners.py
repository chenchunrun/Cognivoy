"""Partners management API.

A partner is an IM-connected companion driven by the chat agent loop.
This router owns: partner CRUD + lifecycle, the soul library, channel
config (schema-driven), asset provisioning (KB / skills / notebooks copied
into the partner workspace), tool configuration, history, and the web chat
entry points (HTTP / SSE / WebSocket).
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import copy
from datetime import datetime
import json
import logging
from typing import Annotated, Any, AsyncGenerator, Literal
from uuid import uuid4
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from cognivoy.api.errors import internal_http_error
from cognivoy.core.i18n import t
from cognivoy.partners.config.paths import get_partner_dir, get_partner_media_dir
from cognivoy.partners.helpers import safe_filename
from cognivoy.services.cron import get_cron_service
from cognivoy.services.partners import (
    get_partner_manager,
    slugify_partner_id,
    slugify_soul_id,
)
from cognivoy.services.partners.manager import (
    LEGACY_GLOBAL_DELIVERY_KEYS,
    PartnerConfig,
    PartnerInstance,
    mask_channel_secrets,
    strip_legacy_global_delivery,
)
from cognivoy.services.partners.proactive_learning import (
    list_proactive_audit,
    proactive_effectiveness,
    record_proactive_outcome,
    schedule_proactive_event,
)
from cognivoy.services.partners.workspace import (
    list_assets,
    list_soul_versions,
    provision_assets,
    read_soul,
    remove_asset,
    restore_soul_version,
    strip_frontmatter,
    write_soul,
)

logger = logging.getLogger(__name__)
router = APIRouter()


# Per-partner async locks used to dedupe concurrent WebSocket-driven
# auto-starts (start_partner short-circuits when running, but that check is
# not async-safe under concurrent connections).
_start_locks: dict[str, asyncio.Lock] = {}
_start_locks_mutex = asyncio.Lock()


async def _get_start_lock(partner_id: str) -> asyncio.Lock:
    async with _start_locks_mutex:
        lock = _start_locks.get(partner_id)
        if lock is None:
            lock = asyncio.Lock()
            _start_locks[partner_id] = lock
        return lock


async def _ensure_running_partner(
    partner_id: str,
    *,
    allow_stopped: bool = False,
) -> PartnerInstance:
    mgr = get_partner_manager()
    instance = mgr.get_partner(partner_id)
    if instance and instance.running:
        return instance

    config = mgr.load_config(partner_id)
    if config is None:
        raise HTTPException(status_code=404, detail=t("api.partner_not_found"))
    if not allow_stopped and not mgr.auto_start_enabled(partner_id, default=False):
        raise HTTPException(status_code=409, detail=t("api.partner_stopped_start_required"))

    lock = await _get_start_lock(partner_id)
    async with lock:
        instance = mgr.get_partner(partner_id)
        if instance and instance.running:
            return instance
        if not allow_stopped and not mgr.auto_start_enabled(partner_id, default=False):
            raise HTTPException(status_code=409, detail=t("api.partner_stopped_start_required"))
        try:
            return await mgr.start_partner(partner_id, config)
        except RuntimeError as exc:
            raise internal_http_error(exc, operation="partners.auto_start") from None
        except Exception as exc:
            logger.exception("Failed to auto-start partner '%s'", partner_id)
            raise internal_http_error(exc, operation="partners.auto_start") from exc


# ── Request models ─────────────────────────────────────────────


class SoulSpec(BaseModel):
    """Where a new partner's soul comes from."""

    source: Literal["default", "library", "persona", "custom"] = "default"
    id: str | None = None  # library soul id, or persona name
    content: str | None = None  # custom markdown


class AssetSpec(BaseModel):
    knowledge_bases: list[str] = Field(default_factory=list)
    skills: list[str] = Field(default_factory=list)
    notebooks: list[str] = Field(default_factory=list)


Weekday = Annotated[int, Field(ge=0, le=6)]
ClockTime = Annotated[str, Field(pattern=r"^(?:[01]\d|2[0-3]):[0-5]\d$")]


def _validate_timezone(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = value.strip() or "UTC"
    try:
        ZoneInfo(normalized)
    except ZoneInfoNotFoundError:
        raise ValueError(f"Unknown IANA timezone: {normalized}") from None
    return normalized


def _validate_paused_until(value: str | None) -> str | None:
    if value is None or not value.strip():
        return "" if value is not None else None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        raise ValueError("proactive_paused_until must be an ISO-8601 datetime") from None
    if parsed.tzinfo is None:
        raise ValueError("proactive_paused_until must include a timezone offset")
    return parsed.isoformat()


class CreatePartnerRequest(BaseModel):
    partner_id: str | None = None
    name: str = Field(..., min_length=1)
    description: str | None = None
    soul: SoulSpec | None = None
    channels: dict | None = None
    llm_selection: dict[str, str] | None = None
    backup_llm_selection: dict[str, str] | None = None
    language: str | None = None
    emoji: str | None = None
    color: str | None = None
    avatar: str | None = None
    enabled_tools: list[str] | None = None
    builtin_tools: list[str] | None = None
    # Omitting ``mcp_tools`` creates the partner with MCP off (the config
    # default); ``null`` is the deliberate opt-in to every configured MCP tool.
    mcp_tools: list[str] | None = []
    proactive_learning: bool = False
    proactive_review_delay_hours: int = Field(default=24, ge=1, le=24 * 30)
    proactive_low_score_threshold: float = Field(default=0.6, ge=0.0, le=1.0)
    proactive_goal: str = Field(default="", max_length=500)
    proactive_timezone: str = "UTC"
    proactive_allowed_start: ClockTime = "09:00"
    proactive_allowed_end: ClockTime = "21:00"
    proactive_allowed_weekdays: list[Weekday] = Field(
        default_factory=lambda: [0, 1, 2, 3, 4, 5, 6], min_length=1, max_length=7
    )
    proactive_frequency: Literal["as_needed", "daily", "weekly"] = "as_needed"
    proactive_preferred_channel: str = Field(default="", max_length=80)
    proactive_paused_until: str = ""
    proactive_min_interval_hours: int = Field(default=24, ge=0, le=24 * 30)
    proactive_max_per_day: int = Field(default=1, ge=1, le=24)
    proactive_merge_window_hours: int = Field(default=6, ge=0, le=72)
    assets: AssetSpec | None = None
    start: bool = True

    _timezone_valid = field_validator("proactive_timezone")(_validate_timezone)
    _paused_until_valid = field_validator("proactive_paused_until")(_validate_paused_until)


class UpdatePartnerRequest(BaseModel):
    name: str | None = None
    description: str | None = None
    channels: dict | None = None
    llm_selection: dict[str, str] | None = None
    backup_llm_selection: dict[str, str] | None = None
    language: str | None = None
    emoji: str | None = None
    color: str | None = None
    avatar: str | None = None
    enabled_tools: list[str] | None = None
    builtin_tools: list[str] | None = None
    mcp_tools: list[str] | None = None
    proactive_learning: bool | None = None
    proactive_review_delay_hours: int | None = Field(default=None, ge=1, le=24 * 30)
    proactive_low_score_threshold: float | None = Field(default=None, ge=0.0, le=1.0)
    proactive_goal: str | None = Field(default=None, max_length=500)
    proactive_timezone: str | None = None
    proactive_allowed_start: ClockTime | None = None
    proactive_allowed_end: ClockTime | None = None
    proactive_allowed_weekdays: list[Weekday] | None = Field(
        default=None, min_length=1, max_length=7
    )
    proactive_frequency: Literal["as_needed", "daily", "weekly"] | None = None
    proactive_preferred_channel: str | None = Field(default=None, max_length=80)
    proactive_paused_until: str | None = None
    proactive_min_interval_hours: int | None = Field(default=None, ge=0, le=24 * 30)
    proactive_max_per_day: int | None = Field(default=None, ge=1, le=24)
    proactive_merge_window_hours: int | None = Field(default=None, ge=0, le=72)

    _timezone_valid = field_validator("proactive_timezone")(_validate_timezone)
    _paused_until_valid = field_validator("proactive_paused_until")(_validate_paused_until)


class SoulUpdateBody(BaseModel):
    content: str


class AssetAddRequest(AssetSpec):
    pass


class ChatAttachmentRequest(BaseModel):
    type: str = "file"
    url: str = ""
    base64: str = ""
    filename: str = ""
    mime_type: str = ""


class ProactiveReminderActionRequest(BaseModel):
    action: Literal["view", "start", "later", "skip", "disable"]
    later_hours: int = Field(default=4, ge=1, le=24 * 30)


class ProactiveEventRequest(BaseModel):
    event_type: Literal["low_quiz_score", "due_review", "learning_plan", "inactivity", "custom"]
    event_key: str = Field(min_length=1, max_length=240)
    message: str = Field(min_length=1, max_length=10_000)
    desired_at: datetime | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)

    @field_validator("desired_at")
    @classmethod
    def desired_at_has_timezone(cls, value: datetime | None) -> datetime | None:
        if value is not None and value.tzinfo is None:
            raise ValueError("desired_at must include a timezone offset")
        return value


class ChatMessageRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    content: str = ""
    session_id: str | None = None
    session_key: str | None = None
    chat_id: str | None = None
    attachments: list[ChatAttachmentRequest] = Field(default_factory=list)
    llm_selection: dict[str, str] | None = Field(default=None, alias="llmSelection")


class SessionKeyBody(BaseModel):
    session_key: str = Field(..., min_length=1)


class SessionBranchBody(BaseModel):
    source_key: str = Field(..., min_length=1)
    new_key: str = Field(..., min_length=1)


class DeadLetterDispositionBody(BaseModel):
    note: str = Field(default="", max_length=500)


class SoulCreateRequest(BaseModel):
    id: str
    name: str
    content: str


class SoulTemplateUpdateRequest(BaseModel):
    name: str | None = None
    content: str | None = None


# ── Validation helpers ─────────────────────────────────────────


def _validate_channels_payload(channels: dict) -> None:
    """Reject malformed channel configs at the API boundary (422)."""
    from cognivoy.partners.bus.queue import MessageBus
    from cognivoy.partners.channels.manager import (
        ChannelConfigurationError,
        ChannelManager,
    )
    from cognivoy.partners.config.schema import ChannelsConfig

    legacy_keys = sorted(k for k in channels if k in LEGACY_GLOBAL_DELIVERY_KEYS)
    if legacy_keys:
        raise HTTPException(
            status_code=422,
            detail={
                "message": (
                    "Delivery flags are configured per channel; remove top-level "
                    f"channel keys: {', '.join(legacy_keys)}"
                )
            },
        )

    try:
        config = ChannelsConfig(**channels)
        ChannelManager(config, MessageBus(), strict_config=True)
    except ValidationError as exc:
        raise HTTPException(
            status_code=422,
            detail={"message": t("api.invalid_channels_config"), "errors": exc.errors()},
        ) from None
    except TypeError as exc:
        raise HTTPException(
            status_code=422,
            detail=f"{t('api.invalid_channels_config')}: {exc}",
        ) from None
    except ChannelConfigurationError as exc:
        raise HTTPException(
            status_code=422,
            detail={"message": str(exc)},
        ) from None


# Inline avatars are client-resized to ~128px before upload; this cap is a
# server-side backstop so config.yaml can't be bloated with raw photos.
_AVATAR_MAX_CHARS = 200_000


def _validate_avatar_payload(value: str | None) -> str:
    avatar = (value or "").strip()
    if not avatar:
        return ""
    if not avatar.startswith("data:image/"):
        raise HTTPException(status_code=422, detail="Avatar must be a data:image/* URL")
    if len(avatar) > _AVATAR_MAX_CHARS:
        raise HTTPException(
            status_code=422,
            detail="Avatar too large — resize the image before uploading",
        )
    return avatar


def _validate_llm_selection_payload(
    value: dict[str, str] | None,
) -> dict[str, str] | None:
    """Validate a partner model selection against the shared LLM catalog."""
    from cognivoy.services.config import get_model_catalog_service
    from cognivoy.services.model_selection import apply_llm_selection_to_catalog
    from cognivoy.services.partners.model_runtime import normalize_partner_llm_selection

    try:
        selection = normalize_partner_llm_selection(value)
        if selection:
            apply_llm_selection_to_catalog(get_model_catalog_service().load(), selection)
        return selection
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None


def _resolve_soul_content(soul: SoulSpec | None) -> tuple[str, dict[str, str]]:
    """Resolve a SoulSpec into (markdown content, origin record)."""
    from cognivoy.services.partners.workspace import DEFAULT_SOUL

    if soul is None or soul.source == "default":
        return DEFAULT_SOUL, {"type": "default", "id": ""}

    if soul.source == "custom":
        content = (soul.content or "").strip()
        if not content:
            raise HTTPException(status_code=422, detail=t("api.soul_content_empty"))
        return content, {"type": "custom", "id": ""}

    if soul.source == "library":
        entry = get_partner_manager().get_soul(str(soul.id or ""))
        if not entry:
            raise HTTPException(
                status_code=404,
                detail=t("api.soul_library_not_found", name=str(soul.id)),
            )
        return str(entry.get("content") or ""), {"type": "library", "id": str(soul.id)}

    # source == "persona": clone from the chat persona workspace (the
    # requesting user's personas first; non-admins fall back to admin
    # presets, mirroring chat's resolution).
    name = str(soul.id or "").strip()
    if not name:
        raise HTTPException(status_code=422, detail=t("api.persona_name_required"))
    content = _load_persona_markdown(name)
    if not content:
        raise HTTPException(status_code=404, detail=t("api.persona_not_found", name=name))
    return content, {"type": "persona", "id": name}


def _load_persona_markdown(name: str) -> str:
    from cognivoy.multi_user.context import get_current_user
    from cognivoy.multi_user.paths import get_admin_path_service
    from cognivoy.services.persona import PersonaService, get_persona_service

    try:
        detail = get_persona_service().get_detail(name)
        return strip_frontmatter(detail.content)
    except Exception:
        pass
    try:
        if not get_current_user().is_admin:
            admin_service = PersonaService(
                root=get_admin_path_service().get_workspace_dir() / "personas"
            )
            return strip_frontmatter(admin_service.get_detail(name).content)
    except Exception:
        pass
    return ""


# ── Soul template library (before /{partner_id} routes) ───────


@router.get("/souls")
async def list_souls():
    return get_partner_manager().list_souls()


@router.post("/souls")
async def create_soul(payload: SoulCreateRequest):
    mgr = get_partner_manager()
    # Slug the id server-side (authoritative): soul ids ride in ``/souls/<id>``
    # URLs, so a raw CJK / path-unsafe id (e.g. ``我的灵魂`` or ``a/b``) would be
    # unreachable or mis-routed. The client uses the returned ``id``.
    soul_id = slugify_soul_id(payload.id or payload.name)
    if mgr.get_soul(soul_id):
        raise HTTPException(status_code=409, detail=t("api.soul_already_exists", name=soul_id))
    return mgr.create_soul(soul_id, payload.name, payload.content)


@router.get("/souls/{soul_id}")
async def get_soul(soul_id: str):
    soul = get_partner_manager().get_soul(soul_id)
    if not soul:
        raise HTTPException(status_code=404, detail=t("api.soul_not_found"))
    return soul


@router.put("/souls/{soul_id}")
async def update_soul(soul_id: str, payload: SoulTemplateUpdateRequest):
    result = get_partner_manager().update_soul(soul_id, payload.name, payload.content)
    if not result:
        raise HTTPException(status_code=404, detail=t("api.soul_not_found"))
    return result


@router.delete("/souls/{soul_id}")
async def delete_soul(soul_id: str):
    if not get_partner_manager().delete_soul(soul_id):
        raise HTTPException(status_code=404, detail=t("api.soul_not_found"))
    return {"id": soul_id, "deleted": True}


@router.get("/soul-sources")
async def soul_sources():
    """Everything the create-wizard's soul step can start from."""
    from cognivoy.multi_user.context import get_current_user
    from cognivoy.multi_user.paths import get_admin_path_service
    from cognivoy.services.persona import PersonaService, get_persona_service

    def _persona_entry(service: PersonaService, info: Any) -> dict[str, str]:
        # Content rides along so the wizard can preview the clone; creation
        # still re-resolves the persona server-side (_resolve_soul_content).
        try:
            content = strip_frontmatter(service.get_detail(info.name).content)
        except Exception:
            content = ""
        return {"name": info.name, "description": info.description, "content": content}

    personas: list[dict[str, str]] = []
    seen: set[str] = set()
    try:
        service = get_persona_service()
        for info in service.list_personas():
            personas.append(_persona_entry(service, info))
            seen.add(info.name)
    except Exception:
        logger.warning("Failed to list user personas", exc_info=True)
    try:
        if not get_current_user().is_admin:
            admin_service = PersonaService(
                root=get_admin_path_service().get_workspace_dir() / "personas"
            )
            for info in admin_service.list_personas():
                if info.name not in seen:
                    personas.append(_persona_entry(admin_service, info))
    except Exception:
        logger.warning("Failed to list admin personas", exc_info=True)

    return {"library": get_partner_manager().list_souls(), "personas": personas}


# ── Static catalog endpoints ───────────────────────────────────


@router.get("")
async def list_partners():
    return get_partner_manager().list_partners()


@router.get("/recent")
async def recent_partners(limit: int = 3):
    return get_partner_manager().get_recent_active_partners(limit=limit)


@router.get("/channels/schema")
async def list_channel_schemas():
    """JSON-Schema metadata for every available channel (schema-driven UI)."""
    from cognivoy.api.routers._partners_channel_schema import all_channel_schemas

    return {"channels": all_channel_schemas()}


@router.get("/tool-options")
async def tool_options():
    """The configurable tool surface for a partner.

    ``tools`` mirrors the user-toggleable system tools (the same pool the
    chat composer / settings expose); ``builtin_tools`` lists the auto-mounted
    built-in tools (rag / web_fetch / …) the owner can allow or deny;
    ``mcp_tools`` lists every configured MCP tool the partner could be allowed
    to load. ``read_memory`` / ``write_memory`` are excluded: partners use the
    mandatory ``partner_read`` / ``partner_memorize`` / ``partner_search`` tools
    instead, which are always on and not owner-configurable.
    """
    from cognivoy.api.utils.tool_options import build_tool_options

    return await build_tool_options(exclude_builtin={"read_memory", "write_memory"})


# ── Create / read / update / lifecycle ─────────────────────────


@router.post("")
async def create_partner(payload: CreatePartnerRequest):
    mgr = get_partner_manager()
    partner_id = slugify_partner_id(payload.partner_id or payload.name)
    if mgr.partner_exists(partner_id):
        raise HTTPException(
            status_code=409,
            detail=t("api.partner_already_exists", name=partner_id),
        )

    if payload.channels is not None:
        _validate_channels_payload(payload.channels)
    llm_selection = _validate_llm_selection_payload(payload.llm_selection)
    backup_llm_selection = _validate_llm_selection_payload(payload.backup_llm_selection)
    soul_content, soul_origin = _resolve_soul_content(payload.soul)

    config = PartnerConfig(
        name=payload.name.strip(),
        description=(payload.description or "").strip(),
        channels=payload.channels or {},
        llm_selection=llm_selection,
        backup_llm_selection=backup_llm_selection,
        language=(payload.language or "").strip(),
        emoji=(payload.emoji or "").strip(),
        color=(payload.color or "").strip(),
        avatar=_validate_avatar_payload(payload.avatar),
        soul_origin=soul_origin,
        enabled_tools=payload.enabled_tools,
        builtin_tools=payload.builtin_tools,
        mcp_tools=payload.mcp_tools,
        proactive_learning=payload.proactive_learning,
        proactive_review_delay_hours=payload.proactive_review_delay_hours,
        proactive_low_score_threshold=payload.proactive_low_score_threshold,
        proactive_goal=payload.proactive_goal.strip(),
        proactive_timezone=payload.proactive_timezone,
        proactive_allowed_start=payload.proactive_allowed_start,
        proactive_allowed_end=payload.proactive_allowed_end,
        proactive_allowed_weekdays=list(dict.fromkeys(payload.proactive_allowed_weekdays)),
        proactive_frequency=payload.proactive_frequency,
        proactive_preferred_channel=payload.proactive_preferred_channel.strip(),
        proactive_paused_until=payload.proactive_paused_until,
        proactive_min_interval_hours=payload.proactive_min_interval_hours,
        proactive_max_per_day=payload.proactive_max_per_day,
        proactive_merge_window_hours=payload.proactive_merge_window_hours,
    )
    mgr.save_config(partner_id, config, auto_start=bool(payload.start))
    write_soul(partner_id, soul_content)

    provisioning: dict[str, Any] = {"copied": {}, "errors": []}
    if payload.assets is not None:
        provisioning = provision_assets(
            partner_id,
            knowledge_bases=payload.assets.knowledge_bases,
            skills=payload.assets.skills,
            notebooks=payload.assets.notebooks,
        )

    if payload.start:
        try:
            instance = await mgr.start_partner(partner_id, config)
            result = instance.to_dict(mask_secrets=True)
        except Exception:
            logger.exception("Partner '%s' created but failed to start", partner_id)
            result = _stopped_partner_dict(partner_id, config)
            result["start_error"] = "Partner created but failed to start"
    else:
        result = _stopped_partner_dict(partner_id, config)

    result["provisioning"] = provisioning
    return result


def _stopped_partner_dict(
    partner_id: str,
    cfg: PartnerConfig,
    *,
    include_secrets: bool = False,
) -> dict:
    if include_secrets:
        channels: object = strip_legacy_global_delivery(cfg.channels)
    else:
        channels = mask_channel_secrets(strip_legacy_global_delivery(cfg.channels))
    return {
        "partner_id": partner_id,
        "name": cfg.name,
        "description": cfg.description,
        "channels": channels,
        "llm_selection": cfg.llm_selection,
        "backup_llm_selection": cfg.backup_llm_selection,
        "model": cfg.model,
        "language": cfg.language,
        "emoji": cfg.emoji,
        "color": cfg.color,
        "avatar": cfg.avatar,
        "soul_origin": cfg.soul_origin,
        "enabled_tools": cfg.enabled_tools,
        "builtin_tools": cfg.builtin_tools,
        "mcp_tools": cfg.mcp_tools,
        "proactive_learning": cfg.proactive_learning,
        "proactive_review_delay_hours": cfg.proactive_review_delay_hours,
        "proactive_low_score_threshold": cfg.proactive_low_score_threshold,
        "proactive_goal": cfg.proactive_goal,
        "proactive_timezone": cfg.proactive_timezone,
        "proactive_allowed_start": cfg.proactive_allowed_start,
        "proactive_allowed_end": cfg.proactive_allowed_end,
        "proactive_allowed_weekdays": cfg.proactive_allowed_weekdays,
        "proactive_frequency": cfg.proactive_frequency,
        "proactive_preferred_channel": cfg.proactive_preferred_channel,
        "proactive_paused_until": cfg.proactive_paused_until,
        "proactive_min_interval_hours": cfg.proactive_min_interval_hours,
        "proactive_max_per_day": cfg.proactive_max_per_day,
        "proactive_merge_window_hours": cfg.proactive_merge_window_hours,
        "running": False,
        "started_at": None,
        "last_reload_error": None,
    }


_PROACTIVE_EVENT_TYPES = frozenset(
    {"low_quiz_score", "due_review", "learning_plan", "inactivity", "custom"}
)


def _is_proactive_job(job: Any, partner_id: str) -> bool:
    if job.owner.key != f"partner:{partner_id}":
        return False
    event_type = str(job.owner.channel_meta.get("learning_event") or "")
    return (
        event_type in _PROACTIVE_EVENT_TYPES
        or job.name.startswith(f"learning-review:{partner_id}:")
        or job.name.startswith(f"proactive:{partner_id}:")
    )


def _proactive_job_payload(job: Any) -> dict[str, Any]:
    metadata = dict(job.owner.channel_meta or {})
    event_type = str(metadata.get("learning_event") or "")
    if not event_type and job.name.startswith("learning-review:"):
        event_type = "low_quiz_score"
    return {
        "id": job.id,
        "name": job.name,
        "message": job.message,
        "scheduled_for": (
            datetime.fromtimestamp(job.schedule.at_ms / 1000).astimezone().isoformat()
            if job.schedule.at_ms
            else None
        ),
        "channel": job.owner.channel,
        "event_type": event_type or "custom",
        "event_key": metadata.get("event_key"),
        "metadata": metadata,
        "weak_questions": metadata.get("weak_questions", []),
        "merged_events": metadata.get("merged_events", 1),
        "attempt_count": job.state.attempt_count,
        "max_attempts": job.max_attempts,
        "last_error": job.state.last_error,
    }


def _record_project_reminder_outcome(job: Any, *, partner_id: str, decision: str) -> None:
    """Best-effort projection of learner reminder actions into project evidence."""

    metadata = dict(job.owner.channel_meta or {})
    project_id = str(metadata.get("project_id") or "").strip()
    if not project_id:
        return
    try:
        from cognivoy.learning.project_storage import LearningProjectStore
        from cognivoy.multi_user.context import get_current_user

        LearningProjectStore().record_external_event(
            project_id,
            owner_id=get_current_user().id,
            event_type="tutor_reminder",
            title=f"Tutor reminder {decision}",
            description=str(job.message or ""),
            result_refs=[f"partner:{partner_id}", f"reminder:{job.id}"],
            dedupe_key=f"reminder:{job.id}:{decision}",
        )
    except Exception:
        logger.warning("Failed to record learning-project reminder outcome", exc_info=True)


@router.get("/reminders/overview")
async def get_all_proactive_reminders(
    audit_limit_per_partner: int = Query(default=20, ge=1, le=100),
):
    """Cross-partner operations view for pending outreach and recent policy decisions."""
    mgr = get_partner_manager()
    cron = get_cron_service()
    rows: list[dict[str, Any]] = []
    pending_total = 0
    for partner in mgr.list_partners():
        partner_id = str(partner.get("partner_id") or "")
        jobs = [
            job
            for job in cron.list_jobs(owner_key=f"partner:{partner_id}")
            if _is_proactive_job(job, partner_id)
        ]
        pending_total += len(jobs)
        rows.append(
            {
                "partner_id": partner_id,
                "partner_name": partner.get("name") or partner_id,
                "enabled": bool(partner.get("proactive_learning")),
                "pending": [_proactive_job_payload(job) for job in jobs],
                "audit": list_proactive_audit(partner_id, limit=audit_limit_per_partner),
            }
        )
    return {"pending_count": pending_total, "partners": rows}


@router.get("/{partner_id}")
async def get_partner(
    partner_id: str,
    include_secrets: bool = Query(
        False,
        description=(
            "Return raw channel secrets (tokens, passwords). Required by the "
            "edit form; default response masks all secret-looking fields."
        ),
    ),
):
    mgr = get_partner_manager()
    instance = mgr.get_partner(partner_id)
    if instance:
        return instance.to_dict(
            include_secrets=include_secrets,
            mask_secrets=not include_secrets,
        )
    cfg = mgr.load_config(partner_id)
    if cfg:
        return _stopped_partner_dict(partner_id, cfg, include_secrets=include_secrets)
    raise HTTPException(status_code=404, detail=t("api.partner_not_found"))


@router.get("/{partner_id}/proactive-reminders")
async def get_proactive_reminders(
    partner_id: str,
    audit_limit: int = Query(default=100, ge=1, le=500),
):
    mgr = get_partner_manager()
    if not mgr.partner_exists(partner_id):
        raise HTTPException(status_code=404, detail=t("api.partner_not_found"))
    jobs = [
        job
        for job in get_cron_service().list_jobs(owner_key=f"partner:{partner_id}")
        if _is_proactive_job(job, partner_id)
    ]
    audit = list_proactive_audit(partner_id, limit=audit_limit)
    return {
        "pending": [_proactive_job_payload(job) for job in jobs],
        "audit": audit,
        "analytics": proactive_effectiveness(audit),
    }


@router.post("/{partner_id}/proactive-events")
async def create_proactive_event(
    partner_id: str,
    payload: ProactiveEventRequest,
):
    """Schedule a typed TutorBot event through the partner's policy engine.

    The event key is supplied by the producing subsystem and makes retries
    idempotent.  Delivery timing, DND, social windows, merging and rate limits
    remain owned by the Partner configuration rather than by the caller.
    """
    mgr = get_partner_manager()
    if not mgr.partner_exists(partner_id):
        raise HTTPException(status_code=404, detail=t("api.partner_not_found"))
    job_ids = schedule_proactive_event(
        event_type=payload.event_type,
        event_key=payload.event_key.strip(),
        message=payload.message.strip(),
        desired_at=payload.desired_at,
        metadata=dict(payload.metadata),
        partner_ids=[partner_id],
    )
    return {"ok": True, "job_ids": job_ids}


@router.delete("/{partner_id}/proactive-reminders/{job_id}")
async def cancel_proactive_reminder(partner_id: str, job_id: str):
    mgr = get_partner_manager()
    if not mgr.partner_exists(partner_id):
        raise HTTPException(status_code=404, detail=t("api.partner_not_found"))
    cron = get_cron_service()
    job = cron.get_job(job_id)
    if job is None or not _is_proactive_job(job, partner_id):
        raise HTTPException(status_code=404, detail="Reminder not found")
    if not cron.cancel_job(job_id, owner_key=f"partner:{partner_id}"):
        raise HTTPException(status_code=409, detail="Reminder could not be cancelled")
    record_proactive_outcome(
        partner_id=partner_id,
        job_id=job_id,
        decision="cancelled",
    )
    _record_project_reminder_outcome(job, partner_id=partner_id, decision="cancelled")
    return {"ok": True}


@router.post("/{partner_id}/proactive-reminders/{job_id}/action")
async def act_on_proactive_reminder(
    partner_id: str,
    job_id: str,
    payload: ProactiveReminderActionRequest,
):
    mgr = get_partner_manager()
    cfg = mgr.load_config(partner_id)
    if cfg is None:
        raise HTTPException(status_code=404, detail=t("api.partner_not_found"))
    cron = get_cron_service()
    job = cron.get_job(job_id)
    if job is None or not _is_proactive_job(job, partner_id):
        raise HTTPException(status_code=404, detail="Reminder not found")

    if payload.action == "view":
        record_proactive_outcome(
            partner_id=partner_id,
            job_id=job_id,
            decision="viewed",
        )
        _record_project_reminder_outcome(
            job,
            partner_id=partner_id,
            decision="viewed",
        )
        return {"ok": True, "action": "view", "reminder": _proactive_job_payload(job)}

    if payload.action in {"start", "later"}:
        delay = 1 if payload.action == "start" else payload.later_hours * 60 * 60
        moved = cron.reschedule_job(
            job_id,
            at_ms=int(datetime.now().timestamp() * 1000) + delay * 1000,
            owner_key=f"partner:{partner_id}",
        )
        if moved is None:
            raise HTTPException(status_code=409, detail="Reminder could not be rescheduled")
        record_proactive_outcome(
            partner_id=partner_id,
            job_id=job_id,
            decision="expedited" if payload.action == "start" else "snoozed",
        )
        _record_project_reminder_outcome(
            job,
            partner_id=partner_id,
            decision="started" if payload.action == "start" else "snoozed",
        )
        return {"ok": True, "action": payload.action, "reminder": _proactive_job_payload(moved)}

    if not cron.cancel_job(job_id, owner_key=f"partner:{partner_id}"):
        raise HTTPException(status_code=409, detail="Reminder could not be cancelled")
    decision = "skipped"
    if payload.action == "disable":
        cfg.proactive_learning = False
        mgr.save_config(partner_id, cfg)
        for pending in list(cron.list_jobs(owner_key=f"partner:{partner_id}")):
            if _is_proactive_job(pending, partner_id):
                cron.cancel_job(pending.id, owner_key=f"partner:{partner_id}")
        decision = "disabled"
    record_proactive_outcome(
        partner_id=partner_id,
        job_id=job_id,
        decision=decision,
    )
    _record_project_reminder_outcome(job, partner_id=partner_id, decision=decision)
    return {"ok": True, "action": payload.action}


def _apply_update(cfg: PartnerConfig, payload: UpdatePartnerRequest) -> None:
    if payload.name is not None:
        cfg.name = payload.name
    if payload.description is not None:
        cfg.description = payload.description
    if payload.channels is not None:
        cfg.channels = payload.channels
    if payload.language is not None:
        cfg.language = payload.language
    if payload.emoji is not None:
        cfg.emoji = payload.emoji
    if payload.color is not None:
        cfg.color = payload.color
    if payload.avatar is not None:
        cfg.avatar = _validate_avatar_payload(payload.avatar)
    if "llm_selection" in payload.model_fields_set:
        cfg.llm_selection = _validate_llm_selection_payload(payload.llm_selection)
        cfg.model = None  # selection supersedes any legacy model string
    if "backup_llm_selection" in payload.model_fields_set:
        cfg.backup_llm_selection = _validate_llm_selection_payload(payload.backup_llm_selection)
    if "enabled_tools" in payload.model_fields_set:
        cfg.enabled_tools = payload.enabled_tools
    if "builtin_tools" in payload.model_fields_set:
        cfg.builtin_tools = payload.builtin_tools
    if "mcp_tools" in payload.model_fields_set:
        cfg.mcp_tools = payload.mcp_tools
    if payload.proactive_learning is not None:
        cfg.proactive_learning = payload.proactive_learning
    if payload.proactive_review_delay_hours is not None:
        cfg.proactive_review_delay_hours = payload.proactive_review_delay_hours
    if payload.proactive_low_score_threshold is not None:
        cfg.proactive_low_score_threshold = payload.proactive_low_score_threshold
    if payload.proactive_goal is not None:
        cfg.proactive_goal = payload.proactive_goal.strip()
    if payload.proactive_timezone is not None:
        cfg.proactive_timezone = payload.proactive_timezone
    if payload.proactive_allowed_start is not None:
        cfg.proactive_allowed_start = payload.proactive_allowed_start
    if payload.proactive_allowed_end is not None:
        cfg.proactive_allowed_end = payload.proactive_allowed_end
    if payload.proactive_allowed_weekdays is not None:
        cfg.proactive_allowed_weekdays = list(dict.fromkeys(payload.proactive_allowed_weekdays))
    if payload.proactive_frequency is not None:
        cfg.proactive_frequency = payload.proactive_frequency
    if payload.proactive_preferred_channel is not None:
        cfg.proactive_preferred_channel = payload.proactive_preferred_channel.strip()
    if payload.proactive_paused_until is not None:
        cfg.proactive_paused_until = payload.proactive_paused_until
    if payload.proactive_min_interval_hours is not None:
        cfg.proactive_min_interval_hours = payload.proactive_min_interval_hours
    if payload.proactive_max_per_day is not None:
        cfg.proactive_max_per_day = payload.proactive_max_per_day
    if payload.proactive_merge_window_hours is not None:
        cfg.proactive_merge_window_hours = payload.proactive_merge_window_hours


@router.patch("/{partner_id}")
async def update_partner(partner_id: str, payload: UpdatePartnerRequest):
    if payload.channels is not None:
        _validate_channels_payload(payload.channels)

    mgr = get_partner_manager()
    instance = mgr.get_partner(partner_id)
    if instance:
        candidate = copy.deepcopy(instance.config)
        _apply_update(candidate, payload)
        if payload.channels is not None:
            previous = instance.config
            instance.config = candidate
            if instance.runner:
                instance.runner.config = candidate
            try:
                await mgr.reload_channels(partner_id)
            except Exception as exc:
                instance.config = previous
                if instance.runner:
                    instance.runner.config = previous
                logger.exception("reload_channels failed for partner '%s'", partner_id)
                raise HTTPException(
                    status_code=422,
                    detail={"message": f"Invalid channel configuration: {exc}"},
                ) from None
        else:
            instance.config = candidate
            if instance.runner:
                instance.runner.config = candidate
        mgr.save_config(partner_id, candidate)
        # LLM / tool changes need no reload: the runner resolves
        # llm_selection and tool config per turn from this same config object.
        return instance.to_dict(mask_secrets=True)

    cfg = mgr.load_config(partner_id)
    if not cfg:
        raise HTTPException(status_code=404, detail=t("api.partner_not_found"))
    candidate = copy.deepcopy(cfg)
    _apply_update(candidate, payload)
    mgr.save_config(partner_id, candidate)
    return _stopped_partner_dict(partner_id, candidate)


@router.post("/{partner_id}/start")
async def start_partner(partner_id: str):
    instance = await _ensure_running_partner(partner_id, allow_stopped=True)
    # An explicit start is a persisted "run on boot" intent — so the partner
    # comes back in this state after a Cognivoy restart (a manual /stop clears
    # it; a lazy chat-driven start does NOT reach here, so it can't flip it).
    get_partner_manager().save_config(partner_id, instance.config, auto_start=True)
    return instance.to_dict(mask_secrets=True)


@router.post("/{partner_id}/stop")
async def stop_partner(partner_id: str):
    stopped = await get_partner_manager().stop_partner(partner_id)
    if not stopped:
        raise HTTPException(status_code=404, detail=t("api.partner_not_found_or_not_running"))
    return {"partner_id": partner_id, "stopped": True}


@router.delete("/{partner_id}")
async def destroy_partner(partner_id: str):
    destroyed = await get_partner_manager().destroy_partner(partner_id)
    if not destroyed:
        raise HTTPException(status_code=404, detail=t("api.partner_not_found"))
    return {"partner_id": partner_id, "destroyed": True}


@router.post("/{partner_id}/channels/reload")
async def reload_partner_channels(partner_id: str):
    mgr = get_partner_manager()
    instance = mgr.get_partner(partner_id)
    if not instance or not instance.running:
        raise HTTPException(status_code=404, detail=t("api.partner_not_running"))
    try:
        await mgr.reload_channels(partner_id)
    except Exception as exc:
        raise internal_http_error(exc, operation="partners.reload_channels") from None
    return {"partner_id": partner_id, "reloaded": True}


# ── Soul (the partner's own SOUL.md) ───────────────────────────


@router.get("/{partner_id}/soul")
async def get_partner_soul(partner_id: str):
    mgr = get_partner_manager()
    if not mgr.partner_exists(partner_id):
        raise HTTPException(status_code=404, detail=t("api.partner_not_found"))
    return {"partner_id": partner_id, "content": read_soul(partner_id)}


@router.get("/{partner_id}/soul/versions")
async def get_partner_soul_versions(
    partner_id: str,
    limit: int = Query(default=50, ge=1, le=100),
):
    mgr = get_partner_manager()
    if not mgr.partner_exists(partner_id):
        raise HTTPException(status_code=404, detail=t("api.partner_not_found"))
    return {
        "partner_id": partner_id,
        "versions": list_soul_versions(partner_id, limit=limit),
    }


@router.post("/{partner_id}/soul/versions/{version_id}/restore")
async def restore_partner_soul_version(partner_id: str, version_id: str):
    mgr = get_partner_manager()
    if not mgr.partner_exists(partner_id):
        raise HTTPException(status_code=404, detail=t("api.partner_not_found"))
    try:
        content = restore_soul_version(partner_id, version_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Soul version not found") from None
    return {"partner_id": partner_id, "content": content, "restored": True}


@router.put("/{partner_id}/soul")
async def put_partner_soul(partner_id: str, payload: SoulUpdateBody):
    mgr = get_partner_manager()
    if not mgr.partner_exists(partner_id):
        raise HTTPException(status_code=404, detail=t("api.partner_not_found"))
    write_soul(partner_id, payload.content)
    return {"partner_id": partner_id, "saved": True}


# ── Assets ─────────────────────────────────────────────────────


@router.get("/{partner_id}/assets")
async def get_partner_assets(partner_id: str):
    mgr = get_partner_manager()
    if not mgr.partner_exists(partner_id):
        raise HTTPException(status_code=404, detail=t("api.partner_not_found"))
    return list_assets(partner_id)


@router.post("/{partner_id}/assets")
async def add_partner_assets(partner_id: str, payload: AssetAddRequest):
    mgr = get_partner_manager()
    if not mgr.partner_exists(partner_id):
        raise HTTPException(status_code=404, detail=t("api.partner_not_found"))
    report = provision_assets(
        partner_id,
        knowledge_bases=payload.knowledge_bases,
        skills=payload.skills,
        notebooks=payload.notebooks,
    )
    return {"partner_id": partner_id, **report, "assets": list_assets(partner_id)}


@router.delete("/{partner_id}/assets/{asset_type}/{name}")
async def delete_partner_asset(partner_id: str, asset_type: str, name: str):
    mgr = get_partner_manager()
    if not mgr.partner_exists(partner_id):
        raise HTTPException(status_code=404, detail=t("api.partner_not_found"))
    try:
        removed = remove_asset(partner_id, asset_type, name)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None
    if not removed:
        raise HTTPException(status_code=404, detail="Asset not found")
    return {"partner_id": partner_id, "removed": True, "assets": list_assets(partner_id)}


# ── History ────────────────────────────────────────────────────


def _partner_dead_letter_store(partner_id: str):
    from cognivoy.partners.channels.dead_letter import DeadLetterStore

    return DeadLetterStore(get_partner_dir(partner_id) / "runtime" / "dead-letter.jsonl")


@router.get("/{partner_id}/channels/status")
async def get_partner_channel_status(partner_id: str):
    """Return a uniform health and feature-capability contract per channel."""
    mgr = get_partner_manager()
    config = mgr.load_config(partner_id)
    if config is None:
        raise HTTPException(status_code=404, detail=t("api.partner_not_found"))
    instance = mgr.get_partner(partner_id)
    if instance and instance.running and instance.channel_manager:
        channels = await instance.channel_manager.get_status()
    else:
        channels = {}
        for name, raw in strip_legacy_global_delivery(config.channels).items():
            enabled = not isinstance(raw, dict) or bool(raw.get("enabled", True))
            if not enabled:
                continue
            channels[name] = {
                "enabled": True,
                "status": "stopped",
                "running": False,
                "capabilities": {
                    "text": True,
                    "inbound_attachments": False,
                    "outbound_attachments": False,
                    "streaming": False,
                },
            }
    return {
        "partner_id": partner_id,
        "running": bool(instance and instance.running),
        "channels": channels,
    }


@router.get("/{partner_id}/dead-letters")
async def list_partner_dead_letters(
    partner_id: str,
    status: Literal["pending", "replayed", "discarded"] | None = None,
):
    mgr = get_partner_manager()
    if not mgr.partner_exists(partner_id):
        raise HTTPException(status_code=404, detail=t("api.partner_not_found"))
    records = _partner_dead_letter_store(partner_id).list_records(status=status)
    records.sort(key=lambda row: str(row.get("created_at") or ""), reverse=True)
    return {"partner_id": partner_id, "records": records}


@router.post("/{partner_id}/dead-letters/{record_id}/retry")
async def retry_partner_dead_letter(partner_id: str, record_id: str):
    store = _partner_dead_letter_store(partner_id)
    if store.get(record_id) is None:
        raise HTTPException(status_code=404, detail="Delivery failure record not found")
    instance = await _ensure_running_partner(partner_id, allow_stopped=True)
    if not instance.channel_manager:
        raise HTTPException(status_code=409, detail="Partner has no enabled delivery channels")
    try:
        return await instance.channel_manager.retry_dead_letter(record_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Delivery failure record not found") from None
    except LookupError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from None


@router.post("/{partner_id}/dead-letters/{record_id}/discard")
async def discard_partner_dead_letter(
    partner_id: str,
    record_id: str,
    payload: DeadLetterDispositionBody,
):
    mgr = get_partner_manager()
    if not mgr.partner_exists(partner_id):
        raise HTTPException(status_code=404, detail=t("api.partner_not_found"))
    try:
        return _partner_dead_letter_store(partner_id).resolve(
            record_id, status="discarded", note=payload.note
        )
    except KeyError:
        raise HTTPException(status_code=404, detail="Delivery failure record not found") from None


@router.get("/{partner_id}/history")
async def get_partner_history(
    partner_id: str,
    session_key: str | None = None,
    session_id: str | None = None,
    limit: int = 100,
):
    """Conversation history. Pass ``session_key`` for an exact key, or
    ``session_id`` for a web session (mapped through ``web_session_key``);
    with neither, all non-archived sessions are merged."""
    mgr = get_partner_manager()
    if session_id and not session_key:
        session_key = mgr.web_session_key(partner_id, session_id=session_id)
    return mgr.get_history(partner_id, session_key=session_key, limit=limit)


@router.get("/{partner_id}/sessions")
async def get_partner_sessions(partner_id: str):
    mgr = get_partner_manager()
    if not mgr.partner_exists(partner_id):
        raise HTTPException(status_code=404, detail=t("api.partner_not_found"))
    return mgr.session_store(partner_id).list_sessions()


@router.post("/{partner_id}/sessions/archive")
async def archive_partner_session(partner_id: str, payload: SessionKeyBody):
    """Soft-archive a session (web /new) — it stays resumable, file untouched."""
    mgr = get_partner_manager()
    if not mgr.partner_exists(partner_id):
        raise HTTPException(status_code=404, detail=t("api.partner_not_found"))
    mgr.archive_session(partner_id, payload.session_key)
    return {"partner_id": partner_id, "archived": True, "session_key": payload.session_key}


@router.post("/{partner_id}/sessions/resume")
async def resume_partner_session(partner_id: str, payload: SessionKeyBody):
    """Clear a session's archived flag so the web app can continue it."""
    mgr = get_partner_manager()
    if not mgr.partner_exists(partner_id):
        raise HTTPException(status_code=404, detail=t("api.partner_not_found"))
    summary = mgr.resume_session(partner_id, payload.session_key)
    if summary is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return {"partner_id": partner_id, "resumed": True, "session": summary}


@router.post("/{partner_id}/sessions/delete")
async def delete_partner_session(partner_id: str, payload: SessionKeyBody):
    mgr = get_partner_manager()
    if not mgr.partner_exists(partner_id):
        raise HTTPException(status_code=404, detail=t("api.partner_not_found"))
    removed = mgr.delete_session(partner_id, payload.session_key)
    if not removed:
        raise HTTPException(status_code=404, detail="Session not found")
    return {"partner_id": partner_id, "deleted": True, "session_key": payload.session_key}


@router.post("/{partner_id}/sessions/branch")
async def branch_partner_session(partner_id: str, payload: SessionBranchBody):
    """Copy a session's full history into a new key and archive the source."""
    mgr = get_partner_manager()
    if not mgr.partner_exists(partner_id):
        raise HTTPException(status_code=404, detail=t("api.partner_not_found"))
    summary = mgr.branch_session(partner_id, payload.source_key, payload.new_key)
    if summary is None:
        raise HTTPException(status_code=400, detail="Nothing to branch (source is empty)")
    return {"partner_id": partner_id, "branched": True, "session": summary}


@router.get("/commands/palette")
async def partner_command_palette():
    from cognivoy.services.partners.commands import partner_command_palette

    return {"commands": partner_command_palette()}


# ── Chat (HTTP / SSE / WebSocket) ──────────────────────────────


def _sse(event: str, payload: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(payload, ensure_ascii=False, default=str)}\n\n"


def _resolve_http_session(payload: ChatMessageRequest) -> tuple[str, str]:
    explicit_session = (payload.session_id or "").strip()
    explicit_chat = (payload.chat_id or "").strip()
    if explicit_session:
        return explicit_session, explicit_chat or explicit_session
    if explicit_chat:
        return explicit_chat, explicit_chat
    session_id = uuid4().hex
    return session_id, session_id


# Fallback caps when the settings layer is unavailable; the effective values
# come from the shared chat-attachment policy (data/user/settings/system.json,
# editable at /settings/attachments).
_PARTNER_UPLOAD_MAX_BYTES = 20 * 1024 * 1024
_PARTNER_UPLOAD_MAX_TOTAL_BYTES = 25 * 1024 * 1024


def _partner_upload_caps() -> tuple[int, int]:
    try:
        from cognivoy.services.config.runtime_settings import get_chat_attachment_limits

        limits = get_chat_attachment_limits()
        return limits.max_file_bytes, limits.max_total_bytes
    except Exception:  # pragma: no cover - defensive fallback
        return _PARTNER_UPLOAD_MAX_BYTES, _PARTNER_UPLOAD_MAX_TOTAL_BYTES


def _clean_attachment_base64(value: str) -> str:
    text = str(value or "").strip()
    if text.startswith("data:") and "," in text:
        return text.split(",", 1)[1]
    return text


def _default_attachment_prompt(attachments: list[ChatAttachmentRequest]) -> str:
    if attachments and all(str(item.type).lower() == "image" for item in attachments):
        return t("Please analyze the attached image(s).")
    return t("Please use the attached file(s).")


def _materialize_partner_attachments(
    partner_id: str,
    attachments: list[ChatAttachmentRequest],
) -> list[str]:
    """Persist browser-sent attachment bytes into the partner media tree."""
    if not attachments:
        return []

    media_dir = get_partner_media_dir(partner_id, "web")
    max_file_bytes, max_total_bytes = _partner_upload_caps()
    total_bytes = 0
    media_paths: list[str] = []
    for item in attachments:
        raw_b64 = _clean_attachment_base64(item.base64)
        if not raw_b64:
            # Partner web chat accepts uploaded bytes only. URL-only
            # attachments are ignored rather than fetched server-side.
            continue
        try:
            data = base64.b64decode(raw_b64, validate=False)
        except (binascii.Error, ValueError) as exc:
            raise HTTPException(
                status_code=422,
                detail=f"Invalid attachment data for {item.filename or 'file'}",
            ) from exc
        if len(data) > max_file_bytes:
            raise HTTPException(
                status_code=413,
                detail=f"Attachment too large: {item.filename or 'file'}",
            )
        if total_bytes + len(data) > max_total_bytes:
            raise HTTPException(status_code=413, detail="Attachment batch too large")
        total_bytes += len(data)

        filename = safe_filename(item.filename or "attachment") or "attachment"
        path = media_dir / f"{uuid4().hex[:12]}_{filename}"
        path.write_bytes(data)
        media_paths.append(str(path))
    return media_paths


@router.post("/{partner_id}/chat")
async def partner_chat_http(partner_id: str, payload: ChatMessageRequest) -> dict[str, Any]:
    """Send one HTTP message to a partner with persistent session context."""
    content = payload.content.strip()
    if not content and not payload.attachments:
        raise HTTPException(status_code=400, detail=t("api.content_required"))
    await _ensure_running_partner(partner_id)
    media_paths = _materialize_partner_attachments(partner_id, payload.attachments)
    if not content and media_paths:
        content = _default_attachment_prompt(payload.attachments)
    mgr = get_partner_manager()
    session_id, chat_id = _resolve_http_session(payload)
    try:
        response = await mgr.send_message(
            partner_id,
            content,
            chat_id=chat_id,
            session_id=session_id,
            media=media_paths,
            session_key=payload.session_key,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    return {
        "partner_id": partner_id,
        "session_id": session_id,
        "content": response,
    }


async def _partner_chat_stream(
    partner_id: str,
    payload: ChatMessageRequest,
) -> AsyncGenerator[str, None]:
    from cognivoy.core.stream import StreamEventType

    mgr = get_partner_manager()
    content = payload.content.strip()
    if not content and not payload.attachments:
        yield _sse("error", {"detail": t("api.content_required")})
        return
    media_paths = _materialize_partner_attachments(partner_id, payload.attachments)
    if not content and media_paths:
        content = _default_attachment_prompt(payload.attachments)
    session_id, chat_id = _resolve_http_session(payload)
    queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
    done = asyncio.Event()
    holder: dict[str, Any] = {}

    async def on_event(event: Any) -> None:
        if event.type == StreamEventType.THINKING and event.content:
            await queue.put({"event": "thinking", "payload": {"content": event.content}})

    async def run() -> None:
        try:
            holder["content"] = await mgr.send_message(
                partner_id,
                content,
                chat_id=chat_id,
                session_id=session_id,
                media=media_paths,
                on_event=on_event,
                session_key=payload.session_key,
            )
        except Exception as exc:  # noqa: BLE001
            holder["error"] = str(exc)
        finally:
            done.set()

    yield _sse("session", {"partner_id": partner_id, "session_id": session_id})
    task = asyncio.create_task(run())
    try:
        while not done.is_set():
            try:
                item = await asyncio.wait_for(queue.get(), timeout=0.15)
            except asyncio.TimeoutError:
                continue
            yield _sse(item["event"], item["payload"])
        while not queue.empty():
            item = queue.get_nowait()
            yield _sse(item["event"], item["payload"])
        if holder.get("error"):
            yield _sse("error", {"detail": holder["error"]})
            return
        yield _sse("content", {"content": holder.get("content", "")})
        yield _sse("done", {"partner_id": partner_id, "session_id": session_id})
    finally:
        if not task.done():
            task.cancel()


@router.post("/{partner_id}/chat/execute-stream")
async def partner_chat_http_stream(partner_id: str, payload: ChatMessageRequest):
    """Stream one HTTP message to a partner as server-sent events."""
    if not payload.content.strip() and not payload.attachments:
        raise HTTPException(status_code=400, detail=t("api.content_required"))
    await _ensure_running_partner(partner_id)
    return StreamingResponse(
        _partner_chat_stream(partner_id, payload),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.websocket("/{partner_id}/ws")
async def partner_chat_ws(ws: WebSocket, partner_id: str):
    """Web chat socket.

    Client → server: ``{"content": str, "session_id"?: str, "chat_id"?: str,
    "attachments"?: [{"type", "filename", "mime_type", "base64"}]}``.
    Server → client frames:

    * ``{"type": "stream_event", "event": {...}}`` — every chat-loop
      StreamEvent (content/thinking/tool_call/progress/sources/result),
      letting the UI render the same live trace as product chat;
    * ``{"type": "content", "content": str}`` — the final reply;
    * ``{"type": "done"}`` / ``{"type": "error"}`` / ``{"type": "proactive"}``.
    """
    from cognivoy.api.routers.auth import ws_auth_failed, ws_require_auth
    from cognivoy.multi_user.context import reset_current_user

    user_token = await ws_require_auth(ws)
    if user_token is ws_auth_failed:
        return

    mgr = get_partner_manager()
    disconnected = asyncio.Event()

    async def _safe_send(payload: dict) -> bool:
        try:
            await ws.send_json(payload)
            return True
        except (WebSocketDisconnect, RuntimeError):
            disconnected.set()
            return False

    await ws.accept()
    try:
        instance = await _ensure_running_partner(partner_id)
    except HTTPException as exc:
        message = str(exc.detail)
        await _safe_send({"type": "error", "content": message})
        code = 4004 if exc.status_code == 404 else 4003
        await ws.close(code=code, reason=message[:120])
        return

    logger.info("WebSocket connected for partner '%s'", partner_id)

    # Web turns run on the partner instance (see LiveTurn), NOT tied to this
    # socket — so a refresh reattaches and replays instead of killing the turn.
    # The socket just drains a subscriber queue; the receive loop stays free to
    # process stop / attach frames concurrently.
    drain: dict[str, asyncio.Task | None] = {"task": None}

    async def _drain(queue: asyncio.Queue) -> None:
        while True:
            frame = await queue.get()
            if not await _safe_send(frame):
                return
            if frame.get("type") in {"done", "stopped"}:
                return

    def _start_drain(queue: asyncio.Queue) -> None:
        prev = drain["task"]
        if prev is not None and not prev.done():
            prev.cancel()
        drain["task"] = asyncio.create_task(_drain(queue))

    def _resolve_key(data: dict[str, Any]) -> str:
        return str(
            data.get("session_key")
            or mgr.web_session_key(
                partner_id,
                chat_id=data.get("chat_id", "web"),
                session_id=data.get("session_id"),
            )
        )

    async def _handle_user_messages():
        while not disconnected.is_set():
            try:
                raw = await ws.receive_text()
            except WebSocketDisconnect:
                disconnected.set()
                break
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                if not await _safe_send({"type": "error", "content": "Invalid JSON"}):
                    break
                continue

            action = data.get("action")
            if action == "stop":
                mgr.stop_web_turn(partner_id, _resolve_key(data))
                continue
            if action == "attach":
                # Reconnect (a page refresh) — replay an in-flight turn so the
                # streaming answer the user was watching survives the reload.
                turn = mgr.subscribe_web_turn(partner_id, _resolve_key(data))
                if turn is not None:
                    await _safe_send({"type": "resuming"})
                    if turn.user_content:
                        await _safe_send({"type": "user_echo", "content": turn.user_content})
                    _start_drain(turn.subscribe())
                continue

            content = data.get("content", "").strip()
            try:
                attachments = [
                    ChatAttachmentRequest.model_validate(item)
                    for item in (data.get("attachments") or [])
                    if isinstance(item, dict)
                ]
            except ValidationError:
                if not await _safe_send({"type": "error", "content": "Invalid attachments"}):
                    break
                continue

            if not content and not attachments:
                continue
            try:
                media_paths = _materialize_partner_attachments(partner_id, attachments)
            except HTTPException as exc:
                if not await _safe_send({"type": "error", "content": str(exc.detail)}):
                    break
                continue
            if not content and media_paths:
                content = _default_attachment_prompt(attachments)

            try:
                turn = mgr.start_web_turn(partner_id, _resolve_key(data), content, media_paths)
            except RuntimeError as exc:
                if not await _safe_send({"type": "error", "content": str(exc)}):
                    break
                continue
            _start_drain(turn.subscribe())

    async def _handle_notifications():
        while not disconnected.is_set():
            get_task = asyncio.create_task(instance.notify_queue.get())
            wait_task = asyncio.create_task(disconnected.wait())
            done, pending = await asyncio.wait(
                {get_task, wait_task},
                return_when=asyncio.FIRST_COMPLETED,
            )
            for t in pending:
                t.cancel()
            if get_task not in done:
                break
            content = get_task.result()
            if not await _safe_send({"type": "proactive", "content": content}):
                break

    user_task = asyncio.create_task(_handle_user_messages())
    notify_task = asyncio.create_task(_handle_notifications())
    try:
        done, pending = await asyncio.wait(
            [user_task, notify_task],
            return_when=asyncio.FIRST_COMPLETED,
        )
        disconnected.set()
        for t in pending:
            t.cancel()
        for t in done:
            if t.exception() and not isinstance(t.exception(), WebSocketDisconnect):
                logger.exception(
                    "WebSocket task error for partner '%s'",
                    partner_id,
                    exc_info=t.exception(),
                )
    except Exception:
        disconnected.set()
        user_task.cancel()
        notify_task.cancel()
    finally:
        # Detach from the stream only — the turn keeps running on the instance
        # so a reconnecting client can reattach and replay it.
        d = drain["task"]
        if d is not None and not d.done():
            d.cancel()
        if user_token is not None:
            try:
                reset_current_user(user_token)
            except Exception:
                pass
    logger.info("WebSocket closed for partner '%s'", partner_id)
