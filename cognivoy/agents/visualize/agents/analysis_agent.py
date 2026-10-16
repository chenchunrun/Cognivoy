"""Analysis stage: decide SVG vs Chart.js and produce a structured brief."""

from __future__ import annotations

from cognivoy.agents.base_agent import BaseAgent
from cognivoy.core.context import Attachment
from cognivoy.core.trace import build_trace_metadata, new_call_id

from ..analysis import VisualizationAnalysisError, parse_visualization_analysis
from ..models import VisualizationAnalysis


class AnalysisAgent(BaseAgent):
    def __init__(
        self,
        api_key: str | None = None,
        base_url: str | None = None,
        api_version: str | None = None,
        language: str = "zh",
    ) -> None:
        super().__init__(
            module_name="visualize",
            agent_name="analysis_agent",
            api_key=api_key,
            base_url=base_url,
            api_version=api_version,
            language=language,
        )

    async def process(
        self,
        *,
        user_input: str,
        history_context: str,
        render_mode: str = "auto",
        attachments: list[Attachment] | None = None,
    ) -> VisualizationAnalysis:
        # Manim modes short-circuit the LLM call entirely — MathAnimatorPipeline
        # has its own ConceptAnalysisAgent that produces the manim-specific
        # design brief. We only need a stub VisualizationAnalysis here so the
        # capability runner can dispatch on render_type.
        if render_mode in ("manim_video", "manim_image"):
            return VisualizationAnalysis(
                render_type=render_mode,  # type: ignore[arg-type]
                description="",
                data_description="",
                chart_type="",
                visual_elements=[],
                rationale=f"User selected {render_mode} explicitly.",
            )

        if render_mode in ("svg", "chartjs", "mermaid", "html"):
            system_prompt = self.get_prompt("system_fixed")
            user_template = self.get_prompt("user_template_fixed")
        elif render_mode == "figure":
            # Constrained-auto mode: LLM picks one of svg/chartjs/mermaid
            # (html is excluded). Used by the Book figure block.
            system_prompt = self.get_prompt("system_figure")
            user_template = self.get_prompt("user_template_figure")
        else:
            system_prompt = self.get_prompt("system")
            user_template = self.get_prompt("user_template")
        if not system_prompt or not user_template:
            raise ValueError("AnalysisAgent prompts are not configured.")

        format_kwargs: dict[str, str] = {
            "user_input": user_input.strip(),
            "history_context": history_context.strip() or "(none)",
        }
        if render_mode in ("svg", "chartjs", "mermaid", "html"):
            format_kwargs["render_type"] = render_mode

        user_prompt = user_template.format(**format_kwargs)

        # Blocking rather than streamed: nothing consumes the partial JSON, and
        # a reasoning model's <think> prelude never reaches the parser this way.
        trace_meta = build_trace_metadata(
            call_id=new_call_id("viz-analysis"),
            phase="analyzing",
            label="Visualization analysis",
            call_kind="viz_analysis",
            trace_role="analyze",
            trace_kind="llm_output",
        )
        raw = await self.call_llm(
            user_prompt=user_prompt,
            system_prompt=system_prompt,
            response_format={"type": "json_object"},
            stage="analyzing",
            attachments=attachments,
            trace_meta=trace_meta,
        )
        try:
            return parse_visualization_analysis(raw, render_mode=render_mode)
        except VisualizationAnalysisError as exc:
            # The transport may have completed successfully, but its response
            # did not satisfy the analysis contract. Correct the same trace
            # call without exposing provider text or validation input values.
            await self._emit_trace_event(
                {
                    **trace_meta,
                    "event": "llm_call",
                    "agent_name": self.agent_name,
                    "stage": "analyzing",
                    "state": "error",
                    "response": str(exc),
                    "reason": exc.reason,
                }
            )
            raise
