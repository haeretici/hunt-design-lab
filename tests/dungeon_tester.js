#!/usr/bin/env node
/**
 * Stage 11.6 — Generator stress tester.
 * - detect layout type; assessGeneration Successful flag
 * - runDungeonTests on procedural + fixed profiles (CI-scale iters)
 * - failure sampling + threshold
 * Quiet on success; VERBOSE=1 for detail.
 */

'use strict';

const assert = require('assert');
const {
    detectLayoutType,
    generateOnce,
    assessGeneration,
    runDungeonTests,
    formatErrorLog,
    DEFAULT_CI_ITERATIONS
} = require('../kernel/core/lib/dungeon/tester.js');
const {
    loadDungeonProfile,
    loadPiecePack,
    loadPopulation,
    loadMarkerRules,
    listDungeonProfileIds
} = require('../kernel/core/lib/presets.js');
const { setActiveMode } = require('../kernel/core/lib/modes.js');
const { normalizePiecePack } = require('../kernel/core/lib/dungeon/pieces.js');

const VERBOSE = !!process.env.VERBOSE;

function log(...args) {
    if (VERBOSE) console.log(...args);
}

function loaders() {
    return {
        loadDungeonProfile,
        loadPiecePack,
        loadPopulation,
        loadMarkers: loadMarkerRules
    };
}

function testDetectLayoutType() {
    setActiveMode('standard');
    const proc = loadDungeonProfile('small_crawl');
    assert.strictEqual(detectLayoutType(proc), 'procedural');
    const fixed = loadDungeonProfile('outskirts_camp');
    assert.strictEqual(detectLayoutType(fixed), 'fixed');
    assert.strictEqual(detectLayoutType(null), null);
    assert.strictEqual(detectLayoutType({ type: 'proc' }), 'procedural');
    log('detectLayoutType ok');
}

function testAssessSuccessfulProcedural() {
    setActiveMode('standard');
    const profile = loadDungeonProfile('small_crawl');
    const pack = normalizePiecePack(loadPiecePack(profile.piecePack));
    const gen = generateOnce({ profile, pack, seed: 42, layoutType: 'procedural' });
    assert.ok(gen.ok, gen.error && gen.error.message);

    const pop = loadPopulation(profile.populationId);
    const markers = loadMarkerRules(profile.markersId);
    // Marker pool min (6 for A) may exceed piece marker sockets on a small crawl —
    // assess with pacing off first for pure layout Successful.
    const layoutOnly = assessGeneration(gen, {
        layoutType: 'procedural',
        population: pop,
        markerRules: markers,
        pacingBudget: profile.pacingBudget,
        checkPopulation: true,
        checkPacing: false
    });
    assert.strictEqual(layoutOnly.Successful, layoutOnly.successful);
    assert.ok(layoutOnly.successful, layoutOnly.errorLog.join('; '));
    assert.ok(layoutOnly.checks.some((c) => c.code === 'connectivity' && c.ok));
    assert.ok(layoutOnly.checks.some((c) => c.code === 'rule_completion' && c.ok));

    const lines = formatErrorLog(42, []);
    assert.ok(lines[0].indexOf('Successful') >= 0);

    log('assess procedural ok', layoutOnly.stats);
}

function testAssessFixed() {
    setActiveMode('standard');
    const profile = loadDungeonProfile('outskirts_camp');
    const pack = normalizePiecePack(loadPiecePack(profile.piecePack));
    const gen = generateOnce({
        profile,
        pack,
        seed: 7,
        layoutType: 'fixed',
        loadPopulation,
        population: loadPopulation(profile.populationId)
    });
    assert.ok(gen.ok, gen.error && gen.error.message);

    // Fixed profile has few marker sockets in cutout; skip pacing min-pool check
    const a = assessGeneration(gen, {
        layoutType: 'fixed',
        population: loadPopulation(profile.populationId),
        markerRules: loadMarkerRules(profile.markersId),
        pacingBudget: profile.pacingBudget,
        checkPopulation: true,
        checkPacing: false
    });
    assert.ok(a.successful, a.errorLog.join('; '));
    assert.ok(a.checks.some((c) => c.code === 'connectivity' && c.ok));

    log('assess fixed ok', a.stats);
}

