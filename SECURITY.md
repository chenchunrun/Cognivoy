# Security Policy

## Supported versions

Security fixes are provided for the latest Cognivoy release on the `1.5.x`
line and for the current `main` branch. Older releases may receive a fix only
when the maintainer determines that a backport is practical.

| Version | Supported |
| --- | --- |
| Latest `1.5.x` release | Yes |
| Current `main` | Yes |
| Earlier releases | No |

## Reporting a vulnerability

Use GitHub's private vulnerability reporting feature for this repository. If
that option is not visible, email **chenchunrun@live.com** with the subject
`Cognivoy security report`. Do not open a public issue or include credentials,
personal data, access tokens, or working exploit payloads in public discussions.

Include the affected version or commit, deployment mode, impact, reproduction
conditions, and any suggested remediation. You should receive an acknowledgement
within 3 business days and an initial assessment within 7 business days. Timing
for a fix and coordinated disclosure depends on severity and upstream
dependencies.

## Dependency audit exceptions

The release dependency set is audited with `pip-audit`. The following known
findings are temporarily accepted only with the stated constraints and
compensating controls. New findings fail CI.

### Default dependency remediation (2026-10-16)

The 26 advisories found in the previous default lockfile were addressed by
upgrading `multidict` to 6.9.1, `PyJWT` to 2.15.1, `pypdf` to 6.20.1, and
`urllib3` to 2.8.0. Install manifests enforce these minimum versions; multidict
stays on its compatible 6.x line. An unfiltered `pip-audit` of the updated
default, non-development lockfile export reports no known vulnerabilities.
This is a point-in-time database result, not a guarantee that no vulnerabilities
exist. Optional integrations have a separate risk boundary described below.

CI audits both the default lockfile export and freshly resolved server
requirements without advisory exemptions. The lockfile export uses `--locked`
to reject stale metadata. Regression tests enforce the version floors and
verify valid authentication plus rejection of expired, incorrectly signed and
unsigned tokens. CI results must still be checked after pushing.

### Optional and development dependencies (2026-10-16 review)

GraphRAG is temporarily disabled, including its installation extra, because its
compatible release pins vulnerable LiteLLM and newer releases conflict with the
supported parser dependency set. The lockfile no longer contains GraphRAG or
LiteLLM. Existing environments must be recreated to remove old installations;
the runtime guard is not a package uninstaller.

Local LlamaIndex vector/hybrid retrieval and Docling parsing are temporarily
disabled, including installation extras and runtime entry points. The standard
lockfile no longer contains NLTK, Accelerate, LlamaIndex, or Docling. Keyword
retrieval remains available and existing knowledge-base data is preserved.
See [local engine availability](OPTIONAL_CAPABILITIES.md#local-engine-availability). Recreate
existing environments to remove previously installed optional packages.

The web production audit reports no findings, while development tooling retains
the unpatched Braces advisory described in [the frontend review](SECURITY_FRONTEND_REVIEW.md).
Only trusted repository glob configuration may be used for builds; keep build
workers isolated and do not expose these glob parsers to application input.

### Starlette: patched dependency required

As of 2026-09-08, the supported server dependency set requires FastAPI
`>=0.141.1` and Starlette `>=1.3.1,<2.0.0`. The compatible FastAPI release no
longer imposes the old Starlette 0.52 ceiling. The five Starlette audit
exceptions have been removed; the following application-level controls remain
as defense in depth:

- `PYSEC-2026-161` and `PYSEC-2026-248`: Cognivoy's outermost ASGI middleware
  validates the raw path and Host header before Starlette reconstructs a URL.
  Security decisions and access metrics use `scope["path"]`, not
  `request.url.path`.
- `PYSEC-2026-249`: the same middleware rejects URL-encoded bodies over 1 MiB,
  including chunked bodies whose declared length is absent or false.
- `PYSEC-2026-2280`: Cognivoy registers FastAPI route functions and does not
  register Starlette `HTTPEndpoint` subclasses.
- `PYSEC-2026-2281`: Cognivoy does not mount Starlette `StaticFiles`; generated
  outputs are served by authenticated, path-validated API handlers.

The controls live in `cognivoy/api/security_middleware.py` and are covered by
`tests/api/test_request_security_middleware.py` and
`tests/api/test_starlette_advisory_mitigations.py`. Starlette's
[upstream form-parser advisory](https://github.com/Kludex/starlette/security/advisories/GHSA-82w8-qh3p-5jfq)
identifies 1.3.1 as the fixed version; the earlier URL, method-dispatch, and
Windows StaticFiles advisories are fixed by earlier 1.x releases.

### NLTK 3.10.3 (`PYSEC-2026-3740`)

Reviewed again on 2026-10-16: the
[upstream advisory](https://github.com/nltk/nltk/security/advisories/GHSA-8mgp-746c-j5xp)
still lists no patched version. The default full-app and CLI dependency sets
no longer include LlamaIndex or NLTK, and the default server audit has no NLTK
exception. The `rag-llamaindex` compatibility extra is empty, and local
vector/hybrid retrieval is disabled even when old dependencies remain installed.
GraphRAG is disabled.

PyPI still lists 3.10.3 as the latest NLTK release. LlamaIndex core
0.14.25 still requires `nltk>=3.9.3`; upgrading LlamaIndex alone does not
remove this dependency. NLTK, GraphRAG and TextBlob have been removed from the
current lockfile. Keyword document loading,
indexing and historical JSON text-store reading do not import LlamaIndex.
Use a fresh environment for a default-only installation: upgrading an existing
environment does not remove previously installed optional packages.

NLTK is a transitive dependency of optional LlamaIndex. The advisory affects
model-artifact APIs that accept caller-controlled filesystem paths. Cognivoy does
not call NLTK directly and does not expose those model import/export APIs. Treat
NLTK model paths as untrusted nevertheless: do not add an NLTK model loader or
trainer to a Web, tool, parser, sandbox, or knowledge-base path until a patched
NLTK version is available or an explicit containment control and regression test
are added.

`tests/security/test_nltk_advisory_boundary.py` rejects direct NLTK imports and
literal dynamic/plugin imports in product code. Keyword retrieval uses its own
model-free tokenizer; it does not use NLTK model import/export or downloads.
This guard protects the application integration boundary, not arbitrary Python
programs or a third-party dependency's entire API. Do not treat NLTK `pathsec`
as Cognivoy's code-execution sandbox. Audit existing installations separately;
packages installed before this change may remain until the environment is recreated.

The local `rag-lightrag` extra remains disabled because its RAG-Anything/MinerU
dependency chain requires vulnerable Transformers and Gradio versions. Use the
isolated `lightrag-server` integration until the upstream chain accepts patched
releases.
