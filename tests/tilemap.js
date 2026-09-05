#!/usr/bin/env node
/**
 * Stage 1 exit criteria: path PNG → flat friction grid; walkable vs blocked;
 * occupancy helpers; no nested data[z][y][x] object tiles.
 * Quiet on success; VERBOSE=1 for detail.
 */

'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { PATHS, mapPathPng, Settings } = require('../kernel/settings.js');
const { ImageDB } = require('../kernel/core/lib/imagedb.js');
const {
    resolveSpriteUrl,
    defaultTileVariantForDisplay
} = require('../kernel/core/lib/creature_sprites.js');
const {
    createEmptyTileMapFloor,
    setSubLayerCell,
    normalizePaletteEntry
} = require('../kernel/core/lib/dungeon/tilemap_bake.js');
const {
    TileMap,
    FRICTION_BLOCKED,
    SIGHT_BLOCKED,
    SIGHT_CLEAR,
    TILE_FLAG_NO_CAST,
    TILE_FLAG_STAIR,
    TILE_FLAG_LADDER,
    TILE_FLAG_HOLE,
    TILE_FLAG_NO_CREATURE,
    TILE_FLAG_PZ_PACKAGE,
    frictionFromPixel,
    collisionFromPixel,
    registerVerticalFromPlacement,
    reverseHopDir,
    hopsOnStep,
    playerHopsOnStep
} = require('../kernel/core/entities/tilemap.js');

const VERBOSE = !!process.env.VERBOSE;

function log(...args) {
    if (VERBOSE) console.log(...args);
}

/** Build a tiny RGBA buffer (row-major) from [r,g,b] or [r,g,b,a] pixels. */
function rgbaFromPixels(cols, rows, pixels) {
    const out = new Uint8Array(cols * rows * 4);
    for (let i = 0; i < cols * rows; i++) {
        const p = pixels[i];
        const o = i * 4;
        out[o] = p[0];
        out[o + 1] = p[1];
        out[o + 2] = p[2];
        out[o + 3] = p[3] !== undefined ? p[3] : 255;
    }
    return out;
}

function testFrictionFromPixel() {
    assert.strictEqual(frictionFromPixel(255, 255, 0), FRICTION_BLOCKED, 'yellow blocked');
    assert.strictEqual(frictionFromPixel(255, 255, 255), FRICTION_BLOCKED, 'white blocked');
    assert.strictEqual(frictionFromPixel(200, 100, 50), FRICTION_BLOCKED, 'non-gray blocked');
    assert.strictEqual(frictionFromPixel(150, 150, 150), 150, 'gray friction');
    assert.strictEqual(frictionFromPixel(0, 0, 0), 0, 'black is walkable friction 0');
    assert.strictEqual(
        frictionFromPixel(254, 254, 254),
        250,
        'gray >250 clamped to table max'
    );
    assert.strictEqual(Settings.FRICTION_BLOCKED, FRICTION_BLOCKED);

    const water = collisionFromPixel(0, 255, 255);
    assert.strictEqual(water.friction, FRICTION_BLOCKED);
    assert.strictEqual(water.sight, SIGHT_CLEAR);
    assert.strictEqual(water.flags, 0);

    const grate = collisionFromPixel(255, 0, 255);
    assert.strictEqual(grate.friction, 100);
    assert.strictEqual(grate.sight, SIGHT_BLOCKED);

    const pz = collisionFromPixel(0, 255, 0);
    assert.strictEqual(pz.friction, 100);
    assert.strictEqual(pz.sight, SIGHT_CLEAR);
    assert.strictEqual(pz.flags, TILE_FLAG_NO_CAST);

    const wall = collisionFromPixel(255, 255, 0);
    assert.strictEqual(wall.sight, SIGHT_BLOCKED);
    log('frictionFromPixel / collisionFromPixel ok');
}

function testSyntheticGridEncoding() {
    // 3x2 map:
    // yellow | gray150 | white
    // non-gray | gray100 | gray200
    const cols = 3;
    const rows = 2;
    const rgba = rgbaFromPixels(cols, rows, [
        [255, 255, 0],
        [150, 150, 150],
        [255, 255, 255],
        [10, 20, 30],
        [100, 100, 100],
        [200, 200, 200]
    ]);

    const map = new TileMap();
    const layer = map.loadFloorFromRgba('test', cols, rows, rgba);

    assert.ok(layer.friction instanceof Uint8Array, 'friction is Uint8Array');
    assert.ok(layer.occupancy instanceof Int32Array, 'occupancy is Int32Array');
    assert.strictEqual(layer.cols, 3);
    assert.strictEqual(layer.rows, 2);
    assert.strictEqual(layer.friction.length, 6);

    // No nested object grid
    assert.strictEqual(map.layers.test.friction[0], FRICTION_BLOCKED);
    assert.strictEqual(typeof map.layers.test[0], 'undefined');

    assert.strictEqual(map.getFriction(0, 0, 'test'), FRICTION_BLOCKED);
    assert.strictEqual(map.isWalkable(0, 0, 'test'), false);

    assert.strictEqual(map.getFriction(1, 0, 'test'), 150);
    assert.strictEqual(map.isWalkable(1, 0, 'test'), true);

    assert.strictEqual(map.getFriction(2, 0, 'test'), FRICTION_BLOCKED);
    assert.strictEqual(map.isWalkable(2, 0, 'test'), false);

    assert.strictEqual(map.getFriction(0, 1, 'test'), FRICTION_BLOCKED);
    assert.strictEqual(map.getFriction(1, 1, 'test'), 100);
    assert.strictEqual(map.getFriction(2, 1, 'test'), 200);

    // Default couple: yellow wall blocks sight; gray floor open
    assert.strictEqual(map.blocksSight(0, 0, 'test'), true, 'wall blocks sight');
    assert.strictEqual(map.blocksSight(1, 0, 'test'), false, 'floor clear sight');
    assert.ok(layer.sight instanceof Uint8Array, 'sight is Uint8Array');
    assert.ok(layer.flags instanceof Uint8Array, 'flags is Uint8Array');

    assert.strictEqual(map.index(2, 1, cols), 5);
    assert.strictEqual(map.inBounds(2, 1, 'test'), true);
    assert.strictEqual(map.inBounds(3, 0, 'test'), false);
    assert.strictEqual(map.inBounds(-1, 0, 'test'), false);
    assert.strictEqual(map.getFriction(99, 99, 'test'), FRICTION_BLOCKED);
    assert.strictEqual(map.getFriction(0, 0, 'missing'), FRICTION_BLOCKED);

    log('synthetic grid ok');
}

function testOccupancyHelpers() {
    const cols = 2;
    const rows = 1;
    const rgba = rgbaFromPixels(cols, rows, [
        [120, 120, 120],
        [120, 120, 120]
    ]);
    const map = new TileMap();
    map.loadFloorFromRgba(0, cols, rows, rgba);

    assert.strictEqual(map.canEnter(0, 0, 0, 1), true);
    assert.strictEqual(map.tryOccupy(0, 0, 0, 1), true);
    assert.strictEqual(map.getOccupant(0, 0, 0), 1);
    assert.strictEqual(map.canEnter(0, 0, 0, 2), false, 'occupied by other');
    assert.strictEqual(map.tryOccupy(0, 0, 0, 2), false);
    assert.strictEqual(map.canEnter(0, 0, 0, 1), true, 'self may re-enter');
    assert.strictEqual(map.tryOccupy(0, 0, 0, { id: 1 }), true);

    assert.strictEqual(map.release(0, 0, 0, 2), false, 'wrong id');
    assert.strictEqual(map.release(0, 0, 0, 1), true);
    assert.strictEqual(map.getOccupant(0, 0, 0), 0);
    assert.strictEqual(map.tryOccupy(0, 0, 0, 2), true);

    // Blocked tile never occupies
    const blocked = new TileMap();
    blocked.loadFloorFromRgba(
        'b',
        1,
        1,
        rgbaFromPixels(1, 1, [[255, 255, 0]])
    );
    assert.strictEqual(blocked.canEnter(0, 0, 'b', 1), false);
    assert.strictEqual(blocked.tryOccupy(0, 0, 'b', 1), false);

    map.clearOccupancy(0);
    assert.strictEqual(map.getOccupant(0, 0, 0), 0);

    log('occupancy ok');
}

