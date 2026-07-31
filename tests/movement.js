#!/usr/bin/env node
/**
 * Stage 3 exit criteria: movement delay, party ghost-walk on floor-07,
 * no illegal tile overlap, seed-stable step log.
 * Quiet on success; VERBOSE=1 for detail.
 */

'use strict';

const assert = require('assert');
const { Settings } = require('../kernel/settings.js');
const { Time, LOGIC_DT } = require('../kernel/core/lib/time.js');
const {
    computeMoveDelay,
    getMovementDelay,
    getBreakpointForFrictionAndSpeed,
    getFrictionBreakpoints,
    normalizeFriction,
    DEFAULT_TILE_FRICTION,
    FRICTION_TABLE,
    DELAY_TABLE,
    tileDistance,
    isDiagonalStep,
    isAdjacentStep,
    beginStepVisual,
    tickStepVisual,
    stepVisualProgress,
    snapVisualToTile,
    updateSpriteFacing,
    getVisualTilePos,
    getCanvasStepExtraDt
} = require('../kernel/core/lib/movement.js');
const { TileMap } = require('../kernel/core/entities/tilemap.js');
const { Creature } = require('../kernel/core/entities/creature.js');
const { Player } = require('../kernel/core/entities/player.js');
const { Party } = require('../kernel/core/entities/party.js');
const { Simulator } = require('../kernel/providers/simulator/simulator.js');
const {
    runHeadlessPartyWalk,
    DEFAULT_FLOOR07_WAYPOINTS
} = require('../kernel/providers/simulator/headless_runner.js');

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

function openFloor(cols, rows, gray) {
    const g = gray !== undefined ? gray : 100;
    const pixels = [];
    for (let i = 0; i < cols * rows; i++) pixels.push([g, g, g]);
    const map = new TileMap();
    map.loadFloorFromRgba(0, cols, rows, rgbaFromPixels(cols, rows, pixels));
    return map;
}

/**
 * Legacy breakpoint tables (friction 100 row + delay table).
 * speed 1–113 → bp 10 → 0.40s; 114–135 → bp 11 → 0.35s; etc.
 */
function testLegacyBreakpointTables() {
    assert.strictEqual(DEFAULT_TILE_FRICTION, 100);
    assert.strictEqual(DELAY_TABLE.length, 18);
    assert.deepStrictEqual(
        FRICTION_TABLE[100],
        [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 113, 135, 167, 219, 321, 592, 2382]
    );

    assert.strictEqual(normalizeFriction(null), 100);
    assert.strictEqual(normalizeFriction(0), 100);
    assert.strictEqual(normalizeFriction(255), 100); // blocked sentinel → default
    assert.strictEqual(normalizeFriction(50), 70); // below table → clamp low
    assert.strictEqual(normalizeFriction(251), 250); // above table max, walkable → clamp high

    const bp100 = getFrictionBreakpoints(100);
    assert.strictEqual(bp100.length, 17);
    assert.strictEqual(bp100[10], 113);

    // Interpolated friction between known keys must stay finite length-17
    const bp105 = getFrictionBreakpoints(105);
    assert.strictEqual(bp105.length, 17);
    assert.ok(bp105[10] >= 113 && bp105[10] <= 126);

    // speed 110 on friction 100: clears zeros (0–9) and stops before 113 → bp 10
    assert.strictEqual(getBreakpointForFrictionAndSpeed(100, 110), 10);
    assert.strictEqual(getBreakpointForFrictionAndSpeed(100, 0), 0);
    assert.strictEqual(getBreakpointForFrictionAndSpeed(100, 113), 10);
    assert.strictEqual(getBreakpointForFrictionAndSpeed(100, 114), 11);
    assert.strictEqual(getBreakpointForFrictionAndSpeed(100, 2383), 17);

    assert.ok(Math.abs(getMovementDelay(100, 110) - 0.4) < 1e-9);
    assert.ok(Math.abs(getMovementDelay(100, 114) - 0.35) < 1e-9);
    assert.ok(Math.abs(getMovementDelay(100, 0) - 1.5) < 1e-9);
    assert.ok(Math.abs(getMovementDelay(100, 2383) - 0.05) < 1e-9);

    log('legacy breakpoint tables ok');
}

