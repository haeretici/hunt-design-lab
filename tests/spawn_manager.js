#!/usr/bin/env node
/**
 * SpawnManager unit tests: activate / despawn / respawn / no double-spawn.
 * Quiet on success; VERBOSE=1 for detail.
 */

'use strict';

const assert = require('assert');
const { Settings } = require('../kernel/settings.js');
const {
    SpawnManager,
    makeSpawnKey,
    normalizeSpawnEntry
} = require('../kernel/core/lib/spawn_manager.js');

const VERBOSE = !!process.env.VERBOSE;

function log(...args) {
    if (VERBOSE) console.log(...args);
}

/** Minimal host: id map + spawn counter. */
function makeHost() {
    let nextId = 1;
    /** @type {Map<number, object>} */
    const entities = new Map();
    const log = { spawned: 0, despawned: 0 };

    return {
        entities,
        log,
        getEntity(id) {
            return entities.get(id) || null;
        },
        spawn(state) {
            const id = nextId++;
            const entity = {
                id,
                alive: true,
                hp: { current: 10, max: 10 },
                tile: { x: state.x, y: state.y, z: state.z },
                creatureId: state.creatureId
            };
            entities.set(id, entity);
            log.spawned += 1;
            return entity;
        },
        despawn(entity) {
            if (!entity) return;
            entity.alive = false;
            entity.hp.current = 0;
            entities.delete(entity.id);
            log.despawned += 1;
        },
        kill(id) {
            const e = entities.get(id);
            if (!e) return;
            e.alive = false;
            e.hp.current = 0;
            entities.delete(id);
        },
        move(id, x, y, z) {
            const e = entities.get(id);
            if (!e) return;
            e.tile = { x, y, z: z !== undefined ? z : e.tile.z };
        }
    };
}

function testSettingsKnobs() {
    assert.strictEqual(typeof Settings.SPAWN_MODE, 'string');
    assert.strictEqual(
        Settings.SPAWN_MODE,
        'eager',
        'SPAWN_MODE default is eager for stable hunts'
    );
    assert.strictEqual(Settings.SPAWN_ACTIVATE_RADIUS, 10);
    assert.strictEqual(Settings.SPAWN_DESPAWN_HOME_DIST, 20);
    assert.ok(Settings.SPAWN_DESPAWN_IDLE_SEC >= 0);
    assert.ok(Settings.SPAWN_MAX_LIVING >= 0);
    assert.ok(Settings.SPAWN_TIME_MULTIPLIER > 0);
    assert.ok(Settings.SPAWN_CHUNK_SIZE >= 1);
    // Activate radius should cover AI tick bubble (scale alignment).
    assert.ok(
        Settings.SPAWN_ACTIVATE_RADIUS >= Settings.AI_TICK_RADIUS ||
            Settings.AI_TICK_RADIUS === 0,
        'SPAWN_ACTIVATE_RADIUS should be ≥ AI_TICK_RADIUS'
    );
    log('settings knobs ok');
}

function testNormalizeAndKey() {
    const n = normalizeSpawnEntry({
        creatureId: 'cave_rat',
        x: 10.4,
        y: 20.6,
        z: 7,
        respawn: 60
    });
    assert.ok(n);
    assert.strictEqual(n.x, 10);
    assert.strictEqual(n.y, 21);
    assert.strictEqual(n.z, 7);
    assert.strictEqual(n.respawn, 60);
    assert.strictEqual(n.key, makeSpawnKey(n));

    const fromLegacy = normalizeSpawnEntry({
        name: 'Cave Rat',
        x: 1,
        y: 2,
        z: 7,
        spawntime: 90
    });
    assert.strictEqual(fromLegacy.respawn, 90);
    assert.ok(fromLegacy.key.includes('Cave Rat') || fromLegacy.creatureId);

    assert.strictEqual(normalizeSpawnEntry(null), null);
    assert.strictEqual(normalizeSpawnEntry({ creatureId: 'x' }), null);
    log('normalize ok');
}

