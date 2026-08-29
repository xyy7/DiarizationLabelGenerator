"""Request and response shapes."""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str


class JobOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    status: str
    attempts: int
    error: str | None = None
    created_at: datetime
    finished_at: datetime | None = None


class RecordingOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    session_name: str
    original_name: str
    duration_sec: float
    status: str
    annotation_version: int
    claimed_by: UserOut | None = None
    error: str | None = None
    created_at: datetime
    updated_at: datetime


class RecordingList(BaseModel):
    items: list[RecordingOut]
    total: int


class SpeakerIO(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    label: str
    name: str
    color: str = "#1890ff"
    sort_order: int = 0


class SegmentIO(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID | None = None
    speaker_label: str
    start_sec: float
    end_sec: float
    text: str = ""
    is_stable: bool = False


class AnnotationOut(BaseModel):
    version: int
    duration_sec: float
    speakers: list[SpeakerIO]
    segments: list[SegmentIO]


class AnnotationIn(BaseModel):
    # The version the client last read. A mismatch means someone else saved.
    version: int
    speakers: list[SpeakerIO]
    segments: list[SegmentIO]


class AdjustmentOut(BaseModel):
    """What the server had to change to store the annotation.

    Returned rather than silently applied so the client can tell the annotator
    that a boundary moved.
    """

    index: int
    reason: str
    before: tuple[float, float]
    after: tuple[float, float] | None


class AnnotationSaved(BaseModel):
    version: int
    adjustments: list[AdjustmentOut] = Field(default_factory=list)


class ClaimIn(BaseModel):
    force: bool = False


class SimilarityBody(BaseModel):
    """The window the annotator right-clicked; located by time, not by id.

    Time-based on purpose: the frontend may right-click a segment that has
    never reached the server (a tmp- id still pending autosave), and the
    embedding is a function of the audio in the window either way.
    """

    start_sec: float
    end_sec: float


class SimilarityClip(BaseModel):
    segment_id: uuid.UUID | None = None
    start_sec: float
    end_sec: float
    score: float
    short: bool = False


class SimilarityItem(BaseModel):
    """One speaker row: its representative score plus per-clip detail."""

    label: str
    name: str
    color: str
    best_score: float
    clips: list[SimilarityClip]


class SimilarityQuery(BaseModel):
    start_sec: float
    end_sec: float
    short: bool = False


class SimilarityResult(BaseModel):
    query: SimilarityQuery
    items: list[SimilarityItem]
    unranked: list[SpeakerIO]
    elapsed_ms: int = 0
