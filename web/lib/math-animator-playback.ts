import type { MathAnimatorResult } from "@/lib/math-animator-types";

export type MathAnimatorDownload =
  | { kind: "video" | "image"; url: string; filename: string }
  | { kind: "code"; content: string; filename: string };

export function normalizePlaybackRate(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(0.5, Math.min(2, value));
}
export function resolveMathAnimatorDownloads(
  result: MathAnimatorResult,
): MathAnimatorDownload[] {
  const assets: MathAnimatorDownload[] = result.artifacts.map((artifact) => ({
    kind: artifact.type,
    url: artifact.url,
    filename: artifact.filename,
  }));
  if (result.code.content) {
    assets.push({
      kind: "code",
      content: result.code.content,
      filename: "manim-scene.py",
    });
  }
  return assets;
}
