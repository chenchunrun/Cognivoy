import test from "node:test";
import assert from "node:assert/strict";

import { buildChatMarkdown } from "@/lib/chat-export";

test("chat markdown export preserves uploads and linked generated deliverables", () => {
  const markdown = buildChatMarkdown(
    [
      {
        role: "user",
        content: "Review my notes",
        attachments: [
          { filename: "notes.pdf", mime_type: "application/pdf" },
        ],
      },
      {
        role: "assistant",
        capability: "deep_solve",
        content: "Here is the result.",
        attachments: [
          {
            filename: "solution.md",
            mime_type: "text/markdown",
            url: "/api/outputs/deep-solve/solution.md",
            generated: true,
            size_bytes: 128,
          },
        ],
      },
    ],
    {
      title: "Algebra session",
      exportedAt: new Date("2026-08-13T00:00:00.000Z"),
    },
  );

  assert.match(markdown, /^# Algebra session/);
  assert.match(markdown, /`notes\.pdf` \(attached, application\/pdf\)/);
  assert.match(
    markdown,
    /\[solution\.md\]\(\/api\/outputs\/deep-solve\/solution\.md\) \(generated, text\/markdown, 128 bytes\)/,
  );
  assert.match(markdown, /## Assistant _\(deep_solve\)_/);
});

test("chat markdown export does not embed executable or base64 attachment URLs", () => {
  const markdown = buildChatMarkdown([
    {
      role: "assistant",
      content: "unsafe links are omitted",
      attachments: [
        { filename: "payload.txt", url: "javascript:alert(1)" },
        { filename: "large.bin", url: "data:application/octet-stream;base64,AAAA" },
      ],
    },
  ]);

  assert.doesNotMatch(markdown, /javascript:|data:/);
  assert.match(markdown, /`payload\.txt`/);
  assert.match(markdown, /`large\.bin`/);
});
