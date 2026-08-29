/**
 * TileMap editor session (Phase 5).
 *
 * Pure authoring helpers for the map editor: palette stamps, sub-layer paint,
 * Wang-16 family resolve on `path` overlays, sparse dirty-cell bake into
 * friction/sight/flags (not stroke AABB), override masks, undo/redo, hybrid
 * pack packaging. Fields are never written by bake; map-seeded fields use a
 * long default TTL constant for runtime seeding.
 *
 * Does not touch DOM or the filesystem — IO stays in the wiki page / PHP API.
 */

'use strict';

const {
    SUB_LAYER_DEFS,
    SUB_LAYER_IDS,
    OVERRIDE_FRICTION,
    OVERRIDE_SIGHT,
    OVERRIDE_FLAGS,
    createEmptyTileMapFloor,
    ensureSubLayers,
    normalizeTileMapFloor,
    normalizePaletteEntry,
    addPaletteEntry,
    setSubLayerCell,
    bakeTileMapFloor,
    bakeCellIndices,
    normalizeHybridPack,
    serializeHybridPack,
    deserializeHybridPack,
    resolveEditorStairLink,
    isExplicitEditorStairDest,
    normalizeEditorStairDest
} = require('./tilemap_bake.js');

const {
    indexTileRoles,
    normalizeEntityId,
    FRICTION_BLOCKED,
    TILE_FLAG_PZ_PACKAGE,
    TILE_FLAG_NO_CAST,
    TILE_FLAG_NO_CREATURE,
    TILE_FLAG_STAIR,
    TILE_FLAG_LADDER,
    TILE_FLAG_HOLE,
    TILE_FLAG_ROPE_SPOT,
    TILE_FLAG_SHOVEL_SPOT,
    normalizePartialInfluence,
    influenceKey
} = require('./tile_roles.js');

const {
    wangFamilyOf,
    wangCatalogId,
    wangMaskFromCardinals,
    expandWangRing,
    parseWangId,
    emptyWangInners,
    resolveWangOverlay
} = require('../overlay_wang.js');

const {
    wallFamilyOf,
    wallAlignOf,
    wallCatalogId,
    isWallWang,
    isHopStamp,
    resolveWallAlign,
    familyAlignSet,
    parseWallId,
    WALL_ALIGN_ALL
} = require('../wall_wang.js');

/**
 * Binary walk class for bucket connectivity (matches A*: only 255 blocks).
 * @param {number} friction
 * @returns {0|1} 0 = open, 1 = blocked
 */
function frictionWalkClass(friction) {
    return (friction & 0xff) === FRICTION_BLOCKED ? 1 : 0;
}

/** UI list order: top → bottom (vertical on top, ground last). */
const UI_SUB_LAYER_ORDER = Object.freeze([
    'vertical',
    'furniture',
    'scenery',
    'path',
    'ground'
]);

/**
 * Default duration for map-seeded elemental fields (seconds).
 * Longer than combat fields; above active-heap max so map fields persist.
 */
const MAP_FIELD_DEFAULT_TTL_SEC = 7 * 24 * 3600; // 1 week

/** Prefer these sub-layers when stamping a role from the palette. */
const ROLE_DEFAULT_SUBLAYER = Object.freeze({
    floor: 'ground',
    water: 'ground',
    wall: 'ground',
    void: 'ground',
    path: 'path',
    protection: 'ground',
    grate: 'path',
    scenery_blocking: 'scenery',
    scenery_cover: 'scenery',
    furniture_blocking: 'furniture',
    stairs_up: 'vertical',
    stairs_down: 'vertical',
    ladder_up: 'vertical',
    ladder_down: 'vertical',
    hole: 'vertical',
    rope_spot: 'vertical',
    shovel_spot: 'vertical'
});

/** Simple preview colors for composite / palette swatches (role id → CSS hex). */
const ROLE_PREVIEW_COLORS = Object.freeze({
    floor: '#5a8f3c',
    path: '#8b7355',
    wall: '#555555',
    water: '#2a6db0',
    void: '#111111',
    protection: '#33cc55',
    grate: '#8888aa',
    scenery_blocking: '#2d5a1e',
    scenery_cover: '#3d7a2e',
    furniture_blocking: '#8b4513',
    stairs_up: '#c9a227',
    stairs_down: '#a07020',
    ladder_up: '#c44b3c',
    ladder_down: '#8a3028',
    hole: '#402020',
    rope_spot: '#2060a0',
    shovel_spot: '#a06020'
});

const MAX_UNDO = 64;

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
 * Expand a brush footprint around (cx,cy).
 * @param {number} cx
 * @param {number} cy
 * @param {number} size
 * @param {string} shape
 * @param {(x: number, y: number) => void} plot
 */
function forEachBrushCell(cx, cy, size, shape, plot) {
    const s = Math.max(1, size | 0);
    const half = Math.floor(s / 2);
    const x0 = (cx | 0) - half;
    const y0 = (cy | 0) - half;
    if (s === 1) {
        plot(cx | 0, cy | 0);
        return;
    }
    if (shape === 'circle') {
        const r = (s - 1) / 2;
        const r2 = r * r + 0.25;
        for (let dy = 0; dy < s; dy++) {
            for (let dx = 0; dx < s; dx++) {
                const fx = dx - r;
                const fy = dy - r;
                if (fx * fx + fy * fy <= r2) plot(x0 + dx, y0 + dy);
            }
        }
    } else if (shape === 'diamond') {
        const r = Math.floor((s - 1) / 2);
        for (let dy = 0; dy < s; dy++) {
            for (let dx = 0; dx < s; dx++) {
                if (Math.abs(dx - half) + Math.abs(dy - half) <= r) {
                    plot(x0 + dx, y0 + dy);
                }
            }
        }
    } else if (shape === 'cross') {
        for (let i = 0; i < s; i++) {
            plot(x0 + half, y0 + i);
            plot(x0 + i, y0 + half);
        }
    } else if (shape === 'dither') {
        for (let dy = 0; dy < s; dy++) {
            for (let dx = 0; dx < s; dx++) {
                if (((x0 + dx + y0 + dy) & 1) === 0) plot(x0 + dx, y0 + dy);
            }
        }
    } else if (shape === 'spray') {
        const r = (s - 1) / 2;
        const r2 = r * r + 0.25;
        for (let dy = 0; dy < s; dy++) {
            for (let dx = 0; dx < s; dx++) {
                const fx = dx - r;
                const fy = dy - r;
                if (fx * fx + fy * fy > r2) continue;
                const px = x0 + dx;
                const py = y0 + dy;
                let h = (px * 374761393 + py * 668265263) | 0;
                h = (h ^ (h >>> 13)) * 1274126177;
                if ((h & 255) > 170) plot(px, py);
            }
        }
    } else {
        for (let dy = 0; dy < s; dy++) {
            for (let dx = 0; dx < s; dx++) {
                plot(x0 + dx, y0 + dy);
            }
        }
    }
}

/**
 * Map art-set role key → preferred sub-layer.
 * Overlays always land on `path` (even when roleId is water).
 * Wall Wang objects land on `vertical` (cave `tiles` + role wall stay ground).
 * @param {string} artRoleKey
 * @param {string|null} roleId
 * @param {string} [kind]
 * @param {object|string|null} [stampOrId]
 * @returns {string}
 */
function preferredSubLayer(artRoleKey, roleId, kind, stampOrId) {
    if (kind === 'overlays') return 'path';
    if (kind === 'objects' && isWallWang(stampOrId || { kind, roleId })) {
        return 'vertical';
    }
    const rid = roleId ? normalizeEntityId(roleId) : null;
    if (rid && ROLE_DEFAULT_SUBLAYER[rid]) return ROLE_DEFAULT_SUBLAYER[rid];
    const k = String(artRoleKey || '')
        .trim()
        .toLowerCase();
    if (k === 'floor' || k === 'water' || k === 'wall' || k === 'void') return 'ground';
    if (k === 'path') return 'path';
    if (k === 'scenery') return 'scenery';
    if (k === 'furniture') return 'furniture';
    if (
        k === 'stairs' ||
        k === 'stairs_up' ||
        k === 'stairs_down' ||
        k === 'ladder' ||
        k === 'ladder_up' ||
        k === 'ladder_down' ||
        k === 'vertical' ||
        k === 'hole'
    ) {
        return 'vertical';
    }
    return 'ground';
}

/**
 * Family brush occupancy: representative fill, resolved at stroke-end.
 * RAW (`wangLocked` / `wangResolve === false`) keeps the exact catalog id.
 * @param {object|null|undefined} stamp
 * @returns {object|null|undefined}
 */
function occupancyStamp(stamp) {
    if (!stamp) return stamp;
    if (stamp.wangLocked || stamp.wangResolve === false) return stamp;
    const wallFamily = wallFamilyOf(stamp);
    if (wallFamily) {
        const next = Object.assign({}, stamp, {
            kind: 'objects',
            wallFamily,
            wallAlign: 'pole',
            catalogId: wallCatalogId(wallFamily, 'pole'),
            wangLocked: false,
            subLayer: 'vertical',
            hop: undefined
        });
        delete next.wangFamily;
        delete next.wangMask;
        return next;
    }
    const family = wangFamilyOf(stamp);
    if (!family) return stamp;
    const next = Object.assign({}, stamp, {
        kind: 'overlays',
        wangFamily: family,
        catalogId: wangCatalogId(family, 15),
        wangLocked: false,
        subLayer: 'path'
    });
    return next;
}

/**
 * @param {object} floor
 * @returns {object|null}
 */
function pathSubLayer(floor) {
    if (!floor || !Array.isArray(floor.subLayers)) return null;
    for (let i = 0; i < floor.subLayers.length; i++) {
        if (floor.subLayers[i] && floor.subLayers[i].id === 'path') return floor.subLayers[i];
    }
    return null;
}

/**
 * @param {object} floor
 * @returns {object|null}
 */
function verticalSubLayer(floor) {
    if (!floor || !Array.isArray(floor.subLayers)) return null;
    for (let i = 0; i < floor.subLayers.length; i++) {
        if (floor.subLayers[i] && floor.subLayers[i].id === 'vertical') {
            return floor.subLayers[i];
        }
    }
    return null;
}

/**
 * @param {object} floor
 * @param {object} pathSl
 * @param {number} x
 * @param {number} y
 * @param {string} family
 * @returns {boolean}
 */
