/**
 * Wang-16 overlay catalog + neighbor resolve (P3a roster, P3b editor).
 *
 * Bits: N=1 E=2 S=4 W=8. Category === wangFamily (dirt / water / cobble).
 * Ids: <family>_wang_00 … <family>_wang_15.
 * Family brush writes occupancy; resolve picks the mask from 4-neighbors
 * of the same family on `path`. When mask is 15 and exactly one diagonal
 * is empty, write `*_wang_inner_{nw,ne,se,sw}` instead of fill 15.
 */

'use strict';

const OVERLAY_WANG_FAMILIES = Object.freeze(['dirt', 'water', 'cobble']);

const WANG_MASK_COUNT = 16;

const WANG_BITS = Object.freeze({ N: 1, E: 2, S: 4, W: 8 });

/** Empty-diagonal inner stamps (clockwise from NW). Only when mask === 15. */
const WANG_INNERS = Object.freeze(['nw', 'ne', 'se', 'sw']);

/** Cardinal offsets for the 4-neighbor mask (N E S W). */
const WANG_CARDINALS = Object.freeze([
    { bit: WANG_BITS.N, dx: 0, dy: -1 },
    { bit: WANG_BITS.E, dx: 1, dy: 0 },
    { bit: WANG_BITS.S, dx: 0, dy: 1 },
    { bit: WANG_BITS.W, dx: -1, dy: 0 }
]);

/** Diagonal offsets for inner-corner occupancy (NW NE SE SW). */
const WANG_DIAGONALS = Object.freeze([
    { inner: 'nw', dx: -1, dy: -1 },
    { inner: 'ne', dx: 1, dy: -1 },
    { inner: 'se', dx: 1, dy: 1 },
    { inner: 'sw', dx: -1, dy: 1 }
]);

/** Per-mask neighbor hint for image-gen roster lines. */
const WANG_MASK_HINTS = Object.freeze([
    'isolated blob, no neighbor connection',
    'connects north only',
    'connects east only',
    'connects north+east (NE corner)',
    'connects south only',
    'connects north+south (vertical corridor)',
    'connects east+south (SE corner)',
    'connects north+east+south (T, open west)',
    'connects west only',
    'connects north+west (NW corner)',
    'connects east+west (horizontal corridor)',
    'connects north+east+west (T, open south)',
    'connects south+west (SW corner)',
    'connects north+south+west (T, open east)',
    'connects east+south+west (T, open north)',
    'full-cell opaque fill (all four neighbors)'
]);

const FAMILY_LABEL = Object.freeze({
    dirt: 'Dirt',
    water: 'Water',
    cobble: 'Cobble'
});

const WANG_ID_RE = /^(dirt|water|cobble)[_ ]wang[_ ](\d{1,2})$/i;

const WANG_INNER_ID_RE = /^(dirt|water|cobble)[_ ]wang[_ ]inner[_ ](nw|ne|se|sw)$/i;

/**
 * @param {string} family
 * @returns {string}
 */
function normalizeWangFamily(family) {
    const f = String(family || '')
        .trim()
        .toLowerCase();
    if (!OVERLAY_WANG_FAMILIES.includes(f)) {
        throw new Error(
            `Unknown overlay wangFamily "${family}". Known: ${OVERLAY_WANG_FAMILIES.join(', ')}`
        );
    }
    return f;
}

/**
 * @param {unknown} mask
 * @returns {number}
 */
function normalizeWangMask(mask) {
    const n = Number(mask);
    if (!Number.isInteger(n) || n < 0 || n > 15) {
        throw new Error(`wangMask must be an integer 0–15 (got ${mask})`);
    }
    return n;
}

/**
 * @param {number} mask
 * @returns {string}
 */
function padWangMask(mask) {
    return String(normalizeWangMask(mask)).padStart(2, '0');
}

/**
 * @param {unknown} inner
 * @returns {string} nw|ne|se|sw
 */
function normalizeWangInner(inner) {
    const s = String(inner || '')
        .trim()
        .toLowerCase()
        .replace(/[\s_]+/g, '-');
    const key = s.replace(/^inner-/, '');
    if (!WANG_INNERS.includes(key)) {
        throw new Error(
            `wangInner must be nw|ne|se|sw (got ${inner})`
        );
    }
    return key;
}

/**
 * @param {string} family
 * @param {number} mask
 * @returns {string}
 */
function wangCatalogId(family, mask) {
    return `${normalizeWangFamily(family)}_wang_${padWangMask(mask)}`;
}

/**
 * Extra catalog id on the same family (not a 17th mask).
 * @param {string} family
 * @param {string} inner
 * @returns {string}
 */
function wangInnerCatalogId(family, inner) {
    return `${normalizeWangFamily(family)}_wang_inner_${normalizeWangInner(inner)}`;
}

/**
 * @param {string} family
 * @param {number} mask
 * @returns {string}
 */
