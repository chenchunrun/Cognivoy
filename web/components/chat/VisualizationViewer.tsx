"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";
import {
  AlertTriangle,
  Check,
  Code2,
  Copy,
  Download,
  Maximize2,
  Pencil,
  RotateCcw,
  Table2,
  WandSparkles,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import DOMPurify from "dompurify";
import { useTranslation } from "react-i18next";

import {
  parseVisualizeBridgeMessage,
  prepareIframeHtml,
} from "@/lib/iframe-html";
import {
  initializeMermaid,
  renderMermaid,
  stripMermaidFence,
} from "@/lib/mermaid-render";
import { isManimResult, type VisualizeResult } from "@/lib/visualize-types";
import {
  buildVisualizationSourceDownload,
  downloadCanvasPng,
  downloadSvgPng,
  downloadTextAsset,
  parseChartDataTable,
} from "@/lib/visualization-assets";

const MathAnimatorViewer = dynamic(() => import("./MathAnimatorViewer"), {
  ssr: false,
});

function stripFence(source: string): string {
  return source.trim().replace(/^```(?:json|js|javascript)?\s*/i, "").replace(/\s*```$/, "");
}

function requestVisualRepair(renderType: string, source: string, error: string) {
  window.dispatchEvent(new CustomEvent("dt:visualize-prompt", {
    detail: `Repair this ${renderType} visualization. Preserve its teaching intent, fix the error, and return a corrected preview.\n\nError: ${error}\n\nSource:\n${source}`,
  }));
}

function RenderFailure({
  error,
  renderType,
  source,
  onEdit,
}: {
  error: string;
  renderType: string;
  source: string;
  onEdit: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="rounded-xl border border-destructive-border bg-destructive-muted p-4" role="alert">
      <p className="text-sm font-medium text-destructive">{t("Visualization could not be rendered")}</p>
      <p className="mt-1 whitespace-pre-wrap text-xs text-destructive">{error}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={() => requestVisualRepair(renderType, source, error)} className="inline-flex items-center gap-1 rounded-md border border-destructive-border bg-card px-2.5 py-1.5 text-xs text-foreground">
          <WandSparkles size={13} /> {t("Auto repair")}
        </button>
        <button type="button" onClick={onEdit} className="inline-flex items-center gap-1 rounded-md border border-destructive-border bg-card px-2.5 py-1.5 text-xs text-foreground">
          <Pencil size={13} /> {t("Edit source")}
        </button>
        <button type="button" onClick={() => requestVisualRepair("a different render type", source, error)} className="inline-flex items-center gap-1 rounded-md border border-destructive-border bg-card px-2.5 py-1.5 text-xs text-foreground">
          <RotateCcw size={13} /> {t("Change type")}
        </button>
      </div>
    </div>
  );
}

function ChartRenderer({ source, onEdit }: { source: string; onEdit: () => void }) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const chartRef = React.useRef<{ destroy: () => void } | null>(null);
  const [error, setError] = React.useState("");
  React.useEffect(() => {
    let cancelled = false;
    void import("chart.js/auto").then(({ default: Chart }) => {
      if (cancelled || !canvasRef.current) return;
      try {
        chartRef.current?.destroy();
        const config = JSON.parse(stripFence(source));
        chartRef.current = new Chart(canvasRef.current, config);
        setError("");
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    });
    return () => {
      cancelled = true;
      chartRef.current?.destroy();
      chartRef.current = null;
    };
  }, [source]);
  return error ? <RenderFailure error={error} renderType="Chart.js" source={source} onEdit={onEdit} /> : <canvas ref={canvasRef} />;
}

function MermaidRenderer({ source, onEdit }: { source: string; onEdit: () => void }) {
  const id = React.useId().replace(/:/g, "");
  const [svg, setSvg] = React.useState("");
  const [error, setError] = React.useState("");
  React.useEffect(() => {
    let cancelled = false;
    void import("mermaid").then(async ({ default: mermaid }) => {
      if (cancelled) return;
      try {
        initializeMermaid(mermaid, "neutral");
        const rendered = await renderMermaid(
          mermaid,
          `dt-${id}`,
          stripMermaidFence(source),
        );
        if (!cancelled) {
          setSvg(DOMPurify.sanitize(rendered, { USE_PROFILES: { svg: true, svgFilters: true } }));
          setError("");
        }
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      }
    });
    return () => { cancelled = true; };
  }, [id, source]);
  return error ? <RenderFailure error={error} renderType="Mermaid" source={source} onEdit={onEdit} /> : <div className="flex justify-center overflow-auto" dangerouslySetInnerHTML={{ __html: svg }} />;
}

function SvgRenderer({ source }: { source: string }) {
  const safe = React.useMemo(
    () => DOMPurify.sanitize(source, { USE_PROFILES: { svg: true, svgFilters: true } }),
    [source],
  );
  const onClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const prompt = (event.target as Element).closest?.("[data-prompt]")?.getAttribute("data-prompt")?.trim();
    if (prompt) window.dispatchEvent(new CustomEvent("dt:visualize-prompt", { detail: prompt }));
  };
  return <div className="flex justify-center overflow-auto" onClick={onClick} dangerouslySetInnerHTML={{ __html: safe }} />;
}

