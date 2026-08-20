import torch
from pyannote.audio import Pipeline

from audio_io import load_waveform
from config import settings

_diarization_pipeline: Pipeline | None = None


def get_diarization_pipeline() -> Pipeline:
    """Lazily builds the diarization pipeline. Loaded at import time in the
    original prototype, which made /health wait on a multi-second, HF-gated
    model download it doesn't need. Lazy loading here matches
    image-pii-worker's get_ocr_engine()/get_analyzer() pattern."""
    global _diarization_pipeline
    if _diarization_pipeline is None:
        if not settings.HF_TOKEN:
            raise RuntimeError(
                "HF_TOKEN is not set — pyannote/speaker-diarization-3.1 is a "
                "gated model and cannot be pulled without it."
            )
        device = "cuda" if torch.cuda.is_available() else "cpu"
        _diarization_pipeline = Pipeline.from_pretrained(
            "pyannote/speaker-diarization-3.1", token=settings.HF_TOKEN
        ).to(torch.device(device))
    return _diarization_pipeline


def diarize(
    audio_path: str,
    min_speakers: int | None = None,
    max_speakers: int | None = None,
) -> list[dict]:
    """Returns time-sorted diarization turns: [{start, end, speaker_id}].

    speaker_id is a diarization-local label (SPEAKER_00, SPEAKER_01, ...),
    not a subject identity — identity matching happens separately in
    speaker_id.py against uploaded voice snippets.
    """
    pipeline = get_diarization_pipeline()
    kwargs = {}
    if min_speakers is not None:
        kwargs["min_speakers"] = int(min_speakers)
    if max_speakers is not None:
        kwargs["max_speakers"] = int(max_speakers)

    # A waveform dictionary rather than the filename: handed a path, pyannote
    # decodes through torchcodec (pyannote/audio/core/io.py), which is the one
    # thing audio_io exists to avoid. The dictionary is pyannote's own
    # documented alternative - see AudioFileDocString in that module - and joins
    # the same code path immediately after loading.
    waveform, sample_rate = load_waveform(audio_path)
    audio = {"waveform": waveform, "sample_rate": sample_rate}

    diarization = pipeline(audio, **kwargs)

    annotation = getattr(diarization, "speaker_diarization", diarization)
    turns = [
        {"start": segment.start, "end": segment.end, "speaker_id": speaker_id}
        for segment, _track, speaker_id in annotation.itertracks(yield_label=True)
    ]
    turns.sort(key=lambda t: t["start"])
    return turns
