"use client";

// Memory settings form — GET/PUT /api/v1/memory/settings.
// Sections: Update / Audit budgets, Dedup, Merge footnotes, Chunking,
// References. Ported from the previous frontend's settings/memory page;
// here it lives under /memory/settings as part of the memory workbench.

import { useCallback, useEffect, useState } from "react";
import { RotateCcw, Settings2, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  Button,
  Card,
  ConfirmDialog,
  Input,
  Select,
  Skeleton,
  Toggle,
  useToast,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import {
  getMemorySettings,
  getDeletedMemoryEntries,
  permanentlyDeleteMemoryEntry,
  putMemorySettings,
  restoreDeletedMemoryEntry,
  type DeletedMemoryEntry,
  type MemorySettings,
} from "./api";
import { MemorySubNav } from "./MemorySubNav";

export function MemorySettingsForm() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [settings, setSettings] = useState<MemorySettings | null>(null);
  const [snapshot, setSnapshot] = useState<MemorySettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleted, setDeleted] = useState<DeletedMemoryEntry[]>([]);
  const [trashLoading, setTrashLoading] = useState(true);
  const [trashAction, setTrashAction] = useState<string | null>(null);
  const [purgeTarget, setPurgeTarget] = useState<DeletedMemoryEntry | null>(null);

  useEffect(() => {
    let cancelled = false;
    getMemorySettings()
      .then((data) => {
        if (cancelled) return;
        setSettings(data);
        setSnapshot(data);
      })
      .catch((e) => {
        if (cancelled) return;
        toast({
          variant: "destructive",
          title: t("Failed to load memory settings"),
          description: e instanceof Error ? e.message : String(e),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [t, toast]);

  const loadTrash = useCallback(async () => {
    try {
      const result = await getDeletedMemoryEntries();
      setDeleted(result.items);
    } catch (e) {
      toast({
        variant: "destructive",
        title: t("Failed to load deleted memories"),
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setTrashLoading(false);
    }
  }, [t, toast]);

  useEffect(() => {
    let cancelled = false;
    getDeletedMemoryEntries()
      .then((result) => {
        if (!cancelled) setDeleted(result.items);
      })
      .catch((e) => {
        if (cancelled) return;
        toast({
          variant: "destructive",
          title: t("Failed to load deleted memories"),
          description: e instanceof Error ? e.message : String(e),
        });
      })
      .finally(() => {
        if (!cancelled) setTrashLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [t, toast]);

  const dirty =
    !!settings && !!snapshot && JSON.stringify(settings) !== JSON.stringify(snapshot);

  const save = useCallback(async () => {
    if (!settings) return;
    setSaving(true);
    try {
      const saved = await putMemorySettings(settings);
      setSettings(saved);
      setSnapshot(saved);
      toast({ variant: "success", title: t("Settings saved") });
    } catch (e) {
      toast({
        variant: "destructive",
        title: t("Failed to save memory settings"),
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSaving(false);
    }
  }, [settings, t, toast]);

  const restoreEntry = useCallback(
    async (item: DeletedMemoryEntry) => {
      setTrashAction(item.entry.id);
      try {
        await restoreDeletedMemoryEntry(item.layer, item.key, item.entry.id);
        await loadTrash();
        toast({ variant: "success", title: t("Memory restored") });
      } catch (e) {
        toast({
          variant: "destructive",
          title: t("Failed to restore memory"),
          description: e instanceof Error ? e.message : String(e),
        });
      } finally {
        setTrashAction(null);
      }
    },
    [loadTrash, t, toast],
  );

  const purgeEntry = useCallback(async () => {
    if (!purgeTarget) return;
    setTrashAction(purgeTarget.entry.id);
    try {
      await permanentlyDeleteMemoryEntry(
        purgeTarget.layer,
        purgeTarget.key,
        purgeTarget.entry.id,
      );
      setPurgeTarget(null);
      await loadTrash();
      toast({ variant: "success", title: t("Memory permanently deleted") });
    } catch (e) {
      toast({
        variant: "destructive",
        title: t("Failed to permanently delete memory"),
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setTrashAction(null);
    }
  }, [loadTrash, purgeTarget, t, toast]);

  function patch<K extends keyof MemorySettings>(
    key: K,
    value: Partial<MemorySettings[K]>,
  ) {
    if (!settings) return;
    setSettings({ ...settings, [key]: { ...settings[key], ...value } });
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <header className="mb-6">
        <h1 className="display flex items-center gap-2.5 text-2xl font-semibold text-foreground">
          <Settings2 size={22} className="text-primary" />
          {t("Memory settings")}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t(
            "Tune the chunk-based consolidator: how many LLM rounds per Update / Audit / Dedup, how aggressively to chunk, and how strictly to validate references.",
          )}
        </p>
        <div className="mt-4">
          <MemorySubNav />
        </div>
      </header>

      {!settings ? (
        <div className="space-y-4">
          {[0, 1, 2].map((i) => (
            <Card key={i} className="space-y-3 p-5">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </Card>
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          <SettingSection
            title={t("Memory collection")}
            description={t(
              "Control whether Cognivoy records new trace evidence and how long raw daily traces are retained.",
            )}
          >
            <ToggleRow
              label={t("Enable memory")}
              help={t("Disabling memory stops new automatic trace collection.")}
              value={settings.collection.enabled}
              onChange={(v) => patch("collection", { enabled: v })}
            />
            <ToggleRow
              label={t("Capture useful activity automatically")}
              help={t("Existing memories remain available when automatic capture is off.")}
              value={settings.collection.auto_capture}
              onChange={(v) => patch("collection", { auto_capture: v })}
            />
            <NumberRow
              label={t("Raw trace retention (days)")}
              help={t("Use 0 to keep raw trace evidence indefinitely.")}
              value={settings.collection.retention_days}
              onChange={(n) => patch("collection", { retention_days: n })}
              min={0}
              max={3650}
            />
          </SettingSection>

          <SettingSection
            title={t("Automatic memory synthesis")}
            description={t(
              "Optionally consolidate L1 into L2 and then L3 in the background. It is off by default because synthesis can call your configured language model.",
            )}
          >
            <ToggleRow
              label={t("Enable automatic synthesis")}
              help={t("Manual Update, Audit and Dedup remain available when this is off.")}
              value={settings.automation.enabled}
              onChange={(v) => patch("automation", { enabled: v })}
            />
            <NumberRow
              label={t("Check interval (minutes)")}
              value={settings.automation.interval_minutes}
              onChange={(n) => patch("automation", { interval_minutes: n })}
              min={1}
              max={1440}
            />
            <NumberRow
              label={t("Minimum pending items")}
              help={t("A document is synthesized only after its versioned backlog reaches this number.")}
              value={settings.automation.min_backlog}
              onChange={(n) => patch("automation", { min_backlog: n })}
              min={1}
              max={10000}
            />
            <NumberRow
              label={t("Automatic retries")}
              value={settings.automation.max_retries}
              onChange={(n) => patch("automation", { max_retries: n })}
              min={0}
              max={10}
            />
            <NumberRow
              label={t("Retry delay (seconds)")}
              value={settings.automation.retry_delay_seconds}
              onChange={(n) => patch("automation", { retry_delay_seconds: n })}
              min={1}
              max={3600}
            />
          </SettingSection>

          <SettingSection
            title={t("Partner memory access")}
            description={t(
              "Partners can keep isolated notes while access to your shared long-term memory remains under your control.",
            )}
          >
            <ToggleRow
              label={t("Allow partners to read shared owner memory")}
              value={settings.partner.shared_owner_read}
              onChange={(v) => patch("partner", { shared_owner_read: v })}
            />
            <ToggleRow
              label={t("Allow partners to write their private memory")}
              help={t("Partners never write to the owner's memory scope.")}
              value={settings.partner.private_partner_write}
              onChange={(v) => patch("partner", { private_partner_write: v })}
            />
          </SettingSection>

          <SettingSection
            title={t("Update mode")}
            description={t(
              "Default LLM rounds for chunk-based incremental fact extraction. Per-doc overrides live in the workbench.",
            )}
          >
            <NumberRow
              label={t("L2 budget (per surface)")}
              help={t("Maximum chunks the chunker emits for an L2 update.")}
              value={settings.update.l2_budget}
              onChange={(n) => patch("update", { l2_budget: n })}
              min={1}
              max={200}
            />
            <NumberRow
              label={t("L3 budget (per slot)")}
              help={t("Maximum chunks for an L3 update across the 7 L2 docs.")}
              value={settings.update.l3_budget}
              onChange={(n) => patch("update", { l3_budget: n })}
              min={1}
              max={200}
            />
          </SettingSection>

          <SettingSection
            title={t("Audit mode")}
            description={t(
              "Default LLM rounds for line-level edits against raw evidence.",
            )}
          >
            <NumberRow
              label={t("L2 budget (per surface)")}
              value={settings.audit.l2_budget}
              onChange={(n) => patch("audit", { l2_budget: n })}
              min={1}
              max={200}
            />
            <NumberRow
              label={t("L3 budget (per slot)")}
              value={settings.audit.l3_budget}
              onChange={(n) => patch("audit", { l3_budget: n })}
              min={1}
              max={200}
            />
          </SettingSection>

          <SettingSection
            title={t("Dedup")}
            description={t(
              "Iterative dedup over the full doc. Stops early when an iteration emits zero edits.",
            )}
          >
            <NumberRow
              label={t("Iterations")}
              value={settings.dedup.iterations}
              onChange={(n) => patch("dedup", { iterations: n })}
              min={1}
              max={20}
            />
            <ToggleRow
              label={t("Run dedup automatically after Update")}
              value={settings.dedup.auto_after_update}
              onChange={(v) => patch("dedup", { auto_after_update: v })}
            />
          </SettingSection>

          <SettingSection
            title={t("Merge footnotes")}
            description={t(
              "No-LLM consolidation: collapse duplicate ref rows into one footnote each, then renumber. Idempotent, safe to run any time.",
            )}
          >
            <ToggleRow
              label={t("Merge automatically after Update")}
              value={settings.merge.auto_after_update}
              onChange={(v) => patch("merge", { auto_after_update: v })}
            />
            <ToggleRow
              label={t("Merge automatically after Audit")}
              value={settings.merge.auto_after_audit}
              onChange={(v) => patch("merge", { auto_after_audit: v })}
            />
            <ToggleRow
              label={t("Merge automatically after Dedup")}
              value={settings.merge.auto_after_dedup}
              onChange={(v) => patch("merge", { auto_after_dedup: v })}
            />
          </SettingSection>

          <SettingSection
            title={t("Chunking")}
            description={t("Lower-level knobs that shape how content is split.")}
          >
            <NumberRow
              label={t("Overlap ratio")}
              help={t("Fraction of chunk size carried into the next chunk. 0–0.5.")}
              value={settings.chunking.overlap_ratio}
              onChange={(n) => patch("chunking", { overlap_ratio: n })}
              min={0}
              max={0.5}
              step={0.05}
              isFloat
            />
            <SelectRow
              label={t("Boundary")}
              help={t("Where the chunker prefers to cut.")}
              value={settings.chunking.boundary}
              options={[
                { value: "paragraph", label: t("Paragraph") },
                { value: "sentence", label: t("Sentence") },
              ]}
              onChange={(v) =>
                patch("chunking", { boundary: v as "paragraph" | "sentence" })
              }
            />
            <NumberRow
              label={t("Min chunk chars")}
              help={t("Floor for individual chunk size.")}
              value={settings.chunking.min_chunk_chars}
              onChange={(n) => patch("chunking", { min_chunk_chars: n })}
              min={200}
              max={64000}
              step={100}
            />
            <NumberRow
              label={t("Max chunk chars")}
              help={t("Ceiling for individual chunk size.")}
              value={settings.chunking.max_chunk_chars}
              onChange={(n) => patch("chunking", { max_chunk_chars: n })}
              min={200}
              max={64000}
              step={100}
            />
          </SettingSection>

          <SettingSection
            title={t("References")}
            description={t(
              "How strictly facts must cite the chunk they were extracted from.",
            )}
          >
            <ToggleRow
              label={t("Require ref on every fact")}
              help={t("Drops facts that come back without a ref.")}
              value={settings.reference.enforce_required}
              onChange={(v) => patch("reference", { enforce_required: v })}
            />
            <ToggleRow
              label={t("Drop invalid refs (vs reject the whole fact)")}
              help={t(
                "On: keep the fact, drop only out-of-pool refs. Off: any bad ref rejects the fact.",
              )}
              value={settings.reference.drop_invalid_refs}
              onChange={(v) => patch("reference", { drop_invalid_refs: v })}
            />
          </SettingSection>

          <Card data-memory-trash="true">
            <div className="border-b border-border px-5 py-3.5">
              <h2 className="display text-sm font-medium text-foreground">
                {t("Recently deleted")}
              </h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t(
                  "Deleted memory entries stay recoverable until you permanently remove them.",
                )}
              </p>
            </div>
            {trashLoading ? (
              <div className="space-y-2 p-5">
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-16 w-full" />
              </div>
            ) : deleted.length === 0 ? (
              <p className="px-5 py-6 text-sm text-muted-foreground">
                {t("No recently deleted memories.")}
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {deleted.map((item) => (
                  <li key={`${item.layer}:${item.key}:${item.entry.id}`} className="px-5 py-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                          <span>{item.layer} · {item.key} · {item.entry.section}</span>
                          <span>{formatDeletedAt(item.deleted_at)}</span>
                        </div>
                        <p className="mt-1 line-clamp-2 text-[13px] leading-relaxed text-foreground">
                          {item.entry.text}
                        </p>
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          {t("{{count}} evidence references", { count: item.entry.refs.length })}
                        </p>
                      </div>
                      <div className="flex shrink-0 gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          loading={trashAction === item.entry.id && purgeTarget === null}
                          onClick={() => void restoreEntry(item)}
                        >
                          <RotateCcw size={13} />
                          {t("Restore")}
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => setPurgeTarget(item)}
                        >
                          <Trash2 size={13} />
                          {t("Delete forever")}
                        </Button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <div className="sticky bottom-4 flex justify-end">
            <Button
              onClick={() => void save()}
              disabled={!dirty}
              loading={saving}
            >
              {t("Save changes")}
            </Button>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={purgeTarget !== null}
        onClose={() => {
          if (!trashAction) setPurgeTarget(null);
        }}
        onConfirm={() => void purgeEntry()}
        title={t("Permanently delete this memory?")}
        description={t(
          "This removes the entry and its evidence links from the recovery area. This action cannot be undone.",
        )}
        confirmText={t("Delete forever")}
        destructive
        loading={Boolean(purgeTarget && trashAction === purgeTarget.entry.id)}
      />
    </div>
  );
}

function formatDeletedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

// ── Field components ─────────────────────────────────────────────────

function SettingSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <div className="border-b border-border px-5 py-3.5">
        <h2 className="display text-sm font-medium text-foreground">{title}</h2>
        {description && (
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
        )}
      </div>
      <div className="divide-y divide-border">{children}</div>
    </Card>
  );
}

function SettingRow({
  label,
  help,
  control,
}: {
  label: string;
  help?: string;
  control: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-3">
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-foreground">{label}</div>
        {help && (
          <div className="mt-0.5 text-xs text-muted-foreground">{help}</div>
        )}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

interface NumberRowProps {
  label: string;
  help?: string;
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
  step?: number;
  isFloat?: boolean;
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
}: NumberRowProps) {
  return (
    <SettingRow
      label={label}
      help={help}
      control={
        <Input
          type="number"
          aria-label={label}
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
          className="h-8 w-24 text-right text-xs"
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
      label={label}
      help={help}
      control={
        <Toggle checked={value} onCheckedChange={onChange} aria-label={label} />
      }
    />
  );
}

function SelectRow({
  label,
  help,
  value,
  options,
  onChange,
}: {
  label: string;
  help?: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <SettingRow
      label={label}
      help={help}
      control={
        <div className={cn("w-40")}>
          <Select
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="h-8 text-xs"
            aria-label={label}
          >
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </div>
      }
    />
  );
}
