"""
make_icon.py — convert a PNG (typically the Umbrella Automation house
logo from branding/source/) into a multi-size Windows .ico for the
Watchtower installer.

Called from installer/build.ps1 when installer/watchtower.ico is
missing. Pillow is already in the agent's build deps (the tray icon
draws via Pillow at runtime), so no new prereq.

Usage:
  python make_icon.py <src.png> <dst.ico>
"""

import sys
from PIL import Image


# Standard Windows icon sizes. Including the small ones (16/24/32) lets
# Explorer / taskbar pick crisp variants; the larger ones cover the
# installer wizard splash + Add/Remove Programs cards.
ICON_SIZES = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]


def main():
    if len(sys.argv) != 3:
        print("usage: make_icon.py <src.png> <dst.ico>", file=sys.stderr)
        sys.exit(2)
    src, dst = sys.argv[1], sys.argv[2]

    img = Image.open(src).convert("RGBA")
    # If the source is non-square, pad to a square canvas so the icon
    # variants stay aspect-correct (Pillow's ICO writer expects square).
    w, h = img.size
    if w != h:
        side = max(w, h)
        canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
        canvas.paste(img, ((side - w) // 2, (side - h) // 2))
        img = canvas

    img.save(dst, format="ICO", sizes=ICON_SIZES)
    print(f"Wrote {dst} with sizes {ICON_SIZES}")


if __name__ == "__main__":
    main()
