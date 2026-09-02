"""Worker loop: claim a job, run diarization, store the pre-labels.

Runs one job at a time. That is not a limitation to work around -- inference
saturates the CPU threads it was given, so a second concurrent job on the same
machine would make both slower and neither finish sooner.
"""

from __future__ import annotations

import logging
import os
import signal
import socket
import threading
import time
import uuid

from app.annotations import VersionConflict, save_annotation
from app.config import settings
from app.db import SessionLocal, init_schema
from app.domain import rttm_to_annotation
from app.ingest import wav_path_for
from app.models import Job, Recording
from app.rttm import parse
from app.worker import jobs
from app.worker.diarize import diarize, get_pipeline

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("worker")

WORKER_ID = f"{socket.gethostname()}:{os.getpid()}"

_stop = threading.Event()


def _handle_signal(signum, _frame):
    log.info("signal %s received; finishing the current job then exiting", signum)
    _stop.set()


class Heartbeat:
    """Keeps the claim alive while inference blocks.

    `pipeline()` is a long synchronous call, so the heartbeat cannot live on
    the main thread. Without it the job would look stalled after five minutes
    and another worker would start it again from scratch.
    """

    def __init__(self, job_id: uuid.UUID) -> None:
        self.job_id = job_id
        self._done = threading.Event()
        self._thread = threading.Thread(target=self._beat, daemon=True)

    def _beat(self) -> None:
        while not self._done.wait(settings.job_heartbeat_seconds):
            try:
                with SessionLocal() as db:
                    if not jobs.heartbeat(db, self.job_id, WORKER_ID):
                        log.warning(
                            "job %s is no longer ours; stopping heartbeat",
                            self.job_id,
                        )
                        return
            except Exception:
                # A transient database blip must not kill the run; the stale
                # window is ten missed beats wide.
                log.exception("heartbeat failed for job %s", self.job_id)

    def __enter__(self) -> "Heartbeat":
        self._thread.start()
        return self

    def __exit__(self, *exc) -> None:
        self._done.set()


def run_job(db, job: Job) -> None:
    recording = db.get(Recording, job.recording_id)
    if recording is None:
        raise RuntimeError(f"recording {job.recording_id} vanished")

    wav = wav_path_for(recording.id)
    if not wav.exists():
        raise RuntimeError(f"audio missing at {wav}")

    log.info(
        "diarizing %s (%.1fs of audio; expect roughly the same in wall clock)",
        recording.session_name, recording.duration_sec,
    )
    started = time.perf_counter()
    rttm_text = diarize(wav, recording.session_name)
    elapsed = time.perf_counter() - started

    _, turns = parse(rttm_text)
    speakers, segments = rttm_to_annotation(turns)

    # Same write path a human save takes: same validation, same clamping, same
    # version bump. Pre-labels get no shortcuts.
    try:
        version, adjustments = save_annotation(
            db,
            recording,
            expected_version=recording.annotation_version,
            speakers=speakers,
            segments=segments,
        )
    except VersionConflict as exc:
        # The version lock only saw the version from when inference started.
        # If a human saved or imported while inference was running, their
        # annotation supersedes ours -- overwriting it would discard real
        # corrections, and requeueing would just run inference again and
        # lose again. The stale result is dropped instead. (run_job raises
        # nothing, so main() marks the job succeeded without touching the
        # annotation.)
        log.warning(
            "%s: annotation already at version %d; discarding diarization "
            "output rather than overwriting concurrent edits",
            recording.session_name,
            exc.current_version,
        )
        return

    log.info(
        "%s: %d speakers, %d segments in %.0fs (%.2fx realtime) -> version %d%s",
        recording.session_name, len(speakers), len(segments), elapsed,
        elapsed / recording.duration_sec if recording.duration_sec else 0,
        version,
        f"; {len(adjustments)} segment(s) adjusted" if adjustments else "",
    )


def main() -> None:
    signal.signal(signal.SIGTERM, _handle_signal)
    signal.signal(signal.SIGINT, _handle_signal)

    init_schema()
    log.info("worker %s starting", WORKER_ID)

    # Load the model before taking any work, so the first job does not pay for
    # it and a broken install fails immediately instead of after a claim.
    get_pipeline()

    while not _stop.is_set():
        try:
            with SessionLocal() as db:
                job = jobs.claim_next_job(db, WORKER_ID)
                if job is None:
                    _stop.wait(settings.job_poll_seconds)
                    continue

                log.info("claimed job %s", job.id)
                try:
                    with Heartbeat(job.id):
                        run_job(db, job)
                except Exception as exc:
                    db.rollback()
                    jobs.mark_failed(db, job, f"{type(exc).__name__}: {exc}")
                    log.exception("job %s raised", job.id)
                else:
                    jobs.mark_succeeded(db, job)
                    log.info("job %s done", job.id)

        except Exception:
            # Never let the loop die: a database restart would otherwise leave
            # the queue with no consumer and no obvious reason why.
            log.exception("worker loop error; retrying shortly")
            _stop.wait(settings.job_poll_seconds)

    log.info("worker %s stopped", WORKER_ID)


if __name__ == "__main__":
    main()
