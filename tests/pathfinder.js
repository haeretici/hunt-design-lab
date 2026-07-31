#!/usr/bin/env node
/**
 * Stage 2 exit criteria: short-path A*, diagonal corner rules, caps,
 * TileMap.search / followPath. Quiet on success; VERBOSE=1 for detail + optional bench.
 */

'use strict';

const assert = require('assert');
const { performance } = require('perf_hooks');
const { Settings } = require('../kernel/settings.js');
const { TileMap, FRICTION_BLOCKED } = require('../kernel/core/entities/tilemap.js');
const { Time } = require('../kernel/core/lib/time.js');
const { resolveAttack } = require('../kernel/core/lib/combat/resolve.js');
const {
    Pathfinder,
    MinHeap,
    findPath,
    heuristic,
    DEFAULT_MAX_DISTANCE,
    DEFAULT_MAX_ITERATIONS
} = require('../kernel/core/lib/pathfinder.js');

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

/** All-gray walkable floor. */
function openFloor(cols, rows, gray) {
    const g = gray !== undefined ? gray : 100;
    const pixels = [];
    for (let i = 0; i < cols * rows; i++) pixels.push([g, g, g]);
    const map = new TileMap();
    map.loadFloorFromRgba(0, cols, rows, rgbaFromPixels(cols, rows, pixels));
    return map;
}

function testMinHeap() {
    const h = new MinHeap((a, b) => a.f - b.f || a.h - b.h);
    h.push({ f: 3, h: 1, id: 'c' });
    h.push({ f: 1, h: 2, id: 'a' });
    h.push({ f: 2, h: 0, id: 'b' });
    h.push({ f: 1, h: 1, id: 'a2' });
    assert.strictEqual(h.pop().id, 'a2');
    assert.strictEqual(h.pop().id, 'a');
    assert.strictEqual(h.pop().id, 'b');
    assert.strictEqual(h.pop().id, 'c');
    assert.strictEqual(h.pop(), undefined);
    log('MinHeap ok');
}

function testHeuristic() {
    assert.strictEqual(heuristic(0, 0, true), 0);
    assert.strictEqual(heuristic(3, 0, false), 3);
    assert.strictEqual(heuristic(0, 4, false), 4);
    // Octile: 3+4+(√2-2)*3 = 7 + 3*(√2-2) = 1 + 3√2
    const oct = heuristic(3, 4, true);
    assert.ok(Math.abs(oct - (1 + 3 * Math.SQRT2)) < 1e-9, 'octile 3,4');
    log('heuristic ok');
}

function testStraightCardinal() {
    const map = openFloor(5, 5);
    const path = findPath(map, { x: 0, y: 2, z: 0 }, { x: 4, y: 2, z: 0 }, {
        allowDiagonal: false
    });
    assert.ok(path, 'path exists');
    assert.strictEqual(path[0].x, 0);
    assert.strictEqual(path[0].y, 2);
    assert.strictEqual(path[path.length - 1].x, 4);
    assert.strictEqual(path[path.length - 1].y, 2);
    assert.strictEqual(path.length, 5, 'cardinal length 5');
    // All steps stay on row 2
    for (const p of path) assert.strictEqual(p.y, 2);
    log('straight cardinal ok', path);
}

function testDiagonalShortPath() {
    const map = openFloor(5, 5);
    const path = findPath(map, { x: 0, y: 0, z: 0 }, { x: 3, y: 3, z: 0 }, {
        allowDiagonal: true
    });
    assert.ok(path);
    assert.strictEqual(path.length, 4, 'diagonal 0,0→3,3 is 4 points');
    assert.deepStrictEqual(path[0], { x: 0, y: 0 });
    assert.deepStrictEqual(path[path.length - 1], { x: 3, y: 3 });
    log('diagonal short ok', path);
}

function testWallBlocksStraightAllowsDetour() {
    // 5x3 open with a wall column in the middle of the top two rows
    // ##### layout (W=wall, .=walk, S/E):
    // S . W . E
    // . . W . .
    // . . . . .
    const cols = 5;
    const rows = 3;
    const W = [255, 255, 0];
    const G = [100, 100, 100];
    const pixels = [
        G, G, W, G, G,
        G, G, W, G, G,
        G, G, G, G, G
    ];
    const map = new TileMap();
    map.loadFloorFromRgba(0, cols, rows, rgbaFromPixels(cols, rows, pixels));

    const path = findPath(map, { x: 0, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }, {
        allowDiagonal: true
    });
    assert.ok(path, 'detour path');
    // Straight through wall would be length 5 on open ground; detour is at least that
    // (diagonal can equal 5 via row 2) but must never land on wall tiles.
    assert.ok(path.length >= 5, 'reaches far side');
    const wallTiles = new Set(['2,0', '2,1']);
    for (const p of path) {
        assert.ok(
            !wallTiles.has(`${p.x},${p.y}`),
            `path stepped on wall ${p.x},${p.y}`
        );
    }
    assert.deepStrictEqual(path[0], { x: 0, y: 0 });
    assert.deepStrictEqual(path[path.length - 1], { x: 4, y: 0 });
    log('wall detour ok', path);
}

