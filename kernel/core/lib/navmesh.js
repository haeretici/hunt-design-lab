/**
 * Navmesh — coarse waypoint graph for long routes (Stage 10).
 *
 * Local A* (pathfinder.js) stays hard-capped. Long paths use:
 *   start → closest graph points → coarse A* on the graph → successive local A*
 * segments, then stitch into a full tile path.
 *
 * Hunts still prefer authored waypoints; this layer serves UI/long-click paths
 * and multi-segment floor graphs (stair tiles are first-class on TileMap;
 * graph edges still connect multi-floor coarse routes).
 */

'use strict';

const path = require('path');
const { Settings, ROOT, PATHS } = require('../../settings.js');
const { findPath, MinHeap } = require('./pathfinder.js');

let fs = null;
try {
    fs = require('fs');
} catch (_) {
    fs = null;
}

/** Default max Chebyshev distance for a single player/UI path request. */
const DEFAULT_PATH_REQUEST_MAX_DISTANCE = 100;

/**
 * @typedef {Object} NavPoint
 * @property {number} x
 * @property {number} y
 * @property {string|number} z
 * @property {object} [properties]
 */

/**
 * @typedef {Object} NavmeshData
 * @property {NavPoint[]} points
 * @property {number[][]} connections undirected edge list [a, b] indices
 * @property {string} [id]
 * @property {string} [label]
 * @property {string|number} [floor] primary floor hint
 */

/**
 * Euclidean distance between two nav points (same units as tile coords).
 * @param {NavPoint} a
 * @param {NavPoint} b
 * @returns {number}
 */
