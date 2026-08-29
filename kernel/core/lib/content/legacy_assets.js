/**
 * Load helpers for assets/legacy (ported legacy map packs, spawns).
 * Node-only (fs). Browser: inject data or fetch JSON under /assets/legacy/.
 *
 * Packs live under `assets/legacy/maps/<id>/` (flatten). Manifest:
 * `assets/legacy/maps/manifest.json`. Default pack is `defaultId` (v01).
 */

'use strict';

const path = require('path');
const { ROOT, PATHS } = require('../../../settings.js');
const { slugifyMonsterName } = require('./legacy_monster_port.js');
const {
    parseSpawnRows,
    loadFloorSpawnsFromDocs,
    resolveCreatureSpawnId,
    makeEditorSpawnPin,
    DEFAULT_EDITOR_SPAWN_RESPAWN,
    parseSpawnFloorZ,
    planSpawnFloorMove,
    applySpawnFloorMove
} = require('./spawn_rows.js');

let fs = null;
try {
    fs = require('fs');
} catch (_) {
    fs = null;
}

/** Pack id = folder name. */
const LEGACY_MAP_ID_RE = /^[a-z][a-z0-9_]{0,31}$/;
const DEFAULT_LEGACY_MAP_ID = 'v01';
const LEGACY_MAPS_ROOT_REL = 'assets/legacy/maps';

/**
 * @param {string} rel under assets/legacy/
 * @returns {string}
 */
function legacyPath(...parts) {
    return path.join(PATHS.legacy || path.join(ROOT, 'assets', 'legacy'), ...parts);
}

/**
 * @param {string} file absolute path
 * @returns {any}
 */
function readJson(file) {
    if (!fs) throw new Error('legacy_assets: fs unavailable');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * @returns {object}
 */
function loadLegacyMapsManifest() {
    if (!fs) throw new Error('legacy_assets: fs unavailable');
    const p = legacyPath('maps', 'manifest.json');
    if (!fs.existsSync(p)) {
        throw new Error('legacy maps manifest missing');
    }
    const raw = readJson(p);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('invalid legacy maps manifest');
    }
    return raw;
}

/**
 * Browser injects the maps manifest so hunt expand can resolve packs without fs.
 * @type {object|null}
 */
let injectedMapsManifest = null;

/**
 * @param {object|null|undefined} manifest
 */
function setLegacyMapsManifest(manifest) {
    injectedMapsManifest =
        manifest && typeof manifest === 'object' && !Array.isArray(manifest)
            ? manifest
            : null;
}

/**
 * @returns {object|null}
 */
function getLegacyMapsManifest() {
    return injectedMapsManifest;
}

/**
 * @returns {object}
 */
function fallbackMapsManifest() {
    return {
        version: 1,
        defaultId: DEFAULT_LEGACY_MAP_ID,
        maps: [{ id: DEFAULT_LEGACY_MAP_ID, label: DEFAULT_LEGACY_MAP_ID }]
    };
}

/**
 * @param {{ manifest?: object }} [opts]
 * @returns {object}
 */
function manifestFromOpts(opts) {
    if (opts && opts.manifest && typeof opts.manifest === 'object') {
        return opts.manifest;
    }
    if (injectedMapsManifest) return injectedMapsManifest;
    if (fs) return loadLegacyMapsManifest();
    return fallbackMapsManifest();
}

/**
 * @param {object} pack
 * @returns {string}
 */
function packAbs(pack) {
    if (pack && pack.mapsRel) return path.join(ROOT, pack.mapsRel);
    return packRootAbs();
}

/**
 * Resolve a pack from the maps manifest.
 * Empty/omit id → defaultId. Unknown id → defaultId. Invalid id → throw.
 *
 * @param {string|null|undefined} [id]
 * @param {{ manifest?: object }} [opts]
 * @returns {{
 *   id: string,
 *   label: string,
 *   mapsRel: string,
 *   spawnsRel: string,
 *   navmeshRel: string,
 *   boundsRel: string
 * }}
 */
