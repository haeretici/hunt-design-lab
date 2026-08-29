/**
 * Sequential arena waves: clear pack → delay → next pack.
 *
 * Distinct from spatial "waves" (fixed packs along a route). This module owns
 * the temporal FSM only; SpawnManager still materializes one-shot slots.
 *
 * Hunt JSON shapes (both accepted):
 *
 *   "waves": [ { "id", "entries": [ { creatureId, count? } ] }, … ]
 *
 *   "waves": {
 *     "delaySec": 3,
 *     "startDelaySec": 0,
 *     "endOnComplete": true,
 *     "holdRoute": true,
 *     "wavesPerArena": null,          // int >= 1 when multi-arena loop
 *     "pauseOnArenaBoundary": false,  // await host resumeAfterPortal
 *     "regions": [ { "id"?, "x", "y", "w", "h", "z"? }, … ],
 *     "list": [ { "id", "label", "delaySec"?, "entries": […] }, … ]
 *   }
 *
 * Each entry (creatureId + count) is a **pack**. Packs without fixed x/y:
 *   - default (`packClustering` omitted/false) → each member scatters across
 *     the union of all spawn zones (no pack glued to a single box)
 *   - `packClustering: true` → assign the pack to one zone (round-robin over
 *     authored regions, or auto-split a single pool) and clump members near
 *     a random center in that zone
 * Legacy single `region` is still accepted and folded into `regions`.
 * Fixed x/y still supported. `count` expands one row into N one-shot slots.
 *
 * Affixes: entries may set rarity / affixes (rare|champion|elite|boss).
 * normalizeWaveEntry stamps hpMult/atkMult/expMult from DEFAULT_AFFIX_STATS
 * (shared with population packs). Explicit mults override the table.
 * Tutorial: docs/23_arena_system_in_depth_tutorial.md
 */

'use strict';

const {
    DEFAULT_AFFIX_STATS,
    resolveSpawnAffixFields
} = require('./dungeon/population.js');

/** @typedef {'idle'|'waiting'|'active'|'intermission'|'awaiting_portal'|'complete'} WavePhase */

/**
 * @param {*} v
 * @param {number} fallback
 * @returns {number}
 */
