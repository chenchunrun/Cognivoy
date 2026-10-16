"use client";

import { createElement, useState } from "react";
import {
  Cherry,
  Cloud,
  Compass,
  Cookie,
  Droplet,
  Feather,
  Flame,
  Heart,
  Leaf,
  Lightbulb,
  Moon,
  Music,
  Sparkles,
  Sprout,
  Star,
  Sun,
  type LucideIcon,
} from "lucide-react";
import {
  AVATAR_COLORS,
  fallbackAvatarFor,
  parseAvatarMarker,
} from "@/lib/avatar";
import { avatarImageUrl } from "@/lib/profile-api";
import { cn } from "@/lib/utils";

/**
 * User avatars. Marker parsing and the deterministic fallback live in
 * lib/avatar.ts (pure, unit-tested); this component maps icon names to
 * lucide components and renders the marker.
 */

// Must cover every name in AVATAR_ICON_NAMES (lib/avatar.ts).
export const AVATAR_ICONS: Record<string, LucideIcon> = {
  sparkles: Sparkles,
  sprout: Sprout,
  leaf: Leaf,
  feather: Feather,
  cloud: Cloud,
  droplet: Droplet,
  sun: Sun,
  moon: Moon,
  flame: Flame,
  star: Star,
  heart: Heart,
  lightbulb: Lightbulb,
  compass: Compass,
  cherry: Cherry,
  cookie: Cookie,
  music: Music,
};

export interface UserAvatarProps {
  username: string;
  /** Needed to resolve "img:" markers to an image URL. */
  userId?: string;
  /** Avatar marker; empty/undefined renders the deterministic fallback. */
  avatar?: string;
  size?: number;
  className?: string;
}

export function UserAvatar({
  username,
  userId,
  avatar = "",
  size = 32,
  className,
}: UserAvatarProps) {
  const [imageBroken, setImageBroken] = useState(false);
  // A re-upload changes the marker version; give the new URL a fresh chance.
  // Render-time reset (instead of an effect) per react.dev's "adjusting
  // state when a prop changes" guidance.
  const imageKey = `${userId ?? ""}:${avatar}`;
  const [lastImageKey, setLastImageKey] = useState(imageKey);
  if (imageKey !== lastImageKey) {
    setLastImageKey(imageKey);
    setImageBroken(false);
  }

  const descriptor = parseAvatarMarker(avatar);
  const isImage =
    descriptor.kind === "image" && Boolean(userId) && !imageBroken;

  // A stored marker can name an icon/color this build doesn't know; validate
  // against the known sets and fall back to the deterministic avatar so it
  // never renders blank.
  const fallback = fallbackAvatarFor(username);
  let iconName: string;
  let colorName: string;
  if (descriptor.kind === "icon") {
    iconName =
      descriptor.icon in AVATAR_ICONS ? descriptor.icon : fallback.icon;
    colorName =
      descriptor.color in AVATAR_COLORS ? descriptor.color : fallback.color;
  } else {
    iconName = fallback.icon;
    colorName = fallback.color;
  }

  return (
    <span
      className={cn("relative inline-flex shrink-0", className)}
      style={{ width: size, height: size }}
      role="img"
      aria-label={username}
    >
      {isImage ? (
        /* Dynamic backend URL with cookie auth; next/image cannot optimize it. */
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={avatarImageUrl(userId as string, avatar)}
          alt=""
          width={size}
          height={size}
          onError={() => setImageBroken(true)}
          className="h-full w-full rounded-full object-cover"
        />
      ) : (
        <span
          className="flex h-full w-full items-center justify-center rounded-full text-white"
          style={{ backgroundColor: AVATAR_COLORS[colorName] }}
        >
          {createElement(AVATAR_ICONS[iconName] ?? Sparkles, {
            size: Math.round(size * 0.55),
            strokeWidth: 1.8,
          })}
        </span>
      )}
    </span>
  );
}
