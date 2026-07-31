#!/usr/bin/env node
/**
 * Stage 11.0 — Pacing foundation (Blueprint Phase 1, metrics only).
 * - normalizeBudget / buildPacingMetrics / evaluatePacing
 * - headless summary includes pacing fields
 * - standard + legacy hunts declare budgets and report evaluation
 * - seed-stable core still holds (includes pacingEvents)
 * Quiet on success; VERBOSE=1 for detail.
 */

'use strict';

const { hasMode } = require('./helpers/modes.js');

const assert = require('assert');
const {
    normalizeBudget,
    buildPacingMetrics,
    evaluatePacing,
    pacingTagFromEntity
} = require('../kernel/core/lib/dungeon/pacing.js');
const {
    createEmptyHuntTelemetry,
    samplePacingEvent,
    sampleBiomeTransition,
    sampleCombatTouch,
    sampleKill,
    buildHuntSummary,
    summaryCore,
    stableStringify
} = require('../kernel/core/lib/telemetry.js');
const {
    runHeadlessHunt,
    resolveHuntConfig
} = require('../kernel/providers/simulator/headless_runner.js');
const { setActiveMode } = require('../kernel/core/lib/modes.js');

const VERBOSE = !!process.env.VERBOSE;

function log(...args) {
    if (VERBOSE) console.log(...args);
}

function testNormalizeAndEvaluateUnit() {
    const budget = normalizeBudget({
        id: 'unit',
        micro: {
            targetGapSec: 20,
            warnGapSec: 30,
            maxGapSec: 50
        },
        mid: { minKills: 2, maxKills: 10, minChampions: 0, maxChampions: 1 },
        session: { minTimeSec: 5, maxTimeSec: 120, minKillsPerMin: 1 }
    });
    assert.strictEqual(budget.id, 'unit');
    assert.strictEqual(budget.micro.targetGapSec, 20);

    const metrics = buildPacingMetrics({
        events: [
            { t: 2, kind: 'combat' },
            { t: 10, kind: 'kill', tag: 'champion' },
            { t: 18, kind: 'combat' },
            { t: 28, kind: 'kill' }
        ],
        timeSec: 32,
        kills: 2
    });
    assert.strictEqual(metrics.combatEventCount, 2);
    assert.strictEqual(metrics.killEventCount, 2);
    assert.strictEqual(metrics.midCounts.champion, 1);
    assert.ok(metrics.meanGapSec != null);
    assert.ok(metrics.longestIdleSec >= 0);
    assert.ok(metrics.killsPerMinute > 0);

    const pass = evaluatePacing(
        { kills: 2, timeToClear: 32, pacing: { metrics } },
        budget
    );
    assert.strictEqual(
        pass.status,
        'pass',
        JSON.stringify(pass.checks, null, 2)
    );
    assert.ok(pass.checks.length >= 1);

    const failDense = evaluatePacing(
        {
            kills: 0,
            timeToClear: 100,
            pacing: {
                metrics: buildPacingMetrics({
                    events: [],
                    timeSec: 100,
                    kills: 0
                })
            }
        },
        budget
    );
    assert.strictEqual(failDense.status, 'fail');

    const skipped = evaluatePacing({ kills: 1 }, null);
    assert.strictEqual(skipped.status, 'skipped');

    assert.strictEqual(pacingTagFromEntity({ rarity: 'Elite' }), 'elite');
    assert.strictEqual(pacingTagFromEntity({ affixes: ['champion'] }), 'champion');
    assert.strictEqual(pacingTagFromEntity({ isBoss: true }), 'boss');
    assert.strictEqual(pacingTagFromEntity({}), null);

    log('unit normalize/evaluate ok', { status: pass.status, checks: pass.checks.length });
}

function testTelemetryPacingInSummary() {
    const t = createEmptyHuntTelemetry();
    assert.ok(Array.isArray(t.events));
    assert.ok(t.combatTouchedIds instanceof Set);

    sampleCombatTouch(t, 1, 1.0, null);
    sampleCombatTouch(t, 1, 1.5, null); // dedupe
    sampleKill(t, 10, 0);
    samplePacingEvent(t, { kind: 'kill', t: 3.0, tag: null, entityId: 1 });
    sampleCombatTouch(t, 2, 12.0, 'champion');
    samplePacingEvent(t, { kind: 'kill', t: 14.0, tag: 'champion', entityId: 2 });

    assert.strictEqual(t.events.filter((e) => e.kind === 'combat').length, 2);

    const summary = buildHuntSummary({
        telemetry: t,
        seed: 1,
        huntId: 'unit',
        floor: 7,
        tickCount: 400,
        sessionState: 'route_complete',
        routeComplete: true,
        timeSinceLevelLoad: 20,
        pacingBudget: {
            id: 'unit_budget',
            micro: { targetGapSec: 20, warnGapSec: 40, maxGapSec: 80 },
            mid: { minKills: 1, maxKills: 5 },
            session: { minTimeSec: 1, maxTimeSec: 60 }
        }
    });

    assert.ok(summary.pacing);
    assert.ok(summary.pacing.metrics);
    assert.ok(Array.isArray(summary.pacing.events));
    assert.strictEqual(summary.pacing.events.length, 4);
    assert.strictEqual(summary.pacing.budget.id, 'unit_budget');
    assert.ok(
        summary.pacing.evaluation.status === 'pass' ||
            summary.pacing.evaluation.status === 'warn' ||
            summary.pacing.evaluation.status === 'fail'
    );
    assert.ok(Array.isArray(summary.pacing.evaluation.checks));

    const core = summaryCore(summary);
    assert.ok(Array.isArray(core.pacingEvents));
    assert.strictEqual(core.pacingEvents.length, 4);
    assert.ok(!('evaluation' in core));

    log('telemetry pacing summary ok', {
        status: summary.pacing.evaluation.status,
        killsPerMin: summary.pacing.metrics.killsPerMinute
    });
}

