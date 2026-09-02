"""The execution pass: apply a box schedule the backend already decided on.

This module makes no decisions. It never sees a subject id, a consent status or
a tag — only frame ranges and rectangles. That is the same separation
face-worker's /redact and audio-worker's /redact keep, and it is what makes the
consent logic reviewable in one place instead of three.
"""

import logging
import os
import subprocess

import cv2
import numpy as np

from config import settings, ENCODER

logger = logging.getLogger("video-worker.redact")


def _interpolate(keyframes: list[tuple[int, tuple]], frame: int):
    """The box for `frame`, given boxes observed on other frames.

    Outside the observed range the nearest keyframe is held rather than the
    region being dropped. That hold is the whole point: the schedule's
    start/end_frame come from a track that was coasting through an occlusion,
    and un-blurring for those frames is exactly the failure this pipeline
    exists to prevent.
    """
    if not keyframes:
        return None
    if frame <= keyframes[0][0]:
        return keyframes[0][1]
    if frame >= keyframes[-1][0]:
        return keyframes[-1][1]

    for i in range(len(keyframes) - 1):
        f0, b0 = keyframes[i]
        f1, b1 = keyframes[i + 1]
        if f0 <= frame <= f1:
            if f1 == f0:
                return b0
            t = (frame - f0) / (f1 - f0)
            return tuple(b0[k] + (b1[k] - b0[k]) * t for k in range(4))
    return keyframes[-1][1]


def _dilate(box, width: int, height: int, ratio: float):
    x1, y1, x2, y2 = box
    if x2 < x1:
        x1, x2 = x2, x1
    if y2 < y1:
        y1, y2 = y2, y1
    pad_x = (x2 - x1) * ratio
    pad_y = (y2 - y1) * ratio
    x1 = int(max(0, round(x1 - pad_x)))
    y1 = int(max(0, round(y1 - pad_y)))
    x2 = int(min(width, round(x2 + pad_x)))
    y2 = int(min(height, round(y2 + pad_y)))
    if x2 <= x1 or y2 <= y1:
        return None
    return x1, y1, x2, y2


def _parse_regions(specs: list[dict]) -> list[dict]:
    parsed = []
    for spec in specs or []:
        keyframes = []
        for box in spec.get("boxes") or []:
            if isinstance(box, dict):
                keyframes.append((int(box["frame"]), (float(box["x1"]), float(box["y1"]), float(box["x2"]), float(box["y2"]))))
            elif len(box) >= 5:
                keyframes.append((int(box[0]), (float(box[1]), float(box[2]), float(box[3]), float(box[4]))))
        if not keyframes:
            continue
        keyframes.sort(key=lambda k: k[0])
        parsed.append(
            {
                "keyframes": keyframes,
                "start": int(spec.get("start_frame", keyframes[0][0])),
                "end": int(spec.get("end_frame", keyframes[-1][0])),
            }
        )
    return parsed


