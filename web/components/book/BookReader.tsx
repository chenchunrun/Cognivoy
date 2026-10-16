"use client";

/**
 * Reading pane for a single book page: header (title, learning objectives,
 * status, force-regenerate), failed-block banner, and the block stream.
 */

import * as React from "react";
import { BookOpen, Download, History, Plus, RefreshCcw } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Badge, Button, Dialog, DialogDescription, DialogTitle, EmptyState, Skeleton } from "@/components/ui";
import { bookApi } from "@/lib/book-api";
import type { Block, BlockType, Book, Page, PageStatus } from "@/lib/book-types";
import type { BookStatistics } from "@/lib/book-statistics";
import { bookCoverSrc } from "@/lib/book-library";

import { BlockView } from "./BlockView";
import { BookOverviewStats } from "./BookOverviewStats";
import { BookStageReviews } from "./BookStageReviews";
import type { QuizAttemptArgs } from "./QuizBlockView";
import { BookCover } from "./BookCover";

const PAGE_STATUS_VARIANT: Record<PageStatus, "default" | "success" | "warning" | "destructive" | "outline"> = {
  pending: "outline",
  planning: "warning",
  generating: "warning",
  ready: "success",
  partial: "warning",
  error: "destructive",
};

const PAGE_STATUS_LABEL: Record<PageStatus, string> = {
  pending: "Queued",
  planning: "Planning",
  generating: "Compiling",
  ready: "Ready",
  partial: "Partial",
  error: "Failed",
};

export interface BookReaderProps {
  book?: Book | null;
  page: Page | null;
  loading?: boolean;
  onRegenerateBlock?: (block: Block) => void;
  onDeleteBlock?: (block: Block) => void;
  onInsertBlock?: (type: BlockType) => void;
  onMoveBlock?: (block: Block, direction: -1 | 1) => void;
  onChangeBlockType?: (block: Block, type: BlockType) => void;
  onDeepDive?: (topic: string, blockId: string) => Promise<void> | void;
  onQuizAttempt?: (block: Block, args: QuizAttemptArgs) => void;
  onRecompile?: () => void;
  pendingDeepDiveTopic?: string | null;
  overviewStatistics?: BookStatistics | null;
  onExportPdf?: () => void;
  exportingPdf?: boolean;
  onExportPortable?: (format: "markdown" | "epub") => void;
  exportingPortable?: "markdown" | "epub" | null;
  onPageRestored?: (page: Page) => void;
}

