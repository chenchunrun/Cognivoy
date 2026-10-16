import { apiFetch, apiUrl } from "@/lib/api";

export type SloBusinessEvent =
  | "asset_saved"
  | "learning_completed"
  | "reference_clicked"
  | "turn_recovered";

/** Best-effort, content-free product telemetry; never blocks the user action. */
export async function recordSloEvent(
  name: SloBusinessEvent,
  amount = 1,
): Promise<void> {
  try {
    await apiFetch(apiUrl("/api/v1/system/slo/events"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, amount }),
    });
  } catch {
    // Observability must never turn a successful product action into a failure.
  }
}
