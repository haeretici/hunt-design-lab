#!/usr/bin/env node
/**
 * Stage 6 exit criteria:
 * - createEmptyHuntTelemetry / buildHuntSummary rates + element maps
 * - same seed ⇒ same summary core
 * - N batch iterations write summary files
 * Quiet on success; VERBOSE=1 for detail.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
    createEmptyHuntTelemetry,
    sampleAttack,
    sampleKill,
    sampleDeath,
    sampleLootTaken,
    sampleConsumable,
    buildHuntSummary,
    ratePerHour,
    summaryCore,
    stableStringify
} = require('../kernel/core/lib/telemetry.js');
const {
    runHeadlessHunt,
    runHeadlessHuntBatch,
    resolveHuntConfig,
    summaryCore: runnerCore
} = require('../kernel/providers/simulator/headless_runner.js');

const VERBOSE = !!process.env.VERBOSE;

function log(...args) {
    if (VERBOSE) console.log(...args);
}

function testEmptyAndSample() {
    const t = createEmptyHuntTelemetry();
    assert.strictEqual(t.kills, 0);
    assert.ok(t.damageDealtByElement);
    assert.strictEqual(t.damageDealtByElement.physical, 0);
    assert.ok(t.consumables);

    const mage = {
        type: 'player',
        autoAttacks: 0,
        spellsCast: 0,
        spellsCastById: Object.create(null),
        spellsCastByKind: Object.create(null),
        manaSpent: 0
    };
    sampleAttack(
        t,
        mage,
        { type: 'creature' },
        {
            ok: true,
            hit: true,
            critical: true,
            final: 12,
            hpDelta: -12,
            spell: { id: 'ember_bolt', kind: 'spell', element: 'fire', mana: 5 }
        }
    );
    assert.strictEqual(t.attacks, 1);
    assert.strictEqual(t.hits, 1);
    assert.strictEqual(t.crits, 1);
    assert.strictEqual(t.fatals, 0);
    assert.strictEqual(t.damageDealt, 12);
    assert.strictEqual(t.damageDealtByElement.fire, 12);
    assert.strictEqual(t.manaSpent, 5);
    assert.strictEqual(t.consumables.mana, 5);
    assert.strictEqual(t.autoAttacks, 0, 'strategy spells are not auto attacks');
    assert.strictEqual(t.spellsCast, 1, 'non-auto spell counted');
    assert.strictEqual(t.spellsCastById.ember_bolt, 1);
    assert.strictEqual(t.spellsCastByKind.spell, 1);
    assert.strictEqual(mage.spellsCast, 1);
    assert.strictEqual(mage.spellsCastById.ember_bolt, 1);
    assert.strictEqual(mage.manaSpent, 5);

    sampleAttack(
        t,
        { type: 'player' },
        { type: 'creature' },
        {
            ok: true,
            hit: true,
            critical: false,
            fatal: true,
            final: 8,
            hpDelta: -8,
            spell: { id: 'melee_auto', kind: 'auto', element: 'physical', mana: 0 }
        }
    );
    assert.strictEqual(t.fatals, 1);
    assert.strictEqual(t.autoAttacks, 1, 'player melee_auto counts');
    assert.strictEqual(t.spellsCast, 1, 'auto does not bump spellsCast');
    assert.strictEqual(t.spellsCastById.melee_auto, 1);
    assert.strictEqual(t.spellsCastByKind.auto, 1);
    // Per-member counter lives on the attacker entity.
    const playerA = { type: 'player', autoAttacks: 0 };
    sampleAttack(
        t,
        playerA,
        { type: 'creature' },
        {
            ok: true,
            hit: true,
            critical: false,
            final: 4,
            hpDelta: -4,
            spell: { id: 'wand_auto', kind: 'auto', element: 'energy', mana: 0 }
        }
    );
    assert.strictEqual(playerA.autoAttacks, 1, 'attacker.autoAttacks bumped');
    assert.strictEqual(t.autoAttacks, 2);
    assert.strictEqual(playerA.spellsCastById.wand_auto, 1);

    sampleAttack(
        t,
        { type: 'creature' },
        { type: 'player' },
        {
            ok: true,
            hit: true,
            critical: false,
            final: 3,
            hpDelta: -3,
            spell: { id: 'melee_auto', kind: 'auto', element: 'physical', mana: 0 }
        }
    );
    assert.strictEqual(t.damageTaken, 3);
    assert.strictEqual(t.damageTakenByElement.physical, 3);
    assert.strictEqual(t.autoAttacks, 2, 'creature autos do not count for party AutoAtk');

    sampleAttack(
        t,
        { type: 'player' },
        { type: 'creature' },
        {
            ok: true,
            hit: false,
            critical: false,
            final: 0,
            hpDelta: 0,
            spell: { id: 'distance_auto', kind: 'auto', element: 'physical' }
        }
    );
    assert.strictEqual(t.misses, 1);
    assert.strictEqual(t.autoAttacks, 3, 'missed party autos still count as swings');

    sampleKill(t, 40, 2);
    sampleDeath(t);
    sampleConsumable(t, 'potion', 1);
    assert.strictEqual(t.kills, 1);
    assert.strictEqual(t.expGained, 40);
    assert.strictEqual(t.rawExpGained, 40, 'legacy sampleKill treats raw=exp');
    assert.strictEqual(t.deaths, 1);
    assert.strictEqual(t.consumables.potions, 1);

    sampleKill(t, { exp: 100, rawExp: 50, loot: 1, levelUps: 2 });
    assert.strictEqual(t.expGained, 140);
    assert.strictEqual(t.rawExpGained, 90);
    assert.strictEqual(t.levelUps, 2);
    assert.strictEqual(t.lootGained, 3);

    sampleLootTaken(t, 20);
    assert.strictEqual(t.lootGained, 23);
    assert.strictEqual(t.kills, 2, 'loot taken does not add kills');

    log('empty + sample ok');
}

function testBuildSummaryRates() {
    const t = createEmptyHuntTelemetry();
    t.kills = 10;
    t.expGained = 3600;
    t.damageDealt = 7200;
    t.damageDealtByElement.physical = 7200;
    t.autoAttacks = 20;
    t.endReason = 'route_complete';

    const summary = buildHuntSummary({
        telemetry: t,
        seed: 7,
        floor: 7,
        tickCount: 200,
        sessionState: 'route_complete',
        routeComplete: true,
        partyWipe: false,
        timeSinceLevelLoad: 10, // 10 sim seconds
        huntId: 'unit',
        parties: []
    });

    assert.strictEqual(summary.schemaVersion, 1);
    assert.strictEqual(summary.kills, 10);
    assert.strictEqual(summary.expGained, 3600);
    // 3600 exp / 10s * 3600 = 1_296_000 /h
    assert.ok(Math.abs(summary.expPerHour - ratePerHour(3600, 10)) < 1e-9);
    assert.ok(Math.abs(summary.damageDealtPerHour - ratePerHour(7200, 10)) < 1e-9);
    assert.strictEqual(summary.autoAttacks, 20);
    // 20 autos / 10s → 7200/h
    assert.ok(
        Math.abs(summary.autoAttacksPerHour - ratePerHour(20, 10)) < 1e-9
    );
    assert.strictEqual(summary.timeToClear, 10);
    assert.strictEqual(summary.damageDealtByElement.physical, 7200);
    assert.ok(typeof summary.hitRate === 'number');

    const core = summaryCore(summary);
    assert.strictEqual(core.seed, 7);
    assert.strictEqual(core.kills, 10);
    assert.strictEqual(core.autoAttacks, 20);
    assert.ok(!('expPerHour' in core));
    assert.ok(!('autoAttacksPerHour' in core));

    log('buildSummary rates ok', {
        expPerHour: summary.expPerHour,
        dmgPerHour: summary.damageDealtPerHour,
        autoAtkPerHour: summary.autoAttacksPerHour
    });
}

function testResolveHuntConfig() {
    const r = resolveHuntConfig({
        seed: 42,
        huntId: 'cave_crawl_generated',
        maxKills: 2,
        maxSeconds: 30
    });
    assert.strictEqual(r.seed, 42);
    assert.strictEqual(r.huntId, 'cave_crawl_generated');
    assert.ok(r.parties.length >= 1);
    assert.ok(r.spawns.length >= 1);
    assert.strictEqual(r.maxKills, 2);
    assert.ok(r.maxTicks >= 30 * 20);
    assert.ok(r.maxFrames >= 1);
    log('resolveHuntConfig ok', {
        maxTicks: r.maxTicks,
        parties: r.parties.length,
        spawns: r.spawns.length
    });
}

async function testSeedStableSummary() {
    const a = await runHeadlessHunt({
        seed: 42,
        huntId: 'cave_crawl_generated',
        frames: 8000
    });
    const b = await runHeadlessHunt({
        seed: 42,
        huntId: 'cave_crawl_generated',
        frames: 8000
    });

    const ca = summaryCore(a);
    const cb = summaryCore(b);
    assert.strictEqual(
        stableStringify(ca),
        stableStringify(cb),
        'same seed ⇒ same summary core'
    );
    assert.strictEqual(a.sessionState, b.sessionState);
    assert.strictEqual(a.kills, b.kills);
    assert.strictEqual(a.damageDealt, b.damageDealt);
    assert.strictEqual(a.tickCount, b.tickCount);
    assert.ok(a.damageDealtByElement);
    assert.ok(typeof a.expPerHour === 'number');
    assert.ok(typeof a.timeToClear === 'number');
    assert.strictEqual(a.schemaVersion, 1);

    // runner re-exports same core helper
    assert.strictEqual(
        stableStringify(runnerCore(a)),
        stableStringify(ca)
    );

    log('seed-stable summary ok', {
        state: a.sessionState,
        kills: a.kills,
        expPerHour: a.expPerHour,
        ticks: a.tickCount
    });
}

async function testBatchWritesFiles() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'de-sim-'));
    try {
        const result = await runHeadlessHuntBatch({
            seed: 10,
            iterations: 3,
            huntId: 'cave_crawl_generated',
            frames: 8000,
            outDir: tmp,
            writeFiles: true,
            quiet: true
        });

        assert.strictEqual(result.iterations, 3);
        assert.strictEqual(result.summaries.length, 3);
        assert.ok(result.files.length >= 3);
        assert.ok(result.aggregate);
        assert.strictEqual(result.aggregate.iterations, 3);
        assert.ok(result.aggregate.means);
        assert.ok(result.aggregate.outcomes);

        for (let i = 0; i < result.files.length; i++) {
            const f = result.files[i];
            assert.ok(fs.existsSync(f), `missing file ${f}`);
            const raw = fs.readFileSync(f, 'utf8');
            const parsed = JSON.parse(raw);
            assert.ok(parsed);
        }

        // Fixed seed list: two runs with same seed must match
        const sameSeedBatch = await runHeadlessHuntBatch({
            seeds: [99, 99],
            huntId: 'cave_crawl_generated',
            frames: 8000,
            writeFiles: false,
            quiet: true
        });
        assert.strictEqual(
            stableStringify(summaryCore(sameSeedBatch.summaries[0])),
            stableStringify(summaryCore(sameSeedBatch.summaries[1]))
        );

        log('batch write ok', {
            dir: tmp,
            files: result.files.map((f) => path.basename(f)),
            outcomes: result.aggregate.outcomes
        });
    } finally {
        try {
            fs.rmSync(tmp, { recursive: true, force: true });
        } catch (_) {
            /* ignore */
        }
    }
}

