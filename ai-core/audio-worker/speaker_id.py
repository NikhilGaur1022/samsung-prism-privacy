import soundfile as sf
import torch
import torchaudio
from speechbrain.inference.speaker import SpeakerRecognition
from speechbrain.utils.fetching import LocalStrategy

_speaker_embedding_model: SpeakerRecognition | None = None


def get_speaker_embedding_model() -> SpeakerRecognition:
    global _speaker_embedding_model
    if _speaker_embedding_model is None:
        device = "cuda" if torch.cuda.is_available() else "cpu"
        _speaker_embedding_model = SpeakerRecognition.from_hparams(
            source="speechbrain/spkrec-ecapa-voxceleb",
            savedir="/tmp/models/spkrec-ecapa",
            run_opts={"device": device},
            # COPY, not the SpeechBrain default of SYMLINK: creating a symlink
            # on Windows needs SeCreateSymbolicLinkPrivilege, which a normal
            # dev shell does not hold, so the default fails the first fetch
            # with WinError 1314. Copying costs one duplicate of an 80 MB
            # model and behaves identically on Linux, where the container runs.
            local_strategy=LocalStrategy.COPY,
        )
    return _speaker_embedding_model


def extract_voice_vector(
    audio_path: str, start_sec: float | None = None, end_sec: float | None = None
) -> list[float]:
    """Extracts a speaker embedding using SpeechBrain ECAPA-TDNN, optionally
    sliced to [start_sec, end_sec] of the file."""
    # soundfile, not torchaudio.load: as of torchaudio 2.9 that delegates to
    # torchcodec, which dlopens the system FFmpeg shared libraries and raises
    # if they are absent or too new. libsndfile ships inside the soundfile
    # wheel, so this has no system dependency at all. Nothing is lost by it:
    # both portals convert every clip to 16 kHz mono PCM WAV in the browser
    # before upload (see VoiceCapture.jsx), which is plain PCM.
    samples, sr = sf.read(audio_path, dtype="float32", always_2d=True)
    waveform = torch.from_numpy(samples.T.copy())  # (frames, ch) -> (ch, frames)
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
    # torchaudio.info was removed in 2.9 with the rest of the legacy backend
    # dispatcher, and this project is pinned to >=2.11. sf.info reads the
    # header only, which is what the docstring above promises.
    info = sf.info(audio_path)
    if not info.samplerate:
        return 0.0
    return float(info.frames) / float(info.samplerate)


# match_speaker() and cosine_similarity() used to live here, comparing a turn
# against reference snippets uploaded with the request. Identity matching now
# happens in the backend against a Qdrant gallery built from persisted
# SubjectVoiceEnrollment rows (backend/src/lib/voiceGallery.js), for the same
# reason face matching does: the worker holds no state, sees no consent, and
# must not be a second place where "is this person X" gets decided. A local copy
# kept "for convenience" would be a second implementation of the never-guess
# rule, free to drift from the one the redaction decision actually reads.
