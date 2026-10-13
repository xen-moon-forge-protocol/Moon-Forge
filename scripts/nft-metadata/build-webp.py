"""Builds the permanent (Arweave) copies of the Artifact images.

Every image is re-encoded as WebP at full 1024x1024 resolution with the highest quality that keeps
the file under MAX_BYTES, so each one fits ArDrive Turbo's free upload tier (105 KiB per item).
No EXIF or other metadata is written. Output: nft-arweave/images/<tier_slug>/<variant>.webp

Usage: python scripts/nft-metadata/build-webp.py   (needs Pillow)
"""
import io
import pathlib

from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parents[2]
SRC = ROOT / "frontend" / "src" / "assets" / "nft"
OUT = ROOT / "nft-arweave" / "images"
MAX_BYTES = 98_000  # free tier limit is 107,520 bytes per data item, headers and tags included

for src in sorted(SRC.glob("*/*.jpg")):
    image = Image.open(src).convert("RGB")
    for quality in range(92, 49, -2):
        buf = io.BytesIO()
        image.save(buf, "WEBP", quality=quality, method=6)
        if buf.tell() <= MAX_BYTES:
            break
    else:
        raise SystemExit(f"{src}: cannot fit {MAX_BYTES} bytes at 1024px")
    dst = OUT / src.parent.name / (src.stem + ".webp")
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_bytes(buf.getvalue())
    print(f"{dst.relative_to(ROOT)}  q{quality}  {buf.tell()} bytes")
