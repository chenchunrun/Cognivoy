"use client";

import * as React from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { fetchAuthStatus } from "@/lib/auth";
import {
  fetchControlPlaneSnapshot,
  acknowledgeControlPlaneAlert,
  controlPlaneExportUrl,
  discardStagedExecutionPolicy,
  fetchExecutionPolicies,
  publishStagedExecutionPolicy,
  rollbackExecutionPolicyRevision,
  stageExecutionPolicy,
  stageTenantPolicyDeletion,
  markPolicyNotificationRead,
  type ControlPlaneDecisionFilter,
  type ControlPlaneEvent,
  type ControlPlaneRiskFilter,
  type ControlPlaneSnapshot,
  type ExecutionPolicy,
  type ExecutionPolicyBundle,
} from "@/lib/control-plane-api";
import { cn } from "@/lib/utils";
import { Badge, Button, Card, EmptyState, Input, Select, Skeleton, Textarea } from "@/components/ui";
import { SettingsPageHeader } from "@/components/settings/shared";

type Gate = "loading" | "ok" | "forbidden" | "error";

const ALERT_KEYS = {
  critical_policy_denials: "Critical identity or policy violations were blocked.",
  repeated_budget_denials: "Repeated execution-budget denials were detected.",
  elevated_denial_rate: "The policy-denial rate is elevated.",
  network_policy_denials: "Network policy blocked one or more outbound targets.",
} as const;

const RISK_LABEL_KEYS: Record<string, string> = {
  medium: "Medium",
  high: "High",
  critical: "Critical",
};

const POLICY_WARNING_KEYS: Record<string, string> = {
  no_capabilities: "No capabilities would be allowed.",
  no_tools: "No tools would be allowed.",
  tool_budget_decrease: "The per-turn tool budget would decrease.",
  tenant_override_removal: "Removing the override will apply the deployment default.",
  capability_scope_restricted: "The capability scope would change from unrestricted to restricted.",
  tool_scope_restricted: "The tool scope would change from unrestricted to restricted.",
};

function eventTone(event: ControlPlaneEvent) {
  if (event.event === "policy_change") return "warning";
  if (event.event === "security_event") return "destructive";
  if (event.event === "execution_outcome") {
    return event.success === false ? "destructive" : "success";
  }
  return event.allowed === false ? "destructive" : "success";
}

