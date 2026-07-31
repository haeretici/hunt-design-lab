/**
 * NavMesh bake per piece / floor (Stage 11.12+).
 *
 * Builds coarse nav graphs from piece friction or stitched floors so generated
 * hunts get richer auto-edges than sequential waypoint + stair links alone.
 * Edges are walkability-validated (4-connected BFS) and sized for local A*
 * segment expand (default hop budget = PATH_MAX_DISTANCE).
 *
 * Output shape matches Navmesh / hunt.navmeshData:
 *   { id, label?, floor?, points: [{x,y,z,properties?}], connections: [[i,j],…] }
 */

'use strict';

const { Settings } = require('../../../settings.js');
const { canReach, isWalkableCell } = require('./validate.js');

/**
 * Default Euclidean radius when considering a non-spine edge candidate.
 * Keep hops well under PATH_MAX_DISTANCE so segmented expand stays reliable.
 */
const DEFAULT_MAX_EDGE = 24;

/** Cap on spawn sockets used as secondary anchors (keeps graphs small). */
const DEFAULT_MAX_SPAWN_ANCHORS = 24;

/**
 * @returns {number}
 */
function defaultMaxPathLength() {
    return Settings.PATH_MAX_DISTANCE != null
        ? Settings.PATH_MAX_DISTANCE | 0
        : 100;
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
 * Stable point key for dedupe.
 * @param {{ x: number, y: number, z?: * }} p
 * @returns {string}
 */
function pointKey(p) {
    return `${p.x},${p.y},${p.z != null ? p.z : 0}`;
}

/**
 * Euclidean distance in tile units.
 * @param {{ x: number, y: number }} a
 * @param {{ x: number, y: number }} b
 * @returns {number}
 */
function euclid(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Collect / dedupe nav anchors into a points array + key index.
 * @returns {{
 *   points: object[],
 *   indexByKey: Record<string, number>,
 *   add: (p: object, props?: object) => number
 * }}
 */
function createPointSet() {
    /** @type {object[]} */
    const points = [];
    const indexByKey = Object.create(null);

    /**
     * @param {object|null|undefined} p
     * @param {object} [props]
     * @returns {number} index or -1
     */
    function add(p, props) {
        if (!p || p.x == null || p.y == null) return -1;
        const row = {
            x: floorInt(p.x, 0),
            y: floorInt(p.y, 0),
            z: p.z != null ? p.z : 0,
            properties: Object.assign({}, props || {}, p.properties || {})
        };
        const k = pointKey(row);
        if (indexByKey[k] != null) {
            const existing = points[indexByKey[k]];
            existing.properties = Object.assign(
                {},
                existing.properties || {},
                row.properties
            );
            return indexByKey[k];
        }
        const idx = points.length;
        indexByKey[k] = idx;
        points.push(row);
        return idx;
    }

    return { points, indexByKey, add };
}

/**
 * Undirected edge set.
 * @returns {{
 *   list: number[][],
 *   add: (a: number, b: number) => void,
 *   has: (a: number, b: number) => boolean
 * }}
 */
function createEdgeSet() {
    /** @type {number[][]} */
    const list = [];
    const seen = Object.create(null);

    /**
     * @param {number} a
     * @param {number} b
     */
    function add(a, b) {
        if (a < 0 || b < 0 || a === b) return;
        const lo = a < b ? a : b;
        const hi = a < b ? b : a;
        const k = `${lo},${hi}`;
        if (seen[k]) return;
        seen[k] = 1;
        list.push([lo, hi]);
    }

    /**
     * @param {number} a
     * @param {number} b
     * @returns {boolean}
     */
    function has(a, b) {
        if (a < 0 || b < 0 || a === b) return false;
        const lo = a < b ? a : b;
        const hi = a < b ? b : a;
        return !!seen[`${lo},${hi}`];
    }

    return { list, add, has };
}

/**
 * Strip empty / undefined property bags for cleaner JSON.
 * @param {object[]} points
 * @returns {object[]}
 */
function cleanPoints(points) {
    return points.map((p) => {
        const props = p.properties || {};
        const keys = Object.keys(props).filter((k) => props[k] !== undefined);
        const row = { x: p.x, y: p.y, z: p.z };
        if (keys.length) {
            row.properties = {};
            for (let i = 0; i < keys.length; i++) {
                row.properties[keys[i]] = props[keys[i]];
            }
        }
        return row;
    });
}

/**
 * Whether two same-floor anchors can form a local A* hop.
 *
 * @param {Uint8Array} friction
 * @param {number} cols
 * @param {number} rows
 * @param {{ x: number, y: number }} a
 * @param {{ x: number, y: number }} b
 * @param {{ maxPathLength?: number, maxEdge?: number, force?: boolean }} [opts]
 * @returns {{ ok: boolean, pathLength: number }}
 */
function canLinkAnchors(friction, cols, rows, a, b, opts) {
    const o = opts || {};
    const maxPath =
        o.maxPathLength != null ? o.maxPathLength | 0 : defaultMaxPathLength();
    const maxEdge = o.maxEdge != null ? Number(o.maxEdge) : DEFAULT_MAX_EDGE;

    if (!a || !b) return { ok: false, pathLength: 0 };
    if (a.x === b.x && a.y === b.y) return { ok: true, pathLength: 0 };

    const dist = euclid(a, b);
    if (maxEdge > 0 && dist > maxEdge && !o.force) {
        return { ok: false, pathLength: 0 };
    }

    const reach = canReach(friction, cols, rows, a, b, {
        maxNodes: Math.min(
            cols * rows + 8,
            Math.max(64, maxPath * maxPath * 4)
        )
    });
    if (!reach.ok) return { ok: false, pathLength: 0 };
    if (reach.pathLength > maxPath) {
        return { ok: false, pathLength: reach.pathLength };
    }
    return { ok: true, pathLength: reach.pathLength };
}

/**
 * Sample walkable cells on a stride grid (optional density).
 *
 * @param {Uint8Array} friction
 * @param {number} cols
 * @param {number} rows
 * @param {number} stride
 * @param {*|number} z
 * @returns {{ x: number, y: number, z: *, properties: object }[]}
 */
function sampleWalkableAnchors(friction, cols, rows, stride, z) {
    const s = Math.max(2, stride | 0);
    /** @type {{ x: number, y: number, z: *, properties: object }[]} */
    const out = [];
    for (let y = 0; y < rows; y += s) {
        for (let x = 0; x < cols; x += s) {
            if (!isWalkableCell(friction, cols, rows, x, y)) continue;
            out.push({
                x,
                y,
                z: z != null ? z : 0,
                properties: { sample: true }
            });
        }
    }
    return out;
}

/**
 * Collect floor anchors from sockets + optional extras.
 *
 * @param {object} input
 * @param {ReturnType<typeof createPointSet>} set
 * @returns {number[]} ordered spine indices (waypoint order)
 */
function collectFloorAnchors(input, set) {
    const z = input.z != null ? input.z : 0;
    const sock = input.sockets || {};
    const friction = input.friction;
    const cols = input.cols | 0;
    const rows = input.rows | 0;

    /**
     * @param {object} pt
     * @returns {boolean}
     */
    function walkable(pt) {
        if (!friction) return true;
        return isWalkableCell(
            friction,
            cols,
            rows,
            floorInt(pt.x, 0),
            floorInt(pt.y, 0)
        );
    }

    /** @type {number[]} */
    const spine = [];

    const wps = Array.isArray(input.waypoints)
        ? input.waypoints
        : Array.isArray(sock.waypoints)
          ? sock.waypoints
          : [];
    for (let i = 0; i < wps.length; i++) {
        const w = wps[i];
        if (!w) continue;
        const pt = { x: w.x, y: w.y, z: w.z != null ? w.z : z };
        if (!walkable(pt)) continue;
        const idx = set.add(pt, { waypoint: true });
        if (idx >= 0) spine.push(idx);
    }

    const stairs = Array.isArray(input.stairs)
        ? input.stairs
        : Array.isArray(sock.stairs)
          ? sock.stairs
          : [];
    for (let i = 0; i < stairs.length; i++) {
        const s = stairs[i];
        if (!s) continue;
        const pt = { x: s.x, y: s.y, z: s.z != null ? s.z : z };
        if (!walkable(pt)) continue;
        set.add(pt, {
            stair: s.dir != null ? String(s.dir) : true,
            link: s.link != null ? String(s.link) : undefined
        });
    }

    const includeSpawns = input.includeSpawns !== false;
    if (includeSpawns && Array.isArray(sock.spawns)) {
        const maxSp =
            input.maxSpawnAnchors != null
                ? input.maxSpawnAnchors | 0
                : DEFAULT_MAX_SPAWN_ANCHORS;
        let n = 0;
        for (let i = 0; i < sock.spawns.length && n < maxSp; i++) {
            const s = sock.spawns[i];
            if (!s) continue;
            const pt = { x: s.x, y: s.y, z: s.z != null ? s.z : z };
            if (!walkable(pt)) continue;
            set.add(pt, { spawn: true });
            n++;
        }
    }

    if (input.includeMarkers && Array.isArray(sock.markers)) {
        for (let i = 0; i < sock.markers.length; i++) {
            const m = sock.markers[i];
            if (!m) continue;
            const pt = { x: m.x, y: m.y, z: m.z != null ? m.z : z };
            if (!walkable(pt)) continue;
            set.add(pt, {
                marker: true,
                markerId: m.id != null ? String(m.id) : undefined
            });
        }
    }

    const stride = input.sampleStride | 0;
    if (stride > 0 && friction) {
        const samples = sampleWalkableAnchors(friction, cols, rows, stride, z);
        for (let i = 0; i < samples.length; i++) {
            set.add(samples[i], samples[i].properties);
        }
    }

    return spine;
}

/**
 * Greedy nearest-neighbor bridges between undirected components.
 *
 * @param {Uint8Array} friction
 * @param {number} cols
 * @param {number} rows
 * @param {object[]} points
 * @param {ReturnType<typeof createEdgeSet>} edges
 * @param {{ maxPathLength: number, maxEdge: number }} opts
 */
function stitchComponents(friction, cols, rows, points, edges, opts) {
    const n = points.length;
    if (n < 2) return;

    const rejected = Object.create(null);

    /**
     * @returns {{ comp: Int32Array, count: number }}
     */
    function components() {
        /** @type {number[][]} */
        const adj = Array.from({ length: n }, () => []);
        for (let e = 0; e < edges.list.length; e++) {
            const pair = edges.list[e];
            adj[pair[0]].push(pair[1]);
            adj[pair[1]].push(pair[0]);
        }
        const comp = new Int32Array(n);
        comp.fill(-1);
        let cid = 0;
        for (let i = 0; i < n; i++) {
            if (comp[i] >= 0) continue;
            const stack = [i];
            comp[i] = cid;
            while (stack.length) {
                const u = stack.pop();
                const nbrs = adj[u];
                for (let k = 0; k < nbrs.length; k++) {
                    const v = nbrs[k];
                    if (comp[v] < 0) {
                        comp[v] = cid;
                        stack.push(v);
                    }
                }
            }
            cid++;
        }
        return { comp, count: cid };
    }

    for (let pass = 0; pass < n; pass++) {
        const { comp, count } = components();
        if (count <= 1) return;

        /** @type {{ a: number, b: number, dist: number }|null} */
        let best = null;
        for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
                if (comp[i] === comp[j]) continue;
                if (String(points[i].z) !== String(points[j].z)) continue;
                if (edges.has(i, j)) continue;
                const rk = `${i < j ? i : j},${i < j ? j : i}`;
                if (rejected[rk]) continue;
                const d = euclid(points[i], points[j]);
                if (d > opts.maxEdge) continue;
                if (!best || d < best.dist) best = { a: i, b: j, dist: d };
            }
        }
        if (!best) return;
        const link = canLinkAnchors(
            friction,
            cols,
            rows,
            points[best.a],
            points[best.b],
            {
                maxPathLength: opts.maxPathLength,
                maxEdge: opts.maxEdge,
                force: true
            }
        );
        const rk = `${best.a < best.b ? best.a : best.b},${
            best.a < best.b ? best.b : best.a
        }`;
        if (!link.ok) {
            rejected[rk] = 1;
            continue;
        }
        edges.add(best.a, best.b);
    }
}

