import fs from "node:fs";
import path from "node:path";

const NEXT_DIR = path.resolve(process.env.NEXT_DIST_DIR || ".next");
const APP_CHUNKS = path.join(NEXT_DIR, "static", "chunks", "app");
const APP_PATHS = path.join(NEXT_DIR, "server", "app-paths-manifest.json");
const BUILD_MANIFEST = path.join(NEXT_DIR, "build-manifest.json");

const ROUTE_BUDGETS_KB = {
  "/": 180,
  "/home/[[...sessionId]]": 850,
  "/playground": 700,
  "/co-writer": 250,
  "/book": 500,
  "/knowledge": 450,
  "/memory": 500,
  "/space/agents": 420,
  "/settings/agents": 300,
  "/settings/agents/[kind]": 260,
};
// Next 16's framework/runtime chunks account for ~430KB before application
// code. Keep 500KB as a regression ceiling; route budgets below isolate the
// product chunks that this repository controls.
const ROOT_SHELL_BUDGET_KB = 500;

function walk(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name);
    return entry.isDirectory() ? walk(target) : [target];
  });
}

function publicRoute(appPath) {
  return appPath.replace(/\/\([^/]+\)/g, "").replace(/\/page$/, "") || "/";
}

function chunkStem(appPath) {
  return appPath.replace(/^\//, "").replace(/\/page$/, "/page");
}

function matchingInitialChunks(appPath, allChunks) {
  const pageStem = chunkStem(appPath);
  const group = appPath.match(/^\/\(([^)]+)\)/)?.[1];
  const stems = [pageStem];
  if (group) stems.push(`(${group})/layout`);
  const publicSegments = publicRoute(appPath).split("/").filter(Boolean);
  for (let index = 1; index < publicSegments.length; index += 1) {
    const prefix = publicSegments.slice(0, index).join("/");
    stems.push(group ? `(${group})/${prefix}/layout` : `${prefix}/layout`);
  }
  return allChunks.filter((file) => {
    const relative = path.relative(APP_CHUNKS, file).replace(/\\/g, "/");
    return stems.some((stem) => relative.startsWith(`${stem}-`) && relative.endsWith(".js"));
  });
}

function bytes(files) {
  return [...new Set(files)].reduce((total, file) => total + (fs.existsSync(file) ? fs.statSync(file).size : 0), 0);
}

if (!fs.existsSync(APP_PATHS) || !fs.existsSync(APP_CHUNKS)) {
  console.error("Missing webpack production output. Run `next build --webpack` first.");
  process.exit(1);
}

const appPaths = Object.keys(JSON.parse(fs.readFileSync(APP_PATHS, "utf8")));
const allChunks = walk(APP_CHUNKS);
let failed = false;
console.log("Route budgets (initial route chunks, excluding root shell):");
for (const [route, budget] of Object.entries(ROUTE_BUDGETS_KB)) {
  const appPath = appPaths.find((candidate) => publicRoute(candidate) === route);
  if (!appPath) {
    console.log(`FAIL ${route.padEnd(32)} missing route`);
    failed = true;
    continue;
  }
  const actual = Math.round(bytes(matchingInitialChunks(appPath, allChunks)) / 1024);
  const status = actual > budget ? "FAIL" : "OK";
  if (status === "FAIL") failed = true;
  console.log(`${status.padEnd(4)} ${route.padEnd(32)} ${String(actual).padStart(4)}KB / ${budget}KB`);
}

const build = JSON.parse(fs.readFileSync(BUILD_MANIFEST, "utf8"));
const rootFiles = [...(build.rootMainFiles ?? []), ...allChunks.filter((file) => /^layout-[^.]+\.js$/.test(path.basename(file)))].map((file) => path.isAbsolute(file) ? file : path.join(NEXT_DIR, file));
const rootKb = Math.round(bytes(rootFiles) / 1024);
const rootStatus = rootKb > ROOT_SHELL_BUDGET_KB ? "FAIL" : "OK";
if (rootStatus === "FAIL") failed = true;
console.log(`${rootStatus.padEnd(4)} ${"root-shell".padEnd(32)} ${String(rootKb).padStart(4)}KB / ${ROOT_SHELL_BUDGET_KB}KB`);
if (failed) process.exit(1);
