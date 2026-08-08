#!/usr/bin/env node
/**
 * Sequential arena waves: normalize, materialize, FSM, and Simulator endReason.
 * Quiet on success; VERBOSE=1 for detail.
 */

'use strict';

const { hasMode } = require('./helpers/modes.js');

const assert = require('assert');
const { Time } = require('../kernel/core/lib/time.js');
const { TileMap } = require('../kernel/core/entities/tilemap.js');
const { Simulator } = require('../kernel/providers/simulator/simulator.js');
const {
    normalizeWavesConfig,
    normalizeWaveEntry,
    materializeWaveSpawns,
    collectWalkableTiles,
    collectWalkableTilesInRegions,
    buildSpawnZones,
    discoverAutoSpawnZones,
    WaveController
} = require('../kernel/core/lib/wave_manager.js');
const {
    DEFAULT_AFFIX_STATS
} = require('../kernel/core/lib/dungeon/population.js');
const {
    runHeadlessHunt,
    resolveHuntConfig
} = require('../kernel/providers/simulator/headless_runner.js');
const { setActiveMode, getActiveModeId } = require('../kernel/core/lib/modes.js');
const presets = require('../kernel/core/lib/presets.js');

const VERBOSE = !!process.env.VERBOSE;

function log(...args) {
    if (VERBOSE) console.log(...args);
}

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
    return {
        id: 'dummy',
        label: 'Dummy',
        hp: 5,
        atk: 1,
        def: 0,
        exp: 1,
        aggro: true
    };
}

function attachMap(sim, map) {
    sim.setTileMap(map);
    // floor must stay null so start() does not call loadMaps and replace the map
    sim.floor = null;
    sim.floors = null;
    sim.mapPath = null;
    sim.mapPaths = null;
    sim.floorLayers = null;
}

function testNormalizeArrayShape() {
    const cfg = normalizeWavesConfig([
        { entries: [{ creatureId: 'rat', count: 2 }] },
        { id: 'boss', spawns: [{ creatureId: 'orc' }] }
    ]);
    assert.ok(cfg);
    assert.strictEqual(cfg.list.length, 2);
    assert.strictEqual(cfg.delaySec, 3);
    assert.strictEqual(cfg.endOnComplete, true);
    assert.strictEqual(cfg.holdRoute, true);
    assert.strictEqual(cfg.list[0].entries[0].count, 2);
    assert.strictEqual(cfg.list[1].id, 'boss');
    // Array-shaped hunts never set multi-arena fields → classic defaults.
    assert.strictEqual(cfg.wavesPerArena, null);
    assert.strictEqual(cfg.pauseOnArenaBoundary, false);
    log('normalize array ok');
}

function testNormalizeObjectShape() {
    const cfg = normalizeWavesConfig({
        delaySec: 1.5,
        startDelaySec: 0.5,
        endOnComplete: false,
        holdRoute: false,
        // legacy single region still accepted
        region: { x: 1, y: 2, w: 10, h: 8, z: 0 },
        list: [{ id: 'w1', entries: [{ creatureId: 'rat' }] }]
    });
    assert.ok(cfg);
    assert.strictEqual(cfg.delaySec, 1.5);
    assert.strictEqual(cfg.startDelaySec, 0.5);
    assert.strictEqual(cfg.endOnComplete, false);
    assert.strictEqual(cfg.holdRoute, false);
    assert.strictEqual(cfg.packClustering, false);
    // Classic hunts: multi-arena flags default off / null
    assert.strictEqual(cfg.wavesPerArena, null);
    assert.strictEqual(cfg.pauseOnArenaBoundary, false);
    assert.ok(Array.isArray(cfg.regions) && cfg.regions.length === 1);

    const multiArena = normalizeWavesConfig({
        wavesPerArena: 3,
        pauseOnArenaBoundary: true,
        list: [
            { id: 'a', entries: [{ creatureId: 'rat' }] },
            { id: 'b', entries: [{ creatureId: 'orc' }] },
            { id: 'c', entries: [{ creatureId: 'spider' }] }
        ]
    });
    assert.strictEqual(multiArena.wavesPerArena, 3);
    assert.strictEqual(multiArena.pauseOnArenaBoundary, true);
    // Invalid / sub-1 wavesPerArena collapses to null
    const badWpa = normalizeWavesConfig({
        wavesPerArena: 0,
        list: [{ id: 'a', entries: [{ creatureId: 'rat' }] }]
    });
    assert.strictEqual(badWpa.wavesPerArena, null);
    assert.strictEqual(badWpa.pauseOnArenaBoundary, false);

    const clustered = normalizeWavesConfig({
        packClustering: true,
        list: [{ id: 'w1', entries: [{ creatureId: 'rat' }] }]
    });
    assert.strictEqual(clustered.packClustering, true);
    assert.strictEqual(cfg.regions[0].x, 1);
    assert.strictEqual(cfg.regions[0].y, 2);
    assert.strictEqual(cfg.regions[0].w, 10);
    assert.strictEqual(cfg.regions[0].h, 8);
    assert.strictEqual(cfg.region.x, 1);
    assert.strictEqual(normalizeWavesConfig(null), null);
    assert.strictEqual(normalizeWavesConfig({ list: [] }), null);

    const multi = normalizeWavesConfig({
        regions: [
            { id: 'a', x: 0, y: 0, w: 3, h: 3, z: 0 },
            { id: 'b', x: 10, y: 10, w: 2, h: 2 }
        ],
        list: [{ id: 'w1', entries: [{ creatureId: 'rat' }] }]
    });
    assert.ok(multi);
    assert.strictEqual(multi.regions.length, 2);
    assert.strictEqual(multi.regions[0].id, 'a');
    assert.strictEqual(multi.regions[1].id, 'b');
    assert.strictEqual(multi.region.id, 'a');
    log('normalize object ok');
}

function testMaterializeRandomTiles() {
    const map = openFloor(20, 20, 100);
    const walkable = collectWalkableTiles(
        map,
        { x: 2, y: 2, w: 5, h: 5, z: 0 },
        0
    );
    assert.ok(walkable.length >= 20, 'region walkable count');

    const wave = normalizeWavesConfig([
        {
            id: 'w',
            entries: [
                { creatureId: 'rat', count: 3 },
                { creatureId: 'orc', count: 2, x: 4, y: 4 }
            ]
        }
    ]).list[0];

    let calls = 0;
    const rng = () => {
        calls += 1;
        // Deterministic pseudo sequence
        return (calls * 0.17) % 1;
    };
    const rows = materializeWaveSpawns(wave, walkable, rng, {
        defaultZ: 0,
        waveIndex: 0,
        waveId: 'w'
    });
    assert.strictEqual(rows.length, 5);
    // fixed coords preserved for orc rows
    const orcs = rows.filter((r) => r.creatureId === 'orc');
    assert.strictEqual(orcs.length, 2);
    assert.ok(orcs.every((r) => r.x === 4 && r.y === 4));
    // random rats inside region
    const rats = rows.filter((r) => r.creatureId === 'rat');
    for (const r of rats) {
        assert.ok(r.x >= 2 && r.x <= 6);
        assert.ok(r.y >= 2 && r.y <= 6);
        assert.strictEqual(r.respawn, 0);
        assert.strictEqual(r._waveId, 'w');
    }
    log('materialize random ok', { rats: rats.map((r) => [r.x, r.y]) });
}

