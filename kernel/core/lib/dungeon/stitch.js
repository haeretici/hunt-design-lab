/**
 * Stage 11.3 — Piece stitcher.
 *
 * Place normalized pieces at tile origins → world friction / sight / flags
 * grids + absolute sockets. Output is ready for TileMap.loadFloorFromFriction
 * (or loadFloorFromRgba via frictionToRgba / collisionToRgba helpers).
 */

'use strict';

const {
    FRICTION_BLOCKED,
    SIGHT_BLOCKED,
    SIGHT_CLEAR,
    normalizePiece,
    DEFAULT_WALK_FRICTION,
    OPPOSITE,
    canConnect
} = require('./pieces.js');

/**
 * @param {*} v
 * @returns {number}
 */
function floorInt(v, fallback) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.floor(n);
}

/**
 * Resolve placement list entries to { piece, x, y, z, rotation? }.
 * Each entry: { piece | pieceId, x, y, z? } with optional pack lookup.
 *
 * @param {object[]} placements
 * @param {{ byId?: Record<string, object>, getPiece?: (id: string) => object|null }} [ctx]
 * @returns {{ piece: object, x: number, y: number, z: number|string, id: string }[]}
 */
function resolvePlacements(placements, ctx) {
    const c = ctx || {};
    const byId = c.byId || Object.create(null);
    const list = Array.isArray(placements) ? placements : [];
    const out = [];

    for (let i = 0; i < list.length; i++) {
        const pl = list[i];
        if (!pl) continue;
        let piece = null;
        if (pl.piece && typeof pl.piece === 'object') {
            piece = pl.piece.friction instanceof Uint8Array
                ? pl.piece
                : normalizePiece(pl.piece);
        } else {
            const pid =
                pl.pieceId != null
                    ? String(pl.pieceId)
                    : pl.id != null
                      ? String(pl.id)
                      : null;
            if (pid) {
                if (byId[pid]) {
                    piece = byId[pid];
                } else if (typeof c.getPiece === 'function') {
                    const raw = c.getPiece(pid);
                    piece =
                        raw && raw.friction instanceof Uint8Array
                            ? raw
                            : normalizePiece(raw);
                }
            }
        }
        if (!piece) continue;
        const x = floorInt(pl.x, 0);
        const y = floorInt(pl.y, 0);
        const z = pl.z != null ? pl.z : 0;
        out.push({
            piece,
            x,
            y,
            z,
            id: piece.id,
            placementIndex: i
        });
    }
    return out;
}

/**
 * Compute world bounding box for placements (tile-inclusive max).
 * @param {{ piece: object, x: number, y: number }[]} resolved
 * @returns {{ minX: number, minY: number, maxX: number, maxY: number, cols: number, rows: number }}
 */
function boundingBox(resolved) {
    if (!resolved.length) {
        return { minX: 0, minY: 0, maxX: 0, maxY: 0, cols: 1, rows: 1 };
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < resolved.length; i++) {
        const r = resolved[i];
        const w = r.piece.size.w;
        const h = r.piece.size.h;
        minX = Math.min(minX, r.x);
        minY = Math.min(minY, r.y);
        maxX = Math.max(maxX, r.x + w);
        maxY = Math.max(maxY, r.y + h);
    }
    // Normalize so origin can be 0,0 in output when shiftOrigin
    const cols = Math.max(1, maxX - minX);
    const rows = Math.max(1, maxY - minY);
    return { minX, minY, maxX, maxY, cols, rows };
}

/**
 * Stamp one piece collision into world buffers.
 * Later pieces overwrite earlier ones (last-write wins) on overlap.
 *
 * @param {Uint8Array} destFriction
 * @param {number} cols
 * @param {number} rows
 * @param {object} piece normalized
 * @param {number} ox top-left x in dest coords
 * @param {number} oy top-left y in dest coords
 * @param {{
 *   overwriteBlocked?: boolean,
 *   destSight?: Uint8Array|null,
 *   destFlags?: Uint8Array|null
 * }} [opts]
 */