function testComputeMoveDelay() {
    const prev = {
        diag: Settings.MOVE_DIAGONAL_FACTOR,
        min: Settings.MOVE_MIN_DELAY
    };
    Settings.MOVE_DIAGONAL_FACTOR = 2;
    Settings.MOVE_MIN_DELAY = 0.05;

    // friction=100, speed=110 → legacy bp 10 → 0.4s (same as old continuous formula at ref)
    const d0 = computeMoveDelay(100, 110, false);
    assert.ok(Math.abs(d0 - 0.4) < 1e-9, `expected 0.4 got ${d0}`);

    const dDiag = computeMoveDelay(100, 110, true);
    assert.ok(Math.abs(dDiag - 0.8) < 1e-9, `diagonal 2×: ${dDiag}`);

    // Discrete step: 220 clears 219 (index 13) → bp 14 → 0.20s
    const faster = computeMoveDelay(100, 220, false);
    assert.ok(Math.abs(faster - 0.2) < 1e-9, `speed 220 → 0.2 got ${faster}`);
    assert.ok(faster < d0, 'higher speed → lower delay');

    // Higher friction raises thresholds → same speed may land on slower bucket
    const stickier = computeMoveDelay(200, 110, false);
    assert.ok(stickier > d0, 'higher friction → higher delay');

    // Missing friction uses default 100
    assert.ok(
        Math.abs(computeMoveDelay(null, 110, false) - 0.4) < 1e-9,
        'null friction → default 100'
    );

    assert.ok(isDiagonalStep(0, 0, 1, 1));
    assert.ok(!isDiagonalStep(0, 0, 1, 0));
    assert.strictEqual(tileDistance({ x: 0, y: 0 }, { x: 3, y: 1 }), 3);

    Object.assign(Settings, {
        MOVE_DIAGONAL_FACTOR: prev.diag,
        MOVE_MIN_DELAY: prev.min
    });
    log('computeMoveDelay ok');
}

function testMoveEntitySetsDelay() {
    const map = openFloor(5, 5, 100);
    const c = new Creature({ id: 1, speed: 110, tile: { x: 0, y: 0, z: 0 } });
    assert.ok(map.tryOccupy(0, 0, 0, c));
    c.moveDelay = 0;

    const ok = map.moveEntityToTile(c, 1, 0, 0);
    assert.ok(ok);
    assert.strictEqual(c.tile.x, 1);
    assert.ok(c.moveDelay > 0, 'move sets delay');
    assert.strictEqual(map.getOccupant(0, 0, 0), 0);
    assert.strictEqual(map.getOccupant(1, 0, 0), 1);

    const delayCardinal = c.moveDelay;
    // Default walkable gray 100 + speed 110 → legacy table 0.4s
    assert.ok(
        Math.abs(delayCardinal - 0.4) < 1e-9,
        `default friction 100 → 0.4s, got ${delayCardinal}`
    );
    c.moveDelay = 0;
    map.moveEntityToTile(c, 2, 1, 0);
    assert.ok(c.moveDelay > delayCardinal, 'diagonal delay > cardinal');
    log('moveEntityToTile delay ok', { delayCardinal, delayDiag: c.moveDelay });
}

/**
 * Destination friction drives moveDelay; dungeon default walk gray is 100
 * (same as DEFAULT_TILE_FRICTION). Stickier tiles slow steps but stay walkable.
 */
function testDefaultFriction100AndDestinationDelay() {
    const { DEFAULT_WALK_FRICTION } = require('../kernel/core/lib/dungeon/pieces.js');
    assert.strictEqual(DEFAULT_TILE_FRICTION, 100);
    assert.strictEqual(
        DEFAULT_WALK_FRICTION,
        DEFAULT_TILE_FRICTION,
        'dungeon walk default matches movement default'
    );

    const cols = 4;
    const rows = 1;
    const friction = new Uint8Array([100, 100, 200, 100]);
    const map = new TileMap();
    map.loadFloorFromFriction(0, cols, rows, friction);

    const c = new Creature({ id: 1, speed: 110, tile: { x: 0, y: 0, z: 0 } });
    assert.ok(map.tryOccupy(0, 0, 0, c));

    c.moveDelay = 0;
    assert.ok(map.moveEntityToTile(c, 1, 0, 0));
    const d100 = c.moveDelay;
    assert.ok(Math.abs(d100 - 0.4) < 1e-9, `step onto 100 → 0.4 got ${d100}`);

    c.moveDelay = 0;
    assert.ok(map.moveEntityToTile(c, 2, 0, 0));
    const d200 = c.moveDelay;
    assert.ok(d200 > d100, `step onto 200 slower than 100 (${d200} vs ${d100})`);
    assert.ok(
        Math.abs(d200 - computeMoveDelay(200, 110, false)) < 1e-9,
        'delay matches destination friction'
    );

    log('default friction 100 + destination delay ok', { d100, d200 });
}

