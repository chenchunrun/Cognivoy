#!/usr/bin/env node
/**
 * i18n-extract — collect i18n keys actually referenced in code.
 *
 * Scans app/, components/, context/, hooks/, i18n/ for:
 *   - t("...") / t('...')            (plain keys)
 *   - t("...{{var}}...", {...})      (interpolation; key is the string literal only)
 *   - i18n.t("...") / i18n.t('...')
 *   - labelKey: "..." / descKey: "..." / prefillKey: "..." / nameKey: "..."
 *     modeKey: "..." / blurb: "..." / unit: "..."   (object-literal fields that
 *     are later passed through t(...) — the dynamic-call blind spot)
 * Dynamic keys (template literals with expressions, variables) are not
 * extractable — they are reported separately.
 *
 * Usage:
 *   node scripts/i18n-extract.cjs            # human-readable report
 *   node scripts/i18n-extract.cjs --json     # machine-readable JSON on stdout
 *   node scripts/i18n-extract.cjs --check    # exit 1 if locale files are missing keys
 */
const fs = require("node:fs");
const path = require("node:path");

const webRoot = path.resolve(__dirname, "..");
const SCAN_DIRS = ["app", "components", "context", "hooks", "i18n"];
const CODE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx"]);

function listCodeFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name === ".next" || ent.name.startsWith(".next"))
      continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listCodeFiles(full));
    else if (ent.isFile() && CODE_EXTS.has(path.extname(ent.name))) out.push(full);
  }
  return out;
}

function toRel(p) {
  return path.relative(webRoot, p).replaceAll("\\", "/");
}

// Strip comments and block strings that could confuse the key regex.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length))
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function extractFrom(content, rel) {
  const keys = new Map(); // key -> [{file, line}]
  const dynamic = []; // {file, line, snippet}

  const src = stripComments(content);
  const lineOf = (idx) => src.slice(0, idx).split("\n").length;

  const add = (key, idx) => {
    if (!key) return;
    const entry = { file: rel, line: lineOf(idx) };
    if (!keys.has(key)) keys.set(key, []);
    keys.get(key).push(entry);
  };

  // Static string-literal keys: t("...") / t('...') / i18n.t("...")
  // Negative lookbehind on word chars to avoid matching foo.t(...) from
  // unrelated objects — but keep i18n.t / useTranslation's t / this.props.t.
  const staticRe =
    /(?:\bi18n\s*\.\s*|\b)(?<![\w$])t\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g;
  for (const m of src.matchAll(staticRe)) {
    const raw = m[1] !== undefined ? m[1] : m[2];
    let key;
    try {
      // Interpret escape sequences the way JS would.
      key = JSON.parse(`"${raw.replace(/(?<!\\)'/g, "'").replace(/\\'/g, "'")}"`);
    } catch {
      key = raw; // fall back to the raw literal
    }
    add(key, m.index);
  }

  // Dynamic keys: t(`...${...}...`) or t(variable)
  const tplRe = /(?:\bi18n\s*\.\s*|\b)(?<![\w$])t\(\s*`([^`]*)`/g;
  for (const m of src.matchAll(tplRe)) {
    if (m[1].includes("${")) {
      dynamic.push({ file: rel, line: lineOf(m.index), snippet: `\`${m[1].slice(0, 80)}\`` });
    } else {
      add(m[1], m.index); // template literal without expressions = static
    }
  }
  const varRe = /(?:\bi18n\s*\.\s*|\b)(?<![\w$])t\(\s*([A-Za-z_$][\w$.]*)\s*[,)]/g;
  for (const m of src.matchAll(varRe)) {
    dynamic.push({ file: rel, line: lineOf(m.index), snippet: m[1] });
  }

  // Object-literal fields whose value is later fed through t(...) — e.g.
  // `{ labelKey: "Chat", descKey: "…" }` menus rendered as t(item.descKey).
  // Extracting them here closes the dynamic-call blind spot for --check.
  const fieldRe =
    /\b(?:labelKey|descKey|prefillKey|nameKey|modeKey|blurb|unit)\s*:\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g;
  for (const m of src.matchAll(fieldRe)) {
    const raw = m[1] !== undefined ? m[1] : m[2];
    let key;
    try {
      key = JSON.parse(`"${raw.replace(/(?<!\\)'/g, "'").replace(/\\'/g, "'")}"`);
    } catch {
      key = raw;
    }
    add(key, m.index);
  }

  return { keys, dynamic };
}

function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const check = args.includes("--check");

  const files = SCAN_DIRS.flatMap((d) => listCodeFiles(path.join(webRoot, d)));

  const allKeys = new Map(); // key -> refs[]
  const allDynamic = [];
  for (const f of files) {
    const rel = toRel(f);
    const { keys, dynamic } = extractFrom(fs.readFileSync(f, "utf8"), rel);
    for (const [k, refs] of keys) {
      if (!allKeys.has(k)) allKeys.set(k, []);
      allKeys.get(k).push(...refs);
    }
    allDynamic.push(...dynamic);
  }

  const enPath = path.join(webRoot, "locales", "en", "app.json");
  const zhPath = path.join(webRoot, "locales", "zh", "app.json");
  const en = JSON.parse(fs.readFileSync(enPath, "utf8"));
  const zh = JSON.parse(fs.readFileSync(zhPath, "utf8"));

  const keyList = [...allKeys.keys()].sort();
  const missingEn = keyList.filter((k) => !(k in en));
  const missingZh = keyList.filter((k) => !(k in zh));
  const usedSet = new Set(keyList);
  const unusedEn = Object.keys(en).filter((k) => !usedSet.has(k));
  const unusedZh = Object.keys(zh).filter((k) => !usedSet.has(k));

  const report = {
    filesScanned: files.length,
    keysFound: keyList.length,
    missingEn,
    missingZh,
    unusedInCode: { en: unusedEn.length, zh: unusedZh.length },
    dynamic: allDynamic,
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Scanned ${files.length} files in: ${SCAN_DIRS.join(", ")}`);
    console.log(`Static keys found in code: ${keyList.length}`);
    console.log(`Missing from locales/en/app.json: ${missingEn.length}`);
    for (const k of missingEn) console.log(`  - ${k}`);
    console.log(`Missing from locales/zh/app.json: ${missingZh.length}`);
    for (const k of missingZh) console.log(`  - ${k}`);
    console.log(`In JSON but never referenced in code: en=${unusedEn.length}, zh=${unusedZh.length}`);
    console.log(`Dynamic (non-extractable) key sites: ${allDynamic.length}`);
    for (const d of allDynamic) console.log(`  - ${d.file}:${d.line}  ${d.snippet}`);
  }

  if (check && (missingEn.length || missingZh.length)) process.exit(1);
}

main();
