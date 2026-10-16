import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

/**
 * Shared entry-page heading. Its fixed typography and spacing keep workspace
 * and utility destinations on the same visual baseline as users navigate.
 */
export function PageHeader({
  title,
  description,
  actions,
  className,
}: PageHeaderProps) {
  return (
    <header
      data-testid="page-entry-header"
      className={cn(
        "mb-8 flex min-h-14 flex-wrap items-start justify-between gap-x-6 gap-y-4",
        className,
      )}
    >
      <div className="min-w-0 max-w-3xl">
        <h1
          data-testid="page-entry-title"
          className="display text-2xl font-semibold tracking-tight text-foreground"
        >
          {title}
        </h1>
        {description ? (
          <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? (
        <div
          data-testid="page-entry-actions"
          className="flex w-full min-w-0 max-w-full flex-wrap items-center gap-2 sm:w-auto sm:shrink-0"
        >
          {actions}
        </div>
      ) : null}
    </header>
  );
}