export function BookReader({
  book,
  page,
  loading = false,
  onRegenerateBlock,
  onDeleteBlock,
  onInsertBlock,
  onMoveBlock,
  onChangeBlockType,
  onDeepDive,
  onQuizAttempt,
  onRecompile,
  pendingDeepDiveTopic,
  overviewStatistics,
  onExportPdf,
  exportingPdf = false,
  onExportPortable,
  exportingPortable = null,
  onPageRestored,
}: BookReaderProps) {
  const { t } = useTranslation();
  const [versionsOpen, setVersionsOpen] = React.useState(false);
  const [revisions, setRevisions] = React.useState<Array<{ revision_id: string; created_at?: string; title?: string; status?: string; block_count?: number }>>([]);
  const [revisionBusy, setRevisionBusy] = React.useState<string | null>(null);
  const [revisionError, setRevisionError] = React.useState<string | null>(null);

  if (!page) {
    return (
      <div className="flex h-full items-center justify-center">
        <EmptyState
          icon={BookOpen}
          title={t("Select a chapter to start reading")}
          description={t(
            "Pick a page from the table of contents on the left.",
          )}
        />
      </div>
    );
  }

  const failedBlocks = page.blocks.filter((block) => block.status === "error");
  const overviewCoverSrc = page.content_type === "overview" ? bookCoverSrc(book) : null;

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border px-5 py-5 sm:px-8">
        <div className="mx-auto flex w-full max-w-[82ch] flex-col gap-4 2xl:flex-row 2xl:items-start 2xl:justify-between">
          {overviewCoverSrc && (
            <BookCover
              src={overviewCoverSrc}
              title={book?.title || t("Untitled book")}
              className="h-28 w-20"
              testId="book-overview-cover"
            />
          )}
          <div className="min-w-0 flex-1">
            <h1
              className="display text-2xl font-semibold leading-[1.3] text-foreground sm:text-[1.75rem]"
              title={page.title || t("Untitled chapter")}
            >
              {page.title || t("Untitled chapter")}
            </h1>
            {page.learning_objectives.length > 0 && (
              <ul className="mt-3 max-w-[68ch] space-y-1 text-sm leading-relaxed text-muted-foreground">
                {page.learning_objectives.map((obj, idx) => (
                  <li key={idx}>• {obj}</li>
                ))}
              </ul>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Badge variant={PAGE_STATUS_VARIANT[page.status] || "default"}>
              {t(PAGE_STATUS_LABEL[page.status] || page.status)}
            </Badge>
            {onRecompile && (
              <Button
                variant="outline"
                size="sm"
                loading={loading}
                onClick={onRecompile}
              >
                {!loading && <RefreshCcw className="h-3.5 w-3.5" />}
                {loading ? t("Regenerating…") : t("Force regenerate")}
              </Button>
            )}
            {book && (
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  setVersionsOpen(true);
                  setRevisionError(null);
                  try {
                    setRevisions((await bookApi.listPageRevisions(book.id, page.id)).revisions);
                  } catch (error) {
                    setRevisionError(error instanceof Error ? error.message : String(error));
                  }
                }}
                data-testid="book-page-versions"
              >
                <History className="h-3.5 w-3.5" />
                {t("Versions")}
              </Button>
            )}
            {onExportPdf && (
              <Button
                variant="outline"
                size="sm"
                loading={exportingPdf}
                onClick={onExportPdf}
                data-testid="book-export-pdf"
              >
                {!exportingPdf && <Download className="h-3.5 w-3.5" />}
                {exportingPdf ? t("Preparing PDF…") : t("Export PDF")}
              </Button>
            )}
            {onExportPortable && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  loading={exportingPortable === "epub"}
                  disabled={Boolean(exportingPortable)}
                  onClick={() => onExportPortable("epub")}
                  data-testid="book-export-epub"
                >
                  {exportingPortable !== "epub" && <Download className="h-3.5 w-3.5" />}
                  {exportingPortable === "epub" ? t("Preparing EPUB…") : t("Export EPUB")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  loading={exportingPortable === "markdown"}
                  disabled={Boolean(exportingPortable)}
                  onClick={() => onExportPortable("markdown")}
                  data-testid="book-export-markdown"
                >
                  {exportingPortable !== "markdown" && <Download className="h-3.5 w-3.5" />}
                  {exportingPortable === "markdown" ? t("Preparing Markdown…") : t("Export Markdown")}
                </Button>
              </>
            )}
            {onInsertBlock && (
              <label className="relative">
                <span className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-3 text-xs font-medium text-foreground shadow-hairline transition-colors hover:bg-muted">
                  <Plus className="h-3.5 w-3.5" />
                  {t("Insert block")}
                </span>
                <select
                  aria-label={t("Insert block")}
                  defaultValue=""
                  onChange={(event) => {
                    if (event.target.value) onInsertBlock(event.target.value as BlockType);
                    event.target.value = "";
                  }}
                  className="absolute inset-0 cursor-pointer opacity-0"
                >
                  <option value="" disabled>{t("Insert block")}</option>
                  {(["text", "callout", "quiz", "user_note", "figure", "interactive", "animation", "code", "timeline", "flash_cards", "deep_dive", "section", "concept_graph"] as BlockType[]).map((type) => (
                    <option key={type} value={type}>{type}</option>
                  ))}
                </select>
              </label>
            )}
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-5 py-8 sm:px-8 lg:py-10">
        {loading && page.blocks.length === 0 ? (
          <div className="mx-auto w-full max-w-[76ch] space-y-6">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <RefreshCcw className="h-4 w-4 animate-spin" />
              {t("Compiling page…")}
            </div>
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : (
          <article className="book-reading mx-auto flex w-full max-w-[82ch] flex-col gap-8">
            {page.content_type === "overview" && overviewStatistics && (
              <BookOverviewStats statistics={overviewStatistics} />
            )}
            {page.content_type === "overview" && book && (
              <BookStageReviews bookId={book.id} />
            )}
            {failedBlocks.length > 0 && (
              <div className="rounded-xl border border-warning-border bg-warning-muted px-4 py-3 text-sm text-foreground">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <div className="font-semibold">
                    {t("{{count}} block(s) failed", {
                      count: failedBlocks.length,
                    })}
                  </div>
                  {onRecompile && (
                    <Button
                      variant="outline"
                      size="sm"
                      loading={loading}
                      onClick={onRecompile}
                    >
                      {t("Regenerate page")}
                    </Button>
                  )}
                </div>
                <div className="space-y-1.5 text-xs text-muted-foreground">
                  {failedBlocks.slice(0, 5).map((block) => (
                    <div
                      key={block.id}
                      className="flex flex-wrap items-center gap-2"
                    >
                      <code className="rounded bg-muted px-1.5 py-0.5">
                        {block.type}
                      </code>
                      <span>{block.error || t("Unknown error")}</span>
                      {onRegenerateBlock && (
                        <button
                          type="button"
                          onClick={() => onRegenerateBlock(block)}
                          className="rounded border border-border px-1.5 py-0.5 text-[11px] font-medium transition-colors hover:bg-muted"
                        >
                          {t("Retry block")}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {page.blocks.map((block, index) => (
              <div key={block.id} id={`block-${block.id}`} className="scroll-mt-6">
                <BlockView
                  block={block}
                  onRegenerate={onRegenerateBlock}
                  onDelete={onDeleteBlock}
                  onMove={onMoveBlock}
                  onChangeType={onChangeBlockType}
                  canMoveUp={index > 0}
                  canMoveDown={index < page.blocks.length - 1}
                  onDeepDive={onDeepDive}
                  onQuizAttempt={onQuizAttempt}
                  pendingDeepDiveTopic={pendingDeepDiveTopic}
                />
              </div>
            ))}

            {page.blocks.length === 0 && (
              <div className="text-sm text-muted-foreground">
                {t("This page has no blocks yet.")}
              </div>
            )}
          </article>
        )}
      </div>
      <Dialog open={versionsOpen} onClose={() => setVersionsOpen(false)} className="max-w-lg">
        <DialogTitle>{t("Page version history")}</DialogTitle>
        <DialogDescription>
          {t("A snapshot is kept before generated or edited page content changes. Restoring also preserves the current page as a new version.")}
        </DialogDescription>
        {revisionError ? (
          <p className="mt-4 text-sm text-destructive" role="alert">{revisionError}</p>
        ) : revisions.length === 0 ? (
          <p className="mt-4 rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
            {t("No earlier page versions yet.")}
          </p>
        ) : (
          <ul className="mt-4 max-h-80 space-y-2 overflow-y-auto">
            {revisions.map((revision) => (
              <li key={revision.revision_id} className="flex items-center justify-between gap-3 rounded-lg border border-border p-3 text-sm">
                <div className="min-w-0">
                  <p className="truncate font-medium text-foreground">{revision.title || page.title}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {revision.created_at ? new Date(revision.created_at).toLocaleString() : revision.revision_id}
                    {typeof revision.block_count === "number" ? ` · ${t("{{count}} blocks", { count: revision.block_count })}` : ""}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  loading={revisionBusy === revision.revision_id}
                  disabled={revisionBusy !== null}
                  onClick={async () => {
                    if (!book) return;
                    setRevisionBusy(revision.revision_id);
                    setRevisionError(null);
                    try {
                      const result = await bookApi.restorePageRevision(book.id, page.id, revision.revision_id);
                      onPageRestored?.(result.page);
                      setVersionsOpen(false);
                    } catch (error) {
                      setRevisionError(error instanceof Error ? error.message : String(error));
                    } finally {
                      setRevisionBusy(null);
                    }
                  }}
                >
                  {t("Restore")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Dialog>
    </div>
  );
}

export default BookReader;