/**
 * Connect anchors: spine first, then radius + walkability, then component bridges.
 *
 * @param {Uint8Array} friction
 * @param {number} cols
 * @param {number} rows
 * @param {object[]} points
 * @param {number[]} spineIndices
 * @param {{ maxEdge?: number, maxPathLength?: number }} [opts]
 * @returns {number[][]}
 */
function connectAnchors(friction, cols, rows, points, spineIndices, opts) {
    const o = opts || {};
    const maxEdge = o.maxEdge != null ? Number(o.maxEdge) : DEFAULT_MAX_EDGE;
    const maxPath =
        o.maxPathLength != null ? o.maxPathLength | 0 : defaultMaxPathLength();
    const edges = createEdgeSet();

    const spine = Array.isArray(spineIndices) ? spineIndices : [];
    for (let i = 0; i + 1 < spine.length; i++) {
        const a = spine[i];
        const b = spine[i + 1];
        if (a < 0 || b < 0 || a === b) continue;
        const pa = points[a];
        const pb = points[b];
        if (String(pa.z) !== String(pb.z)) continue;
        const link = canLinkAnchors(friction, cols, rows, pa, pb, {
            maxPathLength: maxPath,
            maxEdge: Math.max(maxEdge, maxPath),
            force: true
        });
        if (link.ok) edges.add(a, b);
    }

    for (let i = 0; i < points.length; i++) {
        for (let j = i + 1; j < points.length; j++) {
            if (edges.has(i, j)) continue;
            const a = points[i];
            const b = points[j];
            if (String(a.z) !== String(b.z)) continue;
            const link = canLinkAnchors(friction, cols, rows, a, b, {
                maxPathLength: maxPath,
                maxEdge
            });
            if (link.ok) edges.add(i, j);
        }
    }

    stitchComponents(friction, cols, rows, points, edges, {
        maxPathLength: maxPath,
        maxEdge: Math.max(maxEdge, maxPath)
    });

    return edges.list;
}

