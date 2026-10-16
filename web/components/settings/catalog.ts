// Model-catalog types shared by the service settings editors.
// Shapes mirror cognivoy/services/config (the /api/v1/settings payload).

export type ServiceName =
  | "llm"
  | "embedding"
  | "search"
  | "tts"
  | "stt"
  | "imagegen"
  | "videogen";

export interface CatalogModel {
  id: string;
  name: string;
  model: string;
  dimension?: string;
  send_dimensions?: boolean;
  context_window?: string;
  voice?: string;
  response_format?: string;
  language?: string;
  size?: string;
  quality?: string;
  style?: string;
  aspect_ratio?: string;
  duration?: string;
  resolution?: string;
}

export interface CatalogProfile {
  id: string;
  name: string;
  binding?: string;
  provider?: string;
  base_url: string;
  api_key: string;
  api_version: string;
  proxy?: string;
  max_results?: number;
  models: CatalogModel[];
}

export interface CatalogService {
  active_profile_id: string | null;
  active_model_id?: string | null;
  profiles: CatalogProfile[];
}

export interface Catalog {
  version: number;
  services: Record<ServiceName, CatalogService>;
}

export interface ProviderOption {
  value: string;
  label: string;
  base_url?: string;
  default_dim?: string;
  default_model?: string;
  default_voice?: string;
  auth_mode?: "api_key" | "oauth";
}

export const SERVICE_NAMES: ServiceName[] = [
  "llm",
  "embedding",
  "search",
  "tts",
  "stt",
  "imagegen",
  "videogen",
];

export function defaultCatalog(): Catalog {
  const empty = (): CatalogService => ({
    active_profile_id: null,
    active_model_id: null,
    profiles: [],
  });
  return {
    version: 1,
    services: {
      llm: empty(),
      embedding: empty(),
      search: { active_profile_id: null, profiles: [] },
      tts: empty(),
      stt: empty(),
      imagegen: empty(),
      videogen: empty(),
    },
  };
}

export function cloneCatalog(catalog: Catalog): Catalog {
  return JSON.parse(JSON.stringify(catalog)) as Catalog;
}

/** TTS/STT share the catalog shape but configure audio providers. */
export function isVoiceService(service: ServiceName): boolean {
  return service === "tts" || service === "stt";
}

/** imagegen/videogen share the catalog shape but configure media generation. */
export function isGenerationService(service: ServiceName): boolean {
  return service === "imagegen" || service === "videogen";
}

export function getActiveProfile(
  catalog: Catalog,
  service: ServiceName,
): CatalogProfile | null {
  const slice = catalog.services[service];
  return (
    slice.profiles.find((p) => p.id === slice.active_profile_id) ??
    slice.profiles[0] ??
    null
  );
}

export function getActiveModel(
  catalog: Catalog,
  service: ServiceName,
): CatalogModel | null {
  if (service === "search") return null;
  const slice = catalog.services[service];
  const profile = getActiveProfile(catalog, service);
  if (!profile) return null;
  return (
    profile.models.find((m) => m.id === slice.active_model_id) ??
    profile.models[0] ??
    null
  );
}
