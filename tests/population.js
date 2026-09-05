#!/usr/bin/env node
/**
 * Stage 11.1 — Dynamic population tables (Blueprint Phase 4, monsters).
 * - normalizePopulation / resolvePopulation unit tests
 * - same seed ⇒ same spawn set; champion min/max enforced
 * - explicit spawns win over population
 * - standard + legacy hunts resolve through population
 * Quiet on success; VERBOSE=1 for detail.
 */

'use strict';

const { hasMode } = require('./helpers/modes.js');

const assert = require('assert');
const {
    normalizePopulation,
    resolvePopulation,
    sampleSlotsAlongWaypoints,
    huntHasPopulation,
    huntHasExplicitSpawns
} = require('../kernel/core/lib/dungeon/population.js');
const {
    loadPopulation,
    listPopulationIds,
    loadCreatureTemplate,
    expandHuntDefinition
} = require('../kernel/core/lib/presets.js');
const {
    runHeadlessHunt,
    resolveHuntConfig
} = require('../kernel/providers/simulator/headless_runner.js');
const { setActiveMode } = require('../kernel/core/lib/modes.js');
const { summaryCore, stableStringify } = require('../kernel/core/lib/telemetry.js');

const VERBOSE = !!process.env.VERBOSE;

function log(...args) {
    if (VERBOSE) console.log(...args);
}

function testNormalizeAndResolveUnit() {
    const raw = {
        id: 'unit_rats',
        groups: {
            normal: {
                weight: 80,
                creatureIds: ['cave_rat'],
                packSize: [1, 2]
            },
            champion: {
                weight: 15,
                creatureIds: ['cave_rat'],
                packSize: [2, 3],
                affixes: ['champion']
            },
            elite: {
                weight: 5,
                creatureIds: ['venom_spitter'],
                packSize: [1, 1]
            }
        },
        limits: {
            totalPacks: [4, 6],
            championPacks: [1, 2],
            elitePacks: [0, 1]
        }
    };
    const norm = normalizePopulation(raw);
    assert.ok(norm);
    assert.strictEqual(norm.id, 'unit_rats');
    assert.strictEqual(norm.groups.champion.rarity, 'champion');
    assert.ok(norm.groups.champion.affixes.indexOf('champion') >= 0);
    assert.deepStrictEqual(norm.limits.totalPacks, [4, 6]);
    assert.deepStrictEqual(norm.limits.packLimits.champion, [1, 2]);

    const slots = [];
    for (let i = 0; i < 20; i++) {
        slots.push({ x: 100 + i * 3, y: 50, z: 7 });
    }

    const a = resolvePopulation({ population: raw, slots, seed: 42 });
    const b = resolvePopulation({ population: raw, slots, seed: 42 });
    assert.strictEqual(
        stableStringify(a.spawns),
        stableStringify(b.spawns),
        'same seed ⇒ same spawn set'
    );
    assert.ok(a.spawns.length >= 1, 'expected at least one spawn');
    assert.strictEqual(a.meta.seed, 42);
    assert.ok(a.meta.groupCounts.champion >= 1, 'min champion packs');
    assert.ok(a.meta.groupCounts.champion <= 2, 'max champion packs');
    if (a.meta.groupCounts.elite != null) {
        assert.ok(a.meta.groupCounts.elite <= 1, 'max elite packs');
    }
    assert.ok(a.meta.packCount >= 4 && a.meta.packCount <= 6);

    const champ = a.spawns.find((s) => s.rarity === 'champion' || (s.affixes && s.affixes.indexOf('champion') >= 0));
    assert.ok(champ, 'champion spawn should carry rarity/affixes');
    assert.ok(champ.hpMult > 1, 'champion affix stub hpMult');

    const c = resolvePopulation({ population: raw, slots, seed: 99 });
    // Different seed may differ; not required to differ but usually does
    log('unit resolve ok', {
        seed42: a.spawns.length,
        seed99: c.spawns.length,
        groups: a.meta.groupCounts
    });
}

