#!/usr/bin/env node
/**
 * Stage 10 exit criteria: coarse navmesh graph, getClosestPoints, connectFloors,
 * long routes via successive local A* without exploding the iteration budget.
 * Quiet on success; VERBOSE=1 for detail.
 */

'use strict';

const assert = require('assert');
const path = require('path');
const { Settings, mapPathPng, navmeshPath, PATHS } = require('../kernel/settings.js');
const { TileMap } = require('../kernel/core/entities/tilemap.js');
const { findPath } = require('../kernel/core/lib/pathfinder.js');
const {
    Navmesh,
    findLongPath,
    expandAnchorsWithLocalAStar,
    loadNavmesh,
    buildNavmeshFromPoints,
    chebyshev
} = require('../kernel/core/lib/navmesh.js');

const VERBOSE = !!process.env.VERBOSE;

function log(...args) {
    if (VERBOSE) console.log(...args);
}

/** Build a tiny RGBA buffer (row-major) from [r,g,b] pixels. */
function rgbaFromPixels(cols, rows, pixels) {
    const out = new Uint8Array(cols * rows * 4);
    for (let i = 0; i < cols * rows; i++) {
        const p = pixels[i];
        const o = i * 4;
        out[o] = p[0];
        out[o + 1] = p[1];
        out[o + 2] = p[2];
        out[o + 3] = 255;
    }
    return out;
}

function openFloor(cols, rows, gray, z) {
    const g = gray !== undefined ? gray : 100;
    const floorZ = z !== undefined ? z : 0;
    const pixels = [];
    for (let i = 0; i < cols * rows; i++) pixels.push([g, g, g]);
    const map = new TileMap();
    map.loadFloorFromRgba(floorZ, cols, rows, rgbaFromPixels(cols, rows, pixels));
    return map;
}

function testGetClosestPoints() {
    const mesh = new Navmesh({
        points: [
            { x: 10, y: 10, z: 7 },
            { x: 20, y: 10, z: 7 },
            { x: 15, y: 50, z: 7 },
            { x: 10, y: 10, z: 6 }
        ],
        connections: []
    });
    const closest = mesh.getClosestPoints(12, 10, 7, 2);
    assert.strictEqual(closest.length, 2);
    assert.strictEqual(closest[0][0], 0, 'nearest is index 0');
    assert.strictEqual(closest[1][0], 1, 'second is index 1');
    assert.ok(closest[0][2] < closest[1][2]);
    const only6 = mesh.getClosestPoints(10, 10, 6, 5);
    assert.strictEqual(only6.length, 1);
    assert.strictEqual(only6[0][0], 3);
    log('getClosestPoints ok');
}

function testCoarseAStar() {
    // Linear graph 0—1—2—3
    const mesh = new Navmesh({
        points: [
            { x: 0, y: 0, z: 0 },
            { x: 10, y: 0, z: 0 },
            { x: 20, y: 0, z: 0 },
            { x: 30, y: 0, z: 0 }
        ],
        connections: [
            [0, 1],
            [1, 2],
            [2, 3]
        ]
    });
    const path = mesh.getPath(0, 3);
    assert.deepStrictEqual(path, [0, 1, 2, 3]);
    assert.strictEqual(mesh.getPath(2, 2)[0], 2);
    assert.strictEqual(mesh.getPath(0, 99), null);
    // Disconnected
    const island = new Navmesh({
        points: [
            { x: 0, y: 0, z: 0 },
            { x: 1, y: 0, z: 0 }
        ],
        connections: []
    });
    assert.strictEqual(island.getPath(0, 1), null);
    log('coarse A* ok');
}

function testConnectFloors() {
    // Graph links floor 7 node to floor 6 node (stair edge)
    const mesh = new Navmesh({
        points: [
            { x: 100, y: 100, z: 7, properties: { stair: 'down' } },
            { x: 100, y: 102, z: 6, properties: { stair: 'up' } },
            { x: 110, y: 102, z: 6 }
        ],
        connections: [
            [0, 1],
            [1, 2]
        ]
    });
    const waypoints = [
        { x: 98, y: 100, z: 7, properties: {} },
        { x: 112, y: 102, z: 6, properties: {} }
    ];
    const connected = mesh.connectFloors(waypoints);
    assert.ok(connected.length >= 3, 'inserts intermediate nav nodes');
    assert.strictEqual(connected[0].x, 98);
    assert.strictEqual(zOf(connected[0]), '7');
    // Should include floor-6 intermediate near stair
    const hasFloor6 = connected.some((p) => zOf(p) === '6' && p.x === 100);
    assert.ok(hasFloor6, 'includes stair node on floor 6');
    assert.strictEqual(zOf(connected[connected.length - 1]), '6');
    log('connectFloors ok', connected);
}

