"use client";

/**
 * Book workspace: library → guided creator (intent → proposal → spine) →
 * reader with TOC sidebar, per-block actions and live compile progress.
 *
 * Data flow mirrors the previous frontend: REST for CRUD-ish calls, one
 * WebSocket per long-running operation (create / confirm proposal / compile
 * page / regenerate block) whose events feed the shared progress reducer.
 */

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { useTranslation } from "react-i18next";
import { MessageSquare } from "lucide-react";

import { ConfirmDialog, Spinner, useToast } from "@/components/ui";
import {
  bookApi,
  type BookListParams,
  type BookWsEvent,
  type CreateBookPayload,
} from "@/lib/book-api";
import type {
  Block,
  BlockType,
  Book,
  BookDetail,
  BookProposal,
  Page,
  Spine,
} from "@/lib/book-types";
import {
  emptyBookProgress,
  progressHasActivity,
  progressIsComplete,
  reduceBookEvent,
} from "@/lib/book-progress";

import { BookCreator } from "@/components/book/BookCreator";
import { BookLibrary } from "@/components/book/BookLibrary";
import { BookProgressTimeline } from "@/components/book/BookProgressTimeline";
import { BookReader } from "@/components/book/BookReader";
import { BookPageChat } from "@/components/book/BookPageChat";
import { BookTocSidebar } from "@/components/book/BookTocSidebar";
import { BookPrintDocument } from "@/components/book/BookPrintDocument";
import type { BookPrintOptions } from "@/components/book/BookPrintDocument";
import { BookExportDialog } from "@/components/book/BookExportDialog";
import type { QuizAttemptArgs } from "@/components/book/QuizBlockView";
import { calculateBookStatistics } from "@/lib/book-statistics";
import { consumeBookDraftTransfer } from "@/lib/book-draft-transfer";

type View = "list" | "creator" | "reader";

export default function BookPage() {
  // `useSearchParams()` needs a Suspense boundary during prerender.
  return (
    <React.Suspense
      fallback={
        <div className="flex h-[calc(100dvh-3.5rem)] w-full items-center justify-center md:h-dvh">
          <Spinner size={20} className="text-muted-foreground" />
        </div>
      }
    >
      <BookPageInner />
    </React.Suspense>
  );
}

