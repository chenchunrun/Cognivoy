import test from "node:test";
import assert from "node:assert/strict";

import type { MessageItem } from "@/lib/chat-types";
import {
  artifactDiskPath,
  buildSessionActivity,
} from "@/lib/session-activity";

test("session activity separates uploads and generated deliverables", () => {
  const messages: MessageItem[] = [
    {
      role: "user",
      content: "Use these references",
      attachments: [
        { id: "upload-1", type: "file", filename: "notes.pdf" },
      ],
      requestSnapshot: {
        content: "Use these references",
        enabledTools: ["rag"],
        knowledgeBases: ["calculus"],
        language: "en",
        historyReferences: ["prior-session"],
        bookReferences: [{ book_id: "book-1", page_ids: ["p1", "p2"] }],
        notebookReferences: [
          { notebook_id: "notebook-1", record_ids: ["r1"] },
        ],
        questionNotebookReferences: [17],
        persona: "Socratic mentor",
        memoryReferences: ["summary", "profile"],
      },
    },
    {
      role: "assistant",
      content: "Done",
      events: [
        {
          type: "tool_call",
          source: "chat",
          stage: "exploring",
          content: "rag",
          metadata: { tool: "rag" },
          timestamp: 1,
        },
        {
          type: "tool_call",
          source: "chat",
          stage: "exploring",
          content: "rag",
          metadata: { tool: "rag" },
          timestamp: 2,
        },
      ],
      attachments: [
        {
          id: "artifact-1",
          type: "file",
          filename: "solution.docx",
          url: "/api/outputs/chat/solution.docx",
          generated: true,
          size_bytes: 2048,
        },
      ],
    },
  ];

  const activity = buildSessionActivity(messages);
  assert.equal(activity.isEmpty, false);
  assert.deepEqual(activity.tools, [{ name: "rag", count: 2 }]);
  assert.deepEqual(activity.knowledgeBases, ["calculus"]);
  assert.equal(activity.attachments[0]?.attachment.filename, "notes.pdf");
  assert.equal(activity.artifacts[0]?.attachment.filename, "solution.docx");
  assert.deepEqual(activity.space.historySessionIds, ["prior-session"]);
  assert.equal(activity.space.bookPageCount, 2);
  assert.equal(activity.space.notebookRecordCount, 1);
  assert.deepEqual(activity.space.questionEntryIds, [17]);
  assert.deepEqual(activity.space.personas, ["Socratic mentor"]);
  assert.deepEqual(activity.space.memoryKinds, ["summary", "profile"]);
});

test("session activity empty state and safe artifact paths stay deterministic", () => {
  assert.equal(buildSessionActivity([]).isEmpty, true);
  assert.equal(
    artifactDiskPath("/api/outputs/deep%20solve/result.pdf"),
    "deep solve/result.pdf",
  );
  assert.equal(artifactDiskPath("/api/attachments/private"), null);
});
