"use client";

import { useTranslation } from "react-i18next";
import { Database, Plus, Star, Trash2 } from "lucide-react";
import { Button, EmptyState, Skeleton, Tooltip } from "@/components/ui";
import { cn } from "@/lib/utils";
import { kbDocCount, type KnowledgeBase } from "@/lib/knowledge-helpers";
import { EngineBadge, KbStatusBadge } from "./kb-badges";

interface KbListProps {
  kbs: KnowledgeBase[];
  loading: boolean;
  selectedName: string | null;
  onSelect: (name: string) => void;
  onCreate: () => void;
  onSetDefault: (name: string) => void;
  onDelete: (kb: KnowledgeBase) => void;
}

/** Left pane: one card per knowledge base with engine/status/default/delete. */
export function KbList({
  kbs,
  loading,
  selectedName,
  onSelect,
  onCreate,
  onSetDefault,
  onDelete,
}: KbListProps) {
  const { t } = useTranslation();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 pb-3">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t("{{count}} knowledge bases", { count: kbs.length })}
        </span>
        <Button variant="outline" size="sm" onClick={onCreate}>
          <Plus size={14} aria-hidden="true" />
          {t("New")}
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
        {loading ? (
          Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-20 w-full rounded-xl" />
          ))
        ) : kbs.length === 0 ? (
          <EmptyState
            icon={Database}
            title={t("No knowledge bases yet")}
            description={t(
              "Create one to ground answers in your own documents.",
            )}
            action={
              <Button size="sm" onClick={onCreate}>
                <Plus size={14} aria-hidden="true" />
                {t("Create knowledge base")}
              </Button>
            }
          />
        ) : (
          kbs.map((kb) => {
            const selected = kb.name === selectedName;
            const docCount = kbDocCount(kb);
            return (
              <div
                key={kb.name}
                className={cn(
                  "surface relative w-full cursor-pointer p-3 text-left transition-colors duration-150",
                  selected ? "border-primary bg-primary-muted" : "hover:bg-muted",
                )}
              >
                <button
                  type="button"
                  className="absolute inset-0 z-10 rounded-xl"
                  aria-label={t("Open {{name}}", { name: kb.name })}
                  onClick={() => onSelect(kb.name)}
                />
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">
                      {kb.name}
                    </p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <EngineBadge kb={kb} />
                      <KbStatusBadge kb={kb} />
                    </div>
                  </div>
                  <div
                    className="relative z-20 flex shrink-0 items-center gap-0.5"
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => event.stopPropagation()}
                  >
                    <Tooltip
                      content={
                        kb.is_default
                          ? t("Default knowledge base")
                          : t("Set as default")
                      }
                    >
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        disabled={kb.is_default}
                        onClick={() => onSetDefault(kb.name)}
                        aria-label={
                          kb.is_default
                            ? t("Default knowledge base")
                            : t("Set as default")
                        }
                      >
                        <Star
                          size={14}
                          aria-hidden="true"
                          className={cn(
                            kb.is_default
                              ? "fill-primary text-primary"
                              : "text-muted-foreground",
                          )}
                        />
                      </Button>
                    </Tooltip>
                    <Tooltip content={t("Delete")}>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => onDelete(kb)}
                        aria-label={t("Delete")}
                      >
                        <Trash2
                          size={14}
                          aria-hidden="true"
                          className="text-muted-foreground"
                        />
                      </Button>
                    </Tooltip>
                  </div>
                </div>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  {docCount != null
                    ? t("{{count}} documents", { count: docCount })
                    : t("Document count unknown")}
                </p>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
