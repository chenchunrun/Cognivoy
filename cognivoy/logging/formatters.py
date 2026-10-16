"""Formatters for Cognivoy's stdlib logging pipeline."""

from __future__ import annotations

from datetime import datetime, timezone
import json
import logging
from typing import Any

from .context import LOG_CONTEXT_FIELDS, current_log_context


class ContextFilter(logging.Filter):
    """Attach contextvars and explicit record fields to each LogRecord."""

    def filter(self, record: logging.LogRecord) -> bool:
        context = current_log_context()
        for key in LOG_CONTEXT_FIELDS:
            value = getattr(record, key, None)
            if value is not None:
                context[key] = value
        record.log_context = context
        return True


class JsonlFormatter(logging.Formatter):
    """One structured JSON object per line."""

    def format(self, record: logging.LogRecord) -> str:
        entry: dict[str, Any] = {
            "timestamp": datetime.fromtimestamp(record.created, timezone.utc).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
            "context": getattr(record, "log_context", {}) or {},
        }
        if record.exc_info:
            entry["exception"] = self.formatException(record.exc_info)
        # JSON escapes CR/LF and terminal controls; additionally escape Unicode
        # line separators so line-oriented log readers retain record boundaries.
        return (
            json.dumps(entry, ensure_ascii=False, default=str)
            .replace("\u2028", "\\u2028")
            .replace("\u2029", "\\u2029")
            .replace("\u0085", "\\u0085")
        )


class ConsoleFormatter(logging.Formatter):
    """Small human-readable formatter for local development."""

    def format(self, record: logging.LogRecord) -> str:
        context = getattr(record, "log_context", {}) or {}
        stage = f" @{context['stage']}" if context.get("stage") else ""
        task = f" #{context['task_id']}" if context.get("task_id") else ""
        line = f"{record.levelname:<7} {record.name}{stage}{task} - {record.getMessage()}"
        # Escape control characters at the final sink, including context fields.
        # A filename, provider response, or terminal escape must never forge a
        # second log record or rewrite the operator's terminal.
        return "".join(
            f"\\u{ord(char):04x}"
            if ord(char) < 32 or 127 <= ord(char) <= 159 or char in "\u2028\u2029"
            else char
            for char in line
        )
