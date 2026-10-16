export interface ProviderValue {
  value: string;
}

/**
 * Search works without an explicit profile by falling back to DuckDuckGo.
 * When a user chooses to materialize that implicit default, never select the
 * sentinel `none` provider just because it happens to be first in the catalog.
 */
export function defaultSearchProvider(
  providers: readonly ProviderValue[],
): string {
  return (
    providers.find((provider) => provider.value === "duckduckgo")?.value ??
    providers.find((provider) => provider.value !== "none")?.value ??
    ""
  );
}
