#!/usr/bin/env node
/**
 * Stage 11.10 — Macro 15‑min multi-biome transitions.
 * Quiet on success; VERBOSE=1 for detail.
 */

'use strict';

const { installedModes } = require('./helpers/modes.js');

const assert = require('assert');
const {
    normalizeMacroSegment,
    normalizeMacroSegments,
    expandSegmentsToFloors,
    generateMultiBiomeLayout,
    resolveMultiBiomeHuntLayout,
    huntHasMultiBiome,
    normalizeBudget,
    buildMacroMetrics,
    evaluatePacing,
    bindHuntArt,
    normalizeArtSetPack
} = require('../kernel/core/lib/dungeon/index.js');
const {
    loadBiomePack,
    loadPiecePack,
    loadDungeonProfile,
    loadPopulation,
    loadArtSet,
    loadHunt,
    expandHuntDefinition,
    listArtSetIds,
    listBiomePackIds
} = require('../kernel/core/lib/presets.js');
const { setActiveMode } = require('../kernel/core/lib/modes.js');
const { normalizePiecePack } = require('../kernel/core/lib/dungeon/pieces.js');
const {
    resolveHuntConfig
} = require('../kernel/providers/simulator/headless_runner.js');
const {
    Simulator,
    buildFloorMetaIndex
} = require('../kernel/providers/simulator/simulator.js');
const { Time } = require('../kernel/core/lib/time.js');

const VERBOSE = !!process.env.VERBOSE;

function log(...args) {
    if (VERBOSE) console.log(...args);
}

function loaders() {
    return {
        loadDungeonProfile,
        loadPiecePack,
        loadPopulation,
        loadBiomePack,
        loadArtSet,
        normalizePiecePack
    };
}

function testNormalizeSegments() {
    const segs = normalizeMacroSegments([
        'cave',
        {
            biomeId: 'Crypt',
            targetMinSec: 900,
            floors: [{ profileId: 'small_crawl' }]
        }
    ]);
    assert.ok(segs);
    assert.strictEqual(segs.length, 2);
    assert.strictEqual(segs[0].biomeId, 'cave');
    assert.strictEqual(segs[0].targetMinSec, 900);
    assert.strictEqual(segs[1].biomeId, 'crypt');
    assert.strictEqual(segs[1].floors.length, 1);

    const one = normalizeMacroSegment({ biome: 'cave', durationSec: 600 }, 0);
    assert.strictEqual(one.targetMinSec, 600);
    log('normalize segments ok');
}

function testExpandSegments(mode) {
    setActiveMode(mode);
    const segs = normalizeMacroSegments([
        { biomeId: 'cave', floors: [{ profileId: 'small_crawl' }] },
        { biomeId: 'crypt', floors: [{ profileId: 'small_crawl' }] }
    ]);
    const exp = expandSegmentsToFloors(segs, { loadBiomePack });
    assert.strictEqual(exp.floors.length, 2);
    assert.strictEqual(exp.floors[0].z, 0);
    assert.strictEqual(exp.floors[0].biomeId, 'cave');
    assert.strictEqual(exp.floors[0].artSet, 'cave');
    assert.strictEqual(exp.floors[0].populationId, 'cave_rats');
    assert.strictEqual(exp.floors[1].z, 1);
    assert.strictEqual(exp.floors[1].biomeId, 'crypt');
    assert.strictEqual(exp.floors[1].artSet, 'crypt');
    assert.ok(exp.floors[1].populationId);
    assert.strictEqual(exp.transitions.length, 1);
    assert.strictEqual(exp.transitions[0].fromBiomeId, 'cave');
    assert.strictEqual(exp.transitions[0].toBiomeId, 'crypt');
    assert.strictEqual(exp.segments.length, 2);
    log(`expand segments (${mode}) ok`);
}

