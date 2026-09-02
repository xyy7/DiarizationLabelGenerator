"""FastAPI application entry point."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text

from app.config import settings
from app.db import engine, init_schema
from app.routers import annotations, export, recordings

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger(__name__)

STATIC_DIR = Path("/srv/static")


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_schema()
    for directory in (settings.audio_dir, settings.tmp_dir, settings.export_dir):
        directory.mkdir(parents=True, exist_ok=True)
    log.info("schema applied; data dir %s", settings.data_dir)
    yield


app = FastAPI(
    title="ADG diarization annotation server",
    version="0.1.0",
    lifespan=lifespan,
)

app.include_router(recordings.router)
app.include_router(annotations.router)
app.include_router(export.router)


@app.get("/healthz")
def healthz():
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        db_ok = True
    except Exception:
        log.exception("health check could not reach the database")
        db_ok = False

    return JSONResponse(
        {"ok": db_ok, "db": db_ok}, status_code=200 if db_ok else 503
    )


# The built frontend, if it has been mounted. Registered last so it cannot
# shadow an API route.
#
# Gate on the assets directory, not the mount point: compose binds
# ./ADG/dist which Docker silently creates as an empty directory when the
# build has not run yet -- an empty /srv/static would pass .is_dir() and then
# crash uvicorn at import time with "directory does not exist".
if (STATIC_DIR / "assets").is_dir():
    app.mount("/assets", StaticFiles(directory=STATIC_DIR / "assets"), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa(full_path: str):
        """Serve index.html for any non-API path.

        The client router owns URLs like /rec/<id>. Mounting StaticFiles at the
        root would 404 those on refresh or on a link someone pasted to a
        colleague, which is exactly how they get used.
        """
        candidate = (STATIC_DIR / full_path).resolve()
        if (
            full_path
            and STATIC_DIR in candidate.parents
            and candidate.is_file()
        ):
            return FileResponse(candidate)
        return FileResponse(STATIC_DIR / "index.html")
