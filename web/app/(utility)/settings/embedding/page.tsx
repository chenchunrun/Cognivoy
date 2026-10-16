"use client";

import { useTranslation } from "react-i18next";
import { useEffect, useState } from "react";
import { ServiceEditor } from "@/components/settings/ServiceEditor";
import { Button, Select } from "@/components/ui";
import {
  getLlamaIndexConfig,
  updateLlamaIndexConfig,
  type LlamaIndexConfig,
} from "@/lib/knowledge-api";

export default function EmbeddingSettingsPage() {
  const { t } = useTranslation();
  const [profile, setProfile] = useState<LlamaIndexConfig["retrieval_profile"] | "">("");
  const [saved, setSaved] = useState<LlamaIndexConfig["retrieval_profile"] | "">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    getLlamaIndexConfig()
      .then((config) => {
        if (active) {
          setProfile(config.retrieval_profile);
          setSaved(config.retrieval_profile);
        }
      })
      .catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, []);

  async function saveProfile() {
    if (!profile) return;
    setBusy(true);
    setError(false);
    try {
      const config = await updateLlamaIndexConfig({ retrieval_profile: profile });
      setProfile(config.retrieval_profile);
      setSaved(config.retrieval_profile);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <section className="surface mb-6 space-y-3 p-5" aria-labelledby="retrieval-mode-heading">
        <h2 id="retrieval-mode-heading" className="display text-lg font-semibold">
          {t("Knowledge retrieval mode")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t("Keyword retrieval needs no embedding model, API key, or Ollama. It matches terms in extracted text; semantic and cross-language matching require vector retrieval.")}
        </p>
        <label htmlFor="retrieval-profile" className="block text-sm">{t("Retrieval mode")}</label>
        <Select
          id="retrieval-profile"
          value={profile}
          disabled={busy || !profile}
          onChange={(event) => setProfile(event.target.value as LlamaIndexConfig["retrieval_profile"])}
        >
          {!profile ? <option value="">{t("Loading...")}</option> : null}
          <option value="keyword">{t("Keyword (no model)")}</option>
          <option value="hybrid" disabled>{t("Hybrid (embedding required)")} — {t("Unavailable")}</option>
          <option value="vector" disabled>{t("Vector (embedding required)")} — {t("Unavailable")}</option>
        </Select>
        <p className="text-xs text-muted-foreground">
          {t("Applies to LlamaIndex knowledge bases. Existing text chunks can be reused; original vector indexes are preserved. Scanned images need text extraction first.")}
        </p>
        <Button disabled={busy || !profile || profile === saved} onClick={() => void saveProfile()}>
          {t("Save")}
        </Button>
        {saved === "keyword" ? (
          <p role="status" className="text-sm text-success">
            {t("Model-free retrieval is active. Embedding settings below are optional for vector modes.")}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {t("Failed to load or save retrieval mode. Refresh and retry.")}
          </p>
        ) : null}
      </section>
      <ServiceEditor
        service="embedding"
        title={t("Embedding")}
        description={t(
          "The embedding model used to index and retrieve knowledge-base documents.",
        )}
      />
    </>
  );
}
