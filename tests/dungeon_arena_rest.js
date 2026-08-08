#!/usr/bin/env node
/**
 * Arena ↔ rest chain layout: selective stairLinks, per-floor routes, resolve branch.
 * Quiet on success; VERBOSE=1 for detail.
 */

'use strict';

const assert = require('assert');
const {
    generateArenaRestChain,
    resolveArenaRestChainHuntLayout,
    resolveHuntLayout,
    normalizeArenaLoop,
    walkableAabb
} = require('../kernel/core/lib/dungeon/index.js');
const {
    loadDungeonProfile,
    loadPiecePack
} = require('../kernel/core/lib/presets.js');
const { setActiveMode } = require('../kernel/core/lib/modes.js');
const {
    normalizePiecePack,
    FRICTION_BLOCKED
} = require('../kernel/core/lib/dungeon/pieces.js');

const VERBOSE = !!process.env.VERBOSE;

function log(...args) {
    if (VERBOSE) console.log(...args);
}

function loaders() {
    return {
        loadDungeonProfile,
        loadPiecePack,
        normalizePiecePack
    };
}

function baseLoop(over) {
    return Object.assign(
        {
            wavesPerArena: 2,
            maxArenas: 2,
            artSets: ['cave_simple', 'ice_simple'],
            arenaProfileId: 'arena_combat_shell',
            restProfileId: 'rest_area_shell',
            deathPortal: true
        },
        over || {}
    );
}

function baseHunt(loopOver, wavesLen) {
    const loop = baseLoop(loopOver);
    const n =
        wavesLen != null
            ? wavesLen
            : loop.wavesPerArena * loop.maxArenas;
    const list = [];
    for (let i = 0; i < n; i++) {
        list.push({
            id: 'w' + i,
            delaySec: 0,
            entries: [{ creatureId: 'cave_rat', count: 1 }]
        });
    }
    return {
        id: 'test_arena_rest',
        layout: { type: 'arena_rest_chain' },
        arenaLoop: loop,
        waves: { list }
    };
}

function testNormalizeArenaLoop() {
    const n = normalizeArenaLoop({});
    assert.strictEqual(n.maxArenas, 2);
    assert.strictEqual(n.deathPortal, true);
    assert.strictEqual(n.pauseCombatUntilPortal, true);
    assert.ok(n.artSets.length >= 1);
    assert.strictEqual(normalizeArenaLoop({ deathPortal: false }).deathPortal, false);
    log('normalizeArenaLoop ok');
}

function testWalkableAabb() {
    const cols = 5;
    const rows = 5;
    const friction = new Uint8Array(cols * rows);
    friction.fill(FRICTION_BLOCKED);
    // Walkable 1..3 on both axes
    for (let y = 1; y <= 3; y++) {
        for (let x = 1; x <= 3; x++) {
            friction[y * cols + x] = 0;
        }
    }
    const box = walkableAabb(friction, cols, rows, 7);
    assert.strictEqual(box.z, 7);
    // Inset when box allows
    assert.ok(box.w >= 1 && box.h >= 1);
    log('walkableAabb ok', box);
}

