"""Math animator capability."""

from __future__ import annotations

import asyncio
import hashlib
import json
import time
from typing import Any

from cognivoy.agents._shared.capability_result import emit_capability_result
from cognivoy.core.agentic.usage import UsageTracker
from cognivoy.core.capability_protocol import BaseCapability, CapabilityManifest
from cognivoy.core.context import UnifiedContext
from cognivoy.core.stream_bus import StreamBus
from cognivoy.core.trace import build_trace_metadata, merge_trace_metadata, new_call_id
from cognivoy.i18n import StatusI18n
from cognivoy.runtime.request_contracts import get_capability_request_schema
from cognivoy.services.path_service import get_path_service

from .subtitles import create_subtitle_asset


def _checkpoint_payload(value: Any) -> Any:
    """Convert production models and lightweight doubles to JSON data."""
    if isinstance(value, dict):
        return {str(key): _checkpoint_payload(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_checkpoint_payload(item) for item in value]
    model_dump = getattr(value, "model_dump", None)
    if callable(model_dump):
        try:
            return model_dump(mode="json")
        except TypeError:
            return model_dump()
    if hasattr(value, "__dict__"):
        return {
            str(key): _checkpoint_payload(item)
            for key, item in vars(value).items()
            if not str(key).startswith("_")
        }
    return value


class MathAnimatorCapability(BaseCapability):
    manifest = CapabilityManifest(
        name="math_animator",
        description="Generate math animations or storyboard images with Manim.",
        stages=[
            "concept_analysis",
            "concept_design",
            "code_generation",
            "code_retry",
            "summary",
            "render_output",
        ],
        tools_used=[],
        cli_aliases=["animate"],
        request_schema=get_capability_request_schema("math_animator"),
        config_defaults={
            "output_mode": "video",
            "quality": "medium",
            "style_hint": "",
        },
    )

    async def run(self, context: UnifiedContext, stream: StreamBus) -> None:
        from cognivoy.agents.math_animator.availability import (
            require_math_animator_ready,
        )

        require_math_animator_ready()
        from cognivoy.agents.math_animator.pipeline import MathAnimatorPipeline
        from cognivoy.agents.math_animator.request_config import (
            validate_math_animator_request_config,
        )
        from cognivoy.services.llm.config import get_llm_config

        llm_config = get_llm_config()
        request_config = validate_math_animator_request_config(context.config_overrides)
        usage = UsageTracker(model=getattr(llm_config, "model", None))
        i18n = StatusI18n(self.name, context.language, module="math_animator")
        pipeline = MathAnimatorPipeline(
            api_key=llm_config.api_key,
            base_url=llm_config.base_url,
            api_version=llm_config.api_version,
            language=context.language,
            trace_callback=self._build_trace_bridge(stream, i18n=i18n),
            enable_visual_review=True,
        )

        timings: dict[str, float] = {}
        turn_id = str(context.metadata.get("turn_id", "") or context.session_id or "math-animator")
        history_context = str(context.metadata.get("conversation_context_text", "") or "").strip()
        from cognivoy.agents.math_animator.checkpoint import MathAnimatorCheckpointStore
        from cognivoy.agents.math_animator.models import (
            ConceptAnalysis,
            GeneratedCode,
            RenderResult,
            SceneDesign,
            SummaryPayload,
        )

        checkpoint = MathAnimatorCheckpointStore(turn_id)
        checkpoint_fingerprint = hashlib.sha256(
            json.dumps(
                {
                    "user_input": context.user_message,
                    "history_context": history_context,
                    "config": request_config.model_dump(mode="json"),
                    "attachments": [
                        {
                            "type": item.type,
                            "filename": item.filename,
                            "url": item.url,
                        }
                        for item in context.attachments
                    ],
                },
                ensure_ascii=False,
                sort_keys=True,
            ).encode("utf-8")
        ).hexdigest()
        checkpoint_meta = await asyncio.to_thread(
            checkpoint.start, fingerprint=checkpoint_fingerprint
        )
        resumed_from_checkpoint = bool(
            checkpoint_meta.get("resume_count") and checkpoint_meta.get("stages")
        )
        render_call_meta = build_trace_metadata(
            call_id=new_call_id("math-render"),
            phase="render_output",
            label="Render output",
            call_kind="math_render_output",
            trace_role="render",
            trace_kind="progress",
            output_mode=request_config.output_mode,
            quality=request_config.quality,
        )

        stage_start = time.perf_counter()
        async with stream.stage("concept_analysis", source=self.name):
            analysis = await asyncio.to_thread(
                checkpoint.load_stage, "concept_analysis", ConceptAnalysis
            )
            if analysis is None:
                analysis = await pipeline.run_analysis(
                    user_input=context.user_message,
                    history_context=history_context,
                    request_config=request_config,
                    attachments=context.attachments,
                )
                await asyncio.to_thread(checkpoint.save_stage, "concept_analysis", analysis)
            else:
                await stream.progress(
                    message=i18n.t(
                        "checkpoint_restored",
                        "Restored completed work from the durable checkpoint.",
                    ),
                    source=self.name,
                    stage="concept_analysis",
                    metadata={"resumed_from_checkpoint": True},
                )
        timings["concept_analysis"] = round(time.perf_counter() - stage_start, 3)

        stage_start = time.perf_counter()
        async with stream.stage("concept_design", source=self.name):
            design = await asyncio.to_thread(checkpoint.load_stage, "concept_design", SceneDesign)
            if design is None:
                design = await pipeline.run_design(
                    user_input=context.user_message,
                    request_config=request_config,
                    analysis=analysis,
                )
                await asyncio.to_thread(checkpoint.save_stage, "concept_design", design)
        timings["concept_design"] = round(time.perf_counter() - stage_start, 3)

        stage_start = time.perf_counter()
        async with stream.stage("code_generation", source=self.name):
            generated = await asyncio.to_thread(
                checkpoint.load_stage, "code_generation", GeneratedCode
            )
            if generated is None:
                generated = await pipeline.run_code_generation(
                    user_input=context.user_message,
                    request_config=request_config,
                    analysis=analysis,
                    design=design,
                )
                await asyncio.to_thread(checkpoint.save_stage, "code_generation", generated)
            await stream.progress(
                message=i18n.t("code_prepared", "Manim code prepared."),
                source=self.name,
                stage="code_generation",
            )
        timings["code_generation"] = round(time.perf_counter() - stage_start, 3)

        async def _on_retry(retry_attempt) -> None:
            await stream.progress(
                message=i18n.t(
                    "retry",
                    f"Retry {retry_attempt.attempt}: {retry_attempt.error}",
                    attempt=retry_attempt.attempt,
                    error=retry_attempt.error,
                ),
                source=self.name,
                stage="code_retry",
                metadata={**render_call_meta, "trace_layer": "raw"},
            )

        async def _on_render_progress(message: str, raw: bool) -> None:
            await stream.progress(
                message=message,
                source=self.name,
                stage="render_output",
                metadata={
                    **render_call_meta,
                    "trace_layer": "raw" if raw else "summary",
                },
            )

        async def _on_retry_status(message: str) -> None:
            await stream.progress(
                message=message,
                source=self.name,
                stage="code_retry",
                metadata={"trace_layer": "summary"},
            )

        stage_start = time.perf_counter()
        async with stream.stage("code_retry", source=self.name):
            await stream.progress(
                message=i18n.t(
                    "rendering",
                    f"Rendering {request_config.output_mode} with quality={request_config.quality}.",
                    mode=request_config.output_mode,
                    quality=request_config.quality,
                ),
                source=self.name,
                stage="code_retry",
                metadata={**render_call_meta, "call_state": "running"},
            )
            render_checkpoint = await asyncio.to_thread(checkpoint.load_dict, "code_retry")
            if render_checkpoint is not None:
                try:
                    final_code = str(render_checkpoint["code"])
                    render_result = RenderResult.model_validate(render_checkpoint["render_result"])
                except (KeyError, TypeError, ValueError):
                    render_checkpoint = None
            if render_checkpoint is None:
                final_code, render_result = await pipeline.run_render(
                    turn_id=turn_id,
                    user_input=context.user_message,
                    request_config=request_config,
                    initial_code=generated.code,
                    on_retry=_on_retry,
                    on_render_progress=_on_render_progress,
                    on_retry_status=_on_retry_status,
                )
                await asyncio.to_thread(
                    checkpoint.save_stage,
                    "code_retry",
                    {
                        "code": final_code,
                        "render_result": _checkpoint_payload(render_result),
                    },
                )
        timings["code_retry"] = round(time.perf_counter() - stage_start, 3)

        stage_start = time.perf_counter()
        async with stream.stage("summary", source=self.name):
            summary = await asyncio.to_thread(checkpoint.load_stage, "summary", SummaryPayload)
            if summary is None:
                summary = await pipeline.run_summary(
                    user_input=context.user_message,
                    request_config=request_config,
                    analysis=analysis,
                    design=design,
                    render_result=render_result,
                )
                await asyncio.to_thread(checkpoint.save_stage, "summary", summary)
            if summary.summary_text:
                await stream.content(summary.summary_text, source=self.name, stage="summary")
        timings["summary"] = round(time.perf_counter() - stage_start, 3)

        subtitle_asset = None
        if request_config.output_mode == "video" and render_result.artifacts:
            path_service = get_path_service()
            subtitle_asset = create_subtitle_asset(
                base_dir=path_service.get_agent_dir("math_animator") / turn_id,
                user_data_dir=path_service.user_data_dir,
                summary=summary,
                duration_seconds=request_config.duration_seconds or 0,
                language=context.language,
            )

        async with stream.stage("render_output", source=self.name):
            artifact_count = len(render_result.artifacts)
            artifact_key = "artifacts_one" if artifact_count == 1 else "artifacts_many"
            await stream.progress(
                message=i18n.t(
                    artifact_key,
                    (
                        f"Prepared {artifact_count} "
                        f"{'artifact' if artifact_count == 1 else 'artifacts'}."
                    ),
                    count=artifact_count,
                ),
                source=self.name,
                stage="render_output",
                metadata={**render_call_meta, "call_state": "complete"},
            )
        timings["render_output"] = 0.0
        visual_review = getattr(render_result, "visual_review", None)

        await emit_capability_result(
            stream,
            {
                "response": summary.summary_text,
                "summary": summary.model_dump(),
                "code": {
                    "language": "python",
                    "content": final_code,
                },
                "output_mode": request_config.output_mode,
                "artifacts": [artifact.model_dump() for artifact in render_result.artifacts],
                "timings": timings,
                "render": {
                    "quality": request_config.quality,
                    "width": request_config.width,
                    "height": request_config.height,
                    "fps": request_config.fps,
                    "duration_seconds": request_config.duration_seconds,
                    "aspect_ratio": request_config.aspect_ratio,
                    "theme": request_config.theme,
                    "show_code": request_config.show_code,
                    "retry_attempts": render_result.retry_attempts,
                    "retry_history": [item.model_dump() for item in render_result.retry_history],
                    "source_code_path": render_result.source_code_path,
                    "subtitles_url": subtitle_asset["url"] if subtitle_asset else None,
                    "subtitles_language": subtitle_asset["language"] if subtitle_asset else None,
                    "visual_review": visual_review.model_dump() if visual_review else None,
                    "resumed_from_checkpoint": resumed_from_checkpoint,
                },
                "analysis": analysis.model_dump(),
                "design": design.model_dump(),
            },
            source=self.name,
            usage=usage,
        )
        await asyncio.to_thread(checkpoint.finish, status="completed")

    def _build_trace_bridge(self, stream: StreamBus, i18n: StatusI18n | None = None):
        async def _trace_bridge(update: dict[str, Any]) -> None:
            event = str(update.get("event", "") or "")
            stage = str(update.get("phase") or update.get("stage") or "concept_analysis")
            base_metadata = {
                key: value
                for key, value in update.items()
                if key
                not in {"event", "state", "response", "chunk", "result", "tool_name", "tool_args"}
            }

            if event != "llm_call":
                return

            state = str(update.get("state", "running"))
            label = str(base_metadata.get("label", "") or stage.replace("_", " ").title())
            if state == "running":
                await stream.progress(
                    message=label,
                    source=self.name,
                    stage=stage,
                    metadata=merge_trace_metadata(
                        base_metadata,
                        {"trace_kind": "call_status", "call_state": "running"},
                    ),
                )
                return
            if state == "streaming":
                chunk = str(update.get("chunk", "") or "")
                if chunk:
                    await stream.thinking(
                        chunk,
                        source=self.name,
                        stage=stage,
                        metadata=merge_trace_metadata(
                            base_metadata,
                            {"trace_kind": "llm_chunk"},
                        ),
                    )
                return
            if state == "complete":
                was_streaming = update.get("streaming", False)
                if not was_streaming:
                    response = str(update.get("response", "") or "")
                    if response:
                        await stream.thinking(
                            response,
                            source=self.name,
                            stage=stage,
                            metadata=merge_trace_metadata(
                                base_metadata,
                                {"trace_kind": "llm_output"},
                            ),
                        )
                await stream.progress(
                    message=label,
                    source=self.name,
                    stage=stage,
                    metadata=merge_trace_metadata(
                        base_metadata,
                        {"trace_kind": "call_status", "call_state": "complete"},
                    ),
                )
                return
            if state == "error":
                fallback = (
                    i18n.t("llm_call_failed", "LLM call failed.")
                    if i18n is not None
                    else "LLM call failed."
                )
                await stream.error(
                    str(update.get("response", "") or fallback),
                    source=self.name,
                    stage=stage,
                    metadata=merge_trace_metadata(
                        base_metadata,
                        {"trace_kind": "call_status", "call_state": "error"},
                    ),
                )

        return _trace_bridge
