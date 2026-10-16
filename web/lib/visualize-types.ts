import type { MathAnimatorResult } from "@/lib/math-animator-types";
import { extractMathAnimatorResult } from "@/lib/math-animator-types";

export type VisualizeTextRenderType = "svg" | "chartjs" | "mermaid" | "html";
export type VisualizeManimRenderType = "manim_video" | "manim_image";
export type VisualizeRenderType =
  | VisualizeTextRenderType
  | VisualizeManimRenderType;
export type VisualizeRenderMode = "auto" | VisualizeRenderType;

export interface VisualizeFormConfig {
  render_mode: VisualizeRenderMode;
  // Only consumed by the backend when the resolved render_type ends up
  // being manim_video / manim_image. Ignored on text-only paths but kept
  // in form state so toggling between modes preserves the user's choice.
  quality: "low" | "medium" | "high";
  style_hint: string;
  aspect_ratio: "auto" | "16:9" | "4:3" | "1:1" | "9:16";
  theme: "auto" | "light" | "dark";
  width?: number;
  height?: number;
  duration_seconds?: number;
  fps: number;
  show_code: boolean;
  parameters: Record<string, string | number | boolean | null>;
}

export const DEFAULT_VISUALIZE_CONFIG: VisualizeFormConfig = {
  render_mode: "auto",
  quality: "medium",
  style_hint: "",
  aspect_ratio: "auto",
  theme: "auto",
  fps: 30,
  show_code: true,
  parameters: {},
};

export function buildVisualizeWSConfig(
  cfg: VisualizeFormConfig,
): Record<string, unknown> {
  return {
    render_mode: cfg.render_mode,
    quality: cfg.quality,
    style_hint: cfg.style_hint.trim(),
    aspect_ratio: cfg.aspect_ratio,
    theme: cfg.theme,
    ...(cfg.width != null && cfg.height != null
      ? { width: cfg.width, height: cfg.height }
      : {}),
    ...(cfg.duration_seconds != null
      ? { duration_seconds: cfg.duration_seconds }
      : {}),
    fps: cfg.fps,
    show_code: cfg.show_code,
    parameters: cfg.parameters,
  };
}

export function buildMathAnimatorWSConfig(
  cfg: VisualizeFormConfig,
): Record<string, unknown> {
  const common = buildVisualizeWSConfig(cfg);
  const renderConfig = { ...common };
  delete renderConfig.render_mode;
  return {
    ...renderConfig,
    output_mode: cfg.render_mode === "manim_image" ? "image" : "video",
  };
}

const VISUALIZE_RENDER_LABELS: Record<VisualizeRenderMode, string> = {
  auto: "Auto",
  chartjs: "Chart.js",
  svg: "SVG",
  mermaid: "Mermaid",
  html: "HTML",
  manim_video: "Animation",
  manim_image: "Storyboard",
};

export function isManimRenderType(
  renderType: string,
): renderType is VisualizeManimRenderType {
  return renderType === "manim_video" || renderType === "manim_image";
}

export function isManimResult(
  result: VisualizeResult,
): result is VisualizeManimResult {
  return isManimRenderType(result.render_type);
}

/**
 * One-line summary of the visualize form, shown next to the collapsed
 * `Settings` chevron in the composer. Pass `translate` (typically the
 * `t` function from `react-i18next`) so the summary follows the active
 * UI language.
 */
export function summarizeVisualizeConfig(
  cfg: VisualizeFormConfig,
  translate?: (key: string) => string,
): string {
  const label = VISUALIZE_RENDER_LABELS[cfg.render_mode] ?? cfg.render_mode;
  const text = translate ? translate(label) : label;
  // For manim modes, surface the quality tier alongside the format —
  // matches what users were used to in the old Animator panel.
  if (cfg.render_mode === "manim_video" || cfg.render_mode === "manim_image") {
    const qLabel = cfg.quality.charAt(0).toUpperCase() + cfg.quality.slice(1);
    const q = translate ? translate(qLabel) : qLabel;
    return `${text} · ${q}`;
  }
  return text;
}

export interface VisualizeGeneration {
  status: "completed" | "failed" | "degraded";
  attempts?: number;
  simplified?: boolean;
  requested_render_type?: VisualizeTextRenderType;
  legacy_fallback?: boolean;
}

