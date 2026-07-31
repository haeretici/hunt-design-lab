#!/usr/bin/env python3
"""Count unique RGBA colors in alpha/ PNGs and bucket by bit-depth capacity.

Buckets (unique colors include fully transparent and semi-transparent RGBA tuples):
  ≤16     → fits 4bpp indexed (16 palette slots)
  17–256  → fits 8bpp indexed (256 palette slots)
  >256    → needs more than 8bpp / truecolor

Usage:
  python3 bin/count_alpha_colors.py --all
  python3 bin/count_alpha_colors.py assets/sprites/rpg_fantasy/creatures/alpha/
  python3 bin/count_alpha_colors.py --all --list
"""

from __future__ import annotations

import sys
from dataclasses import dataclass, field
from pathlib import Path

from PIL import Image

# Repo root = parent of bin/
ROOT = Path(__file__).resolve().parent.parent
SPRITES_ROOT = ROOT / "assets" / "sprites"

BUCKET_4BPP = "≤16 (4bpp)"
BUCKET_8BPP = "17–256 (8bpp)"
BUCKET_TRUE = ">256 (truecolor)"
BUCKET_ORDER = (BUCKET_4BPP, BUCKET_8BPP, BUCKET_TRUE)


@dataclass
class BucketStats:
    counts: dict[str, int] = field(
        default_factory=lambda: {b: 0 for b in BUCKET_ORDER}
    )
    files: dict[str, list[tuple[str, int]]] = field(
        default_factory=lambda: {b: [] for b in BUCKET_ORDER}
    )
    errors: list[str] = field(default_factory=list)
    total: int = 0

    def add(self, name: str, n_colors: int) -> None:
        bucket = classify(n_colors)
        self.counts[bucket] += 1
        self.files[bucket].append((name, n_colors))
        self.total += 1

    def merge(self, other: "BucketStats") -> None:
        for b in BUCKET_ORDER:
            self.counts[b] += other.counts[b]
            self.files[b].extend(other.files[b])
        self.errors.extend(other.errors)
        self.total += other.total


def classify(n_colors: int) -> str:
    if n_colors <= 16:
        return BUCKET_4BPP
    if n_colors <= 256:
        return BUCKET_8BPP
    return BUCKET_TRUE


def unique_rgba_count(path: Path) -> int:
    """Number of distinct RGBA tuples (alpha channel included)."""
    with Image.open(path) as im:
        rgba = im.convert("RGBA")
        # getcolors returns None if unique colors exceed maxcolors
        max_px = rgba.width * rgba.height
        colors = rgba.getcolors(maxcolors=max_px)
        if colors is None:
            # Fallback: materialize unique set (rare for our sprite sizes)
            return len(set(rgba.getdata()))
        return len(colors)


def resolve_alpha_dir(path_arg: str) -> Path:
    """Accept alpha/, creatures/, or a genre folder that contains creatures/alpha."""
    p = Path(path_arg).expanduser().resolve()
    if not p.exists():
        raise FileNotFoundError(f"Path not found: {p}")
    if p.is_file():
        raise NotADirectoryError(f"Expected a directory, got file: {p}")
    if p.name == "alpha":
        return p
    if (p / "alpha").is_dir():
        return p / "alpha"
    if (p / "creatures" / "alpha").is_dir():
        return p / "creatures" / "alpha"
    raise FileNotFoundError(
        f"No alpha/ folder under {p} "
        "(pass …/creatures/alpha, …/creatures, or …/<genre>)"
    )


def list_all_alpha_dirs() -> list[Path]:
    if not SPRITES_ROOT.is_dir():
        return []
    dirs = sorted(
        d for d in SPRITES_ROOT.glob("*/creatures/alpha") if d.is_dir()
    )
    return dirs


def scan_alpha_dir(alpha_dir: Path) -> BucketStats:
    stats = BucketStats()
    pngs = sorted(alpha_dir.glob("*.png"))
    for png in pngs:
        try:
            n = unique_rgba_count(png)
            stats.add(png.name, n)
        except Exception as exc:  # noqa: BLE001 — report per-file, keep scanning
            stats.errors.append(f"{png}: {exc}")
    return stats


def print_stats(label: str, stats: BucketStats, *, list_files: bool) -> None:
    print(f"\n=== {label} ===")
    if stats.total == 0 and not stats.errors:
        print("  (no PNG files)")
        return
    print(f"  Total PNGs: {stats.total}")
    for bucket in BUCKET_ORDER:
        n = stats.counts[bucket]
        pct = (100.0 * n / stats.total) if stats.total else 0.0
        print(f"  {bucket:20s}  {n:5d}  ({pct:5.1f}%)")
    if stats.errors:
        print(f"  Errors: {len(stats.errors)}")
        for err in stats.errors:
            print(f"    ! {err}")
    if list_files:
        for bucket in BUCKET_ORDER:
            files = sorted(stats.files[bucket], key=lambda t: (-t[1], t[0]))
            if not files:
                continue
            print(f"\n  -- {bucket} --")
            for name, n in files:
                print(f"    {n:5d}  {name}")


def _print_usage() -> None:
    print(
        "Usage:\n"
        "  python3 bin/count_alpha_colors.py --all [--list]\n"
        "  python3 bin/count_alpha_colors.py <alpha_or_creatures_path> [--list]\n"
        "\n"
        "Counts unique RGBA colors (including alpha) in alpha/ PNGs:\n"
        "  ≤16      4bpp capacity\n"
        "  17–256   8bpp capacity\n"
        "  >256     truecolor / more than 8bpp\n"
        "\n"
        "Options:\n"
        "  --all    Scan every assets/sprites/*/creatures/alpha/\n"
        "  --list   List each file under its bucket (sorted by color count desc)\n"
    )


def main(argv: list[str]) -> int:
    if not argv or "-h" in argv or "--help" in argv:
        _print_usage()
        return 0 if argv and ("-h" in argv or "--help" in argv) else 1

    list_files = "--list" in argv
    process_all = "--all" in argv
    path_args = [a for a in argv if a not in ("--list", "--all", "-h", "--help")]

    if process_all:
        if path_args:
            print("Error: --all does not take a path argument")
            _print_usage()
            return 1
        alpha_dirs = list_all_alpha_dirs()
        if not alpha_dirs:
            print(f"No alpha/ folders under {SPRITES_ROOT}")
            return 1
        grand = BucketStats()
        for alpha_dir in alpha_dirs:
            # Label: genre name (…/sprites/<genre>/creatures/alpha)
            genre = alpha_dir.parent.parent.name
            stats = scan_alpha_dir(alpha_dir)
            print_stats(f"{genre}  ({alpha_dir})", stats, list_files=list_files)
            grand.merge(stats)
        print_stats("TOTAL (all genres)", grand, list_files=False)
        return 1 if grand.errors else 0

    if len(path_args) != 1:
        _print_usage()
        return 1

    try:
        alpha_dir = resolve_alpha_dir(path_args[0])
    except (FileNotFoundError, NotADirectoryError) as exc:
        print(f"Error: {exc}")
        return 1

    stats = scan_alpha_dir(alpha_dir)
    print_stats(str(alpha_dir), stats, list_files=list_files)
    return 1 if stats.errors else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
