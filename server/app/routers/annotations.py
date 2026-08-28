"""Reading, saving, and exporting a recording's annotation."""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import PlainTextResponse

from app import annotations as store
from app.db import get_db
from app.deps import current_user, get_recording
from app.domain import (
    AnnotationError,
    SegmentIn,
    SpeakerIn,
    rttm_to_annotation,
    segments_to_rttm,
)
from app.models import Recording, User
from app.rttm import RttmError, parse, serialize
from app.schemas import (
    AdjustmentOut,
    AnnotationIn,
    AnnotationOut,
    AnnotationSaved,
    SegmentIO,
    SpeakerIO,
)

router = APIRouter(prefix="/api/recordings", tags=["annotations"])

# Statuses that mean "no usable annotation yet"; importing one makes the
# recording claimable.
_PRE_ANNOTATION = {"uploaded", "queued", "running", "failed"}


@router.get("/{recording_id}/annotation", response_model=AnnotationOut)
def read(recording: Recording = Depends(get_recording), db=Depends(get_db)):
    speakers, segments = store.load_annotation(db, recording.id)
    return AnnotationOut(
        version=recording.annotation_version,
        duration_sec=recording.duration_sec,
        speakers=[SpeakerIO.model_validate(s) for s in speakers],
        segments=[SegmentIO.model_validate(s) for s in segments],
    )


@router.put("/{recording_id}/annotation", response_model=AnnotationSaved)
def save(
    body: AnnotationIn,
    recording: Recording = Depends(get_recording),
    db=Depends(get_db),
    user: User = Depends(current_user),
):
    try:
        version, adjustments = store.save_annotation(
            db,
            recording,
            expected_version=body.version,
            speakers=[SpeakerIn(**s.model_dump()) for s in body.speakers],
            segments=[SegmentIn(**s.model_dump()) for s in body.segments],
            edited_by=user.id,
        )
    except store.VersionConflict as exc:
        raise HTTPException(
            409,
            {
                "code": "version_conflict",
                "message": "someone else saved first; reload before saving",
                "current_version": exc.current_version,
            },
        ) from None
    except AnnotationError as exc:
        raise HTTPException(422, {"code": "invalid", "message": str(exc)}) from None

    # Adjustments are reported, never applied in silence: a boundary the server
    # moved is something the annotator needs to see.
    return AnnotationSaved(
        version=version,
        adjustments=[AdjustmentOut(**a.__dict__) for a in adjustments],
    )


@router.post("/{recording_id}/annotation/rttm", response_model=AnnotationSaved)
def import_rttm(
    file: UploadFile = File(...),
    version: int = Form(..., description="the annotation version you are replacing"),
    allow_uri_mismatch: bool = Form(False),
    recording: Recording = Depends(get_recording),
    db=Depends(get_db),
    user: User = Depends(current_user),
):
    """Load pre-labels from an RTTM file produced elsewhere.

    Takes the same path a human save takes -- same parser, same validation,
    same clamping, same version bump -- so a machine-produced annotation gets
    no shortcuts a hand-made one does not.
    """
    if recording.claimed_by and recording.claimed_by != user.id:
        holder = db.get(User, recording.claimed_by)
        raise HTTPException(
            409,
            {
                "code": "claimed",
                "message": (
                    f"{holder.name if holder else 'someone'} is annotating this; "
                    f"importing would discard their corrections"
                ),
            },
        )

    raw = file.file.read()
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise HTTPException(
            422, {"code": "not_utf8", "message": f"cannot decode file: {exc}"}
        ) from None

    try:
        uri, turns = parse(text)
    except RttmError as exc:
        raise HTTPException(422, {"code": "bad_rttm", "message": str(exc)}) from None

    if not turns:
        raise HTTPException(
            422, {"code": "empty", "message": "the file contains no turns"}
        )

    # A mismatched file id almost always means the wrong RTTM was picked, and
    # importing it would quietly attach one recording's labels to another.
    if uri != recording.session_name and not allow_uri_mismatch:
        raise HTTPException(
            422,
            {
                "code": "uri_mismatch",
                "message": (
                    f"the file is labelled {uri!r} but this recording is "
                    f"{recording.session_name!r}; pass allow_uri_mismatch=true "
                    f"if that is intentional"
                ),
                "file_uri": uri,
                "session_name": recording.session_name,
            },
        )

    speakers, segments = rttm_to_annotation(turns)
    try:
        new_version, adjustments = store.save_annotation(
            db,
            recording,
            expected_version=version,
            speakers=speakers,
            segments=segments,
            edited_by=user.id,
        )
    except store.VersionConflict as exc:
        raise HTTPException(
            409,
            {
                "code": "version_conflict",
                "message": "someone else saved first; reload before importing",
                "current_version": exc.current_version,
            },
        ) from None
    except AnnotationError as exc:
        raise HTTPException(422, {"code": "invalid", "message": str(exc)}) from None

    if recording.status in _PRE_ANNOTATION:
        recording.status = "ready"
        recording.error = None
        recording.updated_at = datetime.now(timezone.utc)
        db.commit()

    return AnnotationSaved(
        version=new_version,
        adjustments=[AdjustmentOut(**a.__dict__) for a in adjustments],
    )


@router.get("/{recording_id}/rttm", response_class=PlainTextResponse)
def export_rttm(recording: Recording = Depends(get_recording), db=Depends(get_db)):
    _, segments = store.load_annotation(db, recording.id)
    try:
        body = serialize(
            recording.session_name, segments_to_rttm(segments, recording.session_name)
        )
    except RttmError as exc:
        raise HTTPException(
            500, {"code": "unexportable", "message": str(exc)}
        ) from None

    return PlainTextResponse(
        body,
        media_type="text/plain; charset=utf-8",
        headers={
            "Content-Disposition": (
                f'attachment; filename="{recording.session_name}.rttm"'
            )
        },
    )
