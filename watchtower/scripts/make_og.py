"""
make_og.py - rasterize watchtower/og-image.svg to og-image.png (1200x630)
for social platforms (Facebook, Twitter/X, LinkedIn, Slack, Discord)
that have flaky SVG support.

Uses cairosvg (pure-Python wrapper around libcairo). Install once:
    pip install cairosvg

Then run from the watchtower/ directory or from anywhere:
    python scripts/make_og.py

Re-generate after every edit to og-image.svg.

Output: watchtower/og-image.png (same dir as the SVG).
"""

import os
import sys


def main():
    try:
        import cairosvg
    except ImportError:
        print(
            "cairosvg is not installed.\n"
            "  Install with: pip install cairosvg\n"
            "Then re-run: python scripts/make_og.py",
            file=sys.stderr,
        )
        sys.exit(2)

    here = os.path.dirname(os.path.abspath(__file__))
    svg_path = os.path.normpath(os.path.join(here, "..", "og-image.svg"))
    png_path = os.path.normpath(os.path.join(here, "..", "og-image.png"))

    if not os.path.exists(svg_path):
        print(f"SVG not found: {svg_path}", file=sys.stderr)
        sys.exit(1)

    # Read SVG bytes directly rather than passing url= — cairosvg's URL
    # opener trips on UNC paths (e.g. when working out of a network share)
    # and the bytestring path side-steps that entirely.
    with open(svg_path, "rb") as f:
        svg_bytes = f.read()

    cairosvg.svg2png(
        bytestring=svg_bytes,
        write_to=png_path,
        output_width=1200,
        output_height=630,
    )
    print(f"Wrote {png_path} (1200x630)")


if __name__ == "__main__":
    main()