function testPartySkeleton() {
    const party = new Party({
        name: 'A',
        waypoints: [
            { x: 0, y: 0, z: 0 },
            { x: 2, y: 0, z: 0 }
        ]
    });
    const p = new Player({
        id: 1,
        name: 'L',
        isLeader: true,
        tile: { x: 0, y: 0, z: 0 }
    });
    party.addMember(p);
    assert.strictEqual(party.getLeader(), p);
    assert.strictEqual(party.members.length, 1);
    assert.strictEqual(party.waypoints.length, 2);
    assert.strictEqual(party.loopWaypoints, false);
    assert.strictEqual(p.type, 'player');
    assert.strictEqual(p.classId, 'adventurer');
    log('party skeleton ok');
}

/**
 * loopWaypoints: after last wp, index wraps to 0 and route never completes.
 */
async function testLoopWaypoints() {
    const map = openFloor(10, 3, 100);
    const sim = new Simulator({ seed: 3, recordSteps: true });
    await sim.start();
    sim.setTileMap(map);
    sim.spawnParty({
        name: 'Loop',
        loopWaypoints: true,
        waypoints: [
            { x: 1, y: 1, z: 0 },
            { x: 4, y: 1, z: 0 },
            { x: 7, y: 1, z: 0 }
        ],
        members: [{ name: 'Solo', isLeader: true, speed: 220 }]
    });

    const party = sim.parties[0];
    const leader = party.members[0];
    assert.strictEqual(party.loopWaypoints, true);
    assert.strictEqual(party.allRoutesComplete(), false);

    let sawWrap = false;
    let maxWp = 0;
    let frames = 0;
    const max = 800;
    while (frames < max) {
        Time.advanceFixedLogicStep();
        sim.updateAll();
        frames += 1;
        maxWp = Math.max(maxWp, leader.currentWaypoint | 0);
        // After visiting the end of the list, index should wrap (not complete).
        if (leader.currentWaypoint === 0 && maxWp >= 2) {
            sawWrap = true;
            break;
        }
        assert.strictEqual(leader.routeComplete, false, 'loop never completes');
        assert.strictEqual(sim.sessionState, 'running');
        assertNoStack(map, 0);
    }

    assert.ok(sawWrap, 'wrapped to waypoint 0 after last');
    assert.strictEqual(party.allRoutesComplete(), false);
    assert.strictEqual(sim.sessionState, 'running');
    assert.ok(!sim.allRoutesComplete(), 'sim route stays open while looping');
    sim.destroy();
    log('loop waypoints ok', { frames, maxWp, wp: leader.currentWaypoint });
}

async function testTinyGhostWalk() {
    const map = openFloor(8, 3, 100);
    const sim = new Simulator({ seed: 9, recordSteps: true });
    await sim.start();
    sim.setTileMap(map);
    // setTileMap after start — parties not yet spawned
    sim.spawnParty({
        name: 'Tiny',
        waypoints: [
            { x: 0, y: 1, z: 0 },
            { x: 3, y: 1, z: 0 },
            { x: 6, y: 1, z: 0 }
        ],
        members: [{ name: 'Solo', isLeader: true, speed: 220 }]
    });

    let frames = 0;
    const max = 500;
    while (!sim.allRoutesComplete() && frames < max) {
        Time.advanceFixedLogicStep();
        sim.updateAll();
        frames += 1;
        // Occupancy: at most one entity per tile
        assertNoStack(map, 0);
    }

    assert.ok(sim.allRoutesComplete(), 'route completed');
    assert.ok(sim.stepLog.length > 0, 'steps recorded');
    const leader = sim.parties[0].members[0];
    assert.strictEqual(leader.tile.x, 6);
    assert.strictEqual(leader.tile.y, 1);
    assert.strictEqual(sim.sessionState, 'route_complete');
    sim.destroy();
    log('tiny ghost walk ok', { frames, steps: sim.stepLog.length });
}

