"""Shared FastAPI dependencies.

Identity is a name in a header and nothing more. This is an internal tool on a
trusted network; the point of knowing who someone is here is to show who has
claimed which file and who last edited it, not to keep anyone out. Adding
passwords would buy no safety and would cost every annotator a login.
"""

from __future__ import annotations

import uuid

from fastapi import Depends, Header, HTTPException, Path
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.db import get_db
from app.models import Recording, User


def current_user(
    db=Depends(get_db),
    x_user_name: str = Header(..., description="Annotator name, e.g. 'xuyuyu'"),
) -> User:
    name = x_user_name.strip()
    if not name:
        raise HTTPException(400, {"code": "missing_user", "message": "X-User-Name is empty"})

    # Upsert so a new annotator simply starts working; DO UPDATE rather than
    # DO NOTHING because the latter returns no row on conflict.
    stmt = (
        pg_insert(User)
        .values(name=name)
        .on_conflict_do_update(index_elements=[User.name], set_={"name": name})
        .returning(User)
    )
    user = db.execute(stmt).scalar_one()
    db.commit()
    return user


def get_recording(
    recording_id: uuid.UUID = Path(...),
    db=Depends(get_db),
) -> Recording:
    recording = db.execute(
        select(Recording).where(Recording.id == recording_id)
    ).scalar_one_or_none()
    if recording is None:
        raise HTTPException(404, {"code": "not_found", "message": "unknown recording"})
    return recording
