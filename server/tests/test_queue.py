"""Job queue behaviour: claiming, heartbeats, crash recovery, retry limits.

Requires real PostgreSQL -- SKIP LOCKED and the partial unique index have no
sqlite equivalent and both are load-bearing.
"""

from __future__ import annotations

import uuid
from datetime import timedelta

import pytest

pytest.importorskip("sqlalchemy")

from sqlalchemy import text  # noqa: E402

from app.config import settings  # noqa: E402
from app.db import SessionLocal, engine, init_schema  # noqa: E402
from app.models import Job, Recording  # noqa: E402
from app.worker import jobs  # noqa: E402

STALE = timedelta(minutes=5)


@pytest.fixture(scope="session", autouse=True)
def _schema():
    init_schema()


@pytest.fixture(autouse=True)
def _clean():
    with engine.begin() as conn:
        conn.execute(text("TRUNCATE recordings, users CASCADE"))
    yield


@pytest.fixture
def db():
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


def make_recording(db, name: str = "rec") -> Recording:
    recording = Recording(
        session_name=name,
        original_name=f"{name}.wav",
        sha256=uuid.uuid4().hex + uuid.uuid4().hex,
        duration_sec=30.0,
        status="uploaded",
    )
    db.add(recording)
    db.commit()
    db.refresh(recording)
    return recording


def queue_job(db, recording: Recording) -> Job:
    job = Job(recording_id=recording.id, status="queued")
    db.add(job)
    db.commit()
    db.refresh(job)
    return job


def go_stale(db, job: Job, minutes: int = 10) -> None:
    """Simulate a worker that died holding this job."""
    db.execute(
        text(
            "UPDATE jobs SET status='running', worker_id='dead-worker', "
            "heartbeat_at = now() - make_interval(mins => :m) WHERE id = :id"
        ),
        {"m": minutes, "id": job.id},
    )
    db.commit()


# ---------------------------------------------------------------------------
# Claiming
# ---------------------------------------------------------------------------

def test_nothing_to_claim_returns_none(db):
    assert jobs.claim_next_job(db, "w1") is None


def test_claim_is_fifo(db):
    first = queue_job(db, make_recording(db, "a"))
    queue_job(db, make_recording(db, "b"))

    claimed = jobs.claim_next_job(db, "w1")

    assert claimed.id == first.id
    assert claimed.status == "running"
    assert claimed.worker_id == "w1"


def test_first_claim_does_not_spend_an_attempt(db):
    """Counting the first run would give a job max_attempts-1 real tries."""
    queue_job(db, make_recording(db))

    claimed = jobs.claim_next_job(db, "w1")

    assert claimed.attempts == 0


def test_claim_marks_the_recording_running(db):
    recording = make_recording(db)
    queue_job(db, recording)

    jobs.claim_next_job(db, "w1")

    db.refresh(recording)
    assert recording.status == "running"


def test_two_workers_never_claim_the_same_job(db):
    """SKIP LOCKED: the second worker steps over the locked row."""
    queue_job(db, make_recording(db))

    other = SessionLocal()
    try:
        first = jobs.claim_next_job(db, "w1")
        second = jobs.claim_next_job(other, "w2")
    finally:
        other.close()

    assert first is not None
    assert second is None


# ---------------------------------------------------------------------------
# Crash recovery
# ---------------------------------------------------------------------------

def test_stale_running_job_is_reclaimed(db):
    """A worker killed mid-job leaves a row nobody is working on. Recovery
    lives in the database precisely because that process cannot run it."""
    job = queue_job(db, make_recording(db))
    go_stale(db, job)

    reclaimed = jobs.claim_next_job(db, "w2")

    assert reclaimed is not None
    assert reclaimed.id == job.id
    assert reclaimed.worker_id == "w2"
    assert reclaimed.attempts == 1


def test_a_live_running_job_is_left_alone(db):
    job = queue_job(db, make_recording(db))
    jobs.claim_next_job(db, "w1")  # fresh heartbeat

    assert jobs.claim_next_job(db, "w2") is None


def test_exhausted_job_is_not_reclaimed(db):
    job = queue_job(db, make_recording(db))
    db.execute(
        text("UPDATE jobs SET attempts = :n WHERE id = :id"),
        {"n": settings.job_max_attempts, "id": job.id},
    )
    db.commit()
    go_stale(db, job)

    assert jobs.claim_next_job(db, "w2") is None


# ---------------------------------------------------------------------------
# Heartbeat
# ---------------------------------------------------------------------------

def test_heartbeat_keeps_the_claim(db):
    queue_job(db, make_recording(db))
    job = jobs.claim_next_job(db, "w1")
    db.execute(
        text("UPDATE jobs SET heartbeat_at = now() - interval '10 minutes' WHERE id=:i"),
        {"i": job.id},
    )
    db.commit()

    assert jobs.heartbeat(db, job.id, "w1") is True
    assert jobs.claim_next_job(db, "w2") is None


def test_heartbeat_reports_a_lost_claim(db):
    """If another worker took over, the local run must stop rather than race
    the new owner to write a result."""
    job = queue_job(db, make_recording(db))
    go_stale(db, job)
    jobs.claim_next_job(db, "w2")

    assert jobs.heartbeat(db, job.id, "dead-worker") is False


# ---------------------------------------------------------------------------
# Failure accounting
# ---------------------------------------------------------------------------

def test_failure_requeues_until_attempts_run_out(db):
    """Regression: attempts is incremented both by mark_failed and by the
    stale branch of the claim query. Incrementing in only one of them let a
    job that always raises retry forever, because a requeued job comes back
    through the 'queued' branch, which does not increment.
    """
    recording = make_recording(db)
    queue_job(db, recording)

    seen = 0
    while (job := jobs.claim_next_job(db, "w1")) is not None:
        seen += 1
        assert seen <= settings.job_max_attempts + 1, "job is retrying forever"
        jobs.mark_failed(db, job, "boom")

    assert seen == settings.job_max_attempts

    db.refresh(recording)
    assert recording.status == "failed"
    assert recording.error == "boom"


def test_intermediate_failure_leaves_the_recording_alone(db):
    """One transient failure is not news for the operator."""
    recording = make_recording(db)
    queue_job(db, recording)
    job = jobs.claim_next_job(db, "w1")

    jobs.mark_failed(db, job, "transient")

    db.refresh(recording)
    assert recording.status != "failed"
    assert job.status == "queued"


def test_success_marks_the_recording_ready(db):
    recording = make_recording(db)
    queue_job(db, recording)
    job = jobs.claim_next_job(db, "w1")

    jobs.mark_succeeded(db, job)

    db.refresh(recording)
    assert job.status == "succeeded"
    assert job.finished_at is not None
    assert recording.status == "ready"


def test_requeued_job_still_blocks_a_second_enqueue(db):
    """uq_jobs_active covers queued and running, so a retrying job must not
    let a duplicate slip in behind it."""
    from sqlalchemy.exc import IntegrityError

    recording = make_recording(db)
    queue_job(db, recording)
    job = jobs.claim_next_job(db, "w1")
    jobs.mark_failed(db, job, "boom")  # back to 'queued'

    db.add(Job(recording_id=recording.id, status="queued"))
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()