function num(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

/**
 * @param {*} v
 * @param {number} fallback
 * @returns {number}
 */
function int(v, fallback) {
    return Math.floor(num(v, fallback));
}

/**
 * Collect unique creature ids from a raw or normalized waves config.
 * Used by browser expand / sprite prefetch when there is no flat spawn table.
 * @param {*} raw
 * @returns {string[]}
 */
function collectWaveCreatureIds(raw) {
    if (raw == null) return [];
    /** @type {Record<string, true>} */
    const seen = Object.create(null);
    /** @type {string[]} */
    const out = [];
    const push = (id) => {
        if (!id || seen[id]) return;
        seen[id] = true;
        out.push(id);
    };
    /** @type {object[]} */
    let list = [];
    if (Array.isArray(raw)) {
        // Same unwrap as normalizeWavesConfig (editor-coerced object form).
        if (
            raw.length === 1 &&
            raw[0] &&
            typeof raw[0] === 'object' &&
            !Array.isArray(raw[0]) &&
            (Array.isArray(raw[0].list) || Array.isArray(raw[0].waves)) &&
            !Array.isArray(raw[0].entries) &&
            !Array.isArray(raw[0].spawns) &&
            !Array.isArray(raw[0].creatures)
        ) {
            return collectWaveCreatureIds(raw[0]);
        }
        list = raw;
    } else if (typeof raw === 'object') {
        if (Array.isArray(raw.list)) list = raw.list;
        else if (Array.isArray(raw.waves)) list = raw.waves;
    }
    for (let i = 0; i < list.length; i++) {
        const w = list[i];
        if (!w || typeof w !== 'object') continue;
        const entries = Array.isArray(w.entries)
            ? w.entries
            : Array.isArray(w.spawns)
              ? w.spawns
              : [];
        for (let j = 0; j < entries.length; j++) {
            const e = entries[j];
            if (!e) continue;
            const id =
                e.creatureId != null
                    ? String(e.creatureId)
                    : e.id != null
                      ? String(e.id)
                      : '';
            if (id) push(id);
        }
    }
    return out;
}

/**
 * Normalize one spawn region box (flat or cutout-style bbox).
 * @param {*} raw
 * @param {number} [index=0]
 * @returns {{ id: string, x: number, y: number, w: number, h: number, z: number }|null}
 */
function normalizeRegionBox(raw, index) {
    if (!raw || typeof raw !== 'object') return null;
    const bbox =
        raw.bbox && typeof raw.bbox === 'object' ? raw.bbox : raw;
    const x = int(bbox.x, NaN);
    const y = int(bbox.y, NaN);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const w = Math.max(1, int(bbox.w != null ? bbox.w : bbox.width, 1));
    const h = Math.max(1, int(bbox.h != null ? bbox.h : bbox.height, 1));
    const z = int(raw.z != null ? raw.z : bbox.z, 0);
    const id =
        raw.id != null && String(raw.id).trim()
            ? String(raw.id).trim()
            : `region_${(index != null ? index : 0) + 1}`;
    return { id, x, y, w, h, z };
}

/**
 * Build regions list from `regions[]` and/or legacy single `region`.
 * @param {*} regionsRaw
 * @param {*} legacyRegion
 * @returns {{ id: string, x: number, y: number, w: number, h: number, z: number }[]}
 */
function normalizeRegionsList(regionsRaw, legacyRegion) {
    /** @type {{ id: string, x: number, y: number, w: number, h: number, z: number }[]} */
    const out = [];
    if (Array.isArray(regionsRaw)) {
        for (let i = 0; i < regionsRaw.length; i++) {
            const r = normalizeRegionBox(regionsRaw[i], i);
            if (r) out.push(r);
        }
    }
    if (!out.length && legacyRegion && typeof legacyRegion === 'object') {
        const r = normalizeRegionBox(legacyRegion, 0);
        if (r) out.push(r);
    }
    return out;
}

/**
 * Normalize hunt.waves (array or object) into a stable config, or null.
 * @param {*} raw
 * @returns {{
 *   delaySec: number,
 *   startDelaySec: number,
 *   endOnComplete: boolean,
 *   holdRoute: boolean,
 *   wavesPerArena: number|null,
 *   pauseOnArenaBoundary: boolean,
 *   regions: { id: string, x: number, y: number, w: number, h: number, z: number }[],
 *   region: { id: string, x: number, y: number, w: number, h: number, z: number }|null,
 *   list: object[]
 * }|null}
 */
function normalizeWavesConfig(raw) {
    if (raw == null) return null;

    let delaySec = 3;
    let startDelaySec = 0;
    let endOnComplete = true;
    let holdRoute = true;
    /** Chebyshev radius for near-party spawn bias (null → host default). */
    let anchorRadius = null;
    /** Clump pack members near a shared center (default: scatter in zone). */
    let packClustering = false;
    /**
     * Multi-arena flat list chunk size (null = classic single-arena hunt).
     * Host stamps from arenaLoop; WC only reads these fields.
     * @type {number|null}
     */
    let wavesPerArena = null;
    /** When true, pause auto-advance after every wavesPerArena clears. */
    let pauseOnArenaBoundary = false;
    /** Hold wave 0 until a World pin lever `wave` / `unlock` effect. */
    let holdUntilUnlock = false;
    /** @type {{ id: string, x: number, y: number, w: number, h: number, z: number }[]} */
    let regions = [];
    /** @type {object[]} */
    let list = [];

    if (Array.isArray(raw)) {
        // Hunt-editor schema used to declare waves as array-only; json-editor
        // then wrapped the preferred object form as a single array element
        // { delaySec, regions, list, … }. Detect and unwrap so packs still load.
        if (
            raw.length === 1 &&
            raw[0] &&
            typeof raw[0] === 'object' &&
            !Array.isArray(raw[0]) &&
            (Array.isArray(raw[0].list) || Array.isArray(raw[0].waves)) &&
            !Array.isArray(raw[0].entries) &&
            !Array.isArray(raw[0].spawns) &&
            !Array.isArray(raw[0].creatures)
        ) {
            return normalizeWavesConfig(raw[0]);
        }
        list = raw;
    } else if (typeof raw === 'object') {
        delaySec = Math.max(0, num(raw.delaySec, 3));
        startDelaySec = Math.max(0, num(raw.startDelaySec, 0));
        if (raw.endOnComplete === false) endOnComplete = false;
        if (raw.holdRoute === false) holdRoute = false;
        if (raw.anchorRadius != null) {
            anchorRadius = Math.max(1, int(raw.anchorRadius, 8));
        }
        if (raw.packClustering === true) packClustering = true;
        if (raw.wavesPerArena != null) {
            const n = int(raw.wavesPerArena, 0);
            if (n >= 1) wavesPerArena = n;
        }
        if (raw.pauseOnArenaBoundary === true) pauseOnArenaBoundary = true;
        if (raw.holdUntilUnlock === true) holdUntilUnlock = true;
        regions = normalizeRegionsList(raw.regions, raw.region);
        if (Array.isArray(raw.list)) list = raw.list;
        else if (Array.isArray(raw.waves)) list = raw.waves;
    } else {
        return null;
    }

    const normalizedList = [];
    for (let i = 0; i < list.length; i++) {
        const w = normalizeWaveDef(list[i], i);
        if (w) normalizedList.push(w);
    }
    if (!normalizedList.length) return null;

    // region = first box for brief back-compat (tests / old readers).
    const region = regions.length ? regions[0] : null;

    return {
        delaySec,
        startDelaySec,
        endOnComplete,
        holdRoute,
        wavesPerArena,
        pauseOnArenaBoundary,
        holdUntilUnlock,
        anchorRadius,
        packClustering,
        regions,
        region,
        list: normalizedList
    };
}

/**
 * @param {*} raw
 * @param {number} index
 * @returns {object|null}
 */
function normalizeWaveDef(raw, index) {
    if (!raw || typeof raw !== 'object') return null;
    const entriesRaw =
        Array.isArray(raw.entries)
            ? raw.entries
            : Array.isArray(raw.spawns)
              ? raw.spawns
              : Array.isArray(raw.creatures)
                ? raw.creatures
                : null;
    if (!entriesRaw || !entriesRaw.length) return null;

    const entries = [];
    for (let i = 0; i < entriesRaw.length; i++) {
        const e = normalizeWaveEntry(entriesRaw[i]);
        if (e) entries.push(e);
    }
    if (!entries.length) return null;

    const id =
        raw.id != null && raw.id !== ''
            ? String(raw.id)
            : `wave_${index + 1}`;
    const label =
        raw.label != null && raw.label !== ''
            ? String(raw.label)
            : id;
    const delaySec =
        raw.delaySec != null ? Math.max(0, num(raw.delaySec, 0)) : null;

    return { id, label, delaySec, entries };
}

/**
 * @param {*} raw
 * @param {object} [affixStats] optional override of DEFAULT_AFFIX_STATS
 * @returns {object|null}
 */
function normalizeWaveEntry(raw, affixStats) {
    if (!raw || typeof raw !== 'object') return null;
    const creatureId = raw.creatureId || raw.id || raw.name;
    if (!creatureId) return null;
    const count = Math.max(1, int(raw.count, 1));
    const out = {
        creatureId: String(creatureId),
        count,
        respawn: raw.respawn != null ? Math.max(0, num(raw.respawn, 0)) : 0
    };
    if (raw.x != null && raw.y != null) {
        out.x = Math.round(Number(raw.x));
        out.y = Math.round(Number(raw.y));
    }
    if (raw.z != null) out.z = Number(raw.z);
    if (raw.template) out.template = raw.template;
    if (raw.groupId != null) out.groupId = String(raw.groupId);

    // Shared affix table with population packs (rare/champion/elite/boss).
    // Tags alone stamp mults; explicit mults on the row still win.
    const fields = resolveSpawnAffixFields(
        {
            rarity: raw.rarity,
            affixes: raw.affixes,
            hpMult: raw.hpMult,
            atkMult: raw.atkMult,
            expMult: raw.expMult
        },
        affixStats || DEFAULT_AFFIX_STATS
    );
    if (fields.rarity) out.rarity = fields.rarity;
    if (fields.affixes && fields.affixes.length) {
        out.affixes = fields.affixes.slice();
    }
    if (fields.hpMult !== 1) out.hpMult = fields.hpMult;
    if (fields.atkMult !== 1) out.atkMult = fields.atkMult;
    if (fields.expMult !== 1) out.expMult = fields.expMult;

    return out;
}

/**
 * Resolve floor width/height for whole-floor walkable scans.
 * TileMap keeps size on each layer (`getLayer(z).cols/rows`), not top-level.
 *
 * @param {object} tileMap
 * @param {number|string} z
 * @returns {{ cols: number, rows: number }|null}
 */
function resolveFloorSize(tileMap, z) {
    if (!tileMap) return null;

    let cols = tileMap.cols != null ? tileMap.cols : tileMap.width;
    let rows = tileMap.rows != null ? tileMap.rows : tileMap.height;

    if (
        (cols == null || rows == null) &&
        typeof tileMap.getFloorSize === 'function'
    ) {
        const sz = tileMap.getFloorSize(z);
        if (sz) {
            if (cols == null) {
                cols = sz.cols != null ? sz.cols : sz.width;
            }
            if (rows == null) {
                rows = sz.rows != null ? sz.rows : sz.height;
            }
        }
    }

    // Real TileMap: layers[z] / getLayer(z) hold cols/rows after loadFloor*.
    if (cols == null || rows == null) {
        let layer = null;
        if (typeof tileMap.getLayer === 'function') {
            layer = tileMap.getLayer(z);
        }
        if (
            !layer &&
            tileMap.layers &&
            typeof tileMap.layers === 'object'
        ) {
            layer = tileMap.layers[String(z)] || null;
        }
        if (layer) {
            if (cols == null) cols = layer.cols != null ? layer.cols : layer.width;
            if (rows == null) rows = layer.rows != null ? layer.rows : layer.height;
        }
    }

    cols = int(cols, NaN);
    rows = int(rows, NaN);
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 1 || rows < 1) {
        return null;
    }
    return { cols, rows };
}

