"""DiariZen wrapper.

The pipeline is expensive to construct (292 MB of weights) and stateless
across calls, so it is built once per process and reused for every job.

`rttm_out_dir` is deliberately left None: with it set, the pipeline writes a
file named after the session into a shared directory, which would be both a
side effect we do not want and a collision hazard. Without it, the result stays
in memory and we serialize it ourselves.
"""

from __future__ import annotations

import logging
import os
from functools import lru_cache
from pathlib import Path

from app.config import settings

log = logging.getLogger(__name__)

HUB_DIR = "diarizen-wavlm-large-s80-md"
# The directory name must contain "pyannote": PretrainedSpeakerEmbedding
# dispatches on substrings of the path and checks "pyannote" before
# "wespeaker". A path matching only "wespeaker" is routed to the ONNX loader,
# which cannot read these weights.
EMBED_DIR = "pyannote-wespeaker-voxceleb-resnet34-LM"


def _set_threads() -> None:
    """Must run before anything else touches torch.

    Neither DiariZen nor the vendored pyannote-audio ever calls
    set_num_threads, so without this the process uses whatever torch defaults
    to -- which on a shared box is usually every core.
    """
    import torch

    torch.set_num_threads(settings.torch_num_threads)
    log.info("torch threads: %d", torch.get_num_threads())


def _batch_size() -> int:
    """Batch size for segmentation and embedding passes.

    The checkpoint ships batch_size=32, tuned for a GPU. On a CPU-only box it
    peaks at ~6.6 GB RSS -- enough to trip the OOM killer on an 8 GB machine
    shared with the API and DB (verified the hard way 2026-09-04: three OOM
    kills before the config was trimmed to 4). On GPU, 4 would waste the card
    (a 4090 D has 24 GB; 32 fits with a wide margin), so the default follows
    the device and DIARIZEN_BATCH_SIZE overrides either.
    """
    override = os.environ.get("DIARIZEN_BATCH_SIZE")
    if override:
        return int(override)
    import torch

    return 32 if torch.cuda.is_available() else 4


@lru_cache(maxsize=1)
def get_pipeline():
    """Build the pipeline once. Heavy: expect tens of seconds."""
    _set_threads()

    hub = settings.models_dir / HUB_DIR
    embedding = settings.models_dir / EMBED_DIR / "pytorch_model.bin"

    if not (hub / "pytorch_model.bin").exists():
        raise RuntimeError(
            f"missing checkpoint at {hub}. Run: "
            f"docker compose --profile setup run --rm seed-models"
        )
    if not embedding.exists():
        raise RuntimeError(f"missing embedding model at {embedding}")

    # Imported late so a broken install surfaces here, with context, rather
    # than at module import time in some unrelated code path.
    from diarizen.pipelines.inference import DiariZenPipeline

    log.info("loading DiariZen from %s", hub)
    batch_size = _batch_size()
    log.info("diarization batch size: %d", batch_size)
    pipeline = DiariZenPipeline(
        diarizen_hub=hub,
        embedding_model=str(embedding),
        rttm_out_dir=None,  # keep it in memory; we own serialization
        # config_parse REPLACES whole sections (config["inference"]["args"] =
        # config_parse[...]), so every key the section would otherwise carry
        # must be reproduced verbatim from the checkpoint's config.toml or it
        # silently vanishes -- first run without segmentation_step would hang
        # forever. Both sections copied 1:1 from
        # diarizen-wavlm-large-s80-md/config.toml except the batch size.
        config_parse={
            "inference": {
                "args": {
                    "seg_duration": 16,
                    "segmentation_step": 0.1,
                    "batch_size": batch_size,
                    "apply_median_filtering": True,
                }
            },
            "clustering": {
                "args": {
                    "method": "VBxClustering",
                    "min_speakers": 1,
                    "max_speakers": 20,
                    "ahc_criterion": "distance",
                    "ahc_threshold": 0.6,
                    "Fa": 0.07,
                    "Fb": 0.8,
                    "lda_dim": 128,
                    "max_iters": 20,
                }
            },
        },
    )
    log.info("DiariZen ready")
    return pipeline


def diarize(wav_path: Path, session_name: str) -> str:
    """Run inference and return standard RTTM text.

    Roughly 1x realtime on CPU: a 20-minute recording occupies this worker for
    about 20 minutes.
    """
    pipeline = get_pipeline()
    annotation = pipeline(str(wav_path), sess_name=session_name)

    # pyannote.core's writer is already standard 10-field RTTM; our own parser
    # re-reads it so that everything entering the database has passed through
    # the one validated code path.
    return annotation.to_rttm()


__all__ = ["get_pipeline", "diarize"]
