/**
 * TileMap bake pipeline + hybrid map pack IO (Phase 4).
 *
 * Authoring stacks (ground → path → scenery → furniture → vertical) bake into
 * flat friction / sight / flags. Fields are never written by bake.
 *
 * Hybrid pack: JSON meta (palette, stairs, headers) + gzip cell blobs
 * (`*.u8.gz` / `*.u16.gz`). No uncompressed blob format.
 * Load order: hybrid if present → else legacy friction PNG bootstrap → empty.
 * PNG remains export + bootstrap only.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const fflate = require('fflate');

const {
    FRICTION_BLOCKED,
    SIGHT_BLOCKED,
    DEFAULT_OPEN_FRICTION,
    normalizeEntityId,
    normalizeTileRole,
    bakeCellChannels,
    applyInfluence,
    applyRole,
    finalizeBakeCell,
    createBakeAccumulator,
    resolveTileRole,
    indexTileRoles,
    hopDirOffset
} = require('./tile_roles.js');

const { frictionToRgba } = require('./stitch.js');
const { normalizeStampKind } = require('../../../settings.js');

/** Fixed sub-layers: zOrder low under high; UI lists vertical first / ground last. */
const SUB_LAYER_DEFS = Object.freeze([
    Object.freeze({ id: 'ground', zOrder: 0 }),
    Object.freeze({ id: 'path', zOrder: 1 }),
    Object.freeze({ id: 'scenery', zOrder: 2 }),
    Object.freeze({ id: 'furniture', zOrder: 3 }),
    Object.freeze({ id: 'vertical', zOrder: 4 })
]);

const SUB_LAYER_IDS = SUB_LAYER_DEFS.map((d) => d.id);

/** Per-cell override mask bits (manual Flags/Sight/Friction paint). */
const OVERRIDE_FRICTION = 1 << 0; // 1
const OVERRIDE_SIGHT = 1 << 1; // 2
const OVERRIDE_FLAGS = 1 << 2; // 4

/** Hybrid pack format: gzip-only blobs (`*.u8.gz` / `*.u16.gz`). */
const HYBRID_VERSION = 2;
const HYBRID_META_NAME = 'map.json';
const GZIP_MAGIC0 = 0x1f;
const GZIP_MAGIC1 = 0x8b;

/**
 * @param {Buffer|Uint8Array|ArrayBuffer} data
 * @returns {Uint8Array}
 */
function asU8View(data) {
    if (data instanceof Uint8Array) return data;
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer && Buffer.isBuffer(data)) {
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    return new Uint8Array(data);
}

/**
 * Gzip-compress raw cell bytes for hybrid blob storage / transport.
 * mtime 0 — same cells MUST emit identical bytes (gzip header otherwise stamps now).
 * @param {Buffer|Uint8Array} data
 * @returns {Buffer|Uint8Array}
 */
function gzipBytes(data) {
    const u8 = asU8View(data);
    const out = fflate.gzipSync(u8, { level: 6, mtime: 0 });
    if (typeof Buffer !== 'undefined') {
        return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
    }
    return out;
}

/**
 * Gunzip a hybrid blob. Rejects non-gzip payloads (no raw fallback).
 * @param {Buffer|Uint8Array} data
 * @param {string} [label]
 * @returns {Uint8Array}
 */
function gunzipBytes(data, label) {
    const u8 = asU8View(data);
    if (u8.length < 2 || u8[0] !== GZIP_MAGIC0 || u8[1] !== GZIP_MAGIC1) {
        const where = label ? ` (${label})` : '';
        throw new Error(
            `hybrid blob is not gzip${where}: expected magic 1f 8b (*.u8.gz / *.u16.gz only)`
        );
    }
    return fflate.gunzipSync(u8);
}

/**
 * Relative blob path for a u8 channel/grid (always `.u8.gz`).
 * @param {string} prefix e.g. floors/0
 * @param {string} name e.g. friction
 * @returns {string}
 */
function hybridBlobRelU8(prefix, name) {
    return `${prefix}/${name}.u8.gz`;
}

/**
 * Relative blob path for a u16 sub-layer (always `.u16.gz`).
 * @param {string} prefix
 * @param {string} name e.g. sub_ground
 * @returns {string}
 */
function hybridBlobRelU16(prefix, name) {
    return `${prefix}/${name}.u16.gz`;
}

/**
 * True when relative path is a hybrid gzip blob name.
 * @param {string} rel
 * @returns {boolean}
 */
function isHybridGzipBlobRel(rel) {
    return typeof rel === 'string' && (rel.endsWith('.u8.gz') || rel.endsWith('.u16.gz'));
}

/**
 * @param {*} v
 * @param {number} fallback
 * @returns {number}
 */
function floorInt(v, fallback) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.floor(n);
}

/**
 * @param {number} cols
 * @param {number} rows
 * @returns {number}
 */
function cellCount(cols, rows) {
    return Math.max(0, (cols | 0) * (rows | 0));
}

/**
 * Normalize one palette placement entry.
 * Index 0 is reserved empty (caller keeps null).
 *
 * @param {*} raw
 * @returns {object|null}
 */
function normalizePaletteEntry(raw) {
    if (raw == null) return null;
    if (typeof raw !== 'object') return null;

    const catalogId =
        raw.catalogId != null
            ? String(raw.catalogId).trim()
            : raw.id != null
              ? String(raw.id).trim()
              : '';
    if (!catalogId) return null;

    const kind = normalizeStampKind(raw.kind);

    const roleId =
        raw.roleId != null
            ? normalizeEntityId(raw.roleId)
            : raw.role != null && typeof raw.role === 'string'
              ? normalizeEntityId(raw.role)
              : null;

    /** @type {object} */
    const out = {
        catalogId,
        kind,
        roleId
    };

    if (raw.scale != null && Number.isFinite(Number(raw.scale))) {
        const s = Number(raw.scale);
        if (s >= 0.05 && s <= 8) out.scale = s;
    }
    if (raw.anchor != null && String(raw.anchor).trim()) {
        out.anchor = String(raw.anchor).trim().toLowerCase();
    }

    if (raw.hop && typeof raw.hop === 'object') {
        /** @type {{ dir?: string, deltaZ?: number, to?: object }} */
        const hop = {};
        if (raw.hop.dir != null) hop.dir = String(raw.hop.dir).trim().toLowerCase();
        if (raw.hop.deltaZ != null && Number.isFinite(Number(raw.hop.deltaZ))) {
            hop.deltaZ = Math.trunc(Number(raw.hop.deltaZ));
        }
        if (raw.hop.to && typeof raw.hop.to === 'object') {
            hop.to = {
                x: floorInt(raw.hop.to.x, 0),
                y: floorInt(raw.hop.to.y, 0)
            };
            if (raw.hop.to.z !== undefined && raw.hop.to.z !== null) {
                hop.to.z = raw.hop.to.z;
            }
        }
        out.hop = hop;
    }

    // Inline role influence (tests / authoring without catalog lookup)
    if (raw.role && typeof raw.role === 'object') {
        const role = raw.role.influence
            ? raw.role
            : normalizeTileRole(raw.role);
        if (role) {
            out.role = role;
            if (!out.roleId && role.id) out.roleId = role.id;
        }
    }
    if (raw.influence && typeof raw.influence === 'object' && !out.role) {
        const role = normalizeTileRole({
            id: out.roleId || 'inline',
            influence: raw.influence,
            vertical: raw.vertical
        });
        if (role) out.role = role;
    }
    if (raw.vertical && typeof raw.vertical === 'object' && out.role) {
        // already on role
    } else if (raw.vertical && typeof raw.vertical === 'object') {
        out.vertical = raw.vertical;
    }

    if (raw.wangFamily != null && String(raw.wangFamily).trim()) {
        out.wangFamily = String(raw.wangFamily).trim().toLowerCase();
    }
    if (raw.wangMask != null && Number.isFinite(Number(raw.wangMask))) {
        const m = Math.trunc(Number(raw.wangMask));
        if (m >= 0 && m <= 15) out.wangMask = m;
    }
    if (raw.wangInner != null && String(raw.wangInner).trim()) {
        const inner = String(raw.wangInner)
            .trim()
            .toLowerCase()
            .replace(/[\s_]+/g, '-')
            .replace(/^inner-/, '');
        if (inner === 'nw' || inner === 'ne' || inner === 'se' || inner === 'sw') {
            out.wangInner = inner;
        }
    }
    if (raw.wallFamily != null && String(raw.wallFamily).trim()) {
        out.wallFamily = String(raw.wallFamily).trim().toLowerCase();
    }
    if (raw.wallAlign != null && String(raw.wallAlign).trim()) {
        out.wallAlign = String(raw.wallAlign).trim().toLowerCase().replace(/[\s-]+/g, '_');
    }
    if (raw.wangLocked) out.wangLocked = true;

    return out;
}

