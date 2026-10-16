"""Strict optional-capability acceptance; network generation is explicit and billable.

Run from the source root: ``python -m scripts.verify_optional_capabilities``.
Preflight alone never exits with an acceptance pass. ``--live`` uses synthetic
test content only; it does not read or transmit personal documents or recordings.
"""

from __future__ import annotations

import argparse
import asyncio
import io
import json
import shutil
import subprocess
from tempfile import NamedTemporaryFile
from typing import Any

from cognivoy.agents.math_animator.availability import get_math_animator_readiness
from cognivoy.services.optional_readiness import MEDIA_SERVICES, get_media_readiness

SERVICES = ("manim", *MEDIA_SERVICES)
SPEECH_SAMPLE = "Learning begins with curiosity."


def _check_media(data: bytes, kind: str) -> dict[str, Any]:
    if not data:
        raise ValueError("Empty generated media")
    if kind == "image":
        from PIL import Image

        with Image.open(io.BytesIO(data)) as image:
            image.verify()
        return {"bytes": len(data)}
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        raise RuntimeError("Install FFmpeg/ffprobe for decoded-media acceptance")
    with NamedTemporaryFile(suffix=".media") as artifact:
        artifact.write(data)
        artifact.flush()
        probe = subprocess.run(
            [
                ffprobe,
                "-v",
                "error",
                "-count_frames",
                "-show_entries",
                "stream=codec_type,nb_read_frames",
                "-of",
                "json",
                artifact.name,
            ],
            check=True,
            capture_output=True,
            timeout=30,
        )
    streams = json.loads(probe.stdout).get("streams", [])
    if not any(
        stream.get("codec_type") == kind
        and str(stream.get("nb_read_frames", "")).isdigit()
        and int(stream["nb_read_frames"]) > 0
        for stream in streams
    ):
        raise ValueError("Generated media has no decodable frames in the expected stream")
    return {"bytes": len(data), "stream_type": kind}


async def _run_live(
    name: str, speech: tuple[bytes, str] | None
) -> tuple[dict[str, Any], tuple[bytes, str] | None]:
    if name == "manim":
        from scripts.verify_math_animator_runtime import _verify

        return await _verify(), speech
    if name == "tts":
        from cognivoy.services.voice import synthesize_speech

        speech = await synthesize_speech(SPEECH_SAMPLE, response_format="wav")
        return _check_media(speech[0], "audio"), speech
    if name == "stt":
        from cognivoy.services.voice import transcribe_audio

        if speech is None:
            raise RuntimeError("A successful TTS sample is required for STT round-trip acceptance")
        transcript = await transcribe_audio(
            speech[0], filename="acceptance.wav", content_type=speech[1], language="en"
        )
        if not all(word in transcript.lower() for word in ("learning", "curiosity")):
            raise ValueError("Transcript did not recover the known synthetic speech sample")
        return {"transcript_matched": True}, speech
    if name == "imagegen":
        from cognivoy.services.imagegen import generate_image

        images = await generate_image("A simple blue circle on a white background.", n=1)
        if len(images) != 1:
            raise ValueError("Expected exactly one generated image")
        return _check_media(images[0][0], "image"), speech
    from cognivoy.services.videogen import generate_video

    video = await generate_video(
        "A blue circle moving slowly across a white background.", duration="5"
    )
    return _check_media(video[0], "video"), speech


async def verify(*, live: bool = False, services: tuple[str, ...] = SERVICES) -> dict[str, Any]:
    unknown = set(services) - set(SERVICES)
    if unknown or not services:
        raise ValueError("Select at least one supported service")
    readiness = get_media_readiness()
    if "manim" in services:
        manim = await asyncio.to_thread(get_math_animator_readiness)
        readiness["manim"] = {
            "status": "configured" if manim.available else "unavailable",
            "missing_dependencies": list(manim.missing_dependencies),
            "install_hint": manim.install_hint,
        }
    rows: dict[str, Any] = {}
    speech = None
    # TTS precedes STT even if CLI flags were supplied in another order.
    for name in SERVICES:
        if name not in services:
            continue
        preflight = readiness[name]
        if preflight["status"] != "configured":
            rows[name] = {"status": "blocked", "preflight": preflight}
        elif name == "stt" and "tts" not in services:
            rows[name] = {
                "status": "blocked",
                "reason": "Include tts to create a synthetic STT input sample.",
            }
        elif not live:
            rows[name] = {"status": "not_verified", "preflight": preflight}
        else:
            try:
                evidence, speech = await asyncio.wait_for(_run_live(name, speech), timeout=900)
                rows[name] = {"status": "passed", "evidence": evidence}
            except Exception as exc:
                # A provider exception can include URLs, tokens or response bodies.
                # Keep the public acceptance report content-free and secret-free.
                rows[name] = {"status": "failed", "error_type": type(exc).__name__}
    passed = all(row["status"] == "passed" for row in rows.values())
    return {"status": "passed" if passed else "incomplete", "live": live, "services": rows}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--live",
        action="store_true",
        help="Allow synthetic requests to configured providers; may incur charges.",
    )
    parser.add_argument("--services", nargs="+", choices=SERVICES, default=list(SERVICES))
    args = parser.parse_args()
    report = asyncio.run(verify(live=args.live, services=tuple(args.services)))
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["status"] == "passed" else 2


if __name__ == "__main__":
    raise SystemExit(main())