export default function ControlPlaneSettingsPage() {
  const { t, i18n } = useTranslation();
  const [gate, setGate] = React.useState<Gate>("loading");
  const [snapshot, setSnapshot] = React.useState<ControlPlaneSnapshot | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");
  const [windowHours, setWindowHours] = React.useState(24);
  const [decision, setDecision] =
    React.useState<ControlPlaneDecisionFilter>("all");
  const [riskLevel, setRiskLevel] = React.useState<ControlPlaneRiskFilter>("");
  const requestId = React.useRef(0);

  const load = React.useCallback(async (filters: {
    windowHours: number;
    decision: ControlPlaneDecisionFilter;
    riskLevel: ControlPlaneRiskFilter;
  }) => {
    const activeRequest = requestId.current + 1;
    requestId.current = activeRequest;
    setLoading(true);
    setError("");
    try {
      const next = await fetchControlPlaneSnapshot(filters);
      if (requestId.current === activeRequest) setSnapshot(next);
    } catch (caught) {
      if (requestId.current === activeRequest) {
        setError(caught instanceof Error ? caught.message : t("Failed to load control-plane events."));
      }
    } finally {
      if (requestId.current === activeRequest) setLoading(false);
    }
  }, [t]);

  React.useEffect(() => {
    let cancelled = false;
    void fetchAuthStatus().then((status) => {
      if (cancelled) return;
      if (!status) {
        setGate("error");
      } else if (status.enabled && status.role !== "admin") {
        setGate("forbidden");
      } else {
        setGate("ok");
        void load({ windowHours: 24, decision: "all", riskLevel: "" });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const locale = i18n.language?.startsWith("zh") ? "zh-CN" : "en-US";

  return (
    <div>
      <SettingsPageHeader
        title={t("Execution control plane")}
        description={t(
          "Inspect policy decisions, execution outcomes, budget pressure, and blocked high-risk activity.",
        )}
        action={
          gate === "ok" ? (
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => window.location.assign(controlPlaneExportUrl(windowHours))}
              >
                <Download size={14} />
                {t("Export CSV")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void load({ windowHours, decision, riskLevel })}
                loading={loading}
              >
                {!loading ? <RefreshCw size={14} /> : null}
                {t("Refresh")}
              </Button>
            </div>
          ) : undefined
        }
      />

      {gate === "loading" ? <LoadingState /> : null}
      {gate === "forbidden" ? (
        <Card>
          <EmptyState
            icon={ShieldAlert}
            title={t("Admin only")}
            description={t("Control-plane audit data is available only to administrators.")}
          />
        </Card>
      ) : null}
      {gate === "error" ? (
        <Card>
          <EmptyState
            icon={AlertTriangle}
            title={t("Couldn't verify administrator access")}
            description={t("Check your connection and try again.")}
          />
        </Card>
      ) : null}

      {gate === "ok" ? (
        <>
          <div className="mb-5 flex flex-wrap gap-3">
            <Filter label={t("Time window")}>
              <Select
                aria-label={t("Time window")}
                value={windowHours}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  setWindowHours(value);
                  void load({ windowHours: value, decision, riskLevel });
                }}
              >
                <option value={1}>{t("Last hour")}</option>
                <option value={24}>{t("Last 24 hours")}</option>
                <option value={168}>{t("Last 7 days")}</option>
              </Select>
            </Filter>
            <Filter label={t("Decision")}>
              <Select
                aria-label={t("Decision")}
                value={decision}
                onChange={(event) => {
                  const value = event.target.value as ControlPlaneDecisionFilter;
                  setDecision(value);
                  void load({ windowHours, decision: value, riskLevel });
                }}
              >
                <option value="all">{t("All events")}</option>
                <option value="allowed">{t("Allowed only")}</option>
                <option value="denied">{t("Denied only")}</option>
              </Select>
            </Filter>
            <Filter label={t("Risk level")}>
              <Select
                aria-label={t("Risk level")}
                value={riskLevel}
                onChange={(event) => {
                  const value = event.target.value as ControlPlaneRiskFilter;
                  setRiskLevel(value);
                  void load({ windowHours, decision, riskLevel: value });
                }}
              >
                <option value="">{t("All risk levels")}</option>
                <option value="medium">{t("Medium")}</option>
                <option value="high">{t("High")}</option>
                <option value="critical">{t("Critical")}</option>
              </Select>
            </Filter>
          </div>

          <PolicyManager
            onPolicyChanged={() => void load({ windowHours, decision, riskLevel })}
          />

          {error ? (
            <div role="alert" className="mb-5 rounded-xl border border-destructive-border bg-destructive-muted p-4 text-sm text-destructive">
              {error}
            </div>
          ) : null}

          {!snapshot && loading ? <LoadingState /> : null}
          {snapshot ? (
            <>
              <SummaryCards snapshot={snapshot} />
              {snapshot.alerts.length > 0 ? (
                <section className="mb-6 space-y-2" aria-label={t("Security alerts")}>
                  {snapshot.alerts.map((alert) => (
                    <div
                      key={alert.code}
                      role="alert"
                      className={cn(
                        "flex items-start gap-3 rounded-xl border p-3 text-sm",
                        alert.acknowledged
                          ? "border-border bg-muted-subtle text-muted-foreground"
                          : alert.severity === "critical"
                          ? "border-destructive-border bg-destructive-muted text-destructive"
                          : "border-warning-border bg-warning-muted text-warning",
                      )}
                    >
                      <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                      <span className="min-w-0 flex-1">
                        {t(ALERT_KEYS[alert.code])} {t("{{count}} event(s)", { count: alert.count })}
                        {alert.acknowledged ? ` · ${t("Acknowledged")}` : null}
                      </span>
                      {!alert.acknowledged ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void acknowledgeControlPlaneAlert(alert.fingerprint)
                            .then(() => load({ windowHours, decision, riskLevel }))
                            .catch((caught) => setError(caught instanceof Error ? caught.message : t("Failed to acknowledge alert.")))}
                        >
                          {t("Acknowledge")}
                        </Button>
                      ) : null}
                    </div>
                  ))}
                </section>
              ) : null}
              <EventTable events={snapshot.events} locale={locale} />
              {snapshot.scan_truncated ? (
                <p className="mt-3 text-xs text-muted-foreground">
                  {t("The audit scan reached its safety limit; narrow the time window for a complete view.")}
                </p>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function splitNames(value: string): string[] {
  return [...new Set(value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean))];
}

function PolicyManager({ onPolicyChanged }: { onPolicyChanged: () => void }) {
  const { t } = useTranslation();
  const [bundle, setBundle] = React.useState<ExecutionPolicyBundle | null>(null);
  const [scope, setScope] = React.useState("default");
  const [tenantId, setTenantId] = React.useState("");
  const [draft, setDraft] = React.useState<ExecutionPolicy | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [error, setError] = React.useState("");

  const selectPolicy = React.useCallback((next: ExecutionPolicyBundle, nextScope: string) => {
    setBundle(next);
    setScope(nextScope);
    const selected = nextScope === "default" ? next.default : next.tenants[nextScope] ?? next.default;
    setDraft({ ...selected, denied_tools: [...selected.denied_tools] });
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    void fetchExecutionPolicies()
      .then((next) => {
        if (!cancelled) selectPolicy(next, "default");
      })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : t("Failed to load execution policies."));
      });
    return () => {
      cancelled = true;
    };
  }, [selectPolicy, t]);

  async function stageDraft() {
    if (!draft) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await stageExecutionPolicy({
        scope: scope === "default" ? "default" : "tenant",
        tenantId: scope === "default" ? "" : scope,
        policy: draft,
      });
      const next = await fetchExecutionPolicies();
      selectPolicy(next, scope);
      setMessage(t("Policy preview staged for approval. No runtime settings changed."));
      onPolicyChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("Failed to stage execution policy."));
    } finally {
      setBusy(false);
    }
  }

  async function publishStage(stageId: string) {
    if (!window.confirm(t("Publish this staged policy now? It will affect new turns immediately."))) return;
    setBusy(true);
    setError("");
    try {
      const next = await publishStagedExecutionPolicy(stageId);
      selectPolicy(next, scope);
      setMessage(t("Staged policy published."));
      onPolicyChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("Failed to publish staged policy."));
    } finally {
      setBusy(false);
    }
  }

  async function stageTenantDeletion() {
    if (scope === "default") return;
    if (!window.confirm(t("Stage deletion of this tenant override for approval?"))) return;
    setBusy(true);
    setError("");
    try {
      await stageTenantPolicyDeletion(scope);
      const next = await fetchExecutionPolicies();
      selectPolicy(next, scope);
      setMessage(t("Tenant override deletion staged for approval."));
      onPolicyChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("Failed to stage tenant override deletion."));
    } finally {
      setBusy(false);
    }
  }

  async function discardStage(stageId: string) {
    setBusy(true);
    setError("");
    try {
      await discardStagedExecutionPolicy(stageId);
      const next = await fetchExecutionPolicies();
      selectPolicy(next, scope);
      setMessage(t("Staged policy discarded."));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("Failed to discard staged policy."));
    } finally {
      setBusy(false);
    }
  }

  async function rollbackRevision(revisionId: string) {
    if (!window.confirm(t("Roll back this policy publication? All pending drafts will be discarded."))) return;
    setBusy(true);
    setError("");
    try {
      const next = await rollbackExecutionPolicyRevision(revisionId);
      selectPolicy(next, "default");
      setMessage(t("Policy revision rolled back."));
      onPolicyChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("Failed to roll back policy revision."));
    } finally {
      setBusy(false);
    }
  }

  async function markNotificationRead(notificationId: string) {
    try {
      await markPolicyNotificationRead(notificationId);
      const next = await fetchExecutionPolicies();
      selectPolicy(next, scope);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("Failed to mark approval notification as read."));
    }
  }

  if (!bundle || !draft) {
    return <Skeleton className="mb-6 h-80" />;
  }

  const tenantScopes = Object.keys(bundle.tenants).sort();
  return (
    <Card className="mb-6 p-5">
      <div className="mb-4">
        <h2 className="text-base font-medium text-foreground">{t("Execution policies")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("Set deployment defaults and stricter per-tenant overrides. Request settings can only tighten these limits.")}
        </p>
      </div>
      {bundle.integrity_error ? (
        <div role="alert" className="mb-4 rounded-xl border border-destructive-border bg-destructive-muted p-3 text-sm text-destructive">
          {t("Policy integrity validation failed. Saving the default policy repairs the policy file.")}
        </div>
      ) : null}
      <div className="mb-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
        <Filter label={t("Policy scope")}>
          <Select
            value={scope}
            onChange={(event) => selectPolicy(bundle, event.target.value)}
          >
            <option value="default">{t("Deployment default")}</option>
            {scope !== "default" && !bundle.tenants[scope] ? <option value={scope}>{scope}</option> : null}
            {tenantScopes.map((tenant) => <option key={tenant} value={tenant}>{tenant}</option>)}
          </Select>
        </Filter>
        <Filter label={t("New tenant ID")}>
          <Input value={tenantId} onChange={(event) => setTenantId(event.target.value)} placeholder={t("User ID")} />
        </Filter>
        <Button
          className="self-end"
          variant="outline"
          disabled={!tenantId.trim()}
          onClick={() => {
            const nextScope = tenantId.trim();
            setTenantId("");
            selectPolicy(bundle, nextScope);
          }}
        >
          {t("Edit override")}
        </Button>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <NamePolicyField
          label={t("Allowed capabilities")}
          unrestrictedLabel={t("Allow all capabilities")}
          value={draft.allowed_capabilities}
          suggestions={bundle.catalog.capabilities}
          onChange={(value) => setDraft({ ...draft, allowed_capabilities: value })}
        />
        <NamePolicyField
          label={t("Allowed tools")}
          unrestrictedLabel={t("Allow all tools except denied tools")}
          value={draft.allowed_tools}
          suggestions={bundle.catalog.tools}
          onChange={(value) => setDraft({ ...draft, allowed_tools: value })}
        />
        <label className="text-xs font-medium text-muted-foreground lg:col-span-2">
          <span className="mb-1 block">{t("Denied tools")}</span>
          <Textarea
            rows={2}
            value={draft.denied_tools.join(", ")}
            onChange={(event) => setDraft({ ...draft, denied_tools: splitNames(event.target.value) })}
            placeholder={bundle.catalog.tools.join(", ")}
          />
        </label>
        <Filter label={t("Maximum tool calls per turn")}>
          <Input type="number" min={1} max={96} value={draft.max_tool_calls} onChange={(event) => setDraft({ ...draft, max_tool_calls: Number(event.target.value) })} />
        </Filter>
        <Filter label={t("Maximum calls per tool")}>
          <Input type="number" min={1} max={32} value={draft.max_tool_calls_per_name} onChange={(event) => setDraft({ ...draft, max_tool_calls_per_name: Number(event.target.value) })} />
        </Filter>
      </div>
      {error ? <p role="alert" className="mt-3 text-sm text-destructive">{error}</p> : null}
      {message ? <p role="status" className="mt-3 text-sm text-success">{message}</p> : null}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button loading={busy} onClick={() => void stageDraft()}>{t("Preview and stage")}</Button>
        {scope !== "default" && bundle.tenants[scope] ? (
          <Button variant="outline" disabled={busy} onClick={() => void stageTenantDeletion()}>
            {t("Stage override deletion")}
          </Button>
        ) : null}
      </div>
      <PolicyWorkflowPanel
        bundle={bundle}
        busy={busy}
        onPublish={publishStage}
        onDiscard={discardStage}
        onRollback={rollbackRevision}
        onMarkRead={markNotificationRead}
      />
    </Card>
  );
}

