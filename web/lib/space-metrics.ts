export interface SpaceMetric {
  count: number;
  /** Epoch seconds of the newest known activity. Omitted when the source does
   * not expose timestamps rather than inventing a misleading value. */
  updatedAt?: number;
}
export function latestSpaceTimestamp(
  items: Array<{ updated_at?: number | null }>,
): number | undefined {
  let latest: number | undefined;
  for (const item of items) {
    const value = item.updated_at;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue;
    if (latest === undefined || value > latest) latest = value;
  }
  return latest;
}
