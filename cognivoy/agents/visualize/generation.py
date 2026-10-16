"""Bounded collection of generated code, without exposing partial artifacts."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator
from contextlib import aclosing

FIRST_OUTPUT_TIMEOUT_S = 60.0
IDLE_OUTPUT_TIMEOUT_S = 30.0
TOTAL_OUTPUT_TIMEOUT_S = 150.0
SIMPLIFIED_TOTAL_TIMEOUT_S = 90.0
MAX_GENERATED_CHARS = 128_000


class VisualizationGenerationError(RuntimeError):
    """Safe failure metadata: never retain unfinished code or provider messages."""

    def __init__(self, reason: str, partial_chars: int = 0) -> None:
        self.reason = reason
        self.partial_chars = partial_chars
        super().__init__(f"Visualization generation failed ({reason}).")


async def collect_generated_code(
    stream: AsyncGenerator[str, None], *, simplified: bool = False
) -> str:
    """Return only a complete stream, with first-output, idle and total bounds.

    Whitespace is preserved as source code, but empty/whitespace keepalives do
    not reset the idle deadline. The total deadline prevents endless productive
    streams. Cancelling the caller always propagates to the source generator.
    """
    loop = asyncio.get_running_loop()
    started_at = loop.time()
    total_timeout = SIMPLIFIED_TOTAL_TIMEOUT_S if simplified else TOTAL_OUTPUT_TIMEOUT_S
    total_deadline = started_at + total_timeout
    progress_deadline = started_at + FIRST_OUTPUT_TIMEOUT_S
    has_output = False
    partial_chars = 0
    pieces: list[str] = []

    try:
        async with aclosing(stream):
            while True:
                deadline = min(total_deadline, progress_deadline)
                reason = (
                    "total_timeout"
                    if total_deadline <= progress_deadline
                    else "idle_timeout"
                    if has_output
                    else "first_response_timeout"
                )
                if deadline <= loop.time():
                    raise VisualizationGenerationError(reason, partial_chars)
                timeout = asyncio.timeout_at(deadline)
                try:
                    async with timeout:
                        chunk = await anext(stream)
                except StopAsyncIteration:
                    break
                except TimeoutError:
                    if not timeout.expired():
                        raise VisualizationGenerationError(
                            "provider_error", partial_chars
                        ) from None
                    raise VisualizationGenerationError(reason, partial_chars) from None

                if not isinstance(chunk, str):
                    raise VisualizationGenerationError("invalid_chunk", partial_chars)
                if partial_chars + len(chunk) > MAX_GENERATED_CHARS:
                    raise VisualizationGenerationError("output_limit", partial_chars)
                if chunk:
                    pieces.append(chunk)
                    partial_chars += len(chunk)
                if chunk.strip():
                    has_output = True
                    progress_deadline = loop.time() + IDLE_OUTPUT_TIMEOUT_S
                # A buffered provider can yield without awaiting network I/O.
                # Remain cancellable even during a burst of empty keepalives.
                await asyncio.sleep(0)
        return "".join(pieces)
    except VisualizationGenerationError:
        raise
    except Exception:
        # Provider errors may contain request URLs or credentials. The caller
        # needs only a stable classification to decide whether to retry.
        raise VisualizationGenerationError("provider_error", partial_chars) from None