/**
 * Collect walkable tiles in one region (or whole floor when region is null).
 * @param {{
 *   canEnter?: function,
 *   isWalkable?: function,
 *   getFriction?: function,
 *   getLayer?: function,
 *   layers?: Record<string, { cols?: number, rows?: number }>,
 *   cols?: number,
 *   rows?: number,
 *   width?: number,
 *   height?: number,
 *   getFloorSize?: function
 * }} tileMap
 * @param {{ x: number, y: number, w: number, h: number, z?: number }|null} region
 * @param {number|string} [defaultZ]
 * @returns {{ x: number, y: number, z: number }[]}
 */
function collectWalkableTiles(tileMap, region, defaultZ) {
    if (!tileMap) return [];
    const z =
        region && region.z != null
            ? region.z
            : defaultZ != null
              ? defaultZ
              : 0;

    let x0 = 0;
    let y0 = 0;
    let x1 = 0;
    let y1 = 0;

    if (region) {
        x0 = region.x;
        y0 = region.y;
        x1 = region.x + region.w - 1;
        y1 = region.y + region.h - 1;
    } else {
        // Without regions, need real floor bounds. Falling back to 1×1 silently
        // emptied the walkable pool on TileMap (size lives on layers[z] only)
        // and arena waves cleared with 0 spawns until authors drew boxes.
        const size = resolveFloorSize(tileMap, z);
        if (!size) return [];
        x0 = 0;
        y0 = 0;
        x1 = size.cols - 1;
        y1 = size.rows - 1;
    }

    const out = [];
    for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
            if (tileAllowsSpawn(tileMap, x, y, z)) {
                out.push({ x, y, z });
            }
        }
    }
    return out;
}

/**
 * Union of walkable tiles across multiple spawn regions.
 * Empty / missing regions → whole floor (same as single null region).
 *
 * @param {object} tileMap
 * @param {{ x: number, y: number, w: number, h: number, z?: number }[]|null|undefined} regions
 * @param {number|string} [defaultZ]
 * @returns {{ x: number, y: number, z: number }[]}
 */
