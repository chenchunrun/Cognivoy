import io
import json
import logging

import pytest

from cognivoy.logging.formatters import JsonlFormatter
from cognivoy.logging.safe_logger import get_logger


def test_sdk_host_plain_handler_cannot_receive_forged_records():
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(logging.Formatter("%(name)s %(message)s"))
    root = logging.getLogger()
    root.addHandler(handler)
    logger = get_logger("cognivoy.sdk.regression")
    old_level = logger.level
    logger.setLevel(logging.INFO)
    try:
        logger.info("user=%s", "student\nERROR forged\r\x1b[2J\u0085\u2028\u2029")
        assert len(stream.getvalue().splitlines()) == 1
        assert "\x1b" not in stream.getvalue()
        assert "student\\u000aERROR forged" in stream.getvalue()
    finally:
        root.removeHandler(handler)
        logger.setLevel(old_level)


def test_default_exception_formatter_keeps_diagnostics_without_injected_lines():
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    logger = get_logger("cognivoy.sdk.exception")
    logger.addHandler(handler)
    try:
        try:
            raise ValueError("private diagnostic\nERROR forged\x1b[2J")
        except ValueError:
            logger.exception("failed")
        output = stream.getvalue()
        # The standard formatter inserts one trusted separator before exc_text.
        assert len(output.splitlines()) == 2
        assert "ValueError: private diagnostic\\u000aERROR forged" in output
        assert "\x1b" not in output
    finally:
        logger.removeHandler(handler)


def test_json_exception_diagnostics_remain_available():
    records = []

    class Capture(logging.Handler):
        def emit(self, record):
            records.append(JsonlFormatter().format(record))

    handler = Capture()
    logger = get_logger("cognivoy.sdk.structured")
    logger.addHandler(handler)
    try:
        try:
            raise ValueError("diagnostic\nwith detail")
        except ValueError:
            logger.exception("failed %s", "name\nforged")
        assert len(records[0].splitlines()) == 1
        assert "ValueError: diagnostic\nwith detail" in json.loads(records[0])["exception"]
    finally:
        logger.removeHandler(handler)


def test_helper_does_not_change_host_factory_handlers_or_other_loggers():
    factory = logging.getLogRecordFactory()
    handlers = list(logging.getLogger().handlers)
    foreign = logging.getLogger("third_party.regression")
    filters = list(foreign.filters)
    first = get_logger("cognivoy.sdk.idempotent")
    count = len(first.filters)
    assert get_logger(first.name) is first
    assert len(first.filters) == count
    assert logging.getLogRecordFactory() is factory
    assert logging.getLogger().handlers == handlers
    assert foreign.filters == filters


def test_real_auth_service_sdk_call_uses_safe_logger(monkeypatch):
    from cognivoy.multi_user import identity
    from cognivoy.services import auth

    monkeypatch.setattr(identity, "delete_user", lambda username: True)
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    root = logging.getLogger()
    root.addHandler(handler)
    old_level = auth.logger.level
    auth.logger.setLevel(logging.INFO)
    try:
        assert auth.delete_user("sdk-user\nERROR forged\x1b[2J")
        assert len(stream.getvalue().splitlines()) == 1
        assert "sdk-user\\u000aERROR forged" in stream.getvalue()
    finally:
        root.removeHandler(handler)
        auth.logger.setLevel(old_level)


@pytest.mark.parametrize("via_pipeline", [False, True])
@pytest.mark.asyncio
async def test_keyword_ingestion_filename_is_safe_for_sdk_root_handler(
    tmp_path, monkeypatch, via_pipeline
):
    from cognivoy.services.rag.pipelines.llamaindex import pipeline
    from cognivoy.services.rag.pipelines.llamaindex.document_loader import LlamaIndexDocumentLoader

    monkeypatch.setattr(pipeline, "keyword_enabled", lambda: True)
    source = tmp_path / "notes\nERROR forged\x1b[2J.txt"
    source.write_text("Searchable learning material", encoding="utf-8")
    loader = (
        pipeline.LlamaIndexPipeline(kb_base_dir=str(tmp_path)).document_loader
        if via_pipeline
        else LlamaIndexDocumentLoader()
    )
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    root = logging.getLogger()
    root.addHandler(handler)
    old_level = loader.logger.level
    loader.logger.setLevel(logging.INFO)
    try:
        docs = await loader.load([str(source)], include_images=False)
        assert docs[0].text == "Searchable learning material"
        output = stream.getvalue()
        assert "Parsing text: notes\\u000aERROR forged\\u001b[2J.txt" in output
        assert "\x1b" not in output
        assert not any(line.startswith("ERROR forged") for line in output.splitlines())
    finally:
        root.removeHandler(handler)
        loader.logger.setLevel(old_level)
