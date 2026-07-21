"""
PRISM Visual Pipeline — Configuration.

All settings are loaded from environment variables with the ``PRISM_`` prefix
(e.g. ``PRISM_QDRANT_HOST``) or from a ``.env`` file in the project root.
"""

from __future__ import annotations

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Application-wide configuration backed by environment variables."""

    # ── Qdrant vector-store ──────────────────────────────────────────
    QDRANT_HOST: str = "localhost"
    QDRANT_PORT: int = 6333
    QDRANT_GRPC_PORT: int = 6334

    # ── Face-matching thresholds ─────────────────────────────────────
    MATCH_THRESHOLD: float = 0.60
    MIN_DET_CONFIDENCE: float = 0.70

    # ── InsightFace model ────────────────────────────────────────────
    INSIGHTFACE_MODEL: str = "buffalo_l"
    DET_SIZE_W: int = 640
    DET_SIZE_H: int = 640

    # ── File staging ─────────────────────────────────────────────────
    STAGING_DIR: str = "./staging"

    # ── Blur parameters ──────────────────────────────────────────────
    BLUR_KERNEL_SIZE: int = 99
    BLUR_SIGMA: float = 30.0

    # ── Constants (not loaded from env) ──────────────────────────────
    EMBEDDING_DIM: int = 512

    model_config = {
        "env_prefix": "PRISM_",
        "env_file": ".env",
        "extra": "ignore",
    }


settings = Settings()
