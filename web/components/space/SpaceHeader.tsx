"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { useTranslation } from "react-i18next";

export interface SpaceHeaderProps {
  title: string;
  description?: string;
  /** Renders a "back to Space" link above the title (subpages only). */
  back?: boolean;
  /** Right-aligned actions (buttons, badges). */
  actions?: React.ReactNode;
}

/** Shared page header for the Space area: display title + muted description. */
export function SpaceHeader({
  title,
  description,
  back = false,
  actions,
}: SpaceHeaderProps) {
  const { t } = useTranslation();
  return (
    <header className="mb-6">
      {back && (
        <Link
          href="/space"
          className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeft size={14} aria-hidden="true" />
          {t("Space")}
        </Link>
      )}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="display text-2xl font-semibold text-foreground">
            {title}
          </h1>
          {description && (
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              {description}
            </p>
          )}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}
