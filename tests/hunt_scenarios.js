#!/usr/bin/env node
/**
 * Stage 12G.2 exit criteria:
 * - list / load / apply scenario fixtures
 * - short headless assert (choke combat, wipe, leash state)
 * - default sims unchanged when scenarios are not used
 * Quiet on success; VERBOSE=1 for detail.
 */

'use strict';

const { hasMode } = require('./helpers/modes.js');

const assert = require('assert');
const {
    listScenarioIds,
    loadScenario,
    getScenarioMeta,
    applyScenario,
    scenarioToInput,
    withScenarioSettings,
    splitScenarioOpts,
    runScenarioHunt,
    setScenarioCache,
    clearScenarioCache,
    SCENARIO_SETTINGS_KEYS
} = require('../kernel/core/lib/hunt_scenarios.js');
const {
    runHeadlessHunt,
    resolveHuntConfig
} = require('../kernel/providers/simulator/headless_runner.js');
const { setActiveMode } = require('../kernel/core/lib/modes.js');
const { Settings } = require('../kernel/settings.js');
const { Simulator } = require('../kernel/providers/simulator/simulator.js');
const { Time } = require('../kernel/core/lib/time.js');

const VERBOSE = !!process.env.VERBOSE;

function log(...args) {
    if (VERBOSE) console.log(...args);
}

function testListAndLoad() {
    setActiveMode('standard');
    const ids = listScenarioIds();
    assert.ok(ids.indexOf('golden_cave_crawl') >= 0, 'golden_cave_crawl listed');
    assert.ok(ids.indexOf('golden_band_pressure') >= 0, 'golden_band_pressure listed');
    assert.ok(ids.indexOf('standard_arena_waves') >= 0, 'standard_arena_waves listed');
    assert.ok(ids.indexOf('rising_pressure_macro') >= 0, 'rising_pressure_macro listed');
    assert.ok(ids.indexOf('standard_cave_crawl') >= 0, 'standard_cave_crawl listed');
    assert.ok(ids.indexOf('choke_pack') >= 0, 'choke_pack listed');
    assert.ok(ids.indexOf('leash_test') >= 0, 'leash_test listed');
    assert.ok(ids.indexOf('wipe') >= 0, 'wipe listed');
    assert.ok(ids.indexOf('inventory_sandbox') >= 0, 'inventory_sandbox listed');
    assert.ok(ids.indexOf('rune_field_demo') >= 0, 'rune_field_demo listed');

    const choke = loadScenario('choke_pack');
    assert.strictEqual(choke.id, 'choke_pack');
    assert.ok(Array.isArray(choke.spawns) && choke.spawns.length >= 3);
    assert.ok(Array.isArray(choke.waypoints) && choke.waypoints.length >= 2);
    assert.strictEqual(choke.baseHuntId, 'outskirts_camp_fixed');

    const runeDemo = loadScenario('rune_field_demo');
    assert.strictEqual(runeDemo.id, 'rune_field_demo');
    assert.ok(Array.isArray(runeDemo.members) && runeDemo.members.length === 1);
    assert.strictEqual(runeDemo.members[0].strategyId, 'adept_field_runes');
    assert.ok(
        runeDemo.members[0].inventory &&
            Array.isArray(runeDemo.members[0].inventory.backpack) &&
            runeDemo.members[0].inventory.backpack.some(
                (e) => e && e.itemId === 'blaze_bomb_rune'
            ),
        'rune_field_demo seeds fire bomb runes'
    );

    const meta = getScenarioMeta('wipe');
    assert.strictEqual(meta.id, 'wipe');
    assert.ok(meta.label);
    assert.strictEqual(meta.baseHuntId, 'outskirts_camp_fixed');

    let legIds = [];
    if (hasMode('legacy')) {
        setActiveMode('legacy');
        legIds = listScenarioIds();
        assert.ok(
            legIds.indexOf('legacy_cave_crawl') >= 0,
            'legacy_cave_crawl listed'
        );
        const legCrawl = loadScenario('legacy_cave_crawl');
        assert.strictEqual(legCrawl.id, 'legacy_cave_crawl');
        assert.strictEqual(legCrawl.baseHuntId, 'cave_crawl_generated');
        setActiveMode('standard');
    }
    log('list/load ok', { ids, legIds });
}

