"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

export interface ToggleProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}

export function Toggle({
  checked,
  onCheckedChange,
  disabled = false,
  className,
  "aria-label": ariaLabel,
}: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-primary" : "bg-input",
        className,
      )}
    >
      <motion.span
        className="block h-4 w-4 rounded-full bg-card shadow-hairline"
        initial={false}
        animate={{ x: checked ? 16 : 2 }}
        transition={{ type: "spring", stiffness: 500, damping: 32 }}
        aria-hidden="true"
      />
    </button>
  );
}
