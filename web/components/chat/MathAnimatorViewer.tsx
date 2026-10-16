"use client";

import * as React from "react";
import {
  Code2,
  Captions,
  Download,
  Pencil,
  Expand,
  Image as ImageIcon,
  Repeat2,
  Video,
  Volume2,
  VolumeX,
  WandSparkles,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { apiUrl } from "@/lib/api";
import type { MathAnimatorResult } from "@/lib/math-animator-types";
import {
  normalizePlaybackRate,
  resolveMathAnimatorDownloads,
} from "@/lib/math-animator-playback";
import {
  downloadTextAsset,
  downloadUrlAsset,
} from "@/lib/visualization-assets";
import { rerenderMathAnimatorSource } from "@/lib/math-animator-api";

function assetUrl(url: string): string {
  return /^https?:\/\//i.test(url) ? url : apiUrl(url);
}

export default function MathAnimatorViewer({
  result: initialResult,
  parentTurnId,
}: {
  result: MathAnimatorResult;
  parentTurnId?: string;
}) {
  const { t } = useTranslation();
  const [renderedResult, setRenderedResult] = React.useState(initialResult);
  const result = renderedResult;
  const [fullscreenUrl, setFullscreenUrl] = React.useState<string | null>(null);
  const [showCode, setShowCode] = React.useState(
    result.render.show_code === true,
  );
  const [playbackRate, setPlaybackRate] = React.useState(1);
  const [loop, setLoop] = React.useState(false);
  const [muted, setMuted] = React.useState(false);
  const [captions, setCaptions] = React.useState(Boolean(result.render.subtitles_url));
  const [editingCode, setEditingCode] = React.useState(false);
  const [codeDraft, setCodeDraft] = React.useState(result.code.content);
  const [rerendering, setRerendering] = React.useState(false);
  const [rerenderError, setRerenderError] = React.useState<string | null>(null);
  const videoRefs = React.useRef<Array<HTMLVideoElement | null>>([]);
  const videos = result.artifacts.filter((artifact) => artifact.type === "video");
  const images = result.artifacts.filter((artifact) => artifact.type === "image");
  const downloads = resolveMathAnimatorDownloads(result);

  const applyPlayback = (
    next: { rate?: number; loop?: boolean; muted?: boolean },
  ) => {
    for (const video of videoRefs.current) {
      if (!video) continue;
      if (next.rate !== undefined) video.playbackRate = next.rate;
      if (next.loop !== undefined) video.loop = next.loop;
      if (next.muted !== undefined) video.muted = next.muted;
    }
  };

  const applyCaptions = (enabled: boolean) => {
    for (const video of videoRefs.current) {
      if (!video) continue;
      for (const track of Array.from(video.textTracks)) {
        track.mode = enabled ? "showing" : "disabled";
      }
    }
  };

  const download = (item: (typeof downloads)[number]) => {
    if (item.kind === "code") {
      downloadTextAsset({
        filename: item.filename,
        mimeType: "text/x-python;charset=utf-8",
        content: item.content,
      });
      return;
    }
    downloadUrlAsset(assetUrl(item.url), item.filename);
  };

  const rerender = async () => {
    if (!parentTurnId || !codeDraft.trim() || rerendering) return;
    setRerendering(true);
    setRerenderError(null);
    try {
      const next = await rerenderMathAnimatorSource({
        parent_turn_id: parentTurnId,
        code: codeDraft,
        output_mode: result.output_mode,
        quality:
          result.render.quality === "low" || result.render.quality === "high"
            ? result.render.quality
            : "medium",
        width: result.render.width,
        height: result.render.height,
        fps: result.render.fps,
      });
      setRenderedResult(next);
      setEditingCode(false);
    } catch (error) {
      setRerenderError(error instanceof Error ? error.message : String(error));
    } finally {
      setRerendering(false);
    }
  };

  React.useEffect(() => {
    if (!fullscreenUrl) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFullscreenUrl(null);
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [fullscreenUrl]);

  return (
    <div className="surface space-y-4 p-3" data-math-animator-viewer="true">
      {videos.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted-subtle p-2 text-xs text-muted-foreground">
          <label className="flex items-center gap-2">
            <span>{t("Playback speed")}</span>
            <select
              aria-label={t("Playback speed")}
              value={playbackRate}
              onChange={(event) => {
                const value = normalizePlaybackRate(Number(event.target.value));
                setPlaybackRate(value);
                applyPlayback({ rate: value });
              }}
              className="rounded-md border border-input bg-card px-2 py-1 text-foreground"
            >
              {[0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => <option key={rate} value={rate}>{rate}×</option>)}
            </select>
          </label>
          <button
            type="button"
            aria-pressed={loop}
            onClick={() => {
              const value = !loop;
              setLoop(value);
              applyPlayback({ loop: value });
            }}
            className="inline-flex items-center gap-1 rounded-md border border-input bg-card px-2 py-1 text-foreground"
          >
            <Repeat2 size={13} /> {t("Loop")}
          </button>
          <button
            type="button"
            aria-pressed={muted}
            onClick={() => {
              const value = !muted;
              setMuted(value);
              applyPlayback({ muted: value });
            }}
            className="inline-flex items-center gap-1 rounded-md border border-input bg-card px-2 py-1 text-foreground"
          >
            {muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
            {muted ? t("Unmute") : t("Mute")}
          </button>
          {result.render.subtitles_url && (
            <button
              type="button"
              aria-pressed={captions}
              onClick={() => {
                const value = !captions;
                setCaptions(value);
                applyCaptions(value);
              }}
              className="inline-flex items-center gap-1 rounded-md border border-input bg-card px-2 py-1 text-foreground"
            >
              <Captions size={13} /> {captions ? t("Hide captions") : t("Show captions")}
            </button>
          )}
        </div>
      )}
      {videos.map((artifact, index) => (
        <section key={artifact.url} className="space-y-2">
          <div className="flex items-center gap-2 text-xs font-medium text-foreground">
            <Video size={14} /> {t("Video Output")}
            <button type="button" onClick={() => downloadUrlAsset(assetUrl(artifact.url), artifact.filename)} className="ml-auto inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-muted-foreground">
              <Download size={12} /> {t("Download video")}
            </button>
          </div>
          <video
            ref={(node) => { videoRefs.current[index] = node; }}
            controls
            playsInline
            preload="metadata"
            loop={loop}
            muted={muted}
            onLoadedMetadata={(event) => {
              event.currentTarget.playbackRate = playbackRate;
              for (const track of Array.from(event.currentTarget.textTracks)) {
                track.mode = captions ? "showing" : "disabled";
              }
            }}
            className="aspect-video w-full rounded-xl bg-black object-contain"
            src={assetUrl(artifact.url)}
          >
            {result.render.subtitles_url && (
              <track
                kind="captions"
                src={assetUrl(result.render.subtitles_url)}
                srcLang={result.render.subtitles_language || "en"}
                label={t("Captions")}
                default={captions}
              />
            )}
          </video>
        </section>
      ))}
      {images.length > 0 && (
        <section className="space-y-2">
          <div className="flex items-center gap-2 text-xs font-medium text-foreground">
            <ImageIcon size={14} /> {t("Image Output")}
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {images.map((artifact) => (
              <div key={artifact.url} className="group relative overflow-hidden rounded-xl border border-border bg-background">
                <button type="button" onClick={() => setFullscreenUrl(assetUrl(artifact.url))} className="block w-full">
                {/* Generated assets can be local API URLs, so next/image cannot
                    know their dimensions or remote host at build time. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={assetUrl(artifact.url)}
                  alt={artifact.label || artifact.filename}
                  className="max-h-80 w-full object-contain"
                />
                <span className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-md bg-black/60 px-2 py-1 text-[11px] text-white opacity-0 transition-opacity group-hover:opacity-100">
                  <Expand size={12} /> {t("Fullscreen")}
                </span>
                </button>
                <button type="button" onClick={() => downloadUrlAsset(assetUrl(artifact.url), artifact.filename)} className="absolute bottom-2 right-2 inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-[11px] text-muted-foreground">
                  <Download size={12} /> {t("Download image")}
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
      {result.code.content && (
        <details
          open={showCode}
          onToggle={(event) => setShowCode(event.currentTarget.open)}
          className="overflow-hidden rounded-xl border border-border bg-background"
        >
          <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-xs font-medium text-foreground">
            <Code2 size={14} /> {t("View Manim Code")}
          </summary>
          {editingCode ? (
            <textarea
              aria-label={t("Manim source code")}
              value={codeDraft}
              onChange={(event) => setCodeDraft(event.target.value)}
              spellCheck={false}
              className="min-h-72 w-full resize-y border-t border-border bg-background p-3 font-mono text-xs leading-relaxed text-foreground outline-none focus:ring-2 focus:ring-ring"
            />
          ) : (
            <pre className="max-h-96 overflow-auto border-t border-border p-3 font-mono text-xs leading-relaxed text-foreground">
              {result.code.content}
            </pre>
          )}
          {rerenderError ? (
            <p className="border-t border-destructive-border bg-destructive-muted px-3 py-2 text-xs text-destructive" role="alert">
              {rerenderError}
            </p>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2 border-t border-border p-2">
            {editingCode ? (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setCodeDraft(result.code.content);
                    setEditingCode(false);
                    setRerenderError(null);
                  }}
                  disabled={rerendering}
                  className="rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground"
                >
                  {t("Cancel")}
                </button>
                <button
                  type="button"
                  onClick={() => void rerender()}
                  disabled={!parentTurnId || !codeDraft.trim() || rerendering}
                  className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-xs text-primary-foreground disabled:opacity-50"
                >
                  <Repeat2 size={12} />
                  {rerendering ? t("Rendering…") : t("Render edited source")}
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setCodeDraft(result.code.content);
                  setEditingCode(true);
                }}
                disabled={!parentTurnId}
                title={!parentTurnId ? t("Source editing is unavailable for this saved result.") : undefined}
                className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground disabled:opacity-50"
              >
                <Pencil size={12} /> {t("Edit source")}
              </button>
            )}
            <button type="button" onClick={() => {
              const code = downloads.find((item) => item.kind === "code");
              if (code) download(code);
            }} className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground">
              <Download size={12} /> {t("Download code")}
            </button>
          </div>
        </details>
      )}
      {result.artifacts.length === 0 && (
        <div className="rounded-xl border border-destructive-border bg-destructive-muted p-4" role="alert">
          <p className="text-sm font-medium text-destructive">{t("No rendered animation was produced")}</p>
          <p className="mt-1 text-xs text-destructive">{result.render.retry_history?.at(-1)?.error || t("The generated code is preserved for repair or retry.")}</p>
          <button type="button" onClick={() => window.dispatchEvent(new CustomEvent("dt:visualize-prompt", { detail: `Repair and render this Manim scene.\n\n${result.code.content}` }))} className="mt-3 inline-flex items-center gap-1 rounded-md border border-destructive-border bg-card px-2.5 py-1.5 text-xs text-foreground">
            <WandSparkles size={13} /> {t("Auto repair")}
          </button>
        </div>
      )}
      {result.render.retry_history && result.render.retry_history.length > 0 && (
        <details className="rounded-xl border border-border bg-background p-3 text-xs text-muted-foreground">
          <summary className="cursor-pointer font-medium text-foreground">{t("Render retry log")}</summary>
          <ol className="mt-2 space-y-1">{result.render.retry_history.map((entry) => <li key={entry.attempt}>{t("Attempt {{count}}", { count: entry.attempt })}: {entry.error}</li>)}</ol>
        </details>
      )}
      <div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground">
        {result.render.quality && <span>{t("Quality")}: {result.render.quality}</span>}
        {typeof result.render.retry_attempts === "number" && (
          <span>{t("Retries")}: {result.render.retry_attempts}</span>
        )}
        {result.render.subtitles_url && (
          <button type="button" onClick={() => downloadUrlAsset(assetUrl(result.render.subtitles_url!), "captions.vtt")} className="inline-flex items-center gap-1 underline underline-offset-2">
            <Download size={11} /> {t("Download captions")}
          </button>
        )}
      </div>
      {fullscreenUrl && (
        <button
          type="button"
          aria-label={t("Close")}
          className="fixed inset-0 z-[120] flex items-center justify-center bg-black/85 p-6"
          onClick={() => setFullscreenUrl(null)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={fullscreenUrl} alt={t("Fullscreen math animation output")} className="max-h-full max-w-full object-contain" />
        </button>
      )}
    </div>
  );
}
