"""API and persistence tests. Require a real PostgreSQL.

SKIP LOCKED and partial unique indexes have no sqlite equivalent, and both are
load-bearing here, so there is no in-memory shortcut. Run them with:

    docker compose --profile test run --rm test
"""

from __future__ import annotations

import struct
import wave

import pytest

pytest.importorskip("fastapi", reason="API tests run inside the container")
pytest.importorskip("sqlalchemy")

import math  # noqa: E402

from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import text  # noqa: E402

from app.db import SessionLocal, engine, init_schema  # noqa: E402
from app.main import app  # noqa: E402

HEADERS = {"X-User-Name": "tester"}


@pytest.fixture(scope="session", autouse=True)
def _schema():
    init_schema()


@pytest.fixture(autouse=True)
def _clean():
    with engine.begin() as conn:
        conn.execute(text("TRUNCATE recordings, users CASCADE"))
    yield


@pytest.fixture
def db():
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def make_wav(path, seconds: int = 2, rate: int = 16000) -> bytes:
    """A real, decodable wav so ingest exercises the decoder for real."""
    with wave.open(str(path), "w") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(
            b"".join(
                struct.pack("<h", int(20000 * math.sin(2 * math.pi * 440 * i / rate)))
                for i in range(rate * seconds)
            )
        )
    return path.read_bytes()


@pytest.fixture
def wav_bytes(tmp_path):
    return make_wav(tmp_path / "tone.wav", seconds=2)


@pytest.fixture
def golden_recording(client, tmp_path):
    """A 30 s recording named to match the golden RTTM's file id."""
    data = make_wav(tmp_path / "EN2002a_30s.wav", seconds=30)
    return upload(client, data, name="EN2002a_30s.wav").json()


def upload(client, data: bytes, name: str = "tone.wav"):
    return client.post(
        "/api/recordings",
        files={"file": (name, data, "audio/wav")},
        headers=HEADERS,
    )


# ---------------------------------------------------------------------------
# Ingest
# ---------------------------------------------------------------------------

def test_upload_creates_recording(client, wav_bytes):
    resp = upload(client, wav_bytes)

    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["session_name"] == "tone"
    assert body["duration_sec"] == pytest.approx(2.0, abs=0.01)
    assert body["status"] == "uploaded"


def test_duplicate_upload_is_rejected_with_the_original_id(client, wav_bytes):
    first = upload(client, wav_bytes).json()

    resp = upload(client, wav_bytes, name="same-bytes-different-name.wav")

    assert resp.status_code == 409
    assert resp.json()["detail"]["existing_id"] == first["id"]


def test_corrupt_upload_leaves_nothing_behind(client, db):
    resp = upload(client, b"this is definitely not audio" * 100, name="broken.wav")

    assert resp.status_code == 400
    assert resp.json()["detail"]["code"] == "corrupt"
    assert db.execute(text("SELECT count(*) FROM recordings")).scalar_one() == 0


def test_session_name_is_sanitized(client, wav_bytes):
    resp = upload(client, wav_bytes, name="my meeting 01.wav")

    assert resp.json()["session_name"] == "my_meeting_01"


def test_colliding_session_names_get_suffixes(client, wav_bytes, tmp_path):
    upload(client, wav_bytes, name="rec.wav")
    # Different bytes, same stem.
    other = wav_bytes + b"\x00\x00"
    resp = upload(client, other, name="rec.wav")

    assert resp.json()["session_name"] == "rec-2"


# ---------------------------------------------------------------------------
# Audio and peaks
# ---------------------------------------------------------------------------

def test_peaks_density_and_range(client, wav_bytes):
    rec = upload(client, wav_bytes).json()

    resp = client.get(f"/api/recordings/{rec['id']}/peaks")

    assert resp.status_code == 200
    values = struct.unpack(f"<{len(resp.content) // 4}f", resp.content)
    # 100 bins/second by default, 2 seconds of audio.
    assert len(values) == pytest.approx(200, abs=2)
    assert max(abs(v) for v in values) == pytest.approx(1.0, abs=1e-6)
    assert resp.headers["X-Peaks-Per-Second"] == "100"


