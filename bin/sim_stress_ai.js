#!/usr/bin/env node
/**
 * AI / spawn scale stress harness (Etapa 0–5).
 *
 * Modes:
 *   default  — pre-materialized idle creatures + sleep + tickHuntAi
 *   --slots  — SpawnManager on_demand: many data slots, few living (Etapa 2)
 *
 * Usage:
 *   npm run sim:stress-ai -- --players 50 --creatures 5000 --frames 100
 *   node bin/sim_stress_ai.js --players 200 --creatures 10000 --frames 400
 *   node bin/sim_stress_ai.js --linear   # force O(C×P) path (no spatial)
 *   node bin/sim_stress_ai.js --slots --players 50 --creatures 20000 --frames 40
 *   node bin/sim_stress_ai.js --no-sleep # disable AI_CREATURE_SLEEP
 *   node bin/sim_stress_ai.js --path-budget 32
 *   node bin/sim_stress_ai.js --help
 */

'use strict';

const { Settings } = require('../kernel/settings.js');
const { TileMap } = require('../kernel/core/entities/tilemap.js');
const { Creature } = require('../kernel/core/entities/creature.js');
const { Player } = require('../kernel/core/entities/player.js');
const { Party } = require('../kernel/core/entities/party.js');
const { Simulator } = require('../kernel/providers/simulator/simulator.js');
const {
    tickHuntAi,
    initPlayerAi,
    initCreatureAi,
    applyCreatureSleepState
} = require('../kernel/core/lib/ai/hunt_ai.js');

function printHelp() {
    console.log(`AI / spawn scale stress harness (spatial + caps + selective update).

Usage:
  node bin/sim_stress_ai.js [options]

Options:
  --players <n>      Living party leaders (default 50)
  --creatures <n>    Idle creatures (default mode) OR spawn slots (--slots)
  --frames <n>       Frames to run (default 100)
  --map-size <n>     Square map edge in tiles (default auto from spread)
  --radius <n>       AI_TICK_RADIUS for the run (default Settings)
  --chunk <n>        AI_SPATIAL_CHUNK_SIZE (default Settings)
  --linear           Disable creatureSpatialIndex (baseline O(C×P))
  --spread <n>       Min Chebyshev gap between players (default 40)
  --pack-far         Place all creatures in a far corner (default: true)
  --pack-random      Scatter creatures randomly (harder / denser AOI)
  --slots            Etapa 2: on_demand SpawnManager, creatures = slot count
  --max-living <n>   SPAWN_MAX_LIVING soft cap (slots mode; 0 = off)
  --idle-sec <n>     SPAWN_DESPAWN_IDLE_SEC (slots mode; default Settings)
  --no-sleep         Disable AI_CREATURE_SLEEP (Etapa 3 off)
  --path-budget <n>  AI_PATH_BUDGET_PER_FRAME (0 = unlimited; Etapa 5)
  --no-player-index  Disable playerSpatialIndex (linear creature→player aggro)
  --seed <n>         Placement seed (default 1)
  -h, --help         Show help

Exit: one JSON summary on stdout.
`);
}

/**
 * @param {string[]} argv
 * @returns {object}
 */
