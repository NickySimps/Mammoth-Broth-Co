"""Generate printable QR codes for the public Mammoth Broth Co. pages."""
import os
import urllib.parse
import urllib.request

from PIL import Image
from io import BytesIO

BASE_URL = "https://mammothbroth.com"
PUBLIC_PAGES = {
    "home": "index.html",
    "shop": "shop.html",
    "our-story": "about.html",
    "markets": "markets.html",
    "contact": "contact.html",
    "account": "account.html",
    "thank-you": "thank-you.html",
}


def make_qr_url(target_url):
    encoded_url = urllib.parse.quote(target_url, safe="")
    return (
        "https://api.qrserver.com/v1/create-qr-code/"
        f"?size=1200x1200&data={encoded_url}"
        "&color=48-52-52&bgcolor=234-221-202&qzone=4&format=png"
    )


def main():
    os.makedirs("assets", exist_ok=True)
    headers = {"User-Agent": "Mammoth-Broth-Co QR generator"}

    for name, page in PUBLIC_PAGES.items():
        target_url = f"{BASE_URL}/" if page == "index.html" else f"{BASE_URL}/{page}"
        request = urllib.request.Request(make_qr_url(target_url), headers=headers)
        with urllib.request.urlopen(request, timeout=30) as response:
            qr_image = Image.open(BytesIO(response.read())).convert("RGB")
        # The public QR endpoint caps its response at 250px. Upscale with
        # nearest-neighbor so the modules stay sharp on printed labels.
        qr_image = qr_image.resize((1200, 1200), Image.Resampling.NEAREST)
        output_path = os.path.join("assets", f"{name}-qr.png")
        qr_image.save(output_path, format="PNG", optimize=True)
        print(f"{output_path}: {os.path.getsize(output_path)} bytes -> {target_url}")


if __name__ == "__main__":
    main()
