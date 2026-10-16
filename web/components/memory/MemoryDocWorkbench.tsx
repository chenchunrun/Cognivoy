"use client";

// L2/L3 doc workbench: doc rail (per surface / per slot) + rendered doc
// viewer with line-number view + raw editor, and the LLM run panel.
// Ported from the previous frontend's MemoryWorkbench.

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileText, Hash, Network, Pencil, Save, Workflow } from "lucide-react";
import { useTranslation } from "react-i18next";

import { L3_SLOTS, SURFACES } from "@/lib/memory-graph";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Skeleton,
  Tabs,
  TabsList,
  TabsTrigger,
  Tooltip,
  useToast,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import {
  getDoc,
  getDocLines,
  getOverview,
  MemoryVersionConflictError,
  putDoc,
  type DocOverview,
  type LineRow,
  type MemoryLayer,
} from "./api";
import { prepareDocForRender } from "./doc-render";
import { formatTimestamp, L3_META, SURFACE_META } from "./meta";
import { MemoryRunPanel } from "./MemoryRunPanel";
import { MemorySubNav } from "./MemorySubNav";

const Markdown = dynamic(
  () => import("@/components/chat/Markdown").then((m) => m.Markdown),
  { ssr: false },
);

type ViewMode = "rendered" | "lines";

export interface MemoryDocWorkbenchProps {
  layer: MemoryLayer;
  initialKey?: string;
  /** Entry id (``m_xxx``) to scroll to + flash after render. Deep-link
   * contract: ``?focus=m_xxx`` from the resolver page. */
  initialFocus?: string;
}

