import { apiFetch, apiUrl } from "@/lib/api";
import { invalidateClientCache, withClientCache } from "@/lib/client-cache";

const KNOWLEDGE_CACHE_PREFIX = "knowledge:";

export interface KnowledgeBaseSummary {
  id?: string;
  name: string;
  is_default?: boolean;
  status?: string;
  path?: string;
  metadata?: Record<string, unknown>;
  progress?: Record<string, unknown>;
  statistics?: Record<string, unknown>;
  source?: "admin" | "user";
  assigned?: boolean;
  read_only?: boolean;
  provenance_label?: string;
  available?: boolean;
}

export interface RagProviderSummary {
  id: string;
  name: string;
  description: string;
  /** Whether the engine is ready to use (e.g. its API key is set). */
  configured?: boolean;
  /** Whether the engine needs an API key configured before use. */
  requires_api_key?: boolean;
  /** Retrieval modes this engine supports (empty for mode-less engines). */
  modes?: string[];
  /** The active default retrieval mode for this engine. */
  default_mode?: string;
  /** Whether an existing index for this engine can be linked in place. */
  linkable?: boolean;
  /** Full operational readiness, including active model prerequisites. */
  ready?: boolean;
  preflight?: EnginePreflight;
}

export interface PageIndexConfig {
  api_base_url: string;
  api_key_set: boolean;
  configured: boolean;
}

export interface LlamaIndexConfig {
  version: number;
  /** Keyword is model-free; hybrid/vector require a configured embedding model. */
  retrieval_profile: "keyword" | "hybrid" | "vector";
  /** Default number of chunks a query returns. */
  top_k: number;
  vector_top_k_multiplier: number;
  bm25_top_k_multiplier: number;
  /** Chunk geometry — applies to documents indexed after the change. */
  chunk_size: number;
  chunk_overlap: number;
}

export interface GraphRagConfig {
  version: number;
  response_type: string;
  community_level: number;
  dynamic_community_selection: boolean;
}

export interface LightRagConfig {
  version: number;
  top_k: number;
  response_type: string;
}

export interface PreflightCheck {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
  /** Optional checks don't gate overall readiness (e.g. BM25, vision). */
  optional: boolean;
}

export interface EnginePreflight {
  ok: boolean;
  checks: PreflightCheck[];
}

export interface RetrievalHealthCheck {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
  detail_key?: string;
  parameters?: Record<string, string | number | boolean>;
  optional: boolean;
  action?: { label: string; href: string };
}

export interface RetrievalHealthReport {
  knowledge_base: string;
  provider: string;
  ready: boolean;
  checked_at: string;
  checks: RetrievalHealthCheck[];
}

export interface RetrievalQualityReport {
  knowledge_base: string;
  sample_source: string;
  question: string;
  score: number;
  quality: "good" | "partial" | "poor" | "unavailable";
  source_matched: boolean;
  passage_overlap: number;
  retrieved_count: number;
  recommendations: string[];
}

export interface IndexFragment {
  rank: number;
  source: string;
  page?: string | number | null;
  section?: string | null;
  score?: number | null;
  content: string;
  metadata: Record<string, string | number | boolean | null>;
}

export interface IndexFragmentsReport {
  knowledge_base: string;
  query: string;
  requested_top_k: number;
  fragment_count: number;
  fragments: IndexFragment[];
}

export interface UploadPreflightResult {
  knowledge_base: string;
  has_duplicates: boolean;
  files: Array<{
    name: string;
    relative_path: string;
    path_exists: boolean;
    existing_size_bytes?: number | null;
    same_content_paths: string[];
    suggested_rename?: string | null;
  }>;
}

export type DuplicateUploadStrategy = "error" | "skip" | "replace" | "rename";

export interface ModelOption {
  profile_id: string;
  profile_name: string;
  model_id: string;
  label: string;
  model: string;
  detail: string;
}

export interface ModelKindOptions {
  active: { profile_id: string | null; model_id: string | null };
  options: ModelOption[];
}

/** Map of service kind ("llm" | "embedding") → its options + active selection. */
export type ModelOptionsByKind = Record<string, ModelKindOptions>;

export interface KnowledgeUploadPolicy {
  extensions: string[];
  accept: string;
  max_file_size_bytes: number;
}

export interface KnowledgeBaseFile {
  /** POSIX path relative to the KB's raw/ root (may include folders). */
  name: string;
  /** "folder" entries are organizational only; default "file". */
  type?: "file" | "folder";
  size?: number;
  modified?: number;
  mime_type?: string | null;
}

