#!/usr/bin/env node
/**
 * A/B compare pre-parity (every-tick brain) vs product-default AI think cadence.
 *
 * Measures:
 *   - wall-clock loop speed (ms/hunt, effective UPS)
 *   - character/hunt performance (kills, damage, ticks, exp, deaths, end state)
 *
 * Usage:
 *   node scripts/compare_ai_cadence.js
 *   node scripts/compare_ai_cadence.js --iterations 8 --seed 42 --frames 6000
 */

'use strict';

const { Settings } = require('../kernel/settings.js');
const {
    runBatchSlice,
    DEFAULT_HUNT_MAX_FRAMES
} = require('../kernel/providers/simulator/headless_runner.js');

const CADENCE_KEYS = [
    'AI_GATE_BRAIN_ON_MOVE_DELAY',
    'AI_GATE_CREATURE_ON_MOVE_DELAY',
    'AI_THINK_PAD_SEC',
    'AI_ENGAGE_DECISION_INTERVAL',
    'AI_TARGET_RETARGET_DIST',
    'AI_TARGET_LOSE_DIST'
];

/** Pre-parity: think every logic tick, no pad, no sticky, no distance drop */
const PRE_PARITY = {
    AI_GATE_BRAIN_ON_MOVE_DELAY: false,
    AI_GATE_CREATURE_ON_MOVE_DELAY: false,
    AI_THINK_PAD_SEC: 0,
    AI_ENGAGE_DECISION_INTERVAL: 0,
    AI_TARGET_RETARGET_DIST: 0,
    AI_TARGET_LOSE_DIST: 0
};

/**
 * Product defaults (think gates + pad + sticky distances).
 * Not pure legacy: AI_TARGET_LOSE_DIST is 10 for hysteresis over engageRange 7
 * (legacy-style lose was often 7). Rename keeps A/B labels honest.
 */
const PRODUCT_DEFAULTS = {
    AI_GATE_BRAIN_ON_MOVE_DELAY: true,
    AI_GATE_CREATURE_ON_MOVE_DELAY: true,
    AI_THINK_PAD_SEC: 0.1,
    AI_ENGAGE_DECISION_INTERVAL: 0.25,
    AI_TARGET_RETARGET_DIST: 2,
    AI_TARGET_LOSE_DIST: 10
};

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
    const out = {
        iterations: 6,
        seed: 42,
        huntId: 'cave_crawl_generated',
        frames: Math.min(DEFAULT_HUNT_MAX_FRAMES || 8000, 6000),
        help: false
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '-h' || a === '--help') out.help = true;
        else if (a === '--iterations' || a === '-n')
            out.iterations = parseInt(argv[++i], 10);
        else if (a === '--seed' || a === '-s') out.seed = parseInt(argv[++i], 10);
        else if (a === '--hunt') out.huntId = argv[++i];
        else if (a === '--frames') out.frames = parseInt(argv[++i], 10);
    }
    return out;
}

function snapshotCadence() {
    const s = {};
    for (const k of CADENCE_KEYS) s[k] = Settings[k];
    return s;
}

function applyCadence(cfg) {
    for (const k of CADENCE_KEYS) {
        if (cfg[k] !== undefined) Settings[k] = cfg[k];
    }
}

/**
 * @param {object[]} summaries
 * @param {number} elapsedMs
 */
function aggregate(summaries, elapsedMs) {
    const n = summaries.length;
    const sum = (fn) => summaries.reduce((a, s) => a + (fn(s) || 0), 0);
    const mean = (fn) => (n ? sum(fn) / n : 0);
    const byState = {};
    for (const s of summaries) {
        const k = s.sessionState || 'unknown';
        byState[k] = (byState[k] || 0) + 1;
    }
    const totalTicks = sum((s) => s.tickCount);
    const seconds = elapsedMs / 1000;
    return {
        iterations: n,
        elapsedMs,
        msPerHunt: n ? elapsedMs / n : 0,
        effectiveUps: seconds > 0 ? totalTicks / seconds : 0,
        meanTicks: mean((s) => s.tickCount),
        meanKills: mean((s) => s.kills),
        meanDamageDealt: mean((s) => s.damageDealt),
        meanDamageTaken: mean((s) => s.damageTaken),
        meanExp: mean((s) => s.expGained),
        meanDeaths: mean((s) => s.deaths),
        meanHealing: mean((s) => s.healingDone),
        byState
    };
}

/**
 * @param {string} label
 * @param {object} cadence
 * @param {object} opts
 */
async function runArm(label, cadence, opts) {
    applyCadence(cadence);
    const started = Date.now();
    const summaries = await runBatchSlice(
        {
            seed: opts.seed,
            huntId: opts.huntId,
            frames: opts.frames,
            headless: true,
            quiet: true,
            writeFiles: false
        },
        0,
        opts.iterations
    );
    const elapsedMs = Date.now() - started;
    const metrics = aggregate(summaries, elapsedMs);
    return { label, cadence: Object.assign({}, cadence), metrics, summaries };
}