/**
 * Build empty fixed five sub-layers with zeroed cells.
 * @param {number} cols
 * @param {number} rows
 * @returns {{ id: string, zOrder: number, cells: Uint16Array }[]}
 */
function createEmptySubLayers(cols, rows) {
    const n = cellCount(cols, rows);
    return SUB_LAYER_DEFS.map((d) => ({
        id: d.id,
        zOrder: d.zOrder,
        cells: new Uint16Array(n)
    }));
}

/**
 * Create an empty authoring floor (void defaults when baked).
 * @param {number} cols
 * @param {number} rows
 * @param {{ z?: string|number }} [opts]
 * @returns {object}
 */
function createEmptyTileMapFloor(cols, rows, opts) {
    const c = Math.max(1, cols | 0);
    const r = Math.max(1, rows | 0);
    const o = opts || {};
    return {
        z: o.z != null ? o.z : 0,
        cols: c,
        rows: r,
        palette: [null],
        subLayers: createEmptySubLayers(c, r),
        overrideMask: new Uint8Array(c * r),
        friction: null,
        sight: null,
        flags: null,
        fields: null,
        stairs: []
    };
}

/**
 * Ensure subLayers cover the fixed five ids; sort by zOrder ascending.
 * @param {object} floor
 * @returns {object} floor
 */
function ensureSubLayers(floor) {
    const cols = floor.cols | 0;
    const rows = floor.rows | 0;
    const n = cellCount(cols, rows);
    const byId = Object.create(null);
    const list = Array.isArray(floor.subLayers) ? floor.subLayers : [];
    for (let i = 0; i < list.length; i++) {
        const sl = list[i];
        if (!sl || sl.id == null) continue;
        const id = String(sl.id);
        let cells;
        if (sl.cells instanceof Uint16Array && sl.cells.length >= n) {
            cells = sl.cells.length === n ? sl.cells : sl.cells.subarray(0, n);
        } else if (sl.cells && (Array.isArray(sl.cells) || ArrayBuffer.isView(sl.cells))) {
            cells = new Uint16Array(n);
            for (let j = 0; j < n; j++) cells[j] = (sl.cells[j] || 0) & 0xffff;
        } else if (sl.cells && typeof sl.cells === 'object') {
            cells = new Uint16Array(n);
            for (let j = 0; j < n; j++) cells[j] = (sl.cells[j] || 0) & 0xffff;
        } else {
            cells = new Uint16Array(n);
        }
        const def = SUB_LAYER_DEFS.find((d) => d.id === id);
        byId[id] = {
            id,
            zOrder:
                sl.zOrder != null
                    ? floorInt(sl.zOrder, 0)
                    : def
                      ? def.zOrder
                      : i,
            cells
        };
    }
    floor.subLayers = SUB_LAYER_DEFS.map((d) => {
        if (byId[d.id]) {
            byId[d.id].zOrder = d.zOrder;
            return byId[d.id];
        }
        return { id: d.id, zOrder: d.zOrder, cells: new Uint16Array(n) };
    });
    return floor;
}

/**
 * Normalize a TileMapFloor authoring object.
 * @param {*} raw
 * @returns {object|null}
 */
function normalizeTileMapFloor(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const cols = Math.max(1, floorInt(raw.cols, 1));
    const rows = Math.max(1, floorInt(raw.rows, 1));
    const n = cols * rows;
    const floor = {
        z: raw.z != null ? raw.z : 0,
        cols,
        rows,
        palette: [null],
        subLayers: [],
        overrideMask: new Uint8Array(n),
        friction: null,
        sight: null,
        flags: null,
        fields: null,
        stairs: []
    };

    const pal = Array.isArray(raw.palette) ? raw.palette : [];
    for (let i = 1; i < pal.length; i++) {
        const entry = normalizePaletteEntry(pal[i]);
        floor.palette.push(entry);
    }
    // If palette was sparse or started without reserved null
    if (pal.length === 0 && Array.isArray(raw.placements)) {
        // alternate shape unused for now
    }

    floor.subLayers = Array.isArray(raw.subLayers) ? raw.subLayers : [];
    ensureSubLayers(floor);

    if (raw.overrideMask) {
        copyU8Into(floor.overrideMask, raw.overrideMask, n);
    }
    if (raw.friction) {
        floor.friction = new Uint8Array(n);
        copyU8Into(floor.friction, raw.friction, n);
    }
    if (raw.sight) {
        floor.sight = new Uint8Array(n);
        copyU8Into(floor.sight, raw.sight, n);
    }
    if (raw.flags) {
        floor.flags = new Uint8Array(n);
        copyU8Into(floor.flags, raw.flags, n);
    }
    if (raw.fields) {
        floor.fields = new Uint8Array(n);
        copyU8Into(floor.fields, raw.fields, n);
    }
    if (Array.isArray(raw.stairs)) {
        floor.stairs = raw.stairs.slice();
    }
    return floor;
}

/**
 * @param {Uint8Array} dest
 * @param {ArrayLike<number>|object} src
 * @param {number} n
 */
function copyU8Into(dest, src, n) {
    for (let i = 0; i < n; i++) {
        dest[i] = (src[i] != null ? src[i] : 0) & 0xff;
    }
}

/**
 * Resolve palette entry → role object for bakeCellChannels.
 * @param {object|null} entry
 * @param {Map|object|null} roleCatalog
 * @returns {object|null} stack entry for bakeCellChannels
 */
function placementToStackEntry(entry, roleCatalog) {
    if (!entry) return null;

    let role = entry.role || null;
    if (!role && entry.roleId && roleCatalog) {
        role = resolveTileRole(roleCatalog, entry.roleId);
    }
    if (!role && entry.influence) {
        role = normalizeTileRole({
            id: entry.roleId || 'inline',
            influence: entry.influence,
            vertical: entry.vertical
        });
    }
    if (!role) return null;

    if (role.influence == null) {
        role = normalizeTileRole(role);
        if (!role) return null;
    }

    /** @type {object} */
    const stackEntry = { role };
    if (entry.hop) stackEntry.hop = entry.hop;
    // Placement vertical override (rare)
    if (entry.vertical && !role.vertical) {
        stackEntry.role = Object.assign({}, role, { vertical: entry.vertical });
    }
    return stackEntry;
}

/**
 * Ordered stack of placements at (x,y), bottom → top (ground first).
 * @param {object} floor normalized TileMapFloor
 * @param {number} x
 * @param {number} y
 * @returns {Array<object|null>}
 */
function stackAtCell(floor, x, y) {
    const cols = floor.cols | 0;
    const rows = floor.rows | 0;
    if (x < 0 || y < 0 || x >= cols || y >= rows) return [];
    const idx = y * cols + x;
    const palette = floor.palette || [null];
    const out = [];
    const layers = floor.subLayers || [];
    for (let i = 0; i < layers.length; i++) {
        const sl = layers[i];
        if (!sl || !sl.cells) continue;
        const pi = sl.cells[idx] | 0;
        if (pi <= 0 || pi >= palette.length) continue;
        out.push(palette[pi]);
    }
    return out;
}

