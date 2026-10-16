import importlib.util
from pathlib import Path
import sys


def _load_module():
    module_path = Path(__file__).resolve().parents[2] / "scripts" / "prepare_web_package.py"
    spec = importlib.util.spec_from_file_location("prepare_web_package_under_test", module_path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    try:
        spec.loader.exec_module(module)
        return module
    finally:
        sys.modules.pop(spec.name, None)


def test_scrub_build_paths_removes_build_machine_identity(tmp_path: Path) -> None:
    module = _load_module()
    source_root = tmp_path / "user" / "DeepTutor"
    package_dir = tmp_path / "package"
    package_dir.mkdir()
    generated = package_dir / "server.js"
    generated.write_bytes(f'const root = "{source_root}/web";'.encode("utf-8") + b"\x00binary-safe")

    module._scrub_build_paths(package_dir, source_root=source_root)

    content = generated.read_bytes()
    assert str(source_root).encode() not in content
    assert b"/opt/cognivoy-src/web" in content
    assert content.endswith(b"\x00binary-safe")
