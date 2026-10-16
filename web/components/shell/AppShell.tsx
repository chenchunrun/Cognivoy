"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTranslation } from "react-i18next";
import { Menu, PanelLeft } from "lucide-react";

import { AppShellProvider, useAppShell } from "@/context/AppShellContext";
import { UnifiedChatProvider, useUnifiedChat } from "@/context/UnifiedChatContext";
import { cn } from "@/lib/utils";
import { Button, ToastProvider } from "@/components/ui";
import { Sidebar } from "./Sidebar";
import { CapabilityAccessProvider } from "@/components/access/CapabilityAccessContext";
import { CapabilityGate } from "@/components/access/CapabilityGate";
import { removeStaleMermaidArtifacts } from "@/lib/mermaid-render";

function ShellFrame({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const pathname = usePathname();
  const router = useRouter();
  const { newSession } = useUnifiedChat();
  const { sidebarCollapsed, setSidebarCollapsed } = useAppShell();
  const [mobileOpen, setMobileOpen] = React.useState(false);

  // Close the mobile drawer whenever the route changes.
  React.useEffect(() => {
    setMobileOpen(false);
    removeStaleMermaidArtifacts();
  }, [pathname]);

  return (
    <div className="min-h-screen bg-background">
      <Sidebar mobileOpen={mobileOpen} onMobileClose={() => setMobileOpen(false)} />

      {/* Slim top bar — mobile only */}
      <div className="fixed inset-x-0 top-0 z-20 flex h-14 items-center gap-2 border-b border-border bg-background px-3 md:hidden">
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("Menu")}
          onClick={() => setMobileOpen(true)}
        >
          <Menu size={18} />
        </Button>
        <Link
          href="/home"
          className="display text-lg font-semibold"
          onClick={(event) => {
            event.preventDefault();
            newSession();
            router.push("/home");
          }}
        >
          Cognivoy
        </Link>
      </div>

      {/* Re-open affordance when the desktop sidebar is collapsed */}
      {sidebarCollapsed && (
        <Button
          variant="ghost"
          size="icon"
          className="fixed left-3 top-3 z-20 hidden md:inline-flex"
          aria-label={t("Toggle sidebar")}
          onClick={() => setSidebarCollapsed(false)}
        >
          <PanelLeft size={18} />
        </Button>
      )}

      <main
        className={cn(
          "min-h-screen pt-14 transition-[margin] duration-200 md:pt-0",
          sidebarCollapsed ? "md:ml-0" : "md:ml-[264px]",
        )}
      >
        {children}
      </main>
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <AppShellProvider>
      <UnifiedChatProvider>
        <CapabilityAccessProvider>
          <ToastProvider>
            <ShellFrame><CapabilityGate>{children}</CapabilityGate></ShellFrame>
          </ToastProvider>
        </CapabilityAccessProvider>
      </UnifiedChatProvider>
    </AppShellProvider>
  );
}
