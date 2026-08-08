#!/usr/bin/env node
/**
 * Stage 11.8 — Multi-floor biome chains (stair sockets, biome.floors, nav edges).
 * Quiet on success; VERBOSE=1 for detail.
 */

'use strict';

const { hasMode } = require('./helpers/modes.js');

const assert = require('assert');
const {
    normalizePiece,
    normalizePiecePack,
    normalizeFloorChain,
    normalizeFloorEntry,
    pairStairLinks,
    generateMultiFloorLayout,
    normalizeBiomePack,
    stitch
} = require('../kernel/core/lib/dungeon/index.js');
const {
    loadBiomePack,
    loadPiecePack,
    loadDungeonProfile,
    loadPopulation,
    loadHunt,
    expandHuntDefinition: expandHunt
} = require('../kernel/core/lib/presets.js');
const { setActiveMode } = require('../kernel/core/lib/modes.js');
const { resolveHuntConfig } = require('../kernel/providers/simulator/headless_runner.js');
const { Simulator } = require('../kernel/providers/simulator/simulator.js');
const { expandAnchorsWithLocalAStar } = require('../kernel/core/lib/navmesh.js');
const { TileMap } = require('../kernel/core/entities/tilemap.js');

const VERBOSE = !!process.env.VERBOSE;

function log(...args) {
    if (VERBOSE) console.log(...args);
}

function loaders() {
    return {
        loadDungeonProfile,
        loadPiecePack,
        loadPopulation,
        loadBiomePack,
        normalizePiecePack
    };
}

function testStairSocketsOnPieces() {
    const p = normalizePiece({
        id: 'stair_test',
        size: { w: 3, h: 3 },
        exits: { S: true },
        friction: ['###', '#.#', '#.#'],
        sockets: {
            stairs: [{ x: 1, y: 1, dir: 'down', link: 'main' }]
        }
    });
    assert.ok(p);
    assert.strictEqual(p.sockets.stairs.length, 1);
    assert.strictEqual(p.sockets.stairs[0].dir, 'down');
    assert.strictEqual(p.sockets.stairs[0].link, 'main');

    const stitched = stitch(
        [{ piece: p, x: 0, y: 0, z: 0 }],
        { z: 0 }
    );
    assert.strictEqual(stitched.sockets.stairs.length, 1);
    assert.strictEqual(stitched.sockets.stairs[0].x, 1);
    assert.strictEqual(stitched.sockets.stairs[0].z, 0);
    log('stair sockets ok');
}

function testFloorChainNormalize() {
    const chain = normalizeFloorChain([
        { z: 0, profileId: 'small_crawl', role: 'entrance' },
        'small_crawl'
    ]);
    assert.ok(chain);
    assert.strictEqual(chain.length, 2);
    assert.strictEqual(chain[0].z, 0);
    assert.strictEqual(chain[0].profileId, 'small_crawl');
    assert.strictEqual(chain[1].z, 1);
    assert.strictEqual(chain[1].profileId, 'small_crawl');

    const e = normalizeFloorEntry({ floor: 3, profileId: 'x', artSet: 'cave' }, 0);
    assert.strictEqual(e.z, 3);
    assert.strictEqual(e.artSet, 'cave');
    log('floor chain normalize ok');
}

function testPairStairs() {
    const links = pairStairLinks(
        [
            { x: 1, y: 1, z: 0, dir: 'down', link: 'main' },
            { x: 5, y: 5, z: 0, dir: 'down', link: 'side' }
        ],
        [
            { x: 2, y: 2, z: 1, dir: 'up', link: 'side' },
            { x: 9, y: 9, z: 1, dir: 'up', link: 'main' }
        ]
    );
    assert.strictEqual(links.length, 2);
    const main = links.find((L) => L.link === 'main');
    assert.ok(main);
    assert.strictEqual(main.from.x, 1);
    assert.strictEqual(main.to.x, 9);
    log('pair stairs ok');
}

