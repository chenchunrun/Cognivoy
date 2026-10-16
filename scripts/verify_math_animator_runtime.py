"""Release-gate smoke test for the complete local Math Animator toolchain."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
import time

from cognivoy.agents.math_animator.availability import require_math_animator_ready
from cognivoy.agents.math_animator.renderer import ManimRenderService
from cognivoy.agents.math_animator.visual_review import VisualReviewService

SCENE = r"""
from manim import *

class FormulaSmoke(Scene):
    def construct(self):
        title = Text("Cognivoy Math Animator", font_size=34).to_edge(UP)
        formula = MathTex(r"(a+b)^2", "=", r"a^2+2ab+b^2", font_size=60)
        self.play(Write(title), Write(formula))
        self.wait(0.25)
"""


async def _verify() -> dict[str, object]:
    require_math_animator_ready()
    turn_id = f"release-gate-{int(time.time())}"
    render = await ManimRenderService(turn_id).render(
        code=SCENE,
        output_mode="video",
        quality="low",
    )
    if len(render.artifacts) != 1:
        raise RuntimeError(f"Expected one rendered artifact, got {len(render.artifacts)}")
    artifact = render.artifacts[0]
    frames = await VisualReviewService(turn_id).build_attachments(render)
    if len(frames) < 3 or any(not frame.base64 for frame in frames):
        raise RuntimeError("Visual review did not extract three non-empty frames")
    source = Path(render.source_code_path)
    output = source.parent.parent / "artifacts" / artifact.filename
    if not output.exists() or output.stat().st_size < 1_000:
        raise RuntimeError("Rendered MP4 is missing or unexpectedly small")
    return {
        "status": "passed",
        "turn_id": turn_id,
        "artifact": str(output),
        "bytes": output.stat().st_size,
        "review_frames": len(frames),
    }


if __name__ == "__main__":
    print(json.dumps(asyncio.run(_verify()), ensure_ascii=False, indent=2))