function stampPiece(destFriction, cols, rows, piece, ox, oy, opts) {
    const o = opts || {};
    const overwriteBlocked = o.overwriteBlocked !== false;
    const destSight = o.destSight || null;
    const destFlags = o.destFlags || null;
    const w = piece.size.w;
    const h = piece.size.h;
    const srcF = piece.friction;
    const srcS = piece.sight || null;
    const srcFl = piece.flags || null;
    for (let ly = 0; ly < h; ly++) {
        const wy = oy + ly;
        if (wy < 0 || wy >= rows) continue;
        for (let lx = 0; lx < w; lx++) {
            const wx = ox + lx;
            if (wx < 0 || wx >= cols) continue;
            const li = ly * w + lx;
            const f = srcF[li];
            if (!overwriteBlocked && f === FRICTION_BLOCKED) continue;
            const di = wy * cols + wx;
            destFriction[di] = f;
            if (destSight) {
                destSight[di] = srcS
                    ? srcS[li]
                    : f === FRICTION_BLOCKED
                      ? SIGHT_BLOCKED
                      : SIGHT_CLEAR;
            }
            if (destFlags) {
                destFlags[di] = srcFl ? srcFl[li] : 0;
            }
        }
    }
}

/**
 * Offset piece-local sockets into world space.
 * @param {object} piece
 * @param {number} ox
 * @param {number} oy
 * @param {number|string} z
 * @param {string} pieceId
 * @param {number} placementIndex
 * @returns {{
 *   spawns: object[],
 *   markers: object[],
 *   waypoints: object[]
 * }}
 */
function offsetSockets(piece, ox, oy, z, pieceId, placementIndex) {
    const spawns = [];
    const markers = [];
    const waypoints = [];
    const stairs = [];
    const sock = piece.sockets || {};

    const spawnSrc = sock.spawns || [];
    for (let i = 0; i < spawnSrc.length; i++) {
        const s = spawnSrc[i];
        spawns.push({
            x: ox + s.x,
            y: oy + s.y,
            z,
            pieceId,
            placementIndex
        });
    }

    const markSrc = sock.markers || [];
    for (let i = 0; i < markSrc.length; i++) {
        const s = markSrc[i];
        markers.push({
            id: s.id != null ? s.id : 'A',
            x: ox + s.x,
            y: oy + s.y,
            z,
            pieceId,
            placementIndex
        });
    }

    const wpSrc = sock.waypoints || [];
    for (let i = 0; i < wpSrc.length; i++) {
        const s = wpSrc[i];
        const row = {
            x: ox + s.x,
            y: oy + s.y,
            z,
            pieceId,
            placementIndex
        };
        if (s.id != null) row.id = s.id;
        waypoints.push(row);
    }

    const stairSrc = sock.stairs || [];
    for (let i = 0; i < stairSrc.length; i++) {
        const s = stairSrc[i];
        const row = {
            x: ox + s.x,
            y: oy + s.y,
            z,
            dir: s.dir,
            pieceId,
            placementIndex
        };
        if (s.link != null) row.link = s.link;
        stairs.push(row);
    }

    return { spawns, markers, waypoints, stairs };
}

/**
 * Stitch placements into a single floor friction grid + absolute sockets.
 *
 * @param {object[]} placements
 * @param {{
 *   byId?: Record<string, object>,
 *   getPiece?: (id: string) => object|null,
 *   pack?: object,
 *   shiftOrigin?: boolean,
 *   fill?: number,
 *   z?: number|string,
 *   overwriteBlocked?: boolean
 * }} [opts]
 * @returns {{
 *   cols: number,
 *   rows: number,
 *   friction: Uint8Array,
 *   sockets: { spawns: object[], markers: object[], waypoints: object[], stairs: object[] },
 *   placements: object[],
 *   origin: { x: number, y: number },
 *   meta: object
 * }}
 */