function testGenerateMultiFloor() {
    setActiveMode('standard');
    const pack = normalizePiecePack(loadPiecePack('cave_v1'));
    assert.ok(pack.pieces.some((p) => p.sockets.stairs && p.sockets.stairs.length));

    const gen = generateMultiFloorLayout({
        floors: [
            { z: 0, profileId: 'small_crawl' },
            { z: 1, profileId: 'small_crawl' }
        ],
        seed: 42,
        ...loaders(),
        defaultPiecePack: 'cave_v1',
        defaultArtSet: 'cave'
    });
    assert.ok(gen.ok, gen.error && gen.error.message);
    assert.strictEqual(gen.floors.length, 2);
    assert.ok(gen.floorLayers['0']);
    assert.ok(gen.floorLayers['1']);
    assert.ok(gen.floorLayers['0'].friction instanceof Uint8Array);
    assert.ok(gen.stairLinks.length >= 1);
    assert.ok(gen.waypoints.length >= 4);
    // waypoints span both floors
    const zs = new Set(gen.waypoints.map((w) => String(w.z)));
    assert.ok(zs.has('0') && zs.has('1'), 'waypoints cover both floors');
    assert.ok(gen.navmesh && gen.navmesh.points.length >= 2);
    assert.ok(gen.navmesh.connections.length >= 1);
    log('generate multi-floor ok', {
        floors: gen.floors,
        stairs: gen.stairLinks.length,
        wps: gen.waypoints.length,
        pieces: gen.meta.pieceCount
    });
}

function testBiomeFloorsAndArtSet() {
    setActiveMode('standard');
    const raw = loadBiomePack('cave');
    const m = normalizeBiomePack(raw);
    assert.ok(m);
    assert.strictEqual(m.artSet, 'cave');
    assert.ok(Array.isArray(m.floors));
    assert.strictEqual(m.floors.length, 2);
    assert.strictEqual(m.floors[0].profileId, 'small_crawl');
    log('biome floors + artSet ok');
}

function testExpandHuntMultifloor() {
    setActiveMode('standard');
    const hunt = loadHunt('cave_crawl_multifloor');
    const exp = expandHunt(hunt, { seed: 7 });
    assert.ok(!exp.layoutSkipped, exp.layoutSkipped || exp.layoutError);
    assert.ok(exp.layoutMeta && exp.layoutMeta.reason === 'ok');
    assert.strictEqual(exp.layoutMeta.type, 'multifloor');
    assert.ok(exp.floorLayers);
    assert.ok(exp.floorLayers['0'] && exp.floorLayers['1']);
    assert.ok(Array.isArray(exp.stairLinks) && exp.stairLinks.length >= 1);
    assert.ok(Array.isArray(exp.spawns) && exp.spawns.length > 0);
    // spawns on both floors
    const spawnZ = new Set(exp.spawns.map((s) => String(s.z != null ? s.z : 0)));
    assert.ok(spawnZ.has('0'), 'spawns on floor 0');
    assert.ok(spawnZ.has('1'), 'spawns on floor 1');
    log('expand hunt multifloor ok', {
        spawns: exp.spawns.length,
        stairLinks: exp.stairLinks.length
    });
}

function testLegacyMultifloor() {
    if (!hasMode('legacy')) return;
    setActiveMode('legacy');
    const exp = expandHunt(loadHunt('cave_crawl_multifloor'), { seed: 3 });
    assert.ok(exp.layoutMeta && exp.layoutMeta.reason === 'ok', exp.layoutError);
    assert.ok(exp.floorLayers['0'] && exp.floorLayers['1']);
    log('legacy multifloor ok');
}

async function testSimLoadsBothFloors() {
    setActiveMode('standard');
    const exp = expandHunt(loadHunt('cave_crawl_multifloor'), { seed: 11 });
    const resolved = resolveHuntConfig({ hunt: exp, seed: 11 });
    assert.ok(resolved.floorLayers);
    assert.ok(resolved.floors.length >= 2);

    const sim = new Simulator({
        seed: 11,
        floors: resolved.floors,
        floorLayers: resolved.floorLayers,
        parties: resolved.parties,
        spawns: [],
        combatAi: false
    });
    await sim.loadMaps();
    assert.ok(sim.tileMap.getLayer(0), 'layer 0');
    assert.ok(sim.tileMap.getLayer(1), 'layer 1');
    sim.destroy();
    log('sim multi-floor load ok');
}

