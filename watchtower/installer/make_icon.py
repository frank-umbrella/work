"""
make_icon.py - generate watchtower.ico for the installer EXE from the
dashboard's favicon.svg (the crenellated tower on a teal disc).

Single source of truth across surfaces:
  - Browser tab favicon: watchtower/favicon.svg (direct SVG)
  - Installer wizard small image: rendered from favicon.svg via
    make_wizard_images.py
  - Installer EXE icon in Explorer / Add/Remove Programs: this file
    (rasterizes favicon.svg to multi-size .ico)
  - Tray icon: hand-drawn in PIL to match the same shape (see
    agent/watchtower_tray.py)

All four read as the same product when the operator sees them in
different places (taskbar, system tray, browser, installer).

cairosvg + Pillow are required (both already pulled in by make_og.py
and make_wizard_images.py respectively):
  pip install cairosvg Pillow

Called from installer/build.ps1 when installer/watchtower.ico is
missing. Re-run manually after editing favicon.svg.

Usage:
  python make_icon.py                  # auto-locate favicon.svg
  python make_icon.py <src.svg> <dst.ico>   # legacy positional args
"""

import io
import os
import sys


# Standard Windows icon sizes. Including the small ones (16/24/32) lets
# Explorer / taskbar pick crisp variants; the larger ones cover the
# installer wizard splash + Add/Remove Programs cards + Alt+Tab.
ICON_SIZES = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]


def main():
    here = os.path.dirname(os.path.abspath(__file__))

    # Legacy positional args (kept so anyone with an old build script
    # that passes <src> <dst> still works). Otherwise default to
    # ../favicon.svg -> ./watchtower.ico.
    if len(sys.argv) == 3:
        src, dst = sys.argv[1], sys.argv[2]
    elif len(sys.argv) == 1:
        src = os.path.normpath(os.path.join(here, "..", "favicon.svg"))
        dst = os.path.join(here, "watchtower.ico")
    else:
        print("usage: make_icon.py [<src.svg> <dst.ico>]", file=sys.stderr)
        sys.exit(2)

    if not os.path.exists(src):
        print(f"source file not found: {src}", file=sys.stderr)
        sys.exit(1)

    try:
        import cairosvg
    except ImportError:
        print(
            "cairosvg is not installed.\n"
            "  pip install cairosvg Pillow\n"
            "Then re-run: python make_icon.py",
            file=sys.stderr,
        )
        sys.exit(2)
    try:
        from PIL import Image
    except ImportError:
        print("Pillow is not installed.\n  pip install Pillow", file=sys.stderr)
        sys.exit(2)

    # SVG-only path: rasterize at the largest required size, then let
    # Pillow downsample for the smaller variants. Doing it this way (vs
    # rasterizing the SVG separately at each size) keeps the strokes
    # consistent across all variants.
    if src.lower().endswith(".svg"):
        # bytestring= side-steps cairosvg's URL fetcher which trips on
        # UNC paths (repo on a network share). Same workaround as
        # scripts/make_og.py + make_wizard_images.py.
        with open(src, "rb") as f:
            svg_bytes = f.read()
        png_bytes = cairosvg.svg2png(bytestring=svg_bytes, output_width=256, output_height=256)
        img = Image.open(io.BytesIO(png_bytes)).convert("RGBA")
    else:
        # Legacy: PNG source (Logo-House-Icon.png path). Pad to square
        # if needed so .ico variants stay aspect-correct.
        img = Image.open(src).convert("RGBA")
        w, h = img.size
        if w != h:
            side = max(w, h)
            canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
            canvas.paste(img, ((side - w) // 2, (side - h) // 2))
            img = canvas

    img.save(dst, format="ICO", sizes=ICON_SIZES)
    print(f"Wrote {dst} with sizes {ICON_SIZES} from {os.path.basename(src)}")


if __name__ == "__main__":
    main()
