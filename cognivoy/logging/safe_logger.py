"""Protect application records before they reach SDK-host logging handlers."""

from __future__ import annotations

import logging


def escape_log_controls(value: str) -> str:
    """Keep untrusted text on one terminal-safe physical line."""
    return "".join(
        f"\\u{ord(char):04x}"
        if ord(char) < 32 or 127 <= ord(char) <= 159 or char in "\u2028\u2029"
        else char
        for char in value
    )


class SafeRecordFilter(logging.Filter):
    """Sanitize at the originating logger, including without app bootstrap.

    Parent logger filters do not run for propagated records, so every logger
    returned by ``get_logger`` owns this filter. No host handlers or global
    record factory are replaced. Exception metadata stays available to
    structured handlers; standard formatters use the safe cached text.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        record.msg = escape_log_controls(record.getMessage())
        record.args = ()
        record.name = escape_log_controls(record.name)
        if record.exc_info:
            record.exc_text = escape_log_controls(
                logging.Formatter().formatException(record.exc_info)
            )
        elif record.exc_text:
            record.exc_text = escape_log_controls(record.exc_text)
        if record.stack_info:
            record.stack_info = escape_log_controls(record.stack_info)
        return True


_SAFE_RECORD_FILTER = SafeRecordFilter()


def get_logger(name: str) -> logging.Logger:
    """Return a normal application logger with record-boundary protection."""
    logger = logging.getLogger(name)
    logger.addFilter(_SAFE_RECORD_FILTER)
    return logger
