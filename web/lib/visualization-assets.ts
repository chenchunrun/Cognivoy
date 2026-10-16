import type { VisualizeTextRenderType } from "@/lib/visualize-types";

export interface VisualizationDownload {
  filename: string;
  mimeType: string;
  content: string;
}

export interface ChartDataTable {
  columns: string[];
  rows: Array<Array<string | number | boolean | null>>;
}

function stripFence(source: string): string {
  return source
    .trim()
    .replace(/^```(?:json|js|javascript|html|svg|mermaid)?\s*/i, "")
    .replace(/\s*```$/, "");
}

function cell(value: unknown): string | number | boolean | null {
  if (value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value ?? null;
  }
  return JSON.stringify(value);
}

export function parseChartDataTable(source: string): ChartDataTable | null {
  try {
    const config = JSON.parse(stripFence(source)) as {
      data?: { labels?: unknown[]; datasets?: Array<{ label?: unknown; data?: unknown[] }> };
    };
    const datasets = Array.isArray(config.data?.datasets) ? config.data.datasets : [];
    if (!datasets.length) return null;
    const labels = Array.isArray(config.data?.labels) ? config.data.labels : [];
    const rowCount = Math.max(labels.length, ...datasets.map((dataset) => dataset.data?.length ?? 0));
    if (rowCount === 0) return null;
    return {
      columns: [
        "Label",
        ...datasets.map((dataset, index) => String(dataset.label || `Series ${index + 1}`)),
      ],
      rows: Array.from({ length: rowCount }, (_, index) => [
        cell(labels[index] ?? index + 1),
        ...datasets.map((dataset) => cell(dataset.data?.[index])),
      ]),
    };
  } catch {
    return null;
  }
}

export function buildVisualizationSourceDownload(
  renderType: VisualizeTextRenderType,
  source: string,
): VisualizationDownload {
  if (renderType === "chartjs") {
    let content = stripFence(source);
    try {
      content = JSON.stringify(JSON.parse(content), null, 2);
    } catch {
      // Preserve invalid source so users can diagnose or repair it offline.
    }
    return {
      filename: "visualization.json",
      mimeType: "application/json;charset=utf-8",
      content,
    };
  }
  if (renderType === "html") {
    return {
      filename: "visualization.html",
      mimeType: "text/html;charset=utf-8",
      content: stripFence(source),
    };
  }
  if (renderType === "mermaid") {
    return {
      filename: "visualization.mmd",
      mimeType: "text/plain;charset=utf-8",
      content: stripFence(source),
    };
  }
  return {
    filename: "visualization.svg",
    mimeType: "image/svg+xml;charset=utf-8",
    content: stripFence(source),
  };
}

export function downloadTextAsset(asset: VisualizationDownload): void {
  const url = URL.createObjectURL(new Blob([asset.content], { type: asset.mimeType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = asset.filename;
  anchor.hidden = true;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function downloadUrlAsset(url: string, filename: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.hidden = true;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

export async function downloadCanvasPng(
  canvas: HTMLCanvasElement,
  filename = "visualization.png",
): Promise<boolean> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) return false;
  const url = URL.createObjectURL(blob);
  downloadUrlAsset(url, filename);
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

export function serializeSvgForRaster(svg: SVGElement): string {
  const clone = svg.cloneNode(true) as SVGElement;
  if (!clone.getAttribute("xmlns")) {
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  }
  return new XMLSerializer().serializeToString(clone);
}

export async function downloadSvgPng(
  svg: SVGElement,
  filename = "visualization.png",
): Promise<boolean> {
  const bounds = svg.getBoundingClientRect();
  const width = Math.max(1, Math.ceil(bounds.width || Number(svg.getAttribute("width")) || 1200));
  const height = Math.max(1, Math.ceil(bounds.height || Number(svg.getAttribute("height")) || 675));
  const canvas = document.createElement("canvas");
  const scale = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  const context = canvas.getContext("2d");
  if (!context) return false;
  context.scale(scale, scale);
  const sourceUrl = URL.createObjectURL(new Blob(
    [serializeSvgForRaster(svg)],
    { type: "image/svg+xml;charset=utf-8" },
  ));
  try {
    const image = new Image();
    image.decoding = "async";
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("SVG image could not be rasterized"));
      image.src = sourceUrl;
    });
    context.drawImage(image, 0, 0, width, height);
    return await downloadCanvasPng(canvas, filename);
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}
