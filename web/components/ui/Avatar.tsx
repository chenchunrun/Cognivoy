"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export type AvatarSize = "sm" | "md" | "lg";

export interface AvatarProps {
  src?: string | null;
  alt?: string;
  /** Explicit fallback initials. Derived from `alt` when omitted. */
  fallback?: string;
  size?: AvatarSize;
  className?: string;
}

const sizes: Record<AvatarSize, string> = {
  sm: "h-7 w-7 text-[10px]",
  md: "h-9 w-9 text-xs",
  lg: "h-11 w-11 text-sm",
};

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2);
  return `${parts[0][0]}${parts[parts.length - 1][0]}`;
}

export function Avatar({
  src,
  alt = "",
  fallback,
  size = "md",
  className,
}: AvatarProps) {
  const [errored, setErrored] = React.useState(false);
  const showImage = Boolean(src) && !errored;
  const label = (fallback ?? initials(alt)).toUpperCase();

  return (
    <span
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary-muted font-medium text-accent-foreground",
        sizes[size],
        className,
      )}
      role="img"
      aria-label={alt || undefined}
    >
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src ?? undefined}
          alt={alt}
          className="h-full w-full object-cover"
          onError={() => setErrored(true)}
        />
      ) : (
        <span aria-hidden="true">{label}</span>
      )}
    </span>
  );
}