function testNavmeshCrossFloorExpand() {
    // open 3x3 on two floors
    const tm = new TileMap();
    const open = new Uint8Array(9);
    open.fill(100);
    tm.loadFloorFromFriction(0, 3, 3, open);
    tm.loadFloorFromFriction(1, 3, 3, open);

    const anchors = [
        { x: 0, y: 1, z: 0 },
        { x: 1, y: 1, z: 0 }, // stair down
        { x: 1, y: 1, z: 1 }, // stair up
        { x: 2, y: 1, z: 1 }
    ];
    const path = expandAnchorsWithLocalAStar(tm, anchors, {
        maxDistance: 20,
        maxIterations: 128
    });
    assert.ok(path, 'cross-floor expand succeeds');
    assert.ok(path.some((p) => String(p.z) === '0'));
    assert.ok(path.some((p) => String(p.z) === '1'));
    log('navmesh cross-floor expand ok', path.length);
}

function testPartyStairHop() {
    setActiveMode('standard');
    const exp = expandHunt(loadHunt('cave_crawl_multifloor'), { seed: 5 });
    assert.ok(exp.stairLinks.length >= 1);
    const link = exp.stairLinks[0];

    const { Party } = require('../kernel/core/entities/party.js');
    const { Player } = require('../kernel/core/entities/player.js');
    const tm = new TileMap();
    for (const z of exp.floors) {
        const layer = exp.floorLayers[String(z)];
        tm.loadFloorFromFriction(z, layer.cols, layer.rows, layer.friction);
    }

    const party = new Party({
        waypoints: [
            { x: link.from.x, y: link.from.y, z: link.from.z },
            { x: link.to.x, y: link.to.y, z: link.to.z }
        ],
        stairLinks: exp.stairLinks
    });
    const player = new Player({
        id: 1,
        name: 'T',
        isLeader: true,
        tile: { x: link.from.x, y: link.from.y, z: link.from.z }
    });
    party.addMember(player);
    assert.ok(
        tm.moveEntityToTile(player, link.from.x, link.from.y, link.from.z),
        'place on stair from'
    );

    // Arrive at first wp then hop to second floor
    player.currentWaypoint = 0;
    let guard = 0;
    while (!player.routeComplete && guard < 40) {
        party._stepMember(tm, player);
        guard++;
    }
    assert.strictEqual(
        String(player.tile.z),
        String(link.to.z),
        'hopped to lower floor'
    );
    log('party stair hop ok', { z: player.tile.z, guard });
}

/**
 * Stage 12H: TileMap stairs alone (no party.stairLinks) + approach pad then hop.
 */
function testFirstClassStairTiles() {
    const tm = new TileMap();
    const open = new Uint8Array(25);
    open.fill(100);
    tm.loadFloorFromFriction(0, 5, 5, open);
    tm.loadFloorFromFriction(1, 5, 5, open);

    // Stair at (2,2): z0 ↔ z1
    tm.setStairs([
        { from: { x: 2, y: 2, z: 0 }, to: { x: 2, y: 2, z: 1 } }
    ]);
    assert.ok(tm.isStair(2, 2, 0));
    assert.ok(tm.isStair(2, 2, 1));

    const { Party } = require('../kernel/core/entities/party.js');
    const { Player } = require('../kernel/core/entities/player.js');

    // Party starts off the pad; no party.stairLinks — map stairs only
    const party = new Party({
        waypoints: [
            { x: 0, y: 2, z: 0 },
            { x: 4, y: 2, z: 1 }
        ],
        stairLinks: []
    });
    const player = new Player({
        id: 2,
        name: 'S',
        isLeader: true,
        tile: { x: 0, y: 2, z: 0 }
    });
    party.addMember(player);
    assert.ok(tm.moveEntityToTile(player, 0, 2, 0));

    player.currentWaypoint = 0;
    let guard = 0;
    while (!player.routeComplete && guard < 80) {
        party._stepMember(tm, player);
        guard++;
    }
    assert.strictEqual(String(player.tile.z), '1', 'reached lower floor via map stairs');
    assert.ok(player.routeComplete || player.currentWaypoint >= 1, 'progressed route');
    log('first-class stair tiles ok', {
        z: player.tile.z,
        xy: [player.tile.x, player.tile.y],
        guard,
        complete: player.routeComplete
    });
}