async function testLoadRealFloor07() {
    const filePath = mapPathPng('07');
    assert.ok(
        fs.existsSync(filePath),
        `sample map missing: ${filePath} (expected under assets/legacy/maps/v01/)`
    );
    assert.ok(
        PATHS.maps.includes(`${path.sep}legacy${path.sep}maps${path.sep}v01`) ||
            PATHS.maps.endsWith(`${path.sep}v01`) ||
            PATHS.maps.endsWith('/v01'),
        `PATHS.maps should be assets/legacy/maps/v01, got ${PATHS.maps}`
    );

    const map = new TileMap();
    const layer = await map.loadFloor('07', filePath);

    assert.strictEqual(layer.cols, 2560);
    assert.strictEqual(layer.rows, 2048);
    assert.ok(layer.friction instanceof Uint8Array);
    assert.strictEqual(layer.friction.length, 2560 * 2048);
    // No nested object rows
    assert.strictEqual(map.layers['07'].friction, layer.friction);
    assert.strictEqual(typeof map.layers['07'][0], 'undefined');

    // Synthetic OSS reference samples (bin/build_legacy_map_reference.py)
    assert.strictEqual(map.getFriction(0, 0, '07'), FRICTION_BLOCKED, 'origin yellow');
    assert.strictEqual(map.isWalkable(0, 0, '07'), false);

    // Friction legend strip
    assert.strictEqual(map.getFriction(100, 20, '07'), 255);
    assert.strictEqual(map.getFriction(180, 20, '07'), 255);
    assert.strictEqual(map.getFriction(220, 20, '07'), 255);

    // Far-corner + documented mid samples
    assert.strictEqual(map.getFriction(2006, 9, '07'), 255);
    assert.strictEqual(map.isWalkable(2006, 9, '07'), false);
    assert.strictEqual(map.getFriction(1754, 12, '07'), 255);
    assert.strictEqual(map.getFriction(1876, 14, '07'), 100);
    assert.strictEqual(map.getFriction(1734, 18, '07'), 255);
    assert.strictEqual(map.getFriction(2039, 27, '07'), 255);
    assert.strictEqual(map.getFriction(329, 28, '07'), 100);
    assert.strictEqual(map.getFriction(1728, 32, '07'), 255);

    // Corridor + dens (party walk / spawn regions)
    assert.strictEqual(map.getFriction(260, 96, '07'), 100);
    assert.strictEqual(map.isWalkable(260, 96, '07'), true);
    assert.strictEqual(map.getFriction(282, 96, '07'), 100);
    assert.strictEqual(map.getFriction(470, 845, '07'), 100);
    assert.strictEqual(map.getFriction(256, 64, '07'), 100);
    assert.ok(map.inBounds(2559, 2047, '07'));
    assert.strictEqual(map.inBounds(2560, 0, '07'), false);

    log('floor-07 load ok', { cols: layer.cols, rows: layer.rows });
}

function testFirstClassStairs() {
    const map = new TileMap('stairs');
    const open = new Uint8Array(9);
    open.fill(100);
    map.loadFloorFromFriction(0, 3, 3, open);
    map.loadFloorFromFriction(1, 3, 3, open);

    map.setStairs([
        { from: { x: 1, y: 1, z: 0 }, to: { x: 1, y: 1, z: 1 }, link: 'main' }
    ]);

    assert.ok(map.isStair(1, 1, 0), 'from pad is stair');
    assert.ok(map.isStair(1, 1, 1), 'to pad is stair (bidirectional)');
    const dest = map.getStair(1, 1, 0);
    assert.ok(dest);
    assert.strictEqual(dest.x, 1);
    assert.strictEqual(dest.y, 1);
    assert.strictEqual(String(dest.z), '1');

    const toward = map.findStairToward(0, 1, 0, 0);
    assert.ok(toward);
    assert.strictEqual(toward.x, 1);
    assert.strictEqual(toward.y, 1);

    const entity = {
        id: 7,
        tile: { x: 1, y: 1, z: 0 },
        path: []
    };
    assert.ok(map.tryOccupy(1, 1, 0, 7));
    assert.ok(map.tryUseStair(entity, { x: 1, y: 1, z: 1 }), 'hop down');
    assert.strictEqual(String(entity.tile.z), '1');
    assert.strictEqual(map.getOccupant(1, 1, 0), 0, 'released upper');
    assert.strictEqual(map.getOccupant(1, 1, 1), 7, 'occupied lower');

    const listed = map.listStairs();
    assert.ok(listed.length >= 2, 'both directions listed');

    // Party stack: second hop joins exact dest pad (player–player stack)
    {
        const map2 = new TileMap('stairs_party');
        const open2 = new Uint8Array(25);
        open2.fill(100);
        map2.loadFloorFromFriction(0, 5, 5, open2);
        map2.loadFloorFromFriction(1, 5, 5, open2);
        map2.addStair(
            { x: 2, y: 2, z: 0 },
            { x: 2, y: 2, z: 1 },
            { dir: 'down', link: 'portal', bidirectional: false }
        );
        const ents = new Map();
        map2.resolveEntity = (id) => ents.get(id) || null;
        const a = {
            id: 11,
            type: 'player',
            tile: { x: 2, y: 2, z: 1 },
            path: [],
            alive: true
        };
        const b = {
            id: 12,
            type: 'player',
            tile: { x: 2, y: 2, z: 0 },
            path: [],
            alive: true
        };
        ents.set(11, a);
        ents.set(12, b);
        assert.ok(map2.tryOccupy(2, 2, 1, a), 'first member already on dest');
        assert.ok(map2.tryOccupy(2, 2, 0, b), 'second on from pad');
        assert.ok(
            map2.tryUseStair(b, null),
            'second hop succeeds when dest occupied'
        );
        assert.strictEqual(String(b.tile.z), '1', 'second member changes floor');
        assert.strictEqual(b.tile.x, 2, 'exact dest x');
        assert.strictEqual(b.tile.y, 2, 'exact dest y');
        assert.deepStrictEqual(
            map2.getCombatants(2, 2, 1),
            [11, 12],
            'both players stacked on pad'
        );
        assert.strictEqual(
            map2.getFirstOccupant(2, 2, 1),
            11,
            'first still tile controller'
        );
    }

    log('first-class stairs ok', listed.length);
}

