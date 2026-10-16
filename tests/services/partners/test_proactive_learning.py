from datetime import datetime
import time
from types import SimpleNamespace
from zoneinfo import ZoneInfo

from cognivoy.services.cron.service import CronService
from cognivoy.services.partners.manager import PartnerConfig
from cognivoy.services.partners.proactive_learning import (
    cancel_learning_project_outreach,
    list_proactive_audit,
    proactive_effectiveness,
    reconcile_learning_project_outreach,
    record_proactive_outcome,
    schedule_low_score_reviews,
    schedule_proactive_event,
)


def test_viewed_outcome_is_idempotent_and_effectiveness_is_explicit(
    partners_root,
):
    record_proactive_outcome(partner_id="tutor", job_id="job-1", decision="viewed")
    record_proactive_outcome(partner_id="tutor", job_id="job-1", decision="viewed")
    record_proactive_outcome(partner_id="tutor", job_id="job-1", decision="started")
    records = list_proactive_audit("tutor")
    assert [record["decision"] for record in records] == ["viewed", "started"]
    assert proactive_effectiveness(records) == {
        "scheduled": 0,
        "viewed": 1,
        "started": 1,
        "snoozed": 0,
        "skipped": 0,
        "disabled": 0,
        "delivered": 0,
        "failed": 0,
        "engagement_rate": 1.0,
    }


def test_low_score_schedules_one_deduplicated_partner_review(tmp_path, monkeypatch, partners_root):
    service = CronService(tmp_path / "jobs.json")

    class Manager:
        channel_bindings = {}

        def list_partners(self):
            return [{"partner_id": "tutor"}]

        def load_config(self, partner_id):
            return PartnerConfig(
                name="Tutor",
                proactive_learning=True,
                proactive_review_delay_hours=24,
                proactive_low_score_threshold=0.75,
            )

        def get_partner(self, partner_id):
            return None

    import cognivoy.services.cron as cron_module
    import cognivoy.services.partners as partners_module

    monkeypatch.setattr(cron_module, "get_cron_service", lambda: service)
    monkeypatch.setattr(partners_module, "get_partner_manager", lambda: Manager())
    # The module imports accessors directly; patch those bindings as well.
    monkeypatch.setattr(
        "cognivoy.services.partners.proactive_learning.get_cron_service",
        lambda: service,
    )
    monkeypatch.setattr(
        "cognivoy.services.partners.proactive_learning.get_partner_manager",
        lambda: Manager(),
    )
    answers = [
        {"question": "Factor x²-4", "is_correct": False},
        {"question": "Check both roots", "is_correct": True},
    ]
    first = schedule_low_score_reviews(session_id="s1", turn_id="t1", answers=answers)
    second = schedule_low_score_reviews(session_id="s1", turn_id="t1", answers=answers)
    assert len(first) == 1
    assert second == []
    job = service.get_job(first[0])
    assert job is not None
    assert job.owner.partner_id == "tutor"
    assert job.owner.channel_meta["learning_event"] == "low_quiz_score"


def test_proactive_learning_is_opt_in(tmp_path, monkeypatch, partners_root):
    service = CronService(tmp_path / "jobs.json")

    class Manager:
        def list_partners(self):
            return [{"partner_id": "quiet"}]

        def load_config(self, partner_id):
            return PartnerConfig(name="Quiet", proactive_learning=False)

    monkeypatch.setattr(
        "cognivoy.services.partners.proactive_learning.get_cron_service",
        lambda: service,
    )
    monkeypatch.setattr(
        "cognivoy.services.partners.proactive_learning.get_partner_manager",
        lambda: Manager(),
    )
    assert (
        schedule_low_score_reviews(
            session_id="s", turn_id="t", answers=[{"question": "Q", "is_correct": False}]
        )
        == []
    )


