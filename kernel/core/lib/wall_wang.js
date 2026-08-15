/**
 * Wall Wang-16 on `vertical` (P4). Reuses P3 bits (N=1 E=2 S=4 W=8).
 *
 * Kind `objects`, category `wall`. Family id is `wallFamily` (not overlay
 * `wangFamily`). Ships 4 faces (pole / horizontal / vertical / corner);
 * extra full[] slots optional (ends, other corners, T, intersection).
 * Hop stamps are not neighbors. Not overlays. Not a sixth sub-layer.
 *
 * Legacy wall tables use N=1 W=2 E=4 S=8 — these arrays are remapped.
 */

'use strict';

const { WANG_MASK_COUNT, normalizeWangMask, expandWangRing } = require('./overlay_wang.js');

const WALL_ALIGN_SHIPPED = Object.freeze(['pole', 'horizontal', 'vertical', 'corner']);

const WALL_ALIGN_EXTRA = Object.freeze([
    'south_end',
    'east_end',
    'west_end',
    'north_end',
    'northeast_diagonal',
    'southeast_diagonal',
    'southwest_diagonal',
    'south_t',
    'east_t',
    'west_t',
    'north_t',
    'intersection'
]);

const WALL_ALIGN_ALL = Object.freeze(WALL_ALIGN_SHIPPED.concat(WALL_ALIGN_EXTRA));

const WALL_ALIGN_COUNT = WALL_ALIGN_SHIPPED.length;

/** P3 mask 0–15 → full[] name. Extra slots optional. */
const WALL_ALIGN_FULL = Object.freeze([
    'pole',
    'south_end',
    'west_end',
    'northeast_diagonal',
    'north_end',
    'vertical',
    'southeast_diagonal',
    'west_t',
    'east_end',
    'corner',
    'horizontal',
    'south_t',
    'southwest_diagonal',
    'east_t',
    'north_t',
    'intersection'
]);

/** P3 mask 0–15 → half[] fallback (always one of the four shipped faces). */
const WALL_ALIGN_HALF = Object.freeze([
    'pole',
    'vertical',
    'pole',
    'vertical',
    'pole',
    'vertical',
    'pole',
    'vertical',
    'horizontal',
    'corner',
    'horizontal',
    'corner',
    'horizontal',
    'corner',
    'horizontal',
    'corner'
]);

const WALL_ALIGN_SET = new Set(WALL_ALIGN_ALL);

const WALL_ALIGN_PARSE = Object.freeze(WALL_ALIGN_ALL.concat(['northwest_diagonal']));

const WALL_ID_RE = new RegExp(
    `^(.+)_(${WALL_ALIGN_PARSE.slice()
        .sort((a, b) => b.length - a.length)
        .join('|')})$`,
    'i'
);

const FAMILY_ID_RE = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * @param {unknown} family
 * @returns {string}
 */
function normalizeWallFamily(family) {
    const f = String(family || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '');
    if (!f || !FAMILY_ID_RE.test(f)) {
        throw new Error(`Invalid wallFamily "${family}"`);
    }
    return f;
}

/**
 * @param {unknown} align
 * @returns {string}
 */
function normalizeWallAlign(align) {
    const a = String(align || '')
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, '_');
    if (a === 'northwest_diagonal') return 'corner';
    if (!WALL_ALIGN_SET.has(a)) {
        throw new Error(
            `Unknown wallAlign "${align}". Known: ${WALL_ALIGN_ALL.join(', ')}`
        );
    }
    return a;
}

/**
 * @param {string} family
 * @param {string} align
 * @returns {string}
 */
function wallCatalogId(family, align) {
    return `${normalizeWallFamily(family)}_${normalizeWallAlign(align)}`;
}

/**
 * Parse id / stem (`stone_wall_pole`, `Brick_Wall_Horizontal`).
 * @param {string} raw
 * @returns {{ family: string, align: string }|null}
 */
function parseWallId(raw) {
    const s = String(raw || '')
        .replace(/\.png$/i, '')
        .trim()
        .replace(/\s+/g, '_');
    const m = s.match(WALL_ID_RE);
    if (!m) return null;
    try {
        return {
            family: normalizeWallFamily(m[1]),
            align: normalizeWallAlign(m[2])
        };
    } catch (_err) {
        return null;
    }
}

