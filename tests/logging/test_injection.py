import json
import logging

from cognivoy.logging.formatters import ConsoleFormatter, JsonlFormatter


def test_console_logs_cannot_forge_lines_or_terminal_controls():
    record = logging.LogRecord(
        "cognivoy.test", logging.INFO, "", 1, "%s", ("name\r\nERROR forged\x1b[2J\u2028tail",), None
    )
    record.log_context = {"task_id": "task\nforged", "stage": "stage\x1b[0m"}
    output = ConsoleFormatter().format(record)
    assert len(output.splitlines()) == 1
    assert "\x1b" not in output
    assert "forged" in output


def test_json_logs_keep_untrusted_messages_in_one_record():
    message = "name\r\nERROR forged\x1b[2J\u0085\u2028\u2029tail"
    record = logging.LogRecord("cognivoy.test", logging.INFO, "", 1, "%s", (message,), None)
    output = JsonlFormatter().format(record)
    assert len(output.splitlines()) == 1
    assert json.loads(output)["message"] == message