def test_learning_project_review_outreach_contains_evidence_and_is_cancelled_when_resolved(
    tmp_path, monkeypatch, partners_root
):
    service = CronService(tmp_path / "jobs.json")

    class Manager:
        def list_partners(self):
            return [{"partner_id": "tutor"}]

        def load_config(self, partner_id):
            return PartnerConfig(
                name="Tutor",
                language="zh",
                proactive_learning=True,
                proactive_allowed_start="00:00",
                proactive_allowed_end="23:59",
                proactive_min_interval_hours=0,
                proactive_merge_window_hours=0,
            )

        def get_partner(self, partner_id):
            return None

    monkeypatch.setattr(
        "cognivoy.services.partners.proactive_learning.get_cron_service",
        lambda: service,
    )
    monkeypatch.setattr(
        "cognivoy.services.partners.proactive_learning.get_partner_manager",
        lambda: Manager(),
    )
    review = SimpleNamespace(
        id="review-1",
        title="矩阵乘法",
        knowledge_point="矩阵乘法",
        source_ref="question:s1:t1:q1",
        due_at=datetime(2099, 8, 20, 10, 0, tzinfo=ZoneInfo("UTC")).timestamp(),
        status="scheduled",
    )
    project = SimpleNamespace(
        id="project-1",
        partner_id="tutor",
        language="zh",
        title="线性代数",
        review_items=[review],
        review_preferences=SimpleNamespace(reminder_time="19:00"),
    )

    ids = reconcile_learning_project_outreach(project)

    assert len(ids) == 1
    job = service.get_job(ids[0])
    assert job is not None
    assert job.owner.channel_meta["project_id"] == "project-1"
    assert job.owner.channel_meta["action_href"] == "/space/learning/project-1#review-queue"
    assert job.owner.channel_meta["source_refs"] == ["question:s1:t1:q1"]
    assert job.owner.channel_meta["evidence"][0]["review_id"] == "review-1"
    assert "矩阵乘法" in job.message
    scheduled = datetime.fromtimestamp(job.schedule.at_ms / 1000, tz=ZoneInfo("UTC"))
    assert (scheduled.hour, scheduled.minute) == (19, 0)

    review.status = "mastered"
    assert reconcile_learning_project_outreach(project) == [ids[0]]
    assert service.get_job(ids[0]) is None
    assert list_proactive_audit("tutor")[-1]["decision"] == "cancelled"


def test_learning_project_temporary_mute_cancels_pending_outreach(
    tmp_path, monkeypatch, partners_root
):
    service = CronService(tmp_path / "jobs.json")

    class Manager:
        def list_partners(self):
            return [{"partner_id": "tutor"}]

        def load_config(self, partner_id):
            return PartnerConfig(
                name="Tutor",
                proactive_learning=True,
                proactive_allowed_start="00:00",
                proactive_allowed_end="23:59",
                proactive_min_interval_hours=0,
                proactive_merge_window_hours=0,
            )

        def get_partner(self, partner_id):
            return None

    monkeypatch.setattr(
        "cognivoy.services.partners.proactive_learning.get_cron_service",
        lambda: service,
    )
    monkeypatch.setattr(
        "cognivoy.services.partners.proactive_learning.get_partner_manager",
        lambda: Manager(),
    )
    project = SimpleNamespace(
        id="project-muted",
        partner_id="tutor",
        language="en",
        title="Calculus",
        review_items=[
            SimpleNamespace(
                id="review-1",
                title="Limits",
                knowledge_point="Limits",
                source_ref="question:s:t:q",
                due_at=time.time() + 3600,
                status="scheduled",
            )
        ],
        review_preferences=SimpleNamespace(
            reminder_time="19:00",
            reminders_paused_until=None,
        ),
    )
    scheduled = reconcile_learning_project_outreach(project)
    assert len(scheduled) == 1
    project.review_preferences.reminders_paused_until = time.time() + 86400
    assert reconcile_learning_project_outreach(project) == scheduled
    assert service.get_job(scheduled[0]) is None
    assert list_proactive_audit("tutor")[-1]["reason"] == "project_temporarily_muted"


def test_learning_project_outreach_can_be_cancelled_for_previous_tutor(
    tmp_path, monkeypatch, partners_root
):
    service = CronService(tmp_path / "jobs.json")

    class Manager:
        def list_partners(self):
            return [{"partner_id": "old-tutor"}, {"partner_id": "new-tutor"}]

        def load_config(self, partner_id):
            return PartnerConfig(
                name=partner_id,
                proactive_learning=True,
                proactive_allowed_start="00:00",
                proactive_allowed_end="23:59",
                proactive_min_interval_hours=0,
                proactive_merge_window_hours=0,
            )

        def get_partner(self, partner_id):
            return None

    monkeypatch.setattr(
        "cognivoy.services.partners.proactive_learning.get_cron_service",
        lambda: service,
    )
    monkeypatch.setattr(
        "cognivoy.services.partners.proactive_learning.get_partner_manager",
        lambda: Manager(),
    )
    project = SimpleNamespace(
        id="project-reassign",
        partner_id="old-tutor",
        language="en",
        title="Algebra",
        review_items=[
            SimpleNamespace(
                id="review-1",
                title="Factoring",
                knowledge_point="Factoring",
                source_ref="question:s:t:q",
                due_at=time.time() + 3600,
                status="scheduled",
            )
        ],
    )
    old_ids = reconcile_learning_project_outreach(project)
    assert len(old_ids) == 1

    assert (
        cancel_learning_project_outreach(
            project_id=project.id,
            partner_id="old-tutor",
            reason="tutor_reassigned",
        )
        == old_ids
    )
    assert service.get_job(old_ids[0]) is None


