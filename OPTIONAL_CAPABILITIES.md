# Optional capability deployment and acceptance

Core learning and chat do not require a local model server, Manim, or media-generation providers. Optional capabilities are still product features: missing dependencies or credentials are **blocked**, not a successful full-feature acceptance. Do not label a deployment as fully verified until its selected features pass real artifact tests.

For knowledge bases without an embedding service, see [model-free keyword/BM25 retrieval](MODEL_FREE_RETRIEVAL.md). This avoids an Ollama dependency for text retrieval, but does not remove language-model, OCR, or media-provider requirements from features that use them.

## Math Animator

**Temporarily disabled for security.** Model-generated Python must not execute
in the application host process. Math Animator and Manim-backed visualization
are unavailable until an isolated renderer with resource and filesystem
boundaries is implemented. Installing Manim or its system dependencies does
not enable rendering; there is no host-execution opt-in.

SVG, Mermaid, Chart.js, and HTML visualization do not use this Manim execution
path and remain available. The readiness endpoint reports `isolated-renderer`
as missing. Manim acceptance checks remain blocked, not passed.

## Hosted voice, image and video services

Configure separate active provider profiles and active models in these pages:

| Feature | Settings path | Required live proof |
| --- | --- | --- |
| Text to speech | `/settings/tts` | Decodable generated audio |
| Speech to text | `/settings/stt` | Known spoken words recovered from audio |
| Image generation | `/settings/image` | Downloaded image passes image decoding |
| Video generation | `/settings/video` | Finished task produces a playable video stream |

Use a hosted provider supported by the corresponding Settings page. An LLM credential is not automatically a voice/image/video credential: the provider must enable the chosen model, endpoint and billing entitlement. Do not copy a Codex/OAuth login into an API-key field. Never commit credentials; the source of truth is the local `data/user/settings/model_catalog.json` managed by Settings. No local model server is required for these hosted profiles.

`/settings/status` and `GET /api/v1/system/dependencies` run **configuration-only** checks, with no billable requests. They distinguish missing profiles, active models, endpoints and credentials. `configured` is not a claim of provider connectivity or a successfully generated artifact. Custom keyless gateways are permitted, but require the same real acceptance tests.

## Strict real-provider acceptance

```sh
# No network generation. Exits 2 while any selected feature is unverified.
.venv/bin/python -m scripts.verify_optional_capabilities

# Uses synthetic content; provider requests may incur charges.
.venv/bin/python -m scripts.verify_optional_capabilities --live

# Test a declared deployment subset, not an implicit full-feature pass.
.venv/bin/python -m scripts.verify_optional_capabilities --live --services manim
.venv/bin/python -m scripts.verify_optional_capabilities --live --services tts stt
```

The script exits 0 only when **all requested capabilities produce validated artifacts**. Missing configuration, provider failure, timeout or a merely completed connection probe cannot pass. STT uses only the synthetic TTS phrase generated in the same run; no personal recording is uploaded. Image/audio/video payloads are validated without publishing them. FFprobe must be available for audio/video acceptance. A video task ID alone is not completion: the script waits for and validates its output. Record the selected service list in the release report, and do not promote a subset pass to full-feature acceptance.

The script proves the service/artifact boundary. Release sign-off must additionally confirm playback, microphone input and attachment rendering in a browser on the deployed URL; deterministic mocked browser tests cannot substitute for these real-provider checks.
