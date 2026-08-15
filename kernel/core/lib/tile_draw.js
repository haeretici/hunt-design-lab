/**
 * Tile / prop draw helpers (Phase 6 — client/watch render).
 *
 * Pure geometry for scale + 9-point anchor layout, and y-sort order for
 * tall props vs entities. Used by TileMap terrain cache and EntityMarkers.
 */

'use strict';

/** @type {readonly string[]} */
const ANCHOR_OPTIONS = Object.freeze([
    'top_left',
    'top_center',
    'top_right',
    'middle_left',
    'middle_center',
    'middle_right',
    'bottom_left',
    'bottom_center',
    'bottom_right'
]);

/** Sub-order: lower draws first (behind). Same tileY → props under entities. */
const DRAW_SUB_PROP = 0;
const DRAW_SUB_ENTITY = 1;

/**
 * @param {*} v
 * @param {string} [fallback]
 * @returns {string}
 */
function normalizeAnchor(v, fallback) {
    const s = v != null ? String(v).trim().toLowerCase() : '';
    if (ANCHOR_OPTIONS.indexOf(s) >= 0) return s;
    return fallback || 'middle_center';
}

/**
 * @param {*} v
 * @param {number} lo
 * @param {number} hi
 * @param {number} fallback
 * @returns {number}
 */
function clampScale(v, lo, hi, fallback) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    if (n < lo) return lo;
    if (n > hi) return hi;
    return n;
}

/**
 * Resolve canvas-space draw box for a sprite placed on a tile.
 *
 * Scale is relative to the tile height (matches entity sprite convention):
 *   scaledH = tileH * scale; scaledW preserves image aspect.
 * Anchor is a 9-point grid on the tile rectangle (sprite pivot maps to that point).
 *
 * @param {number} tilePx tile left in canvas px
 * @param {number} tilePy tile top in canvas px
 * @param {number} tileW
 * @param {number} tileH
 * @param {number} imgW source image width
 * @param {number} imgH source image height
 * @param {number} [scale=1]
 * @param {string} [anchor='middle_center']
 * @returns {{ dx: number, dy: number, dw: number, dh: number, scale: number, anchor: string }}
 */
function resolveTileDrawBox(
    tilePx,
    tilePy,
    tileW,
    tileH,
    imgW,
    imgH,
    scale,
    anchor
) {
    const tw = Number(tileW) > 0 ? Number(tileW) : 1;
    const th = Number(tileH) > 0 ? Number(tileH) : 1;
    const iw = Number(imgW) > 0 ? Number(imgW) : tw;
    const ih = Number(imgH) > 0 ? Number(imgH) : th;
    const s = clampScale(scale, 0.05, 8, 1);
    const a = normalizeAnchor(anchor, 'middle_center');

    const dh = th * s;
    const dw = iw * (dh / ih);

    // Pivot on the tile (where the anchor point of the sprite lands)
    let pivotX = tilePx + tw / 2;
    let pivotY = tilePy + th / 2;
    if (a.indexOf('left') >= 0) pivotX = tilePx;
    else if (a.indexOf('right') >= 0) pivotX = tilePx + tw;
    if (a.indexOf('top') === 0) pivotY = tilePy;
    else if (a.indexOf('bottom') === 0) pivotY = tilePy + th;

    // Sprite-local anchor fraction (0..1)
    let ax = 0.5;
    let ay = 0.5;
    if (a.indexOf('left') >= 0) ax = 0;
    else if (a.indexOf('right') >= 0) ax = 1;
    if (a.indexOf('top') === 0) ay = 0;
    else if (a.indexOf('bottom') === 0) ay = 1;

    const dx = pivotX - dw * ax;
    const dy = pivotY - dh * ay;

    return {
        dx,
        dy,
        dw,
        dh,
        scale: s,
        anchor: a
    };
}

/**
 * Sprite-folder name from role / placement (`icon` `small` `retro` …).
 * Empty when unset so callers can fall back to display default.
 *
 * @param {*} v
 * @returns {string}
 */
