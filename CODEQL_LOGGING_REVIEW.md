# Logging and exception boundary review

Scope: the public release snapshot, CodeQL alert inventory retrieved on 2026-10-16,
132 `py/log-injection` alerts (#191–322) and 15 `py/stack-trace-exposure`
alerts (#142–156). This is source review and regression testing, not a fresh
CodeQL result or a dismissal record. No alerts were dismissed.

## Findings and changes

The log-injection findings share the application logging pipeline. Their source
modules use stdlib loggers under `cognivoy`; agent loggers are created in
`BaseAgent`. The CLI and API initialize `configure_logging`, whose console
handler uses `ConsoleFormatter` and rotating file handler uses `JsonlFormatter`.
The console formatter now escapes control characters in the entire final record,
including logger name and context, preventing newline and terminal-control
injection (CWE-117, medium). JSON serialization already escapes CR/LF and terminal
controls; explicit Unicode line-separator escaping also protects line-oriented
readers. Structured process events are JSON-encoded by the SSE transports, so
message newlines cannot introduce another SSE frame.

This mitigation covers configured application sinks, not arbitrary handlers an SDK
host installs, raw stdout/stderr writes, or unsafe downstream rendering of decoded
JSON. The library does not automatically configure a host's logging. CodeQL may
continue flagging call sites if it does not model final formatter sanitization;
rerun and inspect results before resolving individual alerts.

| Alert | Reviewed boundary and disposition |
| --- | --- |
| #142 | Co-writer SSE forwarded `str(exc)` and server-error HTTP details. Replaced unexpected/server errors with a generic message; server logging retains diagnostics. |
| #143 | Knowledge health returned `traceback.format_exc()` and `str(e)` directly. Removed both from the response, with server-only diagnostic logging. |
| #144 | Memory SSE relays `RunManager` event payloads. Unexpected runner errors were stored and emitted verbatim. Both stored error and error event now use a generic message; diagnostics are marked server-only. Existing historical run files are not rewritten. |
| #145 | Notebook summary SSE forwarded `str(exc)`. Replaced with generic failure and existing server error logging. |
| #146 | Partner creation already returns the fixed `Partner created but failed to start` message; `logger.exception` is server logging, not a returned traceback. No additional change to this branch. |
| #147 | Partner chat SSE forwarded the exception string via its error holder. Replaced with generic failure and server-only diagnostic logging. |
| #148 | Playground error helper emits its supplied message. Reviewed `ManimRenderError` constructors: fixed validation messages or a controlled artifact suffix, rather than arbitrary caught exception text. Unexpected execution errors use fixed messages. No demonstrated leak at this helper; retain pending CodeQL dataflow confirmation. |
| #149 | Confirmed raw stdout/stderr were forwarded to SSE, including any concurrent request's output because redirection is process-global. Also `services/embedding/client.py` and RAG pipelines log formatted tracebacks inside error messages, which structured capture could forward. Removed raw stream redirection and replaced warning/error/critical process-log messages with a fixed public status. Normal structured progress and status events remain intact; original diagnostics stay in server logs. Also sanitized partner startup HTTP 5xx details in the capability branch. |
| #150, #151 | Parser install/model-download launch returns a subprocess creation error. Replaced raw exception with generic failure. |
| #152 | Parser job status returns the stored launch error. It now stores the generic launch message. |
| #153 | Parser cancellation returned the termination exception. Replaced with generic failure. |
| #154 | MinerU model launch returns an exception. Replaced with generic failure, including subsequent status; also fixed analogous cancellation. |
| #155 | System dependency helpers returned unexpected exception strings. Replaced with generic status errors and server-only diagnostics. |
| #156 | System status returned LLM, embedding, and search configuration exceptions. Replaced exception-derived fields with generic status errors. |

Confirmed exception-response leaks are medium severity (CWE-209/CWE-497). Their
impact depends on what providers, filesystem operations, or subprocess APIs put
in an exception. Tests inject a synthetic credential and private path into those
errors and verify that responses, streams, and run history do not return them.

## Validation and limits

The final combined suite passed 99 tests across logging, exception boundaries,
memory runs, MinerU models, system status, notebook, co-writer, and plugin
availability/partner APIs. Logging tests include message/context control injection
and JSON record boundaries. The playground regression verifies raw output remains in the
server stream, traceback-like error logs stay out of SSE, and structured progress
is retained. Ruff checks passed using the cached executable; modified formatting
was applied with Ruff.

Server JSONL exception fields remain available to operators; no HTTP route
serving that JSONL file was established in this review. They are not classified
as client disclosure merely because they contain tracebacks. Admin-only parser
job status intentionally returns subprocess output lines; this patch addresses
its Python launch/cancel exceptions, not arbitrary subprocess output. System
connection-test endpoints and other exception flows outside these alert locations
require separate review; this report does not assert that every application error
boundary is now safe.
