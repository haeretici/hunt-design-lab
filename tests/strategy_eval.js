#!/usr/bin/env node
/**
 * Stage 12F exit criteria:
 * - partiesWithStrategy swaps strategy only
 * - rankStrategyRows / strategyEvalToTsv pure helpers
 * - short eval: 1 iteration × 2 strategies (short maxTicks)
 * Quiet on success; VERBOSE=1 for detail.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
    strategyEvalToTsv,
    normalizeAnalysisDocument,
    chartSeriesFromDocument,
    metricsFromAggregate
} = require('../kernel/core/lib/balance_analysis.js');
const {
    listStrategyIds,
    partiesWithStrategy,
    loadHuntPartiesForEval,
    rankStrategyRows,
    strategyViabilityNotes,
    runStrategyEval
} = require('../kernel/core/lib/balance_sweep.js');
const { parseArgs } = require('../bin/sim_eval_strategies.js');

const VERBOSE = !!process.env.VERBOSE;

function log(...args) {
    if (VERBOSE) console.log(...args);
}

function testListAndParties() {
    const ids = listStrategyIds();
    assert.ok(ids.length >= 2);
    assert.ok(ids.indexOf('balanced') >= 0);
    assert.ok(ids.indexOf('pacifist') >= 0);

    const base = loadHuntPartiesForEval('cave_crawl_generated');
    assert.ok(base[0].members.length >= 1);
    const origStrat = base[0].members[0].strategyId;
    const origClass = base[0].members[0].classId;

    const swapped = partiesWithStrategy(base, 'pacifist');
    assert.strictEqual(swapped[0].members[0].strategyId, 'pacifist');
    assert.strictEqual(swapped[0].members[0].classId, origClass);
    // Original not mutated
    assert.strictEqual(base[0].members[0].strategyId, origStrat);

    if (swapped[0].members.length > 1) {
        assert.strictEqual(swapped[0].members[1].strategyId, 'pacifist');
        assert.strictEqual(
            swapped[0].members[1].classId,
            base[0].members[1].classId
        );
    }
    log('list/parties ok', { ids: ids.length, origClass });
}

function testRankAndTsv() {
    const fakeRows = [
        {
            strategyId: 'slow',
            label: 'Slow',
            metrics: metricsFromAggregate({
                iterations: 2,
                means: {
                    kills: 1,
                    deaths: 0,
                    damageDealt: 40,
                    damageTaken: 20,
                    expGained: 20,
                    lootGained: 0,
                    tickCount: 200,
                    timeToClear: 10,
                    expPerHour: 7200
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
            strategyId: 'fast',
            label: 'Fast',
            metrics: metricsFromAggregate({
                iterations: 2,
                means: {
                    kills: 4,
                    deaths: 0,
                    damageDealt: 100,
                    damageTaken: 10,
                    expGained: 80,
                    lootGained: 0,
                    tickCount: 80,
                    timeToClear: 4,
                    expPerHour: 72000
                },
                outcomes: {
                    routeComplete: 2,
                    partyWipe: 0,
                    timeout: 0,
                    killCap: 0
                }
            })
        }
    ];

    const ranked = rankStrategyRows(fakeRows, 'meanExpPerHour', false);
    assert.strictEqual(ranked[0].strategyId, 'fast');
    assert.strictEqual(ranked[0].rank, 1);
    assert.strictEqual(ranked[1].strategyId, 'slow');
    assert.strictEqual(ranked[1].rank, 2);

    const byTime = rankStrategyRows(fakeRows, 'meanTimeToClear', true);
    assert.strictEqual(byTime[0].strategyId, 'fast');

    const doc = {
        kind: 'strategy_eval',
        rows: ranked,
        chartMetrics: ['meanExpPerHour', 'meanKills']
    };
    const tsv = strategyEvalToTsv(doc);
    assert.ok(tsv.indexOf('strategy_id') >= 0);
    assert.ok(tsv.indexOf('fast') >= 0);
    assert.ok(tsv.indexOf('mean_exp_per_hour') >= 0);

    const norm = normalizeAnalysisDocument(doc);
    assert.strictEqual(norm.kind, 'strategy_eval');
    const series = chartSeriesFromDocument(norm, ['meanExpPerHour']);
    assert.deepStrictEqual(series.labels, ['Fast', 'Slow']);
    assert.strictEqual(series.series.meanExpPerHour[0], 72000);

    const notes = strategyViabilityNotes([
        {
            strategyId: 'broken',
            metrics: {
                routeCompleteRate: 0,
                meanKills: 0,
                partyWipeRate: 1,
                meanExpPerHour: 0
            }
        }
    ]);
    assert.ok(notes.length >= 1);
    assert.ok(notes[0].flags.length >= 1);
    log('rank/tsv ok');
}

function testParseArgs() {
    const p = parseArgs([
        '--strategies',
        'balanced,pacifist',
        '--seed',
        '9',
        '--tune',
        '--side-swap'
    ]);
    assert.deepStrictEqual(p.strategyIds, ['balanced', 'pacifist']);
    assert.strictEqual(p.seed, 9);
    assert.strictEqual(p.tune, true);
    assert.strictEqual(p.sideSwap, true);
    log('parseArgs ok');
}

async function testIntegrationEval() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'de-strategy-eval-'));
    try {
        const result = await runStrategyEval({
            huntId: 'cave_crawl_generated',
            strategyIds: ['balanced', 'pacifist'],
            seed: 11,
            iterations: 1,
            // Short cap for quiet CI / agent runs
            frames: 80,
            maxTicks: 80,
            outDir: tmp,
            writeFiles: true,
            quiet: true
        });

        assert.strictEqual(result.kind, 'strategy_eval');
        assert.strictEqual(result.rows.length, 2);
        assert.strictEqual(result.partyMode, 'hunt_default');
        assert.ok(result.files && result.files.json);
        assert.ok(fs.existsSync(result.files.json));
        assert.ok(fs.existsSync(result.files.tsv));

        const ids = result.rows.map((r) => r.strategyId).sort();
        assert.deepStrictEqual(ids, ['balanced', 'pacifist']);

        for (let i = 0; i < result.rows.length; i++) {
            assert.ok(result.rows[i].rank >= 1);
            assert.ok(result.rows[i].metrics);
            assert.ok(
                typeof result.rows[i].metrics.meanKills === 'number'
            );
        }

        // Seed-stable re-run
        const a = await runStrategyEval({
            strategyIds: ['balanced'],
            seed: 3,
            iterations: 1,
            frames: 60,
            maxTicks: 60,
            writeFiles: false,
            quiet: true
        });
        const b = await runStrategyEval({
            strategyIds: ['balanced'],
            seed: 3,
            iterations: 1,
            frames: 60,
            maxTicks: 60,
            writeFiles: false,
            quiet: true
        });
        assert.strictEqual(
            a.rows[0].metrics.meanKills,
            b.rows[0].metrics.meanKills
        );
        assert.strictEqual(
            a.rows[0].metrics.routeCompleteRate,
            b.rows[0].metrics.routeCompleteRate
        );

        log('integration eval ok', {
            ranking: result.rows.map((r) => ({
                id: r.strategyId,
                rank: r.rank,
                k: r.metrics.meanKills,
                exp: r.metrics.meanExpPerHour
            }))
        });
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

async function main() {
    testListAndParties();
    testRankAndTsv();
    testParseArgs();
    await testIntegrationEval();
    console.log('strategy_eval: ok');
}

main().catch((err) => {
    console.error('strategy_eval FAILED:', err);
    process.exit(1);
});
