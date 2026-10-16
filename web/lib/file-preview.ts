const TRUSTED_PREVIEW_PREFIXES = [
  "/api/attachments/",
  "/api/outputs/",
  "/api/v1/knowledge/",
];

/** Resolve only server-owned attachment routes; never turn `//host/path` into a fetch. */
export function trustedPreviewUrl(
  raw: string | undefined,
  origin: string,
): string | null {
  if (!raw) return null;
  try {
    const parsed = new URL(raw, origin);
    if (parsed.origin !== origin) return null;
    if (!TRUSTED_PREVIEW_PREFIXES.some((prefix) => parsed.pathname.startsWith(prefix))) {
      return null;
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}

/** Read a response while enforcing the limit even for chunked/no-length bodies. */
export async function readResponseBytes(
  response: Response,
  limit: number,
  tooLargeMessage = "File is too large to preview",
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > limit) {
    throw new Error(tooLargeMessage);
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > limit) throw new Error(tooLargeMessage);
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel(tooLargeMessage);
        throw new Error(tooLargeMessage);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
