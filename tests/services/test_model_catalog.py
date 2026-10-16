from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path

import pytest

from cognivoy.services.config.model_catalog import (
    ModelCatalogLoadError,
    ModelCatalogService,
)


def test_load_creates_empty_catalog_without_dotenv_hydration(tmp_path: Path):
    env_path = tmp_path / ".env"
    env_path.write_text(
        "LLM_MODEL=legacy-model\nLLM_API_KEY=legacy-key\nEMBEDDING_MODEL=legacy-embedding\n",
        encoding="utf-8",
    )
    catalog_path = tmp_path / "model_catalog.json"

    catalog = ModelCatalogService(path=catalog_path).load()

    assert catalog["services"]["llm"]["profiles"] == []
    assert catalog["services"]["embedding"]["profiles"] == []
    assert catalog["services"]["search"]["profiles"] == []


def test_load_does_not_sync_existing_active_profiles_from_dotenv(tmp_path: Path):
    (tmp_path / ".env").write_text(
        "LLM_MODEL=qwen3.5-plus\nEMBEDDING_MODEL=text-embedding-v4\n",
        encoding="utf-8",
    )
    catalog_path = tmp_path / "model_catalog.json"
    catalog_path.write_text(
        """{
  "version": 1,
  "services": {
    "llm": {
      "active_profile_id": "llm-profile-default",
      "active_model_id": "llm-model-default",
      "profiles": [
        {
          "id": "llm-profile-default",
          "name": "Default LLM Endpoint",
          "binding": "openai",
          "base_url": "https://old-llm.example/v1",
          "api_key": "old-llm-key",
          "api_version": "",
          "extra_headers": {},
          "models": [
            {"id": "llm-model-default", "name": "old-model", "model": "old-model"}
          ]
        }
      ]
    },
    "embedding": {
      "active_profile_id": "embedding-profile-default",
      "active_model_id": "embedding-model-default",
      "profiles": [
        {
          "id": "embedding-profile-default",
          "name": "Default Embedding Endpoint",
          "binding": "openai",
          "base_url": "https://old-emb.example/v1",
          "api_key": "old-emb-key",
          "api_version": "",
          "extra_headers": {},
          "models": [
            {
              "id": "embedding-model-default",
              "name": "old-embedding",
              "model": "old-embedding",
              "dimension": "3072"
            }
          ]
        }
      ]
    },
    "search": {"active_profile_id": null, "profiles": []}
  }
}
""",
        encoding="utf-8",
    )

    service = ModelCatalogService(path=catalog_path)
    catalog = service.load()

    llm_profile = catalog["services"]["llm"]["profiles"][0]
    llm_model = llm_profile["models"][0]
    emb_profile = catalog["services"]["embedding"]["profiles"][0]
    emb_model = emb_profile["models"][0]

    assert llm_profile["binding"] == "openai"
    assert llm_profile["base_url"] == "https://old-llm.example/v1"
    assert llm_profile["api_key"] == "old-llm-key"
    assert llm_model["model"] == "old-model"
    assert llm_model["name"] == "old-model"
    assert emb_profile["binding"] == "openai"
    assert emb_profile["base_url"] == "https://old-emb.example/v1/embeddings"
    assert emb_profile["api_key"] == "old-emb-key"
    assert emb_model["model"] == "old-embedding"
    assert emb_model["name"] == "old-embedding"
    assert emb_model["dimension"] == "3072"


def test_load_preserves_invalid_catalog_and_reports_error(tmp_path: Path):
    catalog_path = tmp_path / "model_catalog.json"
    original = "{not-json"
    catalog_path.write_text(original, encoding="utf-8")

    with pytest.raises(ModelCatalogLoadError, match="file was preserved"):
        ModelCatalogService(path=catalog_path).load()

    assert catalog_path.read_text(encoding="utf-8") == original


def _gemini_embedding_catalog(path: Path, model: str) -> Path:
    path.write_text(
        json.dumps(
            {
                "services": {
                    "embedding": {
                        "active_profile_id": "gemini-profile",
                        "active_model_id": "gemini-model",
                        "profiles": [
                            {
                                "id": "gemini-profile",
                                "name": "Gemini",
                                "binding": "gemini",
                                "base_url": "",
                                "api_key": "test-key",
                                "models": [
                                    {
                                        "id": "gemini-model",
                                        "name": model,
                                        "model": model,
                                    }
                                ],
                            }
                        ],
                    }
                }
            }
        ),
        encoding="utf-8",
    )
    return path


def test_load_sets_gemini_native_endpoint_from_active_embedding_model(tmp_path: Path):
    catalog_path = _gemini_embedding_catalog(tmp_path / "model_catalog.json", "gemini-embedding-2")

    catalog = ModelCatalogService(path=catalog_path).load()

    profile = catalog["services"]["embedding"]["profiles"][0]
    assert profile["base_url"].endswith("/models/gemini-embedding-2:batchEmbedContents")


def test_load_keeps_older_gemini_embedding_models_on_the_openai_path(tmp_path: Path):
    """The native route sends a taskType and L2-normalizes, so moving an
    existing gemini-embedding-001 profile there would change its document
    vectors and invalidate the index built from them."""
    catalog_path = _gemini_embedding_catalog(
        tmp_path / "model_catalog.json", "gemini-embedding-001"
    )

    catalog = ModelCatalogService(path=catalog_path).load()

    profile = catalog["services"]["embedding"]["profiles"][0]
    assert profile["base_url"] == (
        "https://generativelanguage.googleapis.com/v1beta/openai/embeddings"
    )


