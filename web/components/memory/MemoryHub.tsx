"use client";

// Memory hub: header, per-layer overview cards (counts + health), graph
// callout, archived-backup banner. Data: GET /memory/overview plus one
// /memory/snapshot/<surface> per surface for the L1 total.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  ArrowRight,
  Layers,
  Network,
  RefreshCw,
  Settings2,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { SURFACES, L3_SLOTS } from "@/lib/memory-graph";
import {
  Badge,
  Button,
  Card,
  CardContent,
  Skeleton,
  useToast,
} from "@/components/ui";
import { getOverview, getSnapshot, type OverviewResponse } from "./api";
import { MemoryArchivedBanner } from "./MemoryArchivedBanner";
import { MemorySubNav } from "./MemorySubNav";
import { PageHeader } from "@/components/shell/PageHeader";

export function MemoryHub() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [l1Total, setL1Total] = useState<number | null>(null);
  const [l1Pending, setL1Pending] = useState(0);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [ov, ...snaps] = await Promise.all([
        getOverview(),
        ...SURFACES.map((s) => getSnapshot(s).catch(() => null)),
      ]);
      setOverview(ov);
      setL1Total(
        snaps.reduce((acc, s) => acc + (s?.entities?.length ?? 0), 0),
      );
      setL1Pending(
        snaps.reduce((acc, s) => acc + (s?.pending_changes?.length ?? 0), 0),
      );
    } catch (e) {
      toast({
        variant: "destructive",
        title: t("Failed to load memory overview"),
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setLoading(false);
    }
  }, [t, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const l2Docs = (overview?.docs ?? []).filter((d) => d.layer === "L2");
  const l3Docs = (overview?.docs ?? []).filter(
    (d) => d.layer === "L3" && d.key !== "preferences",
  );
  const l2Total = l2Docs.reduce((acc, d) => acc + d.entry_count, 0);
  const l3Total = l3Docs.reduce((acc, d) => acc + d.entry_count, 0);
  const l2Backlog = l2Docs.reduce((acc, d) => acc + d.backlog, 0);
  const l3Backlog = l3Docs.reduce((acc, d) => acc + d.backlog, 0);
  const latestBackup = overview?.backups?.[overview.backups.length - 1] ?? null;

  return (
    <div className="mx-auto max-w-7xl px-6 py-8">
      <PageHeader
        title={t("Memory")}
        description={t(
          "Everything Cognivoy remembers about you, organised across three layers. Click into any layer to inspect or curate it.",
        )}
        actions={
          <>
            <Link href="/memory/settings">
              <Button variant="ghost" size="sm">
                <Settings2 size={14} />
                {t("Memory settings")}
              </Button>
            </Link>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void load()}
              loading={loading}
            >
              {!loading && <RefreshCw size={14} />}
              {t("Refresh")}
            </Button>
          </>
        }
      />
      <div className="mb-6">
        <MemorySubNav />
      </div>

      {loading && !overview ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Card key={i}>
              <CardContent className="space-y-3 p-5">
                <Skeleton className="h-8 w-8 rounded-lg" />
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-8 w-1/3" />
                <Skeleton className="h-3 w-full" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <LayerCard
            href="/memory/l1"
            icon={Layers}
            title={t("L1 · Workspace mirror")}
            tag={t("Live")}
            stat={l1Total === null ? "…" : l1Total.toLocaleString()}
            statLabel={t("entities tracked")}
            detail={t(
              "Snapshot of your live workspace across {{n}} surfaces. Refresh to record changes.",
              { n: SURFACES.length },
            )}
            alert={
              l1Pending > 0
                ? t("{{n}} pending changes", { n: l1Pending })
                : undefined
            }
          />
          <LayerCard
            href="/memory/l2"
            icon={Workflow}
            title={t("L2 · Per-surface summaries")}
            tag={t("Curated")}
            stat={l2Total.toLocaleString()}
            statLabel={t("facts across {{n}} surfaces", {
              n: l2Docs.length || SURFACES.length,
            })}
            detail={t(
              "Surface-specific facts extracted by the consolidator. Run Update / Audit / Dedup per doc.",
            )}
            alert={
              l2Backlog > 0
                ? t("{{n}} workspace items awaiting L2 synthesis", { n: l2Backlog })
                : undefined
            }
          />
          <LayerCard
            href="/memory/l3"
            icon={Network}
            title={t("L3 · Cross-surface knowledge")}
            tag={t("Synthesis")}
            stat={l3Total.toLocaleString()}
            statLabel={t("propositions across {{n}} slots", {
              n: l3Docs.length || L3_SLOTS.length,
            })}
            detail={t(
              "Cross-surface synthesis: profile, recent timeline, knowledge scope. Hedged claims with L2 evidence.",
            )}
            alert={
              l3Backlog > 0
                ? t("{{n}} L2 facts awaiting L3 synthesis", { n: l3Backlog })
                : undefined
            }
          />
        </div>
      )}

      <Link href="/memory/graph" className="group mt-6 block">
        <Card className="transition-colors duration-150 group-hover:border-primary-border">
          <CardContent className="flex items-center gap-5 p-5">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-primary-muted text-accent-foreground">
              <Network size={18} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold text-foreground">
                  {t("Memory graph")}
                </h3>
                <Badge variant="outline" className="text-[10px] uppercase">
                  {t("New")}
                </Badge>
              </div>
              <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
                {t(
                  "See all three layers at once — L3 synthesis at the centre, L2 facts in the middle, L1 traces on the outside. Click any node for a preview.",
                )}
              </p>
            </div>
            <ArrowRight
              size={16}
              className="hidden shrink-0 text-primary transition-transform duration-150 group-hover:translate-x-0.5 md:block"
            />
          </CardContent>
        </Card>
      </Link>

      <div className="mt-6">
        <MemoryArchivedBanner latestBackup={latestBackup} />
      </div>
    </div>
  );
}

interface LayerCardProps {
  href: string;
  icon: LucideIcon;
  title: string;
  tag: string;
  stat: string;
  statLabel: string;
  detail: string;
  alert?: string;
}

function LayerCard({
  href,
  icon: Icon,
  title,
  tag,
  stat,
  statLabel,
  detail,
  alert,
}: LayerCardProps) {
  return (
    <Link href={href} className="group">
      <Card className="flex h-full flex-col gap-4 p-5 transition-colors duration-150 group-hover:border-primary-border">
        <div className="flex items-start justify-between">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-primary-muted text-accent-foreground">
            <Icon size={16} />
          </span>
          <Badge variant="outline" className="text-[10px] uppercase">
            {tag}
          </Badge>
        </div>
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-semibold tracking-tight text-foreground">
            {stat}
          </span>
          <span className="text-xs text-muted-foreground">{statLabel}</span>
        </div>
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          {detail}
        </p>
        <div className="mt-auto flex items-center justify-between">
          {alert ? (
            <Badge variant="warning" className="text-[10.5px]">
              {alert}
            </Badge>
          ) : (
            <span />
          )}
          <ArrowRight
            size={14}
            className="text-primary opacity-0 transition-opacity duration-150 group-hover:opacity-100"
          />
        </div>
      </Card>
    </Link>
  );
}