function resolveLegacyMapPack(id, opts) {
    const manifest = manifestFromOpts(opts);
    const defaultId =
        typeof manifest.defaultId === 'string' &&
        LEGACY_MAP_ID_RE.test(manifest.defaultId)
            ? manifest.defaultId
            : DEFAULT_LEGACY_MAP_ID;
    let packId;
    if (id == null || id === '') {
        packId = defaultId;
    } else {
        packId = String(id);
        if (!LEGACY_MAP_ID_RE.test(packId)) {
            throw new Error('invalid legacy map id');
        }
    }
    const maps = Array.isArray(manifest.maps) ? manifest.maps : [];
    let row = maps.find((m) => m && m.id === packId) || null;
    if (!row) {
        packId = defaultId;
        row = maps.find((m) => m && m.id === packId) || null;
    }
    const mapsRel = `${LEGACY_MAPS_ROOT_REL}/${packId}`;
    const label =
        row && typeof row.label === 'string' && row.label ? row.label : packId;
    return {
        id: packId,
        label,
        mapsRel,
        spawnsRel: `${mapsRel}/spawns`,
        navmeshRel: `${mapsRel}/navmesh`,
        boundsRel: `${mapsRel}/bounds.json`
    };
}

/**
 * Hunt-root `legacyMapId` → pack. Omit → defaultId. Unknown / invalid →
 * defaultId + note (does not throw).
 *
 * @param {object|null|undefined} hunt
 * @param {{ manifest?: object }} [opts]
 * @returns {{
 *   pack: ReturnType<typeof resolveLegacyMapPack>,
 *   requestedId: string|null,
 *   fallback: boolean,
 *   note: string|null
 * }}
 */
function resolveHuntLegacyMapPack(hunt, opts) {
    const requested =
        hunt && hunt.legacyMapId != null && String(hunt.legacyMapId).trim() !== ''
            ? String(hunt.legacyMapId).trim()
            : null;

    let pack;
    let fallback = false;
    let note = null;
    if (requested && !LEGACY_MAP_ID_RE.test(requested)) {
        pack = resolveLegacyMapPack(null, opts);
        fallback = true;
        note =
            'invalid legacyMapId ' +
            JSON.stringify(requested) +
            '; using default pack ' +
            pack.id;
    } else {
        pack = resolveLegacyMapPack(requested, opts);
        if (requested && pack.id !== requested) {
            fallback = true;
            note =
                'unknown legacyMapId ' +
                JSON.stringify(requested) +
                '; using default pack ' +
                pack.id;
        }
    }
    if (note && typeof console !== 'undefined' && console.warn) {
        console.warn(note);
    }
    return { pack, requestedId: requested, fallback, note };
}

/**
 * Absolute pack root (flatten). `legacyRoot` is a pack-root override (tests).
 * @param {string} [legacyRoot]
 * @returns {string}
 */
function packRootAbs(legacyRoot) {
    if (legacyRoot) return legacyRoot;
    if (PATHS.maps) return PATHS.maps;
    return path.join(ROOT, LEGACY_MAPS_ROOT_REL, DEFAULT_LEGACY_MAP_ID);
}

/**
 * @returns {object|null} bounds.json
 */
function loadLegacyBounds() {
    const p = path.join(packRootAbs(), 'bounds.json');
    if (!fs || !fs.existsSync(p)) return null;
    return readJson(p);
}

/**
 * Normalize floor id for by_floor/NN.json paths.
 * @param {string|number} floorId
 * @returns {string}
 */
function padFloorId(floorId) {
    return String(floorId).padStart(2, '0');
}

/**
 * Absolute hybrid map.json for a floor, or a pack-root override.
 * @param {string} id padded floor id
 * @param {string} [legacyRoot] pack root
 * @returns {string}
 */
function hybridMapJsonPath(id, legacyRoot) {
    return path.join(packRootAbs(legacyRoot), 'hybrid', `floor-${id}`, 'map.json');
}

