"""Unit tests for the ``github_query`` tool's pure logic.

We never spawn ``gh`` for real — every test injects its own
``command_runner`` so we can pin returncode / stdout / stderr.
"""

from __future__ import annotations

import asyncio
import base64
import json
import sys
from typing import Any

import pytest

from cognivoy.services.config.network_policy import (
    OutboundNetworkDisabledError,
    OutboundNetworkPolicy,
)
from cognivoy.tools.github_query import (
    MAX_OUTPUT_CHARS,
    _default_command_runner,
    run_github_query,
)


@pytest.fixture(autouse=True)
def isolated_network_policy(monkeypatch):
    monkeypatch.setattr(
        "cognivoy.tools.github_query.require_outbound_network",
        lambda _feature: OutboundNetworkPolicy(True, 20, None),
    )


@pytest.mark.asyncio
async def test_global_network_policy_blocks_gh_before_process_spawn(monkeypatch) -> None:
    monkeypatch.setattr(
        "cognivoy.tools.github_query.require_outbound_network",
        lambda _feature: (_ for _ in ()).throw(OutboundNetworkDisabledError("network disabled")),
    )
    called = False

    async def runner(_argv, _timeout):
        nonlocal called
        called = True
        return 0, "", ""

    outcome = await run_github_query(
        query_type="repo",
        target="owner/repo",
        gh_available=lambda: True,
        command_runner=runner,
    )
    assert outcome.ok is False
    assert "network disabled" in outcome.error
    assert called is False


@pytest.mark.asyncio
async def test_global_network_timeout_caps_gh_timeout(monkeypatch) -> None:
    monkeypatch.setattr(
        "cognivoy.tools.github_query.require_outbound_network",
        lambda _feature: OutboundNetworkPolicy(True, 7, None),
    )
    observed: list[float] = []

    async def runner(_argv, timeout):
        observed.append(timeout)
        return 0, "{}", ""

    outcome = await run_github_query(
        query_type="repo",
        target="owner/repo",
        timeout_s=30,
        gh_available=lambda: True,
        command_runner=runner,
    )
    assert outcome.ok is True
    assert observed == [7]


def _runner(
    *,
    returncode: int = 0,
    stdout: str = "",
    stderr: str = "",
    record: list[list[str]] | None = None,
):
    async def _run(argv, timeout_s):
        if record is not None:
            record.append(list(argv))
        return returncode, stdout, stderr

    return _run


# ---------------------------------------------------------------------------
# Argument validation
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_rejects_missing_query_type() -> None:
    outcome = await run_github_query(
        query_type="",
        target="owner/repo",
        gh_available=lambda: True,
        command_runner=_runner(),
    )
    assert outcome.ok is False
    assert "query_type" in outcome.error


@pytest.mark.asyncio
async def test_rejects_missing_target() -> None:
    outcome = await run_github_query(
        query_type="pr",
        target="",
        gh_available=lambda: True,
        command_runner=_runner(),
    )
    assert outcome.ok is False
    assert "target" in outcome.error


@pytest.mark.asyncio
async def test_rejects_unsupported_query_type() -> None:
    outcome = await run_github_query(
        query_type="merge",  # explicitly write-flavoured, not in the whitelist
        target="owner/repo#1",
        gh_available=lambda: True,
        command_runner=_runner(),
    )
    assert outcome.ok is False
    assert "Unsupported query_type" in outcome.error


# ---------------------------------------------------------------------------
# gh CLI availability
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_reports_gh_missing_gracefully() -> None:
    outcome = await run_github_query(
        query_type="pr",
        target="owner/repo#1",
        gh_available=lambda: False,
        command_runner=_runner(),  # should never be invoked
    )
    assert outcome.ok is False
    assert "`gh`" in outcome.error or "gh" in outcome.error.lower()


# ---------------------------------------------------------------------------
# argv shape — confirms each query_type stays read-only
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_pr_argv_is_view_only() -> None:
    record: list[list[str]] = []
    await run_github_query(
        query_type="pr",
        target="owner/repo#42",
        gh_available=lambda: True,
        command_runner=_runner(stdout='{"title":"x"}', record=record),
    )
    assert record == [
        [
            "gh",
            "pr",
            "view",
            "owner/repo#42",
            "--json",
            "title,state,statusCheckRollup,reviews,url,author,createdAt,body",
        ]
    ]


