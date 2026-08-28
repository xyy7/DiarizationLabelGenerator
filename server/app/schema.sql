-- Schema for the diarization annotation server.
--
-- Idempotent: every process runs this at startup. There is no migration tool
-- yet, which is fine only while the database holds nothing that cannot be
-- rebuilt. Before the phase-2 subtitle work changes any of these tables,
-- introduce Alembic -- by then this database will contain hand-corrected
-- annotations representing tens of hours of irreplaceable human effort.
--
-- Statuses are TEXT + CHECK rather than native ENUMs: adding a value to a
-- CHECK is an ordinary ALTER, adding one to an ENUM is a migration ritual.

CREATE TABLE IF NOT EXISTS users (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name       TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS recordings (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Doubles as the RTTM file id, so it must survive sanitize_uri().
    session_name       TEXT NOT NULL UNIQUE,
    original_name      TEXT NOT NULL,
    -- Hash of the bytes as uploaded, before normalization: the same audio as
    -- mp3 and as flac are genuinely different sources, not duplicates.
    sha256             CHAR(64) NOT NULL UNIQUE,
    -- Measured from the normalized wav, which is also what is served and what
    -- the model sees. One file, one duration, nothing to disagree about.
    duration_sec       DOUBLE PRECISION NOT NULL,
    status             TEXT NOT NULL DEFAULT 'uploaded',
    claimed_by         UUID REFERENCES users(id),
    claimed_at         TIMESTAMPTZ,
    -- Optimistic lock for the whole-annotation PUT.
    annotation_version INTEGER NOT NULL DEFAULT 0,
    last_edited_by     UUID REFERENCES users(id),
    error              TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT recordings_status_check CHECK (status IN (
        'uploaded', 'queued', 'running', 'ready', 'annotating', 'done', 'failed'
    )),
    CONSTRAINT recordings_duration_check CHECK (duration_sec > 0)
);

CREATE INDEX IF NOT EXISTS ix_recordings_status ON recordings (status);
CREATE INDEX IF NOT EXISTS ix_recordings_claimed_by
    ON recordings (claimed_by) WHERE claimed_by IS NOT NULL;

-- An annotation is not a table: it IS the speakers and segments of a
-- recording. One annotation per recording is therefore not a rule anybody has
-- to enforce -- a second one cannot be expressed.
CREATE TABLE IF NOT EXISTS speakers (
    recording_id UUID NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
    -- Stable opaque key, never rewritten. DiariZen's bare integers ("0", "3")
    -- are stored as-is; renaming a speaker touches `name` only.
    label        TEXT NOT NULL,
    name         TEXT NOT NULL,
    color        TEXT NOT NULL DEFAULT '#1890ff',
    sort_order   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (recording_id, label)
);

CREATE TABLE IF NOT EXISTS segments (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recording_id  UUID NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
    speaker_label TEXT NOT NULL,
    start_sec     DOUBLE PRECISION NOT NULL,
    end_sec       DOUBLE PRECISION NOT NULL,
    -- Phase 2 (subtitles). Never reaches RTTM: see app/rttm.py.
    text          TEXT NOT NULL DEFAULT '',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT segments_start_check CHECK (start_sec >= 0),
    CONSTRAINT segments_order_check CHECK (end_sec > start_sec),
    FOREIGN KEY (recording_id, speaker_label)
        REFERENCES speakers (recording_id, label) ON DELETE CASCADE
);

-- Deliberately no exclusion constraint against overlap. Overlapping speech is
-- not corruption, it is the phenomenon being annotated: DiariZen's powerset
-- model emits up to two concurrent speakers, and those regions are the ones
-- diarization evaluation cares about most.
CREATE INDEX IF NOT EXISTS ix_segments_recording
    ON segments (recording_id, start_sec);

CREATE TABLE IF NOT EXISTS jobs (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recording_id UUID NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
    status       TEXT NOT NULL DEFAULT 'queued',
    worker_id    TEXT,
    -- Incremented only when a stale job is re-claimed, so a first run does not
    -- consume an attempt.
    attempts     INTEGER NOT NULL DEFAULT 0,
    claimed_at   TIMESTAMPTZ,
    heartbeat_at TIMESTAMPTZ,
    error        TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at  TIMESTAMPTZ,
    CONSTRAINT jobs_status_check CHECK (status IN (
        'queued', 'running', 'succeeded', 'failed'
    ))
);

-- One active job per recording, enforced by the database rather than by a
-- check-then-insert race in application code.
CREATE UNIQUE INDEX IF NOT EXISTS uq_jobs_active
    ON jobs (recording_id) WHERE status IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS ix_jobs_claimable
    ON jobs (status, created_at);
