/**
 * Stage 12I — Hunt Sim Batch Builder pure helpers.
 * Quiet by default; VERBOSE=1 for detail.
 */

'use strict';

const assert = require('assert');
const {
    normalizeSimBatchForm,
    buildSimBatchConfig,
    buildMembersForConfig,
    buildSimBatchRunPayload,
    formatSimBatchCliJson,
    formatSimBatchCliFlags,
    isLargeBatch,
    formatLargeBatchHint,
    LARGE_BATCH_ITERATIONS,
    DEFAULT_SIM_BATCH_FORM,
    FALLBACK_HUNT_IDS,
    shellQuote,
    listAnalysisRecipes,
    formatRecipeCli
} = require('../kernel/apps/sim-batch-builder.js');
const {
    mergeSimBatchPrefill,
    SIM_BATCH_CHANNEL,
    SIM_BATCH_WINDOW_NAME,
    SIM_BATCH_URL_PATH
} = require('../html/widgets/sim_batch_builder/parent_bridge.js');
const {
    SIM_BATCH_CHANNEL: PROTO_CHANNEL
} = require('../html/widgets/sim_batch_builder/protocol.js');

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

test('protocol channel constants match', () => {
    assert.strictEqual(SIM_BATCH_CHANNEL, 'hunt-design-lab-sim-batch');
    assert.strictEqual(PROTO_CHANNEL, SIM_BATCH_CHANNEL);
    assert.strictEqual(SIM_BATCH_WINDOW_NAME, 'hunt_design_lab_sim_batch');
    assert.ok(SIM_BATCH_URL_PATH.indexOf('sim-batch-builder') >= 0);
    // Must not reuse Engine Tweakings channel
    assert.notStrictEqual(SIM_BATCH_CHANNEL, 'hunt-design-lab-tweaks');
});

test('normalizeSimBatchForm applies defaults', () => {
    const f = normalizeSimBatchForm({});
    assert.strictEqual(f.iterations, DEFAULT_SIM_BATCH_FORM.iterations);
    assert.strictEqual(f.seed, DEFAULT_SIM_BATCH_FORM.seed);
    assert.strictEqual(f.concurrency, DEFAULT_SIM_BATCH_FORM.concurrency);
    assert.strictEqual(f.huntId, 'cave_crawl_generated');
    assert.strictEqual(f.outDir, 'var/sim');
    assert.strictEqual(f.quiet, true);
    assert.strictEqual(f.frames, null);
    assert.strictEqual(f.maxKills, null);
    assert.strictEqual(f.members, null);
});

test('normalizeSimBatchForm coerces numbers and blanks', () => {
    const f = normalizeSimBatchForm({
        iterations: '25',
        seed: '7',
        concurrency: '4',
        huntId: ' catalog_crawl_generated ',
        outDir: ' var/sim/run1 ',
        frames: '',
        maxKills: '100',
        maxTicks: '500',
        quiet: false
    });
    assert.strictEqual(f.iterations, 25);
    assert.strictEqual(f.seed, 7);
    assert.strictEqual(f.concurrency, 4);
    assert.strictEqual(f.huntId, 'catalog_crawl_generated');
    assert.strictEqual(f.outDir, 'var/sim/run1');
    assert.strictEqual(f.frames, null);
    assert.strictEqual(f.maxKills, 100);
    assert.strictEqual(f.maxTicks, 500);
    assert.strictEqual(f.quiet, false);
});

test('buildSimBatchConfig core shape for batch_worker', () => {
    const cfg = buildSimBatchConfig({
        iterations: 10,
        seed: 1,
        concurrency: 2,
        huntId: 'cave_crawl_generated',
        outDir: 'var/sim/t',
        quiet: true
    });
    assert.deepStrictEqual(cfg, {
        iterations: 10,
        seed: 1,
        concurrency: 2,
        huntId: 'cave_crawl_generated',
        outDir: 'var/sim/t',
        quiet: true
    });
    assert.ok(!('members' in cfg));
    assert.ok(!('frames' in cfg));
});

test('buildSimBatchRunPayload maps to PHP sim_batch job', () => {
    const payload = buildSimBatchRunPayload({
        iterations: 5,
        seed: 3,
        concurrency: 2,
        huntId: 'catalog_crawl_generated',
        outDir: 'var/sim/web',
        frames: 1000,
        quiet: true
    });
    assert.strictEqual(payload.script, 'sim_batch');
    assert.strictEqual(payload.iterations, 5);
    assert.strictEqual(payload.seed, 3);
    assert.strictEqual(payload.concurrency, 2);
    assert.strictEqual(payload.huntId, 'catalog_crawl_generated');
    assert.strictEqual(payload.outDir, 'var/sim/web');
    assert.strictEqual(payload.frames, 1000);
    assert.strictEqual(payload.quiet, true);
    assert.ok(!('members' in payload));
});

test('buildSimBatchConfig includes optional limits', () => {
    const cfg = buildSimBatchConfig({
        iterations: 3,
        seed: 9,
        frames: 2000,
        maxKills: 50,
        maxTicks: 4000
    });
    assert.strictEqual(cfg.frames, 2000);
    assert.strictEqual(cfg.maxKills, 50);
    assert.strictEqual(cfg.maxTicks, 4000);
});

