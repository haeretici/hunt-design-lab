/**
 * Map editor single-canvas viewport (Phase 8 + polish).
 *
 * Session / hybrid channels remain the source of truth. This module owns only
 * view state: dirty flags, visibility, coord transforms, and composite paint
 * order for one display surface (plus optional detached RGBA caches).
 *
 * Polish:
 * - terrainCache = ground+path only; tall props via tile_draw (scale/anchor)
 * - presentView blits map-space world → viewport-sized display
 * - spawns/tools drawn as overlay passes on the same display (page-owned)
 *
 * No DOM — unit-testable with a mock 2d context.
 */

'use strict';

const {
    ROLE_PREVIEW_COLORS,
    frictionPreviewColor,
    flagsPreviewColor
} = require('./tilemap_editor.js');
const {
    resolveTileDrawBox,
    resolvePlacementRender,
    collectTallPropsFromFloor,
    TERRAIN_SUB_LAYER_IDS,
    TALL_PROP_SUB_LAYER_IDS
} = require('../tile_draw.js');

/** Default: show catalog icon tiles from 800% zoom upward (adjustable). */
const DEFAULT_SPRITE_ZOOM_MIN = 8;

/**
 * Extra tiles around a dirty brush AABB when *redrawing* tall props.
 * Trees/stairs overhang neighboring map pixels; after clearRect those
 * neighbors must be stamped again. This pad is for draw, not list eviction —
 * painting path/ground does not change adjacent scenery/vertical cells.
 */
const TALL_PROP_OVERHANG_TILES = 2;

/** Composite world passes (bottom → top). Spawns/tools are display overlay. */
const COMPOSITE_PASSES = Object.freeze([
    'base', // path PNG bootstrap or solid dark
    'friction',
    'tilemap', // terrain (ground+path) + tall props
    'fields',
    'flags',
    'sight'
]);

const DEBUG_CHANNELS = Object.freeze(['friction', 'sight', 'flags', 'fields']);

const TILEMAP_SUB_LAYER_IDS = Object.freeze([
    'ground',
    'path',
    'scenery',
    'furniture',
    'vertical'
]);

/**
 * @param {string} hex
 * @returns {{ r: number, g: number, b: number }|null}
 */
function parseHexColor(hex) {
    if (!hex || typeof hex !== 'string') return null;
    let h = hex[0] === '#' ? hex.slice(1) : hex;
    if (h.length === 3) {
        h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    }
    if (h.length !== 6) return null;
    const n = parseInt(h, 16);
    if (!Number.isFinite(n)) return null;
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/**
 * @param {string} hex
 * @param {number} alpha 0–255
 * @param {Map<string, { r: number, g: number, b: number, a: number }>} cache
 */
function hexToRgbaCached(hex, alpha, cache) {
    const key = hex + '|' + (alpha | 0);
    let c = cache.get(key);
    if (c) return c;
    const p = parseHexColor(hex) || { r: 128, g: 128, b: 128 };
    c = { r: p.r, g: p.g, b: p.b, a: alpha | 0 };
    cache.set(key, c);
    return c;
}

/**
 * Default visibility for one floor (all on).
 * @returns {Record<string, boolean>}
 */
function defaultVisibility() {
    /** @type {Record<string, boolean>} */
    const v = {
        floor: true,
        friction: true,
        sight: true,
        flags: true,
        fields: true,
        tilemap: true,
        spawns: true
    };
    for (let i = 0; i < TILEMAP_SUB_LAYER_IDS.length; i++) {
        v['tilemap-' + TILEMAP_SUB_LAYER_IDS[i]] = true;
    }
    return v;
}

/**
 * @param {Record<string, boolean>|null|undefined} vis
 * @param {string} key
 * @returns {boolean}
 */
function isVis(vis, key) {
    if (!vis) return true;
    if (vis.floor === false) return false;
    return vis[key] !== false;
}

/**
 * Which composite passes run for a visibility map (ordered, bottom → top).
 * @param {Record<string, boolean>|null|undefined} visibility
 * @param {{ hasBase?: boolean, hasSession?: boolean }} [opts]
 * @returns {string[]}
 */
function listCompositePasses(visibility, opts) {
    const o = opts || {};
    const out = [];
    const hasSession = o.hasSession === true;
    const hasBase = o.hasBase === true;
    // Path PNG base only when browsing without a session (spawns-only).
    // With a session, friction arrays are the authoritative underlay.
    if (hasBase && !hasSession && isVis(visibility, 'friction')) {
        out.push('base');
    } else if (hasSession && isVis(visibility, 'friction')) {
        out.push('friction');
    } else if (hasBase && isVis(visibility, 'friction')) {
        // Session missing but base present (edge): still show path
        out.push('base');
    }
    if (isVis(visibility, 'tilemap') && hasSession) out.push('tilemap');
    if (isVis(visibility, 'fields') && hasSession) out.push('fields');
    if (isVis(visibility, 'flags') && hasSession) out.push('flags');
    if (isVis(visibility, 'sight') && hasSession) out.push('sight');
    return out;
}

/**
 * Porter-Duff source-over: blend `src` onto `dest` (both packed RGBA, same pixel count).
 * src alpha 0 leaves dest unchanged — critical: putImageData alone would wipe underlays.
 *
 * @param {Uint8ClampedArray|Uint8Array|ArrayLike<number>} dest
 * @param {Uint8ClampedArray|Uint8Array|ArrayLike<number>} src
 * @param {number} pixelCount
 */
function alphaOverRgba(dest, src, pixelCount) {
    const n = pixelCount | 0;
    for (let i = 0; i < n; i++) {
        const p = i * 4;
        const sa = src[p + 3] & 0xff;
        if (sa === 0) continue;
        if (sa === 255) {
            dest[p] = src[p];
            dest[p + 1] = src[p + 1];
            dest[p + 2] = src[p + 2];
            dest[p + 3] = 255;
            continue;
        }
        const da = dest[p + 3] & 0xff;
        if (da === 0) {
            dest[p] = src[p];
            dest[p + 1] = src[p + 1];
            dest[p + 2] = src[p + 2];
            dest[p + 3] = sa;
            continue;
        }
        // outA = sa + da * (1 - sa/255)
        const inv = 255 - sa;
        const outA = sa + (((da * inv + 127) / 255) | 0);
        if (outA <= 0) {
            dest[p] = 0;
            dest[p + 1] = 0;
            dest[p + 2] = 0;
            dest[p + 3] = 0;
            continue;
        }
        // outC = (srcC*sa + dstC*da*(1-sa)) / outA
        const dScale = ((da * inv + 127) / 255) | 0;
        dest[p] = (((src[p] * sa + dest[p] * dScale) / outA) | 0) & 0xff;
        dest[p + 1] = (((src[p + 1] * sa + dest[p + 1] * dScale) / outA) | 0) & 0xff;
        dest[p + 2] = (((src[p + 2] * sa + dest[p + 2] * dScale) / outA) | 0) & 0xff;
        dest[p + 3] = outA > 255 ? 255 : outA;
    }
}

/**
 * Friction channel → RGBA (matches legacy path PNG / editor swatches).
 * @param {Uint8Array|ArrayLike<number>} friction
 * @param {number} cols
 * @param {number} rows
 * @param {{ x0?: number, y0?: number, x1?: number, y1?: number }} [rect]
 * @param {Uint8ClampedArray|Uint8Array} [out] optional target (w*h*4)
 * @returns {{ data: Uint8ClampedArray|Uint8Array, width: number, height: number, x0: number, y0: number }}
 */
function fillFrictionRgba(friction, cols, rows, rect, out) {
    const x0 = rect && rect.x0 != null ? Math.max(0, rect.x0 | 0) : 0;
    const y0 = rect && rect.y0 != null ? Math.max(0, rect.y0 | 0) : 0;
    const x1 = rect && rect.x1 != null ? Math.min(cols - 1, rect.x1 | 0) : cols - 1;
    const y1 = rect && rect.y1 != null ? Math.min(rows - 1, rect.y1 | 0) : rows - 1;
    const w = Math.max(0, x1 - x0 + 1);
    const h = Math.max(0, y1 - y0 + 1);
    const data =
        out && out.length >= w * h * 4
            ? out
            : typeof Uint8ClampedArray !== 'undefined'
              ? new Uint8ClampedArray(w * h * 4)
              : new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y0 + y) * cols + (x0 + x);
            const p = (y * w + x) * 4;
            const v = friction[i] & 0xff;
            if (v === 255) {
                data[p] = 255;
                data[p + 1] = 255;
                data[p + 2] = 0;
                data[p + 3] = 255;
            } else {
                data[p] = v;
                data[p + 1] = v;
                data[p + 2] = v;
                data[p + 3] = 255;
            }
        }
    }
    return { data, width: w, height: h, x0, y0 };
}

/**
 * @param {Uint8Array|ArrayLike<number>} sight
 * @param {number} cols
 * @param {number} rows
 * @param {{ x0?: number, y0?: number, x1?: number, y1?: number }} [rect]
 * @param {Uint8ClampedArray|Uint8Array} [out]
 */
