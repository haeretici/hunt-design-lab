#!/usr/bin/env node
/**
 * Stage 11.7 — Biome packs (dual-mode cave + consistency).
 * Quiet on success; VERBOSE=1 for detail.
 */

'use strict';

const { hasMode, withMode } = require('./helpers/modes.js');

const assert = require('assert');
const {
    normalizeBiomeId,
    normalizeBiomePack,
    validateBiomeConsistency,
    resolveBiomePack,
    listBiomeIdsFromPacks,
    normalizePiecePack,
    normalizePopulation,
    normalizeMarkerRules,
    normalizeDungeonProfile,
    normalizeFixedProfile,
    generateOnce,
    assessGeneration,
    runDungeonTests
} = require('../kernel/core/lib/dungeon/index.js');
const {
    loadBiomePack,
    listBiomePackIds,
    loadPiecePack,
    loadPopulation,
    loadMarkerRules,
    loadDungeonProfile,
    listDungeonProfileIds,
    listPiecePackIds,
    expandHuntDefinition,
    loadJson
} = require('../kernel/core/lib/presets.js');
const { setActiveMode } = require('../kernel/core/lib/modes.js');
const { resolveHuntConfig } = require('../kernel/providers/simulator/headless_runner.js');

const VERBOSE = !!process.env.VERBOSE;

function log(...args) {
    if (VERBOSE) console.log(...args);
}

function loaders() {
    return {
        loadBiomePack,
        loadPiecePack,
        loadPopulation,
        loadMarkers: loadMarkerRules,
        loadDungeonProfile,
        normalizePiecePack,
        normalizePopulation,
        normalizeMarkerRules,
        normalizeDungeonProfile,
        normalizeFixedProfile
    };
}

function testNormalize() {
    assert.strictEqual(normalizeBiomeId('Cave'), 'cave');
    assert.strictEqual(normalizeBiomeId('  '), null);
    assert.strictEqual(normalizeBiomeId(null), null);

    const m = normalizeBiomePack({
        id: 'Cave',
        piecePack: 'cave_v1',
        populationId: 'cave_rats',
        markersId: 'cave_clickies',
        profiles: { procedural: ['small_crawl'], fixed: ['outskirts_camp'] }
    });
    assert.ok(m);
    assert.strictEqual(m.id, 'cave');
    assert.strictEqual(m.piecePack, 'cave_v1');
    assert.ok(m.profiles.indexOf('small_crawl') >= 0);
    assert.ok(m.profiles.indexOf('outskirts_camp') >= 0);
    assert.ok(m.proceduralProfiles.indexOf('small_crawl') >= 0);
    assert.ok(m.fixedProfiles.indexOf('outskirts_camp') >= 0);

    assert.strictEqual(normalizeBiomePack({}), null);
    log('normalize ok');
}

function testConsistency() {
    const ok = validateBiomeConsistency({
        biomeId: 'cave',
        piecePack: { biome: 'cave' },
        population: { biome: 'cave' },
        profile: { biome: 'cave', piecePack: 'cave_v1' },
        manifest: { id: 'cave', piecePack: 'cave_v1', populationId: 'cave_rats' }
    });
    assert.ok(ok.ok);
    assert.strictEqual(ok.errors.length, 0);

    // Stage 11.10: shared logic pieces across biomes → warning, not hard error
    const sharedPieces = validateBiomeConsistency({
        biomeId: 'cave',
        piecePack: { biome: 'crypt' },
        population: { biome: 'cave' },
        manifest: { id: 'cave', piecePack: 'cave_v1', populationId: 'x' }
    });
    assert.ok(sharedPieces.ok);
    assert.ok(
        sharedPieces.warnings.some((e) => e.indexOf('piece_pack_biome_mismatch') >= 0)
    );

    // Population biome mismatch remains a hard error
    const badPop = validateBiomeConsistency({
        biomeId: 'cave',
        piecePack: { biome: 'cave' },
        population: { biome: 'crypt' },
        manifest: { id: 'cave', piecePack: 'cave_v1', populationId: 'x' }
    });
    assert.ok(!badPop.ok);
    assert.ok(
        badPop.errors.some((e) => e.indexOf('population_biome_mismatch') >= 0)
    );
    log('consistency ok');
}

function testStandardCavePack() {
    setActiveMode('standard');
    const ids = listBiomePackIds();
    assert.ok(ids.indexOf('cave') >= 0, 'standard cave biome listed');

    const resolved = resolveBiomePack('cave', loaders());
    assert.ok(resolved.ok, resolved.consistency.errors.join('; '));
    assert.strictEqual(resolved.biome.id, 'cave');
    assert.ok(resolved.piecePack);
    assert.strictEqual(resolved.piecePack.biome, 'cave');
    assert.ok(resolved.population);
    assert.strictEqual(resolved.population.biome, 'cave');
    assert.ok(resolved.profiles.small_crawl);
    assert.ok(resolved.profiles.outskirts_camp);
    assert.strictEqual(resolved.profiles.small_crawl.biome, 'cave');
    assert.strictEqual(resolved.profiles.outskirts_camp.biome, 'cave');

    const fromPacks = listBiomeIdsFromPacks([
        normalizePiecePack(loadPiecePack('cave_v1'))
    ]);
    assert.ok(fromPacks.indexOf('cave') >= 0);

    log('standard cave pack ok', {
        profiles: Object.keys(resolved.profiles),
        pieces: resolved.piecePack.pieces.length
    });
}

