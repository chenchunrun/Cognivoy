/* Deterministic learner-success journey: goal → plan → dashboard → resume. */
const { chromium } = require("@playwright/test");
const axe = require("axe-core");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3783";
const launchOptions = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
  : {};

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function learningStatus(project) {
  const actionable = project.tasks.filter((task) => task.status !== "skipped");
  const completed = actionable.filter((task) => task.status === "completed" && !(
    task.intent === "assessment" && project.baseline_assessment.status !== "completed"
  ));
  const baseline = project.tasks.find((task) => task.intent === "assessment");
  const nextTask = project.tasks.find((task) => task.status === "in_progress")
    || project.tasks.find((task) => task.status === "todo" && task.intent !== "assessment");
  let nextAction;
  if (project.baseline_assessment.status !== "completed" && baseline) {
    nextAction = { kind: "baseline", project_id: project.id, project_title: project.title, title: baseline.objective, reason: "先校准起点，学习计划才能根据你的水平调整。", expected_minutes: baseline.expected_minutes, task: { ...baseline, project_version: project.version } };
  } else if (project.due_review_count) {
    nextAction = { kind: "review", project_id: project.id, project_title: project.title, title: `复习 ${project.due_review_count} 个到期知识点`, reason: "趁记忆仍可巩固时完成复习。", expected_minutes: 5, task: null };
  } else if (nextTask) {
    nextAction = { kind: nextTask.status === "in_progress" ? "continue" : "start", project_id: project.id, project_title: project.title, title: nextTask.objective, reason: "继续计划中最优先的任务。", expected_minutes: nextTask.expected_minutes, task: { ...nextTask, project_version: project.version } };
  } else {
    nextAction = { kind: "completed", project_id: project.id, project_title: project.title, title: "查看学习成果", reason: "当前计划任务已完成。", expected_minutes: 0, task: null };
  }
  return {
    schema_version: 1,
    project_id: project.id,
    project_version: project.version,
    status: project.status,
    progress: { completed_tasks: completed.length, total_tasks: actionable.length, completion_rate: actionable.length ? completed.length / actionable.length : 0 },
    mastery: project.mastery_summary,
    due_reviews: project.due_review_count,
    weak_point_count: project.weak_points.length,
    next_action: nextAction,
    updated_at: project.updated_at,
  };
}

