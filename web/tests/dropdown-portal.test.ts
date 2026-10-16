import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const dropdown = readFileSync(join(process.cwd(), "components/ui/Dropdown.tsx"), "utf8");

test("dropdown portal is opt-in and guarded from server-side document access", () => {
  assert.match(dropdown, /portal\?: boolean/);
  assert.match(dropdown, /portal = false/);
  assert.match(dropdown, /typeof document !== "undefined" && createPortal\(menu, document\.body\)/);
  assert.match(dropdown, /: cn\("absolute mt-1", align === "start" \? "left-0" : "right-0"\)/);
});

test("portal menu measures the actual trigger, flips upward and stays inside the viewport", () => {
  assert.match(dropdown, /if \(!open \|\| !portal\) return/);
  assert.match(dropdown, /triggerElement\.getBoundingClientRect\(\)/);
  assert.match(dropdown, /openAbove = menu\.offsetHeight > below && above > below/);
  assert.match(dropdown, /Math\.min\(left, viewportWidth - width - margin\)/);
  assert.match(dropdown, /Math\.min\(top, viewportHeight - height - margin\)/);
  assert.match(dropdown, /fixed overflow-y-auto overscroll-contain/);
  assert.match(dropdown, /maxWidth: "calc\(100vw - 1rem\)"/);
});

test("portal containment preserves menu clicks while anchor scrolling and resize close it", () => {
  assert.match(dropdown, /!containerRef\.current\?\.contains\(event\.target as Node\) &&\s*!menuRef\.current\?\.contains\(event\.target as Node\)/);
  assert.match(dropdown, /if \(!menuRef\.current\?\.contains\(event\.target as Node\)\) close\(\)/);
  assert.match(dropdown, /addEventListener\("scroll", onScroll, \{ capture: true, passive: true \}\)/);
  assert.match(dropdown, /removeEventListener\("scroll", onScroll, true\)/);
  assert.match(dropdown, /addEventListener\("resize", close\)/);
  assert.match(dropdown, /removeEventListener\("resize", close\)/);
});

test("Escape restores focus without scrolling and trigger/item callbacks retain their behavior", () => {
  assert.match(dropdown, /if \(portal\) triggerRef\.current\?\.focus\(\{ preventScroll: true \}\)/);
  assert.equal((dropdown.match(/closeAndFocusTrigger\(\);/g) ?? []).length, 2);
  assert.match(dropdown, /\.props\.onClick\?\.\(event\);\s*if \(event\.defaultPrevented\) return;\s*triggerRef\.current = event\.currentTarget as HTMLElement;/);
  assert.match(dropdown, /onClick\?\.\(\);\s*context\?\.close\(\)/);
});

test("portal opening focuses the first enabled menu item after positioning without scrolling", () => {
  const layoutEffect = dropdown.slice(dropdown.indexOf("React.useLayoutEffect"), dropdown.indexOf("React.useEffect"));
  assert.match(layoutEffect, /if \(!open \|\| !portal\) return/);
  assert.match(layoutEffect, /visibility: "visible",[\s\S]*menu\.querySelector<HTMLElement>\(\s*'\[role="menuitem"\]:not\(:disabled\):not\(\[aria-disabled="true"\]\)',\s*\)\?\.focus\(\{ preventScroll: true \}\)/);
});

test("focus leaving a portal closes it and its listener is cleaned up without affecting inline menus", () => {
  assert.match(dropdown, /const onOutsideInteraction = \(event: MouseEvent \| FocusEvent\)/);
  assert.match(dropdown, /if \(portal\) \{\s*document\.addEventListener\("focusin", onOutsideInteraction\)/);
  assert.match(dropdown, /if \(portal\) \{\s*document\.removeEventListener\("focusin", onOutsideInteraction\)/);
  assert.match(dropdown, /!containerRef\.current\?\.contains\(event\.target as Node\) &&\s*!menuRef\.current\?\.contains\(event\.target as Node\)/);
});

test("Tab at either portal menu boundary closes it without trapping natural browser focus", () => {
  const tabHandler = dropdown.match(/else if \(portal && event\.key === "Tab"\) \{([\s\S]*?)\} else if \(event\.key === "Enter"/);
  assert.ok(tabHandler, "Tab boundary handling is limited to portal menus");
  assert.match(tabHandler[1], /querySelectorAll<HTMLElement>\(\s*'\[role="menuitem"\]:not\(:disabled\):not\(\[aria-disabled="true"\]\)'/);
  assert.match(tabHandler[1], /event\.shiftKey \? items\[0\] : items\[items\.length - 1\]/);
  assert.match(tabHandler[1], /if \(document\.activeElement === boundary\) close\(\)/);
  assert.doesNotMatch(tabHandler[1], /preventDefault|stopPropagation|closeAndFocusTrigger|\.focus\(/);
});