/**
 * Bake one cell from floor authoring stack.
 * @param {object} floor
 * @param {number} x
 * @param {number} y
 * @param {Map|object|null} roleCatalog
 * @returns {ReturnType<typeof bakeCellChannels>}
 */
function bakeCellFromFloor(floor, x, y, roleCatalog) {
    const stack = stackAtCell(floor, x, y);
    const entries = [];
    for (let i = 0; i < stack.length; i++) {
        const e = placementToStackEntry(stack[i], roleCatalog);
        if (e) entries.push(e);
    }
    return bakeCellChannels(entries);
}

/**
 * Merge baked channels with previous values under override mask.
 * When mask bit set, keep previous; else use baked.
 *
 * @param {{ friction: Uint8Array, sight: Uint8Array, flags: Uint8Array }} baked
 * @param {{ friction?: Uint8Array|null, sight?: Uint8Array|null, flags?: Uint8Array|null }} previous
 * @param {Uint8Array|null|undefined} overrideMask
 * @returns {{ friction: Uint8Array, sight: Uint8Array, flags: Uint8Array }}
 */
function diffOverrides(baked, previous, overrideMask) {
    const n = baked.friction.length;
    const friction = new Uint8Array(baked.friction);
    const sight = new Uint8Array(baked.sight);
    const flags = new Uint8Array(baked.flags);
    if (!overrideMask || overrideMask.length < n) {
        return { friction, sight, flags };
    }
    const prevF = previous && previous.friction;
    const prevS = previous && previous.sight;
    const prevFl = previous && previous.flags;
    for (let i = 0; i < n; i++) {
        const m = overrideMask[i] | 0;
        if ((m & OVERRIDE_FRICTION) && prevF && prevF.length > i) {
            friction[i] = prevF[i] & 0xff;
        }
        if ((m & OVERRIDE_SIGHT) && prevS && prevS.length > i) {
            sight[i] = prevS[i] & 0xff;
        }
        if ((m & OVERRIDE_FLAGS) && prevFl && prevFl.length > i) {
            flags[i] = prevFl[i] & 0xff;
        }
    }
    return { friction, sight, flags };
}

/**
 * Bake an entire TileMapFloor into flat channels + vertical registration list.
 * Does **not** write fields.
 *
 * @param {object} floorRaw normalized or raw floor
 * @param {{
 *   roleCatalog?: Map|object|null,
 *   previous?: { friction?: Uint8Array, sight?: Uint8Array, flags?: Uint8Array }|null,
 *   applyOverrides?: boolean
 * }} [opts]
 * @returns {{
 *   cols: number,
 *   rows: number,
 *   z: string|number,
 *   friction: Uint8Array,
 *   sight: Uint8Array,
 *   flags: Uint8Array,
 *   verticals: Array<{ x: number, y: number, z: string|number, placement: object, cell: object }>,
 *   cells: Array<object>
 * }}
 */
function bakeTileMapFloor(floorRaw, opts) {
    const floor = floorRaw.subLayers ? ensureSubLayers(floorRaw) : normalizeTileMapFloor(floorRaw);
    if (!floor) {
        throw new Error('bakeTileMapFloor: invalid floor');
    }
    const o = opts || {};
    const roleCatalog = o.roleCatalog || null;
    const cols = floor.cols | 0;
    const rows = floor.rows | 0;
    const n = cols * rows;
    const friction = new Uint8Array(n);
    const sight = new Uint8Array(n);
    const flags = new Uint8Array(n);
    /** @type {object[]} */
    const cells = new Array(n);
    /** @type {Array<object>} */
    const verticals = [];

    for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
            const i = y * cols + x;
            const cell = bakeCellFromFloor(floor, x, y, roleCatalog);
            cells[i] = cell;
            friction[i] = cell.friction & 0xff;
            sight[i] = cell.sight & 0xff;
            flags[i] = cell.flags & 0xff;

            if (cell.vertical && cell.vertical.registerStairLink) {
                const stack = stackAtCell(floor, x, y);
                // Topmost placement that contributed vertical (last in stack with role vertical)
                let placement = null;
                for (let s = stack.length - 1; s >= 0; s--) {
                    const ent = stack[s];
                    if (!ent) continue;
                    const se = placementToStackEntry(ent, roleCatalog);
                    if (se && se.role && se.role.vertical) {
                        placement = {
                            role: se.role,
                            vertical: se.role.vertical,
                            hop: se.hop || ent.hop || cell.hop || null,
                            catalogId: ent.catalogId,
                            roleId: ent.roleId || (se.role && se.role.id)
                        };
                        break;
                    }
                }
                if (placement) {
                    verticals.push({
                        x,
                        y,
                        z: floor.z,
                        placement,
                        cell
                    });
                }
            }
        }
    }

    let outF = friction;
    let outS = sight;
    let outFl = flags;
    if (o.applyOverrides !== false && floor.overrideMask) {
        const prev = o.previous || {
            friction: floor.friction,
            sight: floor.sight,
            flags: floor.flags
        };
        const merged = diffOverrides(
            { friction, sight, flags },
            prev,
            floor.overrideMask
        );
        outF = merged.friction;
        outS = merged.sight;
        outFl = merged.flags;
    }

    return {
        cols,
        rows,
        z: floor.z,
        friction: outF,
        sight: outS,
        flags: outFl,
        verticals,
        cells
    };
}

/**
 * Bake one cell into channel buffers (override-aware).
 * @param {object} floor
 * @param {number} x
 * @param {number} y
 * @param {{
 *   roleCatalog?: Map|object|null,
 *   friction: Uint8Array,
 *   sight: Uint8Array,
 *   flags: Uint8Array,
 *   previous?: object|null
 * }} channels
 * @param {object[]} verticalsOut
 */
function bakeOneCellIntoChannels(floor, x, y, channels, verticalsOut) {
    const cols = floor.cols | 0;
    const rows = floor.rows | 0;
    if (x < 0 || y < 0 || x >= cols || y >= rows) return;
    const roleCatalog = channels.roleCatalog || null;
    const i = y * cols + x;
    const cell = bakeCellFromFloor(floor, x, y, roleCatalog);
    let f = cell.friction & 0xff;
    let s = cell.sight & 0xff;
    let fl = cell.flags & 0xff;
    const m = floor.overrideMask ? floor.overrideMask[i] | 0 : 0;
    const prev = channels.previous || {};
    if ((m & OVERRIDE_FRICTION) && prev.friction) f = prev.friction[i] & 0xff;
    if ((m & OVERRIDE_SIGHT) && prev.sight) s = prev.sight[i] & 0xff;
    if ((m & OVERRIDE_FLAGS) && prev.flags) fl = prev.flags[i] & 0xff;
    channels.friction[i] = f;
    channels.sight[i] = s;
    channels.flags[i] = fl;

    if (cell.vertical && cell.vertical.registerStairLink && verticalsOut) {
        const stack = stackAtCell(floor, x, y);
        for (let si = stack.length - 1; si >= 0; si--) {
            const ent = stack[si];
            const se = placementToStackEntry(ent, roleCatalog);
            if (se && se.role && se.role.vertical) {
                verticalsOut.push({
                    x,
                    y,
                    z: floor.z,
                    placement: {
                        role: se.role,
                        vertical: se.role.vertical,
                        hop: se.hop || ent.hop || cell.hop || null
                    },
                    cell
                });
                break;
            }
        }
    }
}

