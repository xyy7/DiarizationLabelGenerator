"""The job queue: PostgreSQL, no broker.

The UI has to show job state anyway, so it has to be in the database anyway.
Adding Redis would mean the same facts live in two places and can disagree.
At this scale -- a handful of jobs in flight, one worker, each job running ten
to forty minutes -- `FOR UPDATE SKIP LOCKED` is the whole scheduler.

Crash recovery lives here rather than in the worker process, which is the point:
a worker killed mid-job cannot clean up after itself, so the row it left behind
has to be reclaimable by whoever comes next.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import text

from app.config import settings
from app.models import Job, Recording

log = logging.getLogger(__name__)

# A claimable job is queued, or running but silent for longer than the worker's
# heartbeat interval by a wide margin.
_CLAIM_SQL = text(
    """
    WITH candidate AS (
        SELECT id FROM jobs
         WHERE (status = 'queued'
                OR (status = 'running' AND heartbeat_at < now() - :stale))
           AND attempts < :max_attempts
         ORDER BY created_at
         LIMIT 1
         FOR UPDATE SKIP LOCKED
    )
    UPDATE jobs
       SET status = 'running',
           worker_id = :worker_id,
           claimed_at = now(),
           heartbeat_at = now(),
           error = NULL,
           -- Only a reclaim spends an attempt. Counting the first run would
           -- give a job two tries, not three.
           attempts = attempts + (CASE WHEN status = 'running' THEN 1 ELSE 0 END)
     WHERE id IN (SELECT id FROM candidate)
    RETURNING id
    """
)


def claim_next_job(
    db,
    worker_id: str,
    stale_after: timedelta | None = None,
    max_attempts: int | None = None,
) -> Job | None:
    """Take the oldest claimable job, or return None if there is nothing to do.

    SKIP LOCKED means concurrent workers step over each other's candidates
    rather than blocking, so this stays correct if a second (GPU) worker is
    added later without any code change.
    """
    stale_after = stale_after or settings.job_stale_after
    max_attempts = max_attempts or settings.job_max_attempts

    row = db.execute(
        _CLAIM_SQL,
        {
            "stale": stale_after,
            "max_attempts": max_attempts,
            "worker_id": worker_id,
        },
    ).first()

    if row is None:
        db.commit()
        return None

    # populate_existing is essential, not tidiness: the UPDATE above went
    # straight to the database, so any copy already in the session's identity
    # map still says 'queued'. Handing that stale object back would make the
    # next ORM write believe status is unchanged and omit it from its UPDATE,
    # leaving the row 'running' forever.
    job = db.get(Job, row.id, populate_existing=True)
    recording = db.get(Recording, job.recording_id, populate_existing=True)
    if recording is not None:
        # Clears a stale 'running' left by a crashed worker so the list view
        # never shows a state nobody is working on.
        recording.status = "running"
        recording.updated_at = datetime.now(timezone.utc)
    db.commit()

    if job.attempts:
        # Either a previous run raised, or a worker died holding this row.
        log.warning(
            "job %s retrying after %d failed run(s)", job.id, job.attempts
        )
    return job


def heartbeat(db, job_id: uuid.UUID, worker_id: str) -> bool:
    """Mark the job alive. Returns False if it is no longer ours.

    Losing the row means another worker reclaimed it -- the local run should
    stop rather than write a result that would race the new owner.
    """
    result = db.execute(
        text(
            "UPDATE jobs SET heartbeat_at = now() "
            " WHERE id = :id AND worker_id = :worker_id AND status = 'running'"
        ),
        {"id": job_id, "worker_id": worker_id},
    )
    db.commit()
    # Same hazard as in claim_next_job: this bypassed the ORM, so drop any
    # cached copy rather than let it drift.
    db.expire_all()
    return result.rowcount == 1


def mark_succeeded(db, job: Job) -> None:
    job.status = "succeeded"
    job.finished_at = datetime.now(timezone.utc)
    job.error = None
    recording = db.get(Recording, job.recording_id)
    if recording is not None:
        recording.status = "ready"
        recording.error = None
        recording.updated_at = datetime.now(timezone.utc)
    db.commit()


def mark_failed(db, job: Job, error: str) -> None:
    """Record a failure and either requeue or give up.

    `attempts` counts runs that did not succeed, whether they ended in an
    exception here or in a worker that died and had its job reclaimed by the
    stale branch of the claim query. Incrementing in exactly one of those two
    places would let the other retry forever: a requeued job comes back through
    the `status = 'queued'` branch, which does not increment.
    """
    message = error[:2000]
    job.attempts += 1
    job.error = message
    job.finished_at = datetime.now(timezone.utc)
    job.worker_id = None

    exhausted = job.attempts >= settings.job_max_attempts
    job.status = "failed" if exhausted else "queued"

    recording = db.get(Recording, job.recording_id)
    if recording is not None and exhausted:
        recording.status = "failed"
        recording.error = message
        recording.updated_at = datetime.now(timezone.utc)

    db.commit()
    log.error(
        "job %s failed (attempt %d/%d)%s: %s",
        job.id, job.attempts, settings.job_max_attempts,
        "" if not exhausted else " - giving up", message,
    )


__all__ = ["claim_next_job", "heartbeat", "mark_succeeded", "mark_failed"]
