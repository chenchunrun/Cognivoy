"""Stable application-layer facade for Cognivoy entry points."""

from __future__ import annotations

from dataclasses import dataclass, field
import json
from typing import Any, AsyncIterator

from cognivoy.runtime.registry.capability_registry import get_capability_registry
from cognivoy.services.notebook import get_notebook_manager
from cognivoy.services.session import get_session_store, get_turn_runtime_manager


class CognivoySDKError(Exception):
    """Base error with a stable machine code and structured details."""

    def __init__(self, code: str, message: str, *, details: dict[str, Any] | None = None) -> None:
        self.code = code
        self.details = details or {}
        super().__init__(message)

    def to_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "message": str(self),
            "details": dict(self.details),
        }


class CapabilityNotFoundError(CognivoySDKError, ValueError):
    """Requested capability or alias is not registered."""


class ResourceNotFoundError(CognivoySDKError, LookupError):
    """A requested SDK resource does not exist or is not visible."""


class TurnStateError(CognivoySDKError, RuntimeError):
    """A turn mutation is invalid for the turn's current lifecycle state."""


@dataclass(slots=True)
class TurnRequest:
    """Stable turn payload used by adapters such as the CLI package."""

    content: str
    capability: str = "chat"
    session_id: str | None = None
    tools: list[str] = field(default_factory=list)
    knowledge_bases: list[str] = field(default_factory=list)
    language: str = "en"
    config: dict[str, Any] = field(default_factory=dict)
    notebook_references: list[dict[str, Any]] = field(default_factory=list)
    history_references: list[str] = field(default_factory=list)
    question_notebook_references: list[int] = field(default_factory=list)
    book_references: list[dict[str, Any]] = field(default_factory=list)
    persona: str = ""
    llm_selection: dict[str, str] | None = None
    parent_message_id: int | None = None
    attachments: list[dict[str, Any]] = field(default_factory=list)
    skills: list[str] = field(default_factory=list)
    memory_references: list[str] = field(default_factory=list)

    def to_payload(self) -> dict[str, Any]:
        payload = {
            "content": self.content,
            "capability": self.capability,
            "session_id": self.session_id,
            "tools": list(self.tools),
            "knowledge_bases": list(self.knowledge_bases),
            "language": self.language,
            "config": dict(self.config),
            "notebook_references": list(self.notebook_references),
            "history_references": list(self.history_references),
            "question_notebook_references": list(self.question_notebook_references),
            "book_references": list(self.book_references),
            "persona": self.persona,
            "llm_selection": (dict(self.llm_selection) if self.llm_selection is not None else None),
            "parent_message_id": self.parent_message_id,
            "attachments": list(self.attachments),
            "skills": list(self.skills),
            "memory_references": list(self.memory_references),
        }
        from cognivoy.runtime.request_contracts import validate_start_turn_payload

        validated = validate_start_turn_payload({"type": "start_turn", **payload})
        validated.pop("type", None)
        return validated


@dataclass(slots=True)
class CapabilityAvailability:
    """Availability result for optional capabilities."""

    name: str
    available: bool
    install_hint: str = ""


