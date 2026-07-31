#!/usr/bin/env node
/**
 * Stage 11.4 — Procedural layout assembler.
 * - rule program normalize + materialize counts
 * - seed-stable generate; connectivity on success
 * - structured errors on failure
 * - hunt expand → floorFriction + population from sockets
 * - headless hunt on generated floor
 * Quiet on success; VERBOSE=1 for detail.
 */

'use strict';

const assert = require('assert');
const {
    RULE_OPS,
    normalizeRuleProgram,
    materializeRuleCounts,
    normalizeRule
} = require('../kernel/core/lib/dungeon/rules.js');
const {
    validateLayout,
    canReach
} = require('../kernel/core/lib/dungeon/validate.js');
const {
    generateProceduralLayout,
    resolveHuntLayout,
    normalizeDungeonProfile
} = require('../kernel/core/lib/dungeon/layout/procedural.js');
const {
    normalizePiecePack
} = require('../kernel/core/lib/dungeon/pieces.js');
const {
    loadPiecePack,
    loadDungeonProfile,
    listDungeonProfileIds,
    expandHuntDefinition,
    loadJson
} = require('../kernel/core/lib/presets.js');
const {
    runHeadlessHunt,
    resolveHuntConfig
} = require('../kernel/providers/simulator/headless_runner.js');
const { setActiveMode } = require('../kernel/core/lib/modes.js');
const { FRICTION_BLOCKED } = require('../kernel/core/entities/tilemap.js');
const { createSeededRandom } = require('../kernel/core/lib/utils.js');

const VERBOSE = !!process.env.VERBOSE;

function log(...args) {
    if (VERBOSE) console.log(...args);
}

function loadCavePack() {
    setActiveMode('standard');
    return normalizePiecePack(loadPiecePack('cave_v1'));
}

function testRuleNormalize() {
    const r = normalizeRule({ op: 'add_hub', tags: ['hub'], count: 1 }, 0);
    assert.ok(r);
    assert.strictEqual(r.op, RULE_OPS.AddHub);
    assert.deepStrictEqual(r.count, [1, 1]);

    const room = normalizeRule(
        { op: 'AddRoom', tags: ['room'], count: [3, 5] },
        1
    );
    assert.strictEqual(room.op, RULE_OPS.AddRoom);
    assert.deepStrictEqual(room.count, [3, 5]);
    assert.ok(room.excludeTags.indexOf('hub') >= 0);

    const prog = normalizeRuleProgram({
        id: 'unit',
        piecePack: 'cave_v1',
        rules: [
            { op: 'AddHub', count: 1 },
            { op: 'AddRoom', count: [2, 4] },
            { op: 'AddExit', count: 1 },
            { op: 'SelectEvent', events: ['champion_room'], count: 1 }
        ]
    });
    assert.ok(prog);
    assert.strictEqual(prog.id, 'unit');
    assert.strictEqual(prog.rules.length, 4);
    assert.strictEqual(prog.piecePack, 'cave_v1');

    const rng = createSeededRandom(7);
    const mat = materializeRuleCounts(prog, rng);
    assert.strictEqual(mat[0].n, 1);
    assert.ok(mat[1].n >= 2 && mat[1].n <= 4);

    log('rule normalize ok');
}