function testResolveBudgetFromHunt() {
    setActiveMode('standard');
    const r = resolveHuntConfig({ seed: 1, huntId: 'cave_crawl_generated' });
    assert.ok(r.pacingBudget, 'standard hunt should declare pacingBudget');
    assert.strictEqual(r.pacingBudget.id, 'small_crawl_micro');
    assert.ok(r.pacingBudget.micro.targetGapSec === 20);

    // Runner override wins
    const over = resolveHuntConfig({
        seed: 1,
        huntId: 'cave_crawl_generated',
        pacingBudget: { id: 'override', session: { maxTimeSec: 10 } }
    });
    assert.strictEqual(over.pacingBudget.id, 'override');
    assert.strictEqual(over.pacingBudget.session.maxTimeSec, 10);

    log('resolve budget ok');
}

async function testStandardHuntPacing() {
    setActiveMode('standard');
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

    assert.ok(a.pacing, 'summary.pacing required');
    assert.ok(a.pacing.metrics);
    assert.ok(a.pacing.budget);
    assert.strictEqual(a.pacing.budget.id, 'small_crawl_micro');
    assert.ok(a.pacing.evaluation);
    assert.ok(
        ['pass', 'warn', 'fail', 'skipped'].indexOf(a.pacing.evaluation.status) >=
            0
    );

    // Same seed ⇒ same summary core (combat + pacingEvents)
    assert.strictEqual(
        stableStringify(summaryCore(a)),
        stableStringify(summaryCore(b)),
        'same seed ⇒ same summary core with pacingEvents'
    );
    assert.strictEqual(a.kills, b.kills);
    assert.strictEqual(a.damageDealt, b.damageDealt);

    // Should have sampled some combat/kill events when kills happened
    if (a.kills > 0) {
        assert.ok(
            a.pacing.events.some((e) => e.kind === 'kill' || e.kind === 'combat'),
            'expected combat or kill pacing events when kills > 0'
        );
        assert.ok(a.pacing.metrics.killsPerMinute >= 0);
    }

    log('standard hunt pacing ok', {
        state: a.sessionState,
        kills: a.kills,
        events: a.pacing.events.length,
        eval: a.pacing.evaluation.status,
        longestIdle: a.pacing.metrics.longestIdleSec
    });
}

async function testLegacyHuntPacing() {
    if (!hasMode('legacy')) return;
    setActiveMode('legacy');
    try {
        // Generator-owned legacy path (bulk dens corridor retired once bars matched).
        const r = resolveHuntConfig({
            seed: 7,
            huntId: 'cave_crawl_generated',
            maxSeconds: 30
        });
        assert.ok(r.pacingBudget, 'legacy generated hunt should declare pacingBudget');
        assert.strictEqual(r.pacingBudget.id, 'small_crawl_legacy_micro');

        const summary = await runHeadlessHunt({
            seed: 7,
            huntId: 'cave_crawl_generated',
            frames: 4000,
            maxSeconds: 30
        });

        assert.ok(summary.pacing);
        assert.ok(summary.pacing.budget);
        assert.strictEqual(
            summary.pacing.budget.id,
            'small_crawl_legacy_micro'
        );
        assert.ok(summary.pacing.evaluation);
        assert.ok(
            ['pass', 'warn', 'fail', 'skipped'].indexOf(
                summary.pacing.evaluation.status
            ) >= 0
        );
        assert.ok(typeof summary.pacing.metrics.longestIdleSec === 'number');
        assert.ok(Array.isArray(summary.pacing.evaluation.checks));

        log('legacy hunt pacing ok', {
            state: summary.sessionState,
            kills: summary.kills,
            events: summary.pacing.events.length,
            eval: summary.pacing.evaluation.status
        });
    } finally {
        setActiveMode('standard');
    }
}

/**
 * Stage 11.10: runtime biome_transition samples feed macro metrics.
 */