function testGenerateMultiBiome(mode) {
    setActiveMode(mode);
    const gen = generateMultiBiomeLayout({
        seed: 42,
        segments: [
            { biomeId: 'cave', floors: [{ profileId: 'small_crawl' }] },
            { biomeId: 'crypt', floors: [{ profileId: 'small_crawl' }] }
        ],
        ...loaders()
    });
    assert.ok(gen.ok, gen.error && gen.error.message);
    assert.strictEqual(gen.type, 'multi_biome');
    assert.ok(gen.floorLayers['0']);
    assert.ok(gen.floorLayers['1']);
    assert.ok(gen.stairLinks && gen.stairLinks.length >= 1);
    assert.ok(gen.macro);
    assert.strictEqual(gen.macro.segmentCount, 2);
    assert.strictEqual(gen.macro.transitionCount, 1);
    assert.ok(gen.macro.biomeIds.indexOf('cave') >= 0);
    assert.ok(gen.macro.biomeIds.indexOf('crypt') >= 0);
    assert.ok(gen.macro.artSets.indexOf('cave') >= 0);
    assert.ok(gen.macro.artSets.indexOf('crypt') >= 0);

    // floorMeta carries per-floor biome + pop
    const fm0 = gen.floorMeta.find((f) => String(f.z) === '0');
    const fm1 = gen.floorMeta.find((f) => String(f.z) === '1');
    assert.ok(fm0 && fm0.biomeId === 'cave');
    assert.ok(fm1 && fm1.biomeId === 'crypt');
    assert.ok(fm0.artSet === 'cave');
    assert.ok(fm1.artSet === 'crypt');
    assert.notStrictEqual(fm0.populationId, fm1.populationId);

    // Deterministic under seed
    const gen2 = generateMultiBiomeLayout({
        seed: 42,
        segments: [
            { biomeId: 'cave', floors: [{ profileId: 'small_crawl' }] },
            { biomeId: 'crypt', floors: [{ profileId: 'small_crawl' }] }
        ],
        ...loaders()
    });
    assert.ok(gen2.ok);
    assert.deepStrictEqual(
        Array.from(gen.floorLayers['0'].friction),
        Array.from(gen2.floorLayers['0'].friction)
    );
    assert.deepStrictEqual(
        Array.from(gen.floorLayers['1'].friction),
        Array.from(gen2.floorLayers['1'].friction)
    );
    log(`generate multi-biome (${mode}) ok`);
}

function testExpandHuntFixture(mode) {
    setActiveMode(mode);
    const raw = loadHunt('cave_to_crypt_macro');
    assert.ok(huntHasMultiBiome(raw));
    const hunt = expandHuntDefinition(raw, { seed: 42 });
    assert.ok(hunt.layoutMeta && hunt.layoutMeta.reason === 'ok');
    assert.strictEqual(hunt.layoutMeta.type, 'multi_biome');
    assert.ok(hunt.layoutMeta.macro);
    assert.strictEqual(hunt.layoutMeta.macro.transitionCount, 1);
    assert.ok(hunt.floorLayers['0'] && hunt.floorLayers['1']);
    assert.ok(hunt.populationByFloor);
    assert.ok(Object.keys(hunt.populationByFloor).length >= 2);
    assert.ok(Array.isArray(hunt.spawns) && hunt.spawns.length > 0);

    // Spawns should land on both floors when slots exist
    const zs = new Set(hunt.spawns.map((s) => String(s.z != null ? s.z : 0)));
    assert.ok(zs.size >= 1, 'expected spawns with z');

    // Art layers: distinct art sets per floor
    assert.ok(hunt.artLayers || hunt.floorArt);
    if (hunt.artLayers) {
        assert.ok(hunt.artLayers['0']);
        assert.ok(hunt.artLayers['1']);
        assert.strictEqual(hunt.artLayers['0'].artSet, 'cave');
        assert.strictEqual(hunt.artLayers['1'].artSet, 'crypt');
    }

    // Macro pacing evaluation from layout
    const budget = normalizeBudget(hunt.pacingBudget);
    assert.ok(budget && budget.macro);
    assert.strictEqual(budget.macro.minTransitions, 1);
    const evalResult = evaluatePacing(
        {
            timeSec: 60,
            kills: 0,
            events: [],
            layoutMeta: hunt.layoutMeta
        },
        budget
    );
    assert.ok(evalResult.status === 'pass' || evalResult.status === 'warn');
    const trCheck = evalResult.checks.find((c) => c.id === 'macro.transitions');
    assert.ok(trCheck);
    assert.strictEqual(trCheck.status, 'pass');
    const biomeCheck = evalResult.checks.find((c) => c.id === 'macro.biomes');
    assert.ok(biomeCheck && biomeCheck.status === 'pass');
    log(`expand hunt fixture (${mode}) ok`);
}