function testApplyScenario() {
    setActiveMode('standard');
    const opts = applyScenario('choke_pack');
    assert.strictEqual(opts.huntId, 'outskirts_camp_fixed');
    assert.strictEqual(opts.scenarioId, 'choke_pack');
    assert.ok(opts.spawns.length >= 3);
    assert.ok(opts.waypoints.length >= 2);
    assert.ok(opts.maxTicks > 0 || opts.frames > 0);

    // Caller overrides win
    const overridden = applyScenario('choke_pack', {
        seed: 99,
        spawns: [{ creatureId: 'dummy', x: 1, y: 1, z: 7, respawn: 0 }]
    });
    assert.strictEqual(overridden.seed, 99);
    assert.strictEqual(overridden.spawns.length, 1);
    assert.strictEqual(overridden.spawns[0].creatureId, 'dummy');
    assert.strictEqual(overridden.huntId, 'outskirts_camp_fixed');

    // resolveHuntConfig accepts applied opts
    const resolved = resolveHuntConfig(opts);
    assert.ok(resolved.spawns.length >= 3);
    assert.ok(resolved.waypoints.length >= 2);
    assert.ok(resolved.parties.length >= 1);

    // Optional: generated legacy combat scenario (bulk dens scenario retired)
    if (hasMode('legacy')) {
        setActiveMode('legacy');
        const legOpts = applyScenario('legacy_cave_crawl');
        assert.strictEqual(legOpts.huntId, 'cave_crawl_generated');
        const legResolved = resolveHuntConfig(legOpts);
        assert.ok(
            legResolved.spawns.length >= 1,
            'legacy_cave_crawl resolves population spawns'
        );
        assert.ok(legResolved.floorLayers, 'generated layout floorLayers');
        assert.ok(
            !legResolved.hunt.spawnSourceSpec,
            'no dual-maintained dens spawnSource on generated scenario'
        );
        setActiveMode('standard');
    }

    // Inline object (no disk)
    const inline = scenarioToInput({
        id: 'inline',
        baseHuntId: 'cave_crawl_generated',
        seed: 3,
        spawns: [],
        waypoints: [{ x: 0, y: 3, z: 0 }]
    });
    assert.strictEqual(inline.scenarioId, 'inline');
    assert.strictEqual(inline.seed, 3);
    assert.deepStrictEqual(inline.spawns, []);

    log('applyScenario ok');
}

function testSettingsWhitelistAndRestore() {
    assert.ok(SCENARIO_SETTINGS_KEYS.has('AI_CREATURE_LEASH'));
    const prev = Settings.AI_CREATURE_LEASH;
    const leash = loadScenario('leash_test');
    assert.ok(leash.settings && leash.settings.AI_CREATURE_LEASH != null);

    const applied = applyScenario('leash_test');
    assert.ok(applied.scenarioSettings);
    assert.strictEqual(
        applied.scenarioSettings.AI_CREATURE_LEASH,
        leash.settings.AI_CREATURE_LEASH
    );

    const { runnerInput, scenarioSettings } = splitScenarioOpts(applied);
    assert.strictEqual(runnerInput.scenarioSettings, undefined);
    assert.ok(scenarioSettings);

    withScenarioSettings(scenarioSettings, () => {
        assert.strictEqual(
            Settings.AI_CREATURE_LEASH,
            leash.settings.AI_CREATURE_LEASH
        );
    });
    assert.strictEqual(
        Settings.AI_CREATURE_LEASH,
        prev,
        'Settings restored after withScenarioSettings'
    );

    // Unknown settings keys are ignored
    const only = applyScenario({
        id: 'tmp',
        baseHuntId: 'cave_crawl_generated',
        settings: { AI_CREATURE_LEASH: 4, NOT_A_REAL_KEY: 99 }
    });
    assert.strictEqual(only.scenarioSettings.AI_CREATURE_LEASH, 4);
    assert.strictEqual(only.scenarioSettings.NOT_A_REAL_KEY, undefined);

    log('settings whitelist/restore ok');
}

