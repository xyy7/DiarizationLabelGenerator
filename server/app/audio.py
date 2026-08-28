"""Audio ingest and range-aware serving.

Everything is normalized to 16 kHz mono WAV on the way in, and that one file is
what gets served to the browser, measured for duration, drawn as peaks, and
handed to DiariZen. A single canonical artifact removes a whole class of "the
waveform doesn't line up with the audio" bugs, and it sidesteps torchaudio's
unreliable MP3-through-BytesIO path: the worker only ever receives a wav path.

Decoding goes through PyAV rather than an ffmpeg subprocess. PyAV's wheel
bundles the same FFmpeg libraries, so the image needs no system packages, and
errors arrive as exceptions instead of a exit code and a blob of stderr.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

import av
import soundfile as sf
from fastapi import Response
from fastapi.responses import StreamingResponse

TARGET_SAMPLE_RATE = 16_000
TARGET_LAYOUT = "mono"
_STREAM_CHUNK = 1 << 16

_RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")


class AudioError(ValueError):
    """Unreadable or undecodable upload."""


@dataclass(frozen=True)
class AudioInfo:
    duration_sec: float
    sample_rate: int
    channels: int


def probe(path: Path) -> AudioInfo:
    """Validate that a file is decodable audio and report its shape.

    This is the gate that rejects corrupt uploads before any database row or
    artifact exists.
    """
    try:
        with av.open(str(path)) as container:
            if not container.streams.audio:
                raise AudioError("file contains no audio stream")
            stream = container.streams.audio[0]

            if stream.duration is not None and stream.time_base:
                duration = float(stream.duration * stream.time_base)
            elif container.duration:
                duration = container.duration / av.time_base
            else:
                duration = 0.0

            return AudioInfo(
                duration_sec=duration,
                sample_rate=int(stream.rate or 0),
                channels=int(stream.channels or 0),
            )
    except AudioError:
        raise
    except Exception as exc:
        raise AudioError(f"not decodable audio: {type(exc).__name__}: {exc}") from exc


def normalize_to_wav(src: Path, dst: Path) -> None:
    """Transcode to 16 kHz mono signed-16 WAV.

    Written frame by frame rather than assembled in memory: an hour of input is
    a perfectly ordinary thing for someone to upload.
    """
    dst.parent.mkdir(parents=True, exist_ok=True)
    resampler = av.audio.resampler.AudioResampler(
        format="s16", layout=TARGET_LAYOUT, rate=TARGET_SAMPLE_RATE
    )

    try:
        with av.open(str(src)) as container:
            if not container.streams.audio:
                raise AudioError("file contains no audio stream")
            stream = container.streams.audio[0]

            with sf.SoundFile(
                str(dst),
                mode="w",
                samplerate=TARGET_SAMPLE_RATE,
                channels=1,
                subtype="PCM_16",
            ) as out:
                wrote = False
                for frame in container.decode(stream):
                    for resampled in resampler.resample(frame):
                        out.write(resampled.to_ndarray().reshape(-1))
                        wrote = True
                # Flush whatever the resampler is still holding.
                for resampled in resampler.resample(None):
                    out.write(resampled.to_ndarray().reshape(-1))
                    wrote = True

                if not wrote:
                    raise AudioError("decoded to zero audio frames")

    except AudioError:
        dst.unlink(missing_ok=True)
        raise
    except Exception as exc:
        dst.unlink(missing_ok=True)
        raise AudioError(f"transcode failed: {type(exc).__name__}: {exc}") from exc


def wav_duration(path: Path) -> float:
    """Authoritative duration, counted in frames rather than read from a
    container header, so it agrees exactly with the peaks and the player."""
    with sf.SoundFile(str(path)) as snd:
        if snd.samplerate <= 0:
            raise AudioError("wav has no sample rate")
        return len(snd) / snd.samplerate


# ---------------------------------------------------------------------------
# Range serving
# ---------------------------------------------------------------------------

def _iter_file(path: Path, start: int, length: int) -> Iterator[bytes]:
    remaining = length
    with path.open("rb") as fh:
        fh.seek(start)
        while remaining > 0:
            chunk = fh.read(min(_STREAM_CHUNK, remaining))
            if not chunk:
                break
            remaining -= len(chunk)
            yield chunk


def _full(path: Path, size: int, media_type: str) -> Response:
    return StreamingResponse(
        _iter_file(path, 0, size),
        media_type=media_type,
        headers={"Accept-Ranges": "bytes", "Content-Length": str(size)},
    )


def range_response(
    path: Path, range_header: str | None, media_type: str = "audio/wav"
) -> Response:
    """Serve a file, honouring a single-range byte request.

    Implemented explicitly rather than leaning on FileResponse because seeking
    in the player depends on it, and the behaviour is worth pinning down in
    tests: 206 with a correct Content-Range, and 416 rather than a silent full
    body when the range cannot be satisfied.

    Multi-range is not supported; RFC 7233 permits answering any range request
    with the full 200 body, which is what an unrecognised header falls back to.
    """
    size = path.stat().st_size

    if not range_header:
        return _full(path, size, media_type)

    match = _RANGE_RE.match(range_header.strip())
    if not match:
        return _full(path, size, media_type)

    start_s, end_s = match.groups()
    unsatisfiable = Response(
        status_code=416,
        headers={"Accept-Ranges": "bytes", "Content-Range": f"bytes */{size}"},
    )

    if start_s == "":
        # Suffix form: the last N bytes.
        if end_s == "" or int(end_s) == 0:
            return unsatisfiable
        start = max(0, size - int(end_s))
        end = size - 1
    else:
        start = int(start_s)
        end = int(end_s) if end_s else size - 1
        if start >= size or start > end:
            return unsatisfiable
        end = min(end, size - 1)

    length = end - start + 1
    return StreamingResponse(
        _iter_file(path, start, length),
        status_code=206,
        media_type=media_type,
        headers={
            "Accept-Ranges": "bytes",
            "Content-Range": f"bytes {start}-{end}/{size}",
            "Content-Length": str(length),
        },
    )


__all__ = [
    "AudioError",
    "AudioInfo",
    "TARGET_SAMPLE_RATE",
    "probe",
    "normalize_to_wav",
    "wav_duration",
    "range_response",
]
