"""Build og-image.png (1200x630) and apple-touch-icon.png (180x180) for the
Computer Name guide. Self-contained: draws a monitor with a name-tag label in
the Umbrella Automation brand palette.

Run from anywhere; output is written to the parent folder (work/computer-name/).
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
OUT_DIR = HERE.parent

BG = (244, 246, 249)          # --bg
INK = (17, 21, 29)            # --ink
INK_SOFT = (74, 82, 96)       # --ink-soft
BRAND = (26, 155, 232)        # --brand  #1A9BE8
BRAND_DEEP = (12, 94, 156)    # --brand-deep #0C5E9C
GRAY = (158, 164, 171)        # submark gray #9ea4ab
WHITE = (255, 255, 255)


def load_font(size, bold=False):
    candidates = (
        "C:/Windows/Fonts/segoeuib.ttf" if bold else "C:/Windows/Fonts/segoeui.ttf",
        "C:/Windows/Fonts/arialbd.ttf" if bold else "C:/Windows/Fonts/arial.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold
        else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    )
    for path in candidates:
        try:
            return ImageFont.truetype(path, size)
        except (OSError, IOError):
            continue
    return ImageFont.load_default()


def draw_house(d, x, y, scale, fill):
    """Tiny Umbrella Automation house submark, roof + walls."""
    # roof: two angled strokes meeting at apex
    apex = (x, y)
    d.line([(x - 52 * scale, y + 40 * scale), apex], fill=fill, width=int(9 * scale))
    d.line([apex, (x + 52 * scale, y + 40 * scale)], fill=fill, width=int(9 * scale))
    # walls
    wx0, wy0 = x - 38 * scale, y + 40 * scale
    wx1, wy1 = x + 38 * scale, y + 96 * scale
    d.rectangle((wx0, wy0, wx1, wy1), outline=fill, width=int(8 * scale))
    # blue connector dots/lines inside
    bx = x - 18 * scale
    for i, dy in enumerate((56, 72)):
        cy = y + dy * scale
        r = int(5 * scale)
        d.ellipse((bx - r, cy - r, bx + r, cy + r), fill=BRAND)
        d.line([(bx + r + 3 * scale, cy), (x + 26 * scale, cy)], fill=BRAND, width=int(4 * scale))


def draw_monitor(d, cx, cy, w, h):
    """A monitor with a highlighted 'name tag' row on screen."""
    x0, y0 = cx - w // 2, cy - h // 2
    x1, y1 = cx + w // 2, cy + h // 2
    # bezel
    d.rounded_rectangle((x0, y0, x1, y1), radius=22, fill=INK)
    # screen
    pad = 14
    sx0, sy0, sx1, sy1 = x0 + pad, y0 + pad, x1 - pad, y1 - pad
    d.rounded_rectangle((sx0, sy0, sx1, sy1), radius=12, fill=WHITE)
    # highlighted name-tag row
    rx0, ry0 = sx0 + 26, sy0 + 30
    rx1, ry1 = sx1 - 26, sy0 + 122
    d.rounded_rectangle((rx0, ry0, rx1, ry1), radius=12,
                        fill=(232, 244, 252), outline=BRAND, width=4)
    lf = load_font(26, bold=False)
    vf = load_font(32, bold=True)
    d.text((rx0 + 22, ry0 + 12), "Device name", fill=INK_SOFT, font=lf)
    d.text((rx0 + 22, ry0 + 48), "DESKTOP-7K2QX9P", fill=BRAND_DEEP, font=vf)
    # two dim placeholder rows below
    for i in range(2):
        ly = ry1 + 26 + i * 40
        d.rounded_rectangle((rx0, ly, rx0 + 150, ly + 16), radius=8, fill=(225, 229, 235))
        d.rounded_rectangle((rx1 - 200, ly, rx1, ly + 16), radius=8, fill=(232, 235, 240))
    # stand
    d.rectangle((cx - 12, y1, cx + 12, y1 + 34), fill=INK)
    d.rounded_rectangle((cx - 70, y1 + 34, cx + 70, y1 + 50), radius=8, fill=INK)


def build_og_image():
    W, H = 1200, 630
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    # bottom brand bar
    d.rectangle((0, H - 10, W, H), fill=BRAND)

    # monitor on the left
    draw_monitor(d, cx=320, cy=300, w=430, h=320)

    # text block on the right
    tx = 588
    f_title = load_font(74, bold=True)
    f_sub = load_font(37, bold=False)
    f_foot = load_font(28, bold=True)

    d.text((tx, 168), "Find Your", fill=INK, font=f_title)
    d.text((tx, 250), "Computer Name", fill=BRAND_DEEP, font=f_title)
    d.text((tx, 366), "A quick, illustrated guide for", fill=INK_SOFT, font=f_sub)
    d.text((tx, 412), "Windows & macOS users.", fill=INK_SOFT, font=f_sub)
    d.text((tx, 492), "Windows 11  ·  Windows 10  ·  macOS",
           fill=BRAND_DEEP, font=f_foot)

    # small UA house mark + label, top-right
    draw_house(d, x=tx + 34, y=66, scale=0.40, fill=GRAY)
    f_brand = load_font(21, bold=True)
    d.text((tx + 78, 74), "UMBRELLA AUTOMATION", fill=GRAY, font=f_brand)

    out = OUT_DIR / "og-image.png"
    img.save(out, "PNG", optimize=True)
    print(f"wrote {out} ({out.stat().st_size} bytes)")


def build_apple_touch_icon():
    S = 180
    img = Image.new("RGB", (S, S), BRAND)
    d = ImageDraw.Draw(img)
    # white monitor glyph
    x0, y0, x1, y1 = 38, 44, 142, 118
    d.rounded_rectangle((x0, y0, x1, y1), radius=12, fill=WHITE)
    d.rounded_rectangle((x0 + 12, y0 + 28, x1 - 12, y0 + 46), radius=5, fill=BRAND)
    d.rectangle((S // 2 - 5, y1, S // 2 + 5, y1 + 14), fill=WHITE)
    d.rounded_rectangle((S // 2 - 30, y1 + 14, S // 2 + 30, y1 + 24), radius=5, fill=WHITE)
    out = OUT_DIR / "apple-touch-icon.png"
    img.save(out, "PNG", optimize=True)
    print(f"wrote {out} ({out.stat().st_size} bytes)")


if __name__ == "__main__":
    build_og_image()
    build_apple_touch_icon()