function zOf(p) {
    return String(p.z);
}

function testSegmentedLongPathBudget() {
    // 60×5 open corridor. Local maxDistance 12 cannot reach end in one search.
    const cols = 60;
    const rows = 5;
    const map = openFloor(cols, rows, 100, 0);
    const start = { x: 0, y: 2, z: 0 };
    const end = { x: 59, y: 2, z: 0 };

    const localFail = findPath(map, start, end, {
        maxDistance: 12,
        maxIterations: 512
    });
    assert.strictEqual(localFail, null, 'direct local A* must fail under tight cap');

    // Nav anchors every 10 tiles
    const points = [];
    for (let x = 0; x <= 60; x += 10) {
        points.push({ x: Math.min(x, 59), y: 2, z: 0 });
    }
    const mesh = buildNavmeshFromPoints(points, { maxEdge: 12, id: 'corridor60' });
    assert.ok(mesh.adj[0].length > 0, 'auto-edges exist');

    const result = findLongPath(map, start, end, {
        navmesh: mesh,
        maxDistance: 12,
        maxIterations: 512
    });
    assert.strictEqual(result.mode, 'segmented', 'uses segmented mode');
    assert.ok(result.path, 'path found');
    assert.strictEqual(result.path[0].x, 0);
    assert.strictEqual(result.path[result.path.length - 1].x, 59);
    // Each segment expansion stayed within budget (path exists ⇒ no explode)
    assert.ok(result.anchors && result.anchors.length >= 3);
    log('segmented long path ok', {
        len: result.path.length,
        anchors: result.anchors.length
    });
}

function testPlayerRequestCap() {
    const map = openFloor(40, 5, 100, 0);
    const start = { x: 0, y: 2, z: 0 };
    const end = { x: 39, y: 2, z: 0 };
    // Anchors every 12 tiles so each local hop fits maxDistance 14
    const points = [];
    for (let x = 0; x <= 39; x += 12) points.push({ x, y: 2, z: 0 });
    if (points[points.length - 1].x !== 39) points.push({ x: 39, y: 2, z: 0 });
    const mesh = buildNavmeshFromPoints(points, { maxEdge: 14 });

    const rejected = findLongPath(map, start, end, {
        navmesh: mesh,
        maxDistance: 14,
        maxRequestDistance: 20,
        enforceRequestCap: true,
        useNavmeshBeyondCap: false
    });
    assert.strictEqual(rejected.mode, 'rejected');
    assert.strictEqual(rejected.reason, 'request_too_far');

    const allowed = findLongPath(map, start, end, {
        navmesh: mesh,
        maxDistance: 14,
        maxRequestDistance: 20,
        enforceRequestCap: true,
        useNavmeshBeyondCap: true
    });
    assert.ok(allowed.path, 'navmesh can still serve long routes when allowed');
    assert.ok(allowed.mode === 'segmented' || allowed.mode === 'local');
    log('player request cap ok', { mode: allowed.mode, len: allowed.path && allowed.path.length });
}

function testLocalShortPathStillPreferred() {
    const map = openFloor(20, 5, 100, 0);
    const mesh = buildNavmeshFromPoints(
        [
            { x: 0, y: 2, z: 0 },
            { x: 10, y: 2, z: 0 },
            { x: 19, y: 2, z: 0 }
        ],
        { maxEdge: 12 }
    );
    const result = findLongPath(
        map,
        { x: 1, y: 2, z: 0 },
        { x: 5, y: 2, z: 0 },
        { navmesh: mesh, maxDistance: 100 }
    );
    assert.strictEqual(result.mode, 'local');
    assert.ok(result.path && result.path.length >= 2);
    log('local preferred ok');
}

