"use client";

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  className?: string;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Dialog({ open, onClose, children, className }: DialogProps) {
  const cardRef = React.useRef<HTMLDivElement | null>(null);

  // ESC to close, simple focus management, body scroll lock.
  React.useEffect(() => {
    if (!open) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    const card = cardRef.current;
    const firstFocusable = card?.querySelector<HTMLElement>(FOCUSABLE);
    (firstFocusable ?? card)?.focus();

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus?.();
    };
  }, [open, onClose]);

  const dialog = (
    <AnimatePresence>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          role="presentation"
        >
          <motion.div
            className="absolute inset-0"
            style={{ backgroundColor: "var(--overlay)" }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={onClose}
            aria-hidden="true"
          />
          <motion.div
            ref={cardRef}
            role="dialog"
            aria-modal="true"
            tabIndex={-1}
            className={cn(
              "relative w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-overlay focus-visible:outline-none",
              className,
            )}
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.15 }}
          >
            {children}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );

  // A fixed overlay must escape transformed cards and panels; otherwise the
  // nearest transformed ancestor becomes its containing block and the dialog
  // visibly jumps as hover/focus styles change.
  return typeof document === "undefined" ? null : createPortal(dialog, document.body);
}

export function DialogTitle({
  className,
  ...props
}: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h2
      className={cn("display text-lg font-medium text-foreground", className)}
      {...props}
    />
  );
}

export function DialogDescription({
  className,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      className={cn("mt-1.5 text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export function DialogFooter({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("mt-6 flex items-center justify-end gap-2", className)}
      {...props}
    />
  );
}
