import { apiFetch, apiUrl } from "@/lib/api";

export type ControlPlaneDecisionFilter = "all" | "allowed" | "denied";
export type ControlPlaneRiskFilter = "" | "medium" | "high" | "critical";

export interface ControlPlaneEvent {
  time?: string;
  event: "policy_decision" | "execution_outcome" | "security_event" | "policy_change";
  category?: string;
  action?: string;
  decision_id?: string;
  kind?: "capability" | "tool";
  name?: string;
  allowed?: boolean;
  rule_id?: string;
  reason?: string;
  risk_level?: string;
  source?: string;
  stage?: string;
  success?: boolean;
  error_type?: string;
  target_digest?: string;
  policy_digest?: string;
  target_user_id?: string;
  user_id?: string;
  role?: string;
  session_id?: string;
}

export interface ControlPlaneSnapshot {
  generated_at: string;
  window_hours: number;
  events: ControlPlaneEvent[];
  summary: {
    decisions: number;
    allowed: number;
    denied: number;
    critical_denied: number;
    budget_denied: number;
    outcomes: number;
    failed_outcomes: number;
    network_denied: number;
    unique_users: number;
    top_denied: Array<{ name: string; count: number }>;
  };
  alerts: Array<{
    code:
      | "critical_policy_denials"
      | "repeated_budget_denials"
      | "elevated_denial_rate"
      | "network_policy_denials";
    severity: "critical" | "warning";
    count: number;
    fingerprint: string;
    acknowledged: boolean;
    acknowledged_at: string;
  }>;
  scanned: number;
  scan_truncated: boolean;
}

export interface ExecutionPolicy {
  allowed_capabilities: string[] | null;
  allowed_tools: string[] | null;
  denied_tools: string[];
  max_tool_calls: number;
  max_tool_calls_per_name: number;
}

export interface ExecutionPolicyBundle {
  version: number;
  default: ExecutionPolicy;
  tenants: Record<string, ExecutionPolicy>;
  integrity_error: string;
  catalog: {
    capabilities: string[];
    tools: string[];
  };
  workflow: PolicyWorkflow;
  approval_mode: "four_eyes" | "single_admin";
  current_user_id: string;
}

export interface PolicySimulation {
  scope: "default" | "tenant";
  tenant_id: string;
  base_digest: string;
  candidate_digest: string;
  affected_tenants: number;
  changes: {
    capabilities: PolicySetChange;
    tools: PolicySetChange;
    denied_tools: PolicySetChange;
    max_tool_calls: { before: number; after: number };
    max_tool_calls_per_name: { before: number; after: number };
  };
  warnings: string[];
}

export interface PolicySetChange {
  before_unrestricted: boolean;
  after_unrestricted: boolean;
  removed: string[];
  added: string[];
  became_restricted: boolean;
  became_unrestricted: boolean;
}

export interface PolicyStage {
  id: string;
  created_at: string;
  expires_at: string;
  created_by: string;
  scope: "default" | "tenant";
  operation: "upsert" | "delete";
  tenant_id: string;
  base_digest: string;
  candidate_digest: string;
  simulation: PolicySimulation;
  expired: boolean;
  can_approve: boolean;
}

export interface PolicyRevision {
  id: string;
  created_at: string;
  created_by: string;
  action: "published" | "rollback";
  scope: string;
  target: string;
  policy_digest: string;
  rollback_digest?: string;
  source_stage_id?: string;
  source_revision_id?: string;
}

export interface PolicyWorkflow {
  stages: PolicyStage[];
  revisions: PolicyRevision[];
  notifications: PolicyApprovalNotification[];
}

export interface PolicyApprovalNotification {
  id: string;
  type: "policy_approval_requested";
  created_at: string;
  stage_id: string;
  target: string;
  resolved_at: string;
  read: boolean;
}

export async function fetchControlPlaneSnapshot(filters: {
  windowHours: number;
  decision: ControlPlaneDecisionFilter;
  riskLevel: ControlPlaneRiskFilter;
  limit?: number;
}): Promise<ControlPlaneSnapshot> {
  const params = new URLSearchParams({
    since_hours: String(filters.windowHours),
    decision: filters.decision,
    risk_level: filters.riskLevel,
    limit: String(filters.limit ?? 100),
  });
  const response = await apiFetch(
    apiUrl(`/api/v1/control-plane/events?${params.toString()}`),
    { cache: "no-store" },
  );
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(
      typeof body.detail === "string"
        ? body.detail
        : `Failed to load control-plane events (HTTP ${response.status})`,
    );
  }
  return (await response.json()) as ControlPlaneSnapshot;
}

