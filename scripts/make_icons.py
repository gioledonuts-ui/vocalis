#!/usr/bin/env python3
"""Régénère les icônes de l'extension Vocalis (16/32/48/128 px).

Usage :  python scripts/make_icons.py
Nécessite Pillow :  pip install pillow

Design : fond indigo sombre arrondi, forme d'onde violet→cyan (5 barres),
le motif du logo Vocalis.
"""

from pathlib import Path

from PIL import Image, ImageDraw

# Couleurs
BG = (20, 18, 31, 255)        # indigo très sombre
GRAD_A = (139, 92, 246)       # violet
GRAD_B = (34, 211, 238)       # cyan

BAR_HEIGHTS = [0.30, 0.58, 0.80, 0.46, 0.66]  # proportions relatives à la taille


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def bar_color(t: float):
    return tuple(int(lerp(GRAD_A[i], GRAD_B[i], t)) for i in range(3)) + (255,)


def make_icon(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    radius = int(size * 0.20)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=BG)

    n = len(BAR_HEIGHTS)
    bar_w = size * 0.105
    gap = size * 0.075
    total_w = n * bar_w + (n - 1) * gap
    x0 = (size - total_w) / 2
    cy = size * 0.52

    for i, h in enumerate(BAR_HEIGHTS):
        t = i / (n - 1)
        bh = size * h
        x = x0 + i * (bar_w + gap)
        d.rounded_rectangle(
            [x, cy - bh / 2, x + bar_w, cy + bh / 2],
            radius=bar_w / 2,
            fill=bar_color(t),
        )
    return img


def main() -> None:
    out_dir = Path(__file__).resolve().parent.parent / "extension" / "icons"
    out_dir.mkdir(parents=True, exist_ok=True)

    base = make_icon(512)  # dessinée en grand puis réduite (meilleur anti-aliasing)
    for size in (16, 32, 48, 128):
        icon = base.resize((size, size), Image.LANCZOS)
        dest = out_dir / f"icon{size}.png"
        icon.save(dest)
        print(f"OK  {dest}")


if __name__ == "__main__":
    main()