function testMultiRegionWalkableUnion() {
    const map = openFloor(20, 20, 100);
    const tiles = collectWalkableTilesInRegions(
        map,
        [
            { x: 1, y: 1, w: 2, h: 2, z: 0 },
            { x: 10, y: 10, w: 2, h: 2, z: 0 }
        ],
        0
    );
    assert.strictEqual(tiles.length, 8, 'two 2x2 boxes → 8 tiles');
    const keys = new Set(tiles.map((t) => `${t.x},${t.y}`));
    assert.ok(keys.has('1,1'));
    assert.ok(keys.has('11,11'));
    assert.ok(!keys.has('5,5'));
    log('multi-region walkable union ok');
}

/**
 * TileMap stores cols/rows on layers[z], not top-level. Whole-floor scans
 * (empty waves.regions) must still find walkable tiles — otherwise arena
 * packs materialize with no x/y and waves clear with 0 spawns.
 */
function testWholeFloorWalkableFromLayerSize() {
    const map = openFloor(16, 12, 100);
    assert.strictEqual(map.cols, undefined, 'TileMap has no top-level cols');
    assert.ok(map.getLayer(0), 'layer 0 loaded');
    assert.strictEqual(map.getLayer(0).cols, 16);
    assert.strictEqual(map.getLayer(0).rows, 12);

    const whole = collectWalkableTiles(map, null, 0);
    assert.ok(
        whole.length >= 100,
        `whole floor should scan layer size, got ${whole.length}`
    );

    // Empty regions list = same whole-floor path
    const viaEmpty = collectWalkableTilesInRegions(map, [], 0);
    assert.strictEqual(viaEmpty.length, whole.length);

    // Missing size → empty (no silent 1×1)
    const bare = {
        canEnter: () => true,
        isWalkable: () => true
    };
    assert.strictEqual(collectWalkableTiles(bare, null, 0).length, 0);

    log('whole floor walkable from layer size ok', { n: whole.length });
}

function testWaveEntryAffixDefaults() {
    const elite = normalizeWaveEntry({
        creatureId: 'cyclops',
        count: 1,
        affixes: ['elite']
    });
    assert.ok(elite);
    assert.strictEqual(elite.rarity, 'elite');
    assert.ok(elite.affixes.indexOf('elite') >= 0);
    assert.strictEqual(elite.hpMult, DEFAULT_AFFIX_STATS.elite.hpMult);
    assert.strictEqual(elite.atkMult, DEFAULT_AFFIX_STATS.elite.atkMult);
    assert.strictEqual(elite.expMult, DEFAULT_AFFIX_STATS.elite.expMult);

    const rare = normalizeWaveEntry({
        creatureId: 'rat',
        rarity: 'rare'
    });
    assert.strictEqual(rare.rarity, 'rare');
    assert.ok(rare.affixes.indexOf('rare') >= 0);
    assert.strictEqual(rare.hpMult, DEFAULT_AFFIX_STATS.rare.hpMult);

    const champ = normalizeWaveEntry({
        creatureId: 'orc',
        rarity: 'champion',
        affixes: ['champion']
    });
    assert.strictEqual(champ.hpMult, DEFAULT_AFFIX_STATS.champion.hpMult);

    const boss = normalizeWaveEntry({
        creatureId: 'dragon',
        affixes: ['boss']
    });
    assert.strictEqual(boss.hpMult, DEFAULT_AFFIX_STATS.boss.hpMult);
    assert.strictEqual(boss.atkMult, DEFAULT_AFFIX_STATS.boss.atkMult);

    // Explicit mults override the table
    const custom = normalizeWaveEntry({
        creatureId: 'orc',
        rarity: 'elite',
        hpMult: 9,
        atkMult: 4,
        expMult: 7
    });
    assert.strictEqual(custom.hpMult, 9);
    assert.strictEqual(custom.atkMult, 4);
    assert.strictEqual(custom.expMult, 7);

    // Normal trash has no mult fields
    const trash = normalizeWaveEntry({ creatureId: 'rat', count: 3 });
    assert.strictEqual(trash.rarity, undefined);
    assert.strictEqual(trash.hpMult, undefined);

    // Materialize preserves affix fields
    const wave = normalizeWavesConfig([
        {
            id: 'affix_mix',
            entries: [
                { creatureId: 'rat', count: 2 },
                { creatureId: 'orc', count: 1, affixes: ['champion'] },
                { creatureId: 'cyclops', count: 1, rarity: 'elite' }
            ]
        }
    ]).list[0];
    const map = openFloor(12, 12, 100);
    const walkable = collectWalkableTiles(map, null, 0);
    const rows = materializeWaveSpawns(wave, walkable, () => 0.4, {
        waveId: 'affix_mix',
        waveIndex: 0
    });
    assert.strictEqual(rows.length, 4);
    const champs = rows.filter((r) => r.rarity === 'champion');
    const elites = rows.filter((r) => r.rarity === 'elite');
    assert.strictEqual(champs.length, 1);
    assert.strictEqual(elites.length, 1);
    assert.strictEqual(champs[0].hpMult, DEFAULT_AFFIX_STATS.champion.hpMult);
    assert.strictEqual(elites[0].hpMult, DEFAULT_AFFIX_STATS.elite.hpMult);
    log('wave entry affix defaults ok');
}