export interface KnowledgeDeletionImpact {
  knowledge_base: string;
  counts: {
    sessions: number;
    notebook_records: number;
    workspace_files: number;
  };
  sessions: Array<{ session_id: string }>;
  notebook_records: Array<{
    notebook_id: string;
    record_id: string;
    title: string;
  }>;
  workspace_files: Array<{ path: string }>;
  total_references: number;
  confirmation_token: string;
}

export interface DeletedKnowledgeReference {
  name: string;
  status: "deleted";
  deleted_at: string;
  impact: KnowledgeDeletionImpact;
}

const IMAGE_UPLOAD_EXTENSIONS = [
  ".bmp",
  ".gif",
  ".jpeg",
  ".jpg",
  ".png",
  ".tif",
  ".tiff",
  ".webp",
];

const IMAGE_UPLOAD_MIME_TYPES = [
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/tiff",
  "image/webp",
];

function normalizeUploadPolicy(data: unknown): KnowledgeUploadPolicy {
  const payload = data as Partial<KnowledgeUploadPolicy> | null | undefined;
  const extensions = Array.from(
    new Set([
      ...(Array.isArray(payload?.extensions) ? payload.extensions : []),
      ...IMAGE_UPLOAD_EXTENSIONS,
    ]),
  ).sort();
  const serverAccept =
    typeof payload?.accept === "string"
      ? payload.accept
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)
      : [];
  const accept = Array.from(
    new Set([...serverAccept, ...extensions, ...IMAGE_UPLOAD_MIME_TYPES]),
  ).join(",");

  return {
    extensions,
    accept,
    max_file_size_bytes:
      typeof payload?.max_file_size_bytes === "number"
        ? payload.max_file_size_bytes
        : 200 * 1024 * 1024,
  };
}

export async function listKnowledgeBases(options?: { force?: boolean }) {
  return withClientCache<KnowledgeBaseSummary[]>(
    `${KNOWLEDGE_CACHE_PREFIX}list`,
    async () => {
      const response = await apiFetch(apiUrl("/api/v1/knowledge/list"), {
        cache: "no-store",
      });
      const data = await response.json();
      return Array.isArray(data)
        ? data
        : Array.isArray(data?.knowledge_bases)
          ? data.knowledge_bases
          : [];
    },
    {
      force: options?.force,
    },
  );
}

export async function listRagProviders(options?: { force?: boolean }) {
  return withClientCache<RagProviderSummary[]>(
    `${KNOWLEDGE_CACHE_PREFIX}providers`,
    async () => {
      const response = await apiFetch(
        apiUrl("/api/v1/knowledge/rag-providers"),
        {
          cache: "no-store",
        },
      );
      const data = await response.json();
      return Array.isArray(data?.providers) ? data.providers : [];
    },
    {
      force: options?.force,
    },
  );
}

export async function getKnowledgeUploadPolicy(options?: { force?: boolean }) {
  return withClientCache<KnowledgeUploadPolicy>(
    `${KNOWLEDGE_CACHE_PREFIX}upload-policy`,
    async () => {
      const response = await apiFetch(
        apiUrl("/api/v1/knowledge/supported-file-types"),
        {
          cache: "no-store",
        },
      );
      const data = await response.json();
      return normalizeUploadPolicy(data);
    },
    {
      force: options?.force,
    },
  );
}

export function invalidateKnowledgeCaches() {
  invalidateClientCache(KNOWLEDGE_CACHE_PREFIX);
}

const PAGEINDEX_CONFIG_PATH =
  "/api/v1/knowledge/rag-pipelines/pageindex/config";

export async function getPageIndexConfig(options?: {
  force?: boolean;
}): Promise<PageIndexConfig> {
  return withClientCache<PageIndexConfig>(
    `${KNOWLEDGE_CACHE_PREFIX}pageindex-config`,
    async () => {
      const response = await apiFetch(apiUrl(PAGEINDEX_CONFIG_PATH), {
        cache: "no-store",
      });
      if (!response.ok) {
        throw new Error(
          await readErrorDetail(response, "Failed to read PageIndex config"),
        );
      }
      return (await response.json()) as PageIndexConfig;
    },
    { force: options?.force, ttlMs: 15_000 },
  );
}

export async function updatePageIndexConfig(payload: {
  /** Omit to keep the stored key, "" to clear it, any value to replace it. */
  api_key?: string;
  api_base_url?: string;
}): Promise<PageIndexConfig> {
  const res = await apiFetch(apiUrl(PAGEINDEX_CONFIG_PATH), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(
      await readErrorDetail(res, "Failed to update PageIndex config"),
    );
  }
  // The provider list's `configured` flag depends on this; refresh it.
  invalidateKnowledgeCaches();
  return (await res.json()) as PageIndexConfig;
}

