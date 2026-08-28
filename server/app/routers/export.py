"""Bulk export and the user directory."""

from __future__ import annotations

import io
import zipfile

from fastapi import APIRouter, Depends, Query
from fastapi.responses import Response
from sqlalchemy import select

from app import annotations as store
from app.db import get_db
from app.domain import segments_to_rttm
from app.models import Recording, User
from app.rttm import serialize
from app.schemas import UserOut

router = APIRouter(prefix="/api", tags=["export"])


@router.get("/export/rttm.zip")
def export_all(
    status: str | None = Query("done", description="omit to export every recording"),
    db=Depends(get_db),
):
    """One .rttm per recording, named by session_name.

    This archive doubles as the human-readable cold backup: plain text that
    stays readable with no database and no software of ours.
    """
    conditions = [Recording.status == status] if status else []
    recordings = list(
        db.execute(
            select(Recording).where(*conditions).order_by(Recording.session_name)
        ).scalars()
    )

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for recording in recordings:
            _, segments = store.load_annotation(db, recording.id)
            body = serialize(
                recording.session_name,
                segments_to_rttm(segments, recording.session_name),
            )
            archive.writestr(f"{recording.session_name}.rttm", body)

    return Response(
        content=buffer.getvalue(),
        media_type="application/zip",
        headers={
            "Content-Disposition": 'attachment; filename="adg-rttm.zip"',
            "X-Recording-Count": str(len(recordings)),
        },
    )


@router.get("/users", response_model=list[UserOut])
def list_users(db=Depends(get_db)):
    return list(db.execute(select(User).order_by(User.name)).scalars())
