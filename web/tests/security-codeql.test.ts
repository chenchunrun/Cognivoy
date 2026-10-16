import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
import { normalizeMarkdownForDisplay } from "../lib/markdown-display";
import { convertFlowFenceToMermaid } from "../lib/latex";
import { freshPartnerSessionKey } from "../lib/partner-session";

test("unterminated inline math with repeated escapes cannot stall rendering", () => {
  const modulePath = resolve(__dirname, "../lib/markdown-display.js");
  const result = spawnSync(process.execPath, ["-e", `
    const { normalizeMarkdownForDisplay } = require(${JSON.stringify(modulePath)});
    normalizeMarkdownForDisplay('$' + '\\\\#'.repeat(10000));
  `], { timeout: 3000, encoding: "utf8" });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});

test("math still protects citations including escaped dollar delimiters", () => {
  for (const math of ["$x = [1, 2]$", "$x = \\$5 + [1, 2]$", "$$x = [1, 2]$$"]) {
    assert.equal(normalizeMarkdownForDisplay(math), math);
  }
});

test("partner conversation keys use 128 bits of cryptographic randomness", () => {
  const original = Math.random;
  Math.random = () => { throw new Error("Insecure random source used"); };
  try {
    const keys = Array.from({ length: 100 }, freshPartnerSessionKey);
    assert.equal(new Set(keys).size, keys.length);
    for (const key of keys) assert.match(key, /^web-[a-f0-9]{32}$/);
  } finally {
    Math.random = original;
  }
});

test("flow node and edge labels cannot escape their Mermaid grammar context", () => {
  const result = convertFlowFenceToMermaid('a=>operation: \\" ] --> evil[Injected] | <script>\nb=>end: Done\na(yes|evil)->b');
  assert.ok(result);
  assert.match(result, /a\["#92;#34; #93; --#62; evil#91;Injected#93; #124; #60;script#62;"\]/);
  assert.ok(result.includes('a -->|"yes#124;evil"| b'));
  assert.ok(result.includes('b(["Done"])'));
});
