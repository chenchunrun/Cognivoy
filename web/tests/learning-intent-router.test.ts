import assert from "node:assert/strict";
import test from "node:test";

import { capabilityTimeRange, previewLearningCapability } from "../lib/learning-intent-router";

test("auto learning preview mirrors explicit learner intents", () => {
  assert.equal(previewLearningCapability("请给我出三道二次方程练习题"), "deep_question");
  assert.equal(previewLearningCapability("深度研究 RAG 的最新论文"), "deep_research");
  assert.equal(previewLearningCapability("把正弦函数画成可视化动画"), "visualize");
  assert.equal(previewLearningCapability("求解 x²-5x+6=0 并验证"), "deep_solve");
  assert.equal(previewLearningCapability("为线性代数建立精通之路"), "mastery_path");
  assert.equal(previewLearningCapability("解释一下傅里叶变换"), "chat");
});

test("preflight estimates keep long tasks visibly distinct", () => {
  assert.equal(capabilityTimeRange("deep_research"), "3–10 min");
  assert.notEqual(capabilityTimeRange("deep_research"), capabilityTimeRange("chat"));
});