/**
 * Stage 12H: followLongPath consumes multi-z expanded path via stair hop.
 */
function testFollowLongPathStairHop() {
    const tm = new TileMap();
    const open = new Uint8Array(9);
    open.fill(100);
    tm.loadFloorFromFriction(0, 3, 3, open);
    tm.loadFloorFromFriction(1, 3, 3, open);
    tm.setStairs([
        { from: { x: 1, y: 1, z: 0 }, to: { x: 1, y: 1, z: 1 } }
    ]);

    // Minimal navmesh: corners + stair pads
    const { Navmesh } = require('../kernel/core/lib/navmesh.js');
    tm.setNavmesh(
        new Navmesh({
            id: 'stair_test',
            points: [
                { x: 0, y: 1, z: 0 },
                { x: 1, y: 1, z: 0 },
                { x: 1, y: 1, z: 1 },
                { x: 2, y: 1, z: 1 }
            ],
            connections: [
                [0, 1],
                [1, 2],
                [2, 3]
            ]
        })
    );

    const entity = {
        id: 3,
        tile: { x: 0, y: 1, z: 0 },
        path: []
    };
    assert.ok(tm.moveEntityToTile(entity, 0, 1, 0));

    let guard = 0;
    while (
        (entity.tile.x !== 2 ||
            entity.tile.y !== 1 ||
            String(entity.tile.z) !== '1') &&
        guard < 40
    ) {
        tm.followLongPath(entity, 2, 1, 1, {
            maxDistance: 20,
            maxIterations: 128,
            enforceRequestCap: false,
            useNavmeshBeyondCap: true
        });
        guard++;
    }
    assert.strictEqual(String(entity.tile.z), '1', 'long path stair hop z');
    assert.strictEqual(entity.tile.x, 2, 'long path stair hop x');
    assert.strictEqual(entity.tile.y, 1, 'long path stair hop y');
    log('followLongPath stair hop ok', { guard });
}

/**
 * Stage 12H: Simulator.loadMaps installs stairLinks onto TileMap.
 */
/**
 * Follower catch-up: Party.stepTowardFloor approaches pad and hops (P0).
 * followPath must refuse cross-floor (P1).
 */
function testFollowerStepTowardFloor() {
    const tm = new TileMap();
    const open = new Uint8Array(25);
    open.fill(100);
    tm.loadFloorFromFriction(0, 5, 5, open);
    tm.loadFloorFromFriction(1, 5, 5, open);
    tm.setStairs([
        { from: { x: 2, y: 2, z: 0 }, to: { x: 2, y: 2, z: 1 } }
    ]);

    const { Party } = require('../kernel/core/entities/party.js');
    const { Player } = require('../kernel/core/entities/player.js');

    const party = new Party({
        waypoints: [
            { x: 0, y: 0, z: 0 },
            { x: 4, y: 4, z: 1 }
        ],
        stairLinks: []
    });
    const follower = new Player({
        id: 10,
        name: 'Follower',
        isLeader: false,
        tile: { x: 0, y: 2, z: 0 }
    });
    party.addMember(follower);
    assert.ok(tm.moveEntityToTile(follower, 0, 2, 0));

    // P1: followPath with different z clears path and does not teleport
    follower.path = [{ x: 1, y: 2 }];
    const refused = tm.followPath(follower, 2, 2, 1);
    assert.strictEqual(refused, false, 'followPath rejects cross-floor');
    assert.strictEqual(follower.path.length, 0, 'stale path cleared');
    assert.strictEqual(String(follower.tile.z), '0', 'no illegal hop');

    // P0: stepTowardFloor walks to pad then hops
    let guard = 0;
    while (String(follower.tile.z) !== '1' && guard < 40) {
        // canStep gate: zero moveDelay so each call may step
        follower.moveDelay = 0;
        party.stepTowardFloor(tm, follower, 1, {
            preferNear: { x: 4, y: 4, z: 1 }
        });
        guard++;
    }
    assert.strictEqual(String(follower.tile.z), '1', 'follower reached z1 via stairs');
    log('follower stepTowardFloor ok', {
        z: follower.tile.z,
        xy: [follower.tile.x, follower.tile.y],
        guard
    });
}

