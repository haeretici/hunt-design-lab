/**
 * Pathfinder — short-path A* for TileMap grids.
 *
 * Stage 2: pure JS (Node + browser same code path). Binary min-heap,
 * g-scores by flat index, octile heuristic, diagonal corner rules from
 * legacy search(). Caps: maxDistance / maxIterations.
 *
 * Friction contract: only the blocked sentinel (255 / FRICTION_BLOCKED)
 * affects search. Walkable values (0–254) never change step cost — A*
 * uses geometric cost only (cardinal 1, diagonal √2). Terrain stickiness
 * applies later as moveDelay via movement.js, not as path cost.
 *
 * Optional faster backends can sit behind the same findPath API later.
 */

'use strict';

const { Settings } = require('../../settings.js');

const SQRT2 = Math.SQRT2;

/** Default search caps (legacy starting points). */
const DEFAULT_MAX_DISTANCE = 100;
const DEFAULT_MAX_ITERATIONS = 512;

/** Non-walkable sentinel — keep in sync with TileMap / Settings.FRICTION_BLOCKED */
function blockedValue() {
    return Settings.FRICTION_BLOCKED != null ? Settings.FRICTION_BLOCKED : 255;
}

/**
 * @typedef {Object} PathPoint
 * @property {number} x
 * @property {number} y
 */

/**
 * @typedef {Object} PathTile
 * @property {number} x
 * @property {number} y
 * @property {string|number} [z]
 */

/**
 * @typedef {Object} FindPathOptions
 * @property {boolean} [allowDiagonal=true]
 * @property {boolean} [checkOccupied=false] Treat occupancy ≠ 0 as blocked (end always open). Ignored when useStackPolicy.
 * @property {boolean} [useStackPolicy=false] 4C stack/push enterability via tileMap.pathStepOccupancy + mover
 * @property {object|number|null} [mover] Entity (or id) for stack/push occupancy policy
 * @property {number} [occupantStepPenalty=0] Soft A* cost on 'soft' (push-enterable) intermediates
 * @property {number} [maxDistance] Chebyshev-style box from start (legacy default 100)
 * @property {number} [maxIterations] Expanded-node budget (legacy default 512)
 * @property {number} [avoidFieldMask=0] Bitmask of elemental field hazards to avoid (1=fire, 2=poison, 4=energy)
 * @property {boolean} [ignorePlayerFields=false] Allow walking through player-sourced fields (friendly fire immunity)
 * @property {number} [fieldPenalty=0] Soft cost for avoided fields when > 0 (13C provoked mode); 0 = hard avoid
 */

/**
 * Binary min-heap. Compare returns < 0 if a should be above b.
 * @template T
 */
class MinHeap {
    /**
     * @param {(a: T, b: T) => number} compare
     */
    constructor(compare) {
        /** @type {T[]} */
        this._data = [];
        this._cmp = compare;
    }

    /** @returns {number} */
    get size() {
        return this._data.length;
    }

    /** @param {T} item */
    push(item) {
        const d = this._data;
        d.push(item);
        this._up(d.length - 1);
    }

    /** @returns {T|undefined} */
    pop() {
        const d = this._data;
        if (d.length === 0) return undefined;
        const top = d[0];
        const last = d.pop();
        if (d.length > 0 && last !== undefined) {
            d[0] = last;
            this._down(0);
        }
        return top;
    }

    /**
     * @param {number} i
     * @private
     */
    _up(i) {
        const d = this._data;
        const cmp = this._cmp;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (cmp(d[i], d[p]) >= 0) break;
            const tmp = d[p];
            d[p] = d[i];
            d[i] = tmp;
            i = p;
        }
    }

    /**
     * @param {number} i
     * @private
     */
    _down(i) {
        const d = this._data;
        const cmp = this._cmp;
        const n = d.length;
        for (;;) {
            let best = i;
            const l = i * 2 + 1;
            const r = l + 1;
            if (l < n && cmp(d[l], d[best]) < 0) best = l;
            if (r < n && cmp(d[r], d[best]) < 0) best = r;
            if (best === i) break;
            const tmp = d[best];
            d[best] = d[i];
            d[i] = tmp;
            i = best;
        }
    }
}

