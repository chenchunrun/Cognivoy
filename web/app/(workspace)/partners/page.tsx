"use client";

/**
 * Partners — IM-connected companions driven by the chat agent loop.
 * List page: one card per partner with identity, channel badges, run state
 * and start/stop control; creation lives at /partners/new.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { BellRing, HeartHandshake, Play, Plus, Square } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  listPartners,
  startPartner,
  stopPartner,
  type PartnerInfo,
} from "@/lib/partners-api";
import {
  Avatar,
  Badge,
  Button,
  EmptyState,
  Skeleton,
  useToast,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/shell/PageHeader";

function channelNames(partner: PartnerInfo): string[] {
  if (Array.isArray(partner.channels)) {
    return partner.channels.filter(
      (n) => n !== "send_progress" && n !== "send_tool_hints",
    );
  }
  return [];
}

export default function PartnersPage() {
  const router = useRouter();
  const { t } = useTranslation();
  const { toast } = useToast();
  const [partners, setPartners] = React.useState<PartnerInfo[] | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      setPartners(await listPartners());
    } catch (e) {
      setPartners([]);
      toast({
        title: e instanceof Error ? e.message : t("Failed to load partners"),
        variant: "destructive",
      });
    }
  }, [t, toast]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const toggleRunning = async (partner: PartnerInfo) => {
    setBusyId(partner.partner_id);
    try {
      if (partner.running) {
        await stopPartner(partner.partner_id);
        toast({
          title: t("{{name}} stopped", { name: partner.name }),
          variant: "success",
        });
      } else {
        await startPartner(partner.partner_id);
        toast({
          title: t("{{name}} started", { name: partner.name }),
          variant: "success",
        });
      }
      await load();
    } catch (e) {
      toast({
        title: e instanceof Error ? e.message : t("Action failed"),
        variant: "destructive",
      });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="mx-auto h-full max-w-7xl overflow-y-auto px-6 py-8">
      <PageHeader
        title={t("Tutors")}
        description={t(
          "Create a personal tutor that follows your learning goals, uses trusted materials, and reminds you when it is time to review.",
        )}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => router.push("/partners/reminders")}>
              <BellRing className="h-4 w-4" />
              {t("Reminder center")}
            </Button>
            <Button onClick={() => router.push("/partners/new")}>
              <Plus className="h-4 w-4" />
              {t("New tutor")}
            </Button>
          </div>
        }
      />

      {partners === null ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28 w-full rounded-xl" />
          ))}
        </div>
      ) : partners.length === 0 ? (
        <EmptyState
          icon={HeartHandshake}
          title={t("No tutors yet")}
          description={t(
            "Create a tutor, connect it to a learning goal and trusted materials, then choose whether it should remind you here or in your messaging apps.",
          )}
          action={
            <Button onClick={() => router.push("/partners/new")}>
              <Plus className="h-4 w-4" />
              {t("Create your first tutor")}
            </Button>
          }
          className="min-h-[360px] rounded-xl border border-dashed border-border"
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {partners.map((partner) => {
            const channels = channelNames(partner);
            const busy = busyId === partner.partner_id;
            return (
              <div
                key={partner.partner_id}
                className="surface group relative flex cursor-pointer items-start gap-3 p-4 text-left transition-colors duration-150 hover:border-ring"
              >
                <button
                  type="button"
                  className="absolute inset-0 z-10 rounded-xl"
                  aria-label={t("Open {{name}}", { name: partner.name })}
                  onClick={() => router.push(`/partners/${partner.partner_id}`)}
                />
                <Avatar
                  src={partner.avatar || null}
                  alt={partner.name}
                  size="lg"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-foreground">
                      {partner.name}
                    </span>
                    <span
                      title={partner.running ? t("Running") : t("Stopped")}
                      className={cn(
                        "h-1.5 w-1.5 shrink-0 rounded-full",
                        partner.running ? "bg-success" : "bg-border",
                      )}
                    />
                  </div>
                  {partner.description ? (
                    <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                      {partner.description}
                    </p>
                  ) : null}
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {channels.length > 0 ? (
                      channels.map((channel) => (
                        <Badge key={channel} variant="default">
                          {channel}
                        </Badge>
                      ))
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        {t("No channels connected")}
                      </span>
                    )}
                  </div>
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  loading={busy}
                  disabled={busyId !== null && !busy}
                  title={partner.running ? t("Stop") : t("Start")}
                  aria-label={partner.running ? t("Stop") : t("Start")}
                  className="relative z-20"
                  onClick={() => {
                    void toggleRunning(partner);
                  }}
                >
                  {partner.running ? (
                    <Square className="h-3.5 w-3.5" />
                  ) : (
                    <Play className="h-3.5 w-3.5" />
                  )}
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
