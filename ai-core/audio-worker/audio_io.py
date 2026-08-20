"""Decoding, in one place, because three call sites need the same bytes.

torchaudio is not used for this. As of 2.9 it removed `info` outright and
rerouted `load` through torchcodec, which dlopens the system FFmpeg shared
libraries — absent on a stock Windows box, and its wheel only carries cores for
FFmpeg 4-7, so a newer install does not satisfy it either. pyannote reaches for
torchcodec on the same path when handed a filename.

So nothing here takes that path. libsndfile ships inside the soundfile wheel and
reads the PCM WAV both portals upload; anything it refuses falls back to
faster-whisper's decoder, which is PyAV carrying its own FFmpeg inside the
wheel. The worker already transcribes through that decoder, so the fallback adds
no dependency and cannot disagree with the transcript about what was decoded.
"""

import soundfile as sf
import torch
from faster_whisper.audio import decode_audio

# What decode_audio is asked for when it is used. It resamples on the way out,
# and every model downstream wants 16 kHz anyway.
FALLBACK_RATE = 16000


def load_waveform(audio_path: str) -> tuple[torch.Tensor, int]:
    """Returns (waveform, sample_rate) with waveform shaped (channel, time).

    That layout is what both consumers expect: SpeechBrain's encode_batch and
    pyannote's waveform dictionary.
    """
    try:
        samples, sample_rate = sf.read(audio_path, dtype="float32", always_2d=True)
        # soundfile gives (frames, channels); the transpose is the whole
        # difference between the two conventions.
        return torch.from_numpy(samples.T.copy()), sample_rate
    except sf.LibsndfileError:
        # A container libsndfile does not open: WebM/Opus from a Chrome
        # MediaRecorder, MP4/AAC from Safari.
        mono = decode_audio(audio_path, sampling_rate=FALLBACK_RATE)
        return torch.from_numpy(mono).unsqueeze(0), FALLBACK_RATE


def duration_sec(audio_path: str) -> float:
    """Length of the file in seconds.

    Read from the header where the format allows it. The fallback decodes,
    which is slower, but a caller that cannot learn the duration cannot
    enforce a minimum against it — and being slow about a WebM clip beats
    rejecting it as unreadable.
    """
    try:
        info = sf.info(audio_path)
        if not info.samplerate:
            return 0.0
        return float(info.frames) / float(info.samplerate)
    except sf.LibsndfileError:
        return len(decode_audio(audio_path, sampling_rate=FALLBACK_RATE)) / FALLBACK_RATE
