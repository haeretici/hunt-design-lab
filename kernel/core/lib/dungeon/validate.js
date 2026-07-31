/**
 * Stage 11.4 — Layout validation (connectivity, bounds, spawn walkability).
 *
 * Headless QA: entrance→exit path, spawn/marker sockets on walkable tiles.
 */

'use strict';

const { FRICTION_BLOCKED } = require('./pieces.js');

/**
 * @param {Uint8Array} friction
 * @param {number} cols
 * @param {number} rows
 * @param {number} x
 * @param {number} y
 * @returns {boolean}
 */
function isWalkableCell(friction, cols, rows, x, y) {
    if (x < 0 || y < 0 || x >= cols || y >= rows) return false;
    return friction[y * cols + x] !== FRICTION_BLOCKED;
}

/**
 * 4-connected BFS: can walk from start to goal on friction grid.
 * @param {Uint8Array} friction
 * @param {number} cols
 * @param {number} rows
 * @param {{x:number,y:number}} start
 * @param {{x:number,y:number}} goal
 * @param {{ maxNodes?: number }} [opts]
 * @returns {{ ok: boolean, pathLength: number, visited: number }}
 */
function canReach(friction, cols, rows, start, goal, opts) {
    const o = opts || {};
    const maxNodes = o.maxNodes != null ? o.maxNodes : cols * rows + 8;
    if (!start || !goal) {
        return { ok: false, pathLength: 0, visited: 0 };
    }
    const sx = Math.floor(start.x);
    const sy = Math.floor(start.y);
    const gx = Math.floor(goal.x);
    const gy = Math.floor(goal.y);
    if (!isWalkableCell(friction, cols, rows, sx, sy)) {
        return { ok: false, pathLength: 0, visited: 0, reason: 'start_blocked' };
    }
    if (!isWalkableCell(friction, cols, rows, gx, gy)) {
        return { ok: false, pathLength: 0, visited: 0, reason: 'goal_blocked' };
    }
    if (sx === gx && sy === gy) {
        return { ok: true, pathLength: 0, visited: 1 };
    }

    const visited = new Uint8Array(cols * rows);
    const qx = new Int32Array(maxNodes);
    const qy = new Int32Array(maxNodes);
    const dist = new Int32Array(maxNodes);
    let head = 0;
    let tail = 0;
    const sIdx = sy * cols + sx;
    visited[sIdx] = 1;
    qx[tail] = sx;
    qy[tail] = sy;
    dist[tail] = 0;
    tail++;

    const dirs = [
        [0, -1],
        [0, 1],
        [1, 0],
        [-1, 0]
    ];

    while (head < tail) {
        const x = qx[head];
        const y = qy[head];
        const d = dist[head];
        head++;
        for (let i = 0; i < 4; i++) {
            const nx = x + dirs[i][0];
            const ny = y + dirs[i][1];
            if (!isWalkableCell(friction, cols, rows, nx, ny)) continue;
            const idx = ny * cols + nx;
            if (visited[idx]) continue;
            visited[idx] = 1;
            if (nx === gx && ny === gy) {
                return { ok: true, pathLength: d + 1, visited: head + 1 };
            }
            if (tail >= maxNodes) {
                return {
                    ok: false,
                    pathLength: 0,
                    visited: head,
                    reason: 'bfs_budget'
                };
            }
            qx[tail] = nx;
            qy[tail] = ny;
            dist[tail] = d + 1;
            tail++;
        }
    }
    return { ok: false, pathLength: 0, visited: head, reason: 'disconnected' };
}

/**
 * Count walkable cells.
 * @param {Uint8Array} friction
 * @returns {number}
 */
function countWalkable(friction) {
    let n = 0;
    for (let i = 0; i < friction.length; i++) {
        if (friction[i] !== FRICTION_BLOCKED) n++;
    }
    return n;
}

/**
 * Validate sockets sit on walkable tiles.
 * @param {Uint8Array} friction
 * @param {number} cols
 * @param {number} rows
 * @param {object[]} points
 * @returns {{ ok: boolean, bad: object[] }}
 */