function testProductChainSeedStable() {
    setActiveMode('standard');
    const opts = Object.assign({ seed: 42, arenaLoop: baseLoop() }, loaders());
    const a = generateArenaRestChain(opts);
    const b = generateArenaRestChain(opts);
    assert.strictEqual(a.ok, true, a.error && a.error.message);
    assert.strictEqual(b.ok, true);
    assert.deepStrictEqual(a.floors, [0, 1, 2]);
    assert.strictEqual(a.stairLinks.length, 1);
    assert.strictEqual(a.meta.deathPortal, true);

    // Product: no link originates on arena
    for (let i = 0; i < a.stairLinks.length; i++) {
        const fromZ = a.stairLinks[i].from.z;
        const fm = a.floorMeta.find((m) => String(m.z) === String(fromZ));
        assert.ok(fm, 'floorMeta for link from');
        assert.strictEqual(fm.role, 'rest', 'product link from rest only');
    }

    // Art alternates on arenas
    const arenas = a.floorMeta.filter((m) => m.role === 'arena');
    assert.strictEqual(arenas[0].artSet, 'cave_simple');
    assert.strictEqual(arenas[1].artSet, 'ice_simple');
    assert.strictEqual(
        a.floorMeta.find((m) => m.role === 'rest').artSet,
        'cave_simple',
        'rest inherits prior arena art'
    );

    // Spawn bounds present
    for (let i = 0; i < a.floorMeta.length; i++) {
        const sb = a.floorMeta[i].spawnBounds;
        assert.ok(sb && sb.w >= 1 && sb.h >= 1, 'spawnBounds');
        assert.strictEqual(String(sb.z), String(a.floorMeta[i].z));
    }

    // Seed stable floor sizes + entrance coords
    assert.strictEqual(
        JSON.stringify(a.floorMeta.map((m) => [m.z, m.pieceId, m.entrance])),
        JSON.stringify(b.floorMeta.map((m) => [m.z, m.pieceId, m.entrance]))
    );

    // Initial waypoints = arena_0 only
    assert.ok(a.waypoints.length);
    assert.ok(a.waypoints.every((w) => String(w.z) === '0'));
    assert.ok(a.perFloorWaypoints['0'] && a.perFloorWaypoints['1']);

    // Rest portal z stamped correctly (not piece-local 0)
    const rest = a.floorMeta.find((m) => m.role === 'rest');
    assert.strictEqual(rest.portalSocket.z, rest.z);
    assert.strictEqual(a.stairLinks[0].from.z, rest.z);
    assert.strictEqual(a.stairLinks[0].to.z, arenas[1].z);

    log('product chain ok', {
        pieces: a.floorMeta.map((m) => m.pieceId),
        links: a.stairLinks.length
    });
}

function testDebugDeathPortalFalse() {
    setActiveMode('standard');
    const gen = generateArenaRestChain(
        Object.assign(
            {
                seed: 7,
                arenaLoop: baseLoop({ maxArenas: 3, deathPortal: false })
            },
            loaders()
        )
    );
    assert.strictEqual(gen.ok, true, gen.error && gen.error.message);
    // floors: A0 R0 A1 R1 A2 → 5
    assert.strictEqual(gen.floors.length, 5);
    assert.strictEqual(gen.stairLinks.length, 4); // 2*(3-1)
    let fromArena = 0;
    let fromRest = 0;
    for (let i = 0; i < gen.stairLinks.length; i++) {
        const fromZ = gen.stairLinks[i].from.z;
        const fm = gen.floorMeta.find((m) => String(m.z) === String(fromZ));
        if (fm.role === 'arena') fromArena += 1;
        if (fm.role === 'rest') fromRest += 1;
    }
    assert.strictEqual(fromArena, 2);
    assert.strictEqual(fromRest, 2);
    log('debug deathPortal false ok');
}

function testResolveBranchAndWaveStamp() {
    setActiveMode('standard');
    const hunt = baseHunt();
    const out = resolveHuntLayout(hunt, {
        seed: 11,
        loadDungeonProfile,
        loadPiecePack
    });
    assert.strictEqual(out.layoutMeta.reason, 'ok');
    assert.strictEqual(out.layoutMeta.type, 'arena_rest_chain');
    assert.strictEqual(out.waves.wavesPerArena, 2);
    assert.strictEqual(out.waves.pauseOnArenaBoundary, true);
    assert.ok(out.floorLayers['0'] && out.floorLayers['1'] && out.floorLayers['2']);
    assert.strictEqual(out.stairLinks.length, 1);

    // Fail closed on list length
    const bad = baseHunt({}, 3);
    const badOut = resolveArenaRestChainHuntLayout(bad, {
        seed: 1,
        loadDungeonProfile,
        loadPiecePack
    });
    assert.notStrictEqual(badOut.layoutMeta.reason, 'ok');
    assert.strictEqual(badOut.layoutSkipped, 'waves_list_length');
    log('resolve + stamp ok');
}

function testThreeArenasProductLinks() {
    setActiveMode('standard');
    const gen = generateArenaRestChain(
        Object.assign(
            {
                seed: 99,
                arenaLoop: baseLoop({ maxArenas: 3, wavesPerArena: 1 })
            },
            loaders()
        )
    );
    assert.strictEqual(gen.ok, true, gen.error && gen.error.message);
    assert.strictEqual(gen.floors.length, 5);
    assert.strictEqual(gen.stairLinks.length, 2);
    for (let i = 0; i < gen.stairLinks.length; i++) {
        const L = gen.stairLinks[i];
        const from = gen.floorMeta.find((m) => String(m.z) === String(L.from.z));
        assert.strictEqual(from.role, 'rest');
    }
    log('three arenas product ok');
}