/**
 * Absolute by_floor JSON for a floor, or a pack-root override.
 * @param {string} id padded floor id
 * @param {string} [legacyRoot] pack root
 * @returns {string}
 */
function byFloorJsonPath(id, legacyRoot) {
    return path.join(
        packRootAbs(legacyRoot),
        'spawns',
        'by_floor',
        `${id}.json`
    );
}

/**
 * Spawns for one floor (0–15 or "07").
 * Node: hybrid `floor-XX/map.json` `spawns` when that pack exists;
 * else pack `spawns/by_floor/NN.json`.
 * Browser: returns [] unless a loader is injected via resolveSpawnSource opts.
 * @param {string|number} floorId
 * @param {{ legacyRoot?: string }} [opts]
 * @returns {object[]}
 */
function loadFloorSpawns(floorId, opts) {
    if (!fs) return [];
    const id = padFloorId(floorId);
    const root = opts && opts.legacyRoot;
    const hybridP = hybridMapJsonPath(id, root);
    if (fs.existsSync(hybridP)) {
        return parseSpawnRows(readJson(hybridP));
    }
    const p = byFloorJsonPath(id, root);
    if (!fs.existsSync(p)) return [];
    return parseSpawnRows(readJson(p));
}

/**
 * Pull filter fields from a flat object or nested `filter` / `bbox`.
 * @param {object} [raw]
 * @returns {object}
 */
function normalizeSpawnFilter(raw) {
    const f = raw && typeof raw === 'object' ? raw : {};
    const nested = f.filter && typeof f.filter === 'object' ? f.filter : {};
    const bbox =
        f.bbox && typeof f.bbox === 'object' && !Array.isArray(f.bbox)
            ? f.bbox
            : Array.isArray(f.bbox) && f.bbox.length >= 4
              ? {
                    xMin: f.bbox[0],
                    yMin: f.bbox[1],
                    xMax: f.bbox[2],
                    yMax: f.bbox[3]
                }
              : {};
    return {
        creatureId: nested.creatureId != null ? nested.creatureId : f.creatureId,
        creatureIds:
            nested.creatureIds != null ? nested.creatureIds : f.creatureIds,
        name: nested.name != null ? nested.name : f.name,
        xMin:
            nested.xMin != null
                ? nested.xMin
                : f.xMin != null
                  ? f.xMin
                  : bbox.xMin,
        xMax:
            nested.xMax != null
                ? nested.xMax
                : f.xMax != null
                  ? f.xMax
                  : bbox.xMax,
        yMin:
            nested.yMin != null
                ? nested.yMin
                : f.yMin != null
                  ? f.yMin
                  : bbox.yMin,
        yMax:
            nested.yMax != null
                ? nested.yMax
                : f.yMax != null
                  ? f.yMax
                  : bbox.yMax,
        limit: nested.limit != null ? nested.limit : f.limit
    };
}

/**
 * Filter an in-memory spawn row list (no I/O). Safe for browser after fetch.
 * @param {object[]} list
 * @param {{
 *   creatureId?: string,
 *   creatureIds?: string[],
 *   name?: string|RegExp,
 *   xMin?: number, xMax?: number, yMin?: number, yMax?: number,
 *   limit?: number
 * }} [filter]
 * @returns {object[]}
 */
