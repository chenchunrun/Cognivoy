"use client";

import * as React from "react";
import { useTranslation } from "react-i18next";

import { apiFetch, apiUrl } from "@/lib/api";
import {
  MAX_CHAT_RESPONSE_TIMEOUT_SECONDS,
  MIN_CHAT_RESPONSE_TIMEOUT_SECONDS,
  clampChatResponseTimeout,
  normalizeDefaultCapability,
  writeStoredChatResponseTimeout,
  writeStoredDefaultCapability,
  type DefaultCapability,
} from "@/context/app-shell-storage";
import { Button, Input, Select, Skeleton, Toggle, useToast } from "@/components/ui";
import {
  SettingRow,
  SettingSection,
  SettingsPageHeader,
} from "@/components/settings/shared";

interface AttachmentSettings {
  max_file_mb: number;
  max_total_mb: number;
  max_chars_per_doc: number;
  max_chars_total: number;
}

interface AttachmentSettingsPayload {
  settings: AttachmentSettings;
  bounds: {
    max_file_mb: [number, number];
    max_total_mb: [number, number];
    chars: [number, number];
  };
}

export default function ChatSettingsPage() {
  const { t } = useTranslation();
  const { toast } = useToast();

  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);

  const [timeoutSeconds, setTimeoutSeconds] = React.useState(180);
  const [timeoutInitial, setTimeoutInitial] = React.useState(180);
  const [autoplay, setAutoplay] = React.useState(false);
  const [autoplayInitial, setAutoplayInitial] = React.useState(false);
  const [defaultCapability, setDefaultCapability] = React.useState<DefaultCapability>("auto");
  const [defaultCapabilityInitial, setDefaultCapabilityInitial] = React.useState<DefaultCapability>("auto");

  const [attachments, setAttachments] =
    React.useState<AttachmentSettings | null>(null);
  const [attachmentsInitial, setAttachmentsInitial] =
    React.useState<AttachmentSettings | null>(null);
  const [attachmentBounds, setAttachmentBounds] =
    React.useState<AttachmentSettingsPayload["bounds"] | null>(null);
  const [attachmentsUnavailable, setAttachmentsUnavailable] =
    React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(apiUrl("/api/v1/settings"));
        if (res.ok) {
          const data = (await res.json()) as {
            ui?: { chat_response_timeout?: number; voice_autoplay?: boolean; default_capability?: string };
          };
          if (cancelled) return;
          const value = clampChatResponseTimeout(
            Number(data.ui?.chat_response_timeout) || 180,
          );
          setTimeoutSeconds(value);
          setTimeoutInitial(value);
          writeStoredChatResponseTimeout(value);
          const voice = data.ui?.voice_autoplay === true;
          setAutoplay(voice);
          setAutoplayInitial(voice);
          const capability = normalizeDefaultCapability(data.ui?.default_capability);
          setDefaultCapability(capability);
          setDefaultCapabilityInitial(capability);
          writeStoredDefaultCapability(capability);
        }
      } catch {
        // Keep defaults; the save path surfaces real errors.
      }
      try {
        const res = await apiFetch(apiUrl("/api/v1/settings/chat-attachments"));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as AttachmentSettingsPayload;
        if (cancelled) return;
        setAttachments({ ...data.settings });
        setAttachmentsInitial({ ...data.settings });
        setAttachmentBounds(data.bounds);
      } catch {
        // Admin-only in multi-user deployments — hide the section.
        if (!cancelled) setAttachmentsUnavailable(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const attachmentsDirty =
    !!attachments &&
    !!attachmentsInitial &&
    JSON.stringify(attachments) !== JSON.stringify(attachmentsInitial);
  const dirty =
    timeoutSeconds !== timeoutInitial ||
    autoplay !== autoplayInitial ||
    defaultCapability !== defaultCapabilityInitial ||
    attachmentsDirty;

  async function save() {
    setSaving(true);
    try {
      if (timeoutSeconds !== timeoutInitial) {
        const value = clampChatResponseTimeout(timeoutSeconds);
        const res = await apiFetch(
          apiUrl("/api/v1/settings/chat-response-timeout"),
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_response_timeout: value }),
          },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setTimeoutSeconds(value);
        setTimeoutInitial(value);
        writeStoredChatResponseTimeout(value);
      }
      if (autoplay !== autoplayInitial) {
        const res = await apiFetch(apiUrl("/api/v1/settings/voice-autoplay"), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ voice_autoplay: autoplay }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setAutoplayInitial(autoplay);
      }
      if (defaultCapability !== defaultCapabilityInitial) {
        const res = await apiFetch(apiUrl("/api/v1/settings/ui"), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ default_capability: defaultCapability }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setDefaultCapabilityInitial(defaultCapability);
        writeStoredDefaultCapability(defaultCapability);
      }
      if (attachmentsDirty && attachments) {
        const res = await apiFetch(
          apiUrl("/api/v1/settings/chat-attachments"),
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(attachments),
          },
        );
        const data = (await res.json().catch(() => ({}))) as
          | AttachmentSettingsPayload
          | { detail?: string };
        if (!res.ok) {
          throw new Error(
            "detail" in data && data.detail
              ? String(data.detail)
              : `HTTP ${res.status}`,
          );
        }
        const next = data as AttachmentSettingsPayload;
        setAttachments({ ...next.settings });
        setAttachmentsInitial({ ...next.settings });
        setAttachmentBounds(next.bounds);
      }
      toast({ title: t("Chat settings saved"), variant: "success" });
    } catch (err) {
      toast({
        title: t("Failed to save chat settings"),
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div>
        <SettingsPageHeader
          title={t("Chat")}
          description={t(
            "Response timeout, voice playback, and attachment limits for chat.",
          )}
        />
        <div className="space-y-4">
          <Skeleton className="h-32" />
          <Skeleton className="h-48" />
        </div>
      </div>
    );
  }

  return (
    <div>
      <SettingsPageHeader
        title={t("Chat")}
        description={t(
          "Response timeout, voice playback, and attachment limits for chat.",
        )}
        action={
          <Button
            size="sm"
            onClick={() => void save()}
            loading={saving}
            disabled={!dirty}
          >
            {t("Save")}
          </Button>
        }
      />

      <SettingSection
        title={t("New chat defaults")}
        description={t("Choose how a new empty conversation starts. Existing conversations keep their saved capability.")}
      >
        <SettingRow
          title={t("Default capability")}
          description={t("Auto routes each request to the most suitable available capability.")}
          control={
            <Select
              aria-label={t("Default capability")}
              className="w-48"
              value={defaultCapability}
              onChange={(event) => setDefaultCapability(normalizeDefaultCapability(event.target.value))}
            >
              <option value="auto">{t("Auto")}</option>
              <option value="chat">{t("Chat")}</option>
              <option value="deep_solve">{t("Deep Solve")}</option>
              <option value="deep_question">{t("Quiz Generation")}</option>
              <option value="deep_research">{t("Deep Research")}</option>
              <option value="visualize">{t("Visualize")}</option>
              <option value="math_animator">{t("Math Animator")}</option>
              <option value="mastery_path">{t("Learning plan")}</option>
            </Select>
          }
        />
      </SettingSection>

      <SettingSection
        title={t("Chat response timeout")}
        description={t(
          "How long chat waits without receiving any progress before stopping. Long-running research and animation modes automatically use a safer minimum. Takes effect immediately.",
        )}
      >
        <SettingRow
          title={t("Timeout (seconds)")}
          description={t("Between {{min}} and {{max}} seconds.", {
            min: MIN_CHAT_RESPONSE_TIMEOUT_SECONDS,
            max: MAX_CHAT_RESPONSE_TIMEOUT_SECONDS,
          })}
          control={
            <Input
              type="number"
              aria-label={t("Timeout (seconds)")}
              className="w-28"
              min={MIN_CHAT_RESPONSE_TIMEOUT_SECONDS}
              max={MAX_CHAT_RESPONSE_TIMEOUT_SECONDS}
              value={timeoutSeconds}
              onChange={(e) => setTimeoutSeconds(Number(e.target.value))}
            />
          }
        />
      </SettingSection>

      <SettingSection
        title={t("Voice playback")}
        description={t(
          "Auto-play chat replies with the configured text-to-speech voice. A per-session override in chat wins over this default.",
        )}
      >
        <SettingRow
          title={t("Auto-play replies")}
          control={
            <Toggle
              checked={autoplay}
              onCheckedChange={setAutoplay}
              aria-label={t("Auto-play replies")}
            />
          }
        />
      </SettingSection>

      {attachments && !attachmentsUnavailable && (
        <SettingSection
          title={t("Attachments")}
          description={t(
            "Upload caps and extraction budgets for files attached in chat. Raising size limits needs a backend restart; lower limits apply immediately.",
          )}
        >
          <SettingRow
            title={t("Max file size (MB)")}
            description={t("Largest single file the composer accepts.")}
            control={
              <Input
                type="number"
                aria-label={t("Max file size (MB)")}
                className="w-28"
                min={attachmentBounds?.max_file_mb[0] ?? 1}
                max={attachmentBounds?.max_file_mb[1] ?? 1024}
                value={attachments.max_file_mb}
                onChange={(e) =>
                  setAttachments((current) =>
                    current
                      ? { ...current, max_file_mb: Number(e.target.value) }
                      : current,
                  )
                }
              />
            }
          />
          <SettingRow
            title={t("Max total per message (MB)")}
            description={t(
              "Combined size of all attachments on a single message.",
            )}
            control={
              <Input
                type="number"
                aria-label={t("Max total per message (MB)")}
                className="w-28"
                min={attachmentBounds?.max_total_mb[0] ?? 1}
                max={attachmentBounds?.max_total_mb[1] ?? 2048}
                value={attachments.max_total_mb}
                onChange={(e) =>
                  setAttachments((current) =>
                    current
                      ? { ...current, max_total_mb: Number(e.target.value) }
                      : current,
                  )
                }
              />
            }
          />
          <SettingRow
            title={t("Max characters per document")}
            description={t(
              "Text extracted beyond this from one file is truncated.",
            )}
            control={
              <Input
                type="number"
                aria-label={t("Max characters per document")}
                className="w-36"
                min={attachmentBounds?.chars[0] ?? 10000}
                max={attachmentBounds?.chars[1] ?? 5000000}
                step={10000}
                value={attachments.max_chars_per_doc}
                onChange={(e) =>
                  setAttachments((current) =>
                    current
                      ? {
                          ...current,
                          max_chars_per_doc: Number(e.target.value),
                        }
                      : current,
                  )
                }
              />
            }
          />
          <SettingRow
            title={t("Max characters per message")}
            description={t(
              "Total extracted text across all documents on one message.",
            )}
            control={
              <Input
                type="number"
                aria-label={t("Max characters per message")}
                className="w-36"
                min={attachmentBounds?.chars[0] ?? 10000}
                max={attachmentBounds?.chars[1] ?? 5000000}
                step={10000}
                value={attachments.max_chars_total}
                onChange={(e) =>
                  setAttachments((current) =>
                    current
                      ? { ...current, max_chars_total: Number(e.target.value) }
                      : current,
                  )
                }
              />
            }
          />
        </SettingSection>
      )}
    </div>
  );
}