def test_review_respects_timezone_allowed_window_goal_and_channel(
    tmp_path, monkeypatch, partners_root
):
    service = CronService(tmp_path / "jobs.json")

    class Instance:
        channel_bindings = {"telegram": "chat-42", "web": "web"}

    class Manager:
        def list_partners(self):
            return [{"partner_id": "tutor"}]

        def load_config(self, partner_id):
            return PartnerConfig(
                name="Tutor",
                language="zh",
                proactive_learning=True,
                proactive_goal="掌握二次方程",
                proactive_timezone="Asia/Shanghai",
                proactive_allowed_start="09:00",
                proactive_allowed_end="18:00",
                proactive_allowed_weekdays=[0, 1, 2, 3, 4],
                proactive_preferred_channel="telegram",
                proactive_review_delay_hours=1,
                proactive_low_score_threshold=0.8,
            )

        def get_partner(self, partner_id):
            return Instance()

    monkeypatch.setattr(
        "cognivoy.services.partners.proactive_learning.get_cron_service",
        lambda: service,
    )
    monkeypatch.setattr(
        "cognivoy.services.partners.proactive_learning.get_partner_manager",
        lambda: Manager(),
    )

    # Friday 17:30 + one hour misses the allowed window, so the reminder moves
    # to Monday 09:00 in the configured timezone.
    now = datetime(2026, 8, 21, 17, 30, tzinfo=ZoneInfo("Asia/Shanghai"))
    monkeypatch.setattr(
        "cognivoy.services.cron.service._now_ms",
        lambda: int(now.timestamp() * 1000),
    )
    ids = schedule_low_score_reviews(
        session_id="s-window",
        turn_id="t-window",
        answers=[{"question": "求 x²-5x+6=0", "is_correct": False}],
        now=now,
    )

    assert len(ids) == 1
    job = service.get_job(ids[0])
    assert job is not None
    scheduled = datetime.fromtimestamp(job.schedule.at_ms / 1000, tz=ZoneInfo("Asia/Shanghai"))
    assert scheduled.isoformat() == "2026-08-24T09:00:00+08:00"
    assert job.owner.channel == "telegram"
    assert job.owner.chat_id == "chat-42"
    assert job.owner.language == "zh"
    assert "掌握二次方程" in job.message

    audit = list_proactive_audit("tutor")
    assert audit[-1]["decision"] == "scheduled"
    assert audit[-1]["job_id"] == job.id
    assert audit[-1]["scheduled_for"] == scheduled.isoformat()


def test_temporary_dnd_suppresses_and_audits_review(tmp_path, monkeypatch, partners_root):
    service = CronService(tmp_path / "jobs.json")
    paused_until = "2026-08-20T12:00:00+00:00"

    class Manager:
        def list_partners(self):
            return [{"partner_id": "quiet"}]

        def load_config(self, partner_id):
            return PartnerConfig(
                name="Quiet",
                proactive_learning=True,
                proactive_paused_until=paused_until,
            )

        def get_partner(self, partner_id):
            return None

    monkeypatch.setattr(
        "cognivoy.services.partners.proactive_learning.get_cron_service",
        lambda: service,
    )
    monkeypatch.setattr(
        "cognivoy.services.partners.proactive_learning.get_partner_manager",
        lambda: Manager(),
    )

    result = schedule_low_score_reviews(
        session_id="s-dnd",
        turn_id="t-dnd",
        answers=[{"question": "Q", "is_correct": False}],
        now=datetime(2026, 8, 20, 8, 0, tzinfo=ZoneInfo("UTC")),
    )
    assert result == []
    audit = list_proactive_audit("quiet")
    assert audit[-1]["decision"] == "suppressed"
    assert audit[-1]["reason"] == "do_not_disturb"


