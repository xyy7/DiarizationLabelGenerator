"""Tests for the authoritative RTTM module.

Several of these are regression tests for specific defects in the previous
frontend serializer (ADG/src/utils/label.ts), which wrote the speaker index
into the channel field and appended transcription as an 11th field. Both are
asserted against here so they cannot come back.
"""

from __future__ import annotations

import pytest

from app.rttm import RttmError, RttmSegment, parse, sanitize_uri, serialize

URI = "EN2002a_30s"


# --------------------------------------------------------------------------
# Golden file: real DiariZen output
# --------------------------------------------------------------------------

def test_parse_golden(golden_text):
    uri, segs = parse(golden_text)

    assert uri == URI
    assert len(segs) == 13
    assert segs[0] == RttmSegment(URI, 0.013, 2.640, "0")
    assert segs[-1] == RttmSegment(URI, 23.453, 6.940, "2")


def test_golden_has_integer_labels_out_of_order(golden_text):
    """DiariZen labels are clustering artifacts: bare integers, first seen in
    arbitrary order. The parser must not assume ordering or a naming scheme."""
    _, segs = parse(golden_text)
    first_seen = list(dict.fromkeys(s.speaker for s in segs))

    assert set(first_seen) == {"0", "1", "2", "3"}
    assert first_seen == ["0", "3", "1", "2"]


def test_golden_contains_overlapping_speech(golden_text):
    """The powerset model emits up to 2 concurrent speakers. Overlap is the
    interesting case for diarization, so it must survive parsing intact."""
    _, segs = parse(golden_text)

    long_turn = next(s for s in segs if s.speaker == "3" and s.start == 0.792)
    overlapping = [
        s for s in segs
        if s.speaker != "3" and s.start < long_turn.end and s.end > long_turn.start
    ]

    assert len(overlapping) >= 4


def test_roundtrip_text_exact(golden_text):
    """Property 1: serialize(parse(t)) reproduces t byte for byte."""
    uri, segs = parse(golden_text)

    assert serialize(uri, segs) == golden_text


def test_roundtrip_structural(golden_text):
    """Property 2: parse(serialize(s)) recovers the segments.

    Kept separate from the text-level property because "%.3f" then float() is
    not bit-exact for arbitrary doubles -- 0.013 has no exact binary form -- so
    equality here has to be approximate on the timestamps and exact elsewhere.
    """
    _, original = parse(golden_text)
    _, again = parse(serialize(URI, original))

    assert len(again) == len(original)
    for a, b in zip(again, original):
        assert a.speaker == b.speaker
        assert a.uri == b.uri
        assert a.start == pytest.approx(b.start, abs=5e-4)
        assert a.duration == pytest.approx(b.duration, abs=5e-4)


def test_crlf_input_parses_identically(golden_text):
    """DiariZen run on Windows writes CRLF (Python text mode). Same result."""
    crlf = golden_text.replace("\n", "\r\n")

    assert parse(crlf) == parse(golden_text)


# --------------------------------------------------------------------------
# Field-level invariants
# --------------------------------------------------------------------------

def test_every_line_has_exactly_ten_fields(golden_text):
    _, segs = parse(golden_text)

    for line in serialize(URI, segs).splitlines():
        assert len(line.split()) == 10, line


def test_channel_field_is_always_one(golden_text):
    """Field 3 is the AUDIO channel, not the speaker index.

    Writing the speaker index here is the defect that made the old exports
    unusable: md-eval pairs reference and hypothesis by channel, so every
    speaker beyond the first scored as a complete miss.
    """
    _, segs = parse(golden_text)

    for line in serialize(URI, segs).splitlines():
        assert line.split()[2] == "1", line


def test_channel_other_than_one_is_rejected():
    """The old broken output must not be silently readable back."""
    with pytest.raises(RttmError, match="channel must be 1"):
        parse("SPEAKER rec 2 0.000 1.000 <NA> <NA> spk1 <NA> <NA>\n")


def test_eleven_fields_is_an_error():
    """The old serializer appended transcription as a field 11."""
    with pytest.raises(RttmError, match="expected 10 fields, got 11"):
        parse("SPEAKER rec 1 0.000 1.000 <NA> <NA> spk1 <NA> <NA> hello\n")


def test_nine_fields_is_an_error():
    with pytest.raises(RttmError, match="expected 10 fields, got 9"):
        parse("SPEAKER rec 1 0.000 1.000 <NA> <NA> spk1 <NA>\n")


def test_orthography_field_stays_na():
    """Transcription has no route into RTTM, so it cannot leak into an
    evaluation file. Segment text lives in the database only."""
    out = serialize("rec", [RttmSegment("rec", 0.0, 1.0, "spk1")])

    assert out.split()[5] == "<NA>"
    assert "hello" not in out


