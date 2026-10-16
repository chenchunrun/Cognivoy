import test from "node:test";
import assert from "node:assert/strict";

import {
  NATIVE_PARITY_ROUTES,
  NATIVE_PARITY_STORIES,
} from "@/lib/native-parity";

test("native parity inventory keeps critical user stories explicit", () => {
  const stories = new Set<string>(NATIVE_PARITY_STORIES);
  for (const story of [
    "chat.activity",
    "chat.export_markdown",
    "chat.file_preview",
    "chat.knowledge_grounding",
    "capability.deep_solve",
    "capability.deep_question",
    "capability.deep_research",
    "capability.math_animator",
    "capability.mastery_path",
    "quiz.adaptive_generation",
    "cowriter.template_document",
    "partner.long_term_memory",
    "partner.proactive_reminders",
    "agent.import_and_scope",
    "knowledge.engine_availability",
    "memory.three_layers",
  ]) {
    assert.ok(stories.has(story), `${story} is missing from the release floor`);
  }
  assert.equal(stories.size, NATIVE_PARITY_STORIES.length, "duplicate parity story");
});

test("native parity routes cover every primary migrated surface", () => {
  const routes = new Set<string>(NATIVE_PARITY_ROUTES);
  for (const route of [
    "/home",
    "/co-writer",
    "/knowledge",
    "/space/agents",
    "/settings/agents",
  ]) {
    assert.ok(routes.has(route), `${route} is missing from the parity route set`);
  }
});