function wangTechnical(family, mask) {
    return `${FAMILY_LABEL[normalizeWangFamily(family)]} Wang ${padWangMask(mask)}`;
}

/**
 * @param {string} family
 * @param {number} mask
 * @returns {string}
 */
function wangAlias(family, mask) {
    return `${FAMILY_LABEL[normalizeWangFamily(family)]} ${padWangMask(mask)}`;
}

/**
 * @param {string} family
 * @param {string} inner
 * @returns {string}
 */
function wangInnerTechnical(family, inner) {
    return `${FAMILY_LABEL[normalizeWangFamily(family)]} Wang Inner ${normalizeWangInner(inner).toUpperCase()}`;
}

/**
 * @param {string} family
 * @param {string} inner
 * @returns {string}
 */
function wangInnerAlias(family, inner) {
    return `${FAMILY_LABEL[normalizeWangFamily(family)]} Inner ${normalizeWangInner(inner).toUpperCase()}`;
}

/**
 * Parse id / stem / technical (`dirt_wang_05`, `Dirt_Wang_05`, `Dirt Wang 05`,
 * `dirt_wang_inner_nw`).
 * @param {string} raw
 * @returns {{ family: string, mask: number, inner?: string }|null}
 */
function parseWangId(raw) {
    const s = String(raw || '')
        .replace(/\.png$/i, '')
        .trim()
        .replace(/\s+/g, '_');
    const innerM = s.match(WANG_INNER_ID_RE);
    if (innerM) {
        return { family: innerM[1].toLowerCase(), mask: 15, inner: innerM[2].toLowerCase() };
    }
    const m = s.match(WANG_ID_RE);
    if (!m) return null;
    const mask = parseInt(m[2], 10);
    if (!Number.isInteger(mask) || mask < 0 || mask > 15) return null;
    return { family: m[1].toLowerCase(), mask };
}

/**
 * @param {number} mask
 * @returns {string}
 */
function wangMaskHint(mask) {
    return WANG_MASK_HINTS[normalizeWangMask(mask)] || '';
}

/**
 * wangFamily from a palette entry, stamp, or catalog id.
 * Unknown / non-overlay → null (does not throw).
 * @param {object|string|null|undefined} entryOrId
 * @returns {string|null}
 */
function wangFamilyOf(entryOrId) {
    if (entryOrId == null) return null;
    if (typeof entryOrId === 'string') {
        const parsed = parseWangId(entryOrId);
        return parsed ? parsed.family : null;
    }
    if (typeof entryOrId !== 'object') return null;
    if (entryOrId.wallFamily != null && String(entryOrId.wallFamily).trim()) return null;
    if (entryOrId.wallAlign != null && String(entryOrId.wallAlign).trim()) return null;
    const raw = entryOrId.wangFamily;
    if (raw != null && String(raw).trim()) {
        try {
            return normalizeWangFamily(raw);
        } catch (_err) {
            return null;
        }
    }
    return wangFamilyOf(entryOrId.catalogId || entryOrId.id || '');
}

/**
 * True when the entry is a Wang overlay occupancy (family brush or resolved mask).
 * RAW one-off stamps still count as neighbors if they parse to a family.
 * @param {object|string|null|undefined} entryOrId
 * @returns {boolean}
 */
function isWangOverlay(entryOrId) {
    return wangFamilyOf(entryOrId) != null;
}

/**
 * Pack 4-neighbor presence into a Wang-16 mask.
 * @param {boolean} north
 * @param {boolean} east
 * @param {boolean} south
 * @param {boolean} west
 * @returns {number} 0–15
 */
function wangMaskFromCardinals(north, east, south, west) {
    return (
        (north ? WANG_BITS.N : 0) |
        (east ? WANG_BITS.E : 0) |
        (south ? WANG_BITS.S : 0) |
        (west ? WANG_BITS.W : 0)
    );
}

/**
 * Seed cells plus their 4-neighbors (in-bounds). Used so a stroke updates
 * the fringe of already-painted same-family cells. Overlay inner corners
 * also need the diagonals (`opts.diagonals`) so a corner edit re-resolves
 * a mask-15 fill.
 * @param {number} cols
 * @param {number} rows
 * @param {Iterable<number>} indices
 * @param {{ diagonals?: boolean }} [opts]
 * @returns {Set<number>}
 */
function expandWangRing(cols, rows, indices, opts) {
    const c = cols | 0;
    const r = rows | 0;
    const diagonals = !!(opts && opts.diagonals);
    const out = new Set();
    if (c <= 0 || r <= 0) return out;
    const src = indices || [];
    for (const raw of src) {
        const i = raw | 0;
        if (i < 0) continue;
        const x = i % c;
        const y = (i / c) | 0;
        if (y < 0 || y >= r || x < 0 || x >= c) continue;
        out.add(y * c + x);
        if (y > 0) out.add((y - 1) * c + x);
        if (x + 1 < c) out.add(y * c + x + 1);
        if (y + 1 < r) out.add((y + 1) * c + x);
        if (x > 0) out.add(y * c + x - 1);
        if (diagonals) {
            if (y > 0 && x > 0) out.add((y - 1) * c + (x - 1));
            if (y > 0 && x + 1 < c) out.add((y - 1) * c + (x + 1));
            if (y + 1 < r && x > 0) out.add((y + 1) * c + (x - 1));
            if (y + 1 < r && x + 1 < c) out.add((y + 1) * c + (x + 1));
        }
    }
    return out;
}