/**
 * Bake a navmesh for one friction floor.
 *
 * @param {{
 *   friction: Uint8Array,
 *   cols: number,
 *   rows: number,
 *   z?: number|string,
 *   sockets?: object,
 *   waypoints?: object[],
 *   stairs?: object[],
 *   includeSpawns?: boolean,
 *   includeMarkers?: boolean,
 *   maxSpawnAnchors?: number,
 *   sampleStride?: number,
 *   maxEdge?: number,
 *   maxPathLength?: number,
 *   id?: string,
 *   label?: string
 * }} input
 * @returns {{
 *   id: string,
 *   label?: string,
 *   floor?: string|number,
 *   points: object[],
 *   connections: number[][],
 *   meta: object
 * }}
 */
function bakeFloorNavmesh(input) {
    const src = input || {};
    const friction = src.friction;
    const cols = src.cols | 0;
    const rows = src.rows | 0;
    const z = src.z != null ? src.z : 0;

    if (!friction || cols < 1 || rows < 1) {
        return {
            id: src.id != null ? String(src.id) : 'baked_floor',
            floor: z,
            points: [],
            connections: [],
            meta: { reason: 'empty', anchorCount: 0, edgeCount: 0 }
        };
    }

    const set = createPointSet();
    const spine = collectFloorAnchors(
        {
            friction,
            cols,
            rows,
            z,
            sockets: src.sockets,
            waypoints: src.waypoints,
            stairs: src.stairs,
            includeSpawns: src.includeSpawns,
            includeMarkers: src.includeMarkers,
            maxSpawnAnchors: src.maxSpawnAnchors,
            sampleStride: src.sampleStride
        },
        set
    );

    const connections = connectAnchors(
        friction,
        cols,
        rows,
        set.points,
        spine,
        {
            maxEdge: src.maxEdge,
            maxPathLength: src.maxPathLength
        }
    );

    const points = cleanPoints(set.points);

    return {
        id: src.id != null ? String(src.id) : 'baked_floor',
        label: src.label != null ? String(src.label) : undefined,
        floor: z,
        points,
        connections,
        meta: {
            reason: 'ok',
            anchorCount: points.length,
            edgeCount: connections.length,
            spineCount: spine.length,
            maxEdge: src.maxEdge != null ? src.maxEdge : DEFAULT_MAX_EDGE,
            maxPathLength:
                src.maxPathLength != null
                    ? src.maxPathLength
                    : defaultMaxPathLength()
        }
    };
}

