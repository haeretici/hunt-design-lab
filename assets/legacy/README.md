# Reference assets (fixtures)

Public distribution of this tree is **reference data only**, plus **one
automatically generated** path-map image for illustration. It is **not** a
commercial art pack or a full world dump.

Map geography / navmesh / spawns under `map/` and `spawns/` are synthetic
open-source samples for the PNG-map path, fixed spawns, and multi-floor
contracts. Regenerate them with:

```bash
python3 bin/build_legacy_map_reference.py
```

See `map/REFERENCE.md` for the floor-07 layout zones. Product combat content is
`presets/standard/`. The historical combat pack is on git branch **`legacy`**
(`git checkout legacy -- presets/legacy`); rebuild with
`node other/content_maps/bin/port_legacy_full.js` only when that pack is present.
See [docs/16_legacy_port.md](../../docs/16_legacy_port.md).

## Public tree

| Path | Contents |
| :--- | :--- |
| `map/floor-07-path.png` | Auto-generated sample collision path map (2560×2048, pixel = tile); illustrative reference |
| `map/REFERENCE.md` | Layout zones + friction contract for the sample map |
| `map/bounds.json` | World bounds + local size |
| `map/navmesh/` | Small reference graph (`merged.json`, `floor07_corridor.json`) + analysis |
| `spawns/` | Small fixed-spawn tables (`by_floor/`, `index.json`) |
| `port_manifest.json` | Port metadata for converters / tests |
| `README.md` | This file |

## Not in the public repository

| Path | Notes |
| :--- | :--- |
| `monsters/` | **Omitted** from public distribution. Treat as empty / absent. Private checkouts may hold GIFs under `monsters/images/` and `monsters/manifest.json` for local sprite-fallback tests only. Do not commit creature art here for a public release. |

Converters for optional private monster fixtures live in
`kernel/core/lib/content/legacy_monster_port.js`.