function testDiagonalCornerRule() {
    // Corner: only both cardinals blocked should forbid diagonal cut.
    //
    //   S W
    //   W E
    //
    // From S(0,0) diagonal to E(1,1): both (1,0) and (0,1) are walls → no diagonal.
    // Path must fail (no other tiles) or go around if map larger.
    {
        const W = [255, 255, 0];
        const G = [100, 100, 100];
        const map = new TileMap();
        map.loadFloorFromRgba(
            0,
            2,
            2,
            rgbaFromPixels(2, 2, [G, W, W, G])
        );
        const path = findPath(map, { x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }, {
            allowDiagonal: true
        });
        // End is always enterable even if we couldn't path through walls;
        // with both cardinals blocked, diagonal is skipped → no path.
        assert.strictEqual(path, null, 'both corners blocked → no diagonal cut');
    }

    // One cardinal open → diagonal allowed
    //   S .
    //   W E
    {
        const W = [255, 255, 0];
        const G = [100, 100, 100];
        const map = new TileMap();
        map.loadFloorFromRgba(
            0,
            2,
            2,
            rgbaFromPixels(2, 2, [G, G, W, G])
        );
        const path = findPath(map, { x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }, {
            allowDiagonal: true
        });
        assert.ok(path, 'one corner open → diagonal ok');
        assert.strictEqual(path.length, 2);
        log('diagonal corner rule ok');
    }
}

function testEndAlwaysEnterable() {
    // End is blocked yellow — still pathable (combat targeting)
    const W = [255, 255, 0];
    const G = [100, 100, 100];
    const map = new TileMap();
    map.loadFloorFromRgba(
        0,
        3,
        1,
        rgbaFromPixels(3, 1, [G, G, W])
    );
    const path = findPath(map, { x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 });
    assert.ok(path);
    assert.deepStrictEqual(path[path.length - 1], { x: 2, y: 0 });
    log('end enterable ok');
}

function testOccupiedBlocksWhenChecked() {
    const map = openFloor(4, 1);
    map.tryOccupy(1, 0, 0, 99);
    map.tryOccupy(2, 0, 0, 98);

    const blocked = findPath(
        map,
        { x: 0, y: 0, z: 0 },
        { x: 3, y: 0, z: 0 },
        { allowDiagonal: false, checkOccupied: true }
    );
    assert.strictEqual(blocked, null, 'occupied corridor blocks');

    const free = findPath(
        map,
        { x: 0, y: 0, z: 0 },
        { x: 3, y: 0, z: 0 },
        { allowDiagonal: false, checkOccupied: false }
    );
    assert.ok(free, 'without checkOccupied path exists');

    // End occupied is still allowed
    map.clearOccupancy(0);
    map.tryOccupy(3, 0, 0, 7);
    const toOcc = findPath(
        map,
        { x: 0, y: 0, z: 0 },
        { x: 3, y: 0, z: 0 },
        { allowDiagonal: false, checkOccupied: true }
    );
    assert.ok(toOcc, 'end occupant allowed');
    log('occupancy path ok');
}

function testMaxDistanceCap() {
    const map = openFloor(30, 1);
    const path = findPath(
        map,
        { x: 0, y: 0, z: 0 },
        { x: 25, y: 0, z: 0 },
        { allowDiagonal: false, maxDistance: 10, maxIterations: 5000 }
    );
    // Target is outside maxDistance box → intermediate tiles beyond 10 skipped,
    // end is exempt from distance check but unreachable without stepping past box.
    assert.strictEqual(path, null, 'maxDistance prevents long corridor');

    const near = findPath(
        map,
        { x: 0, y: 0, z: 0 },
        { x: 8, y: 0, z: 0 },
        { allowDiagonal: false, maxDistance: 10 }
    );
    assert.ok(near);
    assert.strictEqual(near.length, 9);
    log('maxDistance cap ok');
}

function testMaxIterationsCap() {
    // Large open map, tiny iteration budget → fail
    const map = openFloor(40, 40);
    const path = findPath(
        map,
        { x: 0, y: 0, z: 0 },
        { x: 39, y: 39, z: 0 },
        { allowDiagonal: true, maxDistance: 100, maxIterations: 5 }
    );
    assert.strictEqual(path, null, 'maxIterations fails search');

    const ok = findPath(
        map,
        { x: 0, y: 0, z: 0 },
        { x: 5, y: 5, z: 0 },
        { allowDiagonal: true, maxIterations: 512 }
    );
    assert.ok(ok);
    log('maxIterations cap ok');
}

