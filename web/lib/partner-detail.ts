export const PARTNER_DETAIL_TABS = [
  { id: "overview", label: "Overview" },
  { id: "chat", label: "Chat" },
  { id: "soul", label: "Soul" },
  { id: "resources", label: "Resources" },
  { id: "channels", label: "Channels" },
  { id: "sessions", label: "Sessions" },
  { id: "proactive", label: "Proactive" },
  { id: "activity", label: "Activity" },
] as const;

export type PartnerDetailTab = (typeof PARTNER_DETAIL_TABS)[number]["id"];
export type PartnerAssetCollection =
  | "knowledge_bases"
  | "skills"
  | "notebooks";

export function partnerAssetDeleteType(
  collection: PartnerAssetCollection,
): "knowledge_base" | "skill" | "notebook" {
  if (collection === "knowledge_bases") return "knowledge_base";
  return collection === "skills" ? "skill" : "notebook";
}