function testGenerateSeedStable() {
    const pack = loadCavePack();
    const profile = {
        id: 'unit_crawl',
        piecePack: 'cave_v1',
        floor: 0,
        maxAttempts: 48,
        maxPieces: 30,
        rules: [
            { op: 'AddHub', tags: ['hub'], count: 1 },
            { op: 'AddRoom', tags: ['room'], count: [2, 3] },
            { op: 'AddCorridor', tags: ['corridor'], count: [1, 2] },
            { op: 'AddExit', count: 1 }
        ]
    };

    const a = generateProceduralLayout({ profile, pack, seed: 42 });
    const b = generateProceduralLayout({ profile, pack, seed: 42 });
    assert.ok(a.ok, a.error && a.error.message);
    assert.ok(b.ok, b.error && b.error.message);
    assert.strictEqual(a.cols, b.cols);
    assert.strictEqual(a.rows, b.rows);
    assert.strictEqual(a.friction.length, b.friction.length);
    for (let i = 0; i < a.friction.length; i++) {
        assert.strictEqual(a.friction[i], b.friction[i], `friction@${i}`);
    }
    assert.strictEqual(a.placements.length, b.placements.length);
    assert.ok(a.validation && a.validation.ok);
    assert.ok(a.entrance && a.exit);
    assert.ok(a.sockets.spawns.length >= 1);
    assert.ok(a.waypoints.length >= 2);

    // Different seed should usually differ (not guaranteed but likely)
    const c = generateProceduralLayout({ profile, pack, seed: 99 });
    assert.ok(c.ok, c.error && c.error.message);

    log('seed-stable generate ok', {
        cols: a.cols,
        rows: a.rows,
        pieces: a.placements.length,
        spawns: a.sockets.spawns.length,
        attempts: a.attempts
    });
}

function testConnectivityAndValidate() {
    const pack = loadCavePack();
    const profile = normalizeDungeonProfile(loadDungeonProfile('small_crawl'));
    assert.ok(profile);

    let okRuns = 0;
    for (let seed = 1; seed <= 8; seed++) {
        const gen = generateProceduralLayout({
            profile,
            pack,
            seed,
            maxAttempts: 48
        });
        if (!gen.ok) {
            log('generate fail seed', seed, gen.error);
            continue;
        }
        okRuns++;
        assert.ok(gen.validation.ok, `seed ${seed} validation`);
        const reach = canReach(
            gen.friction,
            gen.cols,
            gen.rows,
            gen.entrance,
            gen.exit
        );
        assert.ok(reach.ok, `seed ${seed} entrance→exit`);
        // Spawn sockets walkable
        for (let i = 0; i < gen.sockets.spawns.length; i++) {
            const s = gen.sockets.spawns[i];
            assert.notStrictEqual(
                gen.friction[s.y * gen.cols + s.x],
                FRICTION_BLOCKED,
                `spawn walkable ${s.x},${s.y}`
            );
        }
    }
    assert.ok(okRuns >= 6, `expected most seeds to succeed, got ${okRuns}/8`);
    log('connectivity fixtures ok', { okRuns });
}

function testStructuredErrors() {
    const pack = loadCavePack();
    // Impossible: no rules / empty pack
    const empty = generateProceduralLayout({
        profile: { id: 'x', rules: [] },
        pack,
        seed: 1
    });
    // empty rules falls back to default rules when piecePack set — force invalid
    const noPack = generateProceduralLayout({
        profile: {
            id: 'x',
            rules: [{ op: 'AddHub', count: 1 }]
        },
        pack: null,
        seed: 1
    });
    assert.strictEqual(noPack.ok, false);
    assert.ok(noPack.error);
    assert.strictEqual(noPack.error.code, 'missing_piece_pack');

    // Tags that match nothing
    const badTags = generateProceduralLayout({
        profile: {
            id: 'bad',
            maxAttempts: 3,
            maxPieces: 5,
            rules: [
                { op: 'AddHub', tags: ['hub'], count: 1 },
                { op: 'AddRoom', tags: ['no_such_tag_xyz'], count: 3 }
            ]
        },
        pack,
        seed: 1
    });
    assert.strictEqual(badTags.ok, false);
    assert.ok(badTags.error);
    assert.ok(
        badTags.error.code === 'no_compatible_piece' ||
            badTags.error.code === 'budget_exceeded' ||
            badTags.error.code === 'no_open_exit' ||
            badTags.error.code === 'disconnected',
        badTags.error.code
    );

    log('structured errors ok', {
        noPack: noPack.error.code,
        badTags: badTags.error.code
    });
}

