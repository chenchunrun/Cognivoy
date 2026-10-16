"""Small, non-executing checks for explicitly requested HTML time sliders.

This checks the range contract, not arbitrary JavaScript semantics. Browser
acceptance must still verify that moving the slider changes the shown states.
No sample-specific state names, dates, or generated variable names are assumed.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from html.parser import HTMLParser
import re

from .models import VisualizationAnalysis

_DURATION = re.compile(
    r"(?<![0-9A-Za-z_.])(?P<value>\d{1,12}(?:\.\d{1,6})?)\s*"
    r"(?P<unit>milliseconds?|seconds?|minutes?|hours?|days?|weeks?|"
    r"毫秒|秒钟|秒|分钟|小时|天|周)(?![a-z])",
    re.IGNORECASE,
)
_UNITS = {
    "millisecond": Decimal("0.001"),
    "毫秒": Decimal("0.001"),
    "second": Decimal(1),
    "秒钟": Decimal(1),
    "秒": Decimal(1),
    "minute": Decimal(60),
    "分钟": Decimal(60),
    "hour": Decimal(3600),
    "小时": Decimal(3600),
    "day": Decimal(86400),
    "天": Decimal(86400),
    "week": Decimal(604800),
    "周": Decimal(604800),
}
# HTML's authoring syntax is narrower than Decimal (no underscores or Unicode
# digits). Require it so browser defaults cannot silently shorten the range.
_HTML_NUMBER = re.compile(r"-?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?")


def _html_decimal(value: str) -> Decimal:
    if len(value) > 64 or not _HTML_NUMBER.fullmatch(value):
        raise InvalidOperation
    return Decimal(value)


@dataclass(frozen=True)
class TimelineContract:
    milestones_seconds: tuple[Decimal, ...]

    def prompt(self) -> str:
        maximum = max(self.milestones_seconds)
        milestones = ", ".join(format(value, "f") for value in self.milestones_seconds)
        return (
            "Required time-slider contract (also mandatory on simplified retry):\n"
            f"- Required duration milestones in seconds: {milestones}.\n"  # nosec B608 -- prompt prose, never executed as SQL
            f"- The simulation must reach at least {maximum:f} seconds; do not stop "
            "at an earlier cycle's first activation.\n"
            '- Include an enabled, visible <input type="range" '
            'data-cognivoy-timeline="seconds" min="0" '
            f'max="{maximum:f}" step="any"> (a larger max is allowed). '
            "Its numeric value is elapsed seconds, not a normalized 0-1000 scale. "
            "Bind input events to the same update function used by state cards, "
            "counters, and graphics. Do not clamp or remap it to a shorter interval.\n"
            "- Add labeled milestone buttons for precise navigation across widely "
            "different time scales. Clicking must set this input and run the same "
            "update function. Manual input pauses autoplay until explicitly resumed.\n"
            "- Check before/at/after each transition and the maximum. Protected "
            "items must retain their requested immunity. Keep these behaviors "
            "even if decorative animation is removed."
        )

    def validate(self, code: str) -> tuple[bool, str]:
        parser = _TimelineInputs()
        parser.feed(code)
        for attrs in parser.inputs if len(parser.inputs) == 1 else []:
            try:
                minimum = _html_decimal(attrs.get("min") or "0")
                maximum = _html_decimal(attrs.get("max") or "100")
                step_raw = attrs.get("step") or "1"
                step = None if step_raw == "any" else _html_decimal(step_raw)
            except InvalidOperation:
                continue
            if not minimum.is_finite() or not maximum.is_finite():
                continue
            if minimum != 0 or not max(self.milestones_seconds) <= maximum <= Decimal("1e12"):
                continue
            if step is not None and (
                not step.is_finite()
                or not Decimal("0.000001") <= step <= Decimal("1e12")
                or any((value - minimum) % step != 0 for value in self.milestones_seconds)
            ):
                continue
            return True, ""
        return False, (
            "The required time slider is missing, disabled, or cannot reach all "
            f"duration milestones through {max(self.milestones_seconds):f} seconds. "
            "Use the visible native range input and actual-seconds contract; "
            "do not replace required state transitions with labels."
        )


class _TimelineInputs(HTMLParser):
    _VOID = frozenset(
        "area base br col embed hr img input link meta param source track wbr".split()
    )

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.inputs: list[dict[str, str | None]] = []
        self.ancestors: list[tuple[str, bool]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        blocked = (
            tag in {"template", "noscript", "head", "textarea", "iframe", "xmp"}
            or "hidden" in attributes
            or "inert" in attributes
            or (tag == "fieldset" and "disabled" in attributes)
        )
        if (
            tag == "input"
            and not blocked
            and not any(inert for _, inert in self.ancestors)
            and len(attributes) == len(attrs)
            and (attributes.get("type") or "").lower() == "range"
            and attributes.get("data-cognivoy-timeline") == "seconds"
            and "disabled" not in attributes
            and "hidden" not in attributes
        ):
            self.inputs.append(attributes)
        if tag not in self._VOID:
            self.ancestors.append((tag, blocked))

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        # HTML ignores the self-closing slash on non-void HTML elements. Do
        # not let <div hidden/> falsely release its descendants from hiding.
        self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag: str) -> None:
        for index in range(len(self.ancestors) - 1, -1, -1):
            if self.ancestors[index][0] == tag:
                del self.ancestors[index:]
                break


def timeline_contract(user_input: str, analysis: VisualizationAnalysis) -> TimelineContract | None:
    """Only opt explicit relative-time sliders into a testable seconds control.

    Static diagrams and timelines of calendar dates are deliberately unchanged.
    Month/year conversion is not guessed. Durations come only from the current
    request, not invented analysis values, old conversation history or code.
    """
    if analysis.render_type != "html":
        return None
    if not re.search(
        r"时间轴|时间滑块|timeline|time slider", user_input, re.IGNORECASE
    ) or not re.search(r"滑块|拖动|拖拽|slider|scrub", user_input, re.IGNORECASE):
        return None
    durations = set()
    for match in _DURATION.finditer(user_input):
        unit = match["unit"].lower().removesuffix("s")
        duration = Decimal(match["value"]) * _UNITS[unit]
        if 0 < duration <= Decimal("1e12"):
            durations.add(duration)
    return TimelineContract(tuple(sorted(durations))) if durations else None
