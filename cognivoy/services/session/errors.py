from __future__ import annotations


class SessionStorageUnavailableError(RuntimeError):
    """The configured durable session backend could not complete an operation."""

    def __init__(self, operation: str):
        self.operation = operation
        super().__init__(f"Session storage is unavailable during {operation}.")