function testWaypointSampling() {
    const wps = [
        { x: 0, y: 0, z: 7 },
        { x: 10, y: 0, z: 7 },
        { x: 10, y: 10, z: 7 }
    ];
    const slots = sampleSlotsAlongWaypoints(wps, 5, 7);
    assert.strictEqual(slots.length, 5);
    assert.strictEqual(slots[0].x, 0);
    assert.strictEqual(slots[4].x, 10);
    assert.strictEqual(slots[4].y, 10);

    const fromWp = resolvePopulation({
        population: {
            id: 'wp',
            groups: {
                normal: { weight: 100, creatureIds: ['cave_rat'], packSize: [1, 1] }
            },
            limits: { totalPacks: [3, 3] }
        },
        waypoints: wps,
        seed: 7
    });
    assert.strictEqual(fromWp.spawns.length, 3);
    log('waypoint sample ok', { n: fromWp.spawns.length });
}

function testExplicitSpawnsWin() {
    setActiveMode('standard');
    const fixture = {
        id: 'fixture',
        floor: 7,
        populationId: 'cave_rats',
        spawns: [
            { creatureId: 'cave_rat', x: 1, y: 2, z: 7, respawn: 0 }
        ],
        waypoints: [{ x: 0, y: 0, z: 7 }]
    };
    const expanded = expandHuntDefinition(fixture, { seed: 1 });
    assert.strictEqual(expanded.populationSkipped, 'explicit_spawns');
    assert.strictEqual(expanded.spawns.length, 1);
    assert.strictEqual(expanded.spawns[0].x, 1);
    assert.ok(huntHasExplicitSpawns(fixture));
    assert.ok(huntHasPopulation(fixture));
    log('explicit spawns win ok');
}

function testStandardPopulationPreset() {
    setActiveMode('standard');
    const ids = listPopulationIds();
    assert.ok(ids.indexOf('cave_rats') >= 0, 'standard population preset');
    const table = loadPopulation('cave_rats');
    assert.strictEqual(table.id, 'cave_rats');

    // Generator-owned standard path (hand floor07_population hunt retired).
    const r1 = resolveHuntConfig({ seed: 42, huntId: 'cave_crawl_generated' });
    const r2 = resolveHuntConfig({ seed: 42, huntId: 'cave_crawl_generated' });
    assert.ok(r1.spawns.length >= 1, 'population hunt has spawns');
    assert.strictEqual(
        stableStringify(r1.spawns),
        stableStringify(r2.spawns),
        'resolveHuntConfig seed-stable spawns'
    );
    assert.ok(r1.hunt.populationMeta, 'populationMeta on expanded hunt');
    assert.strictEqual(r1.hunt.populationMeta.seed, 42);
    assert.ok(
        (r1.hunt.populationMeta.groupCounts.champion || 0) >= 1,
        'min champion packs on standard fixture'
    );
    assert.ok(
        (r1.hunt.populationMeta.groupCounts.champion || 0) <= 2,
        'max champion packs on standard fixture'
    );
    assert.ok(
        (r1.hunt.populationMeta.slotsUsed || 0) >= 1 ||
            (r1.hunt.populationMeta.slotCandidates &&
                r1.hunt.populationMeta.slotCandidates.length >= 1),
        'population fills piece sockets (not hand corridor slots)'
    );

    const dense = resolveHuntConfig({
        seed: 42,
        huntId: 'cave_crawl_generated',
        populationDensity: 2
    });
    assert.ok(
        dense.spawns.length >= r1.spawns.length,
        'higher density ⇒ at least as many creatures'
    );

    // Explicit fixture spawns still win when authored on a hunt object
    const fixture = {
        id: 'fixture_explicit',
        floor: 0,
        populationId: 'cave_rats',
        spawns: [
            { creatureId: 'cave_rat', x: 1, y: 2, z: 0, respawn: 0 }
        ],
        waypoints: [{ x: 0, y: 0, z: 0 }]
    };
    const sample = expandHuntDefinition(fixture, { seed: 1 });
    assert.strictEqual(sample.spawns.length, 1);
    assert.strictEqual(sample.populationSkipped, 'explicit_spawns');

    log('standard population preset ok', {
        packs: r1.hunt.populationMeta.packCount,
        creatures: r1.spawns.length,
        dense: dense.spawns.length
    });
}