function sameWangFamilyAt(floor, pathSl, x, y, family) {
    const cols = floor.cols | 0;
    const rows = floor.rows | 0;
    if (x < 0 || y < 0 || x >= cols || y >= rows) return false;
    const pi = pathSl.cells[y * cols + x] & 0xffff;
    if (!pi) return false;
    return wangFamilyOf(floor.palette[pi]) === family;
}

/**
 * Rewrite path overlay cells in the 8-ring to the 4-neighbor Wang-16 mask
 * (inner-corner stamp when mask 15 has exactly one empty diagonal).
 * Skips empty cells and RAW (`wangLocked`) one-offs. Locked cells still count
 * as same-family neighbors.
 * @param {object} floor
 * @param {Iterable<number>} seedIndices
 * @param {(stamp: object) => number} intern
 * @returns {number[]} changed cell indices
 */
function resolveWangOnFloor(floor, seedIndices, intern) {
    const sl = pathSubLayer(floor);
    if (!sl) return [];
    const cols = floor.cols | 0;
    const rows = floor.rows | 0;
    const ring = expandWangRing(cols, rows, seedIndices, { diagonals: true });
    /** @type {number[]} */
    const changed = [];
    for (const i of ring) {
        const pi = sl.cells[i] & 0xffff;
        if (!pi) continue;
        const entry = floor.palette[pi];
        if (!entry || entry.wangLocked) continue;
        const family = wangFamilyOf(entry);
        if (!family) continue;
        const x = i % cols;
        const y = (i / cols) | 0;
        const mask = wangMaskFromCardinals(
            sameWangFamilyAt(floor, sl, x, y - 1, family),
            sameWangFamilyAt(floor, sl, x + 1, y, family),
            sameWangFamilyAt(floor, sl, x, y + 1, family),
            sameWangFamilyAt(floor, sl, x - 1, y, family)
        );
        const emptyInners =
            mask === 15
                ? emptyWangInners(
                      sameWangFamilyAt(floor, sl, x - 1, y - 1, family),
                      sameWangFamilyAt(floor, sl, x + 1, y - 1, family),
                      sameWangFamilyAt(floor, sl, x + 1, y + 1, family),
                      sameWangFamilyAt(floor, sl, x - 1, y + 1, family)
                  )
                : [];
        const resolved = resolveWangOverlay(family, mask, emptyInners);
        const prevInner = entry.wangInner || null;
        if (
            entry.catalogId === resolved.catalogId &&
            (entry.wangMask == null || entry.wangMask === resolved.wangMask) &&
            prevInner === resolved.wangInner
        ) {
            continue;
        }
        const next = intern(
            applyEntryOverrides(
                {
                    catalogId: resolved.catalogId,
                    kind: 'overlays',
                    roleId: entry.roleId,
                    wangFamily: family,
                    wangMask: resolved.wangMask,
                    wangInner: resolved.wangInner || undefined,
                    wangLocked: false
                },
                entry
            )
        );
        if ((next & 0xffff) !== pi) {
            sl.cells[i] = next & 0xffff;
            changed.push(i);
        }
    }
    return changed;
}

/**
 * @param {object} floor
 * @param {object} sl
 * @param {number} x
 * @param {number} y
 * @param {string} family
 * @param {Map|object|null} [roleCatalog]
 * @returns {boolean}
 */
function sameWallFamilyAt(floor, sl, x, y, family, roleCatalog) {
    const cols = floor.cols | 0;
    const rows = floor.rows | 0;
    if (x < 0 || y < 0 || x >= cols || y >= rows) return false;
    const pi = sl.cells[y * cols + x] & 0xffff;
    if (!pi) return false;
    const entry = floor.palette[pi];
    if (!entry || isHopStamp(entry, roleCatalog)) return false;
    return wallFamilyOf(entry) === family;
}

/**
 * Put every full[] face on the palette so resolve can pick extras
 * (ends / T / intersection). Missing PNG → icon fallback.
 * @param {(stamp: object) => number} intern
 * @param {string} family
 * @param {object} entry
 */
function internWallFamilyAligns(intern, family, entry) {
    for (let i = 0; i < WALL_ALIGN_ALL.length; i++) {
        const align = WALL_ALIGN_ALL[i];
        intern(
            applyEntryOverrides(
                {
                    catalogId: wallCatalogId(family, align),
                    kind: 'objects',
                    roleId: entry.roleId || 'wall',
                    wallFamily: family,
                    wallAlign: align,
                    wangLocked: false
                },
                entry
            )
        );
    }
}

/**
 * Rewrite vertical wall cells in the 1-ring to the 4-neighbor face.
 * Hop stamps are skipped (not occupancy, not neighbors). RAW stays locked.
 * Interns the 16 full[] ids so extras are used when art exists.
 * @param {object} floor
 * @param {Iterable<number>} seedIndices
 * @param {(stamp: object) => number} intern
 * @param {Map|object|null} [roleCatalog]
 * @returns {number[]} changed cell indices
 */
function resolveWallsOnFloor(floor, seedIndices, intern, roleCatalog) {
    const sl = verticalSubLayer(floor);
    if (!sl) return [];
    const cols = floor.cols | 0;
    const rows = floor.rows | 0;
    const ring = expandWangRing(cols, rows, seedIndices);
    /** @type {Set<string>} */
    const seeded = new Set();
    /** @type {number[]} */
    const changed = [];
    for (const i of ring) {
        const pi = sl.cells[i] & 0xffff;
        if (!pi) continue;
        const entry = floor.palette[pi];
        if (!entry || entry.wangLocked) continue;
        if (isHopStamp(entry, roleCatalog)) continue;
        const family = wallFamilyOf(entry);
        if (!family) continue;
        if (!seeded.has(family)) {
            internWallFamilyAligns(intern, family, entry);
            seeded.add(family);
        }
        const x = i % cols;
        const y = (i / cols) | 0;
        const mask = wangMaskFromCardinals(
            sameWallFamilyAt(floor, sl, x, y - 1, family, roleCatalog),
            sameWallFamilyAt(floor, sl, x + 1, y, family, roleCatalog),
            sameWallFamilyAt(floor, sl, x, y + 1, family, roleCatalog),
            sameWallFamilyAt(floor, sl, x - 1, y, family, roleCatalog)
        );
        const has = familyAlignSet(floor, family);
        const align = resolveWallAlign(mask, (a) => has.has(a));
        const catalogId = wallCatalogId(family, align);
        if (entry.catalogId === catalogId && (entry.wallAlign == null || entry.wallAlign === align)) {
            continue;
        }
        const next = intern(
            applyEntryOverrides(
                {
                    catalogId,
                    kind: 'objects',
                    roleId: entry.roleId || 'wall',
                    wallFamily: family,
                    wallAlign: align,
                    wangLocked: false
                },
                entry
            )
        );
        if ((next & 0xffff) !== pi) {
            sl.cells[i] = next & 0xffff;
            changed.push(i);
        }
    }
    return changed;
}

/**
 * Copy optional render / influence onto a stamp / intern payload.
 * Art-set disk (`opts.fromArtSet`): `render` only — top-level scale/anchor/variant
 * are ignored. Hybrid placements keep flat scale/anchor/variant.
 *
 * @param {object} dest
 * @param {object|null|undefined} src
 * @param {{ fromArtSet?: boolean }} [opts]
 * @returns {object} dest
 */
function applyEntryOverrides(dest, src, opts) {
    if (!dest || !src) return dest;
    const fromArtSet = !!(opts && opts.fromArtSet);
    const render = src.render && typeof src.render === 'object' ? src.render : null;
    const scaleSrc = fromArtSet
        ? render
            ? render.scale
            : null
        : render && render.scale != null
          ? render.scale
          : src.scale;
    const anchorSrc = fromArtSet
        ? render
            ? render.anchor
            : null
        : render && render.anchor != null
          ? render.anchor
          : src.anchor;
    const variantSrc = fromArtSet
        ? render
            ? render.variant
            : null
        : render && render.variant != null
          ? render.variant
          : src.variant;
    if (scaleSrc != null && Number.isFinite(Number(scaleSrc))) {
        dest.scale = Number(scaleSrc);
    }
    if (anchorSrc != null && String(anchorSrc).trim()) {
        dest.anchor = String(anchorSrc).trim().toLowerCase();
    }
    if (variantSrc != null && String(variantSrc).trim()) {
        dest.variant = String(variantSrc).trim().toLowerCase().slice(0, 40);
    }
    const inf = src.influence
        ? normalizePartialInfluence(src.influence)
        : null;
    if (inf) dest.influence = inf;
    return dest;
}

/**
 * Build stamp list from an art set pack + optional role catalog.
 *
 * @param {object} artSet normalized art set ({ roles: { floor: [...], … } })
 * @param {Map|object|null} [roleCatalog]
 * @returns {Array<object>} stamps for palette UI
 */
