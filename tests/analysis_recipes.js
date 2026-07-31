/**
 * I6 analysis recipes + I7 folder aggregation pure helpers.
 * Quiet on success; VERBOSE=1 for detail.
 */

'use strict';

const assert = require('assert');
const {
    listAnalysisRecipes,
    getAnalysisRecipe,
    formatRecipeCli,
    ANALYSIS_MINI_TUTORIAL
} = require('../kernel/core/lib/analysis_recipes.js');
const {
    normalizeAnalysisDocument,
    documentFromFolderEntries,
    groupResultFilesByFolder,
    metricLabel,
    metricsFromHuntSummary
} = require('../kernel/core/lib/balance_analysis.js');

const VERBOSE = process.env.VERBOSE === '1';
const log = (...args) => {
    if (VERBOSE) console.log(...args);
};

let failed = 0;
let passed = 0;

function test(name, fn) {
    try {
        fn();
        passed += 1;
        log('ok', name);
    } catch (err) {
        failed += 1;
        console.error('FAIL', name);
        console.error(err && err.stack ? err.stack : err);
    }
}

test('listAnalysisRecipes has four I6 recipes', () => {
    const list = listAnalysisRecipes();
    assert.ok(list.length >= 4);
    const ids = list.map((r) => r.id);
    assert.ok(ids.indexOf('band_pressure') >= 0);
    assert.ok(ids.indexOf('class_matrix') >= 0);
    assert.ok(ids.indexOf('strategy_rank') >= 0);
    assert.ok(ids.indexOf('threat_sanity') >= 0);
});

test('band_pressure CLI is sim:batch with golden hunt', () => {
    const cli = formatRecipeCli('band_pressure');
    assert.ok(cli.indexOf('sim:batch') >= 0);
    assert.ok(cli.indexOf('golden_cave_crawl') >= 0);
    assert.ok(cli.indexOf('i6_band_pressure') >= 0);
    const r = getAnalysisRecipe('band_pressure');
    assert.strictEqual(r.webRunnable, true);
    assert.strictEqual(r.kind, 'batch');
});

test('class_matrix and strategy_rank are CLI-only', () => {
    const matrix = formatRecipeCli('class_matrix');
    assert.ok(matrix.indexOf('sim:sweep') >= 0);
    assert.ok(matrix.indexOf('--matrix') >= 0);
    assert.ok(matrix.indexOf('standard_arena_waves') >= 0);
    assert.strictEqual(getAnalysisRecipe('class_matrix').webRunnable, false);

    const strat = formatRecipeCli('strategy_rank');
    assert.ok(strat.indexOf('sim:eval-strategies') >= 0);
    assert.ok(strat.indexOf('meanKills') >= 0);

    const threat = formatRecipeCli('threat_sanity');
    assert.ok(threat.indexOf('measure:threat') >= 0);
});

test('mini-tutorial has steps', () => {
    assert.ok(ANALYSIS_MINI_TUTORIAL.length >= 3);
    assert.ok(ANALYSIS_MINI_TUTORIAL[0].title);
    assert.ok(ANALYSIS_MINI_TUTORIAL[0].body);
});

test('normalize kind:batch sample with nested aggregate', () => {
    const doc = normalizeAnalysisDocument({
        kind: 'batch',
        recipe: 'golden_band_pressure',
        label: 'Golden',
        huntId: 'golden_cave_crawl',
        iterations: 5,
        aggregate: {
            iterations: 5,
            means: { kills: 7.2, timeToClear: 40, expPerHour: 1000 },
            outcomes: {
                routeComplete: 0,
                partyWipe: 0,
                timeout: 0,
                noAttackTimeout: 5
            }
        }
    });
    assert.ok(doc);
    assert.strictEqual(doc.rows.length, 1);
    assert.ok(Math.abs(doc.rows[0].metrics.noAttackTimeoutRate - 1) < 1e-9);
    assert.strictEqual(doc.rows[0].metrics.meanKills, 7.2);
});

