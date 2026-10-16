"use client";

/**
 * Partner detail: identity + lifecycle controls and eight responsibility tabs.
 *
 * The Chat tab stays mounted (hidden off-tab) so an in-progress turn — its
 * WebSocket and live stream — survives switching to another tab.
 */

import * as React from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft,
  BookHeart,
  History,
  BellRing,
  LayoutDashboard,
  MessageCircle,
  PackageOpen,
  Play,
  Radio,
  ScrollText,
  Square,
  Trash2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  destroyPartner,
  getPartner,
  startPartner,
  stopPartner,
  type PartnerInfo,
} from "@/lib/partners-api";
import {
  loadPartnerSessionKey,
  persistPartnerSessionKey,
} from "@/lib/partner-session";
import {
  Avatar,
  Button,
  ConfirmDialog,
  EmptyState,
  Skeleton,
  Tabs,
  TabsList,
  TabsTrigger,
  useToast,
} from "@/components/ui";
import { PartnerChat } from "@/components/partners/partner-chat";
import { PartnerConfig } from "@/components/partners/partner-config";
import { SoulEditor } from "@/components/partners/soul-editor";
import { PartnerSessions } from "@/components/partners/partner-sessions";
import { PartnerProactive } from "@/components/partners/partner-proactive";
import { PartnerResources } from "@/components/partners/partner-resources";
import { PartnerActivity } from "@/components/partners/partner-activity";
import {
  PARTNER_DETAIL_TABS,
  type PartnerDetailTab,
} from "@/lib/partner-detail";
import { cn } from "@/lib/utils";

const TAB_ICONS = {
  overview: LayoutDashboard,
  chat: MessageCircle,
  soul: BookHeart,
  resources: PackageOpen,
  channels: Radio,
  sessions: History,
  proactive: BellRing,
  activity: ScrollText,
} satisfies Record<PartnerDetailTab, typeof MessageCircle>;

