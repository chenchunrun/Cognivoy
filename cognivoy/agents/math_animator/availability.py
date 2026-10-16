"""Authoritative runtime readiness checks for Manim-backed capabilities."""

from __future__ import annotations

from dataclasses import dataclass
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess


@dataclass(frozen=True, slots=True)
class MathAnimatorReadiness:
    available: bool
    missing_dependencies: tuple[str, ...]
    install_hint: str


_COMMANDS: tuple[tuple[str, str, str], ...] = (
    ("ffmpeg", "ffmpeg", "-version"),
    ("ffprobe", "ffprobe", "-version"),
    ("latex", "LaTeX", "--version"),
    ("dvisvgm", "dvisvgm", "--version"),
)

_MACOS_TEX_BIN = Path("/Library/TeX/texbin")


def math_animator_subprocess_env() -> dict[str, str]:
    """Return an environment where macOS and Homebrew TeX installs interoperate."""

    env = os.environ.copy()
    if _MACOS_TEX_BIN.is_dir():
        path_parts = env.get("PATH", "").split(os.pathsep)
        tex_bin = str(_MACOS_TEX_BIN)
        if tex_bin not in path_parts:
            env["PATH"] = os.pathsep.join([tex_bin, *path_parts])

    # Homebrew packages texlive and dvisvgm independently. dvisvgm therefore
    # cannot infer texlive's kpathsea root from its own Cellar location. Point
    # both programs at the active opt symlink so MathTex can resolve map and
    # PostScript prologue files without shell-specific startup configuration.
    brew_texlive = Path("/opt/homebrew/opt/texlive/share")
    texmf_dist = brew_texlive / "texmf-dist"
    if texmf_dist.is_dir():
        env.setdefault("TEXMFROOT", str(brew_texlive))
        env.setdefault("TEXMFDIST", str(texmf_dist))
        env.setdefault("TEXMFCNF", str(texmf_dist / "web2c"))
    return env


def get_math_animator_readiness() -> MathAnimatorReadiness:
    """Check every runtime needed by generated mathematical scenes.

    Importing :mod:`manim` alone is insufficient: ``MathTex`` fails later if
    LaTeX/dvisvgm are missing, and video/review fails without FFmpeg tools.
    Keeping this check in one module makes the Web catalog, SDK, WebSocket
    runtime, visualize route, and book animation agree on availability.
    """

    missing: list[str] = []
    if importlib.util.find_spec("manim") is None:
        missing.append("manim")
    runtime_path = math_animator_subprocess_env().get("PATH")
    for command, label, version_arg in _COMMANDS:
        resolved = shutil.which(command, path=runtime_path)
        if resolved is None or not _command_starts(resolved, version_arg):
            missing.append(label)

    if not missing:
        return MathAnimatorReadiness(True, (), "")

    python_hint = (
        "Install Python support with `pip install -e '.[math-animator]'`. "
        if "manim" in missing
        else ""
    )
    system_hint = (
        "Install FFmpeg and a LaTeX distribution that provides `latex` and "
        "`dvisvgm` (macOS: `brew install ffmpeg` and "
        "`brew install --cask mactex-no-gui`; Debian/Ubuntu: "
        "`apt install ffmpeg texlive-latex-extra texlive-fonts-extra dvisvgm`)."
    )
    return MathAnimatorReadiness(
        False,
        tuple(missing),
        f"Missing runtime dependencies: {', '.join(missing)}. {python_hint}{system_hint}",
    )


def _command_starts(command: str, version_arg: str) -> bool:
    """Reject present-but-broken binaries (for example stale dylib links)."""

    try:
        completed = subprocess.run(
            [command, version_arg],
            env=math_animator_subprocess_env(),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return completed.returncode == 0


def require_math_animator_ready() -> None:
    readiness = get_math_animator_readiness()
    if not readiness.available:
        raise RuntimeError(f"Math Animator is unavailable. {readiness.install_hint}")


__all__ = [
    "MathAnimatorReadiness",
    "get_math_animator_readiness",
    "math_animator_subprocess_env",
    "require_math_animator_ready",
]
