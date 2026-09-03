"""The detection pass: decode -> detect on a stride -> track -> embed sparsely."""

import base64
import json
import logging
import subprocess

import cv2
import numpy as np
import requests
from insightface.app import FaceAnalysis

from config import settings, onnx_providers
from schemas import Box, PiiSpan, Track as TrackSchema, VideoMeta
from tracking import Tracker

logger = logging.getLogger("video-worker.analyze")

# buffalo_l — the SAME pack face-worker loads. Not a preference: the session
# gallery holds ArcFace vectors produced by that service, and a video track
# embedded with any other model would be compared against them with cosine
# similarity and produce confident nonsense.
_face_app: FaceAnalysis | None = None


def face_app() -> FaceAnalysis:
    global _face_app
    if _face_app is None:
        import os
        providers = onnx_providers()
        root_dir = os.environ.get("INSIGHTFACE_HOME", "~/.insightface/models")
        app = FaceAnalysis(name="buffalo_l", root=root_dir, providers=providers)
        app.prepare(ctx_id=0 if "CUDAExecutionProvider" in providers else -1, det_size=(640, 640))
        _face_app = app
        logger.info("insightface ready, providers=%s", providers)
    return _face_app


class PiiUnavailableError(RuntimeError):
    """The PII detector could not be reached or did not answer usefully.

    Distinct from "no PII found" for the same reason it is in the stills
    pipeline: collapsing the two ships an unmasked ID card and reports success.
    """


def probe(path: str) -> VideoMeta:
    """Container facts via ffprobe. No decode, no models."""
    try:
        raw = subprocess.run(
            [
                "ffprobe", "-v", "error", "-print_format", "json",
                "-show_format", "-show_streams", path,
            ],
            capture_output=True, text=True, timeout=60, check=True,
        ).stdout
    except subprocess.CalledProcessError as exc:
        raise ValueError(f"Unreadable video: {exc.stderr.strip()[:300]}") from exc
    except Exception as exc:
        raise ValueError(f"Could not probe video: {exc}") from exc

    data = json.loads(raw)
    streams = data.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    if video is None:
        raise ValueError("File contains no video stream")

    # avg_frame_rate is "30000/1001" style. r_frame_rate lies on VFR files more
    # often than avg does, so prefer avg and fall back.
    def _fps(value: str) -> float:
        try:
            num, den = value.split("/")
            return float(num) / float(den) if float(den) else 0.0
        except Exception:
            return 0.0

    fps = _fps(video.get("avg_frame_rate", "0/0")) or _fps(video.get("r_frame_rate", "0/0"))
    if fps <= 0:
        fps = 25.0
        logger.warning("no usable frame rate in container, assuming %s", fps)

    duration = float(data.get("format", {}).get("duration") or video.get("duration") or 0.0)
    frame_count = int(video.get("nb_frames") or 0) or int(round(duration * fps))

    return VideoMeta(
        duration_sec=round(duration, 3),
        fps=round(fps, 6),
        width=int(video.get("width") or 0),
        height=int(video.get("height") or 0),
        frame_count=frame_count,
        has_audio=any(s.get("codec_type") == "audio" for s in streams),
    )


def _quality(frame_bgr, box, det_score: float) -> float:
    """How much this frame's view of a face is worth embedding.

    Area x sharpness x detector confidence. A big blurry face and a tiny sharp
    one are both bad embeddings for different reasons, and the product punishes
    each. Sharpness is the variance of the Laplacian, the same measure
    face-worker's /embed reports for enrollment selfies.
    """
    x1, y1, x2, y2 = (int(max(0, v)) for v in box)
    crop = frame_bgr[y1:y2, x1:x2]
    if crop.size == 0:
        return 0.0
    area = (x2 - x1) * (y2 - y1)
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    sharpness = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    return float(area) * (1.0 + sharpness / 100.0) * float(det_score)