class CognivoyApp:
    """Facade around runtime, session, notebook, and capability contracts."""

    def __init__(self) -> None:
        self.runtime = get_turn_runtime_manager()
        self.store = get_session_store()
        self.notebooks = get_notebook_manager()
        self.capabilities = get_capability_registry()

    def resolve_capability(self, value: str | None) -> str:
        requested = str(value or "chat").strip() or "chat"
        manifests = self.capabilities.get_manifests()
        for manifest in manifests:
            if manifest["name"] == requested:
                return requested
            aliases = {str(alias).strip() for alias in manifest.get("cli_aliases", [])}
            if requested in aliases:
                return str(manifest["name"])
        available = ", ".join(sorted(manifest["name"] for manifest in manifests))
        raise CapabilityNotFoundError(
            "capability_not_found",
            f"Unknown capability `{requested}`. Available: {available}",
            details={
                "capability": requested,
                "available": sorted(manifest["name"] for manifest in manifests),
            },
        )

    def get_capability_contracts(self) -> list[dict[str, Any]]:
        contracts = []
        for manifest in self.capabilities.get_manifests():
            contracts.append(
                {
                    **manifest,
                    "availability": self.get_capability_availability(manifest["name"]).__dict__,
                }
            )
        return contracts

    def get_capability_contract(self, value: str) -> dict[str, Any]:
        resolved = self.resolve_capability(value)
        for manifest in self.capabilities.get_manifests():
            if manifest["name"] == resolved:
                return {
                    **manifest,
                    "availability": self.get_capability_availability(resolved).__dict__,
                }
        raise CapabilityNotFoundError(
            "capability_not_found",
            f"Capability not found: {resolved}",
            details={"capability": resolved},
        )

    def get_capability_availability(self, capability: str) -> CapabilityAvailability:
        resolved = self.resolve_capability(capability)
        if resolved == "math_animator":
            from cognivoy.agents.math_animator.availability import (
                get_math_animator_readiness,
            )

            readiness = get_math_animator_readiness()
            return CapabilityAvailability(
                name=resolved,
                available=readiness.available,
                install_hint=readiness.install_hint,
            )
        return CapabilityAvailability(name=resolved, available=True)

    async def start_turn(
        self, request: TurnRequest | dict[str, Any]
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        if isinstance(request, dict):
            request = TurnRequest(**request)
        resolved_capability = self.resolve_capability(request.capability)
        session, turn = await self.runtime.start_turn(
            {
                **request.to_payload(),
                "capability": resolved_capability,
            }
        )
        await self.store.update_session_preferences(
            session["id"],
            {
                "language": request.language,
                "notebook_references": request.notebook_references,
                "history_references": request.history_references,
            },
        )
        return session, turn

    async def stream_turn(self, turn_id: str, after_seq: int = 0) -> AsyncIterator[dict[str, Any]]:
        async for item in self.runtime.subscribe_turn(turn_id, after_seq=after_seq):
            yield item

    async def cancel_turn(self, turn_id: str) -> bool:
        cancelled = await self.runtime.cancel_turn(turn_id)
        if not cancelled:
            raise TurnStateError(
                "turn_not_active",
                f"Turn is not active: {turn_id}",
                details={"turn_id": turn_id},
            )
        return True

    async def submit_user_reply(
        self,
        turn_id: str,
        text: str | None = None,
        *,
        answers: list[dict[str, Any]] | None = None,
    ) -> bool:
        """Deliver the user's reply to a turn paused on ``ask_user``."""
        accepted = await self.runtime.submit_user_reply(turn_id, text=text, answers=answers)
        if not accepted:
            raise TurnStateError(
                "turn_not_waiting_for_reply",
                f"Turn is not waiting for a user reply: {turn_id}",
                details={"turn_id": turn_id},
            )
        return True

    async def regenerate_last_turn(
        self,
        session_id: str,
        overrides: dict[str, Any] | None = None,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        return await self.runtime.regenerate_last_turn(session_id, overrides=overrides)

    async def list_sessions(self, limit: int = 50, offset: int = 0) -> list[dict[str, Any]]:
        return await self.store.list_sessions(limit=limit, offset=offset)

    async def get_session(self, session_id: str) -> dict[str, Any]:
        session = await self.store.get_session_with_messages(session_id)
        if session is None:
            raise ResourceNotFoundError(
                "session_not_found",
                f"Session not found: {session_id}",
                details={"session_id": session_id},
            )
        return session

    async def rename_session(self, session_id: str, title: str) -> bool:
        updated = await self.store.update_session_title(session_id, title)
        if not updated:
            raise ResourceNotFoundError(
                "session_not_found",
                f"Session not found: {session_id}",
                details={"session_id": session_id},
            )
        return True

    async def delete_session(self, session_id: str) -> bool:
        deleted = await self.store.delete_session(session_id)
        if not deleted:
            raise ResourceNotFoundError(
                "session_not_found",
                f"Session not found: {session_id}",
                details={"session_id": session_id},
            )
        return True

    async def get_active_turn(self, session_id: str) -> dict[str, Any] | None:
        return await self.store.get_active_turn(session_id)

    def list_notebooks(self) -> list[dict[str, Any]]:
        return self.notebooks.list_notebooks()

    def create_notebook(
        self,
        name: str,
        description: str = "",
        *,
        color: str = "#3B82F6",
        icon: str = "book",
    ) -> dict[str, Any]:
        return self.notebooks.create_notebook(
            name=name,
            description=description,
            color=color,
            icon=icon,
        )

    def get_notebook(self, notebook_id: str) -> dict[str, Any]:
        notebook = self.notebooks.get_notebook(notebook_id)
        if notebook is None:
            raise ResourceNotFoundError(
                "notebook_not_found",
                f"Notebook not found: {notebook_id}",
                details={"notebook_id": notebook_id},
            )
        return notebook

    def add_record(self, **kwargs: Any) -> dict[str, Any]:
        return self.notebooks.add_record(**kwargs)

    def update_record(self, notebook_id: str, record_id: str, **kwargs: Any) -> dict[str, Any]:
        record = self.notebooks.update_record(notebook_id, record_id, **kwargs)
        if record is None:
            raise ResourceNotFoundError(
                "record_not_found",
                f"Record not found: {record_id}",
                details={"notebook_id": notebook_id, "record_id": record_id},
            )
        return record

    def remove_record(self, notebook_id: str, record_id: str) -> bool:
        removed = self.notebooks.remove_record(notebook_id, record_id)
        if not removed:
            raise ResourceNotFoundError(
                "record_not_found",
                f"Record not found: {record_id}",
                details={"notebook_id": notebook_id, "record_id": record_id},
            )
        return True

    def get_records_by_references(
        self, notebook_references: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        return self.notebooks.get_records_by_references(notebook_references)


def dumps_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2, default=str)
