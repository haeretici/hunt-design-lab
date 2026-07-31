# Content modes

Combat and hunt content is packaged per **mode** under `presets/<mode>/`.

| Mode | Role |
| :--- | :--- |
| `standard` | Product / default pack (hunts, catalog bridge, AI scenarios, arena) |

Each folder has `mode.json` (metadata, asset roots, browser catalog). See [docs/17_content_modes.md](../docs/17_content_modes.md).

Art catalogs remain under `assets/data/` and `assets/sprites/` (not mode-scoped). Reference path maps / navmesh / spawns live under `assets/legacy/` (fixtures; see [docs/16_legacy_port.md](../docs/16_legacy_port.md)).

## Create a custom mode

1. Copy `presets/standard` → `presets/<id>/`.
2. Edit `mode.json`: set `id`, `label`, `isDefault: false`, asset roots, `browser` lists, defaults.
3. Optionally enable `features.legacySpawnSource` and point `assets.spawns` at `assets/legacy/spawns` for dens tables.
4. Refresh — `listModes()` discovers the folder automatically.
