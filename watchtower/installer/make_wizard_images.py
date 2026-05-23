"""
make_wizard_images.py - generate Inno Setup wizard images from the
Umbrella Automation branding source.

Produces two BMP files used by watchtower.iss:

  watchtower-wizard.bmp        410x797 px - large left-side banner on
                                Welcome + Finish wizard pages. Dark
                                navy background with the house logo,
                                UMBRELLA AUTOMATION wordmark, and
                                WATCHTOWER product title stacked
                                vertically. The 410x797 'modern' size
                                is auto-detected by Inno Setup (the
                                older 164x314 'classic' size would
                                also work but looks blocky on HiDPI).

  watchtower-wizard-small.bmp  138x140 px - small icon on the top
                                right of intermediate wizard pages
                                (token entry, install progress).
                                Just the house icon on the same
                                navy background as the large banner
                                so they read as one branded set.

Inno Setup requires .bmp specifically; it won't accept PNG/JPG for
WizardImageFile / WizardSmallImageFile. Pillow handles BMP fine.

Called from installer/build.ps1 when the bmps don't already exist.
Re-run manually if you change branding/source/Logo-House-Icon.png:

  python make_wizard_images.py

Output goes alongside the script in installer/.
"""

import os
import sys

from PIL import Image, ImageDraw, ImageFont


# Brand palette - matches the dashboard CSS variables and the
# OG image / Watchtower header so the installer feels like part of
# the same product.
BG_NAVY = (6, 18, 39)          # #061227 - deep navy from OG image bg gradient
ACCENT_TEAL = (10, 107, 107)   # #0a6b6b - Watchtower brand teal
ACCENT_CYAN = (90, 244, 227)   # #5af4e3 - beacon cyan
WORDMARK_BLUE = (38, 166, 230) # #26a6e6 - mid-stop of UMBRELLA gradient
WORDMARK_GRAY = (200, 200, 200) # #c8c8c8 - top of AUTOMATION gradient
WHITE = (255, 255, 255)
INK_FAINT = (127, 179, 179)    # #7fb3b3 - subtle subtitle color


# Output dimensions (Inno Setup 'modern' size set)
LARGE_W, LARGE_H = 410, 797
SMALL_W, SMALL_H = 138, 140


def _find_font(candidates, size):
    """Try a list of system font filenames; return the first that loads.

    Inno Setup wizard images don't have to use the brand's Eurostile
    font (which isn't installed on most build boxes anyway). System
    fonts in the Eurostile-adjacent family read just fine at the small
    rendered size used in wizard pages.
    """
    for name in candidates:
        try:
            return ImageFont.truetype(name, size)
        except (OSError, IOError):
            continue
    # Last-ditch fallback: Pillow's default bitmap font. Ugly but
    # the wizard image still gets produced.
    return ImageFont.load_default()


def _text_width(draw, text, font):
    """Pillow >=10 uses textbbox; older versions used textsize.
    Wrap so we work on whatever the build box has installed.
    """
    try:
        bbox = draw.textbbox((0, 0), text, font=font)
        return bbox[2] - bbox[0]
    except AttributeError:
        return draw.textsize(text, font=font)[0]


def _load_logo(branding_root):
    """Load the house icon PNG. Returns None if missing - caller falls
    back to a text-only image so the build doesn't hard-fail.
    """
    path = os.path.join(branding_root, "source", "Logo-House-Icon.png")
    if not os.path.exists(path):
        return None
    return Image.open(path).convert("RGBA")