function assertNoStack(map, z) {
    const layer = map.getLayer(z);
    assert.ok(layer);
    const seen = new Map();
    for (let i = 0; i < layer.occupancy.length; i++) {
        const id = layer.occupancy[i];
        if (id === 0) continue;
        assert.ok(!seen.has(id), `entity ${id} on multiple tiles`);
        seen.set(id, i);
    }
    // values unique already; also no two same cells (array cells are exclusive)
}

async function testFloor07PartyWalk() {
    const run1 = await runHeadlessPartyWalk({
        seed: 42,
        frames: 4000,
        floor: 7,
        waypoints: DEFAULT_FLOOR07_WAYPOINTS,
        members: [
            { name: 'Leader', classId: 'fighter', isLeader: true, speed: 150 },
            { name: 'Ally', classId: 'ranger', isLeader: false, speed: 150 }
        ],
        recordSteps: true
    });

    assert.ok(run1.routeComplete, 'party finished route on floor-07');
    assert.ok(run1.stepLog.length > 0, 'seed-stable step log non-empty');
    assert.strictEqual(run1.waypoints.length, 5);
    assert.ok(run1.parties[0].members.length === 2);

    // Every member marked route complete; near final waypoint
    const last = DEFAULT_FLOOR07_WAYPOINTS[DEFAULT_FLOOR07_WAYPOINTS.length - 1];
    for (const m of run1.parties[0].members) {
        assert.ok(m.routeComplete, `${m.name} routeComplete`);
        const d = Math.max(Math.abs(m.x - last.x), Math.abs(m.y - last.y));
        assert.ok(d <= 1, `${m.name} near last wp (d=${d}) at ${m.x},${m.y}`);
    }

    const run2 = await runHeadlessPartyWalk({
        seed: 42,
        frames: 4000,
        floor: 7,
        waypoints: DEFAULT_FLOOR07_WAYPOINTS,
        members: [
            { name: 'Leader', classId: 'fighter', isLeader: true, speed: 150 },
            { name: 'Ally', classId: 'ranger', isLeader: false, speed: 150 }
        ],
        recordSteps: true
    });

    assert.deepStrictEqual(
        run1.stepLog,
        run2.stepLog,
        'same seed ⇒ identical step log'
    );
    assert.strictEqual(run1.tickCount, run2.tickCount);
    assert.deepStrictEqual(run1.parties, run2.parties);

    const runOther = await runHeadlessPartyWalk({
        seed: 99,
        frames: 4000,
        floor: 7,
        waypoints: DEFAULT_FLOOR07_WAYPOINTS,
        members: [
            { name: 'Leader', classId: 'fighter', isLeader: true, speed: 150 },
            { name: 'Ally', classId: 'ranger', isLeader: false, speed: 150 }
        ],
        recordSteps: true
    });
    // Different seed may still walk same path (no random in walk), but
    // still complete; if logs equal that is OK for pure pathing.
    assert.ok(runOther.routeComplete);

    log('floor-07 party walk ok', {
        ticks: run1.tickCount,
        steps: run1.stepLog.length,
        time: run1.timeSinceLevelLoad
    });
}