def test_nearby_learning_events_merge_and_daily_limit_is_audited(
    tmp_path, monkeypatch, partners_root
):
    service = CronService(tmp_path / "jobs.json")

    class Manager:
        def list_partners(self):
            return [{"partner_id": "tutor"}]

        def load_config(self, partner_id):
            return PartnerConfig(
                name="Tutor",
                proactive_learning=True,
                proactive_review_delay_hours=2,
                proactive_allowed_start="00:00",
                proactive_allowed_end="23:59",
                proactive_merge_window_hours=4,
                proactive_max_per_day=1,
                proactive_min_interval_hours=0,
            )

        def get_partner(self, partner_id):
            return None

    monkeypatch.setattr(
        "cognivoy.services.partners.proactive_learning.get_cron_service",
        lambda: service,
    )
    monkeypatch.setattr(
        "cognivoy.services.partners.proactive_learning.get_partner_manager",
        lambda: Manager(),
    )
    now = datetime(2026, 8, 20, 8, 0, tzinfo=ZoneInfo("UTC"))
    monkeypatch.setattr(
        "cognivoy.services.cron.service._now_ms",
        lambda: int(now.timestamp() * 1000),
    )
    first = schedule_low_score_reviews(
        session_id="s1",
        turn_id="t1",
        answers=[{"question": "Factor x²-4", "is_correct": False}],
        now=now,
    )
    merged = schedule_low_score_reviews(
        session_id="s2",
        turn_id="t2",
        answers=[{"question": "Check both roots", "is_correct": False}],
        now=now,
    )
    assert len(first) == 1
    assert merged == [first[0]]
    assert "Check both roots" in service.get_job(first[0]).message
    assert list_proactive_audit("tutor")[-1]["decision"] == "merged"

    # Outside the merge window, the same-day cap suppresses another reminder.
    later = schedule_low_score_reviews(
        session_id="s3",
        turn_id="t3",
        answers=[{"question": "Complete the square", "is_correct": False}],
        now=now.replace(hour=15),
    )
    assert later == []
    audit = list_proactive_audit("tutor")
    assert audit[-1]["decision"] == "suppressed"
    assert audit[-1]["reason"] == "daily_limit"


def test_frequency_limit_survives_one_shot_job_removal(tmp_path, monkeypatch, partners_root):
    service = CronService(tmp_path / "jobs.json")

    class Manager:
        def list_partners(self):
            return [{"partner_id": "tutor"}]

        def load_config(self, partner_id):
            return PartnerConfig(
                name="Tutor",
                proactive_learning=True,
                proactive_review_delay_hours=1,
                proactive_allowed_start="00:00",
                proactive_allowed_end="23:59",
                proactive_frequency="daily",
                proactive_min_interval_hours=0,
                proactive_max_per_day=5,
                proactive_merge_window_hours=0,
            )

        def get_partner(self, partner_id):
            return None

    monkeypatch.setattr(
        "cognivoy.services.partners.proactive_learning.get_cron_service",
        lambda: service,
    )
    monkeypatch.setattr(
        "cognivoy.services.partners.proactive_learning.get_partner_manager",
        lambda: Manager(),
    )
    now = datetime(2026, 8, 20, 8, 0, tzinfo=ZoneInfo("UTC"))
    monkeypatch.setattr(
        "cognivoy.services.cron.service._now_ms",
        lambda: int(now.timestamp() * 1000),
    )
    first = schedule_low_score_reviews(
        session_id="s1",
        turn_id="t1",
        answers=[{"question": "Q1", "is_correct": False}],
        now=now,
    )
    assert len(first) == 1
    # One-shot jobs disappear after delivery. The durable decision audit must
    # still enforce the owner's daily frequency instead of forgetting it.
    assert service.cancel_job(first[0])
    second = schedule_low_score_reviews(
        session_id="s2",
        turn_id="t2",
        answers=[{"question": "Q2", "is_correct": False}],
        now=now.replace(hour=12),
    )
    assert second == []
    assert list_proactive_audit("tutor")[-1]["reason"] == "minimum_interval"


def test_generic_proactive_event_supports_all_prd_trigger_types(
    tmp_path, monkeypatch, partners_root
):
    service = CronService(tmp_path / "jobs.json")

    class Instance:
        channel_bindings = {"web": "web"}

    class Manager:
        def list_partners(self):
            return [{"partner_id": "tutor"}]

        def load_config(self, partner_id):
            return PartnerConfig(
                name="Tutor",
                proactive_learning=True,
                proactive_allowed_start="00:00",
                proactive_allowed_end="23:59",
                proactive_min_interval_hours=0,
                proactive_max_per_day=10,
                proactive_merge_window_hours=0,
            )

        def get_partner(self, partner_id):
            return Instance()

    monkeypatch.setattr(
        "cognivoy.services.partners.proactive_learning.get_cron_service",
        lambda: service,
    )
    monkeypatch.setattr(
        "cognivoy.services.partners.proactive_learning.get_partner_manager",
        lambda: Manager(),
    )

    now = datetime(2026, 8, 20, 8, 0, tzinfo=ZoneInfo("UTC"))
    monkeypatch.setattr(
        "cognivoy.services.cron.service._now_ms",
        lambda: int(now.timestamp() * 1000),
    )
    kinds = ("due_review", "learning_plan", "inactivity", "custom")
    ids = []
    for kind in kinds:
        created = schedule_proactive_event(
            event_type=kind,
            event_key=f"{kind}:learner-1",
            message=f"Reminder for {kind}",
            now=now,
            desired_at=now.replace(hour=9 + len(ids)),
            metadata={"learner_id": "learner-1"},
        )
        assert len(created) == 1
        ids.extend(created)

    assert len(set(ids)) == 4
    jobs = [service.get_job(job_id) for job_id in ids]
    assert {job.owner.channel_meta["learning_event"] for job in jobs} == set(kinds)
    assert all(job.owner.channel_meta["learner_id"] == "learner-1" for job in jobs)
    assert {row["event"] for row in list_proactive_audit("tutor")} >= set(kinds)


