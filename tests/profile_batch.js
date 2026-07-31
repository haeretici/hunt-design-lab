#!/usr/bin/env node
/**
 * Stage 12A: profile_batch report shape + short sequential smoke.
 * Quiet on success; VERBOSE=1 for detail.
 */

'use strict';

const assert = require('assert');
const {
    buildProfileReport,
    runProfileBatch,
    DEFAULT
} = require('../scripts/profile_batch.js');

const VERBOSE = !!process.env.VERBOSE;

function log(...args) {
    if (VERBOSE) console.log(...args);
}

function testBuildProfileReportShape() {
    const report = buildProfileReport({
        elapsedMs: 2000,
        summaries: [{ tickCount: 100 }, { tickCount: 300 }],
        config: { huntId: 'cave_crawl_generated', seed: 42, frames: 8000 }
    });
    assert.strictEqual(report.elapsedMs, 2000);
    assert.strictEqual(report.iterations, 2);
    assert.strictEqual(report.totalTicks, 400);
    assert.strictEqual(report.avgTicksPerHunt, 200);
    assert.strictEqual(report.msPerHunt, 1000);
    assert.strictEqual(report.effectiveUps, 200);
    assert.strictEqual(report.huntId, 'cave_crawl_generated');
    assert.strictEqual(report.seed, 42);
    assert.ok(typeof report.frames === 'number');
    log('buildProfileReport shape ok', report);
}

function testBuildProfileReportEmpty() {
    const report = buildProfileReport({
        elapsedMs: 0,
        summaries: [],
        config: {}
    });
    assert.strictEqual(report.iterations, 0);
    assert.strictEqual(report.effectiveUps, 0);
    assert.strictEqual(report.msPerHunt, 0);
    assert.strictEqual(report.totalTicks, 0);
    log('empty profile report ok');
}

async function testRunProfileBatchSmoke() {
    const report = await runProfileBatch({
        iterations: 2,
        seed: 7,
        huntId: 'cave_crawl_generated',
        // Keep smoke fast: short safety cap, still exercises real hunts.
        frames: 400,
        writeFiles: false
    });
    assert.strictEqual(report.iterations, 2);
    assert.ok(report.elapsedMs >= 0);
    assert.ok(report.totalTicks >= 0);
    assert.ok(Number.isFinite(report.effectiveUps));
    assert.ok(Number.isFinite(report.msPerHunt));
    assert.strictEqual(report.huntId, 'cave_crawl_generated');
    assert.strictEqual(report.seed, 7);
    assert.ok(report.avgTicksPerHunt >= 0);
    // Defaults still export sensible profile knobs.
    assert.strictEqual(DEFAULT.concurrency, 1);
    assert.strictEqual(DEFAULT.writeFiles, false);
    log('runProfileBatch smoke ok', report);
}

async function main() {
    testBuildProfileReportShape();
    testBuildProfileReportEmpty();
    await testRunProfileBatchSmoke();
    if (VERBOSE) console.log('profile_batch tests ok');
}

main().catch((err) => {
    console.error('profile_batch tests FAILED:', err);
    process.exit(1);
});