/**
 * Bake a navmesh for a single logic piece (local coordinates).
 *
 * @param {object} piece normalized piece (friction Uint8Array + sockets)
 * @param {{
 *   z?: number|string,
 *   includeSpawns?: boolean,
 *   maxEdge?: number,
 *   maxPathLength?: number,
 *   id?: string
 * }} [opts]
 * @returns {ReturnType<typeof bakeFloorNavmesh>}
 */
function bakePieceNavmesh(piece, opts) {
    const o = opts || {};
    if (!piece || !(piece.friction instanceof Uint8Array)) {
        return {
            id: o.id || (piece && piece.id) || 'piece',
            points: [],
            connections: [],
            meta: { reason: 'invalid_piece', anchorCount: 0, edgeCount: 0 }
        };
    }
    const w = piece.size && piece.size.w ? piece.size.w | 0 : 0;
    const h = piece.size && piece.size.h ? piece.size.h | 0 : 0;
    return bakeFloorNavmesh({
        friction: piece.friction,
        cols: w,
        rows: h,
        z: o.z != null ? o.z : 0,
        sockets: piece.sockets || {},
        includeSpawns: o.includeSpawns !== false,
        includeMarkers: false,
        maxEdge: o.maxEdge != null ? o.maxEdge : Math.max(w, h, DEFAULT_MAX_EDGE),
        maxPathLength: o.maxPathLength,
        id: o.id != null ? String(o.id) : piece.id || 'piece',
        label: piece.id ? `piece:${piece.id}` : undefined
    });
}

