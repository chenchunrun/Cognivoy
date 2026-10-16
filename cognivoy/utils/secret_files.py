"""Atomic, owner-only writes for files that contain secrets."""

from __future__ import annotations

from contextlib import suppress
import os
from pathlib import Path
import stat
import tempfile

SECRET_FILE_MODE = stat.S_IRUSR | stat.S_IWUSR
SECRET_DIR_MODE = stat.S_IRWXU


def _prepare_parent(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with suppress(OSError):
        path.parent.chmod(SECRET_DIR_MODE)


def atomic_write_secret_text(path: Path, text: str) -> None:
    """Atomically replace *path* without ever creating a broad-mode file."""
    path = Path(path)
    _prepare_parent(path)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
        text=True,
    )
    temporary_path = Path(temporary_name)
    try:
        os.fchmod(descriptor, SECRET_FILE_MODE)
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            descriptor = -1
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, path)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        temporary_path.unlink(missing_ok=True)


def create_secret_text(path: Path, text: str) -> bool:
    """Create *path* owner-only, returning false if another writer won."""
    path = Path(path)
    _prepare_parent(path)
    try:
        descriptor = os.open(
            path,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL,
            SECRET_FILE_MODE,
        )
    except FileExistsError:
        return False
    try:
        try:
            handle = os.fdopen(descriptor, "w", encoding="utf-8", newline="\n")
        except BaseException:
            os.close(descriptor)
            raise
        with handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    return True


__all__ = [
    "SECRET_DIR_MODE",
    "SECRET_FILE_MODE",
    "atomic_write_secret_text",
    "create_secret_text",
]
