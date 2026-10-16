/**
 * Per-partner web session key, persisted in localStorage so a refresh / tab
 * switch / navigation reattaches to the SAME conversation. The key is the
 * canonical session id the backend stores under (colon-free, so it doubles as
 * the filename stem and the id used by resume / delete / branch).
 */

function storageKey(partnerId: string): string {
  return `partner-session:${partnerId}`;
}

export function freshPartnerSessionKey(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `web-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function loadPartnerSessionKey(partnerId: string): string {
  try {
    const existing = window.localStorage.getItem(storageKey(partnerId));
    if (existing) return existing;
    const fresh = freshPartnerSessionKey();
    window.localStorage.setItem(storageKey(partnerId), fresh);
    return fresh;
  } catch {
    return freshPartnerSessionKey();
  }
}

export function persistPartnerSessionKey(partnerId: string, key: string): void {
  try {
    window.localStorage.setItem(storageKey(partnerId), key);
  } catch {
    /* private mode / storage disabled — in-memory only */
  }
}