/**
 * Offset a piece-local bake into world coordinates.
 *
 * @param {object} mesh bakeFloorNavmesh result
 * @param {number} ox
 * @param {number} oy
 * @param {*|number} z
 * @returns {{ points: object[], connections: number[][] }}
 */
function offsetNavmesh(mesh, ox, oy, z) {
    const pts = (mesh && mesh.points) || [];
    const conns = (mesh && mesh.connections) || [];
    const points = pts.map((p) => ({
        x: p.x + (ox | 0),
        y: p.y + (oy | 0),
        z: z != null ? z : p.z,
        properties: p.properties ? { ...p.properties } : undefined
    }));
    const connections = conns.map((e) => [e[0], e[1]]);
    return { points, connections };
}

/**
 * Merge multiple navmesh data objects (dedupe points, remap edges).
 *
 * @param {object[]} meshes
 * @param {{ id?: string, label?: string, floor?: * }} [opts]
 * @returns {{ id: string, label?: string, floor?: *, points: object[], connections: number[][], meta: object }}
 */
function mergeNavmeshes(meshes, opts) {
    const o = opts || {};
    const set = createPointSet();
    const edges = createEdgeSet();
    const list = Array.isArray(meshes) ? meshes : [];

    for (let m = 0; m < list.length; m++) {
        const mesh = list[m];
        if (!mesh || !Array.isArray(mesh.points)) continue;
        /** @type {number[]} */
        const remap = [];
        for (let i = 0; i < mesh.points.length; i++) {
            remap[i] = set.add(mesh.points[i], mesh.points[i].properties);
        }
        const conns = Array.isArray(mesh.connections) ? mesh.connections : [];
        for (let c = 0; c < conns.length; c++) {
            const e = conns[c];
            if (!e || e.length < 2) continue;
            const a = remap[e[0] | 0];
            const b = remap[e[1] | 0];
            if (a >= 0 && b >= 0) edges.add(a, b);
        }
    }

    const points = cleanPoints(set.points);

    return {
        id: o.id != null ? String(o.id) : 'merged_navmesh',
        label: o.label,
        floor: o.floor,
        points,
        connections: edges.list,
        meta: {
            reason: 'ok',
            meshCount: list.length,
            anchorCount: points.length,
            edgeCount: edges.list.length
        }
    };
}

/**
 * Bake per-piece graphs, offset into stitched world space, merge with floor bake.
 *
 * @param {{
 *   friction: Uint8Array,
 *   cols: number,
 *   rows: number,
 *   z?: *,
 *   placements?: object[],
 *   piecesById?: Record<string, object>,
 *   sockets?: object,
 *   waypoints?: object[],
 *   includeSpawns?: boolean,
 *   maxEdge?: number,
 *   maxPathLength?: number,
 *   id?: string,
 *   label?: string,
 *   sampleStride?: number
 * }} input
 * @returns {ReturnType<typeof bakeFloorNavmesh>}
 */
