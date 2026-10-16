"use client";

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Columns2, Download, Eye, FilePenLine, FileWarning, History, NotebookPen, PanelRight, PanelRightClose, RotateCcw, Save, Undo2 } from "lucide-react";
import { Button, EmptyState, Skeleton, Tooltip, useToast } from "@/components/ui";
import {
  CoWriterRevisionConflictError,
  CoWriterMergeConflictError,
  downloadCoWriterDocument,
  getCoWriterDocument,
  listCoWriterOperations,
  listCoWriterRevisions,
  mergeCoWriterDocument,
  restoreCoWriterRevision,
  type CoWriterDocumentRevision,
  type CoWriterOperation,
  updateCoWriterDocument,
} from "@/lib/co-writer-api";
import { notifyCoWriterChanged } from "@/lib/co-writer-events";
import { debounce } from "@/lib/debounce";
import {
  coWriterDraftKey,
  parseCoWriterDraft,
  serializeCoWriterDraft,
} from "@/lib/co-writer-draft";
import {
  AssistantPanel,
  type EditProposal,
  type TextSelection,
} from "@/components/co-writer/AssistantPanel";
import { cn } from "@/lib/utils";
import { SaveContentToNotebookDialog } from "@/components/chat/SaveMessageToNotebookDialog";

const AUTOSAVE_DEBOUNCE_MS = 1200;
const MarkdownPreview = dynamic(() => import("@/components/chat/Markdown"), {
  loading: () => <Skeleton className="h-48 w-full" />,
});

type SaveState = "saved" | "dirty" | "saving" | "offline" | "error";
type ViewMode = "edit" | "split" | "preview";

