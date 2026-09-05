"""Alembic environment for the ADG schema.

The URL is taken from app.config.settings (the same DATABASE_URL env var the
application uses), never from the ini file, so the migration tool and the app
can never disagree about which database is being touched.

../models defines every object the schema has -- indexes, partial unique
indexes and server defaults included -- so `alembic check` is a real guard:
metadata and database drift fails the test suite instead of rotting silently.
"""

from __future__ import annotations

import sys
from logging.config import fileConfig
from pathlib import Path

from alembic import context
from sqlalchemy import engine_from_config, pool

# Make `import app...` work when alembic runs from anywhere (tests run with
# cwd=/srv in the container, hand commands from server/ or the repo root on a
# host).
SERVER_DIR = Path(__file__).resolve().parents[1]
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))

from app.config import settings  # noqa: E402
from app.models import Base  # noqa: E402

config = context.config

# engine_from_config below reads `sqlalchemy.url` from the [alembic] section,
# which never carries one (see alembic.ini). The app config is the only
# source of truth for the URL.
config.set_main_option("sqlalchemy.url", settings.database_url)

if config.config_file_name is not None:
    fileConfig(config.config_file_name, disable_existing_loggers=False)

# Server defaults are part of the contract (statuses, colors, booleans): keep
# model metadata and the database honest about them.
COMPARE_ARGS = {"compare_type": True, "compare_server_default": True}

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    """Emit SQL without a live database (alembic upgrade head --sql)."""
    context.configure(
        url=settings.database_url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        **COMPARE_ARGS,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            **COMPARE_ARGS,
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
