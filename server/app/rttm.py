"""The single authoritative RTTM implementation for this system.

Every RTTM byte that enters (DiariZen pre-labels) or leaves (exported reference
test sets) goes through ``parse`` and ``serialize`` here. There is deliberately
no second code path, because the bug that motivated this rewrite was exactly
that: a serializer elsewhere that wrote the speaker index into the channel
field and appended transcription as an 11th field, producing files that scored
~100% DER against any hypothesis.

NIST RTTM is ten whitespace-separated fields:

    1 Type          always ``SPEAKER`` here
    2 File ID       the ``uri`` / session name
    3 Channel ID    always ``1`` -- the AUDIO channel, never the speaker index
    4 Turn Onset    seconds, %.3f
    5 Turn Duration seconds, %.3f
    6 Orthography   always ``<NA>``
    7 Speaker Type  always ``<NA>``
    8 Speaker Name  the diarization label
    9 Confidence    always ``<NA>``
   10 Signal Lookahead always ``<NA>``

Transcription text has no representation here at all. RTTM is a diarization
format; field 6 would be its conventional home, but keeping it permanently
``<NA>`` means text cannot leak into an evaluation file even by accident.
Subtitles will get their own format in phase 2.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Sequence

NA = "<NA>"
_TYPE = "SPEAKER"
_CHANNEL = "1"
_FIELD_COUNT = 10


@dataclass(frozen=True)
class RttmSegment:
    """One speaker turn. ``duration``, not end time -- RTTM stores duration."""

    uri: str
    start: float
    duration: float
    speaker: str

    @property
    def end(self) -> float:
        return self.start + self.duration


class RttmError(ValueError):
    """Raised for any malformed RTTM. Never used to skip a line silently."""


def _reject_whitespace(value: str, field: str) -> None:
    if not value:
        raise RttmError(f"{field} must not be empty")
    if any(ch.isspace() for ch in value):
        raise RttmError(f"{field} must not contain whitespace: {value!r}")


def serialize(uri: str, segments: Sequence[RttmSegment]) -> str:
    """Render segments as standard 10-field RTTM.

    Byte-compatible with pyannote.core's own writer, so a DiariZen file
    round-trips through parse/serialize unchanged. Segments are written in the
    order given -- callers that want time order must sort first.

    Raises RttmError if ``uri`` or any speaker label contains whitespace (such
    a file could not be parsed back, since fields are whitespace-separated).
    """
    _reject_whitespace(uri, "uri")

    lines = []
    for seg in segments:
        _reject_whitespace(seg.speaker, "speaker")
        if not math.isfinite(seg.start) or not math.isfinite(seg.duration):
            raise RttmError(
                f"non-finite start or duration: {seg.start} {seg.duration}"
            )
        if seg.start < 0:
            raise RttmError(f"negative start: {seg.start}")
        if seg.duration <= 0:
            raise RttmError(f"non-positive duration: {seg.duration}")
        if round(seg.duration, 3) == 0:
            # %.3f below renders "0.000", which our own parse rejects.
            raise RttmError(
                f"duration rounds to zero milliseconds: {seg.duration}"
            )
        lines.append(
            f"{_TYPE} {uri} {_CHANNEL} {seg.start:.3f} {seg.duration:.3f} "
            f"{NA} {NA} {seg.speaker} {NA} {NA}\n"
        )
    return "".join(lines)


def parse(text: str) -> tuple[str, list[RttmSegment]]:
    """Parse standard RTTM into ``(uri, segments)``.

    Accepts DiariZen's bare integer labels (``0``, ``3``) as readily as
    ``SPEAKER_00``; labels are opaque strings. Blank lines and ``;;`` comment
    lines are skipped.

    Everything else is a hard error -- a wrong field count, a non-SPEAKER
    record type, a channel other than 1, or turns from more than one file id.
    Nothing is dropped quietly: a file that does not parse is a file the
    operator needs to look at, not one to import three quarters of.

    An empty document yields ``("", [])``.
    """
    segments: list[RttmSegment] = []
    uri: str | None = None

    for lineno, raw in enumerate(text.splitlines(), start=1):
        line = raw.strip()
        if not line or line.startswith(";;"):
            continue

        fields = line.split()
        if len(fields) != _FIELD_COUNT:
            raise RttmError(
                f"line {lineno}: expected {_FIELD_COUNT} fields, got "
                f"{len(fields)}: {line!r}"
            )

        rec_type, file_id, channel, start_s, dur_s, _ortho, _stype, speaker, _conf, _slat = fields

        if rec_type != _TYPE:
            raise RttmError(f"line {lineno}: unsupported record type {rec_type!r}")
        if channel != _CHANNEL:
            raise RttmError(
                f"line {lineno}: channel must be {_CHANNEL} (the audio channel), "
                f"got {channel!r} -- a speaker index here breaks DER scoring"
            )
        if uri is None:
            uri = file_id
        elif file_id != uri:
            raise RttmError(
                f"line {lineno}: file id {file_id!r} differs from {uri!r}; "
                f"this parser handles one recording per document"
            )

        try:
            start = float(start_s)
            duration = float(dur_s)
        except ValueError as exc:
            raise RttmError(f"line {lineno}: bad timestamp: {line!r}") from exc

        if not math.isfinite(start) or not math.isfinite(duration):
            # NaN compares False against everything, so it slips past both
            # checks below and (via max/min quirk) clamps into a whole-file
            # segment. Never let a generator's NaN silent in.
            raise RttmError(
                f"line {lineno}: timestamp must be finite: {line!r}"
            )
        if start < 0:
            raise RttmError(f"line {lineno}: negative start {start}")
        if duration <= 0:
            raise RttmError(f"line {lineno}: non-positive duration {duration}")

        segments.append(
            RttmSegment(uri=uri, start=start, duration=duration, speaker=speaker)
        )

    return uri or "", segments


def sanitize_uri(name: str) -> str:
    """Make ``name`` usable as an RTTM file id.

    Whitespace becomes ``_`` and path separators are dropped, because the field
    is whitespace-delimited and ends up in a filename.
    """
    cleaned = "_".join(name.split())
    for bad in ("/", "\\"):
        cleaned = cleaned.replace(bad, "_")
    return cleaned


__all__ = ["RttmSegment", "RttmError", "serialize", "parse", "sanitize_uri"]