def make_large(out_path, logo):
    """Build the 410x797 left-banner BMP.

    Layout (top to bottom):
      ~120px padding
      house icon, 200x200, centered horizontally
      ~30px gap
      "UMBRELLA" wordmark in brand blue
      "AUTOMATION" wordmark in brand gray
      ~50px gap
      thin horizontal teal divider line
      ~20px gap
      "WATCHTOWER" in cyan, centered
      "Endpoint Monitoring Agent" subtitle in faint teal
      remaining space - blank navy
    """
    img = Image.new("RGB", (LARGE_W, LARGE_H), BG_NAVY)
    draw = ImageDraw.Draw(img)

    # Subtle vignette - paint a slightly lighter band at the top so it
    # doesn't read as flat. 4 rows of slowly lightening color near the
    # top is enough to give depth without distracting.
    for y in range(120):
        # Interpolate from a slightly-lighter navy down to the base
        ratio = y / 120
        r = int(20 + (BG_NAVY[0] - 20) * ratio)
        g = int(35 + (BG_NAVY[1] - 35) * ratio)
        b = int(60 + (BG_NAVY[2] - 60) * ratio)
        draw.line([(0, y), (LARGE_W, y)], fill=(r, g, b))

    y = 110

    # Logo
    if logo:
        icon_size = 200
        scaled = logo.copy()
        scaled.thumbnail((icon_size, icon_size), Image.LANCZOS)
        # Centered horizontally
        ix = (LARGE_W - scaled.width) // 2
        # Paste with alpha - the logo PNG has transparency
        img.paste(scaled, (ix, y), scaled)
        y += scaled.height + 28

    # UMBRELLA / AUTOMATION wordmark (faux brand font via system fallback)
    eurostile_fallbacks = [
        "Eurostile.ttf", "EUROSTI.ttf",   # if the user has it installed
        "Microgramma.ttf",
        "BebasNeue.ttf",
        "Impact.ttf",                      # Windows ships this everywhere
        "arialbd.ttf",                     # Arial Bold - universal fallback
    ]
    wordmark_font = _find_font(eurostile_fallbacks, 38)

    for line, color in (("UMBRELLA", WORDMARK_BLUE), ("AUTOMATION", WORDMARK_GRAY)):
        w = _text_width(draw, line, wordmark_font)
        draw.text(((LARGE_W - w) // 2, y), line, font=wordmark_font, fill=color)
        y += 44

    y += 30

    # Teal divider line (matches the dashboard's section borders)
    div_pad = 60
    draw.line([(div_pad, y), (LARGE_W - div_pad, y)], fill=ACCENT_TEAL, width=2)
    y += 24

    # WATCHTOWER product title
    title_font = _find_font(eurostile_fallbacks + ["seguibl.ttf", "segoeuib.ttf"], 32)
    title = "WATCHTOWER"
    w = _text_width(draw, title, title_font)
    draw.text(((LARGE_W - w) // 2, y), title, font=title_font, fill=ACCENT_CYAN)
    y += 40

    # Subtitle
    subtitle_font = _find_font(["segoeui.ttf", "arial.ttf"], 14)
    subtitle = "Endpoint Monitoring Agent"
    w = _text_width(draw, subtitle, subtitle_font)
    draw.text(((LARGE_W - w) // 2, y), subtitle, font=subtitle_font, fill=INK_FAINT)

    img.save(out_path, format="BMP")
    print(f"Wrote {out_path} ({LARGE_W}x{LARGE_H})")


def make_small(out_path, logo):
    """Build the 138x140 small-icon BMP. Just the house logo on navy."""
    img = Image.new("RGB", (SMALL_W, SMALL_H), BG_NAVY)

    if logo:
        # Leave a 12px border so the icon doesn't crowd the edges.
        icon_size = min(SMALL_W, SMALL_H) - 24
        scaled = logo.copy()
        scaled.thumbnail((icon_size, icon_size), Image.LANCZOS)
        ix = (SMALL_W - scaled.width) // 2
        iy = (SMALL_H - scaled.height) // 2
        img.paste(scaled, (ix, iy), scaled)

    img.save(out_path, format="BMP")
    print(f"Wrote {out_path} ({SMALL_W}x{SMALL_H})")


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    branding_root = os.path.normpath(os.path.join(here, "..", "..", "branding"))

    logo = _load_logo(branding_root)
    if logo is None:
        print(f"warning: branding asset missing at {branding_root}/source/Logo-House-Icon.png", file=sys.stderr)
        print("         wizard images will still generate but without the house icon.", file=sys.stderr)

    large_out = os.path.join(here, "watchtower-wizard.bmp")
    small_out = os.path.join(here, "watchtower-wizard-small.bmp")

    make_large(large_out, logo)
    make_small(small_out, logo)


if __name__ == "__main__":
    main()