async function testNoIllegalOverlapDuringWalk() {
    // Instrumented sim: after every tick, occupancy ids unique
    const sim = new Simulator({
        seed: 7,
        floor: 7,
        recordSteps: true,
        parties: [
            {
                name: 'P',
                waypoints: DEFAULT_FLOOR07_WAYPOINTS,
                members: [
                    { name: 'A', isLeader: true, speed: 180 },
                    { name: 'B', isLeader: false, speed: 180 }
                ]
            }
        ]
    });
    await sim.start();

    const z = 7;
    let frames = 0;
    while (!sim.allRoutesComplete() && frames < 4000) {
        Time.advanceFixedLogicStep();
        sim.updateAll();
        frames += 1;
        assertNoStack(sim.tileMap, z);
        // Cross-check member tiles match occupancy
        const positions = new Map();
        for (const party of sim.parties) {
            for (const m of party.members) {
                const key = `${m.tile.x},${m.tile.y},${m.tile.z}`;
                assert.ok(
                    !positions.has(key),
                    `overlap at ${key}: ${positions.get(key)} vs ${m.id}`
                );
                positions.set(key, m.id);
                assert.strictEqual(
                    sim.tileMap.getOccupant(m.tile.x, m.tile.y, m.tile.z),
                    m.id,
                    `occupancy mismatch for ${m.id}`
                );
            }
        }
    }
    assert.ok(sim.allRoutesComplete(), 'completed without illegal overlap');
    sim.destroy();
    log('no illegal overlap ok', { frames });
}

async function testCreatureDelayGatesSteps() {
    const map = openFloor(6, 1, 100);
    const sim = new Simulator({ seed: 1, recordSteps: true });
    await sim.start();
    sim.setTileMap(map);
    sim.spawnParty({
        waypoints: [
            { x: 0, y: 0, z: 0 },
            { x: 4, y: 0, z: 0 }
        ],
        members: [{ name: 'Slow', isLeader: true, speed: 110 }]
    });

    // First tick: one step
    Time.advanceFixedLogicStep();
    sim.updateAll();
    const m = sim.parties[0].members[0];
    assert.ok(m.moveDelay > 0);
    const xAfterFirst = m.tile.x;
    assert.ok(xAfterFirst >= 1 || m.routeComplete);

    // While delay remains, position must not change
    const delayLeft = m.moveDelay;
    const ticksBlocked = Math.max(1, Math.floor(delayLeft / LOGIC_DT) - 1);
    for (let i = 0; i < ticksBlocked; i++) {
        Time.advanceFixedLogicStep();
        sim.updateAll();
        assert.strictEqual(m.tile.x, xAfterFirst, 'gated by moveDelay');
    }
    sim.destroy();
    log('delay gates steps ok');
}

/**
 * Logic tile snaps instantly; presentation x/y slides over moveDelay
 * (legacy sprite slide). When ready to step again, visual is on tile.
 */
