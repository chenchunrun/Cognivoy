"""Model-free BM25 retrieval over text chunks; never loads an embedding model."""

from __future__ import annotations

from collections import Counter
from functools import lru_cache
import hashlib
import json
import math
import os
from pathlib import Path
import re
import tempfile
from typing import Any

from cognivoy.services.rag.index_versioning import list_kb_versions

INDEX_DIR = "keyword_index"
INDEX_FILE = "chunks.json"
MAX_INDEX_BYTES = 256 * 1024 * 1024
_STOP_WORDS = frozenset(
    "a an and are as at be by for from how in is it of on or that the this to what with".split()
)


def tokenize(text: str) -> list[str]:
    """Latin words and CJK bigrams, with no tokenizer/model downloads."""
    words = re.findall(r"[a-z0-9_]+|[\u3400-\u9fff]+", text.casefold())
    tokens: list[str] = []
    for word in words:
        if "\u3400" <= word[0] <= "\u9fff":
            tokens.extend(word[i : i + 2] for i in range(max(1, len(word) - 1)))
        elif word not in _STOP_WORDS:
            tokens.append(word)
    return tokens


def _index_path(kb_dir: Path) -> Path:
    path = kb_dir / INDEX_DIR / INDEX_FILE
    if not path.resolve().is_relative_to(kb_dir.resolve()):
        raise ValueError("Keyword index must remain inside its knowledge base.")
    return path


def _read_json(path: Path, kb_dir: Path) -> Any:
    # Validate the final file too: a docstore symlink can escape a safe parent.
    if not path.resolve().is_relative_to(kb_dir.resolve()):
        raise ValueError("Document store must remain inside its knowledge base.")
    with path.open("rb") as handle:
        content = handle.read(MAX_INDEX_BYTES + 1)
    if len(content) > MAX_INDEX_BYTES:
        raise ValueError("Keyword index exceeds the supported size.")
    return json.loads(content)


def _readiness_fingerprint(kb_dir: Path) -> tuple:
    """Stat candidate files without parsing their potentially large contents.

    Always resolve and scope-check the final path, including on cache hits.
    Including inode/ctime also invalidates atomic replacements that preserve
    the original modification time and size. No document contents are cached.
    """
    root = kb_dir.resolve()
    index = _index_path(kb_dir)
    if index.is_file():
        candidates = [index]
    else:
        candidates = [
            Path(entry["storage_path"]) / "docstore.json" for entry in list_kb_versions(kb_dir)
        ]
    fingerprints = []
    for candidate in candidates:
        resolved = candidate.resolve()
        if not resolved.is_relative_to(root):
            raise ValueError("Document store must remain inside its knowledge base.")
        if not candidate.is_file():
            continue
        info = candidate.stat()
        if info.st_size > MAX_INDEX_BYTES:
            raise ValueError("Keyword index exceeds the supported size.")
        fingerprints.append(
            (str(resolved), info.st_mtime_ns, info.st_size, info.st_ino, info.st_ctime_ns)
        )
    return (MAX_INDEX_BYTES, tuple(fingerprints))


@lru_cache(maxsize=128)
def _cached_available(kb_root: str, fingerprint: tuple) -> bool:
    # The fingerprint is intentionally part of the cache key, not the parser's
    # input. Readiness changes when any candidate is created, replaced, changed,
    # removed or reordered; old booleans are evicted by the bounded LRU.
    try:
        return bool(load_rows(Path(kb_root)))
    except (OSError, ValueError, TypeError, KeyError):
        return False


def available(kb_dir: Path) -> bool:
    try:
        fingerprint = _readiness_fingerprint(kb_dir)
        return _cached_available(str(kb_dir.resolve()), fingerprint)
    except (OSError, ValueError, TypeError, KeyError):
        return False


def _source_id(metadata: dict, document_id: str = "") -> str:
    if metadata.get("file_path"):
        return "path:" + str(metadata["file_path"])
    if metadata.get("file_name"):
        return "name:" + str(metadata["file_name"])
    return "doc:" + document_id if document_id else ""


def load_rows(kb_dir: Path) -> list[dict[str, Any]]:
    path = _index_path(kb_dir)
    if path.is_file():
        rows = _read_json(path, kb_dir)
        if not isinstance(rows, list) or any(
            not isinstance(row, dict)
            or not isinstance(row.get("text"), str)
            or not isinstance(row.get("metadata"), dict)
            or not isinstance(row.get("node_id"), str)
            for row in rows
        ):
            raise ValueError("Invalid keyword index.")
        return [row for row in rows if row["text"].strip()]
    # All historical layouts are readable without an active embedding signature.
    for entry in list_kb_versions(kb_dir):
        docstore = Path(entry["storage_path"]) / "docstore.json"
        if not docstore.is_file():
            continue
        payload = _read_json(docstore, kb_dir)
        if not isinstance(payload, dict) or not isinstance(payload.get("docstore/data", {}), dict):
            raise ValueError("Invalid legacy document store.")
        rows = []
        for node_id, record in payload.get("docstore/data", {}).items():
            # Read plain JSON only; never instantiate third-party node classes.
            node = record.get("__data__", {}) if isinstance(record, dict) else {}
            if not isinstance(node, dict):
                raise ValueError("Invalid legacy document node.")
            resource = node.get("text_resource") or {}
            text = node.get("text") or (
                resource.get("text", "") if isinstance(resource, dict) else ""
            )
            if not isinstance(text, str) or not text.strip():
                continue
            metadata = node.get("metadata") or node.get("extra_info") or {}
            if not isinstance(metadata, dict):
                raise ValueError("Invalid legacy document metadata.")
            relationships = node.get("relationships") or {}
            source = relationships.get("1", {}) if isinstance(relationships, dict) else {}
            document_id = (
                str(source.get("node_id") or node_id) if isinstance(source, dict) else str(node_id)
            )
            rows.append(
                {
                    "text": text,
                    "metadata": metadata,
                    "node_id": str(node.get("id_") or node_id),
                    "source_id": _source_id(metadata, document_id),
                }
            )
        if rows:
            return rows
    return []