function testActivateOnDemand() {
    const host = makeHost();
    const mgr = new SpawnManager({
        mode: 'on_demand',
        activateRadius: 10,
        despawnHomeDist: 20
    });
    mgr.load([
        { creatureId: 'near_rat', x: 100, y: 100, z: 7, respawn: 0 },
        { creatureId: 'far_rat', x: 200, y: 200, z: 7, respawn: 0 }
    ]);
    assert.strictEqual(mgr.size, 2);

    // No observers → nothing spawns
    let r = mgr.tick({
        time: 0,
        observers: [],
        getEntity: host.getEntity,
        spawn: host.spawn.bind(host),
        despawn: host.despawn.bind(host)
    });
    assert.strictEqual(r.spawned.length, 0);
    assert.strictEqual(host.log.spawned, 0);

    // Observer near first only
    r = mgr.tick({
        time: 1,
        observers: [{ x: 105, y: 100, z: 7 }],
        getEntity: host.getEntity,
        spawn: host.spawn.bind(host),
        despawn: host.despawn.bind(host)
    });
    assert.strictEqual(r.spawned.length, 1);
    assert.strictEqual(r.spawned[0].creatureId, 'near_rat');
    assert.strictEqual(mgr.listSpawned().length, 1);
    assert.ok(mgr.getState(r.spawned[0].key).spawned);
    assert.strictEqual(mgr.getState(makeSpawnKey({ creatureId: 'far_rat', x: 200, y: 200, z: 7 })).spawned, false);

    // Walk to far rat
    r = mgr.tick({
        time: 2,
        observers: [{ x: 200, y: 200, z: 7 }],
        getEntity: host.getEntity,
        spawn: host.spawn.bind(host),
        despawn: host.despawn.bind(host)
    });
    assert.strictEqual(r.spawned.length, 1);
    assert.strictEqual(r.spawned[0].creatureId, 'far_rat');
    assert.strictEqual(mgr.listSpawned().length, 2);
    log('activate on_demand ok');
}

function testActivateEager() {
    const host = makeHost();
    const mgr = new SpawnManager({ mode: 'eager' });
    mgr.load([
        { creatureId: 'a', x: 0, y: 0, z: 0, respawn: 0 },
        { creatureId: 'b', x: 999, y: 999, z: 0, respawn: 0 }
    ]);
    const r = mgr.tick({
        time: 0,
        observers: [],
        getEntity: host.getEntity,
        spawn: host.spawn.bind(host)
    });
    assert.strictEqual(r.spawned.length, 2);
    assert.strictEqual(host.log.spawned, 2);
    log('activate eager ok');
}

function testNoDoubleSpawn() {
    const host = makeHost();
    const mgr = new SpawnManager({ mode: 'eager' });
    mgr.load([{ creatureId: 'rat', x: 5, y: 5, z: 0, respawn: 0 }]);

    const ctx = {
        time: 0,
        observers: [{ x: 5, y: 5, z: 0 }],
        getEntity: host.getEntity,
        spawn: host.spawn.bind(host)
    };
    const r1 = mgr.tick(ctx);
    assert.strictEqual(r1.spawned.length, 1);
    assert.strictEqual(host.log.spawned, 1);

    ctx.time = 10;
    const r2 = mgr.tick(ctx);
    assert.strictEqual(r2.spawned.length, 0, 'already spawned must not re-fire');
    assert.strictEqual(host.log.spawned, 1);
    assert.strictEqual(mgr.listSpawned().length, 1);

    // Host spawn side-effect should still only count one slot
    const state = mgr.listStates()[0];
    assert.strictEqual(state.entityId, r1.spawned[0].entityId);
    log('no double-spawn ok');
}

function testDespawnHomeDistance() {
    const host = makeHost();
    const mgr = new SpawnManager({
        mode: 'eager',
        despawnHomeDist: 20
    });
    mgr.load([{ creatureId: 'wanderer', x: 50, y: 50, z: 1, respawn: 5 }]);

    const ctx = {
        time: 0,
        observers: [{ x: 50, y: 50, z: 1 }],
        getEntity: host.getEntity,
        spawn: host.spawn.bind(host),
        despawn: host.despawn.bind(host)
    };
    const r0 = mgr.tick(ctx);
    assert.strictEqual(r0.spawned.length, 1);
    const id = r0.spawned[0].entityId;

    // Within leash home — stay
    host.move(id, 60, 50, 1); // dist 10
    ctx.time = 1;
    let r = mgr.tick(ctx);
    assert.strictEqual(r.despawned.length, 0);
    assert.strictEqual(mgr.listSpawned().length, 1);

    // Beyond 20 Chebyshev
    host.move(id, 71, 50, 1); // dist 21
    ctx.time = 2;
    r = mgr.tick(ctx);
    assert.strictEqual(r.despawned.length, 1);
    assert.strictEqual(r.despawned[0].spawned, false);
    assert.strictEqual(mgr.listSpawned().length, 0);
    assert.strictEqual(host.log.despawned, 1);
    assert.ok(!host.entities.has(id));
    log('despawn home distance ok');
}

