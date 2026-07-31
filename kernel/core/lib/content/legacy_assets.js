/**
 * Load helpers for assets/legacy (ported legacy map, spawns, monster manifest).
 * Node-only (fs). Browser: inject data or fetch JSON under /assets/legacy/.
 */

'use strict';

const path = require('path');
const { ROOT, PATHS } = require('../../../settings.js');
const { slugifyMonsterName } = require('./legacy_monster_port.js');

let fs = null;
try {
    fs = require('fs');
} catch (_) {
    fs = null;
}

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
 * @returns {object|null} bounds.json
 */
function loadLegacyBounds() {
    const p = legacyPath('map', 'bounds.json');
    if (!fs || !fs.existsSync(p)) return null;
    return readJson(p);
}

/**
 * Monster manifest (id, hp, image…).
 * @returns {object|null}
 */
function loadLegacyMonsterManifest() {
    const p = legacyPath('monsters', 'manifest.json');
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
 * Spawns for one floor (0–15 or "07").
 * Node: reads assets/legacy/spawns/by_floor/NN.json.
 * Browser: returns [] unless a loader is injected via resolveSpawnSource opts.
 * @param {string|number} floorId
 * @returns {object[]}
 */
function loadFloorSpawns(floorId) {
    if (!fs) return [];
    const id = padFloorId(floorId);
    const p = legacyPath('spawns', 'by_floor', `${id}.json`);
    if (!fs.existsSync(p)) return [];
    const data = readJson(p);
    return Array.isArray(data.spawns) ? data.spawns : [];
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
 * @returns {object[]}
 */
function filterFloorSpawns(floorId, filter) {
    return filterSpawnList(loadFloorSpawns(floorId), filter);
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
 *   loadFloorSpawns?: (floorId: string|number) => object[]
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
            : loadFloorSpawns;
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
 *   loadFloorSpawns?: (floorId: string|number) => object[]
 * }} [opts]
 * @returns {object}
 */
function resolveHuntSpawnDefs(hunt, opts) {
    if (!hunt || typeof hunt !== 'object') return hunt;
    if (!hunt.spawnSource) return hunt;

    const floors =
        Array.isArray(hunt.floors) && hunt.floors.length
            ? hunt.floors
            : hunt.floor != null
              ? [hunt.floor]
              : [];
    const resolved = resolveSpawnSource(hunt.spawnSource, {
        floors,
        floor: hunt.floor,
        loadFloorSpawns: opts && opts.loadFloorSpawns
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
    // Lightweight audit trail (not sent to SpawnManager)
    out.spawnSourceMeta = resolved.meta;
    return out;
}

/**
 * Spawn index (floors + creature id list).
 * @returns {object|null}
 */
function loadSpawnIndex() {
    const p = legacyPath('spawns', 'index.json');
    if (!fs || !fs.existsSync(p)) return null;
    return readJson(p);
}

/**
 * Navmesh analysis summary (icons, cross-floor counts).
 * @returns {object|null}
 */
function loadNavmeshAnalysis() {
    const p = legacyPath('map', 'navmesh', 'analysis.json');
    if (!fs || !fs.existsSync(p)) return null;
    return readJson(p);
}

module.exports = {
    legacyPath,
    padFloorId,
    loadLegacyBounds,
    loadLegacyMonsterManifest,
    loadFloorSpawns,
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
