"use client";

import * as React from "react";
import { AlertCircle, ChevronDown, Lock, Wrench } from "lucide-react";
import { useTranslation } from "react-i18next";

import { apiFetch, apiUrl } from "@/lib/api";
import { invalidateEnabledOptionalToolsCache } from "@/lib/tools-settings";
import { cn } from "@/lib/utils";
import {
  Badge,
  Button,
  EmptyState,
  Skeleton,
  Toggle,
  useToast,
} from "@/components/ui";
import { SettingsPageHeader } from "@/components/settings/shared";

interface ToolHints {
  short_description: string;
  when_to_use: string;
  input_format: string;
  guideline: string;
  note: string;
}

interface BuiltinTool {
  name: string;
  description: string;
  parameters: {
    name: string;
    type: string;
    description: string;
    required: boolean;
  }[];
  hints: { en: ToolHints; zh: ToolHints };
  toggleable: boolean;
  coming_soon?: boolean;
  capability?: string | null;
}

interface ToolsResponse {
  tools: BuiltinTool[];
  enabled_optional_tools: string[];
}

interface ToolSection {
  key: string;
  label: string;
  hint: string;
  tools: BuiltinTool[];
}

const CAPABILITY_LABELS: Record<string, string> = {
  solve: "Deep Solve",
  mastery: "Learning plan",
};

