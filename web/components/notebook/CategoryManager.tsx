"use client";

import * as React from "react";
import { useTranslation } from "react-i18next";
import { Check, FolderOpen, Pencil, Plus, Trash2, X } from "lucide-react";
import { Button, Input, useToast } from "@/components/ui";
import type { NotebookCategory } from "@/lib/notebook-api";
import { createCategory, renameCategory } from "@/lib/notebook-api";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface CategoryManagerProps {
  categories: NotebookCategory[];
  onChanged: () => void;
  onDelete: (category: NotebookCategory) => void;
}

/** Inline add / rename / delete panel for question-notebook categories. */
export function CategoryManager({
  categories,
  onChanged,
  onDelete,
}: CategoryManagerProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [newName, setNewName] = React.useState("");
  const [creating, setCreating] = React.useState(false);
  const [renaming, setRenaming] = React.useState<{
    id: number;
    name: string;
  } | null>(null);

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true);
    try {
      await createCategory(name);
      setNewName("");
      onChanged();
    } catch (error) {
      toast({
        variant: "destructive",
        title: t("Failed to create category"),
        description: errorMessage(error),
      });
    } finally {
      setCreating(false);
    }
  };

  const handleRename = async () => {
    if (!renaming || !renaming.name.trim()) {
      setRenaming(null);
      return;
    }
    try {
      await renameCategory(renaming.id, renaming.name.trim());
      setRenaming(null);
      onChanged();
    } catch (error) {
      toast({
        variant: "destructive",
        title: t("Failed to rename category"),
        description: errorMessage(error),
      });
      setRenaming(null);
    }
  };

  return (
    <div className="surface p-4">
      <ul className="space-y-1.5">
        {categories.map((category) => (
          <li
            key={category.id}
            className="flex items-center justify-between gap-2 rounded-lg bg-muted px-3 py-2"
          >
            {renaming?.id === category.id ? (
              <div className="flex flex-1 items-center gap-1.5">
                <Input
                  autoFocus
                  value={renaming.name}
                  onChange={(event) =>
                    setRenaming({ ...renaming, name: event.target.value })
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void handleRename();
                    if (event.key === "Escape") setRenaming(null);
                  }}
                  className="h-7 text-xs"
                  aria-label={t("Category name")}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  aria-label={t("Save")}
                  onClick={() => void handleRename()}
                >
                  <Check size={13} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  aria-label={t("Cancel")}
                  onClick={() => setRenaming(null)}
                >
                  <X size={13} />
                </Button>
              </div>
            ) : (
              <>
                <span className="flex min-w-0 items-center gap-2 text-sm text-foreground">
                  <FolderOpen
                    size={13}
                    className="shrink-0 text-muted-foreground"
                  />
                  <span className="truncate">{category.name}</span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {t("{{count}} entries", { count: category.entry_count })}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-0.5">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    aria-label={t("Rename category")}
                    onClick={() =>
                      setRenaming({ id: category.id, name: category.name })
                    }
                  >
                    <Pencil size={12} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-destructive"
                    aria-label={t("Delete category")}
                    onClick={() => onDelete(category)}
                  >
                    <Trash2 size={12} />
                  </Button>
                </span>
              </>
            )}
          </li>
        ))}
        {categories.length === 0 && (
          <li className="py-2 text-center text-sm text-muted-foreground">
            {t("No categories yet.")}
          </li>
        )}
      </ul>

      <div className="mt-3 flex items-center gap-2">
        <Input
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void handleCreate();
          }}
          placeholder={t("New category name")}
          aria-label={t("New category name")}
          className="h-8 text-sm"
        />
        <Button
          size="sm"
          onClick={() => void handleCreate()}
          loading={creating}
          disabled={!newName.trim()}
        >
          <Plus size={13} />
          {t("Add")}
        </Button>
      </div>
    </div>
  );
}