function testStairLinkBidirectionalOverride() {
    const open = new Uint8Array(9);
    open.fill(100);

    const oneWay = new TileMap('stairs_one_way');
    oneWay.loadFloorFromFriction(0, 3, 3, open);
    oneWay.loadFloorFromFriction(1, 3, 3, open);
    oneWay.addStairLinks(
        [
            {
                from: { x: 1, y: 1, z: 0 },
                to: { x: 1, y: 1, z: 1 },
                dir: 'center',
                bidirectional: false
            }
        ]
        // opts default is bidirectional — per-link false must win
    );
    assert.ok(oneWay.isStair(1, 1, 0), 'forward pad');
    assert.ok(
        !oneWay.isStair(1, 1, 1),
        'per-link bidirectional false skips reverse pad'
    );

    const forced = new TileMap('stairs_forced_bi');
    forced.loadFloorFromFriction(0, 3, 3, open);
    forced.loadFloorFromFriction(1, 3, 3, open);
    forced.addStairLinks(
        [
            {
                from: { x: 1, y: 1, z: 0 },
                to: { x: 1, y: 1, z: 1 },
                dir: 'center',
                bidirectional: true
            }
        ],
        { bidirectional: false }
    );
    assert.ok(forced.isStair(1, 1, 0));
    assert.ok(
        forced.isStair(1, 1, 1),
        'per-link bidirectional true wins over opts false'
    );
    log('stair link bidirectional override ok');
}

/**
 * Phase A: hybrid player stacks, noPlayerStack, mixed stair, creature block.
 */
function testPlayerTileStack() {
    const map = new TileMap('stack');
    const open = new Uint8Array(9);
    open.fill(100);
    map.loadFloorFromFriction(0, 3, 3, open);
    const ents = new Map();
    map.resolveEntity = (id) => ents.get(id) || null;

    function mkPlayer(id, x, y) {
        const p = {
            id,
            type: 'player',
            alive: true,
            tile: { x, y, z: 0 },
            path: [],
            speed: 200
        };
        ents.set(id, p);
        return p;
    }
    function mkCreature(id, x, y, extra) {
        const c = Object.assign(
            {
                id,
                type: 'creature',
                alive: true,
                tile: { x, y, z: 0 },
                path: [],
                speed: 100,
                hp: { current: 50, max: 50 },
                flags: {}
            },
            extra || {}
        );
        ents.set(id, c);
        return c;
    }

    const p1 = mkPlayer(1, 0, 0);
    const p2 = mkPlayer(2, 1, 0);
    assert.ok(map.tryOccupy(0, 0, 0, p1));
    assert.ok(map.canEnter(0, 0, 0, p2), 'player may join player tile');
    assert.ok(map.moveEntityToTile(p2, 0, 0, 0));
    assert.deepStrictEqual(map.getCombatants(0, 0, 0), [1, 2]);
    assert.strictEqual(map.getFirstOccupant(0, 0, 0), 1);
    assert.strictEqual(map.getOccupant(0, 0, 0), 1);

    // Promote on leave
    assert.ok(map.leaveTile(0, 0, 0, p1));
    assert.deepStrictEqual(map.getCombatants(0, 0, 0), [2]);
    assert.strictEqual(map.getFirstOccupant(0, 0, 0), 2);
    assert.ok(!map.playerStacks.has(map.tileStackKey(0, 0, 0)));

    // Creature cannot enter player tile
    const rat = mkCreature(10, 2, 0);
    assert.ok(map.tryOccupy(2, 0, 0, rat));
    assert.strictEqual(map.canEnter(0, 0, 0, rat), false, 'creature vs player');
    assert.strictEqual(map.moveEntityToTile(rat, 0, 0, 0), false);

    // Player cannot normal-walk onto creature
    const p3 = mkPlayer(3, 1, 1);
    assert.ok(map.tryOccupy(1, 1, 0, p3));
    assert.strictEqual(map.canEnter(2, 0, 0, p3), false, 'player vs creature walk');

    // noPlayerStack denies second player
    map.clearOccupancy(0);
    ents.clear();
    const a = mkPlayer(21, 0, 0);
    const b = mkPlayer(22, 1, 0);
    map.setNoPlayerStack(0, 0, 0, true);
    assert.ok(map.tryOccupy(0, 0, 0, a));
    assert.strictEqual(map.canEnter(0, 0, 0, b), false, 'noPlayerStack');
    assert.strictEqual(map.moveEntityToTile(b, 0, 0, 0), false);

    // Max stack
    map.setNoPlayerStack(0, 0, 0, false);
    map.clearOccupancy(0);
    ents.clear();
    const prevMax = Settings.PLAYER_TILE_MAX_STACK;
    Settings.PLAYER_TILE_MAX_STACK = 2;
    try {
        const m1 = mkPlayer(31, 0, 0);
        const m2 = mkPlayer(32, 1, 0);
        const m3 = mkPlayer(33, 2, 0);
        assert.ok(map.tryOccupy(0, 0, 0, m1));
        assert.ok(map.moveEntityToTile(m2, 0, 0, 0));
        assert.strictEqual(map.canEnter(0, 0, 0, m3), false, 'max stack 2');
    } finally {
        Settings.PLAYER_TILE_MAX_STACK = prevMax;
    }

    // Mixed stair: player lands on creature
    map.clearOccupancy(0);
    ents.clear();
    map.loadFloorFromFriction(1, 3, 3, open);
    map.addStair(
        { x: 1, y: 1, z: 0 },
        { x: 1, y: 1, z: 1 },
        { bidirectional: false }
    );
    const beast = mkCreature(40, 1, 1, { tile: { x: 1, y: 1, z: 1 } });
    const climber = mkPlayer(41, 1, 1);
    climber.tile = { x: 1, y: 1, z: 0 };
    assert.ok(map.tryOccupy(1, 1, 1, beast));
    assert.ok(map.tryOccupy(1, 1, 0, climber));
    assert.ok(map.tryUseStair(climber, null), 'stair mixed onto creature');
    assert.deepStrictEqual(map.getCombatants(1, 1, 1), [40, 41]);
    assert.strictEqual(map.getFirstOccupant(1, 1, 1), 40);
    // Second creature cannot enter mixed
    const other = mkCreature(42, 0, 0, { tile: { x: 0, y: 0, z: 1 } });
    assert.ok(map.tryOccupy(0, 0, 1, other));
    assert.strictEqual(map.canEnter(1, 1, 1, other), false, 'no second creature on mixed');

    // Leave creature from mixed → players remain
    assert.ok(map.leaveTile(1, 1, 1, beast));
    assert.deepStrictEqual(map.getCombatants(1, 1, 1), [41]);

    log('player tile stack ok');
}

/**
 * Phase A: canPushCreatures / pushable / crush / summons.
 */
