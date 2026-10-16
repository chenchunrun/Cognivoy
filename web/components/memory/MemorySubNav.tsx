"use client";

// Sub-navigation shared by all /memory/* pages: layer workbenches, graph,
// settings. Active state is derived from the current pathname.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Database, GitCompareArrows, Layers, Network, Settings2, Workflow } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";

export function MemorySubNav() {
  const { t } = useTranslation();
  const pathname = usePathname();

  const entries = [
    { href: "/memory", label: t("Overview"), match: (p: string) => p === "/memory" },
    {
      href: "/memory/l1",
      icon: Layers,
      label: t("L1 · Workspace mirror"),
      match: (p: string) => p.startsWith("/memory/l1"),
    },
    {
      href: "/memory/l2",
      icon: Workflow,
      label: t("L2 · Per-surface summaries"),
      match: (p: string) => p.startsWith("/memory/l2"),
    },
    {
      href: "/memory/l3",
      icon: Network,
      label: t("L3 · Cross-surface knowledge"),
      match: (p: string) => p.startsWith("/memory/l3"),
    },
    {
      href: "/memory/graph",
      label: t("Memory graph"),
      match: (p: string) => p.startsWith("/memory/graph"),
    },
    {
      href: "/memory/resources",
      icon: Database,
      label: t("Memory details"),
      match: (p: string) => p.startsWith("/memory/resources"),
    },
    {
      href: "/memory/conflicts",
      icon: GitCompareArrows,
      label: t("Conflicts"),
      match: (p: string) => p.startsWith("/memory/conflicts"),
    },
    {
      href: "/memory/settings",
      icon: Settings2,
      label: t("Settings"),
      match: (p: string) => p.startsWith("/memory/settings"),
    },
  ];

  return (
    <nav className="flex flex-wrap items-center gap-1">
      {entries.map(({ href, icon: Icon, label, match }) => {
        const active = match(pathname);
        return (
          <Link
            key={href}
            href={href}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium transition-colors duration-150",
              active
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:bg-muted-subtle hover:text-foreground",
            )}
          >
            {Icon && <Icon size={14} />}
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