async function policyRequest(
  path: string,
  init?: RequestInit,
): Promise<ExecutionPolicyBundle> {
  const response = await apiFetch(apiUrl(`/api/v1/control-plane${path}`), {
    cache: "no-store",
    ...init,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(
      typeof body.detail === "string"
        ? body.detail
        : `Policy request failed (HTTP ${response.status})`,
    );
  }
  return (await response.json()) as ExecutionPolicyBundle;
}

export function fetchExecutionPolicies(): Promise<ExecutionPolicyBundle> {
  return policyRequest("/policies");
}

export function saveDefaultExecutionPolicy(
  policy: ExecutionPolicy,
): Promise<ExecutionPolicyBundle> {
  return policyRequest("/policies/default", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(policy),
  });
}

export function saveTenantExecutionPolicy(
  tenantId: string,
  policy: ExecutionPolicy,
): Promise<ExecutionPolicyBundle> {
  return policyRequest(`/policies/tenants/${encodeURIComponent(tenantId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(policy),
  });
}

export function deleteTenantExecutionPolicy(
  tenantId: string,
): Promise<ExecutionPolicyBundle> {
  return policyRequest(`/policies/tenants/${encodeURIComponent(tenantId)}`, {
    method: "DELETE",
  });
}

export async function stageExecutionPolicy(input: {
  scope: "default" | "tenant";
  tenantId: string;
  policy: ExecutionPolicy;
}): Promise<PolicyStage> {
  const response = await policyRequestRaw("/policies/stages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      scope: input.scope,
      tenant_id: input.tenantId,
      policy: input.policy,
    }),
  });
  return (response as { stage: PolicyStage }).stage;
}

export async function stageTenantPolicyDeletion(tenantId: string): Promise<PolicyStage> {
  const response = await policyRequestRaw("/policies/stages/delete-tenant", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tenant_id: tenantId }),
  });
  return (response as { stage: PolicyStage }).stage;
}

export function publishStagedExecutionPolicy(stageId: string): Promise<ExecutionPolicyBundle> {
  return policyRequest(`/policies/stages/${encodeURIComponent(stageId)}/publish`, {
    method: "POST",
  });
}

export async function discardStagedExecutionPolicy(stageId: string): Promise<void> {
  await policyRequestRaw(`/policies/stages/${encodeURIComponent(stageId)}`, {
    method: "DELETE",
  });
}

export function rollbackExecutionPolicyRevision(
  revisionId: string,
): Promise<ExecutionPolicyBundle> {
  return policyRequest(`/policies/revisions/${encodeURIComponent(revisionId)}/rollback`, {
    method: "POST",
  });
}

export async function markPolicyNotificationRead(notificationId: string): Promise<void> {
  await policyRequestRaw(
    `/policies/notifications/${encodeURIComponent(notificationId)}/read`,
    { method: "POST" },
  );
}

async function policyRequestRaw(path: string, init?: RequestInit): Promise<unknown> {
  const response = await apiFetch(apiUrl(`/api/v1/control-plane${path}`), {
    cache: "no-store",
    ...init,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(
      typeof body.detail === "string"
        ? body.detail
        : `Policy request failed (HTTP ${response.status})`,
    );
  }
  return response.json();
}

export async function acknowledgeControlPlaneAlert(
  fingerprint: string,
): Promise<void> {
  const response = await apiFetch(apiUrl("/api/v1/control-plane/alerts/acknowledge"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fingerprint }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(
      typeof body.detail === "string"
        ? body.detail
        : `Failed to acknowledge alert (HTTP ${response.status})`,
    );
  }
}

export function controlPlaneExportUrl(windowHours: number): string {
  const params = new URLSearchParams({ since_hours: String(windowHours) });
  return apiUrl(`/api/v1/control-plane/events/export.csv?${params.toString()}`);
}
