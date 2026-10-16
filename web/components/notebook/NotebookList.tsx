"use client";

import * as React from "react";
import { useTranslation } from "react-i18next";
import { MoreHorizontal, NotebookPen, Pencil, Plus, Trash2 } from "lucide-react";
import {
  Button,
  Dropdown,
  DropdownItem,
  DropdownSeparator,
  EmptyState,
  Skeleton,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import type { NotebookSummary } from "@/lib/notebook-api";

export interface NotebookListProps {
  notebooks: NotebookSummary[];
  loading: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRename: (notebook: NotebookSummary) => void;
  onDelete: (notebook: NotebookSummary) => void;
}

export function NotebookList({
  notebooks,
  loading,
  selectedId,
  onSelect,
  onCreate,
  onRename,
  onDelete,
}: NotebookListProps) {
  const { t } = useTranslation();

  return (
    <div className="surface flex min-h-[200px] flex-col p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 px-1">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t("Notebooks")}
        </span>
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={onCreate}
        >
          <Plus size={15} aria-hidden="true" />
          {t("New notebook")}
        </Button>
      </div>

      {loading ? (
        <div className="space-y-2 p-1">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-14 w-full" />
          ))}
        </div>
      ) : notebooks.length === 0 ? (
        <EmptyState
          icon={NotebookPen}
          title={t("No notebooks yet")}
          description={t("Create one to organize saved outputs.")}
          action={
            <Button size="sm" onClick={onCreate}>
              <Plus size={14} />
              {t("New notebook")}
            </Button>
          }
        />
      ) : (
        <ul className="space-y-1">
          {notebooks.map((notebook) => {
            const active = notebook.id === selectedId;
            return (
              <li key={notebook.id} className="group relative">
                <button
                  type="button"
                  onClick={() => onSelect(notebook.id)}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors duration-150",
                    active
                      ? "bg-primary-muted text-accent-foreground"
                      : "text-foreground hover:bg-muted",
                  )}
                >
                  <span
                    className="h-2 w-2 shrink-0 rounded-full bg-primary"
                    // Per-notebook accent color comes from the backend.
                    style={
                      notebook.color
                        ? { backgroundColor: notebook.color }
                        : undefined
                    }
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {notebook.name}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {t("{{count}} records", {
                        count: notebook.record_count ?? 0,
                      })}
                    </span>
                  </span>
                </button>
                <div
                  className={cn(
                    // Opacity creates a stacking context. Keep the actions (and
                    // its dropdown) above later notebook rows so menu items stay
                    // pointer-reachable instead of only looking clickable.
                    "absolute right-1.5 top-1/2 z-20 -translate-y-1/2",
                    active
                      ? "opacity-100"
                      : "opacity-0 transition-opacity duration-150 group-hover:opacity-100",
                  )}
                >
                  <Dropdown
                    align="end"
                    trigger={
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        aria-label={t("Notebook actions")}
                      >
                        <MoreHorizontal size={14} />
                      </Button>
                    }
                  >
                    <DropdownItem
                      icon={Pencil}
                      label={t("Rename")}
                      onClick={() => onRename(notebook)}
                    />
                    <DropdownSeparator />
                    <DropdownItem
                      icon={Trash2}
                      label={t("Delete")}
                      destructive
                      onClick={() => onDelete(notebook)}
                    />
                  </Dropdown>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