def _blur(frame, rect, kernel: int, sigma: float):
    x1, y1, x2, y2 = rect
    roi = frame[y1:y2, x1:x2]
    if roi.size == 0:
        return
    k = kernel if kernel % 2 == 1 else kernel + 1
    # A kernel wider than the region spends the entire pass on reflected border
    # pixels and leaves the face legible.
    k = max(3, min(k, (min(x2 - x1, y2 - y1) // 2) * 2 + 1))
    frame[y1:y2, x1:x2] = cv2.GaussianBlur(roi, (k, k), sigma)


def _mosaic(frame, rect, blocks: int):
    x1, y1, x2, y2 = rect
    roi = frame[y1:y2, x1:x2]
    if roi.size == 0:
        return
    h, w = roi.shape[:2]
    bx, by = max(1, min(blocks, w)), max(1, min(blocks, h))
    # Downsample-then-upsample throws the pixels away. A Gaussian alone leaves
    # stroke structure in a short run of digits, which is recoverable — the
    # stills path learned this and video inherits the same treatment.
    small = cv2.resize(roi, (bx, by), interpolation=cv2.INTER_AREA)
    frame[y1:y2, x1:x2] = cv2.resize(small, (w, h), interpolation=cv2.INTER_NEAREST)
    _blur(frame, rect, 15, 0)


def _encoder_args() -> list[str]:
    if ENCODER == "h264_nvenc":
        # NVENC has no -crf; -cq is its constant-quality equivalent and -preset
        # takes a different vocabulary (p1..p7).
        return ["-c:v", "h264_nvenc", "-preset", "p4", "-cq", str(settings.CRF)]
    return ["-c:v", "libx264", "-preset", settings.PRESET, "-crf", str(settings.CRF)]


def mute(src_path: str, out_path: str) -> dict:
    """Copy the video stream and drop every audio stream.

    Stream copy, not re-encode: the pixels are not being changed, so decoding and
    re-encoding them would cost a generation of quality and minutes of CPU to
    produce a file that should be byte-identical in its video content. `-an` is
    the whole edit.

    This runs at INGEST, before anything is stored. The platform's rule is that a
    video carries no voice-consent decision, so a soundtrack must never reach
    storage — previously that was enforced by refusing the upload outright, which
    made an agent re-shoot a session they had already finished. Stripping is the
    same guarantee without discarding the footage.
    """
    command = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-i", src_path,
        "-map", "0:v",       # video streams only — no audio, no data, no subtitles
        "-c:v", "copy",
        "-an",
        "-movflags", "+faststart",
        out_path,
    ]
    process = subprocess.run(command, capture_output=True)
    if process.returncode != 0 or not os.path.exists(out_path) or os.path.getsize(out_path) == 0:
        # Stream copy fails on containers whose video codec the mp4 muxer will not
        # accept. Re-encoding is the fallback rather than the default because it is
        # ~100x slower, and on the common case (H.264 in mp4/mov) the copy works.
        if os.path.exists(out_path):
            os.remove(out_path)
        fallback = [
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
            "-i", src_path, "-map", "0:v", *_encoder_args(),
            "-pix_fmt", "yuv420p", "-an", "-movflags", "+faststart", out_path,
        ]
        second = subprocess.run(fallback, capture_output=True)
        if second.returncode != 0 or not os.path.exists(out_path) or os.path.getsize(out_path) == 0:
            if os.path.exists(out_path):
                os.remove(out_path)
            stderr = second.stderr.decode("utf-8", "replace").strip()[:500]
            raise RuntimeError(f"ffmpeg could not strip audio ({second.returncode}): {stderr}")
        return {"reencoded": True, "bytes": os.path.getsize(out_path)}
    return {"reencoded": False, "bytes": os.path.getsize(out_path)}


def _parse_labelled(specs: list[dict]) -> list[dict]:
    """Same shape as _parse_regions, but keeps the label and colour for drawing."""
    parsed = []
    for spec in specs or []:
        keyframes = []
        for box in spec.get("boxes") or []:
            if isinstance(box, dict):
                keyframes.append(
                    (
                        int(box["frame"]),
                        (float(box["x1"]), float(box["y1"]), float(box["x2"]), float(box["y2"])),
                    )
                )
            elif len(box) >= 5:
                keyframes.append(
                    (int(box[0]), (float(box[1]), float(box[2]), float(box[3]), float(box[4])))
                )
        if not keyframes:
            continue
        keyframes.sort(key=lambda k: k[0])
        parsed.append(
            {
                "keyframes": keyframes,
                "start": int(spec.get("start_frame", keyframes[0][0])),
                "end": int(spec.get("end_frame", keyframes[-1][0])),
                "label": str(spec.get("label", "")),
                # BGR. Green reads as "found", amber as "text PII".
                "color": tuple(spec.get("color") or (80, 220, 100)),
            }
        )
    return parsed


def annotate(src_path: str, out_path: str, spec: dict) -> dict:
    """Draw the detection boxes over the frames WITHOUT masking anything.

    This is a review aid, not a derivative anyone outside the tagging screen may
    see: it shows an operator what the detector found and which track each box
    belongs to, so a mis-grouped track is visible before it is tagged rather than
    after it is published. Every face stays legible in it, which is exactly why
    the backend stores it under the same access rules as the original and never
    serves it to a data owner.
    """
    regions = _parse_labelled(spec.get("tracks"))

    capture = cv2.VideoCapture(src_path)
    if not capture.isOpened():
        raise ValueError("Could not open video for annotation")

    fps = capture.get(cv2.CAP_PROP_FPS) or 25.0
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    if width <= 0 or height <= 0:
        capture.release()
        raise ValueError("Video reports no usable dimensions")

    command = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "rawvideo", "-vcodec", "rawvideo",
        "-s", f"{width}x{height}", "-pix_fmt", "bgr24", "-r", str(fps),
        "-i", "-",
        "-an",
        *_encoder_args(),
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        out_path,
    ]

    process = subprocess.Popen(command, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    frames = 0
    # Scaled off the frame so the overlay is legible on a 4K clip and does not
    # swallow a 480p one.
    thickness = max(1, round(min(width, height) / 400))
    font_scale = max(0.4, min(width, height) / 1000)

    try:
        index = -1
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            index += 1

            for region in regions:
                if not (region["start"] <= index <= region["end"]):
                    continue
                box = _interpolate(region["keyframes"], index)
                if not box:
                    continue
                x1, y1, x2, y2 = (int(round(v)) for v in box)
                x1, y1 = max(0, x1), max(0, y1)
                x2, y2 = min(width, x2), min(height, y2)
                if x2 <= x1 or y2 <= y1:
                    continue
                cv2.rectangle(frame, (x1, y1), (x2, y2), region["color"], thickness)
                if region["label"]:
                    (tw, th), _ = cv2.getTextSize(
                        region["label"], cv2.FONT_HERSHEY_SIMPLEX, font_scale, thickness
                    )
                    # Above the box, or inside it when the box is at the top edge —
                    # a label drawn at a negative y is silently not drawn at all.
                    ty = y1 - 4 if y1 - th - 8 >= 0 else y1 + th + 6
                    cv2.rectangle(
                        frame,
                        (x1, ty - th - 4),
                        (x1 + tw + 6, ty + 4),
                        region["color"],
                        -1,
                    )
                    cv2.putText(
                        frame,
                        region["label"],
                        (x1 + 3, ty),
                        cv2.FONT_HERSHEY_SIMPLEX,
                        font_scale,
                        (16, 16, 16),
                        thickness,
                        cv2.LINE_AA,
                    )

            process.stdin.write(frame.tobytes())
            frames += 1
    except Exception:
        process.kill()
        if os.path.exists(out_path):
            os.remove(out_path)
        raise
    finally:
        capture.release()

    try:
        process.stdin.close()
    except BrokenPipeError:
        pass
    stderr = process.stderr.read().decode("utf-8", "replace")
    code = process.wait()

    if code != 0 or not os.path.exists(out_path) or os.path.getsize(out_path) == 0:
        if os.path.exists(out_path):
            os.remove(out_path)
        raise RuntimeError(f"ffmpeg failed ({code}): {stderr.strip()[:500]}")

    return {"frames": frames, "regions": len(regions), "encoder": ENCODER}


def redact(src_path: str, out_path: str, schedule: dict) -> dict:
    """Write a redacted copy. Raises on any failure, leaving no output behind."""
    blur_regions = _parse_regions(schedule.get("blur"))
    mosaic_regions = _parse_regions(schedule.get("mosaic"))

    capture = cv2.VideoCapture(src_path)
    if not capture.isOpened():
        raise ValueError("Could not open video for redaction")

    fps = capture.get(cv2.CAP_PROP_FPS) or 25.0
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    if width <= 0 or height <= 0:
        capture.release()
        raise ValueError("Video reports no usable dimensions")

    command = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "rawvideo", "-vcodec", "rawvideo",
        "-s", f"{width}x{height}", "-pix_fmt", "bgr24", "-r", str(fps),
        "-i", "-",
        # The source audio is deliberately NOT carried over. Video capture in
        # this platform is muted by contract (the upload route rejects a file
        # with an audio stream), so there is no voice-consent decision attached
        # to this file — and copying a track nobody screened would smuggle one in.
        "-an",
        *_encoder_args(),
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        out_path,
    ]

    process = subprocess.Popen(command, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    frames = 0
    blurred_frames = 0

    try:
        index = -1
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            index += 1
            touched = False

            for region in blur_regions:
                if not (region["start"] <= index <= region["end"]):
                    continue
                box = _interpolate(region["keyframes"], index)
                rect = _dilate(box, width, height, settings.BOX_DILATION) if box else None
                if rect:
                    _blur(frame, rect, settings.BLUR_KERNEL, settings.BLUR_SIGMA)
                    touched = True

            for region in mosaic_regions:
                if not (region["start"] <= index <= region["end"]):
                    continue
                box = _interpolate(region["keyframes"], index)
                # Printed text gets more padding than a face: OCR boxes hug the
                # glyphs and leave ascenders/descenders outside the rectangle.
                rect = _dilate(box, width, height, settings.BOX_DILATION + 0.12) if box else None
                if rect:
                    _mosaic(frame, rect, settings.PII_MOSAIC_BLOCKS)
                    touched = True

            process.stdin.write(frame.tobytes())
            frames += 1
            if touched:
                blurred_frames += 1
    except Exception:
        process.kill()
        # Never leave a partial file. A truncated mp4 plays for a while and then
        # stops, which looks like a corrupt download rather than an incomplete
        # redaction — and the frames it does contain were never masked.
        if os.path.exists(out_path):
            os.remove(out_path)
        raise
    finally:
        capture.release()

    try:
        process.stdin.close()
    except BrokenPipeError:
        pass
    stderr = process.stderr.read().decode("utf-8", "replace")
    code = process.wait()

    if code != 0 or not os.path.exists(out_path) or os.path.getsize(out_path) == 0:
        if os.path.exists(out_path):
            os.remove(out_path)
        raise RuntimeError(f"ffmpeg failed ({code}): {stderr.strip()[:500]}")

    return {
        "frames": frames,
        "blurred_frames": blurred_frames,
        "blur_regions": len(blur_regions),
        "mosaic_regions": len(mosaic_regions),
        "encoder": ENCODER,
    }