/**
 * @param {object} a metrics pre-parity
 * @param {object} b metrics legacy-like
 */
function deltaReport(a, b) {
    const pct = (oldV, newV) => {
        if (!oldV || !Number.isFinite(oldV)) return null;
        return ((newV - oldV) / oldV) * 100;
    };
    const rows = [
        ['msPerHunt', a.msPerHunt, b.msPerHunt],
        ['effectiveUps', a.effectiveUps, b.effectiveUps],
        ['meanTicks', a.meanTicks, b.meanTicks],
        ['meanKills', a.meanKills, b.meanKills],
        ['meanDamageDealt', a.meanDamageDealt, b.meanDamageDealt],
        ['meanDamageTaken', a.meanDamageTaken, b.meanDamageTaken],
        ['meanExp', a.meanExp, b.meanExp],
        ['meanDeaths', a.meanDeaths, b.meanDeaths]
    ];
    const out = {};
    for (const [k, av, bv] of rows) {
        out[k] = {
            preParity: av,
            legacyLike: bv,
            deltaPct: pct(av, bv)
        };
    }
    return out;
}

function fmt(n, d = 2) {
    if (n == null || !Number.isFinite(n)) return 'n/a';
    return Number(n).toFixed(d);
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
        console.log(`Compare AI think cadence arms.

  node scripts/compare_ai_cadence.js [--iterations N] [--seed S] [--hunt id] [--frames N]

Arms:
  pre_parity       — gates off, pad 0, engage every tick, no target distance drop
  product_defaults — current Settings defaults (brain on moveDelay, 0.1s pad,
                     AI_TARGET_LOSE_DIST=10 hysteresis; not pure legacy lose=7)
`);
        return;
    }

    const saved = snapshotCadence();
    let pre;
    let product;
    try {
        // Warm one short arm first so map/png load cost is less lopsided
        applyCadence(PRE_PARITY);
        await runBatchSlice(
            {
                seed: opts.seed,
                huntId: opts.huntId,
                frames: Math.min(200, opts.frames),
                headless: true,
                quiet: true,
                writeFiles: false
            },
            0,
            1
        );

        pre = await runArm('pre_parity', PRE_PARITY, opts);
        product = await runArm('product_defaults', PRODUCT_DEFAULTS, opts);
    } finally {
        applyCadence(saved);
    }

    const delta = deltaReport(pre.metrics, product.metrics);
    const report = {
        config: opts,
        pre_parity: pre.metrics,
        product_defaults: product.metrics,
        delta_product_vs_pre: delta,
        note:
            'positive deltaPct on effectiveUps / negative on msPerHunt = loop faster with cadence; ' +
            'kills/exp deltas show character performance change. ' +
            'product_defaults uses AI_TARGET_LOSE_DIST=10 (not pure-legacy 7).'
    };

    console.log(JSON.stringify(report, null, 2));
    console.log('\n── Summary ──');
    console.log(
        `iterations=${opts.iterations} hunt=${opts.huntId} seed=${opts.seed} frames≤${opts.frames}`
    );
    console.log(
        `Loop:  pre ${fmt(pre.metrics.msPerHunt)} ms/hunt @ ${fmt(pre.metrics.effectiveUps)} UPS  →  ` +
            `product ${fmt(product.metrics.msPerHunt)} ms/hunt @ ${fmt(product.metrics.effectiveUps)} UPS  ` +
            `(${fmt(delta.msPerHunt.deltaPct)}% ms/hunt, ${fmt(delta.effectiveUps.deltaPct)}% UPS)`
    );
    console.log(
        `Hunt:  pre kills=${fmt(pre.metrics.meanKills)} dmg=${fmt(pre.metrics.meanDamageDealt, 0)} ` +
            `taken=${fmt(pre.metrics.meanDamageTaken, 0)} ticks=${fmt(pre.metrics.meanTicks, 0)}  →  ` +
            `product kills=${fmt(product.metrics.meanKills)} dmg=${fmt(product.metrics.meanDamageDealt, 0)} ` +
            `taken=${fmt(product.metrics.meanDamageTaken, 0)} ticks=${fmt(product.metrics.meanTicks, 0)}`
    );
    console.log(
        `       kills Δ ${fmt(delta.meanKills.deltaPct)}% | dmg Δ ${fmt(delta.meanDamageDealt.deltaPct)}% | ` +
            `taken Δ ${fmt(delta.meanDamageTaken.deltaPct)}% | ticks Δ ${fmt(delta.meanTicks.deltaPct)}%`
    );
    console.log(
        'end states pre:',
        pre.metrics.byState,
        'product:',
        product.metrics.byState
    );
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