function normalizeRenderVariant(v) {
    const s = v != null ? String(v).trim().toLowerCase() : '';
    return s ? s.slice(0, 40) : '';
}

/**
 * Resolve scale/anchor/variant for a hybrid palette placement.
 * Placement overrides beat role defaults; kind-based fallback last.
 *
 * @param {object|null|undefined} placement
 * @param {{ render?: { scale?: number, anchor?: string, variant?: string } }|null|undefined} [role]
 * @returns {{ scale: number, anchor: string, kind: string, catalogId: string, variant: string|null }}
 */
function resolvePlacementRender(placement, role) {
    if (!placement || typeof placement !== 'object') {
        return {
            scale: 1,
            anchor: 'middle_center',
            kind: 'tiles',
            catalogId: '',
            variant: null
        };
    }
    const kind =
        placement.kind === 'objects' ||
        placement.kind === 'tiles' ||
        placement.kind === 'overlays'
            ? placement.kind
            : 'tiles';
    const catalogId =
        placement.catalogId != null
            ? String(placement.catalogId)
            : placement.id != null
              ? String(placement.id)
              : '';

    let scale = 1;
    let anchor = kind === 'objects' ? 'bottom_center' : 'middle_center';
    let variant = '';

    if (role && role.render) {
        if (role.render.scale != null && Number.isFinite(Number(role.render.scale))) {
            scale = clampScale(role.render.scale, 0.05, 8, scale);
        }
        if (role.render.anchor) {
            anchor = normalizeAnchor(role.render.anchor, anchor);
        }
        if (role.render.variant) {
            variant = normalizeRenderVariant(role.render.variant);
        }
    }
    if (placement.scale != null && Number.isFinite(Number(placement.scale))) {
        scale = clampScale(placement.scale, 0.05, 8, scale);
    }
    if (placement.anchor != null) {
        anchor = normalizeAnchor(placement.anchor, anchor);
    }
    if (placement.variant != null) {
        const pv = normalizeRenderVariant(placement.variant);
        if (pv) variant = pv;
    }

    return { scale, anchor, kind, catalogId, variant: variant || null };
}

/**
 * Y-sort comparator for mixed prop/entity drawables.
 * Lower sortY first; then subOrder (props under entities); then stable key.
 *
 * @param {{ sortY: number, subOrder?: number, stableKey?: string|number }} a
 * @param {{ sortY: number, subOrder?: number, stableKey?: string|number }} b
 * @returns {number}
 */
function compareDrawOrder(a, b) {
    const ay = Number(a && a.sortY);
    const by = Number(b && b.sortY);
    const aY = Number.isFinite(ay) ? ay : 0;
    const bY = Number.isFinite(by) ? by : 0;
    if (aY !== bY) return aY < bY ? -1 : 1;

    const as = a && a.subOrder != null ? a.subOrder | 0 : 0;
    const bs = b && b.subOrder != null ? b.subOrder | 0 : 0;
    if (as !== bs) return as < bs ? -1 : 1;

    const ak = a && a.stableKey != null ? String(a.stableKey) : '';
    const bk = b && b.stableKey != null ? String(b.stableKey) : '';
    if (ak < bk) return -1;
    if (ak > bk) return 1;
    return 0;
}

/**
 * Sort drawables in place by y-order.
 * @param {Array<{ sortY: number, subOrder?: number, stableKey?: string|number }>} list
 * @returns {typeof list}
 */
function sortDrawables(list) {
    if (!Array.isArray(list) || list.length < 2) return list;
    list.sort(compareDrawOrder);
    return list;
}

/**
 * Collect tall-prop drawables from an authoring TileMap floor (scenery /
 * furniture / vertical only — ground+path stay in the terrain cache).
 *
 * @param {object|null|undefined} floor authoring floor with subLayers + palette
 * @param {{
 *   x0?: number, y0?: number, x1?: number, y1?: number,
 *   z?: string|number,
 *   roleCatalog?: Map<string, object>|Record<string, object>|null
 * }} [opts] inclusive tile region; default whole floor
 * @returns {Array<{
 *   type: 'prop',
 *   tileX: number, tileY: number, tileZ: string|number,
 *   sortY: number, subOrder: number, stableKey: string,
 *   catalogId: string, kind: string, scale: number, anchor: string,
 *   variant: string|null, subLayerId: string, paletteIndex: number
 * }>}
 */
