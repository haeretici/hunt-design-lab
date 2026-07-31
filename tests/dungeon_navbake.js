#!/usr/bin/env node
/**
 * Stage 11.12+ — NavMesh bake per piece / floor.
 * - piece bake from sockets + walkability edges
 * - floor bake denser than consecutive waypoint spine
 * - multi-floor bake + stair free-hops
 * - procedural / fixed resolve attach navmeshData
 * Quiet on success; VERBOSE=1 for detail.
 */

'use strict';

const assert = require('assert');
const {
    normalizePiece,
    normalizePiecePack,
    FRICTION_BLOCKED
} = require('../kernel/core/lib/dungeon/pieces.js');
const { stitch, attachOrigin } = require('../kernel/core/lib/dungeon/stitch.js');
const {
    bakePieceNavmesh,
    bakeFloorNavmesh,
    bakeMultiFloorNavmesh,
    bakeStitchedNavmesh,
    toNavmeshData,
    canLinkAnchors,
    DEFAULT_MAX_EDGE
} = require('../kernel/core/lib/dungeon/navbake.js');
const { Navmesh } = require('../kernel/core/lib/navmesh.js');
const { TileMap } = require('../kernel/core/entities/tilemap.js');
const {
    loadPiecePack,
    loadDungeonProfile,
    expandHuntDefinition
} = require('../kernel/core/lib/presets.js');
const { setActiveMode } = require('../kernel/core/lib/modes.js');
const { generateMultiFloorLayout } = require('../kernel/core/lib/dungeon/layout/multifloor.js');

const VERBOSE = !!process.env.VERBOSE;

function log(...args) {
    if (VERBOSE) console.log(...args);
}

function makeCorridorPiece() {
    return normalizePiece({
        id: 'unit_corr_ns',
        size: { w: 5, h: 5 },
        exits: { N: true, S: true, E: false, W: false },
        friction: ['##.##', '#...#', '#...#', '#...#', '##.##'],
        sockets: {
            spawns: [{ x: 2, y: 2 }],
            waypoints: [
                { x: 2, y: 0 },
                { x: 2, y: 4 }
            ],
            markers: [{ id: 'A', x: 1, y: 2 }]
        },
        tags: ['corridor', 'ns']
    });
}

function testPieceBake() {
    const piece = makeCorridorPiece();
    const mesh = bakePieceNavmesh(piece);
    assert.ok(mesh.points.length >= 2, 'piece has waypoint anchors');
    assert.ok(mesh.connections.length >= 1, 'piece has at least one edge');
    // Both waypoints should connect through the corridor
    const meshObj = new Navmesh(toNavmeshData(mesh));
    const a = meshObj.getClosestPoints(2, 0, 0, 1);
    const b = meshObj.getClosestPoints(2, 4, 0, 1);
    assert.ok(a.length && b.length);
    const path = meshObj.getPath(a[0][0], b[0][0]);
    assert.ok(path && path.length >= 2, 'coarse path along piece');
    log('piece bake ok', mesh.meta);
}

