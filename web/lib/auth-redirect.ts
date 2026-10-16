/** Return a same-origin post-auth path, rejecting browser URL ambiguities. */
export function safeNextPath(value: string | null): string {
  if (
    !value ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return "/home";
  }
  try {
    const base = new URL("http://cognivoy.local");
    const resolved = new URL(value, base);
    if (resolved.origin !== base.origin) return "/home";
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return "/home";
  }
}
