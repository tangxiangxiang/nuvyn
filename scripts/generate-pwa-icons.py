#!/usr/bin/env python3
"""Generate Nuvyn PWA PNG assets from the canonical public/logo.svg.

One-time asset maintenance command (not part of the production build):
  python -m pip install "cairosvg==2.7.1" "Pillow==11.3.0"
  python scripts/generate-pwa-icons.py

Do not hand-edit the exported PNGs or alter the underlying Nuvyn brand.
"""
from io import BytesIO
from pathlib import Path

import cairosvg
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / "public/logo.svg").read_bytes()
BACKGROUND = "#f8fafc"
SPECS = (
    ("pwa-192.png", 192, 0.90),
    ("pwa-512.png", 512, 0.90),
    ("pwa-maskable-512.png", 512, 0.78),
    ("apple-touch-icon.png", 180, 0.90),
)

for filename, size, scale in SPECS:
    # Supersample before downscaling, retaining sharp edges and the SVG gradient.
    rendered_size = round(size * scale * 2)
    rendered = Image.open(
        BytesIO(
            cairosvg.svg2png(
                bytestring=SOURCE,
                output_width=rendered_size,
                output_height=rendered_size,
            )
        )
    ).convert("RGBA")
    draw_size = round(size * scale)
    rendered = rendered.resize((draw_size, draw_size), Image.Resampling.LANCZOS)

    background = Image.new("RGBA", (size, size), BACKGROUND)
    offset = ((size - draw_size) // 2, (size - draw_size) // 2)
    background.alpha_composite(rendered, offset)

    # Indexed PNG reduces size while preserving a smooth 256-color brand gradient.
    output = background.convert("RGB").quantize(
        colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE
    )
    target = ROOT / "public" / filename
    output.save(target, format="PNG", optimize=True, compress_level=9)
    print(f"{target.relative_to(ROOT)} ({size}x{size})")
