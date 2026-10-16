/**
 * Public entry point for chat-history import. The user picks a `.claude` or
 * `.codex` folder; we detect which, scan it for projects/sessions, and (later)
 * parse the chosen sessions into the upload payload. All file reading happens in
 * the browser via the File System Access API — those files live on the user's
 * machine, not the server.
 */

import { parseClaudeSession, scanClaude } from "./claude-code";
import { parseCodexSession, scanCodex } from "./codex";
import { detectSource } from "./detect";
import { projectLabel } from "./shared";
import {
  type AgentScope,
  ImportScanError,
  type ImportSource,
  type NormalizedSession,
  type ScanResult,
  type SelectGroup,
  type SelectionUnit,
  type SessionRef,
} from "./types";

export * from "./types";
export { SOURCE_LABEL, epochMsToISODate, projectLabel } from "./shared";

export function isFileSystemAccessSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.showDirectoryPicker === "function"
  );
}

/** Open the OS folder picker, then scan the chosen directory. */
export async function pickAndScan(): Promise<ScanResult> {
  if (!isFileSystemAccessSupported()) {
    throw new ImportScanError("unsupported_browser");
  }
  let root: FileSystemDirectoryHandle;
  try {
    root = await window.showDirectoryPicker!({
      id: "cognivoy-chat-import",
      mode: "read",
    });
  } catch (reason) {
    if (reason instanceof DOMException && reason.name === "AbortError") {
      throw new ImportScanError("aborted");
    }
    throw new ImportScanError(
      "picker_failed",
      reason instanceof Error ? reason.message : "picker_failed",
    );
  }
  return scanDirectory(root);
}

export async function scanDirectory(
  root: FileSystemDirectoryHandle,
): Promise<ScanResult> {
  const source = await detectSource(root);
  if (!source) throw new ImportScanError("not_recognized");
  const projects =
    source === "claude_code" ? await scanClaude(root) : await scanCodex(root);
  return { source, handle: root, projects };
}

/** The dimension a source is sliced by: Codex by day, Claude Code by project. */
export function selectionUnit(source: ImportSource): SelectionUnit {
  return source === "codex" ? "dates" : "projects";
}

/**
 * A first import must be deliberately bounded. CLI histories can span several
 * gigabytes, so selecting every transcript by default makes the browser parse
 * the entire archive before the user has made a scope decision. Start with the
 * newest project/day; the explicit "all" option remains available.
 */
export function recommendedInitialScope(scan: ScanResult): AgentScope {
  const first = buildSelectGroups(scan)[0];
  if (selectionUnit(scan.source) === "projects") {
    return { kind: "projects", cwds: first ? [first.key] : [] };
  }
  return { kind: "dates", days: first ? [first.key] : [] };
}

/**
 * Flatten a scan's sessions into the togglable units the picker shows — Codex
 * by calendar day, Claude Code by project. Each unit's `key` is exactly what
 * lands in {@link AgentScope}, so the same value drives selection and the
 * later scope filter.
 */
export function buildSelectGroups(scan: ScanResult): SelectGroup[] {
  const refs = scan.projects.flatMap((p) => p.sessions);
  if (selectionUnit(scan.source) === "dates") {
    const byDate = new Map<string, SessionRef[]>();
    for (const ref of refs) {
      const key = ref.date || "(unknown)";
      const arr = byDate.get(key) ?? [];
      arr.push(ref);
      byDate.set(key, arr);
    }
    return Array.from(byDate.entries())
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([key, sessions]) => ({ key, label: key, sessions }));
  }
  return scan.projects.map((p) => ({
    key: p.cwd,
    label: p.label || projectLabel(p.cwd),
    sublabel: p.cwd,
    sessions: p.sessions,
  }));
}

/**
 * Keep only the sessions whose selection unit is still in the agent's scope.
 * This is what makes a refresh respect the user's original picks while still
 * pulling in newly-created conversations inside chosen units.
 */
export function filterRefsByScope(
  refs: SessionRef[],
  scope: AgentScope,
): SessionRef[] {
  if (scope.kind === "all") return refs;
  if (scope.kind === "projects") {
    const set = new Set(scope.cwds);
    return refs.filter((r) => set.has(r.cwd));
  }
  if (scope.kind === "dates") {
    const set = new Set(scope.days);
    return refs.filter((r) => set.has(r.date));
  }
  const set = new Set(scope.externalIds);
  return refs.filter((r) => set.has(r.externalId));
}

/** Fully parse the selected sessions; corrupt/unreadable ones are skipped
 *  rather than aborting the batch. */
export async function parseSessions(
  source: ImportSource,
  refs: SessionRef[],
  onProgress?: (done: number, total: number) => void,
): Promise<NormalizedSession[]> {
  const parser =
    source === "claude_code" ? parseClaudeSession : parseCodexSession;
  const out: NormalizedSession[] = [];
  let done = 0;
  for (const ref of refs) {
    try {
      const parsed = await parser(ref);
      if (parsed && parsed.messages.length) out.push(parsed);
    } catch {
      // skip this transcript
    }
    onProgress?.(++done, refs.length);
  }
  return out;
}

/** Parse one transcript so callers can upload incrementally without retaining
 * an entire multi-gigabyte history in browser memory. */
export async function parseSession(
  source: ImportSource,
  ref: SessionRef,
): Promise<NormalizedSession | null> {
  const parser =
    source === "claude_code" ? parseClaudeSession : parseCodexSession;
  return parser(ref);
}

const DEFAULT_IMPORT_BATCH_BYTES = 4 * 1024 * 1024;

/** Parse and upload a history incrementally. A multi-gigabyte CLI archive is
 * never retained as one giant JSON payload, and unreadable transcripts do not
 * prevent valid neighbours from being preserved. */
export async function importRefsIncrementally(
  source: ImportSource,
  refs: SessionRef[],
  upload: (
    sessions: NormalizedSession[],
  ) => Promise<{ imported: number; skipped: number }>,
  onProgress?: (done: number, total: number) => void,
  maxBatchBytes = DEFAULT_IMPORT_BATCH_BYTES,
): Promise<{ imported: number; skipped: number; unreadable: number }> {
  let batch: NormalizedSession[] = [];
  let batchBytes = 2;
  let imported = 0;
  let skipped = 0;
  let unreadable = 0;

  const flush = async () => {
    if (!batch.length) return;
    const result = await upload(batch);
    imported += result.imported;
    skipped += result.skipped;
    batch = [];
    batchBytes = 2;
  };

  for (let index = 0; index < refs.length; index += 1) {
    let parsed: NormalizedSession | null;
    try {
      parsed = await parseSession(source, refs[index]);
    } catch {
      unreadable += 1;
      onProgress?.(index + 1, refs.length);
      continue;
    }
    if (!parsed) {
      unreadable += 1;
      onProgress?.(index + 1, refs.length);
      continue;
    }
    const encodedBytes = new TextEncoder().encode(JSON.stringify(parsed)).byteLength;
    if (batch.length && batchBytes + encodedBytes > maxBatchBytes) {
      await flush();
    }
    batch.push(parsed);
    batchBytes += encodedBytes;
    onProgress?.(index + 1, refs.length);
  }
  await flush();
  return { imported, skipped, unreadable };
}
