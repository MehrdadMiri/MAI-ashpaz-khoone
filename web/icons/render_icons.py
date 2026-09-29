"""Draw the آشپزخونه home-screen icons.

The pot follows the empty-pantry mark in index.html. The tile is the pantry
accent (#9f3d24) edge to edge so a maskable crop still shows that color, and
the pot stays inside the center 80% safe zone. Run from the repo root:

    python3 web/icons/render_icons.py
"""

import struct
import zlib
from pathlib import Path

BG = (0x9F, 0x3D, 0x24)
POT = (0xFF, 0xF4, 0xE2)
STROKE = (0xC9, 0x84, 0x2A)
DOT = (0x9F, 0x3D, 0x24)
SAFFRON = (0xC9, 0x84, 0x2A)

# ViewBox of the empty-state pot. Kept under the maskable safe circle (radius 40%).
SCALE = 1.02


def write_png(path, width, height, rgb):
    raw = bytearray()
    for y in range(height):
        raw.append(0)
        row = y * width
        for x in range(width):
            raw.extend(rgb[row + x])
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    png = b"\x89PNG\r\n\x1a\n" + _chunk(b"IHDR", ihdr) + _chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + _chunk(b"IEND", b"")
    path.write_bytes(png)


def _chunk(tag, data):
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


def _to_px(u, v, size):
    scale = (size * SCALE) / 80
    origin = (size - 80 * scale) / 2
    return origin + u * scale, origin + v * scale


def _paint(buf, size, x, y, color):
    if 0 <= x < size and 0 <= y < size:
        buf[y * size + x] = color


def _fill_round_rect(buf, size, box, radius, color):
    x0, y0, x1, y1 = box
    radius = min(radius, (x1 - x0) / 2, (y1 - y0) / 2)
    ix0 = int(x0)
    iy0 = int(y0)
    ix1 = int(x1) + 1
    iy1 = int(y1) + 1
    for y in range(iy0, iy1):
        for x in range(ix0, ix1):
            cx = min(max(x + 0.5, x0 + radius), x1 - radius)
            cy = min(max(y + 0.5, y0 + radius), y1 - radius)
            dx = x + 0.5 - cx
            dy = y + 0.5 - cy
            if dx * dx + dy * dy <= radius * radius:
                _paint(buf, size, x, y, color)


def _fill_circle(buf, size, cx, cy, radius, color):
    r2 = radius * radius
    for y in range(int(cy - radius) - 1, int(cy + radius) + 2):
        for x in range(int(cx - radius) - 1, int(cx + radius) + 2):
            dx = x + 0.5 - cx
            dy = y + 0.5 - cy
            if dx * dx + dy * dy <= r2:
                _paint(buf, size, x, y, color)


def _fill_ellipse(buf, size, cx, cy, rx, ry, color):
    for y in range(int(cy - ry) - 1, int(cy + ry) + 2):
        for x in range(int(cx - rx) - 1, int(cx + rx) + 2):
            dx = (x + 0.5 - cx) / rx
            dy = (y + 0.5 - cy) / ry
            if dx * dx + dy * dy <= 1:
                _paint(buf, size, x, y, color)


def _downsample(buf, size, sample):
    big = size * sample
    out = [BG] * (size * size)
    area = sample * sample
    for y in range(size):
        for x in range(size):
            red = green = blue = 0
            for sy in range(sample):
                for sx in range(sample):
                    pixel = buf[(y * sample + sy) * big + (x * sample + sx)]
                    red += pixel[0]
                    green += pixel[1]
                    blue += pixel[2]
            out[y * size + x] = (round(red / area), round(green / area), round(blue / area))
    return out


def _raster(size):
    buf = [BG] * (size * size)
    unit = (size * SCALE) / 80

    def px(u, v):
        return _to_px(u, v, size)

    x0, y0 = px(18, 36)
    body = (x0, y0, x0 + 44 * unit, y0 + 24 * unit)
    stroke = unit * 2
    _fill_round_rect(buf, size, (
        body[0] - stroke / 2,
        body[1] - stroke / 2,
        body[2] + stroke / 2,
        body[3] + stroke / 2,
    ), 9 * unit + stroke / 2, STROKE)
    _fill_round_rect(buf, size, body, 9 * unit, POT)

    lid_x, lid_y = px(40, 36)
    lid_rx = 20 * unit
    lid_ry = 12 * unit
    _fill_ellipse(buf, size, lid_x, lid_y, lid_rx + stroke / 2, lid_ry + stroke / 2, STROKE)
    _fill_ellipse(buf, size, lid_x, lid_y, lid_rx, lid_ry, POT)
    # Cover the lower half of the lid so it reads as a dome on the pot, not a second oval.
    _fill_round_rect(buf, size, body, 9 * unit, POT)
    rim_y = body[1]
    _fill_round_rect(buf, size, (
        body[0] + 3 * unit,
        rim_y - stroke / 2,
        body[2] - 3 * unit,
        rim_y + stroke / 2,
    ), stroke, STROKE)

    knob_x, knob_y = px(40, 29)
    _fill_circle(buf, size, knob_x, knob_y, 3.4 * unit, DOT)

    for ux, uy, radius, color in (
        (32, 47, 2.0, SAFFRON),
        (45, 45, 1.7, DOT),
        (36, 53, 1.6, SAFFRON),
        (49, 51, 1.9, DOT),
    ):
        cx, cy = px(ux, uy)
        _fill_circle(buf, size, cx, cy, radius * unit, color)
    return buf


def render(size):
    sample = 3
    return _downsample(_raster(size * sample), size, sample)


def main():
    out = Path(__file__).resolve().parent
    for name, size in (("icon-192.png", 192), ("icon-512.png", 512), ("apple-touch-icon.png", 180)):
        write_png(out / name, size, size, render(size))
        print(name, size)


if __name__ == "__main__":
    main()