function testTileMapFindLongPathAndFollow() {
    const map = openFloor(50, 5, 100, 0);
    const points = [];
    for (let x = 0; x <= 49; x += 12) points.push({ x, y: 2, z: 0 });
    if (points[points.length - 1].x !== 49) points.push({ x: 49, y: 2, z: 0 });
    const mesh = buildNavmeshFromPoints(points, { maxEdge: 14 });
    map.setNavmesh(mesh);

    const r = map.findLongPath(
        { x: 0, y: 2, z: 0 },
        { x: 49, y: 2, z: 0 },
        { maxDistance: 14, maxIterations: 512 }
    );
    assert.ok(r.path, r.reason || 'path required');
    assert.strictEqual(r.mode, 'segmented');

    const entity = {
        id: 1,
        tile: { x: 0, y: 2, z: 0 },
        path: [],
        speed: 200,
        moveDelay: 0
    };
    map.tryOccupy(0, 2, 0, 1);
    let steps = 0;
    const guard = 500;
    while (
        (entity.tile.x !== 49 || entity.tile.y !== 2) &&
        steps < guard
    ) {
        entity.moveDelay = 0;
        const ok = map.followLongPath(
            entity,
            49,
            2,
            0,
            { maxDistance: 14, maxIterations: 512 }
        );
        assert.ok(ok || entity.path.length === 0 || steps > 0, 'progress or path');
        steps++;
    }
    assert.strictEqual(entity.tile.x, 49, 'entity walked full long path');
    assert.ok(steps < guard, 'did not hang');
    log('tilemap followLongPath ok', { steps });
}

function testExpandAnchors() {
    const map = openFloor(20, 5, 100, 0);
    const anchors = [
        { x: 0, y: 2, z: 0 },
        { x: 10, y: 2, z: 0 },
        { x: 19, y: 2, z: 0 }
    ];
    const path = expandAnchorsWithLocalAStar(map, anchors, {
        maxDistance: 12,
        maxIterations: 256
    });
    assert.ok(path);
    assert.strictEqual(path[0].x, 0);
    assert.strictEqual(path[path.length - 1].x, 19);
    log('expandAnchors ok', path.length);
}

function testLoadFloor07Sample() {
    const mesh = loadNavmesh('floor07_corridor');
    assert.strictEqual(mesh.id, 'floor07_corridor');
    assert.ok(mesh.points.length >= 5);
    assert.deepStrictEqual(mesh.getPath(0, 4), [0, 1, 2, 3, 4]);

    // File path helper (assets/legacy/map/navmesh)
    assert.ok(
        navmeshPath('floor07_corridor').includes(path.join('navmesh')) &&
            (navmeshPath('floor07_corridor').includes(path.join('legacy', 'map')) ||
                navmeshPath('floor07_corridor').includes(path.join('maps', 'navmesh'))),
        'navmeshPath under assets/legacy/map/navmesh'
    );
    assert.ok(PATHS.navmesh);

    const closest = mesh.getClosestPoints(265, 96, 7, 1);
    assert.strictEqual(closest.length, 1);
    assert.ok(closest[0][2] < 15);

    // Real map: short corridor segment via mesh + local A*
    return TileMap.prototype.loadFloor
        ? Promise.resolve()
              .then(async () => {
                  const map = new TileMap();
                  await map.loadFloor(7, mapPathPng(7));
                  map.setNavmesh(mesh);
                  const start = { x: 260, y: 96, z: 7 };
                  const end = { x: 304, y: 96, z: 7 };
                  const dist = chebyshev(start, end);
                  assert.ok(dist < Settings.PATH_MAX_DISTANCE);

                  const r = map.findLongPath(start, end, {
                      maxDistance: Settings.PATH_MAX_DISTANCE,
                      maxIterations: Settings.PATH_MAX_ITERATIONS
                  });
                  assert.ok(r.path, 'floor07 corridor path');
                  assert.ok(r.mode === 'local' || r.mode === 'segmented');
                  assert.strictEqual(r.path[0].x, 260);
                  assert.strictEqual(r.path[r.path.length - 1].x, 304);
                  log('floor07 sample ok', { mode: r.mode, len: r.path.length });
              })
        : Promise.resolve();
}

function testChebyshevHelper() {
    assert.strictEqual(chebyshev({ x: 0, y: 0 }, { x: 3, y: 4 }), 4);
    assert.strictEqual(chebyshev({ x: 5, y: 5 }, { x: 5, y: 5 }), 0);
    log('chebyshev ok');
}

async function main() {
    testChebyshevHelper();
    testGetClosestPoints();
    testCoarseAStar();
    testConnectFloors();
    testExpandAnchors();
    testSegmentedLongPathBudget();
    testPlayerRequestCap();
    testLocalShortPathStillPreferred();
    testTileMapFindLongPathAndFollow();
    await testLoadFloor07Sample();

    if (!VERBOSE) {
        // quiet success
    } else {
        console.log('all navmesh tests passed');
    }
    console.log('ok');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