function buildStampsFromArtSet(artSet, roleCatalog) {
    const roles = artSet && artSet.roles && typeof artSet.roles === 'object' ? artSet.roles : {};
    /** @type {object[]} */
    const stamps = [];
    const keys = Object.keys(roles);
    for (let ki = 0; ki < keys.length; ki++) {
        const artRole = keys[ki];
        const list = Array.isArray(roles[artRole]) ? roles[artRole] : [];
        for (let i = 0; i < list.length; i++) {
            const raw = list[i];
            if (!raw) continue;
            const catalogId =
                raw.id != null
                    ? String(raw.id).trim()
                    : raw.catalogId != null
                      ? String(raw.catalogId).trim()
                      : '';
            if (!catalogId) continue;
            const roleId =
                raw.roleId != null
                    ? normalizeEntityId(raw.roleId)
                    : artRole
                      ? normalizeEntityId(artRole)
                      : null;
            const kindRaw = raw.kind != null ? String(raw.kind).trim().toLowerCase() : 'tiles';
            const kind = kindRaw === 'overlays' ? 'overlays' : kindRaw === 'objects' ? 'objects' : 'tiles';
            const family =
                kind === 'overlays'
                    ? wangFamilyOf(raw) || wangFamilyOf(catalogId)
                    : null;
            const wallFamily =
                kind === 'objects'
                    ? wallFamilyOf(raw) || wallFamilyOf(catalogId)
                    : null;
            if (family) {
                let exists = false;
                for (let si = 0; si < stamps.length; si++) {
                    if (stamps[si] && stamps[si].wangFamily === family && stamps[si].kind === 'overlays') {
                        exists = true;
                        break;
                    }
                }
                if (exists) continue;
            }
            if (wallFamily) {
                let exists = false;
                for (let si = 0; si < stamps.length; si++) {
                    if (
                        stamps[si] &&
                        stamps[si].wallFamily === wallFamily &&
                        stamps[si].kind === 'objects' &&
                        isWallWang(stamps[si])
                    ) {
                        exists = true;
                        break;
                    }
                }
                if (exists) continue;
            }
            const subLayer = preferredSubLayer(
                artRole,
                roleId,
                kind,
                wallFamily
                    ? { kind, catalogId, wallFamily }
                    : family
                      ? { kind, catalogId, wangFamily: family }
                      : raw
            );
            /** @type {object} */
            const stamp = {
                catalogId: family
                    ? wangCatalogId(family, 15)
                    : wallFamily
                      ? wallCatalogId(wallFamily, 'pole')
                      : catalogId,
                kind,
                roleId,
                artRole,
                subLayer,
                weight: raw.weight != null ? Number(raw.weight) : 1,
                label: raw.label || (family ? family : wallFamily ? wallFamily : catalogId),
                previewColor: ROLE_PREVIEW_COLORS[roleId] || ROLE_PREVIEW_COLORS[artRole] || '#666666'
            };
            if (family) {
                stamp.wangFamily = family;
                stamp.wangResolve = true;
                stamp.wangLocked = false;
            }
            if (wallFamily) {
                stamp.wallFamily = wallFamily;
                stamp.wallAlign = 'pole';
                stamp.wangResolve = true;
                stamp.wangLocked = false;
            }
            applyEntryOverrides(stamp, raw, { fromArtSet: true });
            // Default hop for vertical roles — not wall faces
            if (subLayer === 'vertical' && !wallFamily) {
                let deltaZ = -1;
                let dir = 'center';
                if (roleCatalog) {
                    const role =
                        roleCatalog instanceof Map
                            ? roleCatalog.get(roleId)
                            : roleCatalog[roleId];
                    if (role && role.vertical) {
                        if (role.vertical.deltaZ != null) deltaZ = role.vertical.deltaZ | 0;
                        if (role.vertical.defaultDir) dir = String(role.vertical.defaultDir);
                    }
                }
                if (roleId === 'hole' || roleId === 'stairs_down') deltaZ = 1;
                stamp.hop = { dir, deltaZ };
            }
            stamps.push(stamp);
        }
    }
    return stamps;
}

/**
 * True when any TileMap sub-layer has a non-empty palette stamp.
 * @param {object} floor
 * @returns {boolean}
 */
function floorHasAnyStamp(floor) {
    if (!floor || !Array.isArray(floor.subLayers)) return false;
    const nCells = (floor.cols | 0) * (floor.rows | 0);
    for (let s = 0; s < floor.subLayers.length; s++) {
        const cells = floor.subLayers[s] && floor.subLayers[s].cells;
        if (!cells) continue;
        const lim = Math.min(nCells, cells.length);
        for (let i = 0; i < lim; i++) {
            if (cells[i]) return true;
        }
    }
    return false;
}

/**
 * True when friction is missing or shorter than cols*rows.
 * @param {object} floor
 * @returns {boolean}
 */
function floorChannelsMissing(floor) {
    const nCells = (floor.cols | 0) * (floor.rows | 0);
    return !floor || !floor.friction || floor.friction.length < nCells;
}

/**
 * Ensure floor has channel buffers (friction/sight/flags/fields/override).
 * New buffers stay 0 — do not invent void (255). PNG / hybrid / bake write real values.
 * @param {object} floor
 * @returns {object}
 */
function ensureChannels(floor) {
    ensureSubLayers(floor);
    const n = (floor.cols | 0) * (floor.rows | 0);
    if (!floor.friction || floor.friction.length < n) {
        floor.friction = new Uint8Array(n);
    }
    if (!floor.sight || floor.sight.length < n) {
        floor.sight = new Uint8Array(n);
    }
    if (!floor.flags || floor.flags.length < n) {
        floor.flags = new Uint8Array(n);
    }
    if (!floor.fields || floor.fields.length < n) {
        floor.fields = new Uint8Array(n);
    }
    if (!floor.overrideMask || floor.overrideMask.length < n) {
        floor.overrideMask = new Uint8Array(n);
    }
    if (!Array.isArray(floor.stairs)) floor.stairs = [];
    if (!Array.isArray(floor.palette) || floor.palette.length === 0) {
        floor.palette = [null];
    }
    return floor;
}

/**
 * @param {object[]|null|undefined} stairs
 * @returns {Map<string, object>}
 */
function indexStairsByCell(stairs) {
    const m = new Map();
    const list = Array.isArray(stairs) ? stairs : [];
    for (let i = 0; i < list.length; i++) {
        const s = list[i];
        if (!s || s.x == null || s.y == null) continue;
        m.set((s.x | 0) + ',' + (s.y | 0), s);
    }
    return m;
}

/**
 * Authoring stair row from a baked vertical. Persists computed `to` so hunt
 * load does not depend on hop.to being set in the stamp. Explicit dest
 * (`dir: custom` or a `to` that is not the dir offset) survives rebake.
 * @param {{ x: number, y: number, placement?: object }} v
 * @param {string|number} floorZ
 * @param {object|null} [prevRow]
 * @returns {{ x: number, y: number, z: string|number, dir: string, type: string, deltaZ: number, to: object|null }}
 */
function stairRowFromVertical(v, floorZ, prevRow) {
    const hop = (v && v.placement && v.placement.hop) || {};
    const vert = (v && v.placement && v.placement.vertical) || {};
    const type = vert.type || 'stairs';
    if (prevRow && isExplicitEditorStairDest(prevRow)) {
        const locked = normalizeEditorStairDest(prevRow.to, prevRow.to && prevRow.to.z);
        if (
            locked &&
            !(
                locked.x === (v.x | 0) &&
                locked.y === (v.y | 0) &&
                String(locked.z) === String(floorZ)
            )
        ) {
            let deltaZ = prevRow.deltaZ != null ? prevRow.deltaZ | 0 : -1;
            const fromZ = Number(floorZ);
            const toZ = Number(locked.z);
            if (Number.isFinite(fromZ) && Number.isFinite(toZ)) {
                deltaZ = Math.trunc(toZ - fromZ);
            }
            return {
                x: v.x,
                y: v.y,
                z: floorZ,
                dir: 'custom',
                type,
                deltaZ,
                bidirectional: !!prevRow.bidirectional,
                to: { x: locked.x, y: locked.y, z: locked.z }
            };
        }
    }
    const deltaZ =
        hop.deltaZ != null
            ? hop.deltaZ | 0
            : vert.deltaZ != null
              ? vert.deltaZ | 0
              : -1;
    const dir = hop.dir || vert.defaultDir || 'center';
    const row = {
        x: v.x,
        y: v.y,
        z: floorZ,
        dir,
        type,
        deltaZ,
        bidirectional: !!(vert.bidirectional || hop.bidirectional),
        to: hop.to || null
    };
    const resolved = resolveEditorStairLink(row);
    if (resolved) {
        row.to = {
            x: resolved.to.x,
            y: resolved.to.y,
            z: resolved.to.z
        };
    }
    return row;
}

/**
 * Snapshot sparse cell changes for undo.
 * @param {object} floor
 * @returns {{ palette: object[], cells: Record<string, number[]>, override: number[], friction: number[], sight: number[], flags: number[], fields: number[], stairs: object[] }}
 */
function snapshotFloorSparse(floor, dirtyIndices) {
    ensureChannels(floor);
    const n = floor.cols * floor.rows;
    /** @type {number[]} */
    const idxs =
        dirtyIndices && dirtyIndices.length
            ? dirtyIndices
            : (() => {
                  const all = new Array(n);
                  for (let i = 0; i < n; i++) all[i] = i;
                  return all;
              })();

    /** @type {Record<string, number[]>} */
    const cells = Object.create(null);
    for (let s = 0; s < floor.subLayers.length; s++) {
        const sl = floor.subLayers[s];
        const arr = new Array(idxs.length);
        for (let j = 0; j < idxs.length; j++) arr[j] = sl.cells[idxs[j]] & 0xffff;
        cells[sl.id] = arr;
    }
    const override = new Array(idxs.length);
    const friction = new Array(idxs.length);
    const sight = new Array(idxs.length);
    const flags = new Array(idxs.length);
    const fields = new Array(idxs.length);
    for (let j = 0; j < idxs.length; j++) {
        const i = idxs[j];
        override[j] = floor.overrideMask[i] & 0xff;
        friction[j] = floor.friction[i] & 0xff;
        sight[j] = floor.sight[i] & 0xff;
        flags[j] = floor.flags[i] & 0xff;
        fields[j] = floor.fields[i] & 0xff;
    }
    return {
        indices: idxs.slice(),
        palette: floor.palette.map((e) => (e ? { ...e, hop: e.hop ? { ...e.hop } : undefined } : null)),
        cells,
        override,
        friction,
        sight,
        flags,
        fields,
        stairs: Array.isArray(floor.stairs)
            ? floor.stairs.map((s) => (s ? { ...s } : s))
            : []
    };
}

/**
 * @param {object} floor
 * @param {ReturnType<typeof snapshotFloorSparse>} snap
 */
function restoreFloorSparse(floor, snap) {
    ensureChannels(floor);
    floor.palette = snap.palette.map((e) =>
        e ? { ...e, hop: e.hop ? { ...e.hop } : undefined } : null
    );
    const idxs = snap.indices;
    for (let s = 0; s < floor.subLayers.length; s++) {
        const sl = floor.subLayers[s];
        const arr = snap.cells[sl.id];
        if (!arr) continue;
        for (let j = 0; j < idxs.length; j++) {
            sl.cells[idxs[j]] = (arr[j] || 0) & 0xffff;
        }
    }
    for (let j = 0; j < idxs.length; j++) {
        const i = idxs[j];
        floor.overrideMask[i] = snap.override[j] & 0xff;
        floor.friction[i] = snap.friction[j] & 0xff;
        floor.sight[i] = snap.sight[j] & 0xff;
        floor.flags[i] = snap.flags[j] & 0xff;
        floor.fields[i] = snap.fields[j] & 0xff;
    }
    floor.stairs = Array.isArray(snap.stairs)
        ? snap.stairs.map((s) => (s ? { ...s } : s))
        : [];
}