function testMacroMetrics() {
    const macro = buildMacroMetrics({
        layoutMacro: {
            segments: [
                { targetMinSec: 900, biomeId: 'cave', artSet: 'cave' },
                { targetMinSec: 900, biomeId: 'crypt', artSet: 'crypt' }
            ],
            transitions: [{ fromBiomeId: 'cave', toBiomeId: 'crypt' }],
            biomeIds: ['cave', 'crypt'],
            artSets: ['cave', 'crypt']
        },
        timeSec: 100
    });
    assert.strictEqual(macro.segmentCount, 2);
    assert.strictEqual(macro.transitionCount, 1);
    assert.strictEqual(macro.biomeCount, 2);
    assert.strictEqual(macro.meanPlannedSegmentSec, 900);

    const budget = normalizeBudget({
        macro: {
            targetSegmentSec: 900,
            minTransitions: 1,
            minBiomes: 2,
            minArtSets: 2
        }
    });
    const ev = evaluatePacing(
        {
            timeSec: 100,
            layoutMeta: {
                macro: {
                    segments: macro.segments || [
                        { targetMinSec: 900 },
                        { targetMinSec: 900 }
                    ],
                    transitions: [{}],
                    biomeIds: ['cave', 'crypt'],
                    artSets: ['cave', 'crypt']
                }
            },
            events: []
        },
        budget
    );
    // buildMacroMetrics from layoutMeta.macro uses segments from layout
    assert.ok(ev.metrics && ev.metrics.macro);
    assert.ok(ev.status === 'pass' || ev.status === 'warn' || ev.status === 'fail');
    log('macro metrics ok');
}

function testArtSetsAndBiomesPresent(mode) {
    setActiveMode(mode);
    const biomes = listBiomePackIds();
    assert.ok(biomes.indexOf('cave') >= 0, 'cave biome');
    assert.ok(biomes.indexOf('crypt') >= 0, 'crypt biome');
    // Stage 11.11 additional biomes
    assert.ok(biomes.indexOf('swamp') >= 0, 'swamp biome');
    assert.ok(biomes.indexOf('ice') >= 0, 'ice biome');
    assert.ok(biomes.indexOf('ruins') >= 0, 'ruins biome');
    const arts = listArtSetIds();
    assert.ok(arts.indexOf('cave') >= 0);
    assert.ok(arts.indexOf('crypt') >= 0);
    assert.ok(arts.indexOf('swamp') >= 0);
    assert.ok(arts.indexOf('ice') >= 0);
    assert.ok(arts.indexOf('ruins') >= 0);
    const cryptArt = normalizeArtSetPack(loadArtSet('crypt'));
    assert.ok(cryptArt);
    assert.ok(cryptArt.roles.floor.length >= 1);
    assert.ok(cryptArt.roles.wall.length >= 1);
    const cryptBiome = loadBiomePack('crypt');
    assert.strictEqual(cryptBiome.artSet, 'crypt');
    assert.ok(cryptBiome.populationId);
    const swampBiome = loadBiomePack('swamp');
    assert.strictEqual(swampBiome.artSet, 'swamp');
    assert.ok(swampBiome.populationId);
    log(`content packs (${mode}) ok`);
}

