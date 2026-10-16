"""Validated request config for the math animator capability."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    ValidationError,
    field_validator,
    model_validator,
)


class MathAnimatorRequestConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    output_mode: Literal["video", "image"] = "video"
    quality: Literal["low", "medium", "high"] = "medium"
    style_hint: str = Field(default="", max_length=500)
    aspect_ratio: Literal["auto", "16:9", "4:3", "1:1", "9:16"] = "auto"
    theme: Literal["auto", "light", "dark"] = "auto"
    width: int | None = Field(default=None, ge=320, le=3840)
    height: int | None = Field(default=None, ge=240, le=2160)
    duration_seconds: float | None = Field(default=None, gt=0, le=600)
    fps: int = Field(default=30, ge=1, le=120)
    show_code: bool = True
    parameters: dict[str, str | int | float | bool | None] = Field(default_factory=dict)

    @field_validator("parameters")
    @classmethod
    def validate_parameters(
        cls, value: dict[str, str | int | float | bool | None]
    ) -> dict[str, str | int | float | bool | None]:
        if len(value) > 20:
            raise ValueError("parameters supports at most 20 entries")
        for key in value:
            if not key.strip() or len(key) > 80:
                raise ValueError("parameter names must contain 1-80 visible characters")
        return value

    @model_validator(mode="after")
    def validate_dimensions(self) -> MathAnimatorRequestConfig:
        if (self.width is None) != (self.height is None):
            raise ValueError("width and height must be provided together")
        return self

    def effective_style_hint(self) -> str:
        constraints = [
            f"aspect ratio {self.aspect_ratio}",
            f"theme {self.theme}",
            f"frame rate {self.fps} fps",
        ]
        if self.width is not None and self.height is not None:
            constraints.append(f"canvas {self.width}x{self.height} pixels")
        if self.duration_seconds is not None:
            constraints.append(f"target duration {self.duration_seconds:g} seconds")
        if self.style_hint.strip():
            constraints.append(self.style_hint.strip())
        if self.parameters:
            import json

            constraints.append(
                "parameters " + json.dumps(self.parameters, ensure_ascii=False, sort_keys=True)
            )
        return "; ".join(constraints)


def validate_math_animator_request_config(
    raw_config: dict[str, Any] | None,
) -> MathAnimatorRequestConfig:
    if raw_config is None:
        return MathAnimatorRequestConfig()
    if not isinstance(raw_config, dict):
        raise ValueError("Math animator config must be an object.")
    try:
        return MathAnimatorRequestConfig.model_validate(raw_config)
    except ValidationError as exc:
        details = "; ".join(
            f"{'.'.join(str(part) for part in error['loc'])}: {error['msg']}"
            for error in exc.errors()
        )
        raise ValueError(f"Invalid math animator config: {details}") from exc


__all__ = [
    "MathAnimatorRequestConfig",
    "validate_math_animator_request_config",
]
