/**
 * Map imported sessions (which live on the backend) back to the client-side
 * agents that own them. An agent's identity lives in IndexedDB, so this is how
 * both the Space management page and the chat reference picker decide which
 * conversations belong to which named agent.
 */

import type { SessionSummary } from "@/lib/session-api";
import type { ImportAgent } from "./agent-store";
import { epochMsToISODate } from "./shared";
import type { AgentScope, ImportSource } from "./types";

export interface SessionImportMeta {
  source: ImportSource;
  sourceCwd: string;
  externalId?: string;
  agentId?: string;
}

export interface ServerImportedAgent {
  id: string;
  name: string;
  source: string;
  sessionIds: string[];
}

const SERVER_SOURCE_LABELS: Record<string, string> = {
  claude_code: "Claude Code",
  codex: "Codex",
  kimi: "Kimi CLI",
  opencode: "OpenCode",
};

/**
 * Group backend-imported sessions whose agent definition is unavailable in
 * this browser. Folder imports keep their richer IndexedDB definition, while
 * server-side imports (Kimi/opencode) still get a visible, openable card.
 */
export function groupServerImportedAgents(
  sessions: SessionSummary[],
  registeredAgentIds: Iterable<string>,
): ServerImportedAgent[] {
  const registered = new Set(registeredAgentIds);
  const groups = new Map<string, ServerImportedAgent>();
  for (const session of sessions) {
    const imp = session.preferences?.import;
    const source = String(imp?.source || "").trim();
    if (!source) continue;
    const explicitId = String(imp?.agent_id || "").trim();
    if (explicitId && registered.has(explicitId)) continue;
    const id = explicitId || `server-import:${source}`;
    const existing = groups.get(id);
    const sessionId = session.session_id || session.id;
    if (existing) {
      existing.sessionIds.push(sessionId);
      continue;
    }
    groups.set(id, {
      id,
      name:
        String(imp?.agent_name || "").trim() ||
        SERVER_SOURCE_LABELS[source] ||
        source,
      source,
      sessionIds: [sessionId],
    });
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function readImportMeta(
  session: SessionSummary,
): SessionImportMeta | null {
  const imp = (
    session.preferences as
      | { import?: { source?: string; source_cwd?: string; external_id?: string; agent_id?: string } }
      | undefined
  )?.import;
  const src = imp?.source;
  if (src !== "claude_code" && src !== "codex") return null;
  return {
    source: src,
    sourceCwd: imp?.source_cwd ?? "",
    externalId: imp?.external_id || undefined,
    agentId: imp?.agent_id || undefined,
  };
}

/** Which selection unit a session falls under, for scope membership tests. */
export function sessionUnitKey(
  source: ImportSource,
  meta: SessionImportMeta,
  createdAtSec: number,
): string {
  return source === "codex"
    ? epochMsToISODate(createdAtSec * 1000)
    : meta.sourceCwd;
}

export function scopeContainsSession(
  scope: AgentScope,
  meta: SessionImportMeta,
  createdAtSec: number,
): boolean {
  if (scope.kind === "all") return true;
  if (scope.kind === "projects") return scope.cwds.includes(meta.sourceCwd);
  if (scope.kind === "dates") {
    return scope.days.includes(epochMsToISODate(createdAtSec * 1000));
  }
  return Boolean(meta.externalId && scope.externalIds.includes(meta.externalId));
}

/**
 * Assign each imported session to exactly one agent: by explicit `agent_id`
 * when present, else by source + scope membership. The fallback re-attaches
 * conversations imported before the agent model and migrated legacy agents
 * (whose scope is `all`). Returns sessionId → agentId; unmatched maps to null.
 */
export function assignSessionsToAgents(
  sessions: SessionSummary[],
  agents: ImportAgent[],
): Map<string, string | null> {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const out = new Map<string, string | null>();
  for (const session of sessions) {
    const sid = session.session_id || session.id;
    const meta = readImportMeta(session);
    if (!meta) {
      out.set(sid, null);
      continue;
    }
    if (meta.agentId && byId.has(meta.agentId)) {
      out.set(sid, meta.agentId);
      continue;
    }
    const owner = agents.find(
      (a) =>
        a.source === meta.source &&
        scopeContainsSession(a.scope, meta, session.created_at),
    );
    out.set(sid, owner?.id ?? null);
  }
  return out;
}