function PolicyWorkflowPanel({
  bundle,
  busy,
  onPublish,
  onDiscard,
  onRollback,
  onMarkRead,
}: {
  bundle: ExecutionPolicyBundle;
  busy: boolean;
  onPublish: (stageId: string) => Promise<void>;
  onDiscard: (stageId: string) => Promise<void>;
  onRollback: (revisionId: string) => Promise<void>;
  onMarkRead: (notificationId: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const notifications = bundle.workflow.notifications.filter((item) => !item.resolved_at);
  return (
    <div className="mt-6 grid gap-5 lg:grid-cols-2">
      <section className="lg:col-span-2" aria-labelledby="approval-notifications-heading">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="approval-notifications-heading" className="text-sm font-medium text-foreground">
            {t("Approval notifications")}
          </h3>
          <Badge variant={bundle.approval_mode === "four_eyes" ? "warning" : "default"}>
            {bundle.approval_mode === "four_eyes" ? t("Four-eyes approval") : t("Single-admin approval")}
          </Badge>
        </div>
        {notifications.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">{t("No unread approval requests from other administrators.")}</p>
        ) : (
          <div className="mt-2 space-y-2">
            {notifications.map((notification) => (
              <div key={notification.id} className={cn("flex items-center justify-between gap-3 rounded-xl border p-3 text-sm", notification.read ? "border-border bg-muted-subtle" : "border-warning-border bg-warning-muted")}>
                <div>
                  <div className="font-medium text-foreground">{t("Policy approval requested")}: {notification.target}</div>
                  <div className="text-xs text-muted-foreground">{new Date(notification.created_at).toLocaleString()}</div>
                </div>
                {!notification.read ? (
                  <Button size="sm" variant="outline" onClick={() => void onMarkRead(notification.id)}>{t("Mark read")}</Button>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>
      <section aria-labelledby="pending-policy-heading">
        <h3 id="pending-policy-heading" className="text-sm font-medium text-foreground">
          {t("Pending approval")}
        </h3>
        <div className="mt-2 space-y-2">
          {bundle.workflow.stages.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("No staged policy changes.")}</p>
          ) : bundle.workflow.stages.map((stage) => (
            <div key={stage.id} className="rounded-xl border border-border bg-muted-subtle p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="font-medium text-foreground">
                    {stage.scope === "default" ? t("Deployment default") : stage.tenant_id}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {stage.operation === "delete" ? `${t("Delete override")} · ` : null}
                    {t("{{count}} affected tenant(s)", { count: stage.simulation.affected_tenants })}
                  </div>
                </div>
                <Badge variant={stage.expired || stage.simulation.warnings.length > 0 ? "warning" : "success"}>
                  {stage.expired ? t("Expired") : stage.simulation.warnings.length > 0 ? t("Review warnings") : t("Preview passed")}
                </Badge>
              </div>
              <div className="mt-2 text-xs text-muted-foreground">
                {t("Tool budget")}: {stage.simulation.changes.max_tool_calls.before} → {stage.simulation.changes.max_tool_calls.after}
                {stage.simulation.changes.tools.removed.length > 0
                  ? ` · ${t("Removed tools")}: ${stage.simulation.changes.tools.removed.join(", ")}`
                  : null}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {t("Expires")}: {new Date(stage.expires_at).toLocaleString()}
              </div>
              {stage.simulation.warnings.map((warning) => (
                <p key={warning} className="mt-1 text-xs text-warning">
                  {t(POLICY_WARNING_KEYS[warning] ?? "Unknown policy warning")}
                </p>
              ))}
              <div className="mt-3 flex gap-2">
                <Button size="sm" disabled={busy || stage.expired || !stage.can_approve} onClick={() => void onPublish(stage.id)}>
                  {!stage.can_approve ? t("Creator cannot approve") : t("Approve and publish")}
                </Button>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void onDiscard(stage.id)}>{t("Discard")}</Button>
              </div>
            </div>
          ))}
        </div>
      </section>
      <section aria-labelledby="policy-history-heading">
        <h3 id="policy-history-heading" className="text-sm font-medium text-foreground">
          {t("Published revisions")}
        </h3>
        <div className="mt-2 space-y-2">
          {bundle.workflow.revisions.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("No policy revisions yet.")}</p>
          ) : bundle.workflow.revisions.slice(0, 10).map((revision) => (
            <div key={revision.id} className="flex items-center justify-between gap-3 rounded-xl border border-border p-3 text-sm">
              <div className="min-w-0">
                <div className="truncate font-medium text-foreground">
                  {revision.action === "rollback" ? t("Rollback") : t("Published")} · {revision.target}
                </div>
                <div className="text-xs text-muted-foreground">{new Date(revision.created_at).toLocaleString()}</div>
              </div>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void onRollback(revision.id)}>
                {t("Roll back")}
              </Button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function NamePolicyField({
  label,
  unrestrictedLabel,
  value,
  suggestions,
  onChange,
}: {
  label: string;
  unrestrictedLabel: string;
  value: string[] | null;
  suggestions: string[];
  onChange: (value: string[] | null) => void;
}) {
  return (
    <div>
      <label className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <input
          type="checkbox"
          checked={value === null}
          onChange={(event) => onChange(event.target.checked ? null : [])}
          className="size-4 rounded border-input accent-primary"
        />
        {unrestrictedLabel}
      </label>
      <label className="text-xs font-medium text-muted-foreground">
        <span className="mb-1 block">{label}</span>
        <Textarea
          rows={3}
          disabled={value === null}
          value={(value ?? []).join(", ")}
          onChange={(event) => onChange(splitNames(event.target.value))}
          placeholder={suggestions.join(", ")}
        />
      </label>
    </div>
  );
}

function Filter({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="min-w-40 text-xs font-medium text-muted-foreground">
      <span className="mb-1 block">{label}</span>
      {children}
    </label>
  );
}

function LoadingState() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-hidden>
      {[0, 1, 2, 3].map((index) => (
        <Skeleton key={index} className="h-24" />
      ))}
    </div>
  );
}

function SummaryCards({ snapshot }: { snapshot: ControlPlaneSnapshot }) {
  const { t } = useTranslation();
  const cards = [
    { label: t("Policy decisions"), value: snapshot.summary.decisions, icon: ShieldCheck },
    { label: t("Denied"), value: snapshot.summary.denied, icon: ShieldAlert },
    { label: t("Critical denials"), value: snapshot.summary.critical_denied, icon: XCircle },
    { label: t("Failed outcomes"), value: snapshot.summary.failed_outcomes, icon: AlertTriangle },
  ];
  return (
    <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {cards.map((card) => {
        const Icon = card.icon;
        return (
          <Card key={card.label} className="p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs text-muted-foreground">{card.label}</p>
                <p className="mt-1 text-2xl font-medium tabular-nums text-foreground">{card.value}</p>
              </div>
              <Icon size={19} className="text-muted-foreground" aria-hidden="true" />
            </div>
          </Card>
        );
      })}
    </div>
  );
}

function EventTable({ events, locale }: { events: ControlPlaneEvent[]; locale: string }) {
  const { t } = useTranslation();
  if (events.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={CheckCircle2}
          title={t("No matching control-plane events")}
          description={t("Try a wider time window or fewer filters.")}
        />
      </Card>
    );
  }
  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="border-b border-border bg-muted-subtle text-xs text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-medium">{t("Time")}</th>
              <th className="px-4 py-3 font-medium">{t("Actor")}</th>
              <th className="px-4 py-3 font-medium">{t("Execution")}</th>
              <th className="px-4 py-3 font-medium">{t("Decision")}</th>
              <th className="px-4 py-3 font-medium">{t("Rule")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {events.map((event, index) => (
              <tr key={`${event.decision_id}-${event.event}-${index}`}>
                <td className="whitespace-nowrap px-4 py-3 text-xs text-muted-foreground">
                  {event.time
                    ? new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "medium" }).format(new Date(event.time))
                    : "—"}
                </td>
                <td className="px-4 py-3">
                  <div className="font-medium text-foreground">{event.user_id || "—"}</div>
                  <div className="text-xs text-muted-foreground">{event.role || "—"}</div>
                </td>
                <td className="px-4 py-3">
                  <div className="font-mono text-xs text-foreground">{event.name || "—"}</div>
                  <div className="text-xs text-muted-foreground">{event.kind || event.event}</div>
                </td>
                <td className="px-4 py-3">
                  <Badge variant={eventTone(event)}>
                    {event.event === "policy_change"
                      ? t("Changed")
                      : event.event === "execution_outcome"
                      ? event.success === false
                        ? t("Failed")
                        : t("Succeeded")
                      : event.allowed === false
                        ? t("Denied")
                        : t("Allowed")}
                  </Badge>
                  {event.risk_level ? (
                    <span className="ml-2 text-xs text-muted-foreground">
                      {t(RISK_LABEL_KEYS[event.risk_level] ?? "Unknown")}
                    </span>
                  ) : null}
                </td>
                <td className="max-w-xs px-4 py-3">
                  <div className="font-mono text-xs text-foreground">{event.rule_id || event.action || event.error_type || "—"}</div>
                  {event.reason ? <div className="mt-1 truncate text-xs text-muted-foreground" title={event.reason}>{event.reason}</div> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
