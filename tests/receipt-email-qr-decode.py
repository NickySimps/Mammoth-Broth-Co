"""Offline QR scan proof: uv run --with pillow --with zxing-cpp python tests/receipt-email-qr-decode.py"""
import base64
import io
import json
from pathlib import Path
import subprocess
import unittest

from PIL import Image
import zxingcpp

ROOT = Path(__file__).resolve().parents[1]


class ReceiptEmailQrDecode(unittest.TestCase):
    def test_pickup_gif_decodes_exact_order_only_at_email_sizes(self):
        for order_id in ("a1" * 32, "0" * 64, "f" * 64):
            result = subprocess.run(
                ["node", "-e", "const {renderReceiptEmail}=require('./firebase/functions/receipt-email.cjs'); const p=renderReceiptEmail('customer@example.invalid PRIVATE-CAPABILITY https://checkout.stripe.com/private',process.argv[1]); console.log(JSON.stringify({html:p.html,gif:p.attachments[0].content.toString('base64')}));", order_id],
                cwd=ROOT, check=True, capture_output=True, text=True,
            )
            packet = json.loads(result.stdout)
            image = Image.open(io.BytesIO(base64.b64decode(packet["gif"]))).convert("RGB")
            expected = f"https://mammothbroth.com/staff.html#order={order_id}"
            self.assertIn(f'href="{expected}"', packet["html"])
            for size in (image.width, 280, 260):
                for sampling in (Image.Resampling.NEAREST, Image.Resampling.LANCZOS):
                    with self.subTest(order=order_id, size=size, sampling=sampling):
                        decoded = zxingcpp.read_barcodes(image.resize((size, size), sampling))
                        self.assertEqual([code.text for code in decoded], [expected])

    def test_existing_shop_png_decodes_at_120px(self):
        self.check_public("shop", "https://mammothbroth.com/shop.html#products-section")

    def test_existing_jar_png_decodes_at_120px(self):
        self.check_public("jar", "https://mammothbroth.com/jar.html")

    def check_public(self, name, expected):
        image = Image.open(ROOT / "assets" / "qr" / f"{name}.png").convert("RGB")
        for sampling in (Image.Resampling.NEAREST, Image.Resampling.LANCZOS):
            with self.subTest(sampling=sampling):
                decoded = zxingcpp.read_barcodes(image.resize((120, 120), sampling))
                self.assertEqual([code.text for code in decoded], [expected])


if __name__ == "__main__":
    unittest.main(verbosity=2)
