"use client";

import * as React from "react";
import { AlertCircle } from "lucide-react";
import { useTranslation } from "react-i18next";

import { apiFetch, apiUrl } from "@/lib/api";
import {
  Button,
  EmptyState,
  Input,
  Skeleton,
  Toggle,
  useToast,
} from "@/components/ui";
import {
  SettingRow,
  SettingSection,
  SettingsPageHeader,
} from "@/components/settings/shared";

// Shape mirrors cognivoy/services/config/capabilities_settings.py.

interface SimpleLLMBlock {
  temperature: number;
  max_tokens: number;
}

interface ChatBlock {
  temperature: number;
  max_rounds: number;
  max_extra_rounds?: number;
  stage_budgets: {
    exploring: number;
    responding: number;
  };
}

interface CapabilitiesSettingsDTO {
  chat: ChatBlock;
  solve: SimpleLLMBlock & { max_rounds: number; max_replans: number };
  research: SimpleLLMBlock & {
    researching: {
      note_agent_mode: string;
      tool_timeout: number;
      tool_max_retries: number;
      paper_search_years_limit: number;
    };
  };
  question: SimpleLLMBlock & {
    exploring: {
      max_iterations: number;
      tool_summarizer: { enabled: boolean; max_tokens: number };
    };
  };
  co_writer: SimpleLLMBlock;
  vision_solver: SimpleLLMBlock;
  math_animator: SimpleLLMBlock;
}

function isValidDTO(value: unknown): value is CapabilitiesSettingsDTO {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const chat = v.chat as Record<string, unknown> | undefined;
  const solve = v.solve as Record<string, unknown> | undefined;
  return (
    !!chat &&
    typeof chat.temperature === "number" &&
    typeof chat.max_rounds === "number" &&
    !!chat.stage_budgets &&
    !!solve &&
    typeof solve.max_rounds === "number" &&
    !!v.research &&
    !!v.question
  );
}

