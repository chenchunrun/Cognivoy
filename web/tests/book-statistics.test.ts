import test from "node:test";
import assert from "node:assert/strict";

import { calculateBookStatistics } from "@/lib/book-statistics";
import type { Block, BookDetail, Page } from "@/lib/book-types";

function block(
  id: string,
  body: string,
  status: Block["status"] = "ready",
): Block {
  return {
    id,
    type: "text",
    status,
    title: "",
    params: {},
    payload: { body },
    source_anchors: [],
    metadata: {},
    error: "",
    created_at: 0,
    updated_at: 0,
  };
}

function page(
  id: string,
  chapterId: string,
  blocks: Block[],
  contentType: Page["content_type"] = "theory",
): Page {
  return {
    id,
    book_id: "book-1",
    chapter_id: chapterId,
    title: id,
    learning_objectives: [],
    content_type: contentType,
    status: "ready",
    order: 0,
    blocks,
    links: [],
    parent_page_id: "",
    error: "",
    created_at: 0,
    updated_at: 0,
  };
}

test("book statistics count readable chapter content and exclude overview/code payloads", () => {
  const detail = {
    book: { chapter_count: 2 },
    spine: {
      chapters: [
        { id: "overview", title: "本书导览", content_type: "overview" },
        { id: "c1", title: "基础", content_type: "theory" },
        { id: "c2", title: "Practice", content_type: "practice" },
      ],
    },
    pages: [
      page("overview", "", [block("graph", "should not count")], "overview"),
      page("p1", "c1", [
        block("b1", "你好世界 hello world"),
        { ...block("hidden", "hidden words"), status: "hidden" },
      ]),
      page("p2", "c2", [block("b2", "one two three")]),
    ],
    progress: { visited_page_ids: ["overview", "p1"] },
  } as unknown as BookDetail;

  const statistics = calculateBookStatistics(detail);

  assert.equal(statistics.chapterCount, 2);
  assert.equal(statistics.pageCount, 2);
  assert.equal(statistics.readyPageCount, 2);
  assert.equal(statistics.blockCount, 2);
  assert.equal(statistics.contentUnits, 9);
  assert.equal(statistics.estimatedReadingMinutes, 1);
  assert.equal(statistics.visitedPageCount, 1);
  assert.equal(statistics.readingProgressPercent, 50);
  assert.deepEqual(
    statistics.chapters.map((chapter) => ({
      title: chapter.title,
      units: chapter.contentUnits,
    })),
    [
      { title: "基础", units: 6 },
      { title: "Practice", units: 3 },
    ],
  );
});

test("reader totals prefer the authoritative backend statistics contract", () => {
  const detail = {
    book: { chapter_count: 1 },
    spine: { chapters: [{ id: "c1", title: "One", content_type: "theory" }] },
    pages: [page("p1", "c1", [block("b1", "client estimate")])],
    progress: { visited_page_ids: [] },
    statistics: {
      chapter_count: 3,
      page_count: 7,
      ready_page_count: 6,
      block_count: 12,
      content_units: 900,
      code_line_count: 40,
      formula_count: 8,
      quiz_count: 4,
      interactive_count: 2,
      source_count: 5,
      estimated_reading_minutes: 30,
      visited_page_count: 2,
      reading_progress_percent: 29,
    },
  } as unknown as BookDetail;

  const statistics = calculateBookStatistics(detail);

  assert.equal(statistics.chapterCount, 3);
  assert.equal(statistics.contentUnits, 900);
  assert.equal(statistics.codeLineCount, 40);
  assert.equal(statistics.formulaCount, 8);
  assert.equal(statistics.quizCount, 4);
  assert.equal(statistics.sourceCount, 5);
  assert.equal(statistics.readingProgressPercent, 29);
  assert.equal(statistics.chapters.length, 1);
});
