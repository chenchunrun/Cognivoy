import { readdirSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const webRoot = path.resolve(".");
const distRoot = path.join(webRoot, "dist", "node-tests");
function collect(dir) {
  return readdirSync(dir).map((name) => path.join(dir, name)).sort().flatMap((entry) => statSync(entry).isDirectory() ? collect(entry) : entry.endsWith(".test.js") ? [entry] : []);
}
function run(command, args) {
  const result = spawnSync(command, args, { cwd: webRoot, stdio: "inherit", env: process.env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
rmSync(distRoot, { recursive: true, force: true });
run(process.execPath, [path.join(webRoot, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.node-tests.json"]);
const tests = collect(path.join(distRoot, "tests"));
if (!tests.length) throw new Error("No compiled node tests found");
run(process.execPath, ["-r", "./scripts/register-node-test-aliases.cjs", "--test", ...tests]);