function filterSpawnList(list, filter) {
    const f = normalizeSpawnFilter(filter);
    let out = Array.isArray(list) ? list.slice() : [];
    if (f.creatureId) {
        const id = slugifyMonsterName(f.creatureId);
        out = out.filter((s) => s && s.creatureId === id);
    }
    if (f.creatureIds && f.creatureIds.length) {
        const set = new Set(
            f.creatureIds.map((c) => slugifyMonsterName(c))
        );
        out = out.filter((s) => s && set.has(s.creatureId));
    }
    if (f.name) {
        const re =
            f.name instanceof RegExp
                ? f.name
                : new RegExp(String(f.name), 'i');
        out = out.filter(
            (s) =>
                s &&
                (re.test(s.legacyName || '') || re.test(s.creatureId || ''))
        );
    }
    if (f.xMin != null) out = out.filter((s) => s && s.x >= f.xMin);
    if (f.xMax != null) out = out.filter((s) => s && s.x <= f.xMax);
    if (f.yMin != null) out = out.filter((s) => s && s.y >= f.yMin);
    if (f.yMax != null) out = out.filter((s) => s && s.y <= f.yMax);
    if (f.limit != null && f.limit >= 0) out = out.slice(0, f.limit);
    return out;
}

/**
 * Filter floor spawns by creature id/name and optional bounding box.
 * @param {string|number} floorId
 * @param {object} [filter]
 * @param {{ legacyRoot?: string }} [opts]
 * @returns {object[]}
 */
function filterFloorSpawns(floorId, filter, opts) {
    return filterSpawnList(loadFloorSpawns(floorId, opts), filter);
}

/**
 * Map spawn rows → hunt spawn **defs** (table entries, not live instances).
 * @param {object[]} spawns
 * @param {{ respawn?: number, defaultZ?: number, keepRowRespawn?: boolean }} [opts]
 *   respawn — if set, override every row.
 *   keepRowRespawn — default true when respawn override omitted: use row.respawn.
 * @returns {object[]}
 */
function toHuntSpawns(spawns, opts) {
    const o = opts || {};
    const keepRow = o.keepRowRespawn !== false;
    return (spawns || []).map((s) => {
        let respawn = 0;
        if (o.respawn != null) {
            respawn = Number(o.respawn) || 0;
        } else if (keepRow && s && s.respawn != null) {
            respawn = Number(s.respawn) || 0;
        } else if (keepRow && s && s.spawntime != null) {
            respawn = Number(s.spawntime) || 0;
        }
        return {
            creatureId: s.creatureId,
            x: s.x,
            y: s.y,
            z: s.z != null ? s.z : o.defaultZ != null ? o.defaultZ : 7,
            respawn
        };
    });
}

/**
 * Floors listed on a spawnSource or hunt context.
 * @param {object} source
 * @param {{ floors?: (string|number)[], floor?: string|number }} [ctx]
 * @returns {(string|number)[]}
 */
function floorsFromSpawnSource(source, ctx) {
    const c = ctx || {};
    if (source && Array.isArray(source.floors) && source.floors.length) {
        return source.floors.slice();
    }
    if (source && source.floor != null) return [source.floor];
    if (Array.isArray(c.floors) && c.floors.length) return c.floors.slice();
    if (c.floor != null) return [c.floor];
    return [];
}

/**
 * Resolve hunt `spawnSource` into spawn **defs** (not creature instances).
 *
 * Supported:
 * - `{ type: "legacy_floor", floors?, floor?, creatureId?, bbox?, limit?, respawn?, spawnMode? }`
 * - `{ type: "inline", spawns: [...] }` (pass-through defs)
 *
 * @param {object|null|undefined} source
 * @param {{
 *   floors?: (string|number)[],
 *   floor?: string|number,
 *   loadFloorSpawns?: (floorId: string|number) => object[],
 *   legacyRoot?: string
 * }} [ctx]
 * @returns {{
 *   spawns: object[],
 *   spawnMode: string|null,
 *   meta: {
 *     type: string|null,
 *     floors: (string|number)[],
 *     rawCount: number,
 *     defCount: number,
 *     creatureIds: string[]
 *   }
 * }}
 */
