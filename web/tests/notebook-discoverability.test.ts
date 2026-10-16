import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

function source(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf8");
}

test("notebook management is directly reachable from the Materials navigation", () => {
  const sidebar = source("components/shell/Sidebar.tsx");
  const materials = sidebar.match(/const MATERIAL_NAV = \[([\s\S]*?)\] as const;/)?.[1];
  assert.ok(materials, "Materials navigation exists");
  assert.match(materials, /href: "\/notebook", labelKey: "Notebooks", icon: NotebookPen/);
  assert.match(sidebar, /MATERIAL_NAV\.map\(\(item\) => \(\s*<NavLink key=\{item\.href\} \{\.\.\.item\} \/>/);
});

test("notebook creation remains visible and wraps with the list header on narrow layouts", () => {
  const list = source("components/notebook/NotebookList.tsx");
  const header = list.slice(list.indexOf('<div className="mb-2'), list.indexOf("{loading ?"));
  assert.match(header, /className="[^"]*flex-wrap[^"]*gap-2/);
  assert.match(header, /<Button[\s\S]*?size="sm"[\s\S]*?onClick=\{onCreate\}/);
  assert.match(header, /<Plus[^>]*aria-hidden="true"[^>]*\/>\s*\{t\("New notebook"\)\}/);
  assert.doesNotMatch(header, /size="icon"|sr-only|\bhidden\b(?!="true")/);
});

test("notebook navigation and creation labels already have English and Chinese translations", () => {
  for (const language of ["en", "zh"]) {
    const messages = JSON.parse(source(`locales/${language}/app.json`)) as Record<string, string>;
    assert.ok(messages.Notebooks?.trim());
    assert.ok(messages["New notebook"]?.trim());
  }
});

test("release acceptance covers the first-notebook save journey", () => {
  const manifest = JSON.parse(source("package.json")) as { scripts: Record<string, string> };
  assert.equal(manifest.scripts["test:e2e:notebook-save"], "node ./scripts/e2e-notebook-save.cjs");
  assert.ok(manifest.scripts["test:e2e:release"].includes("npm run test:e2e:notebook-save"));
});
