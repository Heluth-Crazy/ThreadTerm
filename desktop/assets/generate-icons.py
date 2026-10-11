"""Render threadterm.svg with Pillow; no network/API needed.

Run: python desktop/assets/generate-icons.py
The SVG is the only geometry/color source. Direct rectangles and one clockwise
rotate() group are supported; any other element or transform fails the run so
the PNG cannot drift from the SVG. Supersampling preserves small edges.
Windows ICO contains real frames from 16 to 256px.
"""
from pathlib import Path
import re
import xml.etree.ElementTree as ET
import base64
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[1]
SCALE = 4
ROTATE = re.compile(r"rotate\(\s*([+-]?\d+(?:\.\d+)?)(?:\s+([+-]?\d+(?:\.\d+)?)\s+([+-]?\d+(?:\.\d+)?))?\s*\)")

def local_name(tag):
    return tag.rsplit("}", 1)[-1]

def draw_rect(draw, node, scale):
    x, y, width, height = [float(node.attrib[key]) for key in ("x", "y", "width", "height")]
    bounds = tuple(round(value * scale) for value in (x, y, x + width, y + height))
    draw.rounded_rectangle(bounds, radius=float(node.attrib.get("rx", 0)) * scale, fill=node.attrib["fill"])

def paint(image, nodes, scale, apply_rotation=True):
    draw = ImageDraw.Draw(image)
    for node in nodes:
        kind = local_name(node.tag)
        if kind in {"title", "desc"}:
            continue
        if kind == "rect":
            draw_rect(draw, node, scale)
            continue
        if kind != "g":
            raise SystemExit(f"unsupported SVG element: {kind}")
        transform = node.attrib.get("transform", "").strip()
        if not transform or not apply_rotation:
            paint(image, list(node), scale, apply_rotation)
            continue
        match = ROTATE.fullmatch(transform)
        if not match:
            raise SystemExit(f"unsupported SVG transform: {transform}")
        angle, cx, cy = float(match.group(1)), float(match.group(2) or 0), float(match.group(3) or 0)
        if abs(angle - 5) > 0.01 or abs(cx - 256) > 0.01 or abs(cy - 256) > 0.01:
            raise SystemExit(f"motif rotation must stay rotate(5 256 256), got {transform}")
        layer = Image.new("RGBA", image.size)
        paint(layer, list(node), scale, apply_rotation)
        # SVG positive angles are clockwise. Pillow positive angles are counter-clockwise.
        rotated = layer.rotate(-angle, resample=Image.Resampling.BICUBIC, center=(cx * scale, cy * scale))
        image.alpha_composite(rotated)

def near(pixel, color, tolerance=20):
    rgb = tuple(int(color[index:index + 2], 16) for index in (1, 3, 5))
    return pixel[3] > 220 and all(abs(int(pixel[channel]) - rgb[channel]) <= tolerance for channel in range(3))

source = ET.parse(ROOT / "threadterm.svg").getroot()
image = Image.new("RGBA", (512 * SCALE, 512 * SCALE))
paint(image, list(source), SCALE)
image = image.resize((512, 512), Image.Resampling.LANCZOS)
upright = Image.new("RGBA", (512 * SCALE, 512 * SCALE))
paint(upright, list(source), SCALE, apply_rotation=False)
upright = upright.resize((512, 512), Image.Resampling.LANCZOS)
if image.tobytes() == upright.tobytes():
    raise SystemExit("five-degree motif rotation did not change the rendered mark")
# Gap and stem centers are measured after the clockwise rotation around the tile center.
if not near(image.getpixel((261, 270)), "#5753cf"):
    raise SystemExit(f"stem gap is not the tile color: {image.getpixel((261, 270))}")
if not near(image.getpixel((291, 225)), "#ffffff"):
    raise SystemExit(f"upright stem center is not white: {image.getpixel((291, 225))}")
if not near(image.getpixel((230, 299)), "#dfe2ff"):
    raise SystemExit(f"inverted stem center is not the light T: {image.getpixel((230, 299))}")
small = image.resize((16, 16), Image.Resampling.LANCZOS)
opaque = sum(1 for pixel in small.get_flattened_data() if pixel[3] > 200)
if opaque < 180:
    raise SystemExit(f"16px frame lost the tile: {opaque} opaque pixels")
image.save(ROOT / "threadterm.png")
public = REPO / "renderer" / "public"
public.mkdir(parents=True, exist_ok=True)
image.save(public / "brand-mark.png")
image.save(ROOT / "threadterm.ico", sizes=[(size, size) for size in (16, 20, 24, 32, 40, 48, 64, 128, 256)])
image.resize((32, 32), Image.Resampling.LANCZOS).save(ROOT / "threadterm-tray.png")
with (ROOT / "icon-data.ts").open("w", encoding="utf8") as module:
    module.write("// Generated from threadterm.svg by generate-icons.py; do not edit.\n")
    for name, file in [("applicationIconPng", "threadterm.png"), ("trayIconPng", "threadterm-tray.png")]:
        encoded = base64.b64encode((ROOT / file).read_bytes()).decode("ascii")
        module.write(f"export const {name} = 'data:image/png;base64,{encoded}';\n")
print("Generated ThreadTerm PNG, multi-resolution ICO, tray PNG, and renderer brand mark from SVG.")