function testStepVisualSlide() {
    assert.ok(isAdjacentStep({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }));
    assert.ok(isAdjacentStep({ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }));
    assert.ok(
        !isAdjacentStep({ x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }),
        'multi-tile jump is not adjacent'
    );
    assert.ok(
        !isAdjacentStep({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }),
        'floor change is not adjacent'
    );

    const map = openFloor(5, 3, 100);
    const c = new Creature({
        id: 7,
        speed: 110,
        tile: { x: 0, y: 1, z: 0 }
    });
    assert.ok(map.tryOccupy(0, 1, 0, c));
    c.syncPositionFromTile();
    assert.strictEqual(c.x, 0);
    assert.strictEqual(c.y, 1);

    c.moveDelay = 0;
    assert.strictEqual(c.spriteFacing, 1, 'default facing right');
    const ok = map.moveEntityToTile(c, 1, 1, 0);
    assert.ok(ok);
    // Logic tile already at destination
    assert.strictEqual(c.tile.x, 1);
    assert.strictEqual(c.tile.y, 1);
    // Visual still at previous tile at the start of the slide
    assert.strictEqual(c.x, 0, 'visual starts at previous tile');
    assert.strictEqual(c.y, 1);
    assert.strictEqual(c.spriteFacing, 1, 'step right keeps facing right');
    assert.ok(c.moveDelay > 0);
    assert.ok(c._moveVisDuration > 0);
    assert.ok(Math.abs(c._moveVisDuration - c.moveDelay) < 1e-9);
    assert.strictEqual(stepVisualProgress(c), 0);

    const fullDelay = c.moveDelay;
    // Mid-slide after half the duration
    tickStepVisual(c, fullDelay * 0.5);
    assert.ok(Math.abs(c.x - 0.5) < 1e-9, `mid x expected 0.5 got ${c.x}`);
    assert.strictEqual(c.tile.x, 1, 'logic tile stays at destination');
    assert.ok(stepVisualProgress(c) > 0.49 && stepVisualProgress(c) < 0.51);

    // Finish slide: sprite lands when the step window ends
    tickStepVisual(c, fullDelay * 0.5 + 0.001);
    assert.strictEqual(c.x, 1, 'visual lands on logic tile');
    assert.strictEqual(c.y, 1);
    assert.strictEqual(c._moveVisDuration, 0);
    assert.strictEqual(c.moveSpeed, 0);

    // Diagonal: visual interpolates both axes over delay
    c.moveDelay = 0;
    map.moveEntityToTile(c, 2, 2, 0);
    assert.strictEqual(c.tile.x, 2);
    assert.strictEqual(c.tile.y, 2);
    assert.strictEqual(c.x, 1);
    assert.strictEqual(c.y, 1);
    const d = c.moveDelay;
    tickStepVisual(c, d);
    assert.strictEqual(c.x, 2);
    assert.strictEqual(c.y, 2);

    // Stairs / z change snaps (no long slide)
    c.x = 2;
    c.y = 2;
    c.tile = { x: 2, y: 2, z: 0 };
    c.moveDelay = 0;
    // Manually place on z=0 then force a z hop via begin/snap path
    // (openFloor only has z=0 — exercise helpers directly)
    c.tile = { x: 4, y: 2, z: 1 };
    beginStepVisual(c, { x: 2, y: 2, z: 0 }, 0.4);
    assert.strictEqual(c.x, 4, 'z change snaps visual');
    assert.strictEqual(c.y, 2);
    assert.strictEqual(c._moveVisDuration, 0);

    // getVisualTilePos prefers presentation coords
    c.tile = { x: 3, y: 1, z: 0 };
    c.x = 2.25;
    c.y = 1;
    const vis = getVisualTilePos(c);
    assert.ok(vis);
    assert.strictEqual(vis.x, 2.25);
    assert.strictEqual(vis.y, 1);

    snapVisualToTile(c);
    assert.strictEqual(c.x, 3);
    assert.strictEqual(c.y, 1);

    log('step visual slide ok');
}

/**
 * Watch-mode facing: horizontal steps flip left/right; pure vertical keeps prior.
 */
function testSpriteFacingOnStep() {
    const ent = {
        tile: { x: 2, y: 2, z: 0 },
        spriteFacing: 1
    };
    updateSpriteFacing(ent, { x: 1, y: 2, z: 0 });
    assert.strictEqual(ent.spriteFacing, 1, 'right step → face right');

    updateSpriteFacing(ent, { x: 3, y: 2, z: 0 });
    assert.strictEqual(ent.spriteFacing, -1, 'left step → face left');

    updateSpriteFacing(ent, { x: 2, y: 1, z: 0 });
    assert.strictEqual(ent.spriteFacing, -1, 'vertical-only keeps left');

    updateSpriteFacing(ent, { x: 2, y: 3, z: 0 });
    assert.strictEqual(ent.spriteFacing, -1, 'vertical-only still left');

    updateSpriteFacing(ent, { x: 1, y: 1, z: 0 });
    assert.strictEqual(ent.spriteFacing, 1, 'diagonal with +dx → face right');

    // beginStepVisual also sets facing
    const c = {
        tile: { x: 0, y: 0, z: 0 },
        x: 1,
        y: 0,
        spriteFacing: 1,
        _moveVisDuration: 0,
        _moveVisElapsed: 0
    };
    beginStepVisual(c, { x: 1, y: 0, z: 0 }, 0.2);
    assert.strictEqual(c.spriteFacing, -1);
    assert.ok(c._moveVisDuration > 0, 'adjacent left step still slides');

    log('sprite facing on step ok');
}

/**
 * Pause / seek must freeze canvas sub-frame interp so mid-slide sprites
 * do not jitter as wall-clock advances between frozen logic ticks.
 */
