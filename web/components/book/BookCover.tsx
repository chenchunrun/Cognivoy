"use client";

import * as React from "react";
import { Download, Maximize2, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Dialog, DialogTitle } from "@/components/ui";
import { cn } from "@/lib/utils";

export interface BookCoverProps {
  src: string;
  title: string;
  className?: string;
  imageClassName?: string;
  testId?: string;
}

/** A book-cover thumbnail that always opens an accessible, fitted preview. */
export function BookCover({
  src,
  title,
  className,
  imageClassName,
  testId,
}: BookCoverProps) {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);

  return (
    <>
      <button
        type="button"
        aria-label={t("View cover for {{title}}", { title })}
        onClick={() => setOpen(true)}
        className={cn(
          "group/cover relative shrink-0 overflow-hidden rounded-lg border border-primary-border bg-primary-muted shadow-hairline outline-none transition hover:border-primary hover:shadow-lift focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
          className,
        )}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={title}
          className={cn("h-full w-full object-cover", imageClassName)}
          data-testid={testId}
        />
        <span className="absolute inset-0 flex items-center justify-center bg-overlay opacity-0 transition-opacity group-hover/cover:opacity-100 group-focus-visible/cover:opacity-100">
          <Maximize2 className="h-5 w-5 text-primary-foreground" aria-hidden="true" />
        </span>
      </button>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        className="flex max-h-[92dvh] max-w-5xl flex-col gap-3 p-4"
      >
        <div className="flex items-center justify-between gap-4 px-1">
          <DialogTitle className="min-w-0 truncate">{title}</DialogTitle>
          <div className="flex shrink-0 items-center gap-1">
            <a
              href={`${src}${src.includes("?") ? "&" : "?"}download=true`}
              aria-label={t("Download cover for {{title}}", { title })}
              className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Download className="h-4 w-4" />
            </a>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label={t("Close")}
              className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-lg bg-background p-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={t("Book cover preview: {{title}}", { title })}
            className="h-[78dvh] w-auto max-w-full object-contain shadow-overlay"
            data-testid="book-cover-preview"
          />
        </div>
      </Dialog>
    </>
  );
}
