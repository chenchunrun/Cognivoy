"use client";

/**
 * Sessions tab: every conversation this partner has had (web + channels),
 * newest first. Resume points the Chat tab at that conversation; archive
 * hides it from the partner's active context; delete removes it for good.
 */

import * as React from "react";
import { useTranslation } from "react-i18next";
import { Archive, MessagesSquare, RotateCcw, Trash2 } from "lucide-react";
import {
  archivePartnerSession,
  deletePartnerSession,
  getPartnerSessions,
  resumePartnerSession,
  type PartnerSessionInfo,
} from "@/lib/partners-api";
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  Skeleton,
  useToast,
} from "@/components/ui";

function formatUpdatedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function PartnerSessions({
  partnerId,
  activeSessionKey,
  onResume,
}: {
  partnerId: string;
  activeSessionKey: string;
  /** Point the Chat tab at the given conversation. */
  onResume: (sessionKey: string) => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [sessions, setSessions] = React.useState<PartnerSessionInfo[] | null>(
    null,
  );
  const [busyKey, setBusyKey] = React.useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] =
    React.useState<PartnerSessionInfo | null>(null);
  const [deleting, setDeleting] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      setSessions(await getPartnerSessions(partnerId));
    } catch (e) {
      setSessions([]);
      toast({
        title: e instanceof Error ? e.message : t("Failed to load sessions"),
        variant: "destructive",
      });
    }
  }, [partnerId, t, toast]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const handleResume = async (session: PartnerSessionInfo) => {
    setBusyKey(session.session_key);
    try {
      await resumePartnerSession(partnerId, session.session_key);
      onResume(session.session_key);
    } catch (e) {
      toast({
        title: e instanceof Error ? e.message : t("Session not found"),
        variant: "destructive",
      });
    } finally {
      setBusyKey(null);
    }
  };

  const handleArchive = async (session: PartnerSessionInfo) => {
    setBusyKey(session.session_key);
    try {
      await archivePartnerSession(partnerId, session.session_key);
      toast({ title: t("Conversation archived"), variant: "success" });
      await load();
    } catch (e) {
      toast({
        title: e instanceof Error ? e.message : t("Action failed"),
        variant: "destructive",
      });
    } finally {
      setBusyKey(null);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deletePartnerSession(partnerId, deleteTarget.session_key);
      toast({ title: t("Conversation deleted"), variant: "success" });
      setDeleteTarget(null);
      await load();
    } catch (e) {
      toast({
        title: e instanceof Error ? e.message : t("Delete failed"),
        variant: "destructive",
      });
    } finally {
      setDeleting(false);
    }
  };

  if (sessions === null) {
    return (
      <div className="space-y-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <EmptyState
        icon={MessagesSquare}
        title={t("No conversations yet")}
        description={t(
          "Once you or someone on a connected channel talks to this partner, the conversations will show up here.",
        )}
      />
    );
  }

  return (
    <div className="space-y-2">
      {sessions.map((session) => {
        const isActive = session.session_key === activeSessionKey;
        return (
          <div
            key={session.session_key}
            className="surface flex items-center gap-3 px-4 py-3"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium text-foreground">
                  {session.title || t("New conversation")}
                </span>
                {isActive && (
                  <Badge variant="primary">{t("Current")}</Badge>
                )}
                {session.archived && (
                  <Badge variant="outline">{t("Archived")}</Badge>
                )}
              </div>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                <span className="font-mono">{session.session_key}</span>
                {" · "}
                {t("{{count}} messages", { count: session.message_count })}
                {" · "}
                {formatUpdatedAt(session.updated_at)}
              </p>
              {session.last_message && (
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  {session.last_message}
                </p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {!isActive && (
                <Button
                  size="sm"
                  variant="ghost"
                  loading={busyKey === session.session_key}
                  onClick={() => void handleResume(session)}
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  {t("Open")}
                </Button>
              )}
              {!session.archived && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busyKey === session.session_key}
                  onClick={() => void handleArchive(session)}
                >
                  <Archive className="h-3.5 w-3.5" />
                  {t("Archive")}
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                onClick={() => setDeleteTarget(session)}
              >
                <Trash2 className="h-3.5 w-3.5" />
                {t("Delete")}
              </Button>
            </div>
          </div>
        );
      })}

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void handleDelete()}
        title={t("Delete this conversation?")}
        description={t(
          "The conversation \"{{title}}\" will be permanently removed. This cannot be undone.",
          { title: deleteTarget?.title || deleteTarget?.session_key || "" },
        )}
        confirmText={t("Delete")}
        cancelText={t("Cancel")}
        destructive
        loading={deleting}
      />
    </div>
  );
}
