import * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SelectProps
  extends React.SelectHTMLAttributes<HTMLSelectElement> {
  ref?: React.Ref<HTMLSelectElement>;
}

export function Select({ className, children, ref, ...props }: SelectProps) {
  return (
    <div className="relative inline-block w-full">
      <select
        ref={ref}
        className={cn(
          "h-9 w-full appearance-none rounded-lg border border-input bg-card pl-3 pr-8 text-sm text-foreground transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        size={14}
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
        aria-hidden="true"
      />
    </div>
  );
}