function testFloorBakeRicherThanSpine() {
    const piece = makeCorridorPiece();
    // Stack three corridors south
    const p0 = { piece, x: 0, y: 0 };
    const o1 = attachOrigin(piece, 0, 0, 'S', piece);
    const p1 = { piece, x: o1.x, y: o1.y };
    const o2 = attachOrigin(piece, o1.x, o1.y, 'S', piece);
    const p2 = { piece, x: o2.x, y: o2.y };
    const stitched = stitch([p0, p1, p2], { z: 0 });
    assert.strictEqual(stitched.meta.reason, 'ok');

    const spineOnly = bakeFloorNavmesh({
        friction: stitched.friction,
        cols: stitched.cols,
        rows: stitched.rows,
        z: 0,
        sockets: {
            waypoints: stitched.sockets.waypoints,
            spawns: [],
            stairs: []
        },
        includeSpawns: false,
        id: 'spine'
    });

    const rich = bakeStitchedNavmesh(stitched, {
        z: 0,
        waypoints: stitched.sockets.waypoints,
        includeSpawns: true,
        id: 'rich'
    });

    assert.ok(rich.points.length >= spineOnly.points.length, 'spawns add anchors');
    assert.ok(rich.connections.length >= 1, 'rich graph has edges');
    // Every connection must be walkable within PATH_MAX_DISTANCE
    for (let i = 0; i < rich.connections.length; i++) {
        const [ai, bi] = rich.connections[i];
        const a = rich.points[ai];
        const b = rich.points[bi];
        const link = canLinkAnchors(
            stitched.friction,
            stitched.cols,
            stitched.rows,
            a,
            b,
            { maxEdge: DEFAULT_MAX_EDGE * 4, force: true }
        );
        assert.ok(link.ok, `edge ${ai}-${bi} pathable`);
    }

    // Coarse graph routes entrance → exit
    const nav = new Navmesh(toNavmeshData(rich));
    const start = stitched.sockets.waypoints[0];
    const end = stitched.sockets.waypoints[stitched.sockets.waypoints.length - 1];
    const ca = nav.getClosestPoints(start.x, start.y, 0, 1);
    const cb = nav.getClosestPoints(end.x, end.y, 0, 1);
    assert.ok(ca.length && cb.length);
    const coarse = nav.getPath(ca[0][0], cb[0][0]);
    assert.ok(coarse && coarse.length >= 2, 'coarse path on baked graph');

    // Runtime long path: default local budget may take local mode on short maps;
    // with a tight maxDistance under Chebyshev, segmented expand must succeed
    // because bake edges stay within DEFAULT_MAX_EDGE.
    const map = new TileMap();
    map.loadFloorFromFriction(0, stitched.cols, stitched.rows, stitched.friction);
    map.setNavmesh(nav);
    const cheb = Math.max(
        Math.abs(end.x - start.x),
        Math.abs(end.y - start.y)
    );
    const tight = Math.max(4, Math.min(DEFAULT_MAX_EDGE, cheb - 1));
    const long = map.findLongPath(
        { x: start.x, y: start.y, z: 0 },
        { x: end.x, y: end.y, z: 0 },
        {
            maxDistance: tight,
            maxIterations: 256,
            useNavmeshBeyondCap: true
        }
    );
    assert.ok(
        long.path && long.path.length > 1,
        `long path via baked navmesh (mode=${long.mode} reason=${long.reason || ''} tight=${tight})`
    );
    assert.strictEqual(long.mode, 'segmented', 'tight cap forces segmented mode');
    log('floor bake ok', {
        spinePts: spineOnly.points.length,
        richPts: rich.points.length,
        richEdges: rich.connections.length,
        mode: long.mode,
        tight
    });
}

function testMultiFloorBake() {
    // Two tiny floors linked by a stair
    const friction = new Uint8Array([
        255, 100, 255,
        255, 100, 255,
        255, 100, 255
    ]);
    const floors = [
        {
            z: 0,
            friction,
            cols: 3,
            rows: 3,
            waypoints: [
                { x: 1, y: 0, z: 0 },
                { x: 1, y: 2, z: 0 }
            ],
            sockets: {
                waypoints: [
                    { x: 1, y: 0, z: 0 },
                    { x: 1, y: 2, z: 0 }
                ],
                spawns: [{ x: 1, y: 1, z: 0 }],
                stairs: [{ x: 1, y: 2, z: 0, dir: 'down' }]
            }
        },
        {
            z: 1,
            friction,
            cols: 3,
            rows: 3,
            waypoints: [
                { x: 1, y: 0, z: 1 },
                { x: 1, y: 2, z: 1 }
            ],
            sockets: {
                waypoints: [
                    { x: 1, y: 0, z: 1 },
                    { x: 1, y: 2, z: 1 }
                ],
                spawns: [{ x: 1, y: 1, z: 1 }],
                stairs: [{ x: 1, y: 0, z: 1, dir: 'up' }]
            }
        }
    ];
    const stairLinks = [
        {
            from: { x: 1, y: 2, z: 0 },
            to: { x: 1, y: 0, z: 1 }
        }
    ];
    const mesh = bakeMultiFloorNavmesh({
        floors,
        stairLinks,
        includeSpawns: true,
        id: 'mf_unit'
    });
    assert.ok(mesh.points.length >= 4, 'multi-floor anchors');
    assert.ok(mesh.connections.length >= 2, 'same-floor + stair edges');

    const nav = new Navmesh(toNavmeshData(mesh));
    const a = nav.getClosestPoints(1, 0, 0, 1);
    const b = nav.getClosestPoints(1, 2, 1, 1);
    assert.ok(a.length && b.length);
    const path = nav.getPath(a[0][0], b[0][0]);
    assert.ok(path && path.length >= 2, 'coarse multi-floor path via stair edge');
    log('multi-floor bake ok', mesh.meta);
}