function testSameTileAndOob() {
    const map = openFloor(3, 3);
    const same = findPath(map, { x: 1, y: 1, z: 0 }, { x: 1, y: 1, z: 0 });
    assert.deepStrictEqual(same, [{ x: 1, y: 1 }]);

    assert.strictEqual(
        findPath(map, { x: -1, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }),
        null
    );
    assert.strictEqual(
        findPath(map, { x: 0, y: 0, z: 0 }, { x: 99, y: 99, z: 0 }),
        null
    );
    // Missing layer on start z → null (end z alone is ignored when start has z)
    assert.strictEqual(
        findPath(map, { x: 0, y: 0, z: 'missing' }, { x: 1, y: 1, z: 'missing' }),
        null
    );
    log('same/oob ok');
}

function testTileMapSearchWrapper() {
    const map = openFloor(5, 5);
    const path = map.search({ x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }, false);
    assert.ok(path);
    assert.strictEqual(path.length, 3);

    const opts = map.search(
        { x: 0, y: 0, z: 0 },
        { x: 2, y: 2, z: 0 },
        { allowDiagonal: true, maxDistance: 50 }
    );
    assert.ok(opts);
    assert.strictEqual(opts.length, 3);

    assert.strictEqual(Settings.PATH_MAX_DISTANCE, DEFAULT_MAX_DISTANCE);
    assert.strictEqual(Settings.PATH_MAX_ITERATIONS, DEFAULT_MAX_ITERATIONS);
    log('TileMap.search ok');
}

function testFollowPathAndRepath() {
    const map = openFloor(6, 1);
    const entity = {
        id: 1,
        tile: { x: 0, y: 0, z: 0 },
        path: []
    };
    assert.ok(map.tryOccupy(0, 0, 0, 1));

    // Walk to x=4
    let steps = 0;
    while (entity.tile.x !== 4 && steps < 20) {
        const moved = map.followPath(entity, 4, 0, 0);
        assert.ok(moved, 'step ' + steps);
        steps++;
    }
    assert.strictEqual(entity.tile.x, 4);
    assert.strictEqual(map.getOccupant(4, 0, 0), 1);
    assert.strictEqual(map.getOccupant(0, 0, 0), 0);

    // Place blocker on next path and force repath around
    // Rebuild as 2-row map for detour
    const detour = new TileMap();
    const W = [255, 255, 0];
    const G = [100, 100, 100];
    // 5x2: top almost open, bottom open
    detour.loadFloorFromRgba(
        0,
        5,
        2,
        rgbaFromPixels(5, 2, [
            G, G, G, G, G,
            G, G, G, G, G
        ])
    );
    const e2 = { id: 2, tile: { x: 0, y: 0, z: 0 }, path: [] };
    detour.tryOccupy(0, 0, 0, 2);
    // Precompute path toward 4,0 then block next step with another entity
    detour.followPath(e2, 4, 0, 0);
    assert.ok(e2.path.length > 0);
    // Occupy next step so move fails → repath (still only one row free if we block mid)
    const next = e2.path[0];
    detour.tryOccupy(next.x, next.y, 0, 9);
    // After repath without occupancy check on fallback, may step onto occupied? 
    // followPath tries checkOccupied true then false — fallback can walk "through" occupancy.
    // With only one corridor, fallback finds path through occupied tiles.
    const afterBlock = detour.followPath(e2, 4, 0, 0);
    // Either repath moved around (if alternative) or used fallback — must not throw
    assert.strictEqual(typeof afterBlock, 'boolean');

    // Blocked moveEntity
    const stuck = openFloor(2, 1);
    const e3 = { id: 3, tile: { x: 0, y: 0, z: 0 }, path: [] };
    stuck.tryOccupy(0, 0, 0, 3);
    stuck.tryOccupy(1, 0, 0, 4);
    assert.strictEqual(stuck.moveEntityToTile(e3, 1, 0, 0), false);
    assert.strictEqual(e3.tile.x, 0);

    log('followPath ok', { steps });
}

function testPathfinderClass() {
    const pf = new Pathfinder({ allowDiagonal: false, maxDistance: 20 });
    const map = openFloor(10, 10);
    const path = pf.findPath(map, { x: 1, y: 1, z: 0 }, { x: 5, y: 1, z: 0 });
    assert.ok(path);
    assert.strictEqual(path.length, 5);
    // Override defaults
    const diag = pf.findPath(
        map,
        { x: 0, y: 0, z: 0 },
        { x: 3, y: 3, z: 0 },
        { allowDiagonal: true }
    );
    assert.ok(diag);
    assert.strictEqual(diag.length, 4);
    log('Pathfinder class ok');
}