function testCacheInject() {
    setScenarioCache('unit_only', {
        id: 'unit_only',
        baseHuntId: 'cave_crawl_generated',
        waypoints: [{ x: 260, y: 96, z: 7 }],
        spawns: [{ creatureId: 'cave_rat', x: 261, y: 96, z: 7, respawn: 0 }]
    });
    assert.ok(listScenarioIds().indexOf('unit_only') >= 0);
    const o = applyScenario('unit_only');
    assert.strictEqual(o.spawns[0].creatureId, 'cave_rat');
    setScenarioCache('unit_only', null);
    assert.ok(listScenarioIds().indexOf('unit_only') < 0);
    clearScenarioCache();
    // disk scenarios still load after clear
    assert.ok(loadScenario('choke_pack').id === 'choke_pack');
    log('cache inject ok');
}

async function testChokeHeadless() {
    const summary = await runScenarioHunt('choke_pack', { seed: 1 });
    log('choke summary', {
        state: summary.sessionState,
        kills: summary.kills,
        dmg: summary.damageDealt,
        ticks: summary.tickCount
    });
    assert.ok(
        summary.sessionState === 'route_complete' ||
            summary.sessionState === 'party_wipe' ||
            summary.sessionState === 'timeout' ||
            summary.sessionState === 'kill_cap',
        `unexpected state ${summary.sessionState}`
    );
    assert.ok(
        summary.kills >= 1 || summary.damageDealt > 0,
        'choke_pack should produce combat'
    );
    assert.ok(!summary.partyWipe, 'default choke party should not wipe');
    log('choke headless ok');
}

async function testWipeHeadless() {
    const summary = await runScenarioHunt('wipe', { seed: 2 });
    log('wipe summary', {
        state: summary.sessionState,
        kills: summary.kills,
        deaths: summary.deaths,
        ticks: summary.tickCount
    });
    assert.strictEqual(summary.sessionState, 'party_wipe');
    assert.ok(summary.partyWipe);
    assert.ok(summary.deaths >= 1);
    assert.ok(summary.damageTaken > 0);
    log('wipe headless ok');
}

async function testLeashHeadlessState() {
    // Full headless summary is enough for end-state; also inspect mid-run aiState.
    const opts = applyScenario('leash_test', { seed: 5 });
    const { runnerInput, scenarioSettings } = splitScenarioOpts(opts);
    const resolved = resolveHuntConfig(runnerInput);

    const prevLeash = Settings.AI_CREATURE_LEASH;
    await withScenarioSettings(scenarioSettings, async () => {
        Settings.HEADLESS = true;
        const sim = new Simulator({
            seed: resolved.seed,
            floor: resolved.floor,
            floors: resolved.floors,
            floorLayers: resolved.floorLayers || null,
            floorFriction: resolved.floorFriction || null,
            combatAi: true,
            headless: true,
            parties: resolved.parties,
            spawns: resolved.spawns,
            waypoints: resolved.waypoints,
            maxTicks: resolved.maxTicks || 600
        });
        await sim.start();
        sim.active = true;

        let sawLeash = false;
        let sawAggro = false;
        const maxFrames = resolved.maxFrames || 600;
        for (let frame = 0; frame < maxFrames; frame++) {
            Time.advanceFixedLogicStep();
            sim.updateAll();
            const c = sim.creatures[0];
            if (c && c.alive) {
                if (c.aiState === 'leash') sawLeash = true;
                if (c.aiState === 'aggro' || c.aiState === 'attack') sawAggro = true;
            }
            if (
                sim.sessionState !== 'running' &&
                sim.sessionState !== 'idle'
            ) {
                break;
            }
        }

        const summary = sim.buildHuntSummary();
        log('leash mid-run', {
            sawLeash,
            sawAggro,
            state: summary.sessionState,
            kills: summary.kills,
            ticks: summary.tickCount,
            finalAi: sim.creatures[0] && sim.creatures[0].aiState
        });

        assert.ok(sawAggro, 'rat should aggro the walker');
        assert.ok(sawLeash, 'rat should enter leash under tight AI_CREATURE_LEASH');
        assert.ok(
            summary.sessionState === 'route_complete' ||
                summary.sessionState === 'timeout' ||
                summary.sessionState === 'party_wipe',
            `leash session ended: ${summary.sessionState}`
        );
        // Pacifist should not clear the rat for free in this short pull
        // (kills may still be 0)
        sim.destroy();
    });
    assert.strictEqual(
        Settings.AI_CREATURE_LEASH,
        prevLeash,
        'leash Settings restored after scenario run'
    );
    log('leash headless ok');
}