function bakeFromPlacements(input) {
    const src = input || {};
    const floorMesh = bakeFloorNavmesh({
        friction: src.friction,
        cols: src.cols,
        rows: src.rows,
        z: src.z,
        sockets: src.sockets,
        waypoints: src.waypoints,
        includeSpawns: src.includeSpawns,
        sampleStride: src.sampleStride,
        maxEdge: src.maxEdge,
        maxPathLength: src.maxPathLength,
        id: src.id || 'baked_floor',
        label: src.label
    });

    const placements = Array.isArray(src.placements) ? src.placements : [];
    const byId = src.piecesById || Object.create(null);
    if (!placements.length || !Object.keys(byId).length) {
        return floorMesh;
    }

    /** @type {object[]} */
    const pieceMeshes = [floorMesh];
    for (let i = 0; i < placements.length; i++) {
        const pl = placements[i];
        if (!pl) continue;
        const pid = pl.pieceId != null ? String(pl.pieceId) : null;
        const piece = pid && byId[pid] ? byId[pid] : pl.piece || null;
        if (!piece || !(piece.friction instanceof Uint8Array)) continue;
        const local = bakePieceNavmesh(piece, {
            z: pl.z != null ? pl.z : src.z,
            includeSpawns: src.includeSpawns,
            maxEdge: src.maxEdge,
            maxPathLength: src.maxPathLength
        });
        if (!local.points.length) continue;
        const world = offsetNavmesh(
            local,
            pl.x | 0,
            pl.y | 0,
            pl.z != null ? pl.z : src.z
        );
        pieceMeshes.push({
            points: world.points,
            connections: world.connections
        });
    }

    const merged = mergeNavmeshes(pieceMeshes, {
        id: src.id || 'baked_floor',
        label: src.label,
        floor: src.z
    });

    const edges = createEdgeSet();
    const maxEdge =
        src.maxEdge != null ? Number(src.maxEdge) : DEFAULT_MAX_EDGE;
    const maxPath =
        src.maxPathLength != null
            ? src.maxPathLength | 0
            : defaultMaxPathLength();

    for (let c = 0; c < merged.connections.length; c++) {
        const e = merged.connections[c];
        const a = merged.points[e[0]];
        const b = merged.points[e[1]];
        if (!a || !b) continue;
        if (String(a.z) !== String(b.z)) continue;
        const link = canLinkAnchors(
            src.friction,
            src.cols | 0,
            src.rows | 0,
            a,
            b,
            {
                maxPathLength: maxPath,
                maxEdge: Math.max(maxEdge, maxPath),
                force: true
            }
        );
        if (link.ok) edges.add(e[0], e[1]);
    }

    const densified = connectAnchors(
        src.friction,
        src.cols | 0,
        src.rows | 0,
        merged.points,
        [],
        { maxEdge, maxPathLength: maxPath }
    );
    for (let i = 0; i < densified.length; i++) {
        edges.add(densified[i][0], densified[i][1]);
    }

    return {
        id: merged.id,
        label: merged.label,
        floor: merged.floor,
        points: merged.points,
        connections: edges.list,
        meta: {
            reason: 'ok',
            anchorCount: merged.points.length,
            edgeCount: edges.list.length,
            fromPlacements: placements.length,
            pieceMeshes: pieceMeshes.length - 1
        }
    };
}

/**
 * Multi-floor bake: per-floor graphs + free stair-link edges.
 *
 * @param {{
 *   floors: {
 *     z: *,
 *     friction: Uint8Array,
 *     cols: number,
 *     rows: number,
 *     sockets?: object,
 *     waypoints?: object[],
 *     stairs?: object[]
 *   }[],
 *   stairLinks?: { from: object, to: object }[],
 *   includeSpawns?: boolean,
 *   maxEdge?: number,
 *   maxPathLength?: number,
 *   id?: string,
 *   label?: string
 * }} input
 * @returns {{
 *   id: string,
 *   label?: string,
 *   points: object[],
 *   connections: number[][],
 *   meta: object
 * }}
 */
