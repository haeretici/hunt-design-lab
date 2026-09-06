/**
 * 12-piece border + variation autotile (map editor Phase C).
 *
 * Do not overload overlay_wang.js. Wang-16 occupancy lives on `path`.
 * border12 fill occupancy lives on `ground`; edges stamp `path` on land
 * neighbors (transparent fringe — collision stays the fill role).
 *
 * Slot names match the 12-piece edge set: n e s w cnw cne cse csw
 * dnw dne dse dsw. `c*` = outer (only a diagonal neighbor is fill).
 * `d*` = inner (two adjacent cardinals are fill). Cardinals n/e/s/w
 * when exactly one cardinal neighbor is fill.
 *
 * Variation: family brush writes a position-seeded alt; RAW locks one id.
 */

'use strict';

const { parseWallFrontId, WALL_FRONT_SLOT_SET } = require('./wall_front.js');
const {
    parseRect9Id,
    RECT9_SLOT_SET,
    RECT9_UNIQUE_ID_SLOTS
} = require('./overlay_rect9.js');

/** @type {readonly string[]} */
const BORDER12_SLOTS = Object.freeze([
    'n',
    'e',
    's',
    'w',
    'cnw',
    'cne',
    'cse',
    'csw',
    'dnw',
    'dne',
    'dse',
    'dsw'
]);

const BORDER12_SLOT_SET = Object.freeze(
    BORDER12_SLOTS.reduce((acc, slot) => {
        acc[slot] = true;
        return acc;
    }, /** @type {Record<string, boolean>} */ ({}))
);

const AUTO_TILE_KINDS = Object.freeze([
    'none',
    'variation',
    'border12',
    'rect9',
    'wallTop15',
    'wallFront',
    'wang16'
]);

/**
 * Phase B water fill id is `ref_water_fill` (family `beach`, not `water`).
 * Catalog autoTile wins when an index is present.
 */
const BORDER12_FILL_ALIASES = Object.freeze({
    ref_water_fill: 'beach',
    ref_lava_fill: 'lava',
    ref_green_lake_fill: 'green_lake',
    ref_water_pool_fill: 'water_pool'
});

const EDGE_ID_RE =
    /^ref_([a-z][a-z0-9]*)_(n|e|s|w|cnw|cne|cse|csw|dnw|dne|dse|dsw)$/;
const FILL_ID_RE = /^ref_([a-z][a-z0-9]*)_fill$/;
const ALT_ID_RE = /^ref_([a-z][a-z0-9]*)_(\d{2})$/;

/**
 * @param {string} family
 * @returns {string}
 */
function normalizeFamily(family) {
    return String(family || '')
        .trim()
        .toLowerCase();
}

/**
 * @param {string} slot
 * @returns {string}
 */
function normalizeBorder12Slot(slot) {
    const s = String(slot || '')
        .trim()
        .toLowerCase();
    if (!BORDER12_SLOT_SET[s]) {
        throw new Error(
            `Unknown border12 slot "${slot}". Known: ${BORDER12_SLOTS.join(', ')}`
        );
    }
    return s;
}

/**
 * @param {string} family
 * @param {string} slot
 * @returns {string}
 */
function border12CatalogId(family, slot) {
    const f = normalizeFamily(family);
    if (!f) throw new Error('border12 family is empty');
    return `ref_${f}_${normalizeBorder12Slot(slot)}`;
}

/**
 * @param {unknown} raw
 * @returns {{ kind: string, family: string, slot: string }|null}
 */
function normalizeAutoTile(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const rec = /** @type {Record<string, unknown>} */ (raw);
    const kind = String(rec.kind || '').trim();
    if (!kind || AUTO_TILE_KINDS.indexOf(kind) < 0) return null;
    const family = normalizeFamily(rec.family);
    if (!family) return null;
    const slot = String(rec.slot || '')
        .trim()
        .toLowerCase();
    if (!slot) return null;
    return { kind, family, slot };
}

/**
 * Parse a catalog id when autoTile metadata is missing.
 * @param {string} raw
 * @returns {{ kind: string, family: string, slot: string }|null}
 */
function parseAutoTileId(raw) {
    const id = String(raw || '')
        .replace(/\.png$/i, '')
        .trim()
        .toLowerCase();
    if (!id) return null;
    const alias = BORDER12_FILL_ALIASES[id];
    if (alias) return { kind: 'border12', family: alias, slot: 'fill' };
    const rect9 = parseRect9Id(id);
    if (rect9 && RECT9_UNIQUE_ID_SLOTS[rect9.slot]) return rect9;
    const edge = id.match(EDGE_ID_RE);
    if (edge) return { kind: 'border12', family: edge[1], slot: edge[2] };
    const fill = id.match(FILL_ID_RE);
    if (fill) return { kind: 'variation', family: fill[1], slot: 'fill' };
    const alt = id.match(ALT_ID_RE);
    if (alt) return { kind: 'variation', family: alt[1], slot: alt[2] };
    const wallFront = parseWallFrontId(id);
    if (wallFront) return wallFront;
    return null;
}

