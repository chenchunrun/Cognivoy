export type RoutedLearningCapability =
  | "chat"
  | "deep_question"
  | "deep_research"
  | "visualize"
  | "mastery_path"
  | "deep_solve";

/** Fast local mirror of the server's deterministic Auto-mode router.
 * The server remains authoritative; this function exists only so learners can
 * see a useful preflight before sending a turn.
 */
export function previewLearningCapability(text: string): RoutedLearningCapability {
  if (/(出题|测验|练习题|题目卡|quiz|practice questions?|test me)/i.test(text)) return "deep_question";
  if (/(深度研究|调研|文献综述|论文检索|research|literature review)/i.test(text)) return "deep_research";
  if (/(可视化|画图|图表|流程图|动画|visuali[sz]e|diagram|chart|animate)/i.test(text)) return "visualize";
  if (/(精通之路|掌握.*知识点|学习路径|mastery path|guided learning)/i.test(text)) return "mastery_path";
  if (/(求解|解方程|证明|计算|推导|验证.*解|solve|prove|calculate|derive|equation)/i.test(text)) return "deep_solve";
  return "chat";
}

export function capabilityTimeRange(capability: string): string {
  if (capability === "deep_research") return "3–10 min";
  if (capability === "visualize") return "1–5 min";
  if (capability === "deep_solve" || capability === "deep_question") return "30 sec–3 min";
  if (capability === "mastery_path") return "1–5 min";
  return "a few seconds";
}
