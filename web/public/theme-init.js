/* Pre-hydration theme init — must stay in sync with lib/theme.ts.
 * Served as a static file so it executes as a classic parser-blocking script
 * (React 19 never executes inline <script> elements rendered from components). */
(function () {
  try {
    var stored = localStorage.getItem("cognivoy-theme");
    var dark = stored
      ? stored === "dark" || stored === "glass"
      : window.matchMedia("(prefers-color-scheme: dark)").matches;
    if (dark) document.documentElement.classList.add("dark");
  } catch {}
})();
