/**
 * 9-piece rectangle autotile (`autoTile.kind: rect9`).
 *
 * Do not overload overlay_wang.js. 3×3 slots: nw n ne / w c e / sw s se.
 * Occupancy is the painted family (carpets on `path` overlays; roofs later
 * on `scenery` objects). Stroke-end rewrites the same layer from 4-neighbors.
 *
 * Isolated / thin strips use center + cardinals so a 1×N run is w/c/e
 * (or n/c/s), not corner pieces.
 */

'use strict';

/** @type {readonly string[]} */
const RECT9_SLOTS = Object.freeze([
    'nw',
    'n',
    'ne',
    'w',
    'c',
    'e',
    'sw',
    's',
    'se'
]);

const RECT9_SLOT_SET = Object.freeze(
    RECT9_SLOTS.reduce((acc, slot) => {
        acc[slot] = true;
        return acc;
    }, /** @type {Record<string, boolean>} */ ({}))
);

/**
 * Id-only parse: these cannot be border12 edges (`n e s w`).
 * Cardinals need catalog `autoTile`.
 * @type {Readonly<Record<string, boolean>>}
 */
const RECT9_UNIQUE_ID_SLOTS = Object.freeze({
    c: true,
    nw: true,
    ne: true,
    sw: true,
    se: true
});

const RECT9_FAMILY_SLOT = 'c';

const FAMILY_ID_RE = /^[a-z][a-z0-9_]{0,63}$/;

/** Longest-first so `nw` is not parsed as `n` + leftover. */
const RECT9_SLOTS_PARSE = Object.freeze(
    RECT9_SLOTS.slice().sort((a, b) => b.length - a.length)
);

/**
 * @param {unknown} family
 * @returns {string}
 */
function normalizeRect9Family(family) {
    const f = String(family || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '');
    if (!f || !FAMILY_ID_RE.test(f)) {
        throw new Error(`Invalid rect9 family "${family}"`);
    }
    return f;
}

/**
 * @param {unknown} slot
 * @returns {string}
 */
function normalizeRect9Slot(slot) {
    const s = String(slot || '')
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, '_');
    if (!RECT9_SLOT_SET[s]) {
        throw new Error(`Unknown rect9 slot "${slot}". Known: ${RECT9_SLOTS.join(', ')}`);
    }
    return s;
}

/**
 * @param {string} family
 * @param {string} slot
 * @returns {string}
 */
function rect9CatalogId(family, slot) {
    return `ref_${normalizeRect9Family(family)}_${normalizeRect9Slot(slot)}`;
}

/**
 * Parse `ref_square_c` / `ref_square_nw`. Cardinals `n e s w` also match
 * when the suffix is exact; callers that share those with border12 should
 * prefer catalog `autoTile` or `RECT9_UNIQUE_ID_SLOTS`.
 * @param {unknown} raw
 * @returns {{ kind: 'rect9', family: string, slot: string }|null}
 */
function parseRect9Id(raw) {
    const id = String(raw || '')
        .replace(/\.png$/i, '')
        .trim()
        .toLowerCase();
    if (!id || id.indexOf('ref_') !== 0) return null;
    const rest = id.slice(4);
    if (!rest) return null;
    for (let i = 0; i < RECT9_SLOTS_PARSE.length; i++) {
        const slot = RECT9_SLOTS_PARSE[i];
        const suffix = `_${slot}`;
        if (rest.length <= suffix.length || rest.slice(-suffix.length) !== suffix) {
            continue;
        }
        const family = rest.slice(0, rest.length - suffix.length);
        try {
            return {
                kind: 'rect9',
                family: normalizeRect9Family(family),
                slot: normalizeRect9Slot(slot)
            };
        } catch (_err) {
            return null;
        }
    }
    return null;
}

/**
 * 4-neighbor 3×3. Isolated → c. 1-wide column → n/c/s. 1-tall row → w/c/e.
 * Filled rectangle uses corners then edges then center.
 * @param {{ n?: boolean, e?: boolean, s?: boolean, w?: boolean }|null|undefined} neigh
 * @returns {'nw'|'n'|'ne'|'w'|'c'|'e'|'sw'|'s'|'se'}
 */
function resolveRect9Slot(neigh) {
    const n = !!(neigh && neigh.n);
    const e = !!(neigh && neigh.e);
    const s = !!(neigh && neigh.s);
    const w = !!(neigh && neigh.w);
    if (!n && !e && !s && !w) return 'c';
    const h = e || w;
    const v = n || s;
    if (!h) {
        if (n && s) return 'c';
        if (s) return 'n';
        if (n) return 's';
        return 'c';
    }
    if (!v) {
        if (e && w) return 'c';
        if (e) return 'w';
        if (w) return 'e';
        return 'c';
    }
    const north = !n;
    const south = !s;
    const west = !w;
    const east = !e;
    if (north && west) return 'nw';
    if (north && east) return 'ne';
    if (south && west) return 'sw';
    if (south && east) return 'se';
    if (north) return 'n';
    if (south) return 's';
    if (west) return 'w';
    if (east) return 'e';
    return 'c';
}

/**
 * @param {unknown} slot
 * @returns {boolean}
 */
function isRect9FamilySlot(slot) {
    return (
        String(slot || '')
            .trim()
            .toLowerCase() === RECT9_FAMILY_SLOT
    );
}

module.exports = {
    RECT9_SLOTS,
    RECT9_SLOT_SET,
    RECT9_UNIQUE_ID_SLOTS,
    RECT9_FAMILY_SLOT,
    normalizeRect9Family,
    normalizeRect9Slot,
    rect9CatalogId,
    parseRect9Id,
    resolveRect9Slot,
    isRect9FamilySlot
};
