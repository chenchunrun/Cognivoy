import { apiFetch, apiUrl } from "@/lib/api";

export interface CapabilityAvailability {
  name: string;
  available: boolean;
  install_hint?: string;
}

export interface CapabilityCatalogItem {
  name: string;
  description: string;
  stages?: string[];
  tools_used?: string[];
  availability?: CapabilityAvailability;
}

export async function listCapabilityCatalog(): Promise<CapabilityCatalogItem[]> {
  const response = await apiFetch(apiUrl("/api/v1/plugins/list"), {
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = (await response.json()) as {
    capabilities?: CapabilityCatalogItem[];
  };
  return payload.capabilities ?? [];
}
