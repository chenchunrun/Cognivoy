"""
Base exception classes for consistent error handling across the application.
Provides a standardized way to distinguish between bugs, recoverable errors,
and configuration issues.
"""

from typing import Any, Dict, Optional


class CognivoyError(Exception):
    """Base class for all application errors in Cognivoy."""

    def __init__(self, message: str, details: Optional[Dict[str, Any]] = None):
        super().__init__(message)
        self.message = message
        self.details = details or {}

    def __str__(self) -> str:
        if self.details:
            return f"{self.message} (details: {self.details})"
        return self.message


class ConfigurationError(CognivoyError):
    """Raised when there's a configuration-related error."""

    pass


class CapabilityGenerationError(CognivoyError):
    """A safe, retryable failure to produce the requested learning artifact."""

    def __init__(self, message: str, *, reason: str = "generation_failed") -> None:
        super().__init__(message)
        self.reason = reason


class ValidationError(CognivoyError):
    """Raised when input validation fails."""

    pass


class ServiceError(CognivoyError):
    """Base class for service layer errors."""

    pass


class LLMServiceError(ServiceError):
    """Base class for LLM service-related errors."""

    pass


class LLMContextError(LLMServiceError):
    """Raised when prompt exceeds model context window."""

    pass


class EnvironmentConfigError(ConfigurationError):
    """Raised when there's an environment-related configuration error."""

    pass
