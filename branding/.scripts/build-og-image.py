"""
Build Umbrella Automation brand-page social assets.

Outputs (all in repo root, work/branding/):
  og-image.png            1200x630   social share card
  apple-touch-icon.png     180x180   iOS home-screen icon

Renders the canonical SVG logos via cairosvg, then composites with
Pillow text. Run from any cwd with:
    python work/branding/.scripts/build-og-image.py
"""

from io import BytesIO
from pathlib import Path

import cairosvg
from PIL import Image, ImageDraw, ImageFont

REPO = Path(__file__).resolve().parents[1]
OUT_OG = REPO / "og-image.png"
OUT_APPLE = REPO / "apple-touch-icon.png"

LOGO_ON_DARK_SVG = REPO / "assets" / "logo-on-dark.svg"
SUBMARK_SVG = REPO / "assets" / "submark.svg"
FAVICON_SVG = REPO / "favicon.svg"

# Brand palette (mirrors index.html :root)
BG_DARK    = (13, 17, 25)      # #0d1119  - page dark variant
BG_DARKER  = (6,  8,  16)      # #060810
BRAND_BLUE = (26, 155, 232)    # #1A9BE8
BRAND_DEEP = (12, 94, 156)     # #0C5E9C
BRAND_STORM = (26, 31, 43)     # #1A1F2B
INK_WHITE  = (255, 255, 255)
INK_DIM    = (181, 188, 200)   # subtitle gray
INK_FAINT  = (110, 118, 132)
LINE_SOFT  = (38, 44, 56)


FONTS = "C:/Windows/Fonts"


def f(name, size):
    return ImageFont.truetype(f"{FONTS}/{name}", size)


def text_size(draw, text, font):
    l, t, r, b = draw.textbbox((0, 0), text, font=font)
    return r - l, b - t


def svg_to_pil(svg_path: Path, output_width: int) -> Image.Image:
    """Rasterize an SVG to a PIL RGBA Image at the given pixel width.

    Reads the file ourselves and passes the bytes — cairosvg's url= mode
    rewrites T:\\… paths into UNC \\Apps\\… on this NAS-mapped drive and
    fails. bytestring= avoids the path round-trip.
    """
    svg_bytes = svg_path.read_bytes()
    png_bytes = cairosvg.svg2png(
        bytestring=svg_bytes,
        output_width=output_width,
    )
    return Image.open(BytesIO(png_bytes)).convert("RGBA")


# ---------------------------------------------------------------------------
# Open Graph card — 1200 x 630
# ---------------------------------------------------------------------------
W, H = 1200, 630
img = Image.new("RGB", (W, H), BG_DARKER)
d = ImageDraw.Draw(img, "RGBA")

# Soft vertical gradient backdrop — subtle, just enough to lift the panel
for y in range(H):
    t = y / H
    # blend from BG_DARKER (top) to BG_DARK (bottom)
    r = int(BG_DARKER[0] + (BG_DARK[0] - BG_DARKER[0]) * t)
    g = int(BG_DARKER[1] + (BG_DARK[1] - BG_DARKER[1]) * t)
    b = int(BG_DARKER[2] + (BG_DARK[2] - BG_DARKER[2]) * t)
    d.line([(0, y), (W, y)], fill=(r, g, b))

# Thin brand-blue accent stripe top + bottom
d.rectangle([0, 0, W, 6], fill=BRAND_BLUE)
d.rectangle([0, H - 6, W, H], fill=BRAND_DEEP)

# Subtle inset border
PAD = 60
d.rounded_rectangle([PAD, PAD, W - PAD, H - PAD], radius=22,
                    outline=LINE_SOFT, width=2)

# ---- Logo (on-dark variant) ------------------------------------------------
# logo-on-dark.svg is 1300x280. Render it at 880px wide so it sits roomily
# centered horizontally; keep its aspect ratio.
logo_w = 880
logo = svg_to_pil(LOGO_ON_DARK_SVG, output_width=logo_w)
logo_h = logo.height
logo_x = (W - logo_w) // 2
# Place a bit above vertical center so the subtitle has clean breathing room
logo_y = (H - logo_h) // 2 - 50
img.paste(logo, (logo_x, logo_y), logo)

# ---- Subtitle --------------------------------------------------------------
sub_font = f("Inter-SemiBold.ttf", 26)
subtitle = "BRAND  GUIDELINES"
sw, sh = text_size(d, subtitle, sub_font)
# Tracked spacing visual cue via the double-space already in the string
sub_x = (W - sw) // 2
sub_y = logo_y + logo_h + 28
d.text((sub_x, sub_y), subtitle, font=sub_font, fill=INK_DIM)

# Thin blue underline under subtitle
ux1 = (W - 80) // 2
d.rectangle([ux1, sub_y + sh + 14, ux1 + 80, sub_y + sh + 17], fill=BRAND_BLUE)

# ---- Foot row: brand name (left) + tagline (right) ------------------------
foot_y = H - PAD - 34
brand_font = f("Inter-SemiBold.ttf", 18)
d.text((PAD + 24, foot_y), "Umbrella Automation",
       font=brand_font, fill=INK_DIM)

tag_font = f("Inter-Medium.ttf", 16)
tagline = "Logos  ·  Colors  ·  Typography  ·  Usage"
tw, th = text_size(d, tagline, tag_font)
d.text((W - PAD - 24 - tw, foot_y + 2), tagline,
       font=tag_font, fill=INK_FAINT)

img.save(OUT_OG, "PNG", optimize=True)
print(f"Wrote {OUT_OG.relative_to(REPO.parent)}  ({OUT_OG.stat().st_size // 1024} KB)")


# ---------------------------------------------------------------------------
# Apple touch icon — 180 x 180
# ---------------------------------------------------------------------------
# Render the favicon at a generous internal size, then place it on a rounded
# brand-storm square so iOS home-screen lockup looks intentional.
icon_size = 180
corner_r = 36  # iOS rounds with its own mask anyway, but this looks right in
               # preview viewers + Safari pinned-tab

icon_bg = Image.new("RGBA", (icon_size, icon_size), (0, 0, 0, 0))
icon_d = ImageDraw.Draw(icon_bg, "RGBA")
icon_d.rounded_rectangle([0, 0, icon_size - 1, icon_size - 1],
                         radius=corner_r,
                         fill=BRAND_STORM)

# Render the submark (the house icon, no wordmark) at 78% of canvas
mark_w = int(icon_size * 0.78)
mark = svg_to_pil(SUBMARK_SVG, output_width=mark_w)
# Submark viewBox is 116x102 — taller-than-square ratio (16:14ish)
mx = (icon_size - mark.width) // 2
my = (icon_size - mark.height) // 2
icon_bg.paste(mark, (mx, my), mark)

icon_bg.convert("RGB").save(OUT_APPLE, "PNG", optimize=True)
print(f"Wrote {OUT_APPLE.relative_to(REPO.parent)}  ({OUT_APPLE.stat().st_size // 1024} KB)")
