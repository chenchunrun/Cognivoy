/**
 * A server id should enter the URL only when a draft on `/home` has just been
 * bound. A pre-existing id left over for one render while navigating from
 * `/home/:id` back to `/home` must never bounce the user into that history.
 */
export function shouldPromoteDraftSessionToUrl(
  sessionId: string | null,
  sessionIdParam: string | null,
  previousStateSessionId: string | null,
): boolean {
  return Boolean(sessionId && !sessionIdParam && !previousStateSessionId);
}