/**
 * Empty-diagonal labels (same-family missing on that corner).
 * @param {boolean} nw
 * @param {boolean} ne
 * @param {boolean} se
 * @param {boolean} sw
 * @returns {string[]}
 */
function emptyWangInners(nw, ne, se, sw) {
    /** @type {string[]} */
    const empty = [];
    if (!nw) empty.push('nw');
    if (!ne) empty.push('ne');
    if (!se) empty.push('se');
    if (!sw) empty.push('sw');
    return empty;
}

/**
 * Catalog id after the 4-neighbor mask is known.
 * mask !== 15 → Wang-16. mask === 15 + exactly one empty diagonal → inner.
 * 0 or 2+ empty diagonals stay fill 15.
 * @param {string} family
 * @param {number} mask
 * @param {Iterable<string>|null|undefined} [emptyInners]
 * @returns {{ catalogId: string, wangMask: number, wangInner: string|null }}
 */
function resolveWangOverlay(family, mask, emptyInners) {
    const wangMask = normalizeWangMask(mask);
    let wangInner = null;
    if (wangMask === 15) {
        const empty = emptyInners ? Array.from(emptyInners) : [];
        if (empty.length === 1) {
            wangInner = normalizeWangInner(empty[0]);
        }
    }
    return {
        catalogId: wangInner
            ? wangInnerCatalogId(family, wangInner)
            : wangCatalogId(family, wangMask),
        wangMask,
        wangInner
    };
}

/**
 * Sixteen catalog rows for one overlay family.
 * @param {string} family
 * @param {string} [genreId]
 * @returns {Array<{
 *   technical: string,
 *   alias: string,
 *   genre?: string,
 *   kind: string,
 *   category: string,
 *   wangFamily: string,
 *   wangMask: number,
 *   opaqueAlpha: false
 * }>}
 */
function buildWangFamilyRoster(family, genreId) {
    const wangFamily = normalizeWangFamily(family);
    /** @type {ReturnType<typeof buildWangFamilyRoster>} */
    const items = [];
    for (let mask = 0; mask < WANG_MASK_COUNT; mask++) {
        items.push({
            technical: wangTechnical(wangFamily, mask),
            alias: wangAlias(wangFamily, mask),
            genre: genreId,
            kind: 'overlays',
            category: wangFamily,
            wangFamily,
            wangMask: mask,
            opaqueAlpha: false
        });
    }
    return items;
}

/**
 * First incomplete family (or the requested one). Incomplete = no mask in exclude.
 * @param {{ genre?: string, category?: string|null, exclude?: Iterable<string> }} options
 * @returns {ReturnType<typeof buildWangFamilyRoster>}
 */
function generateWangFamilyRoster(options = {}) {
    const exclude = new Set(options.exclude || []);
    const wanted = options.category ? [normalizeWangFamily(options.category)] : OVERLAY_WANG_FAMILIES.slice();
    for (let i = 0; i < wanted.length; i++) {
        const family = wanted[i];
        const items = buildWangFamilyRoster(family, options.genre);
        const blocked = items.some((it) => exclude.has(it.technical) || exclude.has(wangCatalogId(family, it.wangMask)));
        if (blocked) {
            if (options.category) {
                throw new Error(
                    `Overlay family "${family}" is already on the done list. ` +
                        `Omit --category to take the next family, or clear that family first.`
                );
            }
            continue;
        }
        return items;
    }
    throw new Error(
        'No incomplete overlay family (dirt / water / cobble all recorded). ' +
            'Clear overlays_list_done.txt or generate a missing family with --category.'
    );
}

module.exports = {
    OVERLAY_WANG_FAMILIES,
    WANG_MASK_COUNT,
    WANG_BITS,
    WANG_INNERS,
    WANG_CARDINALS,
    WANG_DIAGONALS,
    WANG_MASK_HINTS,
    normalizeWangFamily,
    normalizeWangMask,
    normalizeWangInner,
    padWangMask,
    wangCatalogId,
    wangInnerCatalogId,
    wangTechnical,
    wangAlias,
    wangInnerTechnical,
    wangInnerAlias,
    parseWangId,
    wangMaskHint,
    wangFamilyOf,
    isWangOverlay,
    wangMaskFromCardinals,
    expandWangRing,
    emptyWangInners,
    resolveWangOverlay,
    buildWangFamilyRoster,
    generateWangFamilyRoster
};