def test_audio_range_partial(client, wav_bytes):
    rec = upload(client, wav_bytes).json()

    resp = client.get(
        f"/api/recordings/{rec['id']}/audio", headers={"Range": "bytes=0-99"}
    )

    assert resp.status_code == 206
    assert len(resp.content) == 100
    assert resp.headers["Content-Range"].startswith("bytes 0-99/")


def test_audio_range_suffix(client, wav_bytes):
    rec = upload(client, wav_bytes).json()

    resp = client.get(
        f"/api/recordings/{rec['id']}/audio", headers={"Range": "bytes=-500"}
    )

    assert resp.status_code == 206
    assert len(resp.content) == 500


def test_audio_range_unsatisfiable(client, wav_bytes):
    rec = upload(client, wav_bytes).json()

    resp = client.get(
        f"/api/recordings/{rec['id']}/audio",
        headers={"Range": "bytes=99999999-99999999"},
    )

    assert resp.status_code == 416
    assert resp.headers["Content-Range"].startswith("bytes */")


def test_audio_without_range_is_complete(client, wav_bytes):
    rec = upload(client, wav_bytes).json()

    resp = client.get(f"/api/recordings/{rec['id']}/audio")

    assert resp.status_code == 200
    assert resp.headers["Accept-Ranges"] == "bytes"


# ---------------------------------------------------------------------------
# Annotation
# ---------------------------------------------------------------------------

def annotation_payload(version=0):
    return {
        "version": version,
        "speakers": [
            {"label": "0", "name": "A", "sort_order": 0},
            {"label": "1", "name": "B", "sort_order": 1},
        ],
        "segments": [
            {"speaker_label": "0", "start_sec": 0.0, "end_sec": 1.2},
            {"speaker_label": "1", "start_sec": 0.8, "end_sec": 1.9},
        ],
    }


def test_save_and_reload_annotation(client, wav_bytes):
    rec = upload(client, wav_bytes).json()
    url = f"/api/recordings/{rec['id']}/annotation"

    saved = client.put(url, json=annotation_payload(), headers=HEADERS)
    assert saved.status_code == 200, saved.text
    assert saved.json()["version"] == 1

    loaded = client.get(url).json()
    assert loaded["version"] == 1
    assert len(loaded["segments"]) == 2


def test_overlapping_segments_survive_a_round_trip(client, wav_bytes):
    """Overlap is the phenomenon being annotated; nothing may merge it away."""
    rec = upload(client, wav_bytes).json()
    url = f"/api/recordings/{rec['id']}/annotation"

    client.put(url, json=annotation_payload(), headers=HEADERS)
    segments = client.get(url).json()["segments"]

    a, b = sorted(segments, key=lambda s: s["start_sec"])
    assert a["end_sec"] > b["start_sec"]


def test_stale_version_is_rejected(client, wav_bytes):
    rec = upload(client, wav_bytes).json()
    url = f"/api/recordings/{rec['id']}/annotation"
    client.put(url, json=annotation_payload(0), headers=HEADERS)

    resp = client.put(url, json=annotation_payload(0), headers=HEADERS)

    assert resp.status_code == 409
    assert resp.json()["detail"]["current_version"] == 1


def test_segment_past_the_end_is_clamped_and_reported(client, wav_bytes):
    """The DiariZen overrun case, end to end."""
    rec = upload(client, wav_bytes).json()
    payload = annotation_payload()
    payload["segments"] = [
        {"speaker_label": "0", "start_sec": 1.5, "end_sec": 2.393}
    ]

    resp = client.put(
        f"/api/recordings/{rec['id']}/annotation", json=payload, headers=HEADERS
    )

    assert resp.status_code == 200
    adjustments = resp.json()["adjustments"]
    assert len(adjustments) == 1
    assert adjustments[0]["reason"] == "clamped to audio"
    assert adjustments[0]["after"][1] == pytest.approx(rec["duration_sec"])


def test_unknown_speaker_is_rejected(client, wav_bytes):
    rec = upload(client, wav_bytes).json()
    payload = annotation_payload()
    payload["segments"][0]["speaker_label"] = "ghost"

    resp = client.put(
        f"/api/recordings/{rec['id']}/annotation", json=payload, headers=HEADERS
    )

    assert resp.status_code == 422
    assert "unknown speakers" in resp.json()["detail"]["message"]


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------