def index_documents(documents, kb_dir: str, *, append=False, progress_callback=None) -> int:
    """Atomically publish text chunks while preserving all prior vector indexes."""
    from .config import chunk_geometry

    root = Path(kb_dir)
    path = _index_path(root)
    rows = load_rows(root) if append else []
    size, overlap = chunk_geometry()
    # Approximate token geometry in characters without downloading a tokenizer.
    size, overlap = size * 4, overlap * 4
    documents = list(documents)
    incoming = {_source_id(doc.metadata or {}, str(doc.doc_id)) for doc in documents}
    # Older docstores sometimes retain only the basename. Upgrade that identity
    # only when unambiguous; never merge two known, different absolute paths.
    paths_by_name: dict[str, set[str]] = {}
    for metadata in [*(row["metadata"] for row in rows), *(doc.metadata for doc in documents)]:
        if metadata.get("file_path"):
            name = str(metadata.get("file_name") or Path(metadata["file_path"]).name)
            paths_by_name.setdefault(name, set()).add(str(metadata["file_path"]))
    incoming_names = {
        str(doc.metadata.get("file_name") or Path(doc.metadata.get("file_path", "")).name)
        for doc in documents
    }

    def replaced(row):
        metadata = row["metadata"]
        if (
            row.get("source_id") or _source_id(metadata, str(row.get("ref_doc_id") or ""))
        ) in incoming:
            return True
        name = str(metadata.get("file_name") or "")
        return (
            not metadata.get("file_path")
            and bool(name)
            and name in incoming_names
            and len(paths_by_name.get(name, set())) <= 1
        )

    rows = [row for row in rows if not replaced(row)]
    added = 0
    for number, doc in enumerate(documents):
        text = str(getattr(doc, "text", "") or "")
        for start in range(0, len(text), max(1, size - overlap)):
            chunk = text[start : start + size]
            if not chunk.strip():
                continue
            identity = f"{doc.doc_id}:{start}:{chunk}".encode()
            rows.append(
                {
                    "text": chunk,
                    "metadata": dict(doc.metadata or {}),
                    "node_id": hashlib.sha256(identity).hexdigest()[:24],
                    "source_id": _source_id(doc.metadata or {}, str(doc.doc_id)),
                }
            )
            added += 1
        if progress_callback:
            progress_callback(
                number + 1, len(documents), "Indexing text without an embedding model"
            )
    if not rows:
        raise ValueError("No searchable text was found. Image-only documents need text extraction.")
    path.parent.mkdir(parents=True, exist_ok=True)
    name = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=path.parent, delete=False
        ) as handle:
            name = handle.name
            json.dump(rows, handle, ensure_ascii=False)
            handle.flush()
            if os.fstat(handle.fileno()).st_size > MAX_INDEX_BYTES:
                raise ValueError("Keyword index exceeds the supported size.")
            os.fsync(handle.fileno())
        os.replace(name, path)
    finally:
        if name and os.path.exists(name):
            os.unlink(name)
    return added


def retrieve(kb_dir: str, query: str, *, top_k=5) -> list[dict[str, Any]]:
    rows = load_rows(Path(kb_dir))
    terms = set(tokenize(query[:4000]))
    if not rows or not terms:
        return []
    counts = [Counter(tokenize(str(row.get("text") or ""))) for row in rows]
    lengths = [sum(count.values()) for count in counts]
    average = sum(lengths) / len(rows) or 1
    frequency = {term: sum(term in count for count in counts) for term in terms}
    scored = []
    for row, count, length in zip(rows, counts, lengths, strict=True):
        score = 0.0
        for term in terms:
            tf = count[term]
            if tf:
                idf = math.log1p((len(rows) - frequency[term] + 0.5) / (frequency[term] + 0.5))
                score += idf * tf * 2.5 / (tf + 1.5 * (0.25 + 0.75 * length / average))
        if score > 0:
            scored.append({**row, "score": score})
    scored.sort(key=lambda row: (-row["score"], row["node_id"]))
    from .storage import diversify_source_payload

    return diversify_source_payload(scored, top_k=max(1, min(50, int(top_k))))
