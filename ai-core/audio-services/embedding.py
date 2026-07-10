import torch
import torchaudio
import numpy as np
from cv2 import Mat
from insightface.app import FaceAnalysis
from speechbrain.inference.speaker import SpeakerRecognition

device = "cuda" if torch.cuda.is_available() else "cpu"

voice_encoder = SpeakerRecognition.from_hparams(
    source="speechbrain/spkrec-ecapa-voxceleb", 
    savedir="/tmp/models/spkrec-ecapa",
    run_opts={"device": device}
)


def extract_voice_vector(audio_path: str) -> list[float]:
    """Generates a 192-dimension acoustic signature array."""
    waveform, sr = torchaudio.load(audio_path)
    if sr != 16000:
        resampler = torchaudio.transforms.Resample(orig_freq=sr, new_freq=16000)
        waveform = resampler(waveform)
    
    with torch.no_grad():
        embedding = voice_encoder.encode_batch(waveform)
        vector = embedding[0][0].cpu().numpy().tolist()
    return vector