function testHuntExpandLayout() {
    setActiveMode('standard');
    const ids = listDungeonProfileIds();
    assert.ok(ids.indexOf('small_crawl') >= 0);

    const hunt = loadJson('hunts/cave_crawl_generated.json');
    const expanded = expandHuntDefinition(hunt, { seed: 42 });
    assert.ok(expanded.floorFriction, 'floorFriction present');
    assert.ok(expanded.floorFriction.friction);
    assert.ok(expanded.floorFriction.cols >= 5);
    assert.ok(expanded.layoutMeta && expanded.layoutMeta.reason === 'ok');
    assert.ok(Array.isArray(expanded.waypoints) && expanded.waypoints.length >= 2);
    assert.ok(
        Array.isArray(expanded.populationSlots) &&
            expanded.populationSlots.length >= 1
    );
    assert.ok(Array.isArray(expanded.spawns) && expanded.spawns.length >= 1);
    // Same seed twice
    const e2 = expandHuntDefinition(hunt, { seed: 42 });
    assert.strictEqual(
        expanded.floorFriction.cols,
        e2.floorFriction.cols
    );
    assert.strictEqual(
        expanded.floorFriction.friction.length,
        e2.floorFriction.friction.length
    );
    assert.strictEqual(expanded.spawns.length, e2.spawns.length);

    // resolveHuntConfig wires floorLayers
    const resolved = resolveHuntConfig({
        huntId: 'cave_crawl_generated',
        seed: 42
    });
    assert.ok(resolved.floorLayers);
    assert.ok(resolved.waypoints.length >= 2);
    assert.ok(resolved.spawns.length >= 1);

    log('hunt expand ok', {
        cols: expanded.floorFriction.cols,
        rows: expanded.floorFriction.rows,
        spawns: expanded.spawns.length,
        props: (expanded.props || []).length,
        pieces: expanded.layoutMeta.pieceCount
    });
}

async function testHeadlessGeneratedHunt() {
    setActiveMode('standard');
    const summary = await runHeadlessHunt({
        huntId: 'cave_crawl_generated',
        seed: 42,
        frames: 400
    });
    assert.ok(summary);
    assert.ok(
        summary.endReason === 'route_complete' ||
            summary.endReason === 'timeout' ||
            summary.endReason === 'party_wipe' ||
            summary.endReason === 'kill_cap' ||
            summary.sessionState,
        `unexpected end ${summary.endReason}`
    );
    // Map loaded and party moved or fought
    assert.ok(summary.tickCount > 0 || summary.frames > 0);
    log('headless generated hunt ok', {
        endReason: summary.endReason,
        ticks: summary.tickCount,
        kills: summary.kills,
        frames: summary.frames
    });
}

function testValidateUnit() {
    // Tiny corridor
    const cols = 5;
    const rows = 3;
    const friction = new Uint8Array(cols * rows);
    friction.fill(FRICTION_BLOCKED);
    for (let x = 0; x < cols; x++) {
        friction[1 * cols + x] = 100;
    }
    const v = validateLayout(
        {
            cols,
            rows,
            friction,
            sockets: {
                spawns: [{ x: 2, y: 1 }],
                markers: [],
                waypoints: [
                    { x: 0, y: 1 },
                    { x: 4, y: 1 }
                ]
            }
        },
        {
            entrance: { x: 0, y: 1 },
            exit: { x: 4, y: 1 }
        }
    );
    assert.ok(v.ok);
    assert.ok(v.connectivity.ok);

    const bad = validateLayout(
        {
            cols,
            rows,
            friction,
            sockets: { spawns: [{ x: 0, y: 0 }], markers: [], waypoints: [] }
        },
        {
            entrance: { x: 0, y: 1 },
            exit: { x: 4, y: 1 },
            requireSpawnWalkable: true
        }
    );
    assert.strictEqual(bad.ok, false);
    assert.ok(bad.errors.some((e) => e.code === 'spawn_blocked'));

    log('validate unit ok');
}

async function main() {
    testRuleNormalize();
    testValidateUnit();
    testGenerateSeedStable();
    testConnectivityAndValidate();
    testStructuredErrors();
    testHuntExpandLayout();
    await testHeadlessGeneratedHunt();
    console.log('dungeon_layout: ok');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
