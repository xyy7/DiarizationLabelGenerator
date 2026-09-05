"""SQLAlchemy models — the single source of truth for the database schema.

Schema changes go here, then through an Alembic migration
(``server/migrations/versions/``). ``alembic check`` in the test suite
guarantees models and database never drift; a failing check is the signal to
add the missing revision, not to hand-edit a database by hand.

This module mirrors the schema.sql this database started from, plus the
indexes and server defaults that schema.sql declared.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    Float,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    Text,
    func,
    text as sa_text,
)
from sqlalchemy.dialects.postgresql import CHAR, JSONB, UUID as PgUUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


def _uuid_pk() -> Mapped[uuid.UUID]:
    # server_default mirrors the DDL (gen_random_uuid is core PostgreSQL 13+);
    # alembic check compares server defaults, so omitting it is drift.
    return mapped_column(
        PgUUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=sa_text("gen_random_uuid()"),
    )


# Recording lifecycle. The worker owns queued -> running -> ready|failed;
# the API owns ready -> annotating -> done.
RECORDING_STATUSES = (
    "uploaded",
    "queued",
    "running",
    "ready",
    "annotating",
    "done",
    "failed",
)

JOB_STATUSES = ("queued", "running", "succeeded", "failed")


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = _uuid_pk()
    name: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class Recording(Base):
    __tablename__ = "recordings"

    id: Mapped[uuid.UUID] = _uuid_pk()
    session_name: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    original_name: Mapped[str] = mapped_column(Text, nullable=False)
    sha256: Mapped[str] = mapped_column(
        CHAR(64), unique=True, nullable=False
    )
    duration_sec: Mapped[float] = mapped_column(Float, nullable=False)
    status: Mapped[str] = mapped_column(
        Text, nullable=False, default="uploaded", server_default=sa_text("'uploaded'")
    )
    claimed_by: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )
    claimed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    annotation_version: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default=sa_text("0")
    )
    last_edited_by: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    speakers: Mapped[list["Speaker"]] = relationship(
        back_populates="recording",
        cascade="all, delete-orphan",
        order_by="Speaker.sort_order",
    )
    segments: Mapped[list["Segment"]] = relationship(
        back_populates="recording",
        cascade="all, delete-orphan",
        order_by="Segment.start_sec",
    )

    __table_args__ = (
        CheckConstraint(
            "status IN " + str(RECORDING_STATUSES), name="recordings_status_check"
        ),
        CheckConstraint("duration_sec > 0", name="recordings_duration_check"),
        Index("ix_recordings_status", "status"),
        Index(
            "ix_recordings_claimed_by",
            "claimed_by",
            postgresql_where=sa_text("claimed_by IS NOT NULL"),
        ),
    )


class Speaker(Base):
    __tablename__ = "speakers"

    recording_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("recordings.id", ondelete="CASCADE"),
        primary_key=True,
    )
    # Opaque stable key. Renames change `name`, never this.
    label: Mapped[str] = mapped_column(Text, primary_key=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    color: Mapped[str] = mapped_column(
        Text, nullable=False, default="#1890ff", server_default=sa_text("'#1890ff'")
    )
    sort_order: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default=sa_text("0")
    )

    recording: Mapped[Recording] = relationship(back_populates="speakers")


class Segment(Base):
    __tablename__ = "segments"

    id: Mapped[uuid.UUID] = _uuid_pk()
    recording_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("recordings.id", ondelete="CASCADE"),
        nullable=False,
    )
    speaker_label: Mapped[str] = mapped_column(Text, nullable=False)
    start_sec: Mapped[float] = mapped_column(Float, nullable=False)
    end_sec: Mapped[float] = mapped_column(Float, nullable=False)
    text: Mapped[str] = mapped_column(
        Text, nullable=False, default="", server_default=sa_text("''")
    )
    is_stable: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=sa_text("false")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    recording: Mapped[Recording] = relationship(back_populates="segments")

    __table_args__ = (
        CheckConstraint("start_sec >= 0", name="segments_start_check"),
        CheckConstraint("end_sec > start_sec", name="segments_order_check"),
        ForeignKeyConstraint(
            ["recording_id", "speaker_label"],
            ["speakers.recording_id", "speakers.label"],
            ondelete="CASCADE",
        ),
        Index("ix_segments_recording", "recording_id", "start_sec"),
    )


class SegmentEmbedding(Base):
    """Cached speaker embedding for one audio window.

    Keyed by content, not by segment id: rewriting an annotation replaces all
    segment rows, but the embedding of a window is unchanged unless its audio
    outcome changes -- i.e. the (start_sec, end_sec) pair or model_id.
    """

    __tablename__ = "segment_embeddings"

    recording_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("recordings.id", ondelete="CASCADE"),
        primary_key=True,
    )
    start_sec: Mapped[float] = mapped_column(Float, primary_key=True)
    end_sec: Mapped[float] = mapped_column(Float, primary_key=True)
    model_id: Mapped[str] = mapped_column(Text, nullable=False)
    embedding: Mapped[list] = mapped_column(JSONB, nullable=False)  # 192 floats
    computed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class Job(Base):
    __tablename__ = "jobs"

    id: Mapped[uuid.UUID] = _uuid_pk()
    recording_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("recordings.id", ondelete="CASCADE"),
        nullable=False,
    )
    status: Mapped[str] = mapped_column(
        Text, nullable=False, default="queued", server_default=sa_text("'queued'")
    )
    worker_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    attempts: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default=sa_text("0")
    )
    claimed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    heartbeat_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    finished_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    __table_args__ = (
        CheckConstraint("status IN " + str(JOB_STATUSES), name="jobs_status_check"),
        # One active job per recording, enforced by the database rather than by
        # a check-then-insert race in application code.
        Index(
            "uq_jobs_active",
            "recording_id",
            unique=True,
            postgresql_where=sa_text("status IN ('queued', 'running')"),
        ),
        Index("ix_jobs_claimable", "status", "created_at"),
    )


__all__ = [
    "Base",
    "User",
    "Recording",
    "Speaker",
    "Segment",
    "SegmentEmbedding",
    "Job",
    "RECORDING_STATUSES",
    "JOB_STATUSES",
]
