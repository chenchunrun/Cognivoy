// Prepare a memory doc's raw markdown for rendering: hide the entry-id
// HTML comments as zero-width anchors (so ``#m_xxx`` hash navigation works)
// and rewrite footnote definitions into clickable links.
//
// Link targets, picked by (ref shape, current layer):
//   * ``surface:id``     → ``/memory/l1?ref=surface:id``   (L2 → L1 hop)
//   * ``m_<ULID>`` in L2 → ``#m_<ULID>``                   (same-doc scroll)
//   * ``m_<ULID>`` in L3 → ``/memory/resolve?id=m_<ULID>`` (resolver redirect)
//   * bare ``<surface>`` → ``/memory/l2/<surface>``        (L3 → L2 hop)
//
// Ported from the previous frontend's MemoryWorkbench (web/components/memory).

import type { MemoryLayer } from "./api";

const ENTRY_ANCHOR_RE = /\s*<!--\s*(m_[0-9A-HJKMNP-TV-Z]{26})\s*-->/g;
const FOOTNOTE_DEF_SURFACE_REF_RE =
  /^(\[\^[^\]]+\]:\s*)([a-z][a-z0-9_-]*):([A-Za-z0-9_-]+)\s*$/gm;
const FOOTNOTE_DEF_ENTRY_RE =
  /^(\[\^[^\]]+\]:\s*)(m_[0-9A-HJKMNP-TV-Z]{26})\s*$/gm;
const FOOTNOTE_DEF_BARE_RE = /^(\[\^[^\]]+\]:\s*)([a-z][a-z0-9_-]*)\s*$/gm;

const L3_SURFACES = new Set([
  "chat",
  "notebook",
  "quiz",
  "kb",
  "book",
  "partner",
  "cowriter",
]);

export function prepareDocForRender(md: string, layer: MemoryLayer): string {
  // Anchor injection MUST come before linkify so that ``m_xxx`` text on a
  // footnote-definition line is matched as a ref, not chewed up by the
  // anchor regex (which only matches inside HTML comments).
  const withAnchors = md.replace(
    ENTRY_ANCHOR_RE,
    ' <span id="$1" class="memory-entry-anchor"></span>',
  );
  const withSurfaceLinks = withAnchors.replace(
    FOOTNOTE_DEF_SURFACE_REF_RE,
    (_match, prefix: string, surface: string, entityId: string) => {
      const ref = `${surface}:${entityId}`;
      const url = `/memory/l1?ref=${encodeURIComponent(ref)}`;
      return `${prefix}[${ref}](${url})`;
    },
  );
  const withEntryLinks = withSurfaceLinks.replace(
    FOOTNOTE_DEF_ENTRY_RE,
    (_match, prefix: string, entryId: string) => {
      const href =
        layer === "L2"
          ? `#${entryId}`
          : `/memory/resolve?id=${encodeURIComponent(entryId)}`;
      return `${prefix}[${entryId}](${href})`;
    },
  );
  return withEntryLinks.replace(
    FOOTNOTE_DEF_BARE_RE,
    (match, prefix: string, name: string) => {
      if (!L3_SURFACES.has(name)) return match;
      return `${prefix}[${name}](/memory/l2/${name})`;
    },
  );
}
