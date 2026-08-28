"""Recording lifecycle: upload, listing, claiming, audio, peaks, diarization."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, File, Form, Header, HTTPException, Query, UploadFile
from fastapi.responses import Response
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from app import ingest
from app.audio import AudioError, range_response
from app.config import settings
from app.db import get_db
from app.deps import current_user, get_recording
from app.models import Job, Recording, User
from app.peaks import peaks_path_for
from app.schemas import ClaimIn, JobOut, RecordingList, RecordingOut, UserOut

router = APIRouter(prefix="/api/recordings", tags=["recordings"])

# Statuses from which a human may take a file to work on.
CLAIMABLE = {"ready", "annotating", "done"}


def _out(db, recording: Recording) -> RecordingOut:
    """Build the response explicitly.

    model_validate(recording) cannot be used here: `claimed_by` is a user id on
    the ORM row but a nested user object in the response, and from_attributes
    would try to validate the raw UUID as a UserOut.
    """
    holder = db.get(User, recording.claimed_by) if recording.claimed_by else None
    return RecordingOut(
        id=recording.id,
        session_name=recording.session_name,
        original_name=recording.original_name,
        duration_sec=recording.duration_sec,
        status=recording.status,
        annotation_version=recording.annotation_version,
        claimed_by=UserOut(id=holder.id, name=holder.name) if holder else None,
        error=recording.error,
        created_at=recording.created_at,
        updated_at=recording.updated_at,
    )


@router.post("", status_code=201, response_model=RecordingOut)
def upload(
    file: UploadFile = File(...),
    session_name: str | None = Form(None),
    db=Depends(get_db),
    user: User = Depends(current_user),
):
    try:
        stored = ingest.ingest(db, file.file, file.filename or "upload", session_name)
    except ingest.DuplicateUpload as exc:
        raise HTTPException(
            409,
            {
                "code": "duplicate",
                "message": "these exact bytes are already ingested",
                "existing_id": str(exc.existing_id),
            },
        ) from None
    except AudioError as exc:
        raise HTTPException(400, {"code": "corrupt", "message": str(exc)}) from None
    except ValueError as exc:  # oversize
        raise HTTPException(413, {"code": "too_large", "message": str(exc)}) from None

    return _out(db, stored.recording)


@router.get("", response_model=RecordingList)
def list_recordings(
    status: str | None = Query(None),
    claimed_by: uuid.UUID | None = Query(None),
    q: str | None = Query(None, description="substring of the original filename"),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    db=Depends(get_db),
):
    conditions = []
    if status:
        conditions.append(Recording.status == status)
    if claimed_by:
        conditions.append(Recording.claimed_by == claimed_by)
    if q:
        conditions.append(Recording.original_name.ilike(f"%{q}%"))

    total = db.execute(
        select(func.count()).select_from(Recording).where(*conditions)
    ).scalar_one()
    rows = db.execute(
        select(Recording)
        .where(*conditions)
        .order_by(Recording.created_at)
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).scalars()

    return RecordingList(items=[_out(db, r) for r in rows], total=total)


@router.get("/{recording_id}", response_model=RecordingOut)
def get_one(recording: Recording = Depends(get_recording), db=Depends(get_db)):
    return _out(db, recording)


@router.delete("/{recording_id}", status_code=204)
def delete_one(recording: Recording = Depends(get_recording), db=Depends(get_db)):
    recording_id = recording.id
    db.delete(recording)
    db.commit()
    ingest.delete_artifacts(recording_id)
    return Response(status_code=204)


@router.get("/{recording_id}/audio")
def get_audio(
    recording: Recording = Depends(get_recording),
    range: str | None = Header(None),
):
    """Range support is what makes seeking in the player work; see app/audio.py."""
    path = ingest.wav_path_for(recording.id)
    if not path.exists():
        raise HTTPException(404, {"code": "no_audio", "message": "audio file missing"})
    return range_response(path, range)


@router.get("/{recording_id}/peaks")
def get_peaks(recording: Recording = Depends(get_recording)):
    """Raw little-endian float32, one value per 10 ms.

    The client does `new Float32Array(await res.arrayBuffer())` and hands it
    straight to wavesurfer, which then never decodes the audio itself.
    """
    path = peaks_path_for(ingest.audio_dir_for(recording.id))
    if not path.exists():
        raise HTTPException(404, {"code": "no_peaks", "message": "peaks not computed"})
    return Response(
        content=path.read_bytes(),
        media_type="application/octet-stream",
        headers={"X-Peaks-Per-Second": str(settings.peaks_per_second)},
    )


@router.post("/{recording_id}/claim", response_model=RecordingOut)
def claim(
    body: ClaimIn,
    recording: Recording = Depends(get_recording),
    db=Depends(get_db),
    user: User = Depends(current_user),
):
    if recording.status not in CLAIMABLE:
        raise HTTPException(
            409,
            {
                "code": "not_claimable",
                "message": f"status is {recording.status}; needs pre-labels first",
            },
        )

    held_by_other = recording.claimed_by and recording.claimed_by != user.id
    if held_by_other and not body.force:
        stale_after = datetime.now(timezone.utc) - timedelta(
            hours=settings.claim_stale_hours
        )
        if recording.claimed_at and recording.claimed_at > stale_after:
            holder = db.get(User, recording.claimed_by)
            raise HTTPException(
                409,
                {
                    "code": "already_claimed",
                    "message": f"claimed by {holder.name if holder else 'someone'}",
                    "claimed_at": recording.claimed_at.isoformat(),
                },
            )

    recording.claimed_by = user.id
    recording.claimed_at = datetime.now(timezone.utc)
    recording.status = "annotating"
    recording.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(recording)
    return _out(db, recording)


@router.post("/{recording_id}/complete", response_model=RecordingOut)
def complete(
    recording: Recording = Depends(get_recording),
    db=Depends(get_db),
    user: User = Depends(current_user),
):
    if recording.claimed_by != user.id:
        raise HTTPException(
            409, {"code": "not_claimant", "message": "only the claimant can complete"}
        )

    recording.status = "done"
    recording.claimed_by = None
    recording.claimed_at = None
    recording.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(recording)
    return _out(db, recording)


@router.post("/{recording_id}/diarize", status_code=202, response_model=JobOut)
def enqueue_diarize(
    recording: Recording = Depends(get_recording),
    db=Depends(get_db),
    user: User = Depends(current_user),
):
    """Queue pre-labelling. Replaces any existing annotation on success.

    Blocked while someone else holds the file: re-running would erase
    corrections they are in the middle of making.
    """
    if recording.claimed_by and recording.claimed_by != user.id:
        holder = db.get(User, recording.claimed_by)
        raise HTTPException(
            409,
            {
                "code": "claimed",
                "message": (
                    f"{holder.name if holder else 'someone'} is annotating this; "
                    f"re-running would discard their corrections"
                ),
            },
        )

    job = Job(recording_id=recording.id, status="queued")
    db.add(job)
    recording.status = "queued"
    recording.error = None
    recording.updated_at = datetime.now(timezone.utc)
    try:
        db.commit()
    except IntegrityError:
        # uq_jobs_active: a job for this recording is already queued or running.
        db.rollback()
        active = db.execute(
            select(Job)
            .where(Job.recording_id == recording.id, Job.status.in_(["queued", "running"]))
        ).scalar_one()
        raise HTTPException(
            409,
            {"code": "job_active", "message": "already queued", "job_id": str(active.id)},
        ) from None

    db.refresh(job)
    return job


@router.get("/{recording_id}/job", response_model=JobOut)
def latest_job(recording: Recording = Depends(get_recording), db=Depends(get_db)):
    job = db.execute(
        select(Job)
        .where(Job.recording_id == recording.id)
        .order_by(Job.created_at.desc())
        .limit(1)
    ).scalar_one_or_none()
    if job is None:
        raise HTTPException(404, {"code": "no_job", "message": "never diarized"})
    return job