function testDeathFreesSlot() {
    const host = makeHost();
    const mgr = new SpawnManager({ mode: 'eager' });
    mgr.load([{ creatureId: 'target', x: 1, y: 1, z: 0, respawn: 10 }]);

    const ctx = {
        time: 0,
        observers: [],
        getEntity: host.getEntity,
        spawn: host.spawn.bind(host),
        despawn: host.despawn.bind(host)
    };
    const r0 = mgr.tick(ctx);
    const id = r0.spawned[0].entityId;
    host.kill(id);

    ctx.time = 1;
    const r1 = mgr.tick(ctx);
    assert.strictEqual(r1.freed.length, 1);
    assert.strictEqual(r1.spawned.length, 0, 'respawn cooldown not elapsed');
    assert.strictEqual(mgr.listSpawned().length, 0);
    const state = mgr.listStates()[0];
    assert.strictEqual(state.spawned, false);
    assert.strictEqual(state.lastSpawnTime, 1);
    log('death frees slot ok');
}

function testRespawnAfterCooldown() {
    const host = makeHost();
    const mgr = new SpawnManager({
        mode: 'on_demand',
        activateRadius: 10,
        spawnTimeMultiplier: 1
    });
    mgr.load([{ creatureId: 'respawner', x: 0, y: 0, z: 0, respawn: 5 }]);

    const ctx = {
        time: 0,
        observers: [{ x: 0, y: 0, z: 0 }],
        getEntity: host.getEntity,
        spawn: host.spawn.bind(host),
        despawn: host.despawn.bind(host)
    };

    // First spawn immediate (initial lastSpawnTime far past)
    let r = mgr.tick(ctx);
    assert.strictEqual(r.spawned.length, 1);
    const firstId = r.spawned[0].entityId;

    host.kill(firstId);
    ctx.time = 1;
    r = mgr.tick(ctx);
    assert.strictEqual(r.freed.length, 1);
    assert.strictEqual(r.spawned.length, 0);

    // Still cooling: need time > lastSpawnTime(1) + 5
    ctx.time = 6;
    r = mgr.tick(ctx);
    assert.strictEqual(r.spawned.length, 0, 'strict > cooldown boundary');

    ctx.time = 6.01;
    r = mgr.tick(ctx);
    assert.strictEqual(r.spawned.length, 1);
    assert.notStrictEqual(r.spawned[0].entityId, firstId);
    assert.strictEqual(host.log.spawned, 2);
    log('respawn after cooldown ok');
}

function testRespawnMultiplier() {
    const host = makeHost();
    const mgr = new SpawnManager({
        mode: 'eager',
        spawnTimeMultiplier: 2
    });
    mgr.load([{ creatureId: 'slow', x: 0, y: 0, z: 0, respawn: 3 }]);
    const ctx = {
        time: 0,
        observers: [],
        getEntity: host.getEntity,
        spawn: host.spawn.bind(host)
    };
    let r = mgr.tick(ctx);
    host.kill(r.spawned[0].entityId);
    ctx.time = 1;
    mgr.tick(ctx);
    // need time > 1 + 3*2 = 7
    ctx.time = 7;
    r = mgr.tick(ctx);
    assert.strictEqual(r.spawned.length, 0);
    ctx.time = 7.01;
    r = mgr.tick(ctx);
    assert.strictEqual(r.spawned.length, 1);
    log('respawn multiplier ok');
}

function testNoDoubleAfterFailedHostSpawn() {
    const host = makeHost();
    let refuse = true;
    const mgr = new SpawnManager({ mode: 'eager' });
    mgr.load([{ creatureId: 'blocked', x: 0, y: 0, z: 0, respawn: 0 }]);

    const ctx = {
        time: 0,
        observers: [],
        getEntity: host.getEntity,
        spawn(state) {
            if (refuse) return null;
            return host.spawn(state);
        }
    };
    let r = mgr.tick(ctx);
    assert.strictEqual(r.spawned.length, 0);
    assert.strictEqual(mgr.listSpawned().length, 0);

    refuse = false;
    ctx.time = 1;
    r = mgr.tick(ctx);
    assert.strictEqual(r.spawned.length, 1);
    log('failed host spawn retries ok');
}

