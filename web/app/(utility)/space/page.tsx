"use client";

import * as React from "react";
import Link from "next/link";
import { useTranslation } from "react-i18next";
import { PageHeader } from "@/components/shell/PageHeader";
import {
  ChevronRight,
  ClipboardList,
  GraduationCap,
  History,
  NotebookPen,
  Plug,
  Terminal,
  UserRound,
  Bot,
  Wand2,
  type LucideIcon,
} from "lucide-react";
import { Skeleton } from "@/components/ui";
import { getSessionStats } from "@/lib/session-api";
import { groupServerImportedAgents } from "@/lib/chat-import/attribution";
import { listImportedSessions } from "@/lib/imports-api";
import { listSubagentConnections } from "@/lib/subagents-api";
import { listNotebooks, listNotebookEntries } from "@/lib/notebook-api";
import { listPersonas } from "@/lib/personas-api";
import { listSkills } from "@/lib/skills-api";
import { fetchAllProgress } from "@/lib/learning-api";
import { getSpaceMcpState, MCP_SPACE_BASE_PATH } from "@/lib/mcp-api";
import { getCliApps } from "@/lib/cli-apps-api";
import {
  latestSpaceTimestamp,
  type SpaceMetric,
} from "@/lib/space-metrics";

interface DashboardItem {
  key: string;
  href: string;
  icon: LucideIcon;
  title: string;
  blurb: string;
  unit: string;
  load: () => Promise<SpaceMetric>;
}

interface DashboardGroup {
  key: string;
  labelKey: string;
  items: DashboardItem[];
}

const GROUPS: DashboardGroup[] = [
  {
    key: "conversations",
    labelKey: "Conversations & Materials",
    items: [
      {
        key: "chat-history",
        href: "/space/chat-history",
        icon: History,
        title: "Chat History",
        blurb: "Review and reopen previous conversations.",
        unit: "conversations",
        load: async () => {
          const stats = await getSessionStats({ force: true });
          return { count: stats.total, updatedAt: stats.updated_at ?? undefined };
        },
      },
      {
        key: "notebooks",
        href: "/notebook",
        icon: NotebookPen,
        title: "Notebooks",
        blurb: "Organize saved outputs from chat, research, Co-Writer, and more.",
        unit: "notebooks",
        load: async () => {
          const items = await listNotebooks();
          return { count: items.length, updatedAt: latestSpaceTimestamp(items) };
        },
      },
      {
        key: "questions",
        href: "/question-notebook",
        icon: ClipboardList,
        title: "Question Bank",
        blurb: "Review and organize quiz questions across sessions.",
        unit: "questions",
        load: async () => {
          const result = await listNotebookEntries({ limit: 1 });
          return { count: result.total, updatedAt: latestSpaceTimestamp(result.items) };
        },
      },
    ],
  },
  {
    key: "personalization",
    labelKey: "Preferences & Expert tools",
    items: [
      {
        key: "agents",
        href: "/space/agents",
        icon: Bot,
        title: "My Agents",
        blurb: "Import, scope, refresh, and open coding-agent conversations.",
        unit: "agents",
        load: async () => {
          const [items, sessions, connections] = await Promise.all([
            (await import("@/lib/chat-import/agent-store")).getAgents(),
            listImportedSessions(200, 0, { force: true }),
            listSubagentConnections(),
          ]);
          const serverAgents = groupServerImportedAgents(
            sessions,
            items.map((item) => item.id),
          );
          const updatedAt = Math.max(
            0,
            ...items.map((item) => (item.lastSyncAt || 0) / 1000),
            ...sessions.map((item) => item.updated_at || 0),
            ...connections.map((item) => {
              const value = item.updated_at || item.created_at;
              return value ? Date.parse(value) / 1000 : 0;
            }),
          );
          return {
            count: items.length + serverAgents.length + connections.length,
            updatedAt: updatedAt || undefined,
          };
        },
      },
      {
        key: "learning",
        href: "/space/learning",
        icon: GraduationCap,
        title: "Learning Plans",
        blurb: "Turn long-term goals into tasks, mastery checks, and spaced review.",
        unit: "paths",
        load: async () => {
          const items = (await fetchAllProgress()).summaries.filter((item) => item.kp_count > 0);
          return { count: items.length, updatedAt: latestSpaceTimestamp(items) };
        },
      },
      {
        key: "personas",
        href: "/space/personas",
        icon: UserRound,
        title: "Teaching Preferences",
        blurb: "Choose how Cognivoy explains, questions, and guides you.",
        unit: "personas",
        load: async () => ({ count: (await listPersonas()).length }),
      },
      {
        key: "skills",
        href: "/space/skills",
        icon: Wand2,
        title: "Skills",
        blurb: "Expert playbooks Cognivoy can use for specialized tasks.",
        unit: "skills",
        load: async () => ({ count: (await listSkills()).length }),
      },
      {
        key: "mcp",
        href: "/space/mcp",
        icon: Plug,
        title: "MCP Services",
        blurb: "Connect hosted MCP services and bring their tools into chat.",
        unit: "services",
        // The account's own servers only: deployment servers are shown on the
        // page but are not this reader's to count.
        load: async () => ({
          count: Object.keys((await getSpaceMcpState(MCP_SPACE_BASE_PATH)).servers).length,
        }),
      },
      {
        key: "cli-apps",
        href: "/space/cli-apps",
        icon: Terminal,
        title: "CLI Apps",
        blurb:
          "Command-line tools from the CLI-Anything catalog, callable from chat.",
        unit: "apps",
        // What this reader can actually use, not what the deployment installed.
        load: async () => {
          const items = (await getCliApps()).apps.filter((app) => app.granted && app.enabled);
          const installed = items
            .map((item) => Date.parse(item.installed_at) / 1000)
            .filter((value) => Number.isFinite(value) && value > 0)
            .map((updated_at) => ({ updated_at }));
          return { count: items.length, updatedAt: latestSpaceTimestamp(installed) };
        },
      },
    ],
  },
];