function testBiomeTransitionTelemetry() {
    const t = createEmptyHuntTelemetry();
    sampleBiomeTransition(t, {
        t: 12.5,
        fromBiomeId: 'cave',
        toBiomeId: 'crypt',
        fromArtSet: 'cave',
        toArtSet: 'crypt',
        fromZ: 0,
        toZ: 1,
        fromSegment: 0,
        toSegment: 1,
        entityId: 7
    });
    assert.strictEqual(t.events.length, 1);
    assert.strictEqual(t.events[0].kind, 'biome_transition');
    assert.strictEqual(t.events[0].fromBiomeId, 'cave');
    assert.strictEqual(t.events[0].toBiomeId, 'crypt');
    assert.strictEqual(t.events[0].fromArtSet, 'cave');
    assert.strictEqual(t.events[0].toArtSet, 'crypt');
    assert.strictEqual(t.events[0].fromZ, 0);
    assert.strictEqual(t.events[0].toZ, 1);

    const metrics = buildPacingMetrics({
        events: t.events,
        timeSec: 30,
        kills: 0
    });
    assert.strictEqual(metrics.biomeTransitionCount, 1);
    assert.strictEqual(metrics.biomeTransitions.length, 1);
    assert.strictEqual(metrics.biomeTransitions[0].toBiomeId, 'crypt');

    // Two transitions → runtime gap feeds segmentSec evaluation
    sampleBiomeTransition(t, {
        t: 920,
        fromBiomeId: 'crypt',
        toBiomeId: 'swamp',
        fromArtSet: 'crypt',
        toArtSet: 'swamp',
        fromZ: 1,
        toZ: 2
    });
    const metrics2 = buildPacingMetrics({
        events: t.events,
        timeSec: 1000,
        kills: 0
    });
    assert.strictEqual(metrics2.biomeTransitionCount, 2);
    assert.strictEqual(metrics2.biomeGapsSec.length, 1);
    assert.ok(Math.abs(metrics2.biomeGapsSec[0] - (920 - 12.5)) < 0.01);

    const summary = buildHuntSummary({
        telemetry: t,
        seed: 1,
        timeSinceLevelLoad: 1000,
        tickCount: 20000,
        sessionState: 'route_complete',
        pacingBudget: {
            id: 'macro_rt',
            macro: {
                minTransitions: 1,
                minBiomes: 2,
                minArtSets: 2,
                targetSegmentSec: 900
            }
        },
        layoutMeta: {
            macro: {
                segments: [
                    { targetMinSec: 900, biomeId: 'cave', artSet: 'cave' },
                    { targetMinSec: 900, biomeId: 'crypt', artSet: 'crypt' },
                    { targetMinSec: 900, biomeId: 'swamp', artSet: 'swamp' }
                ],
                transitions: [{}, {}],
                biomeIds: ['cave', 'crypt', 'swamp'],
                artSets: ['cave', 'crypt', 'swamp']
            }
        }
    });
    assert.ok(summary.layoutMeta);
    assert.ok(summary.pacing.events.some((e) => e.kind === 'biome_transition'));
    const firstBt = summary.pacing.events.find(
        (e) => e.kind === 'biome_transition'
    );
    assert.strictEqual(firstBt.fromBiomeId, 'cave');
    assert.strictEqual(firstBt.toBiomeId, 'crypt');
    assert.ok(summary.pacing.metrics.biomeTransitionCount >= 2);
    assert.ok(summary.pacing.metrics.macro);
    assert.ok(summary.pacing.metrics.macro.runtimeTransitionCount >= 2);
    assert.ok(
        summary.pacing.metrics.macro.meanRuntimeGapSec != null,
        'runtime gaps preferred for segmentSec'
    );

    const core = summaryCore(summary);
    const coreBt = core.pacingEvents.find((e) => e.kind === 'biome_transition');
    assert.ok(coreBt);
    assert.strictEqual(coreBt.fromBiomeId, 'cave');
    assert.strictEqual(coreBt.toBiomeId, 'crypt');

    log('biome_transition telemetry ok', {
        count: summary.pacing.metrics.biomeTransitionCount,
        meanGap: summary.pacing.metrics.macro.meanRuntimeGapSec
    });
}

async function main() {
    let failed = 0;
    const tests = [
        ['normalizeAndEvaluateUnit', testNormalizeAndEvaluateUnit],
        ['telemetryPacingInSummary', testTelemetryPacingInSummary],
        ['biomeTransitionTelemetry', testBiomeTransitionTelemetry],
        ['resolveBudgetFromHunt', testResolveBudgetFromHunt],
        ['standardHuntPacing', testStandardHuntPacing],
        ['legacyHuntPacing', testLegacyHuntPacing]
    ];

    for (let i = 0; i < tests.length; i++) {
        const name = tests[i][0];
        const fn = tests[i][1];
        try {
            await fn();
        } catch (err) {
            failed += 1;
            console.error('FAIL', name);
            console.error(err && err.stack ? err.stack : err);
        }
    }

    if (failed) {
        console.error(`pacing: ${failed} failed`);
        process.exit(1);
    }
    console.log('pacing: ok');
}

main().catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
});