/**
 * Friction is walkable-vs-blocked only for A*. Stickier grays must not
 * lengthen or detour paths; only FRICTION_BLOCKED (255) is an obstacle.
 */
function testFrictionNotPathCost() {
    const cols = 7;
    const rows = 3;
    const start = { x: 0, y: 1, z: 0 };
    const end = { x: 6, y: 1, z: 0 };
    const opts = { allowDiagonal: false, maxDistance: 20, maxIterations: 512 };

    function floorFromFriction(fillFn) {
        const friction = new Uint8Array(cols * rows);
        for (let y = 0; y < rows; y++) {
            for (let x = 0; x < cols; x++) {
                friction[y * cols + x] = fillFn(x, y);
            }
        }
        const map = new TileMap();
        map.loadFloorFromFriction(0, cols, rows, friction);
        return map;
    }

    const low = floorFromFriction(() => 70);
    const high = floorFromFriction(() => 200);
    // Alternating stickiness on the straight row — still fully walkable
    const mixed = floorFromFriction((x, y) => {
        if (y === 1) return x % 2 === 0 ? 70 : 200;
        return 100;
    });
    // Sticky corridor mid-row, low-friction detour on top — must still take straight
    // (if friction were path cost, A* would prefer the top row).
    const stickyCorridor = floorFromFriction((x, y) => {
        if (y === 1) return 250;
        if (y === 0) return 70;
        return 100;
    });

    const pathLow = findPath(low, start, end, opts);
    const pathHigh = findPath(high, start, end, opts);
    const pathMixed = findPath(mixed, start, end, opts);
    const pathSticky = findPath(stickyCorridor, start, end, opts);

    assert.ok(pathLow && pathHigh && pathMixed && pathSticky);
    assert.strictEqual(pathLow.length, 7, 'low-friction straight length');
    assert.strictEqual(pathHigh.length, pathLow.length, 'high friction same length');
    assert.strictEqual(pathMixed.length, pathLow.length, 'mixed walkable same length');
    assert.strictEqual(pathSticky.length, pathLow.length, 'sticky corridor same length');
    assert.deepStrictEqual(pathHigh, pathLow, 'path points independent of gray value');
    assert.deepStrictEqual(pathMixed, pathLow, 'mixed grays same geometric path');
    // Straight mid-row despite stickier mid vs freer top
    for (const p of pathSticky) {
        assert.strictEqual(p.y, 1, `sticky mid-path stays y=1, got y=${p.y}`);
    }

    // Only 255 blocks — wall mid forces detour regardless of surrounding gray
    const withWall = floorFromFriction((x, y) => {
        if (x === 3 && y === 1) return FRICTION_BLOCKED;
        return 100;
    });
    const detour = findPath(withWall, start, end, opts);
    assert.ok(detour, 'detour around blocked');
    assert.ok(detour.length > pathLow.length, 'blocked tile lengthens path');
    assert.ok(
        !detour.some((p) => p.x === 3 && p.y === 1),
        'path never steps on FRICTION_BLOCKED intermediate'
    );

    log('friction not path cost ok', {
        straight: pathLow.length,
        detour: detour.length
    });
}

/**
 * Party ally-pass: swap on 1-wide corridor, yield-aside on open floor.
 * Requires tileMap.resolveEntity + shared party refs (same as Simulator).
 */
