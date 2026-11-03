#!/usr/bin/env python3
"""Generate synthetic test images for the Immich API spike.

Usage: python3 make-fixtures.py <out-dir>      (requires Pillow)

Produces:
  IMG_0001.PNG                 iPhone-sized PNG with EXIF UserComment = "Screenshot" (like iOS)
  Screenshot_20260101-120000.png  Android-style name, no EXIF
  Bildschirmfoto 2026-01-01 um 12.00.00.png  macOS (German) name, no EXIF
  IMG_0002.PNG                 iPhone-sized PNG, tag stripped (re-encoded screenshot)
  DSC_0001.JPG                 camera JPEG with make/model/lens/exposure/fNumber
  wallpaper.png                tall PNG without EXIF (false-positive candidate; archived by seed)

Images contain noise so PNGs are well above 64 KiB, which makes the
HTTP Range (bytes=0-65535) test meaningful.
"""

import os
import random
import sys

from PIL import Image
from PIL.TiffImagePlugin import IFDRational

# EXIF tag ids
MAKE, MODEL = 0x010F, 0x0110
EXIF_IFD = 0x8769
EXPOSURE_TIME, F_NUMBER = 0x829A, 0x829D
USER_COMMENT = 0x9286
LENS_MODEL = 0xA434


def noisy(width: int, height: int, seed: int) -> Image.Image:
    rnd = random.Random(seed)
    img = Image.new("RGB", (width, height), (rnd.randrange(256), rnd.randrange(256), rnd.randrange(256)))
    # A noisy band near the top defeats PNG compression enough to exceed 64 KiB.
    band = Image.frombytes("RGB", (width, 200), rnd.randbytes(width * 200 * 3))
    img.paste(band, (0, 100))
    return img


def ios_screenshot_exif() -> Image.Exif:
    exif = Image.Exif()
    ifd = exif.get_ifd(EXIF_IFD)
    # UserComment: 8-byte charset prefix + text (EXIF 2.3 §4.6.5)
    ifd[USER_COMMENT] = b"ASCII\x00\x00\x00Screenshot"
    return exif


def camera_exif() -> Image.Exif:
    exif = Image.Exif()
    exif[MAKE] = "NIKON CORPORATION"
    exif[MODEL] = "NIKON Z 6"
    ifd = exif.get_ifd(EXIF_IFD)
    ifd[EXPOSURE_TIME] = IFDRational(1, 250)
    ifd[F_NUMBER] = IFDRational(28, 10)
    ifd[LENS_MODEL] = "NIKKOR Z 24-70mm f/4 S"
    return exif


def main(out_dir: str) -> None:
    os.makedirs(out_dir, exist_ok=True)
    w, h = 1179, 2556  # iPhone 15 / 16 screen resolution

    noisy(w, h, 1).save(os.path.join(out_dir, "IMG_0001.PNG"), exif=ios_screenshot_exif().tobytes())
    noisy(w, h, 2).save(os.path.join(out_dir, "IMG_0002.PNG"))
    noisy(1080, 2400, 3).save(os.path.join(out_dir, "Screenshot_20260101-120000.png"))
    noisy(2880, 1800, 4).save(os.path.join(out_dir, "Bildschirmfoto 2026-01-01 um 12.00.00.png"))
    noisy(1440, 3200, 5).save(os.path.join(out_dir, "wallpaper.png"))
    noisy(6048, 4024, 6).save(os.path.join(out_dir, "DSC_0001.JPG"), quality=80, exif=camera_exif().tobytes())

    for name in sorted(os.listdir(out_dir)):
        print(f"{os.path.getsize(os.path.join(out_dir, name)):>10}  {name}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "fixtures")
