"use client";

import { useTranslation } from "react-i18next";
import { Badge, type BadgeVariant } from "@/components/ui";
import {
  kbHasLiveProgress,
  kbNeedsReindex,
  kbProvider,
  resolveKbStatus,
  type KnowledgeBase,
} from "@/lib/knowledge-helpers";

/** Terracotta-accented chip naming the retrieval engine a KB is bound to. */
export function EngineBadge({ kb }: { kb: KnowledgeBase }) {
  const provider = kbProvider(kb);
  return (
    <Badge variant="primary" className="font-mono text-[11px]">
      {provider}
    </Badge>
  );
}

interface StatusView {
  variant: BadgeVariant;
  label: string;
}

function statusView(
  kb: KnowledgeBase,
  t: (key: string) => string,
): StatusView {
  if (kbHasLiveProgress(kb)) {
    return { variant: "warning", label: t("Indexing") };
  }
  if (kbNeedsReindex(kb)) {
    return { variant: "warning", label: t("Needs re-index") };
  }
  const status = resolveKbStatus(kb);
  switch (status) {
    case "ready":
      return { variant: "success", label: t("Ready") };
    case "error":
      return { variant: "destructive", label: t("Error") };
    case "cancelled":
      return { variant: "default", label: t("Cancelled") };
    case "empty":
      return { variant: "default", label: t("Empty") };
    default:
      return { variant: "default", label: status };
  }
}

export function KbStatusBadge({ kb }: { kb: KnowledgeBase }) {
  const { t } = useTranslation();
  const view = statusView(kb, t);
  return <Badge variant={view.variant}>{view.label}</Badge>;
}

/**
 * Per-file status badge. Raw file entries carry no indexing state of their
 * own, so the badge reflects the KB's current phase.
 */
export function KbFileStatusBadge({ kb }: { kb: KnowledgeBase }) {
  const { t } = useTranslation();
  if (kbHasLiveProgress(kb)) {
    return <Badge variant="warning">{t("Indexing")}</Badge>;
  }
  const status = resolveKbStatus(kb);
  if (status === "ready") return <Badge variant="success">{t("Indexed")}</Badge>;
  if (status === "error") return <Badge variant="destructive">{t("Failed")}</Badge>;
  return <Badge variant="default">{t("Pending")}</Badge>;
}