export default function CoWriterEditorPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const params = useParams<{ docId?: string | string[] }>();
  const docId = useMemo(() => {
    const raw = params?.docId;
    if (!raw) return "";
    return Array.isArray(raw) ? (raw[0] ?? "") : raw;
  }, [params]);

  const [isLoading, setIsLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [isOnline, setIsOnline] = useState(true);
  const [panelOpen, setPanelOpen] = useState(true);
  const [viewMode, setViewMode] = useState<ViewMode>("edit");
  const [selection, setSelection] = useState<TextSelection | null>(null);
  const [conflictRevision, setConflictRevision] = useState<number | null>(null);
  const [mergeConflictCount, setMergeConflictCount] = useState(0);
  const [canUndo, setCanUndo] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [revisionHistory, setRevisionHistory] = useState<CoWriterDocumentRevision[]>([]);
  const [operationHistory, setOperationHistory] = useState<CoWriterOperation[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [restoringRevision, setRestoringRevision] = useState<number | null>(null);
  const [saveToNotebookOpen, setSaveToNotebookOpen] = useState(false);
  const [saveToNotebookRevision, setSaveToNotebookRevision] = useState(1);
  const [exportingFormat, setExportingFormat] = useState<"markdown" | "docx" | "pdf" | null>(null);

  const contentRef = useRef("");
  const titleRef = useRef("");
  const savedContentRef = useRef("");
  const savedTitleRef = useRef("");
  const revisionRef = useRef(1);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const mountedRef = useRef(true);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const selectionBackdropRef = useRef<HTMLDivElement>(null);
  const undoContentRef = useRef<string | null>(null);
  const deferredContent = useDeferredValue(content);
  const localDraftKey = useMemo(
    () => (docId ? coWriterDraftKey(docId) : ""),
    [docId],
  );

  const writeRecoveryDraft = useCallback(() => {
    if (!docId || !localDraftKey || typeof window === "undefined") return;
    const serialized = serializeCoWriterDraft({
      documentId: docId,
      title: titleRef.current,
      content: contentRef.current,
      baseRevision: revisionRef.current,
      savedAt: Date.now(),
    });
    try {
      if (serialized) window.localStorage.setItem(localDraftKey, serialized);
    } catch {
      // Browser policy/quota failures must never block editing.
    }
  }, [docId, localDraftKey]);

  const clearRecoveryDraft = useCallback(() => {
    if (!localDraftKey || typeof window === "undefined") return;
    try {
      window.localStorage.removeItem(localDraftKey);
    } catch {
      // Non-fatal; a matching draft is ignored on the next load.
    }
  }, [localDraftKey]);

  useEffect(() => {
    mountedRef.current = true;
    setIsOnline(window.navigator.onLine);
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      mountedRef.current = false;
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  useEffect(() => {
    contentRef.current = content;
  }, [content]);

  // Load the document.
  useEffect(() => {
    if (!docId) return;
    let cancelled = false;
    setIsLoading(true);
    setNotFound(false);
    getCoWriterDocument(docId)
      .then((document) => {
        if (cancelled) return;
        const serverTitle = document.title || "";
        const serverContent = document.content ?? "";
        let localDraft: ReturnType<typeof parseCoWriterDraft> = null;
        try {
          localDraft = parseCoWriterDraft(
            window.localStorage.getItem(coWriterDraftKey(docId)),
            docId,
          );
        } catch {
          // Storage can be disabled by browser policy.
        }
        const hasRecovery = Boolean(
          localDraft &&
            (localDraft.title !== serverTitle || localDraft.content !== serverContent),
        );
        const nextTitle = hasRecovery ? localDraft!.title : serverTitle;
        const nextContent = hasRecovery ? localDraft!.content : serverContent;
        setTitle(nextTitle);
        titleRef.current = nextTitle;
        setContent(nextContent);
        contentRef.current = nextContent;
        savedContentRef.current = serverContent;
        savedTitleRef.current = serverTitle;
        revisionRef.current = document.revision || 1;
        setConflictRevision(null);
        setSaveState(hasRecovery ? "dirty" : "saved");
        if (hasRecovery) {
          toast({
            title: t("Recovered unsaved local draft."),
            description: t("Review it, then save to sync it with the server."),
            variant: "success",
          });
        } else {
          try {
            window.localStorage.removeItem(coWriterDraftKey(docId));
          } catch {
            // Storage is optional.
          }
        }
      })
      .catch((err) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("404")) {
          setNotFound(true);
        } else {
          toast({
            title: t("Failed to load document."),
            description: message,
            variant: "destructive",
          });
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [docId, t, toast]);

  const updateRevision = useCallback(
    async (payload: { title?: string | null; content?: string | null }) => {
      if (!docId) return null;
      const operation = saveQueueRef.current
        .catch(() => undefined)
        .then(() => updateCoWriterDocument(docId, {
          ...payload,
          expectedRevision: revisionRef.current,
        }))
        .then((updated) => {
          revisionRef.current = updated.revision;
          return updated;
        });
      // The queue itself always settles; the returned operation still rejects
      // so the initiating interaction can render a conflict or save error.
      saveQueueRef.current = operation.then(
        () => undefined,
        () => undefined,
      );
      return operation;
    },
    [docId],
  );

  const handleSaveError = useCallback(
    (err: unknown, fallbackTitle: string) => {
      if (!mountedRef.current) return;
      writeRecoveryDraft();
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        setIsOnline(false);
        setSaveState("offline");
        toast({
          title: t("Saved locally while offline."),
          description: t("Cognivoy will retry automatically when the connection returns."),
          variant: "success",
        });
        return;
      }
      setSaveState("error");
      if (err instanceof CoWriterRevisionConflictError) {
        setConflictRevision(err.currentRevision);
        toast({
          title: t("Document changed elsewhere."),
          description: t("Reload the latest version or keep this draft and overwrite it."),
          variant: "destructive",
        });
        return;
      }
      toast({
        title: fallbackTitle,
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    },
    [t, toast, writeRecoveryDraft],
  );

  const persistContent = useCallback(
    async (value: string) => {
      if (!docId) return;
      if (value !== contentRef.current) return;
      if (mountedRef.current) setSaveState("saving");
      try {
        await updateRevision({ content: value });
        savedContentRef.current = value;
        if (!mountedRef.current) return;
        setSaveState(
          contentRef.current === value &&
            titleRef.current.trim() === savedTitleRef.current.trim()
            ? "saved"
            : "dirty",
        );
        if (
          contentRef.current === value &&
          titleRef.current.trim() === savedTitleRef.current.trim()
        ) {
          clearRecoveryDraft();
        }
        notifyCoWriterChanged();
      } catch (err) {
        handleSaveError(err, t("Failed to save changes."));
      }
    },
    [clearRecoveryDraft, docId, handleSaveError, t, updateRevision],
  );

  const scheduleSaveRef = useRef<(value: string) => void>(() => {});

  useEffect(() => {
    scheduleSaveRef.current = debounce(
      (value: string) => void persistContent(value),
      AUTOSAVE_DEBOUNCE_MS,
    );
  }, [persistContent]);

  const handleContentChange = useCallback(
    (value: string) => {
      setContent(value);
      contentRef.current = value;
      setSelection(null);
      setSaveState("dirty");
      writeRecoveryDraft();
      scheduleSaveRef.current(value);
    },
    [writeRecoveryDraft],
  );

  // Best-effort flush when leaving the page before the debounce fires.
  useEffect(
    () => () => {
      const pendingContent = contentRef.current;
      const pendingTitle = titleRef.current.trim();
      if (
        docId &&
        (pendingContent !== savedContentRef.current ||
          pendingTitle !== savedTitleRef.current.trim())
      ) {
        writeRecoveryDraft();
        savedContentRef.current = pendingContent;
        savedTitleRef.current = pendingTitle;
        void updateRevision({
          title: pendingTitle,
          content: pendingContent,
        })
          .then(() => notifyCoWriterChanged())
          .catch(() => {
            /* the next visit reloads from the server */
          });
      }
    },
    [docId, updateRevision, writeRecoveryDraft],
  );

  const commitTitle = useCallback(
    async (nextTitle: string) => {
      if (!docId) return;
      const next = nextTitle.trim();
      if (next === savedTitleRef.current.trim()) return;
      setSaveState("saving");
      try {
        const updated = await updateRevision({ title: next });
        if (!updated) return;
        if (!mountedRef.current) return;
        setTitle(updated.title || "");
        titleRef.current = updated.title || "";
        savedTitleRef.current = updated.title || "";
        setSaveState(
          contentRef.current === savedContentRef.current ? "saved" : "dirty",
        );
        if (contentRef.current === savedContentRef.current) clearRecoveryDraft();
        notifyCoWriterChanged();
      } catch (err) {
        handleSaveError(err, t("Failed to save title."));
      }
    },
    [clearRecoveryDraft, docId, handleSaveError, t, updateRevision],
  );

  const saveNow = useCallback(async () => {
    if (!docId || saveState === "saving") return false;
    const nextTitle = titleRef.current.trim();
    const nextContent = contentRef.current;
    setSaveState("saving");
    try {
      const updated = await updateRevision({
        title: nextTitle,
        content: nextContent,
      });
      if (!updated) return false;
      if (!mountedRef.current) return true;
      const savedTitle = updated.title || "";
      const savedContent = updated.content ?? "";
      setTitle(savedTitle);
      titleRef.current = savedTitle;
      savedTitleRef.current = savedTitle;
      savedContentRef.current = savedContent;
      setSaveState(
        contentRef.current === savedContent &&
          titleRef.current.trim() === savedTitle.trim()
          ? "saved"
          : "dirty",
      );
      if (
        contentRef.current === savedContent &&
        titleRef.current.trim() === savedTitle.trim()
      ) {
        clearRecoveryDraft();
      }
      notifyCoWriterChanged();
      setConflictRevision(null);
      toast({ title: t("Document saved."), variant: "success" });
      return true;
    } catch (err) {
      handleSaveError(err, t("Failed to save changes."));
      return false;
    }
  }, [clearRecoveryDraft, docId, handleSaveError, saveState, t, toast, updateRevision]);

  useEffect(() => {
    if (!isOnline || isLoading || saveState !== "offline") return;
    const timer = window.setTimeout(() => {
      setSaveState("dirty");
      void saveNow();
    }, 100);
    return () => window.clearTimeout(timer);
  }, [isLoading, isOnline, saveNow, saveState]);

  const exportDocument = useCallback(async (format: "markdown" | "docx" | "pdf") => {
    if (!docId || exportingFormat) return;
    if (saveState !== "saved" && !(await saveNow())) return;
    setExportingFormat(format);
    try {
      const { blob, filename } = await downloadCoWriterDocument(docId, format);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      toast({ title: t("Document export ready."), variant: "success" });
    } catch (err) {
      toast({
        title: t("Failed to export document."),
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setExportingFormat(null);
    }
  }, [docId, exportingFormat, saveNow, saveState, t, toast]);

  const reloadLatest = useCallback(async () => {
    if (!docId) return;
    setSaveState("saving");
    try {
      const latest = await getCoWriterDocument(docId);
      setTitle(latest.title || "");
      titleRef.current = latest.title || "";
      savedTitleRef.current = latest.title || "";
      setContent(latest.content ?? "");
      contentRef.current = latest.content ?? "";
      savedContentRef.current = latest.content ?? "";
      revisionRef.current = latest.revision || 1;
      setConflictRevision(null);
      setSelection(null);
      setSaveState("saved");
      clearRecoveryDraft();
      toast({ title: t("Latest version loaded."), variant: "success" });
    } catch (err) {
      handleSaveError(err, t("Failed to load document."));
    }
  }, [clearRecoveryDraft, docId, handleSaveError, t, toast]);

  const keepLocalDraft = useCallback(() => {
    if (!conflictRevision) return;
    revisionRef.current = conflictRevision;
    setConflictRevision(null);
    setSaveState("dirty");
    void saveNow();
  }, [conflictRevision, saveNow]);

  const mergeWithLatest = useCallback(async () => {
    if (!docId || !conflictRevision) return;
    setSaveState("saving");
    try {
      const merged = await mergeCoWriterDocument(docId, {
        baseRevision: revisionRef.current,
        expectedCurrentRevision: conflictRevision,
        localTitle: titleRef.current,
        localContent: contentRef.current,
      });
      setTitle(merged.title || "");
      titleRef.current = merged.title || "";
      savedTitleRef.current = merged.title || "";
      setContent(merged.content ?? "");
      contentRef.current = merged.content ?? "";
      savedContentRef.current = merged.content ?? "";
      revisionRef.current = merged.revision;
      setConflictRevision(null);
      setMergeConflictCount(0);
      setSaveState("saved");
      clearRecoveryDraft();
      notifyCoWriterChanged();
      toast({ title: t("Local and remote changes merged."), variant: "success" });
    } catch (error) {
      setSaveState("error");
      if (error instanceof CoWriterMergeConflictError) {
        setMergeConflictCount(error.conflicts.length);
        toast({
          title: t("Some changes need manual review."),
          description: t("{{count}} overlapping changes could not be merged automatically.", { count: error.conflicts.length }),
          variant: "destructive",
        });
        return;
      }
      handleSaveError(error, t("Failed to merge document changes."));
    }
  }, [clearRecoveryDraft, conflictRevision, docId, handleSaveError, t, toast]);

  const loadRevisionHistory = useCallback(async () => {
    if (!docId) return;
    setLoadingHistory(true);
    try {
      const [revisions, operations] = await Promise.all([
        listCoWriterRevisions(docId),
        listCoWriterOperations(docId),
      ]);
      setRevisionHistory(revisions);
      setOperationHistory(operations);
    } catch (err) {
      toast({
        title: t("Failed to load version history."),
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setLoadingHistory(false);
    }
  }, [docId, t, toast]);

  const toggleRevisionHistory = useCallback(() => {
    setHistoryOpen((open) => {
      if (!open) void loadRevisionHistory();
      return !open;
    });
  }, [loadRevisionHistory]);

  const restoreRevision = useCallback(async (revision: number) => {
    if (!docId || saveState !== "saved") return;
    setRestoringRevision(revision);
    try {
      const restored = await restoreCoWriterRevision(
        docId,
        revision,
        revisionRef.current,
      );
      setTitle(restored.title || "");
      titleRef.current = restored.title || "";
      savedTitleRef.current = restored.title || "";
      setContent(restored.content ?? "");
      contentRef.current = restored.content ?? "";
      savedContentRef.current = restored.content ?? "";
      revisionRef.current = restored.revision;
      setSelection(null);
      setCanUndo(false);
      undoContentRef.current = null;
      clearRecoveryDraft();
      await loadRevisionHistory();
      notifyCoWriterChanged();
      toast({ title: t("Version restored."), variant: "success" });
    } catch (err) {
      handleSaveError(err, t("Failed to restore version."));
    } finally {
      setRestoringRevision(null);
    }
  }, [clearRecoveryDraft, docId, handleSaveError, loadRevisionHistory, saveState, t, toast]);

  useEffect(() => {
    const handleSaveShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveNow();
      }
    };
    window.addEventListener("keydown", handleSaveShortcut);
    return () => window.removeEventListener("keydown", handleSaveShortcut);
  }, [saveNow]);

  const handleSelect = useCallback(
    (event: React.SyntheticEvent<HTMLTextAreaElement>) => {
      const target = event.currentTarget;
      const start = target.selectionStart;
      const end = target.selectionEnd;
      if (start === end) {
        setSelection(null);
        return;
      }
      const text = target.value.slice(start, end);
      if (!text.trim()) {
        setSelection(null);
        return;
      }
      setSelection({ start, end, text });
    },
    [],
  );

  const clearSelection = useCallback(() => {
    const caret = selection?.end ?? editorRef.current?.selectionEnd ?? 0;
    editorRef.current?.setSelectionRange(caret, caret);
    setSelection(null);
  }, [selection]);

  const closeAssistantAndRestoreTarget = useCallback(() => {
    setPanelOpen(false);
    window.requestAnimationFrame(() => {
      const editor = editorRef.current;
      if (!editor) return;
      editor.focus({ preventScroll: true });
      if (selection) {
        editor.setSelectionRange(selection.start, selection.end);
        const prefixLines = contentRef.current.slice(0, selection.start).split("\n").length;
        const totalLines = Math.max(1, contentRef.current.split("\n").length);
        editor.scrollTop = Math.max(
          0,
          (prefixLines / totalLines) * editor.scrollHeight - editor.clientHeight / 3,
        );
        if (selectionBackdropRef.current) {
          selectionBackdropRef.current.scrollTop = editor.scrollTop;
        }
      }
    });
  }, [selection]);

  useEffect(() => {
    if (!panelOpen || typeof window === "undefined") return;
    const mobile = window.matchMedia("(max-width: 639px)").matches;
    const previousOverflow = document.body.style.overflow;
    if (mobile) document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeAssistantAndRestoreTarget();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      if (mobile) document.body.style.overflow = previousOverflow;
    };
  }, [closeAssistantAndRestoreTarget, panelOpen]);

  const handleEditorScroll = useCallback(
    (event: React.UIEvent<HTMLTextAreaElement>) => {
      if (!selectionBackdropRef.current) return;
      selectionBackdropRef.current.scrollTop = event.currentTarget.scrollTop;
      selectionBackdropRef.current.scrollLeft = event.currentTarget.scrollLeft;
    },
    [],
  );

  const handleApplyProposal = useCallback(
    (proposal: EditProposal): boolean => {
      const current = contentRef.current;
      if (current !== proposal.base) return false;
      let next: string;
      if (proposal.kind === "selection" && proposal.range) {
        next = `${current.slice(0, proposal.range.start)}${proposal.text}${current.slice(proposal.range.end)}`;
      } else {
        next = proposal.text;
      }
      undoContentRef.current = current;
      setCanUndo(true);
      handleContentChange(next);
      setSelection(null);
      toast({ title: t("AI edit applied."), variant: "success" });
      return true;
    },
    [handleContentChange, t, toast],
  );

  const getContent = useCallback(() => contentRef.current, []);

  const undoAiEdit = useCallback(() => {
    const previous = undoContentRef.current;
    if (previous === null) return;
    undoContentRef.current = null;
    setCanUndo(false);
    handleContentChange(previous);
    toast({ title: t("AI edit undone."), variant: "success" });
  }, [handleContentChange, t, toast]);

  const wordCount = useMemo(() => {
    const trimmed = content.trim();
    if (!trimmed) return 0;
    // CJK has no word-delimiting spaces: count each CJK char as one word,
    // then whitespace-split whatever remains.
    const cjkPattern = /[一-鿿㐀-䶿぀-ヿ가-힯]/g;
    const cjkCount = trimmed.match(cjkPattern)?.length ?? 0;
    const latinWords = trimmed
      .replace(cjkPattern, " ")
      .split(/\s+/)
      .filter(Boolean).length;
    return cjkCount + latinWords;
  }, [content]);

  const saveLabel =
    saveState === "saving"
      ? t("Saving…")
      : saveState === "offline"
        ? t("Saved locally · waiting for connection")
      : saveState === "error"
        ? t("Save failed")
        : saveState === "dirty"
          ? t("Unsaved changes")
          : t("Saved");

  if (notFound) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-6">
        <EmptyState
          icon={FileWarning}
          title={t("Document not found")}
          description={t("It may have been deleted, or the link is wrong.")}
          action={
            <Link href="/co-writer">
              <Button variant="outline">
                <ArrowLeft size={14} />
                {t("Back to Co-Writer")}
              </Button>
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col bg-background">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3">
        <Tooltip content={t("Back to Co-Writer")}>
          <Link href="/co-writer">
            <Button variant="ghost" size="icon" aria-label={t("Back to Co-Writer")}>
              <ArrowLeft size={16} />
            </Button>
          </Link>
        </Tooltip>
        <div className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {title || t("Untitled document")}
        </div>
        {!isLoading && (
          <span
            className={`shrink-0 text-xs ${
              saveState === "error" || saveState === "offline"
                ? "text-destructive"
                : "text-muted-foreground"
            }`}
            role="status"
          >
            {saveLabel}
          </span>
        )}
        {!isLoading && canUndo && (
          <Tooltip content={t("Undo last AI edit")}>
            <Button
              variant="ghost"
              size="icon"
              onClick={undoAiEdit}
              aria-label={t("Undo last AI edit")}
            >
              <Undo2 size={15} />
            </Button>
          </Tooltip>
        )}
        {!isLoading && (
          <Tooltip content={t("Save to notebook")}>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => {
                setSaveToNotebookRevision(revisionRef.current);
                setSaveToNotebookOpen(true);
              }}
              aria-label={t("Save document to notebook")}
            >
              <NotebookPen size={15} />
            </Button>
          </Tooltip>
        )}
        {!isLoading && (
          <Tooltip content={t("Version history")}>
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleRevisionHistory}
              aria-label={t("Version history")}
              aria-pressed={historyOpen}
            >
              <History size={15} />
            </Button>
          </Tooltip>
        )}
        {!isLoading && (
          <details className="relative">
            <summary className="flex h-8 cursor-pointer list-none items-center gap-1.5 rounded-lg border border-border bg-background px-2 text-xs font-medium hover:bg-muted" aria-label={t("Export document")}>
              <Download size={14} />
              <span className="hidden sm:inline">{exportingFormat ? t("Exporting…") : t("Export")}</span>
            </summary>
            <div className="absolute right-0 z-30 mt-1 w-40 rounded-lg border border-border bg-card p-1 shadow-overlay">
              {(["markdown", "docx", "pdf"] as const).map((format) => (
                <button key={format} type="button" disabled={Boolean(exportingFormat)} onClick={() => void exportDocument(format)} className="block w-full rounded-md px-3 py-2 text-left text-xs font-medium hover:bg-muted disabled:opacity-50">
                  {format === "docx" ? t("Word document") : format === "pdf" ? t("PDF document") : t("Markdown document")}
                </button>
              ))}
            </div>
          </details>
        )}
        {!isLoading && (
          <div className="hidden items-center rounded-lg border border-border bg-muted-subtle p-0.5 md:flex" role="group" aria-label={t("Document view")}>
            {([
              ["edit", FilePenLine, t("Editor")],
              ["split", Columns2, t("Split view")],
              ["preview", Eye, t("Preview")],
            ] as const).map(([mode, Icon, label]) => (
              <Tooltip key={mode} content={label}>
                <button
                  type="button"
                  onClick={() => setViewMode(mode)}
                  aria-label={label}
                  aria-pressed={viewMode === mode}
                  className={cn(
                    "rounded-md p-1.5 text-muted-foreground transition-colors hover:text-foreground",
                    viewMode === mode && "bg-card text-foreground shadow-hairline",
                  )}
                >
                  <Icon size={14} />
                </button>
              </Tooltip>
            ))}
          </div>
        )}
        {!isLoading && (
          <Button
            size="sm"
            variant={saveState === "error" ? "outline" : "primary"}
            onClick={() => void saveNow()}
            loading={saveState === "saving"}
            aria-label={t("Save document")}
          >
            {saveState !== "saving" && <Save size={14} />}
            {saveState === "error" ? t("Retry save") : t("Save")}
          </Button>
        )}
        <Tooltip
          content={panelOpen ? t("Hide AI assistant") : t("Show AI assistant")}
        >
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setPanelOpen((open) => !open)}
            aria-label={t("Toggle AI assistant")}
          >
            {panelOpen ? (
              <PanelRightClose size={16} />
            ) : (
              <PanelRight size={16} />
            )}
          </Button>
        </Tooltip>
      </header>
      {saveToNotebookOpen && (
        <SaveContentToNotebookDialog
          content={content}
          defaultTitle={title || t("Untitled document")}
          recordType="co_writer"
          userQuery={title}
          idempotencyKey={`co-writer:${docId}:revision:${saveToNotebookRevision}`}
          references={[{ type: "co_writer", id: docId }]}
          onClose={() => setSaveToNotebookOpen(false)}
        />
      )}

      {conflictRevision !== null && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-destructive bg-card px-4 py-2 text-sm" role="alert">
          <div>
            <div className="font-medium text-destructive">{t("A newer version exists")}</div>
            <div className="text-xs text-muted-foreground">{t("Reload it, or explicitly overwrite it with your current draft.")}</div>
            {mergeConflictCount > 0 && <div className="text-xs text-destructive">{t("{{count}} overlapping changes require you to choose one version.", { count: mergeConflictCount })}</div>}
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => void reloadLatest()}>
              <RotateCcw size={13} />
              {t("Reload latest")}
            </Button>
            <Button size="sm" variant="outline" onClick={() => void mergeWithLatest()}>{t("Merge non-overlapping changes")}</Button>
            <Button size="sm" onClick={keepLocalDraft}>{t("Keep my draft")}</Button>
          </div>
        </div>
      )}

      {historyOpen && (
        <section className="shrink-0 border-b border-border bg-card px-4 py-3" aria-label={t("Version history")}>
          <div className="mb-2 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-medium text-foreground">{t("Version history")}</h2>
              <p className="text-xs text-muted-foreground">
                {t("Every saved revision can be reviewed and restored without deleting newer versions.")}
              </p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setHistoryOpen(false)}>
              {t("Close")}
            </Button>
          </div>
          {loadingHistory ? (
            <Skeleton className="h-16 w-full" />
          ) : (
            <ol className="flex gap-2 overflow-x-auto pb-1" data-testid="co-writer-version-history">
              {revisionHistory.map((item) => (
                <li key={item.revision} className="min-w-64 rounded-lg border border-border bg-background p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-foreground">
                      {t("Revision {{revision}}", { revision: item.revision })}
                    </span>
                    {item.current ? (
                      <span className="text-[10px] text-success">{t("Current")}</span>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-xs"
                        disabled={saveState !== "saved"}
                        loading={restoringRevision === item.revision}
                        onClick={() => void restoreRevision(item.revision)}
                      >
                        <RotateCcw size={12} /> {t("Restore")}
                      </Button>
                    )}
                  </div>
                  <div className="mt-1 truncate text-xs text-muted-foreground">{item.title}</div>
                  <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">{item.preview || t("Empty draft")}</p>
                </li>
              ))}
            </ol>
          )}
          {saveState !== "saved" && (
            <p className="mt-2 text-xs text-warning">{t("Save the current draft before restoring a version.")}</p>
          )}
          <div className="mt-3 border-t border-border pt-3">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t("AI operation audit")}
            </h3>
            {operationHistory.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("No AI operations recorded for this document yet.")}</p>
            ) : (
              <ol className="flex gap-2 overflow-x-auto pb-1" data-testid="co-writer-operation-history">
                {operationHistory.map((operation) => {
                  const instruction = String(
                    operation.input?.instruction ?? operation.input?.selected_text ?? "",
                  );
                  return (
                    <li key={operation.id} className="min-w-64 rounded-lg border border-border bg-background p-3 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-foreground">
                          {t("AI {{action}}", { action: operation.mode || operation.action })}
                        </span>
                        <span className={cn(
                          "rounded-full px-2 py-0.5 text-[10px]",
                          operation.decision === "accepted"
                            ? "bg-success-muted text-success"
                            : operation.decision === "rejected"
                              ? "bg-destructive-muted text-destructive"
                              : "bg-muted text-muted-foreground",
                        )}>
                          {operation.decision === "accepted"
                            ? t(operation.partial ? "Partially accepted" : "Accepted")
                            : operation.decision === "rejected"
                              ? t("Rejected")
                              : t("Pending review")}
                        </span>
                      </div>
                      {instruction ? <p className="mt-1 line-clamp-2 text-muted-foreground">{instruction}</p> : null}
                      <div className="mt-2 flex flex-wrap gap-x-3 text-[10px] text-muted-foreground">
                        {operation.model ? <span>{operation.model}</span> : null}
                        {operation.source || operation.tools?.length ? (
                          <span>{t("Sources")}: {operation.source || operation.tools?.join(", ")}</span>
                        ) : null}
                        <time>{new Date(operation.timestamp).toLocaleString()}</time>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        </section>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="mx-auto max-w-3xl px-8 py-10">
              <Skeleton className="h-8 w-1/2" />
              <Skeleton className="mt-8 h-4 w-full" />
              <Skeleton className="mt-3 h-4 w-full" />
              <Skeleton className="mt-3 h-4 w-5/6" />
              <Skeleton className="mt-3 h-4 w-2/3" />
            </div>
          ) : (
            <div
              className={cn(
                "mx-auto flex min-h-full flex-col px-8 py-10",
                viewMode === "split" ? "max-w-6xl" : "max-w-3xl",
              )}
            >
              <input
                value={title}
                onChange={(event) => {
                  const value = event.target.value;
                  setTitle(value);
                  titleRef.current = value;
                  setSaveState("dirty");
                  writeRecoveryDraft();
                }}
                onBlur={(event) => void commitTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    event.currentTarget.blur();
                  }
                }}
                placeholder={t("Untitled document")}
                aria-label={t("Document title")}
                className="display w-full bg-transparent text-3xl font-medium tracking-tight text-foreground placeholder:text-muted-foreground focus:outline-none"
              />
              <div
                className={cn(
                  "mt-8 min-h-[50vh] w-full flex-1",
                  viewMode === "split" && "grid grid-cols-2 gap-8",
                )}
              >
                {viewMode !== "preview" && (
                  <div className="relative min-h-[50vh] w-full">
                    <div
                      ref={selectionBackdropRef}
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words text-[15px] leading-relaxed text-transparent"
                    >
                      {selection ? (
                        <>
                          {content.slice(0, selection.start)}
                          <mark
                            data-testid="co-writer-selection-highlight"
                            className="box-decoration-clone rounded-sm bg-primary-muted text-transparent"
                          >
                            {content.slice(selection.start, selection.end)}
                          </mark>
                          {content.slice(selection.end)}
                        </>
                      ) : (
                        content
                      )}
                    </div>
                    <textarea
                      ref={editorRef}
                      value={content}
                      onChange={(event) => handleContentChange(event.target.value)}
                      onSelect={handleSelect}
                      onScroll={handleEditorScroll}
                      placeholder={t("Start writing…")}
                      aria-label={t("Document content")}
                      className="relative z-10 h-full min-h-[50vh] w-full resize-none bg-transparent text-[15px] leading-relaxed text-foreground selection:bg-primary-border selection:text-foreground placeholder:text-muted-foreground focus:outline-none"
                    />
                  </div>
                )}
                {viewMode !== "edit" && (
                  <section
                    aria-label={t("Markdown preview")}
                    className={cn(
                      "prose-cognivoy min-h-[50vh] overflow-auto rounded-xl bg-card p-5 text-foreground shadow-hairline",
                      viewMode === "split" && "border-l border-border",
                    )}
                  >
                    {deferredContent.trim() ? (
                      <MarkdownPreview content={deferredContent} />
                    ) : (
                      <p className="text-sm text-muted-foreground">{t("Nothing to preview yet.")}</p>
                    )}
                  </section>
                )}
              </div>
              <div className="mt-6 shrink-0 border-t border-border pt-3 text-xs text-muted-foreground">
                {t("{{count}} words", { count: wordCount })}
              </div>
            </div>
          )}
        </div>

        {panelOpen && !isLoading && (
          <aside className="hidden w-96 shrink-0 border-l border-border bg-card sm:block">
            <AssistantPanel
              documentId={docId}
              getContent={getContent}
              selection={selection}
              onClearSelection={clearSelection}
              onApply={handleApplyProposal}
              onClose={closeAssistantAndRestoreTarget}
              onAuditChanged={() => {
                if (historyOpen) void loadRevisionHistory();
              }}
            />
          </aside>
        )}
        {panelOpen && !isLoading && (
          <div className="fixed inset-0 z-50 sm:hidden">
            <button
              type="button"
              className="absolute inset-0 bg-overlay"
              aria-label={t("Close assistant panel")}
              onClick={closeAssistantAndRestoreTarget}
            />
            <aside
              data-testid="co-writer-mobile-assistant"
              role="dialog"
              aria-modal="true"
              aria-label={t("AI assistant")}
              className="fixed inset-x-0 bottom-0 z-10 h-[min(82dvh,720px)] overflow-hidden rounded-t-2xl border-t border-border bg-card shadow-overlay sm:hidden"
            >
              <AssistantPanel
                documentId={docId}
                getContent={getContent}
                selection={selection}
                onClearSelection={clearSelection}
                onApply={handleApplyProposal}
                onClose={closeAssistantAndRestoreTarget}
                onAuditChanged={() => {
                  if (historyOpen) void loadRevisionHistory();
                }}
              />
            </aside>
          </div>
        )}
      </div>
    </div>
  );
}
