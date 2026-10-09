"""Render the rectangle-only SVG source with Pillow; no network/API needed.

Run: python desktop/assets/generate-icons.py
The SVG is the only geometry/color source. Supersampling preserves small edges;
Windows ICO contains real frames from 16 to 256px.
"""
from pathlib import Path
import xml.etree.ElementTree as ET
import base64
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent
SCALE = 4
source = ET.parse(ROOT / "threadterm.svg").getroot()
image = Image.new("RGBA", (512 * SCALE, 512 * SCALE))
draw = ImageDraw.Draw(image)
for node in source:
    if node.tag.rsplit("}", 1)[-1] != "rect":
        continue
    x, y, width, height = [float(node.attrib[key]) for key in ("x", "y", "width", "height")]
    bounds = tuple(round(value * SCALE) for value in (x, y, x + width, y + height))
    draw.rounded_rectangle(bounds, radius=float(node.attrib.get("rx", 0)) * SCALE, fill=node.attrib["fill"])
image = image.resize((512, 512), Image.Resampling.LANCZOS)
image.save(ROOT / "threadterm.png")
image.save(ROOT / "threadterm.ico", sizes=[(size, size) for size in (16, 20, 24, 32, 40, 48, 64, 128, 256)])
image.resize((32, 32), Image.Resampling.LANCZOS).save(ROOT / "threadterm-tray.png")
with (ROOT / "icon-data.ts").open("w", encoding="utf8") as module:
    module.write("// Generated from threadterm.svg by generate-icons.py; do not edit.\n")
    for name, file in [("applicationIconPng", "threadterm.png"), ("trayIconPng", "threadterm-tray.png")]:
        encoded = base64.b64encode((ROOT / file).read_bytes()).decode("ascii")
        module.write(f"export const {name} = 'data:image/png;base64,{encoded}';\n")
print("Generated ThreadTerm PNG, multi-resolution ICO and tray PNG from SVG.")
