"use client";

/**
 * Book table-of-contents sidebar. Groups pages under their spine chapters,
 * shows per-page status dots plus visited markers from the reading progress,
 * and a thin progress bar for the whole book. Collapsible to a slim rail.
 */

import * as React from "react";
import {
  ArrowLeft,
  Check,
  ChevronLeft,
  Compass,
  PanelLeft,
  RotateCcw,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button, Tooltip } from "@/components/ui";
import type { Book, Page, Progress, Spine } from "@/lib/book-types";
import { bookCoverSrc } from "@/lib/book-library";
import { cn } from "@/lib/utils";
import { BookCover } from "./BookCover";

interface TocEntry {
  chapterId: string | null;
  chapterTitle: string | null;
  pages: Page[];
}

function buildToc(pages: Page[], spine: Spine | null): TocEntry[] {
  const byChapter = new Map<string, Page[]>();
  const ungrouped: Page[] = [];
  for (const page of pages) {
    if (page.chapter_id) {
      const list = byChapter.get(page.chapter_id) || [];
      list.push(page);
      byChapter.set(page.chapter_id, list);
    } else {
      ungrouped.push(page);
    }
  }
  const entries: TocEntry[] = [];
  const seen = new Set<string>();
  if (spine) {
    for (const chapter of spine.chapters) {
      const chapterPages = byChapter.get(chapter.id);
      if (!chapterPages) continue;
      seen.add(chapter.id);
      entries.push({
        chapterId: chapter.id,
        chapterTitle: chapter.title,
        pages: chapterPages,
      });
    }
  }
  for (const [chapterId, chapterPages] of byChapter) {
    if (seen.has(chapterId)) continue;
    entries.push({ chapterId, chapterTitle: null, pages: chapterPages });
  }
  if (ungrouped.length > 0) {
    entries.push({ chapterId: null, chapterTitle: null, pages: ungrouped });
  }
  return entries;
}

function PageStatusDot({ page, visited }: { page: Page; visited: boolean }) {
  if (page.status === "error") {
    return <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-destructive" />;
  }
  if (page.status === "generating" || page.status === "planning") {
    return (
      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-warning" />
    );
  }
  if (visited) {
    return <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />;
  }
  if (page.status === "ready") {
    return <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />;
  }
  return <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full border border-border" />;
}

export interface BookTocSidebarProps {
  book: Book | null;
  spine: Spine | null;
  pages: Page[];
  progress: Progress | null;
  selectedPageId: string | null;
  onSelectPage: (id: string) => void;
  onBackToLibrary: () => void;
  onRebuild?: () => void;
  rebuilding?: boolean;
}

