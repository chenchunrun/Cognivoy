/**
 * Pre-hydration theme script: loads /theme-init.js (see public/theme-init.js)
 * as a classic parser-blocking script so the stored/system theme class is
 * applied before first paint — no flash of the wrong theme.
 *
 * A static external file is used because React 19 never executes inline
 * <script> elements rendered from components.
 */
export function ThemeScript() {
  // eslint-disable-next-line @next/next/no-sync-scripts -- must run before hydration to prevent theme flash
  return <script src="/theme-init.js" />;
}
