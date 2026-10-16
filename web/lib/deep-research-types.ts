import type { StreamEvent } from "@/lib/unified-ws";
import type { OutlineItem } from "@/lib/research-types";

export interface ResearchOutlineResult {
  topic: string;
  subTopics: OutlineItem[];
  config: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function extractResearchOutlineResult(
  event: StreamEvent | undefined,
): ResearchOutlineResult | null {
  if (event?.type !== "result" || !isRecord(event.metadata)) return null;
  if (event.metadata.outline_preview !== true) return null;
  const rawTopics = Array.isArray(event.metadata.sub_topics)
    ? event.metadata.sub_topics
    : [];
  const subTopics = rawTopics.flatMap((item) => {
    if (!isRecord(item)) return [];
    const title = typeof item.title === "string" ? item.title.trim() : "";
    if (!title) return [];
    return [
      {
        title,
        overview:
          typeof item.overview === "string" ? item.overview.trim() : "",
      },
    ];
  });
  if (!subTopics.length) return null;
  return {
    topic: typeof event.metadata.topic === "string" ? event.metadata.topic : "",
    subTopics,
    config: isRecord(event.metadata.research_config)
      ? event.metadata.research_config
      : {},
  };
}
