"""
SessionQdrantManager — Manages ephemeral per-session Qdrant collections.

Each photography session gets its own collection storing consented-subject
face embeddings. Collections are created on session start and deleted on
session end, ensuring no biometric data persists beyond its intended scope.
"""

from __future__ import annotations

import logging
from typing import Optional
from uuid import uuid4

from qdrant_client import QdrantClient, models

from app.config import settings

logger = logging.getLogger(__name__)


class SessionQdrantManager:
    """
    Thin wrapper around QdrantClient for session-scoped vector collections.

    Uses a singleton client shared across the application lifetime.
    Collections are named ``session_{session_id}`` to avoid clashes.
    """

    _client: Optional[QdrantClient] = None

    @classmethod
    def _get_client(cls) -> QdrantClient:
        """Return (or lazily create) the singleton QdrantClient."""
        if cls._client is None:
            host = settings.QDRANT_HOST
            if host == ":memory:":
                logger.info("Using in-memory Qdrant (no external server required)")
                cls._client = QdrantClient(location=":memory:")
            else:
                cls._client = QdrantClient(
                    host=host,
                    port=settings.QDRANT_PORT,
                    grpc_port=settings.QDRANT_GRPC_PORT,
                )
        return cls._client

    @staticmethod
    def _collection_name(session_id: str) -> str:
        return f"session_{session_id}"

    # ── Session lifecycle ────────────────────────────────────────────

    def create_session(self, session_id: str) -> str:
        """Create a new Qdrant collection for the session."""
        client = self._get_client()
        col_name = self._collection_name(session_id)

        client.create_collection(
            collection_name=col_name,
            vectors_config=models.VectorParams(
                size=settings.EMBEDDING_DIM,
                distance=models.Distance.COSINE,
            ),
        )

        logger.info(
            "Created session Qdrant collection: %s (dim=%d, distance=COSINE)",
            col_name, settings.EMBEDDING_DIM,
        )
        return col_name

    def session_exists(self, session_id: str) -> bool:
        """Check whether a session collection already exists."""
        client = self._get_client()
        col_name = self._collection_name(session_id)
        try:
            client.get_collection(col_name)
            return True
        except Exception:
            return False

    def delete_session(self, session_id: str) -> None:
        """Delete the session's Qdrant collection and all its data."""
        client = self._get_client()
        col_name = self._collection_name(session_id)
        client.delete_collection(col_name)
        logger.info("Deleted session Qdrant collection: %s", col_name)

    # ── Enrollment operations ────────────────────────────────────────

    def add_enrollment(
        self,
        session_id: str,
        consent_id: str,
        embedding: list[float],
        payload: Optional[dict] = None,
    ) -> str:
        """
        Store a consented subject's face embedding in the session collection.

        Returns the generated point_id (UUID string).
        """
        client = self._get_client()
        col_name = self._collection_name(session_id)
        point_id = str(uuid4())

        point_payload = {"consent_id": consent_id}
        if payload:
            point_payload.update(payload)

        client.upsert(
            collection_name=col_name,
            points=[
                models.PointStruct(
                    id=point_id,
                    vector=embedding,
                    payload=point_payload,
                ),
            ],
        )

        logger.info(
            "Enrolled consent_id=%s in collection=%s (point_id=%s)",
            consent_id, col_name, point_id,
        )
        return point_id

    def search_face(
        self,
        session_id: str,
        embedding: list[float],
        threshold: Optional[float] = None,
    ) -> Optional[tuple[str, float, dict]]:
        """
        Search for the closest matching face in the session collection.

        Uses ``query_points()`` (qdrant-client v1.16+).

        Returns:
            ``(consent_id, score, payload)`` if a match is found above
            the threshold, otherwise ``None``.
        """
        client = self._get_client()
        col_name = self._collection_name(session_id)
        threshold = threshold or settings.MATCH_THRESHOLD

        result = client.query_points(
            collection_name=col_name,
            query=embedding,
            limit=1,
            with_payload=True,
        )

        if not result.points:
            return None

        top = result.points[0]
        score = float(top.score)

        if score < threshold:
            return None

        consent_id = top.payload.get("consent_id", "")
        logger.info(
            "Matched face in %s: consent_id=%s, score=%.4f",
            col_name, consent_id, score,
        )
        return consent_id, score, top.payload

    def list_enrollments(self, session_id: str) -> list[dict]:
        """
        List all enrolled subjects in a session collection.

        Returns a list of payload dicts (each containing consent_id,
        subject_name, etc.).
        """
        client = self._get_client()
        col_name = self._collection_name(session_id)

        records, _ = client.scroll(
            collection_name=col_name,
            limit=1000,
            with_payload=True,
            with_vectors=False,
        )

        return [r.payload for r in records]