function fillSightRgba(sight, cols, rows, rect, out) {
    const x0 = rect && rect.x0 != null ? Math.max(0, rect.x0 | 0) : 0;
    const y0 = rect && rect.y0 != null ? Math.max(0, rect.y0 | 0) : 0;
    const x1 = rect && rect.x1 != null ? Math.min(cols - 1, rect.x1 | 0) : cols - 1;
    const y1 = rect && rect.y1 != null ? Math.min(rows - 1, rect.y1 | 0) : rows - 1;
    const w = Math.max(0, x1 - x0 + 1);
    const h = Math.max(0, y1 - y0 + 1);
    const data =
        out && out.length >= w * h * 4
            ? out
            : typeof Uint8ClampedArray !== 'undefined'
              ? new Uint8ClampedArray(w * h * 4)
              : new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y0 + y) * cols + (x0 + x);
            const p = (y * w + x) * 4;
            const v = sight[i] & 0xff;
            data[p] = v;
            data[p + 1] = v;
            data[p + 2] = v;
            // Dim overlay so TileMap remains readable (no CSS mix-blend-mode).
            data[p + 3] = v ? 140 : 0;
        }
    }
    return { data, width: w, height: h, x0, y0 };
}

/**
 * @param {Uint8Array|ArrayLike<number>} flags
 * @param {number} cols
 * @param {number} rows
 * @param {{ x0?: number, y0?: number, x1?: number, y1?: number }} [rect]
 * @param {Uint8ClampedArray|Uint8Array} [out]
 * @param {Map} [colorCache]
 */
function fillFlagsRgba(flags, cols, rows, rect, out, colorCache) {
    const cache = colorCache || new Map();
    const x0 = rect && rect.x0 != null ? Math.max(0, rect.x0 | 0) : 0;
    const y0 = rect && rect.y0 != null ? Math.max(0, rect.y0 | 0) : 0;
    const x1 = rect && rect.x1 != null ? Math.min(cols - 1, rect.x1 | 0) : cols - 1;
    const y1 = rect && rect.y1 != null ? Math.min(rows - 1, rect.y1 | 0) : rows - 1;
    const w = Math.max(0, x1 - x0 + 1);
    const h = Math.max(0, y1 - y0 + 1);
    const data =
        out && out.length >= w * h * 4
            ? out
            : typeof Uint8ClampedArray !== 'undefined'
              ? new Uint8ClampedArray(w * h * 4)
              : new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y0 + y) * cols + (x0 + x);
            const p = (y * w + x) * 4;
            const bits = flags[i] & 0xff;
            if (!bits) {
                data[p] = 0;
                data[p + 1] = 0;
                data[p + 2] = 0;
                data[p + 3] = 0;
                continue;
            }
            const hex = flagsPreviewColor(bits);
            const c = hexToRgbaCached(hex, 200, cache);
            data[p] = c.r;
            data[p + 1] = c.g;
            data[p + 2] = c.b;
            data[p + 3] = c.a;
        }
    }
    return { data, width: w, height: h, x0, y0 };
}

/**
 * @param {Uint8Array|ArrayLike<number>} fields
 * @param {number} cols
 * @param {number} rows
 * @param {{ x0?: number, y0?: number, x1?: number, y1?: number }} [rect]
 * @param {Uint8ClampedArray|Uint8Array} [out]
 */
function fillFieldsRgba(fields, cols, rows, rect, out) {
    const x0 = rect && rect.x0 != null ? Math.max(0, rect.x0 | 0) : 0;
    const y0 = rect && rect.y0 != null ? Math.max(0, rect.y0 | 0) : 0;
    const x1 = rect && rect.x1 != null ? Math.min(cols - 1, rect.x1 | 0) : cols - 1;
    const y1 = rect && rect.y1 != null ? Math.min(rows - 1, rect.y1 | 0) : rows - 1;
    const w = Math.max(0, x1 - x0 + 1);
    const h = Math.max(0, y1 - y0 + 1);
    const data =
        out && out.length >= w * h * 4
            ? out
            : typeof Uint8ClampedArray !== 'undefined'
              ? new Uint8ClampedArray(w * h * 4)
              : new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y0 + y) * cols + (x0 + x);
            const p = (y * w + x) * 4;
            const v = fields[i] & 0xff;
            if (!v) {
                data[p] = 0;
                data[p + 1] = 0;
                data[p + 2] = 0;
                data[p + 3] = 0;
            } else if (v === 1) {
                data[p] = 255;
                data[p + 1] = 136;
                data[p + 2] = 0;
                data[p + 3] = 200;
            } else if (v === 2) {
                data[p] = 0;
                data[p + 1] = 204;
                data[p + 2] = 0;
                data[p + 3] = 200;
            } else if (v === 4) {
                data[p] = 170;
                data[p + 1] = 0;
                data[p + 2] = 255;
                data[p + 3] = 200;
            } else {
                data[p] = 255;
                data[p + 1] = 255;
                data[p + 2] = 255;
                data[p + 3] = 180;
            }
        }
    }
    return { data, width: w, height: h, x0, y0 };
}

/**
 * TileMap role-preview composite.
 *
 * Modes:
 * - `terrain` (default for cache): ground then path stack (path on top). Tall props
 *   are drawn separately via tile_draw (scale/anchor).
 * - `topmost`: topmost non-empty sub-layer (legacy flat preview / export).
 *
 * @param {{
 *   cols: number,
 *   rows: number,
 *   floor?: object,
 *   previewColorAt?: (x: number, y: number) => string|null,
 *   subLayerVisible?: (id: string) => boolean,
 *   mode?: 'terrain'|'topmost'
 * }} src
 * @param {{ x0?: number, y0?: number, x1?: number, y1?: number }} [rect]
 * @param {Uint8ClampedArray|Uint8Array} [out]
 * @param {Map} [colorCache]
 */
function fillTileMapRgba(src, rect, out, colorCache) {
    const cols = src.cols | 0;
    const rows = src.rows | 0;
    const x0 = rect && rect.x0 != null ? Math.max(0, rect.x0 | 0) : 0;
    const y0 = rect && rect.y0 != null ? Math.max(0, rect.y0 | 0) : 0;
    const x1 = rect && rect.x1 != null ? Math.min(cols - 1, rect.x1 | 0) : cols - 1;
    const y1 = rect && rect.y1 != null ? Math.min(rows - 1, rect.y1 | 0) : rows - 1;
    const w = Math.max(0, x1 - x0 + 1);
    const h = Math.max(0, y1 - y0 + 1);
    const data =
        out && out.length >= w * h * 4
            ? out
            : typeof Uint8ClampedArray !== 'undefined'
              ? new Uint8ClampedArray(w * h * 4)
              : new Uint8Array(w * h * 4);
    const cache = colorCache || new Map();
    const floor = src.floor;
    const subVis = src.subLayerVisible;
    const mode = src.mode === 'topmost' ? 'topmost' : 'terrain';

    /** @type {Map<string, object>|null} */
    let subById = null;
    if (floor && Array.isArray(floor.subLayers)) {
        subById = new Map();
        for (let s = 0; s < floor.subLayers.length; s++) {
            const sl = floor.subLayers[s];
            if (sl && sl.id) subById.set(String(sl.id), sl);
        }
    }

    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const mx = x0 + x;
            const my = y0 + y;
            const p = (y * w + x) * 4;
            let col = null;
            if (floor && floor.subLayers && floor.palette && subById) {
                if (mode === 'terrain') {
                    // ground → path stack
                    for (let t = 0; t < TERRAIN_SUB_LAYER_IDS.length; t++) {
                        const sid = TERRAIN_SUB_LAYER_IDS[t];
                        if (subVis && !subVis(sid)) continue;
                        const sl = subById.get(sid);
                        if (!sl || !sl.cells) continue;
                        const pi = sl.cells[my * cols + mx] & 0xffff;
                        if (!pi) continue;
                        const ent = floor.palette[pi];
                        if (!ent) continue;
                        const rid = ent.roleId || null;
                        col = ROLE_PREVIEW_COLORS[rid] || '#888888';
                    }
                } else {
                    // topmost across all sub-layers (vertical last in array)
                    for (let s = floor.subLayers.length - 1; s >= 0; s--) {
                        const sl = floor.subLayers[s];
                        if (subVis && !subVis(sl.id)) continue;
                        const pi = sl.cells[my * cols + mx] & 0xffff;
                        if (!pi) continue;
                        const ent = floor.palette[pi];
                        if (!ent) continue;
                        const rid = ent.roleId || null;
                        col = ROLE_PREVIEW_COLORS[rid] || '#888888';
                        break;
                    }
                }
            } else if (typeof src.previewColorAt === 'function') {
                col = src.previewColorAt(mx, my);
            }
            if (!col) {
                data[p] = 0;
                data[p + 1] = 0;
                data[p + 2] = 0;
                data[p + 3] = 0;
            } else {
                const c = hexToRgbaCached(col, 220, cache);
                data[p] = c.r;
                data[p + 1] = c.g;
                data[p + 2] = c.b;
                data[p + 3] = c.a;
            }
        }
    }
    return { data, width: w, height: h, x0, y0 };
}

