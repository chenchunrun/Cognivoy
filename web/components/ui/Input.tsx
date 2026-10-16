import * as React from "react";
import { cn } from "@/lib/utils";

export interface InputProps
  extends React.InputHTMLAttributes<HTMLInputElement> {
  ref?: React.Ref<HTMLInputElement>;
}

export function Input({ className, ref, ...props }: InputProps) {
  return (
    <input
      ref={ref}
      className={cn(
        "h-9 w-full rounded-lg border border-input bg-card px-3 text-sm text-foreground placeholder:text-muted-foreground transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
