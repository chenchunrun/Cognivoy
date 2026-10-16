"""Guided Learning API Router."""

from __future__ import annotations

import html
import json

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from pydantic import ValidationError as PydanticValidationError

from cognivoy.learning import policy as learning_policy
from cognivoy.learning import prompts as learning_prompts
from cognivoy.learning.models import (
    KnowledgePoint,
    KnowledgeType,
    LearningModule,
    LearningStage,
)
from cognivoy.learning.service import LearningService, schedule_learning_plan_outreach
from cognivoy.learning.storage import LearningStore
from cognivoy.services.settings.interface_settings import get_response_language
from cognivoy.utils.json_parser import parse_json_response

router = APIRouter()


def get_learning_service() -> LearningService:
    # Create a fresh store + service per request to avoid object-level race conditions.
    store = LearningStore()
    return LearningService(store)


def _validate_book_id(book_id: str) -> None:
    """Reject empty or path-traversal-bearing book ids (shared by all endpoints)."""
    if not book_id or ".." in book_id or "/" in book_id or "\\" in book_id or ":" in book_id:
        raise HTTPException(status_code=400, detail="Invalid book_id")


def _parse_modules(body_modules: list[dict]) -> list[LearningModule]:
    """Parse raw module dicts into LearningModule objects (shared by init/replace)."""
    modules: list[LearningModule] = []
    for i, m in enumerate(body_modules):
        kps_data = m.get("knowledge_points", [])
        try:
            kps = [KnowledgePoint(**kp) for kp in kps_data]
        except PydanticValidationError as exc:
            raise HTTPException(
                status_code=422,
                detail=f"Invalid knowledge_point data in modules[{i}]: {exc.errors()}",
            ) from exc
        # Remove knowledge_points from m to avoid duplicate argument to LearningModule.
        m_clean = {k: v for k, v in m.items() if k != "knowledge_points"}
        try:
            modules.append(LearningModule(knowledge_points=kps, **m_clean))
        except PydanticValidationError as exc:
            raise HTTPException(
                status_code=422,
                detail=f"Invalid module data in modules[{i}]: {exc.errors()}",
            ) from exc
    return modules


def _validate_runnable_modules(modules: list[LearningModule], *, status_code: int = 400) -> None:
    if not modules:
        raise HTTPException(
            status_code=status_code, detail="At least one learning module is required"
        )
    module_ids = [module.id for module in modules]
    if len(module_ids) != len(set(module_ids)):
        raise HTTPException(status_code=status_code, detail="Module ids must be unique")
    known = set(module_ids)
    for mod in modules:
        if not mod.knowledge_points:
            raise HTTPException(
                status_code=status_code,
                detail=f"Module {mod.id!r} must contain at least one knowledge point",
            )
        for dependency in mod.depends_on:
            if dependency == mod.id:
                raise HTTPException(
                    status_code=status_code,
                    detail=f"Module {mod.id!r} cannot depend on itself",
                )
            if dependency not in known:
                raise HTTPException(
                    status_code=status_code,
                    detail=f"Unknown module dependency {dependency!r} for {mod.id!r}",
                )

    graph = {module.id: set(module.depends_on) for module in modules}
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(module_id: str) -> None:
        if module_id in visiting:
            raise HTTPException(
                status_code=status_code,
                detail="Module dependency cycle detected",
            )
        if module_id in visited:
            return
        visiting.add(module_id)
        for dependency in graph[module_id]:
            visit(dependency)
        visiting.remove(module_id)
        visited.add(module_id)

    for module_id in graph:
        visit(module_id)


async def _cancel_active_learning_turn(book_id: str) -> None:
    from cognivoy.services.session import get_turn_runtime_manager

    runtime = get_turn_runtime_manager()
    active_turn = await runtime.store.get_active_turn(book_id)
    if active_turn:
        await runtime.cancel_turn(active_turn["id"])


# ── Request models ───────────────────────────────────────────────────────────


class InitModulesRequest(BaseModel):
    modules: list[dict]  # list of LearningModule-compatible dicts


class ChapterImport(BaseModel):
    title: str
    knowledge_points: list[str] = []


class ImportFromBookRequest(BaseModel):
    chapters: list[ChapterImport]


