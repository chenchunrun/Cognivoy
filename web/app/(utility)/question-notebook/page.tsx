"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useTranslation } from "react-i18next";
import {
  Bookmark,
  CalendarClock,
  CircleCheck,
  FolderOpen,
  Gauge,
  GraduationCap,
  NotebookPen,
  Search,
} from "lucide-react";
import {
  Button,
  ConfirmDialog,
  EmptyState,
  Input,
  Skeleton,
  useToast,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import {
  addEntryToCategory,
  attemptNotebookEntry,
  deleteCategory,
  deleteNotebookEntry,
  fetchQuestionNotebookStatistics,
  listCategories,
  listNotebookEntries,
  removeEntryFromCategory,
  updateNotebookEntry,
  upsertNotebookEntry,
  type NotebookCategory,
  type NotebookEntry,
  type QuestionNotebookStatistics,
} from "@/lib/notebook-api";
import {
  fetchLearningProjects,
  type LearningProject,
} from "@/lib/learning-project-api";
import { CategoryManager } from "@/components/notebook/CategoryManager";
import {
  EntryEditDialog,
  type EntryEditValues,
} from "@/components/notebook/EntryEditDialog";
import { QuestionEntryCard } from "@/components/notebook/QuestionEntryCard";

type FilterMode = "all" | "bookmarked" | "due" | "mastered" | "wrong";
const PAGE_SIZE = 40;

function isFilterMode(value: string | null): value is FilterMode {
  return (
    value === "all" ||
    value === "bookmarked" ||
    value === "due" ||
    value === "mastered" ||
    value === "wrong"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function QuestionNotebookPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const router = useRouter();

  const [items, setItems] = React.useState<NotebookEntry[]>([]);
  const [total, setTotal] = React.useState(0);
  const [page, setPage] = React.useState(0);
  const [categories, setCategories] = React.useState<NotebookCategory[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [statistics, setStatistics] =
    React.useState<QuestionNotebookStatistics | null>(null);
  const [query, setQuery] = React.useState("");
  const deferredQuery = React.useDeferredValue(query);
  const [questionType, setQuestionType] = React.useState("");
  const [difficulty, setDifficulty] = React.useState("");
  const [sourceType, setSourceType] = React.useState("");
  const [projectId, setProjectId] = React.useState("");
  const [taskId, setTaskId] = React.useState("");
  const [projects, setProjects] = React.useState<LearningProject[]>([]);
  const [rangeDays, setRangeDays] = React.useState(0);
  const [filtersHydrated, setFiltersHydrated] = React.useState(false);
  const [filter, setFilter] = React.useState<FilterMode>("all");
  const [activeCategoryId, setActiveCategoryId] = React.useState<number | null>(
    null,
  );
  const [pendingId, setPendingId] = React.useState<number | null>(null);
  const [managerOpen, setManagerOpen] = React.useState(false);

  const [editTarget, setEditTarget] = React.useState<NotebookEntry | null>(
    null,
  );
  const [deleteTarget, setDeleteTarget] = React.useState<NotebookEntry | null>(
    null,
  );
  const [deleting, setDeleting] = React.useState(false);
  const [categoryDeleteTarget, setCategoryDeleteTarget] =
    React.useState<NotebookCategory | null>(null);
  const [categoryDeleting, setCategoryDeleting] = React.useState(false);

  const loadCategories = React.useCallback(async () => {
    try {
      setCategories(await listCategories());
    } catch (error) {
      toast({
        variant: "destructive",
        title: t("Failed to load categories"),
        description: errorMessage(error),
      });
    }
  }, [t, toast]);

  const loadItems = React.useCallback(
    async (mode: FilterMode, categoryId: number | null) => {
      setLoading(true);
      try {
        const now = Math.floor(Date.now() / 1000);
        const response = await listNotebookEntries({
          q: deferredQuery,
          question_type: questionType || undefined,
          difficulty: difficulty || undefined,
          source_type: sourceType || undefined,
          project_id: projectId || undefined,
          task_id: taskId || undefined,
          updated_from:
            rangeDays > 0 ? now - rangeDays * 24 * 60 * 60 : undefined,
          bookmarked: mode === "bookmarked" ? true : undefined,
          is_correct: mode === "wrong" ? false : undefined,
          review_status:
            mode === "due" || mode === "mastered" ? mode : undefined,
          category_id: categoryId ?? undefined,
          limit: PAGE_SIZE,
          offset: page * PAGE_SIZE,
        });
        setItems(response.items);
        setTotal(response.total);
      } catch (error) {
        toast({
          variant: "destructive",
          title: t("Failed to load entries"),
          description: errorMessage(error),
        });
      } finally {
        setLoading(false);
      }
    },
    [deferredQuery, difficulty, page, projectId, questionType, rangeDays, sourceType, taskId, t, toast],
  );

  React.useEffect(() => {
    void loadItems(filter, activeCategoryId);
  }, [filter, activeCategoryId, loadItems]);

  React.useEffect(() => {
    setPage(0);
  }, [activeCategoryId, deferredQuery, difficulty, filter, projectId, questionType, rangeDays, sourceType, taskId]);

  React.useEffect(() => {
    const lastPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);
    if (page > lastPage) setPage(lastPage);
  }, [page, total]);

  React.useEffect(() => {
    void loadCategories();
  }, [loadCategories]);

  React.useEffect(() => {
    fetchLearningProjects()
      .then(setProjects)
      .catch((error) => {
        toast({
          variant: "destructive",
          title: t("Failed to load learning plans"),
          description: errorMessage(error),
        });
      });
  }, [t, toast]);

  const loadStatistics = React.useCallback(async () => {
    try {
      setStatistics(await fetchQuestionNotebookStatistics(projectId || undefined));
    } catch (error) {
      toast({
        variant: "destructive",
        title: t("Failed to load question statistics"),
        description: errorMessage(error),
      });
    }
  }, [projectId, t, toast]);

  React.useEffect(() => {
    void loadStatistics();
  }, [loadStatistics]);

  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setQuery(params.get("q") ?? "");
    setQuestionType(params.get("question_type") ?? "");
    setDifficulty(params.get("difficulty") ?? "");
    setSourceType(params.get("source_type") ?? "");
    setProjectId(params.get("project_id") ?? "");
    setTaskId(params.get("task_id") ?? "");
    setRangeDays(Number(params.get("range_days") ?? 0) || 0);
    const mode = params.get("filter");
    if (isFilterMode(mode)) setFilter(mode);
    const legacyReviewStatus = params.get("review_status");
    if (legacyReviewStatus === "due") setFilter("due");
    if (legacyReviewStatus === "mastered") setFilter("mastered");
    const category = Number(params.get("category_id"));
    if (Number.isInteger(category) && category > 0) setActiveCategoryId(category);
    setFiltersHydrated(true);
  }, []);

  React.useEffect(() => {
    if (!filtersHydrated) return;
    const params = new URLSearchParams();
    if (query.trim()) params.set("q", query.trim());
    if (questionType) params.set("question_type", questionType);
    if (difficulty) params.set("difficulty", difficulty);
    if (sourceType) params.set("source_type", sourceType);
    if (projectId) params.set("project_id", projectId);
    if (taskId) params.set("task_id", taskId);
    if (rangeDays > 0) params.set("range_days", String(rangeDays));
    if (filter !== "all") params.set("filter", filter);
    if (activeCategoryId !== null)
      params.set("category_id", String(activeCategoryId));
    const next = `${window.location.pathname}${params.size ? `?${params}` : ""}`;
    window.history.replaceState(window.history.state, "", next);
  }, [activeCategoryId, difficulty, filter, filtersHydrated, projectId, query, questionType, rangeDays, sourceType, taskId]);

  const selectedProject = projects.find((project) => project.id === projectId);
  const selectedTask = selectedProject?.tasks.find((task) => task.id === taskId);
  const projectTitles = React.useMemo(
    () => new Map(projects.map((project) => [project.id, project.title])),
    [projects],
  );

  const refresh = () => {
    void loadItems(filter, activeCategoryId);
    void loadCategories();
    void loadStatistics();
  };

  const handleToggleBookmark = async (entry: NotebookEntry) => {
    const next = !entry.bookmarked;
    setPendingId(entry.id);
    try {
      await updateNotebookEntry(entry.id, { bookmarked: next });
      setItems((previous) =>
        filter === "bookmarked" && !next
          ? previous.filter((item) => item.id !== entry.id)
          : previous.map((item) =>
              item.id === entry.id ? { ...item, bookmarked: next } : item,
            ),
      );
      if (filter === "bookmarked" && !next) {
        setTotal((value) => Math.max(0, value - 1));
      }
    } catch (error) {
      toast({
        variant: "destructive",
        title: t("Failed to update bookmark"),
        description: errorMessage(error),
      });
    } finally {
      setPendingId(null);
    }
  };

  const handleSubmitAnswer = async (entry: NotebookEntry, answer: string) => {
    setPendingId(entry.id);
    try {
      const updated = await attemptNotebookEntry(entry.id, answer);
      setItems((previous) =>
        previous.map((item) => (item.id === updated.id ? updated : item)),
      );
      await loadStatistics();
      toast({
        variant: updated.is_correct ? "success" : "default",
        title: updated.is_correct ? t("Correct") : t("Answer recorded"),
      });
    } catch (error) {
      toast({
        variant: "destructive",
        title: t("Failed to submit answer"),
        description: errorMessage(error),
      });
      throw error;
    } finally {
      setPendingId(null);
    }
  };

  const handleEditSubmit = async (values: EntryEditValues) => {
    if (!editTarget) return;
    try {
      const updated = await upsertNotebookEntry({
        session_id: editTarget.session_id,
        turn_id: editTarget.turn_id,
        question_id: editTarget.question_id,
        question: editTarget.question,
        question_type: editTarget.question_type,
        options: editTarget.options,
        correct_answer: values.correctAnswer,
        explanation: values.explanation,
        difficulty: editTarget.difficulty,
        user_answer: values.userAnswer,
        is_correct: editTarget.is_correct,
        learning_project_id: editTarget.learning_project_id,
        learning_task_id: editTarget.learning_task_id,
      });
      setItems((previous) =>
        previous.map((item) => (item.id === updated.id ? updated : item)),
      );
      toast({ variant: "success", title: t("Entry updated") });
    } catch (error) {
      toast({
        variant: "destructive",
        title: t("Failed to update entry"),
        description: errorMessage(error),
      });
      throw error;
    }
  };

  const handleDeleteEntry = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteNotebookEntry(deleteTarget.id);
      setItems((previous) =>
        previous.filter((item) => item.id !== deleteTarget.id),
      );
      setTotal((value) => Math.max(0, value - 1));
      setDeleteTarget(null);
      toast({ variant: "success", title: t("Entry deleted") });
    } catch (error) {
      toast({
        variant: "destructive",
        title: t("Failed to delete entry"),
        description: errorMessage(error),
      });
    } finally {
      setDeleting(false);
    }
  };

  const handleAddToCategory = async (
    entry: NotebookEntry,
    categoryId: number,
  ) => {
    setPendingId(entry.id);
    try {
      await addEntryToCategory(entry.id, categoryId);
      refresh();
    } catch (error) {
      toast({
        variant: "destructive",
        title: t("Failed to add to category"),
        description: errorMessage(error),
      });
    } finally {
      setPendingId(null);
    }
  };

  const handleRemoveFromCategory = async (
    entry: NotebookEntry,
    categoryId: number,
  ) => {
    setPendingId(entry.id);
    try {
      await removeEntryFromCategory(entry.id, categoryId);
      setItems((previous) =>
        previous.filter((item) => item.id !== entry.id),
      );
      setTotal((value) => Math.max(0, value - 1));
      void loadCategories();
    } catch (error) {
      toast({
        variant: "destructive",
        title: t("Failed to remove from category"),
        description: errorMessage(error),
      });
    } finally {
      setPendingId(null);
    }
  };

  const handleDeleteCategory = async () => {
    if (!categoryDeleteTarget) return;
    setCategoryDeleting(true);
    try {
      await deleteCategory(categoryDeleteTarget.id);
      if (activeCategoryId === categoryDeleteTarget.id) {
        setActiveCategoryId(null);
        setFilter("all");
      }
      setCategoryDeleteTarget(null);
      toast({ variant: "success", title: t("Category deleted") });
      void loadCategories();
    } catch (error) {
      toast({
        variant: "destructive",
        title: t("Failed to delete category"),
        description: errorMessage(error),
      });
    } finally {
      setCategoryDeleting(false);
    }
  };

  const FILTERS: { mode: FilterMode; label: string }[] = [
    { mode: "all", label: t("All") },
    { mode: "bookmarked", label: t("Bookmarked") },
    { mode: "due", label: t("Due for review") },
    { mode: "mastered", label: t("Mastered") },
    { mode: "wrong", label: t("Incorrect only") },
  ];
  const hasActiveFilters = Boolean(
    query.trim() ||
      questionType ||
      difficulty ||
      sourceType ||
      projectId ||
      taskId ||
      rangeDays ||
      filter !== "all" ||
      activeCategoryId,
  );
  const clearFilters = () => {
    setQuery("");
    setQuestionType("");
    setDifficulty("");
    setSourceType("");
    setProjectId("");
    setTaskId("");
    setRangeDays(0);
    setFilter("all");
    setActiveCategoryId(null);
  };

  return (
    <div
      data-testid="question-notebook-layout"
      className="w-full px-4 py-8 sm:px-6 lg:px-8 2xl:px-10"
    >
      <header className="mb-6">
        <h1 className="display text-2xl font-semibold text-foreground">
          {t("Question Notebook")}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("Review and organize quiz questions across sessions.")}
        </p>
      </header>

      {selectedProject && (
        <div className="surface mb-5 flex items-center justify-between gap-3 border-primary-border bg-primary-muted p-4">
          <div className="flex min-w-0 items-center gap-3">
            <GraduationCap className="shrink-0 text-primary" size={20} aria-hidden="true" />
            <div className="min-w-0">
              <p className="text-xs font-medium text-primary">{t("Learning plan practice")}</p>
              <p className="truncate font-semibold text-foreground">{selectedProject.title}</p>
              {selectedTask && <p className="truncate text-xs text-muted-foreground">{t("Task practice")} · {selectedTask.objective}</p>}
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={() => router.push(`/space/learning/${encodeURIComponent(selectedProject.id)}`)}>
            {t("Back to project")}
          </Button>
        </div>
      )}

      {statistics && (
        <dl className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <QuestionStat
            icon={NotebookPen}
            label={t("Saved questions")}
            value={statistics.total}
          />
          <QuestionStat
            icon={CalendarClock}
            label={t("Due for review")}
            value={statistics.due_review}
          />
          <QuestionStat
            icon={Gauge}
            label={t("Accuracy")}
            value={`${statistics.accuracy_percent}%`}
          />
          <QuestionStat
            icon={CircleCheck}
            label={t("Correct answers")}
            value={statistics.correct}
          />
        </dl>
      )}

      <div className="surface mb-5 grid gap-2 p-3 xl:grid-cols-[minmax(0,1fr)_auto_auto_auto_auto_auto]">
        <div className="relative">
          <Search
            size={14}
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("Search questions, explanations, or sessions")}
            aria-label={t("Search question notebook")}
            className="pl-8"
          />
        </div>
        <select
          value={projectId}
          onChange={(event) => { setProjectId(event.target.value); setTaskId(""); }}
          aria-label={t("Filter by learning plan")}
          className="h-9 max-w-52 rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="">{t("All learning plans")}</option>
          <option value="__unassigned__">{t("Unassigned practice")}</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>{project.title}</option>
          ))}
        </select>
        {selectedProject && (
          <select
            value={taskId}
            onChange={(event) => setTaskId(event.target.value)}
            aria-label={t("Filter by learning task")}
            className="h-9 max-w-56 rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="">{t("All project tasks")}</option>
            {selectedProject.tasks.map((task) => (
              <option key={task.id} value={task.id}>{task.objective}</option>
            ))}
          </select>
        )}
        <select
          value={questionType}
          onChange={(event) => setQuestionType(event.target.value)}
          aria-label={t("Filter by question type")}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="">{t("All question types")}</option>
          {Object.keys(statistics?.question_types ?? {}).map((type) => (
            <option key={type} value={type}>{t(type)}</option>
          ))}
        </select>
        <select
          value={difficulty}
          onChange={(event) => setDifficulty(event.target.value)}
          aria-label={t("Filter by difficulty")}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="">{t("All difficulties")}</option>
          {Object.keys(statistics?.difficulties ?? {}).map((value) => (
            <option key={value} value={value}>{t(value)}</option>
          ))}
        </select>
        <select
          value={rangeDays}
          onChange={(event) => setRangeDays(Number(event.target.value))}
          aria-label={t("Filter by time")}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
        >
          <option value={0}>{t("Any time")}</option>
          <option value={7}>{t("Last 7 days")}</option>
          <option value={30}>{t("Last 30 days")}</option>
          <option value={90}>{t("Last 90 days")}</option>
        </select>
        <select
          value={sourceType}
          onChange={(event) => setSourceType(event.target.value)}
          aria-label={t("Filter by source")}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="">{t("All sources")}</option>
          <option value="knowledge_base">{t("Knowledge base")}</option>
          <option value="web">{t("Web")}</option>
          <option value="papers">{t("Papers")}</option>
          <option value="book">{t("Book")}</option>
          <option value="notebook">{t("Notebook")}</option>
          <option value="sample">{t("Sample question")}</option>
          <option value="none">{t("No verified source")}</option>
        </select>
      </div>

      {/* Category manager toggle + panel */}
      <div className="mb-5">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setManagerOpen((value) => !value)}
          aria-expanded={managerOpen}
        >
          <FolderOpen size={14} />
          {t("Manage categories")}
          {categories.length > 0 && (
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-xs tabular-nums text-muted-foreground">
              {categories.length}
            </span>
          )}
        </Button>
        {managerOpen && (
          <div className="mt-3">
            <CategoryManager
              categories={categories}
              onChanged={() => {
                void loadCategories();
              }}
              onDelete={setCategoryDeleteTarget}
            />
          </div>
        )}
      </div>

      {/* Filter chips */}
      <div className="mb-5 flex flex-wrap items-center gap-1.5 border-b border-border pb-4">
        {FILTERS.map(({ mode, label }) => {
          const active = filter === mode && activeCategoryId === null;
          return (
            <button
              key={mode}
              type="button"
              onClick={() => {
                setFilter(mode);
                setActiveCategoryId(null);
              }}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm transition-colors duration-150",
                active
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:text-foreground",
              )}
            >
              {mode === "bookmarked" && <Bookmark size={12} />}
              {label}
            </button>
          );
        })}
        {categories.length > 0 && (
          <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
        )}
        {categories.map((category) => {
          const active = activeCategoryId === category.id;
          return (
            <button
              key={category.id}
              type="button"
              onClick={() => {
                setActiveCategoryId(active ? null : category.id);
                setFilter("all");
              }}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm transition-colors duration-150",
                active
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:text-foreground",
              )}
            >
              <FolderOpen size={12} />
              {category.name}
            </button>
          );
        })}
        <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
          {t("{{count}} entries", { count: total })}
        </span>
      </div>

      {/* Entries */}
      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-40 w-full rounded-xl" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="surface">
          <EmptyState
            icon={NotebookPen}
            title={
              hasActiveFilters
                ? t("No matching questions")
                : t("Build your practice library")
            }
            description={
              hasActiveFilters
                ? t("Try clearing some filters to see more saved questions.")
                : t("Generate a focused practice set in chat. Your answers, mistakes, and review schedule will be saved here.")
            }
            action={
              hasActiveFilters ? (
                <Button variant="outline" onClick={clearFilters}>{t("Clear filters")}</Button>
              ) : (
                <div className="flex flex-wrap justify-center gap-2">
                  <Button onClick={() => router.push("/home?quick_start=deep_question")}>
                    {t("Create practice questions")}
                  </Button>
                  <Button variant="outline" onClick={() => router.push("/space/learning")}>
                    {t("Create a learning goal")}
                  </Button>
                </div>
              )
            }
            className="py-20"
          />
        </div>
      ) : (
        <>
          <ul className="space-y-3">
            {items.map((entry) => (
              <QuestionEntryCard
                key={entry.id}
                entry={entry}
                projectTitle={projectTitles.get(entry.learning_project_id)}
                categories={categories}
                activeCategoryId={activeCategoryId}
                pending={pendingId === entry.id}
                onToggleBookmark={(item) => void handleToggleBookmark(item)}
                onEdit={setEditTarget}
                onDelete={setDeleteTarget}
                onAddToCategory={(item, categoryId) =>
                  void handleAddToCategory(item, categoryId)
                }
                onRemoveFromCategory={(item, categoryId) =>
                  void handleRemoveFromCategory(item, categoryId)
                }
                onGenerateSimilar={(item) =>
                  router.push(
                    `/home?practice_similar=${encodeURIComponent(item.id)}${item.learning_project_id ? `&project_id=${encodeURIComponent(item.learning_project_id)}` : ""}`,
                  )
                }
                onSubmitAnswer={handleSubmitAnswer}
              />
            ))}
          </ul>
          {total > PAGE_SIZE && (
            <nav
              data-testid="question-notebook-pagination"
              aria-label={t("Question notebook pages")}
              className="mt-5 flex items-center justify-between gap-3"
            >
              <Button
                variant="outline"
                size="sm"
                disabled={page === 0 || loading}
                onClick={() => setPage((value) => Math.max(0, value - 1))}
              >
                {t("Previous page")}
              </Button>
              <span className="text-xs tabular-nums text-muted-foreground">
                {t("Page {{page}} of {{pages}}", {
                  page: page + 1,
                  pages: Math.ceil(total / PAGE_SIZE),
                })}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={(page + 1) * PAGE_SIZE >= total || loading}
                onClick={() => setPage((value) => value + 1)}
              >
                {t("Next page")}
              </Button>
            </nav>
          )}
        </>
      )}

      <EntryEditDialog
        open={Boolean(editTarget)}
        onClose={() => setEditTarget(null)}
        entry={editTarget}
        onSubmit={handleEditSubmit}
      />
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void handleDeleteEntry()}
        title={t("Delete entry")}
        description={t("Delete this question entry? This cannot be undone.")}
        confirmText={t("Delete")}
        destructive
        loading={deleting}
      />
      <ConfirmDialog
        open={Boolean(categoryDeleteTarget)}
        onClose={() => setCategoryDeleteTarget(null)}
        onConfirm={() => void handleDeleteCategory()}
        title={t("Delete category")}
        description={t(
          'Delete the category "{{name}}"? Entries inside it are kept.',
          { name: categoryDeleteTarget?.name ?? "" },
        )}
        confirmText={t("Delete")}
        destructive
        loading={categoryDeleting}
      />
    </div>
  );
}

function QuestionStat({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ size?: number; className?: string; "aria-hidden"?: boolean }>;
  label: string;
  value: number | string;
}) {
  return (
    <div className="surface p-3">
      <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon size={14} className="text-primary" aria-hidden={true} />
        {label}
      </dt>
      <dd className="mt-1 text-xl font-semibold tabular-nums text-foreground">
        {value}
      </dd>
    </div>
  );
}
