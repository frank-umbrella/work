"""
make_wizard_images.py - generate Inno Setup wizard images for the
Watchtower installer by rasterizing the brand-aligned SVGs:

  watchtower-wizard.bmp        410x797 -- the sci-fi watchtower scene
                                from installer/wizard-banner.svg.
                                Portrait composition of the same visual
                                language as the OG image (dark navy
                                gradient, starfield, glowing-beacon
                                tower, WATCHTOWER wordmark with cyan
                                glow). Shown on Welcome + Finish pages.

  watchtower-wizard-small.bmp  138x140 -- the dashboard favicon
                                (watchtower/favicon.svg), the
                                crenellated tower silhouette on a
                                teal disc. Shown on intermediate
                                wizard pages.

Uses cairosvg (already in the project for scripts/make_og.py). PIL is
used only to convert cairosvg's PNG output to the BMP format Inno
requires for WizardImageFile / WizardSmallImageFile.

  pip install cairosvg Pillow

Called from installer/build.ps1 when the BMPs don't exist. Re-run
manually after editing wizard-banner.svg or favicon.svg.
"""

import io
import os
import sys


# Output dimensions match Inno's 'modern' wizard image slot.
LARGE_W, LARGE_H = 410, 797
SMALL_W, SMALL_H = 138, 140

# Match the navy from wizard-banner.svg / og-image.svg so the small
# icon's teal-disc favicon sits on the same background. Subtle thing
# but the two BMPs read as one branded set instead of a tower in space
# next to a teal puck on white.
BG_NAVY = (6, 18, 39)


def _ensure_deps():
    """Returns (cairosvg, PIL.Image) or raises a clean message."""
    try:
        import cairosvg  # noqa: F401
    except ImportError:
        print(
            "cairosvg is not installed.\n"
            "  pip install cairosvg Pillow\n"
            "Then re-run: python make_wizard_images.py",
            file=sys.stderr,
        )
        sys.exit(2)
    try:
        from PIL import Image  # noqa: F401
    except ImportError:
        print(
            "Pillow is not installed.\n"
            "  pip install Pillow\n"
            "Then re-run.",
            file=sys.stderr,
        )
        sys.exit(2)
    import cairosvg
    from PIL import Image
    return cairosvg, Image


def _svg_to_bmp(cairosvg, Image, svg_path, out_path, width, height, bg=None):
    """Rasterize SVG -> PNG bytes via cairosvg, then convert to BMP via
    Pillow. cairosvg honors viewBox + width/height so output dimensions
    match the wizard slot exactly. Optional `bg` flattens transparency
    against a solid color (used for the small icon so the favicon's
    teal disc sits on the wizard's navy background, not white)."""
    png_bytes = cairosvg.svg2png(
        url=svg_path,
        output_width=width,
        output_height=height,
    )
    img = Image.open(io.BytesIO(png_bytes)).convert("RGBA")
    if bg is not None:
        # Composite over the requested bg color.
        bg_layer = Image.new("RGBA", img.size, bg + (255,))
        img = Image.alpha_composite(bg_layer, img)
    # BMP doesn't carry alpha cleanly across all renderers; flatten to RGB.
    img.convert("RGB").save(out_path, format="BMP")
    print(f"Wrote {out_path} ({width}x{height}) from {os.path.basename(svg_path)}")


def main():
    cairosvg, Image = _ensure_deps()

    here = os.path.dirname(os.path.abspath(__file__))

    # Large banner: rasterize the dedicated wizard SVG that's portrait-
    # composed for this slot. Sits next to og-image.svg in spirit.
    large_svg = os.path.join(here, "wizard-banner.svg")
    large_out = os.path.join(here, "watchtower-wizard.bmp")
    if not os.path.exists(large_svg):
        print(f"ERROR: {large_svg} not found", file=sys.stderr)
        sys.exit(1)
    _svg_to_bmp(cairosvg, Image, large_svg, large_out, LARGE_W, LARGE_H)

    # Small icon: reuse the dashboard's favicon (crenellated tower on
    # teal disc) so the browser tab + installer wizard share an icon.
    # Composited over navy so the disc sits on the same background as
    # the big banner, reading as one set.
    favicon_svg = os.path.normpath(os.path.join(here, "..", "favicon.svg"))
    small_out = os.path.join(here, "watchtower-wizard-small.bmp")
    if not os.path.exists(favicon_svg):
        print(f"ERROR: {favicon_svg} not found", file=sys.stderr)
        sys.exit(1)
    _svg_to_bmp(cairosvg, Image, favicon_svg, small_out, SMALL_W, SMALL_H, bg=BG_NAVY)


if __name__ == "__main__":
    main()
