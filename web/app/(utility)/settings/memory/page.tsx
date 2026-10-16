"use client";

import { Brain } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  SettingsLinkCard,
  SettingsPageHeader,
} from "@/components/settings/shared";

export default function MemorySettingsPage() {
  const { t } = useTranslation();
  return (
    <div>
      <SettingsPageHeader
        title={t("Memory")}
        description={t(
          "Memory budgets, consolidation, and chunking now live with the memory workbench.",
        )}
      />
      <SettingsLinkCard
        href="/memory"
        icon={Brain}
        title={t("Open memory settings")}
        description={t(
          "Tune Update / Audit / Dedup budgets, chunking, and reference validation in the memory workbench.",
        )}
        actionLabel={t("Go to Memory")}
      />
    </div>
  );
}