/**
 * Bake only the listed cell indices in place (does not fill the bounding box).
 * Diagonal strokes must use this so unpainted tiles inside the stroke AABB keep
 * their previous channels.
 *
 * @param {object} floor
 * @param {Iterable<number>} indices
 * @param {{
 *   roleCatalog?: Map|object|null,
 *   friction: Uint8Array,
 *   sight: Uint8Array,
 *   flags: Uint8Array,
 *   previous?: object|null
 * }} channels
 * @returns {{ verticals: object[] }}
 */
function bakeCellIndices(floor, indices, channels) {
    ensureSubLayers(floor);
    const cols = floor.cols | 0;
    const rows = floor.rows | 0;
    /** @type {object[]} */
    const verticals = [];
    const seen = new Set();
    for (const raw of indices) {
        const i = raw | 0;
        if (seen.has(i)) continue;
        seen.add(i);
        if (i < 0 || i >= cols * rows) continue;
        const x = i % cols;
        const y = (i / cols) | 0;
        bakeOneCellIntoChannels(floor, x, y, channels, verticals);
    }
    return { verticals };
}

/**
 * Bake a rectangular dirty region in place on channel buffers.
 * Prefer bakeCellIndices when only sparse dirty cells should update.
 * @param {object} floor
 * @param {number} x0
 * @param {number} y0
 * @param {number} x1 inclusive
 * @param {number} y1 inclusive
 * @param {{
 *   roleCatalog?: Map|object|null,
 *   friction: Uint8Array,
 *   sight: Uint8Array,
 *   flags: Uint8Array,
 *   previous?: object|null
 * }} channels
 * @returns {{ verticals: object[] }}
 */
function bakeCellRect(floor, x0, y0, x1, y1, channels) {
    ensureSubLayers(floor);
    const cols = floor.cols | 0;
    const rows = floor.rows | 0;
    const xa = Math.max(0, Math.min(cols - 1, Math.min(x0, x1) | 0));
    const xb = Math.max(0, Math.min(cols - 1, Math.max(x0, x1) | 0));
    const ya = Math.max(0, Math.min(rows - 1, Math.min(y0, y1) | 0));
    const yb = Math.max(0, Math.min(rows - 1, Math.max(y0, y1) | 0));
    /** @type {object[]} */
    const verticals = [];

    for (let y = ya; y <= yb; y++) {
        for (let x = xa; x <= xb; x++) {
            bakeOneCellIntoChannels(floor, x, y, channels, verticals);
        }
    }
    return { verticals };
}

/**
 * Apply bake result onto a TileMap entity (loadFloorFromFriction + stairs).
 * Fields are left untouched unless opts.fields is provided separately.
 *
 * @param {object} map TileMap instance
 * @param {string|number} z
 * @param {ReturnType<typeof bakeTileMapFloor>} bakeResult
 * @param {{
 *   fields?: Uint8Array|null,
 *   registerVertical?: boolean,
 *   clearStairs?: boolean
 * }} [opts]
 * @returns {object} layer
 */
function applyBakeToTileMap(map, z, bakeResult, opts) {
    if (!map || typeof map.loadFloorFromFriction !== 'function') {
        throw new Error('applyBakeToTileMap: map requires loadFloorFromFriction');
    }
    const o = opts || {};
    const layer = map.loadFloorFromFriction(
        z,
        bakeResult.cols,
        bakeResult.rows,
        bakeResult.friction,
        {
            sight: bakeResult.sight,
            flags: bakeResult.flags
        }
    );
    if (o.fields && layer && layer.fields && o.fields.length >= bakeResult.cols * bakeResult.rows) {
        const n = bakeResult.cols * bakeResult.rows;
        for (let i = 0; i < n; i++) layer.fields[i] = o.fields[i] & 0xff;
    }

    if (o.registerVertical !== false && Array.isArray(bakeResult.verticals)) {
        let registerFn = null;
        try {
            registerFn = require('../../entities/tilemap.js').registerVerticalFromPlacement;
        } catch (_e) {
            registerFn = null;
        }
        if (typeof registerFn === 'function') {
            for (let i = 0; i < bakeResult.verticals.length; i++) {
                const v = bakeResult.verticals[i];
                registerFn(map, v.placement, v.x, v.y, z, {
                    // flags already baked into channel
                    setFlags: false
                });
            }
        }
    }
    return layer;
}

// ─── Hybrid pack ─────────────────────────────────────────────────────────────

/**
 * Normalize a multi-floor hybrid pack in memory.
 * @param {*} raw
 * @returns {object|null}
 */
function normalizeHybridPack(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id =
        raw.id != null
            ? String(raw.id).trim()
            : raw.name != null
              ? String(raw.name).trim()
              : 'map';
    /** @type {object} */
    const pack = {
        version: floorInt(raw.version, HYBRID_VERSION) || HYBRID_VERSION,
        id,
        label: raw.label != null ? String(raw.label) : id,
        floors: Object.create(null),
        spawns: raw.spawns != null ? raw.spawns : null
    };

    if (Array.isArray(raw.floors)) {
        for (let i = 0; i < raw.floors.length; i++) {
            const f = normalizeTileMapFloor(raw.floors[i]);
            if (f) pack.floors[String(f.z)] = f;
        }
    } else if (raw.floors && typeof raw.floors === 'object') {
        const keys = Object.keys(raw.floors);
        for (let i = 0; i < keys.length; i++) {
            const f = normalizeTileMapFloor(
                Object.assign({}, raw.floors[keys[i]], {
                    z:
                        raw.floors[keys[i]].z != null
                            ? raw.floors[keys[i]].z
                            : keys[i]
                })
            );
            if (f) pack.floors[String(f.z)] = f;
        }
    }
    return pack;
}

/**
 * Encode Uint8Array / Uint16Array to Node Buffer (copy).
 * @param {Uint8Array|Uint16Array} arr
 * @returns {Buffer}
 */
function typedToBuffer(arr) {
    // Node Buffer when available; Uint8Array otherwise (browser hybrid serialize).
    if (typeof Buffer !== 'undefined') {
        if (arr instanceof Uint16Array) {
            return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
        }
        if (arr instanceof Uint8Array) {
            return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
        }
        return Buffer.from(arr);
    }
    if (arr instanceof Uint16Array) {
        return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength).slice();
    }
    if (arr instanceof Uint8Array) {
        return arr.slice ? arr.slice() : new Uint8Array(arr);
    }
    return new Uint8Array(arr);
}

/**
 * @param {Buffer|Uint8Array} buf
 * @param {number} n
 * @returns {Uint8Array}
 */
function bufferToU8(buf, n) {
    const out = new Uint8Array(n);
    const src = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const len = Math.min(n, src.length);
    for (let i = 0; i < len; i++) out[i] = src[i];
    return out;
}

/**
 * @param {Buffer|Uint8Array} buf
 * @param {number} n
 * @returns {Uint16Array}
 */
function bufferToU16(buf, n) {
    const out = new Uint16Array(n);
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    // little-endian pairs
    const pairs = Math.min(n, Math.floor(u8.length / 2));
    for (let i = 0; i < pairs; i++) {
        out[i] = u8[i * 2] | (u8[i * 2 + 1] << 8);
    }
    return out;
}

/**
 * True when every sample in the first `n` entries is 0 (or array missing).
 * Used to omit empty sub-layers / fields from hybrid packs (PNG-bootstrap maps).
 *
 * @param {ArrayLike<number>|null|undefined} arr
 * @param {number} n
 * @returns {boolean}
 */
function isAllZero(arr, n) {
    if (!arr || n <= 0) return true;
    const len = Math.min(n, arr.length | 0);
    for (let i = 0; i < len; i++) {
        if (arr[i]) return false;
    }
    return true;
}

