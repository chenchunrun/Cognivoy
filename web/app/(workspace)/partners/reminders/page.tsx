"use client";

import * as React from "react";
import Link from "next/link";
import { AlarmClock, ArrowLeft, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  getProactiveOverview,
  type ProactiveOverview,
} from "@/lib/partners-api";
import { Badge, Button, EmptyState, Skeleton, useToast } from "@/components/ui";
import { PageHeader } from "@/components/shell/PageHeader";

export default function PartnerReminderCenterPage() {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const [overview, setOverview] = React.useState<ProactiveOverview | null>(null);
  const [loading, setLoading] = React.useState(true);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      setOverview(await getProactiveOverview());
    } catch (error) {
      toast({
        title: error instanceof Error ? error.message : t("Failed to load reminders"),
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [t, toast]);

  React.useEffect(() => {
    let cancelled = false;
    void getProactiveOverview()
      .then((next) => {
        if (!cancelled) setOverview(next);
      })
      .catch((error) => {
        if (!cancelled) {
          toast({
            title: error instanceof Error ? error.message : t("Failed to load reminders"),
            variant: "destructive",
          });
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [t, toast]);

  return (
    <div className="mx-auto h-full max-w-6xl overflow-y-auto px-6 py-8">
      <Link href="/partners" className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-3.5 w-3.5" />
        {t("Partners")}
      </Link>
      <PageHeader
        title={t("Reminder center")}
        description={t("Monitor pending and recent proactive tutor decisions across every partner.")}
        actions={
          <Button variant="outline" onClick={() => void load()} loading={loading}>
            <RefreshCw className="h-4 w-4" />
            {t("Refresh")}
          </Button>
        }
      />

      {!overview ? (
        <div className="space-y-3">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      ) : overview.partners.length === 0 ? (
        <EmptyState
          icon={AlarmClock}
          title={t("No partners yet")}
          description={t("Create a partner before configuring proactive outreach.")}
          className="min-h-80"
        />
      ) : (
        <div className="space-y-3">
          <div className="surface flex items-center justify-between px-4 py-3">
            <span className="text-sm text-muted-foreground">{t("Pending reminders")}</span>
            <span className="text-xl font-semibold text-foreground">{overview.pending_count}</span>
          </div>
          {overview.partners.map((partner) => {
            const latest = partner.audit.at(-1);
            return (
              <Link
                key={partner.partner_id}
                href={`/partners/${partner.partner_id}`}
                className="surface block p-4 transition-colors hover:border-ring"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <h2 className="text-sm font-medium text-foreground">{partner.partner_name}</h2>
                      <Badge variant={partner.enabled ? "success" : "default"}>
                        {partner.enabled ? t("Enabled") : t("Disabled")}
                      </Badge>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t("{{count}} pending", { count: partner.pending.length })}
                    </p>
                  </div>
                  {latest ? (
                    <div className="text-right text-xs text-muted-foreground">
                      <p>{t(latest.decision)}</p>
                      <p className="mt-1">
                        {new Intl.DateTimeFormat(
                          i18n.language.startsWith("zh") ? "zh-CN" : "en",
                          { dateStyle: "medium", timeStyle: "short" },
                        ).format(new Date(latest.at))}
                      </p>
                    </div>
                  ) : null}
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