/**
 * Host FSM integration: deathPortal product path reaches waves_complete
 * after arena_0 → rest → arena_1 with spawn z rebind.
 */
async function testHostDeathPortalLoop() {
    setActiveMode('standard');
    const {
        runHeadlessHunt
    } = require('../kernel/providers/simulator/headless_runner.js');

    const hunt = {
        id: 'test_arc_host',
        artSet: 'cave_simple',
        spawnMode: 'eager',
        layout: { type: 'arena_rest_chain' },
        loopWaypoints: true,
        arenaLoop: baseLoop({
            wavesPerArena: 1,
            maxArenas: 2,
            deathPortal: true,
            portalNearRadius: 2
        }),
        waves: {
            packClustering: false,
            holdRoute: true,
            endOnComplete: true,
            delaySec: 0,
            startDelaySec: 0,
            list: [
                {
                    id: 'a0',
                    delaySec: 0,
                    entries: [
                        { creatureId: 'cave_rat', count: 2 },
                        { creatureId: 'bug', count: 1 }
                    ]
                },
                {
                    id: 'a1',
                    delaySec: 0,
                    entries: [
                        { creatureId: 'cave_rat', count: 2 },
                        { creatureId: 'bug', count: 1 }
                    ]
                }
            ]
        },
        limits: { maxSeconds: 120, noAttackTimeoutSec: 60 }
    };

    const summary = await runHeadlessHunt({
        seed: 3,
        hunt,
        frames: 5000,
        partyId: 'balance_quartet'
    });

    assert.strictEqual(
        summary.endReason,
        'waves_complete',
        'host endReason ' + summary.endReason
    );
    assert.ok(summary.arenaLoop, 'summary.arenaLoop');
    assert.strictEqual(summary.arenaLoop.phase, 'complete');
    assert.strictEqual(String(summary.arenaLoop.activeArenaZ), '2');
    assert.strictEqual(summary.waves.wavesCompleted, 2);

    const kinds = (summary.pacing && summary.pacing.events || []).map(
        (e) => e.kind
    );
    for (const need of [
        'arena_enter',
        'wave_boundary',
        'arena_clear',
        'portal_spawn',
        'rest_enter',
        'waves_complete'
    ]) {
        assert.ok(kinds.indexOf(need) >= 0, 'missing pacing ' + need);
    }
    // Two arena_enter (start + arena_1)
    assert.ok(
        kinds.filter((k) => k === 'arena_enter').length >= 2,
        'two arena_enter'
    );
    log('host deathPortal loop ok', {
        ticks: summary.tickCount,
        kills: summary.kills
    });
}

/**
 * Expand product hunt preset (resolve only — full ladder is long).
 */
function testProductHuntExpands() {
    setActiveMode('standard');
    const { loadHunt, expandHuntDefinition } = require('../kernel/core/lib/presets.js');
    const raw = loadHunt('standard_arena_rest_chain');
    assert.ok(raw, 'load standard_arena_rest_chain');
    const expanded = expandHuntDefinition(raw, { seed: 1 });
    assert.strictEqual(expanded.layoutMeta.reason, 'ok');
    assert.strictEqual(expanded.layoutMeta.type, 'arena_rest_chain');
    assert.strictEqual(expanded.floors.length, 3);
    assert.strictEqual(expanded.stairLinks.length, 1);
    assert.strictEqual(expanded.waves.wavesPerArena, 2);
    assert.strictEqual(expanded.waves.pauseOnArenaBoundary, true);
    assert.strictEqual(expanded.waves.list.length, 4);
    log('product hunt expand ok');
}

async function main() {
    testNormalizeArenaLoop();
    testWalkableAabb();
    testProductChainSeedStable();
    testDebugDeathPortalFalse();
    testResolveBranchAndWaveStamp();
    testThreeArenasProductLinks();
    testProductHuntExpands();
    await testHostDeathPortalLoop();
    console.log('dungeon_arena_rest: ok');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
