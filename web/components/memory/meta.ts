// Shared metadata for memory surfaces / L3 slots: icons + i18n label keys.
// Label strings here are English i18n keys — wrap with t() at the call site.

import {
  BookOpen,
  Bot,
  ClipboardList,
  FileText,
  History,
  Library,
  MessageSquare,
  NotebookPen,
  PenLine,
  SlidersHorizontal,
  Target,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import type { L3Slot, Surface } from "@/lib/memory-graph";

export const SURFACE_META: Record<Surface, { icon: LucideIcon; label: string }> =
  {
    chat: { icon: MessageSquare, label: "Chat" },
    notebook: { icon: NotebookPen, label: "Notebook" },
    quiz: { icon: ClipboardList, label: "Quiz" },
    kb: { icon: BookOpen, label: "Knowledge base" },
    book: { icon: Library, label: "Book" },
    partner: { icon: Bot, label: "Partner" },
    cowriter: { icon: PenLine, label: "Co-writer" },
  };

export const L3_META: Record<L3Slot, { icon: LucideIcon; label: string }> = {
  profile: { icon: UserRound, label: "User profile" },
  recent: { icon: History, label: "Recent summary" },
  scope: { icon: Target, label: "Knowledge scope" },
  preferences: { icon: SlidersHorizontal, label: "Preferences" },
};

export const GENERIC_DOC_ICON = FileText;

export function formatTimestamp(value: string | null, fallback = ""): string {
  if (!value) return fallback;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

export function shorten(s: string, n: number): string {
  const trimmed = (s || "").replace(/\s+/g, " ").trim();
  return trimmed.length > n ? trimmed.slice(0, n - 1) + "…" : trimmed;
}