/**
 * FollowLeader AI climbs when leader is already on another floor (P0/P2).
 */
function testFollowLeaderCrossFloorAi() {
    const tm = new TileMap();
    const open = new Uint8Array(25);
    open.fill(100);
    tm.loadFloorFromFriction(0, 5, 5, open);
    tm.loadFloorFromFriction(1, 5, 5, open);
    tm.setStairs([
        { from: { x: 2, y: 2, z: 0 }, to: { x: 2, y: 2, z: 1 } }
    ]);

    const { Party } = require('../kernel/core/entities/party.js');
    const { Player } = require('../kernel/core/entities/player.js');
    const {
        FollowLeader,
        changePlayerState
    } = require('../kernel/core/lib/ai/player_states.js');
    const huntAi = require('../kernel/core/lib/ai/hunt_ai.js');

    const party = new Party({
        waypoints: [
            { x: 0, y: 2, z: 0 },
            { x: 4, y: 2, z: 1 }
        ],
        stairLinks: []
    });
    const leader = new Player({
        id: 1,
        name: 'Lead',
        isLeader: true,
        tile: { x: 4, y: 2, z: 1 },
        strategy: {
            aggression: 0,
            engageRange: 1,
            monstersToEngage: 99,
            fleeHpPercent: 0,
            returnToRoute: true
        }
    });
    const scout = new Player({
        id: 2,
        name: 'Scout',
        isLeader: false,
        tile: { x: 0, y: 2, z: 0 },
        strategy: {
            aggression: 0,
            engageRange: 1,
            monstersToEngage: 99,
            fleeHpPercent: 0,
            returnToRoute: true
        }
    });
    party.addMember(leader);
    party.addMember(scout);
    assert.ok(tm.moveEntityToTile(leader, 4, 2, 1));
    assert.ok(tm.moveEntityToTile(scout, 0, 2, 0));
    leader.currentWaypoint = 1;
    scout.currentWaypoint = 0;
    leader.routeComplete = false;
    scout.routeComplete = false;

    huntAi.initPlayerAi(scout);
    huntAi.initPlayerAi(leader);
    changePlayerState(scout, FollowLeader);

    const ctx = {
        tileMap: tm,
        sim: { findPartyOf: () => party },
        enemies: [],
        allies: [leader, scout],
        spellBook: {},
        rng: () => 0.99,
        hooks: null
    };

    let guard = 0;
    while (String(scout.tile.z) !== '1' && guard < 60) {
        scout.moveDelay = 0;
        FollowLeader.execute(scout, ctx);
        guard++;
    }
    assert.strictEqual(
        String(scout.tile.z),
        '1',
        'FollowLeader climbs to leader floor'
    );
    log('FollowLeader cross-floor AI ok', {
        z: scout.tile.z,
        xy: [scout.tile.x, scout.tile.y],
        guard
    });
}

/**
 * FollowLeader trail: first follower aims one tile before leader on path
 * (not stack-on-leader). At trail dest: clear path and hold.
 */