export default function CapabilitiesSettingsPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [settings, setSettings] =
    React.useState<CapabilitiesSettingsDTO | null>(null);
  const [snapshot, setSnapshot] =
    React.useState<CapabilitiesSettingsDTO | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoadError(null);
    try {
      const res = await apiFetch(apiUrl("/api/v1/capabilities/settings"));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: unknown = await res.json();
      if (!isValidDTO(data)) {
        throw new Error(t("Unexpected payload from the backend."));
      }
      setSettings(data);
      setSnapshot(data);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [t]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const dirty =
    !!settings && !!snapshot && JSON.stringify(settings) !== JSON.stringify(snapshot);

  async function save() {
    if (!settings) return;
    setSaving(true);
    try {
      const res = await apiFetch(apiUrl("/api/v1/capabilities/settings"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      const data: unknown = await res.json().catch(() => null);
      if (!res.ok || !isValidDTO(data)) {
        throw new Error(`HTTP ${res.status}`);
      }
      setSettings(data);
      setSnapshot(data);
      toast({ title: t("Capability settings saved"), variant: "success" });
    } catch (err) {
      toast({
        title: t("Failed to save capability settings"),
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  }

  if (loadError) {
    return (
      <div>
        <SettingsPageHeader
          title={t("Capabilities")}
          description={t("Per-capability LLM parameters and runtime knobs.")}
        />
        <EmptyState
          icon={AlertCircle}
          title={t("Couldn't load capability settings")}
          description={loadError}
          action={
            <Button variant="outline" size="sm" onClick={() => void load()}>
              {t("Retry")}
            </Button>
          }
        />
      </div>
    );
  }

  if (!settings) {
    return (
      <div>
        <SettingsPageHeader
          title={t("Capabilities")}
          description={t("Per-capability LLM parameters and runtime knobs.")}
        />
        <div className="space-y-4">
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
        </div>
      </div>
    );
  }

  const patchChat = <K extends keyof ChatBlock>(
    key: K,
    value: ChatBlock[K],
  ) => setSettings({ ...settings, chat: { ...settings.chat, [key]: value } });

  const patchStageBudget = (
    stage: keyof ChatBlock["stage_budgets"],
    value: number,
  ) =>
    setSettings({
      ...settings,
      chat: {
        ...settings.chat,
        stage_budgets: { ...settings.chat.stage_budgets, [stage]: value },
      },
    });

  const patchSimple = (
    cap: "solve" | "co_writer" | "vision_solver" | "math_animator",
    value: Partial<SimpleLLMBlock>,
  ) => setSettings({ ...settings, [cap]: { ...settings[cap], ...value } });

  return (
    <div>
      <SettingsPageHeader
        title={t("Capabilities")}
        description={t("Per-capability LLM parameters and runtime knobs.")}
        action={
          <Button
            size="sm"
            onClick={() => void save()}
            loading={saving}
            disabled={!dirty}
          >
            {t("Save")}
          </Button>
        }
      />

      <SettingSection
        title={t("Chat")}
        description={t(
          "Exploring agent loop followed by a respond stage. Stage budgets cap max_tokens per LLM round.",
        )}
      >
        <NumberRow
          label={t("Temperature")}
          help={t("Sampling temperature shared across every chat stage.")}
          value={settings.chat.temperature}
          onChange={(n) => patchChat("temperature", n)}
          min={0}
          max={2}
          step={0.05}
          isFloat
        />
        <NumberRow
          label={t("Initial exploration rounds")}
          help={t("Starting round allowance. Additional rounds require new successful results and remaining time and usage headroom.")}
          value={settings.chat.max_rounds}
          onChange={(n) => patchChat("max_rounds", n)}
          min={1}
          max={50}
        />
        <NumberRow
          label={t("Maximum extra exploration rounds")}
          help={t("Zero disables adaptive rounds. Total exploration never exceeds 50 rounds; finalization is counted separately.")}
          value={settings.chat.max_extra_rounds ?? 0}
          onChange={(n) => patchChat("max_extra_rounds", n)}
          min={0}
          max={24}
        />
        <NumberRow
          label={t("Exploring (max tokens)")}
          help={t("Budget per exploring-loop round (notes + tool calls).")}
          value={settings.chat.stage_budgets.exploring}
          onChange={(n) => patchStageBudget("exploring", n)}
          min={256}
          max={200000}
          step={100}
        />
        <NumberRow
          label={t("Responding (max tokens)")}
          help={t("Budget for the final user-facing response.")}
          value={settings.chat.stage_budgets.responding}
          onChange={(n) => patchStageBudget("responding", n)}
          min={256}
          max={200000}
          step={100}
        />
      </SettingSection>

      <SettingSection
        title={t("Solve")}
        description={t(
          "Deep solve runs as one agent loop with a plan / finish-step / replan spine.",
        )}
      >
        <NumberRow
          label={t("Temperature")}
          value={settings.solve.temperature}
          onChange={(n) => patchSimple("solve", { temperature: n })}
          min={0}
          max={2}
          step={0.05}
          isFloat
        />
        <NumberRow
          label={t("Max tokens")}
          value={settings.solve.max_tokens}
          onChange={(n) => patchSimple("solve", { max_tokens: n })}
          min={256}
          max={200000}
          step={100}
        />
        <NumberRow
          label={t("Max rounds")}
          help={t("Total LLM-round budget for one solve turn.")}
          value={settings.solve.max_rounds}
          onChange={(n) =>
            setSettings({
              ...settings,
              solve: { ...settings.solve, max_rounds: n },
            })
          }
          min={1}
          max={50}
        />
        <NumberRow
          label={t("Max replans")}
          help={t(
            "How many times the planner may revise the plan within one turn.",
          )}
          value={settings.solve.max_replans}
          onChange={(n) =>
            setSettings({
              ...settings,
              solve: { ...settings.solve, max_replans: n },
            })
          }
          min={0}
          max={10}
        />
      </SettingSection>

      <SettingSection
        title={t("Question")}
        description={t("Deep question (quiz) generation pipeline.")}
      >
        <NumberRow
          label={t("Temperature")}
          value={settings.question.temperature}
          onChange={(n) =>
            setSettings({
              ...settings,
              question: { ...settings.question, temperature: n },
            })
          }
          min={0}
          max={2}
          step={0.05}
          isFloat
        />
        <NumberRow
          label={t("Max tokens")}
          value={settings.question.max_tokens}
          onChange={(n) =>
            setSettings({
              ...settings,
              question: { ...settings.question, max_tokens: n },
            })
          }
          min={256}
          max={200000}
          step={100}
        />
        <NumberRow
          label={t("Explore max iterations")}
          help={t("Cap on the explore loop before planning.")}
          value={settings.question.exploring.max_iterations}
          onChange={(n) =>
            setSettings({
              ...settings,
              question: {
                ...settings.question,
                exploring: {
                  ...settings.question.exploring,
                  max_iterations: n,
                },
              },
            })
          }
          min={1}
          max={50}
        />
        <ToggleRow
          label={t("Tool summarizer enabled")}
          help={t("Summarize long tool outputs to keep the prompt budget low.")}
          value={settings.question.exploring.tool_summarizer.enabled}
          onChange={(v) =>
            setSettings({
              ...settings,
              question: {
                ...settings.question,
                exploring: {
                  ...settings.question.exploring,
                  tool_summarizer: {
                    ...settings.question.exploring.tool_summarizer,
                    enabled: v,
                  },
                },
              },
            })
          }
        />
        <NumberRow
          label={t("Tool summarizer (max tokens)")}
          value={settings.question.exploring.tool_summarizer.max_tokens}
          onChange={(n) =>
            setSettings({
              ...settings,
              question: {
                ...settings.question,
                exploring: {
                  ...settings.question.exploring,
                  tool_summarizer: {
                    ...settings.question.exploring.tool_summarizer,
                    max_tokens: n,
                  },
                },
              },
            })
          }
          min={128}
          max={200000}
          step={100}
        />
      </SettingSection>

      <SettingSection
        title={t("Research")}
        description={t(
          "Deep research pipeline. Iteration count is controlled per request via the depth selector in the chat input.",
        )}
      >
        <NumberRow
          label={t("Temperature")}
          value={settings.research.temperature}
          onChange={(n) =>
            setSettings({
              ...settings,
              research: { ...settings.research, temperature: n },
            })
          }
          min={0}
          max={2}
          step={0.05}
          isFloat
        />
        <NumberRow
          label={t("Max tokens")}
          value={settings.research.max_tokens}
          onChange={(n) =>
            setSettings({
              ...settings,
              research: { ...settings.research, max_tokens: n },
            })
          }
          min={256}
          max={200000}
          step={100}
        />
        <NumberRow
          label={t("Tool timeout (s)")}
          help={t("Per-tool wall-clock timeout for the researching phase.")}
          value={settings.research.researching.tool_timeout}
          onChange={(n) =>
            setSettings({
              ...settings,
              research: {
                ...settings.research,
                researching: {
                  ...settings.research.researching,
                  tool_timeout: n,
                },
              },
            })
          }
          min={1}
          max={600}
        />
        <NumberRow
          label={t("Tool max retries")}
          value={settings.research.researching.tool_max_retries}
          onChange={(n) =>
            setSettings({
              ...settings,
              research: {
                ...settings.research,
                researching: {
                  ...settings.research.researching,
                  tool_max_retries: n,
                },
              },
            })
          }
          min={0}
          max={10}
        />
        <NumberRow
          label={t("Paper search years limit")}
          help={t("How far back paper search will scan.")}
          value={settings.research.researching.paper_search_years_limit}
          onChange={(n) =>
            setSettings({
              ...settings,
              research: {
                ...settings.research,
                researching: {
                  ...settings.research.researching,
                  paper_search_years_limit: n,
                },
              },
            })
          }
          min={1}
          max={50}
        />
      </SettingSection>

      <SettingSection
        title={t("Math animator")}
        description={t("Manim animation / image generation pipeline.")}
      >
        <NumberRow
          label={t("Temperature")}
          value={settings.math_animator.temperature}
          onChange={(n) => patchSimple("math_animator", { temperature: n })}
          min={0}
          max={2}
          step={0.05}
          isFloat
        />
        <NumberRow
          label={t("Max tokens")}
          value={settings.math_animator.max_tokens}
          onChange={(n) => patchSimple("math_animator", { max_tokens: n })}
          min={256}
          max={200000}
          step={100}
        />
      </SettingSection>

      <SettingSection
        title={t("Co-writer")}
        description={t("Selection edit / inline rewrite agent.")}
      >
        <NumberRow
          label={t("Temperature")}
          value={settings.co_writer.temperature}
          onChange={(n) => patchSimple("co_writer", { temperature: n })}
          min={0}
          max={2}
          step={0.05}
          isFloat
        />
        <NumberRow
          label={t("Max tokens")}
          value={settings.co_writer.max_tokens}
          onChange={(n) => patchSimple("co_writer", { max_tokens: n })}
          min={256}
          max={200000}
          step={100}
        />
      </SettingSection>
    </div>
  );
}

function NumberRow({
  label,
  help,
  value,
  onChange,
  min,
  max,
  step = 1,
  isFloat = false,
}: {
  label: string;
  help?: string;
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
  step?: number;
  isFloat?: boolean;
}) {
  return (
    <SettingRow
      title={label}
      description={help}
      control={
        <Input
          type="number"
          aria-label={label}
          className="w-28 text-right"
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === "") return;
            const n = isFloat ? parseFloat(raw) : parseInt(raw, 10);
            if (!Number.isNaN(n)) onChange(n);
          }}
        />
      }
    />
  );
}

function ToggleRow({
  label,
  help,
  value,
  onChange,
}: {
  label: string;
  help?: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <SettingRow
      title={label}
      description={help}
      control={
        <Toggle
          checked={value}
          onCheckedChange={onChange}
          aria-label={label}
        />
      }
    />
  );
}
