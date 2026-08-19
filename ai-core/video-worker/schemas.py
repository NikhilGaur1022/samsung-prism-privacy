from pydantic import BaseModel


class Box(BaseModel):
    """One keyframed bounding box: the frame it was observed on, then x1,y1,x2,y2
    in that frame's pixel coordinates."""

    frame: int
    x1: float
    y1: float
    x2: float
    y2: float


class Track(BaseModel):
    """One person's continuous appearance in the clip.

    A track is NOT an identity. It is "the same face, frame after frame", which
    spatial continuity establishes far more reliably than embedding similarity
    ever does. Two tracks can be the same person (they left frame and came
    back); the backend's clustering step is what merges them, because that is
    the step that can also see the session's other photos.

    `embedding` is the mean of the best EMBED_FRAMES_PER_TRACK frames, L2
    normalised, so the backend's cosine similarity stays a plain dot product and
    matches what face-worker returns for a still. None when no frame in the
    track could be embedded — which the backend must read as "not identifiable",
    therefore untagged, therefore blurred.
    """

    track_id: str
    start_frame: int
    end_frame: int
    start_sec: float
    end_sec: float
    boxes: list[Box]
    det_score: float
    embedding: list[float] | None
    embedded_frames: int
    rep_frame: int
    rep_crop_jpeg_b64: str | None


class PiiSpan(BaseModel):
    """A run of frames over which sensitive printed text was visible.

    Sampled at PII_SAMPLE_FPS and held across the whole interval between
    samples. Unlike a face track this carries no identity and is never gated on
    consent — an Aadhaar number in frame is masked whoever is holding it, the
    same rule the stills pipeline applies.
    """

    start_frame: int
    end_frame: int
    boxes: list[Box]
    kind: str


class VideoMeta(BaseModel):
    duration_sec: float
    fps: float
    width: int
    height: int
    frame_count: int
    has_audio: bool


class AnalyzeResponse(BaseModel):
    meta: VideoMeta
    tracks: list[Track]
    pii_spans: list[PiiSpan]
    # What this run actually did, for the audit payload. `gpu`/`encoder` are here
    # because "the redaction took 40 minutes" and "the redaction took 40 seconds"
    # are the same code path on different hardware, and the log has to say which.
    detect_stride: int
    frames_detected: int
    gpu: bool


class ProbeResponse(VideoMeta):
    """Container facts only — no decode, no models.

    Split from /analyze because the upload route needs `has_audio` to decide
    whether to accept the file at all, and it must not pay for a full detection
    pass to find that out.
    """
