"""Annotation rules: clamping, validation, and the RTTM mapping.

No database, no HTTP. These are the rules that decide whether the exported
test set is correct, so they are tested in isolation from everything that
could make them slow to run.
"""

from __future__ import annotations

import pytest

from app.domain import (
    AnnotationError,
    SegmentIn,
    SpeakerIn,
    clamp_segments,
    rttm_to_annotation,
    segments_to_rttm,
    validate_speakers,
)
from app.rttm import parse, serialize
from tests.conftest import GOLDEN_AUDIO_DURATION

DURATION = 30.0


def seg(start: float, end: float, label: str = "0") -> SegmentIn:
    return SegmentIn(speaker_label=label, start_sec=start, end_sec=end)


# ---------------------------------------------------------------------------
# Clamping
# ---------------------------------------------------------------------------

def test_segments_within_audio_are_untouched():
    kept, adjustments = clamp_segments([seg(1.0, 2.0), seg(5.0, 6.0)], DURATION)

    assert kept == [seg(1.0, 2.0), seg(5.0, 6.0)]
    assert adjustments == []


def test_diarizen_overrun_is_clamped_and_reported():
    """DiariZen's own example output ends past the end of the audio.

    The last turn of EN2002a_30s.rttm runs 23.453 + 6.940 = 30.393 s against a
    30.000 s file. The previous frontend clamped exactly this case with no
    signal at all, which is how a reference set quietly acquires wrong
    boundaries.
    """
    kept, adjustments = clamp_segments([seg(23.453, 30.393)], GOLDEN_AUDIO_DURATION)

    assert kept[0].end_sec == GOLDEN_AUDIO_DURATION
    assert len(adjustments) == 1
    assert adjustments[0].reason == "clamped to audio"
    assert adjustments[0].before == (23.453, 30.393)
    assert adjustments[0].after == (23.453, 30.0)
    assert "30.393" in adjustments[0].describe()


def test_golden_file_needs_exactly_one_clamp(golden_text):
    """Only the final turn overruns; nothing else should be touched."""
    _, turns = parse(golden_text)
    _, segments = rttm_to_annotation(turns)

    kept, adjustments = clamp_segments(segments, GOLDEN_AUDIO_DURATION)

    assert len(kept) == 13
    assert len(adjustments) == 1
    assert adjustments[0].index == 12


def test_negative_start_is_clamped():
    kept, adjustments = clamp_segments([seg(-0.5, 2.0)], DURATION)

    assert kept[0].start_sec == 0.0
    assert adjustments[0].after == (0.0, 2.0)


def test_nan_segment_is_rejected():
    # NaN would clamp into a whole-file segment via max/min compare quirks;
    # the rules decide correctness, so they refuse it loudly.
    with pytest.raises(AnnotationError, match="finite"):
        clamp_segments([seg(float("nan"), 2.0)], DURATION)
    with pytest.raises(AnnotationError, match="finite"):
        clamp_segments([seg(1.0, float("inf"))], DURATION)


def test_submillisecond_segment_is_dropped_loudly():
    # RTTM prints %.3f: a 0.0002 s segment would export as duration "0.000",
    # which the parser refuses on the way back in (and DER tools misread).
    kept, adjustments = clamp_segments([seg(1.0, 1.0002)], DURATION)

    assert kept == []
    assert len(adjustments) == 1
    assert adjustments[0].reason == "shorter than 1 ms"
    assert adjustments[0].after is None


def test_segment_entirely_past_the_end_is_dropped_loudly():
    kept, adjustments = clamp_segments([seg(1.0, 2.0), seg(40.0, 41.0)], DURATION)

    assert len(kept) == 1
    assert adjustments[0].reason == "outside audio"
    assert adjustments[0].after is None
    assert "dropped" in adjustments[0].describe()


def test_inverted_segment_is_an_error_not_a_clamp():
    with pytest.raises(AnnotationError, match="must be greater than start"):
        clamp_segments([seg(5.0, 5.0)], DURATION)


