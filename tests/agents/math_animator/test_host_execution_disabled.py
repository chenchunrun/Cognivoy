import pytest

from cognivoy.agents.math_animator.availability import require_math_animator_ready
from cognivoy.agents.math_animator.renderer import ManimRenderService


def test_readiness_blocks_host_execution():
    with pytest.raises(RuntimeError, match="isolated"):
        require_math_animator_ready()


@pytest.mark.asyncio
async def test_direct_image_entry_blocks_before_parsing(tmp_path):
    renderer = object.__new__(ManimRenderService)
    renderer.source_dir = tmp_path
    with pytest.raises(RuntimeError, match="isolated"):
        await renderer._render_image_blocks(
            code="invalid code", quality="low", width=None, height=None, fps=None
        )
    assert list(tmp_path.iterdir()) == []


@pytest.mark.asyncio
async def test_render_rejects_before_writing_source(tmp_path):
    renderer = object.__new__(ManimRenderService)
    renderer.source_dir = tmp_path
    renderer.progress_callback = None
    with pytest.raises(RuntimeError, match="isolated"):
        await renderer.render(code="raise AssertionError()", output_mode="image", quality="low")
    assert list(tmp_path.iterdir()) == []


@pytest.mark.asyncio
async def test_direct_process_entry_is_disabled(tmp_path):
    renderer = object.__new__(ManimRenderService)
    renderer.media_dir = tmp_path
    renderer.progress_callback = None
    with pytest.raises(RuntimeError, match="isolated"):
        await renderer._run_manim(
            code_path=tmp_path / "nonexistent.py",
            scene_name="Scene",
            quality="low",
            save_last_frame=False,
            width=None,
            height=None,
            fps=None,
        )