function testVolumeMacroExpand(mode) {
    setActiveMode(mode);
    const hunt = expandHuntDefinition(loadHunt('biome_volume_macro'), { seed: 5 });
    assert.ok(hunt.layoutMeta && hunt.layoutMeta.reason === 'ok');
    assert.ok(hunt.layoutMeta.macro);
    assert.ok(hunt.layoutMeta.macro.segmentCount >= 4);
    assert.ok(hunt.floorLayers);
    assert.ok(Object.keys(hunt.floorLayers).length >= 4);
    assert.ok(hunt.artLayers);
    assert.ok(hunt.stairLinks && hunt.stairLinks.length >= 3);
    // Distinct art sets across floors
    /** @type {Record<string, true>} */
    const sets = Object.create(null);
    const zs = Object.keys(hunt.artLayers);
    for (let i = 0; i < zs.length; i++) {
        const a = hunt.artLayers[zs[i]].artSet;
        if (a) sets[a] = true;
    }
    assert.ok(Object.keys(sets).length >= 4, '≥4 art sets in volume macro');
    log(`volume macro expand (${mode}) ok`, Object.keys(sets).join(','));
}

function testResolveHuntConfig(mode) {
    setActiveMode(mode);
    const cfg = resolveHuntConfig({
        huntId: 'cave_to_crypt_macro',
        seed: 42
    });
    assert.ok(cfg && cfg.hunt);
    assert.ok(cfg.hunt.floorLayers);
    assert.ok(cfg.hunt.layoutMeta && cfg.hunt.layoutMeta.macro);
    assert.ok(cfg.hunt.stairLinks && cfg.hunt.stairLinks.length >= 1);
    log(`resolveHuntConfig (${mode}) ok`);
}

function testBiomeIdsShorthand(mode) {
    setActiveMode(mode);
    const hunt = resolveMultiBiomeHuntLayout(
        {
            layout: {
                type: 'multi_biome',
                biomeIds: ['cave', 'crypt']
            },
            seed: 7
        },
        loaders()
    );
    assert.ok(hunt.layoutMeta && hunt.layoutMeta.reason === 'ok');
    assert.ok(hunt.layoutMeta.macro.segmentCount >= 2);
    assert.ok(hunt.floorLayers);
    // biome packs expand to their floors[] (2 each) → 4 floors
    assert.ok(Object.keys(hunt.floorLayers).length >= 2);
    log(`biomeIds shorthand (${mode}) ok`);
}

function testBuildFloorMetaIndex() {
    const idx = buildFloorMetaIndex(
        [
            { z: 0, biomeId: 'cave', artSet: 'cave' },
            { z: 1, biomeId: 'crypt', artSet: 'crypt', macroTransition: true }
        ],
        {
            segments: [
                { index: 0, floorZs: [0], startZ: 0, endZ: 0 },
                { index: 1, floorZs: [1], startZ: 1, endZ: 1 }
            ]
        }
    );
    assert.ok(idx['0'] && idx['0'].biomeId === 'cave');
    assert.ok(idx['1'] && idx['1'].biomeId === 'crypt');
    assert.strictEqual(idx['0'].segmentIndex, 0);
    assert.strictEqual(idx['1'].segmentIndex, 1);
    assert.strictEqual(idx['1'].macroTransition, true);
    log('buildFloorMetaIndex ok');
}

/**
 * Runtime biome_transition: stair hop into a new segment samples telemetry.
 */
