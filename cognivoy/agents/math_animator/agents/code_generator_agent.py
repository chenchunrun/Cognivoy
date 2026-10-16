"""Code generation and repair stages for math animator."""

from __future__ import annotations

import ast
import json
import re
from typing import Any

from cognivoy.agents.base_agent import BaseAgent
from cognivoy.core.trace import build_trace_metadata, new_call_id

from ..models import ConceptAnalysis, GeneratedCode, SceneDesign
from ..utils import build_repair_error_message, extract_json_object

_CODE_GENERATION_TOKEN_FLOOR = 16_000
_VIDEO_SCENE_PATTERN = re.compile(r"class\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*.*?Scene.*?\)\s*:")
_IMAGE_BLOCK_PATTERN = re.compile(
    r"###\s*YON_IMAGE_\d+_START\s*###\s*(.*?)\s*"
    r"###\s*YON_IMAGE_\d+_END\s*###",
    re.DOTALL | re.IGNORECASE,
)
_COMPACT_RETRY_INSTRUCTION = """

The previous generation attempt exceeded the output budget or returned invalid JSON.
Regenerate from the same requirements, but keep the complete Manim script concise:
- at most 160 non-empty Python lines for video mode;
- 4-6 teaching beats for a normal single-concept request;
- reuse mobjects instead of duplicating nearly identical code;
- omit long comments and decorative detail that does not teach the concept.
Return one valid JSON object and nothing else.
""".strip()