function testAllySwapAndYield() {
    const party = { id: 'test_party' };

    // ── 1-wide corridor: leader swaps past follower ──────────────────
    // Layout: L . F . . goal   all on one row (must swap, no detour)
    const corridor = openFloor(6, 1);
    const entities = new Map();
    corridor.resolveEntity = (id) => entities.get(id) || null;

    const leader = {
        id: 1,
        isLeader: true,
        alive: true,
        party,
        tile: { x: 0, y: 0, z: 0 },
        path: [],
        speed: 220
    };
    const follower = {
        id: 2,
        isLeader: false,
        alive: true,
        party,
        tile: { x: 2, y: 0, z: 0 },
        path: [],
        speed: 220
    };
    entities.set(1, leader);
    entities.set(2, follower);
    assert.ok(corridor.tryOccupy(0, 0, 0, 1));
    assert.ok(corridor.tryOccupy(2, 0, 0, 2));

    // Walk leader toward x=5; after a few steps must pass the follower
    let steps = 0;
    while (leader.tile.x < 5 && steps < 40) {
        assert.ok(
            corridor.followPath(leader, 5, 0, 0),
            'leader step ' + steps + ' at x=' + leader.tile.x
        );
        steps++;
    }
    assert.strictEqual(leader.tile.x, 5, 'leader reaches goal via swap');
    assert.strictEqual(corridor.getOccupant(5, 0, 0), 1);
    // Follower was displaced at least once (not still only at x=2 with leader past)
    assert.ok(
        follower.tile.x !== 2 || corridor.getOccupant(2, 0, 0) !== 2,
        'follower moved during pass'
    );
    log('ally swap corridor ok', {
        steps,
        leaderX: leader.tile.x,
        followerX: follower.tile.x
    });

    // ── Yield: follower cannot swap leader; leader steps aside on 2-row ─
    const follower2 = {
        id: 12,
        isLeader: false,
        alive: true,
        party,
        tile: { x: 0, y: 0, z: 0 },
        path: [],
        speed: 220
    };
    const leader2 = {
        id: 13,
        isLeader: true,
        alive: true,
        party,
        tile: { x: 1, y: 0, z: 0 },
        path: [],
        speed: 220
    };
    const open2 = openFloor(4, 2);
    const ents3 = new Map();
    open2.resolveEntity = (id) => ents3.get(id) || null;
    ents3.set(12, follower2);
    ents3.set(13, leader2);
    assert.ok(open2.tryOccupy(0, 0, 0, 12));
    assert.ok(open2.tryOccupy(1, 0, 0, 13));

    // Follower paths through leader tile → leader yields aside (swap denied)
    assert.ok(open2.followPath(follower2, 3, 0, 0));
    assert.ok(
        open2.getOccupant(1, 0, 0) !== 13 || follower2.tile.x >= 1,
        'yield freed the blocked step for follower approach'
    );
    // Not a swap: leader must not be on follower's old tile only (may be aside)
    assert.ok(
        !(leader2.tile.x === 0 && leader2.tile.y === 0 && follower2.tile.x === 1),
        'follower must not swap onto leader (yield-aside instead)'
    );
    log('ally yield ok', {
        follower: follower2.tile,
        leader: leader2.tile
    });

    // ── Follower cannot pass leader when no free yield tile ───────────
    // Walkable only x=0,1 (blocked x=2) so leader has nowhere to yield.
    const narrow = new TileMap();
    narrow.loadFloorFromFriction(0, 3, 1, new Uint8Array([100, 100, 255]));
    const ents4 = new Map();
    narrow.resolveEntity = (id) => ents4.get(id) || null;
    const flw = {
        id: 20,
        isLeader: false,
        alive: true,
        party,
        tile: { x: 0, y: 0, z: 0 },
        path: [],
        speed: 220
    };
    const ldr = {
        id: 21,
        isLeader: true,
        alive: true,
        party,
        tile: { x: 1, y: 0, z: 0 },
        path: [],
        speed: 220
    };
    ents4.set(20, flw);
    ents4.set(21, ldr);
    assert.ok(narrow.tryOccupy(0, 0, 0, 20));
    assert.ok(narrow.tryOccupy(1, 0, 0, 21));
    // Swap denied + yield impossible → both stay put
    narrow.followPath(flw, 2, 0, 0);
    assert.strictEqual(ldr.tile.x, 1, 'leader not swapped by follower');
    assert.strictEqual(ldr.tile.y, 0);
    assert.strictEqual(flw.tile.x, 0, 'follower still blocked without yield room');
    log('follower cannot swap leader ok');

    // ── Non-ally (creature) is not swapped ───────────────────────────
    const combat = openFloor(3, 1);
    const ents5 = new Map();
    combat.resolveEntity = (id) => ents5.get(id) || null;
    const hero = {
        id: 30,
        isLeader: true,
        alive: true,
        party,
        tile: { x: 0, y: 0, z: 0 },
        path: [],
        speed: 220
    };
    const rat = {
        id: 31,
        alive: true,
        // no party
        tile: { x: 1, y: 0, z: 0 },
        path: [],
        speed: 220
    };
    ents5.set(30, hero);
    ents5.set(31, rat);
    assert.ok(combat.tryOccupy(0, 0, 0, 30));
    assert.ok(combat.tryOccupy(1, 0, 0, 31));
    combat.followPath(hero, 2, 0, 0);
    assert.strictEqual(hero.tile.x, 0, 'no swap with creature');
    assert.strictEqual(rat.tile.x, 1);
    log('no creature swap ok');
}