const LLAMAINDEX_CONFIG_PATH =
  "/api/v1/knowledge/rag-pipelines/llamaindex/config";

export async function getLlamaIndexConfig(options?: {
  force?: boolean;
}): Promise<LlamaIndexConfig> {
  return withClientCache<LlamaIndexConfig>(
    `${KNOWLEDGE_CACHE_PREFIX}llamaindex-config`,
    async () => {
      const response = await apiFetch(apiUrl(LLAMAINDEX_CONFIG_PATH), {
        cache: "no-store",
      });
      if (!response.ok) {
        throw new Error(
          await readErrorDetail(response, "Failed to read LlamaIndex config"),
        );
      }
      return (await response.json()) as LlamaIndexConfig;
    },
    { force: options?.force, ttlMs: 15_000 },
  );
}

export async function updateLlamaIndexConfig(
  payload: Partial<Omit<LlamaIndexConfig, "version">>,
): Promise<LlamaIndexConfig> {
  const res = await apiFetch(apiUrl(LLAMAINDEX_CONFIG_PATH), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(
      await readErrorDetail(res, "Failed to update LlamaIndex config"),
    );
  }
  invalidateKnowledgeCaches();
  return (await res.json()) as LlamaIndexConfig;
}

async function getEngineConfig<T>(
  provider: string,
  cacheKey: string,
  options?: { force?: boolean },
): Promise<T> {
  return withClientCache<T>(
    `${KNOWLEDGE_CACHE_PREFIX}${cacheKey}`,
    async () => {
      const response = await apiFetch(
        apiUrl(`/api/v1/knowledge/rag-pipelines/${provider}/config`),
        { cache: "no-store" },
      );
      if (!response.ok) {
        throw new Error(
          await readErrorDetail(response, `Failed to read ${provider} config`),
        );
      }
      return (await response.json()) as T;
    },
    { force: options?.force, ttlMs: 15_000 },
  );
}

async function updateEngineConfig<T>(
  provider: string,
  payload: Record<string, unknown>,
): Promise<T> {
  const res = await apiFetch(
    apiUrl(`/api/v1/knowledge/rag-pipelines/${provider}/config`),
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  if (!res.ok) {
    throw new Error(
      await readErrorDetail(res, `Failed to update ${provider} config`),
    );
  }
  invalidateKnowledgeCaches();
  return (await res.json()) as T;
}

export const getGraphRagConfig = (options?: { force?: boolean }) =>
  getEngineConfig<GraphRagConfig>("graphrag", "graphrag-config", options);
export const updateGraphRagConfig = (
  payload: Partial<Omit<GraphRagConfig, "version">>,
) => updateEngineConfig<GraphRagConfig>("graphrag", payload);

export const getLightRagConfig = (options?: { force?: boolean }) =>
  getEngineConfig<LightRagConfig>("lightrag", "lightrag-config", options);
export const updateLightRagConfig = (
  payload: Partial<Omit<LightRagConfig, "version">>,
) => updateEngineConfig<LightRagConfig>("lightrag", payload);

export async function getEnginePreflight(
  provider: string,
): Promise<EnginePreflight> {
  const res = await apiFetch(
    apiUrl(`/api/v1/knowledge/rag-pipelines/${provider}/preflight`),
    { cache: "no-store" },
  );
  if (!res.ok) {
    throw new Error(await readErrorDetail(res, "Failed to check environment"));
  }
  return (await res.json()) as EnginePreflight;
}

export async function getRetrievalHealth(
  kbName: string,
): Promise<RetrievalHealthReport> {
  const res = await apiFetch(
    apiUrl(`/api/v1/knowledge/${encodeURIComponent(kbName)}/retrieval-health`),
    { cache: "no-store" },
  );
  if (!res.ok) {
    throw new Error(await readErrorDetail(res, "Failed to check retrieval health"));
  }
  return (await res.json()) as RetrievalHealthReport;
}

export async function runRetrievalQualityProbe(
  kbName: string,
): Promise<RetrievalQualityReport> {
  const res = await apiFetch(
    apiUrl(`/api/v1/knowledge/${encodeURIComponent(kbName)}/retrieval-quality`),
    { method: "POST" },
  );
  if (!res.ok) {
    throw new Error(await readErrorDetail(res, "Failed to run retrieval quality probe"));
  }
  return (await res.json()) as RetrievalQualityReport;
}

export async function getEngineModelOptions(
  kinds: string[],
): Promise<ModelOptionsByKind> {
  const res = await apiFetch(
    apiUrl(
      `/api/v1/knowledge/rag-pipelines/model-options?kinds=${encodeURIComponent(
        kinds.join(","),
      )}`,
    ),
    { cache: "no-store" },
  );
  if (!res.ok) {
    throw new Error(await readErrorDetail(res, "Failed to read model options"));
  }
  return (await res.json()) as ModelOptionsByKind;
}

export async function setEngineActiveModel(
  kind: string,
  profileId: string,
  modelId: string,
): Promise<ModelKindOptions> {
  const res = await apiFetch(
    apiUrl("/api/v1/knowledge/rag-pipelines/active-model"),
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, profile_id: profileId, model_id: modelId }),
    },
  );
  if (!res.ok) {
    throw new Error(await readErrorDetail(res, "Failed to switch model"));
  }
  invalidateKnowledgeCaches();
  return (await res.json()) as ModelKindOptions;
}

