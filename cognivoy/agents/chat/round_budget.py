"""Bounded, progress-aware headroom for ordinary chat, not a token window.

Only successful, distinct tool requests with non-empty results are evidence
of progress. No extra model call is needed to make this scheduling decision.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
import hashlib
import json
import time
from typing import Any

from cognivoy.core.agentic.tool_dispatch import DispatchOutcome

MAX_EXTENSION_TOKENS = 1_000_000  # cumulative usage, NOT context-window occupancy
EXTENSION_STEP = 4


@dataclass
class RoundBudget:
    initial: int
    maximum: int
    extension_deadline_s: float = 120.0
    limit: int = field(init=False)
    reason: str = ""
    started_at: float = field(default_factory=time.monotonic)
    paused_seconds: float = 0.0
    _recent: deque[bool] = field(default_factory=lambda: deque(maxlen=3))
    _seen: set[str] = field(default_factory=set)
    _seen_results: set[str] = field(default_factory=set)

    def __post_init__(self) -> None:
        self.limit = self.initial
        self.maximum = max(self.initial, self.maximum)

    def observe(self, tool_calls: list[dict[str, Any]], outcome: DispatchOutcome) -> None:
        successful = set(outcome.successful_tool_call_ids)
        nonempty = {
            message.get("tool_call_id"): str(message.get("content") or "").strip()
            for message in outcome.tool_messages
            if str(message.get("content") or "").strip()
        }
        progress = False
        for call in tool_calls:
            if call.get("id") not in successful or call.get("id") not in nonempty:
                continue
            # The loop uses the canonical flat {name, arguments} shape;
            # accepting the wire shape also keeps this helper reusable.
            function = call.get("function") or call
            arguments = function.get("arguments") or "{}"
            try:
                parsed = json.loads(arguments) if isinstance(arguments, str) else arguments
                canonical = json.dumps(parsed, sort_keys=True, ensure_ascii=False)
            except (TypeError, ValueError):
                canonical = str(arguments)
            digest = hashlib.sha256(f"{function.get('name')}:{canonical}".encode()).hexdigest()
            result_digest = hashlib.sha256(
                f"{function.get('name')}:{nonempty[call['id']]}".encode()
            ).hexdigest()
            if digest not in self._seen and result_digest not in self._seen_results:
                progress = True
            self._seen.add(digest)
            self._seen_results.add(result_digest)
        self._recent.append(progress)

    def extend(self, *, total_tokens: int) -> bool:
        if self.limit >= self.maximum:
            self.reason = "round_limit"
        elif time.monotonic() - self.started_at - self.paused_seconds >= self.extension_deadline_s:
            self.reason = "time_reserve"
        elif total_tokens >= MAX_EXTENSION_TOKENS:
            self.reason = "usage_reserve"
        elif not self._recent or not self._recent[-1] or sum(self._recent) < 2:
            self.reason = "no_recent_progress"
        else:
            self.limit = min(self.maximum, self.limit + EXTENSION_STEP)
            self.reason = "progress_extension"
            return True
        return False

    def snapshot(self, *, used: int, settlement: int, phase: str) -> dict[str, Any]:
        return {
            "initial": self.initial,
            "limit": self.limit,
            "maximum": self.maximum,
            "used": used,
            "settlement_rounds": settlement,
            "phase": phase,
            "reason": self.reason,
        }
