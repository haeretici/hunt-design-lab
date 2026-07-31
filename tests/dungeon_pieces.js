#!/usr/bin/env node
/**
 * Stage 11.3 — Modular friction pieces + stitch.
 * - normalize piece / pack; cardinal matching
 * - stitch corridor of pieces → walkable friction; A* entrance→exit
 * - load pack from presets/standard/pieces/
 * Quiet on success; VERBOSE=1 for detail.
 */

'use strict';

const assert = require('assert');
const {
    normalizePiece,
    normalizePiecePack,
    canConnect,
    matchingDirections,
    exitSummary,
    filterByTags,
    filterByExits,
    parseFrictionGrid,
    DEFAULT_WALK_FRICTION,
    FRICTION_BLOCKED
} = require('../kernel/core/lib/dungeon/pieces.js');
const {
    stitch,
    frictionToRgba,
    attachOrigin,
    waypointSocketEdges
} = require('../kernel/core/lib/dungeon/stitch.js');
const {
    loadPiecePack,
    listPiecePackIds
} = require('../kernel/core/lib/presets.js');
const { setActiveMode } = require('../kernel/core/lib/modes.js');
const {
    TileMap,
    FRICTION_BLOCKED: TM_BLOCKED
} = require('../kernel/core/entities/tilemap.js');
const { findPath } = require('../kernel/core/lib/pathfinder.js');

const VERBOSE = !!process.env.VERBOSE;

function log(...args) {
    if (VERBOSE) console.log(...args);
}

function testParseFrictionAndNormalize() {
    const raw = {
        id: 'unit_ns',
        biome: 'cave',
        size: { w: 5, h: 5 },
        exits: { N: true, S: true },
        friction: ['##.##', '#...#', '#...#', '#...#', '##.##'],
        sockets: {
            spawns: [{ x: 2, y: 2 }],
            markers: [{ id: 'A', x: 1, y: 2 }],
            waypoints: [{ x: 2, y: 0 }, { x: 2, y: 4 }]
        },
        tags: ['corridor', 'ns']
    };
    const p = normalizePiece(raw);
    assert.ok(p);
    assert.strictEqual(p.id, 'unit_ns');
    assert.strictEqual(p.size.w, 5);
    assert.strictEqual(p.size.h, 5);
    assert.strictEqual(p.exits.N, true);
    assert.strictEqual(p.exits.S, true);
    assert.strictEqual(p.exits.E, false);
    assert.strictEqual(p.friction.length, 25);
    assert.strictEqual(p.friction[0], FRICTION_BLOCKED);
    assert.strictEqual(p.friction[2], DEFAULT_WALK_FRICTION);
    assert.strictEqual(p.sockets.spawns.length, 1);
    assert.strictEqual(p.sockets.waypoints.length, 2);

    // exits as string / array
    assert.deepStrictEqual(normalizePiece({
        id: 'e1',
        size: { w: 1, h: 1 },
        exits: 'NS',
        friction: ['.']
    }).exits, { N: true, S: true, E: false, W: false });

    assert.deepStrictEqual(normalizePiece({
        id: 'e2',
        size: { w: 1, h: 1 },
        exits: ['E', 'W'],
        friction: ['.']
    }).exits, { N: false, S: false, E: true, W: true });

    // number-row friction
    const grid = parseFrictionGrid(
        [
            [255, 100, 255],
            [255, 100, 255]
        ],
        3,
        2
    );
    assert.strictEqual(grid[1], 100);
    assert.strictEqual(grid[4], 100);

    log('parse/normalize ok');
}

function testCardinalMatching() {
    const ns = normalizePiece({
        id: 'ns',
        exits: { N: true, S: true },
        friction: ['##.##', '#...#', '#...#', '#...#', '##.##']
    });
    const ew = normalizePiece({
        id: 'ew',
        exits: { E: true, W: true },
        friction: ['#####', '.....', '.....', '.....', '#####']
    });
    const room = normalizePiece({
        id: 'room',
        exits: { N: true, S: true, E: true, W: true },
        friction: [
            '###.###',
            '#.....#',
            '#.....#',
            '.......',
            '#.....#',
            '#.....#',
            '###.###'
        ]
    });

    assert.ok(canConnect(ns, 'S', ns), 'NS→NS south');
    assert.ok(canConnect(ns, 'N', ns), 'NS→NS north');
    assert.ok(!canConnect(ns, 'E', ns), 'NS no east');
    assert.ok(canConnect(ns, 'S', room), 'corridor to hub');
    assert.ok(canConnect(room, 'E', ew), 'hub to EW');
    assert.ok(!canConnect(ns, 'E', ew), 'NS cannot go east into EW (no E exit)');

    const dirs = matchingDirections(room, ns);
    assert.ok(dirs.indexOf('N') >= 0 && dirs.indexOf('S') >= 0);

    const dead = exitSummary(
        normalizePiece({
            id: 'd',
            exits: { S: true },
            friction: ['#####', '#...#', '#...#', '#...#', '##.##']
        })
    );
    assert.strictEqual(dead.openCount, 1);
    assert.strictEqual(dead.deadEnd, true);

    log('cardinal matching ok');
}

