"use client";

import * as React from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ArrowLeft, Download, FileText, PackageOpen, Search, ShieldCheck, Square, Star } from "lucide-react";
import {
  Badge,
  Button,
  Dialog,
  DialogDescription,
  DialogTitle,
  EmptyState,
  Input,
  Select,
  Skeleton,
  useToast,
} from "@/components/ui";
import {
  fetchHubCatalog,
  cancelSkillInstallJob,
  getSkillInstallJob,
  previewSkillInstall,
  startReviewedSkillInstall,
  summarizeSkillInstallRisks,
  type SkillInstallConflictStrategy,
  type SkillInstallPreview,
  type SkillInstallJob,
  type HubSkillListing,
} from "@/lib/skills-api";

export interface EduHubImportDialogProps {
  open: boolean;
  onClose: () => void;
  onInstalled: () => void;
}

/**
 * Browse the EduHub skill catalog and install entries into the caller's own
 * skill layer. The backend proxies the hub, so no hub account is needed.
 */
export function EduHubImportDialog({
  open,
  onClose,
  onInstalled,
}: EduHubImportDialogProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [query, setQuery] = React.useState("");
  const [skills, setSkills] = React.useState<HubSkillListing[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [installing, setInstalling] = React.useState<string | null>(null);
  const [reviewing, setReviewing] = React.useState<string | null>(null);
  const [preview, setPreview] = React.useState<SkillInstallPreview | null>(null);
  const [conflictStrategy, setConflictStrategy] = React.useState<SkillInstallConflictStrategy>("error");
  const [riskAcknowledged, setRiskAcknowledged] = React.useState(false);
  const [installJob, setInstallJob] = React.useState<SkillInstallJob | null>(null);

  const search = React.useCallback(
    async (q: string) => {
      setLoading(true);
      try {
        const catalog = await fetchHubCatalog({ query: q || undefined });
        setSkills(catalog.skills);
      } catch (error) {
        toast({
          variant: "destructive",
          title: t("Failed to load the EduHub catalog"),
          description: error instanceof Error ? error.message : String(error),
        });
        setSkills([]);
      } finally {
        setLoading(false);
      }
    },
    [t, toast],
  );

  React.useEffect(() => {
    if (!open) return;
    setQuery("");
    setPreview(null);
    setRiskAcknowledged(false);
    setInstallJob(null);
    void search("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleReview = async (listing: HubSkillListing) => {
    setReviewing(listing.slug);
    try {
      const result = await previewSkillInstall(
        `eduhub:${listing.slug}@${listing.version}`,
      );
      setPreview(result);
      setConflictStrategy(result.conflict ? "copy" : "error");
      setRiskAcknowledged(false);
    } catch (error) {
      toast({
        variant: "destructive",
        title: t("Failed to review skill"),
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setReviewing(null);
    }
  };

  const handleInstall = async () => {
    if (!preview) return;
    setInstalling(preview.ref.slug);
    try {
      const result = await startReviewedSkillInstall(preview, conflictStrategy, {
        allowUnverified: preview.verdict.status === "suspicious" && riskAcknowledged,
      });
      setInstallJob(result);
    } catch (error) {
      toast({
        variant: "destructive",
        title: t("Failed to install skill"),
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setInstalling(null);
    }
  };

  const activeInstallTaskId = installJob?.taskId;
  const activeInstallStatus = installJob?.status;
  React.useEffect(() => {
    if (!activeInstallTaskId || !activeInstallStatus || !["queued", "running", "cancelling"].includes(activeInstallStatus)) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const next = await getSkillInstallJob(activeInstallTaskId);
        if (disposed) return;
        setInstallJob(next);
        if (["queued", "running", "cancelling"].includes(next.status)) {
          timer = setTimeout(() => void poll(), 750);
          return;
        }
        setInstalling(null);
        if (next.status === "completed") {
          invalidateAndClose(next);
        } else {
          toast({
            variant: next.status === "cancelled" ? "default" : "destructive",
            title: t(next.status === "cancelled" ? "Installation cancelled" : "Failed to install skill"),
            description: next.message || undefined,
          });
        }
      } catch (error) {
        if (!disposed) {
          setInstalling(null);
          toast({
            variant: "destructive",
            title: t("Failed to read installation status"),
            description: error instanceof Error ? error.message : String(error),
          });
        }
      }
    };
    const invalidateAndClose = (job: SkillInstallJob) => {
      toast({ variant: "success", title: t("Skill installed"), description: job.result?.name });
      onInstalled();
      setPreview(null);
      setInstallJob(null);
    };
    timer = setTimeout(() => void poll(), 250);
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [activeInstallStatus, activeInstallTaskId, onInstalled, t, toast]);

  const handleCancelInstall = async () => {
    if (!installJob) return;
    try {
      setInstallJob(await cancelSkillInstallJob(installJob.taskId));
    } catch (error) {
      toast({
        variant: "destructive",
        title: t("Failed to cancel installation"),
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return (
    <Dialog open={open} onClose={onClose} className="max-w-2xl">
      <DialogTitle>{t("Import from EduHub")}</DialogTitle>
      <DialogDescription>
        {preview
          ? t("Review files, permissions, and conflicts before installing.")
          : t("Browse community skills and add them to your library.")}
      </DialogDescription>

      {preview ? (
        <SkillInstallReview
          preview={preview}
          conflictStrategy={conflictStrategy}
          onConflictStrategyChange={setConflictStrategy}
          riskAcknowledged={riskAcknowledged}
          onRiskAcknowledgedChange={setRiskAcknowledged}
          installing={installing !== null}
          installJob={installJob}
          onBack={() => setPreview(null)}
          onInstall={() => void handleInstall()}
          onCancelInstall={() => void handleCancelInstall()}
        />
      ) : <>

      <form
        className="relative mt-4"
        onSubmit={(event) => {
          event.preventDefault();
          void search(query.trim());
        }}
      >
        <Search
          size={14}
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("Search EduHub skills...")}
          className="pl-8"
          aria-label={t("Search EduHub skills")}
        />
      </form>

      <div className="mt-4 max-h-[50vh] overflow-y-auto">
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : skills.length === 0 ? (
          <EmptyState
            icon={PackageOpen}
            title={t("No skills found")}
            description={t("Try a different search term.")}
          />
        ) : (
          <ul className="space-y-2">
            {skills.map((listing) => (
              <li
                key={listing.slug}
                className="flex items-start justify-between gap-3 rounded-lg border border-border p-3"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-foreground">
                      {listing.name}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      v{listing.version}
                    </span>
                    {listing.stars > 0 && (
                      <span className="inline-flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground">
                        <Star size={11} aria-hidden="true" />
                        {listing.stars}
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                    {listing.summary}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {listing.owner}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  loading={reviewing === listing.slug}
                  disabled={reviewing !== null}
                  onClick={() => void handleReview(listing)}
                >
                  <Download size={13} aria-hidden="true" />
                  {t("Review")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      </>}
    </Dialog>
  );
}

function SkillInstallReview({
  preview,
  conflictStrategy,
  onConflictStrategyChange,
  riskAcknowledged,
  onRiskAcknowledgedChange,
  installing,
  installJob,
  onBack,
  onInstall,
  onCancelInstall,
}: {
  preview: SkillInstallPreview;
  conflictStrategy: SkillInstallConflictStrategy;
  onConflictStrategyChange: (value: SkillInstallConflictStrategy) => void;
  riskAcknowledged: boolean;
  onRiskAcknowledgedChange: (value: boolean) => void;
  installing: boolean;
  installJob: SkillInstallJob | null;
  onBack: () => void;
  onInstall: () => void;
  onCancelInstall: () => void;
}) {
  const { t } = useTranslation();
  const risks = summarizeSkillInstallRisks(preview);
  const bins = Array.isArray(preview.requirements.bins) ? preview.requirements.bins.map(String) : [];
  const env = Array.isArray(preview.requirements.env) ? preview.requirements.env.map(String) : [];
  const riskDisplay = [
    ...(bins.length ? [t("Runs commands: {{commands}}", { commands: bins.join(", ") })] : []),
    ...(env.length ? [t("Needs secrets: {{secrets}}", { secrets: env.join(", ") })] : []),
    ...(preview.requirements.network === true ? [t("Uses network access")] : []),
    ...(preview.verdict.status !== "ok" ? [t("Security verdict: {{status}}", { status: preview.verdict.status })] : []),
    ...(preview.conflict ? [t("A skill with this name already exists")] : []),
  ];
  const needsAcknowledgement = risks.length > 0;
  const blockedFiles = preview.files.filter((file) => !file.allowed);
  return (
    <div className="mt-5 space-y-4" data-testid="skill-install-review">
      <Button variant="ghost" size="sm" onClick={onBack} disabled={installing}>
        <ArrowLeft size={14} aria-hidden="true" /> {t("Back to catalog")}
      </Button>
      <div className="surface p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="font-medium text-foreground">{preview.name}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{preview.description}</p>
          </div>
          <span className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-1 text-xs text-muted-foreground">
            {preview.verdict.status === "ok" ? <ShieldCheck size={13} aria-hidden="true" /> : <AlertTriangle size={13} aria-hidden="true" />}
            {t("Security: {{status}}", { status: preview.verdict.status })}
          </span>
        </div>
        {preview.verdict.detail && <p className="mt-2 text-xs text-muted-foreground">{preview.verdict.detail}</p>}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <section className="surface p-4" aria-labelledby="skill-risk-heading">
          <h4 id="skill-risk-heading" className="text-sm font-medium text-foreground">{t("Permissions and risks")}</h4>
          {risks.length === 0 ? (
            <p className="mt-2 text-xs text-success">{t("No elevated requirements were declared.")}</p>
          ) : (
            <ul className="mt-2 space-y-1 text-xs text-warning">
              {riskDisplay.map((risk) => <li key={risk}>• {risk}</li>)}
            </ul>
          )}
        </section>
        <section className="surface p-4" aria-labelledby="skill-files-heading">
          <h4 id="skill-files-heading" className="text-sm font-medium text-foreground">{t("Package files ({{count}})", { count: preview.files.length })}</h4>
          <ul className="mt-2 max-h-32 space-y-1 overflow-y-auto text-xs text-muted-foreground">
            {preview.files.map((file) => (
              <li key={file.path} className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate"><FileText size={12} className="mr-1 inline" aria-hidden="true" />{file.path}</span>
                <span className={file.allowed ? "" : "text-destructive"}>{file.allowed ? `${file.sizeBytes} B` : file.reason}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      {preview.conflict && (
        <label className="block text-sm font-medium text-foreground">
          {t("A skill with this name already exists")}
          <Select
            className="mt-2"
            value={conflictStrategy}
            onChange={(event) => onConflictStrategyChange(event.target.value as SkillInstallConflictStrategy)}
          >
            <option value="copy">{t("Install as a copy")}</option>
            <option value="replace">{t("Replace existing skill")}</option>
            <option value="error">{t("Cancel if conflict remains")}</option>
          </Select>
        </label>
      )}

      {needsAcknowledgement && (
        <label className="flex items-start gap-2 rounded-lg border border-warning-border bg-warning-muted p-3 text-sm text-foreground">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={riskAcknowledged}
            onChange={(event) => onRiskAcknowledgedChange(event.target.checked)}
          />
          <span>{t("I reviewed the files, permissions, and security verdict and want to continue.")}</span>
        </label>
      )}

      {blockedFiles.length > 0 && (
        <p className="text-xs text-warning">{t("Blocked files will not be installed.")}</p>
      )}
      {installJob && (
        <section className="surface space-y-2 p-3" aria-live="polite">
          <div className="flex items-center justify-between gap-2 text-sm">
            <span>{t("Installation status")}</span>
            <Badge variant={installJob.status === "failed" ? "warning" : "outline"}>
              {t(installJob.status[0].toUpperCase() + installJob.status.slice(1))}
            </Badge>
          </div>
          {installJob.message && <p className="text-xs text-muted-foreground">{installJob.message}</p>}
          <pre className="max-h-36 overflow-auto whitespace-pre-wrap rounded-lg bg-muted p-2 text-xs text-foreground">
            {installJob.log || t("Waiting for installation output...")}
          </pre>
        </section>
      )}
      <div className="flex justify-end gap-2">
        {installJob && ["queued", "running", "cancelling"].includes(installJob.status) ? (
          <Button variant="outline" onClick={onCancelInstall} disabled={installJob.status === "cancelling"}>
            <Square size={13} aria-hidden="true" /> {t("Cancel installation")}
          </Button>
        ) : <>
          <Button variant="outline" onClick={onBack} disabled={installing}>{t("Cancel")}</Button>
          <Button
            onClick={onInstall}
            loading={installing}
            disabled={installing || (needsAcknowledgement && !riskAcknowledged)}
          >
            <Download size={14} aria-hidden="true" /> {t(installJob ? "Retry installation" : "Confirm and install")}
          </Button>
        </>}
      </div>
    </div>
  );
}
