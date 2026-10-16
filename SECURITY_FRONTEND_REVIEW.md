# Frontend security review — 2026-10-16

Scope: the twelve JavaScript CodeQL alerts and three npm Dependabot alerts supplied for the public release snapshot. This is a manual source/data-flow review with targeted regression tests, not a new CodeQL scan. No alerts were dismissed or suppressed.

## CodeQL dispositions

| Alert | Location | Assessment and action |
| --- | --- | --- |
| 1 | `web/lib/markdown-display.ts`, `MATH_SPAN_REGEX` | **Medium, CWE-1333. Fixed.** The overlapping `\\.` and `[^$\n]` alternatives allowed exponential backtracking on unterminated math. Excluding backslashes from the second alternative makes the choices disjoint. The original expression timed out after one second with 40 repeated escaped tokens; a subprocess regression now handles 10,000 within a three-second deadline. Valid escaped-dollar and citation-containing math remains protected. |
| 2, 3 | `web/scripts/i18n-extract.cjs`, static and object-field key extraction | **Quality finding. Fixed.** Replacing an apostrophe with the same apostrophe did nothing. Removed both identity replacements without changing the subsequent escaped-apostrophe handling. Locale extraction and parity checks pass. |
| 4 | `web/scripts/route_budgets.mjs`, `chunkStem` | **Quality finding. Fixed.** Removed `/page` to `/page` identity replacement. Production route-budget verification passes. |
| 5 | `web/components/shell/Sidebar.tsx`, session title | **Not an exploitable HTML sink in current code.** `session.title` is passed as a React `title` attribute and React text child. React escapes these values; neither use parses HTML. No `innerHTML`, `outerHTML`, or `dangerouslySetInnerHTML` sink exists in this component. No code suppression added. |
| 6 | `web/lib/markdown-display.ts`, `stripDisplaySyntax` | **Not a sanitizer boundary.** Tag removal feeds only empty-table/empty-block predicates. Its result is never inserted as HTML; the original block is retained or discarded. Actual Markdown rendering uses `rehypeRaw`, KaTeX, then `rehypeSanitize` in `web/components/chat/Markdown.tsx`. No code suppression added. |
| 7 | `web/lib/markdown-display.ts`, `hasVisibleMarkdownContent` | **Not a sanitizer boundary.** The stripped intermediate value becomes a boolean length check, never HTML. Nested malformed tags may affect visibility classification but cannot inject a DOM node through this function. No code suppression added. |
| 8 | `web/lib/latex.ts`, flow-fence conversion | **Low, CWE-116. Fixed grammar injection.** Backslash-escaping a pipe is not sufficient Mermaid escaping, and other closing delimiters could create graph statements. Node and edge labels now use quoted strings with single-pass decimal entity encoding of syntax characters, including backslashes and entity introducers. Mermaid already runs with `securityLevel: "strict"`; no script execution was demonstrated. A browser render of a malicious label produced only the two expected nodes and no script nodes. |
| 9 | `web/tests/release-gates.test.ts`, navigation-source assertions | **Test-only quality finding. Fixed.** Replaced dynamically escaped regular expressions with literal `source.includes(destination)` assertions. These values are constant strings, not attacker input. |
| 10 | partner conversation ID generation, now in `web/lib/partner-session.ts` | **Low, CWE-338. Fixed defense in depth.** Replaced a short `Math.random()` ID with 16 Web Crypto random bytes encoded as hex. Existing stored keys remain usable. IDs do not replace backend authorization. Regression fails if `Math.random()` is used and validates the 128-bit output format. `getRandomValues` works without requiring `randomUUID`'s secure-context support. |
| 11 | `web/scripts/e2e-research-resume.cjs`, evidence write | **Not an arbitrary-path write in current code.** The filename uses the explicit `SESSION_ID` environment setting after `^[A-Za-z0-9_-]{1,160}$` validation, not an HTTP response field. Existing tests reject `../another-session`. Response values are JSON-serialized into that fixed evidence directory; writing response content is the test's intended evidence function. No code suppression added. |
| 12 | `web/lib/markdown-display.ts`, reference-section matcher | **Intentional mixed anchoring, clarified.** Markdown headings must start a line; HTML `<details id="references">` may appear inline. Explicitly grouped the two alternatives while preserving this behavior. This expression is not an access-control or URL-validation check. |