/**
 * Inclusive map-space rect union, clamped to [0,cols)×[0,rows).
 * Null args mean "no prior rect"; both null → null.
 * @param {{ x0: number, y0: number, x1: number, y1: number }|null|undefined} a
 * @param {{ x0: number, y0: number, x1: number, y1: number }|null|undefined} b
 * @param {number} cols
 * @param {number} rows
 * @returns {{ x0: number, y0: number, x1: number, y1: number }|null}
 */
function unionMapRect(a, b, cols, rows) {
    const c = cols | 0;
    const r = rows | 0;
    if (!a && !b) return null;
    if (!a) return clampMapRect(b, c, r);
    if (!b) return clampMapRect(a, c, r);
    const u = {
        x0: Math.min(a.x0 | 0, b.x0 | 0),
        y0: Math.min(a.y0 | 0, b.y0 | 0),
        x1: Math.max(a.x1 | 0, b.x1 | 0),
        y1: Math.max(a.y1 | 0, b.y1 | 0)
    };
    return clampMapRect(u, c, r);
}

/**
 * @param {{ x0: number, y0: number, x1: number, y1: number }|null|undefined} rect
 * @param {number} cols
 * @param {number} rows
 * @returns {{ x0: number, y0: number, x1: number, y1: number }|null}
 */
function clampMapRect(rect, cols, rows) {
    if (!rect) return null;
    const c = cols | 0;
    const r = rows | 0;
    if (c <= 0 || r <= 0) return null;
    const x0 = Math.max(0, Math.min(c - 1, rect.x0 | 0));
    const y0 = Math.max(0, Math.min(r - 1, rect.y0 | 0));
    const x1 = Math.max(0, Math.min(c - 1, rect.x1 | 0));
    const y1 = Math.max(0, Math.min(r - 1, rect.y1 | 0));
    if (x1 < x0 || y1 < y0) return null;
    return { x0, y0, x1, y1 };
}

/**
 * Visible map-tile rectangle for a viewport-sized display (CSS zoom + scroll pan).
 * Inclusive x0/y0/x1/y1; clamped to map; may be empty (x1 < x0).
 *
 * @param {number} cols
 * @param {number} rows
 * @param {number} scrollLeft
 * @param {number} scrollTop
 * @param {number} viewWidth display canvas CSS/client width in px
 * @param {number} viewHeight
 * @param {number} zoom map-px → screen-px scale
 * @param {number} [pad=1] extra tiles around edges for tall-prop overhang
 * @returns {{ x0: number, y0: number, x1: number, y1: number, mapX: number, mapY: number, mapW: number, mapH: number }}
 */
function visibleMapRect(cols, rows, scrollLeft, scrollTop, viewWidth, viewHeight, zoom, pad) {
    const z = zoom > 0 ? +zoom : 1;
    const mapX = (scrollLeft | 0) / z;
    const mapY = (scrollTop | 0) / z;
    const mapW = Math.max(0, (viewWidth | 0) / z);
    const mapH = Math.max(0, (viewHeight | 0) / z);
    const p = pad != null ? pad | 0 : 1;
    const x0 = Math.max(0, Math.floor(mapX) - p);
    const y0 = Math.max(0, Math.floor(mapY) - p);
    const x1 = Math.min((cols | 0) - 1, Math.ceil(mapX + mapW) + p);
    const y1 = Math.min((rows | 0) - 1, Math.ceil(mapY + mapH) + p);
    return { x0, y0, x1, y1, mapX, mapY, mapW, mapH };
}

/**
 * Whether catalog icon sprites should overpaint the display at this zoom.
 * - `minZoom` null / false / Infinity → off
 * - `minZoom` ≤ 0 → always on (any positive zoom)
 * - else on when `zoom >= minZoom` (e.g. 8 = 800%)
 *
 * @param {number} zoom
 * @param {number|null|false|undefined} minZoom
 * @returns {boolean}
 */
function shouldShowTileSprites(zoom, minZoom) {
    if (minZoom == null || minZoom === false) return false;
    const m = +minZoom;
    if (!Number.isFinite(m) || m === Infinity) return false;
    const z = zoom > 0 ? +zoom : 0;
    if (!(z > 0)) return false;
    if (m <= 0) return true;
    return z >= m;
}

/**
 * Normalize persisted / UI sprite-zoom threshold.
 * Accepts number, numeric string, "off", "always".
 * @param {*} raw
 * @param {number} [fallback=DEFAULT_SPRITE_ZOOM_MIN]
 * @returns {number|null} null = off; 0 = always; else min zoom factor
 */
function normalizeSpriteZoomMin(raw, fallback) {
    const fb =
        fallback != null && Number.isFinite(+fallback)
            ? +fallback
            : DEFAULT_SPRITE_ZOOM_MIN;
    if (raw == null || raw === false || raw === '') return null;
    if (raw === true) return 0;
    if (typeof raw === 'string') {
        const s = raw.trim().toLowerCase();
        if (s === 'off' || s === 'never' || s === 'none') return null;
        if (s === 'always' || s === 'on') return 0;
    }
    const n = +raw;
    if (!Number.isFinite(n)) return fb;
    if (n < 0 || n === Infinity) return null;
    return n;
}

/**
 * Draw authoring ground/path (+ optional tall props) as catalog **icon** sprites
 * in **display/screen space** for the visible viewport only.
 *
 * World buffer stays 1 map-px per tile (role colors). At high zoom this overpaints
 * sharp 32×32 icons without rebuilding a multi-px world (floor-07 is 2560×2048).
 *
 * @param {{
 *   drawImage?: Function,
 *   fillRect?: Function,
 *   fillStyle?: *,
 *   imageSmoothingEnabled?: boolean
 * }} ctx display 2d context
 * @param {{
 *   floor: object,
 *   cols: number,
 *   rows: number,
 *   scrollLeft: number,
 *   scrollTop: number,
 *   zoom: number,
 *   viewWidth: number,
 *   viewHeight: number,
 *   getImage: ((catalogId: string, kind: string, variant?: string|null) => *)|null,
 *   subLayerVisible?: (id: string) => boolean,
 *   roleForPlacement?: ((placement: object) => object|null)|null,
 *   props?: Array<object>|null,
 *   pad?: number,
 *   drawTerrain?: boolean,
 *   drawProps?: boolean
 * }} opts
 * @returns {{ terrain: number, props: number, pending: number }}
 */
function drawAuthoringSpritesDisplay(ctx, opts) {
    const o = opts || {};
    const out = { terrain: 0, props: 0, pending: 0 };
    if (!ctx || typeof ctx.drawImage !== 'function') return out;
    const floor = o.floor;
    const cols = o.cols | 0;
    const rows = o.rows | 0;
    const z = o.zoom != null && o.zoom > 0 ? +o.zoom : 0;
    if (!floor || !cols || !rows || !(z > 0)) return out;
    const getImage = typeof o.getImage === 'function' ? o.getImage : null;
    if (!getImage) return out;

    const sl = o.scrollLeft != null ? +o.scrollLeft : 0;
    const st = o.scrollTop != null ? +o.scrollTop : 0;
    const vw = o.viewWidth | 0;
    const vh = o.viewHeight | 0;
    if (vw < 1 || vh < 1) return out;

    const pad = o.pad != null ? o.pad | 0 : 1;
    const vis = visibleMapRect(cols, rows, sl, st, vw, vh, z, pad);
    if (vis.x1 < vis.x0 || vis.y1 < vis.y0) return out;

    try {
        ctx.imageSmoothingEnabled = false;
    } catch (_e) {
        /* mock */
    }

    const subVis = typeof o.subLayerVisible === 'function' ? o.subLayerVisible : null;
    const roleFor =
        typeof o.roleForPlacement === 'function' ? o.roleForPlacement : null;
    const palette = floor.palette || [];
    /** @type {Map<string, object>|null} */
    let subById = null;
    if (Array.isArray(floor.subLayers)) {
        subById = new Map();
        for (let s = 0; s < floor.subLayers.length; s++) {
            const slayer = floor.subLayers[s];
            if (slayer && slayer.id) subById.set(String(slayer.id), slayer);
        }
    }

    const drawTerrain = o.drawTerrain !== false;
    if (drawTerrain && subById) {
        for (let my = vis.y0; my <= vis.y1; my++) {
            for (let mx = vis.x0; mx <= vis.x1; mx++) {
                const tilePx = mx * z - sl;
                const tilePy = my * z - st;
                for (let t = 0; t < TERRAIN_SUB_LAYER_IDS.length; t++) {
                    const sid = TERRAIN_SUB_LAYER_IDS[t];
                    if (subVis && !subVis(sid)) continue;
                    const slayer = subById.get(sid);
                    if (!slayer || !slayer.cells) continue;
                    const pi = slayer.cells[my * cols + mx] & 0xffff;
                    if (!pi || pi >= palette.length) continue;
                    const placement = palette[pi];
                    if (!placement) continue;
                    const role = roleFor ? roleFor(placement) : null;
                    const meta = resolvePlacementRender(placement, role);
                    if (!meta.catalogId) continue;
                    const img = getImage(meta.catalogId, meta.kind, meta.variant);
                    if (!img) {
                        out.pending++;
                        continue;
                    }
                    const iw = img.naturalWidth || img.width || z;
                    const ih = img.naturalHeight || img.height || z;
                    const box = resolveTileDrawBox(
                        tilePx,
                        tilePy,
                        z,
                        z,
                        iw,
                        ih,
                        meta.scale,
                        meta.anchor
                    );
                    try {
                        ctx.drawImage(img, box.dx, box.dy, box.dw, box.dh);
                        out.terrain++;
                    } catch (_e) {
                        /* skip broken image */
                    }
                }
            }
        }
    }

    const drawProps = o.drawProps !== false;
    const props = drawProps && Array.isArray(o.props) ? o.props : null;
    if (props && props.length) {
        for (let i = 0; i < props.length; i++) {
            const prop = props[i];
            if (!prop) continue;
            if (subVis && prop.subLayerId && !subVis(prop.subLayerId)) continue;
            const tx = prop.tileX | 0;
            const ty = prop.tileY | 0;
            if (tx < vis.x0 || tx > vis.x1 || ty < vis.y0 || ty > vis.y1) continue;
            if (!prop.catalogId) continue;
            const img = getImage(prop.catalogId, prop.kind, prop.variant);
            if (!img) {
                out.pending++;
                continue;
            }
            const tilePx = tx * z - sl;
            const tilePy = ty * z - st;
            const iw = img.naturalWidth || img.width || z;
            const ih = img.naturalHeight || img.height || z;
            const box = resolveTileDrawBox(
                tilePx,
                tilePy,
                z,
                z,
                iw,
                ih,
                prop.scale,
                prop.anchor
            );
            try {
                ctx.drawImage(img, box.dx, box.dy, box.dw, box.dh);
                out.props++;
            } catch (_e) {
                /* skip */
            }
        }
    }

    return out;
}

