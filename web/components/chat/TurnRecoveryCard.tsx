"use client";

import Link from "next/link";
import { RotateCcw, Settings2, Zap } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { TerminalRecovery } from "@/lib/chat-recovery";

const QUICK_CAPABILITIES = new Set([
  "deep_solve",
  "deep_research",
  "visualize",
  "math_animator",
]);

export default function TurnRecoveryCard({
  recovery,
  capability,
  onRetry,
  onQuickRetry,
}: {
  recovery: TerminalRecovery;
  capability?: string;
  onRetry: () => void;
  onQuickRetry: () => void;
}) {
  const { t } = useTranslation();
  if (!recovery.retryable) return null;
  const canQuickRetry = QUICK_CAPABILITIES.has(capability ?? "");
  return (
    <section className="mt-2 rounded-xl border border-warning-border bg-warning-muted p-3" data-testid="turn-recovery">
      <p className="text-sm font-medium text-foreground">{t("The task stopped before it finished")}</p>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        {recovery.timeoutSeconds
          ? t("No new events arrived for {{seconds}} seconds. Completed output above is preserved.", { seconds: recovery.timeoutSeconds })
          : t("Completed output above is preserved. You can retry without re-entering the request.")}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={onRetry} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-foreground hover:border-primary-border">
          <RotateCcw size={13} /> {t("Retry")}
        </button>
        {canQuickRetry ? (
          <button type="button" onClick={onQuickRetry} className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary-hover">
            <Zap size={13} /> {t("Retry in faster mode")}
          </button>
        ) : null}
        <Link href="/settings/chat" className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground">
          <Settings2 size={13} /> {t("Adjust timeout")}
        </Link>
      </div>
    </section>
  );
}
