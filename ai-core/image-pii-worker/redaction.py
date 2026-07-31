"""Pixel redaction primitives for PII regions.

Deliberately PIL-only. rapidocr-onnxruntime drags OpenCV in transitively, but
relying on a transitive dependency for the one step that actually destroys the
data is how a wheel bump turns into a silent breach. Pillow is a direct,
declared dependency of this service.

Text is redacted differently from faces. A Gaussian blur over a small block of
printed digits leaves stroke-level structure behind — enough for a human, and
comfortably enough for a deblurring model, to recover an Aadhaar number. So a
PII region is first collapsed to a coarse mosaic (which throws the pixels away)
and only then blurred (which hides the mosaic edges). The mosaic is the part
that makes it irreversible; the blur is cosmetic.
"""

from PIL import Image, ImageFilter

# OCR boxes hug the glyphs. Ascenders, descenders and the last character of a
# number routinely sit a pixel or two outside them, so every region is grown
# before it is destroyed.
BOX_PAD_RATIO = 0.12
BOX_PAD_MIN_PX = 4

# Longest edge of the mosaic grid a region is collapsed to. 6 means even a
# full-width region survives as at most 6 blocks across — no glyph shape can
# survive that.
MOSAIC_MAX_BLOCKS = 6


def pad_box(box, width: int, height: int, ratio: float = BOX_PAD_RATIO, min_px: int = BOX_PAD_MIN_PX):
    """Grows a box outward and clamps it to the image. Returns None when the
    box is degenerate or entirely outside the frame."""
    try:
        x1, y1, x2, y2 = (int(round(float(v))) for v in list(box)[:4])
    except (TypeError, ValueError):
        return None

    if x2 < x1:
        x1, x2 = x2, x1
    if y2 < y1:
        y1, y2 = y2, y1

    # Zero-area in means zero-area out. Padding it first would invent a region
    # out of a box that located nothing.
    if x2 == x1 or y2 == y1:
        return None

    pad_x = max(min_px, int(round((x2 - x1) * ratio)))
    pad_y = max(min_px, int(round((y2 - y1) * ratio)))

    x1 = max(0, x1 - pad_x)
    y1 = max(0, y1 - pad_y)
    x2 = min(width, x2 + pad_x)
    y2 = min(height, y2 + pad_y)

    if x2 <= x1 or y2 <= y1:
        return None
    return (x1, y1, x2, y2)


def _destroy(region: Image.Image) -> Image.Image:
    """Mosaic, then blur. Order matters — blurring first would leave the mosaic
    averaging already-smeared pixels, which is weaker, not stronger."""
    width, height = region.size
    blocks_x = max(1, min(MOSAIC_MAX_BLOCKS, width))
    blocks_y = max(1, min(MOSAIC_MAX_BLOCKS, height))

    mosaic = region.resize((blocks_x, blocks_y), Image.BILINEAR).resize(
        (width, height), Image.NEAREST
    )
    radius = max(2.0, min(width, height) / 3.0)
    return mosaic.filter(ImageFilter.GaussianBlur(radius=radius))


def redact_regions(image: Image.Image, boxes) -> int:
    """Destroys every given region in-place. Returns how many were applied.

    A box that cannot be parsed is skipped rather than raised on: the caller has
    already committed to redacting this image, and one malformed entry must not
    turn into a request that returns the unredacted original.
    """
    width, height = image.size
    applied = 0

    for box in boxes or []:
        padded = pad_box(box, width, height)
        if padded is None:
            continue
        image.paste(_destroy(image.crop(padded)), padded)
        applied += 1

    return applied
