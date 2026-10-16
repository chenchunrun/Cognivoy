import type { ChannelSchemaEntry } from "@/lib/partners-api";

/** Return enabled-channel fields that are still empty before a save/create. */
export function validateChannelConfig(
  entry: ChannelSchemaEntry,
  value: Record<string, unknown>,
): string[] {
  if (value.enabled === false) return [];
  return (entry.required_when_enabled ?? []).filter((path) => {
    const resolved = path.split(".").reduce<unknown>((current, segment) => {
      if (!current || typeof current !== "object") return undefined;
      return (current as Record<string, unknown>)[segment];
    }, value);
    return (
      resolved == null ||
      resolved === "" ||
      (Array.isArray(resolved) && resolved.length === 0)
    );
  });
}
