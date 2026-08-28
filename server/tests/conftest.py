from __future__ import annotations

from pathlib import Path

import pytest

DATA_DIR = Path(__file__).parent / "data"

# Real DiariZen output, copied from DiariZen/example/. Kept in the repo so the
# test suite is self-contained. Stored with LF endings: the upstream copy has
# CRLF purely because it was produced by Python text-mode writes on Windows,
# which is an artifact of the dev machine, not of the format.
GOLDEN_RTTM = DATA_DIR / "EN2002a_30s.rttm"

# The audio this RTTM annotates is exactly 30.000 s, but the last turn ends at
# 23.453 + 6.940 = 30.393 s. DiariZen overruns the file. Ingest must clamp and
# say so rather than truncate in silence.
GOLDEN_AUDIO_DURATION = 30.0
GOLDEN_OVERRUN = 0.393


@pytest.fixture
def golden_text() -> str:
    """The golden RTTM, read as bytes so line endings are unambiguous."""
    return GOLDEN_RTTM.read_bytes().decode("utf-8")