function collectWalkableTilesInRegions(tileMap, regions, defaultZ) {
    if (!regions || !regions.length) {
        return collectWalkableTiles(tileMap, null, defaultZ);
    }
    /** @type {Record<string, true>} */
    const seen = Object.create(null);
    /** @type {{ x: number, y: number, z: number }[]} */
    const out = [];
    for (let i = 0; i < regions.length; i++) {
        const tiles = collectWalkableTiles(tileMap, regions[i], defaultZ);
        for (let j = 0; j < tiles.length; j++) {
            const t = tiles[j];
            const k = t.x + ',' + t.y + ',' + t.z;
            if (seen[k]) continue;
            seen[k] = true;
            out.push(t);
        }
    }
    return out;
}

/**
 * @param {object} tileMap
 * @param {number} x
 * @param {number} y
 * @param {*} z
 * @returns {boolean}
 */
function tileAllowsSpawn(tileMap, x, y, z) {
    if (typeof tileMap.canEnter === 'function') {
        return !!tileMap.canEnter(x, y, z, null);
    }
    if (typeof tileMap.isWalkable === 'function') {
        return !!tileMap.isWalkable(x, y, z);
    }
    return false;
}

/**
 * Fisher–Yates shuffle of a shallow copy (uses rng in [0,1)).
 * @param {object[]} tiles
 * @param {() => number} rng
 * @returns {object[]}
 */
function shuffleTiles(tiles, rng) {
    const arr = tiles.slice();
    const rand = typeof rng === 'function' ? rng : Math.random;
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        const t = arr[i];
        arr[i] = arr[j];
        arr[j] = t;
    }
    return arr;
}

/**
 * Chebyshev distance (grid combat range style).
 * @param {{ x: number, y: number }} a
 * @param {{ x: number, y: number }} b
 * @returns {number}
 */