function FullscreenPreview({ label, onClose, children }: {
  label: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const dialogRef = React.useRef<HTMLDialogElement | null>(null);

  React.useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    // The native modal top layer also makes the chat inert and keeps keyboard
    // focus inside the preview, including controls in a sandboxed iframe.
    // Iframe Escape is forwarded separately through the scoped widget bridge.
    dialog.showModal();
    document.body.style.overflow = "hidden";
    return () => {
      dialog.close();
      document.body.style.overflow = previousOverflow;
      if (previouslyFocused?.isConnected) previouslyFocused.focus({ preventScroll: true });
    };
  }, []);

  // Both the portal and top layer are intentional: chat messages and their
  // zoom canvas have transformed/clipped ancestors that capture fixed layers.
  // The closed initial state is identical during SSR and hydration.
  if (typeof document === "undefined") return null;
  return createPortal(
    <dialog
      ref={dialogRef}
      aria-modal="true"
      aria-label={label}
      data-testid="visualization-fullscreen"
      className="fixed inset-0 m-0 h-dvh max-h-none w-screen max-w-none overflow-hidden border-0 bg-background p-3 text-foreground sm:p-4"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), iframe, [tabindex]:not([tabindex="-1"])',
        )).filter((element) => element.getClientRects().length > 0);
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey ? document.activeElement === first : document.activeElement === last) {
          event.preventDefault();
          (event.shiftKey ? last : first)?.focus({ preventScroll: true });
        }
      }}
    >
      <div className="flex h-full min-h-0 flex-col gap-2">
        <button type="button" autoFocus onClick={onClose} className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-card px-3 py-2 text-xs text-foreground"><X size={13} />{t("Close")}</button>
        {children}
      </div>
    </dialog>,
    document.body,
  );
}

