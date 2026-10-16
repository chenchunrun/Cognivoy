"use client";

import * as React from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Download, Search, ShieldAlert, Square, Terminal, Trash2 } from "lucide-react";
import {
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  DialogDescription,
  DialogTitle,
  EmptyState,
  Input,
  Skeleton,
  Toggle,
  useToast,
} from "@/components/ui";
import { SpaceHeader } from "@/components/space/SpaceHeader";
import {
  getCliApps,
  getCliCatalog,
  getCliAppInstallPreview,
  getCliAppInstallJob,
  installReviewedCliApp,
  cancelCliAppInstallJob,
  setCliAppEnabled,
  uninstallCliApp,
  type CliApp,
  type CliAppState,
  type CliCatalogPage,
  type CliAppInstallPreview,
  type CliInstallJob,
} from "@/lib/cli-apps-api";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function SpaceCliAppsPage() {
  const { t } = useTranslation();
  const { toast } = useToast();

  const [state, setState] = React.useState<CliAppState | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [catalog, setCatalog] = React.useState<CliCatalogPage | null>(null);
  const [catalogLoading, setCatalogLoading] = React.useState(true);
  const [catalogQuery, setCatalogQuery] = React.useState("");
  const [installing, setInstalling] = React.useState<string | null>(null);
  const [reviewing, setReviewing] = React.useState<string | null>(null);
  const [installPreview, setInstallPreview] = React.useState<CliAppInstallPreview | null>(null);
  const [installJob, setInstallJob] = React.useState<CliInstallJob | null>(null);
  const [installAcknowledged, setInstallAcknowledged] = React.useState(false);
  const [toggling, setToggling] = React.useState<string | null>(null);
  const [removalTarget, setRemovalTarget] = React.useState<CliApp | null>(null);
  const [removing, setRemoving] = React.useState(false);
  const announcedInstallTerminal = React.useRef("");

  React.useEffect(() => {
    let cancelled = false;
    getCliApps()
      .then((result) => {
        if (!cancelled) setState(result);
      })
      .catch((error) => {
        toast({
          variant: "destructive",
          title: t("Failed to load CLI apps"),
          description: errorMessage(error),
        });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [t, toast]);

  React.useEffect(() => {
    let cancelled = false;
    setCatalogLoading(true);
    getCliCatalog({ q: catalogQuery || undefined, limit: 24 })
      .then((result) => {
        if (!cancelled) setCatalog(result);
      })
      .catch(() => {
        // The catalog is supplementary — the installed list still works.
        if (!cancelled) setCatalog(null);
      })
      .finally(() => {
        if (!cancelled) setCatalogLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [catalogQuery]);

  const activeInstallTaskId = installJob?.taskId;
  const activeInstallStatus = installJob?.status;
  React.useEffect(() => {
    if (!activeInstallTaskId || !activeInstallStatus || !["queued", "running", "cancelling"].includes(activeInstallStatus)) {
      return;
    }
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const next = await getCliAppInstallJob(activeInstallTaskId);
        if (disposed) return;
        if (["queued", "running", "cancelling"].includes(next.status)) {
          setInstallJob(next);
          timer = setTimeout(() => void poll(), 750);
          return;
        }
        setInstalling(null);
        if (announcedInstallTerminal.current !== next.taskId) {
          announcedInstallTerminal.current = next.taskId;
          if (next.status === "completed") {
            const [apps, catalogPage] = await Promise.all([
              getCliApps(),
              getCliCatalog({ q: catalogQuery || undefined, limit: 24 }),
            ]);
            if (!disposed) {
              setInstallJob(next);
              setState(apps);
              setCatalog(catalogPage);
              toast({ variant: "success", title: t("App installed") });
            }
          } else if (!disposed) {
            setInstallJob(next);
            let terminalTitle = t("Failed to install app");
            if (next.status === "cancelled") terminalTitle = t("Installation cancelled");
            toast({
              variant: next.status === "cancelled" ? "default" : "destructive",
              title: terminalTitle,
              description: next.message || undefined,
            });
          }
        }
      } catch (error) {
        if (!disposed) {
          setInstalling(null);
          toast({
            variant: "destructive",
            title: t("Failed to read installation status"),
            description: errorMessage(error),
          });
        }
      }
    };
    timer = setTimeout(() => void poll(), 250);
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [activeInstallStatus, activeInstallTaskId, catalogQuery, t, toast]);

  const handleToggle = async (appId: string, enabled: boolean) => {
    setToggling(appId);
    try {
      setState(await setCliAppEnabled(appId, enabled));
    } catch (error) {
      toast({
        variant: "destructive",
        title: t("Failed to update app"),
        description: errorMessage(error),
      });
    } finally {
      setToggling(null);
    }
  };

  const handleReview = async (appId: string) => {
    setReviewing(appId);
    try {
      setInstallPreview(await getCliAppInstallPreview(appId));
      setInstallAcknowledged(false);
      setInstallJob(null);
    } catch (error) {
      toast({
        variant: "destructive",
        title: t("Failed to review app installation"),
        description: errorMessage(error),
      });
    } finally {
      setReviewing(null);
    }
  };

  const handleInstall = async () => {
    if (!installPreview) return;
    setInstalling(installPreview.appId);
    try {
      const job = await installReviewedCliApp(installPreview);
      announcedInstallTerminal.current = "";
      setInstallJob(job);
    } catch (error) {
      toast({
        variant: "destructive",
        title: t("Failed to install app"),
        description: errorMessage(error),
      });
      setInstalling(null);
    }
  };

  const handleCancelInstall = async () => {
    if (!installJob) return;
    try {
      setInstallJob(await cancelCliAppInstallJob(installJob.taskId));
    } catch (error) {
      toast({
        variant: "destructive",
        title: t("Failed to cancel installation"),
        description: errorMessage(error),
      });
    }
  };

  const handleUninstall = async () => {
    if (!removalTarget) return;
    setRemoving(true);
    try {
      const [apps, catalogPage] = await Promise.all([
        uninstallCliApp(removalTarget.id),
        getCliCatalog({ q: catalogQuery || undefined, limit: 24 }),
      ]);
      setState(apps);
      setCatalog(catalogPage);
      setRemovalTarget(null);
      toast({ variant: "success", title: t("App uninstalled") });
    } catch (error) {
      toast({
        variant: "destructive",
        title: t("Failed to uninstall app"),
        description: errorMessage(error),
      });
    } finally {
      setRemoving(false);
    }
  };

  const installActive = Boolean(
    installJob && ["queued", "running", "cancelling"].includes(installJob.status),
  );
  const installStatusLabel = installJob
    ? {
        queued: t("Queued"),
        running: t("Running"),
        cancelling: t("Cancelling"),
        completed: t("Completed"),
        failed: t("Failed"),
        cancelled: t("Cancelled"),
      }[installJob.status]
    : "";

  const apps = state?.apps ?? [];
  const catalogEntries = catalog?.entries ?? [];

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <SpaceHeader
        back
        title={t("CLI Apps")}
        description={t(
          "Command-line tools from the CLI-Anything catalog, callable directly from chat.",
        )}
      />

      {state?.access.exec_denied && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
          <ShieldAlert
            size={14}
            aria-hidden="true"
            className="mt-0.5 shrink-0 text-warning"
          />
          {t(
            "Code execution is disabled for this account, so CLI apps cannot run.",
          )}
        </div>
      )}

      <section>
        <h2 className="display mb-3 text-base font-semibold text-foreground">
          {t("Installed")}
        </h2>
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : apps.length === 0 ? (
          <div className="surface">
            <EmptyState
              icon={Terminal}
              title={t("No CLI apps installed")}
              description={t("Install one from the catalog below.")}
            />
          </div>
        ) : (
          <div className="space-y-2">
            {apps.map((app) => (
              <div
                key={app.id}
                className="surface flex items-center gap-3 px-4 py-3"
              >
                <Toggle
                  checked={app.enabled}
                  disabled={!app.granted || toggling === app.id}
                  onCheckedChange={(next) => void handleToggle(app.id, next)}
                  aria-label={t("Enable {{name}}", { name: app.display_name })}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium text-foreground">
                      {app.display_name}
                    </span>
                    <Badge variant="outline">{app.runtime}</Badge>
                    {app.trust === "first-party" && (
                      <Badge variant="success">{t("First-party")}</Badge>
                    )}
                    {!app.granted && (
                      <Badge variant="warning">{t("Not granted")}</Badge>
                    )}
                    {!app.in_catalog && (
                      <Badge variant="warning">{t("Removed from catalog")}</Badge>
                    )}
                  </div>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {app.description || app.tool_name}
                    {app.version ? ` · v${app.version}` : ""}
                  </p>
                </div>
                {state?.access.unrestricted && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setRemovalTarget(app)}
                    aria-label={t("Uninstall {{name}}", { name: app.display_name })}
                    title={t("Uninstall")}
                  >
                    <Trash2 size={15} aria-hidden="true" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="mt-8">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="display text-base font-semibold text-foreground">
            {t("Catalog")}
          </h2>
          <div className="relative w-56">
            <Search
              size={14}
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              value={catalogQuery}
              onChange={(event) => setCatalogQuery(event.target.value)}
              placeholder={t("Search the catalog...")}
              className="pl-8"
              aria-label={t("Search the catalog")}
            />
          </div>
        </div>
        {catalog?.catalog_pin && (
          <p className="mb-3 text-xs text-muted-foreground">
            {t("Catalog pinned to {{pin}}", { pin: catalog.catalog_pin })}
          </p>
        )}
        {catalogLoading ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-24 w-full" />
            ))}
          </div>
        ) : catalogEntries.length === 0 ? (
          <div className="surface">
            <EmptyState
              icon={Terminal}
              title={t("No catalog entries found")}
              description={t("Try a different search term.")}
            />
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {catalogEntries.map((entry) => (
              <div key={entry.id} className="surface flex flex-col p-4">
                <div className="flex items-center gap-2">
                  <h3 className="truncate text-sm font-medium text-foreground">
                    {entry.display_name}
                  </h3>
                  <Badge variant="outline" className="shrink-0">
                    {entry.runtime}
                  </Badge>
                  {entry.installed && (
                    <Badge variant="success" className="shrink-0">
                      {t("Installed")}
                    </Badge>
                  )}
                </div>
                <p className="mt-1 line-clamp-2 flex-1 text-xs leading-relaxed text-muted-foreground">
                  {entry.description}
                </p>
                {!entry.installable && entry.unsupported_reason && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {entry.unsupported_reason}
                  </p>
                )}
                <div className="mt-3 flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">
                    {t(entry.category)}
                  </span>
                  {!entry.installed && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!entry.installable || installing !== null}
                      loading={reviewing === entry.id}
                      onClick={() => void handleReview(entry.id)}
                    >
                      <Download size={13} aria-hidden="true" />
                      {t("Review")}
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <Dialog
        open={installPreview !== null}
        onClose={() => {
          if (!installActive) {
            setInstallPreview(null);
            setInstallJob(null);
          }
        }}
        className="max-w-2xl"
      >
        {installPreview && <>
          <DialogTitle>{t("Review CLI app installation")}</DialogTitle>
          <DialogDescription>
            {t("This action runs package installation commands outside the chat sandbox.")}
          </DialogDescription>
          <div className="mt-4 space-y-4" data-testid="cli-app-install-review">
            <div className="surface space-y-2 p-4 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <strong>{installPreview.displayName}</strong>
                <Badge variant={installPreview.trust === "first-party" ? "success" : "warning"}>
                  {t(installPreview.trust === "first-party" ? "First-party" : "Third-party")}
                </Badge>
                {installPreview.pinned && <Badge variant="outline">{t("Pinned")}</Badge>}
              </div>
              <p className="text-xs text-muted-foreground">
                {t("Origin: {{origin}}", { origin: installPreview.origin })}
              </p>
              <p className="break-all text-xs text-muted-foreground">
                {t("Package: {{target}}", { target: installPreview.installTarget })}
              </p>
            </div>
            <section>
              <h3 className="mb-2 text-sm font-medium text-foreground">{t("Commands to run")}</h3>
              <div className="space-y-2">
                {installPreview.commands.map((command, index) => (
                  <pre key={`${index}-${command.join(" ")}`} className="overflow-x-auto rounded-lg bg-muted p-3 text-xs text-foreground">
                    {command.join(" ")}
                  </pre>
                ))}
              </div>
            </section>
            <div className="flex items-start gap-2 rounded-lg border border-warning-border bg-warning-muted p-3 text-sm text-foreground">
              <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
              <span>{t("Installation uses network access and may execute third-party package build code.")}</span>
            </div>
            <label className="flex items-start gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={installAcknowledged}
                onChange={(event) => setInstallAcknowledged(event.target.checked)}
              />
              <span>{t("I reviewed the source, package target, and exact commands.")}</span>
            </label>
            {installJob && (
              <section className="space-y-2" aria-live="polite" data-testid="cli-app-install-job">
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span className="font-medium text-foreground">{t("Installation status")}</span>
                  <Badge variant={installJob.status === "completed" ? "success" : installJob.status === "failed" ? "warning" : "outline"}>
                    {installStatusLabel}
                  </Badge>
                </div>
                {installJob.message && <p className="text-xs text-muted-foreground">{installJob.message}</p>}
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-muted p-3 text-xs text-foreground">
                  {installJob.log || t("Waiting for installation output...")}
                </pre>
              </section>
            )}
            <div className="flex justify-end gap-2">
              {installActive ? (
                <Button
                  variant="outline"
                  onClick={() => void handleCancelInstall()}
                  disabled={installJob?.status === "cancelling"}
                >
                  <Square size={13} aria-hidden="true" /> {t("Cancel installation")}
                </Button>
              ) : (
                <>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setInstallPreview(null);
                      setInstallJob(null);
                    }}
                    disabled={installing !== null}
                  >
                    {t(installJob ? "Close" : "Cancel")}
                  </Button>
                  {(!installJob || installJob.status !== "completed") && (
                    <Button
                      onClick={() => void handleInstall()}
                      disabled={!installAcknowledged || installing !== null}
                      loading={installing === installPreview.appId}
                    >
                      <Download size={14} aria-hidden="true" /> {t(installJob ? "Retry installation" : "Confirm and install")}
                    </Button>
                  )}
                </>
              )}
            </div>
          </div>
        </>}
      </Dialog>
      <ConfirmDialog
        open={removalTarget !== null}
        onClose={() => {
          if (!removing) setRemovalTarget(null);
        }}
        onConfirm={() => void handleUninstall()}
        title={t("Uninstall CLI app")}
        description={t(
          "This removes the deployment-wide app environment. Users will no longer be able to run it.",
        )}
        confirmText={t("Uninstall")}
        destructive
        loading={removing}
      >
        {removalTarget && (
          <p className="mt-3 text-sm font-medium text-foreground">
            {removalTarget.display_name}
          </p>
        )}
      </ConfirmDialog>
    </div>
  );
}