/**
 * Draw tall props (scenery/furniture/vertical) in **map pixel space** (1 tile = 1 px).
 * Uses tile_draw resolveTileDrawBox for scale/anchor. Optional getImage for sprites.
 *
 * @param {{
 *   fillRect?: Function,
 *   drawImage?: Function,
 *   fillStyle?: *
 * }} ctx
 * @param {Array<object>} props from collectTallPropsFromFloor
 * @param {{
 *   getImage?: ((catalogId: string, kind: string, variant?: string|null) => *)|null,
 *   roleColor?: ((prop: object) => string|null)|null,
 *   subLayerVisible?: (id: string) => boolean,
 *   tileSize?: number
 * }} [opts]
 * @returns {number} drawn count
 */
function drawTallPropsMapSpace(ctx, props, opts) {
    if (!ctx || !Array.isArray(props) || !props.length) return 0;
    const o = opts || {};
    const getImage = typeof o.getImage === 'function' ? o.getImage : null;
    const roleColor = typeof o.roleColor === 'function' ? o.roleColor : null;
    const subVis = typeof o.subLayerVisible === 'function' ? o.subLayerVisible : null;
    const ts = o.tileSize != null && o.tileSize > 0 ? +o.tileSize : 1;
    let n = 0;
    for (let i = 0; i < props.length; i++) {
        const prop = props[i];
        if (!prop) continue;
        if (subVis && prop.subLayerId && !subVis(prop.subLayerId)) continue;
        const tilePx = prop.tileX * ts;
        const tilePy = prop.tileY * ts;
        const img = getImage
            ? getImage(prop.catalogId, prop.kind, prop.variant)
            : null;
        if (img && typeof ctx.drawImage === 'function') {
            const iw = img.naturalWidth || img.width || ts;
            const ih = img.naturalHeight || img.height || ts;
            const box = resolveTileDrawBox(
                tilePx,
                tilePy,
                ts,
                ts,
                iw,
                ih,
                prop.scale,
                prop.anchor
            );
            try {
                ctx.drawImage(img, box.dx, box.dy, box.dw, box.dh);
                n++;
                continue;
            } catch (_e) {
                // fall through to color placeholder
            }
        }
        // Role-color box with correct scale/anchor footprint
        const box = resolveTileDrawBox(tilePx, tilePy, ts, ts, ts, ts, prop.scale, prop.anchor);
        let hex = roleColor ? roleColor(prop) : null;
        if (!hex) {
            hex = '#888888';
        }
        if (typeof ctx.fillRect === 'function') {
            ctx.fillStyle = hex;
            ctx.fillRect(box.dx, box.dy, box.dw, box.dh);
            n++;
        }
    }
    return n;
}

/**
 * Blit a map-space world surface into a viewport-sized display context.
 * World is 1 map-pixel per tile; display applies zoom + scroll pan.
 *
 * @param {{
 *   clearRect?: Function,
 *   drawImage?: Function,
 *   imageSmoothingEnabled?: boolean
 * }} displayCtx
 * @param {*} worldCanvas canvas / ImageBitmap with map-space pixels
 * @param {{
 *   viewWidth: number,
 *   viewHeight: number,
 *   scrollLeft?: number,
 *   scrollTop?: number,
 *   zoom?: number,
 *   overlay?: (ctx: *, info: object) => void
 * }} opts
 * @returns {{ painted: boolean, mapX: number, mapY: number, mapW: number, mapH: number }}
 */
function presentView(displayCtx, worldCanvas, opts) {
    const o = opts || {};
    const vw = o.viewWidth | 0;
    const vh = o.viewHeight | 0;
    const z = o.zoom != null && o.zoom > 0 ? +o.zoom : 1;
    const sl = o.scrollLeft != null ? +o.scrollLeft : 0;
    const st = o.scrollTop != null ? +o.scrollTop : 0;
    if (!displayCtx || !worldCanvas || vw < 1 || vh < 1) {
        return { painted: false, mapX: 0, mapY: 0, mapW: 0, mapH: 0 };
    }
    const mapX = sl / z;
    const mapY = st / z;
    const mapW = vw / z;
    const mapH = vh / z;
    if (typeof displayCtx.clearRect === 'function') {
        displayCtx.clearRect(0, 0, vw, vh);
    }
    if (typeof displayCtx.drawImage === 'function') {
        try {
            displayCtx.imageSmoothingEnabled = false;
        } catch (_e) {
            /* mock */
        }
        try {
            displayCtx.drawImage(worldCanvas, mapX, mapY, mapW, mapH, 0, 0, vw, vh);
        } catch (_e) {
            return { painted: false, mapX, mapY, mapW, mapH };
        }
    }
    const info = { zoom: z, scrollLeft: sl, scrollTop: st, mapX, mapY, mapW, mapH, viewWidth: vw, viewHeight: vh };
    if (typeof o.overlay === 'function') {
        o.overlay(displayCtx, info);
    }
    return { painted: true, mapX, mapY, mapW, mapH };
}

/**
 * Decode path-PNG style friction colors → channel bytes (legacy bootstrap).
 * Same rules as the wiki editor PNG→session path.
 * @param {Uint8ClampedArray|Uint8Array|ArrayLike<number>} rgba
 * @param {number} cols
 * @param {number} rows
 * @param {{ noCastBit?: number }} [opts]
 * @returns {{ friction: Uint8Array, sight: Uint8Array, flags: Uint8Array, fields: Uint8Array }}
 */
function decodeFrictionRgbaToChannels(rgba, cols, rows, opts) {
    const n = cols * rows;
    const friction = new Uint8Array(n);
    const sight = new Uint8Array(n);
    const flags = new Uint8Array(n);
    const fields = new Uint8Array(n);
    const noCast = (opts && opts.noCastBit) != null ? opts.noCastBit | 0 : 1;
    for (let i = 0; i < n; i++) {
        const p = i * 4;
        const r = rgba[p],
            g = rgba[p + 1],
            b = rgba[p + 2];
        if (r === 255 && g === 255 && b === 0) {
            friction[i] = 255;
            sight[i] = 255;
        } else if (r === 0 && g === 255 && b === 255) {
            friction[i] = 255;
            sight[i] = 0;
        } else if (r === 255 && g === 0 && b === 255) {
            friction[i] = 100;
            sight[i] = 255;
        } else if (r === 0 && g === 255 && b === 0) {
            friction[i] = 100;
            sight[i] = 0;
            flags[i] = noCast;
        } else if (r === g && g === b && r !== 255) {
            friction[i] = r > 250 ? 250 : r;
        } else {
            friction[i] = 255;
            sight[i] = 255;
        }
    }
    return { friction, sight, flags, fields };
}

/**
 * Map ↔ screen helpers (CSS zoom + scroll pan, 1 map pixel = 1 tile).
 * @param {number} clientX
 * @param {number} clientY
 * @param {{ left: number, top: number }} viewRect getBoundingClientRect of scroll host
 * @param {{ scrollLeft: number, scrollTop: number }} scroll
 * @param {number} zoom
 * @returns {{ x: number, y: number }}
 */
function clientToMap(clientX, clientY, viewRect, scroll, zoom) {
    const z = zoom > 0 ? zoom : 1;
    return {
        x: (clientX - viewRect.left + scroll.scrollLeft) / z,
        y: (clientY - viewRect.top + scroll.scrollTop) / z
    };
}

