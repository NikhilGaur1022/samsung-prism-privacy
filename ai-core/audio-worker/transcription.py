from typing import Iterable

import torch
from faster_whisper import WhisperModel

from config import settings

_whisper_model: WhisperModel | None = None


def get_whisper_model() -> WhisperModel:
    """Lazily builds the Whisper model. Same reasoning as
    diarization.get_diarization_pipeline(): don't pay model-load cost at
    import time, only on first real request."""
    global _whisper_model
    if _whisper_model is None:
        device = "cuda" if torch.cuda.is_available() else "cpu"
        compute_type = "float16" if device == "cuda" else "float32"
        _whisper_model = WhisperModel(
            settings.WHISPER_MODEL_SIZE, device=device, compute_type=compute_type
        )
    return _whisper_model


def transcribe(audio_path: str) -> list:
    """Returns faster-whisper Segment objects with word-level timestamps.

    vad_filter is off deliberately: this pipeline needs every spoken word
    (including short bystander utterances) to have a chance at being matched
    to a speaker and checked for PII — VAD's job is to skip silence, but an
    aggressive filter can also skip short, quiet, or overlapping speech that
    still needs to be evaluated for redaction.
    """
    model = get_whisper_model()
    segments, _info = model.transcribe(
        audio_path,
        word_timestamps=True,
        vad_filter=False,
    )
    return list(segments)
