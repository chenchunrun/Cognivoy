"use client";

import { CheckCircle2, Cloud, Cpu, KeyRound, Plus, Server, XCircle } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Badge, Button } from "@/components/ui";
import {
  buildKnowledgeEngineOverview,
  type KnowledgeEngineStatus,
} from "@/lib/knowledge-engine-overview";
import type { RagProviderSummary } from "@/lib/knowledge-api";
import type { KnowledgeBase } from "@/lib/knowledge-helpers";

const LOCAL_ENGINES = new Set(["llamaindex", "graphrag", "lightrag"]);
const CONNECT_ONLY_ENGINES = new Set(["lightrag-server", "ima"]);

function statusCopy(status: KnowledgeEngineStatus) {
  if (status === "needs_key") {
    return { label: "Needs key", icon: KeyRound, variant: "warning" as const };
  }
  if (status === "not_installed") {
    return { label: "Not installed", icon: XCircle, variant: "outline" as const };
  }
  if (status === "needs_setup") {
    return { label: "Needs setup", icon: XCircle, variant: "warning" as const };
  }
  return { label: "Ready to use", icon: CheckCircle2, variant: "success" as const };
}

export function KnowledgeEngineOverview({
  providers,
  knowledgeBases,
  onCreate,
}: {
  providers: RagProviderSummary[];
  knowledgeBases: KnowledgeBase[];
  onCreate: (provider: string) => void;
}) {
  const { t } = useTranslation();
  const engines = buildKnowledgeEngineOverview(providers, knowledgeBases);
  const readyCount = engines.filter((engine) => engine.status === "ready").length;

  if (!engines.length) return null;

  return (
    <section className="mb-7" aria-labelledby="retrieval-engines-heading">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id="retrieval-engines-heading" className="display text-base font-semibold text-foreground">
            {t("Retrieval engines")}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("Compare availability, retrieval modes, and current usage before creating a knowledge base.")}
          </p>
        </div>
        <Badge variant={readyCount === engines.length ? "success" : "outline"}>
          {t("{{ready}} of {{total}} ready", { ready: readyCount, total: engines.length })}
        </Badge>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {engines.map((engine) => {
          const status = statusCopy(engine.status);
          const StatusIcon = status.icon;
          const EngineIcon = LOCAL_ENGINES.has(engine.id)
            ? Cpu
            : engine.id === "pageindex"
              ? Cloud
              : Server;
          const canOpen = engine.status === "ready";
          return (
            <article key={engine.id} className="surface flex min-h-44 flex-col p-4">
              <div className="flex items-start gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-muted text-accent-foreground">
                  <EngineIcon size={17} aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-medium text-foreground">{engine.name}</h3>
                    <Badge variant={status.variant}>
                      <StatusIcon size={11} aria-hidden="true" />
                      {t(status.label)}
                    </Badge>
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {LOCAL_ENGINES.has(engine.id) ? t("Local engine") : t("Hosted or connected engine")}
                    {" · "}
                    {t("{{count}} knowledge bases", { count: engine.knowledgeBaseCount })}
                  </p>
                </div>
              </div>
              <p className="mt-3 line-clamp-3 text-xs leading-relaxed text-muted-foreground">
                {t(engine.description)}
              </p>
              <div className="mt-auto flex flex-wrap items-end justify-between gap-2 pt-3">
                <div className="flex min-w-0 flex-wrap gap-1">
                  {engine.modes?.slice(0, 4).map((mode) => (
                    <Badge key={mode} variant={mode === engine.default_mode ? "primary" : "outline"}>
                      {mode}
                    </Badge>
                  ))}
                  {engine.default_mode ? (
                    <span className="self-center text-[10px] text-muted-foreground">
                      {t("Default: {{mode}}", { mode: engine.default_mode })}
                    </span>
                  ) : null}
                </div>
                {canOpen ? (
                  <Button size="sm" variant="outline" onClick={() => onCreate(engine.id)}>
                    <Plus size={13} aria-hidden="true" />
                    {CONNECT_ONLY_ENGINES.has(engine.id) ? t("Connect") : t("Create")}
                  </Button>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