function resolveSpawnSource(source, ctx) {
    const empty = {
        spawns: [],
        spawnMode: null,
        meta: {
            type: null,
            floors: [],
            rawCount: 0,
            defCount: 0,
            creatureIds: []
        }
    };
    if (!source || typeof source !== 'object') return empty;

    const type = source.type || source.kind || null;
    const spawnMode =
        source.spawnMode === 'on_demand' || source.spawnMode === 'eager'
            ? source.spawnMode
            : null;

    if (type === 'inline' || type === 'table') {
        const defs = Array.isArray(source.spawns) ? source.spawns.slice() : [];
        const ids = uniqueCreatureIds(defs);
        return {
            spawns: defs,
            spawnMode,
            meta: {
                type: type || 'inline',
                floors: [],
                rawCount: defs.length,
                defCount: defs.length,
                creatureIds: ids
            }
        };
    }

    if (type === 'legacy_floor' || type === 'legacyFloor') {
        return resolveLegacyFloorSpawnSource(source, ctx || {}, spawnMode);
    }

    return {
        spawns: [],
        spawnMode,
        meta: {
            type: type || 'unknown',
            floors: [],
            rawCount: 0,
            defCount: 0,
            creatureIds: []
        }
    };
}

/**
 * @param {object} source
 * @param {object} ctx
 * @param {string|null} spawnMode
 * @returns {ReturnType<typeof resolveSpawnSource>}
 * @private
 */
function resolveLegacyFloorSpawnSource(source, ctx, spawnMode) {
    const floors = floorsFromSpawnSource(source, ctx);
    const load =
        typeof ctx.loadFloorSpawns === 'function'
            ? ctx.loadFloorSpawns
            : (floorId) => loadFloorSpawns(floorId, { legacyRoot: ctx.legacyRoot });
    const filter = normalizeSpawnFilter(source);

    /** @type {object[]} */
    let raw = [];
    for (let i = 0; i < floors.length; i++) {
        const rows = load(floors[i]) || [];
        for (let j = 0; j < rows.length; j++) {
            raw.push(rows[j]);
        }
    }
    // Apply creature/bbox filters across combined floors; limit after merge
    const withoutLimit = Object.assign({}, filter);
    delete withoutLimit.limit;
    let filtered = filterSpawnList(raw, withoutLimit);
    if (filter.limit != null && filter.limit >= 0) {
        filtered = filtered.slice(0, filter.limit);
    }

    const defaultZ =
        floors.length === 1 ? Number(floors[0]) : source.defaultZ;
    const mapOpts = {
        defaultZ: defaultZ != null && !Number.isNaN(defaultZ) ? defaultZ : 7,
        keepRowRespawn: true
    };
    if (source.respawn != null) {
        mapOpts.respawn = source.respawn;
    }
    const defs = toHuntSpawns(filtered, mapOpts);
    const ids = uniqueCreatureIds(defs);

    return {
        spawns: defs,
        spawnMode,
        meta: {
            type: 'legacy_floor',
            floors: floors.slice(),
            rawCount: raw.length,
            defCount: defs.length,
            creatureIds: ids
        }
    };
}

/**
 * @param {object[]} defs
 * @returns {string[]}
 */
function uniqueCreatureIds(defs) {
    const set = new Set();
    for (let i = 0; i < (defs || []).length; i++) {
        const d = defs[i];
        if (d && d.creatureId) set.add(String(d.creatureId));
    }
    return Array.from(set).sort();
}

/**
 * Expand hunt.spawnSource → hunt.spawns defs (in-place style copy).
 * Leaves hunt unchanged when spawnSource is absent.
 * Does **not** instantiate creatures — only table rows for SpawnManager.
 *
 * @param {object} hunt
 * @param {{
 *   loadFloorSpawns?: (floorId: string|number, packId?: string) => object[],
 *   legacyRoot?: string,
 *   manifest?: object
 * }} [opts]
 * @returns {object}
 */
