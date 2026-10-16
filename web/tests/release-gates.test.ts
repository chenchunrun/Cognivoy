import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const packageJson = JSON.parse(
  readFileSync(join(process.cwd(), "package.json"), "utf8"),
) as { scripts: Record<string, string> };

test("deterministic release gate excludes external services and live models", () => {
  const release = packageJson.scripts["test:e2e:release"];
  assert.ok(release);
  assert.doesNotMatch(release, /test:e2e:capabilities/);
  assert.doesNotMatch(release, /test:e2e:new-chat/);
  assert.doesNotMatch(release, /REQUIRE_NATIVE_BASELINE=1/);
});

test("CI runs the complete deterministic production gate and retains diagnostics", () => {
  const workflow = readFileSync(join(process.cwd(), "../.github/workflows/tests.yml"), "utf8");
  assert.match(workflow, /npm --prefix web run test:e2e:release/);
  assert.match(workflow, /web\/test-results\//);
  assert.match(workflow, /npm run build:perf/);
});

test("live-model and native-parity gates remain explicit", () => {
  assert.match(packageJson.scripts["test:e2e:live"], /test:e2e:capabilities/);
  assert.match(packageJson.scripts["test:e2e:live"], /test:e2e:new-chat/);
  assert.match(packageJson.scripts["test:e2e:parity"], /REQUIRE_NATIVE_BASELINE=1/);
});

test("release gate includes the full-route WCAG and responsive audit", () => {
  const accessibility = packageJson.scripts["test:e2e:accessibility"];
  const release = packageJson.scripts["test:e2e:release"];
  assert.ok(accessibility);
  assert.match(accessibility, /e2e-accessibility\.cjs/);
  assert.match(release, /test:e2e:accessibility/);
});

test("release gate includes the learner-project journey", () => {
  const journey = packageJson.scripts["test:e2e:learning-project"];
  const release = packageJson.scripts["test:e2e:release"];
  assert.ok(journey);
  assert.match(journey, /e2e-learning-project\.cjs/);
  assert.match(release, /test:e2e:learning-project/);
});

test("release gate measures streaming scroll stability without live models", () => {
  assert.equal(packageJson.scripts["test:e2e:stream-scroll"], "node ./scripts/e2e-stream-scroll.cjs");
  assert.match(packageJson.scripts["test:e2e:release"], /npm run test:e2e:stream-scroll/);
});

test("release gate includes the knowledge retrieval health journey", () => {
  const journey = packageJson.scripts["test:e2e:knowledge-health"];
  const release = packageJson.scripts["test:e2e:release"];
  assert.ok(journey);
  assert.match(journey, /e2e-knowledge-health\.cjs/);
  assert.match(release, /test:e2e:knowledge-health/);
});

test("sidebar prioritizes the learner journey and nests expert tools", () => {
  const source = readFileSync(
    join(process.cwd(), "components/shell/Sidebar.tsx"),
    "utf8",
  );
  for (const destination of [
    'href: "/home"',
    'href: "/space/learning"',
    'href: "/question-notebook"',
    'href: "/partners"',
    'href: "/space"',
  ]) {
    assert.ok(source.includes(destination));
  }
  assert.match(source, /const MATERIAL_NAV/);
  assert.match(source, /const EXPERT_NAV/);
  assert.match(source, /<details[\s\S]*?Expert tools/);
  assert.doesNotMatch(source, /const WORKSPACE_NAV/);
});

test("release gate protects recent sidebar layout and history navigation", () => {
  assert.equal(packageJson.scripts["test:e2e:sidebar-recent"], "node ./scripts/e2e-sidebar-recent.cjs");
  assert.match(packageJson.scripts["test:e2e:release"], /npm run test:e2e:sidebar-recent/);
});

test("co-writer keeps the AI assistant reachable as a mobile bottom drawer", () => {
  const source = readFileSync(
    join(process.cwd(), "app/(workspace)/co-writer/[docId]/page.tsx"),
    "utf8",
  );
  assert.match(source, /data-testid="co-writer-mobile-assistant"/);
  assert.match(source, /aria-modal="true"/);
  assert.match(source, /sm:hidden/);
  assert.match(source, /fixed inset-x-0 bottom-0/);
});

test("large question, book, and notebook collections expose bounded paging", () => {
  const questionSource = readFileSync(
    join(process.cwd(), "app/(utility)/question-notebook/page.tsx"),
    "utf8",
  );
  const bookSource = readFileSync(
    join(process.cwd(), "components/book/BookLibrary.tsx"),
    "utf8",
  );
  const notebookSource = readFileSync(
    join(process.cwd(), "components/notebook/NotebookRecords.tsx"),
    "utf8",
  );
  assert.match(questionSource, /data-testid="question-notebook-pagination"/);
  assert.match(bookSource, /data-testid="book-library-pagination"/);
  assert.match(notebookSource, /data-testid="notebook-record-pagination"/);
  assert.doesNotMatch(questionSource, /limit:\s*200/);
});

test("book cards use a dedicated open target that cannot overlap cover actions", () => {
  const source = readFileSync(
    join(process.cwd(), "components/book/BookLibrary.tsx"),
    "utf8",
  );
  assert.match(
    source,
    /<button[\s\S]*?data-testid="book-open"[\s\S]*?aria-label=\{t\("Open \{\{title\}\}"/,
  );
  assert.doesNotMatch(
    source,
    /className="absolute inset-0 z-10 rounded-xl"/,
  );
});

test("book reading persists page progress and resumes the last page", () => {
  const pageSource = readFileSync(
    join(process.cwd(), "app/(workspace)/book/page.tsx"),
    "utf8",
  );
  const apiSource = readFileSync(join(process.cwd(), "lib/book-api.ts"), "utf8");
  assert.match(apiSource, /recordPageVisit:[\s\S]*?\/books\/page-visit/);
  assert.match(pageSource, /data\.progress\?\.current_page_id/);
  assert.match(pageSource, /resumedPage \|\| firstReady \|\| firstAny/);
  assert.match(pageSource, /persistPageVisit\(detail\.book\.id, pageId\)/);
});

test("P2 learner controls remain protected by frontend contracts", () => {
  const memory = readFileSync(join(process.cwd(), "components/memory/MemoryResourceWorkbench.tsx"), "utf8");
  const agents = readFileSync(join(process.cwd(), "app/(utility)/space/agents/page.tsx"), "utf8");
  const knowledge = readFileSync(join(process.cwd(), "components/knowledge/kb-index-versions.tsx"), "utf8");
  assert.match(memory, /data-testid="memory-merge"/);
  assert.match(memory, /data-testid=\{`memory-pause-/);
  assert.match(memory, /data-testid=\{`memory-incorrect-/);
  assert.match(memory, /data-testid=\{`memory-projects-/);
  assert.match(memory, /data-testid="memory-project-picker"/);
  assert.match(memory, /updateMemoryResourceProjects/);
  assert.match(agents, /data-testid="agent-capability-matrix"/);
  assert.match(agents, /data-testid="opencode-history-import"/);
  assert.match(knowledge, /data-testid="knowledge-retrieval-quality"/);
});

test("P3 learning projects expose adaptive teaching and period comparison", () => {
  const page = readFileSync(join(process.cwd(), "app/(utility)/space/learning/[projectId]/page.tsx"), "utf8");
  assert.match(page, /data-testid="adaptive-teaching-profile"/);
  assert.match(page, /data-testid="learning-period-comparison"/);
  assert.match(page, /data-testid="project-reminder-pause"/);
  assert.match(page, /sm:flex-row/);
  const composer = readFileSync(join(process.cwd(), "components/chat/ChatComposer.tsx"), "utf8");
  assert.match(composer, /data-testid="learning-intent-preflight"/);
  assert.match(composer, /previewLearningCapability/);
});

test("Tutor reminders preserve viewed evidence and expose outcome metrics", () => {
  const proactive = readFileSync(join(process.cwd(), "components/partners/partner-proactive.tsx"), "utf8");
  const api = readFileSync(join(process.cwd(), "lib/partners-api.ts"), "utf8");
  assert.match(proactive, /data-testid="reminder-effectiveness"/);
  assert.match(proactive, /actOnProactiveReminder\(partnerId, reminder\.id, "view"\)/);
  assert.match(api, /action: "view" \| "start" \| "later" \| "skip" \| "disable"/);
});

test("deepened learner assets remain recoverable, inspectable, and consent based", () => {
  const bookReader = readFileSync(join(process.cwd(), "components/book/BookReader.tsx"), "utf8");
  const bookExport = readFileSync(join(process.cwd(), "components/book/BookExportDialog.tsx"), "utf8");
  const knowledge = readFileSync(join(process.cwd(), "lib/knowledge-api.ts"), "utf8");
  const coWriter = readFileSync(join(process.cwd(), "app/(workspace)/co-writer/[docId]/page.tsx"), "utf8");
  const impact = readFileSync(join(process.cwd(), "components/learning/LearningImpactSummary.tsx"), "utf8");
  assert.match(bookReader, /listPageRevisions/);
  assert.match(bookReader, /restorePageRevision/);
  assert.match(bookExport, /PDF export settings/);
  assert.match(bookExport, /includeToc/);
  assert.match(knowledge, /uploadKnowledgeBaseFilesResumable/);
  assert.match(knowledge, /uploads\/resumable\/process/);
  assert.match(knowledge, /preflightKnowledgeUpload/);
  assert.match(coWriter, /Saved locally · waiting for connection/);
  assert.match(coWriter, /window\.addEventListener\("online"/);
  assert.match(impact, /data-testid="learning-impact-summary"/);
  assert.match(impact, /updateLearningExperimentConsent/);
  assert.match(impact, /raw messages and documents are never shared/);
});

test("book editorial gates and knowledge source jumps are versioned user actions", () => {
  const bookReader = readFileSync(join(process.cwd(), "components/book/BookReader.tsx"), "utf8");
  const bookReviews = readFileSync(join(process.cwd(), "components/book/BookStageReviews.tsx"), "utf8");
  const bookApi = readFileSync(join(process.cwd(), "lib/book-api.ts"), "utf8");
  const knowledge = readFileSync(join(process.cwd(), "components/knowledge/kb-index-versions.tsx"), "utf8");
  assert.match(bookReader, /<BookStageReviews bookId=\{book\.id\}/);
  assert.match(bookReviews, /data-testid="book-stage-reviews"/);
  assert.match(bookReviews, /expected_revision: current\?\.revision \|\| 0/);
  assert.match(bookApi, /\/stage-reviews/);
  assert.match(knowledge, /data-testid="knowledge-fragment-open-source"/);
  assert.match(knowledge, /#page=/);
  assert.match(knowledge, /FilePreviewDrawer/);
});
