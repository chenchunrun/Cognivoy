"""Safe extraction of user-uploaded ZIP archives.

A naive ``ZipFile.extractall`` is unsafe for untrusted uploads: it is
vulnerable to *Zip Slip* (path traversal via ``../`` or absolute member
names), *zip bombs* (tiny archives that decompress to fill the disk), and it
happily writes any file type. This module extracts members one at a time and
puts each through the same ``DocumentValidator`` gate as a direct upload:

* member names are collapsed to a sanitized basename, which defuses Zip Slip
  (no path component survives) and enforces the extension whitelist;
* per-entry uncompressed size, cumulative size, entry count and compression
  ratio are all bounded to defeat zip bombs;
* ``__MACOSX`` resource forks, dotfiles, directories and nested archives are
  skipped rather than trusted.

The extractor is deliberately decoupled from the upload router so it can be
unit-tested in isolation and reused by any ingestion path.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import logging
from pathlib import Path, PurePosixPath
import stat
import tarfile
import zipfile

from cognivoy.utils.document_validator import DocumentValidator

logger = logging.getLogger(__name__)


class ArchiveTooLargeError(ValueError):
    """Raised when an archive exceeds the configured extraction limits."""


@dataclass(frozen=True)
class ZipExtractionLimits:
    """Bounds applied while extracting an archive.

    Defaults are intentionally conservative and reuse the upload size cap so a
    zip cannot smuggle in more data than a direct upload would allow.
    """

    max_total_bytes: int = DocumentValidator.MAX_FILE_SIZE
    max_entry_bytes: int = DocumentValidator.MAX_FILE_SIZE
    max_entries: int = 1000
    max_compression_ratio: float = 200.0


@dataclass
class ZipExtractionResult:
    """Outcome of an extraction: written paths and skipped members + reasons."""

    extracted: list[Path] = field(default_factory=list)
    skipped: list[tuple[str, str]] = field(default_factory=list)


@dataclass(frozen=True)
class TreeExtractionLimits:
    """Bounds for archives whose directory hierarchy must be preserved."""

    max_total_bytes: int = 100 * 1024 * 1024
    max_entry_bytes: int = 50 * 1024 * 1024
    max_entries: int = 5000
    max_compression_ratio: float = 200.0


def _is_within(path: Path, root: Path) -> bool:
    """True if ``path`` is ``root`` or lives underneath it."""
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def safe_extract_zip(
    zip_path: str | Path,
    target_dir: str | Path,
    *,
    allowed_extensions: set[str],
    limits: ZipExtractionLimits | None = None,
) -> ZipExtractionResult:
    """Extract ``zip_path`` into ``target_dir``, flattening to safe basenames.

    Args:
        zip_path: Path to the ``.zip`` archive on disk.
        target_dir: Directory that extracted files are written into (created
            if missing). Files are written flat — subdirectories in the
            archive are dropped, so two members with the same basename collide
            and the later one is skipped as a duplicate.
        allowed_extensions: Extensions a member may have to be extracted.
            ``.zip`` is always excluded to prevent nested-archive recursion.
        limits: Optional size/count bounds; sensible defaults are used.

    Returns:
        A :class:`ZipExtractionResult` listing written paths and skipped
        members (with a reason for each skip).

    Raises:
        ArchiveTooLargeError: If the archive trips a zip-bomb guard.
        zipfile.BadZipFile: If the file is not a valid zip archive.
    """
    limits = limits or ZipExtractionLimits()
    target_dir = Path(target_dir)
    target_dir.mkdir(parents=True, exist_ok=True)
    target_root = target_dir.resolve()

    # Never extract nested archives — they are an unbounded-recursion vector.
    extract_extensions = {ext.lower() for ext in allowed_extensions if ext.lower() != ".zip"}

    result = ZipExtractionResult()
    seen_names: set[str] = set()
    total_bytes = 0

    with zipfile.ZipFile(zip_path) as archive:
        members = [info for info in archive.infolist() if not info.is_dir()]
        if len(members) > limits.max_entries:
            raise ArchiveTooLargeError(
                f"Archive has too many entries: {len(members)} > {limits.max_entries}"
            )

        for info in members:
            member = info.filename
            basename = member.replace("\\", "/").rsplit("/", 1)[-1]

            if member.startswith("__MACOSX/") or basename.startswith("."):
                result.skipped.append((member, "system file or dotfile"))
                continue

            # Zip-bomb guards evaluated against the archive's own metadata
            # *before* writing a single byte.
            if info.file_size > limits.max_entry_bytes:
                raise ArchiveTooLargeError(
                    f"Zip entry too large: {member} ({info.file_size} bytes)"
                )
            if info.compress_size > 0:
                ratio = info.file_size / info.compress_size
                if ratio > limits.max_compression_ratio:
                    raise ArchiveTooLargeError(
                        f"Suspicious compression ratio for {member}: {ratio:.0f}x"
                    )
            if total_bytes + info.file_size > limits.max_total_bytes:
                raise ArchiveTooLargeError(
                    f"Archive exceeds total size limit of {limits.max_total_bytes} bytes"
                )

            # Validate + sanitize using the same gate as direct uploads. This
            # collapses any path (defusing Zip Slip) and enforces the
            # extension whitelist and per-file size.
            try:
                safe_name = DocumentValidator.validate_upload_safety(
                    basename, info.file_size, allowed_extensions=extract_extensions
                )
            except ValueError as exc:
                result.skipped.append((member, str(exc)))
                continue

            if safe_name in seen_names:
                result.skipped.append((member, "duplicate name after flattening"))
                continue

            destination = (target_root / safe_name).resolve()
            if not _is_within(destination, target_root):  # defense in depth
                result.skipped.append((member, "path escapes target directory"))
                continue

            written = _extract_member(archive, info, destination, limits.max_entry_bytes)
            if written > info.file_size:
                # Decompressed more than the header declared → treat as a bomb.
                destination.unlink(missing_ok=True)
                raise ArchiveTooLargeError(
                    f"Zip entry decompressed past its declared size: {member}"
                )

            total_bytes += written
            seen_names.add(safe_name)
            result.extracted.append(destination)

    return result


def _extract_member(
    archive: zipfile.ZipFile,
    info: zipfile.ZipInfo,
    destination: Path,
    max_entry_bytes: int,
    chunk_size: int = 1 << 16,
) -> int:
    """Stream a single member to ``destination`` with a hard byte budget.

    Returns the number of bytes written. If the member decompresses past
    ``max_entry_bytes`` the partial output is removed and the byte count
    returned still exceeds the limit so the caller can detect the overflow.
    """
    written = 0
    with archive.open(info) as source, open(destination, "wb") as sink:
        while True:
            chunk = source.read(chunk_size)
            if not chunk:
                break
            written += len(chunk)
            if written > max_entry_bytes:
                sink.write(chunk)
                return written  # signal overflow; caller cleans up
            sink.write(chunk)
    return written


def _safe_relative_member(name: str) -> Path | None:
    """Return a normalized relative archive member, or ``None`` if unsafe."""
    normalized = name.replace("\\", "/")
    pure = PurePosixPath(normalized)
    if pure.is_absolute() or not pure.parts or ".." in pure.parts:
        return None
    if pure.parts[0].endswith(":"):
        return None
    return Path(*pure.parts)


def safe_extract_zip_tree(
    zip_path: str | Path,
    target_dir: str | Path,
    *,
    limits: TreeExtractionLimits | None = None,
) -> list[Path]:
    """Safely extract a ZIP while preserving its relative directory tree."""
    limits = limits or TreeExtractionLimits()
    target_root = Path(target_dir).resolve()
    target_root.mkdir(parents=True, exist_ok=True)
    extracted: list[Path] = []
    total = 0

    with zipfile.ZipFile(zip_path) as archive:
        members = [item for item in archive.infolist() if not item.is_dir()]
        if len(members) > limits.max_entries:
            raise ArchiveTooLargeError(
                f"Archive has too many entries: {len(members)} > {limits.max_entries}"
            )
        for info in members:
            rel = _safe_relative_member(info.filename)
            unix_mode = info.external_attr >> 16
            if rel is None or stat.S_ISLNK(unix_mode):
                logger.warning("Skipping unsafe ZIP member: %s", info.filename)
                continue
            if info.file_size > limits.max_entry_bytes:
                raise ArchiveTooLargeError(f"ZIP entry too large: {info.filename}")
            if (
                info.compress_size > 0
                and info.file_size / info.compress_size > limits.max_compression_ratio
            ):
                raise ArchiveTooLargeError(f"Suspicious compression ratio for {info.filename}")
            if total + info.file_size > limits.max_total_bytes:
                raise ArchiveTooLargeError("Archive exceeds total size limit")

            destination = (target_root / rel).resolve()
            if not _is_within(destination, target_root):
                logger.warning("Skipping ZIP member escaping root: %s", info.filename)
                continue
            destination.parent.mkdir(parents=True, exist_ok=True)
            written = _extract_member(archive, info, destination, limits.max_entry_bytes)
            if written > info.file_size:
                destination.unlink(missing_ok=True)
                raise ArchiveTooLargeError(
                    f"ZIP entry decompressed past its declared size: {info.filename}"
                )
            total += written
            extracted.append(destination)
    return extracted


def safe_extract_tar_tree(
    tar_path: str | Path,
    target_dir: str | Path,
    *,
    limits: TreeExtractionLimits | None = None,
) -> list[Path]:
    """Safely extract a TAR while rejecting links, devices and path traversal."""
    limits = limits or TreeExtractionLimits()
    target_root = Path(target_dir).resolve()
    target_root.mkdir(parents=True, exist_ok=True)
    extracted: list[Path] = []
    total = 0

    with tarfile.open(tar_path, "r:*") as archive:
        members = archive.getmembers()
        if len(members) > limits.max_entries:
            raise ArchiveTooLargeError(
                f"Archive has too many entries: {len(members)} > {limits.max_entries}"
            )
        for member in members:
            if member.isdir():
                continue
            rel = _safe_relative_member(member.name)
            if rel is None or not member.isfile():
                logger.warning("Skipping unsafe TAR member: %s", member.name)
                continue
            if member.size > limits.max_entry_bytes:
                raise ArchiveTooLargeError(f"TAR entry too large: {member.name}")
            if total + member.size > limits.max_total_bytes:
                raise ArchiveTooLargeError("Archive exceeds total size limit")

            destination = (target_root / rel).resolve()
            if not _is_within(destination, target_root):
                logger.warning("Skipping TAR member escaping root: %s", member.name)
                continue
            source = archive.extractfile(member)
            if source is None:
                continue
            destination.parent.mkdir(parents=True, exist_ok=True)
            written = 0
            with source, open(destination, "wb") as sink:
                while True:
                    chunk = source.read(1 << 16)
                    if not chunk:
                        break
                    written += len(chunk)
                    if written > limits.max_entry_bytes or total + written > limits.max_total_bytes:
                        sink.close()
                        destination.unlink(missing_ok=True)
                        raise ArchiveTooLargeError(f"TAR entry exceeded size limit: {member.name}")
                    sink.write(chunk)
            total += written
            extracted.append(destination)
    return extracted
