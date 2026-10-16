"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  RefreshCw,
  Search,
  Shield,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  Trash2,
  UserCheck,
  UserX,
  UserPlus,
  Users,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { fetchAuthStatus } from "@/lib/auth";
import {
  createUser,
  deleteUser,
  getUserDeletionImpact,
  listUsers,
  setUserRole,
  setUserDisabled,
  type UserRecord,
  type UserDeletionImpact,
  type UserAssetStrategy,
} from "@/lib/admin-api";
import { filterUsersByQuery } from "@/lib/admin-users";
import { formatDate, type Language } from "@/lib/datetime";
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  EmptyState,
  Input,
  Select,
  Skeleton,
  Tooltip,
  useToast,
} from "@/components/ui";
import { UserAvatar } from "@/components/profile/UserAvatar";

type ConfirmTarget = {
  kind: "delete" | "promote" | "demote" | "disable" | "enable";
  user: UserRecord;
};

function formatJoined(iso: string, lang: Language): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return formatDate(date, lang);
}

export default function AdminUsersPage() {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const lang: Language = i18n.language?.startsWith("zh") ? "zh" : "en";

  const [gate, setGate] = useState<"loading" | "forbidden" | "ok">("loading");
  const [currentUser, setCurrentUser] = useState<string | null>(null);
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [confirmTarget, setConfirmTarget] = useState<ConfirmTarget | null>(
    null,
  );
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [deletionImpact, setDeletionImpact] = useState<UserDeletionImpact | null>(null);
  const [deletionStrategy, setDeletionStrategy] = useState<UserAssetStrategy>("preserve");
  const [transferTarget, setTransferTarget] = useState("");
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [createUsername, setCreateUsername] = useState("");
  const [createPassword, setCreatePassword] = useState("");
  const [createSubmitting, setCreateSubmitting] = useState(false);
  const [createError, setCreateError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      const data = await listUsers();
      setUsers(data);
    } catch (err) {
      setLoadFailed(true);
      toast({
        title: t("Failed to load users"),
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [t, toast]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const status = await fetchAuthStatus();
      if (cancelled) return;
      // apiFetch redirects to /login on 401 when auth is enabled, so an
      // unauthenticated session is already on its way out; this gate covers
      // auth-disabled servers and non-admin roles.
      if (!status?.enabled || status.role !== "admin") {
        setGate("forbidden");
        setLoading(false);
        return;
      }
      setCurrentUser(status.username ?? null);
      setGate("ok");
      void load();
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  useEffect(() => {
    if (confirmTarget?.kind !== "delete") return;
    let cancelled = false;
    void getUserDeletionImpact(confirmTarget.user.username)
      .then((impact) => { if (!cancelled) setDeletionImpact(impact); })
      .catch(() => { if (!cancelled) setDeletionImpact(null); });
    return () => { cancelled = true; };
  }, [confirmTarget]);

  function openCreateDialog() {
    setCreateUsername("");
    setCreatePassword("");
    setCreateError("");
    setShowCreateDialog(true);
  }

  function closeCreateDialog() {
    if (createSubmitting) return;
    setShowCreateDialog(false);
  }

  async function handleCreateSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (createSubmitting) return;
    setCreateError("");
    const username = createUsername.trim();
    if (!username) {
      setCreateError(t("Username is required."));
      return;
    }
    if (createPassword.length < 8) {
      setCreateError(t("Password must be at least 8 characters."));
      return;
    }
    setCreateSubmitting(true);
    try {
      await createUser(username, createPassword);
      setShowCreateDialog(false);
      toast({
        title: t("User {{username}} created", { username }),
        variant: "success",
      });
      await load();
    } catch (err) {
      setCreateError(
        err instanceof Error ? err.message : t("Failed to create user"),
      );
    } finally {
      setCreateSubmitting(false);
    }
  }

  async function handleConfirmAction() {
    if (!confirmTarget || confirmBusy) return;
    const { kind, user } = confirmTarget;
    setConfirmBusy(true);
    try {
      if (kind === "delete") {
        await deleteUser(user.username, {
          assetStrategy: deletionStrategy,
          transferTo: deletionStrategy === "transfer" ? transferTarget : undefined,
        });
        setUsers((prev) => prev.filter((u) => u.username !== user.username));
        toast({
          title: t("User {{username}} deleted", { username: user.username }),
          variant: "success",
        });
      } else if (kind === "promote" || kind === "demote") {
        const newRole = kind === "promote" ? "admin" : "user";
        await setUserRole(user.username, newRole);
        setUsers((prev) =>
          prev.map((u) =>
            u.username === user.username ? { ...u, role: newRole } : u,
          ),
        );
        toast({
          title: t("Role updated for {{username}}", {
            username: user.username,
          }),
          variant: "success",
        });
      } else {
        const disabled = kind === "disable";
        await setUserDisabled(user.username, disabled);
        setUsers((prev) =>
          prev.map((item) =>
            item.username === user.username ? { ...item, disabled } : item,
          ),
        );
        toast({
          title: disabled
            ? t("User {{username}} disabled", { username: user.username })
            : t("User {{username}} restored", { username: user.username }),
          variant: "success",
        });
      }
      setConfirmTarget(null);
    } catch (err) {
      setConfirmTarget(null);
      toast({
        title:
          kind === "delete"
            ? t("Failed to delete user")
            : kind === "promote" || kind === "demote"
              ? t("Failed to update role")
              : t("Failed to update account status"),
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    } finally {
      setConfirmBusy(false);
    }
  }

  const filteredUsers = filterUsersByQuery(users, query);
  const normalizedQuery = query.trim();

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10">
      <header className="mb-8">
        <Link
          href="/"
          className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors duration-150 hover:text-foreground"
        >
          <ArrowLeft size={16} />
          {t("Back")}
        </Link>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="display text-2xl font-medium text-foreground">
              {t("User Management")}
            </h1>
            <p className="mt-1.5 text-sm text-muted-foreground">
              {t("Manage registered accounts.")}
            </p>
          </div>
          {gate === "ok" && (
            <div className="flex shrink-0 items-center gap-2">
              <Button variant="primary" size="sm" onClick={openCreateDialog}>
                <UserPlus size={14} />
                {t("Add user")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void load()}
                disabled={loading}
              >
                <RefreshCw
                  size={14}
                  className={loading ? "animate-spin" : undefined}
                />
                {t("Refresh")}
              </Button>
            </div>
          )}
        </div>
      </header>

      {gate === "loading" ? (
        <Card>
          <div className="divide-y divide-border" aria-hidden>
            {[0, 1, 2].map((row) => (
              <div key={row} className="flex items-center gap-3 px-5 py-4">
                <Skeleton className="h-8 w-8 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-3 w-36" />
                  <Skeleton className="h-2.5 w-24" />
                </div>
                <Skeleton className="h-5 w-16 rounded-full" />
              </div>
            ))}
          </div>
        </Card>
      ) : gate === "forbidden" ? (
        <Card>
          <EmptyState
            icon={ShieldAlert}
            title={t("Admin only")}
            description={t(
              "User management is available to administrators when accounts are enabled.",
            )}
          />
        </Card>
      ) : (
        <>
          {!loading && !loadFailed && users.length > 0 && (
            <div className="mb-4 flex items-center gap-3">
              <div className="relative flex-1">
                <Search
                  size={14}
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t("Search users…")}
                  aria-label={t("Search users")}
                  className="pl-9"
                />
              </div>
              <span className="shrink-0 text-xs text-muted-foreground">
                {normalizedQuery
                  ? t("{{filtered}} of {{total}}", {
                      filtered: filteredUsers.length,
                      total: users.length,
                    })
                  : t("{{count}} users", { count: users.length })}
              </span>
            </div>
          )}

          <Card className="overflow-hidden">
            {loading ? (
              <div className="divide-y divide-border" aria-hidden>
                {[0, 1, 2].map((row) => (
                  <div
                    key={row}
                    className="flex items-center gap-3 px-5 py-4"
                  >
                    <Skeleton className="h-8 w-8 rounded-full" />
                    <div className="flex-1 space-y-2">
                      <Skeleton className="h-3 w-36" />
                      <Skeleton className="h-2.5 w-24" />
                    </div>
                    <Skeleton className="h-5 w-16 rounded-full" />
                  </div>
                ))}
              </div>
            ) : loadFailed ? (
              <EmptyState
                icon={Users}
                title={t("Failed to load users")}
                description={t("Check your connection and try again.")}
                action={
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void load()}
                  >
                    <RefreshCw size={14} />
                    {t("Retry")}
                  </Button>
                }
              />
            ) : users.length === 0 ? (
              <EmptyState
                icon={Users}
                title={t("No users yet")}
                description={t("Accounts you create will appear here.")}
                action={
                  <Button variant="primary" size="sm" onClick={openCreateDialog}>
                    <UserPlus size={14} />
                    {t("Add user")}
                  </Button>
                }
              />
            ) : filteredUsers.length === 0 ? (
              <EmptyState
                icon={Search}
                title={t("No users match your search")}
                action={
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setQuery("")}
                  >
                    {t("Clear search")}
                  </Button>
                }
              />
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                    <th className="px-5 py-3 font-medium">{t("User")}</th>
                    <th className="px-5 py-3 font-medium">{t("Role")}</th>
                    <th className="px-5 py-3 font-medium">{t("Joined")}</th>
                    <th className="px-5 py-3 font-medium">{t("Status")}</th>
                    <th className="px-5 py-3 text-right font-medium">
                      {t("Actions")}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filteredUsers.map((user) => {
                    const isSelf = user.username === currentUser;
                    const isAdmin = user.role === "admin";
                    return (
                      <tr
                        key={user.username}
                        className="transition-colors duration-150 hover:bg-muted-subtle"
                      >
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-3">
                            <UserAvatar
                              username={user.username}
                              userId={user.id}
                              avatar={user.avatar}
                              size={32}
                            />
                            <span className="min-w-0">
                              <span className="block truncate font-medium text-foreground">
                                {user.display_name || user.username}
                                {isSelf && (
                                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                                    {t("(you)")}
                                  </span>
                                )}
                              </span>
                              {user.display_name && user.display_name !== user.username ? (
                                <span className="block truncate text-xs text-muted-foreground">
                                  @{user.username}
                                </span>
                              ) : null}
                            </span>
                          </div>
                        </td>
                        <td className="px-5 py-3">
                          <Badge variant={isAdmin ? "primary" : "default"}>
                            {isAdmin && (
                              <ShieldCheck size={11} strokeWidth={2} />
                            )}
                            {isAdmin ? t("Admin") : t("User")}
                          </Badge>
                        </td>
                        <td className="px-5 py-3 text-muted-foreground">
                          {formatJoined(user.created_at, lang)}
                        </td>
                        <td className="px-5 py-3">
                          <Badge
                            variant={user.disabled ? "destructive" : "success"}
                          >
                            {user.disabled ? t("Disabled") : t("Active")}
                          </Badge>
                        </td>
                        <td className="px-5 py-3">
                          <div className="flex items-center justify-end gap-1.5">
                            <Tooltip
                              content={
                                isSelf
                                  ? t("Cannot disable your own account")
                                  : user.disabled
                                    ? t("Restore {{username}}", { username: user.username })
                                    : t("Disable {{username}}", { username: user.username })
                              }
                            >
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                disabled={isSelf}
                                aria-label={
                                  user.disabled
                                    ? t("Restore {{username}}", { username: user.username })
                                    : t("Disable {{username}}", { username: user.username })
                                }
                                onClick={() =>
                                  setConfirmTarget({
                                    kind: user.disabled ? "enable" : "disable",
                                    user,
                                  })
                                }
                              >
                                {user.disabled ? <UserCheck size={15} /> : <UserX size={15} />}
                              </Button>
                            </Tooltip>
                            <Tooltip
                              content={
                                isSelf
                                  ? t("Cannot change your own role")
                                  : isAdmin
                                    ? t("Demote to user")
                                    : t("Promote to admin")
                              }
                            >
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                disabled={isSelf}
                                aria-label={
                                  isAdmin
                                    ? t("Demote to user")
                                    : t("Promote to admin")
                                }
                                onClick={() =>
                                  setConfirmTarget({
                                    kind: isAdmin ? "demote" : "promote",
                                    user,
                                  })
                                }
                              >
                                {isAdmin ? (
                                  <ShieldOff size={15} />
                                ) : (
                                  <Shield size={15} />
                                )}
                              </Button>
                            </Tooltip>
                            <Tooltip
                              content={
                                isSelf
                                  ? t("Cannot delete your own account")
                                  : t("Delete {{username}}", {
                                      username: user.username,
                                    })
                              }
                            >
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 hover:bg-destructive-muted hover:text-destructive"
                                disabled={isSelf}
                                aria-label={t("Delete {{username}}", {
                                  username: user.username,
                                })}
                                onClick={() => {
                                  setDeletionStrategy("preserve");
                                  setTransferTarget("");
                                  setConfirmTarget({ kind: "delete", user });
                                }}
                              >
                                <Trash2 size={15} />
                              </Button>
                            </Tooltip>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </Card>
        </>
      )}

      <ConfirmDialog
        open={confirmTarget !== null}
        onClose={() => {
          setConfirmTarget(null);
          setDeletionImpact(null);
        }}
        onConfirm={() => void handleConfirmAction()}
        title={
          confirmTarget?.kind === "delete"
            ? t("Delete user")
            : confirmTarget?.kind === "promote"
              ? t("Promote to admin")
              : confirmTarget?.kind === "demote"
                ? t("Demote to user")
                : confirmTarget?.kind === "disable"
                  ? t("Disable user")
                  : t("Restore user")
        }
        description={
          confirmTarget
            ? confirmTarget.kind === "delete"
              ? t(
                  "This permanently removes account {{username}}, but preserves its workspace for administrator recovery.{{impact}}",
                  {
                    username: confirmTarget.user.username,
                    impact:
                      deletionImpact?.username === confirmTarget.user.username
                        ? t(" Impact: {{files}} files, {{size}} bytes; {{knowledge}} knowledge bases, {{books}} books, {{documents}} documents and {{notebooks}} notebooks.", {
                            files: deletionImpact.file_count ?? "—",
                            size: deletionImpact.total_bytes ?? "—",
                            knowledge: deletionImpact.resources.knowledge_bases ?? 0,
                            books: deletionImpact.resources.books ?? 0,
                            documents: deletionImpact.resources.documents ?? 0,
                            notebooks: deletionImpact.resources.notebooks ?? 0,
                          })
                        : t(" Workspace impact is being inspected."),
                  },
                )
              : confirmTarget.kind === "promote"
                ? t(
                    "{{username}} will be able to manage users and the admin area.",
                    { username: confirmTarget.user.username },
                  )
                : confirmTarget.kind === "demote"
                  ? t(
                    "{{username}} will lose access to the admin area.",
                    { username: confirmTarget.user.username },
                  )
                  : confirmTarget.kind === "disable"
                    ? t(
                        "{{username}} will be signed out and cannot access the account until restored. Their workspace is preserved.",
                        { username: confirmTarget.user.username },
                      )
                    : t(
                        "{{username}} will be able to sign in and access the preserved workspace again.",
                        { username: confirmTarget.user.username },
                      )
            : undefined
        }
        confirmText={
          confirmTarget?.kind === "delete"
            ? t("Delete user")
            : confirmTarget?.kind === "promote"
              ? t("Promote")
              : confirmTarget?.kind === "demote"
                ? t("Demote")
                : confirmTarget?.kind === "disable"
                  ? t("Disable user")
                  : t("Restore user")
        }
        cancelText={t("Cancel")}
        destructive={confirmTarget?.kind === "delete" || confirmTarget?.kind === "disable"}
        loading={confirmBusy}
        confirmDisabled={
          confirmTarget?.kind === "delete" &&
          deletionStrategy === "transfer" &&
          !transferTarget
        }
      >
        {confirmTarget?.kind === "delete" && !deletionImpact?.workspace_shared ? (
          <div className="mt-4 space-y-3">
            <label className="block text-xs font-medium text-foreground">
              {t("Workspace handling")}
              <Select
                className="mt-1"
                value={deletionStrategy}
                onChange={(event) =>
                  setDeletionStrategy(event.target.value as UserAssetStrategy)
                }
                disabled={confirmBusy}
              >
                <option value="preserve">{t("Preserve for recovery")}</option>
                <option value="export">{t("Export archive, then remove")}</option>
                <option value="transfer">{t("Transfer to another user")}</option>
                <option value="purge">{t("Permanently purge")}</option>
              </Select>
            </label>
            {deletionStrategy === "transfer" ? (
              <label className="block text-xs font-medium text-foreground">
                {t("Transfer target")}
                <Select
                  className="mt-1"
                  value={transferTarget}
                  onChange={(event) => setTransferTarget(event.target.value)}
                  disabled={confirmBusy}
                >
                  <option value="">{t("Select a user")}</option>
                  {users
                    .filter((user) => user.username !== confirmTarget.user.username)
                    .map((user) => (
                      <option key={user.id} value={user.username}>
                        {user.display_name || user.username} ({user.username})
                      </option>
                    ))}
                </Select>
              </label>
            ) : null}
            {deletionStrategy === "purge" ? (
              <p className="text-xs text-destructive">
                {t("Purge cannot be undone and removes all workspace files.")}
              </p>
            ) : null}
          </div>
        ) : null}
      </ConfirmDialog>

      <Dialog open={showCreateDialog} onClose={closeCreateDialog}>
        <form onSubmit={handleCreateSubmit}>
          <DialogTitle>{t("Add user")}</DialogTitle>
          <DialogDescription>
            {t("Create a new account with a username and password.")}
          </DialogDescription>

          <div className="mt-4 space-y-3">
            <label className="block text-xs text-muted-foreground">
              {t("Username")}
              <Input
                type="text"
                value={createUsername}
                onChange={(event) => setCreateUsername(event.target.value)}
                disabled={createSubmitting}
                autoComplete="off"
                autoFocus
                className="mt-1"
              />
            </label>
            <label className="block text-xs text-muted-foreground">
              {t("Password (at least 8 characters)")}
              <Input
                type="password"
                value={createPassword}
                onChange={(event) => setCreatePassword(event.target.value)}
                disabled={createSubmitting}
                autoComplete="new-password"
                className="mt-1"
              />
            </label>
            {createError && (
              <p className="text-xs text-destructive">{createError}</p>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={closeCreateDialog}
              disabled={createSubmitting}
            >
              {t("Cancel")}
            </Button>
            <Button type="submit" loading={createSubmitting}>
              {t("Create")}
            </Button>
          </DialogFooter>
        </form>
      </Dialog>
    </div>
  );
}