function BookPageInner() {
  const { t } = useTranslation();
  const { toast } = useToast();

  const [books, setBooks] = React.useState<Book[]>([]);
  const [bookTotal, setBookTotal] = React.useState(0);
  const [bookSummary, setBookSummary] = React.useState({
    total: 0,
    ready: 0,
    in_progress: 0,
    chapters: 0,
  });
  const [loadingBooks, setLoadingBooks] = React.useState(true);
  const bookBrowseRef = React.useRef<BookListParams>({ limit: 24, offset: 0 });
  const [view, setView] = React.useState<View>("list");
  const [initialBookIntent, setInitialBookIntent] = React.useState("");

  const [selectedBookId, setSelectedBookId] = React.useState<string | null>(
    null,
  );
  const [detail, setDetail] = React.useState<BookDetail | null>(null);
  const [selectedPageId, setSelectedPageId] = React.useState<string | null>(
    null,
  );

  // Creator-stage state
  const [creating, setCreating] = React.useState(false);
  const [confirmingProposal, setConfirmingProposal] = React.useState(false);
  const [confirmingSpine, setConfirmingSpine] = React.useState(false);
  const [pendingBook, setPendingBook] = React.useState<Book | null>(null);
  const [pendingProposal, setPendingProposal] =
    React.useState<BookProposal | null>(null);
  const [pendingSpine, setPendingSpine] = React.useState<Spine | null>(null);

  // Reader-stage state
  const [compilingPageId, setCompilingPageId] = React.useState<string | null>(
    null,
  );
  const [rebuildingBook, setRebuildingBook] = React.useState(false);
  const [pendingDeepDiveTopic, setPendingDeepDiveTopic] = React.useState<
    string | null
  >(null);
  const [pageChatOpen, setPageChatOpen] = React.useState(false);
  const [printingBook, setPrintingBook] = React.useState(false);
  const [exportSettingsOpen, setExportSettingsOpen] = React.useState(false);
  const [printOptions, setPrintOptions] = React.useState<BookPrintOptions>({
    edition: "screen",
    paperSize: "A4",
    fontFamily: "serif",
    includeToc: true,
    header: "Cognivoy",
    footer: "",
  });
  const [exportingBookFormat, setExportingBookFormat] = React.useState<"markdown" | "epub" | null>(null);

  // Confirm dialogs
  const [deleteBookId, setDeleteBookId] = React.useState<string | null>(null);
  const [deletingBook, setDeletingBook] = React.useState(false);
  const [rebuildOpen, setRebuildOpen] = React.useState(false);
  const [rebuildPreview, setRebuildPreview] = React.useState<Awaited<
    ReturnType<typeof bookApi.rebuildPreview>
  > | null>(null);
  const [rebuildPreviewLoading, setRebuildPreviewLoading] = React.useState(false);
  const [blockPendingDelete, setBlockPendingDelete] =
    React.useState<Block | null>(null);
  const [deletingBlock, setDeletingBlock] = React.useState(false);

  const [progress, dispatchProgress] = React.useReducer(
    reduceBookEvent,
    null,
    emptyBookProgress,
  );

  const showError = React.useCallback(
    (title: string, err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      toast({ title, description: message, variant: "destructive" });
    },
    [toast],
  );

  const handlePortableExport = React.useCallback(async (format: "markdown" | "epub") => {
    if (!detail || exportingBookFormat) return;
    setExportingBookFormat(format);
    try {
      const { blob, filename } = await bookApi.downloadExport(detail.book.id, format);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      toast({ variant: "success", title: t("Book export ready") });
    } catch (err) {
      showError(t("Failed to export book"), err);
    } finally {
      setExportingBookFormat(null);
    }
  }, [detail, exportingBookFormat, showError, t, toast]);

  // ── Data loaders ────────────────────────────────────────────────────

  const refreshBooks = React.useCallback(async (options?: BookListParams) => {
    setLoadingBooks(true);
    try {
      const data = await bookApi.list(options ?? bookBrowseRef.current);
      setBooks(data.books);
      setBookTotal(data.total ?? data.books.length);
      setBookSummary(data.summary ?? {
        total: data.books.length,
        ready: data.books.filter((book) => book.status === "ready").length,
        in_progress: data.books.filter((book) =>
          ["draft", "spine_ready", "compiling"].includes(book.status),
        ).length,
        chapters: data.books.reduce((sum, book) => sum + (book.chapter_count || 0), 0),
      });
    } catch (err) {
      showError(t("Failed to load books"), err);
    } finally {
      setLoadingBooks(false);
    }
  }, [showError, t]);

  const handleBrowseBooks = React.useCallback(
    (options: BookListParams) => {
      bookBrowseRef.current = options;
      void refreshBooks(options);
    },
    [refreshBooks],
  );

  const loadBookDetail = React.useCallback(
    async (id: string) => {
      const data = await bookApi.get(id);
      setDetail(data);
      return data;
    },
    [],
  );

  const persistPageVisit = React.useCallback(
    async (bookId: string, pageId: string) => {
      try {
        const { progress: nextProgress } = await bookApi.recordPageVisit(bookId, pageId);
        setDetail((current) =>
          current?.book.id === bookId
            ? { ...current, progress: nextProgress }
            : current,
        );
      } catch {
        // Reading remains available offline or during a transient persistence
        // failure; the next page selection retries without interrupting flow.
      }
    },
    [],
  );

  // ── Live WS event handling ───────────────────────────────────────────

  const handleBookOperationEvent = React.useCallback(
    (event: BookWsEvent) => {
      dispatchProgress(event);
      const meta =
        (event.metadata as Record<string, unknown> | undefined) || {};
      const kind = String(
        (event.content as string) || (meta.kind as string) || "",
      );
      if (
        selectedBookId &&
        (kind === "block_ready" ||
          kind === "block_error" ||
          kind === "page_compiled" ||
          kind === "page_planned" ||
          kind === "spine_ready")
      ) {
        void loadBookDetail(selectedBookId).catch(() => undefined);
      }
    },
    [selectedBookId, loadBookDetail],
  );

  // ── Selectors ────────────────────────────────────────────────────────

  const selectedPage: Page | null = React.useMemo(() => {
    if (!detail || !selectedPageId) return null;
    return detail.pages.find((p) => p.id === selectedPageId) || null;
  }, [detail, selectedPageId]);

  const bookStatistics = React.useMemo(
    () => (detail ? calculateBookStatistics(detail) : null),
    [detail],
  );

  // ── Navigation ───────────────────────────────────────────────────────

  const handleSelectBook = React.useCallback(
    async (id: string | null) => {
      if (!id) {
        setSelectedBookId(null);
        setDetail(null);
        setSelectedPageId(null);
        setPendingBook(null);
        setPendingProposal(null);
        setPendingSpine(null);
        setView("list");
        return;
      }
      setSelectedBookId(id);
      try {
        const data = await loadBookDetail(id);
        if (data.book.status === "draft" && data.book.proposal) {
          setPendingBook(data.book);
          setPendingProposal(data.book.proposal);
          setPendingSpine(null);
          setView("creator");
        } else if (data.book.status === "spine_ready" && data.spine) {
          setPendingBook(data.book);
          setPendingProposal(null);
          setPendingSpine(data.spine);
          setView("creator");
        } else {
          const resumedPage = data.progress?.current_page_id
            ? data.pages.find((page) => page.id === data.progress?.current_page_id)
            : null;
          const firstReady = data.pages.find((p) => p.status === "ready");
          const firstAny = data.pages[0] || null;
          const firstPageId = (resumedPage || firstReady || firstAny)?.id || null;
          setSelectedPageId(firstPageId);
          if (firstPageId) void persistPageVisit(id, firstPageId);
          setView("reader");
        }
      } catch (err) {
        showError(t("Failed to open book"), err);
      }
    },
    [loadBookDetail, persistPageVisit, showError, t],
  );

  const handleGenerateCover = React.useCallback(async (bookId: string) => {
    try {
      await bookApi.generateCover(bookId, { theme: "learning" });
      await refreshBooks();
      toast({ variant: "success", title: t("Book cover generated") });
    } catch (error) {
      showError(t("Failed to generate book cover"), error);
    }
  }, [refreshBooks, showError, t, toast]);

  const handleUploadCover = React.useCallback(async (bookId: string, file: File) => {
    try {
      await bookApi.uploadCover(bookId, file);
      await refreshBooks();
      toast({ variant: "success", title: t("Book cover uploaded") });
    } catch (error) {
      showError(t("Failed to upload book cover"), error);
    }
  }, [refreshBooks, showError, t, toast]);

  // Deep-linking via /book?book=<id> (e.g. from the global sidebar).
  const searchParams = useSearchParams();
  const requestedBookId = searchParams?.get("book") || null;
  const requestedDraftKey = searchParams?.get("create") || null;
  const lastDeepLinkedBookId = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!requestedBookId) return;
    if (requestedBookId === selectedBookId) return;
    if (requestedBookId === lastDeepLinkedBookId.current) return;
    lastDeepLinkedBookId.current = requestedBookId;
    void handleSelectBook(requestedBookId);
  }, [requestedBookId, selectedBookId, handleSelectBook]);

  const consumedDraftKey = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!requestedDraftKey || consumedDraftKey.current === requestedDraftKey) return;
    consumedDraftKey.current = requestedDraftKey;
    const transfer = consumeBookDraftTransfer(requestedDraftKey);
    if (!transfer) return;
    setInitialBookIntent(transfer.intent);
    setSelectedBookId(null);
    setDetail(null);
    setPendingBook(null);
    setPendingProposal(null);
    setPendingSpine(null);
    setView("creator");
  }, [requestedDraftKey]);

  const handleNewBook = () => {
    setSelectedBookId(null);
    setDetail(null);
    setSelectedPageId(null);
    setPendingBook(null);
    setPendingProposal(null);
    setPendingSpine(null);
    setView("creator");
  };

  // ── Library actions ──────────────────────────────────────────────────

  const handleDeleteBook = async () => {
    if (!deleteBookId) return;
    setDeletingBook(true);
    try {
      await bookApi.delete(deleteBookId);
      if (selectedBookId === deleteBookId) {
        setSelectedBookId(null);
        setDetail(null);
        setView("list");
      }
      setDeleteBookId(null);
      await refreshBooks();
    } catch (err) {
      showError(t("Failed to delete book"), err);
    } finally {
      setDeletingBook(false);
    }
  };

  const handleRebuildBook = async () => {
    if (!detail) return;
    setRebuildOpen(false);
    setRebuildingBook(true);
    try {
      await bookApi.rebuild(detail.book.id, true);
      const refreshed = await loadBookDetail(detail.book.id);
      setSelectedPageId(refreshed.pages[0]?.id || null);
      setView("reader");
      await refreshBooks();
    } catch (err) {
      showError(t("Failed to rebuild book"), err);
    } finally {
      setRebuildingBook(false);
    }
  };

  const openRebuildPreview = async () => {
    if (!detail) return;
    setRebuildPreview(null);
    setRebuildOpen(true);
    setRebuildPreviewLoading(true);
    try {
      setRebuildPreview(await bookApi.rebuildPreview(detail.book.id));
    } catch (err) {
      setRebuildOpen(false);
      showError(t("Failed to preview book rebuild"), err);
    } finally {
      setRebuildPreviewLoading(false);
    }
  };

  // ── Creator actions ──────────────────────────────────────────────────

  const handleCreate = async (payload: CreateBookPayload) => {
    setCreating(true);
    try {
      const result = await bookApi.create(
        payload,
        handleBookOperationEvent,
      );
      setPendingBook(result.book);
      setPendingProposal(result.proposal);
      setPendingSpine(null);
      setSelectedBookId(result.book.id);
      await refreshBooks();
    } catch (err) {
      showError(t("Failed to create book"), err);
    } finally {
      setCreating(false);
    }
  };

  const handleConfirmProposal = async (edited: BookProposal) => {
    if (!pendingBook) return;
    setConfirmingProposal(true);
    try {
      const result = await bookApi.confirmProposal(
        pendingBook.id,
        edited,
        handleBookOperationEvent,
      );
      setPendingBook(result.book);
      setPendingProposal(null);
      setPendingSpine(result.spine);
      await loadBookDetail(result.book.id);
      await refreshBooks();
    } catch (err) {
      showError(t("Failed to build outline"), err);
    } finally {
      setConfirmingProposal(false);
    }
  };

  const handleConfirmSpine = async (spine: Spine) => {
    const bookId = selectedBookId || pendingBook?.id;
    if (!bookId) return;
    setConfirmingSpine(true);
    try {
      await bookApi.confirmSpine(bookId, spine, true);
      const refreshed = await loadBookDetail(bookId);
      const firstPage = refreshed.pages[0] || null;
      setSelectedPageId(firstPage?.id || null);
      setPendingSpine(null);
      setPendingBook(null);
      setView("reader");
      if (firstPage) {
        void compilePage(firstPage.id);
      }
      await refreshBooks();
    } catch (err) {
      showError(t("Failed to confirm outline"), err);
    } finally {
      setConfirmingSpine(false);
    }
  };

  // ── Reader actions ───────────────────────────────────────────────────

  const compilePage = React.useCallback(
    async (pageId: string, force = false) => {
      if (!selectedBookId) return;
      setCompilingPageId(pageId);
      try {
        await bookApi.compilePage(
          selectedBookId,
          pageId,
          force,
          handleBookOperationEvent,
        );
      } catch (err) {
        showError(t("Failed to compile page"), err);
      } finally {
        setCompilingPageId((current) => (current === pageId ? null : current));
        await loadBookDetail(selectedBookId).catch(() => undefined);
      }
    },
    [selectedBookId, loadBookDetail, handleBookOperationEvent, showError, t],
  );

  const handleSelectPage = (pageId: string) => {
    setSelectedPageId(pageId);
    if (!detail) return;
    void persistPageVisit(detail.book.id, pageId);
    const page = detail.pages.find((p) => p.id === pageId);
    if (page && page.status !== "ready" && page.status !== "generating") {
      void compilePage(pageId);
    }
  };

  const handleRegenerateBlock = async (block: Block) => {
    if (!detail || !selectedPage) return;
    try {
      await bookApi.regenerateBlock(
        detail.book.id,
        selectedPage.id,
        block.id,
        undefined,
        handleBookOperationEvent,
      );
    } catch (err) {
      showError(t("Failed to regenerate block"), err);
    } finally {
      await loadBookDetail(detail.book.id).catch(() => undefined);
    }
  };

  const handleDeleteBlock = async () => {
    if (!detail || !selectedPage || !blockPendingDelete) return;
    setDeletingBlock(true);
    try {
      await bookApi.deleteBlock(
        detail.book.id,
        selectedPage.id,
        blockPendingDelete.id,
      );
      setBlockPendingDelete(null);
      await loadBookDetail(detail.book.id);
    } catch (err) {
      showError(t("Failed to delete block"), err);
    } finally {
      setDeletingBlock(false);
    }
  };

  const handleInsertBlock = async (type: BlockType) => {
    if (!detail || !selectedPage) return;
    try {
      await bookApi.insertBlock({
        book_id: detail.book.id,
        page_id: selectedPage.id,
        block_type: type,
        position: selectedPage.blocks.length,
      });
      await loadBookDetail(detail.book.id);
    } catch (err) {
      showError(t("Failed to insert block"), err);
    }
  };

  const handleMoveBlock = async (block: Block, direction: -1 | 1) => {
    if (!detail || !selectedPage) return;
    const index = selectedPage.blocks.findIndex((item) => item.id === block.id);
    if (index < 0) return;
    try {
      await bookApi.moveBlock(detail.book.id, selectedPage.id, block.id, index + direction);
      await loadBookDetail(detail.book.id);
    } catch (err) {
      showError(t("Failed to move block"), err);
    }
  };

  const handleChangeBlockType = async (block: Block, type: BlockType) => {
    if (!detail || !selectedPage || type === block.type) return;
    try {
      await bookApi.changeBlockType({
        book_id: detail.book.id,
        page_id: selectedPage.id,
        block_id: block.id,
        new_type: type,
      });
      await loadBookDetail(detail.book.id);
    } catch (err) {
      showError(t("Failed to change block type"), err);
    }
  };

  const handleDeepDive = async (topic: string, blockId: string) => {
    if (!detail || !selectedPage) return;
    setPendingDeepDiveTopic(topic);
    try {
      const result = await bookApi.deepDive({
        book_id: detail.book.id,
        parent_page_id: selectedPage.id,
        topic,
        block_id: blockId,
      });
      const refreshed = await loadBookDetail(detail.book.id);
      const newPage = refreshed.pages.find((p) => p.id === result.page.id);
      if (newPage) {
        setSelectedPageId(newPage.id);
      }
    } catch (err) {
      showError(t("Deep dive failed"), err);
    } finally {
      setPendingDeepDiveTopic(null);
    }
  };

  const handleQuizAttempt = async (block: Block, args: QuizAttemptArgs) => {
    if (!detail || !selectedPage) return;
    try {
      await bookApi.recordQuizAttempt({
        book_id: detail.book.id,
        page_id: selectedPage.id,
        block_id: block.id,
        question_id: args.questionId,
        user_answer: args.userAnswer,
        is_correct: args.isCorrect,
      });
    } catch (err) {
      showError(t("Failed to record quiz attempt"), err);
      return;
    }
    if (!args.isCorrect) {
      // A wrong answer queues a best-effort supplement block for the topic.
      const topic =
        (block.params?.topic as string | undefined) ||
        selectedPage.title ||
        "this topic";
      try {
        await bookApi.supplement(detail.book.id, selectedPage.id, topic);
        await loadBookDetail(detail.book.id);
      } catch {
        // best-effort
      }
    }
  };

  const handlePageChatSession = async (sessionId: string) => {
    if (!detail || !selectedPage) return;
    try {
      const result = await bookApi.setPageChatSession(detail.book.id, selectedPage.id, sessionId);
      setDetail((current) => current ? { ...current, book: result.book } : current);
    } catch (err) {
      showError(t("Failed to save page chat"), err);
    }
  };

  // ── Render ───────────────────────────────────────────────────────────

  return (
    <>
    <div className="flex h-[calc(100dvh-3.5rem)] w-full overflow-hidden md:h-dvh">
      {view === "reader" && (
        <BookTocSidebar
          book={detail?.book || null}
          spine={detail?.spine || null}
          pages={detail?.pages || []}
          progress={detail?.progress || null}
          selectedPageId={selectedPageId}
          onSelectPage={handleSelectPage}
          onBackToLibrary={() => void handleSelectBook(null)}
          onRebuild={detail ? () => void openRebuildPreview() : undefined}
          rebuilding={rebuildingBook}
        />
      )}

      <main className="relative flex flex-1 overflow-hidden bg-background">
        {progressHasActivity(progress) && !progressIsComplete(progress) && (
          <div className="pointer-events-none absolute right-3 top-3 z-30">
            <BookProgressTimeline progress={progress} mini />
          </div>
        )}

        <div className="flex-1 overflow-hidden">
          {view === "list" && (
            <BookLibrary
              books={books}
              total={bookTotal}
              summary={bookSummary}
              loading={loadingBooks}
              onBrowse={handleBrowseBooks}
              onNewBook={handleNewBook}
              onSelectBook={(id) => void handleSelectBook(id)}
              onDeleteBook={(id) => setDeleteBookId(id)}
              onGenerateCover={handleGenerateCover}
              onUploadCover={handleUploadCover}
            />
          )}

          {view === "creator" && (
            <BookCreator
              initialIntent={initialBookIntent}
              onCreate={(payload) => void handleCreate(payload)}
              creating={creating}
              proposal={pendingProposal}
              onConfirmProposal={(edited) => void handleConfirmProposal(edited)}
              confirmingProposal={confirmingProposal}
              spine={pendingSpine}
              onConfirmSpine={(spine) => void handleConfirmSpine(spine)}
              confirmingSpine={confirmingSpine}
              progress={progress}
              onCancel={() => void handleSelectBook(null)}
            />
          )}

          {view === "reader" && (
            <BookReader
              book={detail?.book || null}
              page={selectedPage}
              loading={
                !!compilingPageId && compilingPageId === selectedPage?.id
              }
              onRegenerateBlock={(block) => void handleRegenerateBlock(block)}
              onDeleteBlock={(block) => setBlockPendingDelete(block)}
              onInsertBlock={(type) => void handleInsertBlock(type)}
              onMoveBlock={(block, direction) => void handleMoveBlock(block, direction)}
              onChangeBlockType={(block, type) => void handleChangeBlockType(block, type)}
              onDeepDive={(topic, blockId) => handleDeepDive(topic, blockId)}
              onQuizAttempt={(block, args) => void handleQuizAttempt(block, args)}
              pendingDeepDiveTopic={pendingDeepDiveTopic}
              overviewStatistics={bookStatistics}
              onExportPdf={detail ? () => setExportSettingsOpen(true) : undefined}
              exportingPdf={printingBook}
              onExportPortable={detail ? (format) => void handlePortableExport(format) : undefined}
              exportingPortable={exportingBookFormat}
              onPageRestored={(page) =>
                setDetail((current) =>
                  current
                    ? {
                        ...current,
                        pages: current.pages.map((item) =>
                          item.id === page.id ? page : item,
                        ),
                      }
                    : current,
                )
              }
              onRecompile={
                selectedPage
                  ? () => void compilePage(selectedPage.id, true)
                  : undefined
              }
            />
          )}
        </div>
        {view === "reader" && detail && selectedPage && pageChatOpen && (
          <BookPageChat
            key={selectedPage.id}
            book={detail.book}
            page={selectedPage}
            sessionId={detail.book.metadata.page_chat_sessions?.[selectedPage.id] || null}
            onSessionResolved={(sessionId) => void handlePageChatSession(sessionId)}
            onClose={() => setPageChatOpen(false)}
          />
        )}
        {view === "reader" && !pageChatOpen && (
          <button type="button" onClick={() => setPageChatOpen(true)} className="absolute bottom-4 right-4 z-20 inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-lift">
            <MessageSquare size={15} />{t("Page Chat")}
          </button>
        )}
      </main>

      <ConfirmDialog
        open={!!deleteBookId}
        onClose={() => setDeleteBookId(null)}
        onConfirm={() => void handleDeleteBook()}
        title={t("Delete this book?")}
        description={t("This cannot be undone.")}
        confirmText={t("Delete")}
        destructive
        loading={deletingBook}
      />
      <BookExportDialog
        open={exportSettingsOpen}
        onClose={() => setExportSettingsOpen(false)}
        title={detail?.book.title || t("Untitled book")}
        onExport={(options) => {
          setPrintOptions(options);
          setExportSettingsOpen(false);
          setPrintingBook(true);
        }}
      />

      <ConfirmDialog
        open={rebuildOpen}
        onClose={() => setRebuildOpen(false)}
        onConfirm={() => void handleRebuildBook()}
        title={t("Rebuild this book?")}
        description={t(
          rebuildPreview
            ? "{{pages}} pages and {{blocks}} generated blocks will be replaced. {{notes}} notes, reading progress, bookmarks, and page chats will be preserved."
            : "Calculating the exact rebuild impact…",
          rebuildPreview
            ? {
                pages: rebuildPreview.page_count,
                blocks: rebuildPreview.generated_block_count,
                notes: rebuildPreview.user_note_count,
              }
            : undefined,
        )}
        confirmText={t("Rebuild")}
        destructive
        loading={rebuildingBook || rebuildPreviewLoading}
      />

      <ConfirmDialog
        open={!!blockPendingDelete}
        onClose={() => setBlockPendingDelete(null)}
        onConfirm={() => void handleDeleteBlock()}
        title={t("Delete this {{type}} block?", {
          type: blockPendingDelete ? t(blockPendingDelete.type) : "",
        })}
        confirmText={t("Delete")}
        destructive
        loading={deletingBlock}
      />
    </div>
    {detail && (
      <BookPrintDocument
        detail={detail}
        open={printingBook}
        onClose={() => setPrintingBook(false)}
        options={printOptions}
      />
    )}
    </>
  );
}