function stitch(placements, opts) {
    const o = opts || {};
    const pack = o.pack || null;
    const byId =
        o.byId ||
        (pack && pack.byId) ||
        Object.create(null);

    const resolved = resolvePlacements(placements, {
        byId,
        getPiece: o.getPiece
    });

    if (!resolved.length) {
        const fill = o.fill != null ? o.fill | 0 : FRICTION_BLOCKED;
        const fillSight =
            fill === FRICTION_BLOCKED ? SIGHT_BLOCKED : SIGHT_CLEAR;
        return {
            cols: 1,
            rows: 1,
            friction: new Uint8Array([fill]),
            sight: new Uint8Array([fillSight]),
            flags: new Uint8Array([0]),
            sockets: { spawns: [], markers: [], waypoints: [], stairs: [] },
            placements: [],
            origin: { x: 0, y: 0 },
            meta: { pieceCount: 0, reason: 'empty' }
        };
    }

    // Optional default z for sockets
    const defaultZ = o.z != null ? o.z : resolved[0].z;
    for (let i = 0; i < resolved.length; i++) {
        if (resolved[i].z == null) resolved[i].z = defaultZ;
    }

    const box = boundingBox(resolved);
    const shiftOrigin = o.shiftOrigin !== false;
    const originX = shiftOrigin ? box.minX : 0;
    const originY = shiftOrigin ? box.minY : 0;
    const cols = shiftOrigin
        ? box.cols
        : Math.max(1, box.maxX);
    const rows = shiftOrigin
        ? box.rows
        : Math.max(1, box.maxY);

    const fill =
        o.fill != null ? (o.fill | 0) & 0xff : FRICTION_BLOCKED;
    const fillSight =
        fill === FRICTION_BLOCKED ? SIGHT_BLOCKED : SIGHT_CLEAR;
    const friction = new Uint8Array(cols * rows);
    friction.fill(fill);
    const sight = new Uint8Array(cols * rows);
    sight.fill(fillSight);
    const flags = new Uint8Array(cols * rows);

    const sockets = { spawns: [], markers: [], waypoints: [], stairs: [] };
    const placedMeta = [];

    for (let i = 0; i < resolved.length; i++) {
        const r = resolved[i];
        const ox = r.x - originX;
        const oy = r.y - originY;
        stampPiece(friction, cols, rows, r.piece, ox, oy, {
            overwriteBlocked: o.overwriteBlocked,
            destSight: sight,
            destFlags: flags
        });
        const sock = offsetSockets(
            r.piece,
            ox,
            oy,
            r.z,
            r.id,
            r.placementIndex
        );
        for (let j = 0; j < sock.spawns.length; j++) {
            sockets.spawns.push(sock.spawns[j]);
        }
        for (let j = 0; j < sock.markers.length; j++) {
            sockets.markers.push(sock.markers[j]);
        }
        for (let j = 0; j < sock.waypoints.length; j++) {
            sockets.waypoints.push(sock.waypoints[j]);
        }
        for (let j = 0; j < sock.stairs.length; j++) {
            sockets.stairs.push(sock.stairs[j]);
        }
        placedMeta.push({
            pieceId: r.id,
            x: ox,
            y: oy,
            worldX: r.x,
            worldY: r.y,
            z: r.z,
            w: r.piece.size.w,
            h: r.piece.size.h,
            exits: r.piece.exits,
            tags: r.piece.tags
        });
    }

    return {
        cols,
        rows,
        friction,
        sight,
        flags,
        sockets,
        placements: placedMeta,
        origin: { x: originX, y: originY },
        meta: {
            pieceCount: resolved.length,
            reason: 'ok',
            fill,
            walkDefault: DEFAULT_WALK_FRICTION
        }
    };
}

/**
 * Convert collision grids to RGBA suitable for TileMap.loadFloorFromRgba.
 * Encodes special path-PNG colors for water / grate / protection zone.
 *
 * @param {Uint8Array} friction
 * @param {number} cols
 * @param {number} rows
 * @param {{ sight?: Uint8Array|null, flags?: Uint8Array|null }} [opts]
 * @returns {Uint8Array} length cols*rows*4
 */
