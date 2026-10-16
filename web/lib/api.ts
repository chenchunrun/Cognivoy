// API configuration and utility functions.
//
// The frontend bundle is now URL-agnostic: the browser issues requests against
// the frontend origin (`:3782/api/...` and `:3782/api/.../ws`), and
// `web/proxy.ts` rewrites `/api/*` and `/ws/*` to the configured backend on
// every request. This means there is no build-time or runtime URL substitution
// in the bundle, and no placeholder token to keep alive. `apiUrl` and `wsUrl`
// stay as one-liner pass-throughs so the dozens of existing call sites continue
// to compile and work without modification.

/**
 * Construct a full API URL from a path.
 *
 * Pass-through: returns the path unchanged. The actual backend URL is
 * determined at request time by `web/proxy.ts`, which reads
 * `COGNIVOY_API_BASE_URL` (exported by the container entrypoint from
 * `data/user/settings/system.json`).
 *
 * @param path - API path (e.g., '/api/v1/knowledge/list')
 * @returns The same path, unchanged
 */
export function apiUrl(path: string): string {
  return path;
}

/**
 * Construct a WebSocket URL from a path.
 *
 * Pass-through: returns the path unchanged. `proxy.ts` rewrites `/ws/*` to
 * the configured backend, and the runtime upgrades to `ws://` /
 * `wss://` based on the backend's scheme.
 *
 * @param path - WebSocket path (e.g., '/api/v1/solve')
 * @returns The same path, unchanged
 */
export function wsUrl(path: string): string {
  return path;
}

/**
 * Parse a "COGNIVOY_AUTH_ENABLED"-style flag at runtime.
 *
 * Used by both `apiFetch` (frontend) and `web/proxy.ts` (auth redirect) to
 * decide whether to gate requests. Evaluated with a runtime regex so the
 * value can be set by the container entrypoint on every start (no build-time
 * inlining).
 */
export function parseAuthEnabled(raw: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((raw ?? "").trim());
}

// Whether auth is enabled, learned at runtime — NOT from a build-time env var.
// The browser bundle never sees `COGNIVOY_AUTH_ENABLED` (it isn't a
// `NEXT_PUBLIC_` var, so Next.js does not inline it), and auth is a runtime
// setting that must not be baked at build time anyway. `fetchAuthStatus()` in
// `web/lib/auth.ts` calls `setRuntimeAuthEnabled()` once the backend reports the
// real state. Until then it defaults to `false`, so a stray 401 in the default
// auth-disabled deployment never bounces the user to /login. The server-side
// gate (web/proxy.ts middleware) enforces auth independently; this flag only
// drives the client's in-session 401 → /login redirect.
let runtimeAuthEnabled = false;

/** Record the backend-reported auth state for `apiFetch`'s 401 redirect gate. */
export function setRuntimeAuthEnabled(enabled: boolean): void {
  runtimeAuthEnabled = enabled;
}

/**
 * Authenticated fetch wrapper. Behaves identically to `fetch` but automatically
 * redirects to /login when the backend returns 401 (expired / invalid token).
 *
 * Pass `skipAuthRedirect: true` for endpoints where a 401 is an expected,
 * recoverable response that the caller wants to handle inline — most notably
 * the login/register endpoints, where 401 means "wrong credentials" and must
 * surface as a form error rather than reload the page.
 */
export async function apiFetch(
  input: RequestInfo | URL,
  init?: RequestInit & { skipAuthRedirect?: boolean },
): Promise<Response> {
  const { skipAuthRedirect, ...fetchInit } = init ?? {};
  const inputRequest = typeof Request !== "undefined" && input instanceof Request
    ? input
    : null;
  const method = String(fetchInit.method ?? inputRequest?.method ?? "GET").toUpperCase();
  const headers = new Headers(inputRequest?.headers);
  new Headers(fetchInit.headers).forEach((value, key) => headers.set(key, value));
  if (!["GET", "HEAD", "OPTIONS", "TRACE"].includes(method)) {
    headers.set("X-Cognivoy-CSRF", "1");
  }
  const res = await fetch(input, {
    credentials: "include",
    ...fetchInit,
    headers,
  });

  if (
    res.status === 401 &&
    runtimeAuthEnabled &&
    !skipAuthRedirect &&
    typeof window !== "undefined"
  ) {
    const next = encodeURIComponent(window.location.pathname);
    window.location.href = `/login?next=${next}`;
    return new Promise(() => {});
  }

  // A reverse-proxy timeout/disconnect may return plain text or an HTML error
  // page instead of the backend's JSON envelope. Keep callers' error parsing
  // usable without exposing proxy internals or replaying a potentially mutating
  // request. Preserve real backend JSON errors and all successful/streaming data.
  const contentType = res.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (
    res.status >= 500 &&
    contentType !== "application/json" &&
    !contentType?.endsWith("+json")
  ) {
    await res.body?.cancel().catch(() => {});
    return new Response(JSON.stringify({
      detail: "The backend is temporarily unavailable or timed out. Please try again.",
      error: "backend_unavailable",
    }), {
      status: res.status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  return res;
}