/**
 * @param {number} mapX
 * @param {number} mapY
 * @param {{ scrollLeft: number, scrollTop: number }} scroll
 * @param {number} zoom
 * @returns {{ x: number, y: number }}
 */
function mapToScreen(mapX, mapY, scroll, zoom) {
    const z = zoom > 0 ? zoom : 1;
    return {
        x: mapX * z - scroll.scrollLeft,
        y: mapY * z - scroll.scrollTop
    };
}

/**
 * @typedef {object} DirtyFlags
 * @property {boolean} terrain
 * @property {boolean} props
 * @property {boolean} debug
 * @property {boolean} spawns
 * @property {boolean} tools
 * @property {boolean} view
 * @property {boolean} full
 */

/**
 * Create a viewport controller for the map editor.
 * @param {{
 *   cols?: number,
 *   rows?: number,
 *   zoom?: number,
 *   visibility?: Record<string, boolean>,
 *   spriteZoomMin?: number|null
 * }} [opts]
 */
function createEditorViewport(opts) {
    const o = opts || {};
    let cols = Math.max(0, o.cols | 0);
    let rows = Math.max(0, o.rows | 0);
    let zoom = o.zoom != null && o.zoom > 0 ? +o.zoom : 1;
    let scrollLeft = 0;
    let scrollTop = 0;
    /**
     * Min zoom factor for catalog icon overpaint on the display (null = off).
     * Default 8 → 800%. World buffer stays 1 px/tile role-color.
     * @type {number|null}
     */
    let spriteZoomMin =
        o.spriteZoomMin !== undefined
            ? normalizeSpriteZoomMin(o.spriteZoomMin, DEFAULT_SPRITE_ZOOM_MIN)
            : DEFAULT_SPRITE_ZOOM_MIN;

    /** @type {Record<string, boolean>} */
    let visibility = Object.assign(defaultVisibility(), o.visibility || {});

    /** @type {DirtyFlags} */
    const dirty = {
        terrain: true,
        props: true,
        debug: true,
        spawns: true,
        tools: true,
        view: true,
        full: true
    };

    /** @type {object|null} editor session or { floor, previewColorAt, cols, rows } */
    let session = null;

    /**
     * Optional full-map RGBA from path PNG (bootstrap when no hybrid / no session paint).
     * @type {{ data: Uint8ClampedArray|Uint8Array, width: number, height: number }|null}
     */
    let baseRgba = null;

    /** @type {Map<string, { r: number, g: number, b: number, a: number }>} */
    const colorCache = new Map();

    /**
     * Detached terrain cache (ground+path role preview) in map space.
     * @type {{ data: Uint8ClampedArray|Uint8Array, width: number, height: number }|null}
     */
    let terrainCache = null;

    /**
     * Cached tall-prop list for map-space draw (scenery/furniture/vertical).
     * @type {Array<object>|null}
     */
    let propList = null;

    /**
     * Pending world-buffer dirty rect (map tiles, inclusive). null + dirty.full → full map.
     * @type {{ x0: number, y0: number, x1: number, y1: number }|null}
     */
    let worldDirtyRect = null;

    /**
     * Optional catalog image getter: (catalogId, kind) → drawable | null
     * @type {((catalogId: string, kind: string) => *)|null}
     */
    let imageGetter = null;

    /** @type {Map<string, object>|Record<string, object>|null} */
    let roleCatalog = null;

    function anyDirty() {
        return (
            dirty.full ||
            dirty.terrain ||
            dirty.props ||
            dirty.debug ||
            dirty.spawns ||
            dirty.tools ||
            dirty.view ||
            worldDirtyRect != null
        );
    }

    /**
     * @param {string|string[]|Partial<DirtyFlags>|'all'} [keys]
     */
    function markDirty(keys) {
        if (keys == null || keys === 'all') {
            dirty.full = true;
            dirty.terrain = true;
            dirty.props = true;
            dirty.debug = true;
            dirty.spawns = true;
            dirty.tools = true;
            dirty.view = true;
            worldDirtyRect = null; // full map; ignore partial rect
            return;
        }
        if (typeof keys === 'string') {
            if (keys === 'full') {
                dirty.full = true;
                worldDirtyRect = null;
            } else if (keys in dirty) dirty[keys] = true;
            return;
        }
        if (Array.isArray(keys)) {
            for (let i = 0; i < keys.length; i++) markDirty(keys[i]);
            return;
        }
        const k = Object.keys(keys);
        for (let i = 0; i < k.length; i++) {
            if (k[i] in dirty && keys[k[i]]) dirty[k[i]] = true;
        }
    }

    function clearDirty() {
        dirty.terrain = false;
        dirty.props = false;
        dirty.debug = false;
        dirty.spawns = false;
        dirty.tools = false;
        dirty.view = false;
        dirty.full = false;
        worldDirtyRect = null;
    }

    /**
     * Consume pending partial world dirty rect (for compositeMap). Cleared after take.
     * Returns null when a full rebuild is required (dirty.full or no rect).
     * @returns {{ x0: number, y0: number, x1: number, y1: number }|null}
     */
    function takeWorldDirtyRect() {
        if (dirty.full) {
            worldDirtyRect = null;
            return null;
        }
        const r = worldDirtyRect;
        worldDirtyRect = null;
        return r;
    }

    /** Peek without clearing (tests / diagnostics). */
    function peekWorldDirtyRect() {
        return worldDirtyRect;
    }

    function setMapSize(c, r) {
        const nc = Math.max(0, c | 0);
        const nr = Math.max(0, r | 0);
        if (nc !== cols || nr !== rows) {
            cols = nc;
            rows = nr;
            terrainCache = null;
            propList = null;
            markDirty('all');
        }
    }

    /**
     * @param {object|null} s
     */
    function setSession(s) {
        const next = s || null;
        // Same object: paint strokes re-call setSession every frame — must not full-invalidate.
        if (next === session) {
            if (session) {
                const c =
                    session.cols != null ? session.cols : session.floor && session.floor.cols;
                const r =
                    session.rows != null ? session.rows : session.floor && session.floor.rows;
                if (c && r) setMapSize(c, r);
                if (session.roleCatalog) roleCatalog = session.roleCatalog;
            }
            return;
        }
        session = next;
        if (session) {
            const c = session.cols != null ? session.cols : session.floor && session.floor.cols;
            const r = session.rows != null ? session.rows : session.floor && session.floor.rows;
            if (c && r) setMapSize(c, r);
            if (session.roleCatalog) roleCatalog = session.roleCatalog;
        }
        terrainCache = null;
        propList = null;
        markDirty(['terrain', 'props', 'debug', 'full']);
    }

    /**
     * @param {((catalogId: string, kind: string) => *)|null} fn
     */
    function setImageGetter(fn) {
        imageGetter = typeof fn === 'function' ? fn : null;
        markDirty(['props', 'terrain', 'full']);
    }

    /**
     * @param {Map<string, object>|Record<string, object>|null} cat
     */
    function setRoleCatalog(cat) {
        roleCatalog = cat || null;
        propList = null;
        markDirty(['props', 'full']);
    }

    /**
     * @param {Uint8ClampedArray|Uint8Array|null} data
     * @param {number} width
     * @param {number} height
     */
    function setBaseRgba(data, width, height) {
        if (!data || !width || !height) {
            baseRgba = null;
            markDirty(['terrain', 'full']);
            return;
        }
        baseRgba = { data, width: width | 0, height: height | 0 };
        setMapSize(width, height);
        markDirty(['terrain', 'full']);
    }

    function clearBaseRgba() {
        baseRgba = null;
        markDirty(['terrain', 'full']);
    }

    /**
     * @param {string} key
     * @param {boolean} on
     */
    function setVisible(key, on) {
        visibility[key] = !!on;
        markDirty(['view', 'full']);
        if (key === 'tilemap' || String(key).startsWith('tilemap-')) {
            markDirty(['terrain', 'props']);
            propList = null;
            terrainCache = null;
        }
        if (DEBUG_CHANNELS.indexOf(key) >= 0) markDirty('debug');
        if (key === 'spawns') markDirty('spawns');
    }

    /**
     * @param {Record<string, boolean>} map
     */
    function setVisibilityMap(map) {
        if (!map) return;
        const keys = Object.keys(map);
        for (let i = 0; i < keys.length; i++) {
            visibility[keys[i]] = !!map[keys[i]];
        }
        markDirty('all');
    }

    function isVisible(key) {
        return isVis(visibility, key);
    }

    function subLayerVisible(id) {
        return isVis(visibility, 'tilemap-' + id);
    }

    function setZoom(z) {
        const nz = z > 0 ? +z : 1;
        if (nz !== zoom) {
            zoom = nz;
            markDirty('view');
        }
    }

    function setScroll(sx, sy) {
        scrollLeft = sx | 0;
        scrollTop = sy | 0;
        markDirty('view');
    }

    function clientToMapCoords(clientX, clientY, viewRect) {
        return clientToMap(clientX, clientY, viewRect, { scrollLeft, scrollTop }, zoom);
    }

    function mapToScreenCoords(mapX, mapY) {
        return mapToScreen(mapX, mapY, { scrollLeft, scrollTop }, zoom);
    }

    function rebuildTerrainCache(rect) {
        if (!session || !cols || !rows) {
            terrainCache = null;
            return null;
        }
        const floor = session.floor;
        const src = {
            cols,
            rows,
            floor,
            mode: 'terrain',
            previewColorAt:
                typeof session.previewColorAt === 'function'
                    ? (x, y) => session.previewColorAt(x, y)
                    : null,
            subLayerVisible
        };
        const region = clampMapRect(rect, cols, rows);
        // Patch dirty rect into existing full-map cache when possible (paint strokes).
        if (region && terrainCache && terrainCache.width === cols && terrainCache.height === rows) {
            const patch = fillTileMapRgba(src, region, null, colorCache);
            const pw = patch.width | 0;
            const ph = patch.height | 0;
            const pd = patch.data;
            const td = terrainCache.data;
            const rx0 = patch.x0 | 0;
            const ry0 = patch.y0 | 0;
            for (let y = 0; y < ph; y++) {
                for (let x = 0; x < pw; x++) {
                    const si = (y * pw + x) * 4;
                    const di = ((ry0 + y) * cols + (rx0 + x)) * 4;
                    td[di] = pd[si];
                    td[di + 1] = pd[si + 1];
                    td[di + 2] = pd[si + 2];
                    td[di + 3] = pd[si + 3];
                }
            }
            return terrainCache;
        }
        // Full-map ground+path cache; tall props drawn as separate pass.
        const full = fillTileMapRgba(src, null, null, colorCache);
        terrainCache = {
            data: full.data,
            width: full.width,
            height: full.height
        };
        return terrainCache;
    }

    function sortPropList(list) {
        list.sort((a, b) => {
            const ai = TALL_PROP_SUB_LAYER_IDS.indexOf(a.subLayerId);
            const bi = TALL_PROP_SUB_LAYER_IDS.indexOf(b.subLayerId);
            if (ai !== bi) return ai - bi;
            if (a.tileY !== b.tileY) return a.tileY - b.tileY;
            return a.tileX - b.tileX;
        });
        return list;
    }

    function rebuildPropList(rect) {
        if (!session || !session.floor || !cols || !rows) {
            propList = null;
            return null;
        }
        const cat = roleCatalog || session.roleCatalog || null;
        const region = clampMapRect(rect, cols, rows);
        // Patch: drop only props whose origin tile is inside the painted AABB,
        // then rescan that same AABB. Do not inflate the eviction box — a
        // path/ground stroke used to strip neighbor stairs/trees (pad=2) and
        // never put them back, so they vanished until reload.
        if (region && propList) {
            const x0 = region.x0;
            const y0 = region.y0;
            const x1 = region.x1;
            const y1 = region.y1;
            const kept = propList.filter(
                (p) =>
                    !p ||
                    (p.tileX | 0) < x0 ||
                    (p.tileX | 0) > x1 ||
                    (p.tileY | 0) < y0 ||
                    (p.tileY | 0) > y1
            );
            const added = collectTallPropsFromFloor(session.floor, {
                x0,
                y0,
                x1,
                y1,
                roleCatalog: cat
            });
            propList = sortPropList(kept.concat(added));
            return propList;
        }
        propList = collectTallPropsFromFloor(session.floor, {
            roleCatalog: cat
        });
        // Fixed stack order for authoring (scenery → furniture → vertical), not y-sort
        sortPropList(propList);
        return propList;
    }

    function propRoleColor(prop) {
        if (!prop) return '#888888';
        let role = null;
        const cat = roleCatalog || (session && session.roleCatalog) || null;
        const rid = prop.roleId || null;
        // palette entry role from floor when available
        if (session && session.floor && session.floor.palette && prop.paletteIndex != null) {
            const ent = session.floor.palette[prop.paletteIndex];
            if (ent && ent.roleId) {
                return ROLE_PREVIEW_COLORS[ent.roleId] || '#888888';
            }
        }
        if (rid && cat) {
            if (typeof cat.get === 'function') role = cat.get(String(rid));
            else role = cat[String(rid)];
        }
        if (role && role.id) return ROLE_PREVIEW_COLORS[role.id] || '#888888';
        return '#888888';
    }

    /**
     * Composite visible layers into a 2d context in **map pixel space**.
     * Context must already be sized to cols×rows (or caller clips).
     *
     * @param {{
     *   clearRect?: Function,
     *   putImageData?: Function,
     *   drawImage?: Function,
     *   fillRect?: Function,
     *   fillStyle?: *,
     *   createImageData?: Function
     * }} ctx
     * @param {{
     *   rect?: { x0: number, y0: number, x1: number, y1: number }|null,
     *   passes?: string[]|null,
     *   skipBase?: boolean
     * }} [opts]
     * @returns {{ passes: string[], painted: boolean }}
     */
    function compositeMap(ctx, opts) {
        const ro = opts || {};
        if (!ctx || !cols || !rows) {
            return { passes: [], painted: false };
        }

        const hasSession = !!(session && session.floor);
        const floor = hasSession ? session.floor : null;
        const hasBase = !!(baseRgba && baseRgba.data);
        const passes =
            ro.passes ||
            listCompositePasses(visibility, {
                hasBase: hasBase && !ro.skipBase,
                hasSession
            });

        const rect = ro.rect || null;
        const x0 = rect ? Math.max(0, rect.x0 | 0) : 0;
        const y0 = rect ? Math.max(0, rect.y0 | 0) : 0;
        const x1 = rect ? Math.min(cols - 1, rect.x1 | 0) : cols - 1;
        const y1 = rect ? Math.min(rows - 1, rect.y1 | 0) : rows - 1;
        const w = x1 - x0 + 1;
        const h = y1 - y0 + 1;
        if (w <= 0 || h <= 0) return { passes: [], painted: false };

        if (typeof ctx.clearRect === 'function' && !rect) {
            ctx.clearRect(0, 0, cols, rows);
        } else if (typeof ctx.clearRect === 'function' && rect) {
            ctx.clearRect(x0, y0, w, h);
        }

        // Software underlay buffer for the current dirty rect (map-space).
        // Overlay passes alpha-blend into this buffer so transparent cells never wipe friction.
        // Flushed to ctx before tall-prop drawImage; debug overlays after props use getImageData.
        const work =
            typeof Uint8ClampedArray !== 'undefined'
                ? new Uint8ClampedArray(w * h * 4)
                : new Uint8Array(w * h * 4);
        let workDirty = false;

        /**
         * @param {{ data: *, width: number, height: number, x0: number, y0: number }} pack
         * @returns {boolean}
         */
        function packMatchesRect(pack) {
            return (
                pack &&
                pack.width === w &&
                pack.height === h &&
                (pack.x0 | 0) === x0 &&
                (pack.y0 | 0) === y0
            );
        }

        /**
         * Opaque replace into work buffer (and mark dirty).
         * @param {{ data: *, width: number, height: number, x0: number, y0: number }} pack
         */
        function workReplace(pack) {
            if (!pack || !pack.width || !pack.height) return;
            const src = pack.data;
            if (packMatchesRect(pack)) {
                const n = w * h * 4;
                if (typeof work.set === 'function' && src && src.length >= n) {
                    work.set(src.length === n || !src.subarray ? src : src.subarray(0, n));
                } else {
                    for (let i = 0; i < n; i++) work[i] = src[i];
                }
            } else {
                // General rect paste into work (pack coords are map-space absolute).
                const pw = pack.width | 0;
                const ph = pack.height | 0;
                const ox = (pack.x0 | 0) - x0;
                const oy = (pack.y0 | 0) - y0;
                for (let y = 0; y < ph; y++) {
                    const dy = oy + y;
                    if (dy < 0 || dy >= h) continue;
                    for (let x = 0; x < pw; x++) {
                        const dx = ox + x;
                        if (dx < 0 || dx >= w) continue;
                        const si = (y * pw + x) * 4;
                        const di = (dy * w + dx) * 4;
                        work[di] = src[si];
                        work[di + 1] = src[si + 1];
                        work[di + 2] = src[si + 2];
                        work[di + 3] = src[si + 3];
                    }
                }
            }
            workDirty = true;
        }

        /**
         * Source-over into work buffer.
         * @param {{ data: *, width: number, height: number, x0: number, y0: number }} pack
         */
        function workOver(pack) {
            if (!pack || !pack.width || !pack.height) return;
            if (packMatchesRect(pack)) {
                alphaOverRgba(work, pack.data, w * h);
                workDirty = true;
                return;
            }
            // Slow path: blend pack into a temp slice of work
            const pw = pack.width | 0;
            const ph = pack.height | 0;
            const ox = (pack.x0 | 0) - x0;
            const oy = (pack.y0 | 0) - y0;
            const src = pack.data;
            for (let y = 0; y < ph; y++) {
                const dy = oy + y;
                if (dy < 0 || dy >= h) continue;
                for (let x = 0; x < pw; x++) {
                    const dx = ox + x;
                    if (dx < 0 || dx >= w) continue;
                    const si = (y * pw + x) * 4;
                    const sa = src[si + 3] & 0xff;
                    if (!sa) continue;
                    const di = (dy * w + dx) * 4;
                    if (sa === 255) {
                        work[di] = src[si];
                        work[di + 1] = src[si + 1];
                        work[di + 2] = src[si + 2];
                        work[di + 3] = 255;
                        continue;
                    }
                    // single-pixel alpha-over
                    const tmpD = [work[di], work[di + 1], work[di + 2], work[di + 3]];
                    const tmpS = [src[si], src[si + 1], src[si + 2], sa];
                    alphaOverRgba(tmpD, tmpS, 1);
                    work[di] = tmpD[0];
                    work[di + 1] = tmpD[1];
                    work[di + 2] = tmpD[2];
                    work[di + 3] = tmpD[3];
                }
            }
            workDirty = true;
        }

        /**
         * Build ImageData-like object for putImageData.
         * @param {{ data: *, width: number, height: number }} pack
         */
        function toImageDataLike(pack) {
            if (
                typeof ImageData !== 'undefined' &&
                !(pack.data instanceof ImageData) &&
                typeof ctx.createImageData === 'function'
            ) {
                try {
                    const id = ctx.createImageData(pack.width, pack.height);
                    id.data.set(pack.data);
                    return id;
                } catch (_e) {
                    /* fall through */
                }
            }
            if (!(pack.data && pack.data.width != null)) {
                return {
                    data: pack.data,
                    width: pack.width,
                    height: pack.height
                };
            }
            return pack.data;
        }

        function flushWork() {
            if (!workDirty || typeof ctx.putImageData !== 'function') return;
            ctx.putImageData(toImageDataLike({ data: work, width: w, height: h }), x0, y0);
            workDirty = false;
        }

        /**
         * Source-over onto the live canvas (after tall props). Prefer getImageData;
         * fall back to work buffer re-read is not available — use workOver + flush.
         * @param {{ data: *, width: number, height: number, x0: number, y0: number }} pack
         */
        function blitOverCanvas(pack) {
            if (!pack || !pack.width || !pack.height) return;
            const px = pack.width * pack.height;
            if (typeof ctx.getImageData === 'function' && typeof ctx.putImageData === 'function') {
                try {
                    const dest = ctx.getImageData(pack.x0, pack.y0, pack.width, pack.height);
                    if (dest && dest.data) {
                        alphaOverRgba(dest.data, pack.data, px);
                        ctx.putImageData(dest, pack.x0, pack.y0);
                        return;
                    }
                } catch (_e) {
                    /* fall through */
                }
            }
            // No getImageData (unit mock): blend into work then flush (may cover props in mock).
            workOver(pack);
            flushWork();
        }

        for (let pi = 0; pi < passes.length; pi++) {
            const pass = passes[pi];
            if (pass === 'base' && hasBase) {
                if (!rect) {
                    workReplace({
                        data: baseRgba.data,
                        width: baseRgba.width,
                        height: baseRgba.height,
                        x0: 0,
                        y0: 0
                    });
                } else {
                    const bd = baseRgba.data;
                    const bw = baseRgba.width;
                    const slice =
                        typeof Uint8ClampedArray !== 'undefined'
                            ? new Uint8ClampedArray(w * h * 4)
                            : new Uint8Array(w * h * 4);
                    for (let y = 0; y < h; y++) {
                        for (let x = 0; x < w; x++) {
                            const si = ((y0 + y) * bw + (x0 + x)) * 4;
                            const di = (y * w + x) * 4;
                            slice[di] = bd[si];
                            slice[di + 1] = bd[si + 1];
                            slice[di + 2] = bd[si + 2];
                            slice[di + 3] = bd[si + 3];
                        }
                    }
                    workReplace({ data: slice, width: w, height: h, x0, y0 });
                }
            } else if (pass === 'friction' && floor && floor.friction) {
                // Opaque session underlay (walkable gray / blocked yellow).
                workReplace(
                    fillFrictionRgba(floor.friction, cols, rows, { x0, y0, x1, y1 }, null)
                );
            } else if (pass === 'friction' && !floor && hasBase) {
                // base already drawn into work
            } else if (pass === 'tilemap' && hasSession) {
                if (dirty.terrain || dirty.full || !terrainCache) {
                    rebuildTerrainCache(rect);
                }
                if (terrainCache && !rect) {
                    workOver({
                        data: terrainCache.data,
                        width: terrainCache.width,
                        height: terrainCache.height,
                        x0: 0,
                        y0: 0
                    });
                } else if (terrainCache && rect) {
                    // Slice patched cache for dirty rect (avoids second full fill).
                    const slice =
                        typeof Uint8ClampedArray !== 'undefined'
                            ? new Uint8ClampedArray(w * h * 4)
                            : new Uint8Array(w * h * 4);
                    const td = terrainCache.data;
                    for (let y = 0; y < h; y++) {
                        for (let x = 0; x < w; x++) {
                            const si = ((y0 + y) * cols + (x0 + x)) * 4;
                            const di = (y * w + x) * 4;
                            slice[di] = td[si];
                            slice[di + 1] = td[si + 1];
                            slice[di + 2] = td[si + 2];
                            slice[di + 3] = td[si + 3];
                        }
                    }
                    workOver({ data: slice, width: w, height: h, x0, y0 });
                } else {
                    workOver(
                        fillTileMapRgba(
                            {
                                cols,
                                rows,
                                floor,
                                mode: 'terrain',
                                previewColorAt:
                                    typeof session.previewColorAt === 'function'
                                        ? (x, y) => session.previewColorAt(x, y)
                                        : null,
                                subLayerVisible
                            },
                            { x0, y0, x1, y1 },
                            null,
                            colorCache
                        )
                    );
                }
                // Flush underlay before tall-prop drawImage so sprites sit above terrain.
                flushWork();
                if (dirty.props || dirty.full || !propList) {
                    // Full when forced; otherwise patch prop list for the dirty rect only.
                    rebuildPropList(dirty.full || !propList ? null : rect);
                }
                const props = propList || [];
                if (props.length) {
                    // Partial composite: only tall props that overlap the dirty rect.
                    let drawProps = props;
                    if (rect) {
                        const pad = TALL_PROP_OVERHANG_TILES;
                        drawProps = props.filter(
                            (p) =>
                                p &&
                                (p.tileX | 0) >= x0 - pad &&
                                (p.tileX | 0) <= x1 + pad &&
                                (p.tileY | 0) >= y0 - pad &&
                                (p.tileY | 0) <= y1 + pad
                        );
                    }
                    if (drawProps.length) {
                        drawTallPropsMapSpace(ctx, drawProps, {
                            getImage: imageGetter,
                            roleColor: propRoleColor,
                            subLayerVisible,
                            tileSize: 1
                        });
                    }
                }
            } else if (pass === 'fields' && floor && floor.fields) {
                flushWork();
                blitOverCanvas(
                    fillFieldsRgba(floor.fields, cols, rows, { x0, y0, x1, y1 }, null)
                );
            } else if (pass === 'flags' && floor && floor.flags) {
                flushWork();
                blitOverCanvas(
                    fillFlagsRgba(floor.flags, cols, rows, { x0, y0, x1, y1 }, null, colorCache)
                );
            } else if (pass === 'sight' && floor && floor.sight) {
                flushWork();
                blitOverCanvas(fillSightRgba(floor.sight, cols, rows, { x0, y0, x1, y1 }, null));
            }
        }
        // Friction-only (or base-only) path: flush if never flushed by overlays.
        flushWork();

        return { passes: passes.slice(), painted: true };
    }

    /**
     * Export one channel as full-map RGBA for PNG save (session truth).
     * @param {'friction'|'sight'|'flags'|'fields'|'tilemap'} channel
     * @returns {{ data: Uint8ClampedArray|Uint8Array, width: number, height: number }|null}
     */
    function exportChannelRgba(channel) {
        if (!cols || !rows) return null;
        if (channel === 'friction') {
            if (session && session.floor && session.floor.friction) {
                const p = fillFrictionRgba(session.floor.friction, cols, rows, null, null);
                return { data: p.data, width: p.width, height: p.height };
            }
            if (baseRgba) {
                return {
                    data: baseRgba.data,
                    width: baseRgba.width,
                    height: baseRgba.height
                };
            }
            return null;
        }
        if (!session || !session.floor) return null;
        const floor = session.floor;
        if (channel === 'sight' && floor.sight) {
            // Export opaque for legacy layer PNG (not dim overlay alpha)
            const x0 = 0,
                y0 = 0,
                x1 = cols - 1,
                y1 = rows - 1;
            const w = cols;
            const h = rows;
            const data =
                typeof Uint8ClampedArray !== 'undefined'
                    ? new Uint8ClampedArray(w * h * 4)
                    : new Uint8Array(w * h * 4);
            for (let i = 0; i < w * h; i++) {
                const v = floor.sight[i] & 0xff;
                const p = i * 4;
                data[p] = v;
                data[p + 1] = v;
                data[p + 2] = v;
                data[p + 3] = v ? 255 : 0;
            }
            return { data, width: w, height: h };
        }
        if (channel === 'flags' && floor.flags) {
            const p = fillFlagsRgba(floor.flags, cols, rows, null, null, colorCache);
            // Opaque export
            for (let i = 3; i < p.data.length; i += 4) {
                if (p.data[i] > 0) p.data[i] = 255;
            }
            return { data: p.data, width: p.width, height: p.height };
        }
        if (channel === 'fields' && floor.fields) {
            const p = fillFieldsRgba(floor.fields, cols, rows, null, null);
            for (let i = 3; i < p.data.length; i += 4) {
                if (p.data[i] > 0) p.data[i] = 255;
            }
            return { data: p.data, width: p.width, height: p.height };
        }
        if (channel === 'tilemap') {
            // Export: topmost flat preview (includes tall sub-layers as colors)
            const p = fillTileMapRgba(
                {
                    cols,
                    rows,
                    floor,
                    mode: 'topmost',
                    previewColorAt:
                        typeof session.previewColorAt === 'function'
                            ? (x, y) => session.previewColorAt(x, y)
                            : null,
                    subLayerVisible
                },
                null,
                null,
                colorCache
            );
            return { data: p.data, width: p.width, height: p.height };
        }
        return null;
    }

    /**
     * Invalidate caches after session paint (dirty rect optional).
     * With a rect: union into worldDirtyRect and patch caches — do not full-map rebuild.
     * Without a rect: full invalidate (layer toggle, load, undo of unknown extent).
     * @param {{ x0: number, y0: number, x1: number, y1: number }|null} [rect]
     * @param {string[]} [layers]
     */
    function notifySessionPaint(rect, layers) {
        const ls = layers || ['tilemap', 'friction', 'sight', 'flags', 'fields'];
        const region = clampMapRect(rect, cols, rows);
        if (ls.indexOf('tilemap') >= 0) {
            if (!region) {
                terrainCache = null;
                propList = null;
                markDirty(['terrain', 'props', 'full']);
            } else {
                // Ground/path strokes: patch terrain only. Tall props stay valid unless
                // a full rebuild is requested elsewhere (stamp on scenery/furniture/vertical
                // still only changes cells — propList is rebuilt when props dirty).
                markDirty(['terrain']);
                // Tall sub-layer paint may add/remove props; cheap full collect is OK
                // only when needed — mark props dirty so next composite refreshes list.
                markDirty(['props']);
            }
        }
        for (let i = 0; i < DEBUG_CHANNELS.length; i++) {
            if (ls.indexOf(DEBUG_CHANNELS[i]) >= 0) markDirty('debug');
        }
        if (region) {
            worldDirtyRect = unionMapRect(worldDirtyRect, region, cols, rows);
            markDirty('view');
        } else {
            markDirty('full');
        }
        return region;
    }

    /**
     * Resolve role doc for a placement (optional catalog).
     * @param {object|null|undefined} placement
     * @returns {object|null}
     */
    function roleForPlacement(placement) {
        if (!placement) return null;
        const cat = roleCatalog || (session && session.roleCatalog) || null;
        if (!cat) return null;
        const rid = placement.roleId != null ? String(placement.roleId) : '';
        if (!rid) return null;
        if (typeof cat.get === 'function') return cat.get(rid) || null;
        return cat[rid] || null;
    }

    /**
     * True when current zoom should overpaint catalog icon sprites on display.
     * @param {number} [z]
     */
    function spritesActive(z) {
        const zz = z != null && z > 0 ? +z : zoom;
        if (!shouldShowTileSprites(zz, spriteZoomMin)) return false;
        if (!imageGetter) return false;
        if (!session || !session.floor) return false;
        if (!isVisible('tilemap')) return false;
        return true;
    }

    /**
     * @param {number|null|false|string} raw
     */
    function setSpriteZoomMin(raw) {
        const next =
            raw === undefined
                ? DEFAULT_SPRITE_ZOOM_MIN
                : normalizeSpriteZoomMin(raw, DEFAULT_SPRITE_ZOOM_MIN);
        if (next === spriteZoomMin) return spriteZoomMin;
        spriteZoomMin = next;
        markDirty('view');
        return spriteZoomMin;
    }

    /**
     * Present map-space world onto a viewport-sized display (zoom + scroll).
     * When zoom ≥ spriteZoomMin, overpaints visible catalog **icon** sprites
     * (32×32) in screen space before the page overlay (grid/spawns).
     * @param {*} displayCtx
     * @param {*} worldCanvas
     * @param {{
     *   viewWidth: number,
     *   viewHeight: number,
     *   scrollLeft?: number,
     *   scrollTop?: number,
     *   zoom?: number,
     *   overlay?: Function
     * }} [viewOpts]
     */
    function present(displayCtx, worldCanvas, viewOpts) {
        const vo = viewOpts || {};
        const zPresent = vo.zoom != null ? vo.zoom : zoom;
        const sl = vo.scrollLeft != null ? vo.scrollLeft : scrollLeft;
        const st = vo.scrollTop != null ? vo.scrollTop : scrollTop;
        const userOverlay = typeof vo.overlay === 'function' ? vo.overlay : null;
        return presentView(displayCtx, worldCanvas, {
            viewWidth: vo.viewWidth,
            viewHeight: vo.viewHeight,
            scrollLeft: sl,
            scrollTop: st,
            zoom: zPresent,
            overlay: (dctx, info) => {
                if (spritesActive(info.zoom)) {
                    if (dirty.props || dirty.full || !propList) {
                        rebuildPropList(null);
                    }
                    drawAuthoringSpritesDisplay(dctx, {
                        floor: session.floor,
                        cols,
                        rows,
                        scrollLeft: info.scrollLeft,
                        scrollTop: info.scrollTop,
                        zoom: info.zoom,
                        viewWidth: info.viewWidth,
                        viewHeight: info.viewHeight,
                        getImage: imageGetter,
                        subLayerVisible,
                        roleForPlacement,
                        props: propList,
                        pad: 2
                    });
                }
                if (userOverlay) userOverlay(dctx, info);
            }
        });
    }

    /**
     * Visible tile rect for current scroll/zoom and a viewport size.
     * @param {number} viewWidth
     * @param {number} viewHeight
     * @param {number} [pad]
     */
    function getVisibleMapRect(viewWidth, viewHeight, pad) {
        return visibleMapRect(cols, rows, scrollLeft, scrollTop, viewWidth, viewHeight, zoom, pad);
    }

    return {
        get cols() {
            return cols;
        },
        get rows() {
            return rows;
        },
        get zoom() {
            return zoom;
        },
        get scrollLeft() {
            return scrollLeft;
        },
        get scrollTop() {
            return scrollTop;
        },
        get visibility() {
            return visibility;
        },
        get dirty() {
            return dirty;
        },
        get session() {
            return session;
        },
        get hasBase() {
            return !!(baseRgba && baseRgba.data);
        },
        get baseRgba() {
            return baseRgba;
        },
        get propList() {
            return propList;
        },
        get spriteZoomMin() {
            return spriteZoomMin;
        },
        anyDirty,
        markDirty,
        clearDirty,
        takeWorldDirtyRect,
        peekWorldDirtyRect,
        setMapSize,
        setSession,
        setBaseRgba,
        clearBaseRgba,
        setImageGetter,
        setRoleCatalog,
        setVisible,
        setVisibilityMap,
        isVisible,
        subLayerVisible,
        setZoom,
        setScroll,
        setSpriteZoomMin,
        spritesActive,
        clientToMap: clientToMapCoords,
        mapToScreen: mapToScreenCoords,
        compositeMap,
        rebuildTerrainCache,
        rebuildPropList,
        exportChannelRgba,
        notifySessionPaint,
        present,
        getVisibleMapRect,
        listCompositePasses: (extra) =>
            listCompositePasses(visibility, {
                hasBase: !!(baseRgba && baseRgba.data),
                hasSession: !!(session && session.floor),
                ...(extra || {})
            })
    };
}

module.exports = {
    COMPOSITE_PASSES,
    DEBUG_CHANNELS,
    TILEMAP_SUB_LAYER_IDS,
    TERRAIN_SUB_LAYER_IDS,
    TALL_PROP_SUB_LAYER_IDS,
    DEFAULT_SPRITE_ZOOM_MIN,
    TALL_PROP_OVERHANG_TILES,
    defaultVisibility,
    listCompositePasses,
    parseHexColor,
    hexToRgbaCached,
    alphaOverRgba,
    fillFrictionRgba,
    fillSightRgba,
    fillFlagsRgba,
    fillFieldsRgba,
    fillTileMapRgba,
    decodeFrictionRgbaToChannels,
    clientToMap,
    mapToScreen,
    visibleMapRect,
    unionMapRect,
    clampMapRect,
    presentView,
    shouldShowTileSprites,
    normalizeSpriteZoomMin,
    drawAuthoringSpritesDisplay,
    drawTallPropsMapSpace,
    createEditorViewport,
    frictionPreviewColor,
    flagsPreviewColor
};