function testFollowLeaderTrailSlot() {
    const tm = new TileMap();
    // 1-wide corridor length 6
    const open = new Uint8Array(6);
    open.fill(100);
    tm.loadFloorFromFriction(0, 6, 1, open);

    const { Party } = require('../kernel/core/entities/party.js');
    const { Player } = require('../kernel/core/entities/player.js');
    const {
        FollowLeader,
        changePlayerState,
        pickTrailPoint,
        partyFollowSlot,
        resolveFollowRawGoal
    } = require('../kernel/core/lib/ai/player_states.js');
    const huntAi = require('../kernel/core/lib/ai/hunt_ai.js');

    const party = new Party({
        waypoints: [
            { x: 0, y: 0, z: 0 },
            { x: 5, y: 0, z: 0 }
        ]
    });
    const strategy = {
        aggression: 0,
        engageRange: 1,
        monstersToEngage: 99,
        fleeHpPercent: 0,
        returnToRoute: true
    };
    const leader = new Player({
        id: 101,
        name: 'Lead',
        isLeader: true,
        tile: { x: 4, y: 0, z: 0 },
        strategy,
        speed: 220
    });
    const scout = new Player({
        id: 102,
        name: 'Scout',
        isLeader: false,
        tile: { x: 0, y: 0, z: 0 },
        strategy,
        speed: 220
    });
    const ents = new Map([
        [101, leader],
        [102, scout]
    ]);
    tm.resolveEntity = (id) => ents.get(id) || null;

    party.addMember(leader);
    party.addMember(scout);
    assert.ok(tm.moveEntityToTile(leader, 4, 0, 0));
    assert.ok(tm.moveEntityToTile(scout, 0, 0, 0));
    leader.currentWaypoint = 1;
    scout.currentWaypoint = 0;
    leader.routeComplete = false;
    scout.routeComplete = false;

    // rawGoal hook is leader.tile (peaceful-WP not active)
    const raw = resolveFollowRawGoal(scout, leader, party);
    assert.deepStrictEqual(
        raw,
        { x: 4, y: 0, z: 0 },
        'rawGoal = leader.tile'
    );
    assert.strictEqual(partyFollowSlot(scout, party), 1, 'first follower slot 1');
    const samplePath = [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 2, y: 0 },
        { x: 3, y: 0 },
        { x: 4, y: 0 }
    ];
    assert.deepStrictEqual(
        pickTrailPoint(samplePath, 1, raw, 1),
        { x: 3, y: 0, z: 0 },
        'slot 1 → one tile before leader'
    );

    huntAi.initPlayerAi(scout);
    huntAi.initPlayerAi(leader);
    changePlayerState(scout, FollowLeader);

    const ctx = {
        tileMap: tm,
        sim: { findPartyOf: () => party },
        enemies: [],
        allies: [leader, scout],
        spellBook: {},
        rng: () => 0.99,
        hooks: null
    };

    let guard = 0;
    while (scout.tile.x !== 3 && guard < 40) {
        scout.moveDelay = 0;
        FollowLeader.execute(scout, ctx);
        guard++;
    }
    assert.strictEqual(scout.tile.x, 3, 'follower trail dest x (before leader)');
    assert.strictEqual(scout.tile.y, 0, 'follower trail dest y');
    assert.notStrictEqual(
        scout.tile.x,
        leader.tile.x,
        'does not stack on leader as goal'
    );

    // At trail dest: clear path and hold
    scout.path = [
        { x: 5, y: 0 },
        { x: 2, y: 0 }
    ];
    scout.moveDelay = 0;
    FollowLeader.execute(scout, ctx);
    assert.deepStrictEqual(scout.path, [], 'trail dest clears path');
    assert.strictEqual(scout.tile.x, 3, 'stays on trail slot');

    log('FollowLeader trail slot ok', {
        guard,
        xy: [scout.tile.x, scout.tile.y],
        leader: [leader.tile.x, leader.tile.y]
    });
}

/**
 * Two followers get distinct trail slots on a long corridor (legacy spacing).
 */
