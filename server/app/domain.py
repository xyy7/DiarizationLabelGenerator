"""Annotation rules, with no database and no framework in sight.

These are the parts most likely to be wrong -- boundary clamping, label
validation, the mapping to and from RTTM -- so they are kept free of imports
that would need infrastructure to exercise. Everything here runs under a bare
`pytest` with nothing installed.
"""

from __future__ import annotations

import uuid
from collections import Counter
from dataclasses import dataclass, replace
from typing import Protocol, Sequence

from app.rttm import RttmSegment

# Matches the palette the frontend used, so imported pre-labels look familiar.
PALETTE = (
    "#1890ff", "#52c41a", "#faad14", "#f5222d", "#722ed1",
    "#13c2c2", "#eb2f96", "#fa8c16", "#a0d911", "#2f54eb",
)


class AnnotationError(ValueError):
    """Invalid annotation payload."""


@dataclass(frozen=True)
class SpeakerIn:
    label: str
    name: str
    color: str = PALETTE[0]
    sort_order: int = 0


@dataclass(frozen=True)
class SegmentIn:
    speaker_label: str
    start_sec: float
    end_sec: float
    text: str = ""
    id: uuid.UUID | None = None


class SegmentRow(Protocol):
    """Structural view of a stored segment, so this module needs no ORM."""

    speaker_label: str
    start_sec: float
    end_sec: float


@dataclass(frozen=True)
class Adjustment:
    """A segment the server had to change to make it storable.

    Reported rather than applied quietly. DiariZen routinely overruns the end
    of the audio -- its own example RTTM ends at 30.393 s for a 30.000 s file
    -- and truncating that in silence is precisely how a reference test set
    acquires errors that nobody ever notices.
    """

    index: int
    reason: str
    before: tuple[float, float]
    after: tuple[float, float] | None  # None => dropped entirely

    def describe(self) -> str:
        target = "dropped" if self.after is None else "%.3f-%.3f" % self.after
        return (
            f"segment {self.index}: {self.reason}: "
            f"{self.before[0]:.3f}-{self.before[1]:.3f} -> {target}"
        )


def clamp_segments(
    segments: Sequence[SegmentIn], duration_sec: float
) -> tuple[list[SegmentIn], list[Adjustment]]:
    """Fit segments inside [0, duration], reporting every change.

    A segment with no positive extent left after clamping is dropped, and the
    drop is reported too.
    """
    if duration_sec <= 0:
        raise AnnotationError(f"duration must be positive, got {duration_sec}")

    kept: list[SegmentIn] = []
    adjustments: list[Adjustment] = []

    for index, seg in enumerate(segments):
        start, end = seg.start_sec, seg.end_sec
        if end <= start:
            raise AnnotationError(
                f"segment {index}: end ({end}) must be greater than start ({start})"
            )

        new_start = max(0.0, start)
        new_end = min(duration_sec, end)

        if new_end <= new_start:
            adjustments.append(Adjustment(index, "outside audio", (start, end), None))
            continue

        if (new_start, new_end) != (start, end):
            adjustments.append(
                Adjustment(index, "clamped to audio", (start, end), (new_start, new_end))
            )
            seg = replace(seg, start_sec=new_start, end_sec=new_end)

        kept.append(seg)

    return kept, adjustments


def validate_speakers(
    speakers: Sequence[SpeakerIn], segments: Sequence[SegmentIn]
) -> None:
    """Labels unique, whitespace-free, and referenced only where declared.

    The whitespace rule exists because a label becomes RTTM field 8 in a
    whitespace-delimited format. Enforcing it at save time means an annotation
    can never reach a state that cannot be exported.
    """
    labels = [s.label for s in speakers]
    duplicates = sorted(
        label for label, count in Counter(labels).items() if count > 1
    )
    if duplicates:
        raise AnnotationError(f"duplicate speaker labels: {duplicates}")

    for speaker in speakers:
        if not speaker.label or any(ch.isspace() for ch in speaker.label):
            raise AnnotationError(
                f"speaker label must be non-empty and whitespace-free: "
                f"{speaker.label!r}"
            )

    unknown = sorted({s.speaker_label for s in segments} - set(labels))
    if unknown:
        raise AnnotationError(f"segments reference unknown speakers: {unknown}")


def segments_to_rttm(segments: Sequence[SegmentRow], uri: str) -> list[RttmSegment]:
    """Stored segments -> RTTM turns, in time order.

    `text` is deliberately not carried across; RTTM has no place for it.
    """
    ordered = sorted(segments, key=lambda s: (s.start_sec, s.speaker_label))
    return [
        RttmSegment(
            uri=uri,
            start=s.start_sec,
            duration=s.end_sec - s.start_sec,
            speaker=s.speaker_label,
        )
        for s in ordered
    ]


def rttm_to_annotation(
    turns: Sequence[RttmSegment],
) -> tuple[list[SpeakerIn], list[SegmentIn]]:
    """RTTM turns -> a fresh annotation.

    Labels are kept exactly as emitted (DiariZen produces bare integers like
    "0" and "3"); only the display name is prettified. The label is the stable
    key, so leaving it alone keeps a re-run comparable with the original.
    """
    labels = list(dict.fromkeys(t.speaker for t in turns))

    speakers = [
        SpeakerIn(
            label=label,
            name=f"说话人 {label}",
            color=PALETTE[i % len(PALETTE)],
            sort_order=i,
        )
        for i, label in enumerate(labels)
    ]
    segments = [
        SegmentIn(
            speaker_label=t.speaker,
            start_sec=t.start,
            end_sec=t.start + t.duration,
        )
        for t in turns
    ]
    return speakers, segments


__all__ = [
    "AnnotationError",
    "SpeakerIn",
    "SegmentIn",
    "SegmentRow",
    "Adjustment",
    "PALETTE",
    "clamp_segments",
    "validate_speakers",
    "segments_to_rttm",
    "rttm_to_annotation",
]
