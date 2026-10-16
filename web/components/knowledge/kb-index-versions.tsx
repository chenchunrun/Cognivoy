"use client";

import { useState } from "react";
import Link from "next/link";
import { CheckCircle2, Clock, Eye, HeartPulse, Layers, Search, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Badge, Button, Input } from "@/components/ui";
import FilePreviewDrawer from "@/components/chat/FilePreviewDrawer";
import { getRetrievalHealth, inspectKnowledgeIndexFragments, knowledgeBaseFilePath, knowledgeBaseFilePreviewTextPath, knowledgeBasePptxPreviewPath, runRetrievalQualityProbe, type IndexFragment, type IndexFragmentsReport, type RetrievalHealthReport, type RetrievalQualityReport } from "@/lib/knowledge-api";
import {
  formatKnowledgeTimestamp,
  kbKeywordIndexReady,
  kbUsesKeywordRetrieval,
  type IndexVersion,
  type KnowledgeBase,
} from "@/lib/knowledge-helpers";

export function KbIndexVersions({ kb }: { kb: KnowledgeBase }) {
  const { t } = useTranslation();
  const [health, setHealth] = useState<RetrievalHealthReport | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [checkingHealth, setCheckingHealth] = useState(false);
  const [quality, setQuality] = useState<RetrievalQualityReport | null>(null);
  const [qualityError, setQualityError] = useState<string | null>(null);
  const [checkingQuality, setCheckingQuality] = useState(false);
  const [fragmentQuery, setFragmentQuery] = useState("");
  const [fragments, setFragments] = useState<IndexFragmentsReport | null>(null);
  const [fragmentError, setFragmentError] = useState<string | null>(null);
  const [checkingFragments, setCheckingFragments] = useState(false);
  const [previewFragment, setPreviewFragment] = useState<IndexFragment | null>(null);
  const versions = kb.statistics?.index_versions ?? [];
  const activeSignature = kb.statistics?.active_signature ?? null;
  const lastIndexed = formatKnowledgeTimestamp(kb.metadata?.last_indexed_at);
  const keywordMode = kbUsesKeywordRetrieval(kb);
  const keywordReady = kbKeywordIndexReady(kb);
  const versionList = (
    <ul className="mt-3 divide-y divide-border overflow-hidden rounded-lg border border-border">
      {versions.map((version, index) => (
        <IndexVersionRow
          key={version.signature || `${version.model}-${version.dimension}-${version.created_at}-${index}`}
          version={version}
          active={!keywordMode && Boolean(version.signature && version.signature === activeSignature)}
        />
      ))}
    </ul>
  );

  return (
    <section className="surface p-4" aria-labelledby="kb-index-versions-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="kb-index-versions-title" className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Layers size={14} />
            {keywordMode ? t("Keyword text index") : t("Index versions")}
            {!keywordMode && <Badge variant="outline">{versions.length}</Badge>}
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {keywordMode
              ? t("Searches extracted text using a separate keyword index. No embedding model, API key, or local model service is required.")
              : t("Each embedding configuration keeps its own stored vector index.")}
          </p>
          {keywordMode && (
            <p className="mt-2 flex items-center gap-1.5 text-xs font-medium text-foreground" data-testid="knowledge-keyword-index-status" role="status">
              {keywordReady ? <CheckCircle2 size={14} className="text-success" /> : <TriangleAlert size={14} className="text-warning" />}
              {keywordReady ? t("Keyword index is ready") : t("Keyword index is not ready")}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Clock size={13} />
            {t("Last indexed")}: {lastIndexed || t("Not recorded yet")}
          </div>
          <Button
            variant="outline"
            size="sm"
            loading={checkingHealth}
            data-testid="knowledge-retrieval-health"
            onClick={async () => {
              setCheckingHealth(true);
              setHealthError(null);
              try {
                setHealth(await getRetrievalHealth(kb.id || kb.name));
              } catch (error) {
                setHealthError(error instanceof Error ? error.message : String(error));
              } finally {
                setCheckingHealth(false);
              }
            }}
          >
            {!checkingHealth && <HeartPulse size={13} />}
            {checkingHealth ? t("Checking retrieval…") : t("Check retrieval health")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            loading={checkingQuality}
            data-testid="knowledge-retrieval-quality"
            onClick={async () => {
              setCheckingQuality(true);
              setQualityError(null);
              try {
                setQuality(await runRetrievalQualityProbe(kb.id || kb.name));
              } catch (error) {
                setQualityError(error instanceof Error ? error.message : String(error));
              } finally {
                setCheckingQuality(false);
              }
            }}
          >
            {!checkingQuality && <HeartPulse size={13} />}
            {checkingQuality ? t("Testing recall…") : t("Test recall quality")}
          </Button>
        </div>
      </div>

      {(health || healthError) && (
        <div
          className="mt-3 rounded-lg border border-border bg-muted-subtle p-3"
          role={healthError || health?.ready === false ? "alert" : "status"}
        >
          {healthError ? (
            <p className="text-xs text-destructive">{healthError}</p>
          ) : health ? (
            <>
              <p className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                {health.ready ? <CheckCircle2 size={14} className="text-success" /> : <TriangleAlert size={14} className="text-warning" />}
                {health.ready ? t("Retrieval is ready") : t("Retrieval needs attention")}
              </p>
              <ul className="mt-2 space-y-1.5">
                {health.checks.map((check) => (
                  <li key={check.key} className="flex flex-wrap items-start gap-2 text-xs">
                    <span className={check.ok ? "text-success" : "text-warning"}>
                      {check.ok ? <CheckCircle2 size={13} /> : <TriangleAlert size={13} />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="font-medium text-foreground">{t(check.label)}</span>
                      <span className="ml-1 text-muted-foreground">
                        {t(check.detail_key || check.detail, check.parameters ?? {})}
                      </span>
                    </span>
                    {!check.ok && check.action && (
                      <Link href={check.action.href} className="font-medium text-primary hover:underline">
                        {t(check.action.label)}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      )}

      {(quality || qualityError) && (
        <div className="mt-3 rounded-lg border border-border bg-muted-subtle p-3" role={qualityError || quality?.quality === "poor" || quality?.quality === "unavailable" ? "alert" : "status"} data-testid="knowledge-quality-report">
          {qualityError ? <p className="text-xs text-destructive">{qualityError}</p> : quality ? (
            <>
              <p className="flex items-center gap-2 text-xs font-medium text-foreground">
                {quality.score >= 0.7 ? <CheckCircle2 size={14} className="text-success" /> : <TriangleAlert size={14} className="text-warning" />}
                {t("Recall quality")}: {Math.round(quality.score * 100)}% · {t(quality.quality)}
              </p>
              <p className="mt-2 text-xs text-muted-foreground">{t("Sample source")}: <span className="text-foreground">{quality.sample_source}</span></p>
              <p className="mt-1 text-xs text-muted-foreground">{t("Passage overlap")}: {Math.round(quality.passage_overlap * 100)}% · {t("Source attribution")}: {t(quality.source_matched ? "Matched" : "Not matched")}</p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                {quality.recommendations.map((recommendation) => <li key={recommendation}>{t(recommendation)}</li>)}
              </ul>
            </>
          ) : null}
        </div>
      )}

      <div className="mt-3 rounded-lg border border-border bg-muted-subtle p-3" data-testid="knowledge-index-fragments">
        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-56 flex-1 text-xs font-medium text-foreground">
            {t("Inspect indexed fragments")}
            <Input
              className="mt-1"
              value={fragmentQuery}
              onChange={(event) => setFragmentQuery(event.target.value)}
              placeholder={t("Enter a phrase or question to inspect real retrieval hits")}
            />
          </label>
          <Button
            variant="outline"
            size="sm"
            loading={checkingFragments}
            disabled={!fragmentQuery.trim()}
            onClick={async () => {
              setCheckingFragments(true);
              setFragmentError(null);
              try {
                setFragments(await inspectKnowledgeIndexFragments(kb.id || kb.name, fragmentQuery));
              } catch (error) {
                setFragmentError(error instanceof Error ? error.message : String(error));
              } finally {
                setCheckingFragments(false);
              }
            }}
          >
            {!checkingFragments && <Search size={13} />}
            {t("Inspect")}
          </Button>
        </div>
        {fragmentError && <p className="mt-2 text-xs text-destructive" role="alert">{fragmentError}</p>}
        {fragments && !fragmentError && (
          <div className="mt-3">
            <p className="text-xs text-muted-foreground">
              {t("{{count}} retrieval fragments", { count: fragments.fragment_count })}
            </p>
            {fragments.fragments.length ? (
              <ol className="mt-2 space-y-2">
                {fragments.fragments.map((fragment) => (
                  <li key={`${fragment.rank}-${fragment.source}`} className="rounded-lg border border-border bg-background p-3 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium text-foreground">#{fragment.rank} · {fragment.source}</span>
                      <span className="flex items-center gap-2 text-muted-foreground">
                        <span>
                          {fragment.page != null ? `${t("Page")} ${fragment.page}` : ""}
                          {fragment.score != null ? ` · ${Number(fragment.score).toFixed(3)}` : ""}
                        </span>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setPreviewFragment(fragment)}
                          aria-label={t("Open source: {{name}}", { name: fragment.source })}
                          data-testid="knowledge-fragment-open-source"
                        >
                          <Eye size={13} />
                          {t("Open source")}
                        </Button>
                      </span>
                    </div>
                    {fragment.section && <p className="mt-1 text-muted-foreground">{fragment.section}</p>}
                    <p className="mt-2 max-h-32 overflow-y-auto whitespace-pre-wrap text-foreground">{fragment.content || t("No text excerpt was returned by this provider.")}</p>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">{t("No matching fragments were returned.")}</p>
            )}
          </div>
        )}
      </div>

      {keywordMode ? (
        versions.length > 0 ? (
          <details className="mt-3 rounded-lg border border-border p-3" data-testid="knowledge-stored-vector-indexes">
            <summary className="cursor-pointer text-xs font-medium text-foreground">
              {t("Stored vector indexes")} <Badge variant="outline">{versions.length}</Badge>
            </summary>
            <p className="mt-2 text-xs text-muted-foreground">
              {t("These indexes are preserved for vector modes and are not used by keyword retrieval.")}
            </p>
            {versionList}
          </details>
        ) : null
      ) : versions.length === 0 ? (
        <p className="mt-3 rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
          {t("No index versions yet.")}
        </p>
      ) : (
        versionList
      )}

      {previewFragment && (
        <FilePreviewDrawer
          source={{
            type: "file",
            filename: previewFragment.source,
            url: `${knowledgeBaseFilePath(kb.id || kb.name, previewFragment.source)}${
              previewFragment.page != null ? `#page=${encodeURIComponent(String(previewFragment.page))}` : ""
            }`,
            text_preview_url: knowledgeBaseFilePreviewTextPath(kb.id || kb.name, previewFragment.source),
            slide_preview_url: knowledgeBasePptxPreviewPath(kb.id || kb.name, previewFragment.source),
            extracted_text: /\.(txt|md|csv|tsv|json|ya?ml|js|jsx|ts|tsx|py|go|rs|java|css|html|log)$/i.test(previewFragment.source)
              ? previewFragment.content
              : undefined,
            preview_page: previewFragment.page != null && Number.isFinite(Number(previewFragment.page))
              ? Number(previewFragment.page)
              : undefined,
            preview_section: previewFragment.section || undefined,
            preview_focus_text: previewFragment.section || previewFragment.content.slice(0, 120),
          }}
          onClose={() => setPreviewFragment(null)}
        />
      )}
    </section>
  );
}

function IndexVersionRow({ version, active }: { version: IndexVersion; active: boolean }) {
  const { t } = useTranslation();
  const ready = version.ready === true;
  const title = version.model || version.signature || t("Unknown");
  const created = formatKnowledgeTimestamp(version.created_at);

  return (
    <li className="flex flex-wrap items-center gap-3 bg-background px-3 py-2.5 text-xs">
      <span className={ready ? "text-success" : "text-warning"}>
        {ready ? <CheckCircle2 size={15} /> : <TriangleAlert size={15} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-foreground">{title}</span>
        <span className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-muted-foreground">
          {typeof version.dimension === "number" && <span>{version.dimension}d</span>}
          {version.binding && <span>{version.binding}</span>}
          {created && <span>{created}</span>}
          {version.signature && <span className="font-mono">{version.signature.slice(0, 12)}</span>}
        </span>
      </span>
      {active && <Badge variant={ready ? "success" : "outline"}>{ready ? t("Active version") : t("Active, not ready")}</Badge>}
      {version.legacy && <Badge variant="outline">{t("Legacy")}</Badge>}
    </li>
  );
}

export default KbIndexVersions;
