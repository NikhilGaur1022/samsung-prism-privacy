import torch
import torchaudio
from speechbrain.inference.speaker import SpeakerRecognition

_speaker_embedding_model: SpeakerRecognition | None = None


def get_speaker_embedding_model() -> SpeakerRecognition:
    global _speaker_embedding_model
    if _speaker_embedding_model is None:
        device = "cuda" if torch.cuda.is_available() else "cpu"
        _speaker_embedding_model = SpeakerRecognition.from_hparams(
            source="speechbrain/spkrec-ecapa-voxceleb",
            savedir="/tmp/models/spkrec-ecapa",
            run_opts={"device": device},
        )
    return _speaker_embedding_model


def extract_voice_vector(
    audio_path: str, start_sec: float | None = None, end_sec: float | None = None
) -> list[float]:
    """Extracts a speaker embedding using SpeechBrain ECAPA-TDNN, optionally
    sliced to [start_sec, end_sec] of the file."""
    waveform, sr = torchaudio.load(audio_path)
    if sr != 16000:
        waveform = torchaudio.transforms.Resample(sr, 16000)(waveform)

    if start_sec is not None and end_sec is not None:
        start_sample = int(start_sec * 16000)
        end_sample = int(end_sec * 16000)
        waveform = waveform[:, start_sample:end_sample]

    with torch.no_grad():
        embedding = get_speaker_embedding_model().encode_batch(waveform)

    return embedding[0][0].cpu().numpy().tolist()


def audio_duration_sec(audio_path: str) -> float:
    """Length of the file in seconds, read from the header rather than by
    decoding — /embed reports it back so the backend can enforce its minimum
    enrollment length against what the worker actually received, not against
    what a client claimed in a form field."""
    info = torchaudio.info(audio_path)
    if not info.sample_rate:
        return 0.0
    return float(info.num_frames) / float(info.sample_rate)


# match_speaker() and cosine_similarity() used to live here, comparing a turn
# against reference snippets uploaded with the request. Identity matching now
# happens in the backend against a Qdrant gallery built from persisted
# SubjectVoiceEnrollment rows (backend/src/lib/voiceGallery.js), for the same
# reason face matching does: the worker holds no state, sees no consent, and
# must not be a second place where "is this person X" gets decided. A local copy
# kept "for convenience" would be a second implementation of the never-guess
# rule, free to drift from the one the redaction decision actually reads.