function testElementalFieldAvoidance() {
    log('Running testElementalFieldAvoidance...');
    const map = openFloor(4, 3);
    // Block row 0 and row 1 of column 1 with fire field (mask = 1 = FIRE)
    map.setTileFieldMask(1, 0, 0, 1);
    map.setTileFieldMask(1, 1, 0, 1);

    const avoidPath = findPath(
        map,
        { x: 0, y: 0, z: 0 },
        { x: 2, y: 0, z: 0 },
        { avoidFieldMask: 1, allowDiagonal: false }
    );
    assert.ok(avoidPath, 'Detour path exists around fire field');
    assert.ok(avoidPath.some(p => p.x === 1 && p.y === 2), 'Path detoured through unfielded tile (1, 2)');

    const immunePath = findPath(
        map,
        { x: 0, y: 0, z: 0 },
        { x: 2, y: 0, z: 0 },
        { avoidFieldMask: 0, allowDiagonal: false }
    );
    assert.strictEqual(immunePath.length, 3, 'Immune path goes straight across (1, 0)');

    // Test friendly-fire player source flag (mask 1 | 8 = 9)
    map.setTileFieldMask(1, 0, 0, 9);
    const playerPath = findPath(
        map,
        { x: 0, y: 0, z: 0 },
        { x: 2, y: 0, z: 0 },
        { avoidFieldMask: 1, ignorePlayerFields: true, allowDiagonal: false }
    );
    assert.strictEqual(playerPath.length, 3, 'Player ignores player-sourced fire field');

    const monsterPath = findPath(
        map,
        { x: 0, y: 0, z: 0 },
        { x: 2, y: 0, z: 0 },
        { avoidFieldMask: 1, ignorePlayerFields: false, allowDiagonal: false }
    );
    assert.ok(monsterPath.some(p => p.x === 1 && p.y === 2), 'Monster avoids player-sourced fire field');

    // Test followPath derivation and trapped combat fallback
    const monster = {
        id: 101,
        tile: { x: 0, y: 0, z: 0 },
        path: [],
        speed: 220,
        resists: { fire: 0 },
        inBattle: false
    };
    // Completely block column 1 with fire fields
    map.setTileFieldMask(1, 2, 0, 1);
    const successNoBattle = map.followPath(monster, 3, 0, 0);
    assert.strictEqual(successNoBattle, false, 'Non-engaged monster stops when completely trapped by fire fields');

    monster.inBattle = true;
    monster.path = [];
    const successInBattleUnprovoked = map.followPath(monster, 3, 0, 0);
    assert.strictEqual(successInBattleUnprovoked, false, 'Legacy parity: unprovoked inBattle monster safe-spots behind fire wall');

    monster.provokedUntil = 10.0; // Simulate player attack across wall
    monster.path = [];
    const successProvoked = map.followPath(monster, 3, 0, 0);
    assert.strictEqual(successProvoked, true, 'Provoked monster falls back to walking through fire field using penalty weighting');
    assert.ok(monster._hazardRouteUntil > 0, 'Hazard route cache timer is set upon successful fallback');

    // S06-01 Option B: summons do not free-cross by master distance / inBattle
    const farMaster = {
        id: 1,
        tile: { x: 10, y: 0, z: 0 },
        inBattle: true
    };
    const summon = {
        id: 102,
        masterId: 1,
        master: farMaster,
        tile: { x: 0, y: 0, z: 0 },
        path: [],
        speed: 220,
        resists: { fire: 0 },
        inBattle: false
    };
    map.moveEntityToTile(summon, 0, 0, 0);
    const successFarUnprovoked = map.followPath(summon, 3, 0, 0);
    assert.strictEqual(
        successFarUnprovoked,
        false,
        'Legacy-strict: unprovoked summon does not cross fields even if master is far / inBattle'
    );

    summon.provokedUntil = 10.0;
    summon.path = [];
    summon._hazardRouteUntil = 0;
    const successSummonProvoked = map.followPath(summon, 3, 0, 0);
    assert.strictEqual(
        successSummonProvoked,
        true,
        'Provoked summon may cross fields with penalty weighting (same as wild monster)'
    );
    log('testElementalFieldAvoidance: ok');
}

/**
 * S06-01: production summons set masterId only (spawnSummon), not entity.master.
 * resolveEntity is wired by Simulator; pathfinding must not treat goal distance
 * as master distance (Option B: no distance free-pass at all).
 */
function testSummonMasterIdOnlyNoFieldFreePass() {
    log('Running testSummonMasterIdOnlyNoFieldFreePass...');
    const map = openFloor(4, 3);
    map.setTileFieldMask(1, 0, 0, 1);
    map.setTileFieldMask(1, 1, 0, 1);
    map.setTileFieldMask(1, 2, 0, 1);

    const master = {
        id: 501,
        tile: { x: 10, y: 0, z: 0 },
        inBattle: true,
        alive: true
    };
    map.resolveEntity = (id) => (Number(id) === 501 ? master : null);

    const summon = {
        id: 502,
        masterId: 501,
        // deliberately no entity.master — matches spawnSummon
        tile: { x: 0, y: 0, z: 0 },
        path: [],
        speed: 220,
        resists: { fire: 0 },
        inBattle: false
    };

    // Long goal (> AI_SUMMON_FIELD_OVERRIDE_DIST if that knob still existed)
    const blocked = map.followPath(summon, 3, 0, 0);
    assert.strictEqual(
        blocked,
        false,
        'masterId-only summon does not free-cross fields via path-goal distance'
    );

    summon.provokedUntil = 10.0;
    summon.path = [];
    summon._hazardRouteUntil = 0;
    const afterHit = map.followPath(summon, 3, 0, 0);
    assert.strictEqual(
        afterHit,
        true,
        'masterId-only summon crosses after provocation (resolveEntity present, unused for gate)'
    );
    log('testSummonMasterIdOnlyNoFieldFreePass: ok');
}

