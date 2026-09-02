"""Upload ingest.

Order matters here: hash and probe before transcoding, so a duplicate upload
or a corrupt file costs a hash rather than a full ffmpeg pass, and so no row
or artifact is ever created for a file that turns out to be unreadable.
"""

from __future__ import annotations

import hashlib
import shutil
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app import audio, peaks
from app.config import settings
from app.models import Recording
from app.rttm import sanitize_uri

_HASH_CHUNK = 1 << 20


class DuplicateUpload(Exception):
    def __init__(self, existing_id: uuid.UUID) -> None:
        super().__init__(f"already ingested as {existing_id}")
        self.existing_id = existing_id


@dataclass(frozen=True)
class Stored:
    recording: Recording
    audio_path: Path
    peaks_path: Path


def audio_dir_for(recording_id: uuid.UUID) -> Path:
    return settings.audio_dir / str(recording_id)


def wav_path_for(recording_id: uuid.UUID) -> Path:
    return audio_dir_for(recording_id) / "audio.wav"


def _spool(source: BinaryIO, dest: Path, max_bytes: int) -> str:
    """Copy to disk in chunks, hashing on the way. Never buffers the whole
    upload in memory -- these files run to hundreds of megabytes."""
    digest = hashlib.sha256()
    written = 0
    dest.parent.mkdir(parents=True, exist_ok=True)

    with dest.open("wb") as out:
        while chunk := source.read(_HASH_CHUNK):
            written += len(chunk)
            if written > max_bytes:
                raise ValueError(f"upload exceeds {max_bytes} bytes")
            digest.update(chunk)
            out.write(chunk)

    return digest.hexdigest()


def _unique_session_name(db, proposed: str) -> str:
    """Session name doubles as the RTTM file id, so it has to be unique."""
    base = sanitize_uri(proposed) or "recording"
    name = base
    suffix = 2
    while db.execute(
        select(Recording.id).where(Recording.session_name == name)
    ).first():
        name = f"{base}-{suffix}"
        suffix += 1
    return name


def ingest(
    db,
    stream: BinaryIO,
    original_name: str,
    session_name: str | None = None,
) -> Stored:
    """Store an upload and return the new recording.

    Raises DuplicateUpload if these exact bytes are already here, or
    audio.AudioError if the file is not decodable audio.
    """
    settings.tmp_dir.mkdir(parents=True, exist_ok=True)
    tmp = settings.tmp_dir / f"{uuid.uuid4()}.upload"
    created_dir: Path | None = None

    try:
        sha256 = _spool(stream, tmp, settings.max_upload_bytes)

        # Cheap check before the expensive transcode.
        existing = db.execute(
            select(Recording.id).where(Recording.sha256 == sha256)
        ).scalar_one_or_none()
        if existing is not None:
            raise DuplicateUpload(existing)

        # Gate on decodability before anything durable is created.
        audio.probe(tmp)

        recording_id = uuid.uuid4()
        created_dir = audio_dir_for(recording_id)
        wav = wav_path_for(recording_id)
        audio.normalize_to_wav(tmp, wav)

        # Duration and peaks both come from the normalized wav, which is also
        # what gets served and what the model reads. Nothing to disagree about.
        duration = audio.wav_duration(wav)
        peaks_file = peaks.peaks_path_for(audio_dir_for(recording_id))
        peaks.write_peaks(peaks.compute_peaks(wav), peaks_file)

        # Kept for provenance; everything downstream uses the wav.
        original_ext = Path(original_name).suffix
        shutil.copy2(tmp, audio_dir_for(recording_id) / f"original{original_ext}")

        recording = Recording(
            id=recording_id,
            session_name=_unique_session_name(db, session_name or Path(original_name).stem),
            original_name=original_name,
            sha256=sha256,
            duration_sec=duration,
            status="uploaded",
        )
        db.add(recording)
        try:
            db.commit()
        except IntegrityError:
            # Either lost a race with a concurrent upload of the same bytes,
            # or one of the same stem beat us to the session name.
            db.rollback()
            existing = db.execute(
                select(Recording.id).where(Recording.sha256 == sha256)
            ).scalar_one_or_none()
            if existing is not None:
                raise DuplicateUpload(existing) from None
            # Not the hash race: claim another name and retry. The window is
            # tiny, so a few attempts is plenty.
            last: IntegrityError | None = None
            for _ in range(3):
                recording.session_name = _unique_session_name(
                    db, session_name or Path(original_name).stem
                )
                db.add(recording)
                try:
                    db.commit()
                    break
                except IntegrityError as exc:
                    last = exc
                    db.rollback()
            else:
                raise last

        db.refresh(recording)
        created_dir = None  # committed: the files now belong to a real row
        return Stored(recording=recording, audio_path=wav, peaks_path=peaks_file)

    finally:
        tmp.unlink(missing_ok=True)
        # Anything that produced files but no committed row would otherwise sit
        # on disk forever with nothing referencing it.
        if created_dir is not None:
            shutil.rmtree(created_dir, ignore_errors=True)


def delete_artifacts(recording_id: uuid.UUID) -> None:
    shutil.rmtree(audio_dir_for(recording_id), ignore_errors=True)


__all__ = [
    "DuplicateUpload",
    "Stored",
    "ingest",
    "audio_dir_for",
    "wav_path_for",
    "delete_artifacts",
]