function chebyshev(a, b) {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/**
 * Prefer walkable tiles near anchors (party positions) so a single pack can
 * land inside combat range. Multi-pack waves skip this so packs can spread.
 *
 * @param {{ x: number, y: number, z?: * }[]} walkable
 * @param {{ x: number, y: number, z?: * }[]|null|undefined} anchors
 * @param {number} [radius=8]
 * @returns {{ x: number, y: number, z: number }[]}
 */
function preferTilesNearAnchors(walkable, anchors, radius) {
    if (!walkable || !walkable.length) return [];
    if (!anchors || !anchors.length) return walkable.slice();
    const r = radius != null && radius > 0 ? radius : 8;
    const near = [];
    for (let i = 0; i < walkable.length; i++) {
        const t = walkable[i];
        for (let j = 0; j < anchors.length; j++) {
            const a = anchors[j];
            if (!a) continue;
            if (a.z != null && t.z != null && String(a.z) !== String(t.z)) {
                continue;
            }
            if (chebyshev(t, a) <= r) {
                near.push(t);
                break;
            }
        }
    }
    return near.length ? near : walkable.slice();
}

/**
 * Split walkable tiles into ~desiredZones spatial pools via farthest-point
 * seeds + nearest-seed assignment. Used when authors leave regions empty (or
 * only one box) so packs do not all pile in the same corner.
 *
 * @param {{ x: number, y: number, z?: number }[]} walkable
 * @param {number} desiredZones
 * @param {() => number} rng
 * @returns {{ id: string, tiles: { x: number, y: number, z?: number }[] }[]}
 */
function discoverAutoSpawnZones(walkable, desiredZones, rng) {
    if (!walkable || !walkable.length) return [];
    const nWant = Math.max(1, Math.floor(Number(desiredZones) || 1));
    const n = Math.min(nWant, walkable.length);
    if (n <= 1) {
        return [{ id: 'auto_0', tiles: walkable.slice() }];
    }

    const shuffled = shuffleTiles(walkable, rng);
    /** @type {{ x: number, y: number, z?: number }[]} */
    const seeds = [shuffled[0]];

    while (seeds.length < n) {
        let best = null;
        let bestScore = -1;
        for (let i = 0; i < walkable.length; i++) {
            const t = walkable[i];
            let minD = Infinity;
            for (let s = 0; s < seeds.length; s++) {
                const d = chebyshev(t, seeds[s]);
                if (d < minD) minD = d;
            }
            // Prefer farther tiles; slight rng tie-break for determinism under seed
            const score = minD + (typeof rng === 'function' ? rng() * 0.01 : 0);
            if (score > bestScore) {
                bestScore = score;
                best = t;
            }
        }
        if (!best || bestScore < 1) break;
        seeds.push(best);
    }

    /** @type {{ id: string, tiles: { x: number, y: number, z?: number }[] }[]} */
    const zones = [];
    for (let i = 0; i < seeds.length; i++) {
        zones.push({ id: 'auto_' + i, tiles: [] });
    }
    for (let i = 0; i < walkable.length; i++) {
        const t = walkable[i];
        let bestI = 0;
        let bestD = Infinity;
        for (let s = 0; s < seeds.length; s++) {
            const d = chebyshev(t, seeds[s]);
            if (d < bestD) {
                bestD = d;
                bestI = s;
            }
        }
        zones[bestI].tiles.push(t);
    }
    return zones.filter((z) => z.tiles && z.tiles.length);
}

/**
 * Pick `count` tiles scattered across `tiles` (shuffled sample, wrap if short).
 * Default pack placement — members fill the zone instead of clumping.
 *
 * @param {{ x: number, y: number, z?: number }[]} tiles
 * @param {number} count
 * @param {() => number} rng
 * @returns {{ x: number, y: number, z?: number }[]}
 */
function pickScatteredTiles(tiles, count, rng) {
    if (!tiles || !tiles.length || count < 1) return [];
    const need = Math.max(1, Math.floor(count));
    if (tiles.length === 1) {
        const out = [];
        for (let i = 0; i < need; i++) out.push(tiles[0]);
        return out;
    }
    const ordered = shuffleTiles(tiles, rng);
    /** @type {{ x: number, y: number, z?: number }[]} */
    const out = [];
    for (let i = 0; i < need; i++) {
        out.push(ordered[i % ordered.length]);
    }
    return out;
}

/**
 * Pick `count` tiles clustered around a random center inside `tiles`.
 * Expands Chebyshev radius until enough tiles are available; wraps if short.
 * Opt-in via waves `packClustering: true`.
 *
 * @param {{ x: number, y: number, z?: number }[]} tiles
 * @param {number} count
 * @param {() => number} rng
 * @returns {{ x: number, y: number, z?: number }[]}
 */
function pickClusteredTiles(tiles, count, rng) {
    if (!tiles || !tiles.length || count < 1) return [];
    const need = Math.max(1, Math.floor(count));
    if (tiles.length === 1) {
        const out = [];
        for (let i = 0; i < need; i++) out.push(tiles[0]);
        return out;
    }

    const shuffled = shuffleTiles(tiles, rng);
    const center = shuffled[0];

    // Growing neighborhood around center keeps pack members together.
    let radius = 1;
    /** @type {{ x: number, y: number, z?: number }[]} */
    let neighborhood = [center];
    const maxR = 64;
    while (neighborhood.length < need && radius <= maxR) {
        neighborhood = [];
        for (let i = 0; i < tiles.length; i++) {
            if (chebyshev(tiles[i], center) <= radius) {
                neighborhood.push(tiles[i]);
            }
        }
        if (neighborhood.length >= need) break;
        radius += 1;
    }
    if (!neighborhood.length) neighborhood = tiles.slice();

    const ordered = shuffleTiles(neighborhood, rng);
    /** @type {{ x: number, y: number, z?: number }[]} */
    const out = [];
    for (let i = 0; i < need; i++) {
        out.push(ordered[i % ordered.length]);
    }
    return out;
}

/**
 * Build spawn zones from authored regions (or one whole-floor pool).
 * Empty tiles are dropped. Does not auto-split — that happens in materialize.
 *
 * @param {object} tileMap
 * @param {{ id?: string, x: number, y: number, w: number, h: number, z?: number }[]|null|undefined} regions
 * @param {number|string} [defaultZ]
 * @returns {{ id: string, tiles: { x: number, y: number, z: number }[] }[]}
 */
function buildSpawnZones(tileMap, regions, defaultZ) {
    if (regions && regions.length) {
        /** @type {{ id: string, tiles: { x: number, y: number, z: number }[] }[]} */
        const zones = [];
        for (let i = 0; i < regions.length; i++) {
            const r = regions[i];
            const tiles = collectWalkableTiles(tileMap, r, defaultZ);
            if (!tiles.length) continue;
            zones.push({
                id: r.id != null ? String(r.id) : 'region_' + (i + 1),
                tiles
            });
        }
        return zones;
    }
    const whole = collectWalkableTiles(tileMap, null, defaultZ);
    if (!whole.length) return [];
    return [{ id: 'floor', tiles: whole }];
}

/**
 * Deduped union of all zone tile lists (for non-clustered scatter).
 *
 * @param {{ tiles: { x: number, y: number, z?: number }[] }[]} zones
 * @returns {{ x: number, y: number, z?: number }[]}
 */
function unionZoneTiles(zones) {
    /** @type {{ x: number, y: number, z?: number }[]} */
    const out = [];
    if (!zones || !zones.length) return out;
    /** @type {Record<string, true>} */
    const seen = Object.create(null);
    for (let i = 0; i < zones.length; i++) {
        const tiles = zones[i] && zones[i].tiles;
        if (!tiles) continue;
        for (let j = 0; j < tiles.length; j++) {
            const t = tiles[j];
            if (!t) continue;
            const z = t.z != null ? t.z : 0;
            const key = t.x + ',' + t.y + ',' + z;
            if (seen[key]) continue;
            seen[key] = true;
            out.push(t);
        }
    }
    return out;
}

/**
 * Expand wave entries into concrete spawn-table rows (x/y filled).
 * Deterministic under seeded rng.
 *
 * Default (`packClustering` omitted/false): members of each entry scatter
 * across the union of all spawn zones — not glued into one box.
 *
 * Opt-in `packClustering: true`: treat each entry as a spatial pack — assign
 * it to one zone (shuffled round-robin; auto-split a single pool by pack
 * count) and clump members near a random center in that zone.
 *
 * Single free pack may still bias toward party anchors for combat range.
 *
 * @param {object} wave normalized wave def
 * @param {{ x: number, y: number, z: number }[]|null|undefined} walkable
 *        legacy flat pool (single zone). Prefer opts.zones when available.
 * @param {() => number} rng
 * @param {{
 *   defaultZ?: number,
 *   waveIndex?: number,
 *   waveId?: string,
 *   anchors?: { x: number, y: number, z?: * }[],
 *   anchorRadius?: number,
 *   zones?: { id?: string, tiles: { x: number, y: number, z?: number }[] }[],
 *   autoSplit?: boolean,
 *   packClustering?: boolean
 * }} [opts]
 * @returns {object[]}
 */
function materializeWaveSpawns(wave, walkable, rng, opts) {
    const o = opts || {};
    const defaultZ = o.defaultZ != null ? o.defaultZ : 0;
    const waveIndex = o.waveIndex != null ? o.waveIndex : 0;
    const waveId = o.waveId != null ? o.waveId : wave && wave.id;
    // Strict true only — missing / false / undefined → scatter (default).
    const packClustering = o.packClustering === true;
    if (!wave || !Array.isArray(wave.entries)) return [];

    /** @type {{ id: string, tiles: { x: number, y: number, z?: number }[] }[]} */
    let zones = [];
    if (Array.isArray(o.zones) && o.zones.length) {
        for (let i = 0; i < o.zones.length; i++) {
            const z = o.zones[i];
            if (!z || !Array.isArray(z.tiles) || !z.tiles.length) continue;
            zones.push({
                id: z.id != null ? String(z.id) : 'zone_' + i,
                tiles: z.tiles
            });
        }
    } else if (walkable && walkable.length) {
        zones = [{ id: 'pool', tiles: walkable }];
    }

    // Free packs = entries that need random placement.
    /** @type {number[]} */
    const freePackIdx = [];
    for (let i = 0; i < wave.entries.length; i++) {
        const e = wave.entries[i];
        if (!e) continue;
        if (e.x != null && e.y != null) continue;
        freePackIdx.push(i);
    }

    // Clustering only: invent spatial zones so multi-pack waves do not share
    // one corner when there is a single authored/flat pool.
    const autoSplit = o.autoSplit !== false;
    if (
        packClustering &&
        autoSplit &&
        freePackIdx.length > 1 &&
        zones.length === 1
    ) {
        zones = discoverAutoSpawnZones(
            zones[0].tiles,
            freePackIdx.length,
            rng
        );
    }

    // Clustering only: shuffled round-robin zone assignment per pack.
    /** @type {number[]} */
    const zoneOrder = [];
    if (packClustering && zones.length) {
        for (let i = 0; i < zones.length; i++) zoneOrder.push(i);
        const rand = typeof rng === 'function' ? rng : Math.random;
        for (let i = zoneOrder.length - 1; i > 0; i--) {
            const j = Math.floor(rand() * (i + 1));
            const tmp = zoneOrder[i];
            zoneOrder[i] = zoneOrder[j];
            zoneOrder[j] = tmp;
        }
    }

    // Default path: one shared pool = union of every zone.
    const scatterPool = packClustering ? null : unionZoneTiles(zones);

    /** @type {Record<number, { x: number, y: number, z?: number }[]>} */
    const packTiles = Object.create(null);
    for (let p = 0; p < freePackIdx.length; p++) {
        const entryIndex = freePackIdx[p];
        const entry = wave.entries[entryIndex];
        const count = Math.max(1, int(entry.count, 1));
        if (!zones.length) {
            packTiles[entryIndex] = [];
            continue;
        }

        /** @type {{ x: number, y: number, z?: number }[]} */
        let pool;
        if (packClustering) {
            const zone = zones[zoneOrder[p % zoneOrder.length]];
            pool = zone.tiles;
        } else {
            pool = scatterPool || [];
        }

        // Single free pack: keep near-party bias so trash still lands in range.
        if (freePackIdx.length === 1) {
            pool = preferTilesNearAnchors(pool, o.anchors, o.anchorRadius);
        }

        packTiles[entryIndex] = packClustering
            ? pickClusteredTiles(pool, count, rng)
            : pickScatteredTiles(pool, count, rng);
    }

    /** @type {object[]} */
    const out = [];
    for (let i = 0; i < wave.entries.length; i++) {
        const entry = wave.entries[i];
        const count = Math.max(1, int(entry.count, 1));
        const tilesForPack = packTiles[i] || null;
        for (let n = 0; n < count; n++) {
            const row = {
                creatureId: entry.creatureId,
                respawn: entry.respawn != null ? entry.respawn : 0,
                _waveIndex: waveIndex,
                _waveId: waveId
            };
            if (entry.template) row.template = entry.template;
            if (entry.rarity != null) row.rarity = entry.rarity;
            if (entry.affixes) row.affixes = entry.affixes;
            if (entry.hpMult != null) row.hpMult = entry.hpMult;
            if (entry.atkMult != null) row.atkMult = entry.atkMult;
            if (entry.expMult != null) row.expMult = entry.expMult;
            if (entry.groupId != null) row.groupId = entry.groupId;

            if (entry.x != null && entry.y != null) {
                row.x = entry.x;
                row.y = entry.y;
                row.z = entry.z != null ? entry.z : defaultZ;
            } else if (tilesForPack && tilesForPack.length) {
                const tile = tilesForPack[n % tilesForPack.length];
                row.x = tile.x;
                row.y = tile.y;
                row.z = tile.z != null ? tile.z : defaultZ;
            } else {
                // No walkable pool: leave missing coords (host may reject).
                row.z = entry.z != null ? entry.z : defaultZ;
            }
            out.push(row);
        }
    }
    return out;
}

/**
 * Runtime FSM for sequential waves.
 */
class WaveController {
    /**
     * @param {ReturnType<typeof normalizeWavesConfig>} config
     */
    constructor(config) {
        this.config = config;
        /** @type {WavePhase} */
        this.phase = config ? 'waiting' : 'idle';
        this.waveIndex = -1;
        /** Next wall time (sim seconds) when waiting/intermission may advance. */
        this.readyAt = 0;
        this.wavesCompleted = 0;
        this.totalWaves = config && config.list ? config.list.length : 0;
        /** Spawns last materialized (for tests / summary). */
        this.lastSpawned = [];
        /** @type {string|null} */
        this.currentWaveId = null;
    }

    /** @returns {boolean} */
    get active() {
        return (
            this.phase === 'active' ||
            this.phase === 'intermission' ||
            this.phase === 'waiting' ||
            this.phase === 'awaiting_portal'
        );
    }

    /** @returns {boolean} */
    get isComplete() {
        return this.phase === 'complete';
    }

    /** @returns {boolean} */
    get holdRoute() {
        return !!(this.config && this.config.holdRoute);
    }

    /** @returns {boolean} */
    get endOnComplete() {
        return !this.config || this.config.endOnComplete !== false;
    }

    /**
     * Arenas fully cleared (KD3): floor(wavesCompleted / wavesPerArena).
     * @returns {number}
     */
    arenasCleared() {
        const wpa = this.config && this.config.wavesPerArena;
        if (!wpa || wpa < 1) return 0;
        return Math.floor(this.wavesCompleted / wpa);
    }

    /**
     * Arena index of the current global wave while fighting / waiting (KD3):
     * floor(max(0, waveIndex) / wavesPerArena). Do not use wavesCompleted-1.
     * @returns {number}
     */
    currentArenaIndex() {
        const wpa = this.config && this.config.wavesPerArena;
        if (!wpa || wpa < 1) return 0;
        return Math.floor(Math.max(0, this.waveIndex) / wpa);
    }

    /**
     * Host rebind finished (arena_enter): leave awaiting_portal and schedule
     * the next wave on the following tick (readyAt = now → 0 delay).
     * @param {number} timeSec
     * @returns {boolean} true if resumed
     */
    resumeAfterPortal(timeSec) {
        if (this.phase !== 'awaiting_portal') return false;
        this.phase = 'intermission';
        this.readyAt = Math.max(0, Number(timeSec) || 0);
        return true;
    }

    /**
     * Snapshot for telemetry / summary.
     * @returns {object|null}
     */
    snapshot() {
        if (!this.config) return null;
        const cur =
            this.waveIndex >= 0 && this.waveIndex < this.config.list.length
                ? this.config.list[this.waveIndex]
                : null;
        return {
            phase: this.phase,
            waveIndex: this.waveIndex,
            waveId: this.currentWaveId,
            waveLabel: cur && cur.label ? cur.label : null,
            wavesCompleted: this.wavesCompleted,
            totalWaves: this.totalWaves,
            readyAt: this.readyAt,
            endOnComplete: this.endOnComplete,
            holdRoute: this.holdRoute,
            wavesPerArena: this.config.wavesPerArena,
            pauseOnArenaBoundary: !!this.config.pauseOnArenaBoundary,
            holdUntilUnlock: !!this.config.holdUntilUnlock,
            arenasCleared: this.arenasCleared(),
            currentArenaIndex: this.currentArenaIndex()
        };
    }

    /**
     * Begin session: schedule wave 0 after startDelaySec.
     * @param {number} timeSec
     * @returns {{ kind: string, waveIndex?: number, wave?: object }|null}
     */
    begin(timeSec) {
        if (!this.config) {
            this.phase = 'idle';
            return null;
        }
        this.phase = 'waiting';
        this.waveIndex = -1;
        this.wavesCompleted = 0;
        const t = Math.max(0, Number(timeSec) || 0);
        this.readyAt = this.config.holdUntilUnlock
            ? Infinity
            : t + this.config.startDelaySec;
        this.lastSpawned = [];
        this.currentWaveId = null;
        return { kind: 'waves_begin', readyAt: this.readyAt };
    }

    /**
     * World pin start-lever: release waiting / intermission now.
     * Optional `waveId` jumps to that list index (not while active).
     * @param {number} timeSec
     * @param {string|null|undefined} [waveId]
     * @returns {boolean}
     */
    unlock(timeSec, waveId) {
        if (!this.config) return false;
        const time = Math.max(0, Number(timeSec) || 0);
        if (this.phase === 'idle') this.begin(time);
        if (
            this.phase === 'active' ||
            this.phase === 'awaiting_portal' ||
            this.phase === 'complete'
        ) {
            return false;
        }
        const want = waveId != null ? String(waveId).trim() : '';
        if (want) {
            let idx = -1;
            const list = this.config.list || [];
            for (let i = 0; i < list.length; i++) {
                if (list[i] && list[i].id === want) {
                    idx = i;
                    break;
                }
            }
            if (idx < 0) return false;
            this.waveIndex = idx - 1;
            this.phase = 'waiting';
            this.readyAt = time;
            return true;
        }
        if (this.phase === 'waiting' || this.phase === 'intermission') {
            this.readyAt = time;
            return true;
        }
        return false;
    }

    /**
     * Advance FSM. Host must apply `spawn` actions (load slots + tick manager).
     *
     * @param {{
     *   time: number,
     *   waveClear: boolean,
     *   tileMap: object|null,
     *   rng?: () => number,
     *   defaultZ?: number,
     *   anchors?: { x: number, y: number, z?: * }[],
     *   anchorRadius?: number
     * }} ctx
     * @returns {{
     *   events: object[],
     *   spawnRows: object[]|null,
     *   complete: boolean
     * }}
     */
    tick(ctx) {
        const events = [];
        /** @type {object[]|null} */
        let spawnRows = null;
        if (!this.config || this.phase === 'idle' || this.phase === 'complete') {
            return { events, spawnRows, complete: this.phase === 'complete' };
        }

        const time = Number(ctx.time) || 0;

        if (this.phase === 'waiting' || this.phase === 'intermission') {
            if (time + 1e-9 < this.readyAt) {
                return { events, spawnRows, complete: false };
            }
            const nextIndex = this.waveIndex + 1;
            if (nextIndex >= this.config.list.length) {
                this.phase = 'complete';
                events.push({
                    kind: 'waves_complete',
                    wavesCompleted: this.wavesCompleted,
                    totalWaves: this.totalWaves
                });
                return { events, spawnRows, complete: true };
            }
            spawnRows = this._materialize(nextIndex, ctx);
            this.waveIndex = nextIndex;
            this.phase = 'active';
            const wave = this.config.list[nextIndex];
            this.currentWaveId = wave.id;
            events.push({
                kind: 'wave_start',
                waveIndex: nextIndex,
                waveId: wave.id,
                waveLabel: wave.label,
                count: spawnRows.length
            });
            return { events, spawnRows, complete: false };
        }

        if (this.phase === 'active') {
            if (!ctx.waveClear) {
                return { events, spawnRows, complete: false };
            }
            this.wavesCompleted += 1;
            const wave = this.config.list[this.waveIndex];
            events.push({
                kind: 'wave_clear',
                waveIndex: this.waveIndex,
                waveId: wave ? wave.id : this.currentWaveId,
                waveLabel: wave ? wave.label : null,
                wavesCompleted: this.wavesCompleted
            });

            // Full multi-arena list clear (KD4) — not stage/boundary complete.
            if (this.wavesCompleted >= this.totalWaves) {
                this.phase = 'complete';
                events.push({
                    kind: 'waves_complete',
                    wavesCompleted: this.wavesCompleted,
                    totalWaves: this.totalWaves
                });
                return { events, spawnRows, complete: true };
            }

            // Arena boundary: host must hop then call resumeAfterPortal.
            // readyAt = +Infinity so no auto-advance race on a short delaySec.
            // Hosts must key off phase === 'awaiting_portal' (not readyAt alone):
            // JSON.stringify(snapshot) turns Infinity into null.
            const wpa = this.config.wavesPerArena;
            if (
                this.config.pauseOnArenaBoundary &&
                wpa &&
                wpa >= 1 &&
                this.wavesCompleted % wpa === 0
            ) {
                this.phase = 'awaiting_portal';
                this.readyAt = Infinity;
                events.push({
                    kind: 'wave_boundary',
                    wavesCompleted: this.wavesCompleted,
                    arenaIndex: Math.floor(this.wavesCompleted / wpa)
                });
                return { events, spawnRows: null, complete: false };
            }

            const nextIndex = this.waveIndex + 1;
            const nextWave = this.config.list[nextIndex];
            const delay =
                nextWave && nextWave.delaySec != null
                    ? nextWave.delaySec
                    : this.config.delaySec;
            this.phase = 'intermission';
            this.readyAt = time + Math.max(0, delay);
            events.push({
                kind: 'wave_intermission',
                waveIndex: this.waveIndex,
                nextWaveIndex: nextIndex,
                delaySec: delay,
                readyAt: this.readyAt
            });
            return { events, spawnRows, complete: false };
        }

        // awaiting_portal: hold until host resumeAfterPortal (no auto-advance).
        return { events, spawnRows, complete: false };
    }

    /**
     * @param {number} index
     * @param {object} ctx
     * @returns {object[]}
     * @private
     */
    _materialize(index, ctx) {
        const wave = this.config.list[index];
        const regions = Array.isArray(this.config.regions)
            ? this.config.regions
            : this.config.region
              ? [this.config.region]
              : [];
        const defaultZ =
            ctx.defaultZ != null
                ? ctx.defaultZ
                : regions.length && regions[0].z != null
                  ? regions[0].z
                  : 0;
        const zones = buildSpawnZones(ctx.tileMap, regions, defaultZ);
        // Flat walkable kept for callers/tests that inspect only the pool size.
        const walkable = [];
        for (let i = 0; i < zones.length; i++) {
            const tiles = zones[i].tiles;
            for (let j = 0; j < tiles.length; j++) walkable.push(tiles[j]);
        }
        const rows = materializeWaveSpawns(wave, walkable, ctx.rng || Math.random, {
            defaultZ,
            waveIndex: index,
            waveId: wave.id,
            anchors: ctx.anchors,
            anchorRadius: ctx.anchorRadius,
            zones,
            // Multiple authored boxes: assign packs to those boxes only.
            // Single/empty: materialize auto-splits the one pool by pack count.
            autoSplit: zones.length <= 1,
            packClustering: this.config.packClustering === true
        });
        this.lastSpawned = rows;
        return rows;
    }
}

module.exports = {
    normalizeWavesConfig,
    normalizeWaveDef,
    normalizeWaveEntry,
    normalizeRegionBox,
    normalizeRegionsList,
    collectWaveCreatureIds,
    collectWalkableTiles,
    collectWalkableTilesInRegions,
    buildSpawnZones,
    discoverAutoSpawnZones,
    pickScatteredTiles,
    pickClusteredTiles,
    preferTilesNearAnchors,
    materializeWaveSpawns,
    shuffleTiles,
    WaveController
};
