from cognivoy.agents.math_animator.availability import get_math_animator_readiness


def test_readiness_requires_python_video_and_formula_runtimes(monkeypatch):
    monkeypatch.setattr(
        "cognivoy.agents.math_animator.availability.importlib.util.find_spec",
        lambda _name: object(),
    )
    monkeypatch.setattr(
        "cognivoy.agents.math_animator.availability.shutil.which",
        lambda command, **_kwargs: f"/usr/bin/{command}",
    )
    monkeypatch.setattr(
        "cognivoy.agents.math_animator.availability._command_starts",
        lambda _command, _version_arg: True,
    )
    assert get_math_animator_readiness().available is True


def test_readiness_names_every_missing_runtime(monkeypatch):
    monkeypatch.setattr(
        "cognivoy.agents.math_animator.availability.importlib.util.find_spec",
        lambda _name: None,
    )
    monkeypatch.setattr(
        "cognivoy.agents.math_animator.availability.shutil.which",
        lambda _command, **_kwargs: None,
    )
    readiness = get_math_animator_readiness()
    assert readiness.available is False
    assert readiness.missing_dependencies == (
        "manim",
        "ffmpeg",
        "ffprobe",
        "LaTeX",
        "dvisvgm",
    )


def test_readiness_rejects_present_but_broken_binary(monkeypatch):
    monkeypatch.setattr(
        "cognivoy.agents.math_animator.availability.importlib.util.find_spec",
        lambda _name: object(),
    )
    monkeypatch.setattr(
        "cognivoy.agents.math_animator.availability.shutil.which",
        lambda command, **_kwargs: f"/usr/bin/{command}",
    )
    monkeypatch.setattr(
        "cognivoy.agents.math_animator.availability._command_starts",
        lambda command, _version_arg: not command.endswith("ffprobe"),
    )
    readiness = get_math_animator_readiness()
    assert readiness.available is False
    assert readiness.missing_dependencies == ("ffprobe",)