function parseArgs(argv) {
    const out = {
        players: 50,
        creatures: 5000,
        frames: 100,
        mapSize: null,
        radius: null,
        chunk: null,
        linear: false,
        spread: 40,
        packFar: true,
        seed: 1,
        slots: false,
        maxLiving: null,
        idleSec: null,
        noSleep: false,
        pathBudget: null,
        noPlayerIndex: false,
        help: false
    };
    const args = argv.slice();
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '-h' || a === '--help') {
            out.help = true;
        } else if (a === '--linear') {
            out.linear = true;
        } else if (a === '--pack-far') {
            out.packFar = true;
        } else if (a === '--pack-random') {
            out.packFar = false;
        } else if (a === '--slots') {
            out.slots = true;
        } else if (a === '--no-sleep') {
            out.noSleep = true;
        } else if (a === '--no-player-index') {
            out.noPlayerIndex = true;
        } else if (a === '--path-budget' && args[i + 1]) {
            out.pathBudget = Math.max(0, parseInt(args[++i], 10) || 0);
        } else if (a === '--players' && args[i + 1]) {
            out.players = Math.max(1, parseInt(args[++i], 10) || 1);
        } else if (a === '--creatures' && args[i + 1]) {
            out.creatures = Math.max(0, parseInt(args[++i], 10) || 0);
        } else if (a === '--frames' && args[i + 1]) {
            out.frames = Math.max(1, parseInt(args[++i], 10) || 1);
        } else if (a === '--map-size' && args[i + 1]) {
            out.mapSize = Math.max(16, parseInt(args[++i], 10) || 16);
        } else if (a === '--radius' && args[i + 1]) {
            out.radius = Math.max(0, parseInt(args[++i], 10) || 0);
        } else if (a === '--chunk' && args[i + 1]) {
            out.chunk = Math.max(1, parseInt(args[++i], 10) || 1);
        } else if (a === '--spread' && args[i + 1]) {
            out.spread = Math.max(1, parseInt(args[++i], 10) || 1);
        } else if (a === '--max-living' && args[i + 1]) {
            out.maxLiving = Math.max(0, parseInt(args[++i], 10) || 0);
        } else if (a === '--idle-sec' && args[i + 1]) {
            out.idleSec = Math.max(0, parseFloat(args[++i]) || 0);
        } else if (a === '--seed' && args[i + 1]) {
            out.seed = parseInt(args[++i], 10) || 1;
        }
    }
    return out;
}

/**
 * Open walkable floor (mid-gray path pixels).
 * @param {number} cols
 * @param {number} rows
 * @param {number|string} z
 * @returns {TileMap}
 */
function openFloor(cols, rows, z) {
    const g = 100;
    const rgba = new Uint8Array(cols * rows * 4);
    for (let i = 0; i < cols * rows; i++) {
        const o = i * 4;
        rgba[o] = g;
        rgba[o + 1] = g;
        rgba[o + 2] = g;
        rgba[o + 3] = 255;
    }
    const map = new TileMap();
    map.loadFloorFromRgba(z, cols, rows, rgba);
    return map;
}

/**
 * LCG for placement (does not touch Math.random / sim seed binding).
 * @param {number} seed
 * @returns {() => number}
 */
function makeRng(seed) {
    let s = seed >>> 0 || 1;
    return () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return s / 0x100000000;
    };
}

/**
 * Etapa 2: many spawn slots, on_demand materialization, idle AOI unload.
 * Living count should track player bubbles, not total slots.
 * @param {object} opts
 * @returns {object}
 */