async function testParallelBatchMatchesSequential() {
    const {
        planWorkerChunks,
        normalizeConcurrency
    } = require('../kernel/providers/simulator/headless_runner.js');

    assert.strictEqual(normalizeConcurrency(5, 3), 3);
    assert.strictEqual(normalizeConcurrency(0, 4), 1);
    const chunks = planWorkerChunks(5, 2);
    assert.strictEqual(chunks.length, 2);
    assert.strictEqual(
        chunks.reduce((s, c) => s + c.count, 0),
        5
    );

    const common = {
        seed: 21,
        iterations: 4,
        huntId: 'cave_crawl_generated',
        frames: 8000,
        writeFiles: false,
        quiet: true
    };
    const seq = await runHeadlessHuntBatch(
        Object.assign({}, common, { concurrency: 1 })
    );
    const par = await runHeadlessHuntBatch(
        Object.assign({}, common, { concurrency: 2 })
    );
    assert.strictEqual(par.workerProcessesUsed, 2);
    assert.strictEqual(seq.summaries.length, 4);
    assert.strictEqual(par.summaries.length, 4);
    for (let i = 0; i < 4; i++) {
        assert.strictEqual(
            stableStringify(summaryCore(seq.summaries[i])),
            stableStringify(summaryCore(par.summaries[i])),
            `parallel/sequential mismatch at i=${i}`
        );
    }
    log('parallel batch ok', {
        workers: par.workerProcessesUsed,
        kills: par.aggregate.means.kills
    });
}

async function testKillCapLimit() {
    const summary = await runHeadlessHunt({
        seed: 1,
        huntId: 'cave_crawl_generated',
        maxKills: 1,
        frames: 8000
    });
    // May kill_cap or finish earlier with route — if kill_cap, kills >= 1
    if (summary.sessionState === 'kill_cap') {
        assert.ok(summary.kills >= 1);
        assert.strictEqual(summary.endReason, 'kill_cap');
    }
    assert.ok(
        ['route_complete', 'party_wipe', 'timeout', 'kill_cap'].includes(
            summary.sessionState
        ),
        `unexpected state ${summary.sessionState}`
    );
    log('kill cap path ok', {
        state: summary.sessionState,
        kills: summary.kills
    });
}

async function main() {
    testEmptyAndSample();
    testBuildSummaryRates();
    testResolveHuntConfig();
    await testSeedStableSummary();
    await testBatchWritesFiles();
    await testParallelBatchMatchesSequential();
    await testKillCapLimit();
    console.log('telemetry: ok');
}

main().catch((err) => {
    console.error('telemetry FAILED:', err);
    process.exit(1);
});
