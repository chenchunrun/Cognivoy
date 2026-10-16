"""
Visualize Capability
====================

Unified visualization capability. AnalysisAgent picks one of six render
types — svg / chartjs / mermaid / html (text-emitting, three-stage pipeline)
or manim_video / manim_image (Manim subprocess pipeline). The result
envelope carries ``render_type`` as the discriminator so the frontend can
delegate to the right viewer.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from typing import Any

from cognivoy.agents._shared.capability_result import emit_capability_result
from cognivoy.agents.visualize.analysis import (
    VisualizationAnalysisError,
    parse_visualization_analysis,
)
from cognivoy.agents.visualize.generation import VisualizationGenerationError
from cognivoy.agents.visualize.interaction_contract import timeline_contract
from cognivoy.core.agentic.usage import UsageTracker
from cognivoy.core.capability_protocol import BaseCapability, CapabilityManifest
from cognivoy.core.context import UnifiedContext
from cognivoy.core.errors import CapabilityGenerationError
from cognivoy.core.stream_bus import StreamBus
from cognivoy.core.trace import merge_trace_metadata
from cognivoy.i18n import StatusI18n
from cognivoy.runtime.request_contracts import (
    VisualizeRequestConfig,
    get_capability_request_schema,
    validate_visualize_request_config,
)

logger = logging.getLogger(__name__)

# Stages exposed in the manifest. The first three cover the text-emitting
# path (svg/chartjs/mermaid/html); the rest cover the manim subprocess
# path. A given turn only streams a subset of these.
_VISUALIZE_STAGES = [
    "analyzing",
    "generating",
    "reviewing",
    "concept_analysis",
    "concept_design",
    "code_generation",
    "code_retry",
    "summary",
    "render_output",
]

_MANIM_RENDER_TYPES = {"manim_video", "manim_image"}
_ANALYSIS_TIMEOUT_SECONDS = 30
_GENERATION_TIMEOUT_SECONDS = 150
_SIMPLIFIED_TIMEOUT_SECONDS = 90
_GENERATION_TOTAL_SECONDS = 240


def _markdown_language_for_render_type(render_type: str) -> str:
    """Return the fence language consumed by the Web markdown renderers."""
    return {
        "svg": "svg",
        "chartjs": "chartjs",
        "mermaid": "mermaid",
        "html": "html",
    }.get(render_type, "text")


class VisualizeCapability(BaseCapability):
    manifest = CapabilityManifest(
        name="visualize",
        description=(
            "Generate SVG, Chart.js, Mermaid, interactive HTML, or Manim "
            "animation/storyboard visualizations."
        ),
        stages=_VISUALIZE_STAGES,
        tools_used=[],
        cli_aliases=["visualize", "viz"],
        request_schema=get_capability_request_schema("visualize"),
    )

    async def run(self, context: UnifiedContext, stream: StreamBus) -> None:
        from cognivoy.agents.visualize.models import (
            ReviewResult,
            VisualizationAnalysis,
        )
        from cognivoy.agents.visualize.pipeline import VisualizePipeline
        from cognivoy.agents.visualize.utils import (
            validate_visualization,
        )
        from cognivoy.runtime.orchestrator import _turn_timeout_seconds
        from cognivoy.services.llm.config import get_llm_config
        from cognivoy.services.session.stage_checkpoint import StageCheckpointStore

        request_config = validate_visualize_request_config(context.config_overrides)
        # Leave room for checkpoint persistence and a truthful terminal event.
        deadline = asyncio.get_running_loop().time() + max(
            0.0, _turn_timeout_seconds(context, self.name) - 5.0
        )
        render_mode = request_config.render_mode
        i18n = StatusI18n(self.name, context.language, module="visualize")

        llm_config_for_usage = get_llm_config()
        usage = UsageTracker(model=getattr(llm_config_for_usage, "model", None))

        llm_config = get_llm_config()
        history_context = str(context.metadata.get("conversation_context_text", "") or "").strip()
        turn_id = str(context.metadata.get("turn_id", "") or context.session_id or "visualize")
        checkpoint = StageCheckpointStore("visualize", turn_id)
        fingerprint = hashlib.sha256(
            json.dumps(
                {
                    "message": context.user_message,
                    "language": context.language,
                    "config": request_config.model_dump(mode="json"),
                    "history": history_context,
                    "attachments": [
                        {
                            "id": attachment.id,
                            "filename": attachment.filename,
                            "type": attachment.type,
                        }
                        for attachment in context.attachments
                    ],
                },
                ensure_ascii=False,
                sort_keys=True,
            ).encode("utf-8")
        ).hexdigest()
        checkpoint_meta = await asyncio.to_thread(checkpoint.start, fingerprint=fingerprint)
        resumed_from_checkpoint = bool(checkpoint_meta.get("resume_count"))

        pipeline = VisualizePipeline(
            api_key=llm_config.api_key,
            base_url=llm_config.base_url,
            api_version=llm_config.api_version,
            language=context.language,
            trace_callback=self._build_trace_bridge(stream, i18n=i18n),
        )

        # Stage 1: Analyze (routing decision)
        analysis_checkpoint = (
            await asyncio.to_thread(checkpoint.load_stage, "analyzing")
            if checkpoint_meta.get("status") != "completed"
            else None
        )
        analysis = None
        analysis_recovery = None
        if analysis_checkpoint is not None:
            saved_analysis = analysis_checkpoint.get("analysis") or {}
            if (
                not isinstance(saved_analysis, dict)
                or (render_mode != "auto" and saved_analysis.get("render_type") != render_mode)
            ) or saved_analysis.get("data_description") == (
                "Visualization analysis timed out; using a safe HTML fallback."
            ):
                analysis_checkpoint = None
            else:
                try:
                    analysis = parse_visualization_analysis(
                        json.dumps(saved_analysis, ensure_ascii=False), render_mode=render_mode
                    )
                except VisualizationAnalysisError:
                    analysis_checkpoint = None
                else:
                    saved_recovery = analysis_checkpoint.get("recovery")
                    if isinstance(saved_recovery, dict):
                        analysis_recovery = saved_recovery
        async with stream.stage("analyzing", source=self.name):
            await stream.thinking(
                i18n.t("analyzing", "Analyzing visualization requirements..."),
                source=self.name,
                stage="analyzing",
            )
            if analysis is None:
                try:
                    analysis = await asyncio.wait_for(
                        pipeline.run_analysis(
                            user_input=context.user_message,
                            history_context=history_context,
                            render_mode=render_mode,
                            attachments=context.attachments,
                        ),
                        timeout=min(
                            _ANALYSIS_TIMEOUT_SECONDS,
                            max(0.0, deadline - asyncio.get_running_loop().time()),
                        ),
                    )
                except asyncio.CancelledError:
                    await asyncio.to_thread(checkpoint.finish, status="cancelled")
                    raise
                except (asyncio.TimeoutError, VisualizationAnalysisError) as exc:
                    # Analysis is only a routing brief. A malformed model reply
                    # must not abort an otherwise viable graphic request. Use
                    # the original input (never the invalid reply) and still
                    # require a real, locally validated generated artifact.
                    reason = (
                        exc.reason
                        if isinstance(exc, VisualizationAnalysisError)
                        else "analysis_timeout"
                    )
                    analysis_recovery = {"reason": reason, "strategy": "original_request"}
                    analysis = VisualizationAnalysis(
                        render_type=render_mode if render_mode != "auto" else "svg",
                        description=context.user_message,
                        data_description=context.user_message,
                    )
                except Exception as exc:
                    logger.warning("Visualize analysis call failed: %s", type(exc).__name__)
                    await asyncio.to_thread(checkpoint.finish, status="failed")
                    raise CapabilityGenerationError(
                        i18n.t(
                            "analysis_failed",
                            "The visualization analysis service could not complete the request. Please retry.",
                        ),
                        reason="analysis_provider_failed",
                    ) from None
                await asyncio.to_thread(
                    checkpoint.save_stage,
                    "analyzing",
                    {"analysis": analysis.model_dump(), "recovery": analysis_recovery},
                )
            if analysis_recovery:
                is_timeout = analysis_recovery.get("reason") == "analysis_timeout"
                await stream.progress(
                    message=(
                        i18n.t(
                            "analysis_timeout_fallback",
                            "Analysis timed out; trying a simple diagram in the requested format.",
                        )
                        if is_timeout
                        else i18n.t(
                            "analysis_invalid_fallback",
                            "The analysis reply was unusable; generating a simple diagram from your original request.",
                        )
                    ),
                    source=self.name,
                    stage="analyzing",
                    metadata={"trace_kind": "warning", **analysis_recovery},
                )
            await stream.progress(
                message=i18n.t(
                    "render_type_detected",
                    f"Render type: {analysis.render_type} — {analysis.description}",
                    render_type=analysis.render_type,
                    description=analysis.description,
                ),
                source=self.name,
                stage="analyzing",
            )

        # Branch: manim path takes over completely after the analysis stage,
        # using its own multi-agent pipeline + Manim subprocess.
        if analysis.render_type in _MANIM_RENDER_TYPES:
            await self._run_manim_path(
                context=context,
                stream=stream,
                render_type=analysis.render_type,
                visualize_config=request_config,
                history_context=history_context,
                usage=usage,
                i18n=i18n,
                checkpoint=checkpoint,
                resumed_from_checkpoint=resumed_from_checkpoint,
            )
            return

        interaction_contract = timeline_contract(context.user_message, analysis)

        def validate_artifact(candidate: str) -> tuple[bool, str]:
            ok, error = validate_visualization(candidate, analysis.render_type)
            if ok and interaction_contract:
                return interaction_contract.validate(candidate)
            return ok, error

        # Stage 2: Only valid graphics are reusable checkpoints. In particular,
        # legacy timeout cards must not silently become a successful artifact.
        generation_checkpoint = (
            await asyncio.to_thread(checkpoint.load_stage, "generating")
            if checkpoint_meta.get("status") != "completed"
            else None
        )
        if generation_checkpoint is not None and (
            generation_checkpoint.get("render_type") != analysis.render_type
            or not validate_artifact(str(generation_checkpoint.get("code") or ""))[0]
        ):
            generation_checkpoint = None
        generation = {
            "status": "completed",
            "attempts": 1,
            "simplified": False,
            "requested_render_type": analysis.render_type,
        }
        async with stream.stage("generating", source=self.name):
            await stream.thinking(
                i18n.t("generating", "Generating visualization code..."),
                source=self.name,
                stage="generating",
            )
            if generation_checkpoint is not None:
                code = str(generation_checkpoint.get("code") or "")
                saved_generation = generation_checkpoint.get("generation")
                if isinstance(saved_generation, dict):
                    generation.update(saved_generation)
            else:
                generation_deadline = min(
                    deadline, asyncio.get_running_loop().time() + _GENERATION_TOTAL_SECONDS
                )
                code = ""
                failure_reason = "generation_timeout"
                validation_error = ""
                for attempt in (1, 2):
                    remaining = generation_deadline - asyncio.get_running_loop().time()
                    if remaining <= 0:
                        break
                    generation.update(attempts=attempt, simplified=attempt == 2)
                    try:
                        candidate = await asyncio.wait_for(
                            pipeline.run_code_generation(
                                user_input=context.user_message,
                                history_context=history_context,
                                analysis=analysis,
                                render_constraints=self._render_constraints_text(request_config)
                                + (
                                    f"\nPrevious attempt failed validation: {validation_error[:500]}"
                                    if validation_error
                                    else ""
                                ),
                                **({"simplified": True} if attempt == 2 else {}),
                            ),
                            timeout=min(
                                remaining,
                                _GENERATION_TIMEOUT_SECONDS
                                if attempt == 1
                                else _SIMPLIFIED_TIMEOUT_SECONDS,
                            ),
                        )
                        ok, validation_error = validate_artifact(candidate)
                        if ok:
                            code = candidate
                            break
                        failure_reason = "invalid_visualization"
                    except asyncio.CancelledError:
                        await asyncio.to_thread(checkpoint.finish, status="cancelled")
                        raise
                    except Exception as exc:
                        # Log only the exception class, not provider payloads or
                        # credentials. Retrying is bounded to one simpler draft.
                        logger.warning(
                            "Visualize generation attempt %d failed: %s",
                            attempt,
                            type(exc).__name__,
                        )
                        failure_reason = (
                            exc.reason
                            if isinstance(exc, VisualizationGenerationError)
                            else "generation_timeout"
                            if isinstance(exc, TimeoutError)
                            else "generation_failed"
                        )
                    if attempt == 1 and generation_deadline > asyncio.get_running_loop().time():
                        await stream.progress(
                            message=i18n.t(
                                "generation_retry",
                                "The first attempt did not produce a valid diagram; retrying once with a simpler layout.",
                            ),
                            source=self.name,
                            stage="generating",
                            metadata={
                                "trace_kind": "warning",
                                "reason": failure_reason,
                                "attempt": 2,
                            },
                        )
                if not code:
                    await asyncio.to_thread(checkpoint.finish, status="failed")
                    raise CapabilityGenerationError(
                        i18n.t(
                            "generation_failed",
                            "The visualization was not generated successfully. No placeholder has been marked as complete. Retry the request or use a simpler diagram.",
                        ),
                        reason=failure_reason,
                    )
                await asyncio.to_thread(
                    checkpoint.save_stage,
                    "generating",
                    {"code": code, "render_type": analysis.render_type, "generation": generation},
                )
            await stream.progress(
                message=i18n.t("code_generated", "Code generated."),
                source=self.name,
                stage="generating",
            )

        # Stage 3: Review the actual artifact, never a failure explanation.
        review_checkpoint = (
            await asyncio.to_thread(checkpoint.load_stage, "reviewing")
            if generation_checkpoint is not None
            else None
        )
        if review_checkpoint is not None and (
            review_checkpoint.get("render_type") != analysis.render_type
            or not validate_artifact(str(review_checkpoint.get("final_code") or ""))[0]
        ):
            review_checkpoint = None
        async with stream.stage("reviewing", source=self.name):
            if review_checkpoint is not None:
                final_code = str(review_checkpoint.get("final_code") or code)
                review = ReviewResult.model_validate(review_checkpoint.get("review") or {})
            else:
                final_code = code
                review = ReviewResult(
                    optimized_code=final_code,
                    changed=False,
                    review_notes="Passed local validation.",
                )
                await stream.progress(
                    message=i18n.t("validation_passed", "Passed local format checks."),
                    source=self.name,
                    stage="reviewing",
                )
                await asyncio.to_thread(
                    checkpoint.save_stage,
                    "reviewing",
                    {
                        "final_code": final_code,
                        "render_type": analysis.render_type,
                        "review": review.model_dump(mode="json"),
                    },
                )

        # Emit final content as a fenced code block for the chat area
        lang_tag = _markdown_language_for_render_type(analysis.render_type)
        content_md = f"```{lang_tag}\n{final_code}\n```"
        await stream.content(content_md, source=self.name, stage="reviewing")

        # Structured result for the frontend viewer
        await emit_capability_result(
            stream,
            {
                "response": content_md,
                "render_type": analysis.render_type,
                "code": {
                    "language": lang_tag,
                    "content": final_code,
                },
                "analysis": analysis.model_dump(),
                "analysis_recovery": analysis_recovery,
                "review": review.model_dump(),
                "render_config": request_config.model_dump(mode="json"),
                "show_code": request_config.show_code,
                "generation": generation,
                "resumed_from_checkpoint": resumed_from_checkpoint,
            },
            source=self.name,
            usage=usage,
        )
        await asyncio.to_thread(checkpoint.finish, status="completed")

    @staticmethod
    def _render_constraints_text(config: VisualizeRequestConfig) -> str:
        constraints = [
            f"aspect_ratio={config.aspect_ratio}",
            f"theme={config.theme}",
            f"fps={config.fps}",
            f"show_code={str(config.show_code).lower()}",
        ]
        if config.width is not None:
            constraints.append(f"width={config.width}px")
        if config.height is not None:
            constraints.append(f"height={config.height}px")
        if config.duration_seconds is not None:
            constraints.append(f"duration={config.duration_seconds:g}s")
        if config.parameters:
            import json

            constraints.append(
                "parameters=" + json.dumps(config.parameters, ensure_ascii=False, sort_keys=True)
            )
        if config.style_hint.strip():
            constraints.append(f"style={config.style_hint.strip()}")
        return "\n".join(f"- {item}" for item in constraints)

    async def _run_manim_path(
        self,
        *,
        context: UnifiedContext,
        stream: StreamBus,
        render_type: str,
        visualize_config: VisualizeRequestConfig,
        history_context: str,
        usage: UsageTracker | None = None,
        i18n: StatusI18n | None = None,
        checkpoint=None,
        resumed_from_checkpoint: bool = False,
    ) -> None:
        """
        Manim sub-pipeline. Mirrors ``MathAnimatorCapability.run`` but emits
        the final result with ``render_type`` as the discriminator so the
        unified frontend dispatcher can route to ``MathAnimatorViewer``.
        """
        import time

        from cognivoy.agents.math_animator.availability import (
            require_math_animator_ready,
        )

        require_math_animator_ready()

        from cognivoy.agents.math_animator.models import (
            ConceptAnalysis,
            GeneratedCode,
            RenderResult,
            SceneDesign,
            SummaryPayload,
        )
        from cognivoy.agents.math_animator.pipeline import MathAnimatorPipeline
        from cognivoy.agents.math_animator.request_config import MathAnimatorRequestConfig
        from cognivoy.core.trace import build_trace_metadata, new_call_id
        from cognivoy.services.llm.config import get_llm_config

        if i18n is None:
            i18n = StatusI18n(self.name, context.language, module="visualize")
        output_mode = "image" if render_type == "manim_image" else "video"
        request_config = MathAnimatorRequestConfig(
            output_mode=output_mode,  # type: ignore[arg-type]
            quality=visualize_config.quality,
            style_hint=visualize_config.style_hint,
            aspect_ratio=visualize_config.aspect_ratio,
            theme=visualize_config.theme,
            width=visualize_config.width,
            height=visualize_config.height,
            duration_seconds=visualize_config.duration_seconds,
            fps=visualize_config.fps,
            show_code=visualize_config.show_code,
            parameters=visualize_config.parameters,
        )

        llm_config = get_llm_config()
        pipeline = MathAnimatorPipeline(
            api_key=llm_config.api_key,
            base_url=llm_config.base_url,
            api_version=llm_config.api_version,
            language=context.language,
            trace_callback=self._build_trace_bridge(stream, i18n=i18n),
            enable_visual_review=True,
        )

        timings: dict[str, float] = {}
        turn_id = str(
            context.metadata.get("turn_id", "") or context.session_id or "visualize-manim"
        )
        render_call_meta = build_trace_metadata(
            call_id=new_call_id("manim-render"),
            phase="render_output",
            label="Render output",
            call_kind="math_render_output",
            trace_role="render",
            trace_kind="progress",
            output_mode=request_config.output_mode,
            quality=request_config.quality,
        )

        stage_start = time.perf_counter()
        saved_analysis = (
            await asyncio.to_thread(checkpoint.load_stage, "manim_concept_analysis")
            if resumed_from_checkpoint
            else None
        )
        async with stream.stage("concept_analysis", source=self.name):
            if saved_analysis is not None:
                analysis = ConceptAnalysis.model_validate(saved_analysis)
            else:
                analysis = await pipeline.run_analysis(
                    user_input=context.user_message,
                    history_context=history_context,
                    request_config=request_config,
                    attachments=context.attachments,
                )
                await asyncio.to_thread(
                    checkpoint.save_stage,
                    "manim_concept_analysis",
                    analysis.model_dump(mode="json"),
                )
        timings["concept_analysis"] = round(time.perf_counter() - stage_start, 3)

        stage_start = time.perf_counter()
        saved_design = (
            await asyncio.to_thread(checkpoint.load_stage, "manim_concept_design")
            if resumed_from_checkpoint
            else None
        )
        async with stream.stage("concept_design", source=self.name):
            if saved_design is not None:
                design = SceneDesign.model_validate(saved_design)
            else:
                design = await pipeline.run_design(
                    user_input=context.user_message,
                    request_config=request_config,
                    analysis=analysis,
                )
                await asyncio.to_thread(
                    checkpoint.save_stage,
                    "manim_concept_design",
                    design.model_dump(mode="json"),
                )
        timings["concept_design"] = round(time.perf_counter() - stage_start, 3)

        stage_start = time.perf_counter()
        saved_code = (
            await asyncio.to_thread(checkpoint.load_stage, "manim_code_generation")
            if resumed_from_checkpoint
            else None
        )
        async with stream.stage("code_generation", source=self.name):
            if saved_code is not None:
                generated = GeneratedCode.model_validate(saved_code)
            else:
                generated = await pipeline.run_code_generation(
                    user_input=context.user_message,
                    request_config=request_config,
                    analysis=analysis,
                    design=design,
                )
                await asyncio.to_thread(
                    checkpoint.save_stage,
                    "manim_code_generation",
                    generated.model_dump(mode="json"),
                )
            await stream.progress(
                message=i18n.t("manim_code_prepared", "Manim code prepared."),
                source=self.name,
                stage="code_generation",
            )
        timings["code_generation"] = round(time.perf_counter() - stage_start, 3)

        async def _on_retry(retry_attempt) -> None:
            await stream.progress(
                message=i18n.t(
                    "manim_retry",
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
        saved_render = (
            await asyncio.to_thread(checkpoint.load_stage, "manim_code_retry")
            if resumed_from_checkpoint
            else None
        )
        async with stream.stage("code_retry", source=self.name):
            await stream.progress(
                message=i18n.t(
                    "manim_rendering",
                    (
                        f"Rendering {request_config.output_mode} "
                        f"with quality={request_config.quality}."
                    ),
                    mode=request_config.output_mode,
                    quality=request_config.quality,
                ),
                source=self.name,
                stage="code_retry",
                metadata={**render_call_meta, "call_state": "running"},
            )
            if saved_render is not None:
                final_code = str(saved_render.get("code") or generated.code)
                render_result = RenderResult.model_validate(saved_render.get("render_result") or {})
            else:
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
                    "manim_code_retry",
                    {
                        "code": final_code,
                        "render_result": render_result.model_dump(mode="json"),
                    },
                )
        timings["code_retry"] = round(time.perf_counter() - stage_start, 3)

        stage_start = time.perf_counter()
        saved_summary = (
            await asyncio.to_thread(checkpoint.load_stage, "manim_summary")
            if resumed_from_checkpoint
            else None
        )
        async with stream.stage("summary", source=self.name):
            if saved_summary is not None:
                summary = SummaryPayload.model_validate(saved_summary)
            else:
                summary = await pipeline.run_summary(
                    user_input=context.user_message,
                    request_config=request_config,
                    analysis=analysis,
                    design=design,
                    render_result=render_result,
                )
                await asyncio.to_thread(
                    checkpoint.save_stage,
                    "manim_summary",
                    summary.model_dump(mode="json"),
                )
            if summary.summary_text:
                await stream.content(summary.summary_text, source=self.name, stage="summary")
        timings["summary"] = round(time.perf_counter() - stage_start, 3)

        async with stream.stage("render_output", source=self.name):
            artifact_count = len(render_result.artifacts)
            artifact_key = "manim_artifacts_one" if artifact_count == 1 else "manim_artifacts_many"
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
                "render_type": render_type,
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
        code_progress: dict[str, tuple[int, float]] = {}

        async def _trace_bridge(update: dict[str, Any]) -> None:
            event = str(update.get("event", "") or "")
            stage = str(update.get("phase") or update.get("stage") or "analyzing")
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
            is_analysis = base_metadata.get("call_kind") == "viz_analysis"
            if is_analysis and i18n is not None:
                label = i18n.t("analyzing", "Analyzing visualization requirements...")
                base_metadata["label"] = label
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
                if is_analysis:
                    return
                if base_metadata.get("call_kind") == "viz_code_generation":
                    # Show activity without flooding the reasoning trace with
                    # incomplete source code or refreshing the UI per token.
                    call_id = str(base_metadata.get("call_id", ""))
                    count, last_emit = code_progress.get(call_id, (0, 0.0))
                    count += len(chunk)
                    now = asyncio.get_running_loop().time()
                    if chunk and now - last_emit >= 1.0:
                        await stream.progress(
                            message=(
                                i18n.t(
                                    "generation_progress",
                                    "Generating diagram code...",
                                    count=count,
                                )
                                if i18n is not None
                                else "Generating diagram code..."
                            ),
                            source=self.name,
                            stage=stage,
                            metadata=merge_trace_metadata(
                                base_metadata,
                                {
                                    "trace_kind": "call_status",
                                    "call_state": "running",
                                    "received_chars": count,
                                },
                            ),
                        )
                        last_emit = now
                    code_progress[call_id] = (count, last_emit)
                    return
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
                if not was_streaming and not is_analysis:
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
                # A failed *attempt* can recover; only the terminal capability
                # exception should produce a task-level error/retry card.
                await stream.progress(
                    message=fallback,
                    source=self.name,
                    stage=stage,
                    metadata=merge_trace_metadata(
                        base_metadata,
                        {"trace_kind": "call_status", "call_state": "error"},
                    ),
                )

        return _trace_bridge