function runSlotsStress(opts) {
    const prevMode = Settings.SPAWN_MODE;
    const prevIdle = Settings.SPAWN_DESPAWN_IDLE_SEC;
    const prevHome = Settings.SPAWN_DESPAWN_HOME_DIST;
    const prevMax = Settings.SPAWN_MAX_LIVING;
    const prevAct = Settings.SPAWN_ACTIVATE_RADIUS;
    const prevAi = Settings.AI_TICK_RADIUS;
    const prevGateP = Settings.AI_GATE_BRAIN_ON_MOVE_DELAY;
    const prevGateC = Settings.AI_GATE_CREATURE_ON_MOVE_DELAY;

    Settings.SPAWN_MODE = 'on_demand';
    Settings.SPAWN_DESPAWN_HOME_DIST = 0;
    Settings.SPAWN_DESPAWN_IDLE_SEC =
        opts.idleSec != null ? opts.idleSec : Settings.SPAWN_DESPAWN_IDLE_SEC;
    Settings.SPAWN_MAX_LIVING =
        opts.maxLiving != null ? opts.maxLiving : Settings.SPAWN_MAX_LIVING;
    if (opts.radius != null) {
        Settings.AI_TICK_RADIUS = opts.radius;
        Settings.SPAWN_ACTIVATE_RADIUS = opts.radius;
    }
    Settings.AI_GATE_BRAIN_ON_MOVE_DELAY = false;
    Settings.AI_GATE_CREATURE_ON_MOVE_DELAY = false;

    try {
        const playersN = opts.players;
        const slotsN = opts.creatures;
        const spread = opts.spread;
        const grid = Math.ceil(Math.sqrt(playersN));
        const need = grid * spread + 40;
        const mapSize = opts.mapSize != null ? opts.mapSize : Math.max(need, 256);
        const z = 0;
        const map = openFloor(mapSize, mapSize, z);
        const rng = makeRng(opts.seed);

        // Build slot table: mostly far pack, plus a few near each player bubble
        const spawns = [];
        const packOrigin = Math.max(2, mapSize - Math.ceil(Math.sqrt(slotsN)) - 4);
        const side = Math.ceil(Math.sqrt(slotsN)) + 2;
        for (let i = 0; i < slotsN; i++) {
            let x;
            let y;
            if (opts.packFar) {
                x = packOrigin + (i % side);
                y = packOrigin + Math.floor(i / side);
                if (x >= mapSize - 1 || y >= mapSize - 1) {
                    x = 1 + Math.floor(rng() * (mapSize - 2));
                    y = 1 + Math.floor(rng() * (mapSize - 2));
                }
            } else {
                x = 1 + Math.floor(rng() * (mapSize - 2));
                y = 1 + Math.floor(rng() * (mapSize - 2));
            }
            spawns.push({
                creatureId: 'stress_slot',
                x,
                y,
                z,
                respawn: 30
            });
        }
        // Sprinkle local dens near player grid so living > 0
        for (let i = 0; i < playersN; i++) {
            const gx = i % grid;
            const gy = Math.floor(i / grid);
            const px = Math.min(mapSize - 2, 4 + gx * spread);
            const py = Math.min(mapSize - 2, 4 + gy * spread);
            for (let k = 0; k < 3; k++) {
                spawns.push({
                    creatureId: 'stress_local',
                    x: Math.min(mapSize - 2, px + (k % 3)),
                    y: Math.min(mapSize - 2, py + Math.floor(k / 3)),
                    z,
                    respawn: 30
                });
            }
        }

        const sim = new Simulator({
            seed: opts.seed,
            combatAi: true,
            recordSteps: false,
            spawnMode: 'on_demand',
            spawns,
            creatureLoader: () => ({
                id: 'stress',
                name: 'Stress',
                combat: { hp: 10, attack: 0, defense: 1 },
                speed: 100
            })
        });
        sim.setTileMap(map);
        sim.floor = z;
        sim.sessionState = 'running';
        sim.active = true;
        // Rebuild spawn manager with current Settings knobs
        sim.spawnManager = sim._createSpawnManager
            ? sim._createSpawnManager()
            : sim.spawnManager;
        if (sim.spawnManager) {
            sim.spawnManager.load(spawns);
        }

        const party = new Party({
            name: 'Stress',
            waypoints: [{ x: 2, y: 2, z }]
        });
        for (let i = 0; i < playersN; i++) {
            const gx = i % grid;
            const gy = Math.floor(i / grid);
            const x = Math.min(mapSize - 2, 4 + gx * spread);
            const y = Math.min(mapSize - 2, 4 + gy * spread);
            const player = new Player({
                id: sim.allocEntityId(),
                name: `P${i}`,
                classId: 'guardian',
                isLeader: i === 0,
                strategyId: 'pacifist',
                level: 20,
                tile: { x, y, z }
            });
            map.tryOccupy(x, y, z, player);
            player.syncPositionFromTile && player.syncPositionFromTile();
            party.addMember(player);
            initPlayerAi(player, { strategyId: 'pacifist' });
            sim.entityById.set(player.id, player);
        }
        sim.parties.push(party);
        sim.insertChild(party);

        sim.spawnPerfTotals = null;
        sim.aiPerfTotals = null;

        const { Time } = require('../kernel/core/lib/time.js');
        const t0 = process.hrtime.bigint();
        for (let f = 0; f < opts.frames; f++) {
            Time.advanceFixedLogicStep();
            // Spawn lifecycle + AI tick (combat-session hot path without full updateAll)
            if (typeof sim._tickSpawnManager === 'function') {
                sim._tickSpawnManager();
            }
            tickHuntAi(sim, null);
        }
        const t1 = process.hrtime.bigint();
        const wallMs = Number(t1 - t0) / 1e6;

        const living = sim.creatures.filter((c) => c && c.alive).length;
        const slots = sim.spawnManager ? sim.spawnManager.size : spawns.length;
        const spawnTot = sim.spawnPerfTotals || {};
        const aiTot = sim.aiPerfTotals || {};

        const summary = {
            ok: true,
            mode: 'slots',
            config: {
                players: playersN,
                slots,
                frames: opts.frames,
                mapSize,
                activateRadius: Settings.SPAWN_ACTIVATE_RADIUS,
                idleSec: Settings.SPAWN_DESPAWN_IDLE_SEC,
                maxLiving: Settings.SPAWN_MAX_LIVING,
                packFar: !!opts.packFar,
                seed: opts.seed
            },
            wallMs: Math.round(wallMs * 1000) / 1000,
            msPerFrame: Math.round((wallMs / opts.frames) * 1000) / 1000,
            living,
            livingPeak: spawnTot.livingPeak || living,
            slots,
            livingToSlots:
                slots > 0
                    ? Math.round((living / slots) * 10000) / 10000
                    : 0,
            spawnTotals: spawnTot,
            aiTotals: {
                frames: aiTot.frames || 0,
                distanceChecks: aiTot.distanceChecks || 0,
                brainsExecuted: aiTot.brainsExecuted || 0,
                usedSpatial: !!aiTot.usedSpatial
            },
            note:
                'Etapa 2 exit: living ≪ slots (O(P × local dens), not full table).'
        };
        if (typeof sim.destroy === 'function') sim.destroy();
        return summary;
    } finally {
        Settings.SPAWN_MODE = prevMode;
        Settings.SPAWN_DESPAWN_IDLE_SEC = prevIdle;
        Settings.SPAWN_DESPAWN_HOME_DIST = prevHome;
        Settings.SPAWN_MAX_LIVING = prevMax;
        Settings.SPAWN_ACTIVATE_RADIUS = prevAct;
        Settings.AI_TICK_RADIUS = prevAi;
        Settings.AI_GATE_BRAIN_ON_MOVE_DELAY = prevGateP;
        Settings.AI_GATE_CREATURE_ON_MOVE_DELAY = prevGateC;
    }
}

