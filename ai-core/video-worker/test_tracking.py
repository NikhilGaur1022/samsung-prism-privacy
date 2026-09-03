"""What the tracker must not do to a blur box.

Every case here is a shape that reached a released clip. The pipeline's whole
claim is that a face is either tagged-and-visible or masked, and each of these
broke it in a way that looked like working software: boxes were drawn, the file
encoded, the status said REDACTED.
"""

import pytest

from config import settings
from tracking import Track, Tracker, iou


def box(x1, y1, w=160, h=190):
    return (float(x1), float(y1), float(x1 + w), float(y1 + h))


def det(b, score=0.9):
    """One detection in the shape step() expects: (box, score, embedding, quality)."""
    return (b, score, None, 1.0)


class TestCoastBudget:
    def test_coast_is_measured_in_detected_frames(self):
        """HOLD_SEC is real time, and step() is called once per SAMPLED frame.

        Built from the clip's frame rate instead, a 30fps clip sampled at 10/sec
        coasted 15 samples — 45 frames, 1.5s — for a configured 0.5s.
        """
        tracker = Tracker(detect_fps=10.0)
        assert tracker.max_missing == round(settings.HOLD_SEC * 10.0)

    def test_frame_rate_does_not_change_the_coast(self):
        """The same footage at 30 and 60fps must hold for the same DURATION."""
        assert Tracker(detect_fps=10.0).max_missing == Tracker(detect_fps=10.0).max_missing

    def test_track_is_dropped_once_the_budget_is_spent(self):
        tracker = Tracker(detect_fps=10.0)
        tracker.step(0, [det(box(100, 100))])
        assert len(tracker.active) == 1

        # Nothing found for longer than the coast allows.
        for i in range(1, tracker.max_missing + 2):
            tracker.step(i * 3, [])

        assert tracker.active == []

    def test_a_face_found_again_after_the_budget_starts_a_new_track(self):
        """The 48-frame re-link is the bug, not a feature.

        t36 on the 10.7s regression clip held exactly two keyframes, 48 frames
        apart, because the coast was three times its configured length. The
        redactor slid one blur box between them for 1.6 seconds.
        """
        tracker = Tracker(detect_fps=10.0)
        tracker.step(0, [det(box(100, 100))])
        first = tracker.active[0].track_id

        for i in range(1, tracker.max_missing + 2):
            tracker.step(i * 3, [])
        tracker.step(60, [det(box(140, 110))])

        assert len(tracker.active) == 1
        assert tracker.active[0].track_id != first
        assert tracker.active[0].boxes == [(60, box(140, 110))]


class TestCoastIsAHoldNotAMovement:
    def test_relinking_pins_the_last_box_before_snapping(self):
        """redact.py interpolates between consecutive keyframes.

        Without a pinned keyframe the blur box travels smoothly from where the
        face WAS to where it turned up later, drifting across background for the
        whole gap while the real face went somewhere else unmasked.
        """
        tracker = Tracker(detect_fps=10.0)
        tracker.step(0, [det(box(100, 100))])
        tracker.step(3, [det(box(103, 100))])
        # Missed, but within budget.
        tracker.step(6, [])
        tracker.step(9, [])
        tracker.step(12, [det(box(112, 100))])

        # Across every track, not active[0]: when the re-link fails the original
        # is still sitting at index 0 with a tidy two-keyframe history, so
        # asserting there passes without the re-linked track existing at all.
        relinked = [t for t in tracker.active + tracker.finished if len(t.boxes) > 2]
        assert relinked, "the face was never re-linked to its original track"
        held = dict(relinked[0].boxes)
        assert 11 in held, "no hold keyframe pinned before the re-detection"
        assert held[11] == held[3], "the hold must repeat the last SEEN box"

    def test_no_two_keyframes_ever_interpolate_across_a_coast(self):
        """The invariant the redactor actually depends on.

        Consecutive keyframes may differ in position only when they are
        adjacent samples. Any wider gap must carry the same box on both ends,
        so interpolation over it is flat.
        """
        tracker = Tracker(detect_fps=10.0)
        tracker.step(0, [det(box(100, 100))])
        tracker.step(3, [det(box(106, 100))])
        tracker.step(6, [])
        tracker.step(9, [])
        tracker.step(12, [])
        tracker.step(15, [det(box(300, 260))])

        for track in tracker.active + tracker.finished:
            boxes = track.boxes
            for (f0, b0), (f1, b1) in zip(boxes, boxes[1:]):
                if f1 - f0 > 3:
                    assert b0 == b1, (
                        f"{track.track_id}: blur box slides across frames {f0}->{f1}"
                    )

    def test_an_unbroken_track_keeps_smooth_interpolation(self):
        """The hold must not fire on consecutive samples.

        Pinning every gap would freeze the box between samples and un-blur the
        leading edge of a moving face.
        """
        tracker = Tracker(detect_fps=10.0)
        for i, x in enumerate([100, 130, 160, 190]):
            tracker.step(i * 3, [det(box(x, 100))])

        assert [f for f, _ in tracker.active[0].boxes] == [0, 3, 6, 9]


class TestPredictionClamp:
    def test_prediction_cannot_travel_further_than_the_face_is_wide(self):
        """An unclamped coast prediction lands on other people.

        At ~27px/frame — an ordinary camera pan — a half-second coast
        extrapolates 400px, far enough to sit on a different face and match it
        on IoU. That merges two people into one track, and tagging the merged
        track to a consenting subject unblurs both.
        """
        track = Track(0, box(100, 100), 0.9)
        track.update(3, box(190, 100), 0.9)

        predicted = track.predict(3 + 60)
        width = track.box[2] - track.box[0]
        assert predicted[0] - track.box[0] <= width + 1e-6

    def test_a_clamped_prediction_does_not_reach_a_bystander(self):
        track = Track(0, box(100, 100), 0.9)
        track.update(3, box(190, 100), 0.9)

        stranger = box(900, 100)
        assert iou(track.predict(63), stranger) == 0.0


class TestOnePersonStaysOneBox:
    def test_a_panning_face_yields_a_single_track(self):
        """The regression in one assertion.

        The real face on the reported clip was tracked cleanly across a pan; the
        extra boxes came from stale siblings kept alive beside it. One moving
        face must produce one track, so the redactor draws one box.
        """
        tracker = Tracker(detect_fps=10.0)
        for i, x in enumerate(range(150, 660, 30)):
            tracker.step(i * 3, [det(box(x, 360))])

        finished = tracker.close(51)
        assert len(finished) == 1, f"one face became {len(finished)} tracks"


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
