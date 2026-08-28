"""Runtime configuration, read once from the environment.

Every value has a default that works for a local `docker compose up`; nothing
here reads a config file, so the compose file is the single place deployment
settings live.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path


def _int(name: str, default: int) -> int:
    return int(os.environ.get(name, default))


@dataclass(frozen=True)
class Settings:
    database_url: str = os.environ.get(
        "DATABASE_URL", "postgresql+psycopg://adg:adg@db:5432/adg"
    )

    # Bind-mounted volume shared by api and worker.
    data_dir: Path = Path(os.environ.get("DATA_DIR", "/data"))

    # Read-only in the worker; populated once by the seed-models container.
    models_dir: Path = Path(os.environ.get("MODELS_DIR", "/models"))

    # 10 ms per bin. Deliberately not the more common 10 bins/sec: the core
    # annotation action is aligning a boundary to within ~10 ms, and at 10
    # bins/sec (100 ms) the waveform simply does not show where speech starts.
    peaks_per_second: int = _int("PEAKS_PER_SECOND", 100)

    # 10 h of 16 kHz mono wav is ~1.1 GB; this leaves generous headroom.
    max_upload_bytes: int = _int("MAX_UPLOAD_BYTES", 8 * 1024**3)

    # Diarization runs at ~1x realtime, so a job may legitimately occupy a
    # worker for 40 minutes. The worker heartbeats every 30 s from a separate
    # thread (pipeline() blocks); 5 minutes is 10 missed beats.
    torch_num_threads: int = _int("TORCH_NUM_THREADS", 10)
    job_heartbeat_seconds: int = _int("JOB_HEARTBEAT_SECONDS", 30)
    job_stale_after: timedelta = timedelta(minutes=_int("JOB_STALE_MINUTES", 5))
    job_max_attempts: int = _int("JOB_MAX_ATTEMPTS", 3)
    job_poll_seconds: int = _int("JOB_POLL_SECONDS", 2)

    # A claim left behind by someone who wandered off can be taken over.
    claim_stale_hours: int = _int("CLAIM_STALE_HOURS", 2)

    @property
    def audio_dir(self) -> Path:
        return self.data_dir / "audio"

    @property
    def tmp_dir(self) -> Path:
        return self.data_dir / "tmp"

    @property
    def export_dir(self) -> Path:
        return self.data_dir / "exports"


settings = Settings()