/**
 * wallFamily from a palette entry, stamp, or catalog id.
 * Overlay `wangFamily` / unknown → null (does not throw).
 * @param {object|string|null|undefined} entryOrId
 * @returns {string|null}
 */
function wallFamilyOf(entryOrId) {
    if (entryOrId == null) return null;
    if (typeof entryOrId === 'string') {
        const parsed = parseWallId(entryOrId);
        return parsed ? parsed.family : null;
    }
    if (typeof entryOrId !== 'object') return null;
    const kind = entryOrId.kind != null ? String(entryOrId.kind).trim().toLowerCase() : '';
    if (kind === 'overlays' || kind === 'tiles') return null;
    const raw = entryOrId.wallFamily;
    if (raw != null && String(raw).trim()) {
        try {
            return normalizeWallFamily(raw);
        } catch (_err) {
            return null;
        }
    }
    const parsed = parseWallId(entryOrId.catalogId || entryOrId.id || '');
    return parsed ? parsed.family : null;
}

/**
 * @param {object|string|null|undefined} entryOrId
 * @returns {string|null}
 */
function wallAlignOf(entryOrId) {
    if (entryOrId == null) return null;
    if (typeof entryOrId === 'string') {
        const parsed = parseWallId(entryOrId);
        return parsed ? parsed.align : null;
    }
    if (typeof entryOrId !== 'object') return null;
    const raw = entryOrId.wallAlign;
    if (raw != null && String(raw).trim()) {
        try {
            return normalizeWallAlign(raw);
        } catch (_err) {
            return null;
        }
    }
    return wallAlignOf(entryOrId.catalogId || entryOrId.id || '');
}

/**
 * True when the entry is a wall-family occupancy (family brush or resolved face).
 * @param {object|string|null|undefined} entryOrId
 * @returns {boolean}
 */
function isWallWang(entryOrId) {
    return wallFamilyOf(entryOrId) != null;
}

/**
 * Hop / stair pad on `vertical` — not a wall neighbor.
 * Role `wall` has `vertical: null`. Stairs carry `role.vertical` and/or `hop`.
 * @param {object|null|undefined} entry
 * @param {Map|object|null|undefined} [roleCatalog]
 * @returns {boolean}
 */
function isHopStamp(entry, roleCatalog) {
    if (!entry || typeof entry !== 'object') return false;
    if (entry.hop && typeof entry.hop === 'object') return true;
    if (entry.vertical && typeof entry.vertical === 'object') return true;
    const roleInline = entry.role;
    if (roleInline && roleInline.vertical && typeof roleInline.vertical === 'object') {
        return true;
    }
    const rid = entry.roleId != null ? String(entry.roleId).trim() : '';
    if (!rid || !roleCatalog) return false;
    const role =
        roleCatalog instanceof Map ? roleCatalog.get(rid) : roleCatalog[rid];
    return !!(role && role.vertical && typeof role.vertical === 'object');
}

/**
 * P3 mask → full[] name if the family has that face, else half[] (one of 4).
 * @param {number} mask
 * @param {(align: string) => boolean} [hasAlign]
 * @returns {string}
 */
function resolveWallAlign(mask, hasAlign) {
    const m = normalizeWangMask(mask);
    const full = WALL_ALIGN_FULL[m];
    if (typeof hasAlign !== 'function' || hasAlign(full)) return full;
    return WALL_ALIGN_HALF[m];
}

/**
 * Aligns present on a floor palette (plus the shipped 4).
 * @param {object} floor
 * @param {string} family
 * @returns {Set<string>}
 */
function familyAlignSet(floor, family) {
    const set = new Set(WALL_ALIGN_SHIPPED);
    const pal = floor && Array.isArray(floor.palette) ? floor.palette : [];
    for (let i = 1; i < pal.length; i++) {
        const e = pal[i];
        if (!e || wallFamilyOf(e) !== family) continue;
        const a = wallAlignOf(e);
        if (a) set.add(a);
    }
    return set;
}

/**
 * P3 mask for a full[] face name (`corner` = 9 = N+W).
 * @param {string} align
 * @returns {number}
 */