/**
 * Find or create palette index for a stamp.
 * @param {object} floor
 * @param {object} stamp
 * @returns {number}
 */
function ensureStampPaletteIndex(floor, stamp) {
    ensureChannels(floor);
    if (!stamp) return 0;
    if (stamp.paletteIndex > 0) return stamp.paletteIndex & 0xffff;
    const catalogId = stamp.catalogId || stamp.id;
    const roleId = stamp.roleId || null;
    const kind =
        stamp.kind === 'overlays'
            ? 'overlays'
            : stamp.kind === 'objects'
              ? 'objects'
              : 'tiles';
    const locked = !!stamp.wangLocked;
    const family = wangFamilyOf(stamp);
    const wallFamily = wallFamilyOf(stamp);
    const parsed = family ? parseWangId(catalogId) : null;
    const wangMask =
        stamp.wangMask != null
            ? stamp.wangMask
            : parsed
              ? parsed.mask
              : undefined;
    const wangInner =
        stamp.wangInner != null
            ? stamp.wangInner
            : parsed && parsed.inner
              ? parsed.inner
              : undefined;
    const wallAlign =
        stamp.wallAlign != null
            ? stamp.wallAlign
            : wallFamily
              ? wallAlignOf(stamp) || parseWallId(catalogId)?.align
              : undefined;
    for (let i = 1; i < floor.palette.length; i++) {
        const e = floor.palette[i];
        if (!e) continue;
        if (
            e.catalogId === catalogId &&
            (e.roleId || null) === (roleId || null) &&
            (e.kind || 'tiles') === kind &&
            !!e.wangLocked === locked &&
            JSON.stringify(e.hop || null) === JSON.stringify(stamp.hop || null) &&
            (e.scale == null ? null : e.scale) === (stamp.scale == null ? null : stamp.scale) &&
            (e.anchor || null) === (stamp.anchor || null) &&
            (e.variant || null) === (stamp.variant || null) &&
            influenceKey(e.influence) === influenceKey(stamp.influence)
        ) {
            return i;
        }
    }
    return addPaletteEntry(floor, {
        catalogId,
        kind,
        roleId,
        scale: stamp.scale,
        anchor: stamp.anchor,
        variant: stamp.variant,
        influence: stamp.influence,
        hop: wallFamily ? undefined : stamp.hop || undefined,
        wangFamily: family || undefined,
        wangMask,
        wangInner,
        wallFamily: wallFamily || undefined,
        wallAlign: wallAlign || undefined,
        wangLocked: locked || undefined
    });
}

/**
 * Create a TileMap editor session for one floor.
 *
 * @param {{
 *   cols?: number,
 *   rows?: number,
 *   z?: string|number,
 *   floor?: object|null,
 *   roleCatalog?: Map|object|null,
 *   artSet?: object|null,
 *   id?: string
 * }} [opts]
 */
