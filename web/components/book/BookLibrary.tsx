"use client";

/**
 * Book library: searchable grid of the user's AI-authored books with
 * status badges, reading stats, skeleton loading and an empty state.
 * Deletion is confirmed by the parent via ConfirmDialog.
 */

import * as React from "react";
import {
  BookOpen,
  BookText,
  Clock3,
  FileText,
  Gauge,
  ImagePlus,
  Layers,
  Plus,
  Search,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  Badge,
  type BadgeVariant,
  Button,
  EmptyState,
  Input,
  Skeleton,
  Tooltip,
} from "@/components/ui";
import type { Book, BookStatus } from "@/lib/book-types";
import { bookCoverSrc, type BookLibrarySort } from "@/lib/book-library";
import { PageHeader } from "@/components/shell/PageHeader";
import { BookCover } from "./BookCover";

const STATUS_VARIANT: Record<BookStatus, BadgeVariant> = {
  draft: "warning",
  spine_ready: "default",
  compiling: "warning",
  ready: "success",
  error: "destructive",
  archived: "outline",
};

const STATUS_LABEL: Record<BookStatus, string> = {
  draft: "Draft",
  spine_ready: "Outline",
  compiling: "Compiling",
  ready: "Ready",
  error: "Error",
  archived: "Archived",
};
const BOOK_PAGE_SIZE = 24;

function relativeTime(
  seconds: number,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (!seconds || Number.isNaN(seconds)) return "";
  const diff = Date.now() / 1000 - seconds;
  if (diff < 60) return t("just now");
  const mins = Math.floor(diff / 60);
  if (mins < 60) return t("{{count}}m ago", { count: mins });
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return t("{{count}}h ago", { count: hrs });
  const days = Math.floor(hrs / 24);
  if (days < 30) return t("{{count}}d ago", { count: days });
  const months = Math.floor(days / 30);
  if (months < 12) return t("{{count}}mo ago", { count: months });
  return t("{{count}}y ago", { count: Math.floor(months / 12) });
}

export interface BookLibraryProps {
  books: Book[];
  total: number;
  summary: { total: number; ready: number; in_progress: number; chapters: number };
  loading: boolean;
  onBrowse: (options: {
    q: string;
    status: BookStatus | "all";
    sort: BookLibrarySort;
    limit: number;
    offset: number;
  }) => void;
  onNewBook: () => void;
  onSelectBook: (id: string) => void;
  onDeleteBook: (id: string) => void;
  onGenerateCover: (id: string) => Promise<void>;
  onUploadCover: (id: string, file: File) => Promise<void>;
}