function testLegacyPopulationPreset() {
    if (!hasMode('legacy')) return;
    setActiveMode('legacy');
    const ids = listPopulationIds();
    assert.ok(ids.indexOf('cave_rats') >= 0, 'legacy population preset');

    // Generator-owned legacy path (bulk dens population hunt retired).
    const r1 = resolveHuntConfig({
        seed: 7,
        huntId: 'cave_crawl_generated'
    });
    const r2 = resolveHuntConfig({
        seed: 7,
        huntId: 'cave_crawl_generated'
    });
    assert.ok(r1.spawns.length >= 1, 'legacy generated population yields spawns');
    assert.strictEqual(
        stableStringify(r1.spawns),
        stableStringify(r2.spawns),
        'legacy population seed-stable'
    );
    assert.ok(r1.hunt.populationMeta);
    assert.ok(
        (r1.hunt.populationMeta.slotsUsed || 0) >= 1 ||
            (r1.hunt.populationMeta.slotCandidates &&
                r1.hunt.populationMeta.slotCandidates.length >= 1),
        'population fills piece sockets (not bulk dens)'
    );
    assert.ok(
        (r1.hunt.populationMeta.groupCounts.champion || 0) >= 1,
        'legacy min champion packs'
    );
    assert.ok(
        !r1.hunt.spawnSourceSpec,
        'generated hunt must not dual-maintain spawnSource dens'
    );

    log('legacy population preset ok', {
        creatures: r1.spawns.length,
        groups: r1.hunt.populationMeta.groupCounts
    });
}

async function testStandardHeadless() {
    setActiveMode('standard');
    const a = await runHeadlessHunt({
        seed: 42,
        huntId: 'cave_crawl_generated',
        frames: 6000
    });
    const b = await runHeadlessHunt({
        seed: 42,
        huntId: 'cave_crawl_generated',
        frames: 6000
    });
    assert.strictEqual(
        stableStringify(summaryCore(a)),
        stableStringify(summaryCore(b)),
        'same seed ⇒ same summary core (population hunt)'
    );
    assert.ok(a.creaturesSpawned >= 1 || a.kills >= 0);
    log('standard headless population ok', {
        state: a.sessionState,
        kills: a.kills,
        spawned: a.creaturesSpawned
    });
}

/** docs/24 I2 — named golden crawl: mid band + quartet + mid-loop champions. */
async function testGoldenCaveCrawlHeadless() {
    setActiveMode('standard');
    const cfg = resolveHuntConfig({ seed: 42, huntId: 'golden_cave_crawl' });
    assert.strictEqual(cfg.hunt && cfg.hunt.populationId, 'cave_mid_mixed');
    assert.strictEqual(cfg.hunt && cfg.hunt.artSet, 'cave_simple');
    assert.strictEqual(cfg.hunt && cfg.hunt.defaultPartyId, 'balance_quartet');
    assert.ok(
        (cfg.noAttackTimeoutSec != null && cfg.noAttackTimeoutSec > 0) ||
            (cfg.hunt &&
                cfg.hunt.limits &&
                cfg.hunt.limits.noAttackTimeoutSec > 0),
        'golden hunt carries noAttackTimeoutSec liveness guard'
    );

    const summary = await runHeadlessHunt({
        seed: 42,
        huntId: 'golden_cave_crawl'
    });
    assert.ok(summary.parties && summary.parties[0]);
    assert.strictEqual(summary.parties[0].partyId, 'balance_quartet');
    assert.strictEqual(summary.parties[0].members.length, 4);
    assert.ok(summary.kills >= 1, 'golden crawl gets kills');
    const mid =
        summary.pacing &&
        summary.pacing.metrics &&
        summary.pacing.metrics.midCounts;
    assert.ok(mid, 'pacing midCounts present');
    assert.ok(
        (mid.champion || 0) >= 1,
        `expected ≥1 champion mid-loop, got ${mid.champion}`
    );
    // Product party survives seed 42; session ends via liveness after combat stall
    assert.strictEqual(summary.partyWipe, false);
    assert.ok(
        summary.endReason === 'no_attack_timeout' ||
            summary.endReason === 'route_complete' ||
            summary.endReason === 'timeout',
        `unexpected endReason ${summary.endReason}`
    );
    log('golden crawl headless ok', {
        state: summary.sessionState || summary.endReason,
        kills: summary.kills,
        champions: mid.champion,
        well: mid.well
    });
}