class CodeGeneratorAgent(BaseAgent):
    def __init__(
        self,
        api_key: str | None = None,
        base_url: str | None = None,
        api_version: str | None = None,
        language: str = "zh",
    ) -> None:
        super().__init__(
            module_name="math_animator",
            agent_name="code_generator_agent",
            api_key=api_key,
            base_url=base_url,
            api_version=api_version,
            language=language,
        )

    async def process(
        self,
        *,
        user_input: str,
        output_mode: str,
        analysis: ConceptAnalysis,
        design: SceneDesign,
        duration_target_seconds: float | None = None,
    ) -> GeneratedCode:
        """BaseAgent-compatible entrypoint for the default generation path."""
        return await self.generate(
            user_input=user_input,
            output_mode=output_mode,
            analysis=analysis,
            design=design,
            duration_target_seconds=duration_target_seconds,
        )

    async def generate(
        self,
        *,
        user_input: str,
        output_mode: str,
        analysis: ConceptAnalysis,
        design: SceneDesign,
        duration_target_seconds: float | None = None,
    ) -> GeneratedCode:
        system_prompt = self.get_prompt("generate_system")
        user_template = self.get_prompt("generate_user_template")
        if not system_prompt or not user_template:
            raise ValueError("CodeGeneratorAgent generation prompts are not configured.")

        user_prompt = user_template.format(
            user_input=user_input.strip(),
            output_mode=output_mode,
            duration_requirement=(
                f"用户明确目标时长约 {duration_target_seconds:.1f} 秒，生成代码必须围绕该时长做节奏预算。"
                if duration_target_seconds is not None
                else "用户未给出明确秒数时长，可按标准教学节奏生成。"
            ),
            analysis_json=json.dumps(analysis.model_dump(), ensure_ascii=False, indent=2),
            design_json=json.dumps(design.model_dump(), ensure_ascii=False, indent=2),
        )
        response = await self._generate_response(
            user_prompt=user_prompt,
            system_prompt=system_prompt,
            stage="code_generation",
            trace_label="Code generation",
            trace_role="generate",
        )
        try:
            return self._parse_generated_code(response, output_mode=output_mode)
        except ValueError:
            # A long Python program expands substantially once escaped inside a
            # JSON string. Some providers therefore stop at the token ceiling,
            # leaving an unusable partial object. Retry once with an explicit
            # compactness contract instead of sending the truncated payload back.
            response = await self._generate_response(
                user_prompt=user_prompt,
                system_prompt=f"{system_prompt.rstrip()}\n\n{_COMPACT_RETRY_INSTRUCTION}",
                stage="code_generation_compact_retry",
                trace_label="Compact code generation retry",
                trace_role="retry",
            )
            return self._parse_generated_code(response, output_mode=output_mode)

    async def _generate_response(
        self,
        *,
        user_prompt: str,
        system_prompt: str,
        stage: str,
        trace_label: str,
        trace_role: str,
    ) -> str:
        chunks: list[str] = []
        async for chunk in self.stream_llm(
            user_prompt=user_prompt,
            system_prompt=system_prompt,
            max_tokens=max(self.get_max_tokens(), _CODE_GENERATION_TOKEN_FLOOR),
            response_format={"type": "json_object"},
            # Structured code generation benefits from preserving the output
            # budget for the JSON/Python payload. Reasoning models can
            # otherwise consume all 16k tokens before emitting any answer.
            reasoning_effort="minimal",
            stage=stage,
            trace_meta=build_trace_metadata(
                call_id=new_call_id("math-codegen"),
                phase=stage,
                label=trace_label,
                call_kind="math_code_generation",
                trace_role=trace_role,
                trace_kind="llm_output",
            ),
        ):
            chunks.append(chunk)
        return "".join(chunks)

    @classmethod
    def _parse_generated_code(
        cls,
        response: str,
        *,
        output_mode: str,
    ) -> GeneratedCode:
        """Select the last *renderable* structured candidate from a response.

        Reasoning-capable providers sometimes mention the requested schema or
        emit a placeholder JSON object before their final answer. Selecting the
        first decodable object therefore turns ``"full code string"`` into a
        costly render/repair loop. Scan every complete object and validate the
        actual Manim contract before accepting it.
        """
        candidates = cls._json_object_candidates(response)
        for payload in reversed(candidates):
            generated = GeneratedCode.model_validate(payload)
            if cls._is_renderable_code(generated.code, output_mode=output_mode):
                return generated
        raise ValueError(
            "Math Animator code generation did not return a complete renderable script."
        )

    @staticmethod
    def _json_object_candidates(response: str) -> list[dict[str, Any]]:
        candidates: list[dict[str, Any]] = []
        seen: set[str] = set()

        try:
            primary = extract_json_object(response)
        except (json.JSONDecodeError, TypeError, ValueError):
            primary = None
        if isinstance(primary, dict):
            candidates.append(primary)
            seen.add(json.dumps(primary, ensure_ascii=False, sort_keys=True))

        decoder = json.JSONDecoder()
        raw = response or ""
        for index, char in enumerate(raw):
            if char != "{":
                continue
            try:
                payload, _end = decoder.raw_decode(raw[index:])
            except json.JSONDecodeError:
                continue
            if not isinstance(payload, dict):
                continue
            fingerprint = json.dumps(payload, ensure_ascii=False, sort_keys=True)
            if fingerprint not in seen:
                seen.add(fingerprint)
                candidates.append(payload)
        return candidates

    @staticmethod
    def _is_renderable_code(code: str, *, output_mode: str) -> bool:
        script = (code or "").strip()
        if not script:
            return False
        if output_mode == "image":
            blocks = _IMAGE_BLOCK_PATTERN.findall(script)
            return bool(blocks) and all(
                _VIDEO_SCENE_PATTERN.search(block) and _is_valid_python(block) for block in blocks
            )
        return bool(_VIDEO_SCENE_PATTERN.search(script)) and _is_valid_python(script)

    async def repair(
        self,
        *,
        user_input: str,
        output_mode: str,
        current_code: str,
        error_message: str,
        attempt: int,
        duration_target_seconds: float | None = None,
    ) -> GeneratedCode:
        system_prompt = self.get_prompt("retry_system")
        user_template = self.get_prompt("retry_user_template")
        if not system_prompt or not user_template:
            raise ValueError("CodeGeneratorAgent retry prompts are not configured.")

        user_prompt = user_template.format(
            user_input=user_input.strip(),
            output_mode=output_mode,
            attempt=attempt,
            duration_requirement=(
                f"目标时长约 {duration_target_seconds:.1f} 秒，修复后仍需保持接近该时长。"
                if duration_target_seconds is not None
                else "无明确目标时长。"
            ),
            error_message=build_repair_error_message(error_message),
            current_code=current_code,
        )
        _chunks: list[str] = []
        async for _c in self.stream_llm(
            user_prompt=user_prompt,
            system_prompt=system_prompt,
            response_format={"type": "json_object"},
            stage="code_retry",
            trace_meta=build_trace_metadata(
                call_id=new_call_id("math-retry"),
                phase="code_retry",
                label=f"Code retry #{attempt}",
                call_kind="math_code_retry",
                trace_role="repair",
                trace_kind="llm_output",
                attempt=attempt,
            ),
        ):
            _chunks.append(_c)
        response = "".join(_chunks)
        return self._parse_generated_code(response, output_mode=output_mode)


def _is_valid_python(code: str) -> bool:
    try:
        ast.parse(code)
    except (SyntaxError, ValueError, TypeError):
        return False
    return True
