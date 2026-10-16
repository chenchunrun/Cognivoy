"use client";

import * as React from "react";
import { useTranslation } from "react-i18next";
import {
  Bot,
  ChevronDown,
  FileText,
  FileUp,
  MessageSquare,
  NotebookPen,
  Pencil,
  Plus,
  Search,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import {
  Badge,
  type BadgeVariant,
  Button,
  EmptyState,
  Input,
  Skeleton,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import type {
  NotebookDetail,
  NotebookRecordItem,
} from "@/lib/notebook-api";
import Markdown from "@/components/chat/Markdown";
import { listDeletedKnowledgeReferences } from "@/lib/knowledge-api";
import {
  deletedKnowledgeBaseSet,
  referenceKnowledgeBaseName,
} from "@/lib/knowledge-references";

const TYPE_META: Record<
  string,
  { labelKey: string; variant: BadgeVariant; icon: typeof MessageSquare }
> = {
  chat: { labelKey: "Chat", variant: "primary", icon: MessageSquare },
  tutorbot: { labelKey: "Partner", variant: "primary", icon: Bot },
  research: { labelKey: "Research", variant: "success", icon: Search },
  question: { labelKey: "Question", variant: "warning", icon: FileText },
  solve: { labelKey: "Solve", variant: "outline", icon: FileText },
  co_writer: { labelKey: "Co-Writer", variant: "default", icon: Pencil },
};
const NOTEBOOK_RECORD_PAGE_SIZE = 50;

export interface NotebookRecordsProps {
  notebook: NotebookDetail | null;
  loading: boolean;
  total: number;
  page: number;
  query: string;
  onPageChange: (page: number) => void;
  onQueryChange: (query: string) => void;
  onAddRecord: () => void;
  onImportMarkdown: () => void;
  onEditRecord: (record: NotebookRecordItem) => void;
  onDeleteRecord: (record: NotebookRecordItem) => void;
}

export function NotebookRecords({
  notebook,
  loading,
  total,
  page,
  query,
  onPageChange,
  onQueryChange,
  onAddRecord,
  onImportMarkdown,
  onEditRecord,
  onDeleteRecord,
}: NotebookRecordsProps) {
  const { t } = useTranslation();
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const [deletedKnowledgeBases, setDeletedKnowledgeBases] = React.useState<Set<string>>(
    () => new Set(),
  );

  React.useEffect(() => {
    let cancelled = false;
    void listDeletedKnowledgeReferences().then((rows) => {
      if (!cancelled) setDeletedKnowledgeBases(deletedKnowledgeBaseSet(rows));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    setExpandedId(null);
  }, [notebook?.id]);

  const records = notebook?.records ?? [];

  if (loading) {
    return (
      <div className="surface space-y-3 p-5">
        <Skeleton className="h-6 w-48" />
        {Array.from({ length: 3 }).map((_, index) => (
          <Skeleton key={index} className="h-16 w-full" />
        ))}
      </div>
    );
  }

  if (!notebook) {
    return (
      <div className="surface">
        <EmptyState
          icon={NotebookPen}
          title={t("Select a notebook")}
          description={t("Pick a notebook on the left to browse its records.")}
          className="py-20"
        />
      </div>
    );
  }

  return (
    <div className="surface min-w-0 overflow-hidden flex flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0">
          <h2 className="display truncate text-lg font-medium text-foreground">
            {notebook.name}
          </h2>
          {notebook.description && (
            <p className="mt-0.5 truncate text-sm text-muted-foreground">
              {notebook.description}
            </p>
          )}
        </div>
        <div className="flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto">
          <div className="relative min-w-0 flex-1 sm:flex-none">
            <Search
              size={13}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder={t("Search records")}
              aria-label={t("Search records")}
              className="w-full pl-7 sm:w-44"
            />
          </div>
          <Button size="sm" variant="outline" onClick={onImportMarkdown}>
            <FileUp size={14} />
            {t("Import Markdown")}
          </Button>
          <Button size="sm" onClick={onAddRecord}>
            <Plus size={14} />
            {t("Add record")}
          </Button>
        </div>
      </div>

      {total === 0 ? (
        <EmptyState
          icon={FileText}
          title={t("No records yet")}
          description={t(
            "Save outputs from chat or add a record manually to fill this notebook.",
          )}
          action={
            <Button size="sm" variant="outline" onClick={onAddRecord}>
              <Plus size={14} />
              {t("Add record")}
            </Button>
          }
        />
      ) : (
        <>
        <ul className="divide-y divide-border">
          {records.map((record) => {
            const meta = TYPE_META[record.type] ?? {
              labelKey: record.type,
              variant: "default" as BadgeVariant,
              icon: FileText,
            };
            const TypeIcon = meta.icon;
            const expanded = expandedId === record.id;
            return (
              <li key={record.id}>
                <div className="flex w-full min-w-0 items-center gap-1 px-3 py-3.5 transition-colors duration-150 hover:bg-muted sm:px-5">
                  <button
                    type="button"
                    aria-expanded={expanded}
                    onClick={() => setExpandedId(expanded ? null : record.id)}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  >
                  <ChevronDown
                    size={14}
                    className={cn(
                      "shrink-0 text-muted-foreground transition-transform duration-150",
                      !expanded && "-rotate-90",
                    )}
                  />
                  <Badge variant={meta.variant} className="shrink-0">
                    <TypeIcon size={11} />
                    {t(meta.labelKey)}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                    {record.title}
                  </span>
                  {record.created_at && (
                    <span className="hidden shrink-0 text-xs tabular-nums text-muted-foreground sm:block">
                      {new Date((record.updated_at ?? record.created_at) * 1000).toLocaleString()}
                    </span>
                  )}
                  </button>
                  <div className="flex shrink-0 items-center gap-0.5">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      aria-label={t("Edit record")}
                      onClick={() => onEditRecord(record)}
                    >
                      <Pencil size={13} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-destructive"
                      aria-label={t("Delete record")}
                      onClick={() => onDeleteRecord(record)}
                    >
                      <Trash2 size={13} />
                    </Button>
                  </div>
                </div>

                {expanded && (
                  <div className="px-5 pb-5 pl-12">
                    <div className="mb-3 flex flex-wrap items-center gap-1.5">
                      {(record.tags ?? []).map((tag) => (
                        <Badge key={tag} variant="outline">{tag}</Badge>
                      ))}
                      {record.revision && (
                        <span className="text-xs text-muted-foreground">
                          {t("Revision {{revision}}", { revision: record.revision })}
                        </span>
                      )}
                      {(record.references?.length ?? 0) > 0 && (
                        <span className="text-xs text-muted-foreground">
                          {t("{{count}} references", { count: record.references?.length ?? 0 })}
                        </span>
                      )}
                      {(record.references ?? []).map((reference, index) => {
                        const kbName = referenceKnowledgeBaseName(reference);
                        if (!kbName || !deletedKnowledgeBases.has(kbName)) return null;
                        return (
                          <Badge
                            key={`${kbName}-${index}`}
                            variant="warning"
                            title={t("This source was deleted after the record was saved.")}
                          >
                            <TriangleAlert size={11} />
                            {t("{{name}} · deleted", { name: kbName })}
                          </Badge>
                        );
                      })}
                    </div>
                    {record.summary && (
                      <p className="mb-3 text-sm leading-6 text-muted-foreground">
                        {record.summary}
                      </p>
                    )}
                    {record.user_query && (
                      <div className="mb-3 rounded-lg border border-border bg-muted px-3 py-2.5">
                        <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                          {t("Query")}
                        </div>
                        <div className="prose-cognivoy text-sm text-foreground">
                          <Markdown content={record.user_query} />
                        </div>
                      </div>
                    )}
                    <div className="rounded-lg border border-border bg-card px-4 py-3">
                      <div className="prose-cognivoy text-foreground">
                        <Markdown content={record.output || ""} />
                      </div>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        {total > NOTEBOOK_RECORD_PAGE_SIZE && (
          <nav
            data-testid="notebook-record-pagination"
            aria-label={t("Notebook record pages")}
            className="flex items-center justify-between gap-3 border-t border-border px-5 py-3"
          >
            <Button
              variant="outline"
              size="sm"
              disabled={page === 0}
              onClick={() => onPageChange(Math.max(0, page - 1))}
            >
              {t("Previous page")}
            </Button>
            <span className="text-xs tabular-nums text-muted-foreground">
              {t("Page {{page}} of {{pages}}", {
                page: page + 1,
                pages: Math.ceil(total / NOTEBOOK_RECORD_PAGE_SIZE),
              })}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={(page + 1) * NOTEBOOK_RECORD_PAGE_SIZE >= total}
              onClick={() => onPageChange(page + 1)}
            >
              {t("Next page")}
            </Button>
          </nav>
        )}
        </>
      )}
    </div>
  );
}
