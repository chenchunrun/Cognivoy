# Optional capability deployment and acceptance

Core learning and chat do not require a local model server, Manim, or media-generation providers. Optional capabilities are still product features: missing dependencies or credentials are **blocked**, not a successful full-feature acceptance. Do not label a deployment as fully verified until its selected features pass real artifact tests.

For knowledge bases without an embedding service, see [model-free keyword/BM25 retrieval](MODEL_FREE_RETRIEVAL.md). This avoids an Ollama dependency for text retrieval, but does not remove language-model, OCR, or media-provider requirements from features that use them.

## Math Animator

Manim is a graphics renderer, not a local AI model. The existing remote language-model profile writes scenes; Manim renders them in the configured execution boundary. It does not require Ollama or model weights.

Install the source extra into the application's virtual environment (never a global Python):

```sh
uv pip install --python .venv/bin/python --dry-run -r requirements/math-animator.txt
uv pip install --python .venv/bin/python -r requirements/math-animator.txt
.venv/bin/python -m scripts.verify_math_animator_runtime
```

The host/container also needs Cairo/Pango, FFmpeg/ffprobe, LaTeX and dvisvgm. On Debian/Ubuntu, image maintainers can provision `build-essential pkg-config libcairo2-dev libpango1.0-dev ffmpeg texlive-latex-extra texlive-fonts-extra texlive-science dvisvgm`. Consult the [Manim installation guide](https://docs.manim.community/en/stable/installation/uv.html) for the operating system. Cognivoy additionally needs FFmpeg command-line tools for generated-video review. System installation is an operator action; the app does not install packages at runtime.

The default Docker image does not include this large optional toolchain. An animation-enabled image must add these system packages and `requirements/math-animator.txt` during its build, then run the smoke test **as the same non-root user that runs Cognivoy**, with a writable data directory. Passing `import manim` alone is not sufficient. The smoke test renders a real formula MP4 and extracts three non-empty review frames. Preserve its JSON result with the release evidence.

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
