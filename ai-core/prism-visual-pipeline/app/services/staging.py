"""
StagingManager — Local filesystem staging for uploaded images and results.

Uploaded DSLR images are stored temporarily in a structured directory layout:

    staging/
      {session_id}/
        {batch_id}/
          original/      ← raw uploaded images
          redacted/       ← stranger-blurred versions
          results/        ← per-image JSON processing results
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Optional

from app.config import settings
from app.schemas.processing_result import ProcessingResult

logger = logging.getLogger(__name__)


class StagingManager:
    """Manages local file staging for upload batches."""

    def __init__(self):
        self._base = Path(settings.STAGING_DIR)

    def _batch_dir(self, session_id: str, batch_id: str) -> Path:
        return self._base / session_id / batch_id

    # ── Stage uploaded files ────────────────────────────────────────

    def stage_files(
        self,
        session_id: str,
        batch_id: str,
        files: list[tuple[str, bytes]],
    ) -> Path:
        """
        Save raw uploaded images to the staging directory.

        Args:
            session_id: Active session identifier.
            batch_id: Unique batch identifier for this upload.
            files: List of (filename, content_bytes) tuples.

        Returns:
            Path to the original images directory.
        """
        original_dir = self._batch_dir(session_id, batch_id) / "original"
        original_dir.mkdir(parents=True, exist_ok=True)

        for filename, content in files:
            filepath = original_dir / filename
            filepath.write_bytes(content)

        logger.info(
            "Staged %d files for session=%s, batch=%s at %s",
            len(files), session_id, batch_id, original_dir,
        )
        return original_dir

    # ── Save / load processing results ──────────────────────────────

    def save_result(
        self,
        session_id: str,
        batch_id: str,
        result: ProcessingResult,
    ) -> Path:
        """Save a ProcessingResult as JSON."""
        results_dir = self._batch_dir(session_id, batch_id) / "results"
        results_dir.mkdir(parents=True, exist_ok=True)

        # Use the image filename (without extension) as the JSON filename
        stem = Path(result.image_file).stem
        filepath = results_dir / f"{stem}.json"
        filepath.write_text(
            result.model_dump_json(indent=2),
            encoding="utf-8",
        )
        return filepath

    def load_result(
        self,
        session_id: str,
        batch_id: str,
        image_filename: str,
    ) -> Optional[ProcessingResult]:
        """Load a single ProcessingResult from its JSON file."""
        results_dir = self._batch_dir(session_id, batch_id) / "results"
        stem = Path(image_filename).stem
        filepath = results_dir / f"{stem}.json"

        if not filepath.exists():
            return None

        data = json.loads(filepath.read_text(encoding="utf-8"))
        return ProcessingResult.model_validate(data)

    def load_all_results(
        self,
        session_id: str,
        batch_id: str,
    ) -> list[ProcessingResult]:
        """Load all ProcessingResults for a batch."""
        results_dir = self._batch_dir(session_id, batch_id) / "results"

        if not results_dir.exists():
            return []

        results = []
        for filepath in sorted(results_dir.glob("*.json")):
            data = json.loads(filepath.read_text(encoding="utf-8"))
            results.append(ProcessingResult.model_validate(data))
        return results

    # ── Redacted images ─────────────────────────────────────────────

    def save_redacted(
        self,
        session_id: str,
        batch_id: str,
        image_filename: str,
        image_bytes: bytes,
    ) -> Path:
        """Save the redacted (stranger-blurred) version of an image."""
        redacted_dir = self._batch_dir(session_id, batch_id) / "redacted"
        redacted_dir.mkdir(parents=True, exist_ok=True)

        filepath = redacted_dir / image_filename
        filepath.write_bytes(image_bytes)
        return filepath

    # ── Path lookups ────────────────────────────────────────────────

    def get_original_path(
        self,
        session_id: str,
        batch_id: str,
        filename: str,
    ) -> Optional[Path]:
        """Get the filesystem path to an original uploaded image."""
        path = self._batch_dir(session_id, batch_id) / "original" / filename
        return path if path.exists() else None

    def get_redacted_path(
        self,
        session_id: str,
        batch_id: str,
        filename: str,
    ) -> Optional[Path]:
        """Get the filesystem path to a redacted image."""
        path = self._batch_dir(session_id, batch_id) / "redacted" / filename
        return path if path.exists() else None

    # ── Cleanup ─────────────────────────────────────────────────────

    def cleanup_batch(self, session_id: str, batch_id: str) -> None:
        """Remove all staged files for a batch."""
        import shutil
        batch_dir = self._batch_dir(session_id, batch_id)
        if batch_dir.exists():
            shutil.rmtree(batch_dir)
            logger.info("Cleaned up batch: %s/%s", session_id, batch_id)
