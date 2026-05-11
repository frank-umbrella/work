"""Generate og-image.png (1200x630) and apple-touch-icon.png (180x180) for the LogMeIn Installer page.

Run from repo root:
    python work/logmein/.scripts/build-og-image.py
"""

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent.parent

ACCENT = (26, 86, 219)        # --accent
ACCENT_HOVER = (22, 71, 184)
INK = (26, 31, 43)            # --ink
INK_SOFT = (71, 80, 99)       # --ink-soft
BG_TOP = (255, 255, 255)
BG_BOT = (243, 246, 252)      # subtle blue tint matching the hero gradient
WHITE = (255, 255, 255)
LINE = (227, 230, 236)


def load_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    candidates = [
        ("segoeuib.ttf" if bold else "segoeui.ttf"),
        ("arialbd.ttf" if bold else "arial.ttf"),
        "DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf",
    ]
    for name in candidates:
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def gradient_bg(w: int, h: int) -> Image.Image:
    img = Image.new("RGB", (w, h), BG_TOP)
    px = img.load()
    for y in range(h):
        t = y / max(h - 1, 1)
        r = int(BG_TOP[0] + (BG_BOT[0] - BG_TOP[0]) * t)
        g = int(BG_TOP[1] + (BG_BOT[1] - BG_TOP[1]) * t)
        b = int(BG_TOP[2] + (BG_BOT[2] - BG_TOP[2]) * t)
        for x in range(w):
            px[x, y] = (r, g, b)
    return img


def draw_download_glyph(draw: ImageDraw.ImageDraw, cx: int, cy: int, size: int, fill, stroke):
    """Rounded square with a download arrow inside (matches favicon.svg)."""
    r = size // 2
    radius = int(size * 0.22)
    draw.rounded_rectangle((cx - r, cy - r, cx + r, cy + r), radius=radius, fill=fill)
    sw = max(int(size * 0.08), 4)
    # vertical shaft
    shaft_top = cy - int(size * 0.28)
    shaft_bot = cy + int(size * 0.10)
    draw.line((cx, shaft_top, cx, shaft_bot), fill=stroke, width=sw)
    # arrowhead (V)
    head_w = int(size * 0.20)
    draw.line((cx - head_w, cy - int(size * 0.04), cx, shaft_bot), fill=stroke, width=sw)
    draw.line((cx + head_w, cy - int(size * 0.04), cx, shaft_bot), fill=stroke, width=sw)
    # tray bar
    tray_y = cy + int(size * 0.28)
    tray_w = int(size * 0.44)
    draw.line((cx - tray_w, tray_y, cx + tray_w, tray_y), fill=stroke, width=sw)


def numbered_pill(draw: ImageDraw.ImageDraw, x: int, y: int, n: str, label: str,
                  num_font, label_font):
    d = 56
    draw.ellipse((x, y, x + d, y + d), fill=ACCENT)
    nw = draw.textlength(n, font=num_font)
    nbb = num_font.getbbox(n)
    nh = nbb[3] - nbb[1]
    draw.text((x + (d - nw) / 2, y + (d - nh) / 2 - nbb[1]), n, fill=WHITE, font=num_font)
    draw.text((x + d + 16, y + 12), label, fill=INK, font=label_font)


def build_og():
    W, H = 1200, 630
    img = gradient_bg(W, H)
    draw = ImageDraw.Draw(img, "RGBA")

    # Decorative soft radial in top-right (matches the hero ::before glow)
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(glow)
    for i in range(60, 0, -1):
        alpha = int(2 * i)
        gdraw.ellipse((W - 220 - i * 4, -120 - i * 2, W + 80 + i * 4, 320 + i * 2),
                      fill=(26, 86, 219, alpha))
    glow = glow.filter(__import__("PIL.ImageFilter", fromlist=["GaussianBlur"]).GaussianBlur(40))
    img.paste(glow, (0, 0), glow)
    draw = ImageDraw.Draw(img, "RGBA")

    # Card border (very subtle inset frame so social previews have a defined edge)
    pad = 36
    draw.rounded_rectangle((pad, pad, W - pad, H - pad), radius=28,
                           outline=LINE, width=2)

    # Logo glyph
    draw_download_glyph(draw, cx=140, cy=158, size=110, fill=ACCENT, stroke=WHITE)

    # Wordmark
    word_font = load_font(36, bold=True)
    draw.text((216, 132), "Umbrella", fill=INK, font=word_font)

    # Headline
    h_font = load_font(76, bold=True)
    draw.text((96, 240), "LogMeIn Installer", fill=INK, font=h_font)

    # Tagline
    t_font = load_font(30)
    draw.text((96, 332), "Three short steps to remote support.", fill=INK_SOFT, font=t_font)

    # Three numbered steps
    num_font = load_font(28, bold=True)
    step_font = load_font(24, bold=True)
    base_y = 432
    steps = [("1", "Download"), ("2", "Run as admin"), ("3", "Email us")]
    x = 96
    for n, label in steps:
        numbered_pill(draw, x, base_y, n, label, num_font, step_font)
        lw = draw.textlength(label, font=step_font)
        x += 56 + 16 + int(lw) + 48

    # URL footer
    url_font = load_font(22)
    draw.text((96, H - 96), "umbrellaautomation.com", fill=INK_SOFT, font=url_font)

    out = OUT / "og-image.png"
    img.save(out, "PNG", optimize=True)
    print(f"wrote {out} ({out.stat().st_size:,} bytes)")


def build_apple_touch_icon():
    S = 180
    img = Image.new("RGB", (S, S), (255, 255, 255))
    draw = ImageDraw.Draw(img)
    draw_download_glyph(draw, cx=S // 2, cy=S // 2, size=S, fill=ACCENT, stroke=WHITE)
    out = OUT / "apple-touch-icon.png"
    img.save(out, "PNG", optimize=True)
    print(f"wrote {out} ({out.stat().st_size:,} bytes)")


if __name__ == "__main__":
    build_og()
    build_apple_touch_icon()
