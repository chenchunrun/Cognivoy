"""Authoritative runtime readiness checks for Manim-backed capabilities."""

from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path


@dataclass(frozen=True, slots=True)
class MathAnimatorReadiness:
    available: bool
    missing_dependencies: tuple[str, ...]
    install_hint: str


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
    """Fail closed until an isolated renderer is implemented.

    Installing host dependencies must never enable generated Python execution.
    """
    return MathAnimatorReadiness(
        False,
        ("isolated-renderer",),
        "Host execution is disabled for security. An isolated Manim renderer is "
        "not yet available. Use SVG, Mermaid, or chart visualization instead.",
    )


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