@pytest.mark.asyncio
async def test_issue_argv_is_view_only() -> None:
    record: list[list[str]] = []
    await run_github_query(
        query_type="issue",
        target="owner/repo#7",
        gh_available=lambda: True,
        command_runner=_runner(stdout='{"title":"x"}', record=record),
    )
    assert record[0][:4] == ["gh", "issue", "view", "owner/repo#7"]


@pytest.mark.asyncio
async def test_run_argv_uses_list_subcommand() -> None:
    record: list[list[str]] = []
    await run_github_query(
        query_type="run",
        target="owner/repo",
        gh_available=lambda: True,
        command_runner=_runner(stdout="[]", record=record),
    )
    assert record[0][:5] == ["gh", "run", "list", "--repo", "owner/repo"]


@pytest.mark.asyncio
async def test_api_argv_does_not_set_method() -> None:
    """`gh api` defaults to GET; we never pass --method so the tool
    can't be coerced into a mutating call by creative ``target``s."""
    record: list[list[str]] = []
    await run_github_query(
        query_type="api",
        target="repos/owner/repo/issues",
        gh_available=lambda: True,
        command_runner=_runner(stdout="[]", record=record),
    )
    assert "--method" not in record[0]
    assert "-X" not in record[0]
    assert record[0][0:2] == ["gh", "api"]


# ---------------------------------------------------------------------------
# Output handling
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_truncates_oversized_output() -> None:
    huge = "y" * (MAX_OUTPUT_CHARS + 500)
    outcome = await run_github_query(
        query_type="pr",
        target="o/r#1",
        gh_available=lambda: True,
        command_runner=_runner(stdout=huge),
    )
    assert outcome.ok is True
    assert outcome.truncated is True
    assert outcome.next_offset is not None
    assert f"offset={outcome.next_offset}" in outcome.output
    assert len(outcome.output) <= MAX_OUTPUT_CHARS


@pytest.mark.asyncio
async def test_api_contents_file_decodes_base64_before_paging() -> None:
    source = "# 文件\n" + "print('hello')\n" * 1500
    payload = json.dumps(
        {
            "type": "file",
            "path": "src/a.py",
            "sha": "a" * 40,
            "encoding": "base64",
            "content": base64.encodebytes(source.encode()).decode(),
            "size": len(source.encode()),
        }
    )
    pages = []
    offset = 0
    while True:
        outcome = await run_github_query(
            query_type="api",
            target="repos/o/r/contents/src/a.py?ref=abcdef",
            offset=offset,
            max_chars=5000,
            gh_available=lambda: True,
            command_runner=_runner(stdout=payload),
        )
        assert outcome.ok
        assert outcome.output_format == "file"
        page = outcome.output.split("\n", 1)[1]  # page range header
        if outcome.truncated:
            page = page.rsplit("\n[truncated;", 1)[0]
        pages.append(page)
        if outcome.next_offset is None:
            break
        assert outcome.next_offset > offset
        offset = outcome.next_offset
    rebuilt = "".join(pages)
    assert rebuilt.split("\n", 1)[1] == source
    assert "base64" not in rebuilt


@pytest.mark.asyncio
@pytest.mark.parametrize("tree", [False, True])
async def test_api_directory_and_tree_compact_redundant_urls(tree) -> None:
    entries = [
        {
            "path": f"src/file_{index}.py",
            "type": "blob" if tree else "file",
            "sha": str(index).zfill(40),
            "size": 500,
            "url": "https://api.github.com/" + "unused/" * 100,
            "_links": {"self": "https://api.github.com/" + "unused/" * 100},
        }
        for index in range(40)
    ]
    payload = {"tree": entries, "truncated": False} if tree else entries
    outcome = await run_github_query(
        query_type="api",
        target="repos/o/r/git/trees/main?recursive=1" if tree else "repos/o/r/contents",
        gh_available=lambda: True,
        command_runner=_runner(stdout=json.dumps(payload)),
    )
    assert outcome.ok and not outcome.truncated
    assert outcome.output_format == "entries"
    assert "file_39.py" in outcome.output
    assert "unused/" not in outcome.output


@pytest.mark.asyncio
async def test_upstream_truncated_tree_is_not_reported_as_complete() -> None:
    outcome = await run_github_query(
        query_type="api",
        target="repos/o/r/git/trees/main?recursive=1",
        gh_available=lambda: True,
        command_runner=_runner(stdout='{"tree":[],"truncated":true}'),
    )
    assert outcome.ok and outcome.source_truncated
    assert "subtree SHA" in outcome.output