function createEditorSession(opts) {
    const o = opts || {};
    let floor =
        o.floor != null
            ? ensureChannels(
                  o.floor.subLayers
                      ? ensureSubLayers(o.floor)
                      : normalizeTileMapFloor(o.floor) || createEmptyTileMapFloor(32, 32, { z: o.z })
              )
            : ensureChannels(
                  createEmptyTileMapFloor(
                      Math.max(1, floorInt(o.cols, 32)),
                      Math.max(1, floorInt(o.rows, 32)),
                      { z: o.z != null ? o.z : 0 }
                  )
              );

    let roleCatalog = o.roleCatalog || null;
    /** @type {object[]} */
    let stamps = o.artSet ? buildStampsFromArtSet(o.artSet, roleCatalog) : [];

    let activeSubLayer = 'ground';
    /** @type {object|null} */
    let selectedStamp = null;
    let dirty = false;
    /** @type {Set<number>} */
    let strokeDirty = new Set();
    /** @type {ReturnType<typeof snapshotFloorSparse>|null} */
    let strokeBefore = null;
    /** @type {Set<number>|null} */
    let strokeBeforeIndexSet = null;
    /** True when this stroke changed TileMap sub-layers (needs bake). */
    let strokeNeedsBake = false;
    let painting = false;

    /** @type {Array<{ before: object, after: object }>} */
    const undoStack = [];
    /** @type {Array<{ before: object, after: object }>} */
    const redoStack = [];

    /**
     * @param {number} x
     * @param {number} y
     * @returns {boolean}
     */
    function inBounds(x, y) {
        return x >= 0 && y >= 0 && x < floor.cols && y < floor.rows;
    }

    /**
     * @param {number} x
     * @param {number} y
     * @returns {number}
     */
    function idx(x, y) {
        return y * floor.cols + x;
    }

    function markDirty() {
        dirty = true;
    }

    /**
     * @param {Iterable<number>} indices
     * @returns {{ x0: number, y0: number, x1: number, y1: number }|null}
     */
    function boundsFromIndices(indices) {
        let x0 = floor.cols;
        let y0 = floor.rows;
        let x1 = -1;
        let y1 = -1;
        for (const i of indices) {
            const x = i % floor.cols;
            const y = (i / floor.cols) | 0;
            if (x < x0) x0 = x;
            if (y < y0) y0 = y;
            if (x > x1) x1 = x;
            if (y > y1) y1 = y;
        }
        return x1 < 0 ? null : { x0, y0, x1, y1 };
    }

    /**
     * Extend strokeBefore sparse snapshot with any new indices.
     * @param {number[]} cellsAsPairsOrIndices - either [[x,y],...] or flat indices
     * @param {boolean} asPairs
     */
    function ensureStrokeBeforeForCells(cellList, asPairs) {
        const missing = [];
        if (!strokeBefore) {
            const seed = [];
            for (let c = 0; c < cellList.length; c++) {
                const i = asPairs
                    ? idx(cellList[c][0], cellList[c][1])
                    : cellList[c];
                seed.push(i);
            }
            strokeBeforeIndexSet = new Set(seed);
            strokeBefore = snapshotFloorSparse(floor, seed);
            return;
        }
        if (!strokeBeforeIndexSet) {
            strokeBeforeIndexSet = new Set(strokeBefore.indices);
        }
        for (let c = 0; c < cellList.length; c++) {
            const i = asPairs
                ? idx(cellList[c][0], cellList[c][1])
                : cellList[c];
            if (!strokeBeforeIndexSet.has(i)) missing.push(i);
        }
        if (!missing.length) return;
        const extra = snapshotFloorSparse(floor, missing);
        strokeBefore.indices = strokeBefore.indices.concat(extra.indices);
        for (const sid of Object.keys(extra.cells)) {
            strokeBefore.cells[sid] = (strokeBefore.cells[sid] || []).concat(
                extra.cells[sid]
            );
        }
        strokeBefore.override = strokeBefore.override.concat(extra.override);
        strokeBefore.friction = strokeBefore.friction.concat(extra.friction);
        strokeBefore.sight = strokeBefore.sight.concat(extra.sight);
        strokeBefore.flags = strokeBefore.flags.concat(extra.flags);
        strokeBefore.fields = strokeBefore.fields.concat(extra.fields);
        for (let m = 0; m < missing.length; m++) {
            strokeBeforeIndexSet.add(missing[m]);
        }
    }

    /**
     * Bake full floor channels + rebuild stairs list from verticals.
     * @returns {object} bake result
     */
    function bakeAll() {
        ensureChannels(floor);
        const prevF = floor.friction;
        const prevS = floor.sight;
        const prevFl = floor.flags;
        const result = bakeTileMapFloor(floor, {
            roleCatalog,
            applyOverrides: true,
            previous: {
                friction: prevF,
                sight: prevS,
                flags: prevFl
            }
        });
        // Empty stacks bake to void at runtime. In the editor, unstamped cells
        // keep PNG / hybrid / previous channel values (a stair must not void the floor).
        const nCells = (floor.cols | 0) * (floor.rows | 0);
        const layers = floor.subLayers || [];
        for (let i = 0; i < nCells; i++) {
            let stamped = false;
            for (let s = 0; s < layers.length && !stamped; s++) {
                const cells = layers[s] && layers[s].cells;
                if (cells && cells[i]) stamped = true;
            }
            if (!stamped) {
                result.friction[i] = prevF[i];
                result.sight[i] = prevS[i];
                result.flags[i] = prevFl[i];
            }
        }
        floor.friction = result.friction;
        floor.sight = result.sight;
        floor.flags = result.flags;
        // Stairs from vertical placements. Keep explicit dests across full rebake.
        const prevByCell = indexStairsByCell(floor.stairs);
        const stairs = [];
        for (let i = 0; i < result.verticals.length; i++) {
            const v = result.verticals[i];
            const prev = prevByCell.get((v.x | 0) + ',' + (v.y | 0)) || null;
            stairs.push(stairRowFromVertical(v, floor.z, prev));
        }
        floor.stairs = stairs;
        return result;
    }

    /**
     * Bake only dirty cell indices (not the stroke AABB) and patch stair links
     * at those cells. Diagonal paints must not rewrite unpainted tiles inside
     * the bounding box. Override merge reads previous from live buffers.
     * @param {Iterable<number>} indices
     * @returns {{ x0: number, y0: number, x1: number, y1: number }|null}
     */
    function bakeDirtyIndices(indices) {
        ensureChannels(floor);
        const list = Array.isArray(indices) ? indices : Array.from(indices);
        if (!list.length) return null;
        const rect = boundsFromIndices(list);
        if (!rect) return null;

        const dirtySet = new Set();
        for (let k = 0; k < list.length; k++) dirtySet.add(list[k] | 0);

        // bakeCellIndices reads prev.friction[i] before writing channels.friction[i],
        // so the live buffers can act as previous (no 3× full-floor clone).
        const { verticals } = bakeCellIndices(floor, dirtySet, {
            roleCatalog,
            friction: floor.friction,
            sight: floor.sight,
            flags: floor.flags,
            previous: {
                friction: floor.friction,
                sight: floor.sight,
                flags: floor.flags
            }
        });

        // Drop stair links only at dirty cells, then re-register from bake.
        // Explicit dest on a dirty pad survives (dir custom / non-offset to).
        const prevByCell = indexStairsByCell(floor.stairs);
        floor.stairs = (floor.stairs || []).filter((s) => {
            if (!s) return false;
            const i = idx(s.x | 0, s.y | 0);
            return !dirtySet.has(i);
        });
        for (let i = 0; i < verticals.length; i++) {
            const v = verticals[i];
            const prev = prevByCell.get((v.x | 0) + ',' + (v.y | 0)) || null;
            floor.stairs.push(stairRowFromVertical(v, floor.z, prev));
        }
        return rect;
    }

    /**
     * Begin a paint stroke (captures undo baseline).
     */
    function beginStroke() {
        if (painting) return;
        painting = true;
        strokeDirty = new Set();
        strokeBefore = null;
        strokeBeforeIndexSet = null;
        strokeNeedsBake = false;
    }

    /**
     * Paint selected stamp (or erase if stamp null / erase mode) on active sub-layer.
     * Overlay family stamps always write occupancy on `path`; wall families
     * write `vertical`. Mask / face is resolved at stroke-end (plus a 1-ring).
     * @param {number} x
     * @param {number} y
     * @param {{ size?: number, shape?: string, erase?: boolean, stamp?: object|null }} [opts]
     */
    function paintAt(x, y, opts) {
        const po = opts || {};
        if (!inBounds(x, y)) return;
        if (!painting) beginStroke();
        const size = po.size != null ? po.size : 1;
        const shape = po.shape || 'square';
        const erase = !!po.erase;
        const rawStamp = po.stamp !== undefined ? po.stamp : selectedStamp;
        const stamp = erase ? null : occupancyStamp(rawStamp);
        const subId =
            stamp && stamp.kind === 'overlays'
                ? 'path'
                : stamp && isWallWang(stamp)
                  ? 'vertical'
                  : po.subLayer || activeSubLayer;
        if (!SUB_LAYER_IDS.includes(subId)) return;

        const cells = [];
        forEachBrushCell(x, y, size, shape, (px, py) => {
            if (inBounds(px, py)) cells.push([px, py]);
        });
        if (!cells.length) return;

        ensureStrokeBeforeForCells(cells, true);

        let palIdx = 0;
        if (!erase && stamp) {
            palIdx = ensureStampPaletteIndex(floor, stamp);
        }
        for (let c = 0; c < cells.length; c++) {
            const px = cells[c][0];
            const py = cells[c][1];
            setSubLayerCell(floor, subId, px, py, palIdx);
            strokeDirty.add(idx(px, py));
        }
        strokeNeedsBake = true;
        markDirty();
    }

    /**
     * Snapshot the 1-ring (for undo) and resolve masks. Bake set stays the
     * painted cells plus cells whose catalog id actually changed — empty
     * PNG-bootstrap neighbors must not be rebaked to void.
     * @param {Set<number>} seed
     * @returns {Set<number>} indices to include in the after-snapshot
     */
    function resolveWangStroke(seed) {
        const ring = expandWangRing(floor.cols, floor.rows, seed);
        if (!ring.size) return seed;
        ensureStrokeBeforeForCells(Array.from(ring), false);
        const overlayChanged = resolveWangOnFloor(floor, ring, (st) =>
            ensureStampPaletteIndex(floor, st)
        );
        const wallChanged = resolveWallsOnFloor(
            floor,
            ring,
            (st) => ensureStampPaletteIndex(floor, st),
            roleCatalog
        );
        const changed = overlayChanged.concat(wallChanged);
        for (let c = 0; c < changed.length; c++) seed.add(changed[c]);
        const snap = new Set(seed);
        for (const i of ring) snap.add(i);
        return snap;
    }

    /**
     * End stroke: optional dirty-rect bake, push undo.
     * @returns {{ rect: object|null }}
     */
    function endStroke() {
        if (!painting) return { rect: null };
        painting = false;
        if (!strokeDirty.size) {
            strokeBefore = null;
            strokeBeforeIndexSet = null;
            strokeNeedsBake = false;
            return { rect: null };
        }
        const snapSet = strokeNeedsBake ? resolveWangStroke(strokeDirty) : strokeDirty;
        const rect = strokeNeedsBake
            ? bakeDirtyIndices(strokeDirty)
            : boundsFromIndices(strokeDirty);
        const after = snapshotFloorSparse(floor, Array.from(snapSet));
        if (strokeBefore) {
            undoStack.push({ before: strokeBefore, after });
            if (undoStack.length > MAX_UNDO) undoStack.shift();
            redoStack.length = 0;
        }
        strokeBefore = null;
        strokeBeforeIndexSet = null;
        strokeDirty = new Set();
        strokeNeedsBake = false;
        return { rect };
    }

    /**
     * Flood-fill active sub-layer with stamp (or erase).
     *
     * Matching is palette index on the sub-layer. When the seed cell is empty
     * (palette 0 — typical after path-PNG bootstrap), connectivity is also
     * gated by binary friction walk class (open vs blocked), so a click in a
     * corridor does not flood the entire empty map. Already-stamped regions
     * (target !== 0) match palette only. Pass `ignoreFrictionMask: true` to
     * fill all empty cells of the same palette regardless of friction.
     *
     * @param {number} x
     * @param {number} y
     * @param {{
     *   erase?: boolean,
     *   stamp?: object|null,
     *   maxCells?: number,
     *   subLayer?: string,
     *   ignoreFrictionMask?: boolean
     * }} [opts]
     */
    function bucketFill(x, y, opts) {
        const po = opts || {};
        if (!inBounds(x, y)) return { rect: null };
        const subId = po.subLayer || activeSubLayer;
        ensureChannels(floor);
        const sl = floor.subLayers.find((s) => s.id === subId);
        if (!sl) return { rect: null };
        const startI = idx(x, y);
        const erase = !!po.erase;
        const rawStamp = po.stamp !== undefined ? po.stamp : selectedStamp;
        const stamp = erase ? null : occupancyStamp(rawStamp);
        const overlayStamp = !!(stamp && stamp.kind === 'overlays');
        const wallStamp = !!(stamp && isWallWang(stamp));
        const slResolved =
            overlayStamp && sl.id !== 'path'
                ? floor.subLayers.find((s) => s && s.id === 'path')
                : wallStamp && sl.id !== 'vertical'
                  ? floor.subLayers.find((s) => s && s.id === 'vertical')
                  : sl;
        if (!slResolved) return { rect: null };
        const startResolved = slResolved.cells[startI] & 0xffff;
        const seedFamily =
            wangFamilyOf(floor.palette[startResolved]) ||
            wallFamilyOf(floor.palette[startResolved]);
        const stampFamily = stamp
            ? wangFamilyOf(stamp) || wallFamilyOf(stamp)
            : null;
        const familyMode = !!(stampFamily || (erase && seedFamily));
        let fillIdx = 0;
        if (!erase && stamp) fillIdx = ensureStampPaletteIndex(floor, stamp);
        if (!familyMode && fillIdx === startResolved) return { rect: null };
        if (familyMode && !erase && stampFamily && seedFamily === stampFamily) {
            return { rect: null };
        }

        // Empty seed: constrain flood by friction walk class (PNG bootstrap UX).
        const useFrictionMask = startResolved === 0 && !po.ignoreFrictionMask;
        const seedWalk = useFrictionMask
            ? frictionWalkClass(floor.friction[startI] | 0)
            : 0;

        // Snapshot all cells matching target in a BFS-bounded pass, then fill.
        const maxCells = po.maxCells != null ? po.maxCells : 200000;
        const stack = [[x, y]];
        const seen = new Set();
        /** @type {number[]} */
        const filled = [];
        const floodSl = slResolved;
        const floodTarget = startResolved;
        while (stack.length && filled.length < maxCells) {
            const [cx, cy] = stack.pop();
            if (!inBounds(cx, cy)) continue;
            const i = idx(cx, cy);
            if (seen.has(i)) continue;
            const pi = floodSl.cells[i] & 0xffff;
            if (familyMode) {
                if (seedFamily) {
                    const cellFam =
                        wangFamilyOf(floor.palette[pi]) ||
                        wallFamilyOf(floor.palette[pi]);
                    if (cellFam !== seedFamily) continue;
                } else if (pi !== 0) {
                    continue;
                }
            } else if (pi !== floodTarget) {
                continue;
            }
            if (
                useFrictionMask &&
                frictionWalkClass(floor.friction[i] | 0) !== seedWalk
            ) {
                continue;
            }
            seen.add(i);
            filled.push(i);
            stack.push([cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]);
        }
        if (!filled.length) return { rect: null };

        const ring = expandWangRing(floor.cols, floor.rows, filled);
        const snapIdx = Array.from(ring);
        const before = snapshotFloorSparse(floor, snapIdx);
        for (let fi = 0; fi < filled.length; fi++) {
            floodSl.cells[filled[fi]] = fillIdx & 0xffff;
        }
        const overlayChanged = resolveWangOnFloor(floor, filled, (st) =>
            ensureStampPaletteIndex(floor, st)
        );
        const wallChanged = resolveWallsOnFloor(
            floor,
            filled,
            (st) => ensureStampPaletteIndex(floor, st),
            roleCatalog
        );
        const wangChanged = overlayChanged.concat(wallChanged);
        const bakeIdx = filled.concat(wangChanged);
        const rect = bakeDirtyIndices(bakeIdx);
        const after = snapshotFloorSparse(floor, snapIdx);
        undoStack.push({ before, after });
        if (undoStack.length > MAX_UNDO) undoStack.shift();
        redoStack.length = 0;
        markDirty();
        return { rect };
    }

    /**
     * Manual channel paint sets override bits so rebake keeps the value.
     * When already inside beginStroke…endStroke, accumulates; otherwise single-shot
     * (begin + paint + end) for API/tests.
     * @param {'friction'|'sight'|'flags'|'fields'} channel
     * @param {number} x
     * @param {number} y
     * @param {number} value
     * @param {{ size?: number, shape?: string, packageBits?: number|null }} [opts]
     */
    function paintChannel(channel, x, y, value, opts) {
        const po = opts || {};
        if (!inBounds(x, y)) return { rect: null };
        ensureChannels(floor);
        const singleShot = !painting;
        if (singleShot) beginStroke();
        const size = po.size != null ? po.size : 1;
        const shape = po.shape || 'square';
        const v = value & 0xff;
        const packageBits = po.packageBits != null ? po.packageBits | 0 : null;

        const cells = [];
        forEachBrushCell(x, y, size, shape, (px, py) => {
            if (inBounds(px, py)) cells.push(idx(px, py));
        });
        if (!cells.length) {
            if (singleShot) {
                painting = false;
                strokeBefore = null;
                strokeBeforeIndexSet = null;
            }
            return { rect: null };
        }

        ensureStrokeBeforeForCells(cells, false);

        for (let c = 0; c < cells.length; c++) {
            const i = cells[c];
            if (channel === 'friction') {
                floor.friction[i] = v;
                floor.overrideMask[i] |= OVERRIDE_FRICTION;
            } else if (channel === 'sight') {
                floor.sight[i] = v;
                floor.overrideMask[i] |= OVERRIDE_SIGHT;
            } else if (channel === 'flags') {
                if (packageBits != null) {
                    // set or clear package: value 0 clears package bits only
                    if (v === 0) {
                        floor.flags[i] = (floor.flags[i] & ~packageBits) & 0xff;
                    } else {
                        floor.flags[i] = (floor.flags[i] | packageBits) & 0xff;
                    }
                } else {
                    floor.flags[i] = v;
                }
                floor.overrideMask[i] |= OVERRIDE_FLAGS;
            } else if (channel === 'fields') {
                floor.fields[i] = v;
                // fields never override-mask (not baked)
            }
            strokeDirty.add(i);
        }
        // Channel paint does not require TileMap rebake
        markDirty();
        if (singleShot) return endStroke();
        return { rect: boundsFromIndices(cells) };
    }

    /**
     * After undo/redo restore, re-resolve the 1-ring so neighbor masks stay
     * consistent even if the snapshot missed a fringe cell.
     * @param {number[]} indices
     */
    function reResolveAfterRestore(indices) {
        if (!indices || !indices.length) return;
        const overlayChanged = resolveWangOnFloor(floor, indices, (st) =>
            ensureStampPaletteIndex(floor, st)
        );
        const wallChanged = resolveWallsOnFloor(
            floor,
            indices,
            (st) => ensureStampPaletteIndex(floor, st),
            roleCatalog
        );
        const changed = overlayChanged.concat(wallChanged);
        if (changed.length) bakeDirtyIndices(changed);
    }

    function undo() {
        if (!undoStack.length) return false;
        const entry = undoStack.pop();
        restoreFloorSparse(floor, entry.before);
        reResolveAfterRestore(entry.before.indices);
        redoStack.push(entry);
        markDirty();
        return true;
    }

    function redo() {
        if (!redoStack.length) return false;
        const entry = redoStack.pop();
        restoreFloorSparse(floor, entry.after);
        reResolveAfterRestore(entry.after.indices);
        undoStack.push(entry);
        markDirty();
        return true;
    }

    /**
     * Seed channels from legacy PNG-decoded arrays; empty TileMap sub-layers.
     * @param {{
     *   cols: number,
     *   rows: number,
     *   friction: Uint8Array|ArrayLike<number>,
     *   sight?: Uint8Array|ArrayLike<number>|null,
     *   flags?: Uint8Array|ArrayLike<number>|null,
     *   fields?: Uint8Array|ArrayLike<number>|null,
     *   z?: string|number
     * }} channels
     */
    function bootstrapFromChannels(channels) {
        const cols = Math.max(1, channels.cols | 0);
        const rows = Math.max(1, channels.rows | 0);
        const n = cols * rows;
        floor = ensureChannels(
            createEmptyTileMapFloor(cols, rows, {
                z: channels.z != null ? channels.z : floor.z
            })
        );
        for (let i = 0; i < n; i++) {
            floor.friction[i] = (channels.friction[i] || 0) & 0xff;
            if (channels.sight) floor.sight[i] = (channels.sight[i] || 0) & 0xff;
            else if (floor.friction[i] === 255) floor.sight[i] = 255;
            if (channels.flags) floor.flags[i] = (channels.flags[i] || 0) & 0xff;
            if (channels.fields) floor.fields[i] = (channels.fields[i] || 0) & 0xff;
        }
        undoStack.length = 0;
        redoStack.length = 0;
        dirty = false;
    }

    /**
     * Load a floor object (e.g. from hybrid deserialize).
     * @param {object} floorObj
     */
    function loadFloor(floorObj) {
        const n = normalizeTileMapFloor(floorObj) || floorObj;
        // Check before ensureChannels: a new 0-buffer must not look like "present friction".
        const needBake = floorChannelsMissing(n) && floorHasAnyStamp(n);
        floor = ensureChannels(n);
        if (needBake) bakeAll();
        undoStack.length = 0;
        redoStack.length = 0;
        dirty = false;
    }

    /**
     * Build hybrid pack for this floor (in-memory).
     *
     * Intentionally does **not** call bakeAll(). A full rebake of empty
     * sub-layers rewrites every cell to void (FRICTION_BLOCKED=255) and wipes
     * PNG-bootstrap / channel-painted friction·sight·flags. Stamp strokes
     * already bake dirty cells in endStroke/bucketFill; channels stay the
     * source of truth for hybrid serialize and path-PNG export.
     *
     * @param {{ id?: string, label?: string, spawns?: *, world?: * }} [meta]
     */
    function toHybridPack(meta) {
        ensureChannels(floor);
        const m = meta || {};
        return normalizeHybridPack({
            id: m.id || o.id || `floor_${floor.z}`,
            label: m.label || null,
            floors: [floor],
            spawns: m.spawns != null ? m.spawns : null,
            world: m.world != null ? m.world : null
        });
    }

    /**
     * @param {Buffer|Uint8Array|ArrayBuffer} buf
     * @returns {Uint8Array}
     */
    function asU8(buf) {
        if (buf instanceof Uint8Array) {
            return buf.byteOffset === 0 && buf.byteLength === buf.buffer.byteLength
                ? buf
                : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
        }
        if (typeof Buffer !== 'undefined' && Buffer.isBuffer && Buffer.isBuffer(buf)) {
            return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
        }
        if (buf instanceof ArrayBuffer) return new Uint8Array(buf);
        return new Uint8Array(buf);
    }

    /**
     * Serialize hybrid for transport (meta + binary blobs as Uint8Array).
     * Prefer this for browser → PHP chunked raw uploads (full floors are ~tens of MB).
     * @param {{ id?: string, label?: string, spawns?: *, world?: * }} [meta]
     * @returns {{ meta: object, blobs: Record<string, Uint8Array> }}
     */
    function toHybridBinaryTransport(meta) {
        const pack = toHybridPack(meta);
        const { meta: serMeta, blobs } = serializeHybridPack(pack);
        /** @type {Record<string, Uint8Array>} */
        const out = Object.create(null);
        const keys = Object.keys(blobs);
        for (let i = 0; i < keys.length; i++) {
            out[keys[i]] = asU8(blobs[keys[i]]);
        }
        return { meta: serMeta, blobs: out };
    }

    /**
     * Serialize hybrid for transport (meta JSON + base64 blobs).
     * Fine for small fixtures/tests; full legacy floors are too large for one FormData body.
     * @param {{ id?: string, label?: string, spawns?: *, world?: * }} [meta]
     * @returns {{ meta: object, blobsBase64: Record<string, string> }}
     */
    function toHybridTransport(meta) {
        const { meta: serMeta, blobs } = toHybridBinaryTransport(meta);
        /** @type {Record<string, string>} */
        const blobsBase64 = Object.create(null);
        const keys = Object.keys(blobs);
        for (let i = 0; i < keys.length; i++) {
            const rel = keys[i];
            const u8 = blobs[rel];
            if (typeof Buffer !== 'undefined') {
                blobsBase64[rel] = Buffer.from(u8).toString('base64');
            } else {
                const chunk = 0x8000;
                let bin = '';
                for (let j = 0; j < u8.length; j += chunk) {
                    const end = Math.min(j + chunk, u8.length);
                    bin += String.fromCharCode.apply(null, u8.subarray(j, end));
                }
                blobsBase64[rel] = btoa(bin);
            }
        }
        return { meta: serMeta, blobsBase64 };
    }

    /**
     * Load hybrid transport (meta + base64 strings and/or binary Uint8Array blobs).
     * @param {object} meta
     * @param {Record<string, string|Uint8Array|ArrayBuffer>} blobsIn
     */
    function loadHybridTransport(meta, blobsIn) {
        /** @type {Record<string, Uint8Array>} */
        const blobs = Object.create(null);
        const keys = Object.keys(blobsIn || {});
        for (let i = 0; i < keys.length; i++) {
            const rel = keys[i];
            const raw = blobsIn[rel];
            if (raw == null) continue;
            if (typeof raw === 'string') {
                if (typeof Buffer !== 'undefined') {
                    blobs[rel] = new Uint8Array(Buffer.from(raw, 'base64'));
                } else {
                    const bin = atob(raw);
                    const u8 = new Uint8Array(bin.length);
                    for (let j = 0; j < bin.length; j++) u8[j] = bin.charCodeAt(j);
                    blobs[rel] = u8;
                }
            } else {
                blobs[rel] = asU8(raw);
            }
        }
        const pack = deserializeHybridPack(meta, blobs);
        const zKeys = Object.keys(pack.floors);
        if (!zKeys.length) throw new Error('loadHybridTransport: empty pack');
        // Prefer matching z, else first floor
        const want = String(floor.z);
        const key = pack.floors[want] ? want : zKeys[0];
        loadFloor(pack.floors[key]);
        return pack;
    }

    /**
     * @param {object|null} artSet
     * @param {Map|object|null} [roles]
     */
    function setArtSet(artSet, roles) {
        if (roles) roleCatalog = roles;
        stamps = artSet ? buildStampsFromArtSet(artSet, roleCatalog) : [];
    }

    function setRoleCatalog(roles) {
        roleCatalog = roles;
    }

    /**
     * Preview color for a cell (topmost non-empty sub-layer).
     * @param {number} x
     * @param {number} y
     * @returns {string|null} css hex or null if empty
     */
    function previewColorAt(x, y) {
        if (!inBounds(x, y)) return null;
        ensureSubLayers(floor);
        // top → bottom in paint order: vertical last in array
        for (let s = floor.subLayers.length - 1; s >= 0; s--) {
            const sl = floor.subLayers[s];
            const pi = sl.cells[idx(x, y)] & 0xffff;
            if (!pi) continue;
            const ent = floor.palette[pi];
            if (!ent) continue;
            const rid = ent.roleId || null;
            return ROLE_PREVIEW_COLORS[rid] || '#888888';
        }
        return null;
    }

    /**
     * Match a live palette entry to an art-set stamp (eyedropper).
     * @param {object} entry
     * @param {string} subLayer
     * @returns {object}
     */
    function stampFromPaletteEntry(entry, subLayer) {
        if (!entry) return null;
        const family = wangFamilyOf(entry);
        if (family && !entry.wangLocked) {
            for (let i = 0; i < stamps.length; i++) {
                const st = stamps[i];
                if (!st || st.kind !== 'overlays') continue;
                if (st.wangFamily === family && st.wangResolve !== false) return st;
            }
            return applyEntryOverrides(
                {
                    catalogId: wangCatalogId(family, 15),
                    kind: 'overlays',
                    roleId: entry.roleId || 'path',
                    subLayer: 'path',
                    wangFamily: family,
                    wangResolve: true,
                    wangLocked: false,
                    label: family,
                    previewColor: ROLE_PREVIEW_COLORS[entry.roleId] || ROLE_PREVIEW_COLORS.path || '#666666'
                },
                entry
            );
        }
        const wallFamily = wallFamilyOf(entry);
        if (wallFamily && !entry.wangLocked) {
            for (let i = 0; i < stamps.length; i++) {
                const st = stamps[i];
                if (!st || st.kind !== 'objects') continue;
                if (st.wallFamily === wallFamily && st.wangResolve !== false) return st;
            }
            return applyEntryOverrides(
                {
                    catalogId: wallCatalogId(wallFamily, 'pole'),
                    kind: 'objects',
                    roleId: entry.roleId || 'wall',
                    subLayer: 'vertical',
                    wallFamily,
                    wallAlign: 'pole',
                    wangResolve: true,
                    wangLocked: false,
                    label: wallFamily,
                    previewColor: ROLE_PREVIEW_COLORS[entry.roleId] || ROLE_PREVIEW_COLORS.wall || '#555555'
                },
                entry
            );
        }
        for (let i = 0; i < stamps.length; i++) {
            const st = stamps[i];
            if (!st) continue;
            if (st.catalogId !== entry.catalogId) continue;
            if ((st.roleId || null) !== (entry.roleId || null)) continue;
            if ((st.kind || 'tiles') !== (entry.kind || 'tiles')) continue;
            if (subLayer && st.subLayer && st.subLayer !== subLayer) continue;
            return st;
        }
        const kind = entry.kind || 'tiles';
        return applyEntryOverrides(
            {
                catalogId: entry.catalogId,
                kind,
                roleId: entry.roleId || null,
                subLayer: subLayer || preferredSubLayer(null, entry.roleId, kind, entry),
                label: entry.catalogId,
                previewColor: ROLE_PREVIEW_COLORS[entry.roleId] || '#666666',
                hop: wallFamily || family ? undefined : entry.hop || undefined,
                wangFamily: family || undefined,
                wangMask: entry.wangMask,
                wallFamily: wallFamily || undefined,
                wallAlign: entry.wallAlign || wallAlignOf(entry) || undefined,
                wangLocked: !!entry.wangLocked,
                wangResolve: entry.wangLocked ? false : undefined
            },
            entry
        );
    }

    /**
     * Eyedropper sample. Channel layers return the baked u8; TileMap returns
     * the stamp on `subLayer` or the topmost non-empty stack cell.
     * @param {number} x
     * @param {number} y
     * @param {{ channel?: string, subLayer?: string }} [opts]
     * @returns {{
     *   kind: string,
     *   value?: number,
     *   subLayer?: string,
     *   paletteIndex?: number,
     *   entry?: object|null,
     *   stamp?: object|null
     * }|null}
     */
    function sampleCellAt(x, y, opts) {
        if (!inBounds(x, y)) return null;
        ensureChannels(floor);
        const o = opts || {};
        const i = idx(x, y);
        const channel = o.channel;
        if (channel === 'friction') {
            return { kind: 'friction', value: floor.friction[i] & 0xff };
        }
        if (channel === 'sight') {
            return { kind: 'sight', value: floor.sight[i] & 0xff };
        }
        if (channel === 'flags') {
            return { kind: 'flags', value: floor.flags[i] & 0xff };
        }
        if (channel === 'fields') {
            return { kind: 'fields', value: floor.fields[i] & 0xff };
        }
        const prefer = o.subLayer && SUB_LAYER_IDS.includes(o.subLayer) ? o.subLayer : null;
        if (prefer) {
            const sl = floor.subLayers.find((s) => s && s.id === prefer);
            const pi = sl ? sl.cells[i] & 0xffff : 0;
            if (!pi) return { kind: 'tilemap', subLayer: prefer, paletteIndex: 0, entry: null, stamp: null };
            const entry = floor.palette[pi] || null;
            return {
                kind: 'tilemap',
                subLayer: prefer,
                paletteIndex: pi,
                entry,
                stamp: stampFromPaletteEntry(entry, prefer)
            };
        }
        for (let s = floor.subLayers.length - 1; s >= 0; s--) {
            const sl = floor.subLayers[s];
            const pi = sl.cells[i] & 0xffff;
            if (!pi) continue;
            const entry = floor.palette[pi] || null;
            return {
                kind: 'tilemap',
                subLayer: sl.id,
                paletteIndex: pi,
                entry,
                stamp: stampFromPaletteEntry(entry, sl.id)
            };
        }
        return { kind: 'tilemap', subLayer: activeSubLayer, paletteIndex: 0, entry: null, stamp: null };
    }

    /**
     * Copy a tile rect as relative stamps (not live palette indices).
     * Empty cells are included as `stamp: null` so paste can punch holes.
     * @param {{ x0: number, y0: number, x1: number, y1: number }} rect inclusive
     * @param {{ subLayer?: string, allLayers?: boolean }} [opts]
     * @returns {{ x0: number, y0: number, w: number, h: number, cells: object[] }|null}
     */
    function copyTiles(rect, opts) {
        if (!rect) return null;
        ensureChannels(floor);
        const x0 = Math.min(rect.x0, rect.x1) | 0;
        const y0 = Math.min(rect.y0, rect.y1) | 0;
        const x1 = Math.max(rect.x0, rect.x1) | 0;
        const y1 = Math.max(rect.y0, rect.y1) | 0;
        if (x1 < 0 || y1 < 0 || x0 >= floor.cols || y0 >= floor.rows) return null;
        const xa = Math.max(0, x0);
        const ya = Math.max(0, y0);
        const xb = Math.min(floor.cols - 1, x1);
        const yb = Math.min(floor.rows - 1, y1);
        if (xb < xa || yb < ya) return null;
        const o = opts || {};
        const layers = o.allLayers
            ? SUB_LAYER_IDS.slice()
            : o.subLayer && SUB_LAYER_IDS.includes(o.subLayer)
              ? [o.subLayer]
              : [activeSubLayer];
        /** @type {object[]} */
        const cells = [];
        for (let y = ya; y <= yb; y++) {
            for (let x = xa; x <= xb; x++) {
                const i = idx(x, y);
                for (let li = 0; li < layers.length; li++) {
                    const sid = layers[li];
                    const sl = floor.subLayers.find((s) => s && s.id === sid);
                    if (!sl) continue;
                    const pi = sl.cells[i] & 0xffff;
                    const entry = pi ? floor.palette[pi] || null : null;
                    cells.push({
                        dx: x - xa,
                        dy: y - ya,
                        subLayer: sid,
                        stamp: entry ? stampFromPaletteEntry(entry, sid) : null
                    });
                }
            }
        }
        if (!cells.length) return null;
        return { x0: xa, y0: ya, w: xb - xa + 1, h: yb - ya + 1, cells };
    }

    /**
     * Paste a tile clipboard at dest. Re-resolves Wang on stroke-end.
     * @param {{ cells?: object[] }|null|undefined} clip
     * @param {number} destX
     * @param {number} destY
     * @returns {{ rect: object|null }}
     */
    function pasteTiles(clip, destX, destY) {
        if (!clip || !Array.isArray(clip.cells) || !clip.cells.length) return { rect: null };
        const dx0 = destX | 0;
        const dy0 = destY | 0;
        if (!Number.isFinite(dx0) || !Number.isFinite(dy0)) return { rect: null };
        const wasPainting = painting;
        if (!wasPainting) beginStroke();
        for (let i = 0; i < clip.cells.length; i++) {
            const c = clip.cells[i];
            if (!c) continue;
            const x = dx0 + (c.dx | 0);
            const y = dy0 + (c.dy | 0);
            if (!inBounds(x, y)) continue;
            if (!c.stamp) {
                paintAt(x, y, { erase: true, subLayer: c.subLayer, size: 1, shape: 'square' });
            } else {
                paintAt(x, y, { stamp: c.stamp, subLayer: c.subLayer, size: 1, shape: 'square' });
            }
        }
        if (!wasPainting) return endStroke();
        return { rect: boundsFromIndices(strokeDirty) };
    }

    /**
     * Punch a hole through every authoring channel in a tile rect.
     * Clears all TileMap sub-layers, fields, and override bits. Stroke-end
     * re-resolves the Wang 1-ring and bakes empty-stack void (friction/sight
     * 255, flags 0). Stairs in the rect drop. World / spawn pins are not
     * touched.
     * @param {{ x0: number, y0: number, x1: number, y1: number }} rect inclusive
     * @returns {{ rect: object|null }}
     */
    function clearAllLayers(rect) {
        if (!rect) return { rect: null };
        ensureChannels(floor);
        const x0 = Math.min(rect.x0, rect.x1) | 0;
        const y0 = Math.min(rect.y0, rect.y1) | 0;
        const x1 = Math.max(rect.x0, rect.x1) | 0;
        const y1 = Math.max(rect.y0, rect.y1) | 0;
        const xa = Math.max(0, x0);
        const ya = Math.max(0, y0);
        const xb = Math.min(floor.cols - 1, x1);
        const yb = Math.min(floor.rows - 1, y1);
        if (xb < xa || yb < ya) return { rect: null };

        const wasPainting = painting;
        if (!wasPainting) beginStroke();

        const cells = [];
        for (let y = ya; y <= yb; y++) {
            for (let x = xa; x <= xb; x++) cells.push([x, y]);
        }
        ensureStrokeBeforeForCells(cells, true);

        const layers = floor.subLayers || [];
        for (let c = 0; c < cells.length; c++) {
            const px = cells[c][0];
            const py = cells[c][1];
            const i = idx(px, py);
            for (let s = 0; s < layers.length; s++) {
                const sl = layers[s];
                if (sl && sl.cells) sl.cells[i] = 0;
            }
            floor.fields[i] = 0;
            floor.overrideMask[i] = 0;
            strokeDirty.add(i);
        }
        strokeNeedsBake = true;
        markDirty();
        if (!wasPainting) return endStroke();
        return { rect: boundsFromIndices(strokeDirty) };
    }

    /**
     * Stair pad at (x,y) on this floor, or null.
     * @param {number} x
     * @param {number} y
     * @returns {object|null}
     */
    function findStairAt(x, y) {
        const ix = x | 0;
        const iy = y | 0;
        const list = floor.stairs || [];
        for (let i = 0; i < list.length; i++) {
            const s = list[i];
            if (s && (s.x | 0) === ix && (s.y | 0) === iy) return s;
        }
        return null;
    }

    /**
     * @param {number[]} indices
     * @param {() => void} mutate
     */
    function commitSparseUndo(indices, mutate) {
        const before = snapshotFloorSparse(floor, indices);
        mutate();
        const after = snapshotFloorSparse(floor, indices);
        undoStack.push({ before, after });
        if (undoStack.length > MAX_UNDO) undoStack.shift();
        redoStack.length = 0;
        markDirty();
    }

    /**
     * Lock pad dest to an explicit tile (`dir: custom`). One-way only.
     * @param {number} x
     * @param {number} y
     * @param {{ x: number, y: number, z?: string|number }} to
     * @param {{ undo?: boolean }} [opts]
     * @returns {{ ok: boolean, reason?: string, row?: object }}
     */
    function setStairDest(x, y, to, opts) {
        const row = findStairAt(x, y);
        if (!row) return { ok: false, reason: 'no_pad' };
        const dest = normalizeEditorStairDest(
            to,
            to && to.z !== undefined && to.z !== null ? to.z : row.z
        );
        if (!dest) return { ok: false, reason: 'invalid_to' };
        if (
            dest.x === (row.x | 0) &&
            dest.y === (row.y | 0) &&
            String(dest.z) === String(row.z)
        ) {
            return { ok: false, reason: 'same_tile' };
        }
        const apply = () => {
            row.dir = 'custom';
            row.to = { x: dest.x, y: dest.y, z: dest.z };
            const fromZ = Number(row.z);
            const toZ = Number(dest.z);
            if (Number.isFinite(fromZ) && Number.isFinite(toZ)) {
                row.deltaZ = Math.trunc(toZ - fromZ);
            }
        };
        if (opts && opts.undo === false) {
            apply();
            markDirty();
        } else {
            commitSparseUndo([idx(row.x | 0, row.y | 0)], apply);
        }
        return { ok: true, row };
    }

    /**
     * Drop explicit dest and rebuild from the stamp dir/deltaZ.
     * @param {number} x
     * @param {number} y
     * @returns {{ ok: boolean, reason?: string, row?: object }}
     */
    function resetStairDest(x, y) {
        const row = findStairAt(x, y);
        if (!row) return { ok: false, reason: 'no_pad' };
        const i = idx(row.x | 0, row.y | 0);
        commitSparseUndo([i], () => {
            const dirtySet = new Set([i]);
            const { verticals } = bakeCellIndices(floor, dirtySet, {
                roleCatalog,
                friction: floor.friction,
                sight: floor.sight,
                flags: floor.flags,
                previous: {
                    friction: floor.friction,
                    sight: floor.sight,
                    flags: floor.flags
                }
            });
            floor.stairs = (floor.stairs || []).filter((s) => {
                if (!s) return false;
                return idx(s.x | 0, s.y | 0) !== i;
            });
            if (verticals.length) {
                for (let v = 0; v < verticals.length; v++) {
                    floor.stairs.push(
                        stairRowFromVertical(verticals[v], floor.z, null)
                    );
                }
            } else {
                const fallback = {
                    x: row.x,
                    y: row.y,
                    z: row.z,
                    dir: 'center',
                    type: row.type || 'stairs',
                    deltaZ: row.deltaZ != null ? row.deltaZ : 0,
                    to: null
                };
                const resolved = resolveEditorStairLink(fallback);
                fallback.to = resolved
                    ? {
                          x: resolved.to.x,
                          y: resolved.to.y,
                          z: resolved.to.z
                      }
                    : null;
                if (fallback.to) floor.stairs.push(fallback);
            }
        });
        return { ok: true, row: findStairAt(x, y) };
    }

    return {
        get floor() {
            return floor;
        },
        get cols() {
            return floor.cols;
        },
        get rows() {
            return floor.rows;
        },
        get z() {
            return floor.z;
        },
        get dirty() {
            return dirty;
        },
        get stamps() {
            return stamps;
        },
        get activeSubLayer() {
            return activeSubLayer;
        },
        get selectedStamp() {
            return selectedStamp;
        },
        get canUndo() {
            return undoStack.length > 0;
        },
        get canRedo() {
            return redoStack.length > 0;
        },
        setActiveSubLayer(id) {
            if (SUB_LAYER_IDS.includes(id)) activeSubLayer = id;
        },
        selectStamp(stamp) {
            selectedStamp = stamp || null;
            if (stamp && stamp.subLayer && SUB_LAYER_IDS.includes(stamp.subLayer)) {
                // Suggest sub-layer but do not force if user pinned another
                if (!stamp.lockSubLayer) activeSubLayer = stamp.subLayer;
            }
        },
        setArtSet,
        setRoleCatalog,
        beginStroke,
        paintAt,
        endStroke,
        bucketFill,
        paintChannel,
        bakeAll,
        bakeDirtyIndices,
        undo,
        redo,
        bootstrapFromChannels,
        loadFloor,
        toHybridPack,
        toHybridBinaryTransport,
        toHybridTransport,
        loadHybridTransport,
        previewColorAt,
        sampleCellAt,
        copyTiles,
        pasteTiles,
        clearAllLayers,
        findStairAt,
        setStairDest,
        resetStairDest,
        ensureStampPaletteIndex: (stamp) => ensureStampPaletteIndex(floor, stamp),
        markClean() {
            dirty = false;
        },
        markDirty
    };
}