/**
 * autoTile from a palette entry, stamp, catalog row, or id.
 * @param {object|string|null|undefined} entryOrId
 * @param {ReturnType<typeof buildAutoTileIndex>|null} [index]
 * @returns {{ kind: string, family: string, slot: string }|null}
 */
function autoTileOf(entryOrId, index) {
    if (entryOrId == null) return null;
    if (typeof entryOrId === 'string') {
        if (index && index.byId && index.byId[entryOrId]) return index.byId[entryOrId];
        return parseAutoTileId(entryOrId);
    }
    if (typeof entryOrId !== 'object') return null;
    const stamped = normalizeAutoTile(entryOrId.autoTile);
    if (stamped) return stamped;
    const id = String(entryOrId.catalogId || entryOrId.id || '');
    if (index && id && index.byId && index.byId[id]) return index.byId[id];
    return parseAutoTileId(id);
}

/**
 * @param {object|string|null|undefined} entryOrId
 * @param {ReturnType<typeof buildAutoTileIndex>|null} [index]
 * @returns {string|null}
 */
function border12FamilyOf(entryOrId, index) {
    const at = autoTileOf(entryOrId, index);
    return at && at.kind === 'border12' ? at.family : null;
}

/**
 * @param {object|string|null|undefined} entryOrId
 * @param {ReturnType<typeof buildAutoTileIndex>|null} [index]
 * @returns {boolean}
 */
function isBorder12Fill(entryOrId, index) {
    const at = autoTileOf(entryOrId, index);
    return !!(at && at.kind === 'border12' && at.slot === 'fill');
}

/**
 * @param {object|string|null|undefined} entryOrId
 * @param {ReturnType<typeof buildAutoTileIndex>|null} [index]
 * @returns {boolean}
 */
function isBorder12Edge(entryOrId, index) {
    const at = autoTileOf(entryOrId, index);
    return !!(at && at.kind === 'border12' && BORDER12_SLOT_SET[at.slot]);
}

/**
 * @param {object|string|null|undefined} entryOrId
 * @param {ReturnType<typeof buildAutoTileIndex>|null} [index]
 * @returns {boolean}
 */
function isWallFront(entryOrId, index) {
    const at = autoTileOf(entryOrId, index);
    return !!(at && at.kind === 'wallFront' && WALL_FRONT_SLOT_SET[at.slot]);
}

/**
 * @param {object|string|null|undefined} entryOrId
 * @param {ReturnType<typeof buildAutoTileIndex>|null} [index]
 * @returns {string|null}
 */
function wallFrontFamilyOf(entryOrId, index) {
    const at = autoTileOf(entryOrId, index);
    return at && at.kind === 'wallFront' ? at.family : null;
}

/**
 * @param {object|string|null|undefined} entryOrId
 * @param {ReturnType<typeof buildAutoTileIndex>|null} [index]
 * @returns {boolean}
 */
function isRect9(entryOrId, index) {
    const at = autoTileOf(entryOrId, index);
    return !!(at && at.kind === 'rect9' && RECT9_SLOT_SET[at.slot]);
}

/**
 * @param {object|string|null|undefined} entryOrId
 * @param {ReturnType<typeof buildAutoTileIndex>|null} [index]
 * @returns {string|null}
 */
function rect9FamilyOf(entryOrId, index) {
    const at = autoTileOf(entryOrId, index);
    return at && at.kind === 'rect9' ? at.family : null;
}

/**
 * @param {object|string|null|undefined} entryOrId
 * @param {ReturnType<typeof buildAutoTileIndex>|null} [index]
 * @returns {boolean}
 */
function isResolveLocked(entryOrId) {
    if (!entryOrId || typeof entryOrId !== 'object') return false;
    return !!(entryOrId.wangLocked || entryOrId.borderLocked || entryOrId.wangResolve === false);
}

/**
 * Single overlay slot for a land cell from 8-neighbor fill occupancy.
 * Path is one stamp per cell — stacked dual-cardinal cases pick one slot
 * (inner, then cardinal n/e/s/w, then outer).
 *
 * @param {{
 *   n?: boolean, e?: boolean, s?: boolean, w?: boolean,
 *   nw?: boolean, ne?: boolean, se?: boolean, sw?: boolean
 * }} neigh
 * @returns {string|null}
 */