test('metricsFromHuntSummary handles no_attack_timeout', () => {
    const m = metricsFromHuntSummary({
        sessionState: 'no_attack_timeout',
        seed: 1,
        kills: 11,
        timeToClear: 50
    });
    assert.strictEqual(m.noAttackTimeoutRate, 1);
    assert.strictEqual(m.meanKills, 11);
});

test('groupResultFilesByFolder groups by dir', () => {
    const folders = groupResultFilesByFolder([
        {
            path: 'var/sim/i6_band_pressure/batch_aggregate.json',
            dir: 'var/sim/i6_band_pressure',
            name: 'batch_aggregate.json',
            mtime: 100
        },
        {
            path: 'var/sim/i6_band_pressure/seed1.json',
            dir: 'var/sim/i6_band_pressure',
            name: 'seed1.json',
            mtime: 90
        },
        {
            path: 'var/sim/sweeps/x/class_matrix.json',
            dir: 'var/sim/sweeps/x',
            name: 'class_matrix.json',
            mtime: 200
        }
    ]);
    assert.strictEqual(folders.length, 2);
    assert.strictEqual(folders[0].path, 'var/sim/sweeps/x'); // newer first
    assert.strictEqual(folders[0].primaryName, 'class_matrix.json');
    const band = folders.find((f) => f.path === 'var/sim/i6_band_pressure');
    assert.ok(band);
    assert.strictEqual(band.fileCount, 2);
    assert.strictEqual(band.primaryName, 'batch_aggregate.json');
});

test('documentFromFolderEntries builds multi-seed batch_folder', () => {
    const combined = documentFromFolderEntries(
        [
            {
                name: 'batch_aggregate.json',
                document: {
                    iterations: 2,
                    means: { kills: 5, timeToClear: 30, expPerHour: 100 },
                    outcomes: {
                        routeComplete: 0,
                        partyWipe: 0,
                        noAttackTimeout: 2
                    },
                    seeds: [1, 2]
                }
            },
            {
                name: 'run_seed1.json',
                document: {
                    seed: 1,
                    huntId: 'golden_cave_crawl',
                    sessionState: 'no_attack_timeout',
                    kills: 4,
                    deaths: 0,
                    timeToClear: 28,
                    expPerHour: 90
                }
            },
            {
                name: 'run_seed2.json',
                document: {
                    seed: 2,
                    huntId: 'golden_cave_crawl',
                    sessionState: 'no_attack_timeout',
                    kills: 6,
                    deaths: 0,
                    timeToClear: 32,
                    expPerHour: 110
                }
            }
        ],
        'var/sim/i6_band_pressure'
    );
    assert.ok(combined);
    assert.strictEqual(combined.kind, 'batch_folder');
    assert.strictEqual(combined.rows.length, 2);
    assert.strictEqual(combined.rows[0].label, 'seed 1');
    assert.strictEqual(combined.rows[1].metrics.meanKills, 6);
    assert.ok(combined.aggregateMetrics);
    assert.strictEqual(combined.aggregateMetrics.meanKills, 5);
    assert.strictEqual(combined.folderPath, 'var/sim/i6_band_pressure');
});

test('documentFromFolderEntries prefers class_matrix primary', () => {
    const combined = documentFromFolderEntries([
        {
            name: 'class_matrix.json',
            document: {
                kind: 'class_matrix',
                rows: [
                    {
                        classId: 'guardian',
                        metrics: { meanKills: 3, routeCompleteRate: 1 }
                    }
                ]
            }
        },
        {
            name: 'noise.json',
            document: { sessionState: 'route_complete', kills: 1, seed: 9 }
        }
    ]);
    assert.ok(combined);
    assert.strictEqual(combined.kind, 'class_matrix');
    assert.strictEqual(combined.rows[0].classId, 'guardian');
});

test('metricLabel is human readable', () => {
    assert.ok(metricLabel('meanKills').indexOf('kills') >= 0);
    assert.ok(metricLabel('partyWipeRate').indexOf('wipe') >= 0);
});

console.log(
    failed
        ? `analysis_recipes: ${failed} failed, ${passed} passed`
        : `analysis_recipes: ${passed} passed`
);
process.exit(failed ? 1 : 0);