function frictionToRgba(friction, cols, rows, opts) {
    const o = opts || {};
    const sight = o.sight || null;
    const flags = o.flags || null;
    const n = cols * rows;
    const out = new Uint8Array(n * 4);
    const { TILE_FLAG_NO_CAST } = require('../../entities/tilemap.js');
    for (let i = 0; i < n; i++) {
        const f = friction[i];
        const si = sight
            ? sight[i]
            : f === FRICTION_BLOCKED
              ? SIGHT_BLOCKED
              : SIGHT_CLEAR;
        const fl = flags ? flags[i] : 0;
        const off = i * 4;
        if ((fl & TILE_FLAG_NO_CAST) !== 0 && f !== FRICTION_BLOCKED) {
            // Pure green — protection zone
            out[off] = 0;
            out[off + 1] = 255;
            out[off + 2] = 0;
            out[off + 3] = 255;
        } else if (f === FRICTION_BLOCKED && si === SIGHT_CLEAR) {
            // Pure cyan — water
            out[off] = 0;
            out[off + 1] = 255;
            out[off + 2] = 255;
            out[off + 3] = 255;
        } else if (f !== FRICTION_BLOCKED && si === SIGHT_BLOCKED) {
            // Pure magenta — grate
            out[off] = 255;
            out[off + 1] = 0;
            out[off + 2] = 255;
            out[off + 3] = 255;
        } else if (f === FRICTION_BLOCKED) {
            // Pure yellow — full wall
            out[off] = 255;
            out[off + 1] = 255;
            out[off + 2] = 0;
            out[off + 3] = 255;
        } else {
            const g = f & 0xff;
            out[off] = g;
            out[off + 1] = g;
            out[off + 2] = g;
            out[off + 3] = 255;
        }
    }
    return out;
}

/** Alias for explicit naming in authoring tools. */
const collisionToRgba = frictionToRgba;

/**
 * Build optional navmesh-style edges between consecutive waypoint sockets.
 * Not a full NavMesh bake — just ordered edges for tiny stitched maps.
 *
 * @param {{ x: number, y: number, z?: number|string }[]} waypoints
 * @returns {{ nodes: object[], edges: { from: number, to: number }[] }}
 */
function waypointSocketEdges(waypoints) {
    const nodes = Array.isArray(waypoints) ? waypoints.slice() : [];
    const edges = [];
    for (let i = 0; i + 1 < nodes.length; i++) {
        edges.push({ from: i, to: i + 1 });
    }
    return { nodes, edges };
}

/**
 * Validate that two adjacent placements match on the shared edge direction.
 * Placement A is "from", direction is from A toward B.
 *
 * @param {object} pieceA
 * @param {string} dir
 * @param {object} pieceB
 * @returns {boolean}
 */
function placementsConnect(pieceA, dir, pieceB) {
    return canConnect(pieceA, dir, pieceB);
}

/**
 * Suggest top-left of pieceB so it attaches to pieceA on direction `dir`
 * (from A toward B), abutted without gap/overlap on the shared edge.
 *
 * A at (ax, ay). B attaches south of A → B.y = ay + A.h, B.x = ax
 * (caller may center-align later).
 *
 * @param {object} pieceA
 * @param {number} ax
 * @param {number} ay
 * @param {string} dir
 * @param {object} pieceB
 * @returns {{ x: number, y: number }|null}
 */
function attachOrigin(pieceA, ax, ay, dir, pieceB) {
    if (!canConnect(pieceA, dir, pieceB)) return null;
    const d = String(dir).toUpperCase();
    const aw = pieceA.size.w;
    const ah = pieceA.size.h;
    const bw = pieceB.size.w;
    const bh = pieceB.size.h;
    // Center-align on the shared edge axis
    if (d === 'S') {
        return {
            x: ax + Math.floor((aw - bw) / 2),
            y: ay + ah
        };
    }
    if (d === 'N') {
        return {
            x: ax + Math.floor((aw - bw) / 2),
            y: ay - bh
        };
    }
    if (d === 'E') {
        return {
            x: ax + aw,
            y: ay + Math.floor((ah - bh) / 2)
        };
    }
    if (d === 'W') {
        return {
            x: ax - bw,
            y: ay + Math.floor((ah - bh) / 2)
        };
    }
    return null;
}

module.exports = {
    resolvePlacements,
    boundingBox,
    stampPiece,
    offsetSockets,
    stitch,
    frictionToRgba,
    collisionToRgba,
    waypointSocketEdges,
    placementsConnect,
    attachOrigin,
    OPPOSITE,
    FRICTION_BLOCKED
};
