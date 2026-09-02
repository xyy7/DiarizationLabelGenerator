"""HTTP client for the verify service, used by the API.

The API owns no torch; everything resembling a floating-point operation lives
in the verify container. This module is the only place the API learns of the
verify endpoint shapes, so the two sides stay compatible by construction.
"""

from __future__ import annotations

import logging
import uuid

import httpx

from app.config import settings

log = logging.getLogger(__name__)

DEFAULT_TIMEOUT = 60.0  # a first click may have to compute several embeddings


class VerifyUnavailable(Exception):
    """The verify service could not be reached (or answered nonsense)."""


class VerifyClient:
    def __init__(self, base_url: str, timeout: float = DEFAULT_TIMEOUT) -> None:
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout

    def similarity(
        self, recording_id: uuid.UUID, start_sec: float, end_sec: float
    ) -> dict:
        """Ask verify for the ranked similarity panel data.

        Raises VerifyUnavailable on any transport or protocol problem.
        """
        try:
            resp = httpx.post(
                f"{self._base_url}/similarity",
                json={
                    "recording_id": str(recording_id),
                    "query": {"start_sec": start_sec, "end_sec": end_sec},
                },
                timeout=self._timeout,
            )
            resp.raise_for_status()
        except httpx.HTTPError as exc:
            raise VerifyUnavailable(f"verify service unreachable: {exc}") from exc
        try:
            return resp.json()
        except ValueError as exc:
            # 200 but not JSON (or not the shape) -- nonsense is as good as
            # down, and must not surface as an API 500.
            raise VerifyUnavailable(
                "verify service answered with an unexpected body"
            ) from exc

    def precompute(self, recording_id: uuid.UUID) -> None:
        """Warm the stable-segment embedding cache. Fire-and-forget by design:
        an annotator's next click is the fallback, and this must never that.
        """
        try:
            resp = httpx.post(
                f"{self._base_url}/precompute",
                json={"recording_id": str(recording_id)},
                timeout=DEFAULT_TIMEOUT,
            )
            resp.raise_for_status()
        except httpx.HTTPError as exc:
            log.warning(
                "verify precompute for %s failed (will be computed on demand): %s",
                recording_id,
                exc,
            )


_client: VerifyClient | None = None


def get_verify_client() -> VerifyClient:
    global _client
    if _client is None:
        _client = VerifyClient(settings.verify_url)
    return _client


__all__ = ["VerifyClient", "VerifyUnavailable", "get_verify_client"]
