import type { BookDetail, Page } from "@/lib/book-types";

const CJK_PATTERN = /[一-鿿㐀-䶿぀-ヿ가-힯]/g;
const NON_PROSE_KEYS = new Set([
  "code",
  "html",
  "id",
  "language",
  "url",
  "video_url",
  "filename",
]);

export interface ChapterStatistics {
  id: string;
  title: string;
  pageCount: number;
  readyPageCount: number;
  blockCount: number;
  contentUnits: number;
}

export interface BookStatistics {
  chapterCount: number;
  pageCount: number;
  readyPageCount: number;
  blockCount: number;
  contentUnits: number;
  estimatedReadingMinutes: number;
  codeLineCount: number;
  formulaCount: number;
  quizCount: number;
  interactiveCount: number;
  sourceCount: number;
  visitedPageCount: number;
  readingProgressPercent: number;
  chapters: ChapterStatistics[];
}

interface TextMeasure {
  cjkCharacters: number;
  latinWords: number;
}

function collectProse(value: unknown, parentKey = ""): string[] {
  if (NON_PROSE_KEYS.has(parentKey)) return [];
  if (typeof value === "string") {
    if (/^(?:https?:|data:|blob:)/i.test(value.trim())) return [];
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectProse(item, parentKey));
  }
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(
    ([key, item]) => collectProse(item, key),
  );
}

function cleanProse(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[#>*_~`|\[\](){}-]+/g, " ");
}

function measureText(text: string): TextMeasure {
  const cleaned = cleanProse(text);
  const cjkCharacters = cleaned.match(CJK_PATTERN)?.length ?? 0;
  const latinWords = cleaned
    .replace(CJK_PATTERN, " ")
    .split(/\s+/)
    .filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
  return { cjkCharacters, latinWords };
}

function measurePage(page: Page): TextMeasure {
  let cjkCharacters = 0;
  let latinWords = 0;
  for (const block of page.blocks) {
    if (block.status === "error" || block.status === "hidden") continue;
    const prose = [
      String(block.payload?.bridge_text ?? ""),
      ...collectProse(block.payload),
    ].join(" ");
    const measured = measureText(prose);
    cjkCharacters += measured.cjkCharacters;
    latinWords += measured.latinWords;
  }
  return { cjkCharacters, latinWords };
}

function sumMeasures(measures: TextMeasure[]): TextMeasure {
  return measures.reduce(
    (total, measure) => ({
      cjkCharacters: total.cjkCharacters + measure.cjkCharacters,
      latinWords: total.latinWords + measure.latinWords,
    }),
    { cjkCharacters: 0, latinWords: 0 },
  );
}

function toContentUnits(measure: TextMeasure): number {
  return measure.cjkCharacters + measure.latinWords;
}

function estimateReadingMinutes(measure: TextMeasure): number {
  const minutes = measure.cjkCharacters / 400 + measure.latinWords / 220;
  return minutes > 0 ? Math.max(1, Math.ceil(minutes)) : 0;
}

export function calculateBookStatistics(detail: BookDetail): BookStatistics {
  const authoritative = detail.statistics ?? null;
  const contentPages = detail.pages.filter(
    (page) => page.content_type !== "overview",
  );
  const visited = new Set(detail.progress?.visited_page_ids ?? []);
  const pageMeasures = new Map(
    contentPages.map((page) => [page.id, measurePage(page)]),
  );
  const totalMeasure = sumMeasures([...pageMeasures.values()]);
  const visitedPageCount = contentPages.filter((page) => visited.has(page.id)).length;
  const chapterDefinitions = (detail.spine?.chapters ?? []).filter(
    (chapter) => chapter.content_type !== "overview",
  );
  const definedChapterIds = chapterDefinitions.map((chapter) => chapter.id);
  const chapterIds = [
    ...definedChapterIds,
    ...new Set(
      contentPages
        .map((page) => page.chapter_id)
        .filter((id) => id && !definedChapterIds.includes(id)),
    ),
  ];

  const chapters = chapterIds.map((chapterId, index) => {
    const definition = chapterDefinitions.find((chapter) => chapter.id === chapterId);
    const pages = contentPages.filter((page) => page.chapter_id === chapterId);
    const measure = sumMeasures(
      pages.map((page) => pageMeasures.get(page.id) ?? { cjkCharacters: 0, latinWords: 0 }),
    );
    return {
      id: chapterId,
      title: definition?.title || pages[0]?.title || `Chapter ${index + 1}`,
      pageCount: pages.length,
      readyPageCount: pages.filter((page) => page.status === "ready").length,
      blockCount: pages.reduce(
        (count, page) =>
          count + page.blocks.filter((block) => block.status !== "hidden").length,
        0,
      ),
      contentUnits: toContentUnits(measure),
    };
  });

  return {
    chapterCount:
      authoritative?.chapter_count ??
      (chapterDefinitions.length || detail.book.chapter_count || chapters.length),
    pageCount: authoritative?.page_count ?? contentPages.length,
    readyPageCount:
      authoritative?.ready_page_count ??
      contentPages.filter((page) => page.status === "ready").length,
    blockCount: authoritative?.block_count ?? contentPages.reduce(
      (count, page) =>
        count + page.blocks.filter((block) => block.status !== "hidden").length,
      0,
    ),
    contentUnits: authoritative?.content_units ?? toContentUnits(totalMeasure),
    estimatedReadingMinutes:
      authoritative?.estimated_reading_minutes ?? estimateReadingMinutes(totalMeasure),
    codeLineCount: authoritative?.code_line_count ?? 0,
    formulaCount: authoritative?.formula_count ?? 0,
    quizCount: authoritative?.quiz_count ?? 0,
    interactiveCount: authoritative?.interactive_count ?? 0,
    sourceCount: authoritative?.source_count ?? 0,
    visitedPageCount: authoritative?.visited_page_count ?? visitedPageCount,
    readingProgressPercent:
      authoritative?.reading_progress_percent ??
      (contentPages.length > 0
        ? Math.round((visitedPageCount / contentPages.length) * 100)
        : 0),
    chapters,
  };
}
