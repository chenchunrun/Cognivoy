from __future__ import annotations

import importlib
import inspect
from pathlib import Path


async def inline_isolated_runner(
    *,
    module: str,
    qualname: str,
    args=(),
    kwargs=None,
    progress_kwarg=None,
    on_progress=None,
    **_ignored,
):
    """Execute an isolated entrypoint inline so monkeypatches remain visible."""

    target = importlib.import_module(module)
    if module.endswith("llamaindex.storage"):
        values = tuple(args)
        options = dict(kwargs or {})
        if qualname == "create_index_isolated":
            return target.create_index(
                values[0], Path(values[1]), show_progress=options.get("show_progress", True)
            )
        if qualname == "insert_documents_isolated":
            return target.insert_documents(Path(values[0]), Path(values[1]), values[2])
        if qualname == "retrieve_nodes_payload":
            rows = []
            nodes = target.retrieve_nodes(Path(values[0]), values[1], top_k=options.get("top_k", 5))
            for index, item in enumerate(nodes):
                node = item.node
                rows.append(
                    {
                        "text": node.text,
                        "metadata": dict(node.metadata or {}),
                        "node_id": str(node.node_id or index),
                        "score": item.score,
                    }
                )
            return rows
    for part in qualname.split("."):
        target = getattr(target, part)
    options = dict(kwargs or {})
    if progress_kwarg and on_progress is not None:
        options[progress_kwarg] = on_progress
    result = target(*args, **options)
    if inspect.isawaitable(result):
        return await result
    return result
