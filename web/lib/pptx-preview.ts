export interface PptxPreviewShape {
  kind: "text" | "image";
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  data_url?: string;
}

export interface PptxPreviewPayload {
  filename: string;
  width: number;
  height: number;
  slide_count: number;
  truncated?: boolean;
  slides: Array<{ number: number; shapes: PptxPreviewShape[] }>;
}

const finiteUnit = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

export function normalizePptxPreview(value: unknown): PptxPreviewPayload | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<PptxPreviewPayload>;
  if (
    typeof raw.filename !== "string" ||
    typeof raw.width !== "number" || raw.width <= 0 ||
    typeof raw.height !== "number" || raw.height <= 0 ||
    typeof raw.slide_count !== "number" ||
    !Array.isArray(raw.slides)
  ) return null;
  const slides = raw.slides.map((slide) => ({
    number: Number(slide?.number) || 1,
    shapes: Array.isArray(slide?.shapes)
      ? slide.shapes.filter((shape) =>
          (shape?.kind === "text" || shape?.kind === "image") &&
          finiteUnit(shape.x) && finiteUnit(shape.y) &&
          finiteUnit(shape.width) && finiteUnit(shape.height) &&
          (shape.kind !== "image" || !shape.data_url || /^data:image\/(png|jpeg|gif|webp);base64,/i.test(shape.data_url)),
        )
      : [],
  }));
  return { ...raw, filename: raw.filename, width: raw.width, height: raw.height, slide_count: raw.slide_count, slides };
}
