import * as React from "react";
import { cn } from "@/lib/utils";
import { Spinner } from "./Spinner";

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "outline"
  | "ghost"
  | "destructive";

export type ButtonSize = "sm" | "md" | "lg" | "icon";

const base =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50";

const variants: Record<ButtonVariant, string> = {
  primary: "bg-primary text-primary-foreground hover:brightness-105",
  secondary: "bg-secondary text-secondary-foreground hover:brightness-95",
  outline: "border border-border bg-transparent hover:bg-muted",
  ghost: "bg-transparent hover:bg-muted",
  destructive:
    "bg-destructive text-destructive-foreground hover:brightness-105",
};

const sizes: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-[13px]",
  md: "h-9 px-4 text-sm",
  lg: "h-10 px-5 text-sm",
  icon: "h-9 w-9",
};

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  ref?: React.Ref<HTMLButtonElement>;
}

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  disabled,
  className,
  children,
  type = "button",
  ref,
  ...props
}: ButtonProps) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(base, variants[variant], sizes[size], className)}
      {...props}
    >
      {loading && <Spinner size={size === "sm" ? 13 : 15} />}
      {children}
    </button>
  );
}