/**
 * S06-05 / S08-04: multi-tick integration — unprovoked safe-spotting over 100
 * logic steps, then resolveAttack stamps provokedUntil and the entity may cross
 * the fire wall with penalty routing. masterId-only summon matches wild (Option B).
 */
function testMultiTickFieldSafeSpotAndProvoke() {
    log('Running testMultiTickFieldSafeSpotAndProvoke...');
    Time.resetTimeSinceLevelLoad();

    const map = openFloor(5, 3);
    // Solid fire column — no clean detour around the wall.
    for (let y = 0; y < 3; y++) {
        map.setTileFieldMask(2, y, 0, 1);
    }

    function makeMonster(id, x, y) {
        return {
            id,
            tile: { x, y, z: 0 },
            path: [],
            speed: 220,
            resists: { fire: 0 },
            inBattle: true,
            type: 'creature',
            alive: true,
            hp: { current: 100, max: 100 },
            combatStats: {
                atk: 1,
                skill: 1,
                magic: 0,
                armor: 0,
                mitigation: 0,
                maxBlock: 0,
                resists: {},
                canBlock: false
            }
        };
    }

    function isOnFire(entity) {
        const mask = map.getTileFieldMask(entity.tile.x, entity.tile.y, entity.tile.z);
        return (mask & 1) !== 0;
    }

    function runTicks(entity, goalX, goalY, n) {
        let onFire = false;
        for (let t = 0; t < n; t++) {
            Time.advanceFixedLogicStep();
            map.followPath(entity, goalX, goalY, 0);
            if (isOnFire(entity)) onFire = true;
        }
        return onFire;
    }

    // --- Wild monster: 100 ticks unprovoked holds west of the wall ---
    const wild = makeMonster(201, 0, 1);
    assert.ok(map.tryOccupy(0, 1, 0, wild.id));
    map.moveEntityToTile(wild, 0, 1, 0);

    const wildUnprovokedFire = runTicks(wild, 4, 1, 100);
    assert.strictEqual(
        wildUnprovokedFire,
        false,
        'unprovoked monster never steps onto fire over 100 ticks'
    );
    assert.ok(
        wild.tile.x < 2,
        `unprovoked monster stays west of fire wall (x=${wild.tile.x})`
    );
    assert.ok(
        !(wild.provokedUntil > 0),
        'provokedUntil unset before attack'
    );

    // Ranged hit across the wall stamps provocation (resolve sole owner).
    const attacker = {
        id: 1,
        tile: { x: 4, y: 1, z: 0 },
        type: 'player',
        alive: true,
        hp: { current: 200, max: 200 },
        mp: { current: 100, max: 100 },
        combatStats: {
            atk: 50,
            skill: 50,
            magic: 50,
            armor: 0,
            mitigation: 0,
            maxBlock: 0,
            resists: {},
            canBlock: false
        },
        cooldowns: {}
    };
    const bolt = {
        id: 'test_field_provoke_bolt',
        min: 20,
        max: 20,
        element: 'physical',
        range: 10,
        mana: 0,
        isMelee: false,
        cooldowns: {}
    };
    const hit = resolveAttack({
        attacker,
        defender: wild,
        spell: bolt,
        skipCooldown: true,
        skipMana: true,
        rng: () => 0.01
    });
    assert.strictEqual(hit.ok, true, 'resolveAttack ok');
    assert.strictEqual(hit.hit, true, 'resolveAttack hit');
    assert.ok(hit.final > 0, 'damage applied');
    assert.ok(
        wild.provokedUntil > Time.timeSinceLevelLoad,
        `provokedUntil stamped (${wild.provokedUntil} > ${Time.timeSinceLevelLoad})`
    );

    wild.path = [];
    wild._hazardRouteUntil = 0;
    const wildCrossed = runTicks(wild, 4, 1, 100);
    assert.strictEqual(
        wildCrossed,
        true,
        'provoked monster steps onto fire while routing through wall'
    );
    assert.ok(
        wild.tile.x > 2,
        `provoked monster reaches east of wall (x=${wild.tile.x})`
    );

    // --- Option B summon: masterId only, far master inBattle — still safe-spots ---
    Time.resetTimeSinceLevelLoad();
    const map2 = openFloor(5, 3);
    for (let y = 0; y < 3; y++) {
        map2.setTileFieldMask(2, y, 0, 1);
    }
    const master = {
        id: 501,
        tile: { x: 10, y: 0, z: 0 },
        inBattle: true,
        alive: true
    };
    map2.resolveEntity = (id) => (Number(id) === 501 ? master : null);

    const summon = makeMonster(502, 0, 1);
    summon.masterId = 501;
    // no entity.master — matches spawnSummon
    assert.ok(map2.tryOccupy(0, 1, 0, summon.id));
    map2.moveEntityToTile(summon, 0, 1, 0);

    function runTicksOn(m, entity, gx, gy, n) {
        let onFire = false;
        for (let t = 0; t < n; t++) {
            Time.advanceFixedLogicStep();
            m.followPath(entity, gx, gy, 0);
            const mask = m.getTileFieldMask(entity.tile.x, entity.tile.y, entity.tile.z);
            if ((mask & 1) !== 0) onFire = true;
        }
        return onFire;
    }

    const summonUnprovokedFire = runTicksOn(map2, summon, 4, 1, 100);
    assert.strictEqual(
        summonUnprovokedFire,
        false,
        'unprovoked masterId summon never steps fire over 100 ticks'
    );
    assert.ok(summon.tile.x < 2, 'summon holds west of wall without provoke');

    const hit2 = resolveAttack({
        attacker,
        defender: summon,
        spell: bolt,
        skipCooldown: true,
        skipMana: true,
        rng: () => 0.01
    });
    assert.strictEqual(hit2.hit, true);
    assert.ok(summon.provokedUntil > Time.timeSinceLevelLoad);

    summon.path = [];
    summon._hazardRouteUntil = 0;
    const summonCrossed = runTicksOn(map2, summon, 4, 1, 100);
    assert.strictEqual(
        summonCrossed,
        true,
        'provoked masterId summon crosses fire like wild creature'
    );
    assert.ok(summon.tile.x > 2, `provoked summon east of wall (x=${summon.tile.x})`);

    log('testMultiTickFieldSafeSpotAndProvoke: ok', {
        wildEnd: wild.tile,
        summonEnd: summon.tile
    });
}

