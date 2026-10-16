"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Highlighter, WandSparkles, X } from "lucide-react";
import { Button, Select, Spinner, Textarea } from "@/components/ui";
import { apiFetch, apiUrl } from "@/lib/api";
import { listKnowledgeBases, type KnowledgeBaseSummary } from "@/lib/knowledge-api";
import {
  applyProposalHunkDecisions,
  buildProposalDiff,
  buildProposalHunks,
} from "@/lib/co-writer-diff";
import { recordCoWriterOperationDecision } from "@/lib/co-writer-api";
import {
  streamSelectionEdit,
  type SelectionEditMode,
} from "./edit-stream";

export interface TextSelection {
  start: number;
  end: number;
  text: string;
}

export interface EditProposal {
  kind: "edit" | "automark" | "selection";
  /** Replacement text — the full document for edit/automark, the selection replacement otherwise. */
  text: string;
  /** Document content the proposal was computed against. Accepting is refused if the draft changed since. */
  base: string;
  /** Document offsets of the edited selection (selection edits only). */
  range?: { start: number; end: number };
  operationId?: string;
}

interface AssistantPanelProps {
  documentId: string;
  getContent: () => string;
  selection: TextSelection | null;
  onClearSelection: () => void;
  /** Applies the proposal to the document. Returns false when the draft has diverged from `proposal.base`. */
  onApply: (proposal: EditProposal) => boolean;
  onClose: () => void;
  onAuditChanged?: () => void;
}

type EditAction = "rewrite" | "shorten" | "expand";
type SourceOption = "none" | "rag" | "web";

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await apiFetch(apiUrl(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(
      String(data?.detail || `Request failed (${res.status})`),
    );
  }
  return data as T;
}

