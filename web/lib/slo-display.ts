export interface SloRouteGroupSummary {
  name: string;
  server_errors: number;
}

const LONG_RUNNING_ROUTE_GROUPS = new Set(["book", "subagents"]);

export function isLongRunningRouteGroup(name: string): boolean {
  return LONG_RUNNING_ROUTE_GROUPS.has(name.trim().toLowerCase());
}

export function routeGroupsWithServerErrors(
  groups: readonly SloRouteGroupSummary[],
): string[] {
  return groups
    .filter((group) => group.server_errors > 0)
    .map((group) => group.name);
}