@pytest.mark.asyncio
@pytest.mark.parametrize("data", [b"\xff\xfe", b"png\x00bytes"])
async def test_binary_contents_are_not_dumped_as_base64(data) -> None:
    outcome = await run_github_query(
        query_type="api",
        target="repos/o/r/contents/image.png",
        gh_available=lambda: True,
        command_runner=_runner(
            stdout=json.dumps(
                {
                    "encoding": "base64",
                    "content": base64.b64encode(data).decode(),
                    "path": "image.png",
                }
            )
        ),
    )
    assert "Binary" in outcome.output
    assert base64.b64encode(data).decode() not in outcome.output


@pytest.mark.asyncio
async def test_missing_inline_content_has_explicit_blob_recovery_hint() -> None:
    outcome = await run_github_query(
        query_type="api",
        target="repos/o/r/contents/big.py",
        gh_available=lambda: True,
        command_runner=_runner(stdout='{"type":"file","encoding":"none","content":"","sha":"abc"}'),
    )
    assert outcome.ok and outcome.source_truncated
    assert "git/blobs/{sha}" in outcome.output


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "kwargs", [{"offset": -1}, {"offset": "1"}, {"offset": True}, {"max_chars": 0}]
)
async def test_invalid_pagination_is_rejected_before_invocation(kwargs) -> None:
    invoked = []
    outcome = await run_github_query(
        query_type="api",
        target="repos/o/r/contents",
        gh_available=lambda: True,
        command_runner=_runner(record=invoked),
        **kwargs,
    )
    assert not outcome.ok and not invoked


@pytest.mark.asyncio
async def test_option_target_rejected() -> None:
    invoked = []
    outcome = await run_github_query(
        query_type="api",
        target="--method=DELETE",
        gh_available=lambda: True,
        command_runner=_runner(record=invoked),
    )
    assert not outcome.ok and not invoked


@pytest.mark.asyncio
async def test_runner_bounded_download_and_timeout_cleanup(monkeypatch) -> None:
    monkeypatch.setattr("cognivoy.tools.github_query.MAX_DOWNLOAD_BYTES", 2000)
    with pytest.raises(ValueError, match="download limit"):
        await _default_command_runner([sys.executable, "-c", "print('x' * 5000)"], 2)
    with pytest.raises(asyncio.TimeoutError):
        await _default_command_runner([sys.executable, "-c", "import time; time.sleep(10)"], 0.05)


@pytest.mark.asyncio
async def test_runner_cancellation_kills_owned_process(monkeypatch) -> None:
    spawn = asyncio.create_subprocess_exec
    spawned = []
    ready = asyncio.Event()

    async def capture(*args, **kwargs):
        proc = await spawn(*args, **kwargs)
        spawned.append(proc)
        ready.set()
        return proc

    monkeypatch.setattr("cognivoy.tools.github_query.asyncio.create_subprocess_exec", capture)
    task = asyncio.create_task(
        _default_command_runner(
            [sys.executable, "-c", "import time; time.sleep(10)"],
            20,
        )
    )
    await ready.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert spawned[0].returncode is not None


@pytest.mark.asyncio
async def test_wrapper_exposes_continuation_parameters_and_metadata(monkeypatch) -> None:
    from cognivoy.tools.builtin import GithubTool
    from cognivoy.tools.github_query import GithubOutcome

    observed = {}

    async def query(**kwargs):
        observed.update(kwargs)
        return GithubOutcome(ok=True, output="page", truncated=True, next_offset=20, total_chars=50)

    monkeypatch.setattr("cognivoy.tools.github_query.run_github_query", query)
    tool = GithubTool()
    schema = tool.get_definition().to_openai_schema()["function"]["parameters"]
    assert "offset" in schema["properties"] and "offset" not in schema["required"]
    result = await tool.execute(
        query_type="api", target="repos/o/r/contents", offset=10, max_chars=10
    )
    assert observed["offset"] == 10 and observed["max_chars"] == 10
    assert result.metadata["next_offset"] == 20


@pytest.mark.asyncio
async def test_surfaces_nonzero_exit_as_failure() -> None:
    outcome = await run_github_query(
        query_type="pr",
        target="o/r#1",
        gh_available=lambda: True,
        command_runner=_runner(returncode=1, stderr="not found"),
    )
    assert outcome.ok is False
    assert "not found" in outcome.error
