"use client";

import * as React from "react";
import { AlertTriangle, CheckCircle2, FileCheck2, RefreshCcw } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Badge, Button } from "@/components/ui";
import { bookApi, type BookStageReview } from "@/lib/book-api";

interface BookStageReviewsProps {
  bookId: string;
}

function latestFor(reviews: BookStageReview[], stage: BookStageReview["stage"]) {
  return reviews
    .filter((review) => review.stage === stage)
    .sort((left, right) => right.revision - left.revision)[0];
}

export function BookStageReviews({ bookId }: BookStageReviewsProps) {
  const { t } = useTranslation();
  const [reviews, setReviews] = React.useState<BookStageReview[]>([]);
  const [notes, setNotes] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    const result = await bookApi.listStageReviews(bookId);
    setReviews(result.reviews);
  }, [bookId]);

  React.useEffect(() => {
    let active = true;
    bookApi.listStageReviews(bookId)
      .then((result) => {
        if (active) setReviews(result.reviews);
      })
      .catch((caught) => {
        if (active) setError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => { active = false; };
  }, [bookId]);

  const outline = latestFor(reviews, "outline");
  const proofread = latestFor(reviews, "proofread");

  const submit = async (
    stage: BookStageReview["stage"],
    decision: BookStageReview["decision"],
  ) => {
    setBusy(true);
    setError(null);
    const current = latestFor(reviews, stage);
    try {
      const result = await bookApi.createStageReview(bookId, {
        stage,
        decision,
        notes,
        expected_revision: current?.revision || 0,
      });
      setReviews((existing) => [result.review, ...existing]);
      setNotes("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      await refresh().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="surface space-y-4 rounded-2xl p-5" data-testid="book-stage-reviews">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 font-semibold text-foreground">
            <FileCheck2 className="h-4 w-4 text-primary" />
            {t("Editorial review")}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("Freeze the outline before drafting, then review the complete book before publishing.")}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refresh()} disabled={busy}>
          <RefreshCcw className="h-3.5 w-3.5" />
          {t("Refresh")}
        </Button>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-xl border border-border bg-muted-subtle p-4">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium text-foreground">{t("Outline review")}</span>
            {outline ? (
              <Badge variant={outline.decision === "approved" ? "success" : "warning"}>
                {t("Revision {{revision}} · {{decision}}", {
                  revision: outline.revision,
                  decision: outline.decision,
                })}
              </Badge>
            ) : <Badge variant="outline">{t("Not reviewed")}</Badge>}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {outline
              ? t("{{chapters}} chapters · {{pages}} pages", {
                  chapters: outline.snapshot.chapter_count || 0,
                  pages: outline.snapshot.page_count || 0,
                })
              : t("Confirm the outline to create the first immutable review version.")}
          </p>
        </div>

        <div className="rounded-xl border border-border bg-muted-subtle p-4">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium text-foreground">{t("Whole-book review")}</span>
            {proofread ? (
              <Badge variant={proofread.decision === "approved" ? "success" : "warning"}>
                {t("Revision {{revision}} · {{decision}}", {
                  revision: proofread.revision,
                  decision: proofread.decision,
                })}
              </Badge>
            ) : <Badge variant="outline">{t("Not reviewed")}</Badge>}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {proofread
              ? t("{{errors}} errors · {{warnings}} warnings · {{sources}} source anchors", {
                  errors: proofread.snapshot.error_count || 0,
                  warnings: proofread.snapshot.warning_count || 0,
                  sources: proofread.snapshot.source_anchor_count || 0,
                })
              : t("Run a structural check across every generated page and block.")}
          </p>
        </div>
      </div>

      {proofread && (proofread.snapshot.issue_count || 0) > 0 && (
        <div className="rounded-xl border border-warning-border bg-warning-muted px-4 py-3 text-xs text-foreground">
          <div className="mb-2 flex items-center gap-2 font-semibold">
            <AlertTriangle className="h-4 w-4" />
            {t("Review findings")}
          </div>
          <ul className="space-y-1 text-muted-foreground">
            {(proofread.snapshot.issues || []).slice(0, 5).map((issue, index) => (
              <li key={`${issue.message}-${index}`}>• {issue.page_title ? `${issue.page_title}: ` : ""}{issue.message}</li>
            ))}
          </ul>
        </div>
      )}

      <label className="block text-xs font-medium text-muted-foreground">
        {t("Review notes")}
        <textarea
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          className="mt-2 min-h-20 w-full resize-y rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
          placeholder={t("Record editorial decisions or required changes…")}
          maxLength={2000}
        />
      </label>

      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}

      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" loading={busy} onClick={() => submit("proofread", "draft")}>
          {!busy && <RefreshCcw className="h-3.5 w-3.5" />}
          {t("Run whole-book review")}
        </Button>
        <Button variant="outline" size="sm" disabled={busy || !proofread} onClick={() => submit("proofread", "changes_requested")}>
          <AlertTriangle className="h-3.5 w-3.5" />
          {t("Request changes")}
        </Button>
        <Button size="sm" disabled={busy || !proofread} onClick={() => submit("proofread", "approved")}>
          <CheckCircle2 className="h-3.5 w-3.5" />
          {t("Approve edition")}
        </Button>
      </div>
    </section>
  );
}