/**
 * docs/24 I5 — multi-biome rising bands: early/mid/late pops + runtime hops.
 * Default rising_pressure_duo (L90) pathfinds stairs; seed 42 hits both
 * transitions. After follower stair catch-up, both members climb and crypt
 * pressure wipes the duo (docs/25 A1 ground truth).
 */
async function testRisingPressureMacroHeadless() {
    setActiveMode('standard');
    const cfg = resolveHuntConfig({
        seed: 42,
        huntId: 'rising_pressure_macro'
    });
    assert.ok(cfg.hunt && cfg.hunt.populationByFloor);
    assert.strictEqual(cfg.hunt.populationByFloor['0'], 'cave_trash_low');
    assert.strictEqual(cfg.hunt.populationByFloor['1'], 'cave_mid_mixed');
    assert.strictEqual(cfg.hunt.populationByFloor['2'], 'crypt_pressure_high');
    assert.strictEqual(cfg.hunt.defaultPartyId, 'rising_pressure_duo');
    assert.ok(cfg.pacingBudget && cfg.pacingBudget.id === 'rising_pressure_macro');

    const summary = await runHeadlessHunt({
        seed: 42,
        huntId: 'rising_pressure_macro',
        // Full three-segment path (~85s sim on seed 42); allow headroom
        maxSeconds: 160,
        frames: 3200
    });
    assert.ok(summary.parties && summary.parties[0]);
    assert.strictEqual(summary.parties[0].partyId, 'rising_pressure_duo');
    assert.ok(summary.kills >= 5, 'macro path gets combat kills');
    assert.ok(summary.pacing && summary.pacing.evaluation, 'pacing evaluation present');
    const checks = summary.pacing.evaluation.checks || [];
    const macroTr = checks.find((c) => c.id === 'macro.transitions');
    const macroBiomes = checks.find((c) => c.id === 'macro.biomes');
    const macroArts = checks.find((c) => c.id === 'macro.artSets');
    assert.ok(macroTr && macroTr.status === 'pass', 'macro.transitions pass');
    assert.ok(macroBiomes && macroBiomes.status === 'pass', 'macro.biomes pass');
    assert.ok(macroArts && macroArts.status === 'pass', 'macro.artSets pass');

    const transitions = (summary.pacing.events || []).filter(
        (e) => e.kind === 'biome_transition'
    );
    assert.ok(
        transitions.length >= 2,
        `expected ≥2 runtime biome_transition, got ${transitions.length}`
    );
    assert.ok(
        transitions.some(
            (e) => e.fromBiomeId === 'cave' && e.toBiomeId === 'ice'
        ),
        'early → mid (cave → ice)'
    );
    assert.ok(
        transitions.some(
            (e) => e.fromBiomeId === 'ice' && e.toBiomeId === 'crypt'
        ),
        'mid → late (ice → crypt)'
    );
    const mid =
        summary.pacing.metrics && summary.pacing.metrics.midCounts;
    assert.ok(mid && (mid.champion || 0) >= 1, 'mid-loop champions fire');
    // A1 product path (docs/25): both members reach crypt; duo wipes under pressure.
    // 2026-08-28: hop-on-step is manual-only — AI no longer bounce on paired stairs.
    assert.strictEqual(summary.partyWipe, true);
    assert.strictEqual(summary.endReason, 'party_wipe');
    assert.strictEqual(summary.tickCount, 1824);
    assert.strictEqual(summary.kills, 22);
    assert.strictEqual(summary.deaths, 2);
    assert.strictEqual(summary.damageTaken, 2645);
    const members = summary.parties[0].members || [];
    assert.ok(
        members.every((m) => String(m.z) === '2'),
        'both members end on crypt floor z=2'
    );
    log('rising pressure macro headless ok', {
        state: summary.sessionState || summary.endReason,
        kills: summary.kills,
        deaths: summary.deaths,
        ticks: summary.tickCount,
        transitions: transitions.length,
        champions: mid && mid.champion
    });
}