function collectTallPropsFromFloor(floor, opts) {
    /** @type {ReturnType<typeof collectTallPropsFromFloor>} */
    const out = [];
    if (!floor || !Array.isArray(floor.subLayers) || !Array.isArray(floor.palette)) {
        return out;
    }
    const cols = floor.cols | 0;
    const rows = floor.rows | 0;
    if (cols < 1 || rows < 1) return out;

    const o = opts || {};
    const x0 = o.x0 != null ? Math.max(0, Math.floor(o.x0)) : 0;
    const y0 = o.y0 != null ? Math.max(0, Math.floor(o.y0)) : 0;
    const x1 = o.x1 != null ? Math.min(cols - 1, Math.floor(o.x1)) : cols - 1;
    const y1 = o.y1 != null ? Math.min(rows - 1, Math.floor(o.y1)) : rows - 1;
    if (x1 < x0 || y1 < y0) return out;

    const z = o.z != null ? o.z : floor.z != null ? floor.z : 0;
    const roleCatalog = o.roleCatalog || null;

    /** @type {string[]} */
    const TALL_IDS = ['scenery', 'furniture', 'vertical'];

    for (let s = 0; s < floor.subLayers.length; s++) {
        const sl = floor.subLayers[s];
        if (!sl || !sl.cells) continue;
        const sid = String(sl.id || '');
        if (TALL_IDS.indexOf(sid) < 0) continue;
        const cells = sl.cells;
        for (let y = y0; y <= y1; y++) {
            const rowBase = y * cols;
            for (let x = x0; x <= x1; x++) {
                const pIdx = cells[rowBase + x] | 0;
                if (pIdx <= 0 || pIdx >= floor.palette.length) continue;
                const placement = floor.palette[pIdx];
                if (!placement) continue;
                let role = null;
                if (roleCatalog && placement.roleId) {
                    const rid = String(placement.roleId);
                    if (typeof roleCatalog.get === 'function') {
                        role = roleCatalog.get(rid) || null;
                    } else if (roleCatalog[rid]) {
                        role = roleCatalog[rid];
                    }
                }
                const meta = resolvePlacementRender(placement, role);
                if (!meta.catalogId) continue;
                out.push({
                    type: 'prop',
                    tileX: x,
                    tileY: y,
                    tileZ: z,
                    sortY: y,
                    subOrder: DRAW_SUB_PROP,
                    stableKey: `prop:${sid}:${x},${y}`,
                    catalogId: meta.catalogId,
                    kind: meta.kind,
                    scale: meta.scale,
                    anchor: meta.anchor,
                    variant: meta.variant,
                    subLayerId: sid,
                    paletteIndex: pIdx
                });
            }
        }
    }
    return out;
}

/**
 * Terrain sub-layer ids (baked into floor cache, not y-sorted).
 * @type {readonly string[]}
 */
const TERRAIN_SUB_LAYER_IDS = Object.freeze(['ground', 'path']);

/**
 * Tall prop sub-layer ids (y-sorted with entities).
 * @type {readonly string[]}
 */
const TALL_PROP_SUB_LAYER_IDS = Object.freeze([
    'scenery',
    'furniture',
    'vertical'
]);

module.exports = {
    ANCHOR_OPTIONS,
    DRAW_SUB_PROP,
    DRAW_SUB_ENTITY,
    TERRAIN_SUB_LAYER_IDS,
    TALL_PROP_SUB_LAYER_IDS,
    normalizeAnchor,
    normalizeRenderVariant,
    clampScale,
    resolveTileDrawBox,
    resolvePlacementRender,
    compareDrawOrder,
    sortDrawables,
    collectTallPropsFromFloor
};
