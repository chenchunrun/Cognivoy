/**
 * Theme persistence for the Paper/Ink design system.
 * Light = "Paper" (warm cream canvas), dark = "Ink" (warm near-black).
 */

export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "cognivoy-theme";

type ThemeChangeListener = (theme: Theme) => void;
const themeListeners = new Set<ThemeChangeListener>();

export function subscribeToThemeChanges(
  listener: ThemeChangeListener,
): () => void {
  themeListeners.add(listener);
  return () => themeListeners.delete(listener);
}

function notifyThemeChange(theme: Theme): void {
  themeListeners.forEach((listener) => listener(theme));
}

export function getStoredTheme(): Theme | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    // Legacy values ("snow"/"cream"/"glass") collapse onto the new two-theme system.
    if (stored === "dark" || stored === "glass") return "dark";
    if (stored) return "light";
  } catch {
    // localStorage may be disabled
  }
  return null;
}

export function saveThemeToStorage(theme: Theme): boolean {
  if (typeof window === "undefined") return false;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
    return true;
  } catch {
    return false;
  }
}

export function getSystemTheme(): Theme {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function applyThemeToDocument(theme: Theme): void {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", theme === "dark");
}

export function initializeTheme(): Theme {
  const stored = getStoredTheme();
  const theme = stored ?? getSystemTheme();
  applyThemeToDocument(theme);
  if (!stored) saveThemeToStorage(theme);
  return theme;
}

export function setTheme(theme: Theme): void {
  applyThemeToDocument(theme);
  saveThemeToStorage(theme);
  notifyThemeChange(theme);
}
