"""Translate learning evidence into opt-in, deduplicated Partner outreach."""

from __future__ import annotations

from datetime import datetime, time, timedelta
import hashlib
import json
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from cognivoy.partners.config.paths import get_partner_dir
from cognivoy.services.cron import get_cron_service
from cognivoy.services.cron.service import CronOwner, CronSchedule
from cognivoy.services.partners import get_partner_manager

_AUDIT_LIMIT = 1000


def _audit_path(partner_id: str) -> Path:
    return get_partner_dir(partner_id) / "proactive_audit.jsonl"


def _append_audit(partner_id: str, record: dict[str, Any]) -> None:
    path = _audit_path(partner_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    existing = []
    if path.exists():
        try:
            existing = path.read_text(encoding="utf-8").splitlines()[-(_AUDIT_LIMIT - 1) :]
        except OSError:
            existing = []
    existing.append(json.dumps(record, ensure_ascii=False, sort_keys=True))
    tmp = path.with_suffix(".tmp")
    tmp.write_text("\n".join(existing) + "\n", encoding="utf-8")
    tmp.replace(path)


def list_proactive_audit(partner_id: str, *, limit: int = 100) -> list[dict[str, Any]]:
    """Return newest policy decisions in chronological order."""
    path = _audit_path(partner_id)
    if not path.exists():
        return []
    records: list[dict[str, Any]] = []
    try:
        lines = path.read_text(encoding="utf-8").splitlines()[-max(1, min(limit, 500)) :]
    except OSError:
        return []
    for line in lines:
        try:
            raw = json.loads(line)
        except (TypeError, ValueError):
            continue
        if isinstance(raw, dict):
            records.append(raw)
    return records


def record_proactive_outcome(
    *,
    partner_id: str,
    job_id: str,
    decision: str,
    error: str | None = None,
    now: datetime | None = None,
) -> None:
    if decision == "viewed" and any(
        str(item.get("job_id") or "") == job_id and item.get("decision") == "viewed"
        for item in list_proactive_audit(partner_id, limit=500)
    ):
        return
    moment = now or datetime.now().astimezone()
    record: dict[str, Any] = {
        "at": moment.isoformat(),
        "event": "delivery",
        "decision": decision,
        "job_id": job_id,
    }
    if error:
        record["error"] = error
    _append_audit(partner_id, record)


def proactive_effectiveness(records: list[dict[str, Any]]) -> dict[str, Any]:
    """Summarize learner-visible reminder outcomes without user profiling."""
    decisions = [str(record.get("decision") or "") for record in records]
    scheduled = decisions.count("scheduled")
    viewed = decisions.count("viewed")
    started = decisions.count("started") + decisions.count("expedited")
    snoozed = decisions.count("snoozed")
    skipped = decisions.count("skipped")
    disabled = decisions.count("disabled")
    delivered = decisions.count("delivered") + decisions.count("success")
    failed = decisions.count("failed") + decisions.count("dead_lettered")
    actionable = started + snoozed + skipped + disabled
    return {
        "scheduled": scheduled,
        "viewed": viewed,
        "started": started,
        "snoozed": snoozed,
        "skipped": skipped,
        "disabled": disabled,
        "delivered": delivered,
        "failed": failed,
        "engagement_rate": round(started / actionable, 4) if actionable else 0.0,
    }


def _timezone(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(name or "UTC")
    except ZoneInfoNotFoundError:
        return ZoneInfo("UTC")


def _clock(value: str, fallback: time) -> time:
    try:
        hour, minute = (int(part) for part in value.split(":", 1))
        return time(hour=hour, minute=minute)
    except (AttributeError, TypeError, ValueError):
        return fallback


def _in_window(moment: datetime, start: time, end: time) -> bool:
    current = moment.time().replace(tzinfo=None)
    if start <= end:
        return start <= current <= end
    return current >= start or current <= end


def _next_allowed(
    moment: datetime,
    config: Any,
    allowed_weekdays: set[int] | None = None,
) -> datetime:
    """Move a desired delivery time into the owner's local social window."""
    start = _clock(config.proactive_allowed_start, time(9, 0))
    end = _clock(config.proactive_allowed_end, time(21, 0))
    weekdays = set(config.proactive_allowed_weekdays or [])
    if allowed_weekdays is not None:
        weekdays &= allowed_weekdays
    if not weekdays:
        raise ValueError("proactive allowed window has no shared weekdays")
    candidate = moment.replace(second=0, microsecond=0)
    # Minute stepping keeps overnight windows and DST transitions correct and
    # is bounded to two weeks (20k cheap iterations in the rare worst case).
    for _ in range(14 * 24 * 60):
        if candidate.weekday() in weekdays and _in_window(candidate, start, end):
            return candidate
        candidate += timedelta(minutes=1)
    raise ValueError("proactive allowed window has no reachable time in two weeks")


def _paused(config: Any, now: datetime) -> bool:
    raw = str(config.proactive_paused_until or "").strip()
    if not raw:
        return False
    try:
        until = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if until.tzinfo is None:
            until = until.replace(tzinfo=now.tzinfo)
        return now < until.astimezone(now.tzinfo)
    except ValueError:
        # An invalid persisted DND value fails safe rather than sending an
        # unsolicited message.
        return True


def _job_local_time(job: Any, timezone: ZoneInfo) -> datetime | None:
    at_ms = job.schedule.at_ms
    if not at_ms:
        return None
    return datetime.fromtimestamp(at_ms / 1000, tz=timezone)


def _historical_delivery_times(partner_id: str, timezone: ZoneInfo) -> dict[str, datetime]:
    records = list_proactive_audit(partner_id, limit=500)
    cancelled = {
        str(record.get("job_id") or "")
        for record in records
        if record.get("decision") == "cancelled"
    }
    times: dict[str, datetime] = {}
    for record in records:
        if record.get("decision") != "scheduled":
            continue
        job_id = str(record.get("job_id") or "")
        if not job_id or job_id in cancelled:
            continue
        raw = str(record.get("scheduled_for") or "")
        try:
            parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except ValueError:
            continue
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone)
        times[job_id] = parsed.astimezone(timezone)
    return times


def _audit_base(*, now: datetime, session_id: str, turn_id: str, score: float) -> dict[str, Any]:
    return {
        "at": now.isoformat(),
        "event": "low_quiz_score",
        "source_session_id": session_id,
        "source_turn_id": turn_id,
        "score": score,
    }


_PROACTIVE_EVENT_TYPES = frozenset(
    {"low_quiz_score", "due_review", "learning_plan", "inactivity", "custom"}
)


def _event_hash(event_type: str, event_key: str) -> str:
    return hashlib.sha256(f"{event_type}:{event_key}".encode()).hexdigest()[:16]


def _localized(moment: datetime, timezone: ZoneInfo) -> datetime:
    if moment.tzinfo is None:
        return moment.replace(tzinfo=timezone)
    return moment.astimezone(timezone)


def schedule_proactive_event(
    *,
    event_type: str,
    event_key: str,
    message: str,
    desired_at: datetime | None = None,
    now: datetime | None = None,
    metadata: dict[str, Any] | None = None,
    partner_ids: list[str] | None = None,
    replace_existing: bool = False,
    allowed_weekdays: list[int] | None = None,
) -> list[str]:
    """Schedule an opt-in TutorBot event through the shared policy engine.

    Event producers use this entry point for due reviews, learning-plan
    checkpoints, inactivity nudges, and user-defined reminders.  The stable
    ``event_key`` makes each producer retry-safe while the partner policy still
    owns time zones, social windows, DND, frequency limits, daily limits,
    coalescing, channel selection, retry, and audit.
    """
    normalized_type = str(event_type or "").strip().lower()
    normalized_key = str(event_key or "").strip()
    normalized_message = str(message or "").strip()
    if normalized_type not in _PROACTIVE_EVENT_TYPES:
        raise ValueError(f"unsupported proactive event type: {normalized_type or '(empty)'}")
    if not normalized_key:
        raise ValueError("event_key is required")
    if not normalized_message:
        raise ValueError("message is required")

    manager = get_partner_manager()
    cron = get_cron_service()
    allowed_partners = set(partner_ids or []) if partner_ids is not None else None
    event_id = _event_hash(normalized_type, normalized_key)
    scheduled: list[str] = []

    for partner in manager.list_partners():
        partner_id = str(partner.get("partner_id") or "")
        if not partner_id or (allowed_partners is not None and partner_id not in allowed_partners):
            continue
        config = manager.load_config(partner_id)
        if not config or not config.proactive_learning:
            continue
        tz = _timezone(config.proactive_timezone)
        local_now = _localized(now or datetime.now().astimezone(), tz)
        audit_base: dict[str, Any] = {
            "at": local_now.isoformat(),
            "event": normalized_type,
            "event_key": normalized_key,
            **dict(metadata or {}),
        }
        if _paused(config, local_now):
            _append_audit(
                partner_id,
                {**audit_base, "decision": "suppressed", "reason": "do_not_disturb"},
            )
            continue

        desired = _localized(desired_at, tz) if desired_at else local_now
        try:
            scheduled_for = _next_allowed(
                max(desired, local_now),
                config,
                set(allowed_weekdays) if allowed_weekdays is not None else None,
            )
        except ValueError:
            _append_audit(
                partner_id,
                {**audit_base, "decision": "suppressed", "reason": "no_shared_weekday"},
            )
            continue
        name = f"proactive:{partner_id}:{normalized_type}:{event_id}"
        pending = cron.list_jobs(owner_key=f"partner:{partner_id}")
        exact = next((job for job in pending if job.name == name), None)
        if exact is not None:
            if not replace_existing:
                continue
            refreshed_meta = {
                **exact.owner.channel_meta,
                **dict(metadata or {}),
                "learning_event": normalized_type,
                "event_key": normalized_key,
                "event_keys": [normalized_key],
            }
            goal = str(config.proactive_goal or "").strip()
            refreshed_message = normalized_message
            if goal and goal not in refreshed_message:
                refreshed_message += f" Learning goal: {goal}."
            cron.update_job(
                exact.id,
                message=refreshed_message,
                channel_meta=refreshed_meta,
            )
            refreshed = cron.reschedule_job(
                exact.id,
                at_ms=int(scheduled_for.timestamp() * 1000),
                owner_key=f"partner:{partner_id}",
            )
            if refreshed is not None:
                _append_audit(
                    partner_id,
                    {
                        **audit_base,
                        "decision": "refreshed",
                        "job_id": refreshed.id,
                        "scheduled_for": scheduled_for.isoformat(),
                    },
                )
                scheduled.append(refreshed.id)
            continue

        merge_window = timedelta(hours=max(0, config.proactive_merge_window_hours))
        for existing in pending:
            existing_time = _job_local_time(existing, tz)
            existing_event = str(existing.owner.channel_meta.get("learning_event") or "")
            merge_scope = str((metadata or {}).get("merge_scope") or "")
            existing_merge_scope = str(existing.owner.channel_meta.get("merge_scope") or "")
            if (
                existing_event == normalized_type
                and existing_merge_scope == merge_scope
                and existing_time is not None
                and merge_window > timedelta(0)
                and abs(existing_time - scheduled_for) <= merge_window
            ):
                event_keys = list(existing.owner.channel_meta.get("event_keys") or [])
                if normalized_key not in event_keys:
                    event_keys.append(normalized_key)
                combined_message = existing.message
                if normalized_message not in combined_message:
                    combined_message = f"{combined_message}\n\n{normalized_message}"
                combined_meta = {
                    **existing.owner.channel_meta,
                    **dict(metadata or {}),
                    "event_keys": event_keys[:20],
                    "merged_events": int(existing.owner.channel_meta.get("merged_events", 1)) + 1,
                }
                cron.update_job(
                    existing.id,
                    message=combined_message,
                    channel_meta=combined_meta,
                )
                _append_audit(
                    partner_id,
                    {
                        **audit_base,
                        "decision": "merged",
                        "job_id": existing.id,
                        "scheduled_for": existing_time.isoformat(),
                    },
                )
                scheduled.append(existing.id)
                break
        else:
            frequency_floor = {
                "as_needed": 0,
                "daily": 24,
                "weekly": 24 * 7,
            }.get(str(config.proactive_frequency), 0)
            min_interval = timedelta(
                hours=max(config.proactive_min_interval_hours, frequency_floor)
            )
            pending_times = {
                job.id: job_time
                for job in pending
                if (job_time := _job_local_time(job, tz)) is not None
                and str(job.owner.channel_meta.get("learning_event") or "")
                in _PROACTIVE_EVENT_TYPES
            }
            historical_times = _historical_delivery_times(partner_id, tz)
            historical_times.update(pending_times)
            if any(
                abs(scheduled_for - job_time) < min_interval
                for job_time in historical_times.values()
            ):
                _append_audit(
                    partner_id,
                    {**audit_base, "decision": "suppressed", "reason": "minimum_interval"},
                )
                continue
            same_day = sum(
                1
                for job_time in historical_times.values()
                if job_time.date() == scheduled_for.date()
            )
            if same_day >= config.proactive_max_per_day:
                _append_audit(
                    partner_id,
                    {**audit_base, "decision": "suppressed", "reason": "daily_limit"},
                )
                continue

            instance = manager.get_partner(partner_id)
            bindings = dict(instance.channel_bindings) if instance else {}
            preferred = str(config.proactive_preferred_channel or "").strip()
            if preferred and preferred in bindings:
                channel, chat_id = preferred, bindings[preferred]
            else:
                channel, chat_id = next(iter(bindings.items()), ("web", "web"))
            goal = str(config.proactive_goal or "").strip()
            final_message = normalized_message
            if goal and goal not in final_message:
                final_message += f" Learning goal: {goal}."
            job = cron.add_job(
                name=name,
                message=final_message,
                schedule=CronSchedule(kind="at", at_ms=int(scheduled_for.timestamp() * 1000)),
                owner=CronOwner(
                    kind="partner",
                    partner_id=partner_id,
                    channel=channel,
                    chat_id=chat_id,
                    session_key=f"{channel}:{chat_id}",
                    language=config.language or "en",
                    channel_meta={
                        **dict(metadata or {}),
                        "learning_event": normalized_type,
                        "event_key": normalized_key,
                        "event_keys": [normalized_key],
                        "merged_events": 1,
                    },
                ),
                max_attempts=3,
                retry_delay_seconds=15 * 60,
            )
            scheduled.append(job.id)
            _append_audit(
                partner_id,
                {
                    **audit_base,
                    "decision": "scheduled",
                    "job_id": job.id,
                    "scheduled_for": scheduled_for.isoformat(),
                    "channel": channel,
                },
            )
    return scheduled


def cancel_learning_project_outreach(
    *,
    project_id: str,
    partner_id: str | None = None,
    reason: str = "resolved",
    now: datetime | None = None,
) -> list[str]:
    """Cancel pending review outreach for one learning project.

    Project reminders are deliberately scoped by metadata instead of their
    display message. This keeps reassignment and review completion reliable
    even after a title or locale change.
    """

    normalized_project_id = str(project_id or "").strip()
    if not normalized_project_id:
        return []
    manager = get_partner_manager()
    cron = get_cron_service()
    allowed = {str(partner_id).strip()} if partner_id else None
    cancelled: list[str] = []
    for partner in manager.list_partners():
        current_partner_id = str(partner.get("partner_id") or "")
        if not current_partner_id or (allowed is not None and current_partner_id not in allowed):
            continue
        owner_key = f"partner:{current_partner_id}"
        for job in cron.list_jobs(owner_key=owner_key):
            metadata = job.owner.channel_meta
            if (
                str(metadata.get("learning_event") or "") != "due_review"
                or str(metadata.get("project_id") or "") != normalized_project_id
            ):
                continue
            if cron.cancel_job(job.id, owner_key=owner_key):
                cancelled.append(job.id)
                moment = now or datetime.now().astimezone()
                _append_audit(
                    current_partner_id,
                    {
                        "at": moment.isoformat(),
                        "event": "due_review",
                        "event_key": f"learning-project:{normalized_project_id}:reviews",
                        "project_id": normalized_project_id,
                        "decision": "cancelled",
                        "reason": reason,
                        "job_id": job.id,
                    },
                )
    return cancelled


def reconcile_learning_project_outreach(project: Any) -> list[str]:
    """Synchronize a project's pending review evidence with its assigned tutor.

    The learning project remains authoritative. Partner outreach is opt-in and
    best-effort at call sites, but every scheduled message carries enough
    evidence to explain why it exists and where the learner can act on it.
    """

    project_id = str(getattr(project, "id", "") or "").strip()
    partner_id = str(getattr(project, "partner_id", "") or "").strip()
    if not project_id:
        return []
    if not partner_id:
        return cancel_learning_project_outreach(
            project_id=project_id,
            reason="tutor_unassigned",
        )

    preferences = getattr(project, "review_preferences", None)
    paused_until = float(getattr(preferences, "reminders_paused_until", 0) or 0)
    if paused_until > datetime.now(tz=ZoneInfo("UTC")).timestamp():
        return cancel_learning_project_outreach(
            project_id=project_id,
            partner_id=partner_id,
            reason="project_temporarily_muted",
        )

    reviews = [
        item
        for item in list(getattr(project, "review_items", []) or [])
        if str(getattr(item, "status", "")) in {"due", "scheduled"}
    ]
    if not reviews:
        return cancel_learning_project_outreach(
            project_id=project_id,
            partner_id=partner_id,
            reason="review_queue_resolved",
        )

    reviews.sort(key=lambda item: float(getattr(item, "due_at", 0) or 0))
    due_at = float(getattr(reviews[0], "due_at", 0) or 0)
    desired_at = datetime.fromtimestamp(max(due_at, 0), tz=ZoneInfo("UTC"))
    config = get_partner_manager().load_config(partner_id)
    reminder_time = str(getattr(preferences, "reminder_time", "") or "").strip()
    if config is not None and reminder_time:
        try:
            hour, minute = (int(part) for part in reminder_time.split(":", 1))
            partner_timezone = _timezone(config.proactive_timezone)
            local_due = desired_at.astimezone(partner_timezone)
            preferred = local_due.replace(
                hour=hour,
                minute=minute,
                second=0,
                microsecond=0,
            )
            # Never notify before the review becomes due. When the preferred
            # time is still ahead on that date, respect it; otherwise the
            # Partner policy engine will schedule from the due time onward.
            desired_at = max(local_due, preferred)
        except (TypeError, ValueError):
            pass
    language = str(getattr(project, "language", "en") or "en")
    title = str(getattr(project, "title", "") or "").strip()
    weak_points = list(
        dict.fromkeys(
            str(getattr(item, "knowledge_point", "") or getattr(item, "title", "")).strip()
            for item in reviews
            if str(getattr(item, "knowledge_point", "") or getattr(item, "title", "")).strip()
        )
    )[:5]
    source_refs = [
        str(getattr(item, "source_ref", "") or "")
        for item in reviews[:10]
        if str(getattr(item, "source_ref", "") or "")
    ]
    if language == "zh":
        message = f"学习项目“{title}”有 {len(reviews)} 项复习任务待处理。"
        if weak_points:
            message += f" 建议先复习：{'、'.join(weak_points[:3])}。"
    else:
        message = f'Your learning project "{title}" has {len(reviews)} review item(s) ready.'
        if weak_points:
            message += f" Start with: {', '.join(weak_points[:3])}."

    return schedule_proactive_event(
        event_type="due_review",
        event_key=f"learning-project:{project_id}:reviews",
        message=message,
        desired_at=desired_at,
        allowed_weekdays=list(
            getattr(preferences, "reminder_weekdays", None) or [0, 1, 2, 3, 4, 5, 6]
        ),
        metadata={
            "project_id": project_id,
            "project_title": title,
            "reason": "spaced_review_due",
            "due_review_count": len(reviews),
            "weak_points": weak_points,
            "source_refs": source_refs,
            "evidence": [
                {
                    "review_id": str(getattr(item, "id", "") or ""),
                    "title": str(getattr(item, "title", "") or ""),
                    "source_ref": str(getattr(item, "source_ref", "") or ""),
                    "due_at": float(getattr(item, "due_at", 0) or 0),
                }
                for item in reviews[:10]
            ],
            "action_href": f"/space/learning/{project_id}#review-queue",
            "merge_scope": f"learning-project:{project_id}",
        },
        partner_ids=[partner_id],
        replace_existing=True,
    )


def schedule_low_score_reviews(
    *,
    session_id: str,
    turn_id: str,
    answers: list[dict[str, Any]],
    now: datetime | None = None,
) -> list[str]:
    """Schedule one spaced-review reminder per opted-in Partner.

    The stable event key makes repeated quiz-result submissions idempotent.
    """
    if not answers:
        return []
    score = sum(bool(item.get("is_correct")) for item in answers) / len(answers)
    weak_questions = [
        str(item.get("question") or "").strip()
        for item in answers
        if not item.get("is_correct") and str(item.get("question") or "").strip()
    ]
    if not weak_questions:
        return []

    manager = get_partner_manager()
    cron = get_cron_service()
    scheduled: list[str] = []
    event_id = hashlib.sha256(
        f"{session_id}:{turn_id}:{'|'.join(weak_questions)}".encode()
    ).hexdigest()[:12]

    for partner in manager.list_partners():
        partner_id = str(partner.get("partner_id") or "")
        config = manager.load_config(partner_id)
        if not config or not config.proactive_learning:
            continue
        if score > config.proactive_low_score_threshold:
            continue
        tz = _timezone(config.proactive_timezone)
        local_now = (now or datetime.now().astimezone()).astimezone(tz)
        audit_base = _audit_base(now=local_now, session_id=session_id, turn_id=turn_id, score=score)
        if _paused(config, local_now):
            _append_audit(
                partner_id,
                {**audit_base, "decision": "suppressed", "reason": "do_not_disturb"},
            )
            continue
        name = f"learning-review:{partner_id}:{event_id}"
        if any(job.name == name for job in cron.list_jobs(owner_key=f"partner:{partner_id}")):
            continue

        instance = manager.get_partner(partner_id)
        bindings = dict(instance.channel_bindings) if instance else {}
        preferred = str(config.proactive_preferred_channel or "").strip()
        if preferred and preferred in bindings:
            channel, chat_id = preferred, bindings[preferred]
        else:
            channel, chat_id = next(iter(bindings.items()), ("web", "web"))
        goal = str(config.proactive_goal or "").strip()
        message = (
            f"The learner scored {round(score * 100)}% on a recent quiz. "
            "Run a brief spaced-retrieval check on these weak points without "
            f"revealing the answer first: {'; '.join(weak_questions[:3])}"
        )
        if goal:
            message += f" Learning goal: {goal}."
        desired = local_now + timedelta(hours=config.proactive_review_delay_hours)
        scheduled_for = _next_allowed(desired, config)
        pending = cron.list_jobs(owner_key=f"partner:{partner_id}")
        merge_window = timedelta(hours=max(0, config.proactive_merge_window_hours))
        for existing in pending:
            existing_time = _job_local_time(existing, tz)
            if (
                existing.name.startswith(f"learning-review:{partner_id}:")
                and existing_time is not None
                and abs(existing_time - scheduled_for) <= merge_window
            ):
                existing_questions = list(existing.owner.channel_meta.get("weak_questions") or [])
                combined = list(dict.fromkeys([*existing_questions, *weak_questions]))[:10]
                merged_message = (
                    f"The learner needs a brief spaced-retrieval check on these weak "
                    f"points without revealing the answer first: {'; '.join(combined)}"
                )
                if goal:
                    merged_message += f" Learning goal: {goal}."
                meta = {
                    **existing.owner.channel_meta,
                    "weak_questions": combined,
                    "merged_events": int(existing.owner.channel_meta.get("merged_events", 1)) + 1,
                }
                cron.update_job(existing.id, message=merged_message, channel_meta=meta)
                _append_audit(
                    partner_id,
                    {
                        **audit_base,
                        "decision": "merged",
                        "job_id": existing.id,
                        "scheduled_for": existing_time.isoformat(),
                    },
                )
                scheduled.append(existing.id)
                break
        else:
            frequency_floor = {
                "as_needed": 0,
                "daily": 24,
                "weekly": 24 * 7,
            }.get(str(config.proactive_frequency), 0)
            min_interval = timedelta(
                hours=max(config.proactive_min_interval_hours, frequency_floor)
            )
            learning_jobs = [
                (job.id, _job_local_time(job, tz))
                for job in pending
                if job.name.startswith(f"learning-review:{partner_id}:")
            ]
            learning_times = _historical_delivery_times(partner_id, tz)
            learning_times.update(
                {job_id: job_time for job_id, job_time in learning_jobs if job_time is not None}
            )
            if any(
                job_time is not None and abs(scheduled_for - job_time) < min_interval
                for job_time in learning_times.values()
            ):
                _append_audit(
                    partner_id,
                    {**audit_base, "decision": "suppressed", "reason": "minimum_interval"},
                )
                continue
            same_day = sum(
                1 for job_time in learning_times.values() if job_time.date() == scheduled_for.date()
            )
            if same_day >= config.proactive_max_per_day:
                _append_audit(
                    partner_id,
                    {**audit_base, "decision": "suppressed", "reason": "daily_limit"},
                )
                continue
            at_ms = int(scheduled_for.timestamp() * 1000)
            job = cron.add_job(
                name=name,
                message=message,
                schedule=CronSchedule(kind="at", at_ms=at_ms),
                owner=CronOwner(
                    kind="partner",
                    partner_id=partner_id,
                    channel=channel,
                    chat_id=chat_id,
                    session_key=f"{channel}:{chat_id}",
                    language=config.language or "en",
                    channel_meta={
                        "learning_event": "low_quiz_score",
                        "source_session_id": session_id,
                        "source_turn_id": turn_id,
                        "score": score,
                        "weak_questions": weak_questions[:10],
                        "merged_events": 1,
                    },
                ),
                max_attempts=3,
                retry_delay_seconds=15 * 60,
            )
            scheduled.append(job.id)
            _append_audit(
                partner_id,
                {
                    **audit_base,
                    "decision": "scheduled",
                    "job_id": job.id,
                    "scheduled_for": scheduled_for.isoformat(),
                    "channel": channel,
                },
            )
    return scheduled


__all__ = [
    "list_proactive_audit",
    "record_proactive_outcome",
    "schedule_proactive_event",
    "schedule_low_score_reviews",
]
