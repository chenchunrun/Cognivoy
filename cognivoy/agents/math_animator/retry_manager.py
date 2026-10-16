"""Retry loop for render-fix-regenerate workflow."""

from __future__ import annotations

import asyncio
from typing import Awaitable, Callable

from .models import GeneratedCode, RetryAttempt, VisualReviewResult
from .renderer import ManimRenderError, ManimRenderService


def _is_non_retriable_environment_error(message: str) -> bool:
    lowered = (message or "").lower()
    return (
        "no such file or directory: 'latex'" in lowered
        or 'no such file or directory: "latex"' in lowered
        or "latex could not be found" in lowered
    )


class CodeRetryManager:
    def __init__(
        self,
        *,
        renderer: ManimRenderService,
        repair_callback: Callable[[str, str, int], Awaitable[GeneratedCode]],
        review_callback: Callable[[str, object], Awaitable[VisualReviewResult]] | None = None,
        on_retry: Callable[[RetryAttempt], Awaitable[None]] | None = None,
        on_status: Callable[[str], Awaitable[None]] | None = None,
        max_retries: int = 4,
        render_timeout_seconds: float = 150.0,
        repair_timeout_seconds: float = 180.0,
        review_timeout_seconds: float = 120.0,
        total_timeout_seconds: float = 480.0,
        render_options: dict[str, object] | None = None,
    ) -> None:
        self.renderer = renderer
        self.repair_callback = repair_callback
        self.review_callback = review_callback
        self.on_retry = on_retry
        self.on_status = on_status
        self.max_retries = max_retries
        self.render_timeout_seconds = render_timeout_seconds
        self.repair_timeout_seconds = repair_timeout_seconds
        self.review_timeout_seconds = review_timeout_seconds
        self.total_timeout_seconds = total_timeout_seconds
        self.render_options = dict(render_options or {})

    async def render_with_retries(
        self,
        *,
        initial_code: str,
        output_mode: str,
        quality: str,
    ):
        try:
            return await asyncio.wait_for(
                self._render_with_retries(
                    initial_code=initial_code,
                    output_mode=output_mode,
                    quality=quality,
                ),
                timeout=self.total_timeout_seconds,
            )
        except asyncio.TimeoutError as timeout_exc:
            raise ManimRenderError(
                "Math animation rendering exceeded the overall "
                f"{int(self.total_timeout_seconds)}s deadline."
            ) from timeout_exc

    async def _render_with_retries(
        self,
        *,
        initial_code: str,
        output_mode: str,
        quality: str,
    ):
        code = initial_code
        retry_history: list[RetryAttempt] = []

        for attempt in range(self.max_retries + 1):
            try:
                if self.on_status is not None:
                    await self.on_status(
                        f"Starting render attempt {attempt + 1}/{self.max_retries + 1}."
                    )
                try:
                    render_result = await asyncio.wait_for(
                        self.renderer.render(
                            code=code,
                            output_mode=output_mode,
                            quality=quality,
                            **self.render_options,
                        ),
                        timeout=self.render_timeout_seconds,
                    )
                except asyncio.TimeoutError as timeout_exc:
                    raise ManimRenderError(
                        f"Render attempt {attempt + 1} timed out after "
                        f"{int(self.render_timeout_seconds)}s."
                    ) from timeout_exc
                if self.review_callback is not None:
                    if self.on_status is not None:
                        await self.on_status(
                            "Reviewing rendered visuals for overlap, readability, and framing."
                        )
                    try:
                        review_result = await asyncio.wait_for(
                            self.review_callback(code, render_result),
                            timeout=self.review_timeout_seconds,
                        )
                    except asyncio.TimeoutError as timeout_exc:
                        raise ManimRenderError(
                            f"Visual quality review timed out after {int(self.review_timeout_seconds)}s."
                        ) from timeout_exc
                    render_result.visual_review = review_result
                    if not review_result.passed:
                        if attempt >= self.max_retries:
                            if self.on_status is not None:
                                await self.on_status(
                                    "Visual review still found issues after all retries. Returning the best available result with a warning."
                                )
                            render_result.retry_attempts = len(retry_history)
                            render_result.retry_history = retry_history
                            return code, render_result
                        retry_attempt = RetryAttempt(
                            attempt=attempt + 1,
                            error=(
                                "Visual review failed: "
                                + (
                                    review_result.summary
                                    or "Detected overlap or readability issues."
                                )
                                + (
                                    f" Suggested fix: {review_result.suggested_fix}"
                                    if review_result.suggested_fix
                                    else ""
                                )
                            ),
                        )
                        retry_history.append(retry_attempt)
                        if self.on_retry is not None:
                            await self.on_retry(retry_attempt)
                        if self.on_status is not None:
                            await self.on_status(
                                f"Generating repaired code for retry #{attempt + 1} from visual review feedback."
                            )
                        try:
                            repaired = await asyncio.wait_for(
                                self.repair_callback(code, retry_attempt.error, attempt + 1),
                                timeout=self.repair_timeout_seconds,
                            )
                        except asyncio.TimeoutError as timeout_exc:
                            raise ManimRenderError(
                                f"Code repair attempt #{attempt + 1} timed out after "
                                f"{int(self.repair_timeout_seconds)}s."
                            ) from timeout_exc
                        code = repaired.code.strip() or code
                        if self.on_status is not None:
                            await self.on_status(
                                f"Retry #{attempt + 1} code generated from visual review. Re-rendering now."
                            )
                        continue
                render_result.retry_attempts = len(retry_history)
                render_result.retry_history = retry_history
                return code, render_result
            except ManimRenderError as exc:
                if _is_non_retriable_environment_error(str(exc)):
                    raise ManimRenderError(
                        "Render failed because local LaTeX is missing. "
                        "Please avoid Tex/MathTex in generated code or install a LaTeX distribution."
                    ) from exc
                if attempt >= self.max_retries:
                    raise
                retry_attempt = RetryAttempt(attempt=attempt + 1, error=str(exc))
                retry_history.append(retry_attempt)
                if self.on_retry is not None:
                    await self.on_retry(retry_attempt)
                if self.on_status is not None:
                    await self.on_status(f"Generating repaired code for retry #{attempt + 1}.")
                try:
                    repaired = await asyncio.wait_for(
                        self.repair_callback(code, str(exc), attempt + 1),
                        timeout=self.repair_timeout_seconds,
                    )
                except asyncio.TimeoutError as timeout_exc:
                    raise ManimRenderError(
                        f"Code repair attempt #{attempt + 1} timed out after "
                        f"{int(self.repair_timeout_seconds)}s."
                    ) from timeout_exc
                code = repaired.code.strip() or code
                if self.on_status is not None:
                    await self.on_status(f"Retry #{attempt + 1} code generated. Re-rendering now.")

        raise ManimRenderError("Math animator render loop exited unexpectedly.")


__all__ = ["CodeRetryManager"]
