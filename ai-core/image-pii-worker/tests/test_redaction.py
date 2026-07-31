"""Tests for the pixel-destruction primitives.

Plain unittest, not pytest: these must be runnable in the built container,
which carries only the service's runtime dependencies.

    python -m unittest discover -s tests    (from ai-core/image-pii-worker)
"""

import os
import sys
import unittest

from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from redaction import pad_box, redact_regions  # noqa: E402


def striped_image(width=200, height=100):
    """High-frequency vertical stripes — a stand-in for printed text. Anything
    that destroys these destroys glyphs."""
    image = Image.new("RGB", (width, height), (255, 255, 255))
    pixels = image.load()
    for x in range(width):
        if x % 2 == 0:
            for y in range(height):
                pixels[x, y] = (0, 0, 0)
    return image


def region_variance(image, box):
    x1, y1, x2, y2 = box
    values = [sum(p) / 3 for p in image.crop((x1, y1, x2, y2)).getdata()]
    mean = sum(values) / len(values)
    return sum((v - mean) ** 2 for v in values) / len(values)


class PadBoxTests(unittest.TestCase):
    def test_grows_and_clamps_to_image(self):
        self.assertEqual(pad_box([50, 50, 100, 70], 200, 100, ratio=0.0, min_px=10), (40, 40, 110, 80))

    def test_clamps_at_edges_instead_of_going_negative(self):
        self.assertEqual(pad_box([0, 0, 10, 10], 200, 100, ratio=0.0, min_px=10), (0, 0, 20, 20))

    def test_normalises_inverted_boxes(self):
        self.assertEqual(pad_box([100, 70, 50, 50], 200, 100, ratio=0.0, min_px=0), (50, 50, 100, 70))

    def test_rejects_degenerate_and_offscreen_boxes(self):
        self.assertIsNone(pad_box([10, 10, 10, 10], 200, 100, ratio=0.0, min_px=0))
        self.assertIsNone(pad_box([500, 500, 600, 600], 200, 100, ratio=0.0, min_px=0))

    def test_rejects_unparseable_boxes(self):
        self.assertIsNone(pad_box(["x", 1, 2, 3], 200, 100))
        self.assertIsNone(pad_box([1, 2], 200, 100))
        self.assertIsNone(pad_box(None, 200, 100))


class RedactRegionsTests(unittest.TestCase):
    def test_destroys_detail_inside_the_region(self):
        image = striped_image()
        before = region_variance(image, (50, 30, 150, 70))
        applied = redact_regions(image, [[50, 30, 150, 70]])
        after = region_variance(image, (60, 40, 140, 60))

        self.assertEqual(applied, 1)
        self.assertGreater(before, 1000)
        # Not "reduced" — effectively flat. Stripe structure must not survive.
        self.assertLess(after, before / 50)

    def test_leaves_pixels_outside_the_padded_region_alone(self):
        image = striped_image()
        control = image.copy()
        redact_regions(image, [[50, 30, 100, 70]])

        # Far from the box and its padding.
        self.assertEqual(image.getpixel((190, 90)), control.getpixel((190, 90)))
        self.assertEqual(image.getpixel((2, 2)), control.getpixel((2, 2)))

    def test_padding_covers_pixels_just_outside_a_tight_ocr_box(self):
        image = striped_image()
        control = image.copy()
        redact_regions(image, [[50, 40, 150, 60]])

        # One row above the box top: an ascender would live here, and a tight
        # box would have left it legible.
        self.assertNotEqual(image.getpixel((100, 38)), control.getpixel((100, 38)))

    def test_tiny_regions_are_still_destroyed(self):
        image = striped_image()
        applied = redact_regions(image, [[10, 10, 14, 13]])
        self.assertEqual(applied, 1)
        self.assertLess(region_variance(image, (10, 10, 14, 13)), 100)

    def test_bad_boxes_are_skipped_not_raised(self):
        image = striped_image()
        applied = redact_regions(image, [["bad"], [0, 0, 0, 0], [10, 10, 40, 30]])
        self.assertEqual(applied, 1)

    def test_empty_and_none_box_lists_are_no_ops(self):
        image = striped_image()
        control = image.copy()
        self.assertEqual(redact_regions(image, []), 0)
        self.assertEqual(redact_regions(image, None), 0)
        self.assertEqual(list(image.getdata()), list(control.getdata()))


if __name__ == "__main__":
    unittest.main()