function testFollowLeaderMultiSlotTrail() {
    const tm = new TileMap();
    const open = new Uint8Array(10);
    open.fill(100);
    tm.loadFloorFromFriction(0, 10, 1, open);

    const { Party } = require('../kernel/core/entities/party.js');
    const { Player } = require('../kernel/core/entities/player.js');
    const {
        FollowLeader,
        changePlayerState,
        pickTrailPoint
    } = require('../kernel/core/lib/ai/player_states.js');
    const huntAi = require('../kernel/core/lib/ai/hunt_ai.js');

    const strategy = {
        aggression: 0,
        engageRange: 1,
        monstersToEngage: 99,
        fleeHpPercent: 0,
        returnToRoute: true
    };
    const party = new Party({
        waypoints: [
            { x: 0, y: 0, z: 0 },
            { x: 9, y: 0, z: 0 }
        ]
    });
    const leader = new Player({
        id: 301,
        name: 'Lead',
        isLeader: true,
        tile: { x: 8, y: 0, z: 0 },
        strategy,
        speed: 220
    });
    const f1 = new Player({
        id: 302,
        name: 'F1',
        isLeader: false,
        tile: { x: 0, y: 0, z: 0 },
        strategy,
        speed: 220
    });
    const f2 = new Player({
        id: 303,
        name: 'F2',
        isLeader: false,
        tile: { x: 1, y: 0, z: 0 },
        strategy,
        speed: 220
    });
    const ents = new Map([
        [301, leader],
        [302, f1],
        [303, f2]
    ]);
    tm.resolveEntity = (id) => ents.get(id) || null;
    party.addMember(leader);
    party.addMember(f1);
    party.addMember(f2);
    assert.ok(tm.moveEntityToTile(leader, 8, 0, 0));
    assert.ok(tm.moveEntityToTile(f1, 0, 0, 0));
    assert.ok(tm.moveEntityToTile(f2, 1, 0, 0));

    const path = tm.search(
        { x: 0, y: 0, z: 0 },
        { x: 8, y: 0, z: 0 },
        { allowDiagonal: true }
    );
    assert.ok(path && path.length >= 5, 'path exists');
    const d1 = pickTrailPoint(path, 1, { x: 8, y: 0, z: 0 }, 1);
    const d2 = pickTrailPoint(path, 2, { x: 8, y: 0, z: 0 }, 1);
    assert.strictEqual(d1.x, 7, 'slot1 → x=7');
    assert.strictEqual(d2.x, 6, 'slot2 → x=6');
    assert.notStrictEqual(d1.x, d2.x, 'distinct trail tiles');

    huntAi.initPlayerAi(f1);
    huntAi.initPlayerAi(f2);
    changePlayerState(f1, FollowLeader);
    changePlayerState(f2, FollowLeader);
    const ctx = {
        tileMap: tm,
        sim: { findPartyOf: () => party },
        enemies: [],
        allies: [leader, f1, f2],
        spellBook: {},
        rng: () => 0.99,
        hooks: null
    };

    let guard = 0;
    while (
        (f1.tile.x !== d1.x || f2.tile.x !== d2.x) &&
        guard < 80
    ) {
        f1.moveDelay = 0;
        f2.moveDelay = 0;
        FollowLeader.execute(f1, ctx);
        FollowLeader.execute(f2, ctx);
        guard++;
    }
    assert.strictEqual(f1.tile.x, d1.x, 'F1 at trail slot 1');
    assert.strictEqual(f2.tile.x, d2.x, 'F2 at trail slot 2');
    assert.notStrictEqual(f1.tile.x, leader.tile.x, 'F1 not on leader');
    assert.notStrictEqual(f2.tile.x, leader.tile.x, 'F2 not on leader');
    log('FollowLeader multi-slot trail ok', {
        guard,
        f1: f1.tile.x,
        f2: f2.tile.x,
        leader: leader.tile.x
    });
}

/**
 * Phase C: multi-member corridor + stair hop — both land stacked on dest pad.
 */