function testLegacyCavePack() {
    if (!hasMode('legacy')) return;
    setActiveMode('legacy');
    assert.ok(listBiomePackIds().indexOf('cave') >= 0);
    assert.ok(listPiecePackIds().indexOf('cave_v1') >= 0);
    assert.ok(listDungeonProfileIds().indexOf('small_crawl') >= 0);
    assert.ok(listDungeonProfileIds().indexOf('outskirts_camp') >= 0);

    const resolved = resolveBiomePack('cave', loaders());
    assert.ok(resolved.ok, resolved.consistency.errors.join('; '));
    assert.strictEqual(resolved.piecePack.biome, 'cave');

    // Generate procedural under legacy
    const profile = loadDungeonProfile('small_crawl');
    const pack = normalizePiecePack(loadPiecePack(profile.piecePack));
    const gen = generateOnce({
        profile,
        pack,
        seed: 42,
        layoutType: 'procedural'
    });
    assert.ok(gen.ok, gen.error && gen.error.message);

    const a = assessGeneration(gen, {
        layoutType: 'procedural',
        population: loadPopulation(profile.populationId),
        markerRules: loadMarkerRules(profile.markersId),
        pacingBudget: profile.pacingBudget,
        checkPopulation: true,
        checkPacing: true
    });
    assert.ok(a.successful, a.errorLog.join('; '));

    // Fixed under legacy
    const fixedP = loadDungeonProfile('outskirts_camp');
    const genF = generateOnce({
        profile: fixedP,
        pack,
        seed: 7,
        layoutType: 'fixed',
        loadPopulation,
        population: loadPopulation(fixedP.populationId)
    });
    assert.ok(genF.ok, genF.error && genF.error.message);
    const aF = assessGeneration(genF, {
        layoutType: 'fixed',
        population: loadPopulation(fixedP.populationId),
        markerRules: loadMarkerRules(fixedP.markersId),
        checkPopulation: true,
        checkPacing: false
    });
    assert.ok(aF.successful, aF.errorLog.join('; '));

    log('legacy cave pack ok', {
        procPieces: gen.result && gen.result.meta && gen.result.meta.pieceCount,
        fixedOk: aF.successful
    });
}

function testLegacyHuntExpand() {
    if (!hasMode('legacy')) return;
    setActiveMode('legacy');
    const hunt = loadJson('hunts/cave_crawl_generated.json');
    const expanded = expandHuntDefinition(hunt, { seed: 42 });
    assert.ok(expanded.floorFriction, 'floorFriction present');
    assert.ok(Array.isArray(expanded.spawns) && expanded.spawns.length >= 1);
    assert.ok(expanded.layoutMeta && expanded.layoutMeta.reason === 'ok');

    const resolved = resolveHuntConfig({
        huntId: 'cave_crawl_generated',
        seed: 42
    });
    assert.ok(resolved.floorLayers);
    assert.ok(resolved.spawns.length >= 1);

    const fixed = expandHuntDefinition(
        loadJson('hunts/outskirts_camp_fixed.json'),
        { seed: 7 }
    );
    assert.ok(fixed.floorFriction);
    assert.ok(fixed.layoutMeta && fixed.layoutMeta.reason === 'ok');

    log('legacy hunt expand ok', {
        procSpawns: expanded.spawns.length,
        fixedCols: fixed.floorFriction.cols
    });
}

function testDualModeStressSmoke() {
    const L = {
        loadDungeonProfile,
        loadPiecePack,
        loadPopulation,
        loadMarkers: loadMarkerRules
    };

    let legacyPassed = null;
    if (hasMode('legacy')) {
        setActiveMode('legacy');
        const report = runDungeonTests({
            profileId: 'small_crawl',
            iterations: 20,
            seedStart: 1000,
            failRateThreshold: 0.15,
            checkPopulation: true,
            checkPacing: true,
            maxFailSamples: 5,
            ...L
        });
        assert.strictEqual(report.iterations, 20);
        assert.ok(
            report.successful,
            `legacy failRate=${report.failureRate} codes=${JSON.stringify(report.errorCodes)} sample=${JSON.stringify(report.errorLog[0] || null)}`
        );
        assert.ok(report.passed >= 17, `legacy passed ${report.passed}/20`);
        legacyPassed = report.passed;
    }

    setActiveMode('standard');
    const reportS = runDungeonTests({
        profileId: 'small_crawl',
        iterations: 20,
        seedStart: 1000,
        failRateThreshold: 0.15,
        checkPopulation: true,
        checkPacing: true,
        maxFailSamples: 5,
        ...L
    });
    assert.ok(
        reportS.successful,
        `standard failRate=${reportS.failureRate} codes=${JSON.stringify(reportS.errorCodes)}`
    );
    assert.ok(reportS.passed >= 17, `standard passed ${reportS.passed}/20`);

    log('dual-mode stress smoke ok', {
        legacy: legacyPassed,
        standard: reportS.passed
    });
}

function main() {
    testNormalize();
    testConsistency();
    testStandardCavePack();
    testLegacyCavePack();
    testLegacyHuntExpand();
    testDualModeStressSmoke();
    console.log('dungeon_biome: ok');
}

main();
