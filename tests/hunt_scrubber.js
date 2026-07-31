#!/usr/bin/env node
/**
 * Stage 12E — hunt scrubber / seek-to-tick.
 * Same seed + tick ⇒ same party tile / summary core after seek.
 * Quiet by default; VERBOSE=1 for detail.
 */

'use strict';

const { hasMode } = require('./helpers/modes.js');

const assert = require('assert');
const {
    runHeadlessHuntToTick
} = require('../kernel/providers/simulator/headless_runner.js');
const { Simulator } = require('../kernel/providers/simulator/simulator.js');
const { Time } = require('../kernel/core/lib/time.js');
const { Settings } = require('../kernel/settings.js');
const {
    summaryCore,
    stableStringify
} = require('../kernel/core/lib/telemetry.js');
const { unbindSeededRandom } = require('../kernel/core/lib/utils.js');
const { setActiveMode } = require('../kernel/core/lib/modes.js');

const VERBOSE = process.env.VERBOSE === '1';
const log = (...args) => {
    if (VERBOSE) console.log(...args);
};

let failed = 0;
let passed = 0;

async function testAsync(name, fn) {
    try {
        await fn();
        passed += 1;
        log('ok', name);
    } catch (err) {
        failed += 1;
        console.error('FAIL', name);
        console.error(err && err.stack ? err.stack : err);
    }
}

function leaderTile(positions) {
    const party = positions && positions[0];
    if (!party || !party.members || !party.members.length) return null;
    const leader =
        party.members.find((m) => m.isLeader) || party.members[0];
    return { x: leader.x, y: leader.y, z: leader.z, hp: leader.hp };
}

/**
 * Sparse sample of decorative tile ids for scrub art regression checks.
 * @param {{ artTileIdAt?: Function, getArtLayer?: Function }|null} tileMap
 * @param {string|number} z
 * @param {number} [step]
 * @returns {{ artSet: string|null, paletteLen: number, sample: (string|null)[], painted: number }|null}
 */
function artLayerFingerprint(tileMap, z, step) {
    if (!tileMap || typeof tileMap.getArtLayer !== 'function') return null;
    const layer = tileMap.getArtLayer(z);
    if (!layer) return null;
    const s = step > 0 ? step | 0 : 11;
    const sample = [];
    let painted = 0;
    for (let y = 0; y < layer.rows; y += s) {
        for (let x = 0; x < layer.cols; x += s) {
            const id =
                typeof tileMap.artTileIdAt === 'function'
                    ? tileMap.artTileIdAt(x, y, z)
                    : null;
            sample.push(id);
            if (id) painted += 1;
        }
    }
    return {
        artSet: layer.artSet != null ? String(layer.artSet) : null,
        paletteLen: Array.isArray(layer.palette) ? layer.palette.length : 0,
        sample,
        painted
    };
}

/**
 * Build a short combat sim and run N ticks (keeps sim for seek).
 * @param {number} seed
 * @param {number} frames
 * @returns {Promise<import('../kernel/providers/simulator/simulator.js').Simulator>}
 */
async function runLiveSim(seed, frames) {
    Settings.HEADLESS = true;
    const {
        resolveHuntConfig,
        pickInjectors
    } = require('../kernel/providers/simulator/headless_runner.js');
    const resolved = resolveHuntConfig({
        seed,
        huntId: 'cave_crawl_generated',
        frames
    });
    const inject = pickInjectors({});
    const live = new Simulator({
        seed: resolved.seed,
        floor: resolved.floor,
        floors: resolved.floors,
        mapPath: resolved.mapPath,
        mapPaths: resolved.mapPaths,
        floorLayers: resolved.floorLayers || null,
        floorFriction: resolved.floorFriction || null,
        genre: resolved.genre,
        huntId: resolved.huntId,
        combatAi: true,
        parties: resolved.parties,
        spawns: resolved.spawns,
        waypoints: resolved.waypoints,
        props: resolved.props,
        maxTicks: resolved.maxTicks,
        maxKills: resolved.maxKills,
        maxSeconds: resolved.maxSeconds,
        spellBook: inject.spellBook,
        strategyTable: inject.strategyTable,
        classLoader: inject.classLoader,
        itemDb: inject.itemDb,
        creatureLoader: inject.creatureLoader
    });
    await live.start();
    live.active = true;
    assert.ok(live.replayConfig, 'replayConfig captured at start');
    assert.strictEqual(live.replayConfig.seed, resolved.seed);

    for (let i = 0; i < frames; i++) {
        Time.advanceFixedLogicStep();
        live.updateAll();
    }
    return live;
}

