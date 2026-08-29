"""SQLAlchemy models mirroring schema.sql.

schema.sql is the source of truth for the database; these classes exist to give
the application typed access to it. When the two drift, schema.sql wins.
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
    Integer,
    String,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID as PgUUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


def _uuid_pk() -> Mapped[uuid.UUID]:
    return mapped_column(PgUUID(as_uuid=True), primary_key=True, default=uuid.uuid4)


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
    sha256: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    duration_sec: Mapped[float] = mapped_column(Float, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="uploaded")
    claimed_by: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )
    claimed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    annotation_version: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0
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
    color: Mapped[str] = mapped_column(Text, nullable=False, default="#1890ff")
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

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
    text: Mapped[str] = mapped_column(Text, nullable=False, default="")
    is_stable: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
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
    )


class SegmentEmbedding(Base):
    """Cached speaker embedding for one audio window (see schema.sql).

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
    status: Mapped[str] = mapped_column(Text, nullable=False, default="queued")
    worker_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
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
