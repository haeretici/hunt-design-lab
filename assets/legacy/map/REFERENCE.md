# Legacy map reference (synthetic)

Open-source **sample** collision map, navmesh, and fixed spawns for the PNG-map
path (`TileMap.loadFloor`, long routes, `spawnSource.legacy_floor`).

These are **not** a full commercial world dump. Regenerate with:

```bash
python3 bin/build_legacy_map_reference.py
```

Full collision contract (runtime + dungeon pieces): **[docs/08_tilemap_and_pathfinding.md](../../../docs/08_tilemap_and_pathfinding.md)**.

## Path PNG pixel contract (`floor-*-path.png`)

Each pixel = one tile. Walk, line-of-sight, and cast rules are **independent**.

| Pixel | Walk | Sight / projectiles | Flags | Use case |
| :--- | :---: | :---: | :--- | :--- |
| `#ffff00` pure yellow | blocked | blocked | — | Full wall / void |
| White / other non-gray | blocked | blocked | — | Full wall (fallback) |
| Gray `R === G === B`, not white | open; friction = channel **0–250** | open | — | Floor (step delay table) |
| `#00ffff` pure cyan | blocked | **open** | — | Water, lava, moat, pit, low cover — shoot across, cannot stand |
| `#ff00ff` pure magenta | open (friction 100) | blocked | — | Grate / glass — walk OK, vision cut |
| `#00ff00` pure green | open (friction 100) | open | `NO_CAST` | Protection zone — walk OK, no spells/autos from tile |

**Notes for authors**

1. Prefer **pure** RGB for special cells (exact 0/255 channels). Near-cyan gray will not decode as water.
2. Gray channel **251–254** is clamped to **250** for delay (table max). Do not use gray for walls — use yellow.
3. Existing maps that only use yellow + gray keep the old couple: wall blocks walk **and** sight.
4. Magic wall / vine barriers write walk+sight blocked at runtime and restore both on expire.

## Piece friction alphabet (dungeon packs)

When authoring modular pieces (`friction` row strings), the same profiles use:

| Char | Meaning |
| :--- | :--- |
| `#` `X` `W` | Full wall (walk + sight) |
| `.` `o` | Floor (default walk friction, usually 100) |
| `~` | Water / solid clear-sight |
| `^` | Grate / glass |
| `P` | Protection zone (NO_CAST) |
| `+` / `0` | Friction 0 (step delay falls back to default 100) |
| `1`–`f` | `FRICTION_TABLE` key by **1-based index**: `1`→70, `2`→90, `3`→95, `4`→100, … `f`→200. (Table’s last key **250** is not reachable via nibble — use a numeric cell.) |

Higher table keys = stickier floor (slower steps). `.` is normal floor at 100 (same as nibble `4` when default walk is 100).

Stitch propagates `friction`, `sight`, and `flags` into `floorLayers` for the simulator.

## `floor-07-path.png`

| Property | Value |
| :--- | :--- |
| Size | **2560 × 2048** (tile = pixel) |
| Blocked | pure yellow `#ffff00` (full wall) |
| Walkable | gray `R === G === B`, friction = channel |

The sample floor is still **yellow + gray only** (no cyan/magenta/green demos yet). Special colors are valid for new authored maps and piece packs.

### Layout zones (map-local tiles)

TODO: This needs to be updated according to the new "Default party waypoints", old values where (260…304, 96, z=7).

| Zone | Region | Friction |
| :--- | :--- | :--- |
| Legend cells | `(100,20)`…`(220,20)`, plus a few extra samples | 100–200 |
| **Reference corridor** | `x 250–320`, `y 90–102` | 160 / 100 / 110 |
| Connector | vertical `x≈320` then east into dens | 100 |
| **Dens room** | `x 400–540`, `y 800–900` | 150 (paths 100) |

Default party waypoints (`DEFAULT_FLOOR07_WAYPOINTS`): `(651…690, 1026, z=7)` along the corridor.

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
