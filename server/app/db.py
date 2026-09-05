"""Database engine, session factory, and schema bootstrap.

Schema is managed by Alembic (``server/migrations/``); ``init_schema()`` runs
``upgrade head`` and is safe to call from every process at startup (api,
worker, verify -- the containers start in any order). The baseline revision is
an idempotent transcription of the old startup DDL (``schema.sql``), so every
database state converges without touching data:

- a fresh database lands with every object;
- a pre-Alembic database re-runs the same ``IF NOT EXISTS`` statements it has
  seen at every startup since its birth -- nothing is re-created, and the
  hand-corrected annotations already in it are never touched;
- a migrated database is a no-op at head.

``tests/test_migrations.py`` guards the other direction: ``alembic check``
fails when the database and ``app/models.py`` drift, so the next schema change
is a migration revision, not hand DDL.
"""

from __future__ import annotations

from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings

MIGRATIONS_DIR = Path(__file__).resolve().parents[1] / "migrations"

# Three containers call init_schema() at startup. The old schema.sql bootstrap
# was safe under that race because every statement was IF NOT EXISTS; the one
# thing that is not idempotent is alembic's version bookkeeping, so serialize
# the whole migration on a session-level advisory lock (released when the
# connection is closed, right after upgrade returns).
_MIGRATION_LOCK_KEY = 475104292

engine = create_engine(
    settings.database_url,
    pool_pre_ping=True,
    # Jobs hold a session open for the length of an inference run; a stale
    # pooled connection would otherwise surface as a mid-job failure.
    pool_recycle=1800,
    future=True,
)

SessionLocal = sessionmaker(bind=engine, expire_on_commit=False, future=True)


def alembic_config() -> Config:
    """Alembic configuration targeting the database this app uses.

    Deliberately built without alembic.ini: script_location is derived from
    the file tree (so it works from any working directory), and
    migrations/env.py reads the URL from ``app.config`` -- the same env var
    the application uses -- so the tool can never aim at a different database
    than the app. The ini file at server/alembic.ini is only for hand-run
    commands such as ``alembic revision --autogenerate``.
    """
    cfg = Config()
    cfg.set_main_option("script_location", str(MIGRATIONS_DIR))
    return cfg


def init_schema() -> None:
    """Bring the database to head. Safe to call from every process at startup."""
    # The advisory lock must be held by a session of our own: alembic uses a
    # separate connection, and a transaction-scoped lock would be released by
    # the first statement of that engine before the migration runs.
    with engine.connect() as conn:
        conn.exec_driver_sql(
            f"SELECT pg_advisory_lock({_MIGRATION_LOCK_KEY})"
        )
        try:
            command.upgrade(alembic_config(), "head")
        finally:
            conn.exec_driver_sql(
                f"SELECT pg_advisory_unlock({_MIGRATION_LOCK_KEY})"
            )


def get_db():
    """FastAPI dependency yielding a session that is always closed."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


__all__ = [
    "engine",
    "SessionLocal",
    "Session",
    "alembic_config",
    "init_schema",
    "get_db",
]