export function AssistantPanel({
  documentId,
  getContent,
  selection,
  onClearSelection,
  onApply,
  onClose,
  onAuditChanged,
}: AssistantPanelProps) {
  const { t } = useTranslation();

  const [instruction, setInstruction] = useState("");
  const [mode, setMode] = useState<SelectionEditMode>("rewrite");
  const [source, setSource] = useState<SourceOption>("none");
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBaseSummary[]>(
    [],
  );
  const [kbName, setKbName] = useState("");

  const [running, setRunning] = useState<"edit" | "automark" | null>(null);
  const [error, setError] = useState("");
  const [streamedResponse, setStreamedResponse] = useState("");
  const [toolNames, setToolNames] = useState<string[]>([]);
  const [proposal, setProposal] = useState<EditProposal | null>(null);
  const [hunkDecisions, setHunkDecisions] = useState<
    Record<number, "accept" | "reject">
  >({});
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    listKnowledgeBases()
      .then((list) => {
        if (cancelled) return;
        setKnowledgeBases(list);
        const defaultKb =
          list.find((kb) => kb.is_default)?.name || list[0]?.name || "";
        setKbName((prev) => prev || defaultKb);
      })
      .catch(() => {
        /* knowledge bases are optional for co-writer */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  const targetingSelection = selection !== null;

  const handleEdit = useCallback(async () => {
    if (running) return;
    const content = getContent();
    const trimmedInstruction = instruction.trim();

    if (targetingSelection && selection) {
      if (mode === "none" && !trimmedInstruction) {
        setError(t("Enter an instruction or choose a mode."));
        return;
      }
    } else {
      if (!trimmedInstruction) {
        setError(t("Enter an editing instruction first."));
        return;
      }
      if (!content.trim()) {
        setError(t("Add some content before running an AI edit."));
        return;
      }
    }

    setRunning("edit");
    setError("");
    setProposal(null);
    setHunkDecisions({});
    setStreamedResponse("");
    setToolNames([]);

    try {
      if (targetingSelection && selection) {
        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;
        const editResult = await streamSelectionEdit(
          {
            selected_text: selection.text,
            instruction: trimmedInstruction,
            mode,
            tools: source === "none" ? [] : [source],
            kb_name: source === "rag" ? kbName || null : null,
            document_id: documentId,
          },
          {
            signal: controller.signal,
            onTrace: (event) => {
              if (event.type === "tool_call" && event.content) {
                setToolNames((prev) => [...prev, String(event.content)]);
              }
              if (event.type === "content" && event.stage === "responding") {
                setStreamedResponse(
                  (prev) => `${prev}${event.content ?? ""}`,
                );
              }
            },
          },
        );
        setProposal({
          kind: "selection",
          text: editResult.editedText,
          base: content,
          range: { start: selection.start, end: selection.end },
          operationId: editResult.operationId,
        });
      } else {
        const data = await postJson<{ edited_text?: string; operation_id?: string }>(
          "/api/v1/co_writer/edit",
          {
            text: content,
            instruction: trimmedInstruction,
            action: mode === "none" ? "rewrite" : (mode as EditAction),
            source: source === "none" ? null : source,
            kb_name: source === "rag" ? kbName || null : null,
            document_id: documentId,
          },
        );
        setProposal({
          kind: "edit",
          text: data.edited_text ?? "",
          base: content,
          operationId: data.operation_id,
        });
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(
        err instanceof Error ? err.message : t("Failed to edit document."),
      );
    } finally {
      abortRef.current = null;
      setRunning(null);
    }
  }, [
    running,
    getContent,
    instruction,
    targetingSelection,
    selection,
    mode,
    source,
    kbName,
    documentId,
    t,
  ]);

  const handleAutoMark = useCallback(async () => {
    if (running) return;
    const content = getContent();
    if (!content.trim()) {
      setError(t("Add some content before running auto-mark."));
      return;
    }
    setRunning("automark");
    setError("");
    setProposal(null);
    setHunkDecisions({});
    try {
      const data = await postJson<{ marked_text?: string; operation_id?: string }>(
        "/api/v1/co_writer/automark",
        { text: content, document_id: documentId },
      );
      setProposal({ kind: "automark", text: data.marked_text ?? "", base: content, operationId: data.operation_id });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("Failed to auto-mark document."),
      );
    } finally {
      setRunning(null);
    }
  }, [running, getContent, documentId, t]);

  const handleAccept = useCallback(() => {
    if (!proposal) return;
    if (onApply(proposal)) {
      if (proposal.operationId) {
        void recordCoWriterOperationDecision(proposal.operationId, {
          decision: "accepted",
          appliedText: proposal.text,
        }).then(onAuditChanged).catch(() => undefined);
      }
      setProposal(null);
      setStreamedResponse("");
      setToolNames([]);
    } else {
      setError(
        t("The draft changed while the AI edit was running. Please try again."),
      );
      setProposal(null);
    }
  }, [proposal, onApply, onAuditChanged, t]);

  const proposalTitle =
    proposal?.kind === "automark"
      ? t("Auto-mark result")
      : proposal?.kind === "selection"
        ? t("Suggested selection edit")
        : t("Suggested edit");
  const proposalDiff = useMemo(() => {
    if (!proposal) return [];
    const before = proposal.kind === "selection" && proposal.range
      ? proposal.base.slice(proposal.range.start, proposal.range.end)
      : proposal.base;
    return buildProposalDiff(before, proposal.text);
  }, [proposal]);
  const proposalHunks = useMemo(() => {
    if (!proposal) return [];
    const before = proposal.kind === "selection" && proposal.range
      ? proposal.base.slice(proposal.range.start, proposal.range.end)
      : proposal.base;
    return buildProposalHunks(before, proposal.text);
  }, [proposal]);

  const handleApplySelected = useCallback(() => {
    if (!proposal) return;
    const before = proposal.kind === "selection" && proposal.range
      ? proposal.base.slice(proposal.range.start, proposal.range.end)
      : proposal.base;
    const accepted = Object.fromEntries(
      Object.entries(hunkDecisions).map(([id, decision]) => [
        Number(id),
        decision === "accept",
      ]),
    );
    const partialText = applyProposalHunkDecisions(before, proposal.text, accepted);
    if (onApply({ ...proposal, text: partialText })) {
      if (proposal.operationId) {
        void recordCoWriterOperationDecision(proposal.operationId, {
          decision: "accepted",
          appliedText: partialText,
          partial: true,
        }).then(onAuditChanged).catch(() => undefined);
      }
      setProposal(null);
      setHunkDecisions({});
      setStreamedResponse("");
      setToolNames([]);
    } else {
      setError(t("The draft changed while the AI edit was running. Please try again."));
      setProposal(null);
      setHunkDecisions({});
    }
  }, [hunkDecisions, onApply, onAuditChanged, proposal, t]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <WandSparkles size={15} className="text-primary" aria-hidden="true" />
          {t("AI assistant")}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={onClose}
          aria-label={t("Close assistant panel")}
        >
          <X size={15} />
        </Button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {targetingSelection && selection ? (
          <div
            data-testid="co-writer-selection-target"
            className="rounded-lg border border-primary-border bg-primary-muted p-3"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-1.5 text-xs font-medium text-accent-foreground">
                <Highlighter size={13} aria-hidden="true" />
                {t("AI editing target")}
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={onClearSelection}
              >
                {t("Clear selection")}
              </Button>
            </div>
            <blockquote className="mt-2 line-clamp-4 whitespace-pre-wrap border-l-2 border-primary pl-2 text-xs leading-relaxed text-foreground">
              {selection.text.trim()}
            </blockquote>
            <div className="mt-2 text-[11px] text-muted-foreground">
              {t("{{count}} characters selected", {
                count: selection.text.length,
              })}
            </div>
          </div>
        ) : (
          <div className="text-xs text-muted-foreground">
            {t("Editing the full draft. Select text in the editor to target a passage.")}
          </div>
        )}

        <div>
          <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
            {t("Instruction")}
          </label>
          <Textarea
            autoResize
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            placeholder={t("Tell the AI how to improve the text…")}
            aria-label={t("Instruction")}
            className="min-h-[64px]"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              {t("Mode")}
            </label>
            <Select
              value={mode}
              onChange={(event) =>
                setMode(event.target.value as SelectionEditMode)
              }
            >
              {targetingSelection && (
                <option value="none">{t("Instruction only")}</option>
              )}
              <option value="rewrite">{t("Rewrite")}</option>
              <option value="shorten">{t("Shorten")}</option>
              <option value="expand">{t("Expand")}</option>
            </Select>
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              {t("Source")}
            </label>
            <Select
              value={source}
              onChange={(event) => setSource(event.target.value as SourceOption)}
            >
              <option value="none">{t("None")}</option>
              <option value="rag">{t("Knowledge base")}</option>
              <option value="web">{t("Web search")}</option>
            </Select>
          </div>
        </div>

        {source === "rag" && (
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              {t("Knowledge base")}
            </label>
            <Select
              value={kbName}
              onChange={(event) => setKbName(event.target.value)}
            >
              {knowledgeBases.length === 0 && (
                <option value="">{t("No knowledge bases available")}</option>
              )}
              {knowledgeBases.map((kb) => (
                <option key={kb.name} value={kb.name}>
                  {kb.name}
                </option>
              ))}
            </Select>
          </div>
        )}

        {error && <p className="text-xs text-destructive">{error}</p>}

        {(running === "edit" || streamedResponse || toolNames.length > 0) &&
          !proposal && (
            <div className="rounded-lg border border-border bg-muted-subtle p-3">
              {running === "edit" && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Spinner className="h-3.5 w-3.5" />
                  {t("AI is working…")}
                </div>
              )}
              {toolNames.length > 0 && (
                <div className="mt-2 space-y-1">
                  {toolNames.map((name, index) => (
                    <div
                      key={`${name}-${index}`}
                      className="text-xs text-muted-foreground"
                    >
                      {t("Using tool: {{name}}", { name })}
                    </div>
                  ))}
                </div>
              )}
              {streamedResponse && (
                <p className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed text-foreground">
                  {streamedResponse}
                </p>
              )}
            </div>
          )}

        {proposal && (
          <div className="rounded-lg border border-border bg-muted-subtle p-3">
            <div className="text-xs font-medium text-foreground">
              {proposalTitle}
            </div>
            <div
              className="mt-2 max-h-72 overflow-auto rounded-md border border-border bg-card font-mono text-[11px] leading-relaxed"
              aria-label={t("Proposed changes")}
            >
              {proposalDiff.map((line, index) => (
                <div
                  key={`${line.kind}-${index}`}
                  className={line.kind === "add"
                    ? "bg-success-muted text-foreground"
                    : line.kind === "remove"
                      ? "bg-destructive-muted text-foreground line-through"
                      : "text-muted-foreground"}
                >
                  <span className="inline-block w-6 select-none text-center opacity-70">
                    {line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " "}
                  </span>
                  <span className="whitespace-pre-wrap break-words">{line.text || " "}</span>
                </div>
              ))}
            </div>
            {proposalHunks.length > 1 && (
              <div className="mt-3 space-y-2" data-testid="co-writer-proposal-hunks">
                {proposalHunks.map((hunk) => (
                  <div key={hunk.id} className="rounded-md border border-border bg-card p-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] font-medium text-muted-foreground">
                        {t("Change {{number}}", { number: hunk.id + 1 })}
                      </span>
                      <div className="flex items-center gap-1">
                        <Button
                          size="sm"
                          variant={hunkDecisions[hunk.id] === "accept" ? "primary" : "outline"}
                          className="h-7 px-2 text-xs"
                          onClick={() => setHunkDecisions((current) => ({ ...current, [hunk.id]: "accept" }))}
                        >
                          <Check size={12} /> {t("Accept change")}
                        </Button>
                        <Button
                          size="sm"
                          variant={hunkDecisions[hunk.id] === "reject" ? "secondary" : "outline"}
                          className="h-7 px-2 text-xs"
                          onClick={() => setHunkDecisions((current) => ({ ...current, [hunk.id]: "reject" }))}
                        >
                          <X size={12} /> {t("Reject change")}
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={handleAccept}>
                <Check size={13} />
                {proposalHunks.length > 1 ? t("Accept all") : t("Accept")}
              </Button>
              {proposalHunks.length > 1 && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleApplySelected}
                  disabled={!Object.values(hunkDecisions).includes("accept")}
                >
                  {t("Apply selected changes")}
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  if (proposal.operationId) {
                    void recordCoWriterOperationDecision(proposal.operationId, {
                      decision: "rejected",
                    }).then(onAuditChanged).catch(() => undefined);
                  }
                  setProposal(null);
                  setHunkDecisions({});
                }}
              >
                <X size={13} />
                {t("Reject")}
              </Button>
            </div>
          </div>
        )}
      </div>

      <div className="shrink-0 space-y-2 border-t border-border p-4">
        <Button
          className="w-full"
          onClick={() => void handleEdit()}
          loading={running === "edit"}
          disabled={running !== null}
        >
          <WandSparkles size={14} />
          {targetingSelection ? t("Edit selection") : t("Edit full draft")}
        </Button>
        <Button
          className="w-full"
          variant="outline"
          onClick={() => void handleAutoMark()}
          loading={running === "automark"}
          disabled={running !== null || targetingSelection}
        >
          <Highlighter size={14} />
          {t("Auto-mark")}
        </Button>
      </div>
    </div>
  );
}
