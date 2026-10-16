"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslation } from "react-i18next";
import {
  Activity,
  Bot,
  Brain,
  Cpu,
  FileText,
  Globe,
  Image,
  Layers,
  MessageSquare,
  Mic,
  Palette,
  Plug,
  ScanLine,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Video,
  Volume2,
  Wrench,
} from "lucide-react";

import { cn } from "@/lib/utils";

const NAV_GROUPS = [
  {
    labelKey: "General",
    items: [
      { href: "/settings", labelKey: "Overview", icon: Settings2 },
      { href: "/settings/appearance", labelKey: "Appearance", icon: Palette },
      { href: "/settings/chat", labelKey: "Chat", icon: MessageSquare },
    ],
  },
  {
    labelKey: "Models",
    items: [
      { href: "/settings/llm", labelKey: "LLM", icon: Cpu },
      { href: "/settings/embedding", labelKey: "Embedding", icon: Layers },
      { href: "/settings/search", labelKey: "Search", icon: Search },
      { href: "/settings/tts", labelKey: "TTS", icon: Volume2 },
      { href: "/settings/stt", labelKey: "STT", icon: Mic },
      { href: "/settings/image", labelKey: "Image", icon: Image },
      { href: "/settings/video", labelKey: "Video", icon: Video },
    ],
  },
  {
    labelKey: "Advanced",
    items: [
      { href: "/settings/tools", labelKey: "Tools", icon: Wrench },
      { href: "/settings/capabilities", labelKey: "Capabilities", icon: Sparkles },
      { href: "/settings/network", labelKey: "Network", icon: Globe },
      { href: "/settings/memory", labelKey: "Memory", icon: Brain },
      {
        href: "/settings/document-parsing",
        labelKey: "Document Parsing",
        icon: FileText,
      },
      { href: "/settings/mineru", labelKey: "MinerU", icon: ScanLine },
      { href: "/settings/mcp", labelKey: "MCP", icon: Plug },
      { href: "/settings/agents", labelKey: "Agents", icon: Bot },
    ],
  },
  {
    labelKey: "System",
    items: [
      { href: "/settings/status", labelKey: "Status", icon: Activity },
      {
        href: "/settings/control-plane",
        labelKey: "Control plane",
        icon: ShieldCheck,
      },
    ],
  },
] as const;

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const pathname = usePathname();

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 md:px-8 md:py-10">
      <h1 className="display text-2xl font-semibold text-foreground">
        {t("Settings")}
      </h1>
      <div className="mt-6 flex flex-col gap-8 xl:flex-row">
        <nav
          aria-label={t("Settings")}
          className="shrink-0 xl:w-52"
        >
          <div className="flex gap-6 overflow-x-auto pb-2 xl:flex-col xl:gap-5 xl:overflow-visible xl:pb-0">
            {NAV_GROUPS.map((group) => (
              <div key={group.labelKey}>
                <div className="px-2.5 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  {t(group.labelKey)}
                </div>
                <div className="flex gap-0.5 xl:flex-col">
                  {group.items.map((item) => {
                    const active =
                      pathname === item.href ||
                      (item.href !== "/settings" && pathname.startsWith(`${item.href}/`));
                    const Icon = item.icon;
                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "flex items-center gap-2 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-sm transition-colors duration-150",
                          active
                            ? "bg-muted font-medium text-foreground"
                            : "text-muted-foreground hover:bg-muted hover:text-foreground",
                        )}
                      >
                        <Icon size={15} className="shrink-0" />
                        {t(item.labelKey)}
                      </Link>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </nav>
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}