function testSameFloorOnly() {
    const host = makeHost();
    const mgr = new SpawnManager({ mode: 'on_demand', activateRadius: 50 });
    mgr.load([{ creatureId: 'floor7', x: 10, y: 10, z: 7, respawn: 0 }]);

    let r = mgr.tick({
        time: 0,
        observers: [{ x: 10, y: 10, z: 6 }],
        getEntity: host.getEntity,
        spawn: host.spawn.bind(host)
    });
    assert.strictEqual(r.spawned.length, 0, 'other floor must not activate');

    r = mgr.tick({
        time: 1,
        observers: [{ x: 10, y: 10, z: 7 }],
        getEntity: host.getEntity,
        spawn: host.spawn.bind(host)
    });
    assert.strictEqual(r.spawned.length, 1);
    log('same floor only ok');
}

function testDuplicateKeysDisambiguated() {
    const mgr = new SpawnManager();
    const n = mgr.load([
        { creatureId: 'rat', x: 1, y: 1, z: 0 },
        { creatureId: 'rat', x: 1, y: 1, z: 0 },
        { id: 'custom', creatureId: 'rat', x: 2, y: 2, z: 0 },
        { id: 'custom', creatureId: 'other', x: 9, y: 9, z: 0 }
    ]);
    // Stacked same-tile rows become unique slots (wipe packs, etc.)
    assert.strictEqual(n, 4);
    assert.strictEqual(mgr.size, 4);
    const keys = mgr.listStates().map((s) => s.key);
    assert.strictEqual(new Set(keys).size, 4);
    log('duplicate keys disambiguated ok');
}

function testNotifyEntityGone() {
    const host = makeHost();
    const mgr = new SpawnManager({ mode: 'eager' });
    mgr.load([{ creatureId: 'n', x: 0, y: 0, z: 0, respawn: 4 }]);
    const r = mgr.tick({
        time: 10,
        getEntity: host.getEntity,
        spawn: host.spawn.bind(host)
    });
    const id = r.spawned[0].entityId;
    const freed = mgr.notifyEntityGone(id, 12);
    assert.ok(freed);
    assert.strictEqual(freed.spawned, false);
    assert.strictEqual(freed.lastSpawnTime, 12);
    assert.strictEqual(mgr.listSpawned().length, 0);
    log('notifyEntityGone ok');
}

function testOneShotNoRespawn() {
    const host = makeHost();
    const mgr = new SpawnManager({ mode: 'eager' });
    mgr.load([{ creatureId: 'once', x: 0, y: 0, z: 0, respawn: 0 }]);
    const ctx = {
        time: 0,
        getEntity: host.getEntity,
        spawn: host.spawn.bind(host)
    };
    let r = mgr.tick(ctx);
    assert.strictEqual(r.spawned.length, 1);
    host.kill(r.spawned[0].entityId);
    ctx.time = 100;
    r = mgr.tick(ctx);
    assert.strictEqual(r.freed.length, 1);
    assert.strictEqual(r.spawned.length, 0, 'respawn:0 must not re-spawn');
    assert.ok(mgr.listStates()[0].exhausted);
    ctx.time = 200;
    r = mgr.tick(ctx);
    assert.strictEqual(r.spawned.length, 0);
    log('one-shot no respawn ok');
}

function testHomeDespawnDisabledWhenZero() {
    const host = makeHost();
    const mgr = new SpawnManager({
        mode: 'eager',
        despawnHomeDist: 0
    });
    mgr.load([{ creatureId: 'far', x: 0, y: 0, z: 0, respawn: 0 }]);
    const ctx = {
        time: 0,
        getEntity: host.getEntity,
        spawn: host.spawn.bind(host),
        despawn: host.despawn.bind(host)
    };
    const r0 = mgr.tick(ctx);
    host.move(r0.spawned[0].entityId, 999, 999, 0);
    ctx.time = 1;
    const r1 = mgr.tick(ctx);
    assert.strictEqual(r1.despawned.length, 0, 'despawnHomeDist 0 disables home check');
    assert.strictEqual(mgr.listSpawned().length, 1);
    log('home despawn disabled ok');
}

