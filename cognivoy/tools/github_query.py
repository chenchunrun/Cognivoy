"""Read-only GitHub queries via the ``gh`` CLI.

Pure-function shape on top of an injectable ``run_command`` callback so
tests don't need to mock ``asyncio.subprocess``. The tool exposes a
restricted set of operations:

* ``pr``    — view a pull request (title, state, checks, reviews)
* ``issue`` — view an issue (title, state, body, comments)
* ``run``   — list recent workflow runs for a repo
* ``repo``  — show repo metadata
* ``api``   — generic ``gh api`` GET (read-only fallback for things not
              covered by the four shortcuts above)

**Read-only by construction**: the command vocabulary below contains
*only* ``view`` / ``list`` and the ``api`` action is always invoked as a
GET. The tool does not expose mutation verbs (``close``, ``merge``,
``comment``, ``edit`` …) — the model can't get them through this
interface even by trying to be creative with ``target``.

If ``gh`` is not installed (which is the common case on most deploys)
:py:func:`run_github_query` returns a friendly ``ok=False`` outcome
instead of raising, so the LLM gets a clear "tool unavailable on this
system" message that it can relay to the user.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
from dataclasses import dataclass
import json
import logging
import shutil
from typing import Awaitable, Callable

from cognivoy.services.config.network_policy import (
    OutboundNetworkDisabledError,
    require_outbound_network,
)

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT_S = 20.0
MAX_OUTPUT_CHARS = 16_000
MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024
_PAGE_TEXT_CHARS = MAX_OUTPUT_CHARS - 512

QueryType = str  # "pr" | "issue" | "run" | "repo" | "api"

# Mapping from (query_type, target) → argv. Each is a strict *read-only*
# template — no mutation verbs.
_PR_FIELDS = "title,state,statusCheckRollup,reviews,url,author,createdAt,body"
_ISSUE_FIELDS = "title,state,body,comments,url,author,createdAt,labels"
_REPO_FIELDS = "description,defaultBranchRef,stargazerCount,forkCount,visibility,url"
_RUN_FIELDS = "name,status,conclusion,workflowName,event,createdAt,url"


@dataclass(frozen=True)
class GithubOutcome:
    """Result of one ``gh`` invocation."""

    ok: bool
    output: str = ""
    error: str = ""
    query_type: str = ""
    target: str = ""
    truncated: bool = False
    next_offset: int | None = None
    total_chars: int = 0
    output_format: str = "text"
    source_truncated: bool = False


# A "command runner" — given an argv list and a timeout, returns
# (returncode, stdout, stderr). Injectable so the tool stays unit-
# testable without spawning real subprocesses.
CommandRunner = Callable[[list[str], float], Awaitable[tuple[int, str, str]]]


async def run_github_query(
    *,
    query_type: str,
    target: str,
    offset: int = 0,
    max_chars: int = _PAGE_TEXT_CHARS,
    timeout_s: float = DEFAULT_TIMEOUT_S,
    command_runner: CommandRunner | None = None,
    gh_available: Callable[[], bool] | None = None,
) -> GithubOutcome:
    """Run one read-only ``gh`` command and return its output.

    Arguments
    ---------
    query_type : "pr" | "issue" | "run" | "repo" | "api"
        Determines which read-only template to use.
    target : str
        ``owner/repo[#number]`` or full URL for ``pr`` / ``issue``;
        ``owner/repo`` for ``run`` and ``repo``; raw ``gh api`` path
        (e.g. ``users/octocat``) for ``api``.
    offset, max_chars : int
        Character slice of the normalised readable result (not raw base64).
        Repeat the same immutable target with ``next_offset`` to continue;
        no additional fetches or cache storage are performed automatically.
    """
    q = (query_type or "").strip().lower()
    t = (target or "").strip()
    if not q:
        return GithubOutcome(ok=False, error="query_type is required.")
    if not t:
        return GithubOutcome(ok=False, query_type=q, error="target is required.")
    if t.startswith("-"):
        return GithubOutcome(ok=False, query_type=q, error="target must not be a CLI option.")
    if (
        isinstance(offset, bool)
        or not isinstance(offset, int)
        or offset < 0
        or isinstance(max_chars, bool)
        or not isinstance(max_chars, int)
        or max_chars < 1
    ):
        return GithubOutcome(ok=False, error="offset must be >= 0 and max_chars > 0 (integers).")

    try:
        network_policy = require_outbound_network("github")
    except OutboundNetworkDisabledError as exc:
        return GithubOutcome(
            ok=False,
            query_type=q,
            target=t,
            error=str(exc),
        )
    timeout_s = min(float(timeout_s), float(network_policy.timeout_seconds))

    is_available = gh_available or _default_gh_available
    if not is_available():
        return GithubOutcome(
            ok=False,
            query_type=q,
            target=t,
            error=(
                "The `gh` CLI is not installed on this server, so GitHub "
                "queries can't run here. Tell the user; they may need to "
                "ask their admin to install it."
            ),
        )

    argv = _build_argv(q, t)
    if argv is None:
        return GithubOutcome(
            ok=False,
            query_type=q,
            target=t,
            error=(f"Unsupported query_type {q!r}. Choose one of: pr, issue, run, repo, api."),
        )

    runner = command_runner or _default_command_runner
    try:
        rc, stdout, stderr = await runner(argv, timeout_s)
    except asyncio.TimeoutError:
        return GithubOutcome(
            ok=False,
            query_type=q,
            target=t,
            error=f"`gh` timed out after {timeout_s:g}s.",
        )
    except Exception as exc:  # pragma: no cover — defensive
        return GithubOutcome(
            ok=False,
            query_type=q,
            target=t,
            error=f"`gh` invocation failed: {exc}",
        )

    if rc != 0:
        err_line = (stderr or stdout).strip().splitlines()[:3]
        return GithubOutcome(
            ok=False,
            query_type=q,
            target=t,
            error=(" / ".join(err_line) or f"gh exited with code {rc}.")[:MAX_OUTPUT_CHARS],
        )

    if len(stdout.encode("utf-8")) > MAX_DOWNLOAD_BYTES:
        return GithubOutcome(ok=False, query_type=q, target=t, error=_download_limit_error())
    out, output_format, source_truncated = _readable_output(stdout.strip(), q)
    end = min(offset + min(max_chars, _PAGE_TEXT_CHARS), len(out))
    if offset > len(out):
        return GithubOutcome(
            ok=False,
            query_type=q,
            target=t,
            error=f"offset exceeds the result length ({len(out)} characters).",
        )
    truncated = end < len(out)
    page = out[offset:end]
    if offset or truncated:
        page = f"[Characters {offset}:{end} of {len(out)}; {output_format}]\n" + page
    if truncated:
        page += (
            f"\n[truncated; next_offset={end}. Call github with the same query_type/target "
            f"and offset={end} to continue. Use an immutable ref/SHA for stable pages.]"
        )
    return GithubOutcome(
        ok=True,
        output=page,
        query_type=q,
        target=t,
        truncated=truncated,
        next_offset=end if truncated else None,
        total_chars=len(out),
        output_format=output_format,
        source_truncated=source_truncated,
    )


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


def _readable_output(output: str, query_type: str) -> tuple[str, str, bool]:
    """Normalise repository API payloads before paging, never fetch extra URLs."""
    if query_type != "api":
        return output, "text", False
    try:
        payload = json.loads(output)
    except (ValueError, TypeError):
        return output, "text", False
    if isinstance(payload, dict) and payload.get("encoding") == "base64":
        encoded = payload.get("content")
        if isinstance(encoded, str):
            header = json.dumps(
                {k: payload[k] for k in ("path", "sha", "size") if k in payload},
                ensure_ascii=False,
            )
            try:
                decoded = base64.b64decode("".join(encoded.split()), validate=True)
                text = decoded.decode("utf-8")
                if any(ord(char) < 32 and char not in "\n\r\t\f" for char in text):
                    raise UnicodeError("binary content")
            except (ValueError, binascii.Error, UnicodeError):
                return (
                    header + "\n[Binary or invalid UTF-8/base64 content; not displayed.]",
                    "file",
                    False,
                )
            return header + "\n" + text, "file", False
    if isinstance(payload, dict) and payload.get("type") == "file":
        if payload.get("encoding") == "none" or not payload.get("content"):
            summary = {k: payload[k] for k in ("path", "sha", "size") if k in payload}
            return (
                json.dumps(summary, ensure_ascii=False)
                + "\n[File body omitted by GitHub. Query repos/{owner}/{repo}/git/blobs/{sha} "
                "for the body, subject to the download limit.]",
                "file",
                True,
            )
    source_truncated = False
    heading = ""
    entries = None
    if isinstance(payload, dict) and isinstance(payload.get("tree"), list):
        entries = payload["tree"]
        source_truncated = bool(payload.get("truncated"))
        heading = "Git tree entries (path, type, sha, size):\n"
        if source_truncated:
            heading += (
                "[GitHub truncated this tree upstream. Paging cannot recover omitted entries; "
                "query a specific subtree SHA without recursive=1.]\n"
            )
    elif (
        isinstance(payload, list)
        and payload
        and all(
            isinstance(item, dict) and "path" in item and "type" in item and "sha" in item
            for item in payload
        )
    ):
        entries = payload
        heading = "Directory entries (path, type, sha, size):\n"
    if entries is not None:
        rows = [
            json.dumps(
                {k: entry[k] for k in ("path", "type", "sha", "size") if k in entry},
                ensure_ascii=False,
                separators=(",", ":"),
            )
            for entry in entries
            if isinstance(entry, dict)
        ]
        return heading + "\n".join(rows), "entries", source_truncated
    return output, "text", False


def _download_limit_error() -> str:
    return "GitHub response exceeds the 8 MiB download limit; query a smaller path/subtree/page."


def _build_argv(query_type: str, target: str) -> list[str] | None:
    if query_type == "pr":
        return [
            "gh",
            "pr",
            "view",
            target,
            "--json",
            _PR_FIELDS,
        ]
    if query_type == "issue":
        return [
            "gh",
            "issue",
            "view",
            target,
            "--json",
            _ISSUE_FIELDS,
        ]
    if query_type == "run":
        return [
            "gh",
            "run",
            "list",
            "--repo",
            target,
            "--limit",
            "10",
            "--json",
            _RUN_FIELDS,
        ]
    if query_type == "repo":
        return [
            "gh",
            "repo",
            "view",
            target,
            "--json",
            _REPO_FIELDS,
        ]
    if query_type == "api":
        # ``gh api`` defaults to GET; we never pass ``--method`` so even
        # a creative ``target`` like ``-X POST repos/...`` can't sneak
        # through because the shell isn't invoked.
        return ["gh", "api", "-H", "Accept: application/vnd.github+json", target]
    return None


def _default_gh_available() -> bool:
    return shutil.which("gh") is not None


async def _default_command_runner(argv: list[str], timeout_s: float) -> tuple[int, str, str]:
    """Run ``argv`` with bounded time and combined stdout/stderr memory."""
    proc = await asyncio.create_subprocess_exec(
        *argv,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    captured = 0

    async def read_bounded(stream: asyncio.StreamReader) -> bytes:
        nonlocal captured
        chunks = []
        while chunk := await stream.read(64 * 1024):
            captured += len(chunk)
            if captured > MAX_DOWNLOAD_BYTES:
                raise ValueError(_download_limit_error())
            chunks.append(chunk)
        return b"".join(chunks)

    tasks = [
        asyncio.create_task(read_bounded(proc.stdout)),
        asyncio.create_task(read_bounded(proc.stderr)),
        asyncio.create_task(proc.wait()),
    ]
    pending = asyncio.gather(*tasks)
    try:
        stdout_b, stderr_b, _ = await asyncio.wait_for(pending, timeout=timeout_s)
    except BaseException:
        pending.cancel()
        for task in tasks:
            task.cancel()
        if proc.returncode is None:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
        await proc.wait()
        await asyncio.gather(pending, *tasks, return_exceptions=True)
        raise
    return (
        proc.returncode if proc.returncode is not None else -1,
        stdout_b.decode("utf-8", errors="replace") if stdout_b else "",
        stderr_b.decode("utf-8", errors="replace") if stderr_b else "",
    )


__all__ = [
    "DEFAULT_TIMEOUT_S",
    "GithubOutcome",
    "QueryType",
    "run_github_query",
]
