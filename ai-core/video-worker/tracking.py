"""IoU tracker with linear motion prediction.

Deliberately hand-rolled rather than pulled from ByteTrack/Norfair. The job here
is narrow — link face detections that are already 10x/second apart — and the
dependency cost of a full tracking library (torch, scipy, lap) is not worth it
for ~80 lines. It also means the one behaviour that matters for privacy, the
coast-and-hold in `step()`, is visible in this file instead of buried in a
library's default.
"""

import itertools

from config import settings


def iou(a, b) -> float:
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b

    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
    inter = iw * ih
    if inter <= 0:
        return 0.0

    area_a = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
    area_b = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


class Track:
    _ids = itertools.count()

    def __init__(self, frame: int, box, det_score: float, embedding=None):
        self.track_id = f"t{next(Track._ids)}"
        self.boxes: list[tuple[int, tuple]] = [(frame, box)]
        self.start_frame = frame
        self.last_frame = frame
        self.det_score = det_score
        # (quality, frame, embedding) — kept sorted by quality so the best N
        # survive without holding every frame's vector in memory.
        self.candidates: list[tuple[float, int, list]] = []
        self.velocity = (0.0, 0.0)
        self.missing = 0

    @property
    def box(self):
        return self.boxes[-1][1]

    def predict(self, frame: int):
        """Where this face probably is on `frame`, given where it was going.

        Constant velocity, clamped to one box-length of travel.

        The clamp matters once a track is coasting. Velocity is per video frame
        and the gap during a coast is the whole missed interval, so an
        unclamped extrapolation of a face panning at ~27px/frame reaches 400px
        away by the end of a half-second coast — far enough to sit on top of a
        DIFFERENT person and match them on IoU. That silently merges two people
        into one track, and a merged track tagged to a consenting subject
        leaves both of them unblurred in the release. Refusing to predict
        further than the face's own width costs a missed re-link, which just
        starts a new track; the alternative costs a privacy breach.
        """
        gap = frame - self.last_frame
        if gap <= 0:
            return self.box
        vx, vy = self.velocity
        x1, y1, x2, y2 = self.box
        w, h = x2 - x1, y2 - y1
        dx = max(-w, min(w, vx * gap))
        dy = max(-h, min(h, vy * gap))
        return (x1 + dx, y1 + dy, x2 + dx, y2 + dy)

    def update(self, frame: int, box, det_score: float):
        gap = max(1, frame - self.last_frame)
        held = self.box
        px1, py1, _, _ = held
        self.velocity = ((box[0] - px1) / gap, (box[1] - py1) / gap)

        # A coasted gap is a HOLD, not a movement, and the two look identical
        # to the redactor unless this says otherwise.
        #
        # redact.py interpolates linearly between consecutive keyframes. With
        # nothing here, a track that lost its face and re-found it later left
        # two keyframes far apart in time AND in space, and the blur box slid
        # smoothly between them across the whole gap — drifting through empty
        # background while the real face, which had gone somewhere else
        # entirely, was left unmasked for the duration.
        #
        # That is not theoretical: on a 10.7s clip one track held keyframes 48
        # frames apart, and the blur it painted travelled across the subject's
        # chest for 1.6 seconds as a second, wrong box while the face was
        # blurred by a different track. Pinning the last seen box at the frame
        # before the re-detection makes the gap a flat hold followed by a snap,
        # which is what HOLD_SEC always claimed to do.
        if self.missing and frame - self.last_frame > 1:
            self.boxes.append((frame - 1, held))

        self.boxes.append((frame, box))
        self.last_frame = frame
        self.det_score = max(self.det_score, det_score)
        self.missing = 0

    def offer_embedding(self, frame: int, embedding, quality: float):
        self.candidates.append((quality, frame, embedding))
        self.candidates.sort(key=lambda c: c[0], reverse=True)
        del self.candidates[settings.EMBED_FRAMES_PER_TRACK :]


class Tracker:
    """Greedy IoU association. O(tracks x detections) per detected frame, which
    at session scale (a handful of faces) is nothing.
    """

    def __init__(self, detect_fps: float):
        # HOLD_SEC of real time, expressed in the unit `missing` is counted in.
        #
        # `step()` is called once per DETECTED frame and increments `missing` by
        # one, so the budget has to be in detected frames. This was built with
        # the clip's own frame rate instead, which on 30fps footage sampled at
        # 10/sec made the coast 15 samples — 45 video frames, 1.5 seconds,
        # three times the configured half-second.
        #
        # The cost was not a slightly generous hold. A track kept alive that
        # long re-links to a detection made 1.5s later, and the redactor then
        # interpolates its blur box between two positions an age apart. On a
        # 10.7s test clip it produced two extra tracks whose only keyframes were
        # 39 and 48 frames apart, each painting a wrong, drifting blur square
        # over the subject's chest — the "two or three boxes for one person"
        # this pipeline was reported for.
        self.max_missing = max(1, int(round(settings.HOLD_SEC * detect_fps)))
        self.active: list[Track] = []
        self.finished: list[Track] = []

    def step(self, frame: int, detections: list[tuple]):
        """One detected frame. `detections` is [(box, det_score, embedding, quality)]."""
        unmatched = list(range(len(detections)))
        pairs = []

        for track in self.active:
            predicted = track.predict(frame)
            best, best_iou = None, settings.IOU_THRESHOLD
            for i in unmatched:
                score = iou(predicted, detections[i][0])
                if score > best_iou:
                    best, best_iou = i, score
            if best is not None:
                pairs.append((track, best))
                unmatched.remove(best)

        for track, i in pairs:
            box, det_score, embedding, quality = detections[i]
            track.update(frame, box, det_score)
            if embedding is not None:
                track.offer_embedding(frame, embedding, quality)

        matched_tracks = {id(t) for t, _ in pairs}
        still_active = []
        for track in self.active:
            if id(track) in matched_tracks:
                still_active.append(track)
                continue
            track.missing += 1
            # Coasting, not gone. The track keeps its last box and keeps being
            # rendered by the redactor for up to max_missing frames — this is
            # the temporal fail-closed rule, and removing it is what would let a
            # face flicker back into view during an occlusion.
            if track.missing <= self.max_missing:
                still_active.append(track)
            else:
                self.finished.append(track)
        self.active = still_active

        for i in unmatched:
            box, det_score, embedding, quality = detections[i]
            track = Track(frame, box, det_score)
            if embedding is not None:
                track.offer_embedding(frame, embedding, quality)
            self.active.append(track)

    def close(self, last_frame: int) -> list[Track]:
        for track in self.active:
            self.finished.append(track)
        self.active = []
        return [
            t
            for t in self.finished
            if (t.last_frame - t.start_frame + 1) >= settings.MIN_TRACK_FRAMES
        ]
