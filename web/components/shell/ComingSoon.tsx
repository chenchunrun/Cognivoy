"use client";

import type { LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { EmptyState } from "@/components/ui";

export function ComingSoon({
  icon,
  title,
}: {
  icon: LucideIcon;
  title: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-[70vh] items-center justify-center">
      <EmptyState
        icon={icon}
        title={title}
        description={t("Coming soon in this redesign")}
      />
    </div>
  );
}
