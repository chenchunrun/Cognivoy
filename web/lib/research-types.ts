export type ResearchMode =
  | ""
  | "notes"
  | "report"
  | "comparison"
  | "learning_path";
export type ResearchDepth = "" | "quick" | "standard" | "deep" | "manual";
export type ResearchSourceType = "knowledge_base" | "web" | "papers";
export type ResearchReportFormat =
  | "markdown"
  | "executive_summary"
  | "literature_review"
  | "comparison";

export interface OutlineItem {
  title: string;
  overview: string;
}

export interface DeepResearchFormConfig {
  mode: ResearchMode;
  depth: ResearchDepth;
  manual_subtopics?: number;
  manual_max_iterations?: number;
  confirmed_outline?: OutlineItem[];
  checkpoint_id?: string;
  source_types?: ResearchSourceType[];
  date_from?: string;
  date_to?: string;
  report_format?: ResearchReportFormat;
  max_sources?: number;
  audience?: string;
  region?: string;
}

export interface ResearchConfigValidationResult {
  valid: boolean;
  errors: Record<string, string>;
}

export function createEmptyResearchConfig(): DeepResearchFormConfig {
  return {
    mode: "",
    depth: "",
    source_types: ["web", "papers"],
    report_format: "markdown",
    max_sources: 20,
  };
}

export function normalizeResearchConfig(
  raw: Record<string, unknown> | undefined,
): DeepResearchFormConfig {
  const empty = createEmptyResearchConfig();
  return {
    mode:
      raw?.mode === "notes" ||
      raw?.mode === "report" ||
      raw?.mode === "comparison" ||
      raw?.mode === "learning_path"
        ? raw.mode
        : empty.mode,
    depth:
      raw?.depth === "quick" ||
      raw?.depth === "standard" ||
      raw?.depth === "deep" ||
      raw?.depth === "manual"
        ? raw.depth
        : empty.depth,
    source_types: Array.isArray(raw?.source_types)
      ? raw.source_types.filter(
          (item): item is ResearchSourceType =>
            item === "knowledge_base" || item === "web" || item === "papers",
        )
      : empty.source_types,
    date_from: typeof raw?.date_from === "string" ? raw.date_from : undefined,
    date_to: typeof raw?.date_to === "string" ? raw.date_to : undefined,
    report_format:
      raw?.report_format === "executive_summary" ||
      raw?.report_format === "literature_review" ||
      raw?.report_format === "comparison" ||
      raw?.report_format === "markdown"
        ? raw.report_format
        : empty.report_format,
    max_sources:
      typeof raw?.max_sources === "number" ? raw.max_sources : empty.max_sources,
    checkpoint_id:
      typeof raw?.checkpoint_id === "string" ? raw.checkpoint_id : undefined,
  };
}

export function validateResearchConfig(
  cfg: DeepResearchFormConfig,
): ResearchConfigValidationResult {
  const errors: Record<string, string> = {};

  if (!cfg.mode) {
    errors.mode = "Required";
  }
  if (!cfg.depth) {
    errors.depth = "Required";
  }
  if (cfg.source_types && cfg.source_types.length === 0) {
    errors.source_types = "Select at least one source";
  }
  if (cfg.date_from && cfg.date_to && cfg.date_from > cfg.date_to) {
    errors.date_range = "Start date must not be after end date";
  }
  if ((cfg.max_sources ?? 20) < 1 || (cfg.max_sources ?? 20) > 100) {
    errors.max_sources = "Use a value from 1 to 100";
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

export function buildResearchWSConfig(
  cfg: DeepResearchFormConfig,
  confirmedOutline?: OutlineItem[],
): Record<string, unknown> {
  const validation = validateResearchConfig(cfg);
  if (!validation.valid) {
    throw new Error("Deep research settings are incomplete.");
  }

  const result: Record<string, unknown> = {
    mode: cfg.mode,
    depth: cfg.depth,
  };

  if (cfg.depth === "manual") {
    if (cfg.manual_subtopics != null)
      result.manual_subtopics = cfg.manual_subtopics;
    if (cfg.manual_max_iterations != null)
      result.manual_max_iterations = cfg.manual_max_iterations;
  }

  if (cfg.source_types) result.source_types = cfg.source_types;
  if (cfg.date_from) result.date_from = cfg.date_from;
  if (cfg.date_to) result.date_to = cfg.date_to;
  result.report_format = cfg.report_format ?? "markdown";
  result.max_sources = cfg.max_sources ?? 20;
  if (cfg.audience?.trim()) result.audience = cfg.audience.trim();
  if (cfg.region?.trim()) result.region = cfg.region.trim();
  if (cfg.checkpoint_id) result.checkpoint_id = cfg.checkpoint_id;

  const outline = confirmedOutline ?? cfg.confirmed_outline;
  if (outline && outline.length > 0) {
    result.confirmed_outline = outline;
  }

  return result;
}

export function createResearchCheckpointId(): string {
  const random = globalThis.crypto?.randomUUID?.().replaceAll("-", "");
  return `research_${random ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
}

const RESEARCH_MODE_LABELS: Record<string, string> = {
  notes: "Study Notes",
  report: "Report",
  comparison: "Comparison",
  learning_path: "Learning Path",
};

const RESEARCH_DEPTH_LABELS: Record<string, string> = {
  quick: "Quick",
  standard: "Standard",
  deep: "Deep",
  manual: "Manual",
};

export function summarizeResearchConfig(
  cfg: DeepResearchFormConfig,
  translate?: (key: string) => string,
): string {
  const validation = validateResearchConfig(cfg);
  const tr = translate ?? ((s: string) => s);
  if (!validation.valid) return tr("Incomplete settings");
  const modeLabel =
    RESEARCH_MODE_LABELS[cfg.mode] ?? cfg.mode.replace("_", " ");
  const depthLabel = RESEARCH_DEPTH_LABELS[cfg.depth] ?? cfg.depth;
  return [tr(modeLabel), tr(depthLabel)].join(" · ");
}
