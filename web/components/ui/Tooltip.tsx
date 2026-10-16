"use client";

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { cn } from "@/lib/utils";

export type TooltipSide = "top" | "bottom" | "left" | "right";

export interface TooltipProps {
  content: React.ReactNode;
  side?: TooltipSide;
  /** Hover delay in ms before the tooltip appears. */
  delay?: number;
  children: React.ReactNode;
  className?: string;
}

const positions: Record<TooltipSide, string> = {
  top: "bottom-full left-1/2 mb-1.5 -translate-x-1/2",
  bottom: "top-full left-1/2 mt-1.5 -translate-x-1/2",
  left: "right-full top-1/2 mr-1.5 -translate-y-1/2",
  right: "left-full top-1/2 ml-1.5 -translate-y-1/2",
};

export function Tooltip({
  content,
  side = "top",
  delay = 300,
  children,
  className,
}: TooltipProps) {
  const [visible, setVisible] = React.useState(false);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = () => {
    timerRef.current = setTimeout(() => setVisible(true), delay);
  };
  const hide = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    setVisible(false);
  };

  React.useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      <AnimatePresence>
        {visible && (
          <motion.span
            role="tooltip"
            className={cn(
              "pointer-events-none absolute z-50 whitespace-nowrap rounded-md bg-foreground px-2 py-1 text-xs text-background shadow-hairline",
              positions[side],
              className,
            )}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
          >
            {content}
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}