/**
 * Build JSON-serializable meta + gzip binary blob map for a hybrid pack.
 * Blob keys are relative paths under the pack directory (`*.u8.gz` / `*.u16.gz`).
 * Empty sub-layers (all palette 0) and empty fields are omitted from blobs.
 * Blob values are always gzip-compressed (no raw on-disk / transport format).
 *
 * @param {object} pack normalized hybrid pack
 * @returns {{ meta: object, blobs: Record<string, Buffer|Uint8Array> }}
 */
function serializeHybridPack(pack) {
    const p = pack.floors ? pack : normalizeHybridPack(pack);
    if (!p) throw new Error('serializeHybridPack: invalid pack');

    /** @type {Record<string, Buffer|Uint8Array>} */
    const blobs = Object.create(null);
    /** @type {object[]} */
    const floorsMeta = [];

    const zKeys = Object.keys(p.floors).sort((a, b) => Number(a) - Number(b));
    for (let fi = 0; fi < zKeys.length; fi++) {
        const floor = ensureSubLayers(p.floors[zKeys[fi]]);
        const z = floor.z;
        const zKey = String(z);
        const n = floor.cols * floor.rows;
        const prefix = `floors/${zKey}`;

        /** @type {object[]} */
        const subMeta = [];
        for (let i = 0; i < floor.subLayers.length; i++) {
            const sl = floor.subLayers[i];
            if (isAllZero(sl.cells, n)) {
                // No stamps on this sub-layer — keep meta row, no blob (deserialize fills zeros).
                subMeta.push({ id: sl.id, zOrder: sl.zOrder, blob: null, empty: true });
                continue;
            }
            const rel = hybridBlobRelU16(prefix, `sub_${sl.id}`);
            blobs[rel] = gzipBytes(typedToBuffer(sl.cells));
            subMeta.push({ id: sl.id, zOrder: sl.zOrder, blob: rel });
        }

        /** @type {object} */
        const channels = {};
        if (floor.friction) {
            const rel = hybridBlobRelU8(prefix, 'friction');
            blobs[rel] = gzipBytes(typedToBuffer(floor.friction));
            channels.friction = rel;
        }
        if (floor.sight) {
            const rel = hybridBlobRelU8(prefix, 'sight');
            blobs[rel] = gzipBytes(typedToBuffer(floor.sight));
            channels.sight = rel;
        }
        if (floor.flags) {
            const rel = hybridBlobRelU8(prefix, 'flags');
            blobs[rel] = gzipBytes(typedToBuffer(floor.flags));
            channels.flags = rel;
        }
        if (floor.fields && !isAllZero(floor.fields, n)) {
            const rel = hybridBlobRelU8(prefix, 'fields');
            blobs[rel] = gzipBytes(typedToBuffer(floor.fields));
            channels.fields = rel;
        }
        let overrideRel = null;
        if (floor.overrideMask) {
            // Only write if any bit set
            let any = false;
            for (let i = 0; i < n; i++) {
                if (floor.overrideMask[i]) {
                    any = true;
                    break;
                }
            }
            if (any) {
                overrideRel = hybridBlobRelU8(prefix, 'override');
                blobs[overrideRel] = gzipBytes(typedToBuffer(floor.overrideMask));
            }
        }

        // Palette: strip live role objects for JSON (keep roleId + hop)
        const paletteJson = floor.palette.map((e, idx) => {
            if (idx === 0 || !e) return null;
            /** @type {object} */
            const pe = {
                catalogId: e.catalogId,
                kind: e.kind || 'tiles',
                roleId: e.roleId || null
            };
            if (e.scale != null) pe.scale = e.scale;
            if (e.anchor != null) pe.anchor = e.anchor;
            if (e.hop) pe.hop = e.hop;
            if (e.wangFamily) pe.wangFamily = e.wangFamily;
            if (e.wangMask != null) pe.wangMask = e.wangMask;
            if (e.wangInner) pe.wangInner = e.wangInner;
            if (e.wallFamily) pe.wallFamily = e.wallFamily;
            if (e.wallAlign) pe.wallAlign = e.wallAlign;
            if (e.wangLocked) pe.wangLocked = true;
            return pe;
        });

        floorsMeta.push({
            z: floor.z,
            cols: floor.cols,
            rows: floor.rows,
            palette: paletteJson,
            subLayers: subMeta,
            channels,
            overrideMask: overrideRel,
            stairs: Array.isArray(floor.stairs) ? floor.stairs : []
        });
    }

    const meta = {
        version: p.version || HYBRID_VERSION,
        id: p.id,
        label: p.label,
        floors: floorsMeta,
        spawns: p.spawns
    };
    return { meta, blobs };
}

/**
 * Resolve gzip blob bytes from the transport map (keys match meta paths).
 * @param {Record<string, Buffer|Uint8Array>} blobMap
 * @param {string} rel
 * @returns {Uint8Array}
 */
function requireGunzippedBlob(blobMap, rel) {
    const buf = blobMap[rel];
    if (!buf) {
        throw new Error(`deserializeHybridPack: missing blob ${rel}`);
    }
    if (!isHybridGzipBlobRel(rel)) {
        throw new Error(
            `deserializeHybridPack: blob path must end with .u8.gz or .u16.gz (got ${rel})`
        );
    }
    return gunzipBytes(buf, rel);
}

/**
 * Rehydrate hybrid pack from meta JSON + gzip blob buffers.
 * Blob paths must be `*.u8.gz` / `*.u16.gz`; values must be gzip (no raw).
 *
 * @param {object} meta
 * @param {Record<string, Buffer|Uint8Array>} blobs
 * @returns {object} normalized pack
 */
function deserializeHybridPack(meta, blobs) {
    if (!meta || typeof meta !== 'object') {
        throw new Error('deserializeHybridPack: meta required');
    }
    const blobMap = blobs || {};
    /** @type {object[]} */
    const floors = [];
    const list = Array.isArray(meta.floors) ? meta.floors : [];

    for (let i = 0; i < list.length; i++) {
        const fm = list[i];
        if (!fm) continue;
        const cols = Math.max(1, floorInt(fm.cols, 1));
        const rows = Math.max(1, floorInt(fm.rows, 1));
        const n = cols * rows;
        /** @type {(object|null)[]} */
        const palette = [null];
        if (Array.isArray(fm.palette)) {
            for (let pi = 1; pi < fm.palette.length; pi++) {
                palette.push(normalizePaletteEntry(fm.palette[pi]));
            }
            // If author omitted reserved null at 0, treat entire array as 1-based entries
            if (fm.palette.length > 0 && fm.palette[0] != null && fm.palette[0].catalogId) {
                palette.length = 1;
                for (let pi = 0; pi < fm.palette.length; pi++) {
                    palette.push(normalizePaletteEntry(fm.palette[pi]));
                }
            }
        }
        /** @type {object} */
        const floor = {
            z: fm.z != null ? fm.z : i,
            cols,
            rows,
            palette,
            subLayers: [],
            stairs: Array.isArray(fm.stairs) ? fm.stairs.slice() : []
        };

        const subList = Array.isArray(fm.subLayers) ? fm.subLayers : [];
        for (let s = 0; s < subList.length; s++) {
            const sm = subList[s];
            if (!sm) continue;
            const zOrder = sm.zOrder != null ? sm.zOrder : s;
            // Omitted / empty blob → all-zero stamp cells (PNG bootstrap, sparse packs).
            if (!sm.blob || sm.empty) {
                floor.subLayers.push({
                    id: sm.id,
                    zOrder,
                    cells: new Uint16Array(n)
                });
                continue;
            }
            const raw = requireGunzippedBlob(blobMap, sm.blob);
            floor.subLayers.push({
                id: sm.id,
                zOrder,
                cells: bufferToU16(raw, n)
            });
        }

        const ch = fm.channels && typeof fm.channels === 'object' ? fm.channels : {};
        if (ch.friction) {
            floor.friction = bufferToU8(requireGunzippedBlob(blobMap, ch.friction), n);
        }
        if (ch.sight) {
            floor.sight = bufferToU8(requireGunzippedBlob(blobMap, ch.sight), n);
        }
        if (ch.flags) {
            floor.flags = bufferToU8(requireGunzippedBlob(blobMap, ch.flags), n);
        }
        if (ch.fields) {
            floor.fields = bufferToU8(requireGunzippedBlob(blobMap, ch.fields), n);
        }
        if (fm.overrideMask) {
            floor.overrideMask = bufferToU8(requireGunzippedBlob(blobMap, fm.overrideMask), n);
        }

        floors.push(floor);
    }

    return normalizeHybridPack({
        version: meta.version,
        id: meta.id,
        label: meta.label,
        floors,
        spawns: meta.spawns
    });
}

