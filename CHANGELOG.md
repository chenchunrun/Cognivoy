# Changelog

All notable changes to the independent Cognivoy distribution will be recorded in
this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and releases use semantic versioning where practical.

## [Unreleased]

### Added

- Model-free BM25 knowledge retrieval, with English/Chinese tokenization, text
  index lifecycle support, and a Web setting. Existing LlamaIndex text stores
  remain usable without Ollama or an embedding API; vector indexes are retained.
- Strict optional-media readiness and live artifact verification commands.

### Changed

- New and invalid LlamaIndex retrieval configurations default to keyword mode;
  existing explicitly selected hybrid/vector configurations are preserved.
- Require compatible FastAPI and patched Starlette releases. Default installs
  exclude NLTK; vector retrieval is an optional extra with documented risks.
- Upgrade PyJWT, pypdf, multidict and urllib3 to reviewed patched versions and
  audit both locked and freshly resolved default dependencies without exemptions.
- Publish a reviewed source snapshot without private development history,
  historical frontend copies or development screenshots.
- Prepared repository documentation, governance, security automation, package
  metadata, and release checks for the first public Cognivoy release.
- Replaced upstream community and placeholder repository links with Cognivoy
  project links.

### Fixed

- Exclude fenced reasoning drafts from visualization artifacts and reject
  incomplete or head/style-only HTML. Keep the native DeepSeek Flash alias
  on the existing non-thinking default unless an effort is explicitly chosen.
- Recover malformed visualization analysis replies using the original request
  before generating a real artifact; classify analysis failures safely and
  reject invalid cached briefs. Preserve JSON mode for the native DeepSeek
  Flash endpoint instead of silently dropping its structured-output request.
- Collect visualization code with separate first-output, idle, and total time
  limits; retry once with a simpler layout. Failed or invalid generations no
  longer become successful placeholder pages or reusable checkpoints. Legacy
  fallback pages show an explicit failure and a user-controlled retry.
- Distinguish empty chat/learning/quiz answers and unverified solve results from
  successful output. Retry only unfinished quiz items, and close model streams
  and parallel quiz tasks when their turn is cancelled.
- Give ordinary chat bounded, progress-aware exploration headroom, with live
  round counters separate from context tokens and configurable extra rounds.
  Preserve hard capability caps and reserve time/usage for finalization.
- Queue short sandbox concurrency bursts within existing per-user limits;
  recover transient web fetch failures within bounded retry/time limits; return
  readable, continuable GitHub file and directory results instead of clipped JSON.
- Keep streamed answers anchored before paint within the chat scrollport,
  including asynchronous content resizing, while preserving manual scrollback
  and the reading position when loading older messages.
- Make notebooks directly discoverable in the sidebar and save dialog. Answers
  can create and select a notebook inline without losing the draft; list and
  creation failures expose retries, and notebook creation stays visible.
- Preserve retrieval/search failures instead of reporting false success or
  inventing citations, with bounded transient search recovery and aligned
  frontend/backend proxy timeouts.
- Persist research evidence and completed report sections for scoped checkpoint
  recovery. Partial, timed-out, and empty-section reports fail strict acceptance;
  quick writing avoids implicit high-thinking budgets where supported.
- Persist knowledge-base rebuild terminal progress with the correct task ID.

## 1.5.11 source baseline - 2026-08-10

First version used as the baseline for the independent Cognivoy public release
process. It has not been published as a Cognivoy GitHub or PyPI release. Earlier
`1.x` notes in the original DeepTutor project are upstream history and are not
Cognivoy release records.

[Unreleased]: https://github.com/chenchunrun/Cognivoy/commits/main
