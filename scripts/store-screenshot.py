#!/usr/bin/env python3
"""Fit any screenshot into a Chrome Web Store 1280x800 frame (no cropping).

Usage: python scripts/store-screenshot.py <input.png> [output.png]
Scales the image to fit inside 1280x800 preserving aspect ratio, then pads
with white to exactly 1280x800.
"""
import sys
from PIL import Image

W, H = 1280, 800
src = sys.argv[1] if len(sys.argv) > 1 else "shot.png"
dst = sys.argv[2] if len(sys.argv) > 2 else "store-1280x800.png"

im = Image.open(src).convert("RGB")
scale = min(W / im.width, H / im.height)
new = im.resize((round(im.width * scale), round(im.height * scale)), Image.LANCZOS)
canvas = Image.new("RGB", (W, H), (255, 255, 255))
canvas.paste(new, ((W - new.width) // 2, (H - new.height) // 2))
canvas.save(dst, "PNG")
print(f"{src} {im.size} -> {dst} {canvas.size}")
