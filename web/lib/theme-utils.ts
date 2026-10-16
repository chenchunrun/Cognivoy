/**
 * Theme utilities for common scenarios (Paper/Ink two-theme system).
 */

import { setTheme, type Theme } from "./theme";

/**
 * Toggle theme between light and dark
 */
export function toggleTheme(currentTheme: Theme): Theme {
  const newTheme: Theme = currentTheme === "dark" ? "light" : "dark";
  setTheme(newTheme);
  return newTheme;
}

export function setLightTheme(): void {
  setTheme("light");
}

export function setDarkTheme(): void {
  setTheme("dark");
}

/**
 * Watch theme changes via localStorage events
 */
export function onThemeChange(callback: (theme: Theme) => void): () => void {
  const handleStorageChange = (e: StorageEvent) => {
    if (
      e.key === "cognivoy-theme" &&
      (e.newValue === "light" || e.newValue === "dark")
    ) {
      callback(e.newValue);
    }
  };

  window.addEventListener("storage", handleStorageChange);

  return () => {
    window.removeEventListener("storage", handleStorageChange);
  };
}