async function testLegacyCaveCrawlHeadless() {
    if (!hasMode('legacy')) return;
    setActiveMode('legacy');
    const opts = applyScenario('legacy_cave_crawl', { seed: 7 });
    const resolved = resolveHuntConfig(opts);
    assert.ok(resolved.spawns.length >= 1);
    assert.ok(resolved.floorLayers);

    const summary = await runScenarioHunt('legacy_cave_crawl', {
        seed: 7,
        frames: 800,
        maxTicks: 800
    });
    log('legacy_cave_crawl summary', {
        state: summary.sessionState,
        kills: summary.kills,
        dmg: summary.damageDealt,
        ticks: summary.tickCount,
        creaturesAlive: summary.creaturesAlive
    });
    assert.ok(
        summary.sessionState === 'route_complete' ||
            summary.sessionState === 'party_wipe' ||
            summary.sessionState === 'timeout' ||
            summary.sessionState === 'kill_cap',
        `unexpected state ${summary.sessionState}`
    );
    assert.ok(
        summary.kills >= 1 ||
            summary.damageDealt > 0 ||
            summary.damageTaken > 0 ||
            summary.tickCount >= 50,
        'legacy_cave_crawl should exercise generated spawn + combat path'
    );
    setActiveMode('standard');
    log('legacy_cave_crawl headless ok');
}

async function testDefaultSimUnchanged() {
    setActiveMode('standard');
    // No scenarioId / no applyScenario → cave_crawl_generated spawns stay the hunt default.
    const resolved = resolveHuntConfig({ seed: 42, huntId: 'cave_crawl_generated' });
    assert.strictEqual(resolved.huntId, 'cave_crawl_generated');
    assert.ok(resolved.spawns.length >= 1);
    // Generated hunt population count differs from choke pack of 5 at short WP end
    const choke = loadScenario('choke_pack');
    assert.notStrictEqual(
        resolved.spawns.length,
        choke.spawns.length,
        'default hunt spawn count should differ from choke_pack fixture'
    );

    const a = await runHeadlessHunt({
        seed: 42,
        huntId: 'cave_crawl_generated',
        frames: 200,
        maxTicks: 200
    });
    const b = await runHeadlessHunt({
        seed: 42,
        huntId: 'cave_crawl_generated',
        frames: 200,
        maxTicks: 200
    });
    assert.strictEqual(a.tickCount, b.tickCount);
    assert.strictEqual(a.kills, b.kills);
    assert.strictEqual(a.sessionState, b.sessionState);
    log('default sim unchanged ok', {
        state: a.sessionState,
        ticks: a.tickCount,
        kills: a.kills
    });
}

async function main() {
    log('=== Hunt scenarios (12G.2) ===');
    testListAndLoad();
    testApplyScenario();
    testSettingsWhitelistAndRestore();
    testCacheInject();
    await testChokeHeadless();
    await testWipeHeadless();
    await testLeashHeadlessState();
    await testLegacyCaveCrawlHeadless();
    await testDefaultSimUnchanged();
    console.log('hunt_scenarios: ok');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