// --- Simulator integration ------------------------------------------------

const { TileMap } = require('../kernel/core/entities/tilemap.js');
const { Simulator } = require('../kernel/providers/simulator/simulator.js');
const { Time } = require('../kernel/core/lib/time.js');
const presets = require('../kernel/core/lib/presets.js');

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

function dummyTemplate() {
    return presets.loadCreatureTemplate('dummy');
}

/**
 * Inject an in-memory path map without triggering loadMaps (floor/mapPath).
 * @param {Simulator} sim
 * @param {TileMap} map
 */
function attachMap(sim, map) {
    sim.setTileMap(map);
    // Avoid start() loadMaps() which needs real PNG paths.
    sim.floor = null;
    sim.floors = null;
    sim.mapPath = null;
    sim.mapPaths = null;
}

async function testSimulatorEagerSpawnsAtStart() {
    const map = openFloor(40, 40, 100);
    const sim = new Simulator({
        seed: 1,
        combatAi: true,
        spawnMode: 'eager',
        spawns: [
            { creatureId: 'dummy', x: 5, y: 5, z: 0, respawn: 0 },
            { creatureId: 'dummy', x: 30, y: 30, z: 0, respawn: 0 }
        ],
        creatureLoader: () => dummyTemplate()
    });
    attachMap(sim, map);
    await sim.start();
    assert.strictEqual(sim.spawnMode, 'eager');
    assert.strictEqual(sim.creatures.length, 2, 'eager materializes all slots at start');
    assert.strictEqual(sim.spawnManager.listSpawned().length, 2);
    log('simulator eager at start ok');
}

async function testSimulatorOnDemandNearPlayerOnly() {
    const map = openFloor(80, 80, 100);
    const sim = new Simulator({
        seed: 2,
        combatAi: true,
        spawnMode: 'on_demand',
        parties: [
            {
                name: 'P',
                id: 'p',
                waypoints: [
                    { x: 10, y: 10, z: 0 },
                    { x: 12, y: 10, z: 0 }
                ],
                members: [
                    {
                        name: 'Lead',
                        classId: 'guardian',
                        isLeader: true,
                        strategyId: 'pacifist',
                        level: 20
                    }
                ]
            }
        ],
        spawns: [
            { creatureId: 'dummy', x: 11, y: 10, z: 0, respawn: 0 },
            { creatureId: 'dummy', x: 70, y: 70, z: 0, respawn: 0 }
        ],
        creatureLoader: () => dummyTemplate(),
        classLoader: (id) => presets.getClass(id)
    });
    attachMap(sim, map);
    await sim.start();
    // on_demand: nothing until combat tick with observers
    assert.strictEqual(sim.creatures.length, 0, 'no eager spawn in on_demand');

    Time.advanceFixedLogicStep();
    sim.updateAll();
    assert.strictEqual(
        sim.creatures.filter((c) => c.alive).length,
        1,
        'only near player slot activates'
    );
    const near = sim.creatures.find((c) => c.alive);
    assert.ok(near);
    assert.ok(
        Math.max(Math.abs(near.tile.x - 11), Math.abs(near.tile.y - 10)) <= 1 ||
            (near.tile.x === 11 && near.tile.y === 10)
    );
    log('simulator on_demand near only ok', {
        count: sim.creatures.length,
        tile: near && near.tile
    });
}

async function testSimulatorRespawnViaManager() {
    const map = openFloor(20, 20, 100);
    const sim = new Simulator({
        seed: 3,
        combatAi: true,
        spawnMode: 'eager',
        spawns: [{ creatureId: 'dummy', x: 8, y: 8, z: 0, respawn: 1 }],
        creatureLoader: () => dummyTemplate()
    });
    attachMap(sim, map);
    await sim.start();
    assert.strictEqual(sim.creatures.length, 1);
    const first = sim.creatures[0];
    const firstId = first.id;
    // Simulate kill path used by combat
    first.alive = false;
    first.hp.current = 0;
    if (sim.tileMap && first.tile) {
        sim.tileMap.release(first.tile.x, first.tile.y, first.tile.z, first);
    }
    sim.spawnManager.notifyEntityGone(firstId, Time.timeSinceLevelLoad);

    // Still cooling (need time > last + 1)
    Time.advanceFixedLogicStep(); // +0.05s
    sim.updateAll();
    const aliveMid = sim.creatures.filter((c) => c.alive);
    assert.strictEqual(aliveMid.length, 0, 'still on cooldown');

    // Advance past 1s cooldown
    for (let i = 0; i < 25; i++) {
        Time.advanceFixedLogicStep();
        sim.updateAll();
    }
    const aliveAfter = sim.creatures.filter((c) => c.alive);
    assert.strictEqual(aliveAfter.length, 1, 'respawned after cooldown');
    assert.notStrictEqual(aliveAfter[0].id, firstId);
    log('simulator respawn via manager ok');
}

