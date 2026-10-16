"use client";

import * as React from "react";
import {
  AtSign,
  AlertTriangle,
  Database,
  Paperclip,
  Sparkles,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { Spinner } from "@/components/ui";
import type { MessageAttachment } from "@/lib/chat-types";
import type { SessionActivity } from "@/lib/session-activity";
import { docIconFor, formatBytes } from "@/lib/doc-attachments";
import FilePreviewDrawer from "@/components/chat/FilePreviewDrawer";
import { listDeletedKnowledgeReferences } from "@/lib/knowledge-api";
import { deletedKnowledgeBaseSet } from "@/lib/knowledge-references";

interface SessionActivityPanelProps {
  activity: SessionActivity;
  open: boolean;
  onClose: () => void;
}

/**
 * Conversation-level index of tools, references, uploads, and generated
 * deliverables. File preview code stays behind FilePreviewDrawer, so opening
 * Activity does not pull Office renderers into the chat's initial bundle.
 */
export function SessionActivityPanel({
  activity,
  open,
  onClose,
}: SessionActivityPanelProps) {
  const { t } = useTranslation();
  const [preview, setPreview] = React.useState<MessageAttachment | null>(null);
  const [contentReady, setContentReady] = React.useState(false);
  const [deletedKnowledgeBases, setDeletedKnowledgeBases] = React.useState<Set<string>>(
    () => new Set(),
  );

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void listDeletedKnowledgeReferences().then((rows) => {
      if (!cancelled) setDeletedKnowledgeBases(deletedKnowledgeBaseSet(rows));
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !preview) onClose();
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [onClose, open, preview]);

  if (!open) return null;

  return (
    <>
      <button
        type="button"
        aria-label={t("Close activity")}
        className="fixed inset-0 z-40 bg-overlay md:hidden"
        onClick={onClose}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={t("Session activity")}
        data-testid="session-activity-panel"
        className="fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-border bg-background shadow-overlay sm:w-[420px]"
      >
        <header className="flex items-center gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 className="display text-lg font-semibold text-foreground">
              {t("Session activity")}
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t("Tools, references, attachments, and generated files in this conversation.")}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("Close")}
            className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X size={16} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-4" aria-busy={!contentReady}>
          {!contentReady ? (
            <div
              className="flex min-h-72 w-full items-center justify-center"
              onAnimationStart={() => setContentReady(true)}
              style={{ animation: "activity-content-ready 1ms" }}
            >
              <Spinner size={18} className="text-muted-foreground" />
            </div>
          ) : activity.isEmpty ? (
            <div className="flex min-h-72 flex-col items-center justify-center px-8 text-center">
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <Wrench size={18} />
              </span>
              <h3 className="display mt-4 text-base font-medium text-foreground">
                {t("Nothing recorded yet")}
              </h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                {t("Tools, sources, uploads, and generated files will appear here as the conversation progresses.")}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {activity.artifacts.length > 0 ? (
                <ActivitySection
                  icon={Sparkles}
                  title={t("Generated files")}
                  count={activity.artifacts.length}
                >
                  {activity.artifacts.map(({ attachment, messageIndex }, index) => (
                    <AttachmentButton
                      key={`${attachment.id ?? attachment.filename ?? index}-${messageIndex}`}
                      attachment={attachment}
                      onClick={() => setPreview(attachment)}
                    />
                  ))}
                </ActivitySection>
              ) : null}

              {activity.attachments.length > 0 ? (
                <ActivitySection
                  icon={Paperclip}
                  title={t("Attachments")}
                  count={activity.attachments.length}
                >
                  {activity.attachments.map(({ attachment, messageIndex }, index) => (
                    <AttachmentButton
                      key={`${attachment.id ?? attachment.filename ?? index}-${messageIndex}`}
                      attachment={attachment}
                      onClick={() => setPreview(attachment)}
                    />
                  ))}
                </ActivitySection>
              ) : null}

              {activity.tools.length > 0 ? (
                <ActivitySection
                  icon={Wrench}
                  title={t("Tools used")}
                  count={activity.tools.length}
                >
                  <ul className="divide-y divide-border">
                    {activity.tools.map((tool) => (
                      <li key={tool.name} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                        <span className="truncate text-foreground">{tool.name}</span>
                        <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                          ×{tool.count}
                        </span>
                      </li>
                    ))}
                  </ul>
                </ActivitySection>
              ) : null}

              {activity.knowledgeBases.length > 0 ? (
                <ActivitySection
                  icon={Database}
                  title={t("Knowledge bases")}
                  count={activity.knowledgeBases.length}
                >
                  <ul className="divide-y divide-border">
                    {activity.knowledgeBases.map((name) => (
                      <li key={name} className="flex items-center gap-2 px-3 py-2 text-sm text-foreground">
                        <span className="min-w-0 flex-1 truncate">{name}</span>
                        {deletedKnowledgeBases.has(name) ? (
                          <span
                            className="flex shrink-0 items-center gap-1 rounded-full bg-warning-muted px-2 py-0.5 text-[11px] text-warning"
                            title={t("This source was deleted after the conversation was saved.")}
                          >
                            <AlertTriangle size={11} />
                            {t("Deleted source")}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </ActivitySection>
              ) : null}

              <SpaceReferences activity={activity} />
            </div>
          )}
        </div>
      </aside>
      {preview ? (
        <FilePreviewDrawer source={preview} onClose={() => setPreview(null)} />
      ) : null}
    </>
  );
}

function ActivitySection({
  icon: Icon,
  title,
  count,
  children,
}: {
  icon: LucideIcon;
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section className="surface overflow-hidden">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <Icon size={14} className="text-muted-foreground" />
        <h3 className="flex-1 text-xs font-semibold uppercase tracking-wide text-foreground">
          {title}
        </h3>
        <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
          {count}
        </span>
      </header>
      {children}
    </section>
  );
}

function AttachmentButton({
  attachment,
  onClick,
}: {
  attachment: MessageAttachment;
  onClick: () => void;
}) {
  const filename = attachment.filename || "untitled";
  const { Icon, label, tint } = docIconFor(filename);
  const detail = [
    label,
    attachment.generated && attachment.size_bytes !== undefined
      ? formatBytes(attachment.size_bytes)
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 border-b border-border px-3 py-2.5 text-left transition-colors last:border-b-0 hover:bg-muted"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
        <Icon size={15} className={tint} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">
          {filename}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {detail}
        </span>
      </span>
    </button>
  );
}

function SpaceReferences({ activity }: { activity: SessionActivity }) {
  const { t } = useTranslation();
  const rows = [
    [t("Chat history"), activity.space.historySessionIds.length],
    [t("Books"), activity.space.bookIds.length],
    [t("Notebooks"), activity.space.notebookIds.length],
    [t("Question bank"), activity.space.questionEntryIds.length],
    [t("Personas"), activity.space.personas.length],
    [t("Memory"), activity.space.memoryKinds.length],
  ].filter((row): row is [string, number] => Number(row[1]) > 0);
  if (rows.length === 0) return null;
  return (
    <ActivitySection icon={AtSign} title={t("Space references")} count={rows.length}>
      <ul className="divide-y divide-border">
        {rows.map(([label, count]) => (
          <li key={label} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
            <span className="text-foreground">{label}</span>
            <span className="text-xs text-muted-foreground">{count}</span>
          </li>
        ))}
      </ul>
    </ActivitySection>
  );
}

export default SessionActivityPanel;