async function testLegacyHeadless() {
    if (!hasMode('legacy')) return;
    setActiveMode('legacy');
    const summary = await runHeadlessHunt({
        seed: 7,
        huntId: 'cave_crawl_generated',
        frames: 3000,
        maxSeconds: 20
    });
    assert.ok(summary);
    assert.ok(typeof summary.kills === 'number');
    assert.ok(summary.pacing);
    log('legacy headless population ok', {
        state: summary.sessionState,
        kills: summary.kills,
        spawned: summary.creaturesSpawned
    });
}

function testDensityKnobApply() {
    setActiveMode('standard');
    const { getKnob } = require('../kernel/core/lib/balance_sweep.js');
    const applied = getKnob('population_density').apply(
        { huntId: 'cave_crawl_generated', seed: 3 },
        2
    );
    assert.strictEqual(applied.knob, 'population_density');
    assert.strictEqual(applied.populationDensity, 2);
    log('population_density knob ok');
}

/** docs/24 I1 — threat-banded populations activate diverse catalog ids. */
function testThreatBandedPopulations() {
    setActiveMode('standard');
    const {
        shellDecision,
        immuneDecision,
        unattackableDecision,
        parseArgs
    } = require('../bin/build_population_band.js');
    const defaultOpts = parseArgs([]);
    // Physical / multi-immune shells must not enter product band pools
    assert.ok(
        immuneDecision(
            {
                id: 'lovely_scorpion',
                resists: {
                    physical: 100,
                    fire: 100,
                    ice: 100,
                    energy: 100,
                    earth: 100,
                    holy: 100,
                    death: 0
                }
            },
            defaultOpts
        ).exclude,
        'lovely_scorpion multi-immune excluded by default'
    );
    assert.ok(
        shellDecision(
            { id: 'phys_wall', hp: 50, resists: { physical: 100 } },
            defaultOpts
        ).exclude,
        'physical≥100 excluded'
    );
    assert.ok(
        !immuneDecision(
            { id: 'soft', resists: { physical: 30, fire: 20 } },
            defaultOpts
        ).exclude,
        'normal resists kept'
    );
    assert.ok(
        !immuneDecision(
            {
                id: 'lovely_scorpion',
                resists: {
                    physical: 100,
                    fire: 100,
                    ice: 100,
                    energy: 100,
                    earth: 100,
                    holy: 100,
                    death: 0
                }
            },
            parseArgs(['--no-exclude-immune'])
        ).exclude,
        '--no-exclude-immune opts out'
    );
    // flags.attackable === false (props / phase shells) must not enter band pools
    assert.ok(
        unattackableDecision(
            { id: 'cosmic_energy_prism_a', flags: { attackable: false } },
            defaultOpts
        ).exclude,
        'attackable:false excluded by default'
    );
    assert.ok(
        shellDecision(
            {
                id: 'prism',
                hp: 1000,
                flags: { attackable: false },
                resists: { physical: 0 }
            },
            defaultOpts
        ).exclude,
        'shellDecision excludes unattackable'
    );
    assert.ok(
        !unattackableDecision(
            { id: 'orc', flags: { attackable: true } },
            defaultOpts
        ).exclude,
        'attackable:true kept'
    );
    assert.ok(
        !unattackableDecision({ id: 'legacy_missing_flag', hp: 50 }, defaultOpts)
            .exclude,
        'missing attackable kept (port default)'
    );
    assert.ok(
        !unattackableDecision(
            { id: 'prism', flags: { attackable: false } },
            parseArgs(['--no-exclude-unattackable'])
        ).exclude,
        '--no-exclude-unattackable opts out'
    );

    const banded = [
        { popId: 'cave_trash_low', huntId: 'cave_band_low', minDistinct: 8 },
        { popId: 'cave_mid_mixed', huntId: 'cave_band_mid', minDistinct: 8 },
        { popId: 'cave_mid_mixed', huntId: 'golden_cave_crawl', minDistinct: 8 },
        { popId: 'crypt_pressure_high', huntId: 'crypt_band_high', minDistinct: 8 }
    ];
    const ids = listPopulationIds();
    for (const row of banded) {
        assert.ok(ids.indexOf(row.popId) >= 0, `list has ${row.popId}`);
        const table = loadPopulation(row.popId);
        assert.strictEqual(table.id, row.popId);
        assert.ok(table.band, `${row.popId} carries band metadata`);
        assert.ok(
            Array.isArray(table.groups.normal.creatureIds) &&
                table.groups.normal.creatureIds.length >= row.minDistinct,
            `${row.popId} normal pool size`
        );
        const unique = new Set(table.groups.normal.creatureIds);
        assert.ok(
            unique.size >= row.minDistinct,
            `${row.popId} diverse creature ids`
        );
        // Not a single-template corridor
        assert.ok(unique.size > 1, `${row.popId} not mono-id`);
        // Known unkillable-for-physical starter kits must not appear
        assert.ok(
            !unique.has('lovely_scorpion') && !unique.has('lovely_snake'),
            `${row.popId} excludes lovely multi-immunes`
        );
        assert.ok(
            !unique.has('cosmic_energy_prism_a') &&
                !unique.has('cosmic_energy_prism_b') &&
                !unique.has('dark_sorcerer_supreme_essence'),
            `${row.popId} excludes attackable:false templates`
        );
        for (const cid of unique) {
            const t = loadCreatureTemplate(cid);
            const phys = t && t.resists ? Number(t.resists.physical) || 0 : 0;
            assert.ok(
                phys < 100,
                `${row.popId} must not include physical-immune ${cid}`
            );
            const attackable =
                t && t.flags && t.flags.attackable !== undefined
                    ? t.flags.attackable
                    : true;
            assert.ok(
                attackable !== false,
                `${row.popId} must not include unattackable ${cid}`
            );
        }

        const r1 = resolveHuntConfig({ seed: 42, huntId: row.huntId });
        const r2 = resolveHuntConfig({ seed: 42, huntId: row.huntId });
        assert.ok(r1.spawns.length >= 1, `${row.huntId} has spawns`);
        assert.strictEqual(
            stableStringify(r1.spawns),
            stableStringify(r2.spawns),
            `${row.huntId} seed-stable`
        );
        assert.ok(r1.hunt.populationMeta, `${row.huntId} populationMeta`);
        const spawnIds = new Set(r1.spawns.map((s) => s.creatureId));
        for (const id of spawnIds) {
            assert.ok(
                unique.has(id) ||
                    (table.groups.champion &&
                        table.groups.champion.creatureIds.indexOf(id) >= 0) ||
                    (table.groups.elite &&
                        table.groups.elite.creatureIds.indexOf(id) >= 0),
                `spawn ${id} from ${row.popId} pools`
            );
        }
        log('banded ok', {
            hunt: row.huntId,
            packs: r1.hunt.populationMeta.packCount,
            creatures: r1.spawns.length,
            distinctSpawned: spawnIds.size
        });
    }

    // Same layout family, different bands → different creature identity sets
    const low = resolveHuntConfig({ seed: 42, huntId: 'cave_band_low' });
    const mid = resolveHuntConfig({ seed: 42, huntId: 'cave_band_mid' });
    const lowIds = new Set(low.spawns.map((s) => s.creatureId));
    const midIds = new Set(mid.spawns.map((s) => s.creatureId));
    let overlap = 0;
    for (const id of lowIds) {
        if (midIds.has(id)) overlap++;
    }
    assert.ok(
        overlap < Math.min(lowIds.size, midIds.size) ||
            lowIds.size === 0 ||
            midIds.size === 0,
        'low vs mid bands should not share the full spawn identity set'
    );
    // Stronger: at least one id unique to each side when both non-empty
    if (lowIds.size && midIds.size) {
        let onlyLow = 0;
        for (const id of lowIds) {
            if (!midIds.has(id)) onlyLow++;
        }
        assert.ok(onlyLow >= 1, 'low band has an id mid band lacks');
    }
    log('band contrast ok', {
        low: [...lowIds],
        mid: [...midIds],
        overlap
    });
}

async function main() {
    testNormalizeAndResolveUnit();
    testWaypointSampling();
    testExplicitSpawnsWin();
    testStandardPopulationPreset();
    testLegacyPopulationPreset();
    testDensityKnobApply();
    testThreatBandedPopulations();
    await testStandardHeadless();
    await testGoldenCaveCrawlHeadless();
    await testRisingPressureMacroHeadless();
    await testLegacyHeadless();
    console.log('ok: population (Stage 11.1)');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