function testIdleAoiDespawnHysteresis() {
    const host = makeHost();
    const mgr = new SpawnManager({
        mode: 'on_demand',
        activateRadius: 10,
        despawnIdleRadius: 10,
        despawnIdleSec: 2,
        despawnHomeDist: 0
    });
    mgr.load([{ creatureId: 'idle_rat', x: 50, y: 50, z: 0, respawn: 0 }]);

    const ctx = {
        time: 0,
        observers: [{ x: 50, y: 50, z: 0 }],
        getEntity: host.getEntity,
        spawn: host.spawn.bind(host),
        despawn: host.despawn.bind(host)
    };
    let r = mgr.tick(ctx);
    assert.strictEqual(r.spawned.length, 1);
    const id = r.spawned[0].entityId;
    assert.strictEqual(mgr.livingCount, 1);

    // Observer leaves — start away timer, no instant despawn
    ctx.observers = [{ x: 0, y: 0, z: 0 }];
    ctx.time = 1;
    r = mgr.tick(ctx);
    assert.strictEqual(r.idleDespawned.length, 0, 'hysteresis: not yet');
    assert.strictEqual(mgr.listSpawned().length, 1);
    assert.strictEqual(host.log.despawned, 0);

    // Still within 2s
    ctx.time = 2.5;
    r = mgr.tick(ctx);
    assert.strictEqual(r.idleDespawned.length, 0);
    assert.ok(host.entities.has(id));

    // Past hysteresis
    ctx.time = 3.01;
    r = mgr.tick(ctx);
    assert.strictEqual(r.idleDespawned.length, 1);
    assert.strictEqual(r.despawned.length, 1);
    assert.strictEqual(mgr.listSpawned().length, 0);
    assert.strictEqual(mgr.livingCount, 0);
    assert.ok(!host.entities.has(id));
    // Soft free: one-shot slot re-arms (not exhausted)
    const state = mgr.listStates()[0];
    assert.strictEqual(state.exhausted, false, 'idle unload must not exhaust');
    assert.strictEqual(state.spawned, false);

    // Observer returns → re-activate
    ctx.observers = [{ x: 50, y: 50, z: 0 }];
    ctx.time = 4;
    r = mgr.tick(ctx);
    assert.strictEqual(r.spawned.length, 1, 're-activates after idle unload');
    assert.strictEqual(mgr.livingCount, 1);
    log('idle aoi despawn hysteresis ok');
}

function testIdleAoiProtectsCombat() {
    const host = makeHost();
    const mgr = new SpawnManager({
        mode: 'on_demand',
        activateRadius: 10,
        despawnIdleSec: 1,
        despawnHomeDist: 0
    });
    mgr.load([{ creatureId: 'fighter', x: 10, y: 10, z: 0, respawn: 0 }]);
    const ctx = {
        time: 0,
        observers: [{ x: 10, y: 10, z: 0 }],
        getEntity: host.getEntity,
        spawn: host.spawn.bind(host),
        despawn: host.despawn.bind(host)
    };
    mgr.tick(ctx);
    const id = mgr.listSpawned()[0].entityId;
    const entity = host.entities.get(id);
    entity.target = { id: 'player' };
    entity.aiState = 'attack';

    ctx.observers = [];
    ctx.time = 100;
    const r = mgr.tick(ctx);
    assert.strictEqual(r.idleDespawned.length, 0, 'combat never idle-despawns');
    assert.strictEqual(mgr.listSpawned().length, 1);
    assert.ok(host.entities.has(id));

    // Clear combat → then idle far despawns
    entity.target = null;
    entity.aiState = 'idle';
    ctx.time = 100;
    mgr.tick(ctx); // start timer
    ctx.time = 101.5;
    const r2 = mgr.tick(ctx);
    assert.strictEqual(r2.idleDespawned.length, 1);
    log('idle aoi protects combat ok');
}