function testRunProceduralStress() {
    setActiveMode('standard');
    const ids = listDungeonProfileIds();
    assert.ok(ids.indexOf('small_crawl') >= 0);

    const report = runDungeonTests({
        profileId: 'small_crawl',
        iterations: 48,
        seedStart: 1,
        failRateThreshold: 0.05,
        checkPopulation: true,
        // Marker pool authored for hand corridor; small crawl sockets are fewer
        checkPacing: false,
        maxFailSamples: 10,
        ...loaders()
    });

    assert.strictEqual(report.profileId, 'small_crawl');
    assert.strictEqual(report.layoutType, 'procedural');
    assert.strictEqual(report.iterations, 48);
    assert.ok(report.passed + report.failed === 48);
    assert.ok(
        report.successful,
        `failureRate=${report.failureRate} codes=${JSON.stringify(report.errorCodes)} sample=${JSON.stringify(report.errorLog[0] || null)}`
    );
    assert.ok(report.passed >= 45, `expected most seeds ok, got ${report.passed}/48`);
    assert.ok(typeof report.durationMs === 'number');
    assert.ok(report.stats && report.stats.samples > 0);

    // Seed-stable: same seedStart ⇒ same pass/fail pattern
    const report2 = runDungeonTests({
        profileId: 'small_crawl',
        iterations: 8,
        seedStart: 1,
        failRateThreshold: 1,
        checkPacing: false,
        ...loaders()
    });
    const report3 = runDungeonTests({
        profileId: 'small_crawl',
        iterations: 8,
        seedStart: 1,
        failRateThreshold: 1,
        checkPacing: false,
        ...loaders()
    });
    assert.strictEqual(report2.passed, report3.passed);
    assert.strictEqual(report2.failed, report3.failed);

    log('procedural stress ok', {
        passed: report.passed,
        failed: report.failed,
        rate: report.failureRate,
        rps: report.runsPerSec
    });
}

function testRunFixedStress() {
    setActiveMode('standard');
    const report = runDungeonTests({
        profileId: 'outskirts_camp',
        iterations: 32,
        seedStart: 10,
        failRateThreshold: 0,
        checkPopulation: true,
        checkPacing: false,
        ...loaders()
    });
    assert.strictEqual(report.layoutType, 'fixed');
    assert.ok(
        report.successful,
        `fixed fail rate ${report.failureRate} ${JSON.stringify(report.errorCodes)}`
    );
    assert.strictEqual(report.passed, 32);

    log('fixed stress ok', {
        passed: report.passed,
        failed: report.failed
    });
}

function testFailureDetection() {
    setActiveMode('standard');
    // Impossible tags → all generations fail
    const pack = normalizePiecePack(loadPiecePack('cave_v1'));
    const badProfile = {
        id: 'bad_tags_test',
        piecePack: 'cave_v1',
        maxAttempts: 2,
        maxPieces: 6,
        rules: [
            { op: 'AddHub', tags: ['hub'], count: 1 },
            { op: 'AddRoom', tags: ['no_such_tag_xyz_zzz'], count: 4 },
            { op: 'AddExit', count: 1 }
        ]
    };

    const report = runDungeonTests({
        profile: badProfile,
        pack,
        iterations: 5,
        seedStart: 1,
        failRateThreshold: 0,
        checkPopulation: false,
        checkPacing: false
    });
    assert.strictEqual(report.successful, false);
    assert.strictEqual(report.Successful, false);
    assert.strictEqual(report.failed, 5);
    assert.ok(report.errorLog.length >= 1);
    assert.ok(Object.keys(report.errorCodes).length >= 1);

    // Threshold allows some failures
    const soft = runDungeonTests({
        profile: badProfile,
        pack,
        iterations: 5,
        seedStart: 1,
        failRateThreshold: 1,
        checkPopulation: false,
        checkPacing: false
    });
    assert.strictEqual(soft.successful, true);
    assert.strictEqual(soft.failed, 5);

    log('failure detection ok', report.errorCodes);
}

function testMissingProfile() {
    setActiveMode('standard');
    const report = runDungeonTests({
        profileId: 'does_not_exist_xyz',
        iterations: 3,
        ...loaders()
    });
    assert.strictEqual(report.successful, false);
    assert.ok(report.errorCodes.missing_profile || report.failed >= 1);
    log('missing profile ok');
}

function testCiDefaults() {
    assert.ok(DEFAULT_CI_ITERATIONS >= 100);
    setActiveMode('standard');
    // Smoke: default CI count would be slow if we used it fully; use explicit small n
    const report = runDungeonTests({
        profileId: 'small_crawl',
        iterations: 12,
        checkPacing: false,
        failRateThreshold: 0.1,
        ...loaders()
    });
    assert.ok('Successful' in report);
    assert.ok(Array.isArray(report.errorLogLines));
    log('ci shape ok', { Successful: report.Successful });
}

function main() {
    testDetectLayoutType();
    testAssessSuccessfulProcedural();
    testAssessFixed();
    testRunProceduralStress();
    testRunFixedStress();
    testFailureDetection();
    testMissingProfile();
    testCiDefaults();
    console.log('dungeon_tester: ok');
}

main();
