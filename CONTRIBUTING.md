# Contributing to Cognivoy

Thank you for helping improve Cognivoy. Contributions of code, tests,
documentation, translations, bug reports, and design feedback are welcome.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
For usage questions, see [SUPPORT.md](SUPPORT.md). Report vulnerabilities using
the private process in [SECURITY.md](SECURITY.md), never in a public issue.

## Project governance

Cognivoy currently uses a maintainer-led model. The project maintainer is
[@chenchunrun](https://github.com/chenchunrun). Decision making and the path to
maintainership are described in [GOVERNANCE.md](GOVERNANCE.md).

## Find or propose work

- Browse [Cognivoy issues](https://github.com/chenchunrun/Cognivoy/issues).
- Open a focused issue before starting a large feature or architectural change.
- Keep security-sensitive details out of issues and discussions.
- Upstream DeepTutor issues are useful historical context, but Cognivoy work is
  planned and reviewed in this repository.

## Development setup

Use Python 3.11–3.13 and Node.js 22 to match the supported release and CI
environment.

```bash
git clone https://github.com/chenchunrun/Cognivoy.git
cd Cognivoy

python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -e ".[dev]"

cd web
npm ci --legacy-peer-deps
cd ..
```

Copy `.env.example` only as a reference. Runtime settings belong under
`data/user/settings/`; never commit API keys, credentials, user data, knowledge
bases, generated outputs, or local `.env` files.

## Branches and pull requests

The public repository uses `main` as its default integration branch. Create a
short-lived branch from the latest `main` and open the pull request back to
`main`.

```bash
git switch main
git pull --ff-only origin main
git switch -c feature/short-description
```

Use `fix/`, `docs/`, `test/`, or `refactor/` when one of those prefixes is more
accurate. Keep pull requests focused and explain:

- the user-visible problem and intended behavior;
- the important implementation choices;
- tests performed and any known limitations;
- documentation, migration, security, or compatibility impact.

Add or update tests for behavior changes. Avoid drive-by formatting or unrelated
refactors in the same pull request.

## Required checks

Run the checks relevant to your change before opening a pull request. The full
baseline is:

```bash
uvx --from ruff==0.16.0 ruff check .
uvx --from ruff==0.16.0 ruff format --check .
pytest -q tests cognivoy/learning/tests

cd web
npm run test:node
node scripts/i18n-extract.cjs --check
npm run i18n:check
```

For security-sensitive backend changes, also run:

```bash
bandit -c pyproject.toml -r cognivoy cognivoy_cli
gitleaks detect --source . --redact
```

CI is the source of truth. A pull request is not ready to merge until all
required checks pass.

## Coding conventions

- Python uses Ruff formatting with a 100-character line length.
- Frontend code follows the conventions in `AGENTS.md`, including CSS-variable
  color tokens and SSR-safe theme/language state.
- Public behavior should be covered by tests and documented in the README or the
  nearest feature documentation.
- User-facing Web strings must be added to both English and Chinese locale files.
- Preserve upstream attribution and update legal notices when incorporating or
  adapting third-party code or assets; follow [ASSET_POLICY.md](ASSET_POLICY.md).

## Commit messages

Prefer concise conventional subjects such as:

```text
feat(chat): add source-level citation controls
fix(kb): reject traversal in uploaded archive names
docs: clarify local installation
```

## License of contributions

Unless explicitly stated otherwise, contributions submitted to this repository
are provided under the project's [Apache License 2.0](LICENSE). You must have the
right to submit every code, text, image, dataset, or other asset included in your
contribution. Identify copied or adapted material and preserve all required
copyright and attribution notices.
