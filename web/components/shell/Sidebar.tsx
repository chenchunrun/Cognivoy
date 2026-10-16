"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTranslation } from "react-i18next";
import {
  BookOpen,
  ArrowRight,
  Bot,
  Brain,
  ClipboardCheck,
  Database,
  FlaskConical,
  GraduationCap,
  HeartHandshake,
  History,
  Info,
  LayoutGrid,
  Lock,
  LogOut,
  MessageSquare,
  Moon,
  MoreHorizontal,
  NotebookPen,
  PanelLeftClose,
  PenLine,
  Plus,
  Settings,
  Sun,
  User,
  X,
} from "lucide-react";

import { useAppShell } from "@/context/AppShellContext";
import { useUnifiedChat } from "@/context/UnifiedChatContext";
import { fetchAuthStatus, logout, type AuthStatus } from "@/lib/auth";
import {
  deleteSession,
  listSessions,
  updateSessionTitle,
  type SessionSummary,
} from "@/lib/session-api";
import { cn } from "@/lib/utils";
import {
  Avatar,
  Button,
  ConfirmDialog,
  Dialog,
  DialogFooter,
  DialogTitle,
  Dropdown,
  DropdownItem,
  DropdownSeparator,
  Input,
  useToast,
} from "@/components/ui";
import { useLanguageSwitch } from "./use-language-switch";
import { useCapabilityAccess } from "@/components/access/CapabilityAccessContext";
import { capabilityForPath } from "@/lib/capability-routes";

const LEARNING_NAV = [
  { href: "/home", labelKey: "Home", icon: MessageSquare },
  { href: "/space/learning", labelKey: "Learning", icon: GraduationCap },
  { href: "/question-notebook", labelKey: "Practice", icon: ClipboardCheck },
  { href: "/partners", labelKey: "Tutor", icon: HeartHandshake },
  { href: "/space", labelKey: "Space", icon: LayoutGrid },
] as const;

const MATERIAL_NAV = [
  { href: "/knowledge", labelKey: "Knowledge", icon: Database },
  { href: "/notebook", labelKey: "Notebooks", icon: NotebookPen },
  { href: "/book", labelKey: "Book", icon: BookOpen },
  { href: "/co-writer", labelKey: "Co-Writer", icon: PenLine },
] as const;

const EXPERT_NAV = [
  { href: "/space/agents", labelKey: "My Agents", icon: Bot },
  { href: "/playground", labelKey: "Playground", icon: FlaskConical },
] as const;

const FOOTER_NAV = [
  { href: "/memory", labelKey: "Memory", icon: Brain },
  { href: "/settings", labelKey: "Settings", icon: Settings },
  { href: "/about", labelKey: "About", icon: Info },
] as const;

function isActive(pathname: string, href: string): boolean {
  return pathname === href || (href !== "/space" && pathname.startsWith(`${href}/`));
}

function NavLink({
  href,
  labelKey,
  icon: Icon,
  compact = false,
}: {
  href: string;
  labelKey: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const pathname = usePathname();
  const router = useRouter();
  const { newSession } = useUnifiedChat();
  const { has, verificationError } = useCapabilityAccess();
  const active = isActive(pathname, href);
  const required = capabilityForPath(href);
  // A failed access check is not evidence that the user lost access. Keep the
  // destination reachable so its route gate can explain and retry the check.
  const locked = required ? !verificationError && !has(required) : false;
  if (locked) {
    return (
      <span
        aria-disabled="true"
        title={t("Feature locked")}
        className={cn(
          "relative flex min-w-0 cursor-not-allowed items-center rounded-lg text-muted-foreground opacity-65",
          compact
            ? "flex-col gap-1 px-1 py-1.5 text-[11px]"
            : "gap-2.5 px-2.5 py-2 text-sm",
        )}
      >
        <Icon size={16} className="shrink-0" />
        <span className={cn("max-w-full truncate", !compact && "min-w-0 flex-1")}>
          {t(labelKey)}
        </span>
        <Lock
          size={12}
          aria-hidden="true"
          className={compact ? "absolute right-1 top-1" : "shrink-0"}
        />
      </span>
    );
  }
  return (
    <Link
      href={href}
      onClick={
        href === "/home"
          ? (event) => {
              event.preventDefault();
              newSession();
              router.push("/home");
            }
          : undefined
      }
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex min-w-0 items-center rounded-lg transition-colors duration-150",
        compact
          ? "flex-col gap-1 px-1 py-1.5 text-[11px]"
          : "gap-2.5 px-2.5 py-2 text-sm",
        active
          ? "bg-sidebar-active font-medium text-foreground"
          : "text-sidebar-foreground hover:bg-sidebar-active",
      )}
    >
      <Icon size={16} className="shrink-0 text-muted-foreground" />
      <span className="max-w-full truncate">{t(labelKey)}</span>
    </Link>
  );
}

