"""Database engine, session factory, and schema bootstrap.

Schema is applied from ``schema.sql`` at startup rather than through Alembic.
That is a deliberate, temporary choice: there is no production data yet, so a
drop-and-recreate is free. Before the phase-2 schema change (subtitles) this
must be replaced with real migrations — by then the database will hold hand-
corrected annotations that cannot be reproduced.
"""

from __future__ import annotations

from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings

SCHEMA_PATH = Path(__file__).parent / "schema.sql"

engine = create_engine(
    settings.database_url,
    pool_pre_ping=True,
    # Jobs hold a session open for the length of an inference run; a stale
    # pooled connection would otherwise surface as a mid-job failure.
    pool_recycle=1800,
    future=True,
)

SessionLocal = sessionmaker(bind=engine, expire_on_commit=False, future=True)


def init_schema() -> None:
    """Apply the idempotent DDL. Safe to call from every process at startup.

    Uses exec_driver_sql rather than execute(text(...)): the file holds many
    statements, and psycopg only accepts a multi-statement string through the
    simple query protocol, which it selects when no parameters are bound.
    """
    ddl = SCHEMA_PATH.read_text(encoding="utf-8")
    with engine.begin() as conn:
        conn.exec_driver_sql(ddl)


def get_db():
    """FastAPI dependency yielding a session that is always closed."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


__all__ = ["engine", "SessionLocal", "Session", "init_schema", "get_db"]