def test_load_persists_normalized_active_ids(tmp_path: Path):
    catalog_path = tmp_path / "model_catalog.json"
    catalog_path.write_text(
        json.dumps(
            {
                "services": {
                    "llm": {
                        "active_profile_id": "missing-profile",
                        "active_model_id": "missing-model",
                        "profiles": [
                            {
                                "id": "llm-profile-a",
                                "name": "A",
                                "binding": "openai",
                                "base_url": "https://example.test/v1",
                                "api_key": "sk",
                                "models": [
                                    {
                                        "id": "llm-model-a",
                                        "name": "gpt",
                                        "model": "gpt-test",
                                    }
                                ],
                            }
                        ],
                    }
                }
            }
        ),
        encoding="utf-8",
    )

    ModelCatalogService(path=catalog_path).load()

    saved = json.loads(catalog_path.read_text(encoding="utf-8"))
    llm = saved["services"]["llm"]
    assert llm["active_profile_id"] == "llm-profile-a"
    assert llm["active_model_id"] == "llm-model-a"
    assert saved["services"]["embedding"]["profiles"] == []
    assert saved["services"]["search"]["profiles"] == []


def test_update_serializes_concurrent_catalog_mutations(tmp_path: Path):
    service = ModelCatalogService(path=tmp_path / "model_catalog.json")
    initial = service.load()
    initial["mutation_count"] = 0
    service.save(initial)

    def increment(_index: int) -> None:
        def mutate(catalog: dict) -> None:
            catalog["mutation_count"] = int(catalog.get("mutation_count", 0)) + 1

        service.update(mutate)

    with ThreadPoolExecutor(max_workers=4) as executor:
        list(executor.map(increment, range(40)))

    assert service.load()["mutation_count"] == 40


def test_atomic_save_leaves_no_temporary_file(tmp_path: Path):
    catalog_path = tmp_path / "model_catalog.json"
    service = ModelCatalogService(path=catalog_path)

    service.save({"version": 1, "services": {}})

    assert catalog_path.exists()
    assert not list(tmp_path.glob(".model_catalog.json.*"))


def test_api_keys_are_encrypted_at_rest_and_legacy_catalogs_migrate(
    tmp_path: Path, monkeypatch
) -> None:
    from cognivoy.multi_user import paths

    monkeypatch.setattr(paths, "SYSTEM_ROOT", tmp_path / "system")
    catalog_path = tmp_path / "model_catalog.json"
    legacy = {
        "services": {
            "llm": {
                "active_profile_id": "llm-a",
                "active_model_id": None,
                "profiles": [
                    {
                        "id": "llm-a",
                        "name": "A",
                        "api_key": "provider-secret",
                        "models": [],
                    }
                ],
            }
        }
    }
    catalog_path.write_text(json.dumps(legacy), encoding="utf-8")

    service = ModelCatalogService(catalog_path)
    assert service.load()["services"]["llm"]["profiles"][0]["api_key"] == "provider-secret"

    raw = catalog_path.read_text(encoding="utf-8")
    assert "provider-secret" not in raw
    assert "$secret" in raw
    assert service.load()["services"]["llm"]["profiles"][0]["api_key"] == "provider-secret"


def test_encrypted_catalog_survives_fresh_service_instance(tmp_path: Path, monkeypatch) -> None:
    from cognivoy.multi_user import paths

    monkeypatch.setattr(paths, "SYSTEM_ROOT", tmp_path / "system")
    catalog_path = tmp_path / "model_catalog.json"
    service = ModelCatalogService(catalog_path)
    catalog = service.load()
    catalog["services"]["llm"] = {
        "active_profile_id": "deepseek",
        "active_model_id": "deepseek-model",
        "profiles": [
            {
                "id": "deepseek",
                "name": "DeepSeek",
                "binding": "openai",
                "base_url": "https://api.deepseek.example/v1",
                "api_key": "restart-safe-secret",
                "extra_headers": {},
                "models": [
                    {
                        "id": "deepseek-model",
                        "name": "DeepSeek V4 Pro",
                        "model": "deepseek-v4-pro",
                    }
                ],
            }
        ],
    }
    service.save(catalog)

    reloaded = ModelCatalogService(catalog_path).load()

    profile = reloaded["services"]["llm"]["profiles"][0]
    assert profile["api_key"] == "restart-safe-secret"
    assert profile["models"][0]["model"] == "deepseek-v4-pro"
    assert "restart-safe-secret" not in catalog_path.read_text(encoding="utf-8")


def test_wrong_master_key_does_not_replace_encrypted_catalog(tmp_path: Path, monkeypatch) -> None:
    from cognivoy.multi_user import paths

    catalog_path = tmp_path / "model_catalog.json"
    monkeypatch.setattr(paths, "SYSTEM_ROOT", tmp_path / "system-a")
    service = ModelCatalogService(catalog_path)
    catalog = service.load()
    catalog["services"]["llm"]["profiles"] = [
        {"id": "p", "name": "P", "api_key": "keep-me", "models": []}
    ]
    service.save(catalog)
    original = catalog_path.read_bytes()

    monkeypatch.setattr(paths, "SYSTEM_ROOT", tmp_path / "system-b")
    with pytest.raises(ModelCatalogLoadError, match="file was preserved"):
        ModelCatalogService(catalog_path).load()

    assert catalog_path.read_bytes() == original