/**
 * Flag palette packages for the Flags layer.
 * `icon` is a Font Awesome 6 Free solid class (no `fa-solid` prefix) for the
 * wiki editor swatch + high-zoom overlay.
 * @returns {Array<{ id: string, label: string, bits: number, color: string, icon?: string, package?: boolean }>}
 */
function flagPaletteEntries() {
    return [
        { id: 'none', label: 'None (0)', bits: 0, color: '#000000' },
        {
            id: 'pz',
            label: 'Protection Zone (NO_CAST|NO_CREATURE)',
            bits: TILE_FLAG_PZ_PACKAGE,
            color: '#00ff00',
            icon: 'fa-shield-halved',
            package: true
        },
        {
            id: 'no_cast',
            label: 'No Cast only',
            bits: TILE_FLAG_NO_CAST,
            color: '#66ff66',
            icon: 'fa-ban'
        },
        {
            id: 'no_creature',
            label: 'No Creature only',
            bits: TILE_FLAG_NO_CREATURE,
            color: '#00aa00',
            icon: 'fa-user-slash'
        },
        { id: 'stair', label: 'Stair', bits: TILE_FLAG_STAIR, color: '#ff00ff', icon: 'fa-stairs' },
        { id: 'ladder', label: 'Ladder', bits: TILE_FLAG_LADDER, color: '#ff0000', icon: 'fa-bars' },
        { id: 'hole', label: 'Hole', bits: TILE_FLAG_HOLE, color: '#0000ff', icon: 'fa-arrow-down' },
        {
            id: 'rope',
            label: 'Rope Spot',
            bits: TILE_FLAG_ROPE_SPOT,
            color: '#00aaff',
            icon: 'fa-circle-dot'
        },
        {
            id: 'shovel',
            label: 'Shovel Spot',
            bits: TILE_FLAG_SHOVEL_SPOT,
            color: '#ff8000',
            icon: 'fa-xmark'
        }
    ];
}

