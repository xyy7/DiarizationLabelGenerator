"""POST /similarity: window validation and verify-service integration.

Requires the same PostgreSQL-backed container as test_api.py; the verify
service itself is always stubbed, so these run with no torch anywhere.
"""

from __future__ import annotations

import io
import math
import struct
import uuid
import wave

import pytest

pytest.importorskip("fastapi", reason="runs inside the container")
pytest.importorskip("sqlalchemy")

from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import text  # noqa: E402

from app.db import engine, init_schema  # noqa: E402
from app.main import app  # noqa: E402

import app.routers.annotations as annotations_mod  # noqa: E402
from app.verify_client import VerifyUnavailable  # noqa: E402

HEADERS = {"X-User-Name": "tester"}

PAYLOAD = {
    "query": {"start_sec": 0.5, "end_sec": 1.5, "short": False},
    "items": [
        {
            "label": "1",
            "name": "说话人 1",
            "color": "#52c41a",
            "best_score": 91.5,
            "clips": [
                {
                    "segment_id": str(uuid.uuid4()),
                    "start_sec": 0.0,
                    "end_sec": 1.0,
                    "score": 91.5,
                    "short": False,
                }
            ],
        }
    ],
    "unranked": [
        {"label": "0", "name": "说话人 0", "color": "#1890ff", "sort_order": 0}
    ],
    "elapsed_ms": 234,
}


@pytest.fixture(scope="session", autouse=True)
def _schema():
    init_schema()


@pytest.fixture(autouse=True)
def _clean():
    with engine.begin() as conn:
        conn.execute(text("TRUNCATE recordings, users CASCADE"))
    yield


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def _tone_wav(seconds: int = 2) -> bytes:
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
def recording_id(client) -> uuid.UUID:
    resp = client.post(
        "/api/recordings",
        files={"file": ("tone.wav", _tone_wav(), "audio/wav")},
        headers=HEADERS,
    )
    assert resp.status_code == 201, resp.text
    return uuid.UUID(resp.json()["id"])


def _similarity_url(recording_id) -> str:
    return f"/api/recordings/{recording_id}/similarity"


class FakeVerify:
    """Stub for the module-level get_verify_client()."""

    def __init__(self, payload=None, error: VerifyUnavailable | None = None):
        self.payload = payload
        self.error = error
        self.called_with = None
        self.precomputed = []

    def similarity(self, recording_id, start_sec, end_sec) -> dict:
        self.called_with = (recording_id, start_sec, end_sec)
        if self.error:
            raise self.error
        return self.payload

    def precompute(self, recording_id) -> None:
        self.precomputed.append(recording_id)


def test_inverted_window_is_invalid(client, recording_id, monkeypatch):
    fake = FakeVerify(payload=PAYLOAD)
    monkeypatch.setattr(annotations_mod, "get_verify_client", lambda: fake)

    resp = client.post(
        _similarity_url(recording_id), json={"start_sec": 1.5, "end_sec": 0.5}, headers=HEADERS
    )

    assert resp.status_code == 422
    assert fake.called_with is None


def test_window_outside_audio_is_invalid(client, recording_id, monkeypatch):
    fake = FakeVerify(payload=PAYLOAD)
    monkeypatch.setattr(annotations_mod, "get_verify_client", lambda: fake)

    resp = client.post(
        _similarity_url(recording_id), json={"start_sec": 0.0, "end_sec": 9.9}, headers=HEADERS
    )

    assert resp.status_code == 422
    assert "outside audio" in resp.json()["detail"]["message"]


def test_verify_down_is_a_503_with_a_reason(client, recording_id, monkeypatch):
    fake = FakeVerify(error=VerifyUnavailable("connection refused"))
    monkeypatch.setattr(annotations_mod, "get_verify_client", lambda: fake)

    resp = client.post(
        _similarity_url(recording_id), json={"start_sec": 0.0, "end_sec": 1.0}, headers=HEADERS
    )

    assert resp.status_code == 503
    assert resp.json()["detail"]["code"] == "verify_unavailable"
    assert "verify" in resp.json()["detail"]["message"].lower()


def test_similarity_passthrough(client, recording_id, monkeypatch):
    fake = FakeVerify(payload=PAYLOAD)
    monkeypatch.setattr(annotations_mod, "get_verify_client", lambda: fake)

    resp = client.post(
        _similarity_url(recording_id), json={"start_sec": 0.5, "end_sec": 1.5}, headers=HEADERS
    )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["query"]["start_sec"] == 0.5
    assert body["items"][0]["best_score"] == 91.5
    assert body["unranked"][0]["label"] == "0"
    assert fake.called_with == (recording_id, 0.5, 1.5)


def test_save_fires_precompute(client, recording_id, monkeypatch):
    fake = FakeVerify(payload=PAYLOAD)
    monkeypatch.setattr(annotations_mod, "get_verify_client", lambda: fake)

    body = {
        "version": 0,
        "speakers": [{"label": "0", "name": "A", "color": "#1890ff", "sort_order": 0}],
        "segments": [{"speaker_label": "0", "start_sec": 0.0, "end_sec": 1.0}],
    }
    resp = client.put(
        f"/api/recordings/{recording_id}/annotation", json=body, headers=HEADERS
    )

    assert resp.status_code == 200, resp.text
    assert fake.precomputed == [recording_id]


def test_precompute_failure_never_breaks_save(client, recording_id, monkeypatch):
    class RudeVerify(FakeVerify):
        def precompute(self, recording_id) -> None:
            raise RuntimeError("boom")  # misbehaving stub on purpose

    monkeypatch.setattr(annotations_mod, "get_verify_client", lambda: RudeVerify(payload=PAYLOAD))

    body = {
        "version": 0,
        "speakers": [{"label": "0", "name": "A", "color": "#1890ff", "sort_order": 0}],
        "segments": [{"speaker_label": "0", "start_sec": 0.0, "end_sec": 1.0}],
    }
    resp = client.put(
        f"/api/recordings/{recording_id}/annotation", json=body, headers=HEADERS
    )

    assert resp.status_code == 200, resp.text
