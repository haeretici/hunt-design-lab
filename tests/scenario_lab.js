#!/usr/bin/env node
/**
 * Stage 12G.2 Scenario Lab — pure session helpers (no DOM).
 * Quiet on success; VERBOSE=1 for detail.
 */

'use strict';

const { hasMode } = require('./helpers/modes.js');

const assert = require('assert');
const {
    normalizeScenarioForm,
    formDefaultsForScenario,
    buildScenarioSimulatorOpts,
    partySummaryFromResolved
} = require('../kernel/apps/scenario-lab/session.js');
const {
    openScenarioSettings,
    listScenarioCatalog,
    listScenarioIds
} = require('../kernel/core/lib/hunt_scenarios.js');
const {
    buildPresetInjectors
} = require('../kernel/apps/game/presets_loader.js');
const { setActiveMode } = require('../kernel/core/lib/modes.js');
const { Settings } = require('../kernel/settings.js');
const { Simulator } = require('../kernel/providers/simulator/simulator.js');
const { Time } = require('../kernel/core/lib/time.js');

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

async function main() {
    test('standard mode has AI scenario fixtures', () => {
        setActiveMode('standard');
        const ids = listScenarioIds();
        assert.ok(ids.indexOf('standard_cave_crawl') >= 0);
        assert.ok(ids.indexOf('choke_pack') >= 0);
        assert.ok(ids.indexOf('leash_test') >= 0);
        assert.ok(ids.indexOf('wipe') >= 0);
    });

    test('optional legacy mode has generated crawl fixture', () => {
        if (!hasMode('legacy')) return;
        setActiveMode('legacy');
        const ids = listScenarioIds();
        assert.ok(ids.indexOf('legacy_cave_crawl') >= 0);
        setActiveMode('standard');
    });

    test('listScenarioCatalog returns meta with optionKeys', () => {
        setActiveMode('standard');
        const cat = listScenarioCatalog(['choke_pack', 'leash_test', 'wipe']);
        assert.strictEqual(cat.length, 3);
        const leash = cat.find((c) => c.id === 'leash_test');
        assert.ok(leash);
        assert.ok(leash.label);
        assert.ok(leash.settings && leash.settings.AI_CREATURE_LEASH === 2);
        assert.ok(leash.optionKeys.indexOf('AI_CREATURE_LEASH') >= 0);

        if (hasMode('legacy')) {
            setActiveMode('legacy');
            const crawlCat = listScenarioCatalog(['legacy_cave_crawl']);
            const crawl = crawlCat.find((c) => c.id === 'legacy_cave_crawl');
            assert.ok(crawl);
            assert.strictEqual(crawl.baseHuntId, 'cave_crawl_generated');
            setActiveMode('standard');
        }
    });

    test('normalizeScenarioForm defaults and coerces', () => {
        const a = normalizeScenarioForm({});
        assert.strictEqual(a.scenarioId, 'choke_pack');
        assert.strictEqual(a.seed, 1);

        const b = normalizeScenarioForm({
            scenarioId: ' wipe ',
            seed: '42',
            settings: { AI_CREATURE_LEASH: '3', NOT_A_KEY: 99 }
        });
        assert.strictEqual(b.scenarioId, 'wipe');
        assert.strictEqual(b.seed, 42);
        assert.ok(b.settings);
        assert.strictEqual(b.settings.AI_CREATURE_LEASH, 3);
        assert.strictEqual(b.settings.NOT_A_KEY, undefined);
    });

    test('formDefaultsForScenario seeds leash settings', () => {
        setActiveMode('standard');
        const d = formDefaultsForScenario('leash_test');
        assert.strictEqual(d.scenarioId, 'leash_test');
        assert.strictEqual(d.seed, 5);
        assert.strictEqual(d.settings.AI_CREATURE_LEASH, 2);
    });

    test('buildScenarioSimulatorOpts wires choke pack', () => {
        setActiveMode('standard');
        const injectors = buildPresetInjectors();
        const built = buildScenarioSimulatorOpts(
            { scenarioId: 'choke_pack', seed: 7 },
            injectors,
            null
        );
        assert.strictEqual(built.simOpts.seed, 7);
        assert.ok(built.simOpts.spawns.length >= 3);
        assert.ok(built.simOpts.parties && built.simOpts.parties[0]);
        assert.ok(
            built.simOpts.waypoints || built.simOpts.parties[0].waypoints
        );
        // Generator-owned fixed shell: friction from layout, not hand path PNG.
        assert.ok(
            built.simOpts.floorLayers || built.simOpts.floorFriction,
            'choke_pack uses generated layout friction'
        );
        assert.strictEqual(built.scenarioSettings, null);
        assert.strictEqual(built.meta.id, 'choke_pack');
    });

    test('buildScenarioSimulatorOpts applies UI settings override', () => {
        const injectors = buildPresetInjectors();
        const built = buildScenarioSimulatorOpts(
            {
                scenarioId: 'leash_test',
                seed: 5,
                settings: { AI_CREATURE_LEASH: 4 }
            },
            injectors,
            null
        );
        assert.ok(built.scenarioSettings);
        assert.strictEqual(built.scenarioSettings.AI_CREATURE_LEASH, 4);
        const party = partySummaryFromResolved(built.resolved);
        assert.ok(party.length >= 1);
        assert.strictEqual(party[0].strategyId, 'pacifist');
    });

    test('inventory_sandbox form members keep inventorySandbox flag', () => {
        setActiveMode('standard');
        const injectors = buildPresetInjectors();
        const defaults = formDefaultsForScenario('inventory_sandbox');
        assert.ok(
            Array.isArray(defaults.members) && defaults.members.length >= 1,
            'fixture exposes members'
        );
        assert.strictEqual(defaults.members[0].inventorySandbox, true);

        // UI always sends form members; merge must re-attach inventorySandbox
        const formMembers = [
            {
                enabled: true,
                name: 'Pack Tester',
                classId: 'guardian',
                profileId: 'guardian_starter',
                level: 50,
                isLeader: true,
                equipment: {},
                strategyId: 'guardian_aggro'
            }
        ];
        const built = buildScenarioSimulatorOpts(
            {
                scenarioId: 'inventory_sandbox',
                seed: 1,
                members: formMembers
            },
            injectors,
            null
        );
        const party =
            built.simOpts.parties && built.simOpts.parties[0]
                ? built.simOpts.parties[0]
                : null;
        assert.ok(party && party.members && party.members[0]);
        assert.strictEqual(
            party.members[0].inventorySandbox,
            true,
            'sandbox flag must survive form party override'
        );
    });

    test('openScenarioSettings restores Settings', () => {
        const prev = Settings.AI_CREATURE_LEASH;
        const restore = openScenarioSettings({ AI_CREATURE_LEASH: 2 });
        assert.strictEqual(Settings.AI_CREATURE_LEASH, 2);
        restore();
        assert.strictEqual(Settings.AI_CREATURE_LEASH, prev);
        restore(); // idempotent
        assert.strictEqual(Settings.AI_CREATURE_LEASH, prev);
    });

    await testAsync('browser-shaped choke pack sim runs short combat', async () => {
        const injectors = buildPresetInjectors();
        const built = buildScenarioSimulatorOpts(
            { scenarioId: 'choke_pack', seed: 1 },
            injectors,
            null
        );
        const sim = new Simulator(built.simOpts);
        await sim.start();
        sim.active = true;
        for (let i = 0; i < 200; i++) {
            Time.advanceFixedLogicStep();
            sim.updateAll();
            if (
                sim.sessionState !== 'running' &&
                sim.sessionState !== 'idle'
            ) {
                break;
            }
        }
        const kills = (sim.telemetry && sim.telemetry.kills) || 0;
        assert.ok(kills >= 1, `expected kills, got ${kills}`);
        log('choke short run', {
            kills,
            state: sim.sessionState,
            ticks: sim.tickCount
        });
    });

    await testAsync('wipe fixture reaches party_wipe', async () => {
        const injectors = buildPresetInjectors();
        const built = buildScenarioSimulatorOpts(
            { scenarioId: 'wipe', seed: 2 },
            injectors,
            null
        );
        const sim = new Simulator(built.simOpts);
        await sim.start();
        sim.active = true;
        for (let i = 0; i < 800; i++) {
            Time.advanceFixedLogicStep();
            sim.updateAll();
            if (sim.sessionState === 'party_wipe') break;
        }
        assert.strictEqual(sim.sessionState, 'party_wipe');
        log('wipe ok', { ticks: sim.tickCount });
    });

    if (failed > 0) {
        console.error(`scenario_lab: ${failed} failed, ${passed} passed`);
        process.exit(1);
    }
    console.log(`scenario_lab: ${passed} passed`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