/**
 * Write hybrid pack to a directory (map.json + blob files).
 * @param {string} dir
 * @param {object} pack
 * @returns {{ metaPath: string, blobs: string[] }}
 */
function writeHybridMapDir(dir, pack) {
    const { meta, blobs } = serializeHybridPack(pack);
    fs.mkdirSync(dir, { recursive: true });
    const metaPath = path.join(dir, HYBRID_META_NAME);
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf8');
    const written = [];
    const keys = Object.keys(blobs);
    for (let i = 0; i < keys.length; i++) {
        const rel = keys[i];
        const abs = path.join(dir, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, blobs[rel]);
        written.push(rel);
    }
    return { metaPath, blobs: written };
}

/**
 * Read hybrid pack from directory.
 * @param {string} dir
 * @returns {object} normalized pack
 */
function readHybridMapDir(dir) {
    const metaPath = path.join(dir, HYBRID_META_NAME);
    if (!fs.existsSync(metaPath)) {
        throw new Error(`readHybridMapDir: missing ${HYBRID_META_NAME} in ${dir}`);
    }
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    /** @type {Record<string, Buffer>} */
    const blobs = Object.create(null);

    // Explicit paths from meta (gzip files only)
    const floors = Array.isArray(meta.floors) ? meta.floors : [];
    for (let i = 0; i < floors.length; i++) {
        const fm = floors[i];
        if (!fm) continue;
        const subs = Array.isArray(fm.subLayers) ? fm.subLayers : [];
        for (let s = 0; s < subs.length; s++) {
            if (subs[s] && subs[s].blob) {
                const rel = subs[s].blob;
                if (!isHybridGzipBlobRel(rel)) {
                    throw new Error(`readHybridMapDir: non-gzip blob path ${rel}`);
                }
                blobs[rel] = fs.readFileSync(path.join(dir, rel));
            }
        }
        const ch = fm.channels || {};
        ['friction', 'sight', 'flags', 'fields'].forEach((k) => {
            if (ch[k]) {
                if (!isHybridGzipBlobRel(ch[k])) {
                    throw new Error(`readHybridMapDir: non-gzip blob path ${ch[k]}`);
                }
                blobs[ch[k]] = fs.readFileSync(path.join(dir, ch[k]));
            }
        });
        if (fm.overrideMask) {
            if (!isHybridGzipBlobRel(fm.overrideMask)) {
                throw new Error(`readHybridMapDir: non-gzip blob path ${fm.overrideMask}`);
            }
            blobs[fm.overrideMask] = fs.readFileSync(path.join(dir, fm.overrideMask));
        }
    }
    return deserializeHybridPack(meta, blobs);
}

/**
 * Detect whether a directory looks like a hybrid map pack.
 * @param {string} dir
 * @returns {boolean}
 */
function isHybridMapDir(dir) {
    try {
        return fs.existsSync(path.join(dir, HYBRID_META_NAME));
    } catch (_e) {
        return false;
    }
}

/**
 * Bake all floors in a pack that need channels (no pre-baked friction, or force).
 * Updates floor.friction/sight/flags in place; returns bake results by z.
 *
 * @param {object} pack
 * @param {{
 *   roleCatalog?: Map|object|null,
 *   force?: boolean
 * }} [opts]
 * @returns {Record<string, ReturnType<typeof bakeTileMapFloor>>}
 */
function bakeHybridPack(pack, opts) {
    const o = opts || {};
    const p = pack.floors ? pack : normalizeHybridPack(pack);
    if (!p) throw new Error('bakeHybridPack: invalid pack');
    /** @type {Record<string, object>} */
    const results = Object.create(null);
    const keys = Object.keys(p.floors);
    for (let i = 0; i < keys.length; i++) {
        const floor = p.floors[keys[i]];
        const needBake =
            o.force ||
            !floor.friction ||
            floor.friction.length < floor.cols * floor.rows;
        if (!needBake) {
            // Keep stored channels. Still collect verticals so stair hops
            // register — editor packs always have baked friction/flags.
            results[keys[i]] = {
                cols: floor.cols,
                rows: floor.rows,
                z: floor.z,
                friction: floor.friction,
                sight:
                    floor.sight ||
                    defaultSightFromFriction(floor.friction, floor.cols * floor.rows),
                flags: floor.flags || new Uint8Array(floor.cols * floor.rows),
                verticals: collectFloorVerticals(floor, o.roleCatalog),
                cells: []
            };
            continue;
        }
        const baked = bakeTileMapFloor(floor, {
            roleCatalog: o.roleCatalog,
            applyOverrides: true
        });
        floor.friction = baked.friction;
        floor.sight = baked.sight;
        floor.flags = baked.flags;
        results[keys[i]] = baked;
    }
    return results;
}

/**
 * @param {Uint8Array} friction
 * @param {number} n
 * @returns {Uint8Array}
 */
function defaultSightFromFriction(friction, n) {
    const sight = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        sight[i] = friction[i] === FRICTION_BLOCKED ? SIGHT_BLOCKED : 0;
    }
    return sight;
}

/**
 * Coerce numeric floor keys for deltaZ (mirrors TileMap.applyFloorDelta).
 * @param {string|number} z
 * @param {number} deltaZ
 * @returns {string|number}
 */
function applyHybridFloorDelta(z, deltaZ) {
    const n = Number(z);
    if (Number.isFinite(n) && String(n) === String(z).trim()) {
        return n + deltaZ;
    }
    return z;
}

/**
 * Editor / hybrid stair row → `{ from, to }` link for `addStairLinks`.
 * Authoring saves `{ x, y, z, dir, type, deltaZ, to, bidirectional }` (`to` often null).
 * Missing `bidirectional` is **false** (one-way). Runtime `addStairLinks`
 * requires `from` + `to` and skips anything else.
 *
 * @param {*} row
 * @returns {{
 *   from: { x: number, y: number, z: string|number },
 *   to: { x: number, y: number, z: string|number },
 *   dir: string,
 *   type: string|null,
 *   link: string|null,
 *   bidirectional: boolean|null,
 *   exitDx: number,
 *   exitDy: number,
 *   deltaZ: number
 * }|null}
 */