export async function updateRagProviderMode(
  provider: string,
  mode: string,
): Promise<{ provider: string; mode: string }> {
  const res = await apiFetch(
    apiUrl(
      `/api/v1/knowledge/rag-providers/${encodeURIComponent(provider)}/mode`,
    ),
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    },
  );
  if (!res.ok) {
    throw new Error(
      await readErrorDetail(res, "Failed to update retrieval mode"),
    );
  }
  // The provider list's `default_mode` depends on this; refresh it.
  invalidateKnowledgeCaches();
  return (await res.json()) as { provider: string; mode: string };
}

function withDockerUpgradeHint(
  detail: string,
  status: number,
  action: string,
): string {
  if (status === 404 && detail.trim().toLowerCase() === "not found") {
    return `${action} endpoint not found (404). The web UI may be newer than the backend API. If using Docker, pull and recreate the container, then retry.`;
  }
  return detail;
}

export async function listKnowledgeBaseFiles(
  name: string,
  options?: { force?: boolean },
): Promise<KnowledgeBaseFile[]> {
  return withClientCache<KnowledgeBaseFile[]>(
    `${KNOWLEDGE_CACHE_PREFIX}files:${name}`,
    async () => {
      const response = await apiFetch(
        apiUrl(`/api/v1/knowledge/${encodeURIComponent(name)}/files`),
        { cache: "no-store" },
      );
      if (!response.ok) {
        const detail = await readErrorDetail(
          response,
          `Failed to list files (${response.status})`,
        );
        throw new Error(
          withDockerUpgradeHint(
            detail,
            response.status,
            "Knowledge file listing",
          ),
        );
      }
      const data = await response.json();
      return Array.isArray(data?.files) ? data.files : [];
    },
    { force: options?.force, ttlMs: 15_000 },
  );
}

