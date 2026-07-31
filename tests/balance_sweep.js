#!/usr/bin/env node
/**
 * Stage 8 exit criteria:
 * - knob apply scales creature HP / spawn density
 * - sweep produces JSON + TSV with metrics
 * - chartSeries / normalizeAnalysisDocument pure helpers
 * - short integration sweep is seed-stable for route rates
 * Quiet on success; VERBOSE=1 for detail.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
    listKnobs,
    parseValueList,
    metricsFromAggregate,
    sweepToTsv,
    normalizeAnalysisDocument,
    chartSeriesFromDocument
} = require('../kernel/core/lib/balance_analysis.js');
const {
    getKnob,
    scaleCreatureFields,
    scaleSpawnDensity,
    runBalanceSweep,
    runClassViabilityMatrix,
    runCompositionSideSwap,
    mirrorPartyComposition,
    duoPartyForClasses,
    soloPartyForClass
} = require('../kernel/core/lib/balance_sweep.js');

const VERBOSE = !!process.env.VERBOSE;

function log(...args) {
    if (VERBOSE) console.log(...args);
}

function testKnobMeta() {
    const knobs = listKnobs();
    assert.ok(knobs.length >= 5);
    const ids = knobs.map((k) => k.id);
    assert.ok(ids.indexOf('creature_hp') >= 0);
    assert.ok(ids.indexOf('spell_power') >= 0);
    assert.ok(ids.indexOf('spawn_density') >= 0);

    const vals = parseValueList('0.5,1,2');
    assert.deepStrictEqual(vals, [0.5, 1, 2]);
    log('knob meta ok');
}

function testScaleHelpers() {
    const tpl = { id: 'cave_rat', hp: 100, hpMax: 100, armor: 10 };
    const half = scaleCreatureFields(tpl, 0.5, ['hp', 'hpMax']);
    assert.strictEqual(half.hp, 50);
    assert.strictEqual(half.hpMax, 50);
    assert.strictEqual(tpl.hp, 100, 'original not mutated');

    const spawns = [
        { creatureId: 'a', x: 1, y: 1 },
        { creatureId: 'b', x: 2, y: 2 },
        { creatureId: 'c', x: 3, y: 3 },
        { creatureId: 'd', x: 4, y: 4 }
    ];
    assert.strictEqual(scaleSpawnDensity(spawns, 2).length, 8);
    assert.strictEqual(scaleSpawnDensity(spawns, 1).length, 4);
    assert.ok(scaleSpawnDensity(spawns, 0.5).length >= 1);
    assert.ok(scaleSpawnDensity(spawns, 0.5).length <= 4);

    const applied = getKnob('creature_hp').apply(
        { huntId: 'cave_crawl_generated', seed: 1 },
        2
    );
    assert.strictEqual(applied.knob, 'creature_hp');
    assert.strictEqual(applied.knobValue, 2);
    assert.strictEqual(typeof applied.creatureLoader, 'function');
    const scaled = applied.creatureLoader('cave_rat');
    // ×2 on ported cave_rat (hp 30) → 60; still must scale base template
    assert.ok(scaled.hp >= 50, `scaled cave_rat hp expected ≥50, got ${scaled.hp}`);
    assert.ok(scaled.hpMax >= scaled.hp);
    log('scale helpers ok');
}

function testTsvAndChart() {
    const fake = {
        kind: 'sweep',
        knob: 'creature_hp',
        rows: [
            {
                value: 1,
                label: '1',
                metrics: metricsFromAggregate({
                    iterations: 2,
                    means: {
                        kills: 3,
                        deaths: 0,
                        damageDealt: 100,
                        damageTaken: 10,
                        expGained: 50,
                        lootGained: 0,
                        tickCount: 80,
                        timeToClear: 4,
                        expPerHour: 45000
                    },
                    outcomes: {
                        routeComplete: 2,
                        partyWipe: 0,
                        timeout: 0,
                        killCap: 0
                    }
                })
            },
            {
                value: 2,
                label: '2',
                metrics: metricsFromAggregate({
                    iterations: 2,
                    means: {
                        kills: 1,
                        deaths: 1,
                        damageDealt: 40,
                        damageTaken: 80,
                        expGained: 20,
                        lootGained: 0,
                        tickCount: 100,
                        timeToClear: 5,
                        expPerHour: 14400
                    },
                    outcomes: {
                        routeComplete: 0,
                        partyWipe: 2,
                        timeout: 0,
                        killCap: 0
                    }
                })
            }
        ],
        chartMetrics: ['routeCompleteRate', 'meanKills']
    };

    const tsv = sweepToTsv(fake);
    assert.ok(tsv.indexOf('route_complete_rate') >= 0);
    assert.ok(tsv.split('\n').length >= 3);

    const doc = normalizeAnalysisDocument(fake);
    assert.strictEqual(doc.kind, 'sweep');
    const series = chartSeriesFromDocument(doc, ['routeCompleteRate', 'meanKills']);
    assert.deepStrictEqual(series.labels, ['1', '2']);
    assert.strictEqual(series.series.routeCompleteRate[0], 1);
    assert.strictEqual(series.series.routeCompleteRate[1], 0);
    assert.strictEqual(series.series.meanKills[0], 3);

    // batch_aggregate.json shape (from runHeadlessHuntBatch)
    const agg = normalizeAnalysisDocument({
        iterations: 4,
        means: { kills: 2.5, expPerHour: 1000, timeToClear: 10, deaths: 0, damageDealt: 50, damageTaken: 0, expGained: 40, lootGained: 1, tickCount: 100 },
        outcomes: { routeComplete: 3, partyWipe: 1, timeout: 0, killCap: 0 },
        seeds: [1, 2, 3, 4]
    });
    assert.ok(agg);
    assert.strictEqual(agg.kind, 'sweep');
    assert.strictEqual(agg.rows.length, 1);
    assert.strictEqual(agg.rows[0].metrics.meanKills, 2.5);
    assert.ok(Math.abs(agg.rows[0].metrics.routeCompleteRate - 0.75) < 1e-9);

    // single hunt summary
    const hunt = normalizeAnalysisDocument({
        seed: 42,
        huntId: 'cave_crawl_generated',
        sessionState: 'route_complete',
        kills: 4,
        deaths: 0,
        damageDealt: 100,
        expPerHour: 5000,
        timeToClear: 6,
        tickCount: 120
    });
    assert.ok(hunt);
    assert.strictEqual(hunt.rows[0].metrics.routeCompleteRate, 1);
    assert.strictEqual(hunt.rows[0].metrics.meanKills, 4);
    log('tsv/chart ok');
}

async function testIntegrationSweep() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'de-sweep-'));
    try {
        // Pin starter_duo: mode default balance_quartet stalls on small_crawl
        // and inverts the soft HP vs route-complete ordering on seed 12.
        const duoBase = { partyId: 'starter_duo' };
        const result = await runBalanceSweep({
            knob: 'creature_hp',
            values: [0.5, 1, 2],
            huntId: 'cave_crawl_generated',
            seed: 12,
            iterations: 1,
            outDir: tmp,
            writeFiles: true,
            quiet: true,
            baseInput: duoBase
        });

        assert.strictEqual(result.kind, 'sweep');
        assert.strictEqual(result.rows.length, 3);
        assert.ok(result.files && result.files.json);
        assert.ok(fs.existsSync(result.files.json));
        assert.ok(fs.existsSync(result.files.tsv));

        const tsv = fs.readFileSync(result.files.tsv, 'utf8');
        assert.ok(tsv.indexOf('mean_kills') >= 0);

        // Higher HP should not increase route-complete rate vs lower HP
        // (soft check: 0.5x HP completes at least as often as 2x for this sample)
        const rLow = result.rows[0].metrics.routeCompleteRate;
        const rHigh = result.rows[2].metrics.routeCompleteRate;
        assert.ok(
            rLow >= rHigh,
            `expected low HP route rate >= high HP (${rLow} vs ${rHigh})`
        );

        // Seed-stable re-run of same single value
        const a = await runBalanceSweep({
            knob: 'creature_hp',
            values: [1],
            seed: 42,
            iterations: 1,
            writeFiles: false,
            quiet: true,
            baseInput: duoBase
        });
        const b = await runBalanceSweep({
            knob: 'creature_hp',
            values: [1],
            seed: 42,
            iterations: 1,
            writeFiles: false,
            quiet: true,
            baseInput: duoBase
        });
        assert.strictEqual(
            a.rows[0].metrics.meanKills,
            b.rows[0].metrics.meanKills
        );
        assert.strictEqual(
            a.rows[0].metrics.routeCompleteRate,
            b.rows[0].metrics.routeCompleteRate
        );
        log('integration sweep ok', {
            rows: result.rows.map((r) => ({
                v: r.value,
                rc: r.metrics.routeCompleteRate,
                k: r.metrics.meanKills
            }))
        });
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

async function testClassMatrix() {
    const parties = soloPartyForClass('guardian');
    assert.strictEqual(parties[0].members[0].classId, 'guardian');

    const matrix = await runClassViabilityMatrix({
        huntId: 'cave_crawl_generated',
        seed: 3,
        iterations: 1,
        classIds: ['guardian', 'scout'],
        writeFiles: false,
        quiet: true
    });
    assert.strictEqual(matrix.kind, 'class_matrix');
    assert.strictEqual(matrix.rows.length, 2);
    assert.ok(matrix.rows[0].metrics);
    log('class matrix ok', matrix.rows.map((r) => r.classId));
}

function testMirrorComposition() {
    const duo = duoPartyForClasses('guardian', 'scout');
    assert.strictEqual(duo[0].members[0].classId, 'guardian');
    assert.strictEqual(duo[0].members[0].isLeader, true);
    assert.strictEqual(duo[0].members[1].classId, 'scout');

    const mirrored = mirrorPartyComposition(duo);
    assert.strictEqual(mirrored[0].members[0].classId, 'scout');
    assert.strictEqual(mirrored[0].members[0].isLeader, true);
    assert.strictEqual(mirrored[0].members[1].classId, 'guardian');
    assert.strictEqual(mirrored[0].members[1].isLeader, false);
    // Original unchanged
    assert.strictEqual(duo[0].members[0].classId, 'guardian');
    log('mirror composition ok');
}

async function testSideSwap() {
    const result = await runCompositionSideSwap({
        huntId: 'cave_crawl_generated',
        seed: 5,
        iterations: 1,
        classA: 'guardian',
        classB: 'scout',
        writeFiles: false,
        quiet: true
    });
    assert.strictEqual(result.kind, 'side_swap');
    assert.ok(result.forward.metrics);
    assert.ok(result.swap.metrics);
    assert.ok(result.averagedMetrics);
    assert.strictEqual(
        result.averagedMetrics.iterations,
        result.forward.metrics.iterations + result.swap.metrics.iterations
    );
    // Averaged rate is mean of both sides
    const expected =
        (result.forward.metrics.meanKills + result.swap.metrics.meanKills) / 2;
    assert.ok(
        Math.abs(result.averagedMetrics.meanKills - expected) < 1e-9
    );
    log('side-swap ok', {
        avgKills: result.averagedMetrics.meanKills,
        fwd: result.forward.metrics.meanKills,
        swap: result.swap.metrics.meanKills
    });
}

async function main() {
    testKnobMeta();
    testScaleHelpers();
    testTsvAndChart();
    testMirrorComposition();
    await testIntegrationSweep();
    await testClassMatrix();
    await testSideSwap();
    console.log('balance_sweep: ok');
}

main().catch((err) => {
    console.error('balance_sweep FAILED:', err);
    process.exit(1);
});