function resolveEditorStairLink(row) {
    if (!row || typeof row !== 'object') return null;

    const fromRaw = row.from && typeof row.from === 'object' ? row.from : row;
    if (fromRaw.x == null || fromRaw.y == null) return null;
    const from = {
        x: Math.round(Number(fromRaw.x) || 0),
        y: Math.round(Number(fromRaw.y) || 0),
        z: fromRaw.z != null ? fromRaw.z : row.z
    };

    const dirRaw =
        row.dir != null
            ? String(row.dir).trim().toLowerCase()
            : 'center';
    const dirs = { center: 1, north: 1, south: 1, east: 1, west: 1 };
    const dir = dirs[dirRaw] ? dirRaw : 'center';
    const off = hopDirOffset(dir);
    const deltaZ =
        row.deltaZ != null && Number.isFinite(Number(row.deltaZ))
            ? Math.trunc(Number(row.deltaZ))
            : 0;

    const toRaw = row.to && typeof row.to === 'object' ? row.to : null;
    let to;
    if (toRaw && toRaw.x != null && toRaw.y != null) {
        to = {
            x: Math.round(Number(toRaw.x) || 0),
            y: Math.round(Number(toRaw.y) || 0),
            z:
                toRaw.z !== undefined && toRaw.z !== null
                    ? toRaw.z
                    : applyHybridFloorDelta(from.z, deltaZ)
        };
    } else {
        to = {
            x: from.x + off.dx,
            y: from.y + off.dy,
            z: applyHybridFloorDelta(from.z, deltaZ)
        };
    }

    if (from.x === to.x && from.y === to.y && String(from.z) === String(to.z)) {
        return null;
    }

    return {
        from,
        to,
        dir,
        type: row.type != null ? String(row.type) : null,
        link: row.link != null ? String(row.link) : null,
        // Authored hybrid rows are one-way unless the designer set the flag.
        // Procedural pairing still uses hunt stairLinks + setStairs default.
        bidirectional:
            row.bidirectional !== undefined && row.bidirectional !== null
                ? !!row.bidirectional
                : false,
        exitDx: off.dx,
        exitDy: off.dy,
        deltaZ
    };
}

/**
 * Dest floors referenced by hybrid stair rows and not already in the pack.
 * @param {object|null|undefined} pack
 * @returns {Array<string|number>}
 */
function collectHybridStairDestFloors(pack) {
    const p = pack && pack.floors ? pack : null;
    if (!p) return [];
    /** @type {Array<string|number>} */
    const out = [];
    const seen = Object.create(null);
    const keys = Object.keys(p.floors);
    for (let i = 0; i < keys.length; i++) {
        const floor = p.floors[keys[i]];
        const stairs = floor && Array.isArray(floor.stairs) ? floor.stairs : [];
        for (let s = 0; s < stairs.length; s++) {
            const link = resolveEditorStairLink(stairs[s]);
            if (!link) continue;
            const z = link.to.z;
            const k = String(z);
            if (seen[k]) continue;
            if (p.floors[k] || p.floors[z]) continue;
            seen[k] = true;
            out.push(z);
        }
    }
    return out;
}

/**
 * Vertical placements for stair register when channels are already baked
 * (skip-rebake path). Prefer `floor.stairs` meta; else scan the vertical layer.
 *
 * @param {object} floor
 * @param {Map|object|null} [roleCatalog]
 * @returns {Array<{ x: number, y: number, z: string|number, placement: object }>}
 */
function collectFloorVerticals(floor, roleCatalog) {
    /** @type {Array<{ x: number, y: number, z: string|number, placement: object }>} */
    const verticals = [];
    if (!floor) return verticals;

    if (Array.isArray(floor.stairs) && floor.stairs.length) {
        for (let i = 0; i < floor.stairs.length; i++) {
            const s = floor.stairs[i];
            if (!s || s.x == null || s.y == null) continue;
            const deltaZ =
                s.deltaZ != null && Number.isFinite(Number(s.deltaZ))
                    ? Math.trunc(Number(s.deltaZ))
                    : 0;
            const dir = s.dir != null ? String(s.dir) : 'center';
            verticals.push({
                x: s.x | 0,
                y: s.y | 0,
                z: floor.z,
                placement: {
                    type: s.type || 'stairs',
                    deltaZ,
                    dir,
                    bidirectional: !!s.bidirectional,
                    registerStairLink: true,
                    hop: {
                        dir,
                        deltaZ,
                        to: s.to || null
                    }
                }
            });
        }
        return verticals;
    }

    const cols = floor.cols | 0;
    const rows = floor.rows | 0;
    const sl = (floor.subLayers || []).find((s) => s && s.id === 'vertical');
    if (!sl || !sl.cells) return verticals;
    for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
            if (!(sl.cells[y * cols + x] | 0)) continue;
            const stack = stackAtCell(floor, x, y);
            for (let si = stack.length - 1; si >= 0; si--) {
                const ent = stack[si];
                const se = placementToStackEntry(ent, roleCatalog);
                if (se && se.role && se.role.vertical) {
                    verticals.push({
                        x,
                        y,
                        z: floor.z,
                        placement: {
                            role: se.role,
                            vertical: se.role.vertical,
                            hop: se.hop || ent.hop || null
                        }
                    });
                    break;
                }
            }
        }
    }
    return verticals;
}

/**
 * Load a hybrid pack onto a TileMap (bake if needed + apply floors + stairs).
 *
 * @param {object} map TileMap
 * @param {object|string} packOrDir pack object or directory path
 * @param {{
 *   roleCatalog?: Map|object|null,
 *   forceBake?: boolean,
 *   zFilter?: Array<string|number>|null
 * }} [opts]
 * @returns {{ pack: object, baked: Record<string, object> }}
 */
function loadHybridOntoTileMap(map, packOrDir, opts) {
    const o = opts || {};
    let pack =
        typeof packOrDir === 'string'
            ? readHybridMapDir(packOrDir)
            : normalizeHybridPack(packOrDir);
    if (!pack) throw new Error('loadHybridOntoTileMap: invalid pack');

    const baked = bakeHybridPack(pack, {
        roleCatalog: o.roleCatalog,
        force: !!o.forceBake
    });

    if (o.roleCatalog && typeof map.setTileRoleCatalog === 'function') {
        map.setTileRoleCatalog(o.roleCatalog);
    }

    const zKeys = Object.keys(pack.floors);
    for (let i = 0; i < zKeys.length; i++) {
        const zKey = zKeys[i];
        if (o.zFilter && o.zFilter.length) {
            const ok = o.zFilter.some((z) => String(z) === zKey);
            if (!ok) continue;
        }
        const floor = pack.floors[zKey];
        const br = baked[zKey];
        applyBakeToTileMap(map, floor.z, br, {
            fields: floor.fields || null,
            registerVertical: true
        });
        // Phase 6: keep authoring stacks for terrain cache + tall-prop y-sort
        if (typeof map.setAuthoringFloor === 'function') {
            map.setAuthoringFloor(floor.z, floor);
        }
        // Explicit stairs from meta (in addition to vertical bake).
        // Editor rows are `{ x, y, z, deltaZ, to }` — convert before addStairLinks.
        // One-way: do not invent a reverse pad on the dest tile. Legacy / hybrid
        // maps only hop where a vertical stamp was painted. Procedural caves
        // still pair both sockets via hunt stairLinks + setStairs.
        if (Array.isArray(floor.stairs) && floor.stairs.length && typeof map.addStairLinks === 'function') {
            /** @type {object[]} */
            const links = [];
            for (let s = 0; s < floor.stairs.length; s++) {
                const link = resolveEditorStairLink(floor.stairs[s]);
                if (link) links.push(link);
            }
            if (links.length) {
                map.addStairLinks(links, { bidirectional: false });
            }
        }
    }
    return { pack, baked };
}

// ─── Legacy PNG bootstrap + export ───────────────────────────────────────────

/**
 * Bootstrap a TileMapFloor / pack from legacy path PNG (friction/collision).
 * TileMap sub-layers start empty; channels seeded from PNG decode.
 *
 * @param {string|number} z
 * @param {string} pathPng filesystem path
 * @param {{
 *   spawns?: *|null,
 *   cols?: number,
 *   rows?: number
 * }} [opts]
 * @returns {Promise<{ floor: object, pack: object }>}
 */
