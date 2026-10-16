"""Cognivoy package bootstrap and compatibility helpers."""

from __future__ import annotations

import os

_LEGACY_ENV_PREFIXES = ("OPENMENTOR_", "DEEPTUTOR_")
_ENV_PREFIX = "COGNIVOY_"


def _migrate_legacy_environment() -> tuple[str, ...]:
    """Copy legacy environment values when their Cognivoy key is absent.

    The compatibility bridge is intentionally one-way: an explicitly set
    ``COGNIVOY_*`` value always wins. The old prefix can be removed after the
    documented one-release migration window.
    """

    migrated: list[str] = []
    environment = tuple(os.environ.items())
    for legacy_prefix in _LEGACY_ENV_PREFIXES:
        for key, value in environment:
            if not key.startswith(legacy_prefix):
                continue
            replacement = f"{_ENV_PREFIX}{key.removeprefix(legacy_prefix)}"
            if replacement not in os.environ:
                os.environ[replacement] = value
                migrated.append(replacement)
    return tuple(migrated)


_migrate_legacy_environment()
