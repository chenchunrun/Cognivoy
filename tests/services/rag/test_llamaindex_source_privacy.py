from cognivoy.services.rag.pipelines.llamaindex.pipeline import _public_source_name


def test_public_source_name_strips_posix_and_windows_directories() -> None:
    assert _public_source_name({"file_path": "/srv/cognivoy/private/lesson.pdf"}, "doc") == (
        "lesson.pdf"
    )
    assert _public_source_name({"file_path": r"C:\Users\alice\secret\notes.md"}, "doc") == (
        "notes.md"
    )


def test_public_source_name_prefers_sanitized_file_name() -> None:
    assert (
        _public_source_name(
            {"file_name": "chapter.pdf", "file_path": "/private/chapter.pdf"}, "doc"
        )
        == "chapter.pdf"
    )
