"""
make_icons.py -- rasterize favicon.svg to PNG at multiple sizes.

Produces:
  watchtower/icon-16.png
  watchtower/icon-32.png
  watchtower/icon-64.png
  watchtower/icon-128.png
  watchtower/icon-192.png    <- Google Chat card header references this
  watchtower/icon-256.png
  watchtower/icon-512.png

Used by:
  * worker/src/index.js buildGoogleChatCard() -> icon-192.png as the
    card header imageUrl (Google Chat needs a public HTTPS PNG, doesn't
    reliably render SVG)
  * brand.html branding page -> download links for each size
  * Anyone who needs a PNG icon outside the browser context

Install once: pip install cairosvg
Run:          python scripts/make_icons.py
Re-run after every edit to favicon.svg.
"""

import os
import sys


SIZES = [16, 32, 64, 128, 192, 256, 512]


def main():
    try:
        import cairosvg
    except ImportError:
        print(
            "cairosvg is not installed.\n"
            "  Install with: pip install cairosvg\n"
            "Then re-run: python scripts/make_icons.py",
            file=sys.stderr,
        )
        sys.exit(2)

    here = os.path.dirname(os.path.abspath(__file__))
    svg_path = os.path.normpath(os.path.join(here, "..", "favicon.svg"))

    if not os.path.exists(svg_path):
        print(f"SVG not found: {svg_path}", file=sys.stderr)
        sys.exit(1)

    # bytestring= sidesteps cairosvg's URL opener which trips on UNC paths.
    with open(svg_path, "rb") as f:
        svg_bytes = f.read()

    for size in SIZES:
        out_path = os.path.normpath(os.path.join(here, "..", f"icon-{size}.png"))
        cairosvg.svg2png(
            bytestring=svg_bytes,
            write_to=out_path,
            output_width=size,
            output_height=size,
        )
        print(f"Wrote {out_path} ({size}x{size})")


if __name__ == "__main__":
    main()
