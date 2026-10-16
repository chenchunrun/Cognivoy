"""Secret files must be private from their first filesystem-visible state."""

from __future__ import annotations

import os
import stat
import sys

import pytest

from cognivoy.utils.secret_files import (
    SECRET_FILE_MODE,
    atomic_write_secret_text,
    create_secret_text,
)

posix_only = pytest.mark.skipif(
    sys.platform == "win32",
    reason="POSIX permission bits are not modelled on Windows",
)


def test_atomic_write_preserves_content(tmp_path) -> None:
    target = tmp_path / "private" / "secret.txt"
    atomic_write_secret_text(target, "token-value")
    assert target.read_text(encoding="utf-8") == "token-value"


@posix_only
def test_atomic_write_replaces_a_wide_open_file_owner_only(tmp_path) -> None:
    target = tmp_path / "secret.txt"
    target.write_text("old", encoding="utf-8")
    target.chmod(0o644)

    atomic_write_secret_text(target, "new")

    assert target.read_text(encoding="utf-8") == "new"
    assert stat.S_IMODE(target.stat().st_mode) == SECRET_FILE_MODE


@posix_only
def test_secret_creation_is_not_widened_by_umask(tmp_path) -> None:
    previous = os.umask(0)
    try:
        target = tmp_path / "secret.txt"
        assert create_secret_text(target, "token-value")
        assert stat.S_IMODE(target.stat().st_mode) == SECRET_FILE_MODE
    finally:
        os.umask(previous)


def test_secret_creation_does_not_overwrite_a_concurrent_winner(tmp_path) -> None:
    target = tmp_path / "secret.txt"
    assert create_secret_text(target, "first")
    assert not create_secret_text(target, "second")
    assert target.read_text(encoding="utf-8") == "first"