function testCreaturePush() {
    const map = new TileMap('push');
    const open = new Uint8Array(25);
    open.fill(100);
    map.loadFloorFromFriction(0, 5, 5, open);
    const ents = new Map();
    map.resolveEntity = (id) => ents.get(id) || null;

    function mk(id, x, y, opts) {
        const o = opts || {};
        const c = {
            id,
            type: 'creature',
            alive: true,
            tile: { x, y, z: 0 },
            path: [],
            speed: 100,
            hp: { current: 40, max: 40 },
            flags: {
                canPushCreatures: o.canPushCreatures === true,
                pushable: o.pushable !== false
            },
            masterId: o.masterId != null && o.masterId > 0 ? o.masterId : null
        };
        if (o.pushable === false) c.flags.pushable = false;
        if (o.canPushCreatures === true) c.flags.canPushCreatures = true;
        ents.set(id, c);
        return c;
    }

    // Pusher shoves pushable into free neighbor
    const pusher = mk(1, 0, 2, { canPushCreatures: true });
    const victim = mk(2, 1, 2, { pushable: true });
    assert.ok(map.tryOccupy(0, 2, 0, pusher));
    assert.ok(map.tryOccupy(1, 2, 0, victim));
    assert.ok(map.canEnter(1, 2, 0, pusher), 'pusher can enter pushable tile');
    assert.ok(map.moveEntityToTile(pusher, 1, 2, 0), 'push enter');
    assert.strictEqual(map.getOccupant(1, 2, 0), 1, 'pusher owns tile');
    assert.strictEqual(map.getCombatants(1, 2, 0).length, 1, 'no creature stack');
    assert.ok(
        victim.tile.x !== 1 || victim.tile.y !== 2,
        'victim shoved off'
    );
    assert.strictEqual(victim.alive, true, 'shove not crush when free neighbor');

    // Unpushable blocks
    map.clearOccupancy(0);
    ents.clear();
    const p2 = mk(3, 0, 0, { canPushCreatures: true });
    const rock = mk(4, 1, 0, { pushable: false });
    assert.ok(map.tryOccupy(0, 0, 0, p2));
    assert.ok(map.tryOccupy(1, 0, 0, rock));
    assert.strictEqual(map.canEnter(1, 0, 0, p2), false, 'unpushable hard block');

    // Summon cannot push
    map.clearOccupancy(0);
    ents.clear();
    const sum = mk(5, 0, 1, { canPushCreatures: true, masterId: 99 });
    const prey = mk(6, 1, 1, { pushable: true });
    assert.ok(map.tryOccupy(0, 1, 0, sum));
    assert.ok(map.tryOccupy(1, 1, 0, prey));
    assert.strictEqual(map.canEnter(1, 1, 0, sum), false, 'summon cannot push');

    // No canPushCreatures flag → deny
    map.clearOccupancy(0);
    ents.clear();
    const meek = mk(7, 0, 2, {});
    const soft = mk(8, 1, 2, { pushable: true });
    assert.ok(map.tryOccupy(0, 2, 0, meek));
    assert.ok(map.tryOccupy(1, 2, 0, soft));
    assert.strictEqual(map.canEnter(1, 2, 0, meek), false, 'no push flag');

    // Crush when no free *orthogonal* neighbor (legacy shove is N/W/E/S only).
    // Diagonal approach: after mover leaves origin, origin is diagonal to victim
    // so it is not a valid shove target → crush.
    map.clearOccupancy(0);
    ents.clear();
    const fr = new Uint8Array(9);
    fr.fill(255);
    fr[0 * 3 + 0] = 100; // (0,0) crusher
    fr[1 * 3 + 1] = 100; // (1,1) victim
    map.loadFloorFromFriction(0, 3, 3, fr);
    const crush = mk(11, 0, 0, { canPushCreatures: true });
    const doomed = mk(12, 1, 1, { pushable: true });
    assert.ok(map.tryOccupy(0, 0, 0, crush));
    assert.ok(map.tryOccupy(1, 1, 0, doomed));
    assert.ok(map.moveEntityToTile(crush, 1, 1, 0), 'crush enter');
    assert.strictEqual(map.getOccupant(1, 1, 0), 11);
    assert.strictEqual(doomed.alive, false, 'crushed');
    assert.strictEqual(doomed.hp.current, 0);
    assert.strictEqual(map.getOccupant(0, 0, 0), 0, 'crusher left origin');

    // Player tile never pushable
    {
        const fr2 = new Uint8Array(9);
        fr2.fill(100);
        map.loadFloorFromFriction(0, 3, 3, fr2);
    }
    map.clearOccupancy(0);
    ents.clear();
    const bully = mk(20, 0, 0, { canPushCreatures: true });
    const hero = {
        id: 21,
        type: 'player',
        alive: true,
        tile: { x: 1, y: 0, z: 0 },
        path: [],
        speed: 200
    };
    ents.set(20, bully);
    ents.set(21, hero);
    assert.ok(map.tryOccupy(0, 0, 0, bully));
    assert.ok(map.tryOccupy(1, 0, 0, hero));
    assert.strictEqual(map.canEnter(1, 0, 0, bully), false, 'never push player');

    log('creature push ok');
}

/**
 * Multi-floor watch: cameraTileZ selects which layer TileMap paints.
 */
function testCameraTileZSelectsFloor() {
    const prevHeadless = Settings.HEADLESS;
    const prevZ = Settings.cameraTileZ;
    const prevX = Settings.cameraTileX;
    const prevY = Settings.cameraTileY;
    try {
        Settings.HEADLESS = false;
        Settings.cameraTileX = null;
        Settings.cameraTileY = null;
        const map = new TileMap();
        const a = new Uint8Array(16);
        a.fill(100);
        const b = new Uint8Array(16);
        b.fill(50);
        map.loadFloorFromFriction(0, 4, 4, a);
        map.loadFloorFromFriction(1, 4, 4, b);
        const g = {
            fillStyle: '',
            fillRect() {},
            drawImage() {}
        };

        Settings.cameraTileZ = null;
        map.render(g);
        assert.strictEqual(String(map._viewZ), '0', 'default first layer');

        Settings.cameraTileZ = 1;
        map.render(g);
        assert.strictEqual(String(map._viewZ), '1', 'camera z selects floor 1');

        Settings.cameraTileZ = '0';
        map.render(g);
        assert.strictEqual(String(map._viewZ), '0', 'camera z selects floor 0');
        log('cameraTileZ floor select ok');
    } finally {
        Settings.HEADLESS = prevHeadless;
        Settings.cameraTileZ = prevZ;
        Settings.cameraTileX = prevX;
        Settings.cameraTileY = prevY;
    }
}

/**
 * @returns {{
 *   resolveTilemapViewport: Function,
 *   computeTilemapCacheRect: Function,
 *   tilemapCacheNeedsRebuild: Function
 * }}
 */
function cacheHelpers() {
    return require('../kernel/core/entities/tilemap.js');
}

/**
 * Pure math: full vs overscan rect + edge rebuild gate.
 */
