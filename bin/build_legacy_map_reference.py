#!/usr/bin/env python3
"""
Build open-source reference assets for the PNG map / navmesh / fixed-spawn path.

Replaces bulk commercial-port geography under assets/legacy/ with a small,
intelligible synthetic layout while keeping the floor-07 canvas size and the
friction encoding contract (yellow = blocked, gray R=G=B = walk friction).

Idempotent. Run from repo root:

    python3 bin/build_legacy_map_reference.py

Does not touch creature GIFs, combat presets, or generator content.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
MAP_DIR = ROOT / "assets" / "legacy" / "map"
NAVMESH_DIR = MAP_DIR / "navmesh"
SPAWNS_DIR = ROOT / "assets" / "legacy" / "spawns"
BY_FLOOR_DIR = SPAWNS_DIR / "by_floor"

# Canvas size is part of the load contract (tests assert cols/rows).
COLS = 2560
ROWS = 2048
Z_MAIN = 7

YELLOW = (255, 255, 0, 255)


def gray(f: int) -> tuple[int, int, int, int]:
    f = max(0, min(254, int(f)))
    return (f, f, f, 255)


def fill_rect(px, x0, y0, x1, y1, color) -> None:
    """Inclusive rectangle fill, clipped to canvas."""
    x0 = max(0, min(COLS - 1, x0))
    x1 = max(0, min(COLS - 1, x1))
    y0 = max(0, min(ROWS - 1, y0))
    y1 = max(0, min(ROWS - 1, y1))
    if x1 < x0:
        x0, x1 = x1, x0
    if y1 < y0:
        y0, y1 = y1, y0
    for y in range(y0, y1 + 1):
        row = y * COLS
        for x in range(x0, x1 + 1):
            px[row + x] = color


def stamp_patch(px, cx, cy, friction, radius=1) -> None:
    fill_rect(px, cx - radius, cy - radius, cx + radius, cy + radius, gray(friction))


def build_floor_png() -> dict:
    """
    Synthetic floor-07 layout (map-local tile coords):

    - Full canvas yellow (blocked).
    - Friction legend patches (documented sample cells).
    - Reference corridor around DEFAULT_FLOOR07_WAYPOINTS (y≈96, x 250–320).
    - Connector path corridor → dens.
    - Dens room (spawn bbox x 400–540, y 800–900).
    """
    px = [YELLOW] * (COLS * ROWS)

    # --- Friction legend (intelligible samples for tilemap tests) ---
    # Single documented cells (radius 0) so samples are exact.
    legend = {
        (100, 20): 100,
        (120, 20): 110,
        (140, 20): 120,
        (160, 20): 140,
        (180, 20): 150,
        (200, 20): 160,
        (220, 20): 200,
        # Extra mid-map samples (still small patches, not world geometry)
        (329, 28): 100,
        (256, 64): 160,
    }
    for (x, y), f in legend.items():
        stamp_patch(px, x, y, f, radius=0)

    # --- Reference corridor (party ghost-walk + floor07_corridor navmesh) ---
    # Continuous open hall, wide enough for two party members side-by-side.
    # Entry (west) stickier, main mid-gray, east stub slightly different.
    fill_rect(px, 250, 90, 264, 102, gray(160))
    fill_rect(px, 265, 90, 304, 102, gray(100))
    fill_rect(px, 305, 90, 320, 102, gray(110))

    # --- Connector: corridor SE → dens room ---
    # Vertical spine at x=320 from corridor south edge to dens latitude.
    fill_rect(px, 316, 103, 324, 850, gray(100))
    # Horizontal arm into dens west wall
    fill_rect(px, 325, 842, 399, 850, gray(100))

    # --- Dens room (legacy_floor bbox tests / cave_rat samples) ---
    fill_rect(px, 400, 800, 540, 900, gray(150))
    # Soft center path through dens (default walk friction)
    fill_rect(px, 420, 830, 520, 870, gray(100))

    # Far-corner sanity patch (proves large canvas, not only local geometry)
    fill_rect(px, 2000, 5, 2010, 15, gray(150))
    stamp_patch(px, 2006, 9, 150, radius=0)
    stamp_patch(px, 1754, 12, 200, radius=0)
    stamp_patch(px, 1876, 14, 120, radius=0)
    stamp_patch(px, 1734, 18, 160, radius=0)
    stamp_patch(px, 2039, 27, 110, radius=0)
    stamp_patch(px, 1728, 32, 140, radius=0)

    im = Image.new("RGBA", (COLS, ROWS))
    im.putdata(px)
    out = MAP_DIR / "floor-07-path.png"
    im.save(out, format="PNG", optimize=True)

    # Walkability sanity for critical waypoints
    checks = {}
    for x in (260, 271, 282, 293, 304):
        checks[f"{x},96"] = im.getpixel((x, 96))
    for key, expected in (
        ((0, 0), YELLOW),
        ((2006, 9), gray(150)),
        ((329, 28), gray(100)),
        ((256, 64), gray(160)),
        ((464, 845), gray(100)),  # dens center path
    ):
        got = im.getpixel(key)
        assert got == expected, f"pixel {key}: expected {expected}, got {got}"

    return {
        "path": str(out.relative_to(ROOT)),
        "cols": COLS,
        "rows": ROWS,
        "waypoint_samples": checks,
        "legend": {f"{x},{y}": f for (x, y), f in legend.items()},
    }


def build_navmesh() -> dict:
    """Small multi-floor reference graph (format-compatible with merged.json)."""
    # Corridor spine (matches floor07_corridor + DEFAULT_FLOOR07_WAYPOINTS)
    corridor = [
        {"x": 260, "y": 96, "z": 7},
        {"x": 271, "y": 96, "z": 7},
        {"x": 282, "y": 96, "z": 7},
        {"x": 293, "y": 96, "z": 7},
        {"x": 304, "y": 96, "z": 7},
        {"x": 320, "y": 96, "z": 7, "properties": {"icon": "flag", "description": "corridor east exit"}},
    ]
    # Connector + dens
    dens = [
        {"x": 320, "y": 400, "z": 7},
        {"x": 320, "y": 700, "z": 7},
        {"x": 320, "y": 845, "z": 7},
        {"x": 420, "y": 845, "z": 7, "properties": {"icon": "sword", "description": "dens west"}},
        {"x": 470, "y": 845, "z": 7, "properties": {"icon": "skull", "description": "dens center"}},
        {"x": 520, "y": 845, "z": 7},
    ]
    # Stair pads: dens center links to floor 6 / 8 samples
    stairs = [
        {
            "x": 470,
            "y": 860,
            "z": 7,
            "properties": {"icon": "down", "description": "sample stair down"},
        },
        {
            "x": 470,
            "y": 860,
            "z": 6,
            "properties": {"icon": "up", "description": "floor 06 pad"},
        },
        {"x": 480, "y": 860, "z": 6},
        {
            "x": 282,
            "y": 102,
            "z": 7,
            "properties": {"icon": "up", "description": "sample stair up"},
        },
        {
            "x": 282,
            "y": 102,
            "z": 8,
            "properties": {"icon": "down", "description": "floor 08 pad"},
        },
        {"x": 290, "y": 102, "z": 8},
    ]

    points = corridor + dens + stairs
    # Chain corridor, dens path, stair edges
    connections = []
    for i in range(len(corridor) - 1):
        connections.append([i, i + 1])
    base = len(corridor)
    # 304 → 320 already in corridor; dens chain starts at first dens node
    connections.append([len(corridor) - 1, base])  # 320,96 → 320,400
    for i in range(len(dens) - 1):
        connections.append([base + i, base + i + 1])
    # dens center (base+4) → stair down on z7
    dens_center = base + 4
    stair_down_z7 = base + len(dens)  # first stairs entry
    connections.append([dens_center, stair_down_z7])
    connections.append([stair_down_z7, stair_down_z7 + 1])  # z7 ↔ z6
    connections.append([stair_down_z7 + 1, stair_down_z7 + 2])  # z6 pad → neighbor
    # corridor mid → stair up
    corridor_mid = 2  # 282,96
    stair_up_z7 = stair_down_z7 + 3
    connections.append([corridor_mid, stair_up_z7])
    connections.append([stair_up_z7, stair_up_z7 + 1])  # z7 ↔ z8
    connections.append([stair_up_z7 + 1, stair_up_z7 + 2])

    merged = {
        "id": "legacy_merged",
        "label": "Open-source reference navmesh (multi-floor sample)",
        "source": "bin/build_legacy_map_reference.py",
        "notes": (
            "Reduced hand graph for PNG-map / long-route demos. "
            "Not a full-world port. Edges stay inside local A* budget where possible."
        ),
        "points": points,
        "connections": connections,
        "inferredStairEdges": [
            [stair_down_z7, stair_down_z7 + 1],
            [stair_up_z7, stair_up_z7 + 1],
        ],
    }

    corridor_mesh = {
        "id": "floor07_corridor",
        "label": "Floor 07 reference corridor (hand graph)",
        "floor": 7,
        "notes": (
            "Coarse nodes along the synthetic reference corridor (y≈96). "
            "Edges must stay inside local A* maxDistance (~100)."
        ),
        "points": [
            {"x": 260, "y": 96, "z": 7},
            {"x": 271, "y": 96, "z": 7},
            {"x": 282, "y": 96, "z": 7},
            {"x": 293, "y": 96, "z": 7},
            {"x": 304, "y": 96, "z": 7},
        ],
        "connections": [[0, 1], [1, 2], [2, 3], [3, 4]],
    }

    analysis = analyze_navmesh(merged)
    # Drop full annotated list from on-disk summary (keep compact)
    analysis.pop("annotated", None)

    write_json(NAVMESH_DIR / "merged.json", merged)
    write_json(NAVMESH_DIR / "floor07_corridor.json", corridor_mesh)
    write_json(NAVMESH_DIR / "analysis.json", analysis)

    return {
        "points": len(points),
        "connections": len(connections),
        "crossFloorEdges": analysis["crossFloorEdges"],
    }


def analyze_navmesh(mesh: dict) -> dict:
    """Mirror kernel analyzeNavmesh shape (subset used by tests/docs)."""
    points = mesh.get("points") or []
    connections = mesh.get("connections") or []
    icons: dict[str, int] = {}
    annotated = []
    by_floor: dict[str, int] = {}

    for i, p in enumerate(points):
        if not p:
            continue
        z = str(p.get("z", 0)).zfill(2)
        by_floor[z] = by_floor.get(z, 0) + 1
        prop = p.get("properties") or {}
        if prop.get("icon"):
            ic = str(prop["icon"])
            icons[ic] = icons.get(ic, 0) + 1
            annotated.append(
                {
                    "index": i,
                    "x": p["x"],
                    "y": p["y"],
                    "z": z,
                    "icon": ic,
                    "description": prop.get("description") or "",
                }
            )

    icon_legend = {
        "up": "Stairs / hole up (floor change up)",
        "down": "Stairs / hole down (floor change down)",
        "flag": "Landmark / POI",
        "sword": "Combat / hunting area",
        "skull": "Danger / boss area",
    }

    cross_floor_edges = 0
    cross_floor_samples = []
    for pair in connections:
        if not pair or len(pair) < 2:
            continue
        a = points[pair[0]]
        b = points[pair[1]]
        if not a or not b:
            continue
        za = str(a.get("z", 0)).zfill(2)
        zb = str(b.get("z", 0)).zfill(2)
        if za != zb:
            cross_floor_edges += 1
            if len(cross_floor_samples) < 40:
                cross_floor_samples.append(
                    {
                        "a": {
                            "i": pair[0],
                            "x": a["x"],
                            "y": a["y"],
                            "z": za,
                            "icon": (a.get("properties") or {}).get("icon"),
                        },
                        "b": {
                            "i": pair[1],
                            "x": b["x"],
                            "y": b["y"],
                            "z": zb,
                            "icon": (b.get("properties") or {}).get("icon"),
                        },
                    }
                )

    return {
        "version": 1,
        "pointCount": len(points),
        "connectionCount": len(connections),
        "annotatedCount": len(annotated),
        "crossFloorEdges": cross_floor_edges,
        "icons": icons,
        "iconLegend": icon_legend,
        "pointsByFloor": by_floor,
        "crossFloorSamples": cross_floor_samples,
        "annotated": annotated,
        "notes": "Synthetic reference analysis (bin/build_legacy_map_reference.py)",
    }


def build_spawns() -> dict:
    """Small fixed-spawn tables; floor 07 dens + a few demo rows on other floors."""
    # Dens bbox used by docs + tests/legacy_port.js
    dens_rats = [
        (464, 816),
        (469, 818),
        (466, 820),
        (450, 845),
        (470, 845),
        (490, 845),
        (455, 860),
        (475, 860),
        (495, 860),
        (430, 840),
        (510, 850),
        (480, 830),
        (440, 870),
        (500, 870),
    ]
    floor07 = []
    for x, y in dens_rats:
        floor07.append(
            {
                "creatureId": "cave_rat",
                "x": x,
                "y": y,
                "z": 7,
                "respawn": 90,
            }
        )
    # A few non-rat rows outside dens (format sample only)
    floor07.extend(
        [
            {"creatureId": "snake", "x": 270, "y": 96, "z": 7, "respawn": 60},
            {"creatureId": "wolf", "x": 300, "y": 98, "z": 7, "respawn": 60},
            {"creatureId": "spider", "x": 320, "y": 400, "z": 7, "respawn": 75},
        ]
    )

    floors_meta = []
    total = 0
    creature_ids: set[str] = set()

    BY_FLOOR_DIR.mkdir(parents=True, exist_ok=True)
    for z in range(0, 16):
        fid = f"{z:02d}"
        if z == 7:
            spawns = floor07
        elif z == 6:
            # Stair landing sample
            spawns = [
                {"creatureId": "cave_rat", "x": 480, "y": 860, "z": 6, "respawn": 90}
            ]
        elif z == 8:
            spawns = [
                {"creatureId": "spider", "x": 290, "y": 102, "z": 8, "respawn": 75}
            ]
        else:
            # Empty floors keep the by_floor/NN.json contract for multi-floor loaders
            spawns = []

        payload = {"floor": z, "count": len(spawns), "spawns": spawns}
        write_json(BY_FLOOR_DIR / f"{fid}.json", payload)
        floors_meta.append(
            {
                "floor": fid,
                "count": len(spawns),
                "path": f"assets/legacy/spawns/by_floor/{fid}.json",
            }
        )
        total += len(spawns)
        for s in spawns:
            creature_ids.add(s["creatureId"])

    index = {
        "version": 1,
        "total": total,
        "floors": floors_meta,
        "creatureIdCount": len(creature_ids),
        "creatureIds": sorted(creature_ids),
        "notes": (
            "Open-source reference spawn tables (synthetic dens + format samples). "
            "Not a full-world port dump."
        ),
    }
    write_json(SPAWNS_DIR / "index.json", index)
    return {"total": total, "floor07": len(floor07), "creatureIds": sorted(creature_ids)}


def write_json(path: Path, data: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
    path.write_text(text, encoding="utf-8")


def update_port_manifest() -> None:
    manifest_path = ROOT / "assets" / "legacy" / "port_manifest.json"
    if manifest_path.exists():
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
    else:
        data = {"version": 1}
    data["mapPathPattern"] = "assets/legacy/map/floor-<id>-path.png"
    data["navmesh"] = "assets/legacy/map/navmesh/merged.json"
    data["spawns"] = "assets/legacy/spawns/"
    data["mapReference"] = "synthetic (bin/build_legacy_map_reference.py)"
    data["note"] = (
        "Dev reference port. Map path PNG / navmesh / spawns are synthetic OSS "
        "samples (not commercial world geography). Prefer commercial-safe original "
        "content for product builds."
    )
    write_json(manifest_path, data)


def write_map_readme() -> None:
    readme = MAP_DIR / "REFERENCE.md"
    readme.write_text(
        """# Legacy map reference (synthetic)

