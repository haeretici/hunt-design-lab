# Legacy map reference (synthetic)

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