/**
 * @param {object} opts
 * @returns {object}
 */
function runStress(opts) {
    if (opts.slots) {
        return runSlotsStress(opts);
    }

    const prevRadius = Settings.AI_TICK_RADIUS;
    const prevChunk = Settings.AI_SPATIAL_CHUNK_SIZE;
    const prevGateP = Settings.AI_GATE_BRAIN_ON_MOVE_DELAY;
    const prevGateC = Settings.AI_GATE_CREATURE_ON_MOVE_DELAY;
    const prevSleep = Settings.AI_CREATURE_SLEEP;
    const prevPathBudget = Settings.AI_PATH_BUDGET_PER_FRAME;

    if (opts.radius != null) Settings.AI_TICK_RADIUS = opts.radius;
    if (opts.chunk != null) Settings.AI_SPATIAL_CHUNK_SIZE = opts.chunk;
    // Keep brains cheap: no move-delay gate thrash; we only care about gather cost.
    Settings.AI_GATE_BRAIN_ON_MOVE_DELAY = false;
    Settings.AI_GATE_CREATURE_ON_MOVE_DELAY = false;
    if (opts.noSleep) Settings.AI_CREATURE_SLEEP = false;
    else Settings.AI_CREATURE_SLEEP = true;
    if (opts.pathBudget != null) Settings.AI_PATH_BUDGET_PER_FRAME = opts.pathBudget;

    try {
        const playersN = opts.players;
        const creaturesN = opts.creatures;
        const spread = opts.spread;
        // Place players on a grid so they rarely share AI bubbles when spread large.
        const grid = Math.ceil(Math.sqrt(playersN));
        const need = grid * spread + 40;
        const mapSize = opts.mapSize != null ? opts.mapSize : Math.max(need, 128);
        const z = 0;
        const map = openFloor(mapSize, mapSize, z);

        const sim = new Simulator({
            seed: opts.seed,
            combatAi: true,
            recordSteps: false
        });
        sim.setTileMap(map);
        sim.floor = z;
        sim.sessionState = 'running';
        sim.active = true;

        if (opts.linear) {
            sim.creatureSpatialIndex = false;
        } else if (sim.creatureSpatialIndex && sim.creatureSpatialIndex !== false) {
            // Recreate with current chunk setting
            const { SpatialIndex } = require('../kernel/core/lib/spatial_index.js');
            sim.creatureSpatialIndex = new SpatialIndex({
                chunkSize: Settings.AI_SPATIAL_CHUNK_SIZE
            });
        }
        if (opts.noPlayerIndex) {
            sim.playerSpatialIndex = false;
        } else if (sim.playerSpatialIndex && sim.playerSpatialIndex !== false) {
            const { SpatialIndex } = require('../kernel/core/lib/spatial_index.js');
            sim.playerSpatialIndex = new SpatialIndex({
                chunkSize: Settings.AI_SPATIAL_CHUNK_SIZE
            });
        }

        const rng = makeRng(opts.seed);
        const party = new Party({
            name: 'Stress',
            waypoints: [{ x: 2, y: 2, z }]
        });

        for (let i = 0; i < playersN; i++) {
            const gx = i % grid;
            const gy = Math.floor(i / grid);
            const x = Math.min(mapSize - 2, 4 + gx * spread);
            const y = Math.min(mapSize - 2, 4 + gy * spread);
            const player = new Player({
                id: sim.allocEntityId(),
                name: `P${i}`,
                classId: 'guardian',
                isLeader: i === 0,
                strategyId: 'pacifist',
                level: 20,
                tile: { x, y, z }
            });
            map.tryOccupy(x, y, z, player);
            player.syncPositionFromTile && player.syncPositionFromTile();
            party.addMember(player);
            initPlayerAi(player, { strategyId: 'pacifist' });
            sim.entityById.set(player.id, player);
            if (sim.playerSpatialIndex && sim.playerSpatialIndex !== false) {
                sim.playerSpatialIndex.insert(player);
            }
        }
        sim.parties.push(party);
        sim.insertChild(party);

        // Fill creatures: default far pack (idle dens off-screen) or random scatter.
        let placed = 0;
        let guard = 0;
        const packOrigin = Math.max(2, mapSize - Math.ceil(Math.sqrt(creaturesN)) - 4);
        while (placed < creaturesN && guard < creaturesN * 40) {
            guard += 1;
            let x;
            let y;
            if (opts.packFar) {
                const side = Math.ceil(Math.sqrt(creaturesN)) + 2;
                x = packOrigin + (placed % side);
                y = packOrigin + Math.floor(placed / side);
                if (x >= mapSize - 1 || y >= mapSize - 1) {
                    x = packOrigin + Math.floor(rng() * Math.min(side, mapSize - packOrigin - 1));
                    y = packOrigin + Math.floor(rng() * Math.min(side, mapSize - packOrigin - 1));
                }
            } else {
                x = 1 + Math.floor(rng() * (mapSize - 2));
                y = 1 + Math.floor(rng() * (mapSize - 2));
            }
            const creature = new Creature({
                id: sim.allocEntityId(),
                name: `c${placed}`,
                tile: { x, y, z },
                combat: { hp: 10, attack: 1, defense: 1 }
            });
            if (!map.tryOccupy(x, y, z, creature)) continue;
            if (typeof creature.syncPositionFromTile === 'function') {
                creature.syncPositionFromTile();
            }
            initCreatureAi(creature);
            creature.aiState = 'idle';
            creature.moveDelay = 0;
            // Pacifist stress: never auto-aggro during gather benchmark
            creature.aggro = false;
            sim.creatures.push(creature);
            sim.entityById.set(creature.id, creature);
            sim.insertChild(creature);
            if (sim.creatureSpatialIndex && sim.creatureSpatialIndex !== false) {
                sim.creatureSpatialIndex.insert(creature);
            }
            placed += 1;
        }

        // Warm one frame so totals start clean after placement
        sim.aiPerfTotals = null;
        sim.updatePerfTotals = null;
        const { Time } = require('../kernel/core/lib/time.js');
        const {
            resetPathBudgetStats,
            pathBudgetStats
        } = require('../kernel/core/lib/path_budget.js');
        resetPathBudgetStats();
        const t0 = process.hrtime.bigint();
        for (let f = 0; f < opts.frames; f++) {
            Time.advanceFixedLogicStep();
            // Etapa 3: sleep + selective entity update (same order as Simulator.updateAll)
            applyCreatureSleepState(sim);
            const list = sim.creatures || [];
            for (let i = 0; i < list.length; i++) {
                const c = list[i];
                if (c) c.updateAll();
            }
            tickHuntAi(sim, null);
        }
        const t1 = process.hrtime.bigint();
        const wallMs = Number(t1 - t0) / 1e6;
        const totals = sim.aiPerfTotals || {};
        const frames = totals.frames || opts.frames;
        const last = sim.aiPerf || {};
        const upTot = sim.updatePerfTotals || {};
        const upLast = sim.updatePerf || {};
        const pathStats = pathBudgetStats();

        const summary = {
            ok: true,
            mode: 'ai_gather',
            config: {
                players: playersN,
                creatures: placed,
                frames: opts.frames,
                mapSize,
                radius: Settings.AI_TICK_RADIUS,
                chunkSize: Settings.AI_SPATIAL_CHUNK_SIZE,
                linear: !!opts.linear,
                sleep: Settings.AI_CREATURE_SLEEP !== false,
                pathBudget: Settings.AI_PATH_BUDGET_PER_FRAME || 0,
                playerIndex: !(sim.playerSpatialIndex === false),
                spread,
                packFar: !!opts.packFar,
                seed: opts.seed
            },
            wallMs: Math.round(wallMs * 1000) / 1000,
            msPerFrame: Math.round((wallMs / opts.frames) * 1000) / 1000,
            spatial: sim.creatureSpatialIndex && sim.creatureSpatialIndex !== false
                ? sim.creatureSpatialIndex.stats()
                : null,
            playerSpatial:
                sim.playerSpatialIndex && sim.playerSpatialIndex !== false
                    ? sim.playerSpatialIndex.stats()
                    : null,
            pathBudget: pathStats,
            totals: {
                frames,
                creaturesIterated: totals.creaturesIterated || 0,
                distanceChecks: totals.distanceChecks || 0,
                brainsExecuted: totals.brainsExecuted || 0,
                brainsConsidered: totals.brainsConsidered || 0,
                enemiesListed: totals.enemiesListed || 0,
                spatialCandidates: totals.spatialCandidates || 0,
                stickyCandidates: totals.stickyCandidates || 0,
                usedSpatial: !!totals.usedSpatial,
                aoiBuilt: totals.aoiBuilt || 0,
                aoiCacheHits: totals.aoiCacheHits || 0
            },
            updateTotals: {
                frames: upTot.frames || 0,
                living: upTot.living || 0,
                awake: upTot.awake || 0,
                asleep: upTot.asleep || 0,
                sleepEnabled: !!upTot.sleepEnabled
            },
            perFrameAvg: {
                creaturesIterated: avg(totals.creaturesIterated, frames),
                distanceChecks: avg(totals.distanceChecks, frames),
                brainsExecuted: avg(totals.brainsExecuted, frames),
                brainsConsidered: avg(totals.brainsConsidered, frames),
                enemiesListed: avg(totals.enemiesListed, frames),
                spatialCandidates: avg(totals.spatialCandidates, frames),
                aoiBuilt: avg(totals.aoiBuilt, frames),
                aoiCacheHits: avg(totals.aoiCacheHits, frames),
                awake: avg(upTot.awake, upTot.frames || frames),
                asleep: avg(upTot.asleep, upTot.frames || frames)
            },
            lastFrame: last,
            lastUpdate: upLast,
            note:
                'Etapa 5: playerSpatialIndex for creature aggro + AI_PATH_BUDGET_PER_FRAME. ' +
                'Etapa 4: AOI frame cache. Etapa 3: asleep skip Creature.update. ' +
                'pack-far → asleep ≈ creatures.'
        };

        // Naive O(C×P) estimate for comparison
        summary.baselineEstimate = {
            distanceChecksPerFrameIfLinear: playersN * placed,
            note: 'Linear path would do up to players×creatures Chebyshev checks per enemy filter+tick (order-of-magnitude).'
        };

        sim.destroy();
        return summary;
    } finally {
        Settings.AI_TICK_RADIUS = prevRadius;
        Settings.AI_SPATIAL_CHUNK_SIZE = prevChunk;
        Settings.AI_GATE_BRAIN_ON_MOVE_DELAY = prevGateP;
        Settings.AI_GATE_CREATURE_ON_MOVE_DELAY = prevGateC;
        Settings.AI_CREATURE_SLEEP = prevSleep;
        Settings.AI_PATH_BUDGET_PER_FRAME = prevPathBudget;
    }
}

/**
 * @param {number} sum
 * @param {number} n
 * @returns {number}
 */
function avg(sum, n) {
    if (!n) return 0;
    return Math.round(((sum || 0) / n) * 100) / 100;
}

function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
        printHelp();
        process.exit(0);
    }
    const summary = runStress(opts);
    console.log(JSON.stringify(summary, null, 2));
}

main();