Open-source **sample** collision map, navmesh, and fixed spawns for the PNG-map
path (`TileMap.loadFloor`, long routes, `spawnSource.legacy_floor`).

These are **not** a full commercial world dump. Regenerate with:

```bash
python3 bin/build_legacy_map_reference.py
```

## `floor-07-path.png`

| Property | Value |
| :--- | :--- |
| Size | **2560 × 2048** (tile = pixel) |
| Blocked | pure yellow `#ffff00` |
| Walkable | gray `R === G === B`, friction = channel `0–254` |

### Layout zones (map-local tiles)

| Zone | Region | Friction |
| :--- | :--- | :--- |
| Legend cells | `(100,20)`…`(220,20)`, plus a few extra samples | 100–200 |
| **Reference corridor** | `x 250–320`, `y 90–102` | 160 / 100 / 110 |
| Connector | vertical `x≈320` then east into dens | 100 |
| **Dens room** | `x 400–540`, `y 800–900` | 150 (paths 100) |

Default party waypoints (`DEFAULT_FLOOR07_WAYPOINTS`): `(260…304, 96, z=7)` along the corridor.

## Navmesh

| File | Role |
| :--- | :--- |
| `navmesh/floor07_corridor.json` | 5-node hand graph on the corridor |
| `navmesh/merged.json` | Small multi-floor sample (stairs icons + cross-floor edges) |
| `navmesh/analysis.json` | Counts / icon summary for the sample graph |

## Spawns

`assets/legacy/spawns/by_floor/07.json` holds dens `cave_rat` rows inside the dens bbox
(`x 400–540`, `y 800–900`) plus a few format demos. Other floors are empty or
tiny stair-landing samples so the multi-floor file contract remains.
""",
        encoding="utf-8",
    )


def main() -> None:
    os.chdir(ROOT)
    MAP_DIR.mkdir(parents=True, exist_ok=True)
    NAVMESH_DIR.mkdir(parents=True, exist_ok=True)
    SPAWNS_DIR.mkdir(parents=True, exist_ok=True)

    png_info = build_floor_png()
    nav_info = build_navmesh()
    spawn_info = build_spawns()
    update_port_manifest()
    write_map_readme()

    print("legacy map reference built:")
    print("  png     ", png_info["path"], f"{png_info['cols']}x{png_info['rows']}")
    print("  navmesh ", nav_info)
    print("  spawns  ", spawn_info)


if __name__ == "__main__":
    main()