def _crop_jpeg(frame_bgr, box, size: int = 256) -> str | None:
    """The tagging card's thumbnail, base64 JPEG.

    Returned inline rather than through a second fetch: a crop is ~15KB and a
    clip yields a handful of tracks, so inlining costs less than the round trips
    and leaves no temp file on this side to clean up.
    """
    h, w = frame_bgr.shape[:2]
    x1, y1, x2, y2 = box
    pad_x, pad_y = (x2 - x1) * 0.25, (y2 - y1) * 0.25
    x1 = int(max(0, x1 - pad_x))
    y1 = int(max(0, y1 - pad_y))
    x2 = int(min(w, x2 + pad_x))
    y2 = int(min(h, y2 + pad_y))
    crop = frame_bgr[y1:y2, x1:x2]
    if crop.size == 0:
        return None
    crop = cv2.resize(crop, (size, size), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", crop, [int(cv2.IMWRITE_JPEG_QUALITY), 88])
    return base64.b64encode(buf.tobytes()).decode("ascii") if ok else None


def _detect_pii(frame_bgr, frame_index: int) -> list[dict]:
    """One frame to the image PII worker. Raises rather than returning [] on any
    failure — see PiiUnavailableError."""
    ok, buf = cv2.imencode(".jpg", frame_bgr, [int(cv2.IMWRITE_JPEG_QUALITY), 90])
    if not ok:
        raise PiiUnavailableError(f"could not encode frame {frame_index} for PII scan")

    try:
        res = requests.post(
            f"{settings.PII_SERVICE_URL}/detect-pii",
            files={"file": (f"frame-{frame_index}.jpg", buf.tobytes(), "image/jpeg")},
            timeout=settings.PII_TIMEOUT_SEC,
        )
    except Exception as exc:
        raise PiiUnavailableError(f"PII worker unreachable at frame {frame_index}: {exc}") from exc

    if res.status_code != 200:
        raise PiiUnavailableError(
            f"PII worker returned {res.status_code} at frame {frame_index}: {res.text[:200]}"
        )
    try:
        body = res.json()
    except Exception as exc:
        raise PiiUnavailableError(f"PII worker sent unreadable JSON at frame {frame_index}") from exc

    regions = body.get("regions")
    # Same rule as the stills path: a body with no regions array is not "clean".
    if not isinstance(regions, list):
        raise PiiUnavailableError(f"PII worker response at frame {frame_index} had no regions array")

    # `regions` is deduped [x1,y1,x2,y2] arrays; `entities` carries the entity
    # type for the same boxes. Only the TYPE is lifted across — `entities` also
    # holds the matched text, which is the Aadhaar number itself, and that must
    # not travel into a span record that ends up in a database or an audit log.
    types = {}
    for entity in body.get("entities") or []:
        box = entity.get("bbox")
        if isinstance(box, list) and len(box) >= 4:
            types.setdefault(tuple(box[:4]), entity.get("type") or "TEXT")

    return [
        {"bbox": region, "type": types.get(tuple(region[:4]), "TEXT")}
        for region in regions
        if isinstance(region, list) and len(region) >= 4
    ]


def analyze(path: str, scan_pii: bool = True) -> dict:
    meta = probe(path)
    app = face_app()

    capture = cv2.VideoCapture(path)
    if not capture.isOpened():
        raise ValueError("Could not open video for decoding")

    # Sampling rate in TIME, not in frames, so a 60fps clip does not do twice the
    # work of a 30fps one for identical footage. The configured frame stride is
    # the floor, which keeps the old behaviour on low-fps material.
    stride = max(
        settings.DETECT_STRIDE,
        int(round(meta.fps / max(0.1, settings.DETECT_FPS))) or 1,
    )
    pii_stride = max(1, int(round(meta.fps / max(0.01, settings.PII_SAMPLE_FPS))))
    # The DETECTION rate, not the clip's frame rate. Tracker.step() runs once per
    # sampled frame, so every budget inside it is denominated in samples.
    tracker = Tracker(meta.fps / stride)

    # Downscale factor for detection only. insightface resizes to det_size
    # internally, so this changes what we pay for the resize, not what the
    # detector sees. Boxes come back multiplied by 1/det_scale, in the original
    # frame's coordinates, because every consumer downstream — the quality score,
    # the representative crop, the backend's redaction schedule — works there.
    longest = max(meta.width, meta.height)
    det_scale = 1.0
    if settings.DETECT_MAX_SIDE > 0 and longest > settings.DETECT_MAX_SIDE:
        det_scale = settings.DETECT_MAX_SIDE / float(longest)
    logger.info(
        "analyze %dx%d @%.2ffps -> stride=%d det_scale=%.3f pii_stride=%d",
        meta.width, meta.height, meta.fps, stride, det_scale, pii_stride,
    )

    # Kept so a representative crop can be cut after the tracks are known —
    # the best frame for a track is only identifiable once the whole track is.
    best_frames: dict[int, np.ndarray] = {}
    # Quality of the best face on each cached frame, so the cache can evict the
    # least useful entry rather than an arbitrary one.
    best_quality_by_frame: dict[int, float] = {}
    pii_samples: list[tuple[int, list]] = []
    frames_detected = 0
    index = -1

    try:
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            index += 1

            if scan_pii and index % pii_stride == 0:
                regions = _detect_pii(frame, index)
                if regions:
                    pii_samples.append((index, regions))

            if index % stride != 0:
                continue

            frames_detected += 1
            if det_scale < 1.0:
                small = cv2.resize(
                    frame, None, fx=det_scale, fy=det_scale, interpolation=cv2.INTER_AREA
                )
            else:
                small = frame
            faces = app.get(small)
            detections = []
            best_quality = 0.0
            inv = 1.0 / det_scale
            for face in faces:
                # Back to full-resolution coordinates before anything else sees
                # them. Everything downstream indexes into `frame`, not `small`.
                box = tuple(float(v) * inv for v in face.bbox)
                quality = _quality(frame, box, float(face.det_score))
                best_quality = max(best_quality, quality)
                embedding = (
                    [float(v) for v in face.normed_embedding]
                    if face.normed_embedding is not None
                    else None
                )
                detections.append((box, float(face.det_score), embedding, quality))

            tracker.step(index, detections)
            if detections:
                # Bounded. Unbounded, this held one 6MB frame per detected frame
                # and reached ~2.5GB on a 40-second 1080p clip — the point at
                # which JPEG encoding started failing and /analyze answered 503.
                #
                # Evicting the lowest-quality frame keeps exactly the frames a
                # representative crop is ever cut from; a track whose frame was
                # evicted simply gets no crop, which the caller already handles.
                best_frames[index] = frame.copy()
                best_quality_by_frame[index] = best_quality
                if len(best_frames) > max(1, settings.BEST_FRAME_CACHE):
                    worst = min(best_quality_by_frame, key=best_quality_by_frame.get)
                    best_frames.pop(worst, None)
                    best_quality_by_frame.pop(worst, None)
    finally:
        capture.release()

    tracks = tracker.close(index)

    out_tracks = []
    for track in tracks:
        # Mean of the best N, then re-normalised. Averaging L2-normalised vectors
        # gives something off the unit sphere, and the backend's cosine is a bare
        # dot product that assumes unit length — skipping this would quietly
        # shrink every similarity score and under-match the whole clip.
        embedding = None
        if track.candidates:
            stacked = np.array([c[2] for c in track.candidates], dtype=np.float32)
            mean = stacked.mean(axis=0)
            norm = float(np.linalg.norm(mean))
            if norm > 0:
                embedding = (mean / norm).astype(float).tolist()

        rep_frame = track.candidates[0][1] if track.candidates else track.start_frame
        rep_box = next(
            (b for f, b in track.boxes if f == rep_frame),
            track.boxes[0][1],
        )
        crop = None
        if rep_frame in best_frames:
            crop = _crop_jpeg(best_frames[rep_frame], rep_box)

        # Widened by one sampling interval at each end, and this is a privacy
        # rule rather than a rounding convenience.
        #
        # A face is only ever SEEN on a sampled frame, but it was already there
        # on the frames between the previous sample and that one, and it is
        # still there after the last one. The schedule blurs [start, end]
        # exactly, so those frames went out unmasked — two frames of a real
        # face at each end of every track, which at 30fps is the flash of a
        # visible face that gets reported as "it un-blurs for a moment".
        #
        # redact.py holds the nearest keyframe outside the observed range, so
        # widening costs a couple of frames of blur over the spot the face
        # entered from. That is the cheap side of this trade.
        margin = max(0, stride - 1)
        first_frame = max(0, track.start_frame - margin)
        final_frame = track.last_frame + margin

        out_tracks.append(
            TrackSchema(
                track_id=track.track_id,
                start_frame=first_frame,
                end_frame=final_frame,
                start_sec=round(first_frame / meta.fps, 3),
                end_sec=round(final_frame / meta.fps, 3),
                boxes=[
                    Box(frame=f, x1=b[0], y1=b[1], x2=b[2], y2=b[3]) for f, b in track.boxes
                ],
                det_score=round(track.det_score, 4),
                embedding=embedding,
                embedded_frames=len(track.candidates),
                rep_frame=rep_frame,
                rep_crop_jpeg_b64=crop,
            )
        )

    # Each sample's regions are held until the next sample. Static text — the
    # overwhelmingly common case — is therefore covered continuously despite
    # being looked for once a second.
    spans = []
    for i, (frame_index, regions) in enumerate(pii_samples):
        end = pii_samples[i + 1][0] - 1 if i + 1 < len(pii_samples) else min(index, frame_index + pii_stride - 1)
        for region in regions:
            box = region.get("bbox") or region.get("box")
            if not box or len(box) < 4:
                continue
            spans.append(
                PiiSpan(
                    start_frame=frame_index,
                    end_frame=max(frame_index, end),
                    boxes=[Box(frame=frame_index, x1=box[0], y1=box[1], x2=box[2], y2=box[3])],
                    kind=str(region.get("type") or region.get("kind") or "TEXT"),
                )
            )

    return {
        "meta": meta,
        "tracks": out_tracks,
        "pii_spans": spans,
        "detect_stride": stride,
        "frames_detected": frames_detected,
        "gpu": "CUDAExecutionProvider" in onnx_providers(),
    }