function maskForWallAlign(align) {
    const a = normalizeWallAlign(align);
    const i = WALL_ALIGN_FULL.indexOf(a);
    return i < 0 ? 0 : i;
}

/**
 * @param {string} family
 * @param {string} align
 * @param {string} [genreId]
 * @returns {{
 *   technical: string,
 *   alias: string,
 *   genre?: string,
 *   kind: string,
 *   category: string,
 *   wallFamily: string,
 *   wallAlign: string,
 *   opaqueAlpha: false
 * }}
 */
function buildWallFaceItem(family, align, genreId) {
    const wallFamily = normalizeWallFamily(family);
    const wallAlign = normalizeWallAlign(align);
    const label = wallFamily
        .split('_')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
    const face = wallAlign
        .split('_')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
    return {
        technical: `${label} ${face}`,
        alias: `${label} ${face}`,
        genre: genreId,
        kind: 'objects',
        category: 'wall',
        wallFamily,
        wallAlign,
        opaqueAlpha: false
    };
}

/**
 * Four catalog rows for one wall family (AI generate minimum).
 * @param {string} family
 * @param {string} [genreId]
 * @returns {Array<ReturnType<typeof buildWallFaceItem>>}
 */
function buildWallFamilyRoster(family, genreId) {
    const wallFamily = normalizeWallFamily(family);
    /** @type {ReturnType<typeof buildWallFamilyRoster>} */
    const items = [];
    for (let i = 0; i < WALL_ALIGN_SHIPPED.length; i++) {
        items.push(buildWallFaceItem(wallFamily, WALL_ALIGN_SHIPPED[i], genreId));
    }
    return items;
}

/**
 * All 16 full[] faces (4 shipped + 12 extras). Debug / complete tileset.
 * @param {string} family
 * @param {string} [genreId]
 * @returns {Array<ReturnType<typeof buildWallFaceItem>>}
 */
function buildWallFamilyFullRoster(family, genreId) {
    const wallFamily = normalizeWallFamily(family);
    /** @type {ReturnType<typeof buildWallFamilyFullRoster>} */
    const items = [];
    for (let i = 0; i < WALL_ALIGN_ALL.length; i++) {
        items.push(buildWallFaceItem(wallFamily, WALL_ALIGN_ALL[i], genreId));
    }
    return items;
}

/**
 * 4-face roster for `--kind objects --category wall` + wallFamily.
 * `wangFamily` on options is a generate-only alias for wallFamily.
 * @param {{ genre?: string, wallFamily?: string, wangFamily?: string, category?: string|null, exclude?: Iterable<string> }} options
 * @returns {ReturnType<typeof buildWallFamilyRoster>}
 */
function generateWallFamilyRoster(options = {}) {
    const family = options.wallFamily || options.wangFamily || options.category;
    if (!family || String(family).trim().toLowerCase() === 'wall') {
        throw new Error(
            'Wall Wang generate needs a family (e.g. wallFamily: "stone_wall"). ' +
                'category stays "wall".'
        );
    }
    const wallFamily = normalizeWallFamily(family);
    const items = buildWallFamilyRoster(wallFamily, options.genre);
    const exclude = new Set(options.exclude || []);
    const blocked = items.some(
        (it) => exclude.has(it.technical) || exclude.has(wallCatalogId(wallFamily, it.wallAlign))
    );
    if (blocked) {
        throw new Error(
            `Wall family "${wallFamily}" is already on the done list. ` +
                `Clear those four faces first, or pick another wallFamily.`
        );
    }
    return items;
}

module.exports = {
    WALL_ALIGN_SHIPPED,
    WALL_ALIGN_EXTRA,
    WALL_ALIGN_ALL,
    WALL_ALIGN_COUNT,
    WALL_ALIGN_FULL,
    WALL_ALIGN_HALF,
    normalizeWallFamily,
    normalizeWallAlign,
    wallCatalogId,
    parseWallId,
    wallFamilyOf,
    wallAlignOf,
    isWallWang,
    isHopStamp,
    resolveWallAlign,
    familyAlignSet,
    maskForWallAlign,
    buildWallFaceItem,
    buildWallFamilyRoster,
    buildWallFamilyFullRoster,
    generateWallFamilyRoster,
    expandWangRing,
    WANG_MASK_COUNT
};
