from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from cognivoy.agents.math_animator.pipeline import MathAnimatorPipeline
from cognivoy.agents.math_animator.request_config import (
    MathAnimatorRequestConfig,
    validate_math_animator_request_config,
)


def test_validate_math_animator_request_config_defaults() -> None:
    config = validate_math_animator_request_config(None)
    assert config.output_mode == "video"
    assert config.quality == "medium"
    assert config.style_hint == ""


def test_validate_math_animator_request_config_rejects_unknown_fields() -> None:
    with pytest.raises(ValueError, match="Invalid math animator config"):
        validate_math_animator_request_config(
            {
                "output_mode": "image",
                "quality": "high",
                "unexpected": True,
            }
        )


@pytest.mark.asyncio
async def test_explicit_duration_config_drives_code_generation() -> None:
    pipeline = object.__new__(MathAnimatorPipeline)
    pipeline.code_agent = SimpleNamespace(generate=AsyncMock(return_value="generated"))
    config = MathAnimatorRequestConfig(duration_seconds=42)

    result = await pipeline.run_code_generation(
        user_input="Animate a sine wave",
        request_config=config,
        analysis=object(),
        design=object(),
    )

    assert result == "generated"
    assert pipeline.code_agent.generate.await_args.kwargs["duration_target_seconds"] == 42