/**
 * @param {number} dx
 * @param {number} dy
 * @param {boolean} allowDiagonal
 * @returns {number}
 */
function heuristic(dx, dy, allowDiagonal) {
    const adx = Math.abs(dx);
    const ady = Math.abs(dy);
    if (allowDiagonal) {
        // Octile: max steps + (√2 − 1) * min (equiv. dx+dy+(√2−2)*min)
        return adx + ady + (SQRT2 - 2) * Math.min(adx, ady);
    }
    return adx + ady;
}

/**
 * Reconstruct path from end node → start as [{x,y}, …] inclusive.
 * @param {{ x: number, y: number, parent: object|null }} node
 * @returns {PathPoint[]}
 */
function reconstructPath(node) {
    /** @type {PathPoint[]} */
    const path = [];
    let cur = node;
    while (cur) {
        path.push({ x: cur.x, y: cur.y });
        cur = cur.parent;
    }
    path.reverse();
    return path;
}

/**
 * A* short path on a TileMap floor.
 *
 * Rules (from legacy search):
 * - End tile is always enterable (even blocked / occupied) so combat pathing can target it.
 * - Diagonal moves allowed only when not both cardinal corner tiles are blocked
 *   (“relaxed” corner rule: blocked only if BOTH side tiles are obstacles).
 * - maxDistance: skip nodes outside |Δx| / |Δy| box from start (end exempt).
 * - maxIterations: hard cap on expanded nodes → null if exceeded.
 *
 * @param {{ getLayer: Function, getFriction: Function, getOccupant: Function, index: Function }} tileMap
 * @param {PathTile} start
 * @param {PathTile} end
 * @param {FindPathOptions} [options]
 * @returns {PathPoint[]|null} Inclusive path start→end, or null if none / capped out
 */
