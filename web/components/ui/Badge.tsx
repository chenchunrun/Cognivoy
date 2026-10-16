import * as React from "react";
import { cn } from "@/lib/utils";

export type BadgeVariant =
  | "default"
  | "outline"
  | "success"
  | "warning"
  | "destructive"
  | "primary";

const variants: Record<BadgeVariant, string> = {
  default: "bg-secondary text-secondary-foreground",
  outline: "border border-border bg-transparent text-foreground",
  success: "bg-success text-success-foreground",
  warning: "bg-warning text-warning-foreground",
  destructive: "bg-destructive text-destructive-foreground",
  primary: "bg-primary-muted text-accent-foreground",
};

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

export function Badge({
  variant = "default",
  className,
  ...props
}: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
        variants[variant],
        className,
      )}
      {...props}
    />
  );
}