function testRenderCacheMath() {
    const {
        resolveTilemapViewport,
        computeTilemapCacheRect,
        tilemapCacheNeedsRebuild
    } = cacheHelpers();

    const small = { cols: 32, rows: 32 };
    const viewNw = resolveTilemapViewport(small, {
        tileWidth: 32,
        tileHeight: 32,
        appWidth: 320,
        appHeight: 240,
        cameraTileX: null,
        cameraTileY: null
    });
    assert.strictEqual(viewNw.originX, 0, 'nw origin x');
    assert.strictEqual(viewNw.originY, 0, 'nw origin y');
    assert.strictEqual(viewNw.viewCols, 10, 'view cols from canvas');
    assert.strictEqual(viewNw.viewRows, 8, 'view rows from canvas');

    // Fractional camera origin (smooth step-slide follow) must not snap to integers
    const viewFrac = resolveTilemapViewport(small, {
        tileWidth: 32,
        tileHeight: 32,
        appWidth: 320,
        appHeight: 240,
        cameraTileX: 3.25,
        cameraTileY: 1.75
    });
    assert.ok(
        Math.abs(viewFrac.originX - 3.25) < 1e-9,
        `fractional originX kept, got ${viewFrac.originX}`
    );
    assert.ok(
        Math.abs(viewFrac.originY - 1.75) < 1e-9,
        `fractional originY kept, got ${viewFrac.originY}`
    );

    const full = computeTilemapCacheRect(small, viewNw, { fullMaxTiles: 6400 });
    assert.strictEqual(full.mode, 'full', 'small map full cache');
    assert.strictEqual(full.w, 32);
    assert.strictEqual(full.h, 32);
    assert.strictEqual(
        tilemapCacheNeedsRebuild(viewNw, full, small),
        false,
        'full never rebuilds for pan'
    );

    const large = { cols: 200, rows: 200 };
    const view = {
        originX: 40,
        originY: 40,
        viewCols: 20,
        viewRows: 15
    };
    const over = computeTilemapCacheRect(large, view, {
        fullMaxTiles: 100,
        marginMin: 8
    });
    assert.strictEqual(over.mode, 'overscan', 'large map overscan');
    assert.ok(over.w >= view.viewCols + 16, 'margin x');
    assert.ok(over.h >= view.viewRows + 16, 'margin y');
    assert.ok(over.x <= view.originX, 'cache covers view left');
    assert.ok(over.y <= view.originY, 'cache covers view top');
    assert.ok(
        over.x + over.w >= view.originX + view.viewCols,
        'cache covers view right'
    );
    assert.ok(
        over.y + over.h >= view.originY + view.viewRows,
        'cache covers view bottom'
    );

    // Centered in cache → no rebuild (tripMargin 0)
    assert.strictEqual(
        tilemapCacheNeedsRebuild(view, over, large),
        false,
        'stable overscan interior'
    );

    // One tile inside the hard edge still contained → no rebuild
    const almostEdge = {
        originX: over.x + over.w - view.viewCols,
        originY: view.originY,
        viewCols: view.viewCols,
        viewRows: view.viewRows
    };
    assert.strictEqual(
        tilemapCacheNeedsRebuild(almostEdge, over, large),
        false,
        'flush with cache edge still contained'
    );

    // Optional tripMargin rebuilds early inside the cache
    assert.strictEqual(
        tilemapCacheNeedsRebuild(almostEdge, over, large, { tripMargin: 2 }),
        true,
        'tripMargin early rebuild'
    );

    // Outside cache always rebuilds
    const outside = {
        originX: over.x + over.w - view.viewCols + 1,
        originY: view.originY,
        viewCols: view.viewCols,
        viewRows: view.viewRows
    };
    assert.strictEqual(
        tilemapCacheNeedsRebuild(outside, over, large),
        true,
        'outside cache rebuilds'
    );

    log('render cache math ok');
}

/**
 * Minimal offscreen surface for Node tests (no DOM canvas).
 * @param {number} w
 * @param {number} h
 */
function mockCacheSurface(w, h) {
    const canvas = { width: w, height: h };
    /** @type {object[]} */
    const ops = [];
    const ctx = {
        canvas,
        fillStyle: '',
        ops,
        clearRect(x, y, cw, ch) {
            ops.push({ t: 'clear', x, y, w: cw, h: ch });
        },
        fillRect(x, y, fw, fh) {
            ops.push({ t: 'fill', x, y, w: fw, h: fh, style: this.fillStyle });
        },
        drawImage() {
            ops.push({ t: 'drawImage' });
        }
    };
    return { canvas, ctx, ops };
}

/**
 * Integration: full-map cache blits once per frame; pan does not rebuild.
 * Overscan rebuilds when camera approaches edge.
 */
function testRenderCacheBlitAndRebuild() {
    const prev = {
        HEADLESS: Settings.HEADLESS,
        cameraTileX: Settings.cameraTileX,
        cameraTileY: Settings.cameraTileY,
        cameraTileZ: Settings.cameraTileZ,
        tileWidth: Settings.tileWidth,
        tileHeight: Settings.tileHeight,
        fullMax: Settings.TILEMAP_CACHE_FULL_MAX_TILES,
        margin: Settings.TILEMAP_CACHE_MARGIN_MIN,
        app: Settings.app
    };
    try {
        Settings.HEADLESS = false;
        Settings.tileWidth = 8;
        Settings.tileHeight = 8;
        Settings.cameraTileZ = null;
        Settings.TILEMAP_CACHE_FULL_MAX_TILES = 6400;
        Settings.TILEMAP_CACHE_MARGIN_MIN = 4;
        Settings.app = { width: 80, height: 64 }; // 10×8 tiles

        // --- full map (16×16 < 6400) ---
        const map = new TileMap();
        const fr = new Uint8Array(16 * 16);
        fr.fill(80);
        map.loadFloorFromFriction(0, 16, 16, fr);
        assert.strictEqual(map._renderCacheDirty, true, 'load dirties cache');

        /** @type {object[]} */
        const blits = [];
        const g = {
            canvas: { width: 80, height: 64 },
            fillStyle: '',
            fillRect() {},
            drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh) {
                blits.push({ img, sx, sy, sw, sh, dx, dy, dw, dh });
            }
        };
        map._allocRenderCache = (pw, ph) => mockCacheSurface(pw, ph);

        Settings.cameraTileX = 0;
        Settings.cameraTileY = 0;
        map.render(g);
        assert.strictEqual(map._renderCacheRebuilds, 1, 'first paint rebuilds');
        assert.ok(map._renderCache, 'cache object set');
        assert.strictEqual(map._renderCache.mode, 'full', 'full mode');
        assert.strictEqual(blits.length, 1, 'one blit');
        assert.strictEqual(blits[0].sx, 0);
        assert.strictEqual(blits[0].sw, 10 * 8);

        Settings.cameraTileX = 3;
        Settings.cameraTileY = 2;
        map.render(g);
        assert.strictEqual(map._renderCacheRebuilds, 1, 'pan full: no rebuild');
        assert.strictEqual(blits.length, 2, 'second blit');
        assert.strictEqual(blits[1].sx, 3 * 8, 'blit sx follows camera');
        assert.strictEqual(blits[1].sy, 2 * 8, 'blit sy follows camera');

        // Sub-tile pan: blit source offset is fractional (smooth camera)
        Settings.cameraTileX = 3.5;
        Settings.cameraTileY = 2.25;
        map.render(g);
        assert.strictEqual(map._renderCacheRebuilds, 1, 'fractional pan full: no rebuild');
        assert.strictEqual(blits.length, 3, 'third blit');
        assert.ok(
            Math.abs(blits[2].sx - 3.5 * 8) < 1e-9,
            `fractional blit sx, got ${blits[2].sx}`
        );
        assert.ok(
            Math.abs(blits[2].sy - 2.25 * 8) < 1e-9,
            `fractional blit sy, got ${blits[2].sy}`
        );
        assert.ok(
            Math.abs(map._viewOriginX - 3.5) < 1e-9,
            'view origin x fractional for entity overlays'
        );

        map.invalidateRenderCache();
        map.render(g);
        assert.strictEqual(map._renderCacheRebuilds, 2, 'invalidate rebuilds');

        // --- overscan on large map ---
        Settings.TILEMAP_CACHE_FULL_MAX_TILES = 50; // force overscan
        const big = new TileMap();
        const bigFr = new Uint8Array(120 * 120);
        bigFr.fill(90);
        big.loadFloorFromFriction(0, 120, 120, bigFr);
        big._allocRenderCache = (pw, ph) => mockCacheSurface(pw, ph);

        const g2 = {
            canvas: { width: 80, height: 64 },
            fillStyle: '',
            fillRect() {},
            drawImage() {}
        };
        Settings.cameraTileX = 40;
        Settings.cameraTileY = 40;
        big.render(g2);
        assert.strictEqual(big._renderCache.mode, 'overscan', 'overscan mode');
        assert.strictEqual(big._renderCacheRebuilds, 1, 'overscan first');
        const firstRect = {
            x: big._renderCache.x,
            y: big._renderCache.y,
            w: big._renderCache.w,
            h: big._renderCache.h
        };

        // Small pan still inside overscan → no rebuild
        Settings.cameraTileX = 41;
        Settings.cameraTileY = 40;
        big.render(g2);
        assert.strictEqual(big._renderCacheRebuilds, 1, 'small pan no rebuild');

        // Leave the cache to the right → rebuild + re-center
        Settings.cameraTileX = Math.min(
            120 - 10,
            firstRect.x + firstRect.w - 10 + 1
        );
        Settings.cameraTileY = 40;
        big.render(g2);
        assert.ok(
            big._renderCacheRebuilds >= 2,
            'leaving overscan rebuilds'
        );
        assert.ok(
            big._renderCache.x !== firstRect.x ||
                big._renderCache.w !== firstRect.w ||
                big._renderCacheRebuilds >= 2,
            'cache recentered after leave'
        );

        log('render cache blit/rebuild ok');
    } finally {
        Settings.HEADLESS = prev.HEADLESS;
        Settings.cameraTileX = prev.cameraTileX;
        Settings.cameraTileY = prev.cameraTileY;
        Settings.cameraTileZ = prev.cameraTileZ;
        Settings.tileWidth = prev.tileWidth;
        Settings.tileHeight = prev.tileHeight;
        Settings.TILEMAP_CACHE_FULL_MAX_TILES = prev.fullMax;
        Settings.TILEMAP_CACHE_MARGIN_MIN = prev.margin;
        Settings.app = prev.app;
    }
}