function testCanvasStepExtraDtPauseFreeze() {
    const prevApp = Settings.app;
    const prevSpeed = Settings.TIME_SPEED;
    Settings.TIME_SPEED = 1;
    Settings.app = {
        paused: false,
        lastUpdate: 1000,
        currentLevel: null
    };

    const live = getCanvasStepExtraDt(1025);
    assert.ok(live > 0 && live <= 0.05, `live extraDt expected ~0.025 got ${live}`);
    assert.ok(Math.abs(live - 0.025) < 1e-9);

    Settings.app.paused = true;
    assert.strictEqual(
        getCanvasStepExtraDt(1025),
        0,
        'paused must freeze sub-frame interp'
    );

    Settings.app.paused = false;
    Settings.app.currentLevel = { _seekInProgress: true };
    assert.strictEqual(
        getCanvasStepExtraDt(1025),
        0,
        'seek-in-progress must freeze sub-frame interp'
    );

    // Mid-slide: wall extraDt advances draw pos; frozen (0) stays at elapsed only
    const ent = {
        tile: { x: 1, y: 0, z: 0 },
        _moveVisFromX: 0,
        _moveVisFromY: 0,
        _moveVisDuration: 0.1,
        _moveVisElapsed: 0.05,
        x: 0.5,
        y: 0
    };
    const withExtra = getVisualTilePos(ent, 0.025);
    const frozen = getVisualTilePos(ent, 0);
    assert.ok(withExtra && frozen);
    assert.ok(
        withExtra.x > frozen.x,
        `extraDt should advance slide: live=${withExtra.x} frozen=${frozen.x}`
    );
    assert.ok(Math.abs(frozen.x - 0.5) < 1e-9);

    Settings.app = prevApp;
    Settings.TIME_SPEED = prevSpeed;
    log('canvas step extraDt pause freeze ok');
}

/**
 * Through Simulator.updateAll: after a step, tile is ahead of visual until
 * moveDelay elapses; when the next step is allowed, visual has caught up.
 */
async function testStepVisualThroughSim() {
    const map = openFloor(8, 1, 100);
    const sim = new Simulator({ seed: 2, recordSteps: true });
    await sim.start();
    sim.setTileMap(map);
    sim.spawnParty({
        waypoints: [
            { x: 0, y: 0, z: 0 },
            { x: 5, y: 0, z: 0 }
        ],
        members: [{ name: 'Walker', isLeader: true, speed: 110 }]
    });

    Time.advanceFixedLogicStep();
    sim.updateAll();
    const m = sim.parties[0].members[0];
    assert.ok(m.tile.x >= 1 || m.routeComplete);
    if (m.moveDelay > 0 && m.tile.x > 0) {
        // Logic already advanced; visual still lagging or mid-slide
        assert.ok(
            m.x < m.tile.x || Math.abs(m.x - m.tile.x) < 1e-9,
            `visual x ${m.x} should not lead logic ${m.tile.x}`
        );
        const logicX = m.tile.x;
        // Drain remaining delay
        let guard = 0;
        while (m.moveDelay > 0 && guard < 200) {
            Time.advanceFixedLogicStep();
            sim.updateAll();
            guard++;
            // While gated on same tile, visual should approach logicX
            if (m.tile.x === logicX) {
                assert.ok(
                    m.x <= logicX + 1e-9,
                    'visual stays on/behind current logic tile during slide'
                );
            }
        }
        // When ready to move again (or just finished slide on this tile)
        if (m.tile.x === logicX) {
            assert.ok(
                Math.abs(m.x - m.tile.x) < 1e-6,
                `visual should land when delay clears: x=${m.x} tile=${m.tile.x}`
            );
        }
    }
    sim.destroy();
    log('step visual through sim ok');
}

async function main() {
    testLegacyBreakpointTables();
    testComputeMoveDelay();
    testMoveEntitySetsDelay();
    testDefaultFriction100AndDestinationDelay();
    testStepVisualSlide();
    testSpriteFacingOnStep();
    testCanvasStepExtraDtPauseFreeze();
    testPartySkeleton();
    await testLoopWaypoints();
    await testTinyGhostWalk();
    await testCreatureDelayGatesSteps();
    await testStepVisualThroughSim();
    await testFloor07PartyWalk();
    await testNoIllegalOverlapDuringWalk();
    console.log('movement: ok');
}

main().catch((err) => {
    console.error('movement: FAIL');
    console.error(err);
    process.exit(1);
});