function testStitchCorridorAndPathfind() {
    const ns = normalizePiece({
        id: 'corr_ns_01',
        size: { w: 5, h: 5 },
        exits: { N: true, S: true },
        friction: ['##.##', '#...#', '#...#', '#...#', '##.##'],
        sockets: {
            waypoints: [{ x: 2, y: 0 }, { x: 2, y: 4 }],
            spawns: [{ x: 2, y: 2 }],
            markers: [{ id: 'A', x: 1, y: 2 }]
        },
        tags: ['corridor']
    });
    const room = normalizePiece({
        id: 'room_ns_01',
        size: { w: 7, h: 7 },
        exits: { N: true, S: true },
        friction: [
            '###.###',
            '#.....#',
            '#.....#',
            '#.....#',
            '#.....#',
            '#.....#',
            '###.###'
        ],
        sockets: {
            waypoints: [{ x: 3, y: 0 }, { x: 3, y: 6 }],
            spawns: [{ x: 3, y: 3 }]
        },
        tags: ['room']
    });

    // Hand placements: three N-S corridors stacked, then a room, then corridor.
    // attachOrigin center-aligns room under corridor.
    const p0 = { piece: ns, x: 0, y: 0 };
    const o1 = attachOrigin(ns, 0, 0, 'S', ns);
    assert.ok(o1);
    const p1 = { piece: ns, x: o1.x, y: o1.y };
    const o2 = attachOrigin(ns, p1.x, p1.y, 'S', ns);
    const p2 = { piece: ns, x: o2.x, y: o2.y };
    const o3 = attachOrigin(ns, p2.x, p2.y, 'S', room);
    assert.ok(o3);
    const p3 = { piece: room, x: o3.x, y: o3.y };
    const o4 = attachOrigin(room, p3.x, p3.y, 'S', ns);
    assert.ok(o4);
    const p4 = { piece: ns, x: o4.x, y: o4.y };

    const result = stitch([p0, p1, p2, p3, p4], { z: 0 });
    assert.strictEqual(result.meta.reason, 'ok');
    assert.strictEqual(result.meta.pieceCount, 5);
    assert.ok(result.cols >= 7, 'room width');
    assert.ok(result.rows >= 5 * 4 + 7, 'stacked height');
    assert.ok(result.sockets.spawns.length >= 5);
    assert.ok(result.sockets.waypoints.length >= 2);
    assert.ok(result.sockets.markers.length >= 1);

    // Entrance = first corridor north socket; exit = last corridor south socket
    const wps = result.sockets.waypoints;
    assert.ok(wps.length >= 2);
    // First placement waypoint at north of first piece (local 2,0)
    const start = wps[0];
    const end = wps[wps.length - 1];
    assert.ok(result.friction[start.y * result.cols + start.x] !== FRICTION_BLOCKED);
    assert.ok(result.friction[end.y * result.cols + end.x] !== FRICTION_BLOCKED);

    const map = new TileMap();
    map.loadFloorFromFriction(0, result.cols, result.rows, result.friction);
    assert.strictEqual(TM_BLOCKED, FRICTION_BLOCKED);
    assert.ok(map.isWalkable(start.x, start.y, 0));
    assert.ok(map.isWalkable(end.x, end.y, 0));

    const path = findPath(
        map,
        { x: start.x, y: start.y, z: 0 },
        { x: end.x, y: end.y, z: 0 },
        { allowDiagonal: false, maxDistance: 200, maxIterations: 4096 }
    );
    assert.ok(path && path.length > 1, 'A* finds entrance→exit on stitched map');
    assert.strictEqual(path[path.length - 1].x, end.x);
    assert.strictEqual(path[path.length - 1].y, end.y);

    // RGBA inject path also works
    const rgba = frictionToRgba(result.friction, result.cols, result.rows);
    const map2 = new TileMap();
    map2.loadFloorFromRgba(0, result.cols, result.rows, rgba);
    assert.ok(map2.isWalkable(start.x, start.y, 0));

    const edges = waypointSocketEdges(result.sockets.waypoints);
    assert.strictEqual(edges.edges.length, result.sockets.waypoints.length - 1);

    log('stitch + pathfind ok', {
        cols: result.cols,
        rows: result.rows,
        pathLen: path.length,
        spawns: result.sockets.spawns.length,
        markers: result.sockets.markers.length,
        waypoints: result.sockets.waypoints.length
    });
}