export function MemoryDocWorkbench({
  layer,
  initialKey,
  initialFocus,
}: MemoryDocWorkbenchProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const router = useRouter();
  const keys: string[] = layer === "L2" ? [...SURFACES] : [...L3_SLOTS];
  const [docKey, setDocKey] = useState<string>(
    initialKey && keys.includes(initialKey) ? initialKey : keys[0],
  );

  useEffect(() => {
    if (initialKey && keys.includes(initialKey)) setDocKey(initialKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialKey]);

  const [overview, setOverview] = useState<Record<string, DocOverview>>({});
  const [content, setContent] = useState("");
  const [docVersion, setDocVersion] = useState("");
  const [docLoading, setDocLoading] = useState(true);
  const [lines, setLines] = useState<LineRow[]>([]);
  const [view, setView] = useState<ViewMode>("rendered");
  const [editing, setEditing] = useState(false);
  const [editorValue, setEditorValue] = useState("");
  const [saving, setSaving] = useState(false);
  // Focus is one-shot — once we've scrolled + flashed the anchor we don't
  // want later reloads (e.g. after a run) to re-scroll.
  const [pendingFocus, setPendingFocus] = useState<string | null>(
    initialFocus ?? null,
  );
  const previewRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (initialFocus) setPendingFocus(initialFocus);
  }, [initialFocus]);

  const loadOverview = useCallback(async () => {
    try {
      const data = await getOverview();
      const map: Record<string, DocOverview> = {};
      for (const d of data.docs ?? []) {
        if (d.layer === layer) map[d.key] = d;
      }
      setOverview(map);
    } catch {
      // overview badges are best-effort
    }
  }, [layer]);

  const loadDoc = useCallback(async () => {
    setDocLoading(true);
    try {
      const data = await getDoc(layer, docKey);
      setContent(data?.content ?? "");
      setEditorValue(data?.content ?? "");
      setDocVersion(data?.version ?? "");
    } catch (e) {
      toast({
        variant: "destructive",
        title: t("Failed to load document"),
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setDocLoading(false);
    }
  }, [layer, docKey, setEditorValue, t, toast]);

  const loadLines = useCallback(async () => {
    try {
      setLines(await getDocLines(layer, docKey));
    } catch {
      setLines([]);
    }
  }, [layer, docKey]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);
  useEffect(() => {
    void loadDoc();
    void loadLines();
  }, [loadDoc, loadLines]);

  // Scroll-to + flash the focused entry once the markdown is in the DOM.
  // Markdown renders via a dynamic import → wait a frame so the anchor
  // span exists. Editing mode hides the preview, so skip then.
  useEffect(() => {
    if (!pendingFocus || editing || docLoading) return;
    if (!content || !previewRef.current) return;
    const anchorId = pendingFocus.startsWith("m_")
      ? pendingFocus
      : `m_${pendingFocus}`;
    let cancelled = false;
    const id = window.setTimeout(() => {
      if (cancelled) return;
      const span = document.getElementById(anchorId);
      const li = (span?.closest("li") as HTMLElement | null) ?? span;
      if (!li) return;
      li.scrollIntoView({ block: "center", behavior: "smooth" });
      const prev = {
        outline: li.style.outline,
        outlineOffset: li.style.outlineOffset,
        borderRadius: li.style.borderRadius,
        transition: li.style.transition,
      };
      li.style.outline = "2px solid var(--primary)";
      li.style.outlineOffset = "4px";
      li.style.borderRadius = "6px";
      li.style.transition = "outline-color 1.4s ease-out";
      const clearFlash = window.setTimeout(() => {
        li.style.outline = prev.outline;
        li.style.outlineOffset = prev.outlineOffset;
        li.style.borderRadius = prev.borderRadius;
        li.style.transition = prev.transition;
      }, 1800);
      setPendingFocus(null);
      return () => window.clearTimeout(clearFlash);
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, [pendingFocus, content, editing, docLoading]);

  const selectDoc = useCallback(
    (next: string) => {
      if (next === docKey) return;
      setDocKey(next);
      setEditing(false);
      // Reflect selection in the URL so refresh + share keep state.
      router.replace(
        layer === "L2" ? `/memory/l2/${next}` : `/memory/l3/${next}`,
      );
    },
    [docKey, layer, router],
  );

  const saveDoc = useCallback(async () => {
    setSaving(true);
    try {
      const result = await putDoc(layer, docKey, editorValue, docVersion);
      setContent(editorValue);
      setDocVersion(result.version);
      setEditing(false);
      toast({ variant: "success", title: t("Saved") });
      void loadLines();
      void loadOverview();
    } catch (e) {
      if (e instanceof MemoryVersionConflictError) {
        try {
          const latest = await getDoc(layer, docKey);
          setContent(latest.content);
          setDocVersion(latest.version);
        } catch {
          // Preserve the local editor text even if reloading the remote copy fails.
        }
      }
      toast({
        variant: "destructive",
        title:
          e instanceof MemoryVersionConflictError
            ? t("Memory changed in another session")
            : t("Save failed"),
        description:
          e instanceof MemoryVersionConflictError
            ? t("The latest version is shown in preview. Review your draft, then save again.")
            : e instanceof Error
              ? e.message
              : String(e),
      });
    } finally {
      setSaving(false);
    }
  }, [
    editorValue,
    docVersion,
    layer,
    docKey,
    setEditing,
    t,
    toast,
    loadLines,
    loadOverview,
  ]);

  const handleDocUpdated = useCallback(() => {
    void loadDoc();
    void loadLines();
    void loadOverview();
  }, [loadDoc, loadLines, loadOverview]);

  const labelFor = useCallback(
    (key: string) => {
      if (layer === "L2") {
        const meta = SURFACE_META[key as keyof typeof SURFACE_META];
        return meta ? t(meta.label) : key;
      }
      const meta = L3_META[key as keyof typeof L3_META];
      return meta ? t(meta.label) : key;
    },
    [layer, t],
  );

  const rendered = useMemo(
    () => prepareDocForRender(content, layer),
    [content, layer],
  );

  const LayerIcon = layer === "L2" ? Workflow : Network;

  return (
    <div className="mx-auto max-w-7xl px-6 py-8">
      <header className="mb-6">
        <h1 className="display flex items-center gap-2.5 text-2xl font-semibold text-foreground">
          <LayerIcon size={22} className="text-primary" />
          {layer === "L2"
            ? t("L2 · Per-surface summaries")
            : t("L3 · Cross-surface knowledge")}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {layer === "L2"
            ? t(
                "Surface-specific facts extracted from your traces. Edit raw, or let the consolidator Update / Audit / Dedup each doc.",
              )
            : t(
                "Cross-surface synthesis: profile, recent timeline, knowledge scope. Hedged claims with L2 evidence.",
              )}
        </p>
        <div className="mt-4">
          <MemorySubNav />
        </div>
      </header>

      <div className="grid items-start gap-5 lg:grid-cols-[210px_minmax(0,1fr)] xl:grid-cols-[210px_minmax(0,1fr)_360px]">
        {/* Doc rail */}
        <Card className="p-2">
          <ul className="space-y-0.5">
            {keys.map((key) => {
              const doc = overview[key];
              const active = key === docKey;
              return (
                <li key={key}>
                  <button
                    type="button"
                    onClick={() => selectDoc(key)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors duration-150",
                      active
                        ? "bg-muted text-foreground"
                        : "text-muted-foreground hover:bg-muted-subtle hover:text-foreground",
                    )}
                  >
                    <span className="flex-1 truncate">{labelFor(key)}</span>
                    {doc?.backlog ? (
                      <Tooltip
                        content={
                          layer === "L2"
                            ? t("Workspace items added, changed, or removed since the last successful synthesis")
                            : t("L2 facts added, changed, or removed since the last successful synthesis")
                        }
                      >
                        <Badge variant="warning" className="px-1.5 text-[10px]">
                          {doc.backlog}
                        </Badge>
                      </Tooltip>
                    ) : doc?.exists ? (
                      <span className="rounded-full bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        {doc.entry_count}
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </Card>

        {/* Viewer / editor */}
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-3">
              <Tabs
                value={view}
                onValueChange={(v) => setView(v as ViewMode)}
              >
                <TabsList>
                  <TabsTrigger value="rendered">
                    <FileText size={13} />
                    {t("Rendered")}
                  </TabsTrigger>
                  <TabsTrigger value="lines">
                    <Hash size={13} />
                    {t("Line numbers")}
                  </TabsTrigger>
                </TabsList>
              </Tabs>
              {overview[docKey]?.updated_at && (
                <span className="text-[11px] text-muted-foreground">
                  {t("updated {{ts}}", {
                    ts: formatTimestamp(overview[docKey].updated_at),
                  })}
                </span>
              )}
            </div>
            {!editing ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setEditing(true)}
              >
                <Pencil size={13} />
                {t("Edit raw")}
              </Button>
            ) : (
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setEditorValue(content);
                    setEditing(false);
                  }}
                >
                  {t("Cancel")}
                </Button>
                <Button
                  size="sm"
                  onClick={() => void saveDoc()}
                  loading={saving}
                >
                  {!saving && <Save size={13} />}
                  {t("Save")}
                </Button>
              </div>
            )}
          </div>

          <Card className="min-h-[320px] p-5" >
            <div ref={previewRef}>
              {docLoading ? (
                <div className="space-y-2">
                  {[0, 1, 2, 3, 4].map((i) => (
                    <Skeleton key={i} className="h-4 w-full" />
                  ))}
                </div>
              ) : editing ? (
                <textarea
                  value={editorValue}
                  onChange={(e) => setEditorValue(e.target.value)}
                  spellCheck={false}
                  className="min-h-[420px] w-full resize-y rounded-lg border border-input bg-background p-3 font-mono text-xs leading-6 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              ) : view === "lines" ? (
                <LineNumberedView lines={lines} />
              ) : content.trim().length > 0 ? (
                // The wrapper hides the default footnote backref arrow so
                // the only clickable element per footnote is the L1 link
                // we inject in prepareDocForRender.
                <div className="prose-cognivoy text-sm [&_.data-footnote-backref]:hidden">
                  <Markdown content={rendered} />
                </div>
              ) : (
                <EmptyState
                  icon={FileText}
                  title={t("Empty doc")}
                  description={t(
                    "Click Update in the LLM workspace to extract facts from your traces.",
                  )}
                />
              )}
            </div>
          </Card>
        </section>

        {/* LLM workspace */}
        <aside className="lg:col-span-2 xl:col-span-1">
          <MemoryRunPanel
            layer={layer}
            docKey={docKey}
            onRunComplete={handleDocUpdated}
            onDocUpdated={handleDocUpdated}
          />
        </aside>
      </div>
    </div>
  );
}

// ── Line-numbered view ───────────────────────────────────────────────

function LineNumberedView({ lines }: { lines: LineRow[] }) {
  const { t } = useTranslation();
  if (lines.length === 0) {
    return (
      <EmptyState
        icon={Hash}
        title={t("Empty doc")}
        description={t("Nothing to show — the doc has no lines yet.")}
      />
    );
  }
  const width = Math.max(2, String(lines[lines.length - 1].number).length);
  return (
    <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-xs leading-relaxed text-foreground">
      {lines.map((line) => {
        const num = String(line.number).padStart(width, " ");
        const muted = line.kind === "blank" || line.kind === "title";
        return (
          <div
            key={line.number}
            id={line.entry_id ?? undefined}
            className={muted ? "text-muted-foreground" : "text-foreground"}
          >
            <span className="select-none pr-3 text-muted-foreground">
              {num}:
            </span>
            {line.text || " "}
          </div>
        );
      })}
    </pre>
  );
}