function testMaxLivingSoftCap() {
    const host = makeHost();
    const mgr = new SpawnManager({
        mode: 'on_demand',
        activateRadius: 50,
        despawnIdleSec: 0,
        despawnHomeDist: 0,
        maxLiving: 2
    });
    // Three slots near observer
    mgr.load([
        { creatureId: 'a', x: 0, y: 0, z: 0, respawn: 0 },
        { creatureId: 'b', x: 1, y: 0, z: 0, respawn: 0 },
        { creatureId: 'c', x: 40, y: 0, z: 0, respawn: 0 }
    ]);
    const ctx = {
        time: 0,
        observers: [{ x: 0, y: 0, z: 0 }],
        getEntity: host.getEntity,
        spawn: host.spawn.bind(host),
        despawn: host.despawn.bind(host)
    };
    let r = mgr.tick(ctx);
    assert.ok(r.spawned.length <= 2, 'cap limits initial activate');
    assert.strictEqual(mgr.livingCount, 2);
    assert.strictEqual(mgr.listSpawned().length, 2);
    // Prefer nearer slots
    const livingIds = mgr.listSpawned().map((s) => s.creatureId).sort();
    assert.deepStrictEqual(livingIds, ['a', 'b']);

    // Move observer to far camp: should prefer c over far-from-observer bodies
    ctx.observers = [{ x: 40, y: 0, z: 0 }];
    ctx.time = 1;
    r = mgr.tick(ctx);
    assert.strictEqual(mgr.livingCount, 2);
    const after = mgr.listSpawned().map((s) => s.creatureId);
    assert.ok(after.includes('c'), 'nearer-to-new-observer activates under cap');
    log('max living soft cap ok', { after, budgetEvicted: r.budgetEvicted.length });
}

function testMaxLivingNeverEvictsProtected() {
    const host = makeHost();
    const mgr = new SpawnManager({
        mode: 'on_demand',
        activateRadius: 100,
        despawnIdleSec: 0,
        maxLiving: 1
    });
    mgr.load([
        { creatureId: 'fighter', x: 0, y: 0, z: 0, respawn: 0 },
        { creatureId: 'idle', x: 5, y: 0, z: 0, respawn: 0 }
    ]);
    const ctx = {
        time: 0,
        observers: [{ x: 0, y: 0, z: 0 }],
        getEntity: host.getEntity,
        spawn: host.spawn.bind(host),
        despawn: host.despawn.bind(host)
    };
    // Spawn fighter first (nearer)
    mgr.tick(ctx);
    assert.strictEqual(mgr.livingCount, 1);
    const fighterState = mgr.listSpawned()[0];
    assert.strictEqual(fighterState.creatureId, 'fighter');
    const fighter = host.entities.get(fighterState.entityId);
    fighter.target = { id: 'p' };
    fighter.aiState = 'attack';

    // Raise cap briefly to spawn idle, then lower and ensure fighter stays
    mgr.maxLiving = 2;
    ctx.time = 1;
    mgr.tick(ctx);
    assert.strictEqual(mgr.livingCount, 2);

    mgr.maxLiving = 1;
    ctx.time = 2;
    const r = mgr.tick(ctx);
    assert.ok(r.budgetEvicted.length >= 1);
    assert.strictEqual(mgr.livingCount, 1);
    assert.strictEqual(
        mgr.listSpawned()[0].creatureId,
        'fighter',
        'protected combat stays under hard pressure'
    );
    log('max living never evicts protected ok');
}

function testEagerIgnoresIdleAoiAndKeepsDefaultUnlimited() {
    const host = makeHost();
    const mgr = new SpawnManager({
        mode: 'eager',
        despawnIdleSec: 2,
        despawnHomeDist: 0,
        maxLiving: 0
    });
    mgr.load([
        { creatureId: 'a', x: 0, y: 0, z: 0, respawn: 0 },
        { creatureId: 'b', x: 999, y: 999, z: 0, respawn: 0 }
    ]);
    const ctx = {
        time: 0,
        observers: [],
        getEntity: host.getEntity,
        spawn: host.spawn.bind(host),
        despawn: host.despawn.bind(host)
    };
    mgr.tick(ctx);
    assert.strictEqual(mgr.livingCount, 2);
    ctx.time = 100;
    const r = mgr.tick(ctx);
    assert.strictEqual(r.idleDespawned.length, 0, 'eager never idle-AOI despawns');
    assert.strictEqual(mgr.livingCount, 2);
    log('eager ignores idle aoi ok');
}