async function bootstrapFloorFromPathPng(z, pathPng, opts) {
    const o = opts || {};
    // Reuse TileMap decode
    const { TileMap } = require('../../entities/tilemap.js');
    const tmp = new TileMap();
    await tmp.loadFloor(z, pathPng);
    const layer = tmp.getLayer ? tmp.getLayer(z) : tmp.layers[String(z)];
    if (!layer) throw new Error('bootstrapFloorFromPathPng: load failed');

    const floor = createEmptyTileMapFloor(layer.cols, layer.rows, { z });
    floor.friction = new Uint8Array(layer.friction);
    floor.sight = new Uint8Array(layer.sight);
    floor.flags = new Uint8Array(layer.flags);
    if (layer.fields) floor.fields = new Uint8Array(layer.fields);

    const pack = normalizeHybridPack({
        id: `bootstrap_z${z}`,
        floors: [floor],
        spawns: o.spawns != null ? o.spawns : null
    });
    return { floor: pack.floors[String(z)], pack };
}

/**
 * Resolve load path: hybrid dir → PNG bootstrap → null.
 *
 * @param {{
 *   hybridDir?: string|null,
 *   pathPng?: string|null,
 *   z?: string|number,
 *   spawns?: *
 * }} opts
 * @returns {Promise<{
 *   source: 'hybrid'|'png'|'none',
 *   pack: object|null
 * }>}
 */
async function resolveMapLoad(opts) {
    const o = opts || {};
    if (o.hybridDir && isHybridMapDir(o.hybridDir)) {
        return { source: 'hybrid', pack: readHybridMapDir(o.hybridDir) };
    }
    if (o.pathPng && fs.existsSync(o.pathPng)) {
        const z = o.z != null ? o.z : 0;
        const { pack } = await bootstrapFloorFromPathPng(z, o.pathPng, {
            spawns: o.spawns
        });
        return { source: 'png', pack };
    }
    return { source: 'none', pack: null };
}

/**
 * Pad numeric floor ids the same way as legacy map assets (`06`, `07`).
 * @param {string|number} floorId
 * @returns {string}
 */
function padHybridFloorId(floorId) {
    const raw = String(floorId);
    return /^\d+$/.test(raw) ? raw.padStart(2, '0') : raw;
}

/**
 * Absolute hybrid pack directory for a floor under the maps root.
 * @param {string|number} floorId
 * @param {string} [mapsRoot]
 * @returns {string}
 */
function hybridMapDirForFloor(floorId, mapsRoot) {
    const root =
        mapsRoot ||
        (function () {
            try {
                return require('../../../settings.js').PATHS.maps;
            } catch (_e) {
                return path.join(process.cwd(), 'assets', 'legacy', 'map');
            }
        })();
    return path.join(root, 'hybrid', `floor-${padHybridFloorId(floorId)}`);
}

/**
 * Load and merge hybrid packs for the given floors when pack dirs exist (Node).
 * Returns null when no hybrid pack is present (caller falls back to path PNG).
 *
 * @param {Array<string|number>|null|undefined} floorIds
 * @param {{ mapsRoot?: string|null, id?: string }} [opts]
 * @returns {object|null} normalized hybrid pack
 */
function tryResolveHybridMapPack(floorIds, opts) {
    const o = opts || {};
    const list = Array.isArray(floorIds) ? floorIds : [];
    if (!list.length) return null;
    /** @type {object[]} */
    const floors = [];
    /** @type {object[]} */
    const spawns = [];
    for (let i = 0; i < list.length; i++) {
        const z = list[i];
        const dir = hybridMapDirForFloor(z, o.mapsRoot || undefined);
        if (!isHybridMapDir(dir)) continue;
        try {
            const pack = readHybridMapDir(dir);
            const keys = Object.keys(pack.floors || {});
            for (let k = 0; k < keys.length; k++) {
                floors.push(pack.floors[keys[k]]);
            }
            if (Array.isArray(pack.spawns)) {
                for (let s = 0; s < pack.spawns.length; s++) {
                    spawns.push(pack.spawns[s]);
                }
            }
        } catch (_e) {
            // Missing/corrupt pack — skip floor
        }
    }
    if (!floors.length) return null;
    return normalizeHybridPack({
        id: o.id || 'auto_hybrid',
        label: 'Auto hybrid (editor packs)',
        floors,
        spawns: spawns.length ? spawns : null
    });
}

/**
 * Export friction/sight/flags as a path-PNG buffer (Node, pngjs).
 * @param {Uint8Array} friction
 * @param {number} cols
 * @param {number} rows
 * @param {{ sight?: Uint8Array|null, flags?: Uint8Array|null }} [opts]
 * @returns {Buffer}
 */
function exportChannelsToPngBuffer(friction, cols, rows, opts) {
    const rgba = frictionToRgba(friction, cols, rows, opts || {});
    const { PNG } = require('pngjs');
    const png = new PNG({ width: cols, height: rows });
    // png.data is Buffer length cols*rows*4
    Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength).copy(png.data);
    return PNG.sync.write(png);
}

/**
 * Write path-PNG export to disk.
 * @param {string} filePath
 * @param {Uint8Array} friction
 * @param {number} cols
 * @param {number} rows
 * @param {{ sight?: Uint8Array|null, flags?: Uint8Array|null }} [opts]
 * @returns {string} filePath
 */
function exportChannelsToPngFile(filePath, friction, cols, rows, opts) {
    const buf = exportChannelsToPngBuffer(friction, cols, rows, opts);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, buf);
    return filePath;
}

/**
 * Helper: set palette index on a sub-layer cell.
 * @param {object} floor
 * @param {string} subLayerId
 * @param {number} x
 * @param {number} y
 * @param {number} paletteIndex
 */
function setSubLayerCell(floor, subLayerId, x, y, paletteIndex) {
    ensureSubLayers(floor);
    const cols = floor.cols | 0;
    const rows = floor.rows | 0;
    if (x < 0 || y < 0 || x >= cols || y >= rows) return;
    const sl = floor.subLayers.find((s) => s.id === subLayerId);
    if (!sl) return;
    sl.cells[y * cols + x] = paletteIndex & 0xffff;
}

/**
 * Append a palette entry; returns new index.
 * @param {object} floor
 * @param {object} entry raw placement
 * @returns {number}
 */
function addPaletteEntry(floor, entry) {
    const pe = normalizePaletteEntry(entry);
    if (!pe) throw new Error('addPaletteEntry: invalid entry');
    floor.palette.push(pe);
    return floor.palette.length - 1;
}

module.exports = {
    SUB_LAYER_DEFS,
    SUB_LAYER_IDS,
    OVERRIDE_FRICTION,
    OVERRIDE_SIGHT,
    OVERRIDE_FLAGS,
    HYBRID_VERSION,
    HYBRID_META_NAME,
    gzipBytes,
    gunzipBytes,
    hybridBlobRelU8,
    hybridBlobRelU16,
    isHybridGzipBlobRel,
    FRICTION_BLOCKED,
    SIGHT_BLOCKED,
    DEFAULT_OPEN_FRICTION,
    // re-exports for convenience
    applyInfluence,
    applyRole,
    bakeCellChannels,
    finalizeBakeCell,
    createBakeAccumulator,
    hopDirOffset,
    resolveTileRole,
    indexTileRoles,
    normalizePaletteEntry,
    createEmptySubLayers,
    createEmptyTileMapFloor,
    ensureSubLayers,
    normalizeTileMapFloor,
    stackAtCell,
    placementToStackEntry,
    bakeCellFromFloor,
    bakeTileMapFloor,
    bakeCellRect,
    bakeCellIndices,
    diffOverrides,
    applyBakeToTileMap,
    normalizeHybridPack,
    serializeHybridPack,
    deserializeHybridPack,
    writeHybridMapDir,
    readHybridMapDir,
    isHybridMapDir,
    bakeHybridPack,
    loadHybridOntoTileMap,
    resolveEditorStairLink,
    collectHybridStairDestFloors,
    collectFloorVerticals,
    bootstrapFloorFromPathPng,
    resolveMapLoad,
    padHybridFloorId,
    hybridMapDirForFloor,
    tryResolveHybridMapPack,
    exportChannelsToPngBuffer,
    exportChannelsToPngFile,
    setSubLayerCell,
    addPaletteEntry
};