interface VisualizeTextResult {
  response: string;
  render_type: VisualizeTextRenderType;
  code: {
    language: string;
    content: string;
  };
  analysis: {
    render_type: string;
    description: string;
    data_description: string;
    chart_type: string;
    visual_elements: string[];
    rationale: string;
  };
  review: {
    optimized_code: string;
    changed: boolean;
    review_notes: string;
  };
  show_code?: boolean;
  generation?: VisualizeGeneration;
}

interface VisualizeManimResult {
  render_type: VisualizeManimRenderType;
  manim: MathAnimatorResult;
}

export type VisualizeResult = VisualizeTextResult | VisualizeManimResult;

function extractGeneration(
  metadata: Record<string, unknown>,
  renderType: VisualizeTextRenderType,
  source: string,
): VisualizeGeneration | undefined {
  const raw = metadata.generation;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    if (typeof record.status === "string" && ["completed", "failed", "degraded"].includes(record.status)) {
      const requestedType = record.requested_render_type;
      return {
        status: record.status as VisualizeGeneration["status"],
        ...(Number.isSafeInteger(record.attempts) && Number(record.attempts) >= 1 && Number(record.attempts) <= 2
          ? { attempts: Number(record.attempts) } : {}),
        ...(typeof record.simplified === "boolean" ? { simplified: record.simplified } : {}),
        ...(typeof requestedType === "string" && ["svg", "chartjs", "mermaid", "html"].includes(requestedType)
          ? { requested_render_type: requestedType as VisualizeTextRenderType } : {}),
      };
    }
  }

  // Older releases persisted a text-only HTML placeholder as a successful
  // visualization. Match the actual template AND its exact failure note, not
  // arbitrary lesson text mentioning a timeout or the word "fallback".
  const legacyNote = [
    "Generation timed out; showing a safe fallback.",
    "The model did not return a renderable HTML document.",
  ].some((note) => source.includes(`<div class="note"><strong>Note:</strong><br>${note}</div>`));
  if (renderType === "html" && legacyNote && source.includes('<div class="card">') && source.includes('<div class="summary">')) {
    return { status: "failed", legacy_fallback: true };
  }
  return undefined;
}

export function extractVisualizeResult(
  resultMetadata: Record<string, unknown> | undefined,
): VisualizeResult | null {
  if (!resultMetadata) return null;

  const renderType = resultMetadata.render_type;

  // Manim path: delegate decoding to math-animator-types so the existing
  // MathAnimatorViewer can render the artefacts unchanged.
  if (renderType === "manim_video" || renderType === "manim_image") {
    const manim = extractMathAnimatorResult(resultMetadata);
    if (!manim) return null;
    return { render_type: renderType, manim };
  }

  if (
    renderType !== "svg" &&
    renderType !== "chartjs" &&
    renderType !== "mermaid" &&
    renderType !== "html"
  )
    return null;

  const codeRaw =
    resultMetadata.code && typeof resultMetadata.code === "object"
      ? (resultMetadata.code as Record<string, unknown>)
      : {};

  const content = typeof codeRaw.content === "string" ? codeRaw.content : "";
  const generation = extractGeneration(resultMetadata, renderType, content);
  if (!content && (!generation || generation.status === "completed")) return null;

  return {
    response: String(resultMetadata.response ?? ""),
    render_type: renderType,
    code: {
      language: String(codeRaw.language ?? ""),
      content,
    },
    analysis:
      resultMetadata.analysis && typeof resultMetadata.analysis === "object"
        ? (resultMetadata.analysis as VisualizeTextResult["analysis"])
        : {
            render_type: renderType,
            description: "",
            data_description: "",
            chart_type: "",
            visual_elements: [],
            rationale: "",
          },
    review:
      resultMetadata.review && typeof resultMetadata.review === "object"
        ? (resultMetadata.review as VisualizeTextResult["review"])
        : { optimized_code: "", changed: false, review_notes: "" },
    show_code:
      typeof resultMetadata.show_code === "boolean"
        ? resultMetadata.show_code
        : undefined,
    ...(generation ? { generation } : {}),
  };
}