/**
 * Failed overlay/wall PNGs must not keep pendingSprites (Hunt CPU leak).
 */
function testFailedArtDoesNotKeepPendingSprites() {
    const prev = {
        HEADLESS: Settings.HEADLESS,
        useEntitySprites: Settings.useEntitySprites,
        cameraTileX: Settings.cameraTileX,
        cameraTileY: Settings.cameraTileY,
        cameraTileZ: Settings.cameraTileZ,
        tileWidth: Settings.tileWidth,
        tileHeight: Settings.tileHeight,
        tileSpriteVariant: Settings.tileSpriteVariant,
        app: Settings.app
    };
    ImageDB.clear();
    try {
        Settings.HEADLESS = false;
        Settings.useEntitySprites = true;
        Settings.tileSpriteVariant = null;
        Settings.tileWidth = 32;
        Settings.tileHeight = 32;
        Settings.cameraTileX = 0;
        Settings.cameraTileY = 0;
        Settings.cameraTileZ = null;
        Settings.app = { width: 64, height: 64 };

        const map = new TileMap();
        const fr = new Uint8Array(8 * 8);
        fr.fill(100);
        map.loadFloorFromFriction(0, 8, 8, fr);

        const floor = createEmptyTileMapFloor(8, 8, { z: 0 });
        floor.palette = [
            null,
            normalizePaletteEntry({
                catalogId: 'dirt_wang_15',
                kind: 'overlays',
                roleId: 'path',
                wangFamily: 'dirt'
            })
        ];
        setSubLayerCell(floor, 'path', 1, 1, 1);
        map.setAuthoringFloor(0, floor);

        const variant = defaultTileVariantForDisplay();
        const opts = {
            genre: 'rpg_fantasy',
            kind: 'overlays',
            id: 'dirt_wang_15',
            variant
        };
        const urls = [
            resolveSpriteUrl(opts),
            resolveSpriteUrl(Object.assign({}, opts, { variant: 'icon' })),
            resolveSpriteUrl(Object.assign({}, opts, { variant: 'original' }))
        ];
        for (let i = 0; i < urls.length; i++) {
            if (urls[i]) ImageDB.failed[urls[i]] = true;
        }

        map._allocRenderCache = (pw, ph) => mockCacheSurface(pw, ph);
        const g = {
            canvas: { width: 64, height: 64 },
            fillStyle: '',
            fillRect() {},
            drawImage() {}
        };
        map.render(g);
        assert.ok(map._renderCache, 'cache built');
        assert.strictEqual(
            map._renderCache.pendingSprites,
            false,
            'failed overlay is not pending'
        );
        const first = map._renderCacheRebuilds;
        map.render(g);
        assert.strictEqual(
            map._renderCacheRebuilds,
            first,
            '404 must not rebuild the floor cache every frame'
        );
        log('failed art pendingSprites ok');
    } finally {
        Settings.HEADLESS = prev.HEADLESS;
        Settings.useEntitySprites = prev.useEntitySprites;
        Settings.cameraTileX = prev.cameraTileX;
        Settings.cameraTileY = prev.cameraTileY;
        Settings.cameraTileZ = prev.cameraTileZ;
        Settings.tileWidth = prev.tileWidth;
        Settings.tileHeight = prev.tileHeight;
        Settings.tileSpriteVariant = prev.tileSpriteVariant;
        Settings.app = prev.app;
        ImageDB.clear();
    }
}

function testWalkSightAndProtectionZones() {
    // 1×4: water | wall | grate | protection
    const cols = 4;
    const rows = 1;
    const rgba = rgbaFromPixels(cols, rows, [
        [0, 255, 255], // cyan water
        [255, 255, 0], // yellow wall
        [255, 0, 255], // magenta grate
        [0, 255, 0] // green PZ
    ]);
    const map = new TileMap();
    map.loadFloorFromRgba(0, cols, rows, rgba);

    assert.strictEqual(map.isWalkable(0, 0, 0), false, 'water non-walkable');
    assert.strictEqual(map.blocksSight(0, 0, 0), false, 'water sight open');
    assert.strictEqual(map.blocksCast(0, 0, 0), false);

    assert.strictEqual(map.isWalkable(1, 0, 0), false, 'wall non-walkable');
    assert.strictEqual(map.blocksSight(1, 0, 0), true, 'wall sight blocked');

    assert.strictEqual(map.isWalkable(2, 0, 0), true, 'grate walkable');
    assert.strictEqual(map.blocksSight(2, 0, 0), true, 'grate sight blocked');

    assert.strictEqual(map.isWalkable(3, 0, 0), true, 'PZ walkable');
    assert.strictEqual(map.blocksSight(3, 0, 0), false, 'PZ sight open');
    assert.strictEqual(map.blocksCast(3, 0, 0), true, 'PZ no cast');
    assert.strictEqual(
        map.getTileFlags(3, 0, 0) & TILE_FLAG_NO_CAST,
        TILE_FLAG_NO_CAST
    );

    // Friction-only load couples sight to walk
    const open = new Uint8Array(4);
    open[0] = 100;
    open[1] = FRICTION_BLOCKED;
    open[2] = 100;
    open[3] = 100;
    const map2 = new TileMap();
    map2.loadFloorFromFriction(1, 2, 2, open);
    assert.strictEqual(map2.blocksSight(0, 0, 1), false);
    assert.strictEqual(map2.blocksSight(1, 0, 1), true, 'default couple wall');

    log('walk/sight/PZ ok');
}

/**
 * Phase 2: flag packages, creature/attack helpers, vertical registration.
 */
