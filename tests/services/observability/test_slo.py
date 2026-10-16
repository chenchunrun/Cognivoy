from __future__ import annotations

from cognivoy.services.observability.slo import SloStore, route_group_for_path


def test_slo_snapshot_reports_availability_latency_and_alerts(tmp_path):
    store = SloStore(
        tmp_path / "slo.sqlite3",
        availability_target=99.5,
        p95_target_ms=500,
        minimum_samples=4,
    )
    for status, duration in [(200, 25), (200, 40), (503, 600), (200, 800)]:
        store.record_request(
            route_group="chat", status_code=status, duration_ms=duration, now=1_000
        )

    snapshot = store.snapshot(window_seconds=3_600, now=1_100)

    assert snapshot["requests"] == 4
    assert snapshot["server_errors"] == 1
    assert snapshot["availability_percent"] == 75.0
    assert snapshot["latency_ms"]["p95"] == 800.0
    assert {alert["code"] for alert in snapshot["alerts"]} == {
        "availability_below_target",
        "p95_above_target",
    }
    assert snapshot["route_groups"][0]["name"] == "chat"


def test_slo_business_metrics_are_whitelisted_and_windowed(tmp_path):
    store = SloStore(tmp_path / "slo.sqlite3")
    store.record_business_event("reference_clicked", amount=2, now=350)
    store.record_business_event("learning_completed", now=360)
    store.record_business_event("reference_clicked", amount=4, now=10)

    snapshot = store.snapshot(window_seconds=50, now=400)

    assert snapshot["business_metrics"] == {
        "asset_saved": 0,
        "learning_completed": 1,
        "reference_clicked": 2,
        "turn_recovered": 0,
    }


def test_slo_rejects_unknown_or_invalid_business_metrics(tmp_path):
    store = SloStore(tmp_path / "slo.sqlite3")

    try:
        store.record_business_event("user_email", now=1)
    except ValueError as exc:
        assert "unsupported" in str(exc)
    else:  # pragma: no cover - documents the required rejection
        raise AssertionError("unknown metric was accepted")

    try:
        store.record_business_event("asset_saved", amount=0, now=1)
    except ValueError as exc:
        assert "positive" in str(exc)
    else:  # pragma: no cover
        raise AssertionError("zero metric amount was accepted")


def test_route_group_drops_resource_identifiers():
    assert route_group_for_path("/api/v1/knowledge/private-kb/files/secret.pdf") == "knowledge"
    assert route_group_for_path("/api/v1/ws") == "ws"
    assert route_group_for_path("/health") == "other"