class RedoProgressRequest(BaseModel):
    reason: str = Field(default="", max_length=500)


# ── Endpoints ────────────────────────────────────────────────────────────────


@router.get("/progress")
async def list_all_progress():
    service = get_learning_service()
    return service.list_progress()


@router.get("/progress/{book_id}")
async def get_progress(book_id: str):
    _validate_book_id(book_id)
    service = get_learning_service()
    progress = service.get_or_create(book_id)
    return progress.model_dump()


@router.get("/progress/{book_id}/map")
async def get_progress_map(book_id: str):
    """The dashboard view of a path: the gate-decided next step plus a map of
    every objective's status (new / learning / mastered). The per-type gate
    lives in ``learning.policy`` so the dashboard and the tutor agree."""
    _validate_book_id(book_id)
    service = get_learning_service()
    progress = service.get_or_create(book_id)
    return {
        "book_id": book_id,
        "next": learning_policy.next_objective(progress).to_dict(),
        "map": learning_policy.map_summary(progress),
    }


@router.post("/progress/{book_id}/init-modules")
async def init_modules(book_id: str, body: InitModulesRequest):
    _validate_book_id(book_id)
    modules = _parse_modules(body.modules)
    _validate_runnable_modules(modules)
    await _cancel_active_learning_turn(book_id)
    service = get_learning_service()
    progress = service.get_or_create(book_id)
    service.init_modules(progress, modules)
    progress.current_module_id = modules[0].id
    progress.current_kp_index = 0
    service.save(progress)
    schedule_learning_plan_outreach(progress)
    return {"status": "ok", "module_count": len(modules)}


@router.post("/progress/{book_id}/import-from-book")
async def import_from_book(book_id: str, body: ImportFromBookRequest):
    _validate_book_id(book_id)
    modules = []
    for i, ch in enumerate(body.chapters):
        kps = [
            KnowledgePoint(
                id=f"{book_id}_ch{i}_kp{j}",
                name=kp_name,
                type=KnowledgeType("concept"),
                module_id=f"{book_id}_ch{i}",
            )
            for j, kp_name in enumerate(ch.knowledge_points)
        ]
        modules.append(
            LearningModule(
                id=f"{book_id}_ch{i}",
                name=ch.title or f"Chapter {i + 1}",
                order=i,
                pass_threshold=0.7,
                depends_on=[f"{book_id}_ch{i - 1}"] if i > 0 else [],
                knowledge_points=kps,
            )
        )
    _validate_runnable_modules(modules)
    await _cancel_active_learning_turn(book_id)
    service = get_learning_service()
    progress = service.get_or_create(book_id)
    service.init_modules(progress, modules)
    progress.current_module_id = modules[0].id
    progress.current_kp_index = 0
    service.save(progress)
    schedule_learning_plan_outreach(progress)
    return {"status": "ok", "module_count": len(modules)}


@router.delete("/progress/{book_id}")
async def delete_progress(book_id: str):
    _validate_book_id(book_id)
    store = LearningStore()
    if not store.exists(book_id):
        raise HTTPException(status_code=404, detail="Progress not found")
    store.delete(book_id)
    return {"status": "ok"}


@router.post("/progress/{book_id}/redo")
async def redo_progress(book_id: str, body: RedoProgressRequest | None = None):
    _validate_book_id(book_id)
    await _cancel_active_learning_turn(book_id)
    store = LearningStore()
    progress = store.load(book_id)
    if progress is None:
        raise HTTPException(status_code=404, detail="Progress not found")
    replacement = progress.model_copy(deep=True)
    replacement.current_stage = LearningStage.DIAGNOSTIC
    replacement.mastery_levels = {}
    replacement.qualitative_mastery = {}
    replacement.quiz_attempts = []
    replacement.error_records = []
    replacement.repetition_states = {}
    replacement.review_queue = []
    replacement.pending_question = None
    replacement.feynman_retries = {}
    replacement.feynman_explanations = {}
    replacement.stage_failure_counts = {}
    replacement.stage_failure_notes = {}
    replacement.diagnostic = None
    replacement.current_kp_index = 0
    replacement.current_module_id = replacement.modules[0].id if replacement.modules else ""
    summary = store.archive_and_replace_for_redo(
        progress,
        replacement,
        reason=body.reason if body else "",
    )
    return {"status": "ok", "audit_id": summary["id"], "archive": summary}


