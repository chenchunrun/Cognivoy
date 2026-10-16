"use client";

import * as React from "react";
import { Play, Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { ResearchOutlineResult } from "@/lib/deep-research-types";
import type { OutlineItem } from "@/lib/research-types";
import { Button, Card, Input, Textarea } from "@/components/ui";

export default function ResearchOutlinePreview({
  result,
  onStart,
}: {
  result: ResearchOutlineResult;
  onStart: (outline: OutlineItem[]) => void;
}) {
  const { t } = useTranslation();
  const [items, setItems] = React.useState(result.subTopics);
  const [submitted, setSubmitted] = React.useState(false);
  const update = (index: number, field: keyof OutlineItem, value: string) => {
    setItems((current) =>
      current.map((item, itemIndex) =>
        itemIndex === index ? { ...item, [field]: value } : item,
      ),
    );
  };
  const validItems = items.filter((item) => item.title.trim());
  const start = () => {
    if (!validItems.length || submitted) return;
    setSubmitted(true);
    onStart(validItems);
  };

  return (
    <Card className="space-y-3 p-4" data-research-outline="true">
      <div>
        <h3 className="text-sm font-semibold text-foreground">
          {t("Research Outline")}
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("Review the sub-topics, then start the research.")}
        </p>
      </div>
      <div className="space-y-2">
        {items.map((item, index) => (
          <div key={index} className="flex items-start gap-2 rounded-lg border border-border p-2">
            <span className="mt-2 w-5 shrink-0 text-center text-xs text-muted-foreground">
              {index + 1}
            </span>
            <div className="min-w-0 flex-1 space-y-1.5">
              <Input
                value={item.title}
                aria-label={t("Sub-topic title")}
                onChange={(event) => update(index, "title", event.target.value)}
              />
              <Textarea
                value={item.overview}
                aria-label={t("Research direction")}
                rows={2}
                onChange={(event) => update(index, "overview", event.target.value)}
              />
            </div>
            <button
              type="button"
              aria-label={t("Remove sub-topic")}
              disabled={items.length === 1 || submitted}
              onClick={() => setItems((current) => current.filter((_, itemIndex) => itemIndex !== index))}
              className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={submitted}
          onClick={() => setItems((current) => [...current, { title: "", overview: "" }])}
        >
          <Plus size={13} /> {t("Add sub-topic")}
        </Button>
        <Button type="button" size="sm" loading={submitted} disabled={!validItems.length} onClick={start}>
          <Play size={13} /> {t("Start Research")}
        </Button>
      </div>
    </Card>
  );
}
