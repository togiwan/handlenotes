"""Render the HandleNotes icon at Chrome's four sizes using the standard library."""
import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "extension" / "icons"
ROOT.mkdir(exist_ok=True)

TRANSPARENT = (0, 0, 0, 0)
KEYLINE = (104, 116, 128, 255)
TILE = (15, 20, 25, 255)
PAPER = (247, 249, 250, 255)
FOLD = (178, 190, 201, 255)


def in_rounded_square(x, y, inset, radius):
    low, high = inset + radius, 128 - inset - radius
    cx, cy = min(max(x, low), high), min(max(y, low), high)
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2


def on_stroke(x, y, start_x, end_x, radius):
    start_y, end_y = 53, 86
    dx, dy = end_x - start_x, end_y - start_y
    progress = ((x - start_x) * dx + (y - start_y) * dy) / (dx * dx + dy * dy)
    fraction = max(0, min(1, progress))
    return (x - start_x - fraction * dx) ** 2 + (y - start_y - fraction * dy) ** 2 <= radius ** 2


def pixel(x, y):
    if not in_rounded_square(x, y, inset=5, radius=26):
        return TRANSPARENT
    if not in_rounded_square(x, y, inset=9, radius=22):
        return KEYLINE
    if not (31 <= x < 97 and 22 <= y < 106 and x <= y + 54):
        return TILE
    if x >= 76 and y < 43:
        return FOLD
    if on_stroke(x, y, 49, 79, 4) or on_stroke(x, y, 79, 49, 4):
        return TILE
    return PAPER


def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)


for size in (16, 32, 48, 128):
    rows = []
    for row in range(size):
        pixels = bytearray()
        for col in range(size):
            samples = [pixel((col + (sx + .5) / 4) * 128 / size, (row + (sy + .5) / 4) * 128 / size)
                       for sy in range(4) for sx in range(4)]
            visible = [rgba for rgba in samples if rgba[3]]
            if visible:
                pixels.extend(round(sum(rgba[k] for rgba in visible) / len(visible)) for k in range(3))
                pixels.append(round(255 * len(visible) / len(samples)))
            else:
                pixels.extend(TRANSPARENT)
        rows.append(b"\0" + pixels)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(b"".join(rows), 9))
    png += chunk(b"IEND", b"")
    (ROOT / f"{size}.png").write_bytes(png)
print("Icons generated: 16, 32, 48, 128 px")