def test_generic_proactive_event_is_idempotent_and_can_target_one_partner(
    tmp_path, monkeypatch, partners_root
):
    service = CronService(tmp_path / "jobs.json")

    class Manager:
        def list_partners(self):
            return [{"partner_id": "one"}, {"partner_id": "two"}]

        def load_config(self, partner_id):
            return PartnerConfig(
                name=partner_id,
                proactive_learning=True,
                proactive_allowed_start="00:00",
                proactive_allowed_end="23:59",
                proactive_min_interval_hours=0,
                proactive_max_per_day=10,
                proactive_merge_window_hours=0,
            )

        def get_partner(self, partner_id):
            return None

    monkeypatch.setattr(
        "cognivoy.services.partners.proactive_learning.get_cron_service",
        lambda: service,
    )
    monkeypatch.setattr(
        "cognivoy.services.partners.proactive_learning.get_partner_manager",
        lambda: Manager(),
    )
    now = datetime(2026, 8, 20, 8, 0, tzinfo=ZoneInfo("UTC"))
    monkeypatch.setattr(
        "cognivoy.services.cron.service._now_ms",
        lambda: int(now.timestamp() * 1000),
    )
    kwargs = {
        "event_type": "custom",
        "event_key": "weekly-plan",
        "message": "Review the weekly plan",
        "partner_ids": ["two"],
        "now": now,
        "desired_at": now.replace(hour=10),
    }
    first = schedule_proactive_event(**kwargs)
    second = schedule_proactive_event(**kwargs)
    assert len(first) == 1
    assert second == []
    job = service.get_job(first[0])
    assert job.owner.partner_id == "two"


def test_generic_proactive_event_can_refresh_a_stable_inactivity_deadline(
    tmp_path, monkeypatch, partners_root
):
    service = CronService(tmp_path / "jobs.json")

    class Manager:
        def list_partners(self):
            return [{"partner_id": "tutor"}]

        def load_config(self, _partner_id):
            return PartnerConfig(
                name="Tutor",
                proactive_learning=True,
                proactive_allowed_start="00:00",
                proactive_allowed_end="23:59",
                proactive_min_interval_hours=0,
                proactive_max_per_day=10,
                proactive_merge_window_hours=0,
            )

        def get_partner(self, _partner_id):
            return None

    monkeypatch.setattr(
        "cognivoy.services.partners.proactive_learning.get_cron_service",
        lambda: service,
    )
    monkeypatch.setattr(
        "cognivoy.services.partners.proactive_learning.get_partner_manager",
        lambda: Manager(),
    )
    now = datetime(2026, 8, 20, 8, 0, tzinfo=ZoneInfo("UTC"))
    monkeypatch.setattr(
        "cognivoy.services.cron.service._now_ms",
        lambda: int(now.timestamp() * 1000),
    )
    first = schedule_proactive_event(
        event_type="inactivity",
        event_key="book-1",
        message="Continue your learning path.",
        now=now,
        desired_at=now.replace(day=27),
    )
    assert len(first) == 1

    refreshed = schedule_proactive_event(
        event_type="inactivity",
        event_key="book-1",
        message="Continue your learning path.",
        now=now.replace(day=21),
        desired_at=now.replace(day=28),
        replace_existing=True,
    )
    assert refreshed == first
    job = service.get_job(first[0])
    assert (
        datetime.fromtimestamp(job.schedule.at_ms / 1000, tz=ZoneInfo("UTC")).date()
        == datetime(2026, 8, 28, tzinfo=ZoneInfo("UTC")).date()
    )
    assert len(service.list_jobs(owner_key="partner:tutor")) == 1
