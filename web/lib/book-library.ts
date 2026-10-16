export type BookLibrarySort =
  | "recent"
  | "title"
  | "progress"
  | "reading_time";

export interface BookLibraryFilter {
  query: string;
  status: string;
  sort: BookLibrarySort;
}

interface SortableBook {
  title?: string;
  description?: string;
  status: string;
  updated_at: number;
  statistics?: {
    reading_progress_percent?: number;
    estimated_reading_minutes?: number;
  } | null;
}

interface CoverableBook {
  updated_at: number;
  metadata?: {
    cover_url?: unknown;
  } | null;
}

/**
 * Return the persisted cover URL with a stable revision query.  Cover assets
 * intentionally keep one endpoint, so the book timestamp prevents browsers
 * from showing an older image after upload or regeneration.
 */
export function bookCoverSrc(book: CoverableBook | null | undefined): string | null {
  const raw = book?.metadata?.cover_url;
  if (typeof raw !== "string" || !raw.trim()) return null;
  const separator = raw.includes("?") ? "&" : "?";
  return `${raw}${separator}v=${encodeURIComponent(String(book?.updated_at || 0))}`;
}

export function filterAndSortBooks<T extends SortableBook>(
  books: readonly T[],
  filter: BookLibraryFilter,
): T[] {
  const query = filter.query.trim().toLocaleLowerCase();
  const filtered = books.filter((book) => {
    if (filter.status !== "all" && book.status !== filter.status) return false;
    if (!query) return true;
    return `${book.title ?? ""} ${book.description ?? ""}`
      .toLocaleLowerCase()
      .includes(query);
  });
  return filtered.toSorted((left, right) => {
    if (filter.sort === "title") {
      return (left.title ?? "").localeCompare(right.title ?? "");
    }
    if (filter.sort === "progress") {
      return (
        (right.statistics?.reading_progress_percent ?? -1) -
        (left.statistics?.reading_progress_percent ?? -1)
      );
    }
    if (filter.sort === "reading_time") {
      return (
        (right.statistics?.estimated_reading_minutes ?? -1) -
        (left.statistics?.estimated_reading_minutes ?? -1)
      );
    }
    return right.updated_at - left.updated_at;
  });
}
