"""Embedding cache + similarity rules of the verify service. No torch.

The pure functions (display_score, is_short, rank_speakers) run anywhere; the
cache tests need a real PostgreSQL, exactly like test_api.py.
"""

from __future__ import annotations

import uuid

import numpy as np
import pytest

pytest.importorskip("fastapi", reason="cache tests run inside the container")
pytest.importorskip("sqlalchemy")

from sqlalchemy import text  # noqa: E402

from app.db import SessionLocal, engine, init_schema  # noqa: E402
from app.main import app  # noqa: E402
from app.verify.service import (  # noqa: E402
    ClipScore,
    MIN_SECONDS,
    display_score,
    ensure_embedding,
    is_short,
    rank_speakers,
)

HEADERS = {"X-User-Name": "tester"}


@pytest.fixture(scope="session", autouse=True)
def _schema():
    init_schema()


@pytest.fixture(autouse=True)
def _clean():
    with engine.begin() as conn:
        conn.execute(text("TRUNCATE recordings, users, segment_embeddings CASCADE"))
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
    from fastapi.testclient import TestClient

    with TestClient(app) as c:
        yield c


@pytest.fixture
def recording_id(client) -> uuid.UUID:
    """Just a row the cache rows can FK onto; a 2 s tone suffices."""
    import math
    import struct
    import wave

    import io

    buf = io.BytesIO()
    with wave.open(buf, "w") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(
            b"".join(
                struct.pack("<h", int(20000 * math.sin(2 * math.pi * 440 * i / 16000)))
                for i in range(16000 * 2)
            )
        )
    resp = client.post(
        "/api/recordings",
        files={"file": ("tone.wav", buf.getvalue(), "audio/wav")},
        headers=HEADERS,
    )
    assert resp.status_code == 201, resp.text
    return uuid.UUID(resp.json()["id"])


# ---------------------------------------------------------------------------
# Pure rules
# ---------------------------------------------------------------------------

def test_display_score_identical_is_100():
    v = np.array([1.0, 0.0, 0.0])
    assert display_score(v, v) == 100.0


def test_display_score_orthogonal_is_zero():
    assert display_score(np.array([1.0, 0.0]), np.array([0.0, 1.0])) == 0.0


def test_display_score_negative_cosine_is_zero():
    assert display_score(np.array([1.0]), np.array([-1.0])) == 0.0


def test_display_score_handles_un_normalized_vectors():
    a = np.array([3.0, 4.0])
    b = np.array([8.0, 6.0])
    assert display_score(a, b) == pytest.approx(96.0)


def test_is_short_threshold():
    assert is_short(0.0, 0.5)
    assert is_short(1.0, 1.7)
    assert not is_short(1.0, 1.8)
    assert MIN_SECONDS == 0.8


class _Sp:
    def __init__(self, label, name, color="#000000"):
        self.label, self.name, self.color = label, name, color


def test_rank_speakers_groups_and_orders():
    speakers = [_Sp("0", "A"), _Sp("1", "B"), _Sp("2", "C")]
    scored = {
        "0": [ClipScore(None, 3.0, 4.0, 80.0, False), ClipScore(None, 1.0, 2.0, 60.0, False)],
        "1": [ClipScore(None, 5.0, 6.0, 70.0, False)],
    }

    ranked, unranked = rank_speakers(scored, speakers)

    assert [s.label for s in ranked] == ["0", "1"]
    assert ranked[0].best_score == 80.0
    assert [c.start_sec for c in ranked[0].clips] == [1.0, 3.0]
    assert [s.label for s in unranked] == ["2"]


# ---------------------------------------------------------------------------
# Cache (needs Postgres)
# ---------------------------------------------------------------------------

def test_cache_round_trip_and_stale_model_recompute(db, recording_id):
    calls = []

    def embed_fn(wav_path, start, end):
        calls.append((wav_path, start, end))
        return np.arange(192, dtype=np.float64)

    vec, computed = ensure_embedding(db, recording_id, "/data/audio.wav", 1.0, 2.0, embed_fn)
    assert computed is True
    assert vec.shape == (192,)
    assert len(calls) == 1

    # Same window: served from cache, no second computation.
    vec2, computed2 = ensure_embedding(db, recording_id, "/data/audio.wav", 1.0, 2.0, embed_fn)
    assert computed2 is False
    assert np.array_equal(vec, vec2)
    assert len(calls) == 1

    # Different window: compute.
    ensure_embedding(db, recording_id, "/data/audio.wav", 3.0, 4.0, embed_fn)
    assert len(calls) == 2

    # A row computed under an older model id is stale, so it is recomputed.
    db.execute(
        text(
            "UPDATE segment_embeddings SET model_id = 'ancient' "
            "WHERE recording_id = :r AND start_sec = 1.0"
        ),
        {"r": recording_id},
    )
    db.commit()
    ensure_embedding(db, recording_id, "/data/audio.wav", 1.0, 2.0, embed_fn)
    assert len(calls) == 3


def test_cache_hits_on_submillisecond_differences(db, recording_id):
    """Float round-trips need not be bit-identical for the cache to hit.

    A one-in-the-last-digit difference (RTTM %.3f rounding, JSON round-trip,
    client arithmetic) must not recompute the vector.
    """
    calls = []

    def embed_fn(wav_path, start, end):
        calls.append((wav_path, start, end))
        return np.arange(192, dtype=np.float64)

    ensure_embedding(db, recording_id, "/data/audio.wav", 1.0, 2.0, embed_fn)
    assert len(calls) == 1

    _, computed = ensure_embedding(
        db, recording_id, "/data/audio.wav", 1.0005, 2.0005, embed_fn
    )
    assert computed is False
    assert len(calls) == 1

    # A real difference (8 ms) is still a miss.
    _, computed = ensure_embedding(
        db, recording_id, "/data/audio.wav", 1.008, 2.0, embed_fn
    )
    assert computed is True
    assert len(calls) == 2
