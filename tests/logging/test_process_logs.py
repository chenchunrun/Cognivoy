import logging

from cognivoy.logging import ProcessLogEvent, bind_log_context, capture_process_logs


def test_capture_process_logs_emits_structured_event_for_matching_task():
    events: list[ProcessLogEvent] = []
    logger = logging.getLogger("cognivoy.tests.process")
    previous_level = logger.level
    logger.setLevel(logging.INFO)

    try:
        with bind_log_context(task_id="task-1", capability="knowledge", stage="indexing"):
            with capture_process_logs(events.append, task_id="task-1"):
                logger.info("Embedding batches: %s/%s", 2, 8)
    finally:
        logger.setLevel(previous_level)

    assert len(events) == 1
    event = events[0].to_dict()
    assert event["type"] == "process_log"
    assert event["level"] == "INFO"
    assert event["message"] == "Embedding batches: 2/8"
    assert event["logger"] == "cognivoy.tests.process"
    assert event["context"] == {
        "task_id": "task-1",
        "capability": "knowledge",
        "stage": "indexing",
    }


def test_capture_process_logs_filters_other_tasks():
    events: list[ProcessLogEvent] = []
    logger = logging.getLogger("cognivoy.tests.process")

    with capture_process_logs(events.append, task_id="task-1"):
        with bind_log_context(task_id="task-2"):
            logger.warning("wrong task")

    assert events == []


def test_capture_process_logs_does_not_forward_server_only_diagnostics():
    events: list[ProcessLogEvent] = []
    logger = logging.getLogger("cognivoy.tests.process")

    with capture_process_logs(events.append, task_id="task-1"):
        with bind_log_context(task_id="task-1", sink="server"):
            logger.error("provider secret: sk-must-not-reach-the-browser")

    assert events == []


def test_capture_process_logs_can_exclude_provider_error_records():
    events: list[ProcessLogEvent] = []
    logger = logging.getLogger("cognivoy.tests.provider")

    with bind_log_context(task_id="task-1"):
        with capture_process_logs(
            events.append,
            task_id="task-1",
            max_level=logging.WARNING,
        ):
            logger.error("raw provider exception with /private/local/path")

    assert events == []