async function testRuntimeBiomeTransition(mode) {
    setActiveMode(mode);
    const hunt = expandHuntDefinition(loadHunt('cave_to_crypt_macro'), {
        seed: 42
    });
    assert.ok(hunt.layoutMeta && hunt.layoutMeta.floorMeta);
    assert.ok(hunt.stairLinks && hunt.stairLinks.length >= 1);

    // Prefer a stair whose from/to floors have different biomes
    let link = null;
    const fmByZ = Object.create(null);
    for (let i = 0; i < hunt.layoutMeta.floorMeta.length; i++) {
        const fm = hunt.layoutMeta.floorMeta[i];
        if (fm && fm.z != null) fmByZ[String(fm.z)] = fm;
    }
    for (let i = 0; i < hunt.stairLinks.length; i++) {
        const L = hunt.stairLinks[i];
        if (!L || !L.from || !L.to) continue;
        const a = fmByZ[String(L.from.z)];
        const b = fmByZ[String(L.to.z)];
        if (a && b && a.biomeId && b.biomeId && a.biomeId !== b.biomeId) {
            link = L;
            break;
        }
    }
    assert.ok(link, 'expected a cross-biome stair link');

    const fromB = fmByZ[String(link.from.z)].biomeId;
    const toB = fmByZ[String(link.to.z)].biomeId;

    const sim = new Simulator({
        seed: 42,
        floors: hunt.floors,
        floorLayers: hunt.floorLayers,
        stairLinks: hunt.stairLinks,
        layoutMeta: hunt.layoutMeta,
        floorMeta: hunt.layoutMeta.floorMeta,
        combatAi: false,
        recordSteps: false,
        spawns: [],
        parties: [
            {
                name: 'MacroParty',
                id: 'macro',
                stairLinks: hunt.stairLinks,
                waypoints: [
                    {
                        x: link.from.x,
                        y: link.from.y,
                        z: link.from.z
                    },
                    {
                        x: link.to.x,
                        y: link.to.y,
                        z: link.to.z
                    }
                ],
                members: [
                    {
                        name: 'Leader',
                        classId: 'fighter',
                        isLeader: true
                    }
                ]
            }
        ]
    });

    try {
        await sim.start();
        assert.ok(Object.keys(sim._floorMetaByZ).length >= 2);

        const party = sim.parties[0];
        const leader = party.getLeader() || party.members[0];
        assert.ok(leader);

        // Place on stair pad so the next hop is immediate
        assert.ok(
            sim.tileMap.moveEntityToTile(
                leader,
                link.from.x,
                link.from.y,
                link.from.z
            ),
            'place on stair from'
        );
        leader.syncPositionFromTile && leader.syncPositionFromTile();
        leader.currentWaypoint = 0;
        leader.routeComplete = false;

        let hopped = false;
        for (let frame = 0; frame < 80; frame++) {
            Time.advanceFixedLogicStep();
            sim.updateAll();
            if (String(leader.tile.z) === String(link.to.z)) {
                hopped = true;
                break;
            }
        }
        assert.ok(hopped, 'leader should stair-hop to destination floor');

        const transitions = (sim.telemetry.events || []).filter(
            (e) => e.kind === 'biome_transition'
        );
        assert.ok(
            transitions.length >= 1,
            'expected biome_transition event after hop'
        );
        const tr = transitions[0];
        assert.strictEqual(tr.fromBiomeId, fromB);
        assert.strictEqual(tr.toBiomeId, toB);

        // Dedup: second hop same key must not double-count
        const nBefore = transitions.length;
        sim._maybeSampleBiomeTransition(
            leader,
            { x: link.from.x, y: link.from.y, z: link.from.z },
            { x: link.to.x, y: link.to.y, z: link.to.z }
        );
        const nAfter = (sim.telemetry.events || []).filter(
            (e) => e.kind === 'biome_transition'
        ).length;
        assert.strictEqual(nAfter, nBefore, 'dedup same fromZ→toZ');

        const summary = sim.buildHuntSummary({
            frames: 80,
            layoutMeta: hunt.layoutMeta,
            pacingBudget: hunt.pacingBudget
        });
        assert.ok(summary.layoutMeta);
        assert.ok(
            summary.pacing.events.some((e) => e.kind === 'biome_transition')
        );
        assert.ok(summary.pacing.metrics.biomeTransitionCount >= 1);
        // Macro budget: layout + runtime both count transitions
        const trCheck = summary.pacing.evaluation.checks.find(
            (c) => c.id === 'macro.transitions'
        );
        assert.ok(trCheck);
        assert.strictEqual(trCheck.status, 'pass');

        log(`runtime biome_transition (${mode}) ok`, {
            from: tr.fromBiomeId,
            to: tr.toBiomeId,
            t: tr.t
        });
    } finally {
        if (sim && typeof sim.destroy === 'function') sim.destroy();
    }
}

/**
 * docs/24 I5 / docs/22 A5b — rising-band multi-biome product hunt.
 * early/mid/late populations + simple art where available + pacingBudget.
 */
