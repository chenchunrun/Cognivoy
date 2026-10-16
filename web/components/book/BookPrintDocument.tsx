"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import type { BookDetail } from "@/lib/book-types";
import { bookCoverSrc } from "@/lib/book-library";

import { BlockView } from "./BlockView";

export interface BookPrintDocumentProps {
  detail: BookDetail;
  open: boolean;
  onClose: () => void;
  options: BookPrintOptions;
}

export interface BookPrintOptions {
  edition: "screen" | "print";
  paperSize: "A4" | "Letter";
  fontFamily: "serif" | "sans";
  includeToc: boolean;
  header: string;
  footer: string;
}

function waitForPrintAssets(container: HTMLElement): Promise<void> {
  const images = Array.from(container.querySelectorAll("img"));
  const pending = images
    .filter((image) => !image.complete)
    .map(
      (image) =>
        new Promise<void>((resolve) => {
          image.addEventListener("load", () => resolve(), { once: true });
          image.addEventListener("error", () => resolve(), { once: true });
        }),
    );

  return Promise.race([
    Promise.all(pending).then(() => undefined),
    new Promise<void>((resolve) => window.setTimeout(resolve, 2500)),
  ]);
}

/**
 * A complete, selectable-text print edition mounted directly under body.
 * Keeping it outside the workspace shell prevents sidebars and fixed chat
 * controls from changing the printable page width.
 */
export function BookPrintDocument({
  detail,
  open,
  onClose,
  options,
}: BookPrintDocumentProps) {
  const { t } = useTranslation();
  const rootRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open || !rootRef.current) return;

    let cancelled = false;
    const handleAfterPrint = () => onClose();
    window.addEventListener("afterprint", handleAfterPrint, { once: true });

    const print = async () => {
      if (document.fonts?.ready) await document.fonts.ready;
      if (rootRef.current) await waitForPrintAssets(rootRef.current);
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      if (!cancelled) window.print();
    };

    void print();
    return () => {
      cancelled = true;
      window.removeEventListener("afterprint", handleAfterPrint);
    };
  }, [open, onClose]);

  if (!open || typeof document === "undefined") return null;

  const coverSrc = bookCoverSrc(detail.book);
  const pages = [...detail.pages]
    .filter((page) => page.content_type !== "overview")
    .sort((a, b) => a.order - b.order);

  return createPortal(
    <div
      ref={rootRef}
      className="book-print-portal"
      data-testid="book-print-document"
      aria-hidden="true"
    >
      <style>{`@page { size: ${options.paperSize}; margin: ${options.edition === "print" ? "18mm 17mm 20mm" : "14mm 14mm 18mm"}; }`}</style>
      {options.header && <div className="book-print-running-header">{options.header}</div>}
      {options.footer && <div className="book-print-running-footer">{options.footer}</div>}
      <article
        className={`book-print-document book-print-${options.edition} book-print-font-${options.fontFamily}`}
      >
        <section className="book-print-cover">
          {coverSrc && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={coverSrc} alt="" className="book-print-cover-image" />
          )}
          <div className="book-print-cover-copy">
            <div className="book-print-kicker">{t("Cognivoy · Learning Edition")}</div>
            <h1>{detail.book.title}</h1>
            {detail.book.description && <p>{detail.book.description}</p>}
            <div className="book-print-meta">
              {t("{{count}} chapters", { count: detail.book.chapter_count })} ·{" "}
              {t("{{count}} pages", { count: pages.length })}
            </div>
          </div>
        </section>

        {options.includeToc && (
          <section className="book-print-toc">
            <div className="book-print-kicker">{t("Contents")}</div>
            <h2>{t("Contents")}</h2>
            <ol>
              {pages.map((page, index) => (
                <li key={page.id}>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <span>{page.title}</span>
                </li>
              ))}
            </ol>
          </section>
        )}

        {pages.map((page, pageIndex) => (
          <section key={page.id} className="book-print-chapter">
            <header>
              <div className="book-print-kicker">
                CHAPTER {String(pageIndex + 1).padStart(2, "0")}
              </div>
              <h2>{page.title}</h2>
              {page.learning_objectives.length > 0 && (
                <ul>
                  {page.learning_objectives.map((objective, index) => (
                    <li key={index}>{objective}</li>
                  ))}
                </ul>
              )}
            </header>
            <div className="book-print-blocks">
              {page.blocks
                .filter((block) => block.status !== "hidden")
                .map((block) => (
                  <div key={block.id} className="book-print-block">
                    <BlockView block={block} />
                  </div>
                ))}
            </div>
          </section>
        ))}
      </article>
    </div>,
    document.body,
  );
}