function validateWalkablePoints(friction, cols, rows, points) {
    const bad = [];
    const list = Array.isArray(points) ? points : [];
    for (let i = 0; i < list.length; i++) {
        const p = list[i];
        if (!p) continue;
        const x = Math.floor(Number(p.x));
        const y = Math.floor(Number(p.y));
        if (!isWalkableCell(friction, cols, rows, x, y)) {
            bad.push({ x, y, kind: p.id != null ? p.id : i });
        }
    }
    return { ok: bad.length === 0, bad };
}

/**
 * Full layout validation after stitch.
 *
 * @param {{
 *   cols: number,
 *   rows: number,
 *   friction: Uint8Array,
 *   sockets?: { spawns?: object[], markers?: object[], waypoints?: object[] }
 * }} stitched
 * @param {{
 *   entrance?: {x:number,y:number},
 *   exit?: {x:number,y:number},
 *   requireEntranceExit?: boolean,
 *   requireSpawnWalkable?: boolean,
 *   minWalkable?: number
 * }} [opts]
 * @returns {{
 *   ok: boolean,
 *   errors: { code: string, message: string, detail?: * }[],
 *   connectivity?: object,
 *   walkable?: number
 * }}
 */
function validateLayout(stitched, opts) {
    const o = opts || {};
    const errors = [];
    if (!stitched || !stitched.friction) {
        return {
            ok: false,
            errors: [
                {
                    code: 'empty_layout',
                    message: 'No stitched friction to validate'
                }
            ]
        };
    }

    const cols = stitched.cols | 0;
    const rows = stitched.rows | 0;
    const friction = stitched.friction;
    const walkable = countWalkable(friction);
    const minWalkable = o.minWalkable != null ? o.minWalkable : 4;
    if (walkable < minWalkable) {
        errors.push({
            code: 'too_few_walkable',
            message: `Walkable cells ${walkable} < ${minWalkable}`,
            detail: { walkable }
        });
    }

    let entrance = o.entrance || null;
    let exit = o.exit || null;
    const wps =
        (stitched.sockets && stitched.sockets.waypoints) || [];
    if (!entrance && wps.length) entrance = wps[0];
    if (!exit && wps.length) exit = wps[wps.length - 1];

    const requireEE = o.requireEntranceExit !== false;
    let connectivity = null;
    if (requireEE) {
        if (!entrance || !exit) {
            errors.push({
                code: 'missing_entrance_exit',
                message: 'Need entrance and exit sockets for connectivity'
            });
        } else {
            connectivity = canReach(friction, cols, rows, entrance, exit);
            if (!connectivity.ok) {
                errors.push({
                    code: 'disconnected',
                    message: 'Entrance cannot reach exit',
                    detail: connectivity
                });
            }
        }
    }

    if (o.requireSpawnWalkable !== false) {
        const spawns = (stitched.sockets && stitched.sockets.spawns) || [];
        const sv = validateWalkablePoints(friction, cols, rows, spawns);
        if (!sv.ok) {
            errors.push({
                code: 'spawn_blocked',
                message: `${sv.bad.length} spawn socket(s) not walkable`,
                detail: sv.bad.slice(0, 8)
            });
        }
        const markers = (stitched.sockets && stitched.sockets.markers) || [];
        const mv = validateWalkablePoints(friction, cols, rows, markers);
        if (!mv.ok) {
            errors.push({
                code: 'marker_blocked',
                message: `${mv.bad.length} marker socket(s) not walkable`,
                detail: mv.bad.slice(0, 8)
            });
        }
    }

    // Bounds sanity
    if (cols < 1 || rows < 1) {
        errors.push({
            code: 'bad_bounds',
            message: `Invalid size ${cols}x${rows}`
        });
    }

    return {
        ok: errors.length === 0,
        errors,
        connectivity,
        walkable,
        entrance: entrance
            ? { x: Math.floor(entrance.x), y: Math.floor(entrance.y) }
            : null,
        exit: exit
            ? { x: Math.floor(exit.x), y: Math.floor(exit.y) }
            : null
    };
}

module.exports = {
    isWalkableCell,
    canReach,
    countWalkable,
    validateWalkablePoints,
    validateLayout,
    FRICTION_BLOCKED
};
