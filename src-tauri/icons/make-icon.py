#!/usr/bin/env python3
"""Generate src-tauri/icons/icon-source.png — the 1024x1024 master image that
`tauri icon` fans out into every platform icon (icon.ico/.icns/.png, the
Square*/Store logos, android/, ios/).

Same design as Luciro PDF's makeAppIcon(): a 135-degree blue gradient rounded
square with a white bold letter. The ONLY per-app difference is GLYPH — keep
every other parameter identical so the two apps share one icon design.

Run from anywhere (writes next to this script), then regenerate platform icons:
    python src-tauri/icons/make-icon.py
    pnpm tauri icon src-tauri/icons/icon-source.png
"""
import os
from PIL import Image, ImageDraw, ImageFont

# --- Design parameters (match Luciro PDF's icon design; keep in sync across apps) -
GLYPH = "M"                                    # <-- the single per-app value
C0 = (0x2a, 0xa7, 0xe0)                        # gradient top-left  (lighter)
C1 = (0x0a, 0x4d, 0x8c)                        # gradient bottom-right (darker)
SIZE = 1024                                    # master canvas (square, RGBA)
RADIUS_DIVISOR = 6                             # corner radius = SIZE / 6
GLYPH_SIZE_PCT = 55                            # glyph pixel size = 55% of canvas
FONT_PATH = r"C:\Windows\Fonts\segoeuib.ttf"   # Segoe UI Bold
SS = 2                                         # supersample for crisp corners

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(SCRIPT_DIR, "icon-source.png")


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def gradient(size):
    """135-degree gradient (top-left -> bottom-right). Rendered small then
    upscaled: a linear gradient enlarges exactly, so this stays crisp while
    avoiding a full-resolution per-pixel loop (no numpy needed)."""
    n = 256
    g = Image.new("RGB", (n, n))
    px = g.load()
    denom = 2 * (n - 1)
    for y in range(n):
        for x in range(n):
            px[x, y] = lerp(C0, C1, (x + y) / denom)
    return g.resize((size, size), Image.LANCZOS)


def render():
    s = SIZE * SS
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))

    # Rounded-square mask (radius = SIZE/6, matching makeAppIcon()).
    radius = max(2, SIZE // RADIUS_DIVISOR) * SS
    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, s - 1, s - 1], radius=radius, fill=255)
    img.paste(gradient(s), (0, 0), mask)

    # White bold glyph, pixel size ~= 55% of the canvas, centred (anchor "mm").
    draw = ImageDraw.Draw(img)
    font = ImageFont.truetype(FONT_PATH, max(8, SIZE * GLYPH_SIZE_PCT // 100) * SS)
    draw.text((s / 2, s / 2), GLYPH, font=font, fill=(255, 255, 255, 255), anchor="mm")

    return img.resize((SIZE, SIZE), Image.LANCZOS)


def main():
    render().save(OUT, format="PNG")
    print("wrote", OUT, "({}x{}, glyph {!r})".format(SIZE, SIZE, GLYPH))


if __name__ == "__main__":
    main()
