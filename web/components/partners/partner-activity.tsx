"use client";

import * as React from "react";
import { Activity, AlertTriangle, CheckCircle2, Clock3, RotateCcw, XCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  getProactiveReminders,
  discardPartnerDeadLetter,
  getPartnerChannelStatus,
  getPartnerDeadLetters,
  retryPartnerDeadLetter,
  type PartnerChannelStatus,
  type PartnerDeadLetter,
  type PartnerInfo,
  type ProactiveAuditRecord,
} from "@/lib/partners-api";
import { Badge, Button, EmptyState, Skeleton, useToast } from "@/components/ui";

function formatDate(value?: string | null) {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : parsed.toLocaleString();
}

export function PartnerActivity({ partner }: { partner: PartnerInfo }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [audit, setAudit] = React.useState<ProactiveAuditRecord[] | null>(null);
  const [channels, setChannels] = React.useState<PartnerChannelStatus | null>(null);
  const [failures, setFailures] = React.useState<PartnerDeadLetter[] | null>(null);
  const [actingOn, setActingOn] = React.useState("");

  const loadOperationalState = React.useCallback(async () => {
    const [channelState, deliveryFailures] = await Promise.all([
      getPartnerChannelStatus(partner.partner_id),
      getPartnerDeadLetters(partner.partner_id),
    ]);
    setChannels(channelState);
    setFailures(deliveryFailures);
  }, [partner.partner_id]);

  React.useEffect(() => {
    let cancelled = false;
    void Promise.all([
      getProactiveReminders(partner.partner_id),
      getPartnerChannelStatus(partner.partner_id),
      getPartnerDeadLetters(partner.partner_id),
    ])
      .then(([response, channelState, deliveryFailures]) => {
        if (!cancelled) {
          setAudit(response.audit);
          setChannels(channelState);
          setFailures(deliveryFailures);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setAudit([]);
          toast({
            title: error instanceof Error ? error.message : t("Failed to load activity"),
            variant: "destructive",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [partner.partner_id, t, toast]);

  const actOnFailure = async (record: PartnerDeadLetter, action: "retry" | "discard") => {
    setActingOn(record.id);
    try {
      if (action === "retry") {
        await retryPartnerDeadLetter(partner.partner_id, record.id);
        toast({ title: t("Delivery retried successfully"), variant: "success" });
      } else {
        await discardPartnerDeadLetter(partner.partner_id, record.id, "Discarded by operator");
        toast({ title: t("Delivery failure discarded"), variant: "success" });
      }
      await loadOperationalState();
    } catch (error) {
      toast({
        title: error instanceof Error ? error.message : t("Action failed"),
        variant: "destructive",
      });
    } finally {
      setActingOn("");
    }
  };

  return (
    <div className="space-y-4">
      <section className="surface grid gap-4 p-5 sm:grid-cols-3">
        <div>
          <p className="text-xs text-muted-foreground">{t("Runtime status")}</p>
          <div className="mt-1 flex items-center gap-2 text-sm text-foreground">
            {partner.running ? (
              <CheckCircle2 className="h-4 w-4 text-success" />
            ) : (
              <Clock3 className="h-4 w-4 text-muted-foreground" />
            )}
            {partner.running ? t("Running") : t("Stopped")}
          </div>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">{t("Started at")}</p>
          <p className="mt-1 text-sm text-foreground">{formatDate(partner.started_at)}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">{t("Last reload")}</p>
          <div className="mt-1 flex items-center gap-2 text-sm text-foreground">
            {partner.last_reload_error ? (
              <AlertTriangle className="h-4 w-4 text-destructive" />
            ) : (
              <CheckCircle2 className="h-4 w-4 text-success" />
            )}
            {partner.last_reload_error || t("No reload errors")}
          </div>
        </div>
      </section>

      <section className="surface p-5">
        <div className="mb-4 flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-medium text-foreground">{t("Channel health")}</h3>
        </div>
        {channels === null ? (
          <Skeleton className="h-16 w-full" />
        ) : Object.keys(channels.channels).length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("No delivery channels configured")}</p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {Object.entries(channels.channels).map(([name, health]) => (
              <div key={name} className="rounded-lg border border-border p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-foreground">{name}</span>
                  <Badge variant={health.status === "healthy" ? "success" : "outline"}>
                    {t(health.status)}
                  </Badge>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  {health.capabilities.inbound_attachments || health.capabilities.outbound_attachments
                    ? t("Attachments supported")
                    : t("Text messages only")}
                  {health.capabilities.streaming ? ` · ${t("Streaming supported")}` : ""}
                </p>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="surface p-5">
        <div className="mb-4 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-warning" />
          <h3 className="text-sm font-medium text-foreground">{t("Delivery failures")}</h3>
          {failures && <Badge variant="outline">{failures.length}</Badge>}
        </div>
        {failures === null ? (
          <Skeleton className="h-20 w-full" />
        ) : failures.length === 0 ? (
          <EmptyState
            icon={CheckCircle2}
            title={t("No pending delivery failures")}
            description={t("Messages that exhaust automatic retries will appear here.")}
            className="min-h-32"
          />
        ) : (
          <ol className="space-y-2">
            {failures.map((record) => (
              <li key={record.id} className="rounded-lg border border-border p-3">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-foreground">{record.channel}</span>
                      <Badge variant="outline">{t("{{count}} attempts", { count: record.attempts })}</Badge>
                      <time className="text-xs text-muted-foreground">{formatDate(record.created_at)}</time>
                    </div>
                    <p className="mt-1 truncate text-sm text-foreground">{record.content}</p>
                    <p className="mt-1 text-xs text-destructive">{record.error_message}</p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      loading={actingOn === record.id}
                      onClick={() => void actOnFailure(record, "retry")}
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      {t("Retry")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={actingOn === record.id}
                      onClick={() => void actOnFailure(record, "discard")}
                    >
                      <XCircle className="h-3.5 w-3.5" />
                      {t("Discard")}
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="surface p-5">
        <div className="mb-4 flex items-center gap-2">
          <Activity className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-medium text-foreground">{t("Reminder activity")}</h3>
          {audit && <Badge variant="outline">{audit.length}</Badge>}
        </div>
        {audit === null ? (
          <div className="space-y-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : audit.length === 0 ? (
          <EmptyState
            icon={Activity}
            title={t("No activity yet")}
            description={t("Runtime and reminder decisions will appear here.")}
            className="min-h-36"
          />
        ) : (
          <ol className="space-y-2">
            {audit.map((entry, index) => (
              <li
                key={`${entry.at}:${entry.job_id ?? index}`}
                className="flex gap-3 rounded-lg border border-border px-3 py-2"
              >
                <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-foreground">
                      {t(entry.decision)}
                    </span>
                    <span className="text-xs text-muted-foreground">{t(entry.event)}</span>
                  </div>
                  {entry.reason && (
                    <p className="mt-0.5 text-xs text-muted-foreground">{t(entry.reason)}</p>
                  )}
                  {entry.error && (
                    <p className="mt-0.5 text-xs text-destructive">{entry.error}</p>
                  )}
                </div>
                <time className="shrink-0 text-xs text-muted-foreground">
                  {formatDate(entry.at)}
                </time>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
