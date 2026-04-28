#!/usr/bin/env python3
"""
Generate placeholder Tauri icons using only the Python stdlib (zlib + struct).

Produces:
  apps/desktop/src-tauri/icons/32x32.png
  apps/desktop/src-tauri/icons/128x128.png
  apps/desktop/src-tauri/icons/128x128@2x.png  (256x256)
  apps/desktop/src-tauri/icons/icon.ico        (multi-res PNG container)
  apps/desktop/src-tauri/icons/source.png      (1024x1024, for `cargo tauri icon`)

This is a real placeholder — solid dark background with an accent-colored "play"
triangle. Replace by running `cargo tauri icon path/to/real-logo.png` once you
have brand art.

Note: macOS .icns is not generated here. Run `cargo tauri icon` (which uses
iconutil under the hood on macOS) once you have the real source PNG.
"""

from __future__ import annotations
import os
import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / "apps" / "desktop" / "src-tauri" / "icons"

BG = (10, 10, 11, 255)         # #0a0a0b
ACCENT = (124, 242, 160, 255)  # #7cf2a0

def _crc(typ: bytes, data: bytes) -> int:
    return zlib.crc32(typ + data)

def _chunk(typ: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + typ + data + struct.pack(">I", _crc(typ, data))

def render_pixels(size: int) -> bytes:
    """Solid dark background with a centered filled play-triangle in accent."""
    pad = size // 6
    # triangle vertices: left top, left bottom, right middle
    lx = pad + size // 12
    rx = size - pad - size // 12
    ty = pad + size // 12
    by = size - pad - size // 12
    apex_x = rx
    apex_y = size // 2

    rows = bytearray()
    for y in range(size):
        rows.append(0)  # filter byte: None
        for x in range(size):
            inside = False
            if lx <= x <= rx and ty <= y <= by:
                # is point (x,y) inside the triangle (lx,ty)-(lx,by)-(apex_x,apex_y)?
                # use barycentric / edge-function approach
                v0x, v0y = lx, ty
                v1x, v1y = lx, by
                v2x, v2y = apex_x, apex_y
                d = (v1y - v2y) * (v0x - v2x) + (v2x - v1x) * (v0y - v2y)
                if d != 0:
                    a = ((v1y - v2y) * (x - v2x) + (v2x - v1x) * (y - v2y)) / d
                    b = ((v2y - v0y) * (x - v2x) + (v0x - v2x) * (y - v2y)) / d
                    c = 1 - a - b
                    inside = a >= 0 and b >= 0 and c >= 0
            color = ACCENT if inside else BG
            rows.extend(color)
    return bytes(rows)

def make_png(size: int) -> bytes:
    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    raw = render_pixels(size)
    idat = zlib.compress(raw, 9)
    return sig + _chunk(b"IHDR", ihdr) + _chunk(b"IDAT", idat) + _chunk(b"IEND", b"")

def make_ico(sizes: list[int]) -> bytes:
    """Modern ICO: PNG payload per entry. Tauri 2 accepts this format."""
    pngs = [(s, make_png(s)) for s in sizes]
    header = struct.pack("<HHH", 0, 1, len(pngs))
    entries = b""
    payload = b""
    offset = 6 + 16 * len(pngs)
    for s, png in pngs:
        w = 0 if s >= 256 else s
        h = 0 if s >= 256 else s
        entries += struct.pack("<BBBBHHII", w, h, 0, 0, 1, 32, len(png), offset)
        payload += png
        offset += len(png)
    return header + entries + payload

def main():
    ICONS.mkdir(parents=True, exist_ok=True)
    targets = {
        "32x32.png": make_png(32),
        "128x128.png": make_png(128),
        "128x128@2x.png": make_png(256),
        "source.png": make_png(1024),
    }
    for name, data in targets.items():
        out = ICONS / name
        out.write_bytes(data)
        print(f"wrote {out.relative_to(ROOT)}  ({len(data)} bytes)")

    ico = make_ico([16, 32, 48, 64, 128, 256])
    (ICONS / "icon.ico").write_bytes(ico)
    print(f"wrote {(ICONS / 'icon.ico').relative_to(ROOT)}  ({len(ico)} bytes)")

    print()
    print("note: icon.icns not generated (requires macOS iconutil).")
    print("for production builds, run: cargo tauri icon apps/desktop/src-tauri/icons/source.png")

if __name__ == "__main__":
    main()
