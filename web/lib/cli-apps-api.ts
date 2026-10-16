import { apiFetch, apiUrl } from "@/lib/api";

/** Mirrors `cognivoy/api/routers/space_cli_apps.py`. */
export const CLI_APPS_BASE_PATH = "/api/v1/space/cli-apps";

/** Where the code comes from — the only honest input to "should I install this?". */
export type CliAppTrust = "first-party" | "third-party";

export type CliAppRuntime = "python" | "node" | "none";

/** One installed app, as the calling account sees it. */
export interface CliApp {
  id: string;
  display_name: string;
  description: string;
  category: string;
  /** The name the chat agent calls it by, e.g. `cli_blender`. */
  tool_name: string;
  entry_point: string;
  runtime: CliAppRuntime;
  installed_at: string;
  version: string;
  /** Commit or ref this install is fixed to; `""` when it floats. */
  pin: string;
  trust: CliAppTrust;
  /** Whether an administrator granted this account access to it. */
  granted: boolean;
  /** Whether it is switched on for this account. False whenever not granted. */
  enabled: boolean;
  /** False once the snapshot no longer lists it: removable, not offerable. */
  in_catalog: boolean;
}

/** Why the list may be unusable even when it is not empty. */
export interface CliAppAccess {
  /** True for an administrator: every installed app is available. */
  unrestricted: boolean;
  /** True when the account's grant denies code execution outright. */
  exec_denied: boolean;
}

export interface CliAppState {
  apps: CliApp[];
  access: CliAppAccess;
  /** The reviewed CLI-Anything commit first-party installs are pinned to. */
  catalog_pin: string;
  /** Install output, present only on the response to an install. */
  log?: string;
}

export interface CliCatalogEntry {
  id: string;
  display_name: string;
  description: string;
  category: string;
  origin: string;
  trust: CliAppTrust;
  requires: string;
  homepage: string;
  source_url: string;
  entry_point: string;
  runtime: CliAppRuntime;
  install_kind: string;
  /** The requirement or package that would be installed, including any pin. */
  install_target: string;
  installable: boolean;
  /** Whether the install resolves to one fixed revision. */
  pinned: boolean;
  /** Present only when `installable` is false, and written for a person. */
  unsupported_reason: string;
  install_notes: string;
  installed: boolean;
}

export interface CliCatalogPage {
  entries: CliCatalogEntry[];
  /** Empty once the last page has been served. */
  next_cursor: string;
  total: number;
  categories: Record<string, number>;
  catalog_pin: string;
}

export interface CliAppInstallPreview {
  appId: string;
  displayName: string;
  origin: string;
  trust: CliAppTrust;
  runtime: CliAppRuntime;
  installTarget: string;
  pinned: boolean;
  networkAccess: boolean;
  commands: string[][];
  notes: string;
  installable: boolean;
}

export type CliInstallJobStatus =
  | "queued"
  | "running"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled";

export interface CliInstallJob {
  taskId: string;
  appId: string;
  displayName: string;
  status: CliInstallJobStatus;
  log: string;
  message: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * A refused request, carrying the backend's reason and — for a failed install —
 * its output. The log is the only actionable thing about a failed install, so it
 * rides on the error rather than being left on the server.
 */
export class CliAppError extends Error {
  readonly code: string;
  readonly log: string;

  constructor(message: string, code = "", log = "") {
    super(message);
    this.name = "CliAppError";
    this.code = code;
    this.log = log;
  }
}

async function asJson(response: Response) {
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    let code = "";
    let log = "";
    try {
      const body = await response.json();
      const detail = (body as { detail?: unknown } | null)?.detail;
      if (detail && typeof detail === "object") {
        const shaped = detail as {
          code?: unknown;
          message?: unknown;
          log?: unknown;
        };
        code = String(shaped.code ?? "");
        log = String(shaped.log ?? "");
        if (shaped.message) message = String(shaped.message);
      } else if (detail) {
        message = String(detail);
      }
    } catch {
      /* keep the status line */
    }
    throw new CliAppError(message, code, log);
  }
  return response.json();
}

function str(value: unknown, fallback = ""): string {
  return value === undefined || value === null ? fallback : String(value);
}

function normalizeApp(raw: unknown): CliApp {
  const item = (raw ?? {}) as Record<string, unknown>;
  return {
    id: str(item.id),
    display_name: str(item.display_name),
    description: str(item.description),
    category: str(item.category),
    tool_name: str(item.tool_name),
    entry_point: str(item.entry_point),
    runtime: (str(item.runtime, "python") as CliAppRuntime) ?? "python",
    installed_at: str(item.installed_at),
    version: str(item.version),
    pin: str(item.pin),
    trust: (str(item.trust, "third-party") as CliAppTrust) ?? "third-party",
    granted: Boolean(item.granted),
    enabled: Boolean(item.enabled),
    // Absent field reads as "still catalogued": treating it as withdrawn would
    // hide a working app behind a warning.
    in_catalog: item.in_catalog === undefined ? true : Boolean(item.in_catalog),
  };
}

function normalizeState(raw: unknown): CliAppState {
  const data = (raw ?? {}) as Record<string, unknown>;
  const access = (data.access ?? {}) as Record<string, unknown>;
  return {
    apps: Array.isArray(data.apps) ? data.apps.map(normalizeApp) : [],
    access: {
      unrestricted: Boolean(access.unrestricted),
      exec_denied: Boolean(access.exec_denied),
    },
    catalog_pin: str(data.catalog_pin),
    ...(data.log === undefined ? {} : { log: str(data.log) }),
  };
}