Priority was the render-time denial of service, followed by identifier entropy and diagram label handling. The unchanged findings retain their source-level rationale above; only a subsequent server CodeQL run can establish which alerts close automatically.

## Dependency remediation

The existing lockfile contained all three reported affected versions. Targeted overrides and lockfile updates now select:

| Dependabot alert | Package | Before | After | Dependency path |
| --- | --- | --- | --- | --- |
| 31 | `postcss-selector-parser` | 6.1.4 | 7.1.6 | Tailwind / postcss-nested |
| 29 | `brace-expansion` | 5.0.9 | 5.0.12 | typescript-eslint / minimatch 10 |
| 26 | `js-yaml` | 4.3.1 | 4.3.2 | ESLint / eslintrc |

Existing brace-expansion 1.x and 2.x compatibility overrides remain unchanged. The selector parser upgrade crosses a major version, so the full production build and route budgets were run to validate Tailwind integration.

The configured npm mirror does not implement the audit endpoint. An audit against `https://registry.npmjs.org` no longer reports the three packages above, but reports **seven high-severity package/chain entries rooted in one additional advisory**, [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm): stack exhaustion in `braces <=3.0.3`, through development-time Tailwind/ESLint glob processing. The audit suggests a Tailwind 4 migration and an eslint-config-next downgrade, not a compatible patch. Those architectural changes are outside this focused remediation. Do not describe the dependency audit as clean; evaluate a maintained replacement or coordinated tooling migration and avoid feeding untrusted glob patterns to these build tools.

### Residual advisory reachability and narrow mitigation

The advisory explicitly lists **no patched version**. Local dependency/source inspection found `braces@3.0.3` through Tailwind's chokidar and micromatch, with fast-glob also reachable from Next's ESLint plugin. Tailwind feeds `tailwindConfig.content.files` to glob processing; this repository supplies six static, shallow extension-group patterns in `web/tailwind.config.js`. Next's `getRootDirs` globs only an explicitly configured `settings.next.rootDir`, which this repository does not set. No direct braces, micromatch, or fast-glob imports were found in application components, libraries, contexts, hooks, or scripts. No remote application-input path to the affected parser was identified in this review.

Use trusted repository configuration, isolate builds, and keep user-supplied strings out of glob configuration. Deploy production dependency sets without development tools where the packaging workflow permits. These are scoped exposure mitigations, not a patched library or an advisory dismissal. A vendored monkeypatch would require maintaining and validating third-party parser semantics and is not recommended as a scanner-only fix.

Audit commands and results (2026-10-16):

```sh
npm audit --json --registry=https://registry.npmjs.org --cache /private/tmp/cognivoy-npm-cache
# Exit 1: 7 high package/chain entries rooted in the braces advisory.
npm audit --omit=dev --json --registry=https://registry.npmjs.org --cache /private/tmp/cognivoy-npm-cache
# Exit 0: 0 vulnerabilities in the production dependency audit.
```

## Verification

- All 160 Node tests passed, including four new security regression tests.
- TypeScript checking passed.
- ESLint passed with two existing Next.js navigation warnings in `lib/api.ts` and `lib/session-api.ts`.
- i18n extraction, locale parity, and strict literal audit passed.
- Production webpack build and all route budgets passed.
- Isolated headless Chromium rendered the malicious flow label successfully with two nodes and zero scripts.
- `npm ls` verified all three patched versions and preserved older compatible brace-expansion branches.

These checks verify the scoped changes; they do not establish that the entire application is vulnerability-free. Re-run hosted CodeQL/Dependabot after the changes are published through the normal review process.
