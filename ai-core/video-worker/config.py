import os
import shutil
import subprocess

from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import Field


class Settings(BaseSettings):
    """Stateless, exactly like face-worker and audio-worker.

    No database, no consent decision, no idea who any of these people are. It
    reports where faces are and what they look like; the backend joins that
    against `project_consent_matrix` and calls /redact back with a box list it
    has already decided on.
    """

    ENV: str = Field(default="development")
    PROJECT_NAME: str = "Samsung-Prism-Privacy-Video-Worker"

    # Detection stride, in frames. 3 at 30fps = detect ~10x/sec, and the tracker
    # fills the two frames in between. The cost is linear in 1/stride, so this
    # is the single biggest performance knob; the risk of raising it is that a
    # fast head turn moves further between detections than the box dilation
    # covers. Tuned with VIDEO_HOLD_SEC, not alone.
    DETECT_STRIDE: int = Field(default=3)

    # How long a track's last known box keeps being blurred after the detector
    # stops finding it. This is the temporal half of failing closed: a detector
    # that drops a face for 8 frames mid-turn would otherwise un-blur a stranger
    # for a quarter second in a file stamped "redacted". Holding costs a few
    # blurred frames of empty background; not holding costs a privacy breach.
    HOLD_SEC: float = Field(default=0.5)

    # IoU below which a detection is considered a different person than the
    # track it is being compared to. 0.3 is loose on purpose — over-linking two
    # people into one track is caught later by the backend's cluster/tag step,
    # while splitting one person into many tracks just makes more cards.
    IOU_THRESHOLD: float = Field(default=0.3)

    # Frames per track that get an ArcFace embedding. The mean of the best 5 is
    # markedly more stable than any single frame, and embedding is the expensive
    # half of the pass — this is what keeps a 3600-frame clip affordable.
    EMBED_FRAMES_PER_TRACK: int = Field(default=5)

    # A track shorter than this is noise: a flicker of a background pattern that
    # scored over the detector's threshold for two frames. Dropping them keeps
    # the agent's tagging queue readable. They are still BLURRED — dropping the
    # track only removes the card, and anything without a card is not TAGGED,
    # which the backend already treats as blur.
    MIN_TRACK_FRAMES: int = Field(default=4)

    # Proportion of box size added on every side of a blur region. Covers the
    # drift between two detections and the jaw/hairline that a tight face box
    # cuts off.
    BOX_DILATION: float = Field(default=0.15)

    # PII text is OCR'd far more sparsely than faces are detected: printed text
    # is static in the common case (an ID card lying on a table), so 1 sample
    # per second finds it and the region is then held across the whole interval.
    PII_SAMPLE_FPS: float = Field(default=1.0)

    # The existing image PII detector, reused over the network rather than
    # reimplemented here. One definition of "what counts as PII" for stills and
    # video both — a second copy would drift, and the copy that drifts is the
    # one that stops masking Aadhaar numbers.
    PII_SERVICE_URL: str = Field(default="http://image-pii-worker:8002")
    PII_TIMEOUT_SEC: float = Field(default=30.0)

    BLUR_KERNEL: int = Field(default=99)
    BLUR_SIGMA: float = Field(default=30.0)
    PII_MOSAIC_BLOCKS: int = Field(default=6)

    CRF: int = Field(default=23)
    PRESET: str = Field(default="veryfast")

    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )


settings = Settings()


def onnx_providers() -> list[str]:
    """CUDA when the runtime actually exposes it, CPU otherwise.

    Probed rather than configured. A CUDA provider named in config but missing
    at runtime makes insightface fail at model load with an error that reads
    like a corrupt download, and the fix ("you are on the CPU image") is not
    discoverable from it.
    """
    try:
        import onnxruntime

        available = onnxruntime.get_available_providers()
    except Exception:
        return ["CPUExecutionProvider"]

    if "CUDAExecutionProvider" in available:
        return ["CUDAExecutionProvider", "CPUExecutionProvider"]
    return ["CPUExecutionProvider"]


def video_encoder() -> str:
    """NVENC when this ffmpeg can actually USE it, libx264 otherwise.

    Same reasoning as onnx_providers: probed, because the answer differs
    between the CPU and GPU images built from this one Dockerfile.

    The probe has to be a real encode, not a listing. `ffmpeg -encoders` reports
    what the binary was COMPILED with, and Debian's ffmpeg ships nvenc support
    whether or not the machine has an NVIDIA card in it. The CPU image therefore
    passed the listing check, selected h264_nvenc, and then died the moment a
    frame was written to it:

        BrokenPipeError: [Errno 32] Broken pipe   (redact.py, process.stdin.write)

    /health reported "encoder": "h264_nvenc" throughout, so the service looked
    correctly configured while every single /redact returned 500 — and on the
    caller's side that is indistinguishable from the worker being down, so the
    clip is parked DEFERRED and the session never archives.

    One frame at 32x32 costs a few hundred milliseconds, once, at import.
    """
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return "libx264"
    try:
        probe = subprocess.run(
            [
                ffmpeg, "-hide_banner", "-loglevel", "error",
                "-f", "lavfi", "-i", "nullsrc=s=32x32:d=0.1",
                "-c:v", "h264_nvenc", "-f", "null", "-",
            ],
            capture_output=True,
            timeout=20,
        )
        if probe.returncode == 0:
            return "h264_nvenc"
    except Exception:
        pass
    return "libx264"


GPU_ENABLED = "CUDAExecutionProvider" in onnx_providers()
ENCODER = video_encoder()
