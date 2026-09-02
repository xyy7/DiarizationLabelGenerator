"""Persistence for annotations.

`save_annotation` is the ONLY write path for speakers and segments. The worker
uses it to store DiariZen's pre-labels; the API uses it to store a human's
corrections. Storing a pre-label is just a save that happens to originate from
a machine, so it gets the same validation, the same clamping, and the same
version bump. A second write path would be a second place for those to be
skipped.

The rules themselves live in app/domain.py, which has no database imports.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Sequence

from sqlalchemy import delete, insert, select, update

from app.domain import (
    Adjustment,
    SegmentIn,
    SpeakerIn,
    clamp_segments,
    validate_speakers,
)
from app.models import Recording, Segment, Speaker

log = logging.getLogger(__name__)


class VersionConflict(Exception):
    """Someone else saved since this client last read."""

    def __init__(self, current_version: int) -> None:
        super().__init__(f"annotation has moved on to version {current_version}")
        self.current_version = current_version


def load_annotation(db, recording_id: uuid.UUID) -> tuple[list[Speaker], list[Segment]]:
    speakers = list(
        db.execute(
            select(Speaker)
            .where(Speaker.recording_id == recording_id)
            .order_by(Speaker.sort_order, Speaker.label)
        ).scalars()
    )
    segments = list(
        db.execute(
            select(Segment)
            .where(Segment.recording_id == recording_id)
            .order_by(Segment.start_sec, Segment.speaker_label)
        ).scalars()
    )
    return speakers, segments


def save_annotation(
    db,
    recording: Recording,
    *,
    expected_version: int,
    speakers: Sequence[SpeakerIn],
    segments: Sequence[SegmentIn],
    edited_by: uuid.UUID | None = None,
) -> tuple[int, list[Adjustment]]:
    """Replace the whole annotation. Returns (new_version, adjustments).

    Whole-document replace rather than per-segment CRUD: a save is a few
    hundred rows, it is atomic, and it matches how the client works -- a local
    edit buffer with undo, flushed on a debounce.

    Raises VersionConflict if someone else saved first.
    """
    validate_speakers(speakers, segments)
    kept, adjustments = clamp_segments(segments, recording.duration_sec)

    for adj in adjustments:
        log.warning("recording %s: %s", recording.id, adj.describe())

    # The guarded UPDATE is the actual lock. Comparing versions in Python
    # first would leave a window for two savers to both pass the check and
    # then interleave their deletes and inserts.
    result = db.execute(
        update(Recording)
        .where(
            Recording.id == recording.id,
            Recording.annotation_version == expected_version,
        )
        .values(
            annotation_version=expected_version + 1,
            last_edited_by=edited_by,
            updated_at=datetime.now(timezone.utc),
        )
    )
    if result.rowcount == 0:
        db.rollback()
        current = db.execute(
            select(Recording.annotation_version).where(Recording.id == recording.id)
        ).scalar_one_or_none()
        raise VersionConflict(current if current is not None else -1)

    # Segments first: they hold the foreign key into speakers.
    db.execute(delete(Segment).where(Segment.recording_id == recording.id))
    db.execute(delete(Speaker).where(Speaker.recording_id == recording.id))

    if speakers:
        db.execute(
            insert(Speaker),
            [
                {
                    "recording_id": recording.id,
                    "label": s.label,
                    "name": s.name,
                    "color": s.color,
                    "sort_order": s.sort_order,
                }
                for s in speakers
            ],
        )
    if kept:
        db.execute(
            insert(Segment),
            [
                {
                    "id": s.id or uuid.uuid4(),
                    "recording_id": recording.id,
                    "speaker_label": s.speaker_label,
                    "start_sec": s.start_sec,
                    "end_sec": s.end_sec,
                    "text": s.text,
                    "is_stable": s.is_stable,
                }
                for s in kept
            ],
        )

    db.commit()
    db.refresh(recording)
    return recording.annotation_version, adjustments


__all__ = ["VersionConflict", "load_annotation", "save_annotation"]