function testStandardPiecePack() {
    setActiveMode('standard');
    const ids = listPiecePackIds();
    assert.ok(ids.indexOf('cave_v1') >= 0, 'cave_v1 pack listed');

    const raw = loadPiecePack('cave_v1');
    const pack = normalizePiecePack(raw);
    assert.ok(pack);
    assert.strictEqual(pack.id, 'cave_v1');
    assert.ok(pack.pieces.length >= 6, 'enough pieces for corridors+hub+room');
    assert.ok(pack.byId.corr_ns_01);
    assert.ok(pack.byId.hub_cross_01);
    assert.ok(pack.byId.room_ns_01);
    assert.ok(pack.byId.deadend_s_01);

    const corridors = filterByTags(pack.pieces, 'corridor');
    assert.ok(corridors.length >= 4);
    const nsPieces = filterByExits(pack.pieces, ['N', 'S']);
    assert.ok(nsPieces.length >= 2);

    // Stitch via pieceId + pack.byId
    const a = pack.byId.corr_ns_01;
    const hub = pack.byId.hub_cross_01;
    const oHub = attachOrigin(a, 0, 0, 'S', hub);
    const oOut = attachOrigin(hub, oHub.x, oHub.y, 'S', a);
    const result = stitch(
        [
            { pieceId: 'corr_ns_01', x: 0, y: 0 },
            { pieceId: 'hub_cross_01', x: oHub.x, y: oHub.y },
            { pieceId: 'corr_ns_01', x: oOut.x, y: oOut.y }
        ],
        { pack, z: 7 }
    );
    assert.strictEqual(result.meta.pieceCount, 3);
    assert.ok(result.sockets.markers.some((m) => m.id === 'A' || m.id === 'B'));
    assert.ok(result.sockets.spawns.length >= 3);

    // Path from first north socket to last south-ish socket
    const start = result.sockets.waypoints.find(
        (w) => w.pieceId === 'corr_ns_01' && w.placementIndex === 0
    );
    // Prefer a waypoint on the last piece with high y
    let end = null;
    for (let i = 0; i < result.sockets.waypoints.length; i++) {
        const w = result.sockets.waypoints[i];
        if (w.placementIndex === 2) {
            if (!end || w.y > end.y) end = w;
        }
    }
    assert.ok(start && end, 'start/end sockets');

    const map = new TileMap();
    map.loadFloorFromFriction(7, result.cols, result.rows, result.friction);
    const path = findPath(
        map,
        { x: start.x, y: start.y, z: 7 },
        { x: end.x, y: end.y, z: 7 },
        { allowDiagonal: true, maxDistance: 100, maxIterations: 2048 }
    );
    assert.ok(path && path.length > 1, 'pack-stitched hub path exists');

    log('standard pack ok', {
        pieces: pack.pieces.length,
        cols: result.cols,
        rows: result.rows,
        pathLen: path.length
    });
}

function testEmptyAndOverlap() {
    const empty = stitch([]);
    assert.strictEqual(empty.meta.reason, 'empty');
    assert.strictEqual(empty.friction[0], FRICTION_BLOCKED);

    const p = normalizePiece({
        id: 'cell',
        size: { w: 3, h: 3 },
        exits: { N: true, S: true },
        friction: ['#.#', '...', '#.#']
    });
    // Overlapping stamps: second overwrites
    const r = stitch(
        [
            { piece: p, x: 0, y: 0 },
            { piece: p, x: 1, y: 0 }
        ],
        { shiftOrigin: true }
    );
    assert.ok(r.cols >= 4);
    assert.strictEqual(r.meta.pieceCount, 2);
    log('empty/overlap ok');
}

function main() {
    testParseFrictionAndNormalize();
    testCardinalMatching();
    testStitchCorridorAndPathfind();
    testStandardPiecePack();
    testEmptyAndOverlap();
    console.log('dungeon_pieces: ok');
}

main();