@router.get("/progress/{book_id}/redo-history")
async def list_redo_history(book_id: str):
    _validate_book_id(book_id)
    store = LearningStore()
    if not store.exists(book_id):
        raise HTTPException(status_code=404, detail="Progress not found")
    return {"book_id": book_id, "items": store.list_redo_history(book_id)}


@router.post("/progress/{book_id}/redo/{audit_id}/restore")
async def restore_redo_history(book_id: str, audit_id: str):
    _validate_book_id(book_id)
    await _cancel_active_learning_turn(book_id)
    store = LearningStore()
    try:
        restored = store.restore_redo_archive(book_id, audit_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="Redo archive not found") from exc
    if restored is None:
        raise HTTPException(status_code=404, detail="Redo archive not found")
    return {
        "status": "ok",
        "audit_id": audit_id,
        "progress": restored.model_dump(mode="json"),
    }


class NotebookRecordInput(BaseModel):
    id: str
    type: str = "note"
    title: str = ""
    output: str = ""


class GenerateFromNotebookRequest(BaseModel):
    notebook_id: str
    records: list[NotebookRecordInput]


@router.post("/progress/{book_id}/generate-from-notebook")
async def generate_from_notebook(book_id: str, body: GenerateFromNotebookRequest):
    _validate_book_id(book_id)
    if not body.records:
        raise HTTPException(status_code=400, detail="No records provided")

    records_data = [
        {
            "type": html.escape(r.type[:50], quote=False),
            "title": html.escape(r.title[:200], quote=False),
            "output": html.escape(r.output[:500], quote=False),
        }
        for r in body.records[:20]
    ]
    records_json = json.dumps(records_data, ensure_ascii=False)
    from cognivoy.services.llm import complete

    language = get_response_language()
    system_prompt, prompt = learning_prompts.notebook_generation_prompts(language, records_json)
    response = await complete(prompt=prompt, system_prompt=system_prompt)
    # LLMs commonly fence/slightly-malform JSON; use the shared fence-stripping
    # repair parser instead of bare json.loads so the common case isn't a 502.
    data = parse_json_response(response, fallback=None)
    if not isinstance(data, dict):
        raise HTTPException(status_code=502, detail="LLM returned invalid JSON")

    modules_raw = data.get("modules", [])
    if not isinstance(modules_raw, list):
        raise HTTPException(
            status_code=502, detail="LLM returned invalid structure: modules is not a list"
        )
    _ALLOWED_KP_TYPES = {"memory", "concept", "procedure", "design"}
    modules = []
    for i, m in enumerate(modules_raw):
        if not isinstance(m, dict) or "name" not in m:
            continue
        fallback_name = learning_prompts.default_module_name(language, i + 1)
        module_name = str(m.get("name") or fallback_name).strip()[:200] or fallback_name
        kps = []
        for j, kp in enumerate(m.get("knowledge_points", [])):
            if not isinstance(kp, dict) or "name" not in kp:
                continue
            kp_name = str(kp["name"]).strip()[:200]
            if len(kp_name) < 2:
                continue
            kp_type = str(kp.get("type", "concept")).strip()
            if kp_type not in _ALLOWED_KP_TYPES:
                kp_type = "concept"
            kps.append(
                KnowledgePoint(
                    id=f"{book_id}_nb{i}_kp{j}",
                    name=kp_name,
                    type=KnowledgeType(kp_type),
                    module_id=f"{book_id}_nb{i}",
                )
            )
        modules.append(
            LearningModule(
                id=f"{book_id}_nb{i}",
                name=module_name,
                order=i,
                pass_threshold=0.7,
                depends_on=[f"{book_id}_nb{i - 1}"] if i > 0 else [],
                knowledge_points=kps,
            )
        )
    _validate_runnable_modules(modules, status_code=502)
    await _cancel_active_learning_turn(book_id)
    service = get_learning_service()
    progress = service.get_or_create(book_id)
    service.init_modules(progress, modules)
    progress.current_module_id = modules[0].id
    progress.current_kp_index = 0
    service.save(progress)
    return {
        "status": "ok",
        "module_count": len(modules),
        "modules": [m.model_dump() for m in modules],
    }
