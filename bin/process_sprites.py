#!/usr/bin/env python3
"""Remove solid backgrounds and emit alpha / medium / retro / small / icon variants.

Pipeline per original PNG:
  1. Detect background key (fractions over the full image, not opaque-only):
       - Transparent pixels (a < ALPHA_CUTOFF) count as a plate "color". If they
         cover ≥33% and beat any solid RGB plate, keep existing alpha (no keying).
       - Else if one RGB (exact or clustered near-color) covers ≥33% and is not a
         green plate, treat that plate as a solid chroma key
         (manual BG swap for green creatures).
       - Else green-screen chroma using the actual plate color from corners
         (pure #00FF00 from AGY, or darker noisy greens from Grok / compression).
  2. Global key for bg (including enclosed pockets) → transparent
     (skipped when mode is existing-alpha)
  3. Green path: drop thin wrapping leftover plate (Grok vignette / #00FF00×black
     mix, G often 40–79) via connected components; keep deep or localized
     character greens; despill remaining mixed edges on non-green interiors.
     Solid path: grow a few pixels into near-key fringe.
  4. Write sibling folders (same stem as the original):
       alpha/   — full-size RGBA, background removed only (no resize, no quantize)
       medium/  — 50% of alpha size (e.g. 256→128), still full-color RGBA (NEAREST)
       retro/   — medium quantized to 16 colors; palette index 0 is transparent
       small/   — alpha smooth-scaled to 64×64 RGBA (LANCZOS)
       icon/    — alpha smooth-scaled to 32×32 RGBA (LANCZOS)

  With --opaque-alpha: skip chroma keying; alpha/ is an opaque RGBA copy of the
  original (full A=255). Used for terrain tiles and other full-bleed assets.
  Overlay originals (…/overlays/original) never chroma-key and never flatten:
  alpha/ is a source RGBA copy so icon/small/medium keep PNG holes. --opaque-alpha
  on an overlay folder is ignored (no flatten, no key fallback).
"""

import shutil
import sys
import subprocess
from collections import Counter, deque
from pathlib import Path

from PIL import Image


# Pure lime green used by generate_sprite.js / Antigravity (#00FF00). Fallback key.
DEFAULT_KEY = (0, 255, 0)

# How strongly G must dominate max(R, B) relative to the key's excess (0–1).
# ~0.35 removes screen + fringe greens while keeping dark olive character greens.
CHROMA_RATIO = 0.35

# Minimum green channel for a pixel to be considered screen green via chroma.
MIN_SCREEN_GREEN = 80

# How much G must exceed max(R, B) for a corner/plate sample to count as green-screen.
# Catches pure #00FF00 and Grok's darker plate (~#0D8D2E) without eating browns.
GREEN_PLATE_MIN_EXCESS = 25

# Fix Green (Asset Manager): separate from chroma key — targets dark olive fringe
# spill (G often 50–79) as well as bright plate leftovers. Does not affect reprocess.
MIN_FIX_GREEN = 50
FIX_GREEN_MIN_EXCESS = 25
# Include semi-transparent AA edge spill; below this alpha is left untouched.
FIX_GREEN_ALPHA_CUTOFF = 32

# Dark leftover plate that fails MIN_SCREEN_GREEN (Grok vignette, #00FF00×black).
# Almost no R/B; not olive (olive keeps some red).
DARK_PLATE_MIN_G = 18
DARK_PLATE_MAX_RB = 48
DARK_PLATE_MIN_EXCESS = 12

# #00FF00 g_band miss: mid G, almost no R/B (not a leaf with red in it).
MID_PURE_MAX_G = 130
MID_PURE_MAX_RB = 28
MID_PURE_MIN_EXCESS = 20

# Connected leftover plate: keep if it has an interior core (character green).
# Thin wrapping rings / shallow fragments are halo, not a frog / leaf blob.
PLATE_DEEP_D4 = 8
PLATE_DEEP_MAXD = 6
PLATE_LOCAL_MIN_MAXD = 3
PLATE_LOCAL_MIN_SIZE = 24
PLATE_INTERIOR_GREEN_EXCESS = 18

SOLID_FRINGE_GROW_ITERS = 3

_N4 = ((1, 0), (-1, 0), (0, 1), (0, -1))
_N8 = _N4 + ((1, 1), (1, -1), (-1, 1), (-1, -1))

# Alpha cut-off: below this → transparent (existing cutout or keyed plate).
ALPHA_CUTOFF = 128

# A plate "color" (exact RGB, near-key cluster, or already-transparent) must cover
# at least this fraction of *all* pixels to win background detection. Flat fills
# and ready-made cutouts are typically 30%+.
SOLID_BG_MIN_FRACTION = 0.33

