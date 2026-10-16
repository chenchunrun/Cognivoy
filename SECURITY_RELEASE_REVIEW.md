# Release security review — 2026-10-16

This review covers the 322 alerts in the public repository's initial CodeQL
inventory. It records remediation and trust-boundary evidence, not a promise
that all alerts automatically disappear or that the application has no bugs.
No scan exclusions or blanket alert dismissals were introduced.

## Domain evidence

- [Path boundaries, alerts 14–141](PATH_INJECTION_REVIEW.md)
- [Logging and exception boundaries, alerts 142–156 and 191–322](CODEQL_LOGGING_REVIEW.md)
- [Frontend, alerts 1–12](SECURITY_FRONTEND_REVIEW.md)

## Remaining rule families

| Alerts | Evidence and action |
| --- | --- |
| 13, 189, 190 | Model discovery intentionally supports administrator-selected local/private gateways. `settings.fetch_models_from_provider` checks administrator status before the provider call; a new test verifies ordinary users cannot trigger a request. Both cloud and local discovery now explicitly disable redirects, with regression tests for all three request paths. This does not impose a public-address-only policy on an intentional administrative integration. |
| 157–160 | Speech Markdown patterns could repeatedly scan unterminated links and markup. Opening delimiters are excluded from inner spans; emphasis spans do not consume their own delimiters. Adversarial text and existing speech conversion tests pass. |
| 161 | Memory JSON fence extraction rescanned whitespace suffixes. Replaced the trailing regex with `endswith`, slicing, and `rstrip`; regression reproduces the original delay and passes after the fix. |
| 162, 163 | Removed overlapping whitespace quantifiers around Manim image block contents. In addition, the public renderer fails readiness before parsing or writing generated code. Manim remains disabled. |
| 164–166 | Frontmatter's opening whitespace matcher consumed newlines and retried the remainder repeatedly. Limited it to horizontal whitespace. Unterminated 60,000-character samples that took seconds now complete within the regression deadline. |
| 167–171 | Removed MCP secret/owner identifiers and Codex credential-store paths from the affected log messages in the earlier hardening commit. |
| 172 | The live-model test helper exposed short secrets in full and prefixes of longer ones. It now prints only configured/empty status; a regression covers both lengths. |
| 173 | MinerU model download is an administrator-only settings action. The resolver chooses the fixed `mineru-models-download` basename beside the explicitly configured CLI, or that fixed command on PATH. The launch uses an argument array, `shell=False`, and enumerated source/model arguments. This is an intentional trusted-admin executable configuration, not shell interpolation. |
| 174 | Removed host Manim subprocess execution, not merely a UI toggle. Public readiness and direct execution reject use even if Manim is installed. Tests assert rejection before source-file writes and subprocess execution. |
| 175 | The runner's `/exec` endpoint intentionally executes commands inside a separate sandbox container. Authentication is checked before parsing/execution; an empty token denies access. The supplied Docker configuration uses a non-root runner, dropped capabilities, no-new-privileges, and read-only root filesystem. Do not run this server on the application host or publish its port as a general-purpose service. Existing authentication, request-shape, quota and argv tests exercise the boundary. |
| 176, 177 | SHA-256 values are in-memory provider/client cache identities, not password verifiers or persisted credential hashes. No password-based authentication decision is made from them. The actual API key remains required by the provider. No weakening or scanner suppression was added. |
| 178–180 | WeChat media encryption/decryption, upload and download are disabled. The old AES-ECB implementation and plaintext fallback were removed. Text messages remain supported; tests cover direct calls and text-plus-attachment delivery. |
| 181 | Provider recognition now compares parsed hostnames exactly, rather than URL substrings; spoofed host/path/userinfo tests pass. |
| 182–188 | These locations are test assertions: exact list membership for CORS origins and trusted host defaults, plus a literal generated-source containment assertion in a launcher test. They do not implement runtime URL allowlisting. |

## Release limits

The prior CLI process-timeout failure was a test observation race; the test now
records the actual subprocess instead of requiring a PID file before a 50 ms
timeout. The settings default-capability browser failure was an incomplete
admin settings fixture missing its catalog, not a product authorization bypass.
The fixture now includes the catalog and always closes its browser.

See [SECURITY.md](SECURITY.md) for unresolved optional/development dependency
advisories and deployment restrictions. Manim, WeChat media, and GraphRAG are
not accepted as available features. Existing private data and manually modified
indexes are outside the clean public snapshot and are not silently migrated.

Final release acceptance still requires the merged public `main` commit's full
CI result and review of its updated CodeQL inventory. A successful analyzer job
means the scan executed; it is not equivalent to zero findings.