function HtmlRenderer({ source }: { source: string }) {
  const { t } = useTranslation();
  const frameRef = React.useRef<HTMLIFrameElement | null>(null);
  const fullscreenFrameRef = React.useRef<HTMLIFrameElement | null>(null);
  const bridgeToken = React.useId();
  const prepared = React.useMemo(
    () => prepareIframeHtml(source, bridgeToken),
    [bridgeToken, source],
  );
  const [height, setHeight] = React.useState(560);
  const [fullscreen, setFullscreen] = React.useState(false);

  React.useEffect(() => {
    const receive = (event: MessageEvent<unknown>) => {
      const message = parseVisualizeBridgeMessage(event.data);
      if (!message || message.token !== bridgeToken) return;
      const fromFullscreen = event.source === fullscreenFrameRef.current?.contentWindow;
      if (!fromFullscreen && event.source !== frameRef.current?.contentWindow) return;
      if (message.type === "dt:visualize-escape") {
        if (fromFullscreen) setFullscreen(false);
      } else if (message.type === "dt:visualize-prompt") {
        window.dispatchEvent(
          new CustomEvent("dt:visualize-prompt", { detail: message.text }),
        );
      } else if (!fromFullscreen) {
        setHeight(message.height);
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [bridgeToken]);

  const frame = (isFullscreen = false) => (
    <iframe
      ref={isFullscreen ? fullscreenFrameRef : frameRef}
      title={t("HTML visualization")}
      sandbox="allow-scripts"
      srcDoc={prepared}
      style={isFullscreen ? undefined : { height }}
      className={isFullscreen ? "h-full w-full border-0 bg-card" : "w-full rounded-xl border-0 bg-card"}
    />
  );
  return (
    <div className="relative min-h-96">
      <button type="button" onClick={() => setFullscreen(true)} className="absolute right-2 top-2 z-10 inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-xs text-muted-foreground">
        <Maximize2 size={12} /> {t("Fullscreen")}
      </button>
      {frame()}
      {fullscreen && (
        <FullscreenPreview label={t("HTML visualization")} onClose={() => setFullscreen(false)}>
          <div className="min-h-0 flex-1 overflow-hidden rounded-xl bg-card">{frame(true)}</div>
        </FullscreenPreview>
      )}
    </div>
  );
}

function Rendered({ result, source, onEdit }: {
  result: Exclude<VisualizeResult, { render_type: "manim_video" | "manim_image" }>;
  source: string;
  onEdit: () => void;
}) {
  if (result.render_type === "chartjs") return <ChartRenderer source={source} onEdit={onEdit} />;
  if (result.render_type === "mermaid") return <MermaidRenderer source={source} onEdit={onEdit} />;
  if (result.render_type === "html") return <HtmlRenderer source={source} />;
  return <SvgRenderer source={source} />;
}

export default function VisualizationViewer({ result, parentTurnId }: { result: VisualizeResult; parentTurnId?: string }) {
  const { t } = useTranslation();
  const [showCode, setShowCode] = React.useState<boolean>(
    isManimResult(result) ? false : (result.show_code ?? false),
  );
  const [copied, setCopied] = React.useState(false);
  const [fullscreen, setFullscreen] = React.useState(false);
  const [source, setSource] = React.useState(isManimResult(result) ? "" : result.code.content);
  const [sourceDraft, setSourceDraft] = React.useState(source);
  const [editing, setEditing] = React.useState(false);
  const [showTable, setShowTable] = React.useState(false);
  const [zoom, setZoom] = React.useState(1);
  const canvasRootRef = React.useRef<HTMLDivElement | null>(null);
  if (isManimResult(result)) return <MathAnimatorViewer result={result.manim} parentTurnId={parentTurnId} />;
  if (result.generation && result.generation.status !== "completed") {
    const retry = () => {
      // Reuse the existing composer bridge. This prepares a prompt for review;
      // it never sends a message or starts a model call on the user's behalf.
      const description = typeof result.analysis.description === "string" ? result.analysis.description : "";
      const detail = typeof result.analysis.data_description === "string" ? result.analysis.data_description : "";
      const prompt = [
        t("Regenerate this visualization as a simpler, readable diagram. Preserve the learning goal and key relationships; do not replace the diagram with a text-only placeholder."),
        description.slice(0, 2000),
        detail.slice(0, 6000),
      ].filter(Boolean).join("\n\n");
      window.dispatchEvent(new CustomEvent("dt:visualize-prompt", { detail: prompt }));
    };
    return (
      <div className="rounded-xl border border-destructive-border bg-destructive-muted p-4" role="alert" data-testid="visualization-generation-failure">
        <p className="flex items-center gap-2 text-sm font-medium text-destructive"><AlertTriangle size={16} />{t("Visualization generation failed")}</p>
        <p className="mt-2 text-sm text-foreground">{t("This result is a text-only fallback, not a completed visualization. Generation timed out or did not produce valid visual content.")}</p>
        <button type="button" onClick={retry} className="mt-3 inline-flex items-center gap-1 rounded-md border border-destructive-border bg-card px-2.5 py-1.5 text-xs text-foreground"><RotateCcw size={13} />{t("Prepare visualization retry")}</button>
        <p className="mt-2 text-xs text-muted-foreground">{t("Review the retry prompt in the input box, then send it when ready.")}</p>
      </div>
    );
  }
  const copy = async () => {
    await navigator.clipboard.writeText(source);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  const beginEdit = () => {
    setSourceDraft(source);
    setEditing(true);
    setShowCode(true);
  };
  const rendered = <Rendered result={result} source={source} onEdit={beginEdit} />;
  const table = result.render_type === "chartjs" ? parseChartDataTable(source) : null;
  const downloadSource = () => {
    downloadTextAsset(buildVisualizationSourceDownload(result.render_type, source));
  };
  const downloadRendered = async () => {
    if (result.render_type === "chartjs") {
      const canvas = canvasRootRef.current?.querySelector<HTMLCanvasElement>('[data-visualization-canvas="true"] canvas');
      if (canvas) await downloadCanvasPng(canvas);
      return;
    }
    const svg = canvasRootRef.current?.querySelector<SVGElement>('[data-visualization-canvas="true"] svg');
    if (svg) {
      downloadTextAsset({
        filename: "visualization.svg",
        mimeType: "image/svg+xml;charset=utf-8",
        content: new XMLSerializer().serializeToString(svg),
      });
      return;
    }
    downloadSource();
  };
  const downloadRenderedPng = async () => {
    const svg = canvasRootRef.current?.querySelector<SVGElement>('[data-visualization-canvas="true"] svg');
    if (svg) await downloadSvgPng(svg);
  };
  return (
    <div className="space-y-3" data-visualization-viewer={result.render_type}>
      {result.generation?.simplified === true && (
        <p className="rounded-lg border border-warning-border bg-warning-muted px-3 py-2 text-xs text-warning" data-testid="visualization-simplified">{t("Generated a simplified visualization after retrying.")}</p>
      )}
      <div ref={canvasRootRef} className="relative overflow-auto rounded-xl border border-border bg-background p-3">
        {result.render_type !== "html" && (
          <button type="button" onClick={() => setFullscreen(true)} className="absolute right-2 top-2 z-10 inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-xs text-muted-foreground">
            <Maximize2 size={12} /> {t("Fullscreen")}
          </button>
        )}
        <div data-visualization-canvas="true" className="transition-transform" style={{ transform: `scale(${zoom})`, transformOrigin: "top center" }}>
          {rendered}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {result.render_type !== "html" && (
          <>
            <button type="button" onClick={() => setZoom((value) => Math.max(0.5, value - 0.25))} aria-label={t("Zoom out")} className="inline-flex items-center rounded-md border border-border p-1.5 text-muted-foreground"><ZoomOut size={13} /></button>
            <button type="button" onClick={() => setZoom((value) => Math.min(2, value + 0.25))} aria-label={t("Zoom in")} className="inline-flex items-center rounded-md border border-border p-1.5 text-muted-foreground"><ZoomIn size={13} /></button>
            <button type="button" onClick={() => setZoom(1)} className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground">{Math.round(zoom * 100)}%</button>
          </>
        )}
        <button type="button" onClick={() => setShowCode((value) => !value)} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground"><Code2 size={12} />{showCode ? t("Hide code") : t("Show code")}</button>
        <button type="button" onClick={() => void copy()} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground">{copied ? <Check size={12} /> : <Copy size={12} />}{copied ? t("Copied") : t("Copy code")}</button>
        <button type="button" onClick={beginEdit} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground"><Pencil size={12} />{t("Edit source")}</button>
        <button type="button" onClick={() => void downloadRendered()} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground"><Download size={12} />{result.render_type === "chartjs" ? t("Download PNG") : result.render_type === "html" ? t("Download HTML") : t("Download SVG")}</button>
        {(result.render_type === "svg" || result.render_type === "mermaid") && (
          <button type="button" onClick={() => void downloadRenderedPng()} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground"><Download size={12} />{t("Download PNG")}</button>
        )}
        {(result.render_type === "chartjs" || result.render_type === "mermaid") && (
          <button type="button" onClick={downloadSource} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground"><Code2 size={12} />{result.render_type === "chartjs" ? t("Download JSON") : t("Download Mermaid")}</button>
        )}
        {table && (
          <button type="button" aria-pressed={showTable} onClick={() => setShowTable((value) => !value)} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground"><Table2 size={12} />{t("Data table")}</button>
        )}
        <span className="ml-auto text-[10px] uppercase tracking-wider text-muted-foreground">{result.render_type}</span>
      </div>
      {showTable && table && (
        <div className="overflow-auto rounded-xl border border-border">
          <table className="w-full border-collapse text-left text-xs">
            <thead className="bg-muted-subtle text-foreground"><tr>{table.columns.map((column) => <th key={column} scope="col" className="border-b border-border px-3 py-2 font-medium">{column}</th>)}</tr></thead>
            <tbody>{table.rows.map((row, rowIndex) => <tr key={rowIndex} className="border-b border-border last:border-0">{row.map((value, cellIndex) => <td key={cellIndex} className="px-3 py-2 text-muted-foreground">{String(value ?? "")}</td>)}</tr>)}</tbody>
          </table>
        </div>
      )}
      {showCode && (
        editing ? (
          <div className="space-y-2 rounded-xl border border-border bg-code p-3">
            <textarea aria-label={t("Visualization source")} value={sourceDraft} onChange={(event) => setSourceDraft(event.target.value)} className="min-h-64 w-full resize-y bg-transparent font-mono text-xs leading-relaxed text-code-foreground outline-none" />
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => { setSourceDraft(source); setEditing(false); }} className="rounded-md border border-border px-3 py-1.5 text-xs text-code-foreground">{t("Cancel")}</button>
              <button type="button" onClick={() => { setSource(sourceDraft); setEditing(false); }} className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground">{t("Apply source")}</button>
            </div>
          </div>
        ) : <pre className="max-h-96 overflow-auto rounded-xl bg-code p-4 font-mono text-xs text-code-foreground"><code>{source}</code></pre>
      )}
      {fullscreen && result.render_type !== "html" && (
        <FullscreenPreview label={t("Fullscreen")} onClose={() => setFullscreen(false)}>
          <div tabIndex={0} className="min-h-0 flex-1 overflow-auto rounded-xl bg-card p-6">{rendered}</div>
        </FullscreenPreview>
      )}
    </div>
  );
}
