"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowUpRight, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** Sub-page header: serif display title + muted description. */
export function SettingsPageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <header className="mb-8 flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h2 className="display text-xl font-medium text-foreground">{title}</h2>
        {description && (
          <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </header>
  );
}

/** Titled group of setting rows on a hairline card. */
export function SettingSection({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("mb-8", className)}>
      <header className="mb-3">
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        {description && (
          <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
            {description}
          </p>
        )}
      </header>
      <div className="surface divide-y divide-border">{children}</div>
    </section>
  );
}

/** One label/description + control row inside a SettingSection. */
export function SettingRow({
  title,
  description,
  control,
}: {
  title: string;
  description?: string;
  control?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-6 px-4 py-3.5">
      <div className="min-w-0">
        <div className="text-sm text-foreground">{title}</div>
        {description && (
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {control && <div className="shrink-0">{control}</div>}
    </div>
  );
}

/** Card linking to the page that actually owns a settings area. */
export function SettingsLinkCard({
  href,
  icon: Icon,
  title,
  description,
  actionLabel,
}: {
  href: string;
  icon: LucideIcon;
  title: string;
  description: string;
  actionLabel: string;
}) {
  return (
    <Link
      href={href}
      className="group flex items-start gap-4 rounded-xl border border-border bg-card p-5 transition-colors duration-150 hover:border-ring"
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Icon size={18} strokeWidth={1.7} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-foreground">
          {title}
        </span>
        <span className="mt-1 block text-[13px] leading-relaxed text-muted-foreground">
          {description}
        </span>
        <span className="mt-3 inline-flex items-center gap-1 text-[13px] font-medium text-primary">
          {actionLabel}
          <ArrowUpRight
            size={14}
            className="transition-transform duration-150 group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
          />
        </span>
      </span>
    </Link>
  );
}