test('buildSimBatchConfig includes members from editor-shaped party', () => {
    const cfg = buildSimBatchConfig({
        iterations: 2,
        seed: 1,
        members: [
            {
                enabled: true,
                name: 'Tank',
                classId: 'guardian',
                strategyId: 'guardian_aggro',
                level: 50,
                isLeader: true,
                equipment: {}
            },
            {
                enabled: false,
                name: 'Skip',
                classId: 'scout',
                strategyId: 'scout_kite',
                level: 40,
                isLeader: false,
                equipment: {}
            }
        ]
    });
    assert.ok(Array.isArray(cfg.members));
    assert.strictEqual(cfg.members.length, 1);
    assert.strictEqual(cfg.members[0].name, 'Tank');
    assert.strictEqual(cfg.members[0].strategyId, 'guardian_aggro');
    assert.strictEqual(cfg.members[0].isLeader, true);
});

test('strategyOverride rewrites member strategies', () => {
    const members = buildMembersForConfig(
        normalizeSimBatchForm({
            strategyOverride: 'balanced',
            members: [
                {
                    enabled: true,
                    name: 'A',
                    classId: 'scout',
                    strategyId: 'scout_kite',
                    isLeader: true
                }
            ]
        })
    );
    assert.strictEqual(members[0].strategyId, 'balanced');
});

test('strategyOverride alone does not invent members', () => {
    const cfg = buildSimBatchConfig({
        strategyOverride: 'balanced',
        iterations: 1
    });
    assert.ok(!('members' in cfg));
});

test('formatSimBatchCliJson wraps compact JSON', () => {
    const cfg = buildSimBatchConfig({ iterations: 5, seed: 2 });
    const cli = formatSimBatchCliJson(cfg);
    assert.ok(cli.startsWith("npm run sim:batch -- '"));
    assert.ok(cli.indexOf('"iterations":5') >= 0);
    assert.ok(cli.indexOf('"seed":2') >= 0);
});

test('formatSimBatchCliFlags uses flags without members', () => {
    const cfg = buildSimBatchConfig({
        iterations: 10,
        seed: 42,
        concurrency: 4,
        huntId: 'cave_crawl_generated',
        outDir: 'var/sim',
        quiet: true
    });
    const cli = formatSimBatchCliFlags(cfg);
    assert.ok(cli.indexOf('--iterations 10') >= 0);
    assert.ok(cli.indexOf('--seed 42') >= 0);
    assert.ok(cli.indexOf('--concurrency 4') >= 0);
    assert.ok(cli.indexOf('--hunt cave_crawl_generated') >= 0);
    assert.ok(cli.indexOf('--out var/sim') >= 0);
    assert.ok(cli.indexOf('--quiet') >= 0);
});

test('formatSimBatchCliFlags falls back to JSON when members present', () => {
    const cfg = buildSimBatchConfig({
        iterations: 2,
        seed: 1,
        members: [
            {
                enabled: true,
                name: 'X',
                classId: 'guardian',
                strategyId: 'guardian_aggro',
                isLeader: true
            }
        ]
    });
    const cli = formatSimBatchCliFlags(cfg);
    assert.ok(cli.startsWith("npm run sim:batch -- '{"));
    assert.ok(cli.indexOf('members') >= 0);
});

test('isLargeBatch and hint', () => {
    assert.strictEqual(isLargeBatch(10), false);
    assert.strictEqual(isLargeBatch(LARGE_BATCH_ITERATIONS), false);
    assert.strictEqual(isLargeBatch(LARGE_BATCH_ITERATIONS + 1), true);
    const hint = formatLargeBatchHint({ iterations: 1000 });
    assert.ok(hint.indexOf('SIMULATION.sh') >= 0);
    assert.ok(hint.indexOf('1000') >= 0);
});

test('mergeSimBatchPrefill applies known keys only', () => {
    const base = normalizeSimBatchForm({});
    const merged = mergeSimBatchPrefill(base, {
        seed: 99,
        huntId: 'catalog_crawl_generated',
        unknown: 'nope',
        members: [{ enabled: true, name: 'L', classId: 'guardian', isLeader: true }]
    });
    assert.strictEqual(merged.seed, 99);
    assert.strictEqual(merged.huntId, 'catalog_crawl_generated');
    assert.ok(Array.isArray(merged.members));
    assert.strictEqual(merged.members[0].name, 'L');
    assert.ok(!('unknown' in merged));
});

test('shellQuote leaves safe tokens alone', () => {
    assert.strictEqual(shellQuote('var/sim'), 'var/sim');
    assert.strictEqual(shellQuote('cave_crawl_generated'), 'cave_crawl_generated');
    assert.ok(shellQuote("a b").indexOf("'") === 0);
});

test('FALLBACK_HUNT_IDS includes product I6 hunts', () => {
    assert.ok(FALLBACK_HUNT_IDS.indexOf('golden_cave_crawl') >= 0);
    assert.ok(FALLBACK_HUNT_IDS.indexOf('standard_arena_waves') >= 0);
});

test('listAnalysisRecipes re-exported from sim-batch-builder', () => {
    const recipes = listAnalysisRecipes();
    assert.ok(recipes.length >= 4);
    const cli = formatRecipeCli('band_pressure');
    assert.ok(cli.indexOf('sim:batch') >= 0);
});

if (failed > 0) {
    console.error(`sim_batch_builder: ${failed} failed, ${passed} passed`);
    process.exit(1);
}
console.log(`sim_batch_builder: ${passed} passed`);
