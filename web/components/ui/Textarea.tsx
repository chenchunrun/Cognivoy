"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export interface TextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Grow the textarea to fit its content as the user types. */
  autoResize?: boolean;
  ref?: React.Ref<HTMLTextAreaElement>;
}

export function Textarea({
  className,
  autoResize = false,
  value,
  ref,
  ...props
}: TextareaProps) {
  const innerRef = React.useRef<HTMLTextAreaElement | null>(null);

  const setRefs = React.useCallback(
    (node: HTMLTextAreaElement | null) => {
      innerRef.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );

  React.useEffect(() => {
    const el = innerRef.current;
    if (!autoResize || !el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [autoResize, value]);

  return (
    <textarea
      ref={setRefs}
      value={value}
      className={cn(
        "min-h-[72px] w-full rounded-lg border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50",
        autoResize && "resize-none overflow-hidden",
        className,
      )}
      {...props}
    />
  );
}