function testPartyStackCorridorAndStair() {
    const tm = new TileMap();
    const open0 = new Uint8Array(5);
    open0.fill(100);
    const open1 = new Uint8Array(5);
    open1.fill(100);
    tm.loadFloorFromFriction(0, 5, 1, open0);
    tm.loadFloorFromFriction(1, 5, 1, open1);
    tm.setStairs([{ from: { x: 4, y: 0, z: 0 }, to: { x: 4, y: 0, z: 1 } }]);

    const { Party } = require('../kernel/core/entities/party.js');
    const { Player } = require('../kernel/core/entities/player.js');

    const party = new Party({
        waypoints: [
            { x: 0, y: 0, z: 0 },
            { x: 4, y: 0, z: 1 }
        ]
    });
    const leader = new Player({
        id: 201,
        name: 'Lead',
        isLeader: true,
        tile: { x: 0, y: 0, z: 0 },
        speed: 220
    });
    const follower = new Player({
        id: 202,
        name: 'Follow',
        isLeader: false,
        tile: { x: 1, y: 0, z: 0 },
        speed: 220
    });
    const ents = new Map([
        [201, leader],
        [202, follower]
    ]);
    tm.resolveEntity = (id) => ents.get(id) || null;

    party.addMember(leader);
    party.addMember(follower);
    assert.ok(tm.moveEntityToTile(leader, 0, 0, 0));
    assert.ok(tm.moveEntityToTile(follower, 1, 0, 0));

    // Ghost-walk both along corridor to stair pad (stack through), then hop.
    let frames = 0;
    while (
        !(String(leader.tile.z) === '1' && String(follower.tile.z) === '1') &&
        frames < 80
    ) {
        leader.moveDelay = 0;
        follower.moveDelay = 0;
        party.stepMember(tm, leader);
        party.stepMember(tm, follower);
        frames++;
    }
    assert.strictEqual(String(leader.tile.z), '1', 'leader climbed');
    assert.strictEqual(String(follower.tile.z), '1', 'follower climbed');
    assert.strictEqual(leader.tile.x, 4, 'leader on dest pad');
    assert.strictEqual(follower.tile.x, 4, 'follower stacked on dest pad');
    const stack = tm.getCombatants(4, 0, 1);
    assert.ok(
        stack.indexOf(201) >= 0 && stack.indexOf(202) >= 0,
        'both players on stair dest stack'
    );
    log('party stack corridor+stair ok', { frames, stack });
}

async function testSimInstallsStairs() {
    setActiveMode('standard');
    const exp = expandHunt(loadHunt('cave_crawl_multifloor'), { seed: 7 });
    assert.ok(exp.stairLinks && exp.stairLinks.length >= 1);

    const sim = new Simulator({
        seed: 7,
        floors: exp.floors,
        floorLayers: exp.floorLayers,
        stairLinks: exp.stairLinks,
        navmeshData: exp.navmeshData || null,
        combatAi: false
    });
    await sim.loadMaps();
    assert.ok(sim.tileMap, 'tileMap');
    const listed = sim.tileMap.listStairs();
    assert.ok(listed.length >= 2, 'bidirectional stairs installed');
    const link = exp.stairLinks[0];
    assert.ok(
        sim.tileMap.isStair(link.from.x, link.from.y, link.from.z),
        'from pad on map'
    );
    assert.ok(
        sim.tileMap.isStair(link.to.x, link.to.y, link.to.z),
        'to pad on map'
    );
    if (exp.navmeshData && exp.navmeshData.points) {
        assert.ok(sim.tileMap.navmesh, 'navmesh attached');
    }
    sim.destroy();
    log('sim installs stairs ok', { stairs: listed.length });
}

async function main() {
    testStairSocketsOnPieces();
    testFloorChainNormalize();
    testPairStairs();
    testGenerateMultiFloor();
    testBiomeFloorsAndArtSet();
    testExpandHuntMultifloor();
    testLegacyMultifloor();
    await testSimLoadsBothFloors();
    testNavmeshCrossFloorExpand();
    testPartyStairHop();
    testFirstClassStairTiles();
    testFollowLongPathStairHop();
    testFollowerStepTowardFloor();
    testFollowLeaderCrossFloorAi();
    testFollowLeaderTrailSlot();
    testFollowLeaderMultiSlotTrail();
    testPartyStackCorridorAndStair();
    await testSimInstallsStairs();
    console.log('dungeon_multifloor: ok');
}

main().catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
});