# Output subfolders under …/creatures/ (siblings of original/).
OUTPUT_VARIANTS = ("alpha", "medium", "retro", "small", "icon")

# Fixed-size smooth downscales from alpha/ (RGBA, LANCZOS).
SMALL_SIZE = (64, 64)
ICON_SIZE = (32, 32)


def find_imagemagick() -> str | None:
    """Resolve ImageMagick binary (v7 magick or v6 convert)."""
    for name in ("magick", "convert"):
        found = shutil.which(name)
        if not found:
            continue
        try:
            result = subprocess.run(
                [found, "-version"],
                capture_output=True,
                text=True,
                check=False,
            )
        except OSError:
            continue
        if result.returncode == 0:
            return found
    return None


def sample_key_color(img: Image.Image) -> tuple[int, int, int]:
    """Median RGB of the four corner pixels (robust against single bad pixels)."""
    w, h = img.size
    corners = [
        img.getpixel((0, 0))[:3],
        img.getpixel((w - 1, 0))[:3],
        img.getpixel((0, h - 1))[:3],
        img.getpixel((w - 1, h - 1))[:3],
    ]
    # Component-wise median of four samples.
    key = []
    for i in range(3):
        vals = sorted(c[i] for c in corners)
        key.append((vals[1] + vals[2]) // 2)
    return tuple(key)


def transparent_fraction(img: Image.Image) -> float:
    """Fraction of all pixels already below ALPHA_CUTOFF (existing cutout)."""
    total = 0
    transparent = 0
    for _r, _g, _b, a in img.getdata():
        total += 1
        if a < ALPHA_CUTOFF:
            transparent += 1
    if total == 0:
        return 0.0
    return transparent / total


def dominant_exact_color(img: Image.Image) -> tuple[tuple[int, int, int], float]:
    """Most frequent exact RGB among opaque pixels; fraction is of *all* pixels.

    Transparent pixels do not contribute to the RGB count but remain in the
    denominator so solid plates compete fairly with existing alpha coverage.
    """
    counts: Counter[tuple[int, int, int]] = Counter()
    total = 0
    for r, g, b, a in img.getdata():
        total += 1
        if a < ALPHA_CUTOFF:
            continue
        counts[(r, g, b)] += 1
    if total == 0 or not counts:
        return DEFAULT_KEY, 0.0
    color, n = counts.most_common(1)[0]
    return color, n / total


def near_color_fraction(
    img: Image.Image, key: tuple[int, int, int], tolerance: float
) -> float:
    """Fraction of *all* pixels within tolerance of key (noisy flat plates).

    Already-transparent pixels never match an RGB key; they only dilute the
    fraction so a real solid plate must still cover enough of the canvas.
    """
    tol_sq = tolerance * tolerance
    near = 0
    total = 0
    kr, kg, kb = key
    for r, g, b, a in img.getdata():
        total += 1
        if a < ALPHA_CUTOFF:
            continue
        if (r - kr) ** 2 + (g - kg) ** 2 + (b - kb) ** 2 <= tol_sq:
            near += 1
    if total == 0:
        return 0.0
    return near / total


def color_dist_sq(r: int, g: int, b: int, key: tuple[int, int, int]) -> int:
    kr, kg, kb = key
    return (r - kr) ** 2 + (g - kg) ** 2 + (b - kb) ** 2


def is_near_key(
    r: int, g: int, b: int, key: tuple[int, int, int], tolerance: float
) -> bool:
    return color_dist_sq(r, g, b, key) <= tolerance * tolerance


def is_green_plate(r: int, g: int, b: int) -> bool:
    """True for green-screen plate colors (pure lime or darker Grok-style greens)."""
    if g < MIN_SCREEN_GREEN:
        return False
    excess = g - max(r, b)
    if excess < GREEN_PLATE_MIN_EXCESS:
        return False
    # Hue must still read as green (not teal-cyan or yellow-brown).
    if r > g or b > g:
        return False
    return True


def is_screen_green(
    r: int,
    g: int,
    b: int,
    key: tuple[int, int, int],
    tolerance: float,
    chroma_ratio: float = CHROMA_RATIO,
) -> bool:
    """True when the pixel matches the green-screen key (not character greens)."""
    kr, kg, kb = key

    # Near-exact match to the sampled key (covers compression / Grok plate noise).
    if is_near_key(r, g, b, key, tolerance):
        return True

    # Chroma-excess keying: screen green has high G relative to R and B.
    # Character olive/dark greens fail the ratio / brightness checks.
    key_excess = kg - max(kr, kb)
    if key_excess <= 0:
        # Key is not green-dominant; only near-key matches (handled above).
        return False

    pixel_excess = g - max(r, b)
    if pixel_excess <= 0 or g < MIN_SCREEN_GREEN:
        return False

    ratio = pixel_excess / key_excess
    if ratio < chroma_ratio:
        return False

    # Reject hues that wandered too far from the key green (keeps yellow/cyan).
    # Relative band scales with key brightness so dark plates (~G=140) still match
    # while pure-#00FF00 keys do not eat mid-tone character greens via raw distance.
    g_band = max(100, int(key_excess * 0.55))
    if abs(g - kg) > g_band and g < kg - 40:
        return False

    # Pixel must still look green-ish relative to R/B (same family as the plate).
    if r > g or b > g:
        return False

    return True


def is_dark_plate_leftover(r: int, g: int, b: int) -> bool:
    """Dark leftover of a green screen (fails MIN_SCREEN_GREEN; G often 40–79)."""
    max_rb = max(r, b)
    if not (DARK_PLATE_MIN_G <= g < MIN_SCREEN_GREEN):
        return False
    if r >= g or b >= g:
        return False
    if g - max_rb < DARK_PLATE_MIN_EXCESS:
        return False
    if max_rb > DARK_PLATE_MAX_RB:
        return False
    return True


def is_mid_pure_screen(r: int, g: int, b: int) -> bool:
    """#00FF00 g_band miss: mid G, almost no R/B (not olive / red-tinged leaf)."""
    max_rb = max(r, b)
    if not (MIN_SCREEN_GREEN <= g <= MID_PURE_MAX_G):
        return False
    if r >= g or b >= g:
        return False
    if g - max_rb < MID_PURE_MIN_EXCESS:
        return False
    if max_rb > MID_PURE_MAX_RB:
        return False
    return True


def is_plate_fringe_candidate(r: int, g: int, b: int) -> bool:
    return is_dark_plate_leftover(r, g, b) or is_mid_pure_screen(r, g, b)


def _adjacent_to_bg(x: int, y: int, is_bg: list[list[bool]], w: int, h: int) -> bool:
    for dx, dy in _N8:
        nx, ny = x + dx, y + dy
        if nx < 0 or ny < 0 or nx >= w or ny >= h or is_bg[ny][nx]:
            return True
    return False


def _median_interior_excess(
    x: int, y: int, pixels, is_bg: list[list[bool]], w: int, h: int
) -> int | None:
    """Median G−max(R,B) of non-bg 8-neighbors, or None if the pixel is isolated."""
    xs: list[int] = []
    for dx, dy in _N8:
        nx, ny = x + dx, y + dy
        if nx < 0 or ny < 0 or nx >= w or ny >= h or is_bg[ny][nx]:
            continue
        r, g, b, _a = pixels[nx, ny]
        xs.append(g - max(r, b))
    if not xs:
        return None
    xs.sort()
    return xs[len(xs) // 2]


def _keep_plate_component(
    cells: list[tuple[int, int, int]], cx: float, cy: float, w: int, h: int
) -> bool:
    """True for deep / localized character-green blobs; False for wrapping halo.

    Dist-to-bg ≥4 on the image border is a Grok vignette (away from the plate),
    not a character core — only interior depth counts as deep.
    """
    quads: set[int] = set()
    for x, y, _d in cells:
        quads.add((0 if x < cx else 1) + (0 if y < cy else 2))
    wrapping = len(quads) >= 3
    interior_d4 = sum(
        1
        for x, y, d in cells
        if d >= 4 and 2 <= x < w - 2 and 2 <= y < h - 2
    )
    maxd = max(d for _x, _y, d in cells)
    if interior_d4 >= PLATE_DEEP_D4:
        return True
    if maxd >= PLATE_DEEP_MAXD and not wrapping:
        return True
    if wrapping:
        return False
    return maxd >= PLATE_LOCAL_MIN_MAXD and len(cells) >= PLATE_LOCAL_MIN_SIZE


def remove_green_plate_leftover(
    pixels, is_bg: list[list[bool]], w: int, h: int
) -> None:
    """Key thin wrapping leftover plate; keep deep or localized character greens.

    Pass-1 chroma leaves Grok vignettes and #00FF00×black mix (G often 40–79).
    Those leftovers form thin rings around non-green sprites. The same color also
    appears as dark green clothing / thin leaves — those have interior depth or
    sit in one or two quadrants around the character core, so they stay.
    """
    cand = [[False] * w for _ in range(h)]
    for y in range(h):
        for x in range(w):
            if is_bg[y][x]:
                continue
            r, g, b, _a = pixels[x, y]
            if is_plate_fringe_candidate(r, g, b):
                cand[y][x] = True

    dist: list[list[int | None]] = [[None] * w for _ in range(h)]
    q: deque[tuple[int, int]] = deque()
    for y in range(h):
        for x in range(w):
            if is_bg[y][x]:
                dist[y][x] = 0
                q.append((x, y))
    while q:
        x, y = q.popleft()
        d0 = dist[y][x] or 0
        for dx, dy in _N4:
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h and dist[ny][nx] is None:
                dist[ny][nx] = d0 + 1
                q.append((nx, ny))

    sx = sy = ncore = 0
    for y in range(h):
        for x in range(w):
            if not is_bg[y][x] and not cand[y][x]:
                sx += x
                sy += y
                ncore += 1
    cx, cy = (sx / ncore, sy / ncore) if ncore else (w / 2.0, h / 2.0)

    seen = [[False] * w for _ in range(h)]
    for y in range(h):
        for x in range(w):
            if not cand[y][x] or seen[y][x]:
                continue
            cells: list[tuple[int, int, int]] = []
            dq: deque[tuple[int, int]] = deque([(x, y)])
            seen[y][x] = True
            while dq:
                px, py = dq.popleft()
                cells.append((px, py, dist[py][px] if dist[py][px] is not None else 99))
                for dx, dy in _N8:
                    nx, ny = px + dx, py + dy
                    if 0 <= nx < w and 0 <= ny < h and cand[ny][nx] and not seen[ny][nx]:
                        seen[ny][nx] = True
                        dq.append((nx, ny))
            if _keep_plate_component(cells, cx, cy, w, h):
                continue
            for px, py, _d in cells:
                is_bg[py][px] = True
                pixels[px, py] = (0, 0, 0, 0)
                cand[py][px] = False

    # Mixed AA fringe on non-green interiors (not a kept green feature).
    for y in range(h):
        for x in range(w):
            if is_bg[y][x] or cand[y][x]:
                continue
            if not _adjacent_to_bg(x, y, is_bg, w, h):
                continue
            r, g, b, a = pixels[x, y]
            max_rb = max(r, b)
            excess = g - max_rb
            if excess <= 12 or g <= 25:
                continue
            med = _median_interior_excess(x, y, pixels, is_bg, w, h)
            if med is None:
                pixels[x, y] = (0, 0, 0, 0)
                is_bg[y][x] = True
                continue
            if med >= PLATE_INTERIOR_GREEN_EXCESS:
                continue
            if max_rb < 48:
                pixels[x, y] = (0, 0, 0, 0)
                is_bg[y][x] = True
            else:
                ng = max_rb
                if max(r, ng, b) < 35:
                    pixels[x, y] = (0, 0, 0, 0)
                    is_bg[y][x] = True
                else:
                    pixels[x, y] = (r, ng, b, a)


def resolve_background_key(
    img: Image.Image,
    tolerance: float = 40.0,
) -> tuple[str, tuple[int, int, int], float]:
    """Choose keying mode and RGB key.

    Returns (mode, key, plate_fraction) where mode is "alpha", "solid", or "green".

    alpha  — already-transparent pixels cover ≥33% of the image and beat any
             solid RGB plate; keep existing alpha (no chroma keying).
    solid  — one RGB dominates the plate (exact or clustered) and is not green
             (e.g. user painted #FF00FF so green character tones survive).
    green  — chroma path for #00FF00 / darker green-screen plates (Grok, noise).
    """
    alpha_frac = transparent_fraction(img)
    dominant, exact_frac = dominant_exact_color(img)
    corner = sample_key_color(img)
    # Noisy generators (Grok) rarely hit one exact RGB; cluster near dominant/corner.
    near_dom = near_color_fraction(img, dominant, tolerance)
    near_corner = near_color_fraction(img, corner, tolerance)
    plate_frac = max(exact_frac, near_dom, near_corner)

    # Existing cutout: transparency is a plate color competing for the 33% bar.
    if alpha_frac >= SOLID_BG_MIN_FRACTION and alpha_frac >= plate_frac:
        return "alpha", (0, 0, 0), alpha_frac

    if plate_frac >= SOLID_BG_MIN_FRACTION:
        # Prefer the sample that actually covers the plate.
        if near_corner >= near_dom and is_green_plate(*corner):
            return "green", corner, plate_frac
        if is_green_plate(*dominant):
            return "green", dominant, plate_frac
        if is_green_plate(*corner):
            return "green", corner, plate_frac
        # Non-green solid plate (manual key for green-toned creatures).
        plate_key = dominant if near_dom >= near_corner else corner
        return "solid", plate_key, plate_frac

    # Sparse / non-flat: still key green corners when they look like a screen plate.
    if is_green_plate(*corner):
        return "green", corner, plate_frac

    # Classic pure lime that failed is_green_plate edge cases → DEFAULT chroma.
    if is_screen_green(
        *corner, key=DEFAULT_KEY, tolerance=tolerance, chroma_ratio=0.5
    ):
        return "green", corner, plate_frac

    return "green", DEFAULT_KEY, plate_frac


def _rgb_hex(key: tuple[int, int, int]) -> str:
    return f"#{key[0]:02X}{key[1]:02X}{key[2]:02X}"


def remove_background(
    img: Image.Image,
    tolerance: float = 40.0,
    chroma_ratio: float = CHROMA_RATIO,
) -> tuple[Image.Image, str]:
    """Key out background pixels (enclosed pockets included).

    Auto-detects existing alpha cutouts, solid non-green plates, or green-screen
    chroma. Returns (image, mode_label) for logging.
    """
    img = img.convert("RGBA")
    w, h = img.size
    pixels = img.load()

    mode, key, solid_fraction = resolve_background_key(img, tolerance=tolerance)
    is_bg = [[False] * w for _ in range(h)]

    if mode == "alpha":
        # Preserve the source cutout; only normalize soft/sub-cutoff alpha to empty.
        for y in range(h):
            for x in range(w):
                r, g, b, a = pixels[x, y]
                if a < ALPHA_CUTOFF:
                    pixels[x, y] = (0, 0, 0, 0)
        label = f"existing alpha ({solid_fraction:.0%} transparent)"
        return img, label

    if mode == "solid":
        # Pass 1: near-exact match to the dominant plate color (global).
        for y in range(h):
            for x in range(w):
                r, g, b, a = pixels[x, y]
                if a < ALPHA_CUTOFF or is_near_key(r, g, b, key, tolerance):
                    is_bg[y][x] = True
                    pixels[x, y] = (0, 0, 0, 0)

        # Pass 2: grow into soft fringe near the key, adjacent to bg.
        fringe_tol = tolerance * 1.75
        for _ in range(SOLID_FRINGE_GROW_ITERS):
            grow = []
            for y in range(h):
                for x in range(w):
                    if is_bg[y][x]:
                        continue
                    r, g, b, a = pixels[x, y]
                    if not is_near_key(r, g, b, key, fringe_tol):
                        continue
                    if _adjacent_to_bg(x, y, is_bg, w, h):
                        grow.append((x, y))
            if not grow:
                break
            for x, y in grow:
                is_bg[y][x] = True
                pixels[x, y] = (0, 0, 0, 0)

        label = (
            f"solid key {_rgb_hex(key)} "
            f"({solid_fraction:.0%} exact plate)"
        )
        return img, label

    # --- green-screen chroma path ---
    # Pass 1: global chroma key — border bg and enclosed green pockets.
    for y in range(h):
        for x in range(w):
            r, g, b, a = pixels[x, y]
            if a < ALPHA_CUTOFF or is_screen_green(
                r, g, b, key, tolerance, chroma_ratio
            ):
                is_bg[y][x] = True
                pixels[x, y] = (0, 0, 0, 0)

    # Pass 2–3: leftover dark plate halo + mixed-edge despill.
    # 1px g>100 grow used to nibble green character silhouettes; CC replace it.
    remove_green_plate_leftover(pixels, is_bg, w, h)

    label = f"green-screen chroma {_rgb_hex(key)}"
    return img, label


def remove_green_screen(
    img: Image.Image,
    tolerance: float = 40.0,
    chroma_ratio: float = CHROMA_RATIO,
) -> Image.Image:
    """Backward-compatible wrapper; prefer remove_background()."""
    out, _ = remove_background(img, tolerance=tolerance, chroma_ratio=chroma_ratio)
    return out


def is_accentuated_green(r: int, g: int, b: int) -> bool:
    """True when G dominates low R/B enough to count as green cast / fringe spill.

    Uses Fix Green thresholds (MIN_FIX_GREEN / FIX_GREEN_MIN_EXCESS), not the
    stricter chroma-key MIN_SCREEN_GREEN — dark olive halos often sit at G 50–79.
    """
    if g < MIN_FIX_GREEN:
        return False
    max_rb = max(r, b)
    if g - max_rb < FIX_GREEN_MIN_EXCESS:
        return False
    if r >= g or b >= g:
        return False
    return True


def fix_green_cast(img: Image.Image) -> tuple[Image.Image, int]:
    """Neutralize accentuated green pixels by setting R and B equal to G.

    Targets G-dominant, low-R/B pixels (screen leftover + dark fringe spill).
    Leaves near-transparent pixels and non-green-dominant colors untouched.
    Returns (image, fixed_count).
    """
    img = img.convert("RGBA")
    pixels = img.load()
    w, h = img.size
    fixed = 0
    for y in range(h):
        for x in range(w):
            r, g, b, a = pixels[x, y]
            if a < FIX_GREEN_ALPHA_CUTOFF:
                continue
            if not is_accentuated_green(r, g, b):
                continue
            pixels[x, y] = (g, g, g, a)
            fixed += 1
    return img, fixed


def fix_green_file(file_path: Path) -> int:
    """In-place fix_green_cast on a single PNG. Returns pixels changed."""
    file_path = Path(file_path)
    if not file_path.is_file():
        raise FileNotFoundError(f"Not a file: {file_path}")
    with Image.open(file_path) as src:
        out, fixed = fix_green_cast(src)
        out.save(file_path)
    return fixed


def quantize_with_transparency(img: Image.Image, colors: int = 16) -> Image.Image:
    """Quantize opaque pixels to (colors-1) entries; index 0 is transparent."""
    img = img.convert("RGBA")
    w, h = img.size
    data = list(img.getdata())

    opaque_rgb = [(r, g, b) for r, g, b, a in data if a >= ALPHA_CUTOFF]
    if not opaque_rgb:
        out = Image.new("P", (w, h), 0)
        out.putpalette([0] * 768)
        return out

    n_opaque_colors = max(1, min(colors - 1, len(set(opaque_rgb))))
    # Pack opaque pixels into a temporary strip so quantize ignores transparency.
    strip = Image.new("RGB", (len(opaque_rgb), 1))
    strip.putdata(opaque_rgb)
    quantized = strip.quantize(colors=n_opaque_colors, method=Image.Quantize.MAXCOVERAGE)

    q_palette = quantized.getpalette() or []
    # Palette layout: index 0 = transparent placeholder, 1.. = real colors.
    new_palette = [0, 0, 0]
    new_palette.extend(q_palette[: n_opaque_colors * 3])
    new_palette.extend([0] * (768 - len(new_palette)))

    q_data = list(quantized.getdata())
    out_indices = []
    oi = 0
    for r, g, b, a in data:
        if a < ALPHA_CUTOFF:
            out_indices.append(0)
        else:
            out_indices.append(q_data[oi] + 1)
            oi += 1

    out = Image.new("P", (w, h))
    out.putpalette(new_palette)
    out.putdata(out_indices)
    return out


def half_size(size: tuple[int, int]) -> tuple[int, int]:
    """50% dimensions, at least 1×1."""
    w, h = size
    return (max(1, w // 2), max(1, h // 2))


def smooth_scale(img: Image.Image, size: tuple[int, int]) -> Image.Image:
    """High-quality resize to a fixed size (LANCZOS)."""
    return img.resize(size, Image.Resampling.LANCZOS)


# Repo root: bin/process_sprites.py → parent.parent
ROOT = Path(__file__).resolve().parent.parent
SPRITES_ROOT = ROOT / "assets" / "sprites"


def discover_original_dirs() -> list[Path]:
    """Find assets/sprites/<genre>/<kind>/original/ for every genre×kind on disk.

    Known kind folders: creatures, equipment, tiles, overlays, objects, ui
    (any sibling of a genre that has an original/ subdir is accepted).
    """
    if not SPRITES_ROOT.is_dir():
        return []
    dirs: list[Path] = []
    for genre_dir in sorted(SPRITES_ROOT.iterdir()):
        if not genre_dir.is_dir():
            continue
        # Prefer nested kind folders (creatures, equipment, …)
        for kind_dir in sorted(genre_dir.iterdir()):
            if not kind_dir.is_dir():
                continue
            original = kind_dir / "original"
            if original.is_dir():
                dirs.append(original)
    return dirs


def _variant_dirs(kind_root: Path) -> dict[str, Path]:
    """Map variant name → …/<kind>/<variant>/ directory."""
    return {name: kind_root / name for name in OUTPUT_VARIANTS}


def is_overlays_original(directory_path: str | Path) -> bool:
    """True when processing assets/sprites/<genre>/overlays/original."""
    p = Path(directory_path)
    return p.name == "original" and p.parent.name == "overlays"


def opaque_alpha_copy(img: Image.Image) -> tuple[Image.Image, str]:
    """Full-size RGBA copy with every pixel forced opaque (A=255). No keying."""
    img = img.convert("RGBA")
    w, h = img.size
    pixels = img.load()
    for y in range(h):
        for x in range(w):
            r, g, b, _a = pixels[x, y]
            pixels[x, y] = (r, g, b, 255)
    return img, "opaque-copy"


def preserve_source_alpha(img: Image.Image) -> tuple[Image.Image, str]:
    """Full-size RGBA copy; keep source alpha. No chroma, no flatten."""
    return img.convert("RGBA"), "source-alpha"


def process_images(
    directory_path: str | Path,
    tolerance: float = 40.0,
    force: bool = False,
    chroma_ratio: float = CHROMA_RATIO,
    only_stems: set[str] | None = None,
    opaque_alpha: bool = False,
) -> tuple[int, int, int]:
    """Process all PNGs in directory_path → sibling alpha/medium/retro/small/icon.

    only_stems: if set, only process basenames (no .png) in this set (case-sensitive stem).
    opaque_alpha: if True, alpha is an opaque RGBA copy (no chroma key).
    Overlay folders ignore opaque_alpha and skip chroma (keep source alpha).
    Returns (ok, skipped, errors).
    """
    base_path = Path(directory_path)
    overlay_src = is_overlays_original(base_path)
    if opaque_alpha and overlay_src:
        print(
            "[WARN] overlays refuse --opaque-alpha; "
            "keeping source alpha (no chroma, no flatten) so icon/small/medium stay transparent."
        )
        opaque_alpha = False
    ok = skipped = errors = 0

    if not base_path.is_dir():
        print(f"Error: The directory '{directory_path}' does not exist or is invalid.")
        return (0, 0, 1)

    # Output folders one level up from the source directory (…/original → …/<variant>).
    kind_root = base_path.parent
    out_dirs = _variant_dirs(kind_root)
    for d in out_dirs.values():
        d.mkdir(exist_ok=True)

    png_files = sorted(base_path.glob("*.png"))
    if only_stems:
        want = {s for s in only_stems}
        png_files = [p for p in png_files if p.stem in want]
    if not png_files:
        print(f"No .png files found in '{directory_path}'.")
        return (0, 0, 0)

    print(f"Found {len(png_files)} .png files. Starting processing...")
    magick_bin = find_imagemagick()

    for file_path in png_files:
        paths = {name: out_dirs[name] / file_path.name for name in OUTPUT_VARIANTS}
        all_exist = all(p.exists() for p in paths.values())

        if all_exist and not force:
            print(
                f"[SKIPPED] {file_path.name} already has "
                "alpha/medium/retro/small/icon outputs."
            )
            skipped += 1
            continue

        try:
            with Image.open(file_path) as src:
                img = src.copy()

            if img.size not in ((256, 256), (1024, 1024)):
                print(
                    f"[WARNING] {file_path.name} is {img.size[0]}x{img.size[1]}, "
                    "expected 256x256 (or 1024x1024). Processing at current size."
                )

            # alpha: overlay source copy, opaque copy, or background removal.
            if overlay_src:
                alpha_img, key_label = preserve_source_alpha(img)
            elif opaque_alpha:
                alpha_img, key_label = opaque_alpha_copy(img)
            else:
                alpha_img, key_label = remove_background(
                    img, tolerance=tolerance, chroma_ratio=chroma_ratio
                )
            alpha_img.save(paths["alpha"])

            # medium: 50% of alpha (e.g. 256→128), still full-color RGBA.
            med_size = half_size(alpha_img.size)
            medium_img = alpha_img.resize(med_size, Image.Resampling.NEAREST)
            medium_img.save(paths["medium"])

            # small / icon: fixed-size smooth downscales from alpha.
            small_img = smooth_scale(alpha_img, SMALL_SIZE)
            small_img.save(paths["small"])
            icon_img = smooth_scale(alpha_img, ICON_SIZE)
            icon_img.save(paths["icon"])

            # retro: small + 16-color palette (index 0 transparent).
            retro_img = quantize_with_transparency(small_img, colors=16)
            retro_img.save(paths["retro"], transparency=0)
            
            # apply imagemagick trim (v7 magick or v6 convert)
            if not magick_bin:
                raise FileNotFoundError(
                    "ImageMagick not found (install magick or convert)"
                )
            subprocess.run(
                [magick_bin, str(paths["retro"]), "-trim", "+repage", str(paths["retro"])],
                check=True,
            )

            aw, ah = alpha_img.size
            mw, mh = medium_img.size
            sw, sh = SMALL_SIZE
            iw, ih = ICON_SIZE
            print(
                f"[OK] {file_path.name} -> {key_label}; "
                f"alpha {aw}x{ah} RGBA, medium {mw}x{mh} RGBA, "
                f"retro trimmed 16-color, small {sw}x{sh} RGBA, "
                f"icon {iw}x{ih} RGBA."
            )
            ok += 1
        except Exception as e:
            print(f"[ERROR] Failed to process {file_path.name}: {e}")
            errors += 1

    return (ok, skipped, errors)


def process_all_genres(
    tolerance: float = 40.0,
    force: bool = False,
    chroma_ratio: float = CHROMA_RATIO,
    opaque_alpha: bool = False,
) -> int:
    """Run process_images on every genre original/ folder. Returns error count."""
    dirs = discover_original_dirs()
    if not dirs:
        print(f"No genre original/ folders under {SPRITES_ROOT}")
        return 1

    total_ok = total_skipped = total_errors = 0
    for original_dir in dirs:
        # assets/sprites/<genre>/<kind>/original → genre/kind
        kind = original_dir.parent.name
        genre = original_dir.parent.parent.name
        print(f"\n=== {genre}/{kind} ({original_dir}) ===")
        ok, skipped, errors = process_images(
            original_dir,
            tolerance=tolerance,
            force=force,
            chroma_ratio=chroma_ratio,
            opaque_alpha=opaque_alpha,
        )
        total_ok += ok
        total_skipped += skipped
        total_errors += errors

    print(
        f"\nAll genres: ok={total_ok} skipped={total_skipped} errors={total_errors} "
        f"({len(dirs)} original folders)"
    )
    return total_errors


def _print_usage() -> None:
    print(
        "Usage:\n"
        "  python3 process_sprites.py <folder_path> [tolerance] [--force] [--only STEM] [--opaque-alpha]\n"
        "  python3 process_sprites.py --all [tolerance] [--force] [--opaque-alpha]\n"
        "  python3 process_sprites.py --fix-green-file <png_path>\n"
        "\n"
        "  folder_path     Path to a genre/<kind>/original/ directory\n"
        "  --all           Process every assets/sprites/*/*/original/\n"
        "  tolerance       RGB distance for near-key match (default: 40)\n"
        "  --force         Overwrite existing alpha/medium/retro/small/icon outputs\n"
        "  --only STEM     Process only this file stem (repeatable; not with --all)\n"
        "  --opaque-alpha  alpha/ is opaque RGBA copy (no chroma key) for this run\n"
        "                  (ignored on overlays/original: source alpha is kept)\n"
        "  --fix-green-file  In-place: G-dominant spill (G>=50) → R=B=G (no reprocess)\n"
        "\n"
        "Outputs (siblings of original/):\n"
        "  alpha/   full-size RGBA (keyed, or opaque copy with --opaque-alpha)\n"
        "  medium/  50% size RGBA (e.g. 128x128 from 256 alpha, NEAREST)\n"
        "  retro/   medium quantized to 16 colors + transparent index 0\n"
        "  small/   alpha smooth-scaled to 64x64 RGBA (LANCZOS)\n"
        "  icon/    alpha smooth-scaled to 32x32 RGBA (LANCZOS)"
    )


if __name__ == "__main__":
    if len(sys.argv) < 2:
        _print_usage()
        sys.exit(1)

    args = sys.argv[1:]
    force = "--force" in args
    process_all = "--all" in args
    opaque_alpha = "--opaque-alpha" in args
    only_stems: set[str] = set()
    fix_green_path: str | None = None
    cleaned: list[str] = []
    i = 0
    while i < len(args):
        a = args[i]
        if a in ("--force", "--all", "--opaque-alpha"):
            i += 1
            continue
        if a == "--fix-green-file":
            if i + 1 >= len(args):
                print("Error: --fix-green-file requires a PNG path")
                _print_usage()
                sys.exit(1)
            fix_green_path = args[i + 1]
            i += 2
            continue
        if a.startswith("--fix-green-file="):
            fix_green_path = a.split("=", 1)[1]
            i += 1
            continue
        if a == "--only":
            if i + 1 >= len(args):
                print("Error: --only requires a STEM argument")
                _print_usage()
                sys.exit(1)
            only_stems.add(args[i + 1])
            i += 2
            continue
        if a.startswith("--only="):
            only_stems.add(a.split("=", 1)[1])
            i += 1
            continue
        cleaned.append(a)
        i += 1
    args = cleaned

    if fix_green_path is not None:
        try:
            n = fix_green_file(Path(fix_green_path))
            print(f"[OK] fix-green {fix_green_path}: {n} pixel(s) neutralized")
            sys.exit(0)
        except Exception as e:
            print(f"[ERROR] fix-green failed: {e}")
            sys.exit(1)

    custom_tolerance = 40.0
    # Remaining args: optional path and/or tolerance number.
    path_arg: str | None = None
    for a in args:
        try:
            custom_tolerance = float(a)
        except ValueError:
            if path_arg is None:
                path_arg = a
            else:
                print(f"Unexpected argument: {a}")
                _print_usage()
                sys.exit(1)

    if process_all:
        if only_stems:
            print("Error: --only cannot be combined with --all")
            sys.exit(1)
        err_count = process_all_genres(
            tolerance=custom_tolerance,
            force=force,
            opaque_alpha=opaque_alpha,
        )
        sys.exit(1 if err_count else 0)

    if not path_arg:
        _print_usage()
        sys.exit(1)

    ok, skipped, errors = process_images(
        path_arg,
        tolerance=custom_tolerance,
        force=force,
        only_stems=only_stems or None,
        opaque_alpha=opaque_alpha,
    )
    sys.exit(1 if errors else 0)
