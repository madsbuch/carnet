"""Render the Carnet icon sources (requires Pillow: pip install pillow).

Outputs, all 1024x1024, consumed by `bun tauri icon icon/app-icon.json`:
  app-icon.png     rounded indigo square + white note-graph motif (desktop)
  app-icon-fg.png  motif alone, sized for the Android adaptive safe zone
  app-icon-bg.png  full-bleed gradient behind the adaptive foreground

The motif is the app's own toolbar graph icon: nodes (5,15) (15,14) (10,5)
in a 20-unit box, fully connected.
"""
from pathlib import Path

from PIL import Image, ImageDraw

S = 3  # supersample factor; everything renders at 1024*S and downscales
N = 1024 * S
WHITE = (255, 255, 255, 255)
TOP, BOTTOM = (129, 140, 248), (79, 70, 229)  # --accent dark/light: #818cf8, #4f46e5
OUT = Path(__file__).parent


def gradient() -> Image.Image:
    img = Image.new("RGBA", (N, N))
    d = ImageDraw.Draw(img)
    for y in range(N):
        t = y / (N - 1)
        c = tuple(round(TOP[i] + (BOTTOM[i] - TOP[i]) * t) for i in range(3)) + (255,)
        d.line([(0, y), (N, y)], fill=c)
    return img


def draw_motif(d: ImageDraw.ImageDraw, unit: float) -> None:
    """Graph triangle centered on the canvas, `unit` px per viewBox unit."""
    nodes = [(5, 15, 2.47), (15, 14, 2.47), (10, 5, 2.93)]
    # center the 20-unit box, nudged up: the triangle is bottom-heavy
    ox, oy = N / 2 - 10 * unit, N / 2 - 10 * unit - 0.67 * unit
    centers = [(ox + x * unit, oy + y * unit) for x, y, _ in nodes]
    lw = 1.13 * unit
    for i in range(3):
        for j in range(i + 1, 3):
            d.line([centers[i], centers[j]], fill=WHITE, width=round(lw))
            for c in (centers[i], centers[j]):  # round the line caps
                d.ellipse(
                    [c[0] - lw / 2, c[1] - lw / 2, c[0] + lw / 2, c[1] + lw / 2],
                    fill=WHITE,
                )
    for (_, _, r), c in zip(nodes, centers):
        rr = r * unit
        d.ellipse([c[0] - rr, c[1] - rr, c[0] + rr, c[1] + rr], fill=WHITE)


def save(img: Image.Image, name: str) -> None:
    img.resize((1024, 1024), Image.LANCZOS).save(OUT / name)
    print("wrote", name)


# desktop icon: gradient rounded square (with macOS-style margin) + motif
icon = Image.new("RGBA", (N, N), (0, 0, 0, 0))
mask = Image.new("L", (N, N), 0)
m, r = 64 * S, 200 * S
ImageDraw.Draw(mask).rounded_rectangle([m, m, N - m, N - m], radius=r, fill=255)
icon.paste(gradient(), (0, 0), mask)
draw_motif(ImageDraw.Draw(icon), 30 * S)
save(icon, "app-icon.png")

# adaptive foreground: motif only, inside the central ~55% (safe zone is 61%)
fg = Image.new("RGBA", (N, N), (0, 0, 0, 0))
draw_motif(ImageDraw.Draw(fg), 25 * S)
save(fg, "app-icon-fg.png")

# adaptive background: the gradient, full bleed
save(gradient(), "app-icon-bg.png")
