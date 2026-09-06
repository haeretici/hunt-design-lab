/**
 * ¾ village wall strip (`autoTile.kind: wallFront`) on `vertical`.
 *
 * Do not overload wall_wang.js. Wang-16 faces stay a second brush.
 * Horizontal-run caps + mid: west/east occupancy of the same family.
 * North/south neighbors do not change the slot (south-facing strip).
 *
 * Resolve slots: left mid right. Optional extras (statue / window) are
 * RAW-locked occupancy; they still count as neighbors.
 */

'use strict';

/** @type {readonly string[]} */
const WALL_FRONT_RESOLVE_SLOTS = Object.freeze(['left', 'mid', 'right']);

/** @type {readonly string[]} */
const WALL_FRONT_EXTRA_SLOTS = Object.freeze([
    'left_statue',
    'mid_window',
    'right_statue'
]);

/** @type {readonly string[]} */
const WALL_FRONT_SLOTS = Object.freeze(
    WALL_FRONT_RESOLVE_SLOTS.concat(WALL_FRONT_EXTRA_SLOTS)
);

const WALL_FRONT_SLOT_SET = Object.freeze(
    WALL_FRONT_SLOTS.reduce((acc, slot) => {
        acc[slot] = true;
        return acc;
    }, /** @type {Record<string, boolean>} */ ({}))
);

const WALL_FRONT_FAMILY_SLOT = 'mid';

const FAMILY_ID_RE = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Longest-first so `mid_window` is not parsed as `mid`.
 * @type {readonly string[]}
 */
const WALL_FRONT_SLOTS_PARSE = Object.freeze(
    WALL_FRONT_SLOTS.slice().sort((a, b) => b.length - a.length)
);

/**
 * @param {unknown} family
 * @returns {string}
 */
function normalizeWallFrontFamily(family) {
    const f = String(family || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '');
    if (!f || !FAMILY_ID_RE.test(f)) {
        throw new Error(`Invalid wallFront family "${family}"`);
    }
    return f;
}

/**
 * @param {unknown} slot
 * @returns {string}
 */
function normalizeWallFrontSlot(slot) {
    const s = String(slot || '')
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, '_');
    if (!WALL_FRONT_SLOT_SET[s]) {
        throw new Error(
            `Unknown wallFront slot "${slot}". Known: ${WALL_FRONT_SLOTS.join(', ')}`
        );
    }
    return s;
}

/**
 * @param {string} family
 * @param {string} slot
 * @returns {string}
 */
function wallFrontCatalogId(family, slot) {
    return `ref_${normalizeWallFrontFamily(family)}_${normalizeWallFrontSlot(slot)}`;
}

/**
 * Parse `ref_village_front_left` / `ref_village_front_mid_window`.
 * @param {unknown} raw
 * @returns {{ kind: 'wallFront', family: string, slot: string }|null}
 */
function parseWallFrontId(raw) {
    const id = String(raw || '')
        .replace(/\.png$/i, '')
        .trim()
        .toLowerCase();
    if (!id || id.indexOf('ref_') !== 0) return null;
    const rest = id.slice(4);
    if (!rest) return null;
    for (let i = 0; i < WALL_FRONT_SLOTS_PARSE.length; i++) {
        const slot = WALL_FRONT_SLOTS_PARSE[i];
        const suffix = `_${slot}`;
        if (rest.length <= suffix.length || rest.slice(-suffix.length) !== suffix) {
            continue;
        }
        const family = rest.slice(0, rest.length - suffix.length);
        try {
            return {
                kind: 'wallFront',
                family: normalizeWallFrontFamily(family),
                slot: normalizeWallFrontSlot(slot)
            };
        } catch (_err) {
            return null;
        }
    }
    return null;
}

/**
 * Isolated / both neighbors → mid. East-only → left cap. West-only → right cap.
 * @param {{ e?: boolean, w?: boolean }|null|undefined} neigh
 * @returns {'left'|'mid'|'right'}
 */
function resolveWallFrontSlot(neigh) {
    const e = !!(neigh && neigh.e);
    const w = !!(neigh && neigh.w);
    if (e && !w) return 'left';
    if (w && !e) return 'right';
    return 'mid';
}

/**
 * @param {unknown} slot
 * @returns {boolean}
 */
function isWallFrontResolveSlot(slot) {
    const s = String(slot || '')
        .trim()
        .toLowerCase();
    return s === 'left' || s === 'mid' || s === 'right';
}

/**
 * Family brush is the representative `mid`. Other slots are RAW locks.
 * @param {unknown} slot
 * @returns {boolean}
 */
function isWallFrontFamilySlot(slot) {
    return (
        String(slot || '')
            .trim()
            .toLowerCase() === WALL_FRONT_FAMILY_SLOT
    );
}

module.exports = {
    WALL_FRONT_SLOTS,
    WALL_FRONT_RESOLVE_SLOTS,
    WALL_FRONT_EXTRA_SLOTS,
    WALL_FRONT_SLOT_SET,
    WALL_FRONT_FAMILY_SLOT,
    normalizeWallFrontFamily,
    normalizeWallFrontSlot,
    wallFrontCatalogId,
    parseWallFrontId,
    resolveWallFrontSlot,
    isWallFrontResolveSlot,
    isWallFrontFamilySlot
};
