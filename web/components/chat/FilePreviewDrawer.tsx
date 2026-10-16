"use client";

import * as React from "react";
import { Download, ExternalLink, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { MessageAttachment } from "@/lib/chat-types";
import { apiFetch } from "@/lib/api";
import { docIconFor } from "@/lib/doc-attachments";
import { readResponseBytes, trustedPreviewUrl } from "@/lib/file-preview";
import { normalizePptxPreview, type PptxPreviewPayload } from "@/lib/pptx-preview";

function sourceUrl(source: MessageAttachment): string | null {
  if (source.url && typeof window !== "undefined") {
    return trustedPreviewUrl(source.url, window.location.origin);
  }
  if (source.base64) return `data:${source.mime_type || "application/octet-stream"};base64,${source.base64}`;
  return null;
}

function previewKind(source: MessageAttachment): "image" | "pdf" | "docx" | "xlsx" | "pptx" | "text" | "fallback" {
  const name = (source.filename || "").toLowerCase();
  const mime = source.mime_type || "";
  if (source.type === "image" || mime.startsWith("image/") || /\.(png|jpe?g|gif|webp|svg)$/.test(name)) return "image";
  if (mime === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  if (/\.docx?$/.test(name) || mime.includes("wordprocessingml")) return "docx";
  if (/\.xlsx?$/.test(name) || mime.includes("spreadsheetml")) return "xlsx";
  if (name.endsWith(".pptx") || mime.includes("presentationml")) return "pptx";
  if (source.extracted_text || mime.startsWith("text/") || /\.(txt|md|csv|tsv|json|ya?ml|js|jsx|ts|tsx|py|go|rs|java|css|html|log)$/.test(name)) return "text";
  return "fallback";
}

function PptxPreview({ source }: { source: MessageAttachment }) {
  const { t } = useTranslation();
  const [deck, setDeck] = React.useState<PptxPreviewPayload | null>(null);
  const [error, setError] = React.useState("");
  const slideUrl = source.slide_preview_url;
  React.useEffect(() => {
    if (!slideUrl) return;
    const controller = new AbortController();
    void apiFetch(slideUrl, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const normalized = normalizePptxPreview(await response.json());
        if (!normalized) throw new Error(t("Invalid slide preview response"));
        setDeck(normalized);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => controller.abort();
  }, [slideUrl, t]);
  React.useEffect(() => {
    if (!deck || !source.preview_page) return;
    const target = document.querySelector(
      `[data-testid="pptx-slide"][data-slide-number="${source.preview_page}"]`,
    );
    target?.scrollIntoView({ block: "start" });
  }, [deck, source.preview_page]);

  const previewError = !slideUrl ? t("Structured slide preview is unavailable.") : error;
  if (previewError) {
    return (
      <div className="flex h-full flex-col">
        <p role="alert" className="border-b border-border px-5 py-3 text-xs text-warning-foreground">
          {t("The visual preview failed. Showing model-readable text instead.")} {previewError}
        </p>
        <div className="min-h-0 flex-1"><TextPreview source={source} url={source.text_preview_url || null} /></div>
      </div>
    );
  }
  if (!deck) return <p className="p-6 text-sm text-muted-foreground">{t("Loading slide preview…")}</p>;
  return (
    <div className="h-full overflow-auto p-5" data-testid="pptx-slide-preview">
      <p className="mb-4 text-xs text-muted-foreground">
        {t("{{count}} slides · layout-preserving preview", { count: deck.slide_count })}
        {deck.truncated ? ` · ${t("Preview truncated for safety")}` : ""}
      </p>
      <div className="space-y-5">
        {deck.slides.map((slide) => (
          <figure key={slide.number} className="surface overflow-hidden rounded-xl bg-card p-3" data-testid="pptx-slide" data-slide-number={slide.number}>
            <div className="relative overflow-hidden rounded-md border border-border bg-background" style={{ aspectRatio: `${deck.width} / ${deck.height}` }}>
              {slide.shapes.map((shape, index) => (
                <div key={`${shape.kind}-${index}`} className="absolute overflow-hidden" style={{ left: `${shape.x * 100}%`, top: `${shape.y * 100}%`, width: `${shape.width * 100}%`, height: `${shape.height * 100}%` }}>
                  {shape.kind === "image" && shape.data_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={shape.data_url} alt="" className="h-full w-full object-contain" />
                  ) : shape.kind === "text" ? (
                    <span className="block whitespace-pre-wrap text-[clamp(6px,1.4vw,15px)] leading-tight text-foreground">{shape.text}</span>
                  ) : null}
                </div>
              ))}
            </div>
            <figcaption className="pt-2 text-center text-xs text-muted-foreground">{t("Slide {{number}}", { number: slide.number })}</figcaption>
          </figure>
        ))}
      </div>
      {source.text_preview_url && (
        <details className="mt-5 rounded-xl border border-border bg-card p-3">
          <summary className="cursor-pointer text-sm text-foreground">{t("Model-readable slide text")}</summary>
          <div className="mt-3 max-h-80 overflow-auto"><TextPreview source={source} url={source.text_preview_url} /></div>
        </details>
      )}
    </div>
  );
}

function BinaryOfficePreview({ source, url, kind }: { source: MessageAttachment; url: string; kind: "docx" | "xlsx" }) {
  const { t } = useTranslation();
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const [error, setError] = React.useState("");
  React.useEffect(() => {
    const controller = new AbortController();
    const host = hostRef.current;
    if (!host) return;
    host.replaceChildren();
    void apiFetch(url, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return readResponseBytes(
          response,
          25 * 1024 * 1024,
          t("File is too large to preview"),
        );
      })
      .then(async (bytes) => {
        if (controller.signal.aborted) return;
        const buffer = bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer;
        if (kind === "docx") {
          const { renderAsync } = await import("docx-preview");
          if (!controller.signal.aborted && hostRef.current) {
            await renderAsync(buffer, hostRef.current, undefined, { inWrapper: true, ignoreWidth: false, ignoreHeight: false });
          }
          return;
        }
        const { default: ExcelJS } = await import("exceljs");
        const workbook = new ExcelJS.Workbook();
        // ExcelJS' browser build accepts ArrayBuffer at runtime, but its
        // declarations still expose Node's Buffer-only signature.
        const loadWorkbook = workbook.xlsx.load as unknown as (
          input: ArrayBuffer,
        ) => Promise<unknown>;
        await loadWorkbook.call(workbook.xlsx, buffer);
        if (controller.signal.aborted || !hostRef.current) return;
        for (const sheet of workbook.worksheets) {
          const section = document.createElement("section");
          section.className = "mb-6 overflow-auto";
          const heading = document.createElement("h3");
          heading.className = "sticky left-0 mb-2 text-sm font-medium text-foreground";
          heading.textContent = sheet.name;
          section.appendChild(heading);
          const table = document.createElement("table");
          table.className = "border-collapse text-xs text-foreground";
          sheet.eachRow({ includeEmpty: true }, (row) => {
            const tr = document.createElement("tr");
            row.eachCell({ includeEmpty: true }, (cell) => {
              const td = document.createElement("td");
              td.className = "max-w-72 border border-border px-2 py-1 align-top";
              td.textContent = cell.text;
              tr.appendChild(td);
            });
            table.appendChild(tr);
          });
          section.appendChild(table);
          hostRef.current.appendChild(section);
        }
        return;
      })
      .then(() => {
        if (controller.signal.aborted || !hostRef.current) return;
        const needle = (source.preview_focus_text || source.preview_section || "").trim().slice(0, 120);
        if (!needle) return;
        const candidates = hostRef.current.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li,td,th,span");
        const target = Array.from(candidates).find((node) => node.textContent?.includes(needle));
        if (target instanceof HTMLElement) {
          target.classList.add("rounded", "outline", "outline-2", "outline-primary", "bg-primary-muted");
          target.scrollIntoView({ block: "center" });
        }
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => controller.abort();
  }, [kind, source.preview_focus_text, source.preview_section, t, url]);
  if (error) return <p className="p-6 text-sm text-destructive">{error}</p>;
  return <div ref={hostRef} className="h-full overflow-auto bg-white p-5 text-black dark:bg-neutral-100" />;
}

function TextPreview({ source, url }: { source: MessageAttachment; url: string | null }) {
  const [text, setText] = React.useState(source.extracted_text || "");
  const [error, setError] = React.useState("");
  React.useEffect(() => {
    if (source.extracted_text || !url) return;
    const controller = new AbortController();
    void apiFetch(url, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return readResponseBytes(response, 8 * 1024 * 1024);
      })
      .then((bytes) => setText(new TextDecoder().decode(bytes)))
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => controller.abort();
  }, [source.extracted_text, url]);
  if (error) return <p className="p-6 text-sm text-destructive">{error}</p>;
  return <pre className="h-full overflow-auto whitespace-pre-wrap p-5 font-mono text-xs leading-relaxed text-foreground">{text}</pre>;
}

export default function FilePreviewDrawer({ source, onClose }: { source: MessageAttachment; onClose: () => void }) {
  const { t } = useTranslation();
  const filename = source.filename || t("Attachment");
  const url = sourceUrl(source);
  const kind = previewKind(source);
  const { Icon, tint } = docIconFor(filename);
  React.useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [onClose]);
  return (
    <aside role="dialog" aria-modal="true" aria-label={t("File preview: {{name}}", { name: filename })} className="fixed inset-y-0 right-0 z-[100] flex w-full flex-col border-l border-border bg-card shadow-overlay md:w-[min(620px,92vw)]">
      <header className="flex items-center gap-3 border-b border-border px-4 py-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted"><Icon size={17} className={tint} /></span>
        <div className="min-w-0 flex-1"><h2 className="truncate text-sm font-medium text-foreground">{filename}</h2><p className="text-xs text-muted-foreground">{source.mime_type || source.type || t("File")}</p></div>
        {url && <a href={url} target="_blank" rel="noreferrer" aria-label={t("Open")} className="rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-foreground"><ExternalLink size={15} /></a>}
        {url && <a href={url} download={filename} aria-label={t("Download")} className="rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-foreground"><Download size={15} /></a>}
        <button type="button" onClick={onClose} aria-label={t("Close")} className="rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-foreground"><X size={16} /></button>
      </header>
      {(source.preview_page || source.preview_section) && (
        <div className="border-b border-border bg-primary-muted px-4 py-2 text-xs text-foreground" data-testid="file-preview-location">
          {source.preview_page ? `${t("Page")} ${source.preview_page}` : ""}
          {source.preview_page && source.preview_section ? " · " : ""}
          {source.preview_section || ""}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-hidden bg-background">
        {kind === "image" && url ? (
          <div className="flex h-full items-center justify-center overflow-auto p-5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={url} alt={filename} className="max-h-full max-w-full object-contain" />
          </div>
        ) : kind === "pdf" && url ? (
          <iframe src={url} title={filename} className="h-full w-full border-0" />
        ) : (kind === "docx" || kind === "xlsx") && url ? (
          <BinaryOfficePreview source={source} url={url} kind={kind} />
        ) : kind === "pptx" ? (
          <PptxPreview source={source} />
        ) : kind === "text" ? (
          <TextPreview source={source} url={url} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center"><Icon size={36} className={tint} /><p className="text-sm text-muted-foreground">{t("Preview isn't available for this file type.")}</p>{url && <a href={url} download={filename} className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground">{t("Download")}</a>}</div>
        )}
      </div>
    </aside>
  );
}