function bakeMultiFloorNavmesh(input) {
    const src = input || {};
    const floors = Array.isArray(src.floors) ? src.floors : [];
    /** @type {object[]} */
    const meshes = [];

    for (let i = 0; i < floors.length; i++) {
        const f = floors[i];
        if (!f || !f.friction) continue;
        const mesh = bakeFloorNavmesh({
            friction: f.friction,
            cols: f.cols,
            rows: f.rows,
            z: f.z != null ? f.z : i,
            sockets: f.sockets,
            waypoints: f.waypoints,
            stairs: f.stairs,
            includeSpawns: src.includeSpawns,
            maxEdge: src.maxEdge,
            maxPathLength: src.maxPathLength,
            id: `floor_${f.z != null ? f.z : i}`
        });
        meshes.push(mesh);
    }

    const merged = mergeNavmeshes(meshes, {
        id: src.id != null ? String(src.id) : 'baked_multifloor',
        label:
            src.label != null ? String(src.label) : 'generated multi-floor'
    });

    const set = createPointSet();
    for (let i = 0; i < merged.points.length; i++) {
        set.add(merged.points[i], merged.points[i].properties);
    }
    const edges = createEdgeSet();
    for (let c = 0; c < merged.connections.length; c++) {
        const e = merged.connections[c];
        edges.add(e[0], e[1]);
    }

    const links = Array.isArray(src.stairLinks) ? src.stairLinks : [];
    for (let i = 0; i < links.length; i++) {
        const L = links[i];
        if (!L || !L.from || !L.to) continue;
        const a = set.add(L.from, { stair: 'pad' });
        const b = set.add(L.to, { stair: 'dest' });
        if (a >= 0 && b >= 0) edges.add(a, b);
    }

    const points = cleanPoints(set.points);

    return {
        id: merged.id,
        label: merged.label,
        points,
        connections: edges.list,
        meta: {
            reason: 'ok',
            floorCount: floors.length,
            stairLinks: links.length,
            anchorCount: points.length,
            edgeCount: edges.list.length
        }
    };
}

/**
 * Convenience: bake from a stitched layout result (+ optional waypoints spine).
 *
 * @param {{
 *   cols: number,
 *   rows: number,
 *   friction: Uint8Array,
 *   sockets?: object,
 *   placements?: object[]
 * }} stitched
 * @param {{
 *   z?: *,
 *   waypoints?: object[],
 *   piecesById?: Record<string, object>,
 *   includeSpawns?: boolean,
 *   maxEdge?: number,
 *   maxPathLength?: number,
 *   id?: string,
 *   usePlacements?: boolean
 * }} [opts]
 * @returns {ReturnType<typeof bakeFloorNavmesh>}
 */
function bakeStitchedNavmesh(stitched, opts) {
    const o = opts || {};
    if (!stitched || !stitched.friction) {
        return {
            id: o.id || 'baked_floor',
            points: [],
            connections: [],
            meta: { reason: 'empty', anchorCount: 0, edgeCount: 0 }
        };
    }
    if (o.usePlacements && o.piecesById && stitched.placements) {
        return bakeFromPlacements({
            friction: stitched.friction,
            cols: stitched.cols,
            rows: stitched.rows,
            z: o.z != null ? o.z : 0,
            placements: stitched.placements,
            piecesById: o.piecesById,
            sockets: stitched.sockets,
            waypoints: o.waypoints,
            includeSpawns: o.includeSpawns,
            maxEdge: o.maxEdge,
            maxPathLength: o.maxPathLength,
            id: o.id
        });
    }
    return bakeFloorNavmesh({
        friction: stitched.friction,
        cols: stitched.cols,
        rows: stitched.rows,
        z: o.z != null ? o.z : 0,
        sockets: stitched.sockets,
        waypoints: o.waypoints,
        includeSpawns: o.includeSpawns,
        maxEdge: o.maxEdge,
        maxPathLength: o.maxPathLength,
        id: o.id || 'baked_floor'
    });
}

/**
 * Strip meta for runtime Navmesh / hunt.navmeshData payloads.
 * @param {object} mesh
 * @returns {{ id?: string, label?: string, floor?: *, points: object[], connections: number[][] }}
 */
function toNavmeshData(mesh) {
    if (!mesh) {
        return { points: [], connections: [] };
    }
    const out = {
        points: Array.isArray(mesh.points) ? mesh.points : [],
        connections: Array.isArray(mesh.connections) ? mesh.connections : []
    };
    if (mesh.id != null) out.id = mesh.id;
    if (mesh.label != null) out.label = mesh.label;
    if (mesh.floor !== undefined && mesh.floor !== null) out.floor = mesh.floor;
    return out;
}

module.exports = {
    DEFAULT_MAX_EDGE,
    DEFAULT_MAX_SPAWN_ANCHORS,
    defaultMaxPathLength,
    pointKey,
    euclid,
    canLinkAnchors,
    sampleWalkableAnchors,
    bakeFloorNavmesh,
    bakePieceNavmesh,
    bakeFromPlacements,
    bakeMultiFloorNavmesh,
    bakeStitchedNavmesh,
    offsetNavmesh,
    mergeNavmeshes,
    toNavmeshData,
    createPointSet,
    createEdgeSet,
    connectAnchors
};