def test_zero_duration_audio_is_rejected():
    with pytest.raises(AnnotationError, match="duration must be positive"):
        clamp_segments([seg(0.0, 1.0)], 0.0)


def test_overlapping_segments_are_preserved():
    """Overlap is the phenomenon being annotated, not a defect to normalize."""
    overlapping = [seg(0.0, 10.0, "0"), seg(5.0, 12.0, "1")]

    kept, adjustments = clamp_segments(overlapping, DURATION)

    assert kept == overlapping
    assert adjustments == []


# ---------------------------------------------------------------------------
# Speaker validation
# ---------------------------------------------------------------------------

def test_accepts_a_consistent_annotation():
    speakers = [SpeakerIn("0", "A"), SpeakerIn("1", "B")]

    validate_speakers(speakers, [seg(0, 1, "0"), seg(1, 2, "1")])


def test_duplicate_labels_rejected():
    with pytest.raises(AnnotationError, match=r"duplicate speaker labels: \['0'\]"):
        validate_speakers([SpeakerIn("0", "A"), SpeakerIn("0", "B")], [])


def test_unknown_speaker_reference_rejected():
    with pytest.raises(AnnotationError, match=r"unknown speakers: \['ghost'\]"):
        validate_speakers([SpeakerIn("0", "A")], [seg(0, 1, "ghost")])


@pytest.mark.parametrize("label", ["has space", "", "tab\there"])
def test_unexportable_labels_rejected_at_save_time(label):
    """A label with whitespace could never be written to RTTM, so it must not
    be storable in the first place."""
    with pytest.raises(AnnotationError, match="whitespace-free"):
        validate_speakers([SpeakerIn(label, "A")], [])


# ---------------------------------------------------------------------------
# RTTM mapping
# ---------------------------------------------------------------------------

def test_diarizen_labels_survive_import_verbatim(golden_text):
    _, turns = parse(golden_text)
    speakers, _ = rttm_to_annotation(turns)

    assert [s.label for s in speakers] == ["0", "3", "1", "2"]
    assert [s.sort_order for s in speakers] == [0, 1, 2, 3]


def test_import_export_round_trip_reproduces_golden(golden_text):
    """DiariZen RTTM -> annotation -> RTTM must be byte-identical.

    This is the whole pre-labelling path in one assertion: if importing then
    exporting loses or shifts anything, the reference test set is wrong.
    """
    uri, turns = parse(golden_text)
    _, segments = rttm_to_annotation(turns)

    assert serialize(uri, segments_to_rttm(segments, uri)) == golden_text


def test_export_sorts_by_time():
    out = segments_to_rttm([seg(5.0, 6.0, "1"), seg(1.0, 2.0, "0")], "rec")

    assert [s.start for s in out] == [1.0, 5.0]


def test_export_drops_text():
    with_text = SegmentIn("0", 0.0, 1.0, text="今天天气不错")

    line = serialize("rec", segments_to_rttm([with_text], "rec"))

    assert "今天天气不错" not in line
    assert line.split()[5] == "<NA>"


def test_overlapping_turns_round_trip_through_rttm():
    """Two speakers over the same window survive export -> import unchanged.

    Multi-speaker overlap is recorded as two turns sharing a time range; the
    serializer is the single path every byte leaves through, so it must not
    mangle it.
    """
    turns = segments_to_rttm(
        [SegmentIn("0", 0.0, 10.0), SegmentIn("1", 0.0, 10.0)], "rec"
    )

    uri, parsed = parse(serialize("rec", turns))

    assert uri == "rec"
    assert parsed == turns


def test_stable_flag_never_reaches_rttm():
    """is_stable is annotation metadata; the RTTM bytes must not change."""
    plain = serialize(
        "rec", segments_to_rttm([SegmentIn("0", 0.0, 1.0)], "rec")
    )
    stable = serialize(
        "rec", segments_to_rttm([SegmentIn("0", 0.0, 1.0, is_stable=True)], "rec")
    )

    assert stable == plain
