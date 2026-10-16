"use client";

import * as React from "react";
import { RefreshCw, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const { t } = useTranslation();

  React.useEffect(() => {
    console.error("Route render failed", error);
  }, [error]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="surface max-w-md p-8 text-center" role="alert">
        <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <TriangleAlert size={20} />
        </span>
        <h1 className="display mt-4 text-xl font-semibold text-foreground">
          {t("This page could not be displayed")}
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          {t("Your work is still saved. Try loading this page again.")}
        </p>
        {error.digest ? (
          <p className="mt-3 font-mono text-[11px] text-muted-foreground">
            {t("Error reference: {{reference}}", { reference: error.digest })}
          </p>
        ) : null}
        <button
          type="button"
          onClick={reset}
          className="mt-5 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
        >
          <RefreshCw size={14} />
          {t("Reload page")}
        </button>
      </div>
    </main>
  );
}
