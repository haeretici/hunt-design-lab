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
    decodeFrictionCell,
    frictionFromTableNibble,
    DEFAULT_WALK_FRICTION,
    FRICTION_BLOCKED
} = require('../kernel/core/lib/dungeon/pieces.js');
const { FRICTION_KEYS } = require('../kernel/core/lib/movement.js');
const {
    stitch,
    frictionToRgba,
    attachOrigin,
    waypointSocketEdges
} = require('../kernel/core/lib/dungeon/stitch.js');
const {
    loadPiecePack,
    listPiecePackIds,
    loadDungeonProfile,
    listDungeonProfileIds
} = require('../kernel/core/lib/presets.js');
const {
    generateFixedLayout
} = require('../kernel/core/lib/dungeon/layout/fixed.js');
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

function testTableNibbleFriction() {
    // 1-based index into FRICTION_KEYS: 1→70, 2→90, 3→95, 4→100, …
    assert.strictEqual(FRICTION_KEYS[0], 70);
    assert.strictEqual(FRICTION_KEYS[1], 90);
    assert.strictEqual(FRICTION_KEYS[2], 95);
    assert.strictEqual(FRICTION_KEYS[3], 100);
    assert.strictEqual(frictionFromTableNibble(1), 70);
    assert.strictEqual(frictionFromTableNibble(2), 90);
    assert.strictEqual(frictionFromTableNibble(3), 95);
    assert.strictEqual(frictionFromTableNibble(4), 100);
    assert.strictEqual(frictionFromTableNibble(0), 0);
    assert.strictEqual(
        frictionFromTableNibble(15),
        FRICTION_KEYS[14],
        'f → 15th key (1-based)'
    );
    assert.strictEqual(decodeFrictionCell('1', 100), 70);
    assert.strictEqual(decodeFrictionCell('2', 100), 90);
    assert.strictEqual(decodeFrictionCell('4', 100), 100);
    assert.strictEqual(decodeFrictionCell('a', 100), FRICTION_KEYS[9]);
    assert.strictEqual(decodeFrictionCell('f', 100), FRICTION_KEYS[14]);
    assert.strictEqual(decodeFrictionCell('0', 100), 0);
    assert.strictEqual(decodeFrictionCell('.', 100), 100);

    const p = normalizePiece({
        id: 'nib',
        size: { w: 4, h: 1 },
        friction: ['12.f']
    });
    assert.strictEqual(p.friction[0], 70);
    assert.strictEqual(p.friction[1], 90);
    assert.strictEqual(p.friction[2], DEFAULT_WALK_FRICTION);
    assert.strictEqual(p.friction[3], FRICTION_KEYS[14]);
    log('table nibble friction ok', {
        f15: FRICTION_KEYS[14],
        keys: FRICTION_KEYS.length
    });
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

/**
 * Assert every spine point is walkable on a generated fixed layout.
 * @param {object} gen
 * @param {string} label
 */
function assertGenSpineWalkable(gen, label) {
    assert.ok(gen.ok, `${label} generateFixedLayout ok`);
    assert.ok(gen.entrance, `${label} entrance`);
    assert.ok(gen.exit, `${label} exit`);
    const map = new TileMap();
    map.loadFloorFromFriction(0, gen.cols, gen.rows, gen.friction);
    assert.ok(
        map.isWalkable(gen.entrance.x, gen.entrance.y, 0),
        `${label} entrance walkable`
    );
    assert.ok(
        map.isWalkable(gen.exit.x, gen.exit.y, 0),
        `${label} exit walkable`
    );
    const wps = gen.waypoints || [];
    assert.ok(wps.length >= 2, `${label} waypoints`);
    for (let i = 0; i < wps.length; i++) {
        const w = wps[i];
        assert.ok(
            map.isWalkable(w.x, w.y, 0),
            `${label} waypoint[${i}] walkable (${w.x},${w.y})`
        );
    }
    const path = findPath(
        map,
        { x: gen.entrance.x, y: gen.entrance.y, z: 0 },
        { x: gen.exit.x, y: gen.exit.y, z: 0 },
        { allowDiagonal: false, maxDistance: 200, maxIterations: 8192 }
    );
    assert.ok(path && path.length > 1, `${label} entrance→exit path`);
}

/**
 * Smoke: arena_combat_v1 (4 open combat shells) + rest_area_v1 (3 portal lobbies).
 * Rest stairs must keep dir and sit on walkable interior cells (normalizeStairList drops dir-less).
 * Shell profiles omit populationId and spine fields so piece sockets drive multi-piece pick.
 */
function testArenaAndRestPacks() {
    setActiveMode('standard');
    const packIds = listPiecePackIds();
    assert.ok(packIds.indexOf('arena_combat_v1') >= 0, 'arena_combat_v1 listed');
    assert.ok(packIds.indexOf('rest_area_v1') >= 0, 'rest_area_v1 listed');

    const arena = normalizePiecePack(loadPiecePack('arena_combat_v1'));
    assert.ok(arena);
    assert.strictEqual(arena.id, 'arena_combat_v1');
    assert.strictEqual(arena.pieces.length, 4);
    const arenaIds = [
        'arena_open_24',
        'arena_pillars_24',
        'arena_ring_22',
        'arena_split_26'
    ];
    for (let i = 0; i < arenaIds.length; i++) {
        const p = arena.byId[arenaIds[i]];
        assert.ok(p, arenaIds[i]);
        assert.strictEqual(p.exits.N, false);
        assert.strictEqual(p.exits.S, false);
        assert.strictEqual(p.exits.E, false);
        assert.strictEqual(p.exits.W, false);
        assert.ok(p.sockets.spawns.length >= 4 && p.sockets.spawns.length <= 8);
        assert.ok(p.sockets.waypoints.length >= 4 && p.sockets.waypoints.length <= 6);
        assert.strictEqual(p.sockets.stairs.length, 0);
        assert.ok(p.tags.indexOf('arena') >= 0);
        assert.ok(p.tags.indexOf('combat') >= 0);
        for (let j = 0; j < p.sockets.spawns.length; j++) {
            const s = p.sockets.spawns[j];
            assert.notStrictEqual(
                p.friction[s.y * p.size.w + s.x],
                FRICTION_BLOCKED,
                `${p.id} spawn walkable`
            );
        }
        for (let j = 0; j < p.sockets.waypoints.length; j++) {
            const s = p.sockets.waypoints[j];
            assert.notStrictEqual(
                p.friction[s.y * p.size.w + s.x],
                FRICTION_BLOCKED,
                `${p.id} waypoint walkable`
            );
        }
    }

    const rest = normalizePiecePack(loadPiecePack('rest_area_v1'));
    assert.ok(rest);
    assert.strictEqual(rest.id, 'rest_area_v1');
    assert.strictEqual(rest.pieces.length, 3);
    const restIds = ['rest_square_14', 'rest_alcove_12', 'rest_hall_16'];
    for (let i = 0; i < restIds.length; i++) {
        const p = rest.byId[restIds[i]];
        assert.ok(p, restIds[i]);
        assert.strictEqual(p.exits.N, false, `${p.id} closed N`);
        assert.strictEqual(p.exits.S, false, `${p.id} closed S`);
        assert.strictEqual(p.exits.E, false, `${p.id} closed E`);
        assert.strictEqual(p.exits.W, false, `${p.id} closed W`);
        assert.ok(p.tags.indexOf('rest') >= 0);
        assert.ok(p.tags.indexOf('portal') >= 0);
        assert.strictEqual(p.sockets.stairs.length, 1, `${p.id} has one stair`);
        const st = p.sockets.stairs[0];
        assert.strictEqual(st.dir, 'down', `${p.id} stair dir=down`);
        assert.strictEqual(st.link, 'portal', `${p.id} stair link=portal`);
        assert.notStrictEqual(
            p.friction[st.y * p.size.w + st.x],
            FRICTION_BLOCKED,
            `${p.id} stair on walkable`
        );
        assert.ok(p.sockets.waypoints.length >= 2);
        const nearPortal = p.sockets.waypoints.some(
            (w) => Math.abs(w.x - st.x) + Math.abs(w.y - st.y) <= 2
        );
        assert.ok(nearPortal, `${p.id} waypoint near portal`);
    }
    // rest_alcove_12: cave_clickies pool letter B → rest_well object
    const alcove = rest.byId.rest_alcove_12;
    const well = alcove.sockets.markers.find((m) => m.id === 'B');
    assert.ok(well, 'alcove marker letter B');
    assert.notStrictEqual(
        alcove.friction[well.y * alcove.size.w + well.x],
        FRICTION_BLOCKED,
        'alcove marker walkable'
    );

    // Shell dungeon profiles: pack wired, populationId + spine fields omitted
    const profileIds = listDungeonProfileIds();
    assert.ok(profileIds.indexOf('arena_combat_shell') >= 0);
    assert.ok(profileIds.indexOf('rest_area_shell') >= 0);

    const arenaShell = loadDungeonProfile('arena_combat_shell');
    assert.strictEqual(arenaShell.piecePack, 'arena_combat_v1');
    assert.ok(
        arenaShell.populationId == null,
        'arena shell omits populationId'
    );
    assert.ok(arenaShell.entrance == null, 'arena shell omits entrance');
    assert.ok(arenaShell.exit == null, 'arena shell omits exit');
    assert.ok(
        arenaShell.waypoints == null ||
            (Array.isArray(arenaShell.waypoints) &&
                arenaShell.waypoints.length === 0),
        'arena shell omits waypoints'
    );
    assert.ok(Array.isArray(arenaShell.placements) && arenaShell.placements.length >= 1);

    const restShell = loadDungeonProfile('rest_area_shell');
    assert.strictEqual(restShell.piecePack, 'rest_area_v1');
    assert.ok(restShell.populationId == null, 'rest shell omits populationId');
    assert.ok(restShell.entrance == null, 'rest shell omits entrance');
    assert.ok(restShell.exit == null, 'rest shell omits exit');
    assert.ok(
        restShell.waypoints == null ||
            (Array.isArray(restShell.waypoints) && restShell.waypoints.length === 0),
        'rest shell omits waypoints'
    );

    // PR2 consumption path: spread shell, overwrite placements only → piece sockets drive spine
    for (let i = 0; i < arenaIds.length; i++) {
        const pieceId = arenaIds[i];
        const gen = generateFixedLayout({
            profile: Object.assign({}, arenaShell, {
                placements: [{ pieceId, x: 0, y: 0 }]
            }),
            pack: arena,
            seed: 1,
            z: 0
        });
        assertGenSpineWalkable(gen, `arena ${pieceId}`);
    }

    for (let i = 0; i < restIds.length; i++) {
        const pieceId = restIds[i];
        const gen = generateFixedLayout({
            profile: Object.assign({}, restShell, {
                placements: [{ pieceId, x: 0, y: 0 }]
            }),
            pack: rest,
            seed: 1,
            z: 0
        });
        assertGenSpineWalkable(gen, `rest ${pieceId}`);
        const stairs = (gen.sockets && gen.sockets.stairs) || [];
        assert.strictEqual(stairs.length, 1, `${pieceId} gen stairs`);
        assert.strictEqual(stairs[0].dir, 'down', `${pieceId} gen stair dir`);
        assert.strictEqual(stairs[0].link, 'portal', `${pieceId} gen stair link`);
        assert.notStrictEqual(
            gen.friction[stairs[0].y * gen.cols + stairs[0].x],
            FRICTION_BLOCKED,
            `${pieceId} gen stair walkable`
        );
    }

    log('arena/rest packs ok', {
        arenaPieces: arena.pieces.length,
        restPieces: rest.pieces.length
    });
}

function main() {
    testTableNibbleFriction();
    testParseFrictionAndNormalize();
    testCardinalMatching();
    testStitchCorridorAndPathfind();
    testStandardPiecePack();
    testEmptyAndOverlap();
    testArenaAndRestPacks();
    console.log('dungeon_pieces: ok');
}

main();
