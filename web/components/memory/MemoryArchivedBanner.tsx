"use client";

// One-time banner shown when a v1→v2 migration backup exists. Dismissal is
// remembered per backup directory name. Ported from the previous frontend.

import { useCallback, useState } from "react";
import { Archive, ChevronDown, ChevronUp, X } from "lucide-react";
import { useTranslation } from "react-i18next";

const STORAGE_KEY = "dt:memory:banner-dismissed";

export function MemoryArchivedBanner({
  latestBackup,
}: {
  latestBackup: string | null;
}) {
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return window.localStorage.getItem(STORAGE_KEY);
  });
  const [expanded, setExpanded] = useState(false);

  const dismiss = useCallback(() => {
    if (!latestBackup) return;
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, latestBackup);
    }
    setDismissed(latestBackup);
  }, [latestBackup]);

  if (!latestBackup || dismissed === latestBackup) return null;

  return (
    <div className="rounded-xl border border-border bg-muted-subtle text-xs">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-4 py-2 text-left"
      >
        <span className="flex items-center gap-2 text-muted-foreground">
          <Archive size={14} />
          {t("Your v1 memory was archived")}
        </span>
        {expanded ? (
          <ChevronUp size={14} className="text-muted-foreground" />
        ) : (
          <ChevronDown size={14} className="text-muted-foreground" />
        )}
      </button>
      {expanded && (
        <div className="relative border-t border-border px-4 py-3 pr-10 text-muted-foreground">
          {t(
            "Stored at memory/backup/{{name}}. v2 starts fresh — interact with Cognivoy and click Update on each doc to build memory.",
            { name: latestBackup },
          )}
          <button
            type="button"
            onClick={dismiss}
            aria-label={t("Dismiss")}
            className="absolute right-2 top-2 rounded-md p-1 text-muted-foreground transition hover:bg-background hover:text-foreground"
          >
            <X size={12} />
          </button>
        </div>
      )}
    </div>
  );
}