export function BookLibrary({
  books,
  total,
  summary,
  loading,
  onBrowse,
  onNewBook,
  onSelectBook,
  onDeleteBook,
  onGenerateCover,
  onUploadCover,
}: BookLibraryProps) {
  const { t } = useTranslation();
  const [query, setQuery] = React.useState("");
  const [status, setStatus] = React.useState<BookStatus | "all">("all");
  const [sort, setSort] = React.useState<BookLibrarySort>("recent");
  const [coverBusy, setCoverBusy] = React.useState<string | null>(null);
  const [page, setPage] = React.useState(0);
  const pageCount = Math.max(1, Math.ceil(total / BOOK_PAGE_SIZE));
  const effectivePage = Math.min(page, pageCount - 1);

  React.useEffect(() => {
    const handle = window.setTimeout(() => {
      onBrowse({
        q: query,
        status,
        sort,
        limit: BOOK_PAGE_SIZE,
        offset: effectivePage * BOOK_PAGE_SIZE,
      });
    }, query ? 200 : 0);
    return () => window.clearTimeout(handle);
  }, [effectivePage, onBrowse, query, sort, status]);

  const stats = React.useMemo(() => {
    return {
      total: summary.total,
      ready: summary.ready,
      inProgress: summary.in_progress,
      chapters: summary.chapters,
      readingMinutes: books.reduce(
        (acc, b) => acc + (b.statistics?.estimated_reading_minutes ?? 0),
        0,
      ),
      contentUnits: books.reduce(
        (acc, b) => acc + (b.statistics?.content_units ?? 0),
        0,
      ),
    };
  }, [books, summary]);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <div className="mx-auto w-full max-w-7xl shrink-0 px-6 pt-8">
        <PageHeader
          title={t("Books")}
          description={t("Generate, browse and study your AI-authored books.")}
          actions={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <div className="relative">
              <Search
                size={13}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                value={query}
                onChange={(e) => {
                  setPage(0);
                  setQuery(e.target.value);
                }}
                placeholder={t("Search books")}
                className="w-52 pl-7"
                aria-label={t("Search books")}
              />
            </div>
            <select
              value={status}
              onChange={(event) => {
                setPage(0);
                setStatus(event.target.value as BookStatus | "all");
              }}
              aria-label={t("Filter books by status")}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="all">{t("All statuses")}</option>
              {(Object.keys(STATUS_LABEL) as BookStatus[]).map((value) => (
                <option key={value} value={value}>
                  {t(STATUS_LABEL[value])}
                </option>
              ))}
            </select>
            <select
              value={sort}
              onChange={(event) => {
                setPage(0);
                setSort(event.target.value as BookLibrarySort);
              }}
              aria-label={t("Sort books")}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="recent">{t("Recently updated")}</option>
              <option value="title">{t("Title A–Z")}</option>
              <option value="progress">{t("Reading progress")}</option>
              <option value="reading_time">{t("Reading time")}</option>
            </select>
            <Button onClick={onNewBook} size="sm">
              <Plus size={14} />
              {t("New book")}
            </Button>
          </div>
          }
        />
      </div>

      <main className="mx-auto w-full max-w-7xl flex-1 overflow-y-auto px-6 pb-6">
        {books.length > 0 && (
          <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
            <StatCard
              icon={<BookOpen size={14} />}
              label={t("Total books")}
              value={stats.total}
            />
            <StatCard
              icon={<Sparkles size={14} />}
              label={t("Ready")}
              value={stats.ready}
            />
            <StatCard
              icon={<Clock3 size={14} />}
              label={t("In progress")}
              value={stats.inProgress}
            />
            <StatCard
              icon={<Layers size={14} />}
              label={t("Chapters")}
              value={stats.chapters}
            />
            <StatCard
              icon={<BookText size={14} />}
              label={t("Visible content")}
              value={stats.contentUnits}
            />
            <StatCard
              icon={<Gauge size={14} />}
              label={t("Visible reading time")}
              value={t("{{count}} min", { count: stats.readingMinutes })}
            />
          </div>
        )}

        {loading ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="surface p-4">
                <div className="mb-3 flex items-center justify-between">
                  <Skeleton className="h-5 w-24" />
                  <Skeleton className="h-5 w-14 rounded-full" />
                </div>
                <Skeleton className="mb-2 h-4 w-3/4" />
                <Skeleton className="mb-1 h-3 w-full" />
                <Skeleton className="h-3 w-2/3" />
              </div>
            ))}
          </div>
        ) : total === 0 && !query && status === "all" ? (
          <EmptyState
            icon={BookOpen}
            title={t("No books yet")}
            description={t(
              "Create your first AI-generated book from a knowledge base, chat selections or simply a topic.",
            )}
            action={
              <Button onClick={onNewBook}>
                <Plus size={14} />
                {t("New book")}
              </Button>
            }
            className="py-24"
          />
        ) : books.length === 0 ? (
          <EmptyState
            icon={Search}
            title={
              query
                ? t("No books match “{{query}}”", { query })
                : t("No books match the selected filters")
            }
            className="py-24"
          />
        ) : (
          <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {books.map((book) => {
              const coverSrc = bookCoverSrc(book);
              return (
              <div
                key={book.id}
                data-testid="book-card"
                data-book-id={book.id}
                data-book-status={book.status}
                className="surface group relative flex flex-col gap-3 p-4 transition duration-150 hover:-translate-y-0.5 hover:border-primary-border hover:shadow-lift"
              >
                <div className="flex items-start justify-between gap-2">
                  {coverSrc ? (
                    <BookCover
                      src={coverSrc}
                      title={book.title || t("Untitled book")}
                      className="h-24 w-[4.5rem]"
                      testId="book-library-cover"
                    />
                  ) : (
                    <div className="flex h-24 w-[4.5rem] shrink-0 items-center justify-center overflow-hidden rounded-lg border border-primary-border bg-primary-muted text-primary shadow-hairline">
                      <span className="display text-2xl font-semibold" aria-hidden="true">
                        {(book.title || t("Untitled book")).trim().charAt(0).toLocaleUpperCase() || "B"}
                      </span>
                    </div>
                  )}
                  <button
                    type="button"
                    data-testid="book-open"
                    aria-label={t("Open {{title}}", { title: book.title || t("Untitled book") })}
                    onClick={() => onSelectBook(book.id)}
                    className="min-w-0 flex-1 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  >
                    <Badge variant={STATUS_VARIANT[book.status] || "default"}>
                      {t(STATUS_LABEL[book.status] || book.status)}
                    </Badge>
                    <div
                      className="display mt-2 line-clamp-3 text-base font-medium text-foreground"
                      title={book.title || t("Untitled book")}
                    >
                      {book.title || t("Untitled book")}
                    </div>
                  </button>
                  <Tooltip content={t("Delete book")}>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onDeleteBook(book.id);
                      }}
                      aria-label={t("Delete book")}
                      className="rounded-md p-1.5 text-muted-foreground opacity-0 transition group-hover:opacity-100 hover:bg-destructive-muted hover:text-destructive focus-visible:opacity-100"
                    >
                      <Trash2 size={13} />
                    </button>
                  </Tooltip>
                </div>
                <p className="line-clamp-3 flex-1 text-xs leading-relaxed text-muted-foreground">
                  {book.description ||
                    t("No description yet. Open the book to view its outline.")}
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    loading={coverBusy === `${book.id}:generate`}
                    onClick={() => {
                      setCoverBusy(`${book.id}:generate`);
                      void onGenerateCover(book.id).finally(() => setCoverBusy(null));
                    }}
                    aria-label={t("Generate cover for {{title}}", { title: book.title || t("Untitled book") })}
                  >
                    <ImagePlus size={12} /> {book.metadata.cover_url ? t("Regenerate cover") : t("Generate cover")}
                  </Button>
                  <label className="inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
                    <Upload size={12} /> {t("Upload cover")}
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      className="sr-only"
                      aria-label={t("Upload cover for {{title}}", { title: book.title || t("Untitled book") })}
                      disabled={coverBusy !== null}
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        event.target.value = "";
                        if (!file) return;
                        setCoverBusy(`${book.id}:upload`);
                        void onUploadCover(book.id, file).finally(() => setCoverBusy(null));
                      }}
                    />
                  </label>
                </div>
                {book.statistics ? (
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                    <span>{t("{{count}} words / characters", { count: book.statistics.content_units })}</span>
                    <span>{t("~{{count}} min", { count: book.statistics.estimated_reading_minutes })}</span>
                    <span>{t("{{count}} quizzes", { count: book.statistics.quiz_count })}</span>
                    <span>{t("{{count}} sources", { count: book.statistics.source_count })}</span>
                  </div>
                ) : (
                  <p className="text-[11px] text-muted-foreground">
                    {t("Statistics unavailable")}
                  </p>
                )}
                <div className="mt-auto pt-1">
                  <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                    <span>{t("Reading progress")}</span>
                    <span>{book.statistics ? `${book.statistics.reading_progress_percent}%` : "—"}</span>
                  </div>
                  <div
                    className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted"
                    role="progressbar"
                    aria-label={t("Reading progress for {{title}}", { title: book.title || t("Untitled book") })}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={book.statistics?.reading_progress_percent ?? 0}
                  >
                    <div
                      className="h-full rounded-full bg-primary transition-[width]"
                      style={{ width: `${book.statistics?.reading_progress_percent ?? 0}%` }}
                    />
                  </div>
                </div>
                <div className="flex items-center justify-between pt-1 text-[11px] text-muted-foreground">
                  <div className="flex items-center gap-3">
                    <span className="inline-flex items-center gap-1">
                      <Layers size={11} />
                      {t("{{count}} ch", { count: book.chapter_count || 0 })}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <FileText size={11} />
                      {t("{{count}} pages", { count: book.page_count || 0 })}
                    </span>
                  </div>
                  <span className="inline-flex items-center gap-1">
                    <Clock3 size={11} />
                    {relativeTime(book.updated_at, t) || "—"}
                  </span>
                </div>
              </div>
              );
            })}
          </div>
          {total > BOOK_PAGE_SIZE && (
            <nav
              data-testid="book-library-pagination"
              aria-label={t("Book library pages")}
              className="mt-6 flex items-center justify-center gap-3"
            >
              <Button
                variant="outline"
                size="sm"
                disabled={effectivePage === 0}
                onClick={() => setPage(Math.max(0, effectivePage - 1))}
              >
                {t("Previous page")}
              </Button>
              <span className="text-xs tabular-nums text-muted-foreground">
                {t("Page {{page}} of {{pages}}", {
                  page: effectivePage + 1,
                  pages: pageCount,
                })}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={(effectivePage + 1) * BOOK_PAGE_SIZE >= total}
                onClick={() => setPage(effectivePage + 1)}
              >
                {t("Next page")}
              </Button>
            </nav>
          )}
          </>
        )}
      </main>
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: number | string;
}) {
  return (
    <div className="surface px-4 py-3">
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="display mt-1 text-xl font-medium text-foreground">
        {value}
      </div>
    </div>
  );
}

export default BookLibrary;