function normalizeEntry(raw: unknown): CliCatalogEntry {
  const item = (raw ?? {}) as Record<string, unknown>;
  return {
    id: str(item.id),
    display_name: str(item.display_name),
    description: str(item.description),
    category: str(item.category),
    origin: str(item.origin),
    trust: (str(item.trust, "third-party") as CliAppTrust) ?? "third-party",
    requires: str(item.requires),
    homepage: str(item.homepage),
    source_url: str(item.source_url),
    entry_point: str(item.entry_point),
    runtime: (str(item.runtime, "python") as CliAppRuntime) ?? "python",
    install_kind: str(item.install_kind),
    install_target: str(item.install_target),
    installable: Boolean(item.installable),
    pinned: Boolean(item.pinned),
    unsupported_reason: str(item.unsupported_reason),
    install_notes: str(item.install_notes),
    installed: Boolean(item.installed),
  };
}

function normalizeInstallJob(raw: unknown): CliInstallJob {
  const item = (raw ?? {}) as Record<string, unknown>;
  const status = str(item.status, "failed") as CliInstallJobStatus;
  return {
    taskId: str(item.task_id),
    appId: str(item.app_id),
    displayName: str(item.display_name),
    status,
    log: str(item.log),
    message: str(item.message),
    createdAt: str(item.created_at),
    updatedAt: str(item.updated_at),
  };
}

export async function getCliApps(): Promise<CliAppState> {
  const response = await apiFetch(apiUrl(`${CLI_APPS_BASE_PATH}/apps`), {
    cache: "no-store",
  });
  return normalizeState(await asJson(response));
}

export async function setCliAppEnabled(
  appId: string,
  enabled: boolean,
): Promise<CliAppState> {
  const response = await apiFetch(
    apiUrl(`${CLI_APPS_BASE_PATH}/apps/${encodeURIComponent(appId)}/enabled`),
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    },
  );
  return normalizeState(await asJson(response));
}

export async function getCliCatalog(
  query: {
    q?: string;
    category?: string;
    installableOnly?: boolean;
    cursor?: string;
    limit?: number;
  } = {},
): Promise<CliCatalogPage> {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.category) params.set("category", query.category);
  if (query.installableOnly === false) params.set("installable_only", "false");
  if (query.cursor) params.set("cursor", query.cursor);
  if (query.limit) params.set("limit", String(query.limit));
  const search = params.toString();
  const response = await apiFetch(
    apiUrl(`${CLI_APPS_BASE_PATH}/catalog${search ? `?${search}` : ""}`),
    { cache: "no-store" },
  );
  const data = await asJson(response);
  const counts = (data?.categories ?? {}) as Record<string, unknown>;
  return {
    entries: Array.isArray(data?.entries)
      ? data.entries.map(normalizeEntry)
      : [],
    next_cursor: str(data?.next_cursor),
    total: typeof data?.total === "number" ? data.total : 0,
    categories: Object.fromEntries(
      Object.entries(counts).map(([category, count]) => [
        category,
        typeof count === "number" ? count : 0,
      ]),
    ),
    catalog_pin: str(data?.catalog_pin),
  };
}

/** Administrator only; a non-admin caller gets a 403 from the route itself. */
export async function getCliAppInstallPreview(
  appId: string,
): Promise<CliAppInstallPreview> {
  const response = await apiFetch(
    apiUrl(`${CLI_APPS_BASE_PATH}/catalog/${encodeURIComponent(appId)}/install/preview`),
    { cache: "no-store" },
  );
  const data = await asJson(response);
  return {
    appId: str(data?.app_id),
    displayName: str(data?.display_name),
    origin: str(data?.origin),
    trust: str(data?.trust, "third-party") as CliAppTrust,
    runtime: str(data?.runtime, "none") as CliAppRuntime,
    installTarget: str(data?.install_target),
    pinned: Boolean(data?.pinned),
    networkAccess: Boolean(data?.network_access),
    commands: Array.isArray(data?.commands)
      ? data.commands.map((row: unknown) => Array.isArray(row) ? row.map(String) : [])
      : [],
    notes: str(data?.notes),
    installable: Boolean(data?.installable),
  };
}

async function startCliAppInstall(appId: string): Promise<CliInstallJob> {
  const response = await apiFetch(
    apiUrl(
      `${CLI_APPS_BASE_PATH}/catalog/${encodeURIComponent(appId)}/install-jobs`,
    ),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmed: true }),
    },
  );
  return normalizeInstallJob(await asJson(response));
}

export async function installReviewedCliApp(
  preview: CliAppInstallPreview,
): Promise<CliInstallJob> {
  if (!preview.installable || preview.commands.length === 0) {
    throw new CliAppError("This catalog entry cannot be installed.", "cli.not_installable");
  }
  return startCliAppInstall(preview.appId);
}

export async function getCliAppInstallJob(
  taskId: string,
): Promise<CliInstallJob> {
  const response = await apiFetch(
    apiUrl(`${CLI_APPS_BASE_PATH}/install-jobs/${encodeURIComponent(taskId)}`),
    { cache: "no-store" },
  );
  return normalizeInstallJob(await asJson(response));
}

export async function cancelCliAppInstallJob(
  taskId: string,
): Promise<CliInstallJob> {
  const response = await apiFetch(
    apiUrl(`${CLI_APPS_BASE_PATH}/install-jobs/${encodeURIComponent(taskId)}`),
    { method: "DELETE" },
  );
  return normalizeInstallJob(await asJson(response));
}

/** Administrator only. */
export async function uninstallCliApp(appId: string): Promise<CliAppState> {
  const response = await apiFetch(
    apiUrl(`${CLI_APPS_BASE_PATH}/apps/${encodeURIComponent(appId)}`),
    { method: "DELETE" },
  );
  return normalizeState(await asJson(response));
}
