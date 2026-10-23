"""Draws the BlowLink icon (two linked rings on a rounded square) without image
libraries and writes build/icon.png (512), build/icon.ico (256) and tray icons.
Run: python3 scripts/make-icons.py"""
import math, struct, zlib, pathlib

OUT = pathlib.Path(__file__).resolve().parent.parent / "build"

def png(w, h, px):
    raw = b"".join(b"\0" + bytes(px[y * w * 4:(y + 1) * w * 4]) for y in range(h))
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)) + \
        chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")

def draw(n, background=True, mono=None):
    s = 4  # supersampling per axis
    px = bytearray(n * n * 4)
    bg_top, bg_bot = (60, 30, 90), (25, 15, 45)
    ring_a, ring_b = (255, 105, 170), (170, 120, 255)
    r_out, r_in = 0.20, 0.135  # ring radii as a share of the size
    ca, cb = (0.39, 0.5), (0.61, 0.5)
    def ring(x, y, c):
        d = math.hypot(x - c[0], y - c[1])
        return r_in <= d <= r_out
    for py in range(n):
        for px_ in range(n):
            acc = [0.0, 0.0, 0.0, 0.0]
            for sy in range(s):
                for sx in range(s):
                    x = (px_ + (sx + 0.5) / s) / n
                    y = (py + (sy + 0.5) / s) / n
                    col, a = None, 0
                    # rounded square
                    if background:
                        m, rad = 0.04, 0.2
                        qx = max(abs(x - 0.5) - (0.5 - m - rad), 0)
                        qy = max(abs(y - 0.5) - (0.5 - m - rad), 0)
                        if math.hypot(qx, qy) <= rad:
                            t = y
                            col = tuple(bg_top[i] * (1 - t) + bg_bot[i] * t for i in range(3)); a = 1
                    # rings: B behind A, except A's right side passes behind B (interlock)
                    in_a, in_b = ring(x, y, ca), ring(x, y, cb)
                    if in_b and (not in_a or y > 0.5):
                        col, a = mono or ring_b, 1
                    elif in_a:
                        col, a = mono or ring_a, 1
                    if a:
                        for i in range(3): acc[i] += col[i]
                        acc[3] += 1
            k = s * s
            if acc[3]:
                for i in range(3): px[(py * n + px_) * 4 + i] = int(acc[i] / acc[3])
                px[(py * n + px_) * 4 + 3] = int(255 * acc[3] / k)
    return png(n, n, px)

def ico(png_bytes, size):
    return struct.pack("<HHH", 0, 1, 1) + struct.pack("<BBBBHHII", 0 if size >= 256 else size, 0 if size >= 256 else size,
                                                       0, 0, 1, 32, len(png_bytes), 22) + png_bytes

OUT.mkdir(exist_ok=True)
(OUT / "icon.png").write_bytes(draw(512))
(OUT / "icon.ico").write_bytes(ico(draw(256), 256))
(OUT / "tray.png").write_bytes(draw(32, background=False))
(OUT / "tray@2x.png").write_bytes(draw(64, background=False))
print("icons written to", OUT)
