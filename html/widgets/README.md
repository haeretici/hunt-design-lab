# Widgets

UI panels as **child browser windows** (`window.open`) talking to a parent page via `postMessage`.

## Designer relation pickers (Phase 5) + Wiki dual-mode browsers

```text
widgets/designer_pickers/
  protocol.js           # Channel, window names, URL paths, uiMode helpers
  tile_picker.html/js   # Genre art catalog (tiles / creature sprites / …)
  shape_picker.html/js  # Spell shape list + matrix preview
  equipment_picker.*    # Combat equipment catalog — dual uiMode (select | view)
  creature_picker.*     # Combat creature templates — dual uiMode (select | view)
```

| Action | Result |
| :--- | :--- |
| Form **Select** on art-set tile id | Opens catalog picker (`kind=tiles`); postMessage `select` with `{ id }` |
| Form **Select** on creature Custom Sprite (`creature_sprite_id`) | Opens art catalog (`kind=creatures` sprites); not combat templates |
| Form **Select** on combat creature id (`creature_id`) | Opens **creature_picker** (`uiMode=select`) — Hunts spawns/waves, Populations `creatureIds` |
| Form **Select** on equipment id (`equipment_id`) | Opens **equipment_picker** (`uiMode=select`) |
| `openCreaturePicker` / `openEquipmentPicker` | Programmatic popup open for combat catalogs |
| Wiki → Creatures / Equipments | Same pickers embedded with `uiMode=view` (no Select chrome) |
| Child **ready** | Parent replies with `init` (mode / genre / current / …) |
| Cancel / close | Parent drops pending session |

**Creature browser extras:**

| Feature | Behavior |
| :--- | :--- |
| Filters | Text (name/id), **race**, **bestiary class**, **level min / max** — client-side after one full `presets_list` (`limit=0`; summaries include `bestiaryClass`) |
| Layouts | **Card grid** or **table** (DataTables 2 + Bootstrap 5) |
| Layout preference | `localStorage` key `hdl_creature_browser_layout` (`grid` \| `table`) — same shell-shared pattern as `hdl_content_mode` |
| Thumbs | `customSprite` (+ optional `customSpriteGenre`) from template JSON, else `spriteId`, else entity `id` under `assets/sprites/<genre>/creatures/alpha/`. List summaries include those fields from `presets_list`. |
| Batch (view only) | Card/table checkboxes + header **Actions** → **Smart Update Sprites** (`smart_update.js` + API `smart_update_sprites`) |

**Equipment browser extras:**

| Feature | Behavior |
| :--- | :--- |
| Filters | Text (name/id), **slot**, **category** (dynamic), **weapon type** (melee/distance/magic/shield), **vocation** (dynamic; unrestricted items always match), **level min / max** — client-side on `presets_get` equipment catalog |
| Layouts | **Card grid** or **table** (DataTables 2 + Bootstrap 5) |
| Layout preference | `localStorage` key `hdl_equipment_browser_layout` (`grid` \| `table`) |
| Thumbs | Same override chain as creatures: `customSprite` / `customSpriteGenre` (schema on equipment items) → `spriteId` → item `id` under `assets/sprites/<genre>/equipment/alpha/`. |
| Batch (view only) | Same Actions / Smart Update Sprites path as creatures (`kind=equipment`, optional category) |

**Smart Update Sprites (view mode):**

1. Optionally check items on cards or the first table column (empty selection is allowed).
2. **Actions → Smart Update Sprites** opens a batch-builder-style modal (genre + asset kind fixed; rows/cols = 4; iters = 1; seed + image model editable; equipment category optional).
3. **Save and Run batch** sets `customSprite` to the entity id, removes `customSpriteGenre` / `customGenre`, fills remaining sheet slots from library entities with `customSprite !== id` (level low→high; equipment honors category when set), then queues `bin/smart_update_sprites.js` (chunks of 16; multi-sheet when N &gt; 16). Empty selection → up to 16 backlog entities.

**Dual mode (`uiMode` query / init):**

| Mode | Used by | Chrome |
| :--- | :--- | :--- |
| `select` (default) | Designer / Hunt Editor field **Select** buttons | Cancel + Select footer; postMessage on confirm |
| `view` | Wiki shell pages (`wiki-creatures.php`, `wiki-equipment.php`) | Browse + detail sidebar only |

Channel: `hunt-design-lab-designer-picker`. Parent helpers: `kernel/apps/designer-ui/relation_pickers.js` (`openEquipmentPicker`, `openCreaturePicker`, …). Wiki host: `kernel/apps/wiki/app.js`.

## Engine Tweakings (Stage 12B)

```text
widgets/engine_tweakings/
  index.html       # Popup page
  panel.html       # Form markup
  popup.js         # Child: form → postMessage
  parent_bridge.js # Parent: open / focus+resync / close + apply Settings
  protocol.js      # Channel, window name, URL path
  bind.js          # loadPersistedDebugAI + loadPersistedCamera (zoom)
```

| Action | Result |
|--------|--------|
| Click **Engine Tweakings** | Opens resizable popup |
| Click again while open | Focus + **re-push live Settings** (no full reload) |
| Parent reload / leave | Popup closes |
| Change a control | Parent updates `Settings` immediately |
| **Scale (Zoom)** | Sets square `tileWidth`/`tileHeight` (8–48 px); `localStorage` `camera_settings` |
| **Play speed / scrubber / transport** | Same as hunt sidebar; child sends `command` messages; parent owns session |

Channel: `hunt-design-lab-tweaks`. Window name: `hunt_design_lab_tweakings`.

Message types: child → parent `ready` / `patch` / `command` / `closing`; parent → child `state` (includes `session` playback snapshot).

Serve with `npm run dev` so the popup can `fetch('panel.html')`.
