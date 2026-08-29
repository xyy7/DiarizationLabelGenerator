"""Embedding cache and similarity ranking. No torch, no model.

Every rule here is worth testing in isolation: what makes a cached row stale,
how a score is displayed, what a speaker's representative score is, and who
belongs in the ranked list. The embedding computation itself lives in
``engine.py``; tests inject a stub ``embed_fn``.

Cache keying is by AUDIO CONTENT -- (recording_id, start_sec, end_sec) -- and
never by segment id. The rationale lives in schema.sql where the table does.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable, Sequence

import numpy as np
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.models import SegmentEmbedding

# Sole identity of "the embedding produced by this model + feature extraction
# code". Bump on ANY change that could move a vector (weights, fbank config,
# normalization): on access every row with an older id is recomputed.
EMBEDDING_MODEL_ID = "eres2net-huge-zhcn-16k-common-v1"

EMBEDDING_DIM = 192

# A window this short yields an embedding that is noise for ranking; the score
# is still shown, but flagged so the panel can phrase its advice honestly.
MIN_SECONDS = 0.8

EmbedFn = Callable[[str, float, float], np.ndarray]


@dataclass(frozen=True)
class ClipScore:
    """One reference clip's similarity to the queried window."""

    segment_id: uuid.UUID | None
    start_sec: float
    end_sec: float
    score: float  # 0..100 display score
    short: bool


@dataclass(frozen=True)
class SpeakerScore:
    """One speaker's row: representative score + per-clip detail."""

    label: str
    name: str
    color: str
    best_score: float
    clips: list[ClipScore]


def display_score(query: np.ndarray, clip: np.ndarray) -> float:
    """Cosine similarity as the 0..100 number the panel shows.

    Vectors are L2-normalized by the engine; the norms are still computed
    here so a non-normalized stub in a test cannot silently produce a score
    above 100. Lower-bounded at 0: a negative cosine means "nothing alike",
    and 0% reads more honestly than -18%.
    """
    denom = float(np.linalg.norm(query) * np.linalg.norm(clip))
    if denom == 0.0:
        return 0.0
    cosine = float(np.dot(query, clip) / denom)
    return round(max(0.0, cosine) * 100.0, 1)


def is_short(start: float, end: float) -> bool:
    return end - start < MIN_SECONDS


# ---------------------------------------------------------------------------
# Cache
# ---------------------------------------------------------------------------

def load_cached(db, recording_id: uuid.UUID, start: float, end: float):
    """Return the cached vector for exactly this window, or None."""
    row = db.execute(
        select(SegmentEmbedding).where(
            SegmentEmbedding.recording_id == recording_id,
            SegmentEmbedding.start_sec == start,
            SegmentEmbedding.end_sec == end,
        )
    ).scalar_one_or_none()
    if row is None or row.model_id != EMBEDDING_MODEL_ID:
        return None
    vec = np.asarray(row.embedding, dtype=np.float64)
    if vec.shape != (EMBEDDING_DIM,):
        return None
    return vec


def store_embedding(db, recording_id: uuid.UUID, start: float, end: float, vec: np.ndarray) -> None:
    """Upsert one window's embedding. Old ids simply get overwritten."""
    if vec.shape != (EMBEDDING_DIM,):
        raise ValueError(f"embedding dim {vec.shape} != {EMBEDDING_DIM}")
    stmt = (
        pg_insert(SegmentEmbedding)
        .values(
            recording_id=recording_id,
            start_sec=start,
            end_sec=end,
            model_id=EMBEDDING_MODEL_ID,
            embedding=vec.tolist(),
            computed_at=datetime.now(timezone.utc),
        )
        .on_conflict_do_update(
            index_elements=[
                SegmentEmbedding.recording_id,
                SegmentEmbedding.start_sec,
                SegmentEmbedding.end_sec,
            ],
            set_={
                "model_id": EMBEDDING_MODEL_ID,
                "embedding": vec.tolist(),
                "computed_at": datetime.now(timezone.utc),
            },
        )
    )
    db.execute(stmt)
    db.commit()


def ensure_embedding(db, recording_id: uuid.UUID, wav_path: str, start: float, end: float, embed_fn: EmbedFn) -> tuple[np.ndarray, bool]:
    """Cached vector, or compute-and-cache it. Returns (vec, computed_now)."""
    cached = load_cached(db, recording_id, start, end)
    if cached is not None:
        return cached, False

    vec = np.asarray(embed_fn(wav_path, start, end), dtype=np.float64)
    store_embedding(db, recording_id, start, end, vec)
    return vec, True


# ---------------------------------------------------------------------------
# Ranking
# ---------------------------------------------------------------------------

def rank_speakers(
    scored_by_label: dict[str, list[ClipScore]],
    speakers: Sequence,  # Sequence[SpeakerIn]-like: needs .label .name .color
) -> tuple[list[SpeakerScore], list]:
    """Turn per-clip scores into speaker rows.

    Returns (ranked, unranked). ranked is ordered by representative score
    (the speaker's BEST clip) descending, with each speaker's clips listed in
    time order; unranked is speakers that got no scored clip at all (no stable
    audio set).
    """
    speaker_map = {sp.label: sp for sp in speakers}

    ranked: list[SpeakerScore] = []
    for label, clips in scored_by_label.items():
        sp = speaker_map.get(label)
        name = sp.name if sp else label
        color = sp.color if sp else "#1890ff"
        ordered = sorted(clips, key=lambda c: c.start_sec)
        ranked.append(
            SpeakerScore(
                label=label,
                name=name,
                color=color,
                best_score=max(c.score for c in ordered),
                clips=ordered,
            )
        )
    ranked.sort(key=lambda s: s.best_score, reverse=True)

    ranked_labels = {s.label for s in ranked}
    unranked = [sp for sp in speakers if sp.label not in ranked_labels]

    return ranked, unranked


__all__ = [
    "EMBEDDING_MODEL_ID",
    "EMBEDDING_DIM",
    "MIN_SECONDS",
    "ClipScore",
    "SpeakerScore",
    "EmbedFn",
    "display_score",
    "is_short",
    "load_cached",
    "store_embedding",
    "ensure_embedding",
    "rank_speakers",
]