function euclid(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Chebyshev distance (tile steps with diagonal).
 * @param {{ x: number, y: number }} a
 * @param {{ x: number, y: number }} b
 * @returns {number}
 */
function chebyshev(a, b) {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/**
 * Normalize z for comparisons / storage.
 * @param {string|number|undefined|null} z
 * @returns {string}
 */
function zKey(z) {
    if (z === undefined || z === null) return '0';
    return String(z);
}

/**
 * Coarse graph of map waypoints + helpers to expand into local A* segments.
 */
class Navmesh {
    /**
     * @param {NavmeshData|null} [data]
     */
    constructor(data) {
        /** @type {NavPoint[]} */
        this.points = [];
        /** @type {number[][]} adjacency list */
        this.adj = [];
        /** @type {string|null} */
        this.id = null;
        /** @type {string|null} */
        this.label = null;
        /** @type {string|null} */
        this.floor = null;

        if (data) this.load(data);
    }

    /**
     * Replace graph from JSON-like data.
     * @param {NavmeshData} data
     * @returns {this}
     */
    load(data) {
        if (!data || !Array.isArray(data.points)) {
            throw new Error('Navmesh.load: data.points array required');
        }
        this.points = data.points.map((p) => ({
            x: Math.round(p.x),
            y: Math.round(p.y),
            z: p.z !== undefined && p.z !== null ? p.z : 0,
            properties: p.properties ? { ...p.properties } : {}
        }));
        this.adj = Array.from({ length: this.points.length }, () => []);
        const conns = Array.isArray(data.connections) ? data.connections : [];
        for (const edge of conns) {
            if (!edge || edge.length < 2) continue;
            const a = edge[0] | 0;
            const b = edge[1] | 0;
            if (a < 0 || b < 0 || a >= this.points.length || b >= this.points.length) {
                continue;
            }
            if (a === b) continue;
            if (!this.adj[a].includes(b)) this.adj[a].push(b);
            if (!this.adj[b].includes(a)) this.adj[b].push(a);
        }
        this.id = data.id != null ? String(data.id) : null;
        this.label = data.label != null ? String(data.label) : null;
        this.floor =
            data.floor !== undefined && data.floor !== null
                ? String(data.floor)
                : null;
        return this;
    }

    /**
     * @returns {NavmeshData}
     */
    toJSON() {
        const connections = [];
        for (let i = 0; i < this.adj.length; i++) {
            for (const j of this.adj[i]) {
                if (j > i) connections.push([i, j]);
            }
        }
        return {
            id: this.id || undefined,
            label: this.label || undefined,
            floor: this.floor != null ? this.floor : undefined,
            points: this.points.map((p) => ({
                x: p.x,
                y: p.y,
                z: p.z,
                properties: p.properties && Object.keys(p.properties).length
                    ? { ...p.properties }
                    : undefined
            })),
            connections
        };
    }

    /**
     * n closest graph points to (x,y) on floor z (z must match).
     * @param {number} x
     * @param {number} y
     * @param {string|number} z
     * @param {number} [n=1]
     * @returns {[number, NavPoint, number][]} [index, point, dist] sorted nearest-first
     */
    getClosestPoints(x, y, z, n) {
        const count = n != null && n > 0 ? n | 0 : 1;
        const zk = zKey(z);
        /** @type {{ index: number, dist: number }[]} */
        const candidates = [];
        for (let i = 0; i < this.points.length; i++) {
            const p = this.points[i];
            if (zKey(p.z) !== zk) continue;
            const dx = p.x - x;
            const dy = p.y - y;
            candidates.push({ index: i, dist: Math.sqrt(dx * dx + dy * dy) });
        }
        candidates.sort((a, b) => a.dist - b.dist);
        const out = [];
        for (let i = 0; i < Math.min(count, candidates.length); i++) {
            const c = candidates[i];
            out.push([c.index, this.points[c.index], c.dist]);
        }
        return out;
    }

    /**
     * Coarse A* on the undirected graph. Edge cost = Euclidean between points.
     * @param {number} pointA index
     * @param {number} pointB index
     * @returns {number[]|null} index path inclusive, or null
     */
    getPath(pointA, pointB) {
        const n = this.points.length;
        if (pointA < 0 || pointB < 0 || pointA >= n || pointB >= n) return null;
        if (pointA === pointB) return [pointA];

        const heuristic = (a, b) => euclid(this.points[a], this.points[b]);

        const open = new MinHeap((a, b) => {
            if (a.f !== b.f) return a.f - b.f;
            return a.h - b.h;
        });
        /** @type {Map<number, number>} */
        const gScore = new Map();
        /** @type {Map<number, number|null>} */
        const cameFrom = new Map();

        gScore.set(pointA, 0);
        cameFrom.set(pointA, null);
        const h0 = heuristic(pointA, pointB);
        open.push({ node: pointA, g: 0, h: h0, f: h0 });

        while (open.size > 0) {
            const cur = open.pop();
            if (!cur) break;
            const bestG = gScore.get(cur.node);
            if (bestG !== undefined && cur.g > bestG) continue;

            if (cur.node === pointB) {
                const path = [];
                let c = pointB;
                while (c !== null && c !== undefined) {
                    path.push(c);
                    c = cameFrom.get(c);
                    if (c === undefined) break;
                }
                path.reverse();
                return path;
            }

            const neighbors = this.adj[cur.node] || [];
            for (const nb of neighbors) {
                const cost = heuristic(cur.node, nb);
                const tent = cur.g + cost;
                const prev = gScore.get(nb);
                if (prev !== undefined && tent >= prev) continue;
                gScore.set(nb, tent);
                cameFrom.set(nb, cur.node);
                const h = heuristic(nb, pointB);
                open.push({ node: nb, g: tent, h, f: tent + h });
            }
        }
        return null;
    }

    /**
     * @param {number[]} indices
     * @returns {NavPoint[]}
     */
    getPointsFromIndices(indices) {
        if (!Array.isArray(indices)) return [];
        const out = [];
        for (const idx of indices) {
            if (idx >= 0 && idx < this.points.length) {
                const p = this.points[idx];
                out.push({
                    x: p.x,
                    y: p.y,
                    z: p.z,
                    properties: p.properties ? { ...p.properties } : {}
                });
            }
        }
        return out;
    }

    /**
     * When consecutive waypoints change floor z, insert intermediate graph
     * nodes along the coarse path between closest nav points (legacy idea).
     * Same-floor segments are left unchanged.
     *
     * @param {NavPoint[]} waypoints
     * @returns {NavPoint[]}
     */
    connectFloors(waypoints) {
        const result = [];
        if (!waypoints || !waypoints.length) return result;

        for (let i = 0; i < waypoints.length; i++) {
            const cur = {
                x: Math.round(waypoints[i].x),
                y: Math.round(waypoints[i].y),
                z: waypoints[i].z,
                properties: waypoints[i].properties
                    ? { ...waypoints[i].properties }
                    : {}
            };
            result.push(cur);

            if (i + 1 >= waypoints.length) break;
            const next = waypoints[i + 1];
            if (zKey(cur.z) === zKey(next.z)) continue;

            const closestA = this.getClosestPoints(cur.x, cur.y, cur.z, 1);
            const closestB = this.getClosestPoints(next.x, next.y, next.z, 1);
            if (!closestA.length || !closestB.length) continue;

            const indices = this.getPath(closestA[0][0], closestB[0][0]);
            if (!indices || !indices.length) continue;

            const pathPoints = this.getPointsFromIndices(indices);
            for (const point of pathPoints) {
                const isCurrent =
                    point.x === cur.x &&
                    point.y === cur.y &&
                    zKey(point.z) === zKey(cur.z);
                const isNext =
                    point.x === Math.round(next.x) &&
                    point.y === Math.round(next.y) &&
                    zKey(point.z) === zKey(next.z);
                if (!isCurrent && !isNext) {
                    result.push(point);
                } else if (isCurrent) {
                    const last = result[result.length - 1];
                    last.properties = {
                        ...(point.properties || {}),
                        ...(last.properties || {})
                    };
                }
            }
        }
        return result;
    }

    /**
     * Coarse route as nav indices from near start to near end (same or multi-z).
     * Tries a few closest endpoints when the first pair has no graph path.
     *
     * @param {{ x: number, y: number, z?: string|number }} start
     * @param {{ x: number, y: number, z?: string|number }} end
     * @param {{ closestN?: number }} [options]
     * @returns {{ indices: number[], points: NavPoint[] }|null}
     */
    findCoarseRoute(start, end, options) {
        if (!start || !end) return null;
        const n =
            options && options.closestN != null
                ? options.closestN | 0
                : Settings.NAVMESH_CLOSEST_N != null
                  ? Settings.NAVMESH_CLOSEST_N
                  : 3;
        const closestN = Math.max(1, n);

        const sz = start.z !== undefined && start.z !== null ? start.z : end.z;
        const ez = end.z !== undefined && end.z !== null ? end.z : start.z;
        const starts = this.getClosestPoints(start.x, start.y, sz, closestN);
        const ends = this.getClosestPoints(end.x, end.y, ez, closestN);
        if (!starts.length || !ends.length) return null;

        let best = null;
        let bestCost = Infinity;
        for (const [si] of starts) {
            for (const [ei] of ends) {
                const indices = this.getPath(si, ei);
                if (!indices) continue;
                let cost = 0;
                for (let k = 1; k < indices.length; k++) {
                    cost += euclid(
                        this.points[indices[k - 1]],
                        this.points[indices[k]]
                    );
                }
                // Prefer snug snaps + short graph cost
                cost += starts.find((c) => c[0] === si)[2];
                cost += ends.find((c) => c[0] === ei)[2];
                if (cost < bestCost) {
                    bestCost = cost;
                    best = indices;
                }
            }
        }
        if (!best) return null;
        return { indices: best, points: this.getPointsFromIndices(best) };
    }

    /**
     * Build a sequence of tile anchors: start → intermediate nav nodes → end.
     * Drops consecutive duplicates.
     *
     * @param {{ x: number, y: number, z?: string|number }} start
     * @param {{ x: number, y: number, z?: string|number }} end
     * @param {{ closestN?: number }} [options]
     * @returns {{ x: number, y: number, z: string|number }[]|null}
     */
    planAnchors(start, end, options) {
        const coarse = this.findCoarseRoute(start, end, options);
        if (!coarse) return null;
        const sz = start.z !== undefined && start.z !== null ? start.z : end.z;
        const ez = end.z !== undefined && end.z !== null ? end.z : start.z;
        /** @type {{ x: number, y: number, z: string|number }[]} */
        const anchors = [
            { x: Math.round(start.x), y: Math.round(start.y), z: sz }
        ];
        for (const p of coarse.points) {
            anchors.push({ x: p.x, y: p.y, z: p.z });
        }
        anchors.push({
            x: Math.round(end.x),
            y: Math.round(end.y),
            z: ez
        });
        return dedupeAnchors(anchors);
    }
}

/**
 * @param {{ x: number, y: number, z: string|number }[]} anchors
 * @returns {{ x: number, y: number, z: string|number }[]}
 */
function dedupeAnchors(anchors) {
    const out = [];
    for (const a of anchors) {
        const last = out[out.length - 1];
        if (
            last &&
            last.x === a.x &&
            last.y === a.y &&
            zKey(last.z) === zKey(a.z)
        ) {
            continue;
        }
        out.push(a);
    }
    return out;
}

/**
 * Stitch local A* between consecutive anchors into one inclusive path.
 * Same-floor segments use local A*. Multi-floor hops (Stage 11.8 / 12H) insert
 * both anchors without A* — runtime follows them via first-class stair tiles
 * (TileMap.tryUseStair) or a direct occupancy transfer.
 *
 * @param {{ search?: Function, getLayer?: Function, getStair?: Function }} tileMap
 * @param {{ x: number, y: number, z: string|number }[]} anchors
 * @param {object} [localOptions] FindPathOptions for each segment
 * @returns {{ x: number, y: number, z: string|number }[]|null}
 */
function expandAnchorsWithLocalAStar(tileMap, anchors, localOptions) {
    if (!tileMap || !anchors || anchors.length === 0) return null;
    if (anchors.length === 1) {
        return [{ x: anchors[0].x, y: anchors[0].y, z: anchors[0].z }];
    }

    /** @type {{ x: number, y: number, z: string|number }[]} */
    const full = [];
    for (let i = 0; i < anchors.length - 1; i++) {
        const a = anchors[i];
        const b = anchors[i + 1];
        if (zKey(a.z) !== zKey(b.z)) {
            // Multi-floor hop: prefer registered stair dest when a sits on a pad
            let hopTo = { x: b.x, y: b.y, z: b.z };
            if (typeof tileMap.getStair === 'function') {
                const stair = tileMap.getStair(a.x, a.y, a.z);
                if (stair && zKey(stair.z) === zKey(b.z)) {
                    hopTo = { x: stair.x, y: stair.y, z: stair.z };
                }
            }
            const last = full[full.length - 1];
            if (
                !last ||
                last.x !== a.x ||
                last.y !== a.y ||
                zKey(last.z) !== zKey(a.z)
            ) {
                full.push({ x: a.x, y: a.y, z: a.z });
            }
            full.push(hopTo);
            // If hop landed on pad but coarse target continues elsewhere on b.z,
            // keep b when it differs so local pathing can continue after hop.
            if (
                hopTo.x !== b.x ||
                hopTo.y !== b.y ||
                zKey(hopTo.z) !== zKey(b.z)
            ) {
                full.push({ x: b.x, y: b.y, z: b.z });
            }
            continue;
        }
        let seg = null;
        if (typeof tileMap.search === 'function') {
            seg = tileMap.search(a, b, localOptions || {});
        } else {
            seg = findPath(tileMap, a, b, localOptions || {});
        }
        if (!seg || !seg.length) return null;
        for (let j = 0; j < seg.length; j++) {
            const pt = { x: seg[j].x, y: seg[j].y, z: a.z };
            const last = full[full.length - 1];
            if (last && last.x === pt.x && last.y === pt.y && zKey(last.z) === zKey(pt.z)) {
                continue;
            }
            full.push(pt);
        }
    }
    return full.length ? full : null;
}

/**
 * Resolve path request distance cap.
 * @param {object} [options]
 * @returns {number}
 */
function pathRequestMaxDistance(options) {
    if (options && options.maxRequestDistance !== undefined) {
        return options.maxRequestDistance;
    }
    if (Settings.PATH_REQUEST_MAX_DISTANCE != null) {
        return Settings.PATH_REQUEST_MAX_DISTANCE;
    }
    return DEFAULT_PATH_REQUEST_MAX_DISTANCE;
}

/**
 * Find a path that may exceed a single local A* budget by using the navmesh.
 *
 * Rules:
 * - Same start/end → trivial path.
 * - If Chebyshev(start,end) > maxRequestDistance and enforceRequestCap:
 *     reject unless useNavmeshBeyondCap allows navmesh (default true when
 *     navmesh provided; player clicks should set enforceRequestCap true and
 *     useNavmeshBeyondCap false for hard UI limit).
 * - Prefer direct local A* when within maxDistance and same z.
 * - Else plan anchors via navmesh and expand segments with local A*.
 *
 * @param {object} tileMap
 * @param {{ x: number, y: number, z?: string|number }} start
 * @param {{ x: number, y: number, z?: string|number }} end
 * @param {{
 *   navmesh?: Navmesh|null,
 *   maxDistance?: number,
 *   maxIterations?: number,
 *   maxRequestDistance?: number,
 *   enforceRequestCap?: boolean,
 *   useNavmeshBeyondCap?: boolean,
 *   allowDiagonal?: boolean,
 *   checkOccupied?: boolean,
 *   closestN?: number
 * }} [options]
 * @returns {{
 *   path: { x: number, y: number, z: string|number }[]|null,
 *   mode: 'trivial'|'local'|'segmented'|'rejected'|'failed',
 *   anchors?: { x: number, y: number, z: string|number }[],
 *   reason?: string
 * }}
 */
function findLongPath(tileMap, start, end, options) {
    const opts = options || {};
    if (!tileMap || !start || !end) {
        return { path: null, mode: 'failed', reason: 'missing_args' };
    }

    const sx = Math.round(start.x);
    const sy = Math.round(start.y);
    const ex = Math.round(end.x);
    const ey = Math.round(end.y);
    const sz = start.z !== undefined && start.z !== null ? start.z : end.z;
    const ez = end.z !== undefined && end.z !== null ? end.z : start.z;

    if (sx === ex && sy === ey && zKey(sz) === zKey(ez)) {
        return {
            path: [{ x: sx, y: sy, z: sz }],
            mode: 'trivial'
        };
    }

    const requestCap = pathRequestMaxDistance(opts);
    const dist = chebyshev({ x: sx, y: sy }, { x: ex, y: ey });
    const multiFloor = zKey(sz) !== zKey(ez);
    const enforce =
        opts.enforceRequestCap !== undefined ? !!opts.enforceRequestCap : false;
    const useBeyond =
        opts.useNavmeshBeyondCap !== undefined
            ? !!opts.useNavmeshBeyondCap
            : true;

    if (enforce && dist > requestCap && !useBeyond) {
        return {
            path: null,
            mode: 'rejected',
            reason: 'request_too_far'
        };
    }

    const localOpts = {
        allowDiagonal: opts.allowDiagonal !== undefined ? opts.allowDiagonal : true,
        checkOccupied: opts.checkOccupied !== undefined ? opts.checkOccupied : false,
        maxDistance:
            opts.maxDistance !== undefined
                ? opts.maxDistance
                : Settings.PATH_MAX_DISTANCE != null
                  ? Settings.PATH_MAX_DISTANCE
                  : 100,
        maxIterations:
            opts.maxIterations !== undefined
                ? opts.maxIterations
                : Settings.PATH_MAX_ITERATIONS != null
                  ? Settings.PATH_MAX_ITERATIONS
                  : 512
    };

    // Direct local A* when same floor and within local box cap
    if (!multiFloor && dist <= localOpts.maxDistance) {
        let local = null;
        if (typeof tileMap.search === 'function') {
            local = tileMap.search(
                { x: sx, y: sy, z: sz },
                { x: ex, y: ey, z: ez },
                localOpts
            );
        } else {
            local = findPath(
                tileMap,
                { x: sx, y: sy, z: sz },
                { x: ex, y: ey, z: ez },
                localOpts
            );
        }
        if (local && local.length) {
            return {
                path: local.map((p) => ({ x: p.x, y: p.y, z: sz })),
                mode: 'local'
            };
        }
        // fall through to navmesh if direct failed (walls / iterations)
    }

    const mesh = opts.navmesh || null;
    if (!mesh || !mesh.points || !mesh.points.length) {
        return {
            path: null,
            mode: 'failed',
            reason: multiFloor ? 'no_navmesh_multi_floor' : 'local_failed_no_navmesh'
        };
    }

    if (enforce && dist > requestCap && !useBeyond) {
        return { path: null, mode: 'rejected', reason: 'request_too_far' };
    }

    const anchors = mesh.planAnchors(
        { x: sx, y: sy, z: sz },
        { x: ex, y: ey, z: ez },
        { closestN: opts.closestN }
    );
    if (!anchors || anchors.length < 2) {
        return {
            path: null,
            mode: 'failed',
            reason: 'no_coarse_route',
            anchors: anchors || undefined
        };
    }

    const expanded = expandAnchorsWithLocalAStar(tileMap, anchors, localOpts);
    if (!expanded) {
        return {
            path: null,
            mode: 'failed',
            reason: 'segment_expand_failed',
            anchors
        };
    }
    return { path: expanded, mode: 'segmented', anchors };
}

/**
 * Load navmesh JSON from disk (Node).
 * Looks under assets/legacy/map/navmesh/<id>.json then presets/navmesh/<id>.json.
 *
 * @param {string} idOrPath mesh id or absolute/relative path ending in .json
 * @returns {Navmesh}
 */
function loadNavmesh(idOrPath) {
    if (!fs) {
        throw new Error('loadNavmesh: fs unavailable (browser). Use Navmesh + injected data.');
    }
    let full = idOrPath;
    if (!idOrPath.endsWith('.json')) {
        const id = String(idOrPath);
        const candidates = [
            path.join(PATHS.navmesh, `${id}.json`),
            path.join(PATHS.maps, 'navmesh', `${id}.json`),
            path.join(ROOT || process.cwd(), 'presets', 'navmesh', `${id}.json`),
            path.join(PATHS.navmesh, 'merged.json'),
            path.join(PATHS.maps, 'navmesh', id, 'merged.json')
        ];
        full = null;
        for (const c of candidates) {
            if (fs.existsSync(c)) {
                full = c;
                break;
            }
        }
        if (!full) {
            throw new Error(
                `loadNavmesh: no file for "${id}" under assets/legacy/map/navmesh or presets/navmesh`
            );
        }
    } else if (!path.isAbsolute(full) && ROOT) {
        const tryPaths = [
            path.resolve(full),
            path.join(ROOT, full),
            path.join(PATHS.navmesh, path.basename(full)),
            path.join(PATHS.maps, 'navmesh', path.basename(full))
        ];
        full = null;
        for (const c of tryPaths) {
            if (fs.existsSync(c)) {
                full = c;
                break;
            }
        }
        if (!full) {
            throw new Error(`loadNavmesh: file not found: ${idOrPath}`);
        }
    }
    const raw = fs.readFileSync(full, 'utf8');
    const data = JSON.parse(raw);
    const mesh = new Navmesh(data);
    if (!mesh.id) mesh.id = path.basename(full, '.json');
    return mesh;
}

/**
 * Build an undirected graph from points, connecting pairs within maxEdge
 * Euclidean distance (and optionally same z only).
 *
 * @param {NavPoint[]} points
 * @param {{ maxEdge?: number, sameFloorOnly?: boolean, id?: string, label?: string }} [options]
 * @returns {Navmesh}
 */
function buildNavmeshFromPoints(points, options) {
    const opts = options || {};
    const maxEdge = opts.maxEdge != null ? opts.maxEdge : 32;
    const sameFloorOnly = opts.sameFloorOnly !== false;
    const data = {
        id: opts.id,
        label: opts.label,
        points: points || [],
        connections: []
    };
    for (let i = 0; i < data.points.length; i++) {
        for (let j = i + 1; j < data.points.length; j++) {
            const a = data.points[i];
            const b = data.points[j];
            if (sameFloorOnly && zKey(a.z) !== zKey(b.z)) continue;
            if (euclid(a, b) <= maxEdge) {
                data.connections.push([i, j]);
            }
        }
    }
    return new Navmesh(data);
}

module.exports = {
    Navmesh,
    findLongPath,
    expandAnchorsWithLocalAStar,
    loadNavmesh,
    buildNavmeshFromPoints,
    chebyshev,
    euclid,
    zKey,
    DEFAULT_PATH_REQUEST_MAX_DISTANCE
};
