#!/usr/bin/env python3
"""
Create a branded VSDactyl icon as PNG.
This creates a simple icon based on the VSDactyl color scheme.
"""

from PIL import Image, ImageDraw, ImageFont
import os

# VSDactyl colors
PRIMARY = (10, 58, 102)      # #0a3a66
PRIMARY_LIGHT = (36, 232, 245)  # #24e8f5
ACCENT = (36, 232, 245)     # #24e8f5
BG = (240, 240, 240)        # Light background

# Create a new image (128x128 for VS Code extension icon)
size = 128
img = Image.new('RGBA', (size, size), (255, 255, 255, 0))
draw = ImageDraw.Draw(img)

# Draw background circle
margin = 5
draw.ellipse(
    [margin, margin, size - margin, size - margin],
    fill=BG,
    outline=PRIMARY,
    width=3
)

# Draw center circle (representing server/connection)
center = size // 2
radius = 25
draw.ellipse(
    [center - radius, center - radius, center + radius, center + radius],
    fill=PRIMARY,
    outline=PRIMARY_LIGHT,
    width=2
)

# Draw accent circle (representing remote/file)
offset_radius = 18
offset = 20
draw.ellipse(
    [center + offset - offset_radius, center - offset - offset_radius, 
     center + offset + offset_radius, center - offset + offset_radius],
    fill=PRIMARY_LIGHT,
    outline=PRIMARY,
    width=2
)

# Draw another accent element
draw.ellipse(
    [center - offset - offset_radius, center + offset - offset_radius,
     center - offset + offset_radius, center + offset + offset_radius],
    fill=ACCENT,
    outline=PRIMARY,
    width=2
)

# Save as PNG
output_path = os.path.join(os.path.dirname(__file__), 'resources', 'icon.png')
img.save(output_path, 'PNG')
print(f"✓ Created branded icon at {output_path}")
