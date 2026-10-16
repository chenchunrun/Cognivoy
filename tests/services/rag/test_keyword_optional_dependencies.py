"""Default retrieval must work even when vector dependencies are absent."""

import subprocess
import sys
import textwrap


def test_keyword_pipeline_without_vector_packages(tmp_path):
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            textwrap.dedent("""
            import asyncio
            import importlib.abc
            import json
            import sys
            from pathlib import Path

            class BlockVectorImports(importlib.abc.MetaPathFinder):
                def find_spec(self, fullname, path=None, target=None):
                    if fullname.split('.')[0] in {'llama_index', 'nltk', 'faiss'}:
                        raise ModuleNotFoundError(fullname, name=fullname)

            sys.meta_path.insert(0, BlockVectorImports())
            from cognivoy.runtime.orchestrator import ChatOrchestrator
            from cognivoy.api.routers.unified_ws import unified_websocket
            from cognivoy.services.rag.pipelines.llamaindex import pipeline, storage
            from cognivoy.services.rag.pipelines.llamaindex.document_loader import LlamaIndexDocumentLoader
            root = Path(sys.argv[1])
            source = root / 'notes.txt'
            source.write_text('Cognivoy keyword retrieval works without models.')
            docs = asyncio.run(LlamaIndexDocumentLoader().load([str(source)], include_images=False))
            assert storage.create_keyword_index_isolated(docs, str(root / 'kb')) == 1
            rows = storage.retrieve_keyword_payload(str(root / 'kb'), 'Cognivoy')
            assert rows and 'Cognivoy' in rows[0]['text']
            legacy = root / 'old' / 'llamaindex_storage'
            legacy.mkdir(parents=True)
            (legacy / 'docstore.json').write_text(json.dumps({
                'docstore/data': {'node': {'__data__': {
                    'text': 'CISA legacy auditing', 'metadata': {'file_name': 'old.txt'},
                    'relationships': {'1': {'node_id': 'original'}}
                }, '__type__': '1'}}
            }))
            rows = storage.retrieve_keyword_payload(str(root / 'old'), 'CISA')
            assert rows and rows[0]['text'] == 'CISA legacy auditing'
            try:
                pipeline._vector_adapter()
            except RuntimeError as exc:
                assert 'rag-llamaindex' in str(exc)
            else:
                raise AssertionError('Missing vector dependency must be actionable')
        """),
            str(tmp_path),
        ],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_default_package_metadata_excludes_vector_dependencies():
    from pathlib import Path
    import tomllib

    from packaging.requirements import Requirement

    root = Path(__file__).resolve().parents[3]
    for path in (root / "pyproject.toml", root / "packaging/cognivoy-cli/pyproject.toml"):
        project = tomllib.loads(path.read_text())["project"]
        names = {Requirement(item).name for item in project["dependencies"]}
        assert not names.intersection({"nltk", "llama-index", "llama-index-core", "faiss-cpu"})
        assert "rag-llamaindex" in project["optional-dependencies"]
