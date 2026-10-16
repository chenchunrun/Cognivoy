/**
 * Machine-readable release floor inherited from Cognivoy v1.5.11.
 * Keep outcomes user-centered: implementations and routes may evolve, but a
 * story cannot silently disappear from the redesigned frontend.
 */
export const NATIVE_PARITY_STORIES = [
  "chat.activity",
  "chat.export_markdown",
  "chat.save_to_notebook",
  "chat.file_preview",
  "chat.voice_input",
  "chat.voice_autoplay",
  "chat.knowledge_grounding",
  "capability.chat",
  "capability.deep_solve",
  "capability.deep_question",
  "capability.deep_research",
  "capability.visualize",
  "capability.math_animator",
  "capability.mastery_path",
  "quiz.adaptive_generation",
  "cowriter.blank_document",
  "cowriter.template_document",
  "book.library",
  "partner.management",
  "partner.long_term_memory",
  "partner.proactive_reminders",
  "agent.import_and_scope",
  "agent.backend_settings",
  "knowledge.engine_selection",
  "knowledge.engine_availability",
  "memory.three_layers",
  "space.learning_assets",
] as const;

export type NativeParityStory = (typeof NATIVE_PARITY_STORIES)[number];

export const NATIVE_PARITY_ROUTES = [
  "/home",
  "/co-writer",
  "/book",
  "/partners",
  "/knowledge",
  "/memory",
  "/space",
  "/space/agents",
  "/settings/chat",
  "/settings/tools",
  "/settings/capabilities",
  "/settings/agents",
] as const;
