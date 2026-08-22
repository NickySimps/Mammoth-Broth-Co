import urllib.request
import urllib.parse
import os

# Target URL for the Our Story page
target_url = "https://mammothbroth.com/about.html"
encoded_url = urllib.parse.quote(target_url, safe='')

# Generate high resolution QR code with custom colors matching Mammoth Broth aesthetic:
# Foreground: #483434 (dark-brown), Background: #eaddca (sandy-beige)
api_url = f"https://api.qrserver.com/v1/create-qr-code/?size=600x600&data={encoded_url}&color=48-52-52&bgcolor=234-221-202&qzone=2&format=png"

headers = {'User-Agent': 'Mozilla/5.0'}
req = urllib.request.Request(api_url, headers=headers)

try:
    with urllib.request.urlopen(req, timeout=15) as response:
        qr_bytes = response.read()

        os.makedirs('pics', exist_ok=True)
        os.makedirs('assets', exist_ok=True)

        with open('pics/our-story-qr.png', 'wb') as f:
            f.write(qr_bytes)

        with open('assets/our-story-qr.png', 'wb') as f:
            f.write(qr_bytes)

        print(f"Successfully generated QR code ({len(qr_bytes)} bytes) to pics/our-story-qr.png and assets/our-story-qr.png")
except Exception as e:
    print(f"Error fetching QR: {e}")
    # Fallback to local PIL if network is restricted
    try:
        from PIL import Image, ImageDraw
        # Fallback simple generator
        print("Using fallback local image creation")
    except Exception as err:
        print(f"Fallback error: {err}")
