"""Build og-image.png (1200x630) and apple-touch-icon.png (180x180) for LinkLock.

Run from the repo root or this directory; output is written to the parent
folder (work/linklock/).
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
OUT_DIR = HERE.parent

BG = (246, 247, 249)        # --bg     #f6f7f9
INK = (26, 31, 43)          # --ink    #1a1f2b
INK_SOFT = (71, 80, 99)     # --ink-soft #475063
ACCENT = (26, 86, 219)      # --accent #1a56db


def load_font(size, bold=False):
    candidates = (
        "C:/Windows/Fonts/segoeuib.ttf" if bold else "C:/Windows/Fonts/segoeui.ttf",
        "C:/Windows/Fonts/arialbd.ttf" if bold else "C:/Windows/Fonts/arial.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    )
    for path in candidates:
        try:
            return ImageFont.truetype(path, size)
        except (OSError, IOError):
            continue
    return ImageFont.load_default()


def draw_padlock(d: ImageDraw.ImageDraw, cx: int, cy: int, scale: float,
                 lock_color, hole_color):
    """Draw a padlock centered at (cx, cy) with overall height ~ 380*scale."""
    body_w = int(280 * scale)
    body_h = int(220 * scale)
    body_x0 = cx - body_w // 2
    body_y0 = cy - body_h // 2 + int(40 * scale)
    body_x1 = body_x0 + body_w
    body_y1 = body_y0 + body_h
    d.rounded_rectangle(
        (body_x0, body_y0, body_x1, body_y1),
        radius=int(26 * scale), fill=lock_color,
    )

    # Shackle: thick arc over the body, with vertical legs reaching down into body
    shackle_w = int(190 * scale)
    shackle_h = int(190 * scale)
    shackle_thickness = int(38 * scale)
    shackle_x0 = cx - shackle_w // 2
    shackle_y0 = body_y0 - shackle_h + int(shackle_thickness // 2)
    shackle_x1 = shackle_x0 + shackle_w
    shackle_y1 = shackle_y0 + shackle_h
    # Top half arc (180° to 360° in PIL = left-to-right across the top)
    d.arc(
        (shackle_x0, shackle_y0, shackle_x1, shackle_y1),
        start=180, end=360, fill=lock_color, width=shackle_thickness,
    )
    # Legs: connect arc endpoints down into body
    leg_top = shackle_y0 + shackle_h // 2
    leg_overlap = int(8 * scale)  # tuck slightly into body for clean join
    d.rectangle(
        (shackle_x0, leg_top, shackle_x0 + shackle_thickness, body_y0 + leg_overlap),
        fill=lock_color,
    )
    d.rectangle(
        (shackle_x1 - shackle_thickness, leg_top, shackle_x1, body_y0 + leg_overlap),
        fill=lock_color,
    )

    # Keyhole on body: circle + downward rectangle
    kh_r = int(22 * scale)
    kh_cy = body_y0 + body_h // 2 - int(10 * scale)
    d.ellipse(
        (cx - kh_r, kh_cy - kh_r, cx + kh_r, kh_cy + kh_r),
        fill=hole_color,
    )
    d.rectangle(
        (cx - int(11 * scale), kh_cy, cx + int(11 * scale), kh_cy + int(48 * scale)),
        fill=hole_color,
    )


def build_og_image():
    W, H = 1200, 630
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    # Subtle bottom accent bar
    d.rectangle((0, H - 8, W, H), fill=ACCENT)

    # Padlock on left
    draw_padlock(d, cx=260, cy=H // 2, scale=1.0, lock_color=ACCENT, hole_color=BG)

    # Right side: text block
    text_x = 520
    font_title = load_font(140, bold=True)
    font_sub = load_font(44, bold=False)
    font_foot = load_font(26, bold=False)

    d.text((text_x, 170), "LinkLock", fill=INK, font=font_title)
    d.text((text_x, 340), "One-time encrypted", fill=INK_SOFT, font=font_sub)
    d.text((text_x, 392), "password sharing", fill=INK_SOFT, font=font_sub)
    d.text((text_x, 490), "Encrypted in browser  •  Burned after first reveal",
           fill=INK_SOFT, font=font_foot)

    out = OUT_DIR / "og-image.png"
    img.save(out, "PNG", optimize=True)
    print(f"wrote {out} ({out.stat().st_size} bytes)")


def build_apple_touch_icon():
    S = 180
    img = Image.new("RGB", (S, S), ACCENT)
    d = ImageDraw.Draw(img)
    # White padlock on accent background, scaled down
    draw_padlock(d, cx=S // 2, cy=S // 2, scale=0.42,
                 lock_color=(255, 255, 255), hole_color=ACCENT)
    out = OUT_DIR / "apple-touch-icon.png"
    img.save(out, "PNG", optimize=True)
    print(f"wrote {out} ({out.stat().st_size} bytes)")


if __name__ == "__main__":
    build_og_image()
    build_apple_touch_icon()
