import { apiFetch, apiUrl } from "@/lib/api";
import type {
  MathAnimatorRerenderRequest,
  MathAnimatorResult,
} from "@/lib/math-animator-types";

export async function rerenderMathAnimatorSource(
  request: MathAnimatorRerenderRequest,
): Promise<MathAnimatorResult> {
  const response = await apiFetch(apiUrl("/api/v1/plugins/math-animator/rerender"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(String(payload.message ?? `Render failed (${response.status})`));
  }
  return {
    response: "",
    output_mode: payload.output_mode === "image" ? "image" : "video",
    code: payload.code as MathAnimatorResult["code"],
    artifacts: (payload.artifacts ?? []) as MathAnimatorResult["artifacts"],
    timings: {},
    render: {
      quality: String(payload.quality ?? request.quality),
      width: request.width,
      height: request.height,
      fps: request.fps,
      show_code: true,
    },
  };
}