function testPhase2FlagsStairsAndPz() {
    const open = new Uint8Array(25);
    open.fill(100);
    const map = new TileMap('phase2');
    map.loadFloorFromFriction(0, 5, 5, open);
    map.loadFloorFromFriction(1, 5, 5, open); // deeper floor (z+1)
    // Upper floor for stairs_up (z-1)
    map.loadFloorFromFriction(-1, 5, 5, open);

    // --- Single-bit NO_CAST (legacy green PNG style) ---
    map.setTileFlags(0, 0, 0, TILE_FLAG_NO_CAST);
    assert.strictEqual(map.blocksCast(0, 0, 0), true);
    assert.strictEqual(map.attackMayAffectTile(0, 0, 0), false);
    assert.strictEqual(map.blocksCreatures(0, 0, 0), false);
    assert.strictEqual(map.isProtectionZonePackage(0, 0, 0), false);
    assert.strictEqual(
        map.creatureMayEnterTile(0, 0, 0, { id: 1, type: 'monster' }),
        true,
        'NO_CAST alone does not block creatures'
    );

    // --- Full PZ package ---
    map.setTileFlags(1, 1, 0, TILE_FLAG_PZ_PACKAGE);
    assert.strictEqual(map.getTileFlags(1, 1, 0), TILE_FLAG_PZ_PACKAGE);
    assert.ok((map.getTileFlags(1, 1, 0) & TILE_FLAG_NO_CAST) !== 0);
    assert.ok((map.getTileFlags(1, 1, 0) & TILE_FLAG_NO_CREATURE) !== 0);
    assert.strictEqual(map.isProtectionZonePackage(1, 1, 0), true);
    assert.strictEqual(map.blocksCast(1, 1, 0), true);
    assert.strictEqual(map.attackMayAffectTile(1, 1, 0), false);
    assert.strictEqual(map.blocksCreatures(1, 1, 0), true);

    const player = { id: 10, type: 'player' };
    const creature = { id: 20, type: 'monster' };
    assert.strictEqual(
        map.creatureMayEnterTile(1, 1, 0, player),
        true,
        'players may enter full PZ'
    );
    assert.strictEqual(
        map.creatureMayEnterTile(1, 1, 0, creature),
        false,
        'creatures blocked on NO_CREATURE'
    );
    assert.strictEqual(map.canEnter(1, 1, 0, player), true);
    assert.strictEqual(map.canEnter(1, 1, 0, creature), false);

    const npc = { id: 30, type: 'monster', isNpc: true, kind: 'npc' };
    const hostileNpc = { id: 31, type: 'monster', isNpc: true, attackableNpc: true };
    assert.strictEqual(
        map.creatureMayEnterTile(1, 1, 0, npc),
        true,
        'talkable NPC may enter full PZ'
    );
    assert.strictEqual(map.canEnter(1, 1, 0, npc), true);
    assert.strictEqual(
        map.creatureMayEnterTile(1, 1, 0, hostileNpc),
        false,
        'attackable NPC still blocked on PZ'
    );
    assert.strictEqual(
        map.creatureMayEnterTile(1, 1, 0, null),
        false,
        'bare probe still blocked on NO_CREATURE'
    );

    // NO_CREATURE alone (no cast block)
    map.setTileFlags(2, 2, 0, TILE_FLAG_NO_CREATURE);
    assert.strictEqual(map.attackMayAffectTile(2, 2, 0), true, 'single-bit no cast open');
    assert.strictEqual(map.blocksCast(2, 2, 0), false);
    assert.strictEqual(map.canEnter(2, 2, 0, creature), false);
    assert.strictEqual(map.canEnter(2, 2, 0, player), true);
    assert.strictEqual(map.canEnter(2, 2, 0, npc), true, 'talkable NPC on NO_CREATURE');
    assert.strictEqual(map.isProtectionZonePackage(2, 2, 0), false);

    map.setTileFlags(3, 1, 0, TILE_FLAG_STAIR | TILE_FLAG_NO_CREATURE);
    assert.strictEqual(
        map.creatureMayEnterTile(3, 1, 0, npc),
        false,
        'talkable NPC blocked on hop pad'
    );
    assert.strictEqual(
        map.creatureMayEnterTile(3, 1, 0, player),
        true,
        'player still walks hop pad'
    );

    // Pathfinding: creature cannot path onto full PZ
    const path = map.search(
        { x: 0, y: 1, z: 0 },
        { x: 1, y: 1, z: 0 },
        { allowDiagonal: false, mover: creature, useStackPolicy: true }
    );
    assert.strictEqual(path, null, 'A* blocks creature goal on NO_CREATURE');

    const playerPath = map.search(
        { x: 0, y: 1, z: 0 },
        { x: 1, y: 1, z: 0 },
        { allowDiagonal: false, mover: player, useStackPolicy: true }
    );
    assert.ok(playerPath && playerPath.length >= 2, 'player can path onto PZ');

    const npcPath = map.search(
        { x: 0, y: 1, z: 0 },
        { x: 1, y: 1, z: 0 },
        { allowDiagonal: false, mover: npc, useStackPolicy: true }
    );
    assert.ok(npcPath && npcPath.length >= 2, 'talkable NPC can path onto PZ');

    // --- Hop north exit offset (stairs_up: deltaZ -1) ---
    const north = registerVerticalFromPlacement(
        map,
        {
            vertical: {
                type: 'stairs',
                deltaZ: -1,
                defaultDir: 'center',
                registerStairLink: true
            },
            hop: { dir: 'north' }
        },
        2,
        2,
        0
    );
    assert.strictEqual(north.registered, true);
    assert.strictEqual(north.exitDx, 0);
    assert.strictEqual(north.exitDy, -1);
    assert.strictEqual(north.deltaZ, -1);
    assert.deepStrictEqual(north.to, { x: 2, y: 1, z: -1 });
    assert.ok(map.isStair(2, 2, 0));
    const stairN = map.getStair(2, 2, 0);
    assert.strictEqual(stairN.x, 2);
    assert.strictEqual(stairN.y, 1);
    assert.strictEqual(String(stairN.z), '-1');
    assert.strictEqual(stairN.dir, 'north');
    assert.strictEqual(stairN.type, 'stairs');
    assert.strictEqual(stairN.exitDx, 0);
    assert.strictEqual(stairN.exitDy, -1);
    assert.ok(
        (map.getTileFlags(2, 2, 0) & TILE_FLAG_STAIR) !== 0,
        'STAIR flag ORd (with prior NO_CREATURE still present)'
    );

    // --- Hole down (deltaZ +1), center ---
    const hole = registerVerticalFromPlacement(
        map,
        {
            vertical: {
                type: 'hole',
                deltaZ: 1,
                defaultDir: 'center',
                registerStairLink: true
            },
            hop: { dir: 'center' }
        },
        3,
        3,
        0
    );
    assert.strictEqual(hole.registered, true);
    assert.strictEqual(hole.exitDx, 0);
    assert.strictEqual(hole.exitDy, 0);
    assert.strictEqual(hole.deltaZ, 1);
    assert.deepStrictEqual(hole.to, { x: 3, y: 3, z: 1 });
    const holeStair = map.getStair(3, 3, 0);
    assert.strictEqual(holeStair.type, 'hole');
    assert.strictEqual(String(holeStair.z), '1');
    assert.ok((map.getTileFlags(3, 3, 0) & TILE_FLAG_HOLE) !== 0);

    // --- Ladder flag + type on registry ---
    const ladder = registerVerticalFromPlacement(
        map,
        {
            vertical: {
                type: 'ladder',
                deltaZ: -1,
                defaultDir: 'center',
                bidirectional: true,
                registerStairLink: true
            },
            hop: { dir: 'east' },
            link: 'ladder-a'
        },
        4,
        4,
        0
    );
    assert.strictEqual(ladder.registered, true);
    assert.strictEqual(ladder.exitDx, 1);
    assert.strictEqual(ladder.exitDy, 0);
    assert.deepStrictEqual(ladder.to, { x: 5, y: 4, z: -1 });
    assert.ok((map.getTileFlags(4, 4, 0) & TILE_FLAG_LADDER) !== 0);
    const lad = map.getStair(4, 4, 0);
    assert.strictEqual(lad.type, 'ladder');
    assert.strictEqual(lad.dir, 'east');
    assert.strictEqual(lad.link, 'ladder-a');
    // Bidirectional reverse
    const rev = map.getStair(5, 4, -1);
    assert.ok(rev, 'reverse ladder pad');
    assert.strictEqual(rev.x, 4);
    assert.strictEqual(rev.y, 4);
    assert.strictEqual(String(rev.z), '0');
    assert.strictEqual(rev.dir, 'west');
    assert.strictEqual(reverseHopDir('east'), 'west');
    assert.strictEqual(reverseHopDir('north'), 'south');

    // Explicit hop.to overrides offset math
    const explicit = registerVerticalFromPlacement(
        map,
        {
            vertical: {
                type: 'stairs',
                deltaZ: 1,
                registerStairLink: true
            },
            hop: { dir: 'north', to: { x: 0, y: 4, z: 1 } }
        },
        0,
        0,
        0
    );
    assert.strictEqual(explicit.registered, true);
    assert.deepStrictEqual(explicit.to, { x: 0, y: 4, z: 1 });

    // Rope spot: flag only, no stair link by default
    const rope = registerVerticalFromPlacement(
        map,
        {
            vertical: {
                type: 'rope',
                deltaZ: -1,
                registerStairLink: false
            }
        },
        1,
        0,
        0
    );
    assert.strictEqual(rope.registered, false);
    assert.strictEqual(map.isStair(1, 0, 0), false);

    log('phase2 flags/stairs/PZ ok');
}