export default function PartnerDetailPage() {
  const params = useParams<{ partnerId: string }>();
  const router = useRouter();
  const { t } = useTranslation();
  const { toast } = useToast();
  const partnerId = params.partnerId;

  const [tab, setTab] = React.useState<PartnerDetailTab>("overview");
  const [partner, setPartner] = React.useState<PartnerInfo | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [lifecycleBusy, setLifecycleBusy] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);

  // The active web session key lives here so the Sessions tab's Open can
  // point the (always-mounted) Chat tab at a different conversation.
  const [sessionKey, setSessionKey] = React.useState("");
  React.useEffect(() => {
    setSessionKey(loadPartnerSessionKey(partnerId));
  }, [partnerId]);
  const changeSessionKey = React.useCallback(
    (key: string) => {
      persistPartnerSessionKey(partnerId, key);
      setSessionKey(key);
    },
    [partnerId],
  );

  const load = React.useCallback(async () => {
    try {
      setPartner(await getPartner(partnerId));
    } catch {
      setPartner(null);
    } finally {
      setLoading(false);
    }
  }, [partnerId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const toggleRunning = async () => {
    if (!partner) return;
    setLifecycleBusy(true);
    try {
      if (partner.running) {
        await stopPartner(partnerId);
        toast({ title: t("Partner stopped"), variant: "success" });
      } else {
        await startPartner(partnerId);
        toast({ title: t("Partner started"), variant: "success" });
      }
      await load();
    } catch (e) {
      toast({
        title: e instanceof Error ? e.message : t("Action failed"),
        variant: "destructive",
      });
    } finally {
      setLifecycleBusy(false);
    }
  };

  const handleDestroy = async () => {
    setDeleting(true);
    try {
      await destroyPartner(partnerId);
      router.push("/partners");
    } catch (e) {
      toast({
        title: e instanceof Error ? e.message : t("Delete failed"),
        variant: "destructive",
      });
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  if (loading) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-3 border-b border-border px-5 py-3">
          <Skeleton className="h-8 w-8 rounded-full" />
          <div className="space-y-1.5">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-64" />
          </div>
        </div>
        <div className="mx-auto w-full max-w-3xl space-y-3 px-5 py-6">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      </div>
    );
  }

  if (!partner) {
    return (
      <EmptyState
        icon={MessageCircle}
        title={t("Partner not found")}
        description={t("It may have been deleted, or the link is wrong.")}
        action={
          <Button variant="outline" onClick={() => router.push("/partners")}>
            {t("Back to Partners")}
          </Button>
        }
        className="h-full"
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-3">
        <Link
          href="/partners"
          aria-label={t("Back to Partners")}
          title={t("Back to Partners")}
          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <Avatar src={partner.avatar || null} alt={partner.name} size="md" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="display truncate text-base font-medium text-foreground">
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
            <p className="truncate text-xs text-muted-foreground">
              {partner.description}
            </p>
          ) : null}
        </div>

        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant={partner.running ? "secondary" : "outline"}
            loading={lifecycleBusy}
            onClick={() => void toggleRunning()}
          >
            {partner.running ? (
              <Square className="h-3.5 w-3.5" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
            {partner.running ? t("Stop") : t("Start")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={() => setConfirmDelete(true)}
            title={t("Delete partner")}
            aria-label={t("Delete partner")}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as PartnerDetailTab)}
        className="overflow-x-auto border-b border-border px-5 pb-2"
      >
        <TabsList className="min-w-max">
          {PARTNER_DETAIL_TABS.map((item) => {
            const Icon = TAB_ICONS[item.id];
            return (
              <TabsTrigger key={item.id} value={item.id}>
                <Icon className="h-3.5 w-3.5" />
                {t(item.label)}
              </TabsTrigger>
            );
          })}
        </TabsList>
      </Tabs>

      {/* Body */}
      <div className="min-h-0 flex-1">
        <div className={tab === "chat" ? "h-full" : "hidden"}>
          <div className="mx-auto h-full max-w-3xl px-5">
            {sessionKey && (
              <PartnerChat
                partnerId={partnerId}
                partnerName={partner.name}
                partnerAvatar={partner.avatar}
                running={partner.running}
                sessionKey={sessionKey}
                onSessionKeyChange={changeSessionKey}
              />
            )}
          </div>
        </div>
        {tab === "overview" && (
          <div className="mx-auto h-full max-w-3xl overflow-y-auto px-5 py-5">
            <PartnerConfig
              partner={partner}
              onUpdated={(next) => setPartner(next)}
              view="overview"
            />
          </div>
        )}
        {tab === "soul" && (
          <div className="mx-auto h-full max-w-3xl overflow-y-auto px-5 py-5">
            <SoulEditor partnerId={partnerId} />
          </div>
        )}
        {tab === "sessions" && (
          <div className="mx-auto h-full max-w-3xl overflow-y-auto px-5 py-5">
            <PartnerSessions
              partnerId={partnerId}
              activeSessionKey={sessionKey}
              onResume={(key) => {
                changeSessionKey(key);
                setTab("chat");
              }}
            />
          </div>
        )}
        {tab === "resources" && (
          <div className="mx-auto h-full max-w-3xl overflow-y-auto px-5 py-5">
            <div className="space-y-4">
              <PartnerResources partnerId={partnerId} />
              <PartnerConfig
                partner={partner}
                onUpdated={(next) => setPartner(next)}
                view="capabilities"
              />
            </div>
          </div>
        )}
        {tab === "channels" && (
          <div className="mx-auto h-full max-w-3xl overflow-y-auto px-5 py-5">
            <PartnerConfig
              partner={partner}
              onUpdated={(next) => setPartner(next)}
              view="channels"
            />
          </div>
        )}
        {tab === "proactive" && (
          <div className="mx-auto h-full max-w-3xl overflow-y-auto px-5 py-5">
            <div className="space-y-4">
              <PartnerConfig
                partner={partner}
                onUpdated={(next) => setPartner(next)}
                view="proactive"
              />
              <PartnerProactive partnerId={partnerId} />
            </div>
          </div>
        )}
        {tab === "activity" && (
          <div className="mx-auto h-full max-w-3xl overflow-y-auto px-5 py-5">
            <PartnerActivity partner={partner} />
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => void handleDestroy()}
        title={t("Delete {{name}}?", { name: partner.name })}
        description={t(
          "This removes the partner and ALL its data — workspace, sessions, and channel wiring. This cannot be undone.",
        )}
        confirmText={t("Delete")}
        cancelText={t("Cancel")}
        destructive
        loading={deleting}
      />
    </div>
  );
}
