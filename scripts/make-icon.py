#!/usr/bin/env python3
"""Turns an icon image into build/icon.icns. The source can be either a
transparent PNG or a rounded square on a white background (which is cut out
automatically). Output follows Apple's macOS icon grid: a 824px body centered
on a 1024px transparent canvas, with a soft drop shadow.

Usage: python3 scripts/make-icon.py assets/icon-source.png
Requires Pillow and macOS `iconutil`.
"""

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

CANVAS = 1024
BODY = 824
BACKGROUND_THRESHOLD = 120  # sum of (255 - channel); below this counts as background
ROOT = Path(__file__).resolve().parent.parent


def body_bbox(image):
    """Bounding box of everything that is not near-white."""
    gray = image.convert("L")
    solid = gray.point(lambda v: 255 if (255 - v) * 3 > BACKGROUND_THRESHOLD else 0)
    bbox = solid.getbbox()
    if not bbox:
        sys.exit("Could not find the icon body: image looks blank")
    return bbox


def outside_mask(image):
    """Mask (255 = keep) that removes the white background connected to the
    corners, leaving white areas inside the icon untouched."""
    width, height = image.size
    rgb = image.convert("RGB")
    near_white = Image.new("L", image.size, 0)
    src, dst = rgb.load(), near_white.load()
    for y in range(height):
        for x in range(width):
            r, g, b = src[x, y]
            if (765 - (r + g + b)) <= BACKGROUND_THRESHOLD:
                dst[x, y] = 255

    for corner in ((0, 0), (width - 1, 0), (0, height - 1), (width - 1, height - 1)):
        if near_white.getpixel(corner) == 255:
            ImageDraw.floodfill(near_white, corner, 128)

    keep = near_white.point(lambda v: 0 if v == 128 else 255)
    # Shave the anti-aliased white fringe off the edge.
    return keep.filter(ImageFilter.MinFilter(5))


def has_transparency(image):
    return image.mode == "RGBA" and image.getchannel("A").getextrema()[0] < 255


def clean_alpha(image):
    """For sources that already have transparency: drop near-invisible haze
    around the body and make the nearly-opaque interior fully opaque."""
    alpha = image.getchannel("A").point(lambda v: 0 if v < 8 else 255 if v >= 245 else v)
    image.putalpha(alpha)
    bbox = alpha.point(lambda v: 255 if v >= 128 else 0).getbbox()
    if not bbox:
        sys.exit("Could not find the icon body: image is fully transparent")
    return image.crop(bbox)


def build_master(source_path):
    image = Image.open(source_path)
    if has_transparency(image.convert("RGBA") if image.mode != "RGBA" else image):
        image = clean_alpha(image.convert("RGBA"))
    else:
        image = image.convert("RGBA")
        image = image.crop(body_bbox(image))
        image.putalpha(outside_mask(image))

    body = image.resize((BODY, BODY), Image.LANCZOS)
    offset = (CANVAS - BODY) // 2

    shadow_alpha = Image.new("L", (CANVAS, CANVAS), 0)
    shadow_alpha.paste(body.getchannel("A"), (offset, offset + 12))
    shadow_alpha = shadow_alpha.filter(ImageFilter.GaussianBlur(14))
    shadow_alpha = ImageChops.multiply(shadow_alpha, Image.new("L", shadow_alpha.size, 77))  # ~30%
    shadow = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    shadow.putalpha(shadow_alpha)

    master = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    master.alpha_composite(shadow)
    master.alpha_composite(body, (offset, offset))
    return master


def write_icns(master, out_path):
    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / "icon.iconset"
        iconset.mkdir()
        for size in (16, 32, 128, 256, 512):
            master.resize((size, size), Image.LANCZOS).save(iconset / f"icon_{size}x{size}.png")
            master.resize((size * 2, size * 2), Image.LANCZOS).save(iconset / f"icon_{size}x{size}@2x.png")
        subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(out_path)], check=True)


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    source = Path(sys.argv[1])
    build_dir = ROOT / "build"
    build_dir.mkdir(exist_ok=True)

    master = build_master(source)
    master.save(build_dir / "icon.png")
    write_icns(master, build_dir / "icon.icns")

    assets = ROOT / "assets"
    assets.mkdir(exist_ok=True)
    if source.resolve() != (assets / "icon-source.png").resolve():
        shutil.copyfile(source, assets / "icon-source.png")

    print(f"Wrote {build_dir / 'icon.png'} and {build_dir / 'icon.icns'}")


if __name__ == "__main__":
    main()