(async () => {
  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext();
  await context.addCookies([{
    name: "cognivoy-lang",
    value: "zh",
    url: BASE,
  }]);
  await context.addInitScript(() => {
    localStorage.setItem("cognivoy-language", "zh");
    localStorage.setItem("cognivoy-response-language", "zh");
  });
  await context.addInitScript({ content: axe.source });
  const page = await context.newPage();
  let project = null;
  let createRequest = null;
  let taskStarted = false;
  let baselineSubmitted = false;
  let projectUpdated = false;
  let assignedPartner = false;
  let practiceAttempted = false;

  await page.route("**/api/v1/auth/status**", (route) => json(route, {
    // Keep this deterministic journey independent from the developer's
    // persisted multi-user setting. Unmatched optional requests may reach a
    // real backend during local runs; auth-disabled mode prevents an unrelated
    // 401 from redirecting the page away from the mocked learning flow.
    enabled: false,
    authenticated: true,
    is_admin: false,
    username: "learning-e2e",
    avatar: "",
  }));
  await page.route("**/api/v1/settings/ui", (route) => json(route, {
    language: "zh",
    response_language: "zh",
  }));
  await page.route("**/api/v1/settings", (route) => json(route, {
    catalog: { capabilities: [] },
  }));
  await page.route("**/api/v1/partners", (route) => json(route, [{
    partner_id: "tutor-e2e",
    name: "学习伙伴小橙",
    description: "项目复习伙伴",
    channels: [],
    proactive_learning: true,
    running: false,
    started_at: null,
  }]));
  await page.route("**/api/v1/knowledge/list**", (route) => json(route, [{ id: "kb-e2e", name: "智能体资料库", status: "ready" }]));
  await page.route("**/api/v1/book/books**", (route) => json(route, {
    books: [{ id: "book-e2e", title: "智能体工程手册", description: "", status: "ready", knowledge_bases: [], language: "zh", page_count: 3, chapter_count: 2, created_at: 1, updated_at: 1, metadata: {} }],
    total: 1,
    limit: 100,
    offset: 0,
    summary: { total: 1, ready: 1, in_progress: 0, chapters: 2 },
  }));
  await page.route("**/api/v1/notebook/list**", (route) => json(route, { notebooks: [{ id: "notebook-e2e", name: "项目学习笔记", record_count: 2 }] }));
  await page.route("**/api/v1/learning/dashboard", (route) => json(route, project ? {
    active_projects: 1,
    next_action: learningStatus(project).next_action,
    primary_project: {
      id: project.id,
      title: project.title,
      language: project.language,
      motivation: project.motivation,
      status: project.status,
      mastery_summary: project.mastery_summary,
      weak_points: project.weak_points,
      due_review_count: project.due_review_count,
      next_review_at: project.next_review_at,
      version: project.version,
      updated_at: project.updated_at,
      analytics: project.analytics,
      learning_status: learningStatus(project),
    },
    due_reviews: project.due_review_count || 0,
    next_review_at: project.next_review_at || null,
    weak_points: project.weak_points,
    weak_project: project.weak_points.length ? {
      project_id: project.id,
      project_version: project.version,
      objective: project.weak_points[0],
    } : null,
    review_project: project.due_review_count ? {
      project_id: project.id,
      project_title: project.title,
    } : null,
    mentor_suggestion: project.weak_points.length
      ? { kind: "strengthen", objective: project.weak_points[0] }
      : { kind: "continue", objective: project.tasks.find((task) => task.status !== "completed")?.objective },
    continue_task: { ...project.tasks.find((task) => task.status !== "completed"), project_version: project.version },
    today_tasks: [{ ...project.tasks.find((task) => task.status !== "completed"), project_version: project.version }],
    recent_projects: [],
  } : {
    active_projects: 0,
    next_action: { kind: "create_plan", project_id: null, title: "创建第一项学习计划", reason: "设定目标后开始。", expected_minutes: 3, task: null },
    primary_project: null,
    due_reviews: 0,
    next_review_at: null,
    weak_points: [],
    weak_project: null,
    review_project: null,
    mentor_suggestion: { kind: "plan" },
    continue_task: null,
    today_tasks: [],
    recent_projects: [],
  }));
  await page.route("**/api/v1/learning/projects", async (route) => {
    if (route.request().method() === "POST") {
      createRequest = {
        body: route.request().postDataJSON(),
        idempotencyKey: route.request().headers()["idempotency-key"],
      };
      project = {
        id: "learning-project-e2e",
        owner_id: "learning-e2e",
        title: createRequest.body.title,
        language: createRequest.body.language,
        motivation: createRequest.body.motivation,
        current_level: createRequest.body.current_level,
        target_level: createRequest.body.target_level,
        existing_materials: createRequest.body.existing_materials,
        weekly_minutes: createRequest.body.weekly_minutes,
        preferred_methods: createRequest.body.preferred_methods,
        partner_id: null,
        knowledge_base_ids: [],
        book_ids: [],
        notebook_ids: [],
        status: "active",
        weekly_plan: ["诊断基础并建立学习起点", "学习核心概念"],
        knowledge_map: [0, 1, 2, 3].map((index) => ({
          id: `knowledge-node-${index}`,
          title: ["基础概念", "核心关系", "应用与练习", "综合与迁移"][index],
          description: "用于校准学习路线",
          status: index === 0 ? "ready" : "locked",
          mastery: 0,
          prerequisite_ids: index ? [`knowledge-node-${index - 1}`] : [],
          order: index,
        })),
        baseline_assessment: { status: "pending", responses: {}, score: null, inferred_level: null },
        review_items: [],
        review_preferences: { intensity: "balanced", reminder_time: "19:00", daily_question_limit: 10 },
        mastery_summary: 0,
        weak_points: [],
        due_review_count: 0,
        next_review_at: null,
        events: [{
          id: "learning-event-e2e",
          project_id: "learning-project-e2e",
          event_type: "project_created",
          title: createRequest.body.title,
          description: createRequest.body.motivation,
          result_refs: [],
          created_at: Date.now() / 1000,
        }],
        analytics: {
          period_days: 7,
          active_days: 1,
          completed_tasks: 1,
          study_minutes: 25,
          review_attempts: 2,
          quiz_attempts: 1,
          mastery_delta: 0.12,
          task_completion_rate: 0.5,
          daily: Array.from({ length: 7 }, (_, index) => ({
            date: new Date(Date.now() - (6 - index) * 86400000).toISOString().slice(0, 10),
            events: index === 6 ? 3 : 0,
            completed_tasks: index === 6 ? 1 : 0,
            reviews: index === 6 ? 2 : 0,
            quizzes: index === 6 ? 1 : 0,
          })),
        },
        course_readiness: {
          status: "blocked",
          score: 70,
          issues: [{ code: "baseline_incomplete", severity: "blocker", message: "基线评估尚未完成。", action: "先完成基线评估。" }],
          metrics: { planned_weeks: 2, weekly_minutes: createRequest.body.weekly_minutes, allocated_minutes: 20, allocation_ratio: 0.5, total_questions: 30, unique_questions: 30, duplicate_questions: 0, attempted_questions: 0, baseline_questions: 30, book_pages: 3, grounded_book_pages: 3, resource_counts: {} },
        },
        tasks: [{
          id: "learning-task-e2e",
          project_id: "learning-project-e2e",
          objective: "诊断基础并建立学习起点",
          expected_minutes: 20,
          intent: "assessment",
          prerequisites: [],
          resource_refs: ["questions:baseline"],
          status: "todo",
          version: 1,
        }],
        version: 1,
        updated_at: Date.now() / 1000,
      };
      return json(route, project, 201);
    }
    return json(route, { items: project ? [project] : [], total: project ? 1 : 0 });
  });
  await page.route("**/api/v1/learning/projects/*/assessment", (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      assert(Object.keys(body.responses).length === 4, "baseline did not submit every response");
      baselineSubmitted = true;
      project.baseline_assessment = {
        status: "completed",
        responses: body.responses,
        score: 0.5,
        inferred_level: "intermediate",
        completed_at: Date.now() / 1000,
      };
      project.current_level = "intermediate";
      project.mastery_summary = 0.5;
      project.tasks[0].status = "completed";
      project.tasks.push({
        id: "learning-task-after-baseline",
        project_id: project.id,
        objective: "学习核心概念",
        expected_minutes: 30,
        intent: "mastery_path",
        prerequisites: ["learning-task-e2e"],
        resource_refs: ["questions:week-1"],
        status: "todo",
        version: 1,
      });
      project.knowledge_map.forEach((node, index) => {
        node.mastery = [0.85, 0.6, 0.3, 0][index];
        node.status = ["mastered", "in_progress", "ready", "locked"][index];
      });
      project.events.push({
        id: "assessment-event-e2e",
        project_id: project.id,
        event_type: "assessment_completed",
        title: "初始水平测试",
        description: "Inferred level: intermediate",
        result_refs: [],
        mastery_after: 0.5,
        created_at: Date.now() / 1000,
      });
      project.version += 1;
      return json(route, project);
    }
    return json(route, {
      status: project.baseline_assessment.status,
      score: project.baseline_assessment.score,
      inferred_level: project.baseline_assessment.inferred_level,
      responses: project.baseline_assessment.responses,
      questions: project.knowledge_map.map((node) => ({
        id: node.id,
        knowledge_node_id: node.id,
        title: node.title,
        prompt: "你目前能做到什么程度？",
        choices: ["完全陌生", "需要指导", "能完成常见任务", "能独立解释和应用"],
      })),
    });
  });
  await page.route("**/api/v1/learning/projects/learning-project-e2e", (route) => {
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON();
      project = { ...project, ...body, version: project.version + 1 };
      delete project.expected_version;
      projectUpdated = true;
      assignedPartner = project.partner_id === "tutor-e2e";
    }
    return json(route, project);
  });
  await page.route("**/api/v1/learning/projects/*/tasks/*", (route) => {
    taskStarted = true;
    const taskId = new URL(route.request().url()).pathname.split("/").pop();
    const task = project.tasks.find((item) => item.id === taskId);
    assert(task, `unknown task start: ${taskId}`);
    task.status = "in_progress";
    task.version += 1;
    project.version += 1;
    return json(route, { task, project_version: project.version });
  });
  await page.route("**/api/v1/learning/projects/*/tasks", (route) => {
    const body = route.request().postDataJSON();
    const task = {
      id: "learning-task-strengthen",
      project_id: project.id,
      objective: body.objective,
      expected_minutes: body.expected_minutes,
      intent: body.intent,
      status: "todo",
      version: 1,
    };
    project.tasks.push(task);
    project.version += 1;
    return json(route, { task, project_version: project.version }, 201);
  });
  await page.route("**/api/v1/learning/projects/*/reviews/*/complete", (route) => {
    const reviewId = new URL(route.request().url()).pathname.split("/").at(-2);
    const review = project.review_items.find((item) => item.id === reviewId);
    assert(review, `unknown review completion: ${reviewId}`);
    const body = route.request().postDataJSON();
    assert(body.attempt_id, "review completion omitted attempt identity");
    review.attempt_count += 1;
    review.correct_streak = body.is_correct ? review.correct_streak + 1 : 0;
    review.status = body.is_correct ? "scheduled" : "due";
    review.due_at = body.is_correct ? Date.now() / 1000 + 86400 : Date.now() / 1000;
    project.due_review_count = body.is_correct ? 0 : 1;
    project.version += 1;
    return json(route, {
      project_version: project.version,
      review,
      due_review_count: project.due_review_count,
      next_review_at: review.due_at,
    });
  });

  // Keep unrelated dashboard sources deterministic so this test has no live-model dependency.
  await page.route("**/api/v1/sessions?**", (route) => json(route, { sessions: [], total: 0 }));
  await page.route("**/api/v1/learning/progress", (route) => json(route, { summaries: [] }));
  const practiceEntry = {
    id: 401,
    session_id: "course-practice-e2e",
    session_title: "CISA practice",
    turn_id: "weekly-practice",
    question_id: "weekly-1",
    question: "Which control most directly protects the integrity of audit evidence?",
    question_type: "choice",
    options: { A: "Public write access", B: "Immutable, access-controlled logs" },
    correct_answer: "B",
    explanation: "Immutable, access-controlled logs preserve integrity and accountability.",
    difficulty: "medium",
    user_answer: "",
    is_correct: false,
    bookmarked: false,
    learning_project_id: "learning-project-e2e",
    learning_task_id: "learning-task-after-baseline",
    attempt_count: 0,
    correct_streak: 0,
    incorrect_streak: 0,
    review_interval_days: 0,
    review_due_at: null,
    last_reviewed_at: null,
    review_status: "new",
    recommended_difficulty: "medium",
    knowledge_points: ["audit evidence"],
    source_refs: [],
    rubric: {},
    created_at: Date.now() / 1000,
    updated_at: Date.now() / 1000,
    categories: [],
  };
  await page.route("**/api/v1/question-notebook/entries/401/attempt", (route) => {
    const body = route.request().postDataJSON();
    assert(body.answer === "B", "task practice did not submit the selected answer");
    assert(body.attempt_id, "task practice did not send an idempotent attempt id");
    practiceAttempted = true;
    Object.assign(practiceEntry, {
      user_answer: body.answer,
      is_correct: true,
      attempt_count: 1,
      correct_streak: 1,
      review_interval_days: 3,
      review_due_at: Date.now() / 1000 + 259200,
      last_reviewed_at: Date.now() / 1000,
      review_status: "scheduled",
    });
    return json(route, practiceEntry);
  });
  await page.route("**/api/v1/question-notebook/entries?**", (route) => json(route, { items: [practiceEntry], total: 1 }));
  await page.route("**/api/v1/question-notebook/statistics**", (route) => json(route, {
    total: 1, correct: practiceAttempted ? 1 : 0, incorrect: 0,
    attempted: practiceAttempted ? 1 : 0, accuracy_percent: practiceAttempted ? 100 : 0,
    bookmarked: 0, due: 0, mastered: 0,
  }));
  await page.route("**/api/v1/question-notebook/categories**", (route) => json(route, []));

  await page.goto(`${BASE}/home`, { waitUntil: "domcontentloaded" });
  if (process.env.DEBUG_E2E === "1") {
    await page.waitForTimeout(3000);
    console.log("DEBUG learning home:", page.url(), await page.locator("body").innerText());
  }
  await page.getByTestId("learning-journey-intro").waitFor();
  await page.getByRole("button", { name: /创建我的学习计划|Create my learning plan/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/你想学习什么|What do you want to learn/).fill("构建可靠的 AI 智能体");
  await dialog.getByLabel(/为什么这个目标|Why is this goal important/).fill("完成生产级项目");
  await dialog.getByRole("button", { name: /继续|Continue/ }).click();
  await dialog.getByLabel(/目标完成日期|Target completion date/).fill("2026-12-31");
  await dialog.getByRole("button", { name: /继续|Continue/ }).click();
  await dialog.getByLabel(/你已经有学习资料|Do you already have materials/).fill("现有代码仓库和架构文档");
  await dialog.getByRole("button", { name: /生成计划和首个任务|Create plan and first task/ }).click();

  await page.getByTestId("course-task-loop").getByText("诊断基础并建立学习起点", { exact: true }).waitFor();
  await page.getByTestId("learning-loop-progress").waitFor();
  await page.getByText(/你的学习闭环|Your learning loop/).waitFor();
  assert(createRequest && createRequest.body.language === "zh", "onboarding did not preserve UI language");
  assert(createRequest.body.deadline > 0, "onboarding did not preserve the target completion date");
  assert(createRequest.idempotencyKey, "project creation omitted its idempotency key");

  await page.goto(`${BASE}/space/learning`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { level: 1, name: /学习计划|Learning plans/ }).waitFor();
  await page.getByRole("heading", { name: "构建可靠的 AI 智能体" }).waitFor();
  await page.getByRole("heading", { name: /最近学习成果|Recent learning outcomes/ }).waitFor();
  await page.getByRole("link", { name: /查看项目详情|View project details/ }).click();
  await page.waitForURL(/\/space\/learning\/learning-project-e2e/);
  await page.getByTestId("learning-loop-progress").waitFor();
  await page.getByText(/计划完成 0%|0% complete/).waitFor();
  await page.getByRole("heading", { name: /初始水平测试|Baseline assessment/ }).waitFor();
  await page.getByTestId("course-readiness").waitFor();
  await page.getByTestId("course-task-loop").waitFor();
  await page.getByRole("heading", { name: /课程任务与练习|Course tasks and practice/ }).waitFor();
  await page.getByTestId("learning-analytics").waitFor();
  await page.getByText(/学习成效 · 最近 7 天|Learning impact · last 7 days/).waitFor();
  await page.getByText("25 分钟", { exact: true }).waitFor();
  const baselineChoices = ["能独立解释和应用", "能完成常见任务", "需要指导", "完全陌生"];
  const baselineSection = page.locator("#baseline-assessment");
  for (let index = 0; index < baselineChoices.length; index += 1) {
    await baselineSection.getByRole("group").nth(index).getByLabel(baselineChoices[index], { exact: true }).click();
  }
  await page.getByRole("button", { name: /保存起点并生成地图|Save baseline and build map/ }).click();
  await page.getByText(/已完成 · 50%|Completed · 50%/).waitFor();
  assert(baselineSubmitted, "baseline assessment was not persisted");
  await page.getByRole("button", { name: /调整计划|Adjust plan/ }).click();
  await page.getByLabel(/每周学习时间|Weekly study time/).fill("300");
  await page.getByRole("combobox", { name: /学习伙伴|Learning tutor/ }).selectOption("tutor-e2e");
  await page.getByRole("combobox", { name: /复习强度|Review intensity/ }).selectOption("intensive");
  await page.getByLabel(/偏好提醒时间|Preferred reminder time/).fill("08:30");
  await page.getByLabel(/每日题量上限|Daily question limit/).fill("6");
  await page.getByLabel("智能体资料库").check();
  await page.getByLabel("智能体工程手册").check();
  await page.getByLabel("项目学习笔记").check();
  await page.getByRole("button", { name: /保存更改|Save changes/ }).click();
  assert(projectUpdated && project.weekly_minutes === 300, "project plan edits were not persisted");
  assert(assignedPartner, "learning tutor assignment was not persisted");
  assert(project.review_preferences.intensity === "intensive", "review intensity was not persisted");
  assert(project.review_preferences.reminder_time === "08:30", "review reminder time was not persisted");
  assert(project.review_preferences.daily_question_limit === 6, "daily review limit was not persisted");
  assert(project.knowledge_base_ids.includes("智能体资料库"), "knowledge base link was not persisted");
  assert(project.book_ids.includes("book-e2e"), "book link was not persisted");
  assert(project.notebook_ids.includes("notebook-e2e"), "notebook link was not persisted");
  await page.getByText(/学习伙伴小橙 会关注本项目|学习伙伴小橙 follows this project/).waitFor();
  await page.getByTestId("project-learning-resources").getByText("智能体资料库", { exact: true }).waitFor();
  await page.getByTestId("project-learning-resources").getByText("智能体工程手册", { exact: true }).waitFor();
  await page.getByTestId("project-learning-resources").getByText("项目学习笔记", { exact: true }).waitFor();
  const practiceLink = page.getByRole("link", { name: /打开项目题目|Open project questions/ });
  await practiceLink.waitFor();
  assert(
    await practiceLink.getAttribute("href") === "/question-notebook?project_id=learning-project-e2e",
    "project practice entry did not preserve project identity",
  );
  await page.goto(`${BASE}/question-notebook?project_id=${project.id}&task_id=learning-task-after-baseline`, { waitUntil: "domcontentloaded" });
  await page.getByText("Which control most directly protects the integrity of audit evidence?", { exact: true }).waitFor();
  await page.getByRole("button", { name: /B\. Immutable, access-controlled logs/ }).click();
  await page.getByRole("button", { name: /提交答案|Submit answer/ }).click();
  await page.getByText(/正确答案|Correct answer/).waitFor();
  assert(practiceAttempted, "task practice did not persist a real attempt");
  await page.goto(`${BASE}/space/learning/${project.id}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /继续学习|Continue learning/ }).click();
  await page.waitForURL(/\/home\?.*learning_task=learning-task-after-baseline/);
  await page.waitForTimeout(500);

  const url = new URL(page.url());
  assert(url.searchParams.get("project") === "learning-project-e2e", "project identity was lost");
  assert(url.searchParams.get("objective") === "学习核心概念", "task objective was lost");
  assert(taskStarted, "resume did not persist the in-progress task state");
  const prompt = await page.getByRole("textbox", { name: "随便问点什么…" }).inputValue();
  assert(
    prompt.includes("学习核心概念"),
    `task launch did not prefill guided learning (value=${JSON.stringify(prompt)})`,
  );

  project.weak_points = ["向量加法"];
  project.due_review_count = 1;
  project.review_items = [{
    id: "review-vector-addition",
    title: "向量加法的封闭性",
    knowledge_point: "向量加法",
    source_ref: "question:e2e:turn:q1",
    mistake_category: "concept",
    diagnostic_reason: "关键定义尚未稳定掌握。",
    due_at: Date.now() / 1000 - 10,
    status: "due",
    interval_days: 0,
    attempt_count: 1,
    correct_streak: 0,
  }];
  await page.goto(`${BASE}/home`, { waitUntil: "domcontentloaded" });
  const focusCard = page.getByTestId("learning-focus-card");
  await focusCard.getByText(/1 项待复习 · 1 个薄弱点|1 review · 1 weak point/).waitFor();
  await focusCard.getByRole("button", { name: /立即复习|Review now/ }).click();
  await page.waitForURL(/\/space\/learning\/learning-project-e2e#review-queue/);
  await page.getByRole("heading", { name: /间隔复习队列|Spaced review queue/ }).waitFor();
  await page.getByText("向量加法的封闭性", { exact: true }).waitFor();
  await page.getByText(/概念未掌握|Concept not mastered/).waitFor();
  await page.getByText("关键定义尚未稳定掌握。", { exact: true }).waitFor();
  await page.getByRole("button", { name: /这次回忆正确|I recalled it correctly/ }).click();
  await page.getByText(/当前没有到期的项目复习项|No project reviews are due/).waitFor();
  assert(project.due_review_count === 0, "review completion did not update the project queue");

  await page.goto(`${BASE}/home`, { waitUntil: "domcontentloaded" });
  await page.getByText(/0 项待复习 · 1 个薄弱点|0 reviews · 1 weak point/).waitFor();
  await page.getByTestId("learning-focus-card").getByRole("button", { name: /继续学习|开始下一项任务|Continue learning|Start next task/ }).waitFor();

  const desktopAudit = await page.evaluate(async () => window.axe.run(document, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
    resultTypes: ["violations"],
  }));
  assert(desktopAudit.violations.length === 0, `desktop learning focus accessibility violations: ${desktopAudit.violations.map((item) => `${item.id}:${item.nodes.map((node) => node.target.join(" ")).join("|")}`).join(", ")}`);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/home`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("learning-focus-card").waitFor();
  const mobileAudit = await page.evaluate(async () => {
    const audit = await window.axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
      resultTypes: ["violations"],
    });
    return {
      violations: audit.violations.map((item) => ({
        id: item.id,
        targets: item.nodes.map((node) => node.target.join(" ")),
      })),
      scrollWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    };
  });
  assert(mobileAudit.violations.length === 0, `mobile learning focus accessibility violations: ${mobileAudit.violations.map((item) => `${item.id}:${item.targets.join("|")}`).join(", ")}`);
  assert(mobileAudit.scrollWidth <= mobileAudit.viewportWidth + 2, `mobile learning focus overflows horizontally: ${mobileAudit.scrollWidth}/${mobileAudit.viewportWidth}`);

  console.log("PASS learning project: onboarding → baseline → resources/practice → canonical next action → due review completion → desktop/mobile accessibility");
  await browser.close();
})().catch((error) => {
  console.error("FAIL learning project:", error);
  process.exit(1);
});
