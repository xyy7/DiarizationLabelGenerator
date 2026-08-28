"""Server-side waveform peak precomputation.

The browser must never decode a 20-minute file to draw a waveform. wavesurfer
accepts pre-computed peaks instead, and its `createBuffer` (verified in
wavesurfer.js 7.12.7 dist/decoder.js) builds a plain object rather than a real
AudioBuffer:

    { duration, length, sampleRate: channel.length / duration, ... }

so the effective "sample rate" is whatever density we choose -- there is no
Web Audio minimum to respect. Its `normalize()` only rescales when a value
falls outside -1..1, so values already in range are used verbatim.

Density is 100 bins/second (10 ms). The obvious choice is 10/second, but this
tool exists to align segment boundaries to within about 10 ms, and at 100 ms
per bin the waveform simply does not show where an utterance starts -- the
annotator would be nudging boundaries blind. 20 minutes at 100 bins/s is
120k float32 = 480 KB, which is cheap for what it buys.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import soundfile as sf

from app.config import settings

# Read in chunks so a long file never lands in memory whole.
_BLOCK_FRAMES = 1 << 20


def compute_peaks(
    wav_path: Path, bins_per_second: int | None = None
) -> np.ndarray:
    """Return a float32 waveform envelope in -1..1, one value per bin.

    Each bin holds the sample of largest magnitude within it, sign preserved,
    so the rendered waveform keeps its natural two-sided shape instead of
    collapsing into a positive-only blob.

    Mono only: ingest normalizes everything to 16 kHz mono, which is also the
    single channel DiariZen reads, so a second channel would describe audio the
    model never saw.
    """
    bins_per_second = bins_per_second or settings.peaks_per_second
    if bins_per_second <= 0:
        raise ValueError(f"bins_per_second must be positive, got {bins_per_second}")

    with sf.SoundFile(str(wav_path)) as snd:
        sample_rate = snd.samplerate
        total_frames = len(snd)
        if total_frames == 0:
            return np.zeros(0, dtype=np.float32)

        samples_per_bin = max(1, round(sample_rate / bins_per_second))
        n_bins = max(1, -(-total_frames // samples_per_bin))  # ceil
        peaks = np.zeros(n_bins, dtype=np.float32)

        # Blocks are aligned to whole bins so a bin is never split across two
        # reads, which would otherwise take the max of a fragment.
        block_frames = max(samples_per_bin, (_BLOCK_FRAMES // samples_per_bin) * samples_per_bin)

        bin_index = 0
        for block in snd.blocks(blocksize=block_frames, dtype="float32", always_2d=True):
            mono = block[:, 0]
            pad = (-len(mono)) % samples_per_bin
            if pad:
                mono = np.concatenate([mono, np.zeros(pad, dtype=np.float32)])
            framed = mono.reshape(-1, samples_per_bin)

            # argmax over |x| then take the signed original, in one pass.
            idx = np.abs(framed).argmax(axis=1)
            block_peaks = framed[np.arange(framed.shape[0]), idx]

            peaks[bin_index : bin_index + len(block_peaks)] = block_peaks
            bin_index += len(block_peaks)

    largest = float(np.abs(peaks).max()) if peaks.size else 0.0
    if largest > 0:
        peaks /= largest  # silence would otherwise divide by zero
    return peaks


def peaks_path_for(audio_dir: Path) -> Path:
    return audio_dir / "peaks.f32"


def write_peaks(peaks: np.ndarray, path: Path) -> None:
    """Store as raw little-endian float32.

    Binary rather than JSON: the client reads it with a single
    `new Float32Array(await res.arrayBuffer())`, and at 100 bins/second JSON
    would roughly double the transfer for no benefit.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(peaks.astype("<f4").tobytes())


def read_peaks(path: Path) -> np.ndarray:
    return np.frombuffer(path.read_bytes(), dtype="<f4")


__all__ = ["compute_peaks", "peaks_path_for", "write_peaks", "read_peaks"]