function resolveHuntSpawnDefs(hunt, opts) {
    if (!hunt || typeof hunt !== 'object') return hunt;
    if (!hunt.spawnSource && !hunt.legacyMapId) return hunt;
    const o = opts || {};
    const packResolved = resolveHuntLegacyMapPack(hunt, o);

    const floors =
        Array.isArray(hunt.floors) && hunt.floors.length
            ? hunt.floors
            : hunt.floor != null
              ? [hunt.floor]
              : [];
    const packAbsRoot = o.legacyRoot || packAbs(packResolved.pack);
    const injected =
        typeof o.loadFloorSpawns === 'function' ? o.loadFloorSpawns : null;
    const load = injected
        ? (floorId) => injected(floorId, packResolved.pack.id)
        : (floorId) => loadFloorSpawns(floorId, { legacyRoot: packAbsRoot });

    if (!hunt.spawnSource) {
        const outPackOnly = Object.assign({}, hunt);
        outPackOnly.legacyMapPack = packResolved.pack;
        if (packResolved.note) {
            outPackOnly.legacyMapMeta = {
                requestedId: packResolved.requestedId,
                fallback: packResolved.fallback,
                note: packResolved.note
            };
        }
        return outPackOnly;
    }

    const resolved = resolveSpawnSource(hunt.spawnSource, {
        floors,
        floor: hunt.floor,
        loadFloorSpawns: load,
        legacyRoot: packAbsRoot
    });

    const out = Object.assign({}, hunt);
    out.spawns = resolved.spawns;
    if (resolved.spawnMode && out.spawnMode == null) {
        out.spawnMode = resolved.spawnMode;
    }
    // Keep original intent for UI/docs; drop spawnSource so re-expand does not
    // wipe defs when loadFloorSpawns is unavailable (browser second pass).
    out.spawnSourceSpec = hunt.spawnSource;
    delete out.spawnSource;
    out.legacyMapPack = packResolved.pack;
    if (packResolved.note) {
        out.legacyMapMeta = {
            requestedId: packResolved.requestedId,
            fallback: packResolved.fallback,
            note: packResolved.note
        };
    }
    // Lightweight audit trail (not sent to SpawnManager)
    out.spawnSourceMeta = Object.assign({}, resolved.meta, {
        legacyMapId: packResolved.pack.id,
        legacyMapRequested: packResolved.requestedId,
        legacyMapFallback: packResolved.fallback,
        legacyMapNote: packResolved.note
    });
    return out;
}

/**
 * Spawn index (floors + creature id list).
 * @returns {object|null}
 */
function loadSpawnIndex() {
    const p = path.join(packRootAbs(), 'spawns', 'index.json');
    if (!fs || !fs.existsSync(p)) return null;
    return readJson(p);
}

/**
 * Navmesh analysis summary (icons, cross-floor counts).
 * @returns {object|null}
 */
function loadNavmeshAnalysis() {
    const nav = PATHS.navmesh || path.join(packRootAbs(), 'navmesh');
    const p = path.join(nav, 'analysis.json');
    if (!fs || !fs.existsSync(p)) return null;
    return readJson(p);
}

module.exports = {
    LEGACY_MAP_ID_RE,
    DEFAULT_LEGACY_MAP_ID,
    LEGACY_MAPS_ROOT_REL,
    legacyPath,
    loadLegacyMapsManifest,
    setLegacyMapsManifest,
    getLegacyMapsManifest,
    resolveLegacyMapPack,
    resolveHuntLegacyMapPack,
    packAbs,
    packRootAbs,
    padFloorId,
    loadLegacyBounds,
    loadFloorSpawns,
    parseSpawnRows,
    loadFloorSpawnsFromDocs,
    resolveCreatureSpawnId,
    makeEditorSpawnPin,
    DEFAULT_EDITOR_SPAWN_RESPAWN,
    parseSpawnFloorZ,
    planSpawnFloorMove,
    applySpawnFloorMove,
    normalizeSpawnFilter,
    filterSpawnList,
    filterFloorSpawns,
    toHuntSpawns,
    floorsFromSpawnSource,
    resolveSpawnSource,
    resolveHuntSpawnDefs,
    uniqueCreatureIds,
    loadSpawnIndex,
    loadNavmeshAnalysis,
    slugifyMonsterName
};