async function testSimulatorIdleDespawnAndPerf() {
    const map = openFloor(80, 80, 100);
    const prevIdle = Settings.SPAWN_DESPAWN_IDLE_SEC;
    const prevHome = Settings.SPAWN_DESPAWN_HOME_DIST;
    Settings.SPAWN_DESPAWN_IDLE_SEC = 0.1;
    Settings.SPAWN_DESPAWN_HOME_DIST = 0;
    try {
        const sim = new Simulator({
            seed: 9,
            combatAi: true,
            spawnMode: 'on_demand',
            parties: [
                {
                    name: 'P',
                    id: 'p',
                    waypoints: [
                        { x: 10, y: 10, z: 0 },
                        { x: 11, y: 10, z: 0 }
                    ],
                    members: [
                        {
                            name: 'Lead',
                            classId: 'guardian',
                            isLeader: true,
                            strategyId: 'pacifist',
                            level: 20
                        }
                    ]
                }
            ],
            spawns: [
                { creatureId: 'dummy', x: 11, y: 10, z: 0, respawn: 30 },
                { creatureId: 'dummy', x: 70, y: 70, z: 0, respawn: 30 }
            ],
            creatureLoader: () => dummyTemplate(),
            classLoader: (id) => presets.getClass(id)
        });
        attachMap(sim, map);
        await sim.start();

        // Activate near slot
        Time.advanceFixedLogicStep();
        sim.updateAll();
        assert.strictEqual(
            sim.creatures.filter((c) => c.alive).length,
            1,
            'near only'
        );
        assert.ok(sim.spawnPerf, 'spawnPerf frame present');
        assert.strictEqual(sim.spawnPerf.slots, 2);
        assert.strictEqual(sim.spawnPerf.living, 1);

        // Teleport party far away and wait past idle hysteresis
        const lead = sim.parties[0].members[0];
        if (sim.tileMap && lead.tile) {
            sim.tileMap.release(lead.tile.x, lead.tile.y, lead.tile.z, lead);
        }
        lead.tile = { x: 70, y: 70, z: 0 };
        sim.tileMap.tryOccupy(70, 70, 0, lead);
        if (typeof lead.syncPositionFromTile === 'function') {
            lead.syncPositionFromTile();
        }

        for (let i = 0; i < 30; i++) {
            Time.advanceFixedLogicStep();
            sim.updateAll();
        }
        // Near original den should idle-despawn; far camp may activate
        const living = sim.creatures.filter((c) => c.alive);
        assert.ok(
            sim.spawnPerfTotals && sim.spawnPerfTotals.idleDespawned >= 1,
            'idleDespawned counted'
        );
        // At most one dens near the new position
        assert.ok(living.length <= 1, 'only local living after move');
        log('simulator idle despawn + spawnPerf ok', {
            living: living.length,
            totals: sim.spawnPerfTotals
        });
        sim.destroy();
    } finally {
        Settings.SPAWN_DESPAWN_IDLE_SEC = prevIdle;
        Settings.SPAWN_DESPAWN_HOME_DIST = prevHome;
    }
}

async function main() {
    testSettingsKnobs();
    testNormalizeAndKey();
    testActivateOnDemand();
    testActivateEager();
    testNoDoubleSpawn();
    testDespawnHomeDistance();
    testDeathFreesSlot();
    testRespawnAfterCooldown();
    testRespawnMultiplier();
    testNoDoubleAfterFailedHostSpawn();
    testSameFloorOnly();
    testDuplicateKeysDisambiguated();
    testNotifyEntityGone();
    testOneShotNoRespawn();
    testHomeDespawnDisabledWhenZero();
    testIdleAoiDespawnHysteresis();
    testIdleAoiProtectsCombat();
    testMaxLivingSoftCap();
    testMaxLivingNeverEvictsProtected();
    testEagerIgnoresIdleAoiAndKeepsDefaultUnlimited();
    await testSimulatorEagerSpawnsAtStart();
    await testSimulatorOnDemandNearPlayerOnly();
    await testSimulatorRespawnViaManager();
    await testSimulatorIdleDespawnAndPerf();
    console.log('spawn_manager: ok');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