function resolveBorder12Slot(neigh) {
    const n = !!(neigh && neigh.n);
    const e = !!(neigh && neigh.e);
    const s = !!(neigh && neigh.s);
    const w = !!(neigh && neigh.w);
    const nw = !!(neigh && neigh.nw);
    const ne = !!(neigh && neigh.ne);
    const se = !!(neigh && neigh.se);
    const sw = !!(neigh && neigh.sw);
    if (n && w) return 'dnw';
    if (n && e) return 'dne';
    if (s && e) return 'dse';
    if (s && w) return 'dsw';
    if (n) return 'n';
    if (e) return 'e';
    if (s) return 's';
    if (w) return 'w';
    if (nw) return 'cnw';
    if (ne) return 'cne';
    if (se) return 'cse';
    if (sw) return 'csw';
    return null;
}

/**
 * Stable per-cell hash (same cell always the same variation).
 * @param {number} x
 * @param {number} y
 * @returns {number}
 */
function cellHash(x, y) {
    let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return h >>> 0;
}

/**
 * @param {string[]} ids
 * @param {number} x
 * @param {number} y
 * @returns {string|null}
 */
function pickVariationId(ids, x, y) {
    if (!ids || !ids.length) return null;
    return ids[cellHash(x, y) % ids.length];
}

/**
 * @param {string} family
 * @param {ReturnType<typeof buildAutoTileIndex>|null} [index]
 * @returns {string[]}
 */
function variationIds(family, index) {
    const f = normalizeFamily(family);
    if (!f || !index || !index.families || !index.families[f]) return [];
    const fam = index.families[f];
    if (fam.kind !== 'variation') return [];
    if (Array.isArray(fam.alts) && fam.alts.length) return fam.alts.slice();
    return fam.fillId ? [fam.fillId] : [];
}

/**
 * @param {Iterable<object|null|undefined>} records
 * @returns {{
 *   byId: Record<string, { kind: string, family: string, slot: string }>,
 *   families: Record<string, {
 *     kind: string,
 *     fillId: string|null,
 *     alts: string[],
 *     slots: Record<string, string>
 *   }>
 * }}
 */
function buildAutoTileIndex(records) {
    /** @type {Record<string, { kind: string, family: string, slot: string }>} */
    const byId = Object.create(null);
    /** @type {Record<string, { kind: string, fillId: string|null, alts: string[], slots: Record<string, string> }>} */
    const families = Object.create(null);
    const list = records || [];
    for (const rec of list) {
        if (!rec || typeof rec !== 'object') continue;
        const id = String(rec.id || rec.catalogId || '').trim();
        if (!id) continue;
        const at = normalizeAutoTile(rec.autoTile) || parseAutoTileId(id);
        if (!at) continue;
        byId[id] = at;
        if (at.kind === 'none') continue;
        if (!families[at.family]) {
            families[at.family] = {
                kind: at.kind,
                fillId: null,
                alts: [],
                slots: Object.create(null)
            };
        }
        const fam = families[at.family];
        if (at.kind && fam.kind === 'variation' && at.kind !== 'variation') {
            fam.kind = at.kind;
        }
        if (at.kind === 'border12') fam.kind = 'border12';
        if (at.kind === 'wallFront') fam.kind = 'wallFront';
        if (at.kind === 'rect9') fam.kind = 'rect9';
        if (at.slot === 'fill') fam.fillId = id;
        if (at.kind === 'variation' && at.slot !== 'fill') fam.alts.push(id);
        if (at.kind === 'border12' && BORDER12_SLOT_SET[at.slot]) {
            fam.slots[at.slot] = id;
        }
        if (at.kind === 'wallFront' && WALL_FRONT_SLOT_SET[at.slot]) {
            fam.slots[at.slot] = id;
            if (at.slot === 'mid') fam.fillId = id;
        }
        if (at.kind === 'rect9' && RECT9_SLOT_SET[at.slot]) {
            fam.slots[at.slot] = id;
            if (at.slot === 'c') fam.fillId = id;
        }
    }
    const keys = Object.keys(families);
    for (let i = 0; i < keys.length; i++) {
        const fam = families[keys[i]];
        fam.alts.sort();
        if (!fam.alts.length && fam.fillId && fam.kind === 'variation') {
            fam.alts.push(fam.fillId);
        }
    }
    return { byId, families };
}

module.exports = {
    BORDER12_SLOTS,
    BORDER12_SLOT_SET,
    BORDER12_FILL_ALIASES,
    AUTO_TILE_KINDS,
    normalizeFamily,
    normalizeBorder12Slot,
    normalizeAutoTile,
    border12CatalogId,
    parseAutoTileId,
    autoTileOf,
    border12FamilyOf,
    isBorder12Fill,
    isBorder12Edge,
    isWallFront,
    wallFrontFamilyOf,
    isRect9,
    rect9FamilyOf,
    isResolveLocked,
    resolveBorder12Slot,
    cellHash,
    pickVariationId,
    variationIds,
    buildAutoTileIndex
};