function testHopOnStepPolicy() {
    assert.strictEqual(hopsOnStep(null), true);
    assert.strictEqual(hopsOnStep(''), true);
    assert.strictEqual(hopsOnStep('stairs'), true);
    assert.strictEqual(hopsOnStep('hole'), true);
    assert.strictEqual(hopsOnStep('ladder'), false);
    assert.strictEqual(hopsOnStep('rope'), false);
    assert.strictEqual(hopsOnStep('shovel'), false);
    assert.strictEqual(playerHopsOnStep({ type: 'player' }), true);
    assert.strictEqual(playerHopsOnStep({ type: 'player', controlMode: 'manual' }), true);
    assert.strictEqual(playerHopsOnStep({ type: 'player', controlMode: 'ai' }), false);
    assert.strictEqual(playerHopsOnStep({ type: 'creature' }), false);

    const open = new Uint8Array(25);
    open.fill(100);
    const map = new TileMap('hop_policy');
    map.loadFloorFromFriction(0, 5, 5, open);
    map.loadFloorFromFriction(1, 5, 5, open);
    map.addStair(
        { x: 1, y: 1, z: 0 },
        { x: 1, y: 1, z: 1 },
        { type: 'stairs', bidirectional: false }
    );
    map.addStair(
        { x: 3, y: 1, z: 0 },
        { x: 3, y: 1, z: 1 },
        { type: 'ladder', bidirectional: false }
    );
    map.addStair(
        { x: 2, y: 3, z: 0 },
        { x: 2, y: 3, z: 1 },
        { type: 'hole', bidirectional: false }
    );
    assert.strictEqual(map.hopsOnStepAt(1, 1, 0), true);
    assert.strictEqual(map.hopsOnStepAt(3, 1, 0), false);
    assert.strictEqual(map.hopsOnStepAt(2, 3, 0), true);
    assert.strictEqual(map.hopsOnStepAt(0, 0, 0), false);

    const ents = new Map();
    map.resolveEntity = (id) => ents.get(id) || null;
    const player = {
        id: 21,
        type: 'player',
        tile: { x: 0, y: 1, z: 0 },
        path: [{ x: 2, y: 2 }],
        alive: true
    };
    ents.set(21, player);
    assert.ok(map.tryOccupy(0, 1, 0, player));
    assert.ok(map.moveEntityToTile(player, 1, 1, 0), 'step onto stair');
    assert.strictEqual(String(player.tile.z), '1', 'stair hop-on-step');
    assert.strictEqual(player.tile.x, 1);
    assert.strictEqual(player.tile.y, 1);
    assert.deepStrictEqual(player.path, [], 'path cleared after hop');

    const aiWalker = {
        id: 25,
        type: 'player',
        controlMode: 'ai',
        tile: { x: 0, y: 3, z: 0 },
        path: [],
        alive: true
    };
    ents.set(25, aiWalker);
    assert.ok(map.tryOccupy(0, 3, 0, aiWalker));
    assert.ok(map.moveEntityToTile(aiWalker, 2, 3, 0), 'AI step onto hole');
    assert.strictEqual(String(aiWalker.tile.z), '0', 'AI does not hop-on-step');
    assert.strictEqual(aiWalker.tile.x, 2);
    assert.strictEqual(aiWalker.tile.y, 3);

    const climber = {
        id: 22,
        type: 'player',
        tile: { x: 2, y: 1, z: 0 },
        path: [],
        alive: true
    };
    ents.set(22, climber);
    assert.ok(map.tryOccupy(2, 1, 0, climber));
    assert.ok(map.moveEntityToTile(climber, 3, 1, 0), 'step onto ladder');
    assert.strictEqual(String(climber.tile.z), '0', 'ladder stays on step');
    assert.strictEqual(climber.tile.x, 3);
    assert.ok(map.tryUseStair(climber, null), 'ladder Use hops');
    assert.strictEqual(String(climber.tile.z), '1');

    const longClimber = {
        id: 24,
        type: 'player',
        tile: { x: 3, y: 2, z: 0 },
        path: [],
        alive: true
    };
    ents.set(24, longClimber);
    assert.ok(map.tryOccupy(3, 2, 0, longClimber));
    assert.ok(map.moveEntityToTile(longClimber, 3, 1, 0), 'step onto ladder again');
    assert.strictEqual(String(longClimber.tile.z), '0');
    longClimber.path = [{ x: 3, y: 1, z: 1 }];
    assert.ok(
        map.followLongPath(longClimber, 3, 1, 1),
        'followLongPath hops ladder (intentional use)'
    );
    assert.strictEqual(String(longClimber.tile.z), '1');

    const holeWalker = {
        id: 23,
        type: 'player',
        tile: { x: 2, y: 2, z: 0 },
        path: [],
        alive: true
    };
    ents.set(23, holeWalker);
    assert.ok(map.tryOccupy(2, 2, 0, holeWalker));
    assert.ok(map.moveEntityToTile(holeWalker, 2, 3, 0), 'step onto hole');
    assert.strictEqual(String(holeWalker.tile.z), '1', 'hole hop-on-step');

    const towardStep = map.findStairToward(0, 1, 0, 0, { hopsOnStepOnly: true });
    assert.ok(towardStep);
    assert.notStrictEqual(towardStep.x, 3, 'manual find skips ladder');

    const towardAny = map.findStairToward(0, 1, 3, 1);
    assert.ok(towardAny);
    assert.strictEqual(towardAny.x, 3, 'party find may pick ladder');

    log('hop-on-step policy ok');
}

async function main() {
    testFrictionFromPixel();
    testSyntheticGridEncoding();
    testOccupancyHelpers();
    testWalkSightAndProtectionZones();
    testFirstClassStairs();
    testStairLinkBidirectionalOverride();
    testPlayerTileStack();
    testCreaturePush();
    testPhase2FlagsStairsAndPz();
    testHopOnStepPolicy();
    testCameraTileZSelectsFloor();
    testRenderCacheMath();
    testRenderCacheBlitAndRebuild();
    testFailedArtDoesNotKeepPendingSprites();
    await testLoadRealFloor07();
    console.log('tilemap: ok');
}

main().catch((err) => {
    console.error('tilemap: FAIL');
    console.error(err);
    process.exit(1);
});