function findPath(tileMap, start, end, options) {
    if (!tileMap || !start || !end) return null;

    const allowDiagonal =
        options && options.allowDiagonal !== undefined
            ? !!options.allowDiagonal
            : true;
    const checkOccupied =
        options && options.checkOccupied !== undefined
            ? !!options.checkOccupied
            : false;
    const useStackPolicy =
        !!(options && options.useStackPolicy) ||
        !!(options && options.mover != null);
    const mover = options && options.mover != null ? options.mover : null;
    const occupantStepPenalty =
        options && options.occupantStepPenalty !== undefined
            ? Number(options.occupantStepPenalty)
            : 0;
    const maxDistance =
        options && options.maxDistance !== undefined
            ? options.maxDistance
            : Settings.PATH_MAX_DISTANCE != null
              ? Settings.PATH_MAX_DISTANCE
              : DEFAULT_MAX_DISTANCE;
    const maxIterations =
        options && options.maxIterations !== undefined
            ? options.maxIterations
            : Settings.PATH_MAX_ITERATIONS != null
              ? Settings.PATH_MAX_ITERATIONS
              : DEFAULT_MAX_ITERATIONS;

    const sx = Math.round(start.x);
    const sy = Math.round(start.y);
    const ex = Math.round(end.x);
    const ey = Math.round(end.y);
    const z = start.z !== undefined && start.z !== null ? start.z : end.z;
    // Local A* is single-floor. Cross-floor goals are invalid here — callers
    // must use stairs / navmesh followLongPath (avoids silent wrong-layer paths).
    if (
        start &&
        end &&
        start.z !== undefined &&
        start.z !== null &&
        end.z !== undefined &&
        end.z !== null &&
        String(start.z) !== String(end.z)
    ) {
        return null;
    }

    const layer = tileMap.getLayer(z);
    if (!layer) return null;

    const cols = layer.cols;
    const rows = layer.rows;
    const friction = layer.friction;
    const occupancy = layer.occupancy;
    const fields = layer.fields || null;

    const avoidFieldMask =
        options && options.avoidFieldMask !== undefined
            ? Number(options.avoidFieldMask) | 0
            : 0;
    const ignorePlayerFields =
        options && options.ignorePlayerFields !== undefined
            ? !!options.ignorePlayerFields
            : false;
    const fieldPenalty =
        options && options.fieldPenalty !== undefined
            ? Number(options.fieldPenalty)
            : 0;

    if (sx < 0 || sy < 0 || sx >= cols || sy >= rows) return null;
    if (ex < 0 || ey < 0 || ex >= cols || ey >= rows) return null;

    if (sx === ex && sy === ey) {
        return [{ x: sx, y: sy }];
    }

    /**
     * Helper to test if a tile index has an avoided field hazard.
     * Player-sourced fields (bit 8) are ignored only when ignorePlayerFields.
     * Creature/scenario fields always count when the kind bit matches.
     * @param {number} idx
     * @returns {boolean}
     */
    function isHazardField(idx) {
        if (!fields || avoidFieldMask <= 0 || (fields[idx] & avoidFieldMask) === 0) {
            return false;
        }
        if (ignorePlayerFields && (fields[idx] & 8) !== 0) {
            return false;
        }
        return true;
    }

    /**
     * Occupancy kind for intermediate tiles under 4C stack policy.
     * @param {number} x
     * @param {number} y
     * @returns {'free'|'soft'|'hard'}
     */
    function occupancyKind(x, y) {
        if (
            useStackPolicy &&
            tileMap &&
            typeof tileMap.pathStepOccupancy === 'function'
        ) {
            return tileMap.pathStepOccupancy(x, y, z, mover);
        }
        const idx = y * cols + x;
        if (!checkOccupied || occupancy[idx] === 0) return 'free';
        return 'hard';
    }

    /**
     * Blocked for traversal.
     * End tile stays open for friction/occupancy (path *to* a combat target),
     * but avoided elemental fields still block the goal in strict mode
     * (fieldPenalty === 0) so entities with canWalkOn* false do not path onto hazards.
     * @param {number} x
     * @param {number} y
     * @returns {boolean}
     */
    function isBlocked(x, y) {
        const isEnd = x === ex && y === ey;
        const idx = y * cols + x;
        // Solid obstacle fields (barrier / vine, bit 16) always hard-block,
        // including as a path goal — unlike combat targets behind open tiles.
        if (fields && (fields[idx] & 16) !== 0) return true;
        // NO_CREATURE (PZ package bit): monsters cannot path onto the tile.
        // Players + talkable NPCs are exempt via creatureMayEnterTile.
        if (
            mover &&
            tileMap &&
            typeof tileMap.creatureMayEnterTile === 'function' &&
            !tileMap.creatureMayEnterTile(x, y, z, mover)
        ) {
            return true;
        }
        if (!isEnd) {
            if (friction[idx] === blockedValue()) return true;
            if (occupancyKind(x, y) === 'hard') return true;
        }
        // Strict avoidance: field hazards block intermediates *and* the goal.
        // Soft fieldPenalty (13C provoked) allows goal + intermediates with cost.
        if (fieldPenalty <= 0 && isHazardField(idx)) return true;
        return false;
    }

    // Open set: min f, then min h (legacy heap-js order)
    const open = new MinHeap((a, b) => {
        if (a.f !== b.f) return a.f - b.f;
        return a.h - b.h;
    });

    /** @type {Map<number, number>} best g by flat index */
    const gValues = new Map();

    const startH = heuristic(sx - ex, sy - ey, allowDiagonal);
    const startNode = {
        x: sx,
        y: sy,
        g: 0,
        h: startH,
        f: startH,
        parent: null
    };
    gValues.set(sy * cols + sx, 0);
    open.push(startNode);

    /** Cardinal then diagonal (matches legacy move order) */
    const moves = allowDiagonal
        ? [
              [0, -1],
              [-1, 0],
              [0, 1],
              [1, 0],
              [-1, -1],
              [1, -1],
              [-1, 1],
              [1, 1]
          ]
        : [
              [0, -1],
              [-1, 0],
              [0, 1],
              [1, 0]
          ];

    let expanded = 0;

    while (open.size > 0) {
        const current = open.pop();
        if (!current) break;

        const cIdx = current.y * cols + current.x;
        const bestG = gValues.get(cIdx);
        if (bestG !== undefined && current.g > bestG) {
            continue;
        }

        if (current.x === ex && current.y === ey) {
            return reconstructPath(current);
        }

        expanded++;
        if (expanded > maxIterations) {
            return null;
        }

        for (let m = 0; m < moves.length; m++) {
            const mx = moves[m][0];
            const my = moves[m][1];
            const nx = current.x + mx;
            const ny = current.y + my;

            if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
            if (isBlocked(nx, ny)) continue;

            // Relaxed diagonal: skip only if BOTH cardinal neighbors are blocked
            if (allowDiagonal && mx !== 0 && my !== 0) {
                const c1x = current.x + mx;
                const c1y = current.y;
                const c2x = current.x;
                const c2y = current.y + my;
                const c1ok =
                    c1x >= 0 && c1x < cols && c1y >= 0 && c1y < rows;
                const c2ok =
                    c2x >= 0 && c2x < cols && c2y >= 0 && c2y < rows;
                if (
                    c1ok &&
                    c2ok &&
                    isBlocked(c1x, c1y) &&
                    isBlocked(c2x, c2y)
                ) {
                    continue;
                }
            }

            // Distance box from start (end always allowed)
            if (
                (nx !== ex || ny !== ey) &&
                (Math.abs(nx - sx) > maxDistance ||
                    Math.abs(ny - sy) > maxDistance)
            ) {
                continue;
            }

            // Geometric cost only for friction — do not weight by friction gray.
            // Soft occupant (4C) + soft field (13C) penalties apply when enabled.
            let moveCost = mx !== 0 && my !== 0 ? SQRT2 : 1;
            const nIdx = ny * cols + nx;
            if (
                occupantStepPenalty > 0 &&
                (nx !== ex || ny !== ey) &&
                occupancyKind(nx, ny) === 'soft'
            ) {
                moveCost += occupantStepPenalty;
            }
            if (fieldPenalty > 0 && isHazardField(nIdx)) {
                moveCost += fieldPenalty;
            }
            const tentativeG = current.g + moveCost;
            const prevG = gValues.get(nIdx);
            if (prevG !== undefined && tentativeG >= prevG) continue;

            gValues.set(nIdx, tentativeG);
            const h = heuristic(nx - ex, ny - ey, allowDiagonal);
            open.push({
                x: nx,
                y: ny,
                g: tentativeG,
                h,
                f: tentativeG + h,
                parent: current
            });
        }
    }

    return null;
}

/**
 * Pathfinder façade (allows a future alternate backend without changing callers).
 */
class Pathfinder {
    /**
     * @param {FindPathOptions} [defaults] Merged under each findPath call
     */
    constructor(defaults) {
        this.defaults = defaults || {};
    }

    /**
     * @param {object} tileMap
     * @param {PathTile} start
     * @param {PathTile} end
     * @param {FindPathOptions} [options]
     * @returns {PathPoint[]|null}
     */
    findPath(tileMap, start, end, options) {
        return findPath(tileMap, start, end, Object.assign({}, this.defaults, options));
    }
}

module.exports = {
    Pathfinder,
    MinHeap,
    findPath,
    heuristic,
    DEFAULT_MAX_DISTANCE,
    DEFAULT_MAX_ITERATIONS
};
