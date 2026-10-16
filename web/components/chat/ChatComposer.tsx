"use client";

/**
 * The chat composer: auto-growing textarea with attachment chips, and a
 * toolbar row for capability / model / knowledge base / persona / tool
 * selection. Sends through the unified chat context; while a turn is live
 * the send button becomes a stop button. Voice input posts the clip to
 * /api/v1/voice/stt and inserts the transcript.
 */

import * as React from "react";
import { useSearchParams } from "next/navigation";
import {
  ArrowUp,
  Check,
  Cpu,
  Database,
  Gauge,
  Lock,
  Mic,
  Paperclip,
  SlidersHorizontal,
  Sparkles,
  Square,
  User,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { useUnifiedChat } from "@/context/UnifiedChatContext";
import { apiFetch, apiUrl } from "@/lib/api";
import { useAttachmentLimits } from "@/lib/attachment-limits";
import {
  ATTACHMENT_ACCEPT,
  classifyFile,
  docIconFor,
  formatBytes,
  isSvgFilename,
} from "@/lib/doc-attachments";
import {
  extractBase64FromDataUrl,
  readFileAsDataUrl,
} from "@/lib/file-attachments";
import {
  listLLMOptions,
  sameLLMSelection,
  type LLMOption,
} from "@/lib/llm-options";
import {
  listKnowledgeBases,
  type KnowledgeBaseSummary,
} from "@/lib/knowledge-api";
import { listPersonas, type PersonaInfo } from "@/lib/personas-api";
import {
  getEnabledOptionalTools,
  invalidateEnabledOptionalToolsCache,
} from "@/lib/tools-settings";
import { notify } from "@/lib/notifications";
import {
  buildResearchWSConfig,
  type DeepResearchFormConfig,
  type ResearchDepth,
  type ResearchMode,
  type ResearchReportFormat,
  type ResearchSourceType,
} from "@/lib/research-types";
import {
  buildMathAnimatorWSConfig,
  buildVisualizeWSConfig,
  DEFAULT_VISUALIZE_CONFIG,
  type VisualizeFormConfig,
} from "@/lib/visualize-types";
import {
  buildQuizWSConfig,
  DEFAULT_QUIZ_CONFIG,
  QUIZ_TYPE_LABEL_KEYS,
  type DeepQuestionFormConfig,
} from "@/lib/quiz-types";
import {
  QUIZ_QUESTION_TYPES,
  type NormalizedQuizQuestionType,
} from "@/lib/quiz-question-type";
import { useImeComposing } from "@/lib/use-ime-composing";
import type { LLMSelection } from "@/lib/unified-ws";
import { useVoiceRecorder } from "@/hooks/useVoiceRecorder";
import { ChatReferencePicker } from "@/components/chat/ChatReferencePicker";
import {
  buildChatReferencePayload,
  countChatReferences,
  type ChatReferenceSelection,
} from "@/lib/chat-reference-selection";
import {
  listCapabilityCatalog,
  type CapabilityAvailability,
} from "@/lib/capability-catalog";
import { Badge, Dropdown, Textarea, Toggle } from "@/components/ui";
import { estimateComposerContext } from "@/lib/context-budget";
import { cn } from "@/lib/utils";
import { capabilityTimeRange, previewLearningCapability } from "@/lib/learning-intent-router";

/* ------------------------------------------------------------------ */
/*  Static option definitions                                          */
/* ------------------------------------------------------------------ */

interface CapabilityDef {
  value: string;
  labelKey: string;
  descKey: string;
}

const CAPABILITIES: CapabilityDef[] = [
  {
    value: "auto",
    labelKey: "Auto learning mode",
    descKey: "Automatically choose the best way to help",
  },
  {
    value: "",
    labelKey: "Chat",
    descKey: "Flexible conversation with tools",
  },
  {
    value: "mastery_path",
    labelKey: "Learning plan",
    descKey: "Guided tutoring that checks understanding as you go",
  },
  {
    value: "deep_solve",
    labelKey: "Deep Solve",
    descKey: "Multi-step reasoning for hard problems",
  },
  {
    value: "deep_question",
    labelKey: "Practice Questions",
    descKey: "Generate auto-validated practice questions",
  },
  {
    value: "deep_research",
    labelKey: "Deep Research",
    descKey: "Multi-agent research with a cited report",
  },
  {
    value: "visualize",
    labelKey: "Visualize",
    descKey: "Charts, diagrams, and interactive visuals",
  },
  {
    value: "math_animator",
    labelKey: "Math Animator",
    descKey: "Animated math explainer videos",
  },
];

interface ToggleableToolDef {
  name: string;
  labelKey: string;
  descKey: string;
}

const TOGGLEABLE_TOOLS: ToggleableToolDef[] = [
  {
    name: "brainstorm",
    labelKey: "Brainstorm",
    descKey: "Breadth-first idea exploration",
  },
  {
    name: "web_search",
    labelKey: "Web Search",
    descKey: "Search the web with citations",
  },
  {
    name: "paper_search",
    labelKey: "Paper Search",
    descKey: "Search arXiv preprints",
  },
  {
    name: "reason",
    labelKey: "Deep Reason",
    descKey: "A dedicated deep-reasoning pass",
  },
];

/** Which of the toggleable tools each capability may use (mirrors the
 *  previous frontend's capability allow-lists, restricted to the four
 *  user-toggleable tools). */
const TOOL_ALLOWLIST: Record<string, string[]> = {
  "": ["brainstorm", "web_search", "paper_search", "reason"],
  chat: ["brainstorm", "web_search", "paper_search", "reason"],
  mastery_path: ["web_search"],
  deep_solve: ["web_search", "reason"],
  deep_question: ["web_search"],
  deep_research: ["web_search", "paper_search"],
  visualize: [],
  math_animator: [],
};

function emptyReferenceSelection(): ChatReferenceSelection {
  return {
    historySessionIds: [],
    notebooks: [],
    questionEntryIds: [],
    books: [],
    memoryScopes: [],
  };
}

const RESEARCH_MODES: Array<{ value: ResearchMode; labelKey: string }> = [
  { value: "notes", labelKey: "Study Notes" },
  { value: "report", labelKey: "Report" },
  { value: "comparison", labelKey: "Comparison" },
  { value: "learning_path", labelKey: "Learning Path" },
];

const RESEARCH_DEPTHS: Array<{ value: ResearchDepth; labelKey: string }> = [
  { value: "quick", labelKey: "Quick" },
  { value: "standard", labelKey: "Standard" },
  { value: "deep", labelKey: "Deep" },
  { value: "manual", labelKey: "Manual" },
];

const RESEARCH_SOURCES: Array<{
  value: ResearchSourceType;
  labelKey: string;
}> = [
  { value: "knowledge_base", labelKey: "Knowledge Base" },
  { value: "web", labelKey: "Web" },
  { value: "papers", labelKey: "Papers" },
];

const RESEARCH_FORMATS: Array<{
  value: ResearchReportFormat;
  labelKey: string;
}> = [
  { value: "markdown", labelKey: "Markdown" },
  { value: "executive_summary", labelKey: "Executive Summary" },
  { value: "literature_review", labelKey: "Literature Review" },
  { value: "comparison", labelKey: "Comparison" },
];

function capabilityLabel(capability: string | null): string {
  return (
    CAPABILITIES.find((c) => c.value === (capability || ""))?.labelKey ??
    capability ??
    "Chat"
  );
}

interface PendingAttachment {
  type: string;
  filename: string;
  base64?: string;
  size?: number;
  mimeType?: string;
}

function knowledgeBaseRuntimeStatus(kb: KnowledgeBaseSummary): string {
  const statisticsStatus = kb.statistics?.status;
  const status = kb.status ?? statisticsStatus;
  return typeof status === "string" ? status.trim().toLowerCase() : "";
}

function knowledgeBaseReady(kb: KnowledgeBaseSummary): boolean {
  const status = knowledgeBaseRuntimeStatus(kb);
  return kb.available !== false && (!status || status === "ready");
}

function knowledgeBaseFailureDetail(kb: KnowledgeBaseSummary): string | null {
  const progressError = kb.progress?.error;
  if (typeof progressError === "string" && progressError.trim()) {
    return progressError.trim();
  }
  const lastError = kb.metadata?.last_error;
  return typeof lastError === "string" && lastError.trim()
    ? lastError.trim()
    : null;
}

/* ------------------------------------------------------------------ */
/*  Dropdown building blocks                                           */
/* ------------------------------------------------------------------ */

function ToolbarIconButton({
  icon: Icon,
  label,
  active,
  onClick,
  className,
  ...buttonProps
}: {
  icon: LucideIcon;
  label: string;
  active?: boolean;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children">) {
  return (
    <button
      {...buttonProps}
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={cn(
        "flex h-8 w-8 items-center justify-center rounded-lg transition-colors duration-150",
        active
          ? "bg-primary-muted text-accent-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
        className,
      )}
    >
      <Icon size={15} />
    </button>
  );
}

function MenuRow({
  title,
  description,
  checked,
  onClick,
  disabled,
  unavailableHint,
}: {
  title: string;
  description?: string;
  checked?: boolean;
  onClick: () => void;
  disabled?: boolean;
  unavailableHint?: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      title={unavailableHint}
      className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors duration-150 hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span className="flex-1">
        <span className="block text-sm text-foreground">{title}</span>
        {description && (
          <span className="block text-xs text-muted-foreground">
            {description}
          </span>
        )}
      </span>
      {disabled ? (
        <Lock size={13} className="mt-0.5 shrink-0 text-muted-foreground" />
      ) : checked ? (
        <Check size={14} className="mt-0.5 shrink-0 text-primary" />
      ) : null}
    </button>
  );
}

function RenderAdvancedControls({
  config,
  onChange,
  motion = false,
}: {
  config: VisualizeFormConfig;
  onChange: (next: Partial<VisualizeFormConfig>) => void;
  motion?: boolean;
}) {
  const { t } = useTranslation();
  const [parameterText, setParameterText] = React.useState(() =>
    JSON.stringify(config.parameters),
  );
  const [parameterError, setParameterError] = React.useState(false);
  const resolution =
    config.width != null && config.height != null
      ? `${config.width}x${config.height}`
      : "auto";

  return (
    <>
      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span>{t("Ratio")}</span>
        <select
          aria-label={t("Ratio")}
          value={config.aspect_ratio}
          onChange={(event) =>
            onChange({
              aspect_ratio: event.target
                .value as VisualizeFormConfig["aspect_ratio"],
            })
          }
          className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring"
        >
          {(["auto", "16:9", "4:3", "1:1", "9:16"] as const).map(
            (ratio) => (
              <option key={ratio} value={ratio}>
                {ratio === "auto" ? t("Auto") : ratio}
              </option>
            ),
          )}
        </select>
      </label>
      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span>{t("Theme")}</span>
        <select
          aria-label={t("Theme")}
          value={config.theme}
          onChange={(event) =>
            onChange({ theme: event.target.value as VisualizeFormConfig["theme"] })
          }
          className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="auto">{t("Auto")}</option>
          <option value="light">{t("Light")}</option>
          <option value="dark">{t("Dark")}</option>
        </select>
      </label>
      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span>{t("Resolution")}</span>
        <select
          aria-label={t("Resolution")}
          value={resolution}
          onChange={(event) => {
            if (event.target.value === "auto") {
              onChange({ width: undefined, height: undefined });
              return;
            }
            const [width, height] = event.target.value.split("x").map(Number);
            onChange({ width, height });
          }}
          className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="auto">{t("Auto")}</option>
          <option value="1280x720">1280×720</option>
          <option value="1920x1080">1920×1080</option>
          <option value="1080x1080">1080×1080</option>
          <option value="1080x1920">1080×1920</option>
        </select>
      </label>
      {motion && (
        <>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span>{t("Duration (s)")}</span>
            <input
              type="number"
              min={1}
              max={600}
              value={config.duration_seconds ?? ""}
              placeholder={t("Auto")}
              onChange={(event) =>
                onChange({
                  duration_seconds: event.target.value
                    ? Number(event.target.value)
                    : undefined,
                })
              }
              className="w-20 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring"
            />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span>{t("FPS")}</span>
            <input
              type="number"
              min={1}
              max={120}
              value={config.fps}
              onChange={(event) => onChange({ fps: Number(event.target.value) })}
              className="w-16 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring"
            />
          </label>
        </>
      )}
      <label className="flex min-w-44 flex-1 items-center gap-1.5 text-xs text-muted-foreground">
        <span>{t("Parameters")}</span>
        <input
          value={parameterText}
          aria-label={t("Parameters")}
          aria-invalid={parameterError}
          onChange={(event) => {
            const nextText = event.target.value;
            setParameterText(nextText);
            try {
              const parsed = JSON.parse(nextText || "{}");
              if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
                throw new Error("Parameters must be an object");
              }
              if (
                Object.values(parsed).some(
                  (value) =>
                    value !== null &&
                    typeof value !== "string" &&
                    typeof value !== "number" &&
                    typeof value !== "boolean",
                )
              ) {
                throw new Error("Parameter values must be scalar");
              }
              setParameterError(false);
              onChange({ parameters: parsed });
            } catch {
              setParameterError(true);
            }
          }}
          title={
            parameterError
              ? t("Enter a JSON object with scalar values")
              : undefined
          }
          className={cn(
            "min-w-32 flex-1 rounded-md border bg-background px-2 py-1 font-mono text-xs text-foreground outline-none focus:ring-2 focus:ring-ring",
            parameterError ? "border-destructive" : "border-border",
          )}
        />
      </label>
      <button
        type="button"
        aria-pressed={config.show_code}
        onClick={() => onChange({ show_code: !config.show_code })}
        className={cn(
          "rounded-full border px-2 py-1 text-[11px] transition-colors",
          config.show_code
            ? "border-primary bg-primary-muted text-foreground"
            : "border-border text-muted-foreground",
        )}
      >
        {t("Show Code")}
      </button>
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Composer                                                           */
/* ------------------------------------------------------------------ */

export function ChatComposer({
  registerPrefill,
  wide = false,
}: {
  /** Lets the page inject text into the textarea (quick-start chips). */
  registerPrefill?: (prefill: (text: string) => void) => void;
  /** Uses the wider empty-state presentation without widening chat transcripts. */
  wide?: boolean;
}) {
  const { t } = useTranslation();
  const searchParams = useSearchParams();
  const {
    state,
    setTools,
    setCapability,
    setKBs,
    setAgentSelection,
    setLLMSelection,
    setPersonaSelection,
    sendMessage,
    cancelStreamingTurn,
  } = useUnifiedChat();

  const [value, setValue] = React.useState("");
  const [attachments, setAttachments] = React.useState<PendingAttachment[]>([]);
  const [referenceSelection, setReferenceSelection] =
    React.useState<ChatReferenceSelection>(emptyReferenceSelection);
  const [agentNames, setAgentNames] = React.useState<string[]>([]);
  const [researchConfig, setResearchConfig] =
    React.useState<DeepResearchFormConfig>({
      mode: "report",
      depth: "quick",
      manual_subtopics: 3,
      manual_max_iterations: 3,
      source_types: ["web", "papers"],
      report_format: "markdown",
      max_sources: 20,
    });
  const [visualizeConfig, setVisualizeConfig] =
    React.useState<VisualizeFormConfig>(DEFAULT_VISUALIZE_CONFIG);
  const [quizConfig, setQuizConfig] =
    React.useState<DeepQuestionFormConfig>(DEFAULT_QUIZ_CONFIG);
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const learningPrefillKeyRef = React.useRef("");
  // Bumping this key remounts single-select dropdowns, closing the menu
  // after a pick (the kit's Dropdown only auto-closes for DropdownItem).
  const [menuKey, setMenuKey] = React.useState(0);
  const closeMenus = React.useCallback(() => setMenuKey((k) => k + 1), []);

  const [llmOptions, setLlmOptions] = React.useState<LLMOption[]>([]);
  const [llmLoadStatus, setLlmLoadStatus] = React.useState<
    "loading" | "ready" | "error"
  >("loading");
  const [activeLLMDefault, setActiveLLMDefault] =
    React.useState<LLMSelection | null>(null);
  const [knowledgeBases, setKnowledgeBases] = React.useState<
    KnowledgeBaseSummary[]
  >([]);
  const [knowledgeBasesLoaded, setKnowledgeBasesLoaded] = React.useState(false);
  const [personas, setPersonas] = React.useState<PersonaInfo[]>([]);
  const [savedTools, setSavedTools] = React.useState<string[] | null>(null);
  const [toolsSaving, setToolsSaving] = React.useState(false);
  const [advancedOpen, setAdvancedOpen] = React.useState(false);
  const [capabilityAvailability, setCapabilityAvailability] = React.useState<
    Record<string, CapabilityAvailability>
  >({});

  const attachmentLimits = useAttachmentLimits();
  const { isComposingRef, onCompositionStart, onCompositionEnd } =
    useImeComposing();

  const voiceMessages = React.useMemo(
    () => ({
      unsupported: t("Recording is not supported in this browser."),
      permissionDenied: t("Microphone permission denied."),
      unavailable: t(
        "Voice input is unavailable until speech-to-text is configured in Settings.",
      ),
      preflightFailed: t(
        "Couldn't check voice input availability. Please try again.",
      ),
      transcriptionFailed: t("Transcription failed."),
      transcriptionHttp: (status: number) =>
        t("Transcription failed (HTTP {{status}}).", { status }),
    }),
    [t],
  );

  const voiceRecorder = useVoiceRecorder(
    React.useCallback((text: string) => {
      setValue((prev) => (prev ? `${prev.trimEnd()} ${text}` : text));
      textareaRef.current?.focus();
    }, []),
    voiceMessages,
  );

  React.useEffect(() => {
    if (voiceRecorder.error) {
      notify(voiceRecorder.error, { tone: "error" });
    }
  }, [voiceRecorder.error]);

  /* ---- option lists (client-cached, one round-trip each) ---- */

  const llmRequestIdRef = React.useRef(0);
  const retryLLMOptions = React.useCallback(async () => {
    const requestId = ++llmRequestIdRef.current;
    setLlmLoadStatus("loading");
    try {
      const data = await listLLMOptions({ force: true });
      if (requestId !== llmRequestIdRef.current) return;
      setLlmOptions(data.options);
      setActiveLLMDefault(data.active);
      setLlmLoadStatus("ready");
    } catch {
      if (requestId !== llmRequestIdRef.current) return;
      setLlmLoadStatus("error");
    }
  }, []);

  React.useEffect(() => {
    let alive = true;
    const requestId = ++llmRequestIdRef.current;
    listLLMOptions()
      .then((data) => {
        if (!alive || requestId !== llmRequestIdRef.current) return;
        setLlmOptions(data.options);
        setActiveLLMDefault(data.active);
        setLlmLoadStatus("ready");
      })
      .catch(() => {
        if (alive && requestId === llmRequestIdRef.current) {
          setLlmLoadStatus("error");
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  React.useEffect(() => {
    let alive = true;
    listKnowledgeBases()
      .then((list) => {
        if (!alive) return;
        setKnowledgeBases(list);
        setKnowledgeBasesLoaded(true);
      })
      .catch(() => {});
    listPersonas()
      .then((list) => alive && setPersonas(list))
      .catch(() => {});
    getEnabledOptionalTools()
      .then((list) => alive && setSavedTools(list))
      .catch(() => alive && setSavedTools([]));
    listCapabilityCatalog()
      .then((items) => {
        if (!alive) return;
        setCapabilityAvailability(
          Object.fromEntries(
            items
              .filter((item) => item.availability)
              .map((item) => [item.name, item.availability!]),
          ),
        );
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  React.useEffect(() => {
    if (!knowledgeBasesLoaded) return;
    const readyNames = new Set(
      knowledgeBases.filter(knowledgeBaseReady).map((kb) => kb.name),
    );
    const next = state.knowledgeBases.filter((name) => readyNames.has(name));
    if (next.length !== state.knowledgeBases.length) setKBs(next);
  }, [knowledgeBases, knowledgeBasesLoaded, setKBs, state.knowledgeBases]);

  // Default the model to the server's active default until the session
  // reports its own selection.
  React.useEffect(() => {
    if (state.llmSelection || !activeLLMDefault) return;
    setLLMSelection(activeLLMDefault);
  }, [activeLLMDefault, setLLMSelection, state.llmSelection]);

  // Keep enabledTools = (user's saved toggleable set) ∩ (capability's
  // allow-list) — same switchboard semantics as /settings/tools.
  React.useEffect(() => {
    if (savedTools === null) return;
    const allowed = new Set(
      TOOL_ALLOWLIST[state.activeCapability || ""] ?? TOOL_ALLOWLIST[""],
    );
    const next = savedTools.filter((tool) => allowed.has(tool));
    const current = state.enabledTools;
    const same =
      current.length === next.length &&
      current.every((tool, i) => tool === next[i]);
    if (!same) setTools(next);
  }, [savedTools, state.activeCapability, state.enabledTools, setTools]);

  /* ---- prefill bridge (empty-state quick chips) ---- */

  React.useEffect(() => {
    registerPrefill?.((text: string) => {
      setValue(text);
      textareaRef.current?.focus();
    });
  }, [registerPrefill]);

  React.useEffect(() => {
    const handleVisualizePrompt = (event: Event) => {
      const text = (event as CustomEvent<unknown>).detail;
      if (typeof text !== "string" || !text.trim()) return;
      setCapability("visualize");
      setValue(text.trim());
      textareaRef.current?.focus();
    };
    window.addEventListener("dt:visualize-prompt", handleVisualizePrompt);
    return () =>
      window.removeEventListener("dt:visualize-prompt", handleVisualizePrompt);
  }, [setCapability]);

  React.useEffect(() => {
    const handlePrefill = (event: Event) => {
      const text = (event as CustomEvent<unknown>).detail;
      if (typeof text !== "string" || !text.trim()) return;
      setValue(text.trim());
      textareaRef.current?.focus();
    };
    window.addEventListener("dt:chat-prefill", handlePrefill);
    return () => window.removeEventListener("dt:chat-prefill", handlePrefill);
  }, []);

  React.useEffect(() => {
    const taskId = searchParams.get("learning_task") || "";
    const projectId = searchParams.get("project") || "";
    const objective = searchParams.get("objective")?.trim() || "";
    const key = taskId && projectId ? `${projectId}:${taskId}` : "";
    if (!key || !objective || learningPrefillKeyRef.current === key) return;
    learningPrefillKeyRef.current = key;
    setCapability("mastery_path");
    setValue((current) => current.trim()
      ? current
      : t("Guide me through this learning task: {{objective}}", { objective }));
    textareaRef.current?.focus();
  }, [searchParams, setCapability, t]);

  /* ---- attachments ---- */

  const filterAndReportFiles = React.useCallback(
    (files: File[]): File[] => {
      let runningTotal = attachments.reduce((sum, a) => sum + (a.size ?? 0), 0);
      const accepted: File[] = [];
      for (const file of files) {
        if (!classifyFile(file)) {
          notify(t("Unsupported file type: {{name}}", { name: file.name }), {
            tone: "error",
          });
          continue;
        }
        if (file.size > attachmentLimits.maxFileBytes) {
          notify(t("File too large: {{name}}", { name: file.name }), {
            tone: "error",
          });
          continue;
        }
        if (runningTotal + file.size > attachmentLimits.maxTotalBytes) {
          notify(t("Too many files, skipped some"), { tone: "error" });
          break;
        }
        runningTotal += file.size;
        accepted.push(file);
      }
      return accepted;
    },
    [attachments, attachmentLimits, t],
  );

  const addFiles = React.useCallback(
    async (files: File[]) => {
      const accepted = filterAndReportFiles(files);
      if (!accepted.length) return;
      const next = await Promise.all(
        accepted.map(async (file): Promise<PendingAttachment> => {
          const dataUrl = await readFileAsDataUrl(file);
          const svg = isSvgFilename(file.name) || file.type === "image/svg+xml";
          const isImage = !svg && file.type.startsWith("image/");
          return {
            type: isImage ? "image" : "file",
            filename: file.name,
            base64: extractBase64FromDataUrl(dataUrl),
            size: file.size,
            mimeType: file.type || undefined,
          };
        }),
      );
      setAttachments((prev) => [...prev, ...next]);
    },
    [filterAndReportFiles],
  );

  /* ---- send ---- */

  const turnActive = state.isStreaming;
  const canSend =
    !turnActive && (value.trim().length > 0 || attachments.length > 0);

  const handleSend = React.useCallback(() => {
    const text = value.trim();
    if (!text && attachments.length === 0) return;
    if (turnActive) return;
    const payload = attachments.map((a) => ({
      type: a.type,
      filename: a.filename,
      base64: a.base64,
      mime_type: a.mimeType,
    }));
    let config: Record<string, unknown> | undefined;
    try {
      config =
        state.activeCapability === "deep_question"
          ? buildQuizWSConfig(quizConfig)
          : state.activeCapability === "math_animator"
            ? buildMathAnimatorWSConfig(visualizeConfig)
            : state.activeCapability === "deep_research"
              ? buildResearchWSConfig(researchConfig)
              : state.activeCapability === "visualize"
                ? buildVisualizeWSConfig(visualizeConfig)
                : undefined;
    } catch {
      notify(t("Check capability settings and try again."), { tone: "error" });
      return;
    }
    const references = buildChatReferencePayload(referenceSelection);
    const learningTaskId = searchParams.get("learning_task") || "";
    const learningProjectId = searchParams.get("project") || "";
    const learningObjective = searchParams.get("objective") || "";
    const learningContext = learningTaskId && learningProjectId
      ? {
          project_id: learningProjectId,
          task_id: learningTaskId,
          objective: learningObjective,
        }
      : undefined;
    sendMessage(
      text,
      payload.length ? payload : undefined,
      config,
      references.notebookReferences,
      references.historyReferences,
      { bookReferences: references.bookReferences, learningContext },
      references.questionNotebookReferences,
      undefined,
      references.memoryReferences,
    );
    setValue("");
    setAttachments([]);
    setReferenceSelection(emptyReferenceSelection());
  }, [
    attachments,
    referenceSelection,
    researchConfig,
    quizConfig,
    visualizeConfig,
    sendMessage,
    searchParams,
    state.activeCapability,
    t,
    turnActive,
    value,
  ]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !isComposingRef.current) {
      e.preventDefault();
      handleSend();
    }
  };

  /* ---- selection handlers ---- */

  const handleSelectTool = async (name: string) => {
    if (toolsSaving) return;
    const current = new Set(state.enabledTools);
    const previousTools = Array.from(current);
    if (current.has(name)) current.delete(name);
    else current.add(name);
    const nextTools = Array.from(current);
    setTools(nextTools);
    const saved = new Set(savedTools ?? []);
    const previousSavedTools = Array.from(saved);
    if (saved.has(name)) saved.delete(name);
    else saved.add(name);
    const nextSavedTools = Array.from(saved);
    setSavedTools(nextSavedTools);
    setToolsSaving(true);
    try {
      const res = await apiFetch(apiUrl("/api/v1/settings/enabled-tools"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled_tools: nextSavedTools }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      invalidateEnabledOptionalToolsCache();
    } catch {
      setTools(previousTools);
      setSavedTools(previousSavedTools);
      notify(t("Couldn't save tool settings"), { tone: "error" });
    } finally {
      setToolsSaving(false);
    }
  };

  const handleToggleKB = (name: string) => {
    const current = new Set(state.knowledgeBases);
    if (current.has(name)) current.delete(name);
    else current.add(name);
    setKBs(Array.from(current));
  };

  const handleAgentNamesChange = React.useCallback((names: string[]) => {
    setAgentNames(names);
  }, []);

  const activeCapability = state.activeCapability || "";
  const previewCapability = React.useMemo(
    () => activeCapability === "auto" ? previewLearningCapability(value) : (activeCapability || "chat"),
    [activeCapability, value],
  );
  const previewSourceCount = state.knowledgeBases.length + countChatReferences(referenceSelection) + attachments.length;
  const previewNeedsNetwork = previewCapability === "deep_research" || state.enabledTools.includes("web_search");
  const currentLLM =
    llmOptions.find((o) => sameLLMSelection(o, state.llmSelection)) ??
    llmOptions.find((o) => o.is_active_default);
  const currentLLMName = currentLLM
    ? currentLLM.model_name || currentLLM.model
    : t("Model");
  const currentPersona = state.personaSelection || "";
  const referenceCount = countChatReferences(referenceSelection);
  const contextEstimate = React.useMemo(
    () =>
      estimateComposerContext({
        text: value,
        attachmentBytes: attachments.reduce((total, item) => total + (item.size ?? 0), 0),
        referenceCount,
        knowledgeBaseCount: state.knowledgeBases.length,
        contextWindow: currentLLM?.context_window,
      }),
    [attachments, currentLLM?.context_window, referenceCount, state.knowledgeBases.length, value],
  );
  const showContextEstimate =
    value.length > 0 || attachments.length > 0 || referenceCount > 0 || state.knowledgeBases.length > 0;

  const toolButtonClass =
    "flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground";

  return (
    <div
      className={cn(
        "mx-auto w-full px-4 pb-4",
        wide ? "max-w-4xl" : "max-w-3xl",
      )}
    >
      <div className="rounded-2xl border border-border bg-card shadow-hairline transition-shadow duration-150 focus-within:ring-2 focus-within:ring-ring">
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-3 pt-3">
            {attachments.map((attachment, index) => {
              const { Icon, tint } = docIconFor(attachment.filename);
              return (
                <span
                  key={`${attachment.filename}-${index}`}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-muted-subtle px-2 py-1 text-xs text-muted-foreground"
                >
                  <Icon size={13} className={cn("shrink-0", tint)} />
                  <span className="max-w-40 truncate">
                    {attachment.filename}
                  </span>
                  {attachment.size != null && (
                    <span className="text-[10px]">
                      {formatBytes(attachment.size)}
                    </span>
                  )}
                  <button
                    type="button"
                    aria-label={t("Remove attachment")}
                    onClick={() =>
                      setAttachments((prev) =>
                        prev.filter((_, i) => i !== index),
                      )
                    }
                    className="rounded p-0.5 transition-colors duration-150 hover:text-foreground"
                  >
                    <X size={12} />
                  </button>
                </span>
              );
            })}
          </div>
        )}
        {activeCapability === "deep_research" && (
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span>{t("Mode")}</span>
              <select
                aria-label={t("Mode")}
                value={researchConfig.mode}
                onChange={(event) =>
                  setResearchConfig((current) => ({
                    ...current,
                    mode: event.target.value as ResearchMode,
                  }))
                }
                className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring"
              >
                {RESEARCH_MODES.map((option) => (
                  <option key={option.value} value={option.value}>
                    {t(option.labelKey)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span>{t("Depth")}</span>
              <select
                aria-label={t("Depth")}
                value={researchConfig.depth}
                onChange={(event) =>
                  setResearchConfig((current) => ({
                    ...current,
                    depth: event.target.value as ResearchDepth,
                  }))
                }
                className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring"
              >
                {RESEARCH_DEPTHS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {t(option.labelKey)}
                  </option>
                ))}
              </select>
            </label>
            <fieldset className="flex items-center gap-1" aria-label={t("Sources")}>
              <legend className="sr-only">{t("Sources")}</legend>
              {RESEARCH_SOURCES.map((source) => {
                const selected = researchConfig.source_types?.includes(source.value) ?? false;
                return (
                  <button
                    key={source.value}
                    type="button"
                    aria-pressed={selected}
                    onClick={() =>
                      setResearchConfig((current) => {
                        const sources = current.source_types ?? [];
                        return {
                          ...current,
                          source_types: selected
                            ? sources.filter((item) => item !== source.value)
                            : [...sources, source.value],
                        };
                      })
                    }
                    className={cn(
                      "rounded-full border px-2 py-1 text-[11px] transition-colors",
                      selected
                        ? "border-primary bg-primary-muted text-foreground"
                        : "border-border text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {t(source.labelKey)}
                  </button>
                );
              })}
            </fieldset>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span>{t("Format")}</span>
              <select
                aria-label={t("Format")}
                value={researchConfig.report_format ?? "markdown"}
                onChange={(event) =>
                  setResearchConfig((current) => ({
                    ...current,
                    report_format: event.target.value as ResearchReportFormat,
                  }))
                }
                className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring"
              >
                {RESEARCH_FORMATS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {t(option.labelKey)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span>{t("From")}</span>
              <input
                type="date"
                aria-label={t("From")}
                value={researchConfig.date_from ?? ""}
                onChange={(event) =>
                  setResearchConfig((current) => ({
                    ...current,
                    date_from: event.target.value || undefined,
                  }))
                }
                className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring"
              />
            </label>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span>{t("To")}</span>
              <input
                type="date"
                aria-label={t("To")}
                value={researchConfig.date_to ?? ""}
                onChange={(event) =>
                  setResearchConfig((current) => ({
                    ...current,
                    date_to: event.target.value || undefined,
                  }))
                }
                className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring"
              />
            </label>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span>{t("Max Sources")}</span>
              <input
                type="number"
                min={1}
                max={100}
                value={researchConfig.max_sources ?? 20}
                onChange={(event) =>
                  setResearchConfig((current) => ({
                    ...current,
                    max_sources: Number(event.target.value),
                  }))
                }
                className="w-16 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring"
              />
            </label>
            {researchConfig.depth === "manual" && (
              <>
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span>{t("Sub-topics")}</span>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={researchConfig.manual_subtopics ?? 3}
                    onChange={(event) =>
                      setResearchConfig((current) => ({
                        ...current,
                        manual_subtopics: Number(event.target.value),
                      }))
                    }
                    className="w-14 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring"
                  />
                </label>
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span>{t("Iterations")}</span>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={researchConfig.manual_max_iterations ?? 3}
                    onChange={(event) =>
                      setResearchConfig((current) => ({
                        ...current,
                        manual_max_iterations: Number(event.target.value),
                      }))
                    }
                    className="w-14 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring"
                  />
                </label>
              </>
            )}
          </div>
        )}
        {activeCapability === "deep_question" && (
          <div
            className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2"
            data-testid="quiz-config"
          >
            <div className="flex rounded-md border border-border p-0.5">
              {(["custom", "mimic"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={quizConfig.mode === mode}
                  onClick={() =>
                    setQuizConfig((current) => ({ ...current, mode }))
                  }
                  className={cn(
                    "rounded px-2 py-1 text-[11px] transition-colors",
                    quizConfig.mode === mode
                      ? "bg-primary-muted text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {mode === "custom" ? t("Custom") : t("Mimic Paper")}
                </button>
              ))}
            </div>
            {quizConfig.mode === "mimic" ? (
              <>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                >
                  {attachments.some((item) =>
                    item.filename.toLowerCase().endsWith(".pdf"),
                  )
                    ? t("Replace PDF")
                    : t("Upload exam PDF")}
                </button>
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span>{t("Maximum questions")}</span>
                  <input
                    type="number"
                    min={1}
                    max={50}
                    value={quizConfig.max_questions}
                    onChange={(event) =>
                      setQuizConfig((current) => ({
                        ...current,
                        max_questions: Math.min(
                          50,
                          Math.max(1, Number(event.target.value) || 1),
                        ),
                      }))
                    }
                    className="w-14 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring"
                  />
                </label>
                <span className="text-[11px] text-muted-foreground">
                  {t("The uploaded paper is parsed into templates, then new questions are generated in the same style.")}
                </span>
              </>
            ) : (
              <>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span>{t("Count")}</span>
              <input
                type="number"
                min={1}
                max={20}
                value={quizConfig.num_questions}
                onChange={(event) =>
                  setQuizConfig((current) => ({
                    ...current,
                    num_questions: Math.min(
                      20,
                      Math.max(1, Number(event.target.value) || 1),
                    ),
                  }))
                }
                className="w-14 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring"
              />
            </label>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span>{t("Difficulty")}</span>
              <select
                value={quizConfig.difficulty}
                onChange={(event) =>
                  setQuizConfig((current) => ({
                    ...current,
                    difficulty: event.target.value,
                  }))
                }
                className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="auto">{t("Auto")}</option>
                <option value="easy">{t("Easy")}</option>
                <option value="medium">{t("Medium")}</option>
                <option value="hard">{t("Hard")}</option>
              </select>
            </label>
            <div className="flex flex-wrap items-center gap-1" aria-label={t("Type")}>
              {QUIZ_QUESTION_TYPES.map((type) => {
                const selected = quizConfig.question_types.includes(type);
                return (
                  <button
                    key={type}
                    type="button"
                    aria-pressed={selected}
                    onClick={() =>
                      setQuizConfig((current) => ({
                        ...current,
                        question_types: selected
                          ? current.question_types.filter((item) => item !== type)
                          : [...current.question_types, type],
                        per_type_counts: {},
                      }))
                    }
                    className={cn(
                      "rounded-full border px-2 py-1 text-[11px] transition-colors",
                      selected
                        ? "border-primary bg-primary-muted text-foreground"
                        : "border-border text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {t(QUIZ_TYPE_LABEL_KEYS[type as NormalizedQuizQuestionType])}
                  </button>
                );
              })}
            </div>
              </>
            )}
          </div>
        )}
        {activeCapability === "visualize" && (
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span>{t("Render Mode")}</span>
              <select
                aria-label={t("Render Mode")}
                value={visualizeConfig.render_mode}
                onChange={(event) =>
                  setVisualizeConfig((current) => ({
                    ...current,
                    render_mode: event.target
                      .value as VisualizeFormConfig["render_mode"],
                  }))
                }
                className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="auto">{t("Auto")}</option>
                <option value="chartjs">{t("Chart.js")}</option>
                <option value="svg">{t("SVG")}</option>
                <option value="mermaid">{t("Mermaid")}</option>
                <option value="html">{t("HTML")}</option>
                <option
                  value="manim_video"
                  disabled={
                    capabilityAvailability.math_animator?.available === false
                  }
                >
                  {t("Animation")}
                </option>
                <option
                  value="manim_image"
                  disabled={
                    capabilityAvailability.math_animator?.available === false
                  }
                >
                  {t("Storyboard")}
                </option>
              </select>
            </label>
            {(visualizeConfig.render_mode === "manim_video" ||
              visualizeConfig.render_mode === "manim_image") && (
              <>
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span>{t("Quality")}</span>
                  <select
                    aria-label={t("Quality")}
                    value={visualizeConfig.quality}
                    onChange={(event) =>
                      setVisualizeConfig((current) => ({
                        ...current,
                        quality: event.target
                          .value as VisualizeFormConfig["quality"],
                      }))
                    }
                    className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring"
                  >
                    <option value="low">{t("Low")}</option>
                    <option value="medium">{t("Medium")}</option>
                    <option value="high">{t("High")}</option>
                  </select>
                </label>
                <label className="flex min-w-48 flex-1 items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="shrink-0">{t("Style Hint")}</span>
                  <input
                    aria-label={t("Style Hint")}
                    value={visualizeConfig.style_hint}
                    onChange={(event) =>
                      setVisualizeConfig((current) => ({
                        ...current,
                        style_hint: event.target.value,
                      }))
                    }
                    placeholder={t("Style, pacing, color...")}
                    className="min-w-28 flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring"
                  />
                </label>
              </>
            )}
            <RenderAdvancedControls
              config={visualizeConfig}
              motion={
                visualizeConfig.render_mode === "manim_video" ||
                visualizeConfig.render_mode === "manim_image"
              }
              onChange={(next) =>
                setVisualizeConfig((current) => ({ ...current, ...next }))
              }
            />
          </div>
        )}
        {activeCapability === "math_animator" && (
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span>{t("Output")}</span>
              <select
                aria-label={t("Output")}
                value={
                  visualizeConfig.render_mode === "manim_image"
                    ? "image"
                    : "video"
                }
                onChange={(event) =>
                  setVisualizeConfig((current) => ({
                    ...current,
                    render_mode:
                      event.target.value === "image"
                        ? "manim_image"
                        : "manim_video",
                  }))
                }
                className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="video">{t("Animation")}</option>
                <option value="image">{t("Storyboard")}</option>
              </select>
            </label>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span>{t("Quality")}</span>
              <select
                value={visualizeConfig.quality}
                onChange={(event) =>
                  setVisualizeConfig((current) => ({
                    ...current,
                    quality: event.target.value as VisualizeFormConfig["quality"],
                  }))
                }
                className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="low">{t("Low")}</option>
                <option value="medium">{t("Medium")}</option>
                <option value="high">{t("High")}</option>
              </select>
            </label>
            <label className="flex min-w-48 flex-1 items-center gap-1.5 text-xs text-muted-foreground">
              <span>{t("Style Hint")}</span>
              <input
                value={visualizeConfig.style_hint}
                onChange={(event) =>
                  setVisualizeConfig((current) => ({
                    ...current,
                    style_hint: event.target.value,
                  }))
                }
                placeholder={t("Style, pacing, color...")}
                className="min-w-28 flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring"
              />
            </label>
            <RenderAdvancedControls
              config={visualizeConfig}
              motion
              onChange={(next) =>
                setVisualizeConfig((current) => ({ ...current, ...next }))
              }
            />
          </div>
        )}
        <Textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onCompositionStart={onCompositionStart}
          onCompositionEnd={onCompositionEnd}
          autoResize
          rows={1}
          placeholder={t("Ask anything…")}
          aria-label={t("Ask anything…")}
          className="max-h-48 min-h-[44px] resize-none overflow-y-auto border-0 bg-transparent px-4 pb-1.5 pt-3 text-[15px] shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
        />
        {value.trim() && (
          <div className="mx-3 mb-1 flex max-w-full gap-3 overflow-x-auto rounded-lg bg-muted-subtle px-3 py-2 text-[11px] text-muted-foreground" data-testid="learning-intent-preflight" role="status">
            <span className="whitespace-nowrap"><strong className="text-foreground">{t("Learning mode")}:</strong> {t(capabilityLabel(previewCapability === "chat" ? null : previewCapability))}</span>
            <span className="whitespace-nowrap"><strong className="text-foreground">{t("Learning sources")}:</strong> {previewSourceCount ? t("{{count}} selected", { count: previewSourceCount }) : t("No selected sources")}</span>
            <span className="whitespace-nowrap"><strong className="text-foreground">{t("Network")}:</strong> {previewNeedsNetwork ? t("May be used") : t("Not required")}</span>
            <span className="whitespace-nowrap"><strong className="text-foreground">{t("Estimated time")}:</strong> {t(capabilityTimeRange(previewCapability))}</span>
          </div>
        )}
        {showContextEstimate ? (
          <div
            className={cn(
              "flex flex-wrap items-center gap-x-2 gap-y-1 px-4 pb-1 text-[11px] text-muted-foreground",
              contextEstimate.level === "critical" && "text-destructive",
              contextEstimate.level === "warning" && "text-warning-foreground",
            )}
            data-testid="composer-context-estimate"
          >
            <Gauge size={11} />
            <span>
              {t("Estimated context: {{tokens}} tokens", {
                tokens: contextEstimate.estimatedTokens.toLocaleString(),
              })}
            </span>
            {contextEstimate.contextWindow && contextEstimate.usagePercent !== null ? (
              <span>
                {t("≈{{percent}}% of {{window}}", {
                  percent: contextEstimate.usagePercent,
                  window: contextEstimate.contextWindow.toLocaleString(),
                })}
              </span>
            ) : null}
            <span title={t("References and attachments are estimated before parsing.")}>≈</span>
            {contextEstimate.level === "critical" ? (
              <span className="font-medium">
                {t("Context may be truncated; remove sources or choose a larger-window model.")}
              </span>
            ) : null}
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-0.5 px-2.5 pb-2.5">
          {/* Attach */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ATTACHMENT_ACCEPT}
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = "";
              void addFiles(files);
            }}
          />
          <ToolbarIconButton
            icon={Paperclip}
            label={t("Attach files")}
            active={attachments.length > 0}
            onClick={() => fileInputRef.current?.click()}
          />

          {/* Learning mode */}
          <Dropdown
            key={`cap-${menuKey}`}
            trigger={
              <button type="button" className={toolButtonClass} aria-label={t("Learning mode")}>
                <Sparkles size={14} />
                <span>{t("Learning mode")}</span>
              </button>
            }
            className="bottom-full mb-1 w-64"
          >
            {CAPABILITIES.map((cap) => (
              <MenuRow
                key={cap.value || "chat"}
                title={t(cap.labelKey)}
                description={t(cap.descKey)}
                checked={activeCapability === cap.value}
                disabled={
                  Boolean(cap.value) &&
                  capabilityAvailability[cap.value]?.available === false
                }
                unavailableHint={
                  cap.value
                    ? capabilityAvailability[cap.value]?.install_hint
                    : undefined
                }
                onClick={() => {
                  if (
                    cap.value &&
                    capabilityAvailability[cap.value]?.available === false
                  ) {
                    return;
                  }
                  setCapability(cap.value || null);
                  closeMenus();
                }}
              />
            ))}
          </Dropdown>
          {activeCapability !== "auto" && (
            <Badge variant="primary" className="ml-0.5">
              {t(capabilityLabel(state.activeCapability))}
            </Badge>
          )}

          {/* Learning sources + connected assistants */}
          <ChatReferencePicker
            selection={referenceSelection}
            onSelectionChange={setReferenceSelection}
            selectedKnowledgeBases={state.knowledgeBases}
            activeAgentName={state.agentSelection}
            onAgentSelectionChange={setAgentSelection}
            onAgentNamesChange={handleAgentNamesChange}
            referenceCount={referenceCount}
          />

          <ToolbarIconButton
            icon={SlidersHorizontal}
            label={t("Advanced options")}
            active={advancedOpen || state.knowledgeBases.length > 0 || currentPersona !== "" || state.enabledTools.length > 0}
            aria-expanded={advancedOpen}
            onClick={() => setAdvancedOpen((open) => !open)}
          />

          {advancedOpen && (
            <div className="order-last mt-2 flex w-full flex-wrap items-center gap-1 border-t border-border pt-2">

          {/* Model */}
          <Dropdown
            key={`llm-${menuKey}`}
            trigger={
              <button type="button" className={toolButtonClass}>
                <Cpu size={14} />
                <span className="max-w-28 truncate">{currentLLMName}</span>
              </button>
            }
            className="bottom-full mb-1 w-64"
          >
            {llmLoadStatus === "loading" && (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">
                {t("Loading models…")}
              </div>
            )}
            {llmLoadStatus === "error" && (
              <div className="space-y-2 px-2 py-1.5 text-xs text-muted-foreground">
                <p>{t("Couldn't load models. Your current selection was kept.")}</p>
                <button
                  type="button"
                  className="font-medium text-accent-foreground hover:underline"
                  onClick={() => void retryLLMOptions()}
                >
                  {t("Retry")}
                </button>
              </div>
            )}
            {llmLoadStatus === "ready" && llmOptions.length === 0 && (
              <div className="space-y-2 px-2 py-1.5 text-xs text-muted-foreground">
                <p>
                  {t(
                    "Using the server default model. Add a model profile to choose explicitly.",
                  )}
                </p>
                <a
                  href="/settings/llm"
                  className="font-medium text-accent-foreground hover:underline"
                >
                  {t("Open model settings")}
                </a>
              </div>
            )}
            {llmOptions.map((option) => (
              <MenuRow
                key={`${option.profile_id}:${option.model_id}`}
                title={option.model_name || option.model}
                description={option.profile_name}
                checked={sameLLMSelection(option, state.llmSelection)}
                onClick={() => {
                  setLLMSelection({
                    profile_id: option.profile_id,
                    model_id: option.model_id,
                  });
                  closeMenus();
                }}
              />
            ))}
          </Dropdown>

          {/* Knowledge bases */}
          <Dropdown
            trigger={
              <ToolbarIconButton
                icon={Database}
                label={t("Knowledge bases")}
                active={state.knowledgeBases.length > 0}
              />
            }
            className="bottom-full mb-1 w-64"
          >
            {knowledgeBases.length === 0 && (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">
                {t("No knowledge bases yet")}
              </div>
            )}
            {knowledgeBases.filter((kb) =>
              !agentNames.includes(kb.name) && kb.metadata?.type !== "subagent"
            ).map((kb) => {
              const ready = knowledgeBaseReady(kb);
              const status = knowledgeBaseRuntimeStatus(kb) || "unavailable";
              const failureDetail = knowledgeBaseFailureDetail(kb);
              return (
              <div
                key={kb.name}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 transition-colors duration-150",
                  ready ? "hover:bg-muted" : "opacity-70",
                )}
                title={failureDetail ?? undefined}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-foreground">
                    {kb.name}
                  </span>
                  {!ready && (
                    <span className="block truncate text-xs text-destructive">
                      {t("Unavailable: {{status}}", { status })}
                    </span>
                  )}
                </span>
                <Toggle
                  checked={state.knowledgeBases.includes(kb.name)}
                  onCheckedChange={() => handleToggleKB(kb.name)}
                  disabled={!ready}
                  aria-label={
                    ready
                      ? kb.name
                      : t("{{name}} is unavailable", { name: kb.name })
                  }
                />
              </div>
              );
            })}
          </Dropdown>

          {/* Teaching preferences */}
          <Dropdown
            key={`persona-${menuKey}`}
            trigger={
              <ToolbarIconButton
                icon={User}
                label={t("Teaching preferences")}
                active={currentPersona !== ""}
              />
            }
            className="bottom-full mb-1 w-64"
          >
            <MenuRow
              title={t("None")}
              description={t("Default assistant style")}
              checked={currentPersona === ""}
              onClick={() => {
                setPersonaSelection("");
                closeMenus();
              }}
            />
            {personas.map((persona) => (
              <MenuRow
                key={persona.name}
                title={persona.name}
                description={persona.description || undefined}
                checked={currentPersona === persona.name}
                onClick={() => {
                  setPersonaSelection(persona.name);
                  closeMenus();
                }}
              />
            ))}
          </Dropdown>

          {/* Advanced tools */}
          <Dropdown
            trigger={
              <ToolbarIconButton
                icon={Wrench}
                label={t("Advanced tools")}
                active={state.enabledTools.length > 0}
              />
            }
            className="bottom-full mb-1 w-72"
          >
            {TOGGLEABLE_TOOLS.map((tool) => (
              <div
                key={tool.name}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 transition-colors duration-150 hover:bg-muted"
              >
                <span className="flex-1">
                  <span className="block text-sm text-foreground">
                    {t(tool.labelKey)}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {t(tool.descKey)}
                  </span>
                </span>
                <Toggle
                  checked={state.enabledTools.includes(tool.name)}
                  onCheckedChange={() => void handleSelectTool(tool.name)}
                  disabled={toolsSaving}
                  aria-label={t(tool.labelKey)}
                />
              </div>
            ))}
          </Dropdown>
            </div>
          )}

          <div className="flex-1" />

          {/* Voice input */}
          <ToolbarIconButton
            icon={Mic}
            label={
              voiceRecorder.state === "recording"
                ? t("Stop recording")
                : voiceRecorder.state === "transcribing"
                  ? t("Transcribing…")
                  : t("Voice input")
            }
            active={voiceRecorder.state === "recording"}
            onClick={voiceRecorder.toggle}
          />

          {/* Send / Stop */}
          {turnActive ? (
            <button
              type="button"
              onClick={cancelStreamingTurn}
              aria-label={t("Stop generating")}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors duration-150 hover:brightness-105"
            >
              <Square size={13} fill="currentColor" />
            </button>
          ) : (
            <button
              type="button"
              onClick={handleSend}
              disabled={!canSend}
              aria-label={t("Send")}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-primary-foreground transition-all duration-150 hover:brightness-105 disabled:opacity-40"
            >
              <ArrowUp size={15} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default ChatComposer;
