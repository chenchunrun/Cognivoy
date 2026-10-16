export interface CoWriterTemplate {
  id: "learning-note" | "research-report" | "lesson-plan";
  title: { en: string; zh: string };
  description: { en: string; zh: string };
  defaultTitle: { en: string; zh: string };
  content: { en: string; zh: string };
}

export const CO_WRITER_TEMPLATES: CoWriterTemplate[] = [
  {
    id: "learning-note",
    title: { en: "Learning note", zh: "学习笔记" },
    description: {
      en: "Capture a concept, examples, questions, and a review checklist.",
      zh: "记录概念、例子、疑问和复习清单。",
    },
    defaultTitle: { en: "Learning Note", zh: "学习笔记" },
    content: {
      en: `# Learning Note

## What I want to understand

Describe the concept or question in your own words.

## Key ideas

- Core idea
- Important relationship
- Common misconception

## Worked example

Walk through one representative example step by step.

## Questions to revisit

- [ ] What is still unclear?
- [ ] Can I explain this without notes?

## Summary

Write a three-sentence summary for your future self.
`,
      zh: `# 学习笔记

## 我想弄懂什么

用自己的话描述概念或问题。

## 核心要点

- 核心概念
- 重要关系
- 常见误区

## 例题推演

选择一个代表性例子，逐步写出过程。

## 待复习问题

- [ ] 还有什么不清楚？
- [ ] 能否脱离笔记讲明白？

## 总结

用三句话写给未来的自己。
`,
    },
  },
  {
    id: "research-report",
    title: { en: "Research report", zh: "研究报告" },
    description: {
      en: "Structure a question, evidence, analysis, and cited conclusions.",
      zh: "组织研究问题、证据、分析和带引用的结论。",
    },
    defaultTitle: { en: "Research Report", zh: "研究报告" },
    content: {
      en: `# Research Report

## Research question

State the question and why it matters.

## Scope and method

Define the time range, sources, and evaluation criteria.

## Findings

### Finding 1

Evidence, interpretation, and limitations.

### Finding 2

Evidence, interpretation, and limitations.

## Synthesis

Explain how the findings relate or conflict.

## Conclusion

Answer the research question and identify open questions.

## References

1. Source title — URL or citation
`,
      zh: `# 研究报告

## 研究问题

说明问题及其重要性。

## 范围与方法

定义时间范围、资料来源和评价标准。

## 研究发现

### 发现一

证据、解释与局限。

### 发现二

证据、解释与局限。

## 综合分析

解释各项发现之间的联系或冲突。

## 结论

回答研究问题，并列出仍待探索的问题。

## 参考资料

1. 资料标题 — 链接或引用
`,
    },
  },
  {
    id: "lesson-plan",
    title: { en: "Lesson plan", zh: "教学方案" },
    description: {
      en: "Plan objectives, activities, checks for understanding, and follow-up.",
      zh: "规划目标、活动、理解检查和后续安排。",
    },
    defaultTitle: { en: "Lesson Plan", zh: "教学方案" },
    content: {
      en: `# Lesson Plan

## Learning objectives

By the end of this lesson, learners can:

1. Explain …
2. Apply …
3. Evaluate …

## Prerequisites

- Prior knowledge
- Materials or tools

## Lesson flow

| Time | Activity | Teaching purpose |
| --- | --- | --- |
| 5 min | Warm-up | Activate prior knowledge |
| 15 min | Explanation and example | Build the mental model |
| 15 min | Guided practice | Check and correct understanding |
| 5 min | Exit ticket | Measure learning |

## Differentiation

- Support for learners who need more scaffolding
- Extension for learners ready for a challenge

## Follow-up

- [ ] Review task
- [ ] Next lesson connection
`,
      zh: `# 教学方案

## 学习目标

完成本节学习后，学习者能够：

1. 解释……
2. 应用……
3. 评价……

## 前置条件

- 已有知识
- 所需材料或工具

## 教学流程

| 时间 | 活动 | 教学目的 |
| --- | --- | --- |
| 5 分钟 | 热身 | 激活已有知识 |
| 15 分钟 | 讲解与示例 | 建立心智模型 |
| 15 分钟 | 引导练习 | 检查并纠正理解 |
| 5 分钟 | 课堂小结 | 评估学习效果 |

## 分层支持

- 为需要更多支架的学习者提供支持
- 为准备好接受挑战的学习者提供拓展

## 后续安排

- [ ] 复习任务
- [ ] 与下一课的衔接
`,
    },
  },
];

export function coWriterTemplateLocale(language: string): "en" | "zh" {
  return language.toLowerCase().startsWith("zh") ? "zh" : "en";
}
