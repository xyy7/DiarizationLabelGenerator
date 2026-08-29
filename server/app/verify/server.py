"""FastAPI application for the verify container (port 8001).

Owns the model, the embedding cache, and every floating-point operation.
The API is the only caller; this service is never reachable from the browser.
Everything here follows the worker's patterns: DB access via app.db, schema
bootstrapped at startup, model loaded before serving so a broken install
fails loudly in the compose logs rather than on someone's first right-click.
"""

from __future__ import annotations

import logging
import time
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from app.annotations import load_annotation
from app.config import settings
from app.db import SessionLocal, init_schema
from app.ingest import wav_path_for
from app.models import Recording
from app.verify import service as svc
from app.verify.engine import EngineError, embed, get_model

log = logging.getLogger("verify")


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_schema()
    get_model()  # fail at startup on a broken install, not on a right-click
    yield


app = FastAPI(title="ADG speaker-verification service", version="0.1.0", lifespan=lifespan)


class QueryWindow(BaseModel):
    start_sec: float
    end_sec: float


class SimilarityRequest(BaseModel):
    recording_id: uuid.UUID
    query: QueryWindow


class PrecomputeRequest(BaseModel):
    recording_id: uuid.UUID


@app.get("/healthz")
def healthz():
    return {"ok": True}


def _window_or_422(start: float, end: float, duration: float) -> None:
    if end <= start:
        raise HTTPException(422, {"code": "invalid", "message": "end must be greater than start"})
    if start < 0 or end > duration:
        raise HTTPException(
            422,
            {"code": "invalid", "message": f"window {start}-{end} outside audio (duration {duration})"},
        )


def _or_engine_error(exc: EngineError) -> HTTPException:
    return HTTPException(
        500, {"code": "engine_failed", "message": f"eres2net failed: {exc}"}
    )


@app.post("/similarity")
def similarity(req: SimilarityRequest):
    t0 = time.perf_counter()

    with SessionLocal() as db:
        recording = db.get(Recording, req.recording_id)
        if recording is None:
            raise HTTPException(
                404, {"code": "not_found", "message": "unknown recording"}
            )
        _window_or_422(
            req.query.start_sec, req.query.end_sec, recording.duration_sec
        )

        wav = wav_path_for(recording.id)
        if not wav.exists():
            raise HTTPException(
                409, {"code": "no_audio", "message": f"audio missing at {wav}"}
            )
        try:
            qvec, _ = svc.ensure_embedding(
                db, recording.id, str(wav), req.query.start_sec, req.query.end_sec, embed
            )
        except EngineError as exc:
            raise _or_engine_error(exc) from None

        speakers, segments = load_annotation(db, recording.id)
        stable = [s for s in segments if s.is_stable]

        scored_by_label: dict[str, list[svc.ClipScore]] = {}
        for seg in stable:
            vec, _ = svc.ensure_embedding(
                db, recording.id, str(wav), seg.start_sec, seg.end_sec, embed
            )
            clip = svc.ClipScore(
                segment_id=seg.id,
                start_sec=seg.start_sec,
                end_sec=seg.end_sec,
                score=svc.display_score(qvec, vec),
                short=svc.is_short(seg.start_sec, seg.end_sec),
            )
            scored_by_label.setdefault(seg.speaker_label, []).append(clip)

    ranked, unranked = svc.rank_speakers(scored_by_label, speakers)

    elapsed_ms = round((time.perf_counter() - t0) * 1000)
    return {
        "query": {
            "start_sec": req.query.start_sec,
            "end_sec": req.query.end_sec,
            "short": svc.is_short(req.query.start_sec, req.query.end_sec),
        },
        "items": [
            {
                "label": s.label,
                "name": s.name,
                "color": s.color,
                "best_score": s.best_score,
                "clips": [
                    {
                        "segment_id": str(c.segment_id) if c.segment_id else None,
                        "start_sec": c.start_sec,
                        "end_sec": c.end_sec,
                        "score": c.score,
                        "short": c.short,
                    }
                    for c in s.clips
                ],
            }
            for s in ranked
        ],
        "unranked": [
            {"label": sp.label, "name": sp.name, "color": sp.color, "sort_order": sp.sort_order}
            for sp in unranked
        ],
        "elapsed_ms": elapsed_ms,
    }


@app.post("/precompute")
def precompute(req: PrecomputeRequest):
    """Warm the cache for every stable segment. Called from the API after a
    save, so the first right-click after marking stable clips is fast."""
    computed = 0
    skipped = 0

    with SessionLocal() as db:
        recording = db.get(Recording, req.recording_id)
        if recording is None:
            raise HTTPException(
                404, {"code": "not_found", "message": "unknown recording"}
            )
        wav = wav_path_for(recording.id)
        if not wav.exists():
            raise HTTPException(
                409, {"code": "no_audio", "message": f"audio missing at {wav}"}
            )
        _, segments = load_annotation(db, recording.id)
        for seg in segments:
            if not seg.is_stable:
                continue
            try:
                _, was_computed = svc.ensure_embedding(
                    db, recording.id, str(wav), seg.start_sec, seg.end_sec, embed
                )
            except EngineError as exc:
                raise _or_engine_error(exc) from None
            if was_computed:
                computed += 1
            else:
                skipped += 1

    return {"computed": computed, "skipped": skipped}


__all__ = ["app"]