const ALL_ITEMS = GROUPS.flatMap((group) => group.items);

export default function SpacePage() {
  const { t } = useTranslation();
  const initializedRef = React.useRef(false);
  const [metrics, setMetrics] = React.useState<
    Record<string, { status: "loading" | "ready" | "error"; metric?: SpaceMetric; error?: string }>
  >({});

  const loadItem = React.useCallback(async (item: DashboardItem) => {
    setMetrics((current) => ({ ...current, [item.key]: { status: "loading" } }));
    try {
      const metric = await item.load();
      setMetrics((current) => ({ ...current, [item.key]: { status: "ready", metric } }));
    } catch (error) {
      setMetrics((current) => ({
        ...current,
        [item.key]: {
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        },
      }));
    }
  }, []);

  React.useEffect(() => {
    // React Strict Mode replays mount effects in development. These are
    // independent network reads, so replaying would both double the load and
    // let a second success hide the first request's actionable error state.
    if (initializedRef.current) return;
    initializedRef.current = true;
    for (const item of ALL_ITEMS) {
      void loadItem(item);
    }
  }, [loadItem]);

  return (
    <div className="mx-auto max-w-7xl px-6 py-8">
      <PageHeader
        title={t("Learning Space")}
        description={t(
          "Your conversations, agents, notebooks, and practice in one place — enter from here.",
        )}
      />

      <div className="space-y-9">
        {GROUPS.map((group) => (
          <section key={group.key}>
            <h2 className="display mb-3 px-0.5 text-base font-semibold text-foreground">
              {t(group.labelKey)}
            </h2>
            <div className="grid gap-3 sm:grid-cols-2">
              {group.items.map((item) => (
                <DashboardCard
                  key={item.key}
                  item={item}
                  state={metrics[item.key] ?? { status: "loading" }}
                  onRetry={() => void loadItem(item)}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function DashboardCard({
  item,
  state,
  onRetry,
}: {
  item: DashboardItem;
  state: { status: "loading" | "ready" | "error"; metric?: SpaceMetric; error?: string };
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const Icon = item.icon;
  return (
    <article className="surface group flex flex-col p-4 transition-colors duration-150 hover:border-input">
      <Link href={item.href} className="flex flex-1 flex-col focus-visible:outline-none">
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary-muted text-accent-foreground"
        >
          <Icon size={18} strokeWidth={1.7} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-medium text-foreground">
            {t(item.title)}
          </h3>
          <div className="mt-1 flex items-baseline gap-1.5">
            {state.status === "loading" ? (
              <Skeleton className="my-0.5 h-4 w-14" />
            ) : state.status === "ready" && state.metric ? (
              <>
                <span className="text-xl font-semibold leading-none tabular-nums text-foreground">
                  {state.metric.count.toLocaleString()}
                </span>
                <span className="text-xs text-muted-foreground">
                  {t(item.unit)}
                </span>
              </>
            ) : (
              <span className="text-xs font-medium text-destructive">
                {t("Temporarily unable to load statistics")}
              </span>
            )}
          </div>
        </div>
        <ChevronRight
          size={16}
          aria-hidden="true"
          className="mt-0.5 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground"
        />
      </div>
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
        {t(item.blurb)}
      </p>
      {state.status === "ready" && state.metric?.updatedAt && (
        <p className="mt-2 text-[11px] text-muted-foreground">
          {t("Last activity {{date}}", {
            date: new Date(state.metric.updatedAt * 1000).toLocaleString(),
          })}
        </p>
      )}
      </Link>
      {state.status === "error" && (
        <div className="mt-3 flex items-center justify-between gap-3 border-t border-border pt-3">
          <span className="min-w-0 truncate text-[11px] text-muted-foreground" title={state.error}>
            {t("This card failed independently; the rest of the space is still available.")}
          </span>
          <button
            type="button"
            onClick={onRetry}
            className="shrink-0 rounded-md border border-input px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted"
            aria-label={t("Retry {{name}} statistics", { name: t(item.title) })}
          >
            {t("Retry")}
          </button>
        </div>
      )}
    </article>
  );
}