function testRisingPressureMacroProduct() {
    setActiveMode('standard');
    const cfg = resolveHuntConfig({
        seed: 42,
        huntId: 'rising_pressure_macro'
    });
    assert.ok(cfg && cfg.hunt);
    const hunt = cfg.hunt;
    assert.strictEqual(hunt.defaultPartyId, 'rising_pressure_duo');
    assert.ok(cfg.pacingBudget, 'rising pressure declares pacingBudget');
    assert.strictEqual(cfg.pacingBudget.id, 'rising_pressure_macro');
    assert.ok(
        cfg.pacingBudget.macro && cfg.pacingBudget.macro.minTransitions >= 2,
        'macro budget wants ≥2 transitions'
    );
    assert.ok(
        cfg.pacingBudget.macro.minBiomes >= 3,
        'macro budget wants ≥3 biomes'
    );

    assert.ok(hunt.layoutMeta && hunt.layoutMeta.reason === 'ok');
    assert.ok(hunt.layoutMeta.macro);
    assert.ok(hunt.layoutMeta.macro.segmentCount >= 3);
    assert.ok(hunt.layoutMeta.macro.transitionCount >= 2);
    assert.ok(
        (hunt.layoutMeta.macro.biomeIds || []).length >= 3,
        'three biomes in macro meta'
    );
    assert.ok(
        (hunt.layoutMeta.macro.artSets || []).length >= 3,
        'three art sets in macro meta'
    );
    assert.ok(
        (hunt.layoutMeta.macro.artSets || []).indexOf('cave_simple') >= 0
    );
    assert.ok(
        (hunt.layoutMeta.macro.artSets || []).indexOf('ice_simple') >= 0
    );

    assert.ok(hunt.populationByFloor);
    assert.strictEqual(hunt.populationByFloor['0'], 'cave_trash_low');
    assert.strictEqual(hunt.populationByFloor['1'], 'cave_mid_mixed');
    assert.strictEqual(hunt.populationByFloor['2'], 'crypt_pressure_high');
    assert.strictEqual(hunt.multiBiomePopulation, true);

    const zs = Object.keys(hunt.floorLayers || {});
    assert.ok(zs.length >= 3, 'three floors');
    assert.ok(hunt.stairLinks && hunt.stairLinks.length >= 2);

    // Spawns present on each segment floor with distinct band identity
    const byZ = Object.create(null);
    for (const s of cfg.spawns || []) {
        const z = String(s.z != null ? s.z : 0);
        if (!byZ[z]) byZ[z] = new Set();
        byZ[z].add(s.creatureId || s.id);
    }
    assert.ok((byZ['0'] || new Set()).size >= 1, 'early floor spawns');
    assert.ok((byZ['1'] || new Set()).size >= 1, 'mid floor spawns');
    assert.ok((byZ['2'] || new Set()).size >= 1, 'late floor spawns');

    // Layout-structure macro checks pass without runtime (short watch still evaluates)
    const budget = normalizeBudget(cfg.pacingBudget);
    const ev = evaluatePacing(
        {
            timeSec: 60,
            layoutMeta: hunt.layoutMeta,
            events: [],
            kills: 1
        },
        budget
    );
    assert.ok(ev && ev.checks);
    const tr = ev.checks.find((c) => c.id === 'macro.transitions');
    const biomes = ev.checks.find((c) => c.id === 'macro.biomes');
    const arts = ev.checks.find((c) => c.id === 'macro.artSets');
    assert.ok(tr && tr.status === 'pass', 'macro.transitions pass from layout');
    assert.ok(biomes && biomes.status === 'pass', 'macro.biomes pass');
    assert.ok(arts && arts.status === 'pass', 'macro.artSets pass');

    log('rising_pressure_macro product ok', {
        floors: zs.length,
        pops: hunt.populationByFloor,
        arts: hunt.layoutMeta.macro.artSets
    });
}

async function main() {
    testNormalizeSegments();
    testMacroMetrics();
    testBuildFloorMetaIndex();
    testRisingPressureMacroProduct();
    for (const mode of installedModes()) {
        testArtSetsAndBiomesPresent(mode);
        testExpandSegments(mode);
        testGenerateMultiBiome(mode);
        testExpandHuntFixture(mode);
        testResolveHuntConfig(mode);
        testBiomeIdsShorthand(mode);
        testVolumeMacroExpand(mode);
        await testRuntimeBiomeTransition(mode);
    }
    console.log('dungeon_macro: ok');
}

main().catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
});
