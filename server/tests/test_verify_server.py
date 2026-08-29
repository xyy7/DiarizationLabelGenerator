"""Verify-service HTTP contract. The ENGINE is stubbed; no torch anywhere.

These run against the real Postgres like test_api.py, and monkeypatch the
module-level ``embed`` / ``get_model`` names in app.verify.server, which is
exactly where the container would wire the real engine.
"""

from __future__ import annotations

import io
import math
import struct
import uuid
import wave

import numpy as np
import pytest

pytest.importorskip("fastapi", reason="runs inside the container")
pytest.importorskip("sqlalchemy")

from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import text  # noqa: E402

from app import annotations as store  # noqa: E402
from app.db import SessionLocal, engine, init_schema  # noqa: E402
from app.domain import SegmentIn, SpeakerIn  # noqa: E402
from app.models import Recording  # noqa: E402
from app.verify import server as verify_mod  # noqa: E402
from app.verify.engine import EngineError  # noqa: E402

HEADERS = {"X-User-Name": "tester"}


def stub_embed(path, start, end):
    """Deterministic pseudo-embeddings: one geometry for early windows, an
    orthogonal one for later windows."""
    vec = np.zeros(192, dtype=np.float64)
    vec[0 if start < 10.0 else 1] = 1.0
    return vec


def failing_embed(path, start, end):
    raise EngineError("smoke on the wire")


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


def _tone_wav(seconds: int = 30) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "w") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(
            b"".join(
                struct.pack("<h", int(20000 * math.sin(2 * math.pi * 440 * i / 16000)))
                for i in range(16000 * seconds)
            )
        )
    return buf.getvalue()


@pytest.fixture
def api_client():
    """The real API app, used only to create recordings."""
    from app.main import app as api_app

    with TestClient(api_app) as c:
        yield c


@pytest.fixture
def recording_id(api_client) -> uuid.UUID:
    """A 30 s recording, uploaded through the real API (shares the DB)."""
    resp = api_client.post(
        "/api/recordings",
        files={"file": ("tone30.wav", _tone_wav(), "audio/wav")},
        headers=HEADERS,
    )
    assert resp.status_code == 201, resp.text
    return uuid.UUID(resp.json()["id"])


@pytest.fixture
def annotated(db, recording_id) -> uuid.UUID:
    """Speakers 0/1/2; '0' and '1' each carry one stable segment."""
    rec = db.get(Recording, recording_id)
    assert rec is not None
    store.save_annotation(
        db,
        rec,
        expected_version=0,
        speakers=[SpeakerIn("0", "A"), SpeakerIn("1", "B"), SpeakerIn("2", "C")],
        segments=[
            SegmentIn("0", 0.0, 1.0, is_stable=True),
            SegmentIn("1", 20.0, 21.0, is_stable=True),
            SegmentIn("2", 25.0, 26.0, is_stable=False),
        ],
    )
    return recording_id


@pytest.fixture
def client(monkeypatch):
    # The container warms the model at startup; tests stub the engine instead.
    monkeypatch.setattr(verify_mod, "get_model", lambda: None)
    monkeypatch.setattr(verify_mod, "embed", stub_embed)
    with TestClient(verify_mod.app) as c:
        yield c


# ---------------------------------------------------------------------------
# /similarity
# ---------------------------------------------------------------------------

def test_ranks_and_lists_unranked(client, annotated):
    resp = client.post(
        "/similarity",
        json={
            "recording_id": str(annotated),
            "query": {"start_sec": 0.5, "end_sec": 1.5},
        },
    )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["query"] == {"start_sec": 0.5, "end_sec": 1.5, "short": False}
    # Speaker 0's clip is the same geometry as the query window: 100.0.
    assert [i["label"] for i in body["items"]] == ["0", "1"]
    assert body["items"][0]["best_score"] == 100.0
    assert body["items"][1]["best_score"] == 0.0
    assert [i["label"] for i in body["unranked"]] == ["2"]
    assert body["unranked"][0]["name"] == "C"


def test_short_query_window_is_flagged(client, annotated):
    resp = client.post(
        "/similarity",
        json={"recording_id": str(annotated), "query": {"start_sec": 0.0, "end_sec": 0.5}},
    )

    assert resp.status_code == 200
    assert resp.json()["query"]["short"] is True


def test_window_outside_audio_is_422(client, annotated):
    resp = client.post(
        "/similarity",
        json={"recording_id": str(annotated), "query": {"start_sec": 0.0, "end_sec": 31.0}},
    )

    assert resp.status_code == 422


def test_unknown_recording_is_404(client):
    resp = client.post(
        "/similarity",
        json={
            "recording_id": str(uuid.uuid4()),
            "query": {"start_sec": 0.0, "end_sec": 1.0},
        },
    )

    assert resp.status_code == 404


def test_engine_failure_is_a_500_with_a_reason(client, annotated, monkeypatch):
    monkeypatch.setattr(verify_mod, "embed", failing_embed)

    resp = client.post(
        "/similarity",
        json={"recording_id": str(annotated), "query": {"start_sec": 0.5, "end_sec": 1.5}},
    )

    assert resp.status_code == 500
    assert resp.json()["detail"]["code"] == "engine_failed"
    assert "eres2net failed" in resp.json()["detail"]["message"]


# ---------------------------------------------------------------------------
# /precompute
# ---------------------------------------------------------------------------

def test_precompute_computes_then_skips(client, annotated):
    resp = client.post("/precompute", json={"recording_id": str(annotated)})
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"computed": 2, "skipped": 0}

    resp = client.post("/precompute", json={"recording_id": str(annotated)})
    assert resp.status_code == 200
    assert resp.json() == {"computed": 0, "skipped": 2}


def test_precompute_unknown_recording_is_404(client):
    resp = client.post("/precompute", json={"recording_id": str(uuid.uuid4())})

    assert resp.status_code == 404