function SessionList({ onNavigate }: { onNavigate: () => void }) {
  const { t } = useTranslation();
  const pathname = usePathname();
  const router = useRouter();
  const { toast } = useToast();
  const { sidebarRefreshToken } = useUnifiedChat();

  const [sessions, setSessions] = React.useState<SessionSummary[] | null>(null);
  const [loadError, setLoadError] = React.useState(false);
  const [reloadCount, setReloadCount] = React.useState(0);
  const [renameTarget, setRenameTarget] =
    React.useState<SessionSummary | null>(null);
  const [renameValue, setRenameValue] = React.useState("");
  const [renameSaving, setRenameSaving] = React.useState(false);
  const [deleteTarget, setDeleteTarget] =
    React.useState<SessionSummary | null>(null);
  const [deleting, setDeleting] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    listSessions(8, 0, { force: true })
      .then((items) => {
        if (!cancelled) {
          setSessions(items);
          setLoadError(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [sidebarRefreshToken, reloadCount]);

  const openRename = (session: SessionSummary) => {
    setRenameTarget(session);
    setRenameValue(session.title || "");
  };

  const submitRename = async () => {
    if (!renameTarget) return;
    const title = renameValue.trim();
    if (!title) return;
    setRenameSaving(true);
    try {
      await updateSessionTitle(renameTarget.session_id, title);
      setSessions(
        (current) =>
          current?.map((item) =>
            item.session_id === renameTarget.session_id
              ? { ...item, title }
              : item,
          ) ?? current,
      );
      setRenameTarget(null);
    } catch {
      toast({ title: t("Rename failed"), variant: "destructive" });
    } finally {
      setRenameSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteSession(deleteTarget.session_id);
      setSessions(
        (current) =>
          current?.filter(
            (item) => item.session_id !== deleteTarget.session_id,
          ) ?? current,
      );
      if (pathname === `/home/${deleteTarget.session_id}`) {
        router.push("/home");
      }
      setDeleteTarget(null);
    } catch {
      toast({ title: t("Delete failed"), variant: "destructive" });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <section
      data-testid="sidebar-recent"
      aria-label={t("Recent learning")}
      className="flex min-h-0 min-w-0 flex-col border-t border-border pt-3"
    >
      <div className="flex shrink-0 items-center gap-2 px-2.5 pb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        <History size={13} aria-hidden="true" />
        {t("Recent learning")}
      </div>
      <div
        data-testid="sidebar-recent-list"
        className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain pr-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        role="region"
        aria-label={t("Recent learning")}
        tabIndex={0}
      >
        {loadError && (
          <div
            role="status"
            className="rounded-lg bg-muted-subtle px-2.5 py-2 text-xs text-muted-foreground"
          >
            <p>{t("Recent conversations could not be loaded")}</p>
            <button
              type="button"
              onClick={() => {
                setLoadError(false);
                setReloadCount((count) => count + 1);
              }}
              className="mt-1 rounded px-1 py-1 font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t("Retry")}
            </button>
          </div>
        )}
        {sessions === null && !loadError ? (
          <div
            role="status"
            aria-label={t("Loading recent conversations")}
            className="space-y-1 px-1 py-1"
          >
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-9 animate-pulse rounded-lg bg-sidebar-active motion-reduce:animate-none"
              />
            ))}
          </div>
        ) : sessions?.length === 0 && !loadError ? (
          <p className="px-2.5 py-2 text-xs text-muted-foreground">
            {t("No recent activity found")}
          </p>
        ) : sessions && sessions.length > 0 ? (
          <ul className="space-y-1">
            {sessions.map((session) => {
              const href = `/home/${session.session_id}`;
              const active = pathname === href;
              return (
                <li key={session.session_id}>
                  <div
                    className={cn(
                      "group flex items-center gap-1 rounded-lg pr-1 text-sm transition-colors duration-150",
                      active
                        ? "bg-sidebar-active font-medium text-foreground"
                        : "text-sidebar-foreground hover:bg-sidebar-active",
                    )}
                  >
                    <Link
                      href={href}
                      onClick={onNavigate}
                      title={session.title || t("Untitled conversation")}
                      aria-current={active ? "page" : undefined}
                      className="min-w-0 flex-1 rounded-lg px-2.5 py-2 leading-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className="block truncate">
                        {session.title || t("Untitled conversation")}
                      </span>
                    </Link>
                    <Dropdown
                      portal
                      align="end"
                      trigger={
                        <button
                          type="button"
                          aria-label={t("Session options")}
                          className={cn(
                            "flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 [@media(hover:none)]:opacity-100",
                            active
                              ? "opacity-100"
                              : "opacity-0 group-hover:opacity-100",
                          )}
                        >
                          <MoreHorizontal size={14} />
                        </button>
                      }
                    >
                      <DropdownItem
                        label={t("Rename")}
                        onClick={() => openRename(session)}
                      />
                      <DropdownItem
                        label={t("Delete")}
                        destructive
                        onClick={() => setDeleteTarget(session)}
                      />
                    </Dropdown>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
      <Link
        data-testid="sidebar-all-conversations"
        href="/space/chat-history"
        onClick={onNavigate}
        aria-current={pathname === "/space/chat-history" ? "page" : undefined}
        className="mt-2 flex shrink-0 items-center justify-between gap-2 rounded-lg border border-border bg-sidebar-active px-2.5 py-2.5 text-xs font-medium text-sidebar-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {t("View all conversations")}
        <ArrowRight size={14} aria-hidden="true" className="shrink-0" />
      </Link>

      <Dialog open={renameTarget !== null} onClose={() => setRenameTarget(null)}>
        <DialogTitle>{t("Rename chat")}</DialogTitle>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submitRename();
          }}
        >
          <Input
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            className="mt-4"
            maxLength={120}
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRenameTarget(null)}
              disabled={renameSaving}
            >
              {t("Cancel")}
            </Button>
            <Button type="submit" loading={renameSaving}>
              {t("Save")}
            </Button>
          </DialogFooter>
        </form>
      </Dialog>

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void confirmDelete()}
        title={t("Delete chat")}
        description={t("Delete this chat?")}
        confirmText={t("Delete")}
        cancelText={t("Cancel")}
        destructive
        loading={deleting}
      />
    </section>
  );
}

function UserChip() {
  const { t } = useTranslation();
  const router = useRouter();
  const [status, setStatus] = React.useState<AuthStatus | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    fetchAuthStatus().then((next) => {
      if (!cancelled) setStatus(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!status?.enabled || !status.authenticated) return null;
  const username = status.username || "?";

  return (
    <Dropdown
      align="end"
      className="bottom-full mb-1 mt-0"
      trigger={
        <button
          type="button"
          title={username}
          aria-label={`${t("Profile")}: ${username}`}
          className="flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-sidebar-active focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Avatar size="sm" alt={username} />
          <span className="sr-only">{username}</span>
        </button>
      }
    >
      <DropdownItem
        icon={User}
        label={t("Profile")}
        onClick={() => router.push("/profile")}
      />
      <DropdownSeparator />
      <DropdownItem
        icon={LogOut}
        label={t("Sign out")}
        onClick={() => {
          void logout().then(() => router.replace("/login"));
        }}
      />
    </Dropdown>
  );
}

export function Sidebar({
  mobileOpen,
  onMobileClose,
}: {
  mobileOpen: boolean;
  onMobileClose: () => void;
}) {
  const { t } = useTranslation();
  const pathname = usePathname();
  const router = useRouter();
  const { theme, setTheme, sidebarCollapsed, setSidebarCollapsed } =
    useAppShell();
  const { newSession } = useUnifiedChat();
  const { language, switchLanguage } = useLanguageSwitch();
  const expertRouteActive = EXPERT_NAV.some((item) =>
    isActive(pathname, item.href),
  );
  const [expertToolsOpen, setExpertToolsOpen] = React.useState(expertRouteActive);

  return (
    <>
      {mobileOpen && (
        <div
          className="fixed inset-0 z-30 md:hidden"
          style={{ backgroundColor: "var(--overlay)" }}
          onClick={onMobileClose}
          aria-hidden="true"
        />
      )}
      <aside
        data-testid="sidebar"
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex h-dvh w-[264px] max-w-[calc(100vw-2rem)] flex-col overflow-y-auto overscroll-contain border-r border-border bg-sidebar text-sidebar-foreground transition-transform duration-200 md:max-w-none",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
          !sidebarCollapsed && "md:translate-x-0",
        )}
      >
        <div className="flex shrink-0 items-center justify-between px-4 pt-4">
          <Link
            href="/home"
            className="display text-lg font-semibold"
            onClick={(event) => {
              event.preventDefault();
              newSession();
              router.push("/home");
              onMobileClose();
            }}
          >
            Cognivoy
          </Link>
          <Button
            variant="ghost"
            size="icon"
            className="hidden h-8 w-8 md:inline-flex"
            aria-label={t("Toggle sidebar")}
            onClick={() => setSidebarCollapsed(true)}
          >
            <PanelLeftClose size={16} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 md:hidden"
            aria-label={t("Close sidebar")}
            onClick={onMobileClose}
          >
            <X size={16} />
          </Button>
        </div>

        <div className="shrink-0 px-3 pt-3">
          <Button
            className="w-full justify-start"
            onClick={() => {
              newSession();
              router.push("/home");
              onMobileClose();
            }}
          >
            <Plus size={16} />
            {t("New chat")}
          </Button>
        </div>

        {/* The navigation yields height before recent conversations do. On
            unusually short screens the outer rail remains scrollable. */}
        <div className="mt-4 grid min-h-[21.5rem] min-w-0 flex-1 grid-cols-1 grid-rows-[minmax(6rem,auto)_minmax(14rem,1fr)] gap-3 px-3 pb-3">
          <nav
            data-testid="sidebar-navigation"
            aria-label={t("Learning navigation")}
            tabIndex={0}
            className="min-h-0 min-w-0 overflow-x-hidden overflow-y-auto overscroll-contain focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <div className="px-2.5 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              {t("Learn")}
            </div>
            <div className="space-y-0.5" onClick={onMobileClose}>
              {LEARNING_NAV.map((item) => (
                <NavLink key={item.href} {...item} />
              ))}
            </div>

            <div className="mt-3 px-2.5 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              {t("Materials")}
            </div>
            <div className="space-y-0.5" onClick={onMobileClose}>
              {MATERIAL_NAV.map((item) => (
                <NavLink key={item.href} {...item} />
              ))}
            </div>

            <details
              className="group mt-3"
              open={expertToolsOpen || expertRouteActive}
              onToggle={(event) => setExpertToolsOpen(event.currentTarget.open)}
            >
              <summary className="cursor-pointer list-none rounded-lg px-2.5 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-sidebar-active hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <span className="inline-flex items-center gap-2">
                  <FlaskConical size={14} aria-hidden="true" />
                  {t("Expert tools")}
                </span>
              </summary>
              <div className="mt-0.5 space-y-0.5 border-l border-border pl-2" onClick={onMobileClose}>
                {EXPERT_NAV.map((item) => (
                  <NavLink key={item.href} {...item} />
                ))}
              </div>
            </details>
          </nav>

          <SessionList onNavigate={onMobileClose} />
        </div>

        <div data-testid="sidebar-footer" className="shrink-0 border-t border-border px-3 py-2">
          <div data-testid="sidebar-footer-navigation" className="grid grid-cols-3 gap-1" onClick={onMobileClose}>
            {FOOTER_NAV.map((item) => (
              <NavLink key={item.href} {...item} compact />
            ))}
          </div>
          <div data-testid="sidebar-footer-controls" className="mt-1 grid grid-cols-3 items-center justify-items-center gap-1">
            <Button
              data-testid="sidebar-theme"
              variant="ghost"
              size="icon"
              className="h-8 w-full"
              aria-label={t("Theme")}
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            >
              {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
            </Button>
            <Button
              data-testid="sidebar-language"
              variant="ghost"
              size="sm"
              className="w-full px-2 text-xs"
              aria-label={t("Language")}
              onClick={() => switchLanguage(language === "en" ? "zh" : "en")}
            >
              {language === "en" ? "中文" : "EN"}
            </Button>
            <div data-testid="sidebar-user" className="flex min-w-0 justify-center">
              <UserChip />
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}