# --------------------------------------------------------------------------
# Label handling
# --------------------------------------------------------------------------

@pytest.mark.parametrize("label", ["0", "3", "SPEAKER_00", "张三", "spk-1"])
def test_labels_are_opaque_strings(label):
    text = f"SPEAKER rec 1 0.000 1.000 <NA> <NA> {label} <NA> <NA>\n"
    _, segs = parse(text)

    assert segs[0].speaker == label
    assert serialize("rec", segs) == text


def test_whitespace_in_speaker_is_rejected():
    with pytest.raises(RttmError, match="speaker must not contain whitespace"):
        serialize("rec", [RttmSegment("rec", 0.0, 1.0, "speaker one")])


def test_whitespace_in_uri_is_rejected():
    with pytest.raises(RttmError, match="uri must not contain whitespace"):
        serialize("my rec", [])


# --------------------------------------------------------------------------
# Degenerate and hostile input
# --------------------------------------------------------------------------

def test_empty_document():
    assert parse("") == ("", [])


def test_blank_and_comment_lines_are_skipped():
    text = (
        ";; generated by something\n"
        "\n"
        "SPEAKER rec 1 0.000 1.000 <NA> <NA> spk1 <NA> <NA>\n"
        "   \n"
    )
    _, segs = parse(text)

    assert len(segs) == 1


def test_mixed_file_ids_are_rejected():
    """One document, one recording. Quietly keeping the first uri would
    silently drop the rest of the file."""
    text = (
        "SPEAKER recA 1 0.000 1.000 <NA> <NA> spk1 <NA> <NA>\n"
        "SPEAKER recB 1 2.000 1.000 <NA> <NA> spk1 <NA> <NA>\n"
    )
    with pytest.raises(RttmError, match="differs from"):
        parse(text)


def test_non_speaker_record_type_is_rejected():
    with pytest.raises(RttmError, match="unsupported record type"):
        parse("SPKR-INFO rec 1 0.000 1.000 <NA> <NA> spk1 <NA> <NA>\n")


def test_unparseable_timestamp_is_rejected():
    with pytest.raises(RttmError, match="bad timestamp"):
        parse("SPEAKER rec 1 start 1.000 <NA> <NA> spk1 <NA> <NA>\n")


@pytest.mark.parametrize("duration", ["0.000", "-1.000"])
def test_non_positive_duration_is_rejected(duration):
    with pytest.raises(RttmError, match="non-positive duration"):
        parse(f"SPEAKER rec 1 0.000 {duration} <NA> <NA> spk1 <NA> <NA>\n")


def test_negative_start_is_rejected():
    with pytest.raises(RttmError, match="negative start"):
        parse("SPEAKER rec 1 -0.500 1.000 <NA> <NA> spk1 <NA> <NA>\n")


def test_serialize_rejects_non_positive_duration():
    with pytest.raises(RttmError, match="non-positive duration"):
        serialize("rec", [RttmSegment("rec", 1.0, 0.0, "spk1")])


def test_parse_rejects_nan_timestamp():
    # NaN compares False against both checks below; without the finite guard
    # it clamps into a whole-file segment.
    with pytest.raises(RttmError, match="finite"):
        parse("SPEAKER rec 1 nan 1.000 <NA> <NA> spk1 <NA> <NA>\n")


def test_parse_rejects_inf_timestamp():
    with pytest.raises(RttmError, match="finite"):
        parse("SPEAKER rec 1 1.000 inf <NA> <NA> spk1 <NA> <NA>\n")


def test_serialize_rejects_non_finite():
    with pytest.raises(RttmError, match="non-finite"):
        serialize("rec", [RttmSegment("rec", float("nan"), 1.0, "spk1")])
    with pytest.raises(RttmError, match="non-finite"):
        serialize("rec", [RttmSegment("rec", 1.0, float("inf"), "spk1")])


def test_serialize_rejects_duration_that_rounds_to_zero():
    # %.3f would render "0.000", a duration our own parser refuses.
    with pytest.raises(RttmError, match="zero milliseconds"):
        serialize("rec", [RttmSegment("rec", 1.0, 0.0002, "spk1")])


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------

@pytest.mark.parametrize(
    "raw,expected",
    [
        ("my file", "my_file"),
        ("  padded  ", "padded"),
        ("a/b\\c", "a_b_c"),
        ("tabs\there", "tabs_here"),
    ],
)
def test_sanitize_uri(raw, expected):
    assert sanitize_uri(raw) == expected
