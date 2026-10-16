/** Build and exercise the same standalone Next.js runtime shipped by the
 * launcher.  This closes the gap where the release gate compared `next dev`
 * against the legacy production frontend and therefore measured compiler/HMR
 * overhead instead of product performance.
 */
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const DIST_NAME = process.env.E2E_PRODUCTION_DIST_DIR || ".next-e2e-production";
const DIST = path.join(ROOT, DIST_NAME);
// A per-process default prevents a stale interrupted run from poisoning the
// next release check. CI may still pin an explicit port when required.
const PORT = Number(process.env.E2E_PRODUCTION_PORT || 38_000 + (process.pid % 1_000));
const BASE_URL = `http://127.0.0.1:${PORT}`;

function apiBaseUrl() {
  if (process.env.E2E_API_BASE_URL) return process.env.E2E_API_BASE_URL;
  if (process.env.COGNIVOY_API_BASE_URL) return process.env.COGNIVOY_API_BASE_URL;
  // The already-running source frontend is the authoritative backend bridge
  // for this E2E run.  Reading system.json is ambiguous when the native and
  // redesigned applications are intentionally running side by side on
  // different backend ports.
  return process.env.E2E_SOURCE_BASE_URL || process.env.BASE_URL || "http://127.0.0.1:3783";
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
  }
}

async function waitUntilReady(url, child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`production server exited with ${child.exitCode}`);
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.status < 500) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`production server did not become ready at ${url}`);
}

(async () => {
  const generated = ["next-env.d.ts", "tsconfig.json"].map((name) => path.join(ROOT, name));
  const snapshots = new Map(generated.map((file) => [file, fs.existsSync(file) ? fs.readFileSync(file) : null]));
  const buildEnv = {
    ...process.env,
    COGNIVOY_NEXT_DIST_DIR: DIST_NAME,
    COGNIVOY_AUTH_ENABLED: "false",
    NEXT_PUBLIC_API_BASE: apiBaseUrl(),
    NEXT_PUBLIC_AUTH_ENABLED: "false",
  };
  try {
    run("npm", ["run", "build"], { env: buildEnv });
  } finally {
    for (const [file, content] of snapshots) {
      if (content == null) fs.rmSync(file, { force: true });
      else fs.writeFileSync(file, content);
    }
  }

  run(process.execPath, ["./scripts/route_budgets.mjs"], {
    env: { ...process.env, NEXT_DIST_DIR: DIST_NAME },
  });

  const standalone = path.join(DIST, "standalone");
  fs.cpSync(path.join(DIST, "static"), path.join(standalone, DIST_NAME, "static"), {
    recursive: true,
  });
  const publicDir = path.join(ROOT, "public");
  if (fs.existsSync(publicDir)) {
    fs.cpSync(publicDir, path.join(standalone, "public"), { recursive: true });
  }

  const server = spawn(process.execPath, [path.join(standalone, "server.js")], {
    cwd: standalone,
    stdio: "inherit",
    env: {
      ...process.env,
      PORT: String(PORT),
      HOSTNAME: "127.0.0.1",
      COGNIVOY_API_BASE_URL: apiBaseUrl(),
      COGNIVOY_AUTH_ENABLED: "false",
      NEXT_PUBLIC_AUTH_ENABLED: "false",
    },
  });

  const stop = () => {
    if (server.exitCode == null) server.kill("SIGTERM");
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await waitUntilReady(`${BASE_URL}/home`, server);
    // The deterministic release gate measures the shipped production build
    // without depending on a separately running legacy app. Native parity is
    // an explicit opt-in gate (`npm run test:e2e:parity`).
    const requireNativeBaseline = process.env.REQUIRE_NATIVE_BASELINE || "0";
    const nativeBaseUrl = Object.prototype.hasOwnProperty.call(
      process.env,
      "NATIVE_BASE_URL",
    )
      ? process.env.NATIVE_BASE_URL
      : /^(1|true|yes)$/i.test(requireNativeBaseline)
        ? "http://127.0.0.1:3782"
        : "";
    run(process.execPath, ["./scripts/e2e-performance.cjs"], {
      env: {
        ...process.env,
        BASE_URL,
        NATIVE_BASE_URL: nativeBaseUrl,
        REQUIRE_NATIVE_BASELINE: requireNativeBaseline,
      },
    });
  } finally {
    stop();
    await new Promise((resolve) => {
      if (server.exitCode != null) return resolve();
      const timer = setTimeout(() => {
        server.kill("SIGKILL");
        resolve();
      }, 3_000);
      server.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
})()
  .catch((error) => {
    console.error(`FAIL ${error.stack || error.message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    // This build exists only for the isolated release gate. Leaving it behind
    // makes lint/branding tools scan generated bundles and can mask real
    // source findings with thousands of false positives.
    fs.rmSync(DIST, { recursive: true, force: true });
  });