export function BookTocSidebar({
  book,
  spine,
  pages,
  progress,
  selectedPageId,
  onSelectPage,
  onBackToLibrary,
  onRebuild,
  rebuilding = false,
}: BookTocSidebarProps) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = React.useState(false);

  React.useEffect(() => {
    // The application navigation already occupies a column. Start the book
    // TOC as a compact rail on narrower desktops so the reading column never
    // collapses into one-character lines; the reader can expand it at will.
    if (window.innerWidth >= 1180) return;
    const frame = window.requestAnimationFrame(() => setCollapsed(true));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const visited = React.useMemo(
    () => new Set(progress?.visited_page_ids || []),
    [progress],
  );
  const readyPages = pages.filter((p) => p.status === "ready").length;
  const visitedCount = pages.filter((p) => visited.has(p.id)).length;
  const readFraction =
    pages.length > 0 ? Math.min(1, visitedCount / pages.length) : 0;
  const toc = React.useMemo(() => buildToc(pages, spine), [pages, spine]);
  const coverSrc = bookCoverSrc(book);

  if (collapsed) {
    return (
      <aside className="flex h-full w-14 shrink-0 flex-col items-center gap-2 border-r border-border bg-sidebar px-2 py-4">
        <Tooltip content={t("All books")} side="right">
          <button
            type="button"
            onClick={onBackToLibrary}
            aria-label={t("All books")}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
        </Tooltip>
        <Tooltip content={t("Expand chapters")} side="right">
          <button
            type="button"
            onClick={() => setCollapsed(false)}
            aria-label={t("Expand chapters")}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <PanelLeft className="h-4 w-4" />
          </button>
        </Tooltip>
        <div className="h-px w-8 bg-border" />
        <div className="flex flex-1 flex-col items-center gap-1 overflow-y-auto">
          {pages.map((page, index) => {
            const active = page.id === selectedPageId;
            return (
              <button
                key={page.id}
                type="button"
                onClick={() => onSelectPage(page.id)}
                title={page.title || t("Untitled")}
                className={cn(
                  "inline-flex h-8 w-8 items-center justify-center rounded-md text-[11px] font-semibold transition-colors",
                  active
                    ? "bg-primary-muted text-accent-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                {page.content_type === "overview" ? (
                  <Compass className="h-3.5 w-3.5" />
                ) : (
                  index + 1
                )}
              </button>
            );
          })}
        </div>
      </aside>
    );
  }

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col gap-3 border-r border-border bg-sidebar px-3 py-4">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={onBackToLibrary}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> {t("All books")}
        </button>
        <Tooltip content={t("Collapse chapters")}>
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            aria-label={t("Collapse chapters")}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
        </Tooltip>
      </div>

      {book && (
        <div className="flex items-start gap-3 px-1">
          {coverSrc ? (
            <BookCover
              src={coverSrc}
              title={book.title || t("Untitled book")}
              className="h-20 w-[3.75rem]"
              testId="book-sidebar-cover"
            />
          ) : (
            <div className="flex h-20 w-[3.75rem] shrink-0 items-center justify-center overflow-hidden rounded-md border border-primary-border bg-primary-muted text-primary shadow-hairline">
              <span className="display text-xl font-semibold" aria-hidden="true">
                {(book.title || t("Untitled book")).trim().charAt(0).toLocaleUpperCase() || "B"}
              </span>
            </div>
          )}
          <div className="min-w-0 pt-0.5">
            <div
              className="display line-clamp-3 text-base font-medium leading-snug text-foreground"
              title={book.title || t("Untitled book")}
            >
              {book.title || t("Untitled book")}
            </div>
            <div className="mt-1 text-[10px] uppercase tracking-wider text-muted-foreground">
              {t(book.status)} ·{" "}
              {t("{{count}} chapters", { count: book.chapter_count || 0 })}
            </div>
          </div>
        </div>
      )}

      {pages.length > 0 && (
        <div className="px-1">
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>{t("Reading progress")}</span>
            <span>
              {t("{{visited}} of {{total}} pages", {
                visited: visitedCount,
                total: pages.length,
              })}
            </span>
          </div>
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all duration-300"
              style={{ width: `${Math.round(readFraction * 100)}%` }}
            />
          </div>
          {readyPages < pages.length && (
            <div className="mt-1 text-[10px] text-muted-foreground">
              {t("{{ready}} of {{total}} pages compiled", {
                ready: readyPages,
                total: pages.length,
              })}
            </div>
          )}
        </div>
      )}

      {onRebuild && (
        <Button
          variant="outline"
          size="sm"
          loading={rebuilding}
          onClick={onRebuild}
          className="w-full"
        >
          {!rebuilding && <RotateCcw className="h-3.5 w-3.5" />}
          {t("Rebuild book")}
        </Button>
      )}

      <section className="flex-1 overflow-y-auto">
        {pages.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-3 py-3 text-xs text-muted-foreground">
            {t("Pages will appear here once the outline is confirmed.")}
          </div>
        ) : (
          <div className="space-y-4">
            {toc.map((entry, entryIdx) => (
              <div key={entry.chapterId || `ungrouped-${entryIdx}`}>
                {entry.chapterTitle && (
                  <div className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                    {entry.chapterTitle}
                  </div>
                )}
                <ul className="space-y-0.5">
                  {entry.pages.map((page) => {
                    const active = page.id === selectedPageId;
                    const isOverview = page.content_type === "overview";
                    return (
                      <li key={page.id}>
                        <button
                          type="button"
                          data-content-type={page.content_type}
                          onClick={() => onSelectPage(page.id)}
                          className={cn(
                            "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                            active
                              ? "bg-primary-muted text-accent-foreground"
                              : "text-muted-foreground hover:bg-muted hover:text-foreground",
                          )}
                        >
                          {isOverview ? (
                            <Compass className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                          ) : (
                            <PageStatusDot
                              page={page}
                              visited={visited.has(page.id)}
                            />
                          )}
                          <span className="line-clamp-2">
                            {page.title || t("Untitled")}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>
    </aside>
  );
}

export default BookTocSidebar;
