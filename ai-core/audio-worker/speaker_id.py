import numpy as np
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


def cosine_similarity(vec_a: list[float], vec_b: list[float]) -> float:
    a = np.array(vec_a)
    b = np.array(vec_b)
    denom = np.linalg.norm(a) * np.linalg.norm(b)
    if denom == 0:
        return 0.0
    return float(np.dot(a, b) / denom)


def match_speaker(
    current_embedding: list[float],
    registered_vectors: dict[str, list[float]],
    threshold: float,
) -> tuple[str | None, float]:
    """Compares one speaker's embedding against every registered voice
    snippet and returns (best_matching_muid_or_None, best_score).

    Returns None for the muid — never a guessed identity — when nothing
    clears `threshold`. The caller must treat an unmatched speaker as an
    unconsented bystander, not as "probably the closest one."
    """
    best_muid: str | None = None
    best_score = 0.0
    for muid, target_vector in registered_vectors.items():
        score = cosine_similarity(target_vector, current_embedding)
        if score > best_score:
            best_score = score
            best_muid = muid

    if best_muid is not None and best_score >= threshold:
        return best_muid, best_score
    return None, best_score