function testFieldPenaltyMinimalExposure() {
    log('Running testFieldPenaltyMinimalExposure...');
    const map = openFloor(8, 8);
    const layer = map.getLayer(0);
    // Wall at x=3 for y=0, 2, 3, 4, 6, 7
    [0, 2, 3, 4, 6, 7].forEach(y => {
        layer.friction[y * 8 + 3] = 255;
    });
    
    // Put 1 fire field at the y=1 gap
    map.setTileFieldMask(3, 1, 0, 1);
    
    // Put 3 fire fields at the y=5 gap
    map.setTileFieldMask(3, 5, 0, 1);
    map.setTileFieldMask(4, 5, 0, 1);
    map.setTileFieldMask(2, 5, 0, 1);

    const path = findPath(
        map,
        { x: 0, y: 3, z: 0 },
        { x: 6, y: 3, z: 0 },
        { avoidFieldMask: 1, fieldPenalty: 10, allowDiagonal: false }
    );
    assert.ok(path, 'Found path with field penalty');
    const choseOneTileGap = path.some(p => p.x === 3 && p.y === 1);
    const choseThreeTileGap = path.some(p => p.x === 3 && p.y === 5);
    assert.strictEqual(choseOneTileGap, true, 'Provoked creature chooses route with minimal field exposure (1 fire tile over 3)');
    assert.strictEqual(choseThreeTileGap, false);
    log('testFieldPenaltyMinimalExposure: ok');
}

function testBenchmarkOptional() {
    if (!VERBOSE) return;
    const map = openFloor(80, 80);
    const t0 = performance.now();
    const path = findPath(
        map,
        { x: 0, y: 0, z: 0 },
        { x: 70, y: 70, z: 0 },
        { allowDiagonal: true, maxDistance: 100, maxIterations: 10000 }
    );
    const ms = performance.now() - t0;
    log('bench open 80x80 diagonal', {
        ms: Math.round(ms * 1000) / 1000,
        len: path && path.length
    });
    assert.ok(path);
}

function main() {
    testMinHeap();
    testHeuristic();
    testStraightCardinal();
    testDiagonalShortPath();
    testWallBlocksStraightAllowsDetour();
    testDiagonalCornerRule();
    testEndAlwaysEnterable();
    testOccupiedBlocksWhenChecked();
    testMaxDistanceCap();
    testMaxIterationsCap();
    testSameTileAndOob();
    testTileMapSearchWrapper();
    testFollowPathAndRepath();
    testPathfinderClass();
    testFrictionNotPathCost();
    testAllySwapAndYield();
    testElementalFieldAvoidance();
    testSummonMasterIdOnlyNoFieldFreePass();
    testMultiTickFieldSafeSpotAndProvoke();
    testFieldPenaltyMinimalExposure();
    testBenchmarkOptional();
    console.log('pathfinder: ok');
}

main();