function testProceduralAttachsNavmesh() {
    setActiveMode('standard');
    const hunt = expandHuntDefinition({
        id: 'navbake_proc_fixture',
        layout: { type: 'procedural', profileId: 'small_crawl' },
        seed: 42
    });
    assert.ok(hunt.floorFriction || hunt.floorLayers, 'layout expanded');
    assert.ok(
        hunt.navmeshData &&
            Array.isArray(hunt.navmeshData.points) &&
            hunt.navmeshData.points.length >= 2,
        'procedural hunt has navmeshData'
    );
    assert.ok(
        Array.isArray(hunt.navmeshData.connections) &&
            hunt.navmeshData.connections.length >= 1,
        'navmeshData has edges'
    );
    log('procedural navmeshData', {
        pts: hunt.navmeshData.points.length,
        edges: hunt.navmeshData.connections.length,
        meta: hunt.layoutMeta && hunt.layoutMeta.navmesh
    });
}

function testMultifloorGeneratorBake() {
    setActiveMode('standard');
    const packRaw = loadPiecePack('cave_v1');
    const pack = normalizePiecePack(packRaw);
    assert.ok(pack);

    const profile = loadDungeonProfile('small_crawl');
    const gen = generateMultiFloorLayout({
        floors: [
            { z: 0, profileId: 'small_crawl', profile },
            { z: 1, profileId: 'small_crawl', profile }
        ],
        pack,
        seed: 7,
        loadDungeonProfile: () => profile,
        loadPiecePack: () => packRaw,
        normalizePiecePack
    });
    assert.ok(gen.ok !== false && gen.navmesh, 'multifloor gen has navmesh');
    assert.ok(gen.navmesh.points.length >= 2);
    assert.ok(gen.navmesh.connections.length >= 1);
    // Should be richer than spine-only when spawns exist
    if (gen.populationSlots && gen.populationSlots.length) {
        assert.ok(
            gen.navmesh.points.length > 2 || gen.navmesh.meta,
            'bake metadata or extra anchors present'
        );
    }
    log('multifloor generator bake', {
        pts: gen.navmesh.points.length,
        edges: gen.navmesh.connections.length,
        meta: gen.navmesh.meta
    });
}

function testBlockedNotLinked() {
    // Two walkable cells separated by a wall — no edge
    const friction = new Uint8Array([
        100, 255, 100
    ]);
    const mesh = bakeFloorNavmesh({
        friction,
        cols: 3,
        rows: 1,
        z: 0,
        sockets: {
            waypoints: [
                { x: 0, y: 0 },
                { x: 2, y: 0 }
            ],
            spawns: []
        },
        includeSpawns: false
    });
    assert.strictEqual(mesh.points.length, 2);
    assert.strictEqual(
        mesh.connections.length,
        0,
        'wall between anchors → no edge'
    );
    log('blocked link rejected');
}

function main() {
    testPieceBake();
    testFloorBakeRicherThanSpine();
    testMultiFloorBake();
    testBlockedNotLinked();
    testProceduralAttachsNavmesh();
    testMultifloorGeneratorBake();
    if (VERBOSE) console.log('all dungeon_navbake tests passed');
}

main();
