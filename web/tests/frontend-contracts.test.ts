import test from "node:test";
import assert from "node:assert/strict";
import {
  buildBookDraftTransfer,
  parseBookDraftTransfer,
} from "../lib/book-draft-transfer";

import { capabilityForPath } from "../lib/capability-routes";
import {
  parseVisualizeBridgeMessage,
  prepareIframeHtml,
} from "../lib/iframe-html";
import { stripMermaidFence } from "../lib/mermaid-render";
import {
  filterMemoryGraphNodes,
  type MemoryGraph,
} from "../lib/memory-graph";
import {
  getMemoryConflictAudit,
  getMemoryConflicts,
  getDeletedMemoryEntries,
  permanentlyDeleteMemoryEntry,
  resolveMemoryConflict,
  restoreDeletedMemoryEntry,
} from "../components/memory/api";
import { extractMathAnimatorResult } from "../lib/math-animator-types";
import { rerenderMathAnimatorSource } from "../lib/math-animator-api";
import { extractResearchOutlineResult } from "../lib/deep-research-types";
import { buildResearchWSConfig } from "../lib/research-types";
import {
  deletedKnowledgeBaseSet,
  referenceKnowledgeBaseName,
} from "../lib/knowledge-references";
import {
  enginePreflightReady,
  failedRequiredPreflightChecks,
  knowledgeErrorGuidance,
  persistedKnowledgeError,
} from "../lib/knowledge-readiness";
import {
  PARTNER_DETAIL_TABS,
  partnerAssetDeleteType,
} from "../lib/partner-detail";
import { partnerProgressLabel } from "../lib/partner-progress";
import { validateChannelConfig } from "../lib/partner-channel-validation";
import {
  buildVisualizeWSConfig,
  DEFAULT_VISUALIZE_CONFIG,
  extractVisualizeResult,
  summarizeVisualizeConfig,
} from "../lib/visualize-types";
import {
  buildQuizWSConfig,
  extractQuizQuestions,
  extractQuizTurnId,
  extractStreamingQuizQuestions,
  parseQuizJudgeVerdict,
  normalizeQuizJudgeAssessment,
  buildQuizRecoveryConfig,
  buildSimilarQuestionConfig,
} from "../lib/quiz-types";
import { latestSpaceTimestamp } from "../lib/space-metrics";
import { defaultSearchProvider } from "../lib/service-defaults";
import { isLongRunningRouteGroup, routeGroupsWithServerErrors } from "../lib/slo-display";
import { groupProgressSummaries, type ProgressSummary } from "../lib/learning-api";
import { questionOptionFeedbackState } from "../lib/question-feedback";
import {
  buildVisualizationSourceDownload,
  parseChartDataTable,
} from "../lib/visualization-assets";
import {
  normalizePlaybackRate,
  resolveMathAnimatorDownloads,
} from "../lib/math-animator-playback";
import { normalizeDefaultCapability } from "../context/app-shell-storage";
import {
  extractContextBudget,
  contextBudgetUsagePercent,
  estimateComposerContext,
} from "../lib/context-budget";
import {
  buildQuickRetrySnapshot,
  extractTerminalRecovery,
} from "../lib/chat-recovery";
import { normalizePptxPreview } from "../lib/pptx-preview";
import {
  previewSkillInstall,
  startReviewedSkillInstall,
  summarizeSkillInstallRisks,
} from "../lib/skills-api";
import {
  getCliAppInstallPreview,
  installReviewedCliApp,
} from "../lib/cli-apps-api";
import { apiFetch } from "../lib/api";
import { shouldPromoteDraftSessionToUrl } from "../lib/chat-route";

