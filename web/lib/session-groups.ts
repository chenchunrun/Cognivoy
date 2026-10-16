import type { SessionSummary } from "@/lib/session-api";

export interface SessionGroup {
  key: string;
  label: string;
  sessions: SessionSummary[];
}

export function groupSessionsByLearningGoal(sessions: SessionSummary[]): SessionGroup[] {
  const groups = new Map<string, SessionSummary[]>();
  for (const session of sessions) {
    const capability = session.preferences?.capability || "chat";
    const knowledgeBase = session.preferences?.knowledge_bases?.[0];
    const key = knowledgeBase ? `kb:${knowledgeBase}` : `cap:${capability}`;
    groups.set(key, [...(groups.get(key) ?? []), session]);
  }
  return [...groups.entries()]
    .map(([key, items]) => ({
      key,
      label: key.startsWith("kb:") ? items[0]?.preferences?.knowledge_bases?.[0] || "Knowledge" : key.slice(4),
      sessions: [...items].sort((a, b) => b.updated_at - a.updated_at),
    }))
    .sort((a, b) => (b.sessions[0]?.updated_at ?? 0) - (a.sessions[0]?.updated_at ?? 0));
}