def test_exported_rttm_is_ten_fields_channel_one(client, wav_bytes):
    rec = upload(client, wav_bytes).json()
    client.put(
        f"/api/recordings/{rec['id']}/annotation",
        json=annotation_payload(),
        headers=HEADERS,
    )

    resp = client.get(f"/api/recordings/{rec['id']}/rttm")

    assert resp.status_code == 200
    lines = resp.text.splitlines()
    assert len(lines) == 2
    for line in lines:
        fields = line.split()
        assert len(fields) == 10
        assert fields[2] == "1"      # audio channel, never the speaker index
        assert fields[5] == "<NA>"   # orthography stays empty


def test_export_never_leaks_segment_text(client, wav_bytes):
    rec = upload(client, wav_bytes).json()
    payload = annotation_payload()
    payload["segments"][0]["text"] = "会议开场白"
    client.put(
        f"/api/recordings/{rec['id']}/annotation", json=payload, headers=HEADERS
    )

    resp = client.get(f"/api/recordings/{rec['id']}/rttm")

    assert "会议开场白" not in resp.text


# ---------------------------------------------------------------------------
# RTTM import (pre-labels produced outside the service)
# ---------------------------------------------------------------------------

def import_rttm(client, rec, body: bytes, version=0, force=False, user="tester"):
    return client.post(
        f"/api/recordings/{rec['id']}/annotation/rttm",
        files={"file": ("pre.rttm", body, "text/plain")},
        data={"version": str(version), "allow_uri_mismatch": str(force).lower()},
        headers={"X-User-Name": user},
    )


def test_import_golden_rttm(client, golden_recording, golden_text):
    resp = import_rttm(client, golden_recording, golden_text.encode())

    assert resp.status_code == 200, resp.text
    assert resp.json()["version"] == 1

    loaded = client.get(
        f"/api/recordings/{golden_recording['id']}/annotation"
    ).json()
    assert len(loaded["segments"]) == 13
    assert {s["label"] for s in loaded["speakers"]} == {"0", "1", "2", "3"}


def test_import_reports_the_overrun_clamp(client, golden_recording, golden_text):
    """DiariZen's own output ends 0.393 s past the audio; that must be said
    out loud, not trimmed in silence."""
    resp = import_rttm(client, golden_recording, golden_text.encode())

    adjustments = resp.json()["adjustments"]
    assert len(adjustments) == 1
    assert adjustments[0]["reason"] == "clamped to audio"
    assert adjustments[0]["before"] == [23.453, 30.393]


def test_import_makes_the_recording_claimable(client, golden_recording, golden_text):
    import_rttm(client, golden_recording, golden_text.encode())

    assert client.get(
        f"/api/recordings/{golden_recording['id']}"
    ).json()["status"] == "ready"
    assert client.post(
        f"/api/recordings/{golden_recording['id']}/claim", json={}, headers=HEADERS
    ).status_code == 200


def test_import_accepts_crlf(client, golden_recording, golden_text):
    """DiariZen run under Windows writes CRLF; that is the normal case here."""
    resp = import_rttm(client, golden_recording, golden_text.replace("\n", "\r\n").encode())

    assert resp.status_code == 200


def test_import_then_export_round_trips(client, golden_recording, golden_text):
    """Import, export, and the only difference is the clamped final turn."""
    import_rttm(client, golden_recording, golden_text.encode())

    exported = client.get(f"/api/recordings/{golden_recording['id']}/rttm").text

    original = golden_text.splitlines()
    produced = exported.splitlines()
    assert len(produced) == len(original)
    assert produced[:-1] == original[:-1]
    assert produced[-1].split()[4] == "6.547"  # 23.453 + 6.547 == 30.000