test("apiFetch adds the CSRF header only to unsafe browser requests", async () => {
  const previousFetch = globalThis.fetch;
  const calls: RequestInit[] = [];
  globalThis.fetch = (async (_input, init) => {
    calls.push(init ?? {});
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    await apiFetch("/read", { method: "GET" });
    await apiFetch("/write", { method: "POST", headers: { "Content-Type": "application/json" } });
  } finally {
    globalThis.fetch = previousFetch;
  }
  assert.equal(new Headers(calls[0]?.headers).get("X-Cognivoy-CSRF"), null);
  assert.equal(new Headers(calls[1]?.headers).get("X-Cognivoy-CSRF"), "1");
  assert.equal(new Headers(calls[1]?.headers).get("Content-Type"), "application/json");
});

test("home navigation clears history without bouncing back to the old session", () => {
  assert.equal(
    shouldPromoteDraftSessionToUrl("imported_old", null, "imported_old"),
    false,
  );
  assert.equal(shouldPromoteDraftSessionToUrl(null, null, "imported_old"), false);
  assert.equal(shouldPromoteDraftSessionToUrl("fresh_new", null, null), true);
  assert.equal(
    shouldPromoteDraftSessionToUrl("fresh_new", "fresh_new", null),
    false,
  );
});

test("CLI app installs expose exact command scope and require confirmation", async () => {
  const previousFetch = globalThis.fetch;
  const requests: Array<{ url: string; body: string }> = [];
  globalThis.fetch = (async (input, init) => {
    requests.push({ url: String(input), body: String(init?.body ?? "") });
    if (String(input).endsWith("/preview")) {
      return new Response(JSON.stringify({
        app_id: "demo", display_name: "Demo", origin: "catalog",
        trust: "third-party", runtime: "python", install_target: "demo==1",
        pinned: true, network_access: true,
        commands: [["python", "-m", "pip", "install", "demo==1"]],
        notes: "review", installable: true,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({
      task_id: "task-1", app_id: "demo", display_name: "Demo",
      status: "queued", log: "", message: "", created_at: "now", updated_at: "now",
    }), { status: 202, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    const preview = await getCliAppInstallPreview("demo");
    assert.deepEqual(preview.commands[0], ["python", "-m", "pip", "install", "demo==1"]);
    await installReviewedCliApp(preview);
  } finally {
    globalThis.fetch = previousFetch;
  }
  assert.equal(requests[0]?.url, "/api/v1/space/cli-apps/catalog/demo/install/preview");
  assert.equal(requests[1]?.url, "/api/v1/space/cli-apps/catalog/demo/install-jobs");
  assert.deepEqual(JSON.parse(requests[1]?.body ?? "{}"), { confirmed: true });
});

test("skill installs require a preview digest and preserve the chosen conflict policy", async () => {
  const previousFetch = globalThis.fetch;
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (input, init) => {
    requests.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    if (String(input).endsWith("/preview")) {
      return new Response(JSON.stringify({
        ref: { hub: "eduhub", slug: "demo", version: "1.0.0" },
        name: "demo",
        description: "Demo",
        files: [{ path: "SKILL.md", size_bytes: 20, allowed: true, reason: "" }],
        requirements: { bins: ["git"], env: ["TOKEN"], network: true },
        verdict: { status: "unknown", detail: "not scanned" },
        conflict: true,
        confirmation_digest: "abc123",
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({
      task_id: "skill-task-1", ref: "eduhub:demo@1.0.0", status: "queued",
      log: "", message: "", result: {}, created_at: "now", updated_at: "now",
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    const preview = await previewSkillInstall("eduhub:demo@1.0.0");
    assert.deepEqual(summarizeSkillInstallRisks(preview), [
      "Runs commands: git",
      "Needs secrets: TOKEN",
      "Uses network access",
      "Security verdict: unknown",
      "A skill with this name already exists",
    ]);
    await startReviewedSkillInstall(preview, "copy");
  } finally {
    globalThis.fetch = previousFetch;
  }
  assert.equal(requests[0]?.url, "/api/v1/skills/install/preview");
  assert.equal(requests[1]?.url, "/api/v1/skills/install-jobs");
  assert.equal(requests[1]?.body.confirmed, true);
  assert.equal(requests[1]?.body.confirmation_digest, "abc123");
  assert.equal(requests[1]?.body.conflict_strategy, "copy");
});

test("PPTX previews retain safe geometry and discard executable image payloads", () => {
  const preview = normalizePptxPreview({
    filename: "deck.pptx", width: 16, height: 9, slide_count: 1,
    slides: [{ number: 1, shapes: [
      { kind: "text", text: "Roadmap", x: 0.1, y: 0.2, width: 0.5, height: 0.2 },
      { kind: "image", data_url: "data:text/html;base64,PHNjcmlwdD4=", x: 0, y: 0, width: 1, height: 1 },
    ] }],
  });
  assert.equal(preview?.slides[0].shapes.length, 1);
  assert.equal(preview?.slides[0].shapes[0].text, "Roadmap");
});

test("knowledge tombstones identify only explicit knowledge-base references", () => {
  const deleted = deletedKnowledgeBaseSet([
    {
      name: "course-kb",
      status: "deleted",
      deleted_at: "2026-08-16T00:00:00Z",
      impact: {} as never,
    },
  ]);
  assert.equal(deleted.has("course-kb"), true);
  assert.equal(
    referenceKnowledgeBaseName({ type: "knowledge_base", name: "course-kb" }),
    "course-kb",
  );
  assert.equal(referenceKnowledgeBaseName({ type: "session", id: "course-kb" }), null);
});

test("edited Manim source uses the explicit rerender contract", async () => {
  const previousFetch = globalThis.fetch;
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (input, init) => {
    requests.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return new Response(JSON.stringify({
      output_mode: "video",
      artifacts: [{ type: "video", url: "/api/outputs/edit.mp4", filename: "edit.mp4" }],
      code: { language: "python", content: "class Demo: pass" },
      quality: "high",
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    const result = await rerenderMathAnimatorSource({
      parent_turn_id: "turn-12345678",
      code: "class Demo: pass",
      output_mode: "video",
      quality: "high",
      fps: 30,
    });
    assert.equal(result.artifacts[0]?.url, "/api/outputs/edit.mp4");
  } finally {
    globalThis.fetch = previousFetch;
  }
  assert.equal(requests[0]?.url, "/api/v1/plugins/math-animator/rerender");
  assert.equal(requests[0]?.body.parent_turn_id, "turn-12345678");
});

test("chat context budget is extracted from the authoritative result envelope", () => {
  const budget = extractContextBudget([
    {
      type: "result",
      source: "chat",
      stage: "responding",
      content: "done",
      timestamp: 1,
      metadata: {
        metadata: {
          context_budget: {
            window: 128_000,
            window_estimated: false,
            used_tokens: 32_000,
            free_tokens: 96_000,
            model: "gpt-test",
            counter: "tiktoken",
            deferred_tool_count: 4,
            segments: [
              { key: "messages", tokens: 20_000 },
              { key: "system_tools", tokens: 12_000 },
            ],
          },
        },
      },
    },
  ]);
  assert.equal(budget?.window, 128_000);
  assert.equal(budget?.segments[0].key, "messages");
  assert.equal(contextBudgetUsagePercent(budget!), 25);
  assert.equal(extractContextBudget([{ type: "result", metadata: {} }] as never), null);
});

test("composer context estimate accounts for references and warns before the window is exhausted", () => {
  const estimate = estimateComposerContext({
    text: "Explain the proof",
    attachmentBytes: 90_000,
    referenceCount: 4,
    knowledgeBaseCount: 2,
    contextWindow: 16_000,
  });
  assert.equal(estimate.contextWindow, 16_000);
  assert(estimate.estimatedTokens > 10_000);
  assert.equal(estimate.level, "warning");
  assert.equal(estimate.estimated, true);
});

test("terminal timeout recovery preserves the request and applies a bounded quick mode", () => {
  const recovery = extractTerminalRecovery([
    {
      type: "error",
      source: "client",
      content: "stopped",
      timestamp: 1,
      metadata: {
        turn_terminal: true,
        reason: "client_idle_timeout",
        status: "timed_out",
        retryable: true,
        timeout_seconds: 180,
      },
    },
  ] as never);
  assert.deepEqual(recovery, {
    reason: "client_idle_timeout",
    status: "timed_out",
    retryable: true,
    timeoutSeconds: 180,
  });

  const snapshot = buildQuickRetrySnapshot({
    content: "Research quantum sensing",
    capability: "deep_research",
    enabledTools: ["web_search"],
    knowledgeBases: ["physics"],
    language: "en",
    config: { depth: "deep", max_sources: 80, report_format: "markdown" },
  });
  assert.equal(snapshot.capability, "deep_research");
  assert.deepEqual(snapshot.enabledTools, ["web_search"]);
  assert.deepEqual(snapshot.config, {
    depth: "quick",
    max_sources: 12,
    report_format: "markdown",
  });
});

test("default capability settings reject unknown or legacy routes", () => {
  assert.equal(normalizeDefaultCapability("deep_research"), "deep_research");
  assert.equal(normalizeDefaultCapability("auto"), "auto");
  assert.equal(normalizeDefaultCapability("admin_shell"), "auto");
  assert.equal(normalizeDefaultCapability(null), "auto");
});

test("math animator playback and downloads stay within the viewer contract", () => {
  assert.equal(normalizePlaybackRate(1.5), 1.5);
  assert.equal(normalizePlaybackRate(7), 2);
  assert.equal(normalizePlaybackRate(Number.NaN), 1);
  assert.deepEqual(
    resolveMathAnimatorDownloads({
      response: "done",
      output_mode: "video",
      code: { language: "python", content: "class Scene: pass" },
      artifacts: [
        { type: "video", url: "/api/outputs/demo.mp4", filename: "demo.mp4" },
        { type: "image", url: "/api/outputs/frame.png", filename: "frame.png" },
      ],
      timings: {},
      render: {},
    }),
    [
      { kind: "video", url: "/api/outputs/demo.mp4", filename: "demo.mp4" },
      { kind: "image", url: "/api/outputs/frame.png", filename: "frame.png" },
      { kind: "code", content: "class Scene: pass", filename: "manim-scene.py" },
    ],
  );
});

test("visualization assets expose portable downloads and an accessible chart table", () => {
  assert.deepEqual(
    buildVisualizationSourceDownload(
      "chartjs",
      '```json\n{"type":"bar","data":{"labels":["A","B"],"datasets":[{"label":"Score","data":[3,5]},{"label":"Target","data":[4,4]}]}}\n```',
    ),
    {
      filename: "visualization.json",
      mimeType: "application/json;charset=utf-8",
      content: JSON.stringify(
        {
          type: "bar",
          data: {
            labels: ["A", "B"],
            datasets: [
              { label: "Score", data: [3, 5] },
              { label: "Target", data: [4, 4] },
            ],
          },
        },
        null,
        2,
      ),
    },
  );
  assert.deepEqual(
    parseChartDataTable(
      '{"data":{"labels":["A","B"],"datasets":[{"label":"Score","data":[3,5]},{"label":"Target","data":[4,4]}]}}',
    ),
    {
      columns: ["Label", "Score", "Target"],
      rows: [["A", 3, 4], ["B", 5, 4]],
    },
  );
  assert.deepEqual(buildVisualizationSourceDownload("html", "<main>Safe</main>"), {
    filename: "visualization.html",
    mimeType: "text/html;charset=utf-8",
    content: "<main>Safe</main>",
  });
});

test("space metrics keep the newest valid activity timestamp", () => {
  assert.equal(
    latestSpaceTimestamp([
      { updated_at: 100 },
      { updated_at: 250 },
      { updated_at: Number.NaN },
      { updated_at: -1 },
      {},
    ]),
    250,
  );
  assert.equal(latestSpaceTimestamp([]), undefined);
});

test("search settings materialize the built-in provider instead of none", () => {
  assert.equal(
    defaultSearchProvider([
      { value: "none" },
      { value: "brave" },
      { value: "duckduckgo" },
    ]),
    "duckduckgo",
  );
  assert.equal(defaultSearchProvider([{ value: "none" }, { value: "brave" }]), "brave");
});

test("SLO presentation identifies errors and long-running route groups", () => {
  assert.deepEqual(
    routeGroupsWithServerErrors([
      { name: "partners", server_errors: 1 },
      { name: "book", server_errors: 0 },
      { name: "sessions", server_errors: 1 },
    ]),
    ["partners", "sessions"],
  );
  assert.equal(isLongRunningRouteGroup("book"), true);
  assert.equal(isLongRunningRouteGroup("subagents"), true);
  assert.equal(isLongRunningRouteGroup("sessions"), false);
});

test("question choices reveal correctness only after the answer is expanded", () => {
  assert.deepEqual(
    questionOptionFeedbackState({
      answerVisible: false,
      isCorrectAnswer: true,
      isUserAnswer: false,
      entryIsCorrect: false,
    }),
    { revealCorrectAnswer: false, revealWrongPick: false },
  );
  assert.deepEqual(
    questionOptionFeedbackState({
      answerVisible: true,
      isCorrectAnswer: true,
      isUserAnswer: false,
      entryIsCorrect: false,
    }),
    { revealCorrectAnswer: true, revealWrongPick: false },
  );
});

test("mastery paths group normalized duplicate names without dropping history", () => {
  const summary = (book_id: string, name: string): ProgressSummary => ({
    book_id,
    name,
    modules_count: 1,
    kp_count: 2,
    current_stage: "diagnostic",
    avg_mastery_pct: 0,
    due_reviews: 0,
    evidence_count: 0,
    current_streak_days: 0,
    updated_at: 1,
  });
  const groups = groupProgressSummaries([
    summary("p1", "The Quadratic Formula"),
    summary("p2", " the   quadratic formula "),
    summary("p3", "Linear Algebra"),
  ]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].items.map((item) => item.book_id), ["p1", "p2"]);
  assert.equal(groups.flatMap((group) => group.items).length, 3);
});

test("failed quiz cards keep valid questions and expose a one-question recovery request", () => {
  const questions = extractQuizQuestions({
    summary: {
      results: [
        {
          qa_pair: {
            question_id: "q-missing",
            question: "Question generation failed for: limits",
            question_type: "written",
            correct_answer: "N/A",
            explanation: "Retry this quiz to regenerate the missing question.",
            difficulty: "hard",
            concentration: "limits",
          },
          metadata: { error: "question_generation_timeout", retryable: true },
        },
      ],
    },
  });
  assert.equal(questions?.[0].generation_error, "question_generation_timeout");
  assert.equal(questions?.[0].retryable, true);
  assert.deepEqual(buildQuizRecoveryConfig(questions[0]), {
    mode: "custom",
    topic: "limits",
    num_questions: 1,
    difficulty: "hard",
    question_types: ["written"],
  });
});

test("a saved mistake becomes a grounded one-question similar-practice request", () => {
  assert.deepEqual(
    buildSimilarQuestionConfig({
      question: "Solve x + 2 = 5",
      question_type: "short_answer",
      difficulty: "medium",
      correct_answer: "x = 3",
      explanation: "Subtract two.",
      knowledge_points: ["linear equations"],
      source_refs: [{ type: "book", id: "page-1" }],
    }),
    {
      mode: "custom",
      topic: "linear equations",
      num_questions: 1,
      difficulty: "medium",
      question_types: ["short_answer"],
      similar_to: {
        question: "Solve x + 2 = 5",
        correct_answer: "x = 3",
        explanation: "Subtract two.",
        source_refs: [{ type: "book", id: "page-1" }],
      },
    },
  );
});

test("AI quiz assessments retain score and flag low-confidence review", () => {
  assert.deepEqual(
    normalizeQuizJudgeAssessment({
      verdict: "partial",
      confidence: 0.68,
      score: 2.5,
      max_score: 4,
      review_recommended: true,
    }),
    {
      verdict: "partial",
      confidence: 0.68,
      score: 2.5,
      max_score: 4,
      review_recommended: true,
    },
  );
  assert.equal(normalizeQuizJudgeAssessment({ verdict: "correct", confidence: 9 }), null);
});
import {
  areMultipleChoiceAnswersEqual,
  normalizeQuizQuestionType,
  resolveMultipleChoiceAnswerKeys,
} from "../lib/quiz-question-type";
import {
  buildSelectGroups,
  filterRefsByScope,
  importRefsIncrementally,
  recommendedInitialScope,
} from "../lib/chat-import";
import { importErrorMessage } from "../lib/imports-api";
import {
  groupServerImportedAgents,
  scopeContainsSession,
} from "../lib/chat-import/attribution";
import { buildKnowledgeEngineOverview } from "../lib/knowledge-engine-overview";
import {
  formatKnowledgeTaskFailure,
  kbCanReindex,
  kbHasLiveProgress,
} from "../lib/knowledge-helpers";

test("knowledge task failures render structured diagnostics without object coercion", () => {
  assert.equal(
    formatKnowledgeTaskFailure({
      code: "knowledge_reindex_failed",
      message: "Re-indexing failed.",
      details: {},
      trace_id: "trace-123",
    }),
    "Re-indexing failed.\n\nDiagnostic ID: trace-123",
  );
  assert.equal(
    formatKnowledgeTaskFailure({
      detail: "Some files failed.",
      details: "chapter.pdf: unsupported encryption",
    }),
    "Some files failed.\n\nchapter.pdf: unsupported encryption",
  );
  assert.equal(
    formatKnowledgeTaskFailure({
      message: "Failed. Diagnostic ID: trace-123",
      trace_id: "trace-123",
    }),
    "Failed. Diagnostic ID: trace-123",
  );
});
import {
  effectiveVoiceAutoplay,
  isMissingTtsConfiguration,
  ttsConfiguredFromDependencies,
} from "../lib/voice-autoplay";
import { readResponseBytes, trustedPreviewUrl } from "../lib/file-preview";
import { buildLearnerTraceItems } from "../lib/learner-trace";
import {
  coWriterDraftKey,
  parseCoWriterDraft,
  serializeCoWriterDraft,
} from "../lib/co-writer-draft";
import type { StreamEvent, StreamEventType } from "../lib/unified-ws";
import { buildLearningDashboardSummary } from "../lib/learning-dashboard";
import { groupSessionsByLearningGoal } from "../lib/session-groups";
import { learningStageLabel } from "../lib/learning-stage";
import {
  clientIdleTimeoutMetadata,
  resolveChatIdleTimeoutSeconds,
} from "../context/app-shell-storage";
import { readSseStream } from "../components/playground/sse";
import {
  buildSessionListQuery,
  isSessionRuntimeStatus,
  resolveUpdatedFrom,
  SESSION_RUNTIME_STATUSES,
} from "../lib/session-api";
import {
  buildChatReferencePayload,
  toggleExclusiveAgent,
} from "../lib/chat-reference-selection";
import { bookCoverSrc, filterAndSortBooks } from "../lib/book-library";
import {
  buildNotebookEntryQuery,
  importNotebookMarkdown,
} from "../lib/notebook-api";
import {
  addNotebookRecord,
  updateNotebookRecord,
} from "../components/notebook/record-api";
import {
  buildQuizDraftKey,
  parseQuizDraft,
  serializeQuizDraft,
} from "../lib/quiz-draft";

test("quiz drafts are turn-scoped, versioned, and ignore stale question ids", () => {
  const key = buildQuizDraftKey("session/one", "turn:two");
  assert.equal(key, "cognivoy.quiz-draft.v1:session%2Fone:turn%3Atwo");

  const raw = serializeQuizDraft({
    q1: { value: "A,C", submitted: false, correct: null },
    stale: { value: "old", submitted: true, correct: false },
  });
  assert.deepEqual(parseQuizDraft(raw, ["q1"]), {
    q1: { value: "A,C", submitted: false, correct: null },
  });
  assert.deepEqual(parseQuizDraft("not json", ["q1"]), {});
  assert.deepEqual(parseQuizDraft(JSON.stringify({ version: 99, answers: {} }), ["q1"]), {});
});

test("question notebook filters serialize into a shareable backend query", () => {
  assert.equal(
    buildNotebookEntryQuery({
      q: "  quadratic  ",
      question_type: "written",
      difficulty: "hard",
      source_type: "knowledge_base",
      updated_from: 100,
      updated_to: 200,
      bookmarked: false,
      review_status: "due",
      project_id: "cisa-project",
      limit: 25,
      offset: 50,
    }).toString(),
    "q=quadratic&question_type=written&difficulty=hard&source_type=knowledge_base&updated_from=100&updated_to=200&bookmarked=false&review_status=due&project_id=cisa-project&limit=25&offset=50",
  );
});

test("book library combines search, status filtering, and authoritative-stat sorting", () => {
  const books = [
    {
      id: "b1",
      title: "Algebra",
      description: "Equations",
      status: "ready",
      updated_at: 10,
      statistics: { reading_progress_percent: 40, estimated_reading_minutes: 8 },
    },
    {
      id: "b2",
      title: "Geometry",
      description: "Algebraic geometry",
      status: "draft",
      updated_at: 20,
      statistics: { reading_progress_percent: 80, estimated_reading_minutes: 12 },
    },
    {
      id: "b3",
      title: "Advanced Algebra",
      description: "Proofs",
      status: "ready",
      updated_at: 30,
      statistics: { reading_progress_percent: 10, estimated_reading_minutes: 20 },
    },
  ];

  assert.deepEqual(
    filterAndSortBooks(books, {
      query: "algebra",
      status: "ready",
      sort: "progress",
    }).map((book) => book.id),
    ["b1", "b3"],
  );
  assert.deepEqual(
    filterAndSortBooks(books, { query: "", status: "all", sort: "reading_time" })
      .map((book) => book.id),
    ["b3", "b2", "b1"],
  );
});

test("book covers stay visible and refresh when their persisted revision changes", () => {
  assert.equal(
    bookCoverSrc({
      updated_at: 42,
      metadata: { cover_url: "/api/v1/book/books/book-1/cover" },
    }),
    "/api/v1/book/books/book-1/cover?v=42",
  );
  assert.equal(
    bookCoverSrc({
      updated_at: 43,
      metadata: { cover_url: "/cover?size=large" },
    }),
    "/cover?size=large&v=43",
  );
  assert.equal(bookCoverSrc({ updated_at: 44, metadata: {} }), null);
});

test("chat asset references serialize into the existing turn contract", () => {
  assert.deepEqual(
    buildChatReferencePayload({
      historySessionIds: ["session-1", "session-1", ""],
      notebooks: [
        { notebookId: "notes", recordIds: ["r1", "r1", "r2"] },
        { notebookId: "empty", recordIds: [] },
      ],
      questionEntryIds: [3, 3, 7],
      books: [
        { bookId: "book-1", pageIds: ["p1", "p2", "p1"] },
      ],
      memoryScopes: ["summary", "profile", "summary"],
    }),
    {
      notebookReferences: [
        { notebook_id: "notes", record_ids: ["r1", "r2"] },
      ],
      historyReferences: ["session-1"],
      questionNotebookReferences: [3, 7],
      bookReferences: [{ book_id: "book-1", page_ids: ["p1", "p2"] }],
      memoryReferences: ["summary", "profile"],
    },
  );
});

test("selecting an agent is exclusive without dropping document knowledge bases", () => {
  assert.deepEqual(
    toggleExclusiveAgent(
      ["course-notes", "Claude Code"],
      ["Claude Code", "Kimi CLI"],
      "Kimi CLI",
    ),
    ["course-notes", "Kimi CLI"],
  );
  assert.deepEqual(
    toggleExclusiveAgent(
      ["course-notes", "Kimi CLI"],
      ["Claude Code", "Kimi CLI"],
      "Kimi CLI",
    ),
    ["course-notes"],
  );
});

test("session history filters serialize with stable pagination and time bounds", () => {
  assert.equal(
    buildSessionListQuery(25, 50, {
      query: "  algebra  ",
      capability: "deep_question",
      updatedFrom: 100,
      updatedTo: 200,
    }).toString(),
    "limit=25&offset=50&q=algebra&capability=deep_question&updated_from=100&updated_to=200",
  );
});

test("frontend accepts every persisted turn lifecycle status", () => {
  assert.deepEqual(SESSION_RUNTIME_STATUSES, [
    "idle",
    "queued",
    "running",
    "waiting_for_input",
    "completed",
    "failed",
    "cancelled",
    "timed_out",
    "rejected",
  ]);
  for (const status of SESSION_RUNTIME_STATUSES) {
    assert.equal(isSessionRuntimeStatus(status), true);
  }
  assert.equal(isSessionRuntimeStatus("orphaned"), false);
  assert.equal(isSessionRuntimeStatus(null), false);
});

test("session time filters use an explicit clock and keep all-time unbounded", () => {
  assert.equal(resolveUpdatedFrom(7, 2_000_000), 1_395_200);
  assert.equal(resolveUpdatedFrom(0, 2_000_000), undefined);
  assert.equal(resolveUpdatedFrom(-1, 2_000_000), undefined);
});

test("capability route matching stays on path-segment boundaries", () => {
  assert.equal(capabilityForPath("/home/abc"), "llm");
  assert.equal(capabilityForPath("/book/abc"), "llm");
  assert.equal(capabilityForPath("/booklet"), null);
  assert.equal(capabilityForPath("/space/agents"), null);
});

test("agent imports support project, date, and conversation scopes", () => {
  const refs = [
    { externalId: "s-1", cwd: "/work/a", date: "2026-08-12", provisionalTitle: "One", lastModified: 2, sizeBytes: 10 },
    { externalId: "s-2", cwd: "/work/b", date: "2026-08-13", provisionalTitle: "Two", lastModified: 1, sizeBytes: 20 },
  ] as Parameters<typeof filterRefsByScope>[0];
  assert.deepEqual(filterRefsByScope(refs, { kind: "projects", cwds: ["/work/a"] }).map((ref) => ref.externalId), ["s-1"]);
  assert.deepEqual(filterRefsByScope(refs, { kind: "dates", days: ["2026-08-13"] }).map((ref) => ref.externalId), ["s-2"]);
  assert.deepEqual(filterRefsByScope(refs, { kind: "sessions", externalIds: ["s-2"] }).map((ref) => ref.externalId), ["s-2"]);
  assert.equal(scopeContainsSession({ kind: "sessions", externalIds: ["s-1"] }, { source: "codex", sourceCwd: "/work/a", externalId: "s-1" }, 0), true);
});

test("server-side opencode imports remain visible without a browser agent definition", () => {
  const groups = groupServerImportedAgents(
    [
      {
        id: "imported-opencode-1",
        session_id: "imported-opencode-1",
        title: "Imported",
        created_at: 1,
        updated_at: 2,
        message_count: 2,
        last_message: "",
        preferences: {
          import: {
            source: "opencode",
            agent_id: "connected:opencode:OpenCode",
            agent_name: "OpenCode",
          },
        },
      },
    ],
    [],
  );
  assert.deepEqual(groups, [
    {
      id: "connected:opencode:OpenCode",
      name: "OpenCode",
      source: "opencode",
      sessionIds: ["imported-opencode-1"],
    },
  ]);
});

test("Codex agent selection groups conversations by date", () => {
  const refs = [
    { externalId: "s-1", cwd: "/work/a", date: "2026-08-12", provisionalTitle: "One", lastModified: 2, sizeBytes: 10 },
    { externalId: "s-2", cwd: "/work/b", date: "2026-08-13", provisionalTitle: "Two", lastModified: 1, sizeBytes: 20 },
  ] as Parameters<typeof filterRefsByScope>[0];
  const groups = buildSelectGroups({ source: "codex", handle: {} as FileSystemDirectoryHandle, projects: [{ cwd: "/work", label: "work", sessions: refs }] });
  assert.deepEqual(groups.map((group) => group.key), ["2026-08-13", "2026-08-12"]);
  assert.deepEqual(
    recommendedInitialScope({
      source: "codex",
      handle: {} as FileSystemDirectoryHandle,
      projects: [{ cwd: "/work", label: "work", sessions: refs }],
    }),
    { kind: "dates", days: ["2026-08-13"] },
  );
});

test("agent history import parses and uploads bounded batches while skipping unreadable files", async () => {
  const ref = (id: string, handle: FileSystemFileHandle) => ({
    externalId: id,
    cwd: "/work",
    date: "2026-08-17",
    provisionalTitle: id,
    lastModified: 1,
    sizeBytes: 100,
    handle,
  });
  const validHandle = (id: string) => ({
    getFile: async () => new File([
      `${JSON.stringify({ timestamp: "2026-08-17T00:00:00Z", type: "session_meta", payload: { id, cwd: "/work", thread_source: "user" } })}\n`,
      `${JSON.stringify({ timestamp: "2026-08-17T00:00:01Z", type: "event_msg", payload: { type: "user_message", message: `question ${id}` } })}\n`,
      `${JSON.stringify({ timestamp: "2026-08-17T00:00:02Z", type: "event_msg", payload: { type: "agent_message", message: `answer ${id}` } })}\n`,
    ], `${id}.jsonl`, { lastModified: 1 }),
  }) as FileSystemFileHandle;
  const brokenHandle = {
    getFile: async () => { throw new Error("unreadable"); },
  } as unknown as FileSystemFileHandle;
  const batchSizes: number[] = [];
  const result = await importRefsIncrementally(
    "codex",
    [ref("one", validHandle("one")), ref("broken", brokenHandle), ref("two", validHandle("two"))],
    async (sessions) => {
      batchSizes.push(sessions.length);
      return { imported: sessions.length, skipped: 0 };
    },
    undefined,
    1,
  );
  assert.deepEqual(batchSizes, [1, 1]);
  assert.deepEqual(result, { imported: 2, skipped: 0, unreadable: 1 });
});

test("agent import API errors preserve the actionable server message", async () => {
  const response = new Response(JSON.stringify({
    message: "No sessions to import",
    trace_id: "trace-1",
  }), { status: 400, headers: { "Content-Type": "application/json" } });
  assert.equal(await importErrorMessage(response), "No sessions to import (trace-1)");
});

test("knowledge engine overview distinguishes setup, key, and install states", () => {
  const overview = buildKnowledgeEngineOverview(
    [
      { id: "llamaindex", name: "LlamaIndex", description: "local", configured: true, ready: false },
      { id: "pageindex", name: "PageIndex", description: "hosted", configured: false, requires_api_key: true },
      { id: "graphrag", name: "GraphRAG", description: "graph", configured: false, modes: ["local"], default_mode: "local" },
    ],
    [
      { name: "notes", statistics: { rag_provider: "llamaindex" } },
      { name: "graph", metadata: { rag_provider: "graphrag" } },
    ],
  );
  assert.deepEqual(
    overview.map(({ id, status, knowledgeBaseCount }) => ({ id, status, knowledgeBaseCount })),
    [
      { id: "llamaindex", status: "needs_setup", knowledgeBaseCount: 1 },
      { id: "pageindex", status: "needs_key", knowledgeBaseCount: 0 },
      { id: "graphrag", status: "not_installed", knowledgeBaseCount: 1 },
    ],
  );
});

test("cancelled knowledge jobs are terminal and retryable", () => {
  const kb = {
    name: "cancelled-kb",
    status: "cancelled",
    progress: { stage: "cancelled", task_id: "task-1" },
    statistics: { raw_documents: 1 },
  };
  assert.equal(kbHasLiveProgress(kb), false);
  assert.equal(kbCanReindex(kb), true);
});

test("voice autoplay session overrides win over the global default", () => {
  assert.equal(effectiveVoiceAutoplay(false, "default"), false);
  assert.equal(effectiveVoiceAutoplay(true, "default"), true);
  assert.equal(effectiveVoiceAutoplay(false, "on"), true);
  assert.equal(effectiveVoiceAutoplay(true, "off"), false);
});

test("voice playback distinguishes missing TTS setup from ordinary provider failures", () => {
  assert.equal(
    ttsConfiguredFromDependencies({
      dependencies: { media: { tts: { status: "configured" } } },
    }),
    true,
  );
  assert.equal(
    ttsConfiguredFromDependencies({
      dependencies: { media: { tts: { status: "not_configured" } } },
    }),
    false,
  );
  assert.equal(ttsConfiguredFromDependencies({}), null);
  assert.equal(
    isMissingTtsConfiguration(400, "No active TTS model is configured."),
    true,
  );
  assert.equal(isMissingTtsConfiguration(502, "TTS provider unavailable"), false);
});

test("playground SSE reader keeps CRLF, multiline, and final unterminated events", async () => {
  const events: Array<[string, Record<string, unknown>]> = [];
  const response = new Response(
    "event: stream\r\ndata: {\"message\":\r\ndata: \"hello\"}\r\n\r\nevent: result\ndata: {\"success\":true}",
  );
  await readSseStream(response, (type, payload) => events.push([type, payload]));
  assert.deepEqual(events, [
    ["stream", { message: "hello" }],
    ["result", { success: true }],
  ]);
});

test("visualize composer sends the backend render contract", () => {
  const config = {
    ...DEFAULT_VISUALIZE_CONFIG,
    render_mode: "manim_video" as const,
    quality: "high" as const,
    style_hint: "  chalkboard  ",
    aspect_ratio: "16:9" as const,
    width: 1920,
    height: 1080,
    duration_seconds: 45,
  };
  assert.deepEqual(
    buildVisualizeWSConfig(config),
    {
      render_mode: "manim_video",
      quality: "high",
      style_hint: "chalkboard",
      aspect_ratio: "16:9",
      theme: "auto",
      width: 1920,
      height: 1080,
      duration_seconds: 45,
      fps: 30,
      show_code: true,
      parameters: {},
    },
  );
  assert.equal(
    summarizeVisualizeConfig({
      ...DEFAULT_VISUALIZE_CONFIG,
      render_mode: "manim_image",
    }),
    "Storyboard · Medium",
  );
});

test("research composer sends explicit source, date, and report constraints", () => {
  assert.deepEqual(
    buildResearchWSConfig({
      mode: "report",
      depth: "deep",
      source_types: ["knowledge_base", "papers"],
      date_from: "2024-01-01",
      date_to: "2026-01-31",
      report_format: "literature_review",
      max_sources: 24,
      audience: " graduate students ",
    }),
    {
      mode: "report",
      depth: "deep",
      source_types: ["knowledge_base", "papers"],
      date_from: "2024-01-01",
      date_to: "2026-01-31",
      report_format: "literature_review",
      max_sources: 24,
      audience: "graduate students",
    },
  );
  assert.equal(
    buildResearchWSConfig({
      mode: "report",
      depth: "quick",
      checkpoint_id: "research_resume123",
    }).checkpoint_id,
    "research_resume123",
  );
});

test("visualize result decoder accepts text and Manim envelopes", () => {
  const text = extractVisualizeResult({ render_type: "svg", code: { language: "svg", content: "<svg/>" } });
  assert.equal(text?.render_type, "svg");
  const manim = extractVisualizeResult({ render_type: "manim_video", output_mode: "video", artifacts: [{ type: "video", url: "/x.mp4", filename: "x.mp4" }] });
  assert.equal(manim?.render_type, "manim_video");
});

test("generic capability results are not mistaken for Manim", () => {
  assert.equal(extractMathAnimatorResult({ response: "hello" }), null);
  assert.ok(extractMathAnimatorResult({ output_mode: "image", artifacts: [{ type: "image", url: "/x.png", filename: "x.png" }] }));
});

test("interactive HTML is sandbox-bridged without inheriting host privileges", () => {
  const prepared = prepareIframeHtml("<html><body><button>Try</button></body></html>");
  assert.match(prepared, /data-dt-bridge/);
  assert.match(prepared, /dt:visualize-prompt/);
  assert.doesNotMatch(prepared, /allow-same-origin/);
  assert.doesNotMatch(prepared, /window\.open|createObjectURL/);
  assert.deepEqual(
    parseVisualizeBridgeMessage({ type: "dt:visualize-prompt", text: "  explain this  ", token: "bridge" }),
    { type: "dt:visualize-prompt", text: "explain this", token: "bridge" },
  );
  assert.deepEqual(
    parseVisualizeBridgeMessage({ type: "dt:visualize-height", height: 50_000, token: "bridge" }),
    { type: "dt:visualize-height", height: 1_200, token: "bridge" },
  );
  assert.equal(parseVisualizeBridgeMessage({ type: "dt:visualize-height", height: "600", token: "bridge" }), null);
  assert.deepEqual(
    parseVisualizeBridgeMessage({ type: "dt:visualize-escape", token: "bridge" }),
    { type: "dt:visualize-escape", token: "bridge" },
  );
  assert.equal(parseVisualizeBridgeMessage({ type: "dt:visualize-escape" }), null);
  assert.match(prepared, /document\.addEventListener\("keydown"/);
  assert.match(prepared, /type: "dt:visualize-escape"/);
});

test("file previews accept only server-owned paths", () => {
  const origin = "https://mentor.example";
  assert.equal(
    trustedPreviewUrl("/api/outputs/session/note.md", origin),
    "/api/outputs/session/note.md",
  );
  assert.equal(
    trustedPreviewUrl("https://mentor.example/api/attachments/abc", origin),
    "/api/attachments/abc",
  );
  assert.equal(
    trustedPreviewUrl("/api/v1/knowledge/math/files/lesson.pdf", origin),
    "/api/v1/knowledge/math/files/lesson.pdf",
  );
  assert.equal(trustedPreviewUrl("//evil.example/file.pdf", origin), null);
  assert.equal(trustedPreviewUrl("data:text/html,<script>alert(1)</script>", origin), null);
  assert.equal(trustedPreviewUrl("/api/v1/settings", origin), null);
});

test("file preview byte limits also apply to chunked responses", async () => {
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5, 6]));
        controller.close();
      },
    }),
  );
  await assert.rejects(() => readResponseBytes(response, 5), /too large/i);
});

test("learner progress never exposes raw reasoning, protocols, args, or tool results", () => {
  const event = (
    type: StreamEventType,
    content: string,
    metadata: Record<string, unknown>,
  ): StreamEvent => ({
    type,
    content,
    metadata,
    source: "test",
    stage: "test",
    timestamp: 0,
  });
  const items = buildLearnerTraceItems(
    [
      event("thinking", "system says English; user says Chinese", {}),
      event("content", "THINK private protocol", { call_id: "n1" }),
      event("tool_call", "", { tool_name: "web_search", tool_call_id: "t1", args: { query: "secret" } }),
      event("tool_result", "raw provider payload", { tool_call_id: "t1" }),
      event("observation", "JSON schema internals", {}),
      event("progress", "正在校验答案", { trace_kind: "progress_summary" }),
      event("progress", "正在校验答案", { trace_kind: "progress_summary" }),
      event("progress", "Search failed\nTraceback (most recent call last): File \"/tmp/private.py\"", {
        trace_kind: "raw_log",
        trace_layer: "raw",
      }),
      event("progress", "部分资料源超时，已使用现有证据继续。", { trace_kind: "warning" }),
    ],
    false,
  );

  assert.deepEqual(items, [
    { kind: "tool", key: "c0", name: "web_search", pending: false, failed: false },
    { kind: "progress", key: "p1", text: "正在校验答案" },
    { kind: "warning", key: "p2", text: "部分资料源超时，已使用现有证据继续。" },
  ]);
});

test("learner trace recognizes explicit and legacy nested failures", () => {
  const event = (type: StreamEventType, metadata: Record<string, unknown>): StreamEvent => ({
    type, metadata, content: "", source: "test", stage: "exploring", timestamp: 0,
  });
  for (const metadata of [
    { success: false }, { error: "failed" },
    { tool_metadata: { error: "worker exited" } },
    { tool_metadata: { success: false } },
  ]) {
    const items = buildLearnerTraceItems([
      event("tool_call", { tool_name: "web_search", tool_call_id: "t1" }),
      event("tool_result", { ...metadata, tool_call_id: "t1" }),
    ], false);
    assert.equal(items[0].kind === "tool" && items[0].failed, true);
  }
  const call = event("tool_call", { tool_name: "web_search" });
  assert.deepEqual(buildLearnerTraceItems([call], false)[0], {
    kind: "tool", key: "c0", name: "web_search", pending: false, failed: true,
  });
  assert.deepEqual(buildLearnerTraceItems([call], true)[0], {
    kind: "tool", key: "c0", name: "web_search", pending: true, failed: false,
  });
});

test("RAG provenance remains visible when a retrieved chunk has no public URL", () => {
  const items = buildLearnerTraceItems(
    [
      {
        type: "sources",
        content: "",
        source: "rag",
        stage: "exploring",
        timestamp: 0,
        metadata: {
          sources: [
            {
              type: "rag",
              kb_name: "Course KB",
              title: "Fourier notes · chunk 7",
              chunk_id: "chunk-7",
            },
          ],
        },
      },
    ],
    false,
  );

  assert.deepEqual(items, [
    {
      kind: "sources",
      key: "s0",
      sources: [{ title: "Fourier notes · chunk 7", url: "" }],
    },
  ]);
});

test("co-writer local recovery drafts are document-scoped and size-bounded", () => {
  const raw = serializeCoWriterDraft({
    documentId: "doc-1",
    title: "Offline title",
    content: "Unsaved offline paragraph",
    baseRevision: 3,
    savedAt: 42,
  });
  assert.equal(coWriterDraftKey("doc/1"), "cognivoy:co-writer:draft:doc%2F1");
  assert.equal(parseCoWriterDraft(raw, "doc-1")?.content, "Unsaved offline paragraph");
  assert.equal(parseCoWriterDraft(raw, "doc-2"), null);
  assert.equal(
    serializeCoWriterDraft({
      documentId: "doc-1",
      title: "large",
      content: "x".repeat(1_600_000),
      baseRevision: 1,
      savedAt: 1,
    }),
    null,
  );
});

test("long-running capabilities receive a safe no-event timeout floor", () => {
  assert.equal(resolveChatIdleTimeoutSeconds(180, "chat"), 180);
  assert.equal(resolveChatIdleTimeoutSeconds(180, "visualize"), 300);
  assert.equal(resolveChatIdleTimeoutSeconds(180, "deep_research"), 600);
  assert.equal(resolveChatIdleTimeoutSeconds(900, "math_animator"), 900);
});

test("client idle timeout is a retryable terminal reason", () => {
  assert.deepEqual(clientIdleTimeoutMetadata(180), {
    turn_terminal: true,
    status: "failed",
    reason: "client_idle_timeout",
    retryable: true,
    timeout_seconds: 180,
  });
});

test("learning dashboard prioritizes due reviews, weak topics, and resumable work", () => {
  const summary = buildLearningDashboardSummary(
    [
      { session_id: "old", id: "1", title: "Old", created_at: 1, updated_at: 1, message_count: 2, last_message: "" },
      { session_id: "recent", id: "2", title: "Algebra", created_at: 2, updated_at: 5, message_count: 4, last_message: "" },
    ],
    [{ book_id: "path", name: "Calculus", modules_count: 1, kp_count: 3, current_stage: "practice", avg_mastery_pct: 60, due_reviews: 2, evidence_count: 4, current_streak_days: 2, updated_at: 4 }],
    [{ question: "Discriminant", id: 1 }, { question: "Discriminant", id: 2 }, { question: "Factoring", id: 3 }] as never,
    2,
  );
  assert.equal(summary.dueReviews, 2);
  assert.deepEqual(summary.weakTopics, ["Discriminant", "Factoring"]);
  assert.equal(summary.continueSession?.session_id, "recent");
  assert.equal(summary.continuePath?.book_id, "path");
});

test("recent sessions group by course first and capability otherwise", () => {
  const groups = groupSessionsByLearningGoal([
    { session_id: "kb", id: "1", title: "Vectors", created_at: 1, updated_at: 3, message_count: 2, last_message: "", preferences: { knowledge_bases: ["Linear Algebra"], capability: "chat" } },
    { session_id: "quiz", id: "2", title: "Quiz", created_at: 1, updated_at: 2, message_count: 2, last_message: "", preferences: { capability: "deep_question" } },
  ]);
  assert.deepEqual(groups.map((group) => group.label), ["Linear Algebra", "deep_question"]);
});

test("Mermaid source normalization removes only Mermaid code fences", () => {
  assert.equal(
    stripMermaidFence("```mermaid\nflowchart TD\n  A --> B\n```"),
    "flowchart TD\n  A --> B",
  );
  assert.equal(stripMermaidFence("graph LR\nA --> B"), "graph LR\nA --> B");
  assert.equal(
    stripMermaidFence("```json\n{\"type\":\"bar\"}\n```"),
    "```json\n{\"type\":\"bar\"}\n```",
  );
});

test("deep research outline previews decode into an actionable result", () => {
  const result = extractResearchOutlineResult({
    type: "result",
    source: "deep_research",
    stage: "",
    content: "",
    metadata: {
      outline_preview: true,
      topic: "RAG",
      sub_topics: [{ title: "Architecture", overview: "Retrieval and generation" }],
      research_config: { mode: "report", depth: "quick" },
    },
    timestamp: 1,
  });
  assert.deepEqual(result, {
    topic: "RAG",
    subTopics: [{ title: "Architecture", overview: "Retrieval and generation" }],
    config: { mode: "report", depth: "quick" },
  });
});

test("quiz composer sends adaptive generation controls", () => {
  assert.deepEqual(
    buildQuizWSConfig({
      mode: "custom",
      topic: "",
      num_questions: 4,
      difficulty: "hard",
      question_types: ["choice", "written"],
      per_type_counts: { choice: 3, written: 1 },
      paper_path: "",
      max_questions: 10,
    }),
    {
      mode: "custom",
      num_questions: 4,
      difficulty: "hard",
      question_types: ["choice", "written"],
      per_type_counts: { choice: 3, written: 1 },
    },
  );
});

test("multiple-choice questions preserve set semantics instead of collapsing to radio", () => {
  assert.equal(normalizeQuizQuestionType("multiple_choice"), "multiple_choice");
  assert.deepEqual(
    resolveMultipleChoiceAnswerKeys(["C", "A", "C"], {
      A: "2",
      B: "4",
      C: "5",
      D: "6",
    }),
    ["A", "C"],
  );
  assert.equal(areMultipleChoiceAnswersEqual("C,A", "A,C"), true);
  assert.equal(areMultipleChoiceAnswersEqual("A", "A,C"), false);
});

test("quiz composer exposes the PDF mimic contract", () => {
  assert.deepEqual(
    buildQuizWSConfig({
      mode: "mimic",
      topic: "",
      num_questions: 3,
      difficulty: "auto",
      question_types: [],
      per_type_counts: {},
      paper_path: "",
      max_questions: 8,
    }),
    { mode: "mimic", paper_path: "", max_questions: 8 },
  );
});

test("AI quiz verdict parser is conservative for subjective grading", () => {
  assert.equal(parseQuizJudgeVerdict("✅ Correct — equivalent derivation."), true);
  assert.equal(parseQuizJudgeVerdict("⚠️ Partially correct — missing a case."), false);
  assert.equal(parseQuizJudgeVerdict("❌ Incorrect — sign error."), false);
  assert.equal(parseQuizJudgeVerdict("判定暂不明确"), null);
});

test("quiz result and streaming envelopes decode to the same card contract", () => {
  const streamed = extractStreamingQuizQuestions([
    {
      type: "content",
      metadata: {
        call_kind: "quiz_question_emitted",
        question_index: 0,
        qa_pair: {
          question_id: "q_1",
          question: "2 + 2?",
          question_type: "choice",
          options: { A: "3", B: "4" },
          correct_answer: "B",
          explanation: "Addition",
        },
      },
    },
  ]);
  const settled = extractQuizQuestions({
    summary: {
      results: [
        {
          qa_pair: {
            question_id: "q_1",
            question: "2 + 2?",
            question_type: "choice",
            options: { A: "3", B: "4" },
            correct_answer: "B",
            explanation: "Addition",
          },
        },
      ],
    },
  });
  assert.deepEqual(streamed, settled);
});

test("quiz persistence is scoped to the producing turn", () => {
  assert.equal(
    extractQuizTurnId([
      { type: "content", turn_id: "turn-stream" },
      { type: "result", turn_id: "turn-result" },
    ]),
    "turn-result",
  );
  assert.equal(extractQuizTurnId([{ type: "content" }]), null);
});

test("learning stages expose learner-friendly progress instead of internal identifiers", () => {
  assert.equal(
    learningStageLabel("ideation", "deep_question"),
    "Designing suitable questions · about 10–15 seconds",
  );
  assert.equal(
    learningStageLabel("unknown_internal_stage", "chat"),
    "Preparing the next learning step",
  );
});

test("partner detail separates the eight PRD responsibilities", () => {
  assert.deepEqual(
    PARTNER_DETAIL_TABS.map((tab) => tab.id),
    [
      "overview",
      "chat",
      "soul",
      "resources",
      "channels",
      "sessions",
      "proactive",
      "activity",
    ],
  );
  assert.equal(partnerAssetDeleteType("knowledge_bases"), "knowledge_base");
  assert.equal(partnerAssetDeleteType("skills"), "skill");
  assert.equal(partnerAssetDeleteType("notebooks"), "notebook");
});

test("partner chat reports the latest meaningful activity", () => {
  const base = {
    source: "chat",
    stage: "exploring",
    content: "",
    timestamp: 0,
  };
  assert.equal(
    partnerProgressLabel([
      { ...base, type: "thinking", metadata: {} },
      {
        ...base,
        type: "tool_call",
        content: "partner_search",
        metadata: {},
      },
    ]),
    "Searching past conversations…",
  );
  assert.equal(
    partnerProgressLabel([
      { ...base, type: "tool_call", metadata: { name: "ask_user" } },
    ]),
    "Preparing diagnostic questions…",
  );
  assert.equal(partnerProgressLabel([]), "Thinking…");
});

test("enabled partner channels reject missing credentials before save", () => {
  const entry = {
    name: "telegram",
    display_name: "Telegram",
    default_config: {},
    secret_fields: ["token"],
    required_when_enabled: ["token", "allow_from"],
    json_schema: null,
  };
  assert.deepEqual(
    validateChannelConfig(entry, { enabled: true, token: "", allow_from: [] }),
    ["token", "allow_from"],
  );
  assert.deepEqual(
    validateChannelConfig(entry, {
      enabled: true,
      token: "secret",
      allow_from: ["*"],
    }),
    [],
  );
  assert.deepEqual(
    validateChannelConfig(entry, { enabled: false, token: "", allow_from: [] }),
    [],
  );
});

test("memory graph search and layer filters produce an accessible node set", () => {
  const graph = {
    nodes: [
      { id: "l1", layer: "L1", cluster: "L1:chat", label: "Calculus chat", preview: "limits", href: "/l1", x: 0, y: 0, r: 2 },
      { id: "l2", layer: "L2", cluster: "L2:chat", section: "Preferences", label: "Learning style", preview: "rigorous derivations", href: "/l2", x: 0, y: 0, r: 4 },
      { id: "l3", layer: "L3", cluster: "L3:profile", label: "Profile", preview: "visual learner", href: "/l3", x: 0, y: 0, r: 6 },
      { id: "anchor", layer: "L2", cluster: "L2:chat", label: "Chat", preview: "", href: "/l2", x: 0, y: 0, r: 0 },
    ],
    edges: [],
    clusters: [],
    adjacency: new Map(),
    nodeCluster: new Map(),
  } as unknown as MemoryGraph;
  assert.deepEqual(
    [...filterMemoryGraphNodes(graph, "derivations", new Set(["L1", "L2", "L3"]))],
    ["l2", "anchor"],
  );
  assert.deepEqual(
    [...filterMemoryGraphNodes(graph, "", new Set(["L3"]))],
    ["l3"],
  );
});

test("memory trash client preserves layer, key, and entry identity", async () => {
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string }> = [];
  globalThis.fetch = (async (input, init) => {
    calls.push({
      url: String(input),
      method: String(init?.method ?? "GET"),
    });
    return new Response(
      JSON.stringify({
        items: [
          {
            layer: "L2",
            key: "chat",
            deleted_at: "2026-08-15T00:00:00Z",
            entry: {
              id: "m_01HZK1ABCDEFGHJKMNPQRSTVWX",
              section: "Facts",
              text: "Worked examples help",
              refs: ["chat:turn-1"],
            },
          },
        ],
        total: 1,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const result = await getDeletedMemoryEntries("L2", "chat");
    assert.equal(result.total, 1);
    assert.equal(result.items[0].entry.refs[0], "chat:turn-1");
    await restoreDeletedMemoryEntry(
      "L2",
      "chat",
      "m_01HZK1ABCDEFGHJKMNPQRSTVWX",
    );
    await permanentlyDeleteMemoryEntry(
      "L2",
      "chat",
      "m_01HZK1ABCDEFGHJKMNPQRSTVWX",
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
  assert.deepEqual(calls, [
    { url: "/api/v1/memory/trash?layer=L2&key=chat", method: "GET" },
    {
      url: "/api/v1/memory/trash/L2/chat/m_01HZK1ABCDEFGHJKMNPQRSTVWX/restore",
      method: "POST",
    },
    {
      url: "/api/v1/memory/trash/L2/chat/m_01HZK1ABCDEFGHJKMNPQRSTVWX",
      method: "DELETE",
    },
  ]);
});

test("memory conflict client lists evidence, resolves, and reloads audit", async () => {
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  globalThis.fetch = (async (input, init) => {
    calls.push({
      url: String(input),
      method: String(init?.method ?? "GET"),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify({ items: [], total: 0, kept_ids: ["left"] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  try {
    await getMemoryConflicts();
    await resolveMemoryConflict({
      conflict_id: "L3:profile:left:right",
      layer: "L3",
      key: "profile",
      left_id: "left",
      right_id: "right",
      action: "merge",
      merged_text: "Merged statement",
      reason: "Confirmed by learner",
    });
    await getMemoryConflictAudit();
  } finally {
    globalThis.fetch = previousFetch;
  }
  assert.deepEqual(calls, [
    { url: "/api/v1/memory/conflicts", method: "GET", body: undefined },
    {
      url: "/api/v1/memory/conflicts/resolve",
      method: "POST",
      body: {
        conflict_id: "L3:profile:left:right",
        layer: "L3",
        key: "profile",
        left_id: "left",
        right_id: "right",
        action: "merge",
        merged_text: "Merged statement",
        reason: "Confirmed by learner",
      },
    },
    { url: "/api/v1/memory/conflicts/audit", method: "GET", body: undefined },
  ]);
});

test("notebook writes carry idempotency, revision, tags, references, and markdown mode", async () => {
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  globalThis.fetch = (async (input, init) => {
    calls.push({
      url: String(input),
      method: String(init?.method ?? "GET"),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(
      JSON.stringify({
        success: true,
        record: { id: "r1", type: "chat", title: "T", user_query: "Q", output: "A", revision: 2 },
        imported_count: 1,
        replaced_count: 0,
        records: [],
        updated_at: 1,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    await addNotebookRecord({
      notebookId: "nb1",
      title: "T",
      userQuery: "Q",
      output: "A",
      tags: ["math"],
      references: [{ type: "session", id: "turn-1" }],
      idempotencyKey: "save:turn-1",
    });
    await updateNotebookRecord("nb1", "r1", {
      output: "Revised",
      expected_revision: 1,
      tags: ["math", "reviewed"],
    });
    await importNotebookMarkdown("nb1", {
      content: "# Notes",
      mode: "replace",
      idempotency_key: "import:notes:v1",
    });
  } finally {
    globalThis.fetch = previousFetch;
  }
  assert.deepEqual(calls, [
    {
      url: "/api/v1/notebook/add_record",
      method: "POST",
      body: {
        notebook_ids: ["nb1"],
        record_type: "chat",
        title: "T",
        summary: "A",
        user_query: "Q",
        output: "A",
        metadata: {},
        tags: ["math"],
        references: [{ type: "session", id: "turn-1" }],
        idempotency_key: "save:turn-1",
      },
    },
    {
      url: "/api/v1/notebook/nb1/records/r1",
      method: "PUT",
      body: { output: "Revised", expected_revision: 1, tags: ["math", "reviewed"] },
    },
    {
      url: "/api/v1/notebook/nb1/import-markdown",
      method: "POST",
      body: { content: "# Notes", mode: "replace", idempotency_key: "import:notes:v1" },
    },
  ]);
});

test("research reports transfer to the reviewed book creator without URL-sized content", () => {
  const content = "# Research report\n\n" + "Evidence with citations. ".repeat(500);
  const transfer = buildBookDraftTransfer({
    sourceType: "deep_research",
    sourceId: "message-42",
    title: "Research report",
    content,
  });
  const restored = parseBookDraftTransfer(JSON.stringify(transfer));
  assert.equal(restored?.sourceType, "deep_research");
  assert.equal(restored?.sourceId, "message-42");
  assert.equal(restored?.content, content);
  assert.match(transfer.key, /^book-draft:/);
  assert.ok(transfer.intent.includes("Build a structured learning book"));
});

test("knowledge creation is gated by required engine preflight checks", () => {
  const missingEmbedding = {
    ok: false,
    checks: [
      {
        key: "embedding",
        label: "Active embedding model",
        ok: false,
        detail: "Configure one under Settings → Embedding.",
        optional: false,
      },
      {
        key: "bm25",
        label: "BM25",
        ok: false,
        detail: "Optional",
        optional: true,
      },
    ],
  };
  assert.equal(enginePreflightReady(missingEmbedding, false, null), false);
  assert.equal(failedRequiredPreflightChecks(missingEmbedding).length, 1);
  assert.equal(enginePreflightReady({ ok: true, checks: [] }, false, null), true);
  assert.equal(enginePreflightReady({ ok: true, checks: [] }, true, null), false);
});

test("persisted knowledge errors survive refresh and point to repair settings", () => {
  const kb = {
    name: "failed-kb",
    status: "error",
    metadata: {
      last_error: "No active embedding model is configured.",
      last_error_at: "2026-08-17T10:00:00",
    },
  };
  const error = persistedKnowledgeError(kb);
  assert.equal(error, "No active embedding model is configured.");
  assert.deepEqual(knowledgeErrorGuidance(error), {
    code: "embedding",
    settingsPath: "/settings/embedding",
  });
});
