"""Generate and decode public-only QR artwork locally; never send URLs to a QR service.

uv run --python 3.13 --with qrcode --with pillow --with zxing-cpp scripts/public_qr.py
Add --verify to check existing assets without rewriting them.
Existing printed QR assets and generate_qr.py are deliberately untouched.
"""
import argparse
import json
from pathlib import Path

import qrcode
from qrcode.image.svg import SvgPathFillImage
from PIL import Image
import zxingcpp

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "assets" / "qr"
TARGETS = {
    "shop": "https://mammothbroth.com/shop.html#products-section",
    "markets": "https://mammothbroth.com/markets.html#market-calendar",
    "contact": "https://mammothbroth.com/contact.html#main-content",
    "jar": "https://mammothbroth.com/jar.html",
}


def generate():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    for name, target in TARGETS.items():
        qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M,
                           box_size=24, border=4)
        qr.add_data(target)
        qr.make(fit=True)
        qr.make_image(fill_color="black", back_color="white").save(OUTPUT / f"{name}.png")
        qr.make_image(image_factory=SvgPathFillImage).save(OUTPUT / f"{name}.svg")
    (OUTPUT / "destinations.json").write_text(json.dumps(TARGETS, indent=2) + "\n", encoding="utf-8")


def verify():
    assert json.loads((OUTPUT / "destinations.json").read_text(encoding="utf-8")) == TARGETS
    for name, target in TARGETS.items():
        image = Image.open(OUTPUT / f"{name}.png").convert("RGB")
        result = zxingcpp.read_barcode(image)
        assert result and result.text == target, f"{name}: full-resolution decode mismatch"
        # The actual on-page image size must remain decodable too.
        small = image.resize((160, 160), Image.Resampling.LANCZOS)
        decoded_small = zxingcpp.read_barcode(small)
        assert decoded_small and decoded_small.text == target, f"{name}: display-size decode mismatch"
        assert image.getpixel((0, 0)) == (255, 255, 255), "Quiet zone must remain white"
        print(f"verified {name}: {image.width}x{image.height}, decoded at 160px -> {target}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify", action="store_true", help="Verify without rewriting assets")
    args = parser.parse_args()
    if not args.verify:
        generate()
    verify()
