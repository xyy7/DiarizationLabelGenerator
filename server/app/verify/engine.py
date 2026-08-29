"""ERes2Net embedding engine: model loading, device selection, windowed embed.

Smoke-verified 2026-08-29 (scripts/smoke_eres2net.py, temporary): the
modelscope speaker-verification pipeline loads fully OFFLINE from a local
model directory, and ``pipe.model.forward(<float32 waveform>)`` returns the
192-dim embedding. That is the whole engine; nothing here re-implements the
network.

The model directory is the one the seed-models container fills:
MODELS_DIR/eres2net-sv-zh-cn-16k-common/pretrained_eres2net_aug.ckpt (221 MB).
The checkpoint name is 3D-Speaker style, NOT pytorch_model.bin.

torch / modelscope are imported only inside the loader (same late-import
pattern as app/worker/diarize.py). The api and test images never import this
module, so their torch-free property holds.
"""

from __future__ import annotations

import logging
from functools import lru_cache
from pathlib import Path
from typing import Any

import numpy as np

from app.config import settings
from app.verify.service import EMBEDDING_DIM

log = logging.getLogger(__name__)

MODEL_DIR_NAME = "eres2net-sv-zh-cn-16k-common"
CHECKPOINT = "pretrained_eres2net_aug.ckpt"
SAMPLE_RATE = 16_000


class EngineError(RuntimeError):
    """Model missing or unloadable; the caller should say so plainly."""


def _device() -> torch.device:  # noqa: F821 -- torch imported in get_model
    """Resolve EMBEDDING_DEVICE (auto|cpu|cuda) to a concrete device."""
    import torch

    choice = settings.embedding_device
    if choice == "auto":
        choice = "cuda" if torch.cuda.is_available() else "cpu"
    if choice not in ("cpu", "cuda"):
        raise EngineError(f"EMBEDDING_DEVICE={choice!r}: expected auto|cpu|cuda")
    return torch.device(choice)


@lru_cache(maxsize=1)
def get_model() -> Any:
    """Load the pipeline once per process. Expect a few seconds to tens."""
    model_dir: Path = settings.models_dir / MODEL_DIR_NAME
    if not (model_dir / CHECKPOINT).exists():
        raise EngineError(
            f"missing checkpoint at {model_dir}. Run: "
            f"docker compose --profile setup run --rm seed-models"
        )

    import torch

    # The same comment as diarize.py: nobody in this stack sets torch threads.
    torch.set_num_threads(settings.torch_num_threads)

    from modelscope.pipelines import pipeline

    log.info("loading eres2net from %s", model_dir)
    pipe = pipeline("speaker-verification", model=str(model_dir))

    device = _device()
    if device.type != "cpu":
        # The pipeline picks its device at construction time (default cpu).
        # forward() moves features to sv.model.device, so fix BOTH halves.
        pipe.model.embedding_model.to(device)
        pipe.model.device = device
    log.info("eres2net ready on %s", device)
    return pipe


def embed(wav_path: Path, start_sec: float, end_sec: float) -> np.ndarray:
    """192-dim L2-normalized embedding of one window of the canonical wav.

    Input audio is what ingest produced: 16 kHz mono, so no conversion here.
    The window is clamped to what the file actually contains -- the server
    validates against the recording duration, so this only guards absurds.
    """
    import soundfile as sf
    import torch

    data, sr = sf.read(str(wav_path), dtype="float32")
    if sr != SAMPLE_RATE:
        raise EngineError(f"{wav_path}: expected {SAMPLE_RATE} Hz, got {sr}")

    s = max(0, int(start_sec * sr))
    e = min(len(data), int(end_sec * sr))
    if e - s < int(sr * 0.25):  # 250 ms of actual audio is the floor
        raise EngineError(f"window {start_sec}-{end_sec} yields less than 250 ms")

    with torch.no_grad():
        out = get_model().model.forward(data[s:e])  # [1, T] float32 -> [1, K]

    vec = out.detach().cpu().numpy()[0]
    if vec.shape != (EMBEDDING_DIM,):
        raise EngineError(f"expected {EMBEDDING_DIM}-dim embedding, got {vec.shape}")

    norm = float(np.linalg.norm(vec))
    if norm == 0.0:
        raise EngineError("zero embedding: degenerate audio window")
    return vec / norm


__all__ = ["EngineError", "MODEL_DIR_NAME", "CHECKPOINT", "get_model", "embed"]