/**
 * CSS color for a friction value (matches legacy editor swatches).
 * @param {number} val
 * @returns {string}
 */
function frictionPreviewColor(val) {
    if (val === 255) return '#ffff00';
    const hex = (val & 0xff).toString(16).padStart(2, '0');
    return `#${hex}${hex}${hex}`;
}

/**
 * CSS color for flags bits (package preferred).
 * @param {number} bits
 * @returns {string}
 */
function flagsPreviewColor(bits) {
    const b = bits & 0xff;
    if (!b) return '#000000';
    if ((b & TILE_FLAG_PZ_PACKAGE) === TILE_FLAG_PZ_PACKAGE) return '#00ff00';
    if (b & TILE_FLAG_NO_CAST) return '#66ff66';
    if (b & TILE_FLAG_NO_CREATURE) return '#00aa00';
    if (b & TILE_FLAG_STAIR) return '#ff00ff';
    if (b & TILE_FLAG_LADDER) return '#ff0000';
    if (b & TILE_FLAG_HOLE) return '#0000ff';
    if (b & TILE_FLAG_ROPE_SPOT) return '#00aaff';
    if (b & TILE_FLAG_SHOVEL_SPOT) return '#ff8000';
    return '#ffffff';
}

module.exports = {
    UI_SUB_LAYER_ORDER,
    MAP_FIELD_DEFAULT_TTL_SEC,
    ROLE_DEFAULT_SUBLAYER,
    ROLE_PREVIEW_COLORS,
    preferredSubLayer,
    occupancyStamp,
    resolveWangOnFloor,
    resolveWallsOnFloor,
    buildStampsFromArtSet,
    ensureChannels,
    frictionWalkClass,
    createEditorSession,
    stairRowFromVertical,
    isExplicitEditorStairDest,
    flagPaletteEntries,
    frictionPreviewColor,
    flagsPreviewColor,
    forEachBrushCell,
    // re-exports for UI convenience
    SUB_LAYER_DEFS,
    SUB_LAYER_IDS,
    OVERRIDE_FRICTION,
    OVERRIDE_SIGHT,
    OVERRIDE_FLAGS,
    TILE_FLAG_PZ_PACKAGE,
    TILE_FLAG_NO_CAST,
    TILE_FLAG_NO_CREATURE,
    indexTileRoles
};