(async () => {
    log('=== Hunt scrubber (12E) ===');

    await testAsync('runHeadlessHuntToTick shape at tick 0', async () => {
        const summary = await runHeadlessHuntToTick({
            seed: 42,
            huntId: 'cave_crawl_generated',
            toTick: 0
        });
        assert.strictEqual(summary.tickCount, 0);
        assert.ok(Array.isArray(summary.partyPositions));
        assert.ok(summary.partyPositions.length >= 1);
        const tile = leaderTile(summary.partyPositions);
        assert.ok(tile, 'leader tile at tick 0');
        assert.ok(Number.isFinite(tile.x));
    });

    await testAsync(
        'same seed + tick via runHeadlessHuntToTick is deterministic',
        async () => {
            const a = await runHeadlessHuntToTick({
                seed: 7,
                huntId: 'cave_crawl_generated',
                toTick: 40
            });
            const b = await runHeadlessHuntToTick({
                seed: 7,
                huntId: 'cave_crawl_generated',
                toTick: 40
            });
            assert.strictEqual(a.tickCount, 40);
            assert.strictEqual(b.tickCount, 40);
            assert.strictEqual(
                stableStringify(summaryCore(a)),
                stableStringify(summaryCore(b))
            );
            assert.deepStrictEqual(
                leaderTile(a.partyPositions),
                leaderTile(b.partyPositions)
            );
        }
    );

    await testAsync(
        'seekToTick restores mid-hunt leader tile + summary core',
        async () => {
            const seed = 99;
            const mid = 30;
            const late = 60;

            const ref = await runHeadlessHuntToTick({
                seed,
                huntId: 'cave_crawl_generated',
                toTick: mid
            });
            const refTile = leaderTile(ref.partyPositions);
            const refCore = summaryCore(ref);

            const live = await runLiveSim(seed, late);
            assert.ok(live.playbackMaxElapsedTicks >= late);
            assert.strictEqual(live.tickCount, late);

            // Seek back to mid
            await live.seekToTick(mid);
            assert.notStrictEqual(
                Math.random,
                live.seededRandom,
                'Math.random unbound after seek'
            );
            assert.ok(typeof Math.random() === 'number');

            assert.strictEqual(live.tickCount, mid);
            assert.strictEqual(live.playbackElapsedTicks, mid);

            const afterTile = leaderTile(live.getPartyPositions());
            assert.deepStrictEqual(afterTile, refTile, 'leader tile after seek');

            const afterSummary = live.buildHuntSummary({
                frames: mid,
                huntId: 'cave_crawl_generated'
            });
            assert.strictEqual(
                stableStringify(summaryCore(afterSummary)),
                stableStringify(refCore),
                'summary core matches fresh run at mid'
            );

            // Seek forward again to late and match a fresh late run
            const refLate = await runHeadlessHuntToTick({
                seed,
                huntId: 'cave_crawl_generated',
                toTick: late
            });
            await live.seekToTick(late);
            assert.strictEqual(live.tickCount, late);
            assert.deepStrictEqual(
                leaderTile(live.getPartyPositions()),
                leaderTile(refLate.partyPositions)
            );

            live.destroy();
            unbindSeededRandom();
            Settings.HEADLESS = false;
        }
    );

    /**
     * Scrub UX: +1 tick across a multi-floor hop must be incremental (not a
     * full reseed). Hop *tick* is discovered from floorHopLog so pathing
     * changes do not require rebaselining this suite (docs/25).
     */
    await testAsync(
        'forward seek across first floor hop is incremental',
        async () => {
            setActiveMode('standard');
            Settings.HEADLESS = true;
            const {
                resolveHuntConfig,
                pickInjectors
            } = require('../kernel/providers/simulator/headless_runner.js');
            const {
                huntToSimulatorOpts
            } = require('../kernel/providers/simulator/hunt_opts.js');
            const resolved = resolveHuntConfig({
                seed: 42,
                huntId: 'rising_pressure_macro',
                partyId: 'rising_pressure_duo'
            });
            const inject = pickInjectors({});
            const opts = huntToSimulatorOpts(resolved, {
                combatAi: true,
                injectors: inject
            });
            const sim = new Simulator(opts);
            await sim.start();
            sim.active = true;
            // Run until first stair hop is logged (or cap).
            const maxPlay = 2500;
            for (let i = 0; i < maxPlay; i++) {
                Time.advanceFixedLogicStep();
                sim.updateAll();
                if (sim.floorHopLog && sim.floorHopLog.length >= 1) break;
                if (
                    sim.sessionState !== 'running' &&
                    sim.sessionState !== 'idle'
                ) {
                    break;
                }
            }
            assert.ok(
                sim.replayConfig && sim.replayConfig.floorLayers,
                'replayConfig keeps floorLayers for multifloor seek'
            );
            assert.ok(
                Array.isArray(sim.replayConfig.stairLinks) &&
                    sim.replayConfig.stairLinks.length >= 1,
                'replayConfig keeps stairLinks'
            );
            assert.ok(
                Array.isArray(sim.floorHopLog) && sim.floorHopLog.length >= 1,
                'expected at least one floor hop on rising_pressure_macro seed 42'
            );
            const firstHop = sim.floorHopLog[0];
            const hopTick = firstHop.tick | 0;
            assert.ok(hopTick >= 2, `hop tick too early: ${hopTick}`);
            const preTick = hopTick - 1;
            const hopperName = String(firstHop.name || '');

            await sim.seekToTick(preTick);
            assert.strictEqual(sim.tickCount, preTick);
            const preMember = sim
                .getPartyPositions()[0]
                .members.find((m) => m.name === hopperName);
            assert.ok(preMember, `member ${hopperName} before hop`);
            assert.strictEqual(
                String(preMember.z),
                String(firstHop.fromZ),
                `${hopperName} still on fromZ at tick ${preTick}`
            );

            const t0 =
                typeof performance !== 'undefined' && performance.now
                    ? performance.now()
                    : Date.now();
            await sim.seekToTick(hopTick);
            const t1 =
                typeof performance !== 'undefined' && performance.now
                    ? performance.now()
                    : Date.now();
            assert.strictEqual(sim.tickCount, hopTick);
            const postMember = sim
                .getPartyPositions()[0]
                .members.find((m) => m.name === hopperName);
            assert.ok(postMember, `member ${hopperName} after hop`);
            assert.strictEqual(
                String(postMember.z),
                String(firstHop.toZ),
                `${hopperName} on toZ at hop tick ${hopTick}`
            );
            assert.ok(
                t1 - t0 < 2000,
                `forward seek too slow (${t1 - t0}ms) — likely reseeded`
            );

            const ref = await runHeadlessHuntToTick({
                seed: 42,
                huntId: 'rising_pressure_macro',
                partyId: 'rising_pressure_duo',
                toTick: hopTick
            });
            assert.deepStrictEqual(
                leaderTile(sim.getPartyPositions()),
                leaderTile(ref.partyPositions),
                `leader after hop matches headless toTick ${hopTick}`
            );
            sim.destroy();
            unbindSeededRandom();
            Settings.HEADLESS = false;
        }
    );

    /**
     * parityTrace plumbing only (fixed window) — no seed-specific hop anchors.
     * Live browser tick-log diffs live in `npm run browser:parity`, not npm test.
     */
    await testAsync(
        'parityTrace fixed window records rng rows',
        async () => {
            Settings.HEADLESS = true;
            const fixed = await runHeadlessHuntToTick({
                seed: 42,
                huntId: 'rising_pressure_macro',
                partyId: 'rising_pressure_duo',
                toTick: 40,
                parityTrace: { fromTick: 10, toTick: 12 }
            });
            assert.strictEqual(fixed.parityTickLog.length, 3);
            assert.strictEqual(fixed.parityTickLog[0].t, 10);
            assert.strictEqual(fixed.parityTickLog[2].t, 12);
            assert.ok(typeof fixed.parityTickLog[0].draws === 'number');
            assert.ok(fixed.parityTickLog[0].rng != null);
            assert.ok(
                Array.isArray(fixed.parityTickLog[0].party) &&
                    fixed.parityTickLog[0].party.length >= 1
            );
            // Deterministic: same seed + window → same first row rng
            const again = await runHeadlessHuntToTick({
                seed: 42,
                huntId: 'rising_pressure_macro',
                partyId: 'rising_pressure_duo',
                toTick: 12,
                parityTrace: { fromTick: 10, toTick: 12 }
            });
            assert.strictEqual(
                again.parityTickLog[0].rng,
                fixed.parityTickLog[0].rng
            );
            unbindSeededRandom();
            Settings.HEADLESS = false;
        }
    );

    await testAsync(
        'seek does not leave Math.random bound (empty reseed)',
        async () => {
            Settings.HEADLESS = true;
            const {
                resolveHuntConfig,
                pickInjectors
            } = require('../kernel/providers/simulator/headless_runner.js');
            const resolved = resolveHuntConfig({
                seed: 3,
                huntId: 'cave_crawl_generated',
                frames: 20
            });
            const inject = pickInjectors({});
            const sim = new Simulator({
                seed: resolved.seed,
                floor: resolved.floor,
                floors: resolved.floors,
                floorLayers: resolved.floorLayers || null,
                floorFriction: resolved.floorFriction || null,
                huntId: resolved.huntId,
                combatAi: true,
                parties: resolved.parties,
                spawns: resolved.spawns,
                waypoints: resolved.waypoints,
                classLoader: inject.classLoader,
                creatureLoader: inject.creatureLoader,
                itemDb: inject.itemDb,
                spellBook: inject.spellBook,
                strategyTable: inject.strategyTable
            });
            await sim.start();
            sim.active = true;
            for (let i = 0; i < 15; i++) {
                Time.advanceFixedLogicStep();
                sim.updateAll();
            }
            assert.ok(sim.replayConfig);
            await sim.seekToTick(10);
            assert.notStrictEqual(Math.random, sim.seededRandom);
            assert.strictEqual(sim._seekInProgress, false);
            sim.destroy();
            unbindSeededRandom();
            Settings.HEADLESS = false;
        }
    );

    await testAsync(
        'legacy generated hunt is deterministic at toTick (scrubber CI)',
        async () => {
            // Bulk dens corridor retired; generator-owned path covers determinism bar.
            if (!hasMode('legacy')) return;
            setActiveMode('legacy');
            const mid = 50;
            const cfg = {
                seed: 7,
                huntId: 'cave_crawl_generated',
                toTick: mid
            };
            const a = await runHeadlessHuntToTick(cfg);
            const b = await runHeadlessHuntToTick(cfg);
            assert.strictEqual(a.tickCount, mid);
            assert.strictEqual(b.tickCount, mid);
            assert.strictEqual(
                stableStringify(summaryCore(a)),
                stableStringify(summaryCore(b)),
                'legacy generated summary core stable'
            );
            assert.deepStrictEqual(
                leaderTile(a.partyPositions),
                leaderTile(b.partyPositions),
                'legacy generated leader tile stable'
            );
            assert.ok(leaderTile(a.partyPositions));
            setActiveMode('standard');
            log('legacy generated scrubber ok', {
                kills: a.kills,
                state: a.sessionState,
                tile: leaderTile(a.partyPositions)
            });
        }
    );

    /**
     * Multi-biome art + scrub reseed: Uint16 art cells must survive
     * captureReplayConfig/applyReplayConfig (not JSON clone). Guards the
     * watch regression where backward scrub painted friction gray only.
     * Also re-checks multi-floor determinism at a post-hop tick (docs/25 A1).
     */
    await testAsync(
        'multi-biome seek reseed keeps artLayers + determinism',
        async () => {
            setActiveMode('standard');
            Settings.HEADLESS = true;
            const {
                resolveHuntConfig,
                pickInjectors
            } = require('../kernel/providers/simulator/headless_runner.js');
            const {
                huntToSimulatorOpts
            } = require('../kernel/providers/simulator/hunt_opts.js');

            const seed = 42;
            const huntId = 'rising_pressure_macro';
            const partyId = 'rising_pressure_duo';
            // Past first hop window used by browser:parity default (Guardian@584, Scout@599).
            const late = 620;
            const mid = 300;

            const resolved = resolveHuntConfig({ seed, huntId, partyId });
            const inject = pickInjectors({});
            const opts = huntToSimulatorOpts(resolved, {
                combatAi: true,
                injectors: inject
            });
            const sim = new Simulator(opts);
            await sim.start();
            sim.active = true;

            assert.ok(
                sim.artLayers && Object.keys(sim.artLayers).length >= 2,
                'macro hunt exposes multi-floor artLayers'
            );
            assert.ok(
                sim.replayConfig && sim.replayConfig.artLayers,
                'replayConfig captures artLayers'
            );

            const zKeys = Object.keys(sim.replayConfig.artLayers).sort();
            assert.ok(zKeys.length >= 2, `expected ≥2 art floors, got ${zKeys.join(',')}`);

            const artSetsBefore = {};
            for (let i = 0; i < zKeys.length; i++) {
                const z = zKeys[i];
                const cfgL = sim.replayConfig.artLayers[z];
                assert.ok(
                    cfgL.cells instanceof Uint16Array,
                    `replayConfig.artLayers[${z}].cells must be Uint16Array (not JSON object)`
                );
                assert.ok(
                    cfgL.cells.length === (cfgL.cols | 0) * (cfgL.rows | 0),
                    `replayConfig art cells length matches cols*rows for z=${z}`
                );
                let nonzero = 0;
                for (let j = 0; j < cfgL.cells.length; j++) {
                    if (cfgL.cells[j] !== 0) nonzero += 1;
                }
                assert.ok(
                    nonzero > 0,
                    `art layer z=${z} should have non-empty decorative cells`
                );
                artSetsBefore[z] = cfgL.artSet || null;

                const mapL = sim.tileMap && sim.tileMap.getArtLayer(z);
                assert.ok(mapL, `TileMap art layer present for z=${z}`);
                assert.strictEqual(
                    mapL.cells.length,
                    (mapL.cols | 0) * (mapL.rows | 0)
                );
            }

            // Distinct biomes across floors (cave → ice → crypt style binding)
            const uniqueArtSets = new Set(
                Object.keys(artSetsBefore)
                    .map((z) => artSetsBefore[z])
                    .filter(Boolean)
            );
            assert.ok(
                uniqueArtSets.size >= 2,
                `multi-biome artSets expected, got ${[...uniqueArtSets].join(',')}`
            );

            const fingerprintBefore = {};
            for (let i = 0; i < zKeys.length; i++) {
                fingerprintBefore[zKeys[i]] = artLayerFingerprint(
                    sim.tileMap,
                    zKeys[i]
                );
            }

            for (let i = 0; i < late; i++) {
                Time.advanceFixedLogicStep();
                sim.updateAll();
                if (
                    sim.sessionState !== 'running' &&
                    sim.sessionState !== 'idle'
                ) {
                    break;
                }
            }
            assert.ok(
                sim.tickCount >= mid,
                `need ≥${mid} ticks for scrub mid; got ${sim.tickCount}`
            );
            const actualLate = sim.tickCount;

            const refMid = await runHeadlessHuntToTick({
                seed,
                huntId,
                partyId,
                toTick: mid
            });
            const refLate = await runHeadlessHuntToTick({
                seed,
                huntId,
                partyId,
                toTick: actualLate
            });

            // Backward scrub = full reseed path (the bug path for art cells)
            await sim.seekToTick(mid);
            assert.strictEqual(sim.tickCount, mid);
            assert.deepStrictEqual(
                leaderTile(sim.getPartyPositions()),
                leaderTile(refMid.partyPositions),
                'leader after backward seek matches headless mid'
            );
            assert.strictEqual(
                stableStringify(summaryCore(sim.buildHuntSummary({
                    frames: mid,
                    huntId
                }))),
                stableStringify(summaryCore(refMid)),
                'summary core after backward seek matches headless mid'
            );

            for (let i = 0; i < zKeys.length; i++) {
                const z = zKeys[i];
                const mapL = sim.tileMap && sim.tileMap.getArtLayer(z);
                assert.ok(mapL, `TileMap art layer still present after reseed z=${z}`);
                assert.ok(
                    mapL.cells instanceof Uint16Array && mapL.cells.length > 0,
                    `art cells remain Uint16 after reseed z=${z}`
                );
                let nonzero = 0;
                for (let j = 0; j < mapL.cells.length; j++) {
                    if (mapL.cells[j] !== 0) nonzero += 1;
                }
                assert.ok(
                    nonzero > 0,
                    `art layer z=${z} still has decorative cells after reseed`
                );
                assert.deepStrictEqual(
                    artLayerFingerprint(sim.tileMap, z),
                    fingerprintBefore[z],
                    `art fingerprint stable across reseed for z=${z}`
                );
                assert.strictEqual(
                    mapL.artSet || null,
                    artSetsBefore[z],
                    `artSet preserved for z=${z}`
                );
            }

            // Forward again to late (may reseed or step; land must match headless)
            await sim.seekToTick(actualLate);
            assert.strictEqual(sim.tickCount, actualLate);
            assert.deepStrictEqual(
                leaderTile(sim.getPartyPositions()),
                leaderTile(refLate.partyPositions),
                'leader after re-seek to late matches headless'
            );
            assert.strictEqual(
                stableStringify(summaryCore(sim.buildHuntSummary({
                    frames: actualLate,
                    huntId
                }))),
                stableStringify(summaryCore(refLate)),
                'summary core at late matches headless after scrub cycle'
            );

            sim.destroy();
            unbindSeededRandom();
            Settings.HEADLESS = false;
        }
    );

    if (failed) {
        console.error(`\nhunt_scrubber: ${failed} failed, ${passed} passed`);
        process.exit(1);
    }
    console.log(`hunt_scrubber: ${passed} passed`);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