def test_import_refuses_a_mismatched_file_id(client, wav_bytes, golden_text):
    """Loading one recording's labels onto another would corrupt the set."""
    other = upload(client, wav_bytes, name="something-else.wav").json()

    resp = import_rttm(client, other, golden_text.encode())

    assert resp.status_code == 422
    detail = resp.json()["detail"]
    assert detail["code"] == "uri_mismatch"
    assert detail["file_uri"] == "EN2002a_30s"
    # Hyphens survive sanitizing: only whitespace and path separators are a
    # problem for a whitespace-delimited format.
    assert detail["session_name"] == "something-else"


def test_import_mismatch_can_be_overridden(client, wav_bytes, golden_text):
    other = upload(client, wav_bytes, name="something-else.wav").json()

    resp = import_rttm(client, other, golden_text.encode(), force=True)

    assert resp.status_code == 200
    # 2 s of audio: everything past the end is dropped or clamped, loudly.
    assert resp.json()["adjustments"]


def test_import_rejects_the_old_eleven_field_format(client, golden_recording):
    body = b"SPEAKER EN2002a_30s 1 0.0 1.0 <NA> <NA> 0 <NA> <NA> hello\n"

    resp = import_rttm(client, golden_recording, body)

    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "bad_rttm"


def test_import_rejects_an_empty_file(client, golden_recording):
    resp = import_rttm(client, golden_recording, b"\n\n")

    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "empty"


def test_import_rejects_a_stale_version(client, golden_recording, golden_text):
    import_rttm(client, golden_recording, golden_text.encode(), version=0)

    resp = import_rttm(client, golden_recording, golden_text.encode(), version=0)

    assert resp.status_code == 409
    assert resp.json()["detail"]["current_version"] == 1


def test_import_refuses_while_someone_else_annotates(
    client, golden_recording, golden_text
):
    import_rttm(client, golden_recording, golden_text.encode())
    client.post(
        f"/api/recordings/{golden_recording['id']}/claim", json={}, headers=HEADERS
    )

    resp = import_rttm(
        client, golden_recording, golden_text.encode(), version=1, user="someone-else"
    )

    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "claimed"


# ---------------------------------------------------------------------------
# Claiming and jobs
# ---------------------------------------------------------------------------

def test_cannot_claim_before_pre_labels_exist(client, wav_bytes):
    rec = upload(client, wav_bytes).json()

    resp = client.post(
        f"/api/recordings/{rec['id']}/claim", json={}, headers=HEADERS
    )

    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "not_claimable"


def test_claim_blocks_others_then_completes(client, wav_bytes, db):
    rec = upload(client, wav_bytes).json()
    db.execute(
        text("UPDATE recordings SET status='ready' WHERE id=:i"), {"i": rec["id"]}
    )
    db.commit()

    assert client.post(
        f"/api/recordings/{rec['id']}/claim", json={}, headers=HEADERS
    ).status_code == 200

    other = client.post(
        f"/api/recordings/{rec['id']}/claim",
        json={},
        headers={"X-User-Name": "someone-else"},
    )
    assert other.status_code == 409
    assert other.json()["detail"]["code"] == "already_claimed"

    forced = client.post(
        f"/api/recordings/{rec['id']}/claim",
        json={"force": True},
        headers={"X-User-Name": "someone-else"},
    )
    assert forced.status_code == 200


def test_second_active_job_is_refused(client, wav_bytes):
    rec = upload(client, wav_bytes).json()

    first = client.post(f"/api/recordings/{rec['id']}/diarize", headers=HEADERS)
    second = client.post(f"/api/recordings/{rec['id']}/diarize", headers=HEADERS)

    assert first.status_code == 202
    assert second.status_code == 409
    assert second.json()["detail"]["job_id"] == first.json()["id"]


def test_diarize_refuses_while_someone_else_annotates(client, wav_bytes, db):
    """Re-running would discard corrections the claimant is making."""
    rec = upload(client, wav_bytes).json()
    db.execute(
        text("UPDATE recordings SET status='ready' WHERE id=:i"), {"i": rec["id"]}
    )
    db.commit()
    client.post(f"/api/recordings/{rec['id']}/claim", json={}, headers=HEADERS)

    resp = client.post(
        f"/api/recordings/{rec['id']}/diarize",
        headers={"X-User-Name": "someone-else"},
    )

    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "claimed"
