/**
 * Spawn pin rows: parse, resolve slug ids, editor pin shape.
 * Browser-safe (no fs). Hybrid map.json is SoT when the pack exists.
 */

'use strict';

/** New editor pins omit one-shot respawn=0 unless the author sets it. */
const DEFAULT_EDITOR_SPAWN_RESPAWN = 60;

/** Editor / hunt floor ids are 0–15 (padded `00`–`15` on disk). */
const MIN_SPAWN_FLOOR_Z = 0;
const MAX_SPAWN_FLOOR_Z = 15;

/**
 * Stable slug id from a typed / display name.
 * "Cave Rat" → "cave_rat", "frost imp" → "frost_imp"
 * @param {string} name
 * @returns {string}
 */
function slugifyCreatureId(name) {
    const s = String(name || '')
        .trim()
        .toLowerCase()
        .replace(/['’]/g, '')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .replace(/_+/g, '_');
    return s || 'unknown';
}

/**
 * Extract spawn rows from hybrid map.json or a by_floor document.
 * @param {*} data
 * @returns {object[]}
 */
function parseSpawnRows(data) {
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.spawns)) return data.spawns;
    return [];
}

/**
 * Hybrid doc wins whenever it is present (even if `spawns` is empty).
 * `by_floor` is fallback only when the hybrid pack is missing.
 * @param {*|null|undefined} hybridDoc
 * @param {*|null|undefined} byFloorDoc
 * @returns {object[]}
 */
function loadFloorSpawnsFromDocs(hybridDoc, byFloorDoc) {
    if (hybridDoc != null) return parseSpawnRows(hybridDoc);
    if (byFloorDoc != null) return parseSpawnRows(byFloorDoc);
    return [];
}

/**
 * Resolve a palette / typed name to a creature slug.
 * Prefer exact preset id, then slug, then label; else slugify.
 * @param {string} raw
 * @param {Record<string, {id?: string, label?: string}>|null|undefined} presets
 * @returns {string}
 */
function resolveCreatureSpawnId(raw, presets) {
    const text = String(raw || '').trim();
    if (!text) return '';
    const map = presets && typeof presets === 'object' ? presets : {};
    if (map[text] && (map[text].id || text)) {
        return String(map[text].id || text);
    }
    const slug = slugifyCreatureId(text);
    if (map[slug] && (map[slug].id || slug)) {
        return String(map[slug].id || slug);
    }
    const lower = text.toLowerCase();
    const keys = Object.keys(map);
    for (let i = 0; i < keys.length; i++) {
        const p = map[keys[i]];
        if (!p) continue;
        const id = p.id != null ? String(p.id) : keys[i];
        if (id.toLowerCase() === lower) return id;
        if (p.label && String(p.label).toLowerCase() === lower) return id;
    }
    return slug;
}

/**
 * Editor / save pin: slug creatureId + x/y/z + respawn.
 * @param {object} raw
 * @param {Record<string, object>|null|undefined} [presets]
 * @param {{ z?: number, respawn?: number }} [opts]
 * @returns {{ creatureId: string, x: number, y: number, z: number, respawn: number }|null}
 */
function makeEditorSpawnPin(raw, presets, opts) {
    if (!raw || typeof raw !== 'object') return null;
    const o = opts || {};
    const x = Math.round(Number(raw.x));
    const y = Math.round(Number(raw.y));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const creatureId = resolveCreatureSpawnId(
        raw.creatureId || raw.id || raw.name,
        presets
    );
    if (!creatureId) return null;
    const zRaw = raw.z != null ? raw.z : o.z;
    const z = zRaw != null ? Number(zRaw) : 0;
    let respawn;
    if (raw.respawn != null) {
        respawn = Math.max(0, Number(raw.respawn) || 0);
    } else if (o.respawn != null) {
        respawn = Math.max(0, Number(o.respawn) || 0);
    } else {
        respawn = DEFAULT_EDITOR_SPAWN_RESPAWN;
    }
    if (!Number.isFinite(z)) return null;
    return { creatureId, x, y, z, respawn };
}

/**
 * Integer floor z in 0–15, or null.
 * @param {*} raw
 * @returns {number|null}
 */
function parseSpawnFloorZ(raw) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    const z = Math.round(n);
    if (z < MIN_SPAWN_FLOOR_Z || z > MAX_SPAWN_FLOOR_Z) return null;
    return z;
}

/**
 * Whether Update should migrate the pin to another floor file.
 * @param {*} fromZ current open floor
 * @param {*} toZ typed z
 * @returns {{ ok: true, fromZ: number, toZ: number }|{ ok: false, reason: 'same'|'invalid' }}
 */
function planSpawnFloorMove(fromZ, toZ) {
    const from = parseSpawnFloorZ(fromZ);
    const to = parseSpawnFloorZ(toZ);
    if (from == null || to == null) return { ok: false, reason: 'invalid' };
    if (from === to) return { ok: false, reason: 'same' };
    return { ok: true, fromZ: from, toZ: to };
}

/**
 * Remove `pin` (identity) from fromList and append a copy with dest z.
 * Does not mutate the input arrays.
 * @param {object[]} fromList
 * @param {object[]} destList
 * @param {object} pin
 * @param {number} destZ
 * @returns {{ fromList: object[], destList: object[], moved: object }|null}
 */
function applySpawnFloorMove(fromList, destList, pin, destZ) {
    const z = parseSpawnFloorZ(destZ);
    if (z == null || !pin || typeof pin !== 'object') return null;
    const from = Array.isArray(fromList) ? fromList.slice() : [];
    const dest = Array.isArray(destList) ? destList.slice() : [];
    const idx = from.indexOf(pin);
    if (idx < 0) return null;
    from.splice(idx, 1);
    const moved = Object.assign({}, pin, { z });
    dest.push(moved);
    return { fromList: from, destList: dest, moved };
}

module.exports = {
    DEFAULT_EDITOR_SPAWN_RESPAWN,
    MIN_SPAWN_FLOOR_Z,
    MAX_SPAWN_FLOOR_Z,
    slugifyCreatureId,
    parseSpawnRows,
    loadFloorSpawnsFromDocs,
    resolveCreatureSpawnId,
    makeEditorSpawnPin,
    parseSpawnFloorZ,
    planSpawnFloorMove,
    applySpawnFloorMove
};
