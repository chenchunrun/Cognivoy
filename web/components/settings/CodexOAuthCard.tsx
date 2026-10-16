"use client";

import * as React from "react";
import { CheckCircle2, ExternalLink, RefreshCw, Unplug } from "lucide-react";
import { useTranslation } from "react-i18next";

import { invalidateLLMOptionsCache } from "@/lib/llm-options";
import {
  CodexOAuthApiError,
  cancelCodexLogin,
  getCodexStatus,
  logoutCodex,
  refreshCodexModels,
  shouldPollCodexStatus,
  startCodexLogin,
  type CodexOAuthStatus,
} from "@/lib/codex-oauth";
import { Badge, Button, useToast } from "@/components/ui";
import { SettingSection } from "./shared";

/**
 * ChatGPT-account (Codex OAuth) sign-in card. Talks only to the per-user
 * /settings/providers/openai-codex/oauth/* endpoints. Simplified port of the
 * old CodexOAuthCard: start → open authorize URL → poll → connected, plus
 * refresh-models and logout. The old card's remote/SSH-forward guidance and
 * catalog reload coordination are not ported.
 */
export function CodexOAuthCard() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [status, setStatus] = React.useState<CodexOAuthStatus | null>(null);
  const [pending, setPending] = React.useState<string | null>(null);

  const reportError = React.useCallback(
    (error: unknown) => {
      toast({
        title: t("Codex sign-in failed"),
        description:
          error instanceof CodexOAuthApiError || error instanceof Error
            ? error.message
            : String(error),
        variant: "destructive",
      });
    },
    [t, toast],
  );

  const loadStatus = React.useCallback(async () => {
    try {
      const next = await getCodexStatus();
      setStatus(next);
      return next;
    } catch (error) {
      reportError(error);
      return null;
    }
  }, [reportError]);

  React.useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  // Poll while an authorization is in flight.
  React.useEffect(() => {
    if (!status || !shouldPollCodexStatus(status)) return;
    const timer = window.setInterval(() => {
      void (async () => {
        const next = await loadStatus();
        if (next?.operation_state === "completed") {
          invalidateLLMOptionsCache();
          toast({
            title: t("Codex account connected"),
            variant: "success",
          });
        }
      })();
    }, 1500);
    return () => window.clearInterval(timer);
  }, [loadStatus, status, t, toast]);

  async function act(
    key: string,
    fn: () => Promise<CodexOAuthStatus>,
    onDone?: (next: CodexOAuthStatus) => void,
  ) {
    setPending(key);
    try {
      const next = await fn();
      setStatus(next);
      invalidateLLMOptionsCache();
      onDone?.(next);
    } catch (error) {
      reportError(error);
    } finally {
      setPending(null);
    }
  }

  async function signIn() {
    setPending("start");
    try {
      const start = await startCodexLogin();
      window.open(start.authorize_url, "_blank", "noopener,noreferrer");
      await loadStatus();
    } catch (error) {
      reportError(error);
    } finally {
      setPending(null);
    }
  }

  const authorizing = status ? shouldPollCodexStatus(status) : false;
  const connected = status?.connection === "connected";

  return (
    <SettingSection
      title={t("ChatGPT account (Codex OAuth)")}
      description={t(
        "Sign in with a ChatGPT plan to use its models as an LLM provider, instead of an API key.",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5">
        <div className="flex min-w-0 items-center gap-2.5">
          {connected ? (
            <>
              <CheckCircle2 size={15} className="shrink-0 text-success" />
              <span className="text-sm text-foreground">
                {t("Connected")}
                {status?.active_model ? ` · ${status.active_model}` : ""}
              </span>
              {status?.activated && (
                <Badge variant="success">{t("Active provider")}</Badge>
              )}
            </>
          ) : authorizing ? (
            <span className="text-sm text-muted-foreground">
              {t("Waiting for sign-in to finish in the browser...")}
            </span>
          ) : (
            <span className="text-sm text-muted-foreground">
              {t("Not connected")}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {connected ? (
            <>
              <Button
                variant="outline"
                size="sm"
                loading={pending === "refresh"}
                onClick={() => void act("refresh", refreshCodexModels)}
              >
                <RefreshCw size={13} />
                {t("Refresh models")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                loading={pending === "logout"}
                onClick={() => void act("logout", logoutCodex)}
              >
                <Unplug size={13} />
                {t("Log out")}
              </Button>
            </>
          ) : authorizing ? (
            <Button
              variant="outline"
              size="sm"
              loading={pending === "cancel"}
              onClick={() => void act("cancel", cancelCodexLogin)}
            >
              {t("Cancel")}
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              loading={pending === "start"}
              onClick={() => void signIn()}
            >
              <ExternalLink size={13} />
              {t("Sign in with ChatGPT")}
            </Button>
          )}
        </div>
      </div>
    </SettingSection>
  );
}