/** Build the `/api/v1/...` path for a raw KB file (caller can pass to apiUrl()). */
export function knowledgeBaseFilePath(
  kbName: string,
  filename: string,
): string {
  return `/api/v1/knowledge/${encodeURIComponent(kbName)}/files/${filename
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

/** Build the `/api/v1/...` path for extracted plain-text preview of a raw KB file. */
export function knowledgeBaseFilePreviewTextPath(
  kbName: string,
  filename: string,
): string {
  return `/api/v1/knowledge/${encodeURIComponent(kbName)}/file-preview-text/${filename
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

/** Build the structured, layout-preserving PPTX slide preview path. */
export function knowledgeBasePptxPreviewPath(
  kbName: string,
  filename: string,
): string {
  return `/api/v1/knowledge/${encodeURIComponent(kbName)}/file-preview-slides/${filename
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

export interface KnowledgeTaskResponse {
  task_id?: string;
  message?: string;
  noop?: boolean;
  skipped_files?: string[];
  renamed_files?: Record<string, string>;
}

async function readErrorDetail(
  res: Response,
  fallback: string,
): Promise<string> {
  try {
    const body = await res.json();
    const detail = body?.detail;
    if (typeof detail === "string" && detail.trim()) return detail;
    if (detail && typeof detail === "object") {
      if (typeof detail.message === "string" && detail.message.trim()) {
        return detail.message;
      }
      if (Array.isArray(detail.checks)) {
        const failed = detail.checks.find(
          (check: unknown) =>
            !!check &&
            typeof check === "object" &&
            "ok" in check &&
            !(check as { ok?: boolean }).ok,
        ) as { detail?: unknown } | undefined;
        if (typeof failed?.detail === "string" && failed.detail.trim()) {
          return failed.detail;
        }
      }
    }
    if (typeof body?.message === "string" && body.message.trim()) {
      return body.message;
    }
  } catch {
    // body wasn't JSON; fall through
  }
  return fallback;
}

// A folder upload's File objects carry `webkitRelativePath` (e.g.
// "Papers/2024/a.pdf"); single-file picks leave it "". We forward it as
// `rel_paths` so the backend preserves the folder layout under raw/.
function appendFilesWithPaths(form: FormData, files: File[]): void {
  files.forEach((file) => {
    form.append("files", file);
    form.append("rel_paths", file.webkitRelativePath || "");
  });
}

export async function createKnowledgeBase(payload: {
  name: string;
  provider: string;
  files: File[];
}): Promise<KnowledgeTaskResponse> {
  const form = new FormData();
  form.append("name", payload.name);
  form.append("rag_provider", payload.provider);
  appendFilesWithPaths(form, payload.files);

  const res = await apiFetch(apiUrl("/api/v1/knowledge/create"), {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    throw new Error(
      await readErrorDetail(res, "Failed to create knowledge base"),
    );
  }
  invalidateKnowledgeCaches();
  return (await res.json()) as KnowledgeTaskResponse;
}

export async function connectObsidianVault(payload: {
  name: string;
  vaultPath: string;
}): Promise<{ status: string; name: string; vault_path: string }> {
  const res = await apiFetch(apiUrl("/api/v1/knowledge/connect-obsidian"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: payload.name, vault_path: payload.vaultPath }),
  });
  if (!res.ok) {
    throw new Error(
      await readErrorDetail(res, "Failed to connect Obsidian vault"),
    );
  }
  invalidateKnowledgeCaches();
  return (await res.json()) as {
    status: string;
    name: string;
    vault_path: string;
  };
}

export interface LinkedFolderProbe {
  /** Whether the folder holds a ready index for the chosen engine. */
  ok: boolean;
  provider: string;
  external_path: string;
  version: string | null;
  doc_count: number | null;
  embedding: {
    /** null when compatibility could not be verified. */
    compatible: boolean | null;
    index_model: string | null;
    current_model: string | null;
  };
  warnings: string[];
  /** Set when the folder cannot be linked at all (no index, wrong engine, …). */
  error: string | null;
}

export async function probeLinkedFolder(payload: {
  folderPath: string;
  provider: string;
}): Promise<LinkedFolderProbe> {
  const res = await apiFetch(apiUrl("/api/v1/knowledge/probe-folder"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      folder_path: payload.folderPath,
      rag_provider: payload.provider,
    }),
  });
  if (!res.ok) {
    throw new Error(await readErrorDetail(res, "Failed to inspect folder"));
  }
  return (await res.json()) as LinkedFolderProbe;
}

export async function connectLinkedFolder(payload: {
  name: string;
  folderPath: string;
  provider: string;
}): Promise<{
  status: string;
  name: string;
  external_path: string;
  rag_provider: string;
  warnings: string[];
}> {
  const res = await apiFetch(apiUrl("/api/v1/knowledge/connect-folder"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: payload.name,
      folder_path: payload.folderPath,
      rag_provider: payload.provider,
    }),
  });
  if (!res.ok) {
    throw new Error(await readErrorDetail(res, "Failed to link folder"));
  }
  invalidateKnowledgeCaches();
  return (await res.json()) as {
    status: string;
    name: string;
    external_path: string;
    rag_provider: string;
    warnings: string[];
  };
}

export interface LightRagServerProbe {
  /** Reachable, a LightRAG server, and (if required) the API key is accepted. */
  ok: boolean;
  base_url: string;
  reachable: boolean;
  auth_required: boolean;
  auth_ok: boolean;
  core_version: string | null;
  api_version: string | null;
  /** Set when the server can't be connected (unreachable, bad key, …). */
  error: string | null;
}

export async function probeLightRagServer(payload: {
  serverUrl: string;
  apiKey?: string;
}): Promise<LightRagServerProbe> {
  const res = await apiFetch(
    apiUrl("/api/v1/knowledge/probe-lightrag-server"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        server_url: payload.serverUrl,
        api_key: payload.apiKey ?? "",
      }),
    },
  );
  if (!res.ok) {
    throw new Error(
      await readErrorDetail(res, "Failed to reach LightRAG server"),
    );
  }
  return (await res.json()) as LightRagServerProbe;
}

export async function connectLightRagServer(payload: {
  name: string;
  serverUrl: string;
  apiKey?: string;
  mode?: string;
}): Promise<{
  status: string;
  name: string;
  server_url: string;
  rag_provider: string;
}> {
  const res = await apiFetch(
    apiUrl("/api/v1/knowledge/connect-lightrag-server"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: payload.name,
        server_url: payload.serverUrl,
        api_key: payload.apiKey ?? "",
        search_mode: payload.mode ?? "",
      }),
    },
  );
  if (!res.ok) {
    throw new Error(
      await readErrorDetail(res, "Failed to connect LightRAG server"),
    );
  }
  invalidateKnowledgeCaches();
  return (await res.json()) as {
    status: string;
    name: string;
    server_url: string;
    rag_provider: string;
  };
}

export interface ImaProbe {
  knowledge_base_id: string;
  ok: boolean;
  credentials_ok: boolean;
  knowledge_base_name: string | null;
  description: string | null;
  error: string | null;
}

export async function probeIma(payload: {
  clientId: string;
  apiKey: string;
  knowledgeBaseId: string;
}): Promise<ImaProbe> {
  const res = await apiFetch(apiUrl("/api/v1/knowledge/probe-ima"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: payload.clientId,
      api_key: payload.apiKey,
      knowledge_base_id: payload.knowledgeBaseId,
    }),
  });
  if (!res.ok) {
    throw new Error(await readErrorDetail(res, "Failed to reach Tencent IMA"));
  }
  return (await res.json()) as ImaProbe;
}

export async function connectIma(payload: {
  name: string;
  clientId: string;
  apiKey: string;
  knowledgeBaseId: string;
}): Promise<{ status: string; name: string; knowledge_base_id: string; rag_provider: string }> {
  const res = await apiFetch(apiUrl("/api/v1/knowledge/connect-ima"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: payload.name,
      client_id: payload.clientId,
      api_key: payload.apiKey,
      knowledge_base_id: payload.knowledgeBaseId,
    }),
  });
  if (!res.ok) {
    throw new Error(await readErrorDetail(res, "Failed to connect Tencent IMA"));
  }
  invalidateKnowledgeCaches();
  return (await res.json()) as { status: string; name: string; knowledge_base_id: string; rag_provider: string };
}

export async function uploadKnowledgeBaseFiles(
  name: string,
  files: File[],
  options?: { provider?: string; duplicateStrategy?: DuplicateUploadStrategy },
): Promise<KnowledgeTaskResponse> {
  const useResumable =
    files.some((file) => file.size > 8 * 1024 * 1024) &&
    files.every((file) => !file.name.toLowerCase().endsWith(".zip"));
  if (useResumable) {
    return uploadKnowledgeBaseFilesResumable(name, files, options?.duplicateStrategy || "error");
  }
  const form = new FormData();
  appendFilesWithPaths(form, files);
  if (options?.provider) form.append("rag_provider", options.provider);
  form.append("duplicate_strategy", options?.duplicateStrategy || "error");

  const res = await apiFetch(
    apiUrl(`/api/v1/knowledge/${encodeURIComponent(name)}/upload`),
    { method: "POST", body: form },
  );
  if (!res.ok) {
    throw new Error(await readErrorDetail(res, "Failed to upload files"));
  }
  invalidateKnowledgeCaches();
  return (await res.json()) as KnowledgeTaskResponse;
}

interface ResumableUploadState {
  session_id: string;
  offset: number;
  size_bytes: number;
  relative_path: string;
}

function resumableStorageKey(name: string, file: File): string {
  return `cognivoy:kb-upload:${name}:${file.webkitRelativePath || file.name}:${file.size}:${file.lastModified}`;
}

async function readResumableState(
  name: string,
  file: File,
): Promise<ResumableUploadState | null> {
  const key = resumableStorageKey(name, file);
  const saved = typeof window !== "undefined" ? window.localStorage.getItem(key) : null;
  if (!saved) return null;
  try {
    const local = JSON.parse(saved) as ResumableUploadState;
    const res = await apiFetch(
      apiUrl(`/api/v1/knowledge/${encodeURIComponent(name)}/uploads/resumable/${encodeURIComponent(local.session_id)}`),
      { cache: "no-store" },
    );
    if (!res.ok) {
      window.localStorage.removeItem(key);
      return null;
    }
    return (await res.json()) as ResumableUploadState;
  } catch {
    window.localStorage.removeItem(key);
    return null;
  }
}

async function uploadKnowledgeBaseFilesResumable(
  name: string,
  files: File[],
  duplicateStrategy: DuplicateUploadStrategy,
): Promise<KnowledgeTaskResponse> {
  const completedPaths: string[] = [];
  for (const file of files) {
    const key = resumableStorageKey(name, file);
    let state = await readResumableState(name, file);
    if (!state) {
      const create = await apiFetch(
        apiUrl(`/api/v1/knowledge/${encodeURIComponent(name)}/uploads/resumable`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: file.name,
            relative_path: file.webkitRelativePath || "",
            size_bytes: file.size,
            sha256: await sha256File(file),
          }),
        },
      );
      if (!create.ok) throw new Error(await readErrorDetail(create, "Failed to start resumable upload"));
      state = (await create.json()) as ResumableUploadState;
      window.localStorage.setItem(key, JSON.stringify(state));
    }

    let offset = Number(state.offset || 0);
    const chunkBytes = 4 * 1024 * 1024;
    while (offset < file.size) {
      const form = new FormData();
      form.append("offset", String(offset));
      form.append("chunk", file.slice(offset, Math.min(file.size, offset + chunkBytes)), file.name);
      const chunk = await apiFetch(
        apiUrl(`/api/v1/knowledge/${encodeURIComponent(name)}/uploads/resumable/${encodeURIComponent(state.session_id)}`),
        { method: "PUT", body: form },
      );
      if (!chunk.ok) throw new Error(await readErrorDetail(chunk, "Resumable upload was interrupted"));
      const progress = (await chunk.json()) as { offset: number };
      offset = progress.offset;
      window.localStorage.setItem(key, JSON.stringify({ ...state, offset }));
    }
    const complete = await apiFetch(
      apiUrl(`/api/v1/knowledge/${encodeURIComponent(name)}/uploads/resumable/${encodeURIComponent(state.session_id)}/complete`),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ duplicate_strategy: duplicateStrategy }),
      },
    );
    if (!complete.ok) throw new Error(await readErrorDetail(complete, "Failed to finalize upload"));
    const result = (await complete.json()) as { path: string; skipped: boolean };
    window.localStorage.removeItem(key);
    if (!result.skipped) completedPaths.push(result.path);
  }
  const process = await apiFetch(
    apiUrl(`/api/v1/knowledge/${encodeURIComponent(name)}/uploads/resumable/process`),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: completedPaths }),
    },
  );
  if (!process.ok) throw new Error(await readErrorDetail(process, "Failed to start indexing"));
  invalidateKnowledgeCaches();
  return (await process.json()) as KnowledgeTaskResponse;
}

async function sha256File(file: File): Promise<string | undefined> {
  // Exact duplicate detection is intentionally bounded: very large files use
  // the path/size preflight and are transferred through the resumable path.
  if (!globalThis.crypto?.subtle || file.size > 16 * 1024 * 1024) return undefined;
  const digest = await globalThis.crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function preflightKnowledgeUpload(
  name: string,
  files: File[],
): Promise<UploadPreflightResult> {
  const metadata = await Promise.all(
    files.map(async (file) => ({
      name: file.name,
      relative_path: file.webkitRelativePath || "",
      size_bytes: file.size,
      sha256: await sha256File(file),
    })),
  );
  const res = await apiFetch(
    apiUrl(`/api/v1/knowledge/${encodeURIComponent(name)}/upload-preflight`),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files: metadata }),
    },
  );
  if (!res.ok) {
    throw new Error(await readErrorDetail(res, "Failed to inspect duplicate files"));
  }
  return (await res.json()) as UploadPreflightResult;
}

export async function inspectKnowledgeIndexFragments(
  name: string,
  query: string,
  topK = 8,
): Promise<IndexFragmentsReport> {
  const res = await apiFetch(
    apiUrl(`/api/v1/knowledge/${encodeURIComponent(name)}/index-fragments`),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, top_k: topK }),
    },
  );
  if (!res.ok) {
    throw new Error(await readErrorDetail(res, "Failed to inspect index fragments"));
  }
  return (await res.json()) as IndexFragmentsReport;
}

export async function createKbFolder(
  name: string,
  path: string,
): Promise<void> {
  const res = await apiFetch(
    apiUrl(`/api/v1/knowledge/${encodeURIComponent(name)}/folders`),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    },
  );
  if (!res.ok) {
    throw new Error(await readErrorDetail(res, "Failed to create folder"));
  }
  invalidateKnowledgeCaches();
}

export async function moveKbFile(
  name: string,
  source: string,
  destFolder: string,
): Promise<void> {
  const res = await apiFetch(
    apiUrl(`/api/v1/knowledge/${encodeURIComponent(name)}/files/move`),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source, dest_folder: destFolder }),
    },
  );
  if (!res.ok) {
    throw new Error(await readErrorDetail(res, "Failed to move file"));
  }
  invalidateKnowledgeCaches();
}

/**
 * Delete a single raw document from a KB. Works even while the KB is in an
 * error state, so an unparseable file can be dropped without rebuilding the
 * whole base. `was_indexed` signals whether a re-index is needed to purge the
 * file's vectors from retrieval.
 */
export async function deleteKbFile(
  name: string,
  filename: string,
): Promise<{ was_indexed: boolean }> {
  const res = await apiFetch(apiUrl(knowledgeBaseFilePath(name, filename)), {
    method: "DELETE",
  });
  if (!res.ok) {
    throw new Error(await readErrorDetail(res, "Failed to delete file"));
  }
  invalidateKnowledgeCaches();
  return (await res.json()) as { was_indexed: boolean };
}

export async function setDefaultKnowledgeBase(name: string): Promise<void> {
  const res = await apiFetch(
    apiUrl(`/api/v1/knowledge/default/${encodeURIComponent(name)}`),
    { method: "PUT" },
  );
  if (!res.ok) {
    throw new Error(await readErrorDetail(res, "Failed to set default"));
  }
  invalidateKnowledgeCaches();
}

export async function reindexKnowledgeBase(
  name: string,
): Promise<KnowledgeTaskResponse> {
  const res = await apiFetch(
    apiUrl(`/api/v1/knowledge/${encodeURIComponent(name)}/reindex`),
    { method: "POST" },
  );
  if (!res.ok) {
    const detail = await readErrorDetail(
      res,
      `Re-index failed (${res.status})`,
    );
    throw new Error(
      withDockerUpgradeHint(detail, res.status, "Knowledge re-index"),
    );
  }
  invalidateKnowledgeCaches();
  return (await res.json()) as KnowledgeTaskResponse;
}

export async function retryKnowledgeBase(
  name: string,
): Promise<KnowledgeTaskResponse> {
  const res = await apiFetch(
    apiUrl(`/api/v1/knowledge/${encodeURIComponent(name)}/retry`),
    { method: "POST" },
  );
  if (!res.ok) {
    const detail = await readErrorDetail(res, `Retry failed (${res.status})`);
    throw new Error(
      withDockerUpgradeHint(detail, res.status, "Knowledge retry"),
    );
  }
  invalidateKnowledgeCaches();
  return (await res.json()) as KnowledgeTaskResponse;
}

export async function cancelKnowledgeTask(
  name: string,
  taskId: string,
): Promise<{ task_id: string; status: "cancelled"; already_cancelled: boolean }> {
  const res = await apiFetch(
    apiUrl(
      `/api/v1/knowledge/${encodeURIComponent(name)}/tasks/${encodeURIComponent(taskId)}/cancel`,
    ),
    { method: "POST" },
  );
  if (!res.ok) {
    throw new Error(await readErrorDetail(res, `Cancel failed (${res.status})`));
  }
  invalidateKnowledgeCaches();
  return (await res.json()) as {
    task_id: string;
    status: "cancelled";
    already_cancelled: boolean;
  };
}

export async function cancelKnowledgeTasksBatch(
  name: string,
  taskIds: string[],
): Promise<{
  knowledge_base: string;
  cancelled: number;
  failed: number;
  results: Array<Record<string, unknown>>;
}> {
  const res = await apiFetch(
    apiUrl(`/api/v1/knowledge/${encodeURIComponent(name)}/tasks/cancel-batch`),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task_ids: taskIds }),
    },
  );
  if (!res.ok) {
    throw new Error(await readErrorDetail(res, `Batch cancel failed (${res.status})`));
  }
  invalidateKnowledgeCaches();
  return (await res.json()) as {
    knowledge_base: string;
    cancelled: number;
    failed: number;
    results: Array<Record<string, unknown>>;
  };
}

export async function getKnowledgeDeletionImpact(
  name: string,
): Promise<KnowledgeDeletionImpact> {
  const res = await apiFetch(
    apiUrl(`/api/v1/knowledge/${encodeURIComponent(name)}/deletion-impact`),
    { cache: "no-store" },
  );
  if (!res.ok) {
    throw new Error(
      await readErrorDetail(res, `Impact analysis failed (${res.status})`),
    );
  }
  return (await res.json()) as KnowledgeDeletionImpact;
}

export async function listDeletedKnowledgeReferences(): Promise<
  DeletedKnowledgeReference[]
> {
  const res = await apiFetch(apiUrl("/api/v1/knowledge/references/deleted"), {
    cache: "no-store",
  });
  if (!res.ok) return [];
  const payload = (await res.json()) as {
    knowledge_bases?: DeletedKnowledgeReference[];
  } | DeletedKnowledgeReference[];
  return Array.isArray(payload)
    ? payload
    : Array.isArray(payload.knowledge_bases)
      ? payload.knowledge_bases
      : [];
}

export async function deleteKnowledgeBase(
  name: string,
  confirmationToken: string,
): Promise<void> {
  const res = await apiFetch(
    apiUrl(
      `/api/v1/knowledge/${encodeURIComponent(name)}?confirmation_token=${encodeURIComponent(confirmationToken)}`,
    ),
    { method: "DELETE" },
  );
  if (!res.ok) {
    throw new Error(
      await readErrorDetail(res, `Delete failed (${res.status})`),
    );
  }
  invalidateKnowledgeCaches();
}