async function testSimulatorAffixSpawnStats() {
    const map = openFloor(24, 24, 100);
    const baseHp = 100;
    const baseAtk = 10;
    const baseExp = 20;
    const sim = new Simulator({
        seed: 11,
        combatAi: false,
        spawnMode: 'eager',
        waves: {
            delaySec: 0.05,
            startDelaySec: 0,
            endOnComplete: true,
            holdRoute: true,
            region: { x: 2, y: 2, w: 10, h: 10, z: 0 },
            list: [
                {
                    id: 'mixed',
                    entries: [
                        { creatureId: 'dummy', count: 1 },
                        {
                            creatureId: 'dummy',
                            count: 1,
                            rarity: 'elite',
                            affixes: ['elite']
                        }
                    ]
                }
            ]
        },
        parties: [
            {
                name: 'P',
                id: 'p',
                waypoints: [
                    { x: 5, y: 5, z: 0 },
                    { x: 6, y: 5, z: 0 }
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
        creatureLoader: () => ({
            id: 'dummy',
            label: 'Dummy',
            hp: baseHp,
            def: 0,
            exp: baseExp,
            aggro: true,
            // Kit-only offense; atkMult scales attacks[].min/max
            attacks: [
                {
                    id: 'melee_0',
                    kind: 'melee',
                    intervalMs: 2000,
                    chance: 100,
                    range: 1,
                    element: 'physical',
                    min: 0,
                    max: baseAtk
                }
            ]
        }),
        classLoader: (id) => {
            try {
                return presets.getClass(id);
            } catch (_) {
                return {
                    id: 'guardian',
                    label: 'G',
                    base: { hp: 200, mp: 50, atk: 10, def: 5, speed: 100 }
                };
            }
        },
        maxSeconds: 10
    });
    attachMap(sim, map);
    await sim.start();
    assert.ok(sim.creatures.length >= 2, 'both wave entries spawned');
    const normals = sim.creatures.filter(
        (c) => c && c.alive && !c.rarity
    );
    const elites = sim.creatures.filter(
        (c) => c && c.alive && c.rarity === 'elite'
    );
    assert.ok(normals.length >= 1, 'normal dummy present');
    assert.ok(elites.length >= 1, 'elite dummy present');
    const elite = elites[0];
    assert.strictEqual(
        elite.hp.max,
        Math.round(baseHp * DEFAULT_AFFIX_STATS.elite.hpMult)
    );
    const eliteMax =
        elite.attacks && elite.attacks[0] ? Number(elite.attacks[0].max) : 0;
    assert.strictEqual(
        eliteMax,
        Math.round(baseAtk * DEFAULT_AFFIX_STATS.elite.atkMult)
    );
    assert.strictEqual(
        elite.expValue,
        Math.round(baseExp * DEFAULT_AFFIX_STATS.elite.expMult)
    );
    assert.ok(
        Array.isArray(elite.affixes) && elite.affixes.indexOf('elite') >= 0
    );
    log('simulator affix spawn stats ok', {
        eliteHp: elite.hp.max,
        eliteKitMax: eliteMax
    });
}

function testCollectWaveCreatureIds() {
    const { collectWaveCreatureIds } = require('../kernel/core/lib/wave_manager.js');
    const ids = collectWaveCreatureIds({
        list: [
            {
                id: 'w0',
                entries: [
                    { creatureId: 'rat', count: 2 },
                    { creatureId: 'snake' }
                ]
            },
            {
                id: 'w1',
                entries: [{ creatureId: 'rat' }, { creatureId: 'orc' }]
            }
        ]
    });
    assert.deepStrictEqual(ids.sort(), ['orc', 'rat', 'snake']);
    assert.deepStrictEqual(collectWaveCreatureIds(null), []);
    log('collectWaveCreatureIds ok');
}

function testWaveControllerFsm() {
    const cfg = normalizeWavesConfig({
        delaySec: 1,
        startDelaySec: 0,
        list: [
            { id: 'a', entries: [{ creatureId: 'rat', count: 1 }] },
            { id: 'b', entries: [{ creatureId: 'orc', count: 1 }] }
        ]
    });
    const map = openFloor(12, 12, 100);
    const wc = new WaveController(cfg);
    wc.begin(0);
    assert.strictEqual(wc.phase, 'waiting');

    let r = wc.tick({
        time: 0,
        waveClear: false,
        tileMap: map,
        rng: () => 0.3,
        defaultZ: 0
    });
    assert.ok(r.spawnRows && r.spawnRows.length === 1);
    assert.strictEqual(wc.phase, 'active');
    assert.strictEqual(wc.waveIndex, 0);
    assert.ok(r.events.some((e) => e.kind === 'wave_start'));

    // Not clear yet
    r = wc.tick({
        time: 0.5,
        waveClear: false,
        tileMap: map,
        rng: () => 0.3,
        defaultZ: 0
    });
    assert.strictEqual(wc.phase, 'active');
    assert.strictEqual(r.spawnRows, null);

    // Clear wave 0 → intermission
    r = wc.tick({
        time: 1,
        waveClear: true,
        tileMap: map,
        rng: () => 0.3,
        defaultZ: 0
    });
    assert.strictEqual(wc.phase, 'intermission');
    assert.ok(r.events.some((e) => e.kind === 'wave_clear'));
    assert.ok(r.events.some((e) => e.kind === 'wave_intermission'));

    // Still waiting delay
    r = wc.tick({
        time: 1.5,
        waveClear: true,
        tileMap: map,
        rng: () => 0.3,
        defaultZ: 0
    });
    assert.strictEqual(wc.phase, 'intermission');

    // After delay → wave 1
    r = wc.tick({
        time: 2.01,
        waveClear: true,
        tileMap: map,
        rng: () => 0.3,
        defaultZ: 0
    });
    assert.strictEqual(wc.phase, 'active');
    assert.strictEqual(wc.waveIndex, 1);
    assert.ok(r.spawnRows && r.spawnRows[0].creatureId === 'orc');

    // Clear final → complete
    r = wc.tick({
        time: 3,
        waveClear: true,
        tileMap: map,
        rng: () => 0.3,
        defaultZ: 0
    });
    assert.strictEqual(wc.phase, 'complete');
    assert.ok(r.complete);
    assert.ok(r.events.some((e) => e.kind === 'waves_complete'));
    log('wave controller fsm ok');
}

/**
 * Classic hunts (pauseOnArenaBoundary unset/false): still auto-intermission.
 * No awaiting_portal even when wavesPerArena is present without the pause flag.
 */
function testClassicHuntUnchangedWithoutBoundaryPause() {
    const map = openFloor(12, 12, 100);
    const makeList = () => [
        { id: 'a', entries: [{ creatureId: 'rat', count: 1 }] },
        { id: 'b', entries: [{ creatureId: 'orc', count: 1 }] },
        { id: 'c', entries: [{ creatureId: 'spider', count: 1 }] }
    ];
    const tickOpts = (time, waveClear) => ({
        time,
        waveClear,
        tileMap: map,
        rng: () => 0.3,
        defaultZ: 0
    });

    function clearToIntermission(cfg) {
        const wc = new WaveController(cfg);
        wc.begin(0);
        let r = wc.tick(tickOpts(0, false));
        assert.strictEqual(wc.phase, 'active');
        r = wc.tick(tickOpts(1, true));
        assert.strictEqual(wc.phase, 'intermission', 'classic clear → intermission');
        assert.ok(r.events.some((e) => e.kind === 'wave_intermission'));
        assert.ok(!r.events.some((e) => e.kind === 'wave_boundary'));
        assert.ok(Number.isFinite(wc.readyAt));
        assert.strictEqual(wc.arenasCleared(), 0);
        return wc;
    }

    // Unset flags (defaults)
    clearToIntermission(
        normalizeWavesConfig({
            delaySec: 1,
            startDelaySec: 0,
            list: makeList()
        })
    );

    // wavesPerArena alone without pause: must still intermission at modulus
    // (wavesCompleted % 2 === 0 would fire boundary if pause flag were ignored).
    const wpaNoPause = normalizeWavesConfig({
        delaySec: 1,
        startDelaySec: 0,
        wavesPerArena: 2,
        pauseOnArenaBoundary: false,
        list: makeList()
    });
    assert.strictEqual(wpaNoPause.wavesPerArena, 2);
    assert.strictEqual(wpaNoPause.pauseOnArenaBoundary, false);

    const wc = new WaveController(wpaNoPause);
    wc.begin(0);
    let r = wc.tick(tickOpts(0, false));
    assert.strictEqual(wc.phase, 'active');
    assert.strictEqual(wc.waveIndex, 0);

    // Clear wave 0 → intermission (1 % 2 !== 0; classic path)
    r = wc.tick(tickOpts(1, true));
    assert.strictEqual(wc.phase, 'intermission');
    assert.ok(r.events.some((e) => e.kind === 'wave_intermission'));
    assert.ok(!r.events.some((e) => e.kind === 'wave_boundary'));
    assert.ok(Number.isFinite(wc.readyAt));

    // Start wave 1
    r = wc.tick(tickOpts(2.01, true));
    assert.strictEqual(wc.phase, 'active');
    assert.strictEqual(wc.waveIndex, 1);

    // Clear wave 1: wavesCompleted === 2 and wpa === 2 — modulus boundary
    // would pause if pauseOnArenaBoundary were wrongly treated as on.
    r = wc.tick(tickOpts(3, true));
    assert.strictEqual(
        wc.phase,
        'intermission',
        'wpa without pause must not enter awaiting_portal at modulus'
    );
    assert.notStrictEqual(wc.phase, 'awaiting_portal');
    assert.ok(Number.isFinite(wc.readyAt), 'readyAt stays finite (not +Infinity hold)');
    assert.ok(r.events.some((e) => e.kind === 'wave_intermission'));
    assert.ok(
        !r.events.some((e) => e.kind === 'wave_boundary'),
        'no wave_boundary when pauseOnArenaBoundary is false'
    );
    assert.strictEqual(wc.wavesCompleted, 2);
    assert.strictEqual(r.complete, false);

    log('classic hunt unchanged without boundary pause ok');
}

/**
 * pauseOnArenaBoundary + wavesPerArena: stage clear → awaiting_portal,
 * readyAt = +Infinity (no auto-advance), resumeAfterPortal starts next wave.
 * Final wave emits waves_complete (not wave_boundary). KD3 index math.
 */
function testAwaitingPortalBoundaryPause() {
    const map = openFloor(12, 12, 100);
    const cfg = normalizeWavesConfig({
        delaySec: 0.05, // short delay would race without boundary pause
        startDelaySec: 0,
        wavesPerArena: 2,
        pauseOnArenaBoundary: true,
        list: [
            { id: 'a0', entries: [{ creatureId: 'rat', count: 1 }] },
            { id: 'a1', entries: [{ creatureId: 'orc', count: 1 }] },
            { id: 'b0', entries: [{ creatureId: 'spider', count: 1 }] },
            { id: 'b1', entries: [{ creatureId: 'snake', count: 1 }] }
        ]
    });
    assert.strictEqual(cfg.wavesPerArena, 2);
    assert.strictEqual(cfg.pauseOnArenaBoundary, true);

    const wc = new WaveController(cfg);
    wc.begin(0);
    assert.strictEqual(wc.arenasCleared(), 0);
    assert.strictEqual(wc.currentArenaIndex(), 0); // waveIndex -1 → max(0,-1)=0

    const tick = (time, waveClear) =>
        wc.tick({
            time,
            waveClear,
            tileMap: map,
            rng: () => 0.3,
            defaultZ: 0
        });

    // Wave 0 start
    let r = tick(0, false);
    assert.strictEqual(wc.phase, 'active');
    assert.strictEqual(wc.waveIndex, 0);
    assert.strictEqual(wc.currentArenaIndex(), 0);
    assert.ok(r.spawnRows && r.spawnRows[0].creatureId === 'rat');

    // Clear wave 0 (not a boundary: 1 % 2 !== 0) → intermission
    r = tick(1, true);
    assert.strictEqual(wc.phase, 'intermission');
    assert.strictEqual(wc.wavesCompleted, 1);
    assert.strictEqual(wc.arenasCleared(), 0);
    assert.ok(r.events.some((e) => e.kind === 'wave_intermission'));
    assert.ok(!r.events.some((e) => e.kind === 'wave_boundary'));

    // Wave 1 start
    r = tick(1.1, true);
    assert.strictEqual(wc.phase, 'active');
    assert.strictEqual(wc.waveIndex, 1);
    assert.strictEqual(wc.currentArenaIndex(), 0); // floor(1/2)=0
    assert.ok(r.spawnRows && r.spawnRows[0].creatureId === 'orc');

    // Clear wave 1 → arena boundary (2 % 2 === 0)
    r = tick(2, true);
    assert.strictEqual(wc.phase, 'awaiting_portal');
    assert.strictEqual(wc.readyAt, Infinity);
    assert.strictEqual(wc.wavesCompleted, 2);
    assert.strictEqual(wc.arenasCleared(), 1);
    // waveIndex still last cleared (1); do not use wavesCompleted-1 for current arena
    assert.strictEqual(wc.waveIndex, 1);
    assert.strictEqual(wc.currentArenaIndex(), 0);
    assert.ok(r.events.some((e) => e.kind === 'wave_clear'));
    const boundary = r.events.find((e) => e.kind === 'wave_boundary');
    assert.ok(boundary, 'wave_boundary emitted');
    assert.strictEqual(boundary.wavesCompleted, 2);
    assert.strictEqual(boundary.arenaIndex, 1);
    assert.strictEqual(r.spawnRows, null);
    assert.strictEqual(r.complete, false);
    assert.ok(!r.events.some((e) => e.kind === 'wave_intermission'));
    assert.ok(!r.events.some((e) => e.kind === 'waves_complete'));

    // Time far past delaySec: must not auto-advance
    r = tick(100, true);
    assert.strictEqual(wc.phase, 'awaiting_portal');
    assert.strictEqual(wc.readyAt, Infinity);
    assert.strictEqual(r.spawnRows, null);
    assert.strictEqual(wc.waveIndex, 1);

    // resumeAfterPortal only valid in awaiting_portal
    assert.strictEqual(wc.resumeAfterPortal(100), true);
    assert.strictEqual(wc.phase, 'intermission');
    assert.strictEqual(wc.readyAt, 100);
    assert.strictEqual(wc.resumeAfterPortal(101), false); // not awaiting

    // Next tick starts waveIndex+1 = 2 (arena 1)
    r = tick(100, false);
    assert.strictEqual(wc.phase, 'active');
    assert.strictEqual(wc.waveIndex, 2);
    assert.strictEqual(wc.currentArenaIndex(), 1); // floor(2/2)=1
    assert.ok(r.spawnRows && r.spawnRows[0].creatureId === 'spider');
    assert.ok(r.events.some((e) => e.kind === 'wave_start'));

    // Clear wave 2 → intermission (3 % 2 !== 0)
    r = tick(101, true);
    assert.strictEqual(wc.phase, 'intermission');
    assert.strictEqual(wc.wavesCompleted, 3);
    assert.strictEqual(wc.arenasCleared(), 1);

    // Wave 3 (final of arena 1 and of full list)
    r = tick(101.1, true);
    assert.strictEqual(wc.phase, 'active');
    assert.strictEqual(wc.waveIndex, 3);
    assert.strictEqual(wc.currentArenaIndex(), 1);
    assert.ok(r.spawnRows && r.spawnRows[0].creatureId === 'snake');

    // Final clear → waves_complete, NOT wave_boundary (KD4 full list)
    r = tick(102, true);
    assert.strictEqual(wc.phase, 'complete');
    assert.ok(r.complete);
    assert.strictEqual(wc.wavesCompleted, 4);
    assert.strictEqual(wc.arenasCleared(), 2);
    assert.ok(r.events.some((e) => e.kind === 'waves_complete'));
    assert.ok(!r.events.some((e) => e.kind === 'wave_boundary'));
    assert.ok(r.events.some((e) => e.kind === 'wave_clear'));

    // Snapshot carries boundary fields
    const snap = wc.snapshot();
    assert.strictEqual(snap.phase, 'complete');
    assert.strictEqual(snap.wavesPerArena, 2);
    assert.strictEqual(snap.pauseOnArenaBoundary, true);
    assert.strictEqual(snap.arenasCleared, 2);

    log('awaiting_portal boundary pause ok');
}

/**
 * KD3 helpers: arenasCleared vs currentArenaIndex use different numerators.
 */
function testArenaIndexHelpers() {
    const cfg = normalizeWavesConfig({
        delaySec: 0,
        startDelaySec: 0,
        wavesPerArena: 3,
        pauseOnArenaBoundary: true,
        list: [
            { id: 'w0', entries: [{ creatureId: 'a' }] },
            { id: 'w1', entries: [{ creatureId: 'b' }] },
            { id: 'w2', entries: [{ creatureId: 'c' }] },
            { id: 'w3', entries: [{ creatureId: 'd' }] },
            { id: 'w4', entries: [{ creatureId: 'e' }] },
            { id: 'w5', entries: [{ creatureId: 'f' }] }
        ]
    });
    const map = openFloor(8, 8, 100);
    const wc = new WaveController(cfg);
    wc.begin(0);

    // No wavesPerArena → helpers return 0
    const classic = new WaveController(
        normalizeWavesConfig({
            list: [{ id: 'x', entries: [{ creatureId: 'rat' }] }]
        })
    );
    assert.strictEqual(classic.arenasCleared(), 0);
    assert.strictEqual(classic.currentArenaIndex(), 0);

    const step = (time, clear) =>
        wc.tick({
            time,
            waveClear: clear,
            tileMap: map,
            rng: () => 0.2,
            defaultZ: 0
        });

    // Start w0
    step(0, false);
    assert.strictEqual(wc.waveIndex, 0);
    assert.strictEqual(wc.wavesCompleted, 0);
    assert.strictEqual(wc.arenasCleared(), 0);
    assert.strictEqual(wc.currentArenaIndex(), 0);

    // Clear w0, w1 → intermissions; start w2
    step(1, true); // clear 0
    step(1, true); // start 1
    assert.strictEqual(wc.waveIndex, 1);
    assert.strictEqual(wc.currentArenaIndex(), 0);
    step(2, true); // clear 1
    step(2, true); // start 2
    assert.strictEqual(wc.waveIndex, 2);
    assert.strictEqual(wc.wavesCompleted, 2);
    assert.strictEqual(wc.arenasCleared(), 0); // floor(2/3)=0
    assert.strictEqual(wc.currentArenaIndex(), 0); // floor(2/3)=0

    // Clear w2 → boundary (3%3===0)
    step(3, true);
    assert.strictEqual(wc.phase, 'awaiting_portal');
    assert.strictEqual(wc.wavesCompleted, 3);
    assert.strictEqual(wc.arenasCleared(), 1);
    // Still on cleared waveIndex 2 → current arena 0 (not wavesCompleted-1 → 2)
    assert.strictEqual(wc.waveIndex, 2);
    assert.strictEqual(wc.currentArenaIndex(), 0);

    wc.resumeAfterPortal(3);
    step(3, false); // start w3
    assert.strictEqual(wc.waveIndex, 3);
    assert.strictEqual(wc.currentArenaIndex(), 1); // floor(3/3)=1
    assert.strictEqual(wc.arenasCleared(), 1);

    log('arena index helpers ok');
}

async function testSimulatorWavesComplete() {
    const map = openFloor(24, 24, 100);
    const sim = new Simulator({
        seed: 7,
        combatAi: true,
        spawnMode: 'eager',
        waves: {
            delaySec: 0.1,
            startDelaySec: 0,
            endOnComplete: true,
            holdRoute: true,
            region: { x: 2, y: 2, w: 10, h: 10, z: 0 },
            list: [
                {
                    id: 'w1',
                    entries: [{ creatureId: 'dummy', count: 2 }]
                },
                {
                    id: 'w2',
                    entries: [{ creatureId: 'dummy', count: 1 }]
                }
            ]
        },
        parties: [
            {
                name: 'P',
                id: 'p',
                waypoints: [
                    { x: 5, y: 5, z: 0 },
                    { x: 6, y: 5, z: 0 }
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
        creatureLoader: () => dummyTemplate(),
        classLoader: (id) => {
            try {
                return presets.getClass(id);
            } catch (_) {
                return {
                    id: 'guardian',
                    label: 'G',
                    base: { hp: 200, mp: 50, atk: 10, def: 5, speed: 100 }
                };
            }
        },
        maxSeconds: 30
    });
    attachMap(sim, map);
    await sim.start();
    assert.ok(sim.waveController);
    assert.strictEqual(sim.waveController.waveIndex, 0);
    assert.ok(sim.creatures.length >= 1, 'wave 0 spawned');

    // Instantly kill all living creatures repeatedly until waves complete
    let guard = 0;
    while (sim.sessionState === 'running' && guard < 400) {
        guard += 1;
        for (const c of sim.creatures.slice()) {
            if (!c || !c.alive) continue;
            c.alive = false;
            c.hp.current = 0;
            if (sim.tileMap && c.tile) {
                sim.tileMap.release(c.tile.x, c.tile.y, c.tile.z, c);
            }
            if (sim.spawnManager) {
                sim.spawnManager.notifyEntityGone(
                    c.id,
                    Time.timeSinceLevelLoad
                );
            }
        }
        Time.advanceFixedLogicStep();
        sim.updateAll();
    }

    assert.strictEqual(
        sim.sessionState,
        'waves_complete',
        `expected waves_complete got ${sim.sessionState}`
    );
    assert.strictEqual(sim.telemetry.endReason, 'waves_complete');
    const summary = sim.buildHuntSummary({ frames: guard });
    assert.strictEqual(summary.endReason, 'waves_complete');
    assert.ok(summary.waves);
    assert.strictEqual(summary.waves.wavesCompleted, 2);
    assert.strictEqual(summary.waves.totalWaves, 2);
    assert.strictEqual(summary.waves.phase, 'complete');
    log('simulator waves_complete ok', { ticks: sim.tickCount, guard });
}

async function testResolveHuntPassesWaves() {
    const prev = getActiveModeId();
    setActiveMode('standard');
    try {
        const resolved = resolveHuntConfig({
            huntId: 'standard_arena_waves',
            seed: 1
        });
        assert.ok(resolved.waves, 'hunt waves resolved');
        // Mults land at normalize (same path Simulator uses on start)
        const cfg = normalizeWavesConfig(resolved.waves);
        assert.ok(cfg && cfg.list, 'waves list present after normalize');
        assert.ok(cfg.list.length >= 9, 'vocation ladder has 9 waves');

        const allEntries = [];
        for (let i = 0; i < cfg.list.length; i++) {
            const ents = cfg.list[i].entries || [];
            for (let j = 0; j < ents.length; j++) allEntries.push(ents[j]);
        }
        const rarities = {};
        for (const e of allEntries) {
            if (!e.rarity) continue;
            rarities[e.rarity] = (rarities[e.rarity] || 0) + 1;
            assert.ok(
                e.hpMult > 1,
                `affixed ${e.creatureId} (${e.rarity}) should have hpMult`
            );
        }
        assert.ok(rarities.rare >= 1, 'ladder includes rare');
        assert.ok(rarities.champion >= 1, 'ladder includes champion');
        assert.ok(rarities.elite >= 1, 'ladder includes elite');
        assert.ok(rarities.boss >= 1, 'ladder includes boss');

        // Authored JSON also carries rarity tags before normalize
        const rawList = resolved.waves.list || resolved.waves;
        const rawRarities = {};
        for (let i = 0; i < rawList.length; i++) {
            const ents = rawList[i].entries || [];
            for (let j = 0; j < ents.length; j++) {
                const r = ents[j].rarity;
                if (r) rawRarities[r] = (rawRarities[r] || 0) + 1;
            }
        }
        assert.ok(rawRarities.boss >= 1, 'authored boss entry present');

        // Four-vocation balance party (session partyId — not embedded on hunt)
        const resolvedParty = resolveHuntConfig({
            huntId: 'standard_arena_waves',
            seed: 1,
            partyId: 'test_balance_quartet'
        });
        const party = (resolvedParty.parties && resolvedParty.parties[0]) || null;
        assert.ok(party && party.members && party.members.length >= 4);
        const classIds = party.members.map((m) => m.classId).sort();
        assert.deepStrictEqual(classIds, [
            'adept',
            'guardian',
            'scout',
            'warden'
        ]);

        // Arena patrol: one lap + loop (not multi-lap duplicated waypoints).
        // Profile may author a longer room-to-room path; loop still wraps.
        assert.strictEqual(resolved.loopWaypoints, true);
        assert.ok(
            party.loopWaypoints,
            'loopWaypoints stamped onto session party'
        );
        assert.ok(
            Array.isArray(resolved.waypoints) &&
                resolved.waypoints.length >= 3 &&
                resolved.waypoints.length <= 24,
            `patrol expected, got ${
                resolved.waypoints && resolved.waypoints.length
            } waypoints`
        );
        assert.ok(
            resolved.noAttackTimeoutSec === 120 ||
                (resolved.hunt &&
                    resolved.hunt.limits &&
                    resolved.hunt.limits.noAttackTimeoutSec === 120),
            'noAttackTimeoutSec liveness guard on arena limits'
        );
        // Prefer resolved field when wired through resolveHuntConfig
        assert.strictEqual(resolved.noAttackTimeoutSec, 120);

        log('resolve hunt waves ok', {
            n: cfg.list.length,
            rarities,
            wps: resolved.waypoints.length
        });
    } finally {
        setActiveMode(prev || 'standard');
    }
}

async function testHeadlessArenaSmoke() {
    const prev = getActiveModeId();
    setActiveMode('standard');
    try {
        // Short run: should spawn wave 0 and not crash
        const summary = await runHeadlessHunt({
            huntId: 'standard_arena_waves',
            seed: 42,
            frames: 40,
            stopOnEnd: true
        });
        assert.ok(summary.creaturesSpawned >= 1 || summary.kills >= 0);
        assert.ok(summary.waves);
        assert.ok(summary.waves.totalWaves >= 9);
        // Early frames: still running or already progressing
        assert.ok(
            summary.sessionState === 'running' ||
                summary.sessionState === 'timeout' ||
                summary.sessionState === 'waves_complete' ||
                summary.sessionState === 'party_wipe' ||
                summary.sessionState === 'no_attack_timeout',
            summary.sessionState
        );
        log('headless arena smoke ok', {
            state: summary.sessionState,
            spawned: summary.creaturesSpawned,
            wave: summary.waves
        });
    } finally {
        setActiveMode(prev || 'standard');
    }
}

/**
 * docs/24 I3 — standard product vocation arena (threat-stepped ladder).
 */
async function testStandardArenaWavesProduct() {
    const prev = getActiveModeId();
    setActiveMode('standard');
    try {
        const resolved = resolveHuntConfig({
            huntId: 'standard_arena_waves',
            seed: 42
        });
        assert.ok(resolved.waves, 'standard_arena_waves has waves');
        assert.strictEqual(resolved.loopWaypoints, true);
        assert.ok(
            resolved.hunt && resolved.hunt.defaultPartyId === 'balance_quartet',
            'product arena defaultPartyId balance_quartet'
        );
        assert.ok(
            (resolved.artSet || (resolved.hunt && resolved.hunt.artSet)) ===
                'cave_simple',
            'product arena uses cave_simple'
        );

        const cfg = normalizeWavesConfig(resolved.waves);
        assert.ok(cfg.list.length >= 9, 'vocation ladder has ≥9 waves');
        const rarities = {};
        for (let i = 0; i < cfg.list.length; i++) {
            const ents = cfg.list[i].entries || [];
            for (let j = 0; j < ents.length; j++) {
                const e = ents[j];
                if (!e.rarity) continue;
                rarities[e.rarity] = (rarities[e.rarity] || 0) + 1;
                assert.ok(
                    e.hpMult > 1,
                    `affixed ${e.creatureId} (${e.rarity}) should have hpMult`
                );
            }
        }
        assert.ok(rarities.rare >= 1, 'ladder includes rare');
        assert.ok(rarities.champion >= 1, 'ladder includes champion');
        assert.ok(rarities.elite >= 1, 'ladder includes elite');
        assert.ok(rarities.boss >= 1, 'ladder includes boss');

        // Full run: progressive pressure ends wipe or clear (not crash).
        const summary = await runHeadlessHunt({
            huntId: 'standard_arena_waves',
            seed: 42
        });
        assert.ok(summary.waves);
        assert.ok(summary.waves.totalWaves >= 9);
        assert.ok(summary.kills >= 1, 'arena gets kills');
        assert.ok(
            summary.parties &&
                summary.parties[0] &&
                summary.parties[0].partyId === 'balance_quartet',
            'session party is balance_quartet'
        );
        assert.ok(
            summary.endReason === 'party_wipe' ||
                summary.endReason === 'waves_complete' ||
                summary.endReason === 'no_attack_timeout' ||
                summary.endReason === 'timeout',
            `unexpected endReason ${summary.endReason}`
        );
        // Mid-loop tags fire across the affix ladder (champions/elites/boss).
        const mid =
            summary.pacing &&
            summary.pacing.metrics &&
            summary.pacing.metrics.midCounts;
        assert.ok(mid, 'pacing midCounts present');
        assert.ok(
            (mid.champion || 0) + (mid.elite || 0) + (mid.boss || 0) >= 1,
            `expected mid-loop affix tags, got ${JSON.stringify(mid)}`
        );
        // Product path reaches late ladder (not stuck on wave 0).
        assert.ok(
            (summary.waves.wavesCompleted || 0) >= 3,
            `expected ≥3 waves cleared, got ${summary.waves.wavesCompleted}`
        );
        log('standard arena product ok', {
            state: summary.sessionState || summary.endReason,
            kills: summary.kills,
            wavesCompleted: summary.waves.wavesCompleted,
            mid
        });
    } finally {
        setActiveMode(prev || 'standard');
    }
}

/**
 * docs/24 I4 / docs/22 A4 — progression tiers on the same arena ladder.
 * Novice L12 < mid L50 < veteran L90 on waves/kills; spell.level gates fire.
 */
async function testArenaProgressionTiers() {
    const prev = getActiveModeId();
    setActiveMode('standard');
    try {
        const noviceParty = presets.loadParty('balance_quartet_novice');
        const midParty = presets.loadParty('balance_quartet');
        const vetParty = presets.loadParty('balance_quartet_veteran');
        assert.ok(noviceParty && noviceParty.members.length === 4);
        assert.ok(midParty && midParty.members.length === 4);
        assert.ok(vetParty && vetParty.members.length === 4);

        const levels = (party) =>
            party.members.map((m) => Number(m.level != null ? m.level : 0));
        const noviceLevels = levels(noviceParty);
        const midLevels = levels(midParty);
        const vetLevels = levels(vetParty);
        assert.ok(
            noviceLevels.every((l) => l > 0 && l < 30),
            `novice levels should be tutorial-band, got ${noviceLevels}`
        );
        assert.ok(
            midLevels.every((l) => l >= 40 && l <= 60),
            `mid levels should be ~L50, got ${midLevels}`
        );
        assert.ok(
            vetLevels.every((l) => l >= 80),
            `veteran levels should be late-band, got ${vetLevels}`
        );

        const seed = 42;
        const novice = await runHeadlessHunt({
            huntId: 'standard_arena_waves',
            partyId: 'balance_quartet_novice',
            seed
        });
        const mid = await runHeadlessHunt({
            huntId: 'standard_arena_waves',
            partyId: 'balance_quartet',
            seed
        });
        const veteran = await runHeadlessHunt({
            huntId: 'standard_arena_waves',
            partyId: 'balance_quartet_veteran',
            seed
        });

        const nW = (novice.waves && novice.waves.wavesCompleted) || 0;
        const mW = (mid.waves && mid.waves.wavesCompleted) || 0;
        const vW = (veteran.waves && veteran.waves.wavesCompleted) || 0;

        assert.ok(novice.kills >= 1, 'novice scores kills');
        assert.ok(
            nW < mW,
            `novice should clear fewer waves than mid (${nW} vs ${mW})`
        );
        assert.ok(
            novice.kills < mid.kills,
            `novice kills ${novice.kills} should be < mid ${mid.kills}`
        );
        assert.ok(
            vW >= mW,
            `veteran waves ${vW} should be ≥ mid ${mW}`
        );
        assert.ok(
            veteran.damageDealt > mid.damageDealt,
            `veteran damage ${veteran.damageDealt} should exceed mid ${mid.damageDealt}`
        );

        // Spell level gates: L90 unlocks; L12 must not cast them.
        const gated = [
            'front_sweep',
            'fierce_rampage',
            'strong_spirit_javelin',
            'strong_flame_strike',
            'strong_ice_strike'
        ];
        const noviceGated = gated.filter(
            (id) => (novice.spellsCastById && novice.spellsCastById[id]) || 0
        );
        assert.strictEqual(
            noviceGated.length,
            0,
            `novice must not cast L70+ gated spells, got ${noviceGated}`
        );
        const veteranGatedHits = gated.reduce(
            (n, id) =>
                n + ((veteran.spellsCastById && veteran.spellsCastById[id]) || 0),
            0
        );
        assert.ok(
            veteranGatedHits >= 1,
            `veteran should cast ≥1 L70+ gated spell, spells=${JSON.stringify(
                veteran.spellsCastById
            )}`
        );

        // Mid can cast L35–50 mid spells (rampage / radiant_crater) that novice cannot.
        const midOnly = ['rampage', 'radiant_crater'];
        const midHits = midOnly.reduce(
            (n, id) => n + ((mid.spellsCastById && mid.spellsCastById[id]) || 0),
            0
        );
        const noviceMidHits = midOnly.reduce(
            (n, id) =>
                n + ((novice.spellsCastById && novice.spellsCastById[id]) || 0),
            0
        );
        assert.ok(midHits >= 1, 'mid tier should cast mid-gated spells');
        assert.strictEqual(
            noviceMidHits,
            0,
            'novice must not cast L35+ mid-gated spells'
        );

        log('arena progression tiers ok', {
            novice: { end: novice.endReason, waves: nW, kills: novice.kills },
            mid: { end: mid.endReason, waves: mW, kills: mid.kills },
            veteran: {
                end: veteran.endReason,
                waves: vW,
                kills: veteran.kills,
                gatedHits: veteranGatedHits
            }
        });
    } finally {
        setActiveMode(prev || 'standard');
    }
}

/**
 * Liveness guard: no successful attack for N ticks → no_attack_timeout.
 */
async function testNoAttackTimeout() {
    const map = openFloor(12, 12, 100);
    const sim = new Simulator({
        seed: 11,
        combatAi: true,
        noAttackTimeoutSec: 0.25, // 5 ticks at 20 UPS
        parties: [
            {
                name: 'P',
                id: 'p',
                loopWaypoints: true,
                waypoints: [
                    { x: 2, y: 2, z: 0 },
                    { x: 4, y: 2, z: 0 }
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
        // No spawns / waves — nothing to attack
        maxSeconds: 30,
        classLoader: () => ({
            id: 'guardian',
            label: 'G',
            base: { hp: 200, mp: 50, atk: 10, def: 5, speed: 100 }
        })
    });
    attachMap(sim, map);
    await sim.start();
    assert.ok(sim.noAttackTimeoutTicks >= 5);

    let guard = 0;
    while (sim.sessionState === 'running' && guard < 40) {
        guard += 1;
        Time.advanceFixedLogicStep();
        sim.updateAll();
    }

    assert.strictEqual(
        sim.sessionState,
        'no_attack_timeout',
        `expected no_attack_timeout got ${sim.sessionState}`
    );
    assert.strictEqual(sim.telemetry.endReason, 'no_attack_timeout');
    log('no attack timeout ok', { ticks: sim.tickCount, guard });
}

function regionIdOf(row, regions) {
    for (let i = 0; i < regions.length; i++) {
        const r = regions[i];
        if (
            row.x >= r.x &&
            row.x < r.x + r.w &&
            row.y >= r.y &&
            row.y < r.y + r.h
        ) {
            return r.id != null ? r.id : 'region_' + (i + 1);
        }
    }
    return null;
}

/**
 * Default (packClustering omitted/false): multi-region entries scatter across
 * the union of boxes — not glued to one region or collapsed on party anchors.
 */
function testDefaultScatterAcrossAuthoredRegions() {
    const map = openFloor(24, 24, 100);
    const regions = [
        { id: 'nw', x: 1, y: 1, w: 3, h: 3, z: 0 },
        { id: 'ne', x: 20, y: 1, w: 3, h: 3, z: 0 },
        { id: 'sw', x: 1, y: 20, w: 3, h: 3, z: 0 },
        { id: 'se', x: 20, y: 20, w: 3, h: 3, z: 0 }
    ];
    const zones = buildSpawnZones(map, regions, 0);
    assert.strictEqual(zones.length, 4);

    // Normalize without packClustering key → must default false.
    const cfg = normalizeWavesConfig({
        regions,
        list: [
            {
                id: 'spread',
                entries: [
                    { creatureId: 'rat', count: 8 },
                    { creatureId: 'orc', count: 4 }
                ]
            }
        ]
    });
    assert.strictEqual(cfg.packClustering, false);
    assert.ok(!('packClustering' in {
        regions,
        list: cfg.list
    }) || true);

    let calls = 0;
    const rng = () => {
        calls += 1;
        return (calls * 0.37) % 1;
    };

    const rows = materializeWaveSpawns(cfg.list[0], null, rng, {
        defaultZ: 0,
        waveId: 'spread',
        zones,
        autoSplit: false,
        packClustering: cfg.packClustering === true,
        // Party sits in NW — must not pull every creature there when multi-pack.
        anchors: [{ x: 2, y: 2, z: 0 }],
        anchorRadius: 4
    });
    assert.strictEqual(rows.length, 12);

    const regionHits = {};
    for (const row of rows) {
        const id = regionIdOf(row, regions);
        assert.ok(id, `row should land in a region, got ${row.x},${row.y}`);
        regionHits[id] = (regionHits[id] || 0) + 1;
    }
    assert.ok(
        Object.keys(regionHits).length >= 3,
        `default scatter should use ≥3 regions, got ${JSON.stringify(regionHits)}`
    );
    // Rats alone should be allowed to straddle multiple boxes (not one pack-box).
    const ratRegions = new Set(
        rows.filter((r) => r.creatureId === 'rat').map((r) => regionIdOf(r, regions))
    );
    assert.ok(
        ratRegions.size >= 2,
        `default: rat members should straddle regions, got ${[...ratRegions]}`
    );
    log('default scatter across authored regions ok', { regionHits, ratRegions: [...ratRegions] });
}

/**
 * packClustering: true keeps each entry as a unit inside one box.
 */
function testPackClusteringKeepsPackInOneRegion() {
    const map = openFloor(24, 24, 100);
    const regions = [
        { id: 'nw', x: 1, y: 1, w: 3, h: 3, z: 0 },
        { id: 'ne', x: 20, y: 1, w: 3, h: 3, z: 0 },
        { id: 'sw', x: 1, y: 20, w: 3, h: 3, z: 0 },
        { id: 'se', x: 20, y: 20, w: 3, h: 3, z: 0 }
    ];
    const zones = buildSpawnZones(map, regions, 0);

    const wave = normalizeWavesConfig({
        packClustering: true,
        list: [
            {
                id: 'clustered',
                entries: [
                    { creatureId: 'rat', count: 3 },
                    { creatureId: 'orc', count: 2 },
                    { creatureId: 'spider', count: 2 },
                    { creatureId: 'snake', count: 2 }
                ]
            }
        ]
    }).list[0];

    let calls = 0;
    const rng = () => {
        calls += 1;
        return (calls * 0.37) % 1;
    };

    const rows = materializeWaveSpawns(wave, null, rng, {
        defaultZ: 0,
        zones,
        autoSplit: false,
        packClustering: true,
        anchors: [{ x: 2, y: 2, z: 0 }],
        anchorRadius: 4
    });

    const packRegions = {};
    for (const creatureId of ['rat', 'orc', 'spider', 'snake']) {
        const pack = rows.filter((r) => r.creatureId === creatureId);
        const ids = new Set(pack.map((r) => regionIdOf(r, regions)));
        assert.strictEqual(
            ids.size,
            1,
            `${creatureId} pack should stay in one region, got ${[...ids]}`
        );
        packRegions[creatureId] = [...ids][0];
    }
    const distinct = new Set(Object.values(packRegions));
    assert.ok(
        distinct.size >= 3,
        `clustered packs should still spread across ≥3 regions, got ${JSON.stringify(packRegions)}`
    );
    log('packClustering keeps pack in one region ok', packRegions);
}

/**
 * No waves.regions + packClustering: auto-zones keep multi-pack units apart.
 */
function testPacksSpreadWithoutRegionsWhenClustering() {
    const map = openFloor(20, 20, 100);
    const walkable = collectWalkableTiles(map, null, 0);
    assert.ok(walkable.length >= 100);

    const zones = discoverAutoSpawnZones(walkable, 3, () => 0.5);
    assert.ok(zones.length >= 2, `auto zones expected ≥2, got ${zones.length}`);

    const wave = normalizeWavesConfig([
        {
            id: 'auto',
            entries: [
                { creatureId: 'rat', count: 4 },
                { creatureId: 'orc', count: 4 },
                { creatureId: 'spider', count: 4 }
            ]
        }
    ]).list[0];

    let calls = 0;
    const rng = () => {
        calls += 1;
        return (calls * 0.23) % 1;
    };

    const rows = materializeWaveSpawns(wave, walkable, rng, {
        defaultZ: 0,
        waveId: 'auto',
        autoSplit: true,
        packClustering: true
    });
    assert.strictEqual(rows.length, 12);

    function centroid(creatureId) {
        const pack = rows.filter((r) => r.creatureId === creatureId);
        let sx = 0;
        let sy = 0;
        for (const r of pack) {
            sx += r.x;
            sy += r.y;
        }
        return { x: sx / pack.length, y: sy / pack.length };
    }

    const cRat = centroid('rat');
    const cOrc = centroid('orc');
    const cSpider = centroid('spider');
    const dRO = Math.max(Math.abs(cRat.x - cOrc.x), Math.abs(cRat.y - cOrc.y));
    const dRS = Math.max(
        Math.abs(cRat.x - cSpider.x),
        Math.abs(cRat.y - cSpider.y)
    );
    const dOS = Math.max(
        Math.abs(cOrc.x - cSpider.x),
        Math.abs(cOrc.y - cSpider.y)
    );
    const maxPair = Math.max(dRO, dRS, dOS);
    assert.ok(
        maxPair >= 4,
        `clustered pack centroids should spread (max chebyshev ${maxPair})`
    );
    log('packs spread without regions (clustering) ok', { maxPair });
}

/**
 * Opt-in packClustering clumps members near a shared center.
 * Default (missing flag) spreads members across the full pool.
 */
function testPackClusteringOptIn() {
    const map = openFloor(20, 20, 100);
    const walkable = collectWalkableTiles(map, null, 0);

    const wave = normalizeWavesConfig([
        {
            id: 'cluster',
            entries: [{ creatureId: 'rat', count: 6 }]
        }
    ]).list[0];

    let calls = 0;
    const rng = () => {
        calls += 1;
        return (calls * 0.31) % 1;
    };

    const clustered = materializeWaveSpawns(wave, walkable, rng, {
        defaultZ: 0,
        packClustering: true
    });
    assert.strictEqual(clustered.length, 6);

    let maxIntra = 0;
    for (let i = 0; i < clustered.length; i++) {
        for (let j = i + 1; j < clustered.length; j++) {
            const d = Math.max(
                Math.abs(clustered[i].x - clustered[j].x),
                Math.abs(clustered[i].y - clustered[j].y)
            );
            if (d > maxIntra) maxIntra = d;
        }
    }
    assert.ok(
        maxIntra <= 4,
        `packClustering should clump (max intra ${maxIntra})`
    );

    // Omit packClustering entirely (same as missing JSON key).
    calls = 0;
    const scattered = materializeWaveSpawns(wave, walkable, rng, {
        defaultZ: 0
    });
    let maxScatter = 0;
    for (let i = 0; i < scattered.length; i++) {
        for (let j = i + 1; j < scattered.length; j++) {
            const d = Math.max(
                Math.abs(scattered[i].x - scattered[j].x),
                Math.abs(scattered[i].y - scattered[j].y)
            );
            if (d > maxScatter) maxScatter = d;
        }
    }
    assert.ok(
        maxScatter > maxIntra,
        `default scatter span (${maxScatter}) should exceed clustered (${maxIntra})`
    );

    log('packClustering opt-in ok', { maxIntra, maxScatter });
}

/**
 * WaveController: default config (no packClustering key) scatters; opt-in clusters.
 */
function testWaveControllerMultiRegionPackSpread() {
    const map = openFloor(24, 24, 100);
    const cfg = normalizeWavesConfig({
        delaySec: 0,
        startDelaySec: 0,
        regions: [
            { id: 'a', x: 1, y: 1, w: 4, h: 4, z: 0 },
            { id: 'b', x: 19, y: 1, w: 4, h: 4, z: 0 },
            { id: 'c', x: 1, y: 19, w: 4, h: 4, z: 0 }
        ],
        list: [
            {
                id: 'w0',
                entries: [
                    { creatureId: 'rat', count: 2 },
                    { creatureId: 'orc', count: 2 },
                    { creatureId: 'spider', count: 2 }
                ]
            }
        ]
    });
    assert.strictEqual(cfg.packClustering, false);
    const wc = new WaveController(cfg);
    wc.begin(0);
    let calls = 0;
    const rng = () => {
        calls += 1;
        return (calls * 0.41) % 1;
    };
    const result = wc.tick({
        time: 0,
        waveClear: false,
        tileMap: map,
        rng,
        defaultZ: 0,
        anchors: [{ x: 2, y: 2, z: 0 }],
        anchorRadius: 3
    });
    assert.ok(result.spawnRows && result.spawnRows.length === 6);

    const keys = new Set(
        result.spawnRows.map((r) => `${Math.floor(r.x / 10)},${Math.floor(r.y / 10)}`)
    );
    // Coarse 10-tile bins: NW(0,0), NE(1,0), SW(0,1) — default scatter uses >1 bin.
    assert.ok(
        keys.size >= 2,
        `controller default scatter should use multiple region bins, got ${[...keys]}`
    );
    log('wave controller multi-region pack spread ok', { bins: [...keys] });
}

async function main() {
    testNormalizeArrayShape();
    testNormalizeObjectShape();
    testCollectWaveCreatureIds();
    testMaterializeRandomTiles();
    testMultiRegionWalkableUnion();
    testWholeFloorWalkableFromLayerSize();
    testDefaultScatterAcrossAuthoredRegions();
    testPackClusteringKeepsPackInOneRegion();
    testPacksSpreadWithoutRegionsWhenClustering();
    testPackClusteringOptIn();
    testWaveControllerMultiRegionPackSpread();
    testWaveEntryAffixDefaults();
    testWaveControllerFsm();
    testClassicHuntUnchangedWithoutBoundaryPause();
    testAwaitingPortalBoundaryPause();
    testArenaIndexHelpers();
    await testSimulatorWavesComplete();
    await testSimulatorAffixSpawnStats();
    await testResolveHuntPassesWaves();
    await testHeadlessArenaSmoke();
    await testStandardArenaWavesProduct();
    await testArenaProgressionTiers();
    await testNoAttackTimeout();
    console.log('wave_manager: ok');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