export default function ToolsSettingsPage() {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const zh = i18n.language?.toLowerCase().startsWith("zh");

  const [tools, setTools] = React.useState<BuiltinTool[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [enabled, setEnabled] = React.useState<Set<string>>(new Set());
  const [pending, setPending] = React.useState<Set<string>>(new Set());
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const [playgroundEnabled, setPlaygroundEnabled] = React.useState<boolean | null>(null);
  const [playgroundPending, setPlaygroundPending] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoadError(null);
    try {
      const res = await apiFetch(apiUrl("/api/v1/tools"));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = (await res.json()) as ToolsResponse;
      setTools(payload.tools);
      setEnabled(new Set(payload.enabled_optional_tools ?? []));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  React.useEffect(() => {
    void apiFetch(apiUrl("/api/v1/settings/playground-policy"))
      .then(async (res) => {
        if (!res.ok) return;
        const payload = (await res.json()) as { execution_enabled: boolean };
        setPlaygroundEnabled(payload.execution_enabled);
      })
      .catch(() => undefined);
  }, []);

  async function togglePlayground() {
    if (playgroundEnabled === null || playgroundPending) return;
    const next = !playgroundEnabled;
    setPlaygroundPending(true);
    try {
      const res = await apiFetch(apiUrl("/api/v1/settings/playground-policy"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ execution_enabled: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = (await res.json()) as { execution_enabled: boolean };
      setPlaygroundEnabled(payload.execution_enabled);
    } catch (err) {
      toast({
        title: t("Failed to update Playground policy"),
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setPlaygroundPending(false);
    }
  }

  async function persist(next: Set<string>): Promise<Set<string>> {
    const res = await apiFetch(apiUrl("/api/v1/settings/enabled-tools"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled_tools: Array.from(next) }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = (await res.json()) as { enabled_optional_tools: string[] };
    invalidateEnabledOptionalToolsCache();
    return new Set(payload.enabled_optional_tools);
  }

  async function handleToggle(toolName: string) {
    if (pending.has(toolName)) return;
    const before = enabled;
    const next = new Set(before);
    if (next.has(toolName)) next.delete(toolName);
    else next.add(toolName);
    setEnabled(next);
    setPending((prev) => new Set(prev).add(toolName));
    try {
      setEnabled(await persist(next));
    } catch (err) {
      setEnabled(before);
      toast({
        title: t("Failed to save tools"),
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setPending((prev) => {
        const out = new Set(prev);
        out.delete(toolName);
        return out;
      });
    }
  }

  const sections = React.useMemo<ToolSection[] | null>(() => {
    if (!tools) return null;
    const experience: BuiltinTool[] = [];
    const builtin: BuiltinTool[] = [];
    const capabilities = new Map<string, BuiltinTool[]>();
    for (const tool of tools) {
      if (tool.capability) {
        const list = capabilities.get(tool.capability) ?? [];
        list.push(tool);
        capabilities.set(tool.capability, list);
      } else if (tool.coming_soon || tool.toggleable) {
        experience.push(tool);
      } else {
        builtin.push(tool);
      }
    }
    const out: ToolSection[] = [];
    if (experience.length) {
      out.push({
        key: "experience",
        label: t("Experience Enhancement"),
        hint: t(
          "User-toggleable. Switch on or off to shape the chat agent's behavior.",
        ),
        tools: experience,
      });
    }
    if (builtin.length) {
      out.push({
        key: "builtin",
        label: t("Built-in Tools"),
        hint: t(
          "Mounted automatically by the chat agent when needed. Not user-toggleable.",
        ),
        tools: builtin,
      });
    }
    for (const [cap, list] of capabilities) {
      const label = CAPABILITY_LABELS[cap] ?? cap;
      out.push({
        key: `cap:${cap}`,
        label: t("{{label}} · Capability Tools", { label }),
        hint: t(
          "Tools specific to this capability; mounted only when it runs.",
        ),
        tools: list,
      });
    }
    return out;
  }, [tools, t]);

  if (loadError) {
    return (
      <div>
        <SettingsPageHeader
          title={t("Tools")}
          description={t(
            "Switch user-toggleable tools on or off. Locked tools are mounted automatically when the chat agent needs them.",
          )}
        />
        <EmptyState
          icon={AlertCircle}
          title={t("Failed to load tools")}
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

  if (!sections) {
    return (
      <div>
        <SettingsPageHeader
          title={t("Tools")}
          description={t(
            "Switch user-toggleable tools on or off. Locked tools are mounted automatically when the chat agent needs them.",
          )}
        />
        <div className="space-y-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      </div>
    );
  }

  return (
    <div>
      <SettingsPageHeader
        title={t("Tools")}
        description={t(
          "Switch user-toggleable tools on or off. Locked tools are mounted automatically when the chat agent needs them.",
        )}
      />

      {playgroundEnabled !== null ? (
        <section className="mb-8">
          <h3 className="text-sm font-medium text-foreground">
            {t("Playground execution")}
          </h3>
          <p className="mt-1 text-[13px] text-muted-foreground">
            {t("Administrators can disable direct Tool and Capability runs without hiding their catalog.")}
          </p>
          <div className="surface mt-3 flex items-center justify-between gap-4 px-4 py-3.5">
            <div>
              <div className="text-sm font-medium text-foreground">
                {t("Allow direct execution")}
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                {playgroundEnabled ? t("Enabled") : t("Disabled")}
              </div>
            </div>
            <Toggle
              checked={playgroundEnabled}
              disabled={playgroundPending}
              onCheckedChange={() => void togglePlayground()}
              aria-label={t("Allow direct execution")}
            />
          </div>
        </section>
      ) : null}

      {sections.map((section) => (
        <section key={section.key} className="mb-8">
          <header className="mb-3 flex items-baseline justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-sm font-medium text-foreground">
                {section.label}
              </h3>
              <p className="mt-1 text-[13px] text-muted-foreground">
                {section.hint}
              </p>
            </div>
            <span className="shrink-0 text-xs text-muted-foreground">
              {section.tools.length}
            </span>
          </header>
          <div className="surface divide-y divide-border">
            {section.tools.map((tool) => {
              const isOpen = expanded.has(tool.name);
              const hints = (tool.hints[zh ? "zh" : "en"] ??
                tool.hints.en) as ToolHints;
              const isComingSoon = !!tool.coming_soon;
              const isEnabled =
                !isComingSoon &&
                (tool.toggleable ? enabled.has(tool.name) : true);
              return (
                <div key={tool.name}>
                  <div className="flex items-start gap-3 px-4 py-3.5">
                    <Wrench
                      size={14}
                      className="mt-0.5 shrink-0 text-muted-foreground"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        setExpanded((prev) => {
                          const next = new Set(prev);
                          if (next.has(tool.name)) next.delete(tool.name);
                          else next.add(tool.name);
                          return next;
                        })
                      }
                      className="flex min-w-0 flex-1 items-start gap-3 text-left"
                      aria-expanded={isOpen}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={cn(
                              "font-mono text-[13px] font-medium",
                              isComingSoon
                                ? "text-muted-foreground"
                                : "text-foreground",
                            )}
                          >
                            {tool.name}
                          </span>
                          {isComingSoon && (
                            <Badge variant="outline">{t("Coming soon")}</Badge>
                          )}
                        </div>
                        <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
                          {hints.short_description || tool.description}
                        </p>
                      </div>
                      <ChevronDown
                        size={15}
                        className={cn(
                          "mt-1 shrink-0 text-muted-foreground transition-transform duration-150",
                          isOpen && "rotate-180",
                        )}
                      />
                    </button>
                    <div className="mt-0.5 shrink-0">
                      {isComingSoon ? (
                        <Toggle
                          checked={false}
                          disabled
                          onCheckedChange={() => {}}
                          aria-label={t("Coming soon")}
                        />
                      ) : tool.toggleable ? (
                        <Toggle
                          checked={isEnabled}
                          disabled={pending.has(tool.name)}
                          onCheckedChange={() => void handleToggle(tool.name)}
                          aria-label={tool.name}
                        />
                      ) : (
                        <Badge
                          variant="default"
                          title={t(
                            "Auto-mounted by the agent when needed. Not user-toggleable.",
                          )}
                        >
                          <Lock size={11} />
                          {t("Always on")}
                        </Badge>
                      )}
                    </div>
                  </div>
                  {isOpen && (
                    <div className="space-y-4 border-t border-border bg-muted-subtle px-4 py-4 text-[13px] leading-relaxed">
                      {hints.when_to_use && (
                        <ToolField label={t("When to use")} body={hints.when_to_use} />
                      )}
                      {hints.input_format && (
                        <ToolField
                          label={t("Input format")}
                          body={hints.input_format}
                          mono
                        />
                      )}
                      {hints.guideline && (
                        <ToolField label={t("Guideline")} body={hints.guideline} />
                      )}
                      {hints.note && (
                        <ToolField label={t("Note")} body={hints.note} />
                      )}
                      {tool.parameters.length > 0 && (
                        <div>
                          <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                            {t("Parameters")}
                          </div>
                          <ul className="space-y-1.5">
                            {tool.parameters.map((p) => (
                              <li
                                key={p.name}
                                className="flex flex-wrap items-baseline gap-2"
                              >
                                <span className="font-mono text-xs text-foreground">
                                  {p.name}
                                </span>
                                <span className="text-[11px] text-muted-foreground">
                                  {p.type}
                                  {p.required ? "" : ` · ${t("optional")}`}
                                </span>
                                {p.description && (
                                  <span className="text-xs text-muted-foreground">
                                    — {p.description}
                                  </span>
                                )}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

function ToolField({
  label,
  body,
  mono,
}: {
  label: string;
  body: string;
  mono?: boolean;
}) {
  return (
    <div>
      <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <p
        className={cn(
          "whitespace-pre-wrap text-[13px] leading-relaxed text-foreground",
          mono && "font-mono",
        )}
      >
        {body}
      </p>
    </div>
  );
}
