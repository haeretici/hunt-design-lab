/**
 * Stage 7 — pure Hunt UI helpers (party form, live panel snapshot).
 * Quiet by default; VERBOSE=1 for detail.
 */

'use strict';

const { hasMode } = require('./helpers/modes.js');

const assert = require('assert');
const path = require('path');
const {
    setPresetCache,
    clearPresetCache,
    loadHunt
} = require('../kernel/core/lib/presets.js');
const {
    MAX_PARTY_SLOTS,
    partyFormFromHunt,
    partyFormFromPartyId,
    membersToPartyConfig,
    buildSimulatorOpts,
    normalizeMember,
    ensureSingleLeader,
    leaderFormSlot,
    resolveActiveViewSlot,
    enabledMemberIndexForSlot,
    collectPrefsState,
    applyPrefsState,
    defaultStrategyForClass
} = require('../kernel/apps/game/party_form.js');
const { loadParty } = require('../kernel/core/lib/presets.js');
const {
    ratePerHour,
    fmtNum,
    formatWaveHud,
    formatPartyFloors,
    formatFloorHopLog,
    snapshotFromSim,
    renderLivePanel,
    renderPartyDetailsHtml,
    sortedCountEntries
} = require('../kernel/apps/game/live_panel.js');
const {
    buildBugReportPayload,
    bugReportToRunnerInput,
    BUG_REPORT_SCHEMA_VERSION
} = require('../kernel/apps/game/bug_report.js');
const {
    equipmentToDesignerSlots,
    buildPreviewProfile,
    getActivePlayerFromSim,
    listActiveStatusIcons,
    statusIconsSignature,
    buildEquipmentItemDetailHtml
} = require('../kernel/apps/game/equipment_panel.js');
const {
    huntToSimulatorOpts,
    isSessionTerminal,
    SIMULATOR_HUNT_FIELD_KEYS
} = require('../kernel/providers/simulator/hunt_opts.js');
const { isLevelFrozen } = require('../kernel/engine.js');
const { Simulator } = require('../kernel/providers/simulator/simulator.js');
const { Time } = require('../kernel/core/lib/time.js');
const { Settings, ROOT } = require('../kernel/settings.js');

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

// --- party form ---

test('defaultStrategyForClass maps known classes', () => {
    assert.strictEqual(defaultStrategyForClass('guardian'), 'guardian_aggro');
    assert.strictEqual(defaultStrategyForClass('scout'), 'scout_kite');
    assert.strictEqual(defaultStrategyForClass('unknown_x'), 'balanced');
});

test('partyFormFromPartyId pads to MAX_PARTY_SLOTS', () => {
    const form = partyFormFromPartyId('test_cave_duo', { loadParty });
    assert.strictEqual(form.members.length, MAX_PARTY_SLOTS);
    assert.strictEqual(form.partyId, 'test_cave_duo');
    assert.ok(form.members[0].enabled);
    assert.ok(form.members[0].isLeader);
    assert.strictEqual(form.members[0].classId, 'guardian');
    assert.ok(form.members[1].enabled);
    assert.strictEqual(form.members[1].classId, 'scout');
    assert.strictEqual(form.members[2].enabled, false);
});

test('membersToPartyConfig drops disabled and keeps one leader', () => {
    const form = partyFormFromPartyId('test_cave_duo', { loadParty });
    form.members[1].enabled = false;
    form.members[0].isLeader = false;
    form.members[1].isLeader = true; // disabled leader
    const cfg = membersToPartyConfig(form.members);
    assert.strictEqual(cfg.length, 1);
    assert.strictEqual(cfg[0].classId, 'guardian');
    assert.strictEqual(cfg[0].isLeader, true);
    assert.ok(cfg[0].equipment.rightHand);
});

test('normalizeMember maps designer profile slots to engine slots', () => {
    const m = normalizeMember(
        {
            enabled: true,
            name: 'Tank',
            classId: 'guardian',
            isLeader: true,
            equipment: {
                head: 'steel_casque',
                chest: 'plate_armor',
                weapon: 'jagged_sword',
                shield: 'plate_shield'
            }
        },
        0
    );
    assert.strictEqual(m.equipment.helmet, 'steel_casque');
    assert.strictEqual(m.equipment.armor, 'plate_armor');
    assert.strictEqual(m.equipment.rightHand, 'jagged_sword');
    assert.strictEqual(m.equipment.leftHand, 'plate_shield');
    assert.strictEqual(m.equipment.head, undefined);
    assert.strictEqual(m.equipment.weapon, undefined);

    const cfg = membersToPartyConfig([m]);
    assert.strictEqual(cfg[0].equipment.rightHand, 'jagged_sword');
    assert.strictEqual(cfg[0].equipment.leftHand, 'plate_shield');
});

test('normalizeMember expands profileId when loader provided', () => {
    const m = normalizeMember(
        {
            enabled: true,
            profileId: 'guardian_starter',
            name: 'Guardian Tank',
            isLeader: true
        },
        0,
        {
            loadPlayerProfile: () => ({
                id: 'guardian_starter',
                vocation: 'guardian',
                level: 50,
                strategyId: 'guardian_aggro',
                skills: {
                    sword: 60,
                    shielding: 50,
                    magicLevel: 0,
                    distance: 10
                },
                equipment: {
                    head: 'steel_casque',
                    weapon: 'jagged_sword',
                    shield: 'plate_shield'
                }
            })
        }
    );
    assert.strictEqual(m.classId, 'guardian');
    assert.strictEqual(m.equipment.helmet, 'steel_casque');
    assert.strictEqual(m.equipment.rightHand, 'jagged_sword');
    assert.strictEqual(m.equipment.leftHand, 'plate_shield');
    assert.strictEqual(m.profileId, 'guardian_starter');
    assert.ok(m.skills, 'profile skills stay on form row');
    assert.strictEqual(m.skills.sword, 60);
    const cfg = membersToPartyConfig([m]);
    assert.ok(cfg[0].skills, 'skills reach simulator party config');
    assert.strictEqual(cfg[0].skills.sword, 60);
    assert.strictEqual(cfg[0].profileId, 'guardian_starter');
});

test('balance_quartet form path carries profile skills (UI/headless parity)', () => {
    const form = partyFormFromPartyId('balance_quartet', { loadParty });
    const adept = form.members.find((m) => m.classId === 'adept');
    assert.ok(adept, 'adept slot present');
    assert.ok(adept.skills, 'adept has profile skills on form');
    assert.strictEqual(
        adept.skills.magicLevel,
        40,
        'profile magicLevel 40 (not class magic 80)'
    );
    const cfg = membersToPartyConfig(form.members);
    const adeptCfg = cfg.find((m) => m.classId === 'adept');
    assert.ok(adeptCfg && adeptCfg.skills);
    assert.strictEqual(adeptCfg.skills.magicLevel, 40);
});

test('buildSimulatorOpts wires combat hunt', () => {
    const hunt = loadHunt('cave_crawl_generated', { seed: 42 });
    const form = partyFormFromHunt(hunt);
    const opts = buildSimulatorOpts({
        seed: 42,
        hunt,
        huntId: 'cave_crawl_generated',
        members: form.members,
        mapPath: '/maps/x.png'
    });
    assert.strictEqual(opts.seed, 42);
    assert.strictEqual(opts.combatAi, true);
    assert.strictEqual(opts.floor, 0);
    assert.strictEqual(opts.mapPath, '/maps/x.png');
    assert.ok(opts.spawns.length >= 1);
    assert.strictEqual(opts.parties.length, 1);
    assert.ok(opts.parties[0].members.length >= 1);
    assert.ok(opts.parties[0].waypoints.length >= 2);
    assert.strictEqual(opts.waves, null);
    // Product path: no parityTrace unless explicitly requested (browser:parity)
    assert.strictEqual(opts.parityTrace, undefined);
});

test('buildSimulatorOpts forwards parityTrace for browser:parity', () => {
    const hunt = loadHunt('cave_crawl_generated', { seed: 42 });
    const form = partyFormFromHunt(hunt);
    const on = buildSimulatorOpts({
        seed: 42,
        hunt,
        huntId: 'cave_crawl_generated',
        members: form.members,
        parityTrace: true
    });
    assert.strictEqual(on.parityTrace, true);
    const fixed = buildSimulatorOpts({
        seed: 42,
        hunt,
        huntId: 'cave_crawl_generated',
        members: form.members,
        parityTrace: { fromTick: 10, toTick: 12 }
    });
    assert.deepStrictEqual(fixed.parityTrace, { fromTick: 10, toTick: 12 });
});

test('buildSimulatorOpts forwards sequential waves (arena)', () => {
    const { setActiveMode, getActiveModeId } = require('../kernel/core/lib/modes.js');
    const prev = getActiveModeId();
    setActiveMode('standard');
    try {
        const hunt = loadHunt('standard_arena_waves', { seed: 1 });
        assert.ok(hunt.waves, 'hunt defines waves');
        const form = partyFormFromHunt(hunt);
        const opts = buildSimulatorOpts({
            seed: 1,
            hunt,
            huntId: 'standard_arena_waves',
            members: form.members,
            mapPath: null
        });
        assert.ok(opts.waves, 'waves reach Simulator opts');
        const list = opts.waves.list || opts.waves;
        assert.ok(Array.isArray(list) ? list.length >= 4 : true);
        // Wave arena has no flat spawn table — party still patrols
        assert.ok(opts.parties[0].waypoints.length >= 2);
    } finally {
        setActiveMode(prev || 'standard');
    }
});

test('buildSimulatorOpts parity with headless resolve (multifloor fields)', () => {
    const { setActiveMode, getActiveModeId } = require('../kernel/core/lib/modes.js');
    const { resolveHuntConfig } = require('../kernel/providers/simulator/headless_runner.js');
    const prev = getActiveModeId();
    setActiveMode('standard');
    try {
        const seed = 11;
        const headless = resolveHuntConfig({
            seed,
            huntId: 'cave_crawl_multifloor'
        });
        const hunt = loadHunt('cave_crawl_multifloor', { seed });
        const form = partyFormFromHunt(hunt);
        const browser = buildSimulatorOpts({
            seed,
            hunt,
            huntId: 'cave_crawl_multifloor',
            members: form.members,
            mapPath: null
        });
        // Simulator-facing fields must not be silently dropped by the UI builder
        const required = [
            'stairLinks',
            'navmeshData',
            'layoutMeta',
            'floorMeta',
            'pacingBudget',
            'artLayers',
            'floorLayers'
        ];
        for (const key of required) {
            const hHas =
                headless[key] != null &&
                !(Array.isArray(headless[key]) && !headless[key].length);
            if (!hHas) continue;
            assert.ok(
                browser[key] != null &&
                    !(Array.isArray(browser[key]) && !browser[key].length),
                `browser opts missing ${key} (headless has it)`
            );
        }
        assert.ok(
            Array.isArray(browser.stairLinks) && browser.stairLinks.length >= 1,
            'stairLinks on browser opts'
        );
        assert.ok(
            browser.parties[0].stairLinks &&
                browser.parties[0].stairLinks.length >= 1,
            'stairLinks on party config'
        );
    } finally {
        setActiveMode(prev || 'standard');
    }
});

/**
 * docs/25 root cause: browser catalog must keep RAW hunt JSON under
 * hunts/*.json. Caching seed-1 expanded snapshots then re-expanding with the
 * session seed corrupts multi-biome z1/z2 packs (Witches vs Manta Rays) while
 * z0 and session LCG can still match through first hop.
 */
test('rising_pressure_macro: raw hunt cache + session seed matches pure expand', () => {
    const fs = require('fs');
    const {
        expandHuntDefinition,
        getPresetsDir
    } = require('../kernel/core/lib/presets.js');
    const { setActiveMode, getActiveModeId } = require('../kernel/core/lib/modes.js');
    const prev = getActiveModeId();
    setActiveMode('standard');
    try {
        const seed = 42;
        const rawPath = path.join(
            getPresetsDir(),
            'hunts',
            'rising_pressure_macro.json'
        );
        const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
        assert.ok(!Array.isArray(raw.spawns) || !raw.spawns.length, 'raw has no spawns');

        clearPresetCache();
        setPresetCache('hunts/rising_pressure_macro.json', raw);
        const pure = loadHunt('rising_pressure_macro', { seed });

        // Old browser bug: catalog wrote seed-1 expanded over raw.
        const expandedSeed1 = expandHuntDefinition(raw, { seed: 1 });
        assert.ok(
            Array.isArray(expandedSeed1.spawns) && expandedSeed1.spawns.length,
            'seed-1 expand produces spawns'
        );
        setPresetCache('hunts/rising_pressure_macro.json', expandedSeed1);
        const corrupt = loadHunt('rising_pressure_macro', { seed });

        const spawnKey = (s) =>
            `${s.creatureId || s.name}@${s.x},${s.y},z${s.z != null ? s.z : 0}`;
        const byZ = (spawns, z) =>
            (spawns || [])
                .filter((s) => String(s.z != null ? s.z : 0) === String(z))
                .map(spawnKey)
                .sort();

        assert.notDeepStrictEqual(
            byZ(corrupt.spawns, 1),
            byZ(pure.spawns, 1),
            're-expand of seed-1 snapshot corrupts z1 (documents the bug)'
        );

        // Fixed contract: cache stays raw → session expand matches pure.
        setPresetCache('hunts/rising_pressure_macro.json', raw);
        const fixed = loadHunt('rising_pressure_macro', { seed });
        assert.deepStrictEqual(
            byZ(fixed.spawns, 0),
            byZ(pure.spawns, 0),
            'z0 spawns'
        );
        assert.deepStrictEqual(
            byZ(fixed.spawns, 1),
            byZ(pure.spawns, 1),
            'z1 spawns'
        );
        assert.deepStrictEqual(
            byZ(fixed.spawns, 2),
            byZ(pure.spawns, 2),
            'z2 spawns'
        );
        assert.strictEqual(
            (fixed.spawns || []).length,
            (pure.spawns || []).length,
            'total spawn count'
        );
        // Live parity log fingerprint for seed 42 z1 (headless canonical).
        assert.ok(
            byZ(fixed.spawns, 1).some((k) => k.startsWith('manta_ray@')),
            'z1 includes manta_ray (not witch re-expand garbage)'
        );
        assert.ok(
            !byZ(fixed.spawns, 1).some((k) => k.startsWith('witch@')),
            'z1 has no witch from corrupt re-expand'
        );
    } finally {
        clearPresetCache();
        setActiveMode(prev || 'standard');
    }
});

/**
 * docs/25 P0 guard: I5 rising_pressure_macro seed 42 browser builder must keep
 * multi-z spawns / stairs / layers that headless resolve provides. Structural
 * only (fast). Outcome parity runs in the integration section below.
 */
test('rising_pressure_macro seed 42 browser opts keep multi-z parity', () => {
    const { setActiveMode, getActiveModeId } = require('../kernel/core/lib/modes.js');
    const { resolveHuntConfig } = require('../kernel/providers/simulator/headless_runner.js');
    const prev = getActiveModeId();
    setActiveMode('standard');
    try {
        const seed = 42;
        const headless = resolveHuntConfig({
            seed,
            huntId: 'rising_pressure_macro',
            partyId: 'rising_pressure_duo'
        });
        const hunt = loadHunt('rising_pressure_macro', { seed });
        const form = partyFormFromPartyId('rising_pressure_duo');
        const members = form.members.filter((m) => m.enabled !== false);
        const browser = buildSimulatorOpts({
            seed,
            hunt,
            huntId: 'rising_pressure_macro',
            partyId: 'rising_pressure_duo',
            members,
            mapPath: null
        });

        assert.deepStrictEqual(browser.floors, headless.floors, 'floors');
        assert.strictEqual(
            (browser.spawns || []).length,
            (headless.spawns || []).length,
            'spawn count'
        );
        const zCount = (spawns) => {
            const m = Object.create(null);
            for (let i = 0; i < (spawns || []).length; i++) {
                const z = String(
                    spawns[i].z != null ? spawns[i].z : 0
                );
                m[z] = (m[z] || 0) + 1;
            }
            return m;
        };
        assert.deepStrictEqual(
            zCount(browser.spawns),
            zCount(headless.spawns),
            'spawns by z'
        );
        assert.ok(
            Array.isArray(browser.stairLinks) && browser.stairLinks.length >= 2,
            'stairLinks'
        );
        assert.deepStrictEqual(
            browser.stairLinks,
            headless.stairLinks,
            'stairLinks deep'
        );
        for (const z of ['0', '1', '2']) {
            assert.ok(
                browser.floorLayers && browser.floorLayers[z],
                `floorLayers[${z}]`
            );
            assert.ok(
                browser.artLayers && browser.artLayers[z],
                `artLayers[${z}]`
            );
        }
        assert.strictEqual(browser.spawnMode, 'eager');
        assert.ok(
            browser.maxTicks != null && browser.maxTicks >= 3600,
            'maxTicks derived from maxSeconds'
        );
        assert.strictEqual(
            JSON.stringify(browser.parties[0].waypoints),
            JSON.stringify(headless.parties[0].waypoints),
            'waypoints'
        );
    } finally {
        setActiveMode(prev || 'standard');
    }
});

test('huntToSimulatorOpts is the shared map for headless resolve', () => {
    const { resolveHuntConfig } = require('../kernel/providers/simulator/headless_runner.js');
    const resolved = resolveHuntConfig({
        seed: 7,
        huntId: 'cave_crawl_generated'
    });
    const opts = huntToSimulatorOpts(resolved, { combatAi: true });
    for (const key of SIMULATOR_HUNT_FIELD_KEYS) {
        if (key === 'mapPath' || key === 'mapPaths') continue;
        if (resolved[key] == null) continue;
        if (Array.isArray(resolved[key]) && !resolved[key].length) continue;
        assert.ok(
            opts[key] != null || opts[key] === resolved[key],
            `huntToSimulatorOpts dropped ${key}`
        );
    }
    assert.strictEqual(opts.combatAi, true);
    assert.strictEqual(opts.seed, 7);
    assert.ok(Array.isArray(opts.spawns));
    assert.ok(Array.isArray(opts.parties) && opts.parties.length >= 1);
});

test('browser buildSimulatorOpts matches huntToSimulatorOpts field set', () => {
    const hunt = loadHunt('cave_crawl_generated', { seed: 3 });
    const form = partyFormFromHunt(hunt);
    const browser = buildSimulatorOpts({
        seed: 3,
        hunt,
        huntId: 'cave_crawl_generated',
        members: form.members,
        mapPath: null
    });
    // Same keys the shared helper always emits for Simulator
    for (const key of [
        'seed',
        'floor',
        'spawns',
        'parties',
        'waves',
        'stairLinks',
        'navmeshData',
        'layoutMeta',
        'floorMeta',
        'pacingBudget',
        'combatAi'
    ]) {
        assert.ok(Object.prototype.hasOwnProperty.call(browser, key), key);
    }
    assert.strictEqual(browser.combatAi, true);
});

test('isSessionTerminal + isLevelFrozen for session-end freeze', () => {
    assert.strictEqual(isSessionTerminal('running'), false);
    assert.strictEqual(isSessionTerminal('idle'), false);
    assert.strictEqual(isSessionTerminal('route_complete'), true);
    assert.strictEqual(isSessionTerminal('party_wipe'), true);
    assert.strictEqual(isSessionTerminal('waves_complete'), true);
    assert.strictEqual(isSessionTerminal('timeout'), true);
    assert.strictEqual(isSessionTerminal(null), false);

    assert.strictEqual(isLevelFrozen(null), false);
    assert.strictEqual(
        isLevelFrozen({ sessionState: 'running' }),
        false
    );
    assert.strictEqual(
        isLevelFrozen({ sessionState: 'route_complete' }),
        true
    );
    assert.strictEqual(
        isLevelFrozen({
            sessionState: 'route_complete',
            _seekInProgress: true
        }),
        false,
        'seek must not freeze mid-reseed'
    );
});

test('formatWaveHud shows index/total and phase', () => {
    assert.strictEqual(formatWaveHud(null), null);
    assert.strictEqual(formatWaveHud({ totalWaves: 0 }), null);
    const line = formatWaveHud({
        phase: 'active',
        waveIndex: 1,
        wavesCompleted: 1,
        totalWaves: 6,
        waveLabel: 'Elite'
    });
    assert.ok(/2\/6/.test(line), line);
    assert.ok(/active/.test(line), line);
    assert.ok(/Elite/.test(line), line);
});

test('buildSimulatorOpts passes generated floorFriction (11.4/11.5)', () => {
    const hunt = loadHunt('outskirts_camp_fixed', { seed: 1 });
    assert.ok(hunt.floorFriction && hunt.floorFriction.friction, 'hunt has friction');
    const form = partyFormFromHunt(hunt);
    const opts = buildSimulatorOpts({
        seed: 1,
        hunt,
        huntId: 'outskirts_camp_fixed',
        members: form.members,
        mapPath: null
    });
    assert.ok(opts.floorFriction, 'floorFriction forwarded');
    assert.strictEqual(opts.floorFriction.cols, hunt.floorFriction.cols);
    assert.ok(opts.floorFriction.friction);
    assert.ok(opts.parties[0].waypoints.length >= 2);
    assert.strictEqual(opts.parties[0].waypoints[0].x, 0);
    assert.strictEqual(opts.parties[0].waypoints[0].y, 3);
});

test('prefs round-trip preserves party loadout', () => {
    const hunt = loadHunt('cave_crawl_generated');
    const form = partyFormFromHunt(hunt);
    const blob = collectPrefsState({
        seed: '99',
        speed: 2.5,
        modeId: 'legacy',
        huntId: 'cave_crawl_generated',
        members: form.members,
        activeViewSlot: 0
    });
    const applied = applyPrefsState(blob, collectPrefsState({}));
    assert.strictEqual(applied.seed, '99');
    assert.strictEqual(applied.speed, 2.5);
    assert.strictEqual(applied.modeId, 'legacy');
    assert.strictEqual(applied.huntId, 'cave_crawl_generated');
    assert.strictEqual(applied.members[0].classId, 'guardian');
    assert.strictEqual(
        applied.members[0].equipment.rightHand,
        form.members[0].equipment.rightHand
    );
    assert.strictEqual(applied.activeViewSlot, 0);
});

test('prefs defaults include modeId standard', () => {
    const defaults = collectPrefsState({});
    assert.strictEqual(defaults.modeId, 'standard');
    assert.strictEqual(defaults.huntId, 'cave_crawl_generated');
    assert.strictEqual(
        defaults.activeViewSlot,
        leaderFormSlot(defaults.members)
    );
    const applied = applyPrefsState(
        { huntId: 'custom_hunt' },
        collectPrefsState({ modeId: 'standard' })
    );
    assert.strictEqual(applied.modeId, 'standard');
    assert.strictEqual(applied.huntId, 'custom_hunt');
});

test('prefs round-trip preserves activeViewSlot', () => {
    const members = [
        normalizeMember(
            { enabled: true, name: 'A', classId: 'guardian', isLeader: true },
            0
        ),
        normalizeMember(
            { enabled: true, name: 'B', classId: 'scout', isLeader: false },
            1
        ),
        normalizeMember(
            { enabled: false, name: 'C', classId: 'mystic', isLeader: false },
            2
        ),
        normalizeMember(
            { enabled: true, name: 'D', classId: 'adept', isLeader: false },
            3
        )
    ];
    ensureSingleLeader(members);
    const blob = collectPrefsState({
        members,
        activeViewSlot: 1
    });
    assert.strictEqual(blob.activeViewSlot, 1);
    const applied = applyPrefsState(blob, collectPrefsState({}));
    assert.strictEqual(applied.activeViewSlot, 1);

    // Disabled preferred slot → leader
    assert.strictEqual(resolveActiveViewSlot(members, 2), 0);
    const fallen = applyPrefsState(
        { members, activeViewSlot: 2 },
        collectPrefsState({ members })
    );
    assert.strictEqual(fallen.activeViewSlot, 0);

    // Legacy prefs without activeViewSlot → leader default
    const legacy = applyPrefsState(
        { members, seed: '1' },
        collectPrefsState({ members })
    );
    assert.strictEqual(legacy.activeViewSlot, leaderFormSlot(members));
});

test('ensureSingleLeader demotes extras', () => {
    const members = [
        normalizeMember({ enabled: true, isLeader: true, name: 'A' }, 0),
        normalizeMember({ enabled: true, isLeader: true, name: 'B' }, 1)
    ];
    ensureSingleLeader(members);
    assert.strictEqual(members[0].isLeader, true);
    assert.strictEqual(members[1].isLeader, false);
});

// --- live panel pure ---

test('equipmentToDesignerSlots maps engine gear to profile slots', () => {
    const eq = equipmentToDesignerSlots({
        helmet: 'steel_casque',
        rightHand: 'iron_longsword',
        leftHand: 'wooden_shield',
        boots: 'leather_boots'
    });
    assert.strictEqual(eq.head, 'steel_casque');
    assert.strictEqual(eq.weapon, 'iron_longsword');
    assert.strictEqual(eq.shield, 'wooden_shield');
    assert.strictEqual(eq.boots, 'leather_boots');
});

test('listActiveStatusIcons maps engine conditions to FA status strip', () => {
    const icons = listActiveStatusIcons({
        conditions: [
            { kind: 'poison', remainingDamage: 40 },
            { kind: 'fire', remainingDamage: 20 },
            { kind: 'slow', durationSec: 10, speedChange: -30 },
            { kind: 'haste', durationSec: 10, speedChange: 20 },
            // alias should normalize
            { kind: 'burning', remainingDamage: 5 },
            { type: 'paralyzed', durationSec: 3 }
        ]
    });
    const kinds = icons.map((i) => i.kind);
    assert.ok(kinds.indexOf('poison') >= 0);
    assert.ok(kinds.indexOf('fire') >= 0);
    assert.ok(kinds.indexOf('slow') >= 0);
    assert.ok(kinds.indexOf('haste') >= 0);
    // burning/paralyzed collapse into fire/slow (no duplicates)
    assert.strictEqual(kinds.filter((k) => k === 'fire').length, 1);
    assert.strictEqual(kinds.filter((k) => k === 'slow').length, 1);
    const slow = icons.find((i) => i.kind === 'slow');
    assert.strictEqual(slow.icon, 'fa-person-running');
    assert.strictEqual(
        statusIconsSignature({
            conditions: [
                { kind: 'poison' },
                { kind: 'fire' },
                { kind: 'slow' },
                { kind: 'haste' }
            ]
        }),
        'poison,fire,slow,haste'
    );
    assert.strictEqual(statusIconsSignature({ conditions: [] }), '');
    assert.strictEqual(listActiveStatusIcons(null).length, 0);
});

test('listActiveStatusIcons shows mana_shield from condition or gear flag', () => {
    const pooled = listActiveStatusIcons({
        conditions: [
            { kind: 'mana_shield', poolRemaining: 120, poolMax: 406 }
        ]
    });
    assert.strictEqual(pooled.length, 1);
    assert.strictEqual(pooled[0].kind, 'mana_shield');
    assert.strictEqual(pooled[0].icon, 'fa-shield-halved');
    assert.ok(
        String(pooled[0].title).indexOf('120 / 406') >= 0,
        'tooltip includes remaining / max'
    );
    const alias = listActiveStatusIcons({
        conditions: [{ type: 'manashield', poolRemaining: 10, poolMax: 10 }]
    });
    assert.strictEqual(alias[0].kind, 'mana_shield');
    const gear = listActiveStatusIcons({
        combatStats: { flags: { manaShield: true } }
    });
    assert.strictEqual(gear.length, 1);
    assert.strictEqual(gear[0].kind, 'mana_shield');
    assert.ok(
        String(gear[0].title).toLowerCase().indexOf('gear') >= 0,
        'gear tooltip marks unpooled'
    );
    assert.strictEqual(
        statusIconsSignature({
            conditions: [{ kind: 'haste' }, { kind: 'mana_shield' }]
        }),
        'haste,mana_shield'
    );
    // Card dirty signature stays kinds-only (pool remaining does not flicker slots).
    const kindsOnly = statusIconsSignature({
        conditions: [{ kind: 'mana_shield', poolRemaining: 50, poolMax: 406 }]
    });
    const kindsOnlyAfter = statusIconsSignature({
        conditions: [{ kind: 'mana_shield', poolRemaining: 10, poolMax: 406 }]
    });
    assert.strictEqual(kindsOnly, kindsOnlyAfter);
});

test('buildPreviewProfile exposes live vitals for profile preview popup', () => {
    const profile = buildPreviewProfile(
        {
            name: 'Guardian',
            classId: 'guardian',
            level: 90,
            equipment: { helmet: 'steel_casque', rightHand: 'iron_longsword' },
            hp: 800,
            hpMax: 1415,
            mp: 200,
            mpMax: 360,
            strategyId: 'guardian_aggro'
        },
        { live: true }
    );
    assert.ok(profile);
    assert.strictEqual(profile.label, 'Guardian');
    assert.strictEqual(profile.equipment.head, 'steel_casque');
    assert.strictEqual(profile.equipment.weapon, 'iron_longsword');
    assert.strictEqual(profile.hp, 800);
    assert.strictEqual(profile.hpMax, 1415);
    assert.strictEqual(profile.mp, 200);
    assert.strictEqual(profile.mpMax, 360);
    assert.ok(String(profile.notes || '').toLowerCase().includes('live'));
});

test('buildPreviewProfile reads nested Player entity vitals (hp.current/max)', () => {
    // Live sim entities use Creature-shaped bags, not flat hp/hpMax.
    const profile = buildPreviewProfile(
        {
            name: 'Scout',
            classId: 'scout',
            level: 80,
            equipment: { rightHand: 'composite_bow' },
            hp: { current: 412, max: 890 },
            mp: { current: 95, max: 220 }
        },
        { live: true }
    );
    assert.ok(profile);
    assert.strictEqual(profile.hp, 412);
    assert.strictEqual(profile.hpMax, 890);
    assert.strictEqual(profile.mp, 95);
    assert.strictEqual(profile.mpMax, 220);
});

test('getActivePlayerFromSim prefers camera focus member', () => {
    const scout = { name: 'Scout', classId: 'scout' };
    const guardian = { name: 'Guardian', classId: 'guardian', isLeader: true };
    const sim = {
        parties: [{ members: [guardian, scout] }],
        getCameraFocusMember() {
            return scout;
        }
    };
    assert.strictEqual(getActivePlayerFromSim(sim), scout);
});

test('ratePerHour and fmtNum', () => {
    assert.strictEqual(ratePerHour(100, 3600), 100);
    assert.strictEqual(ratePerHour(10, 0), 0);
    assert.strictEqual(fmtNum(3.7), '4');
    assert.strictEqual(fmtNum(1.25, 2), '1.25');
});

test('snapshotFromSim empty', () => {
    const snap = snapshotFromSim(null);
    assert.strictEqual(snap.sessionState, 'idle');
    assert.strictEqual(snap.kills, 0);
    assert.deepStrictEqual(snap.members, []);
    assert.strictEqual(snap.waveHud, null);
    assert.strictEqual(snap.terminal, false);
});

test('renderLivePanel shows per-member AutoAtk/h and position', () => {
    const memberList = { innerHTML: '' };
    renderLivePanel(
        { memberList },
        {
            sessionState: 'running',
            members: [
                {
                    name: 'Hero',
                    isLeader: true,
                    alive: true,
                    hp: 80,
                    hpMax: 100,
                    damageDealt: 12,
                    autoAttacks: 10,
                    autoAttacksPerHour: 1800,
                    aiState: 'engage',
                    x: 42,
                    y: 7,
                    z: 7
                },
                {
                    name: 'Mage',
                    isLeader: false,
                    alive: true,
                    hp: 50,
                    hpMax: 60,
                    damageDealt: 4,
                    autoAttacks: 5,
                    autoAttacksPerHour: 900,
                    aiState: 'engage',
                    x: 41,
                    y: 7,
                    z: 7
                }
            ]
        }
    );
    assert.ok(
        /engage · \(42,7,7\)/.test(memberList.innerHTML),
        'expected ai state followed by tile position'
    );
    assert.ok(
        /AutoAtk\/h 1800/.test(memberList.innerHTML),
        'expected Hero AutoAtk/h line'
    );
    assert.ok(
        /AutoAtk\/h 900/.test(memberList.innerHTML),
        'expected Mage AutoAtk/h line'
    );
});

test('formatPartyFloors + formatFloorHopLog for multi-floor panel', () => {
    assert.strictEqual(
        formatPartyFloors([
            { name: 'Guardian', z: 0 },
            { name: 'Scout', z: 1 }
        ]),
        'Guardian z0 · Scout z1'
    );
    assert.strictEqual(formatPartyFloors([]), '—');
    const text = formatFloorHopLog([
        {
            tick: 535,
            name: 'Scout',
            fromZ: 0,
            toZ: 1,
            x: 3,
            y: 4
        },
        {
            tick: 1540,
            name: 'Guardian',
            fromZ: 1,
            toZ: 2,
            x: 1,
            y: 2
        }
    ]);
    assert.ok(/t535 Scout z0→1 @3,4/.test(text), text);
    assert.ok(/t1540 Guardian z1→2 @1,2/.test(text), text);
});

test('renderLivePanel shows tick, floors, hop log', () => {
    const tick = { textContent: '' };
    const floors = { textContent: '' };
    const hopLog = { textContent: '' };
    const parityLog = { textContent: '' };
    renderLivePanel(
        { tick, floors, hopLog, parityLog },
        {
            sessionState: 'running',
            tickCount: 535,
            partyFloors: 'Guardian z0 · Scout z1',
            floorHopLogText: 't535 Scout z0→1 @3,4',
            parityTickLogText: 't536 | S@3,5,z1 ai=combat kills=12 draws+2',
            members: []
        }
    );
    assert.strictEqual(tick.textContent, '535');
    assert.strictEqual(floors.textContent, 'Guardian z0 · Scout z1');
    assert.strictEqual(hopLog.textContent, 't535 Scout z0→1 @3,4');
    assert.ok(/t536/.test(parityLog.textContent));
});

test('snapshotFromSim includes floorHopLog and partyFloors', () => {
    const snap = snapshotFromSim({
        sessionState: 'running',
        tickCount: 535,
        seed: 42,
        floorHopLog: [
            {
                tick: 535,
                name: 'Scout',
                fromZ: 0,
                toZ: 1,
                x: 3,
                y: 4
            }
        ],
        parityTickLog: [
            {
                t: 536,
                rng: 1,
                draws: 2,
                kills: 12,
                exp: 100,
                dmgOut: 4000,
                party: [
                    {
                        n: 'Guardian',
                        x: 8,
                        y: 3,
                        z: 0,
                        hp: 100,
                        ai: 'follow_waypoint',
                        dmg: 1000,
                        k: 5,
                        tgt: null,
                        tgtN: null
                    },
                    {
                        n: 'Scout',
                        x: 3,
                        y: 5,
                        z: 1,
                        hp: 90,
                        ai: 'combat',
                        dmg: 3000,
                        k: 12,
                        tgt: 9,
                        tgtN: 'rat'
                    }
                ],
                hostiles: [],
                atk: []
            }
        ],
        creatures: [],
        telemetry: {},
        getPartyPositions() {
            return [
                {
                    members: [
                        {
                            name: 'Guardian',
                            classId: 'guardian',
                            isLeader: true,
                            alive: true,
                            hp: 100,
                            hpMax: 100,
                            x: 2,
                            y: 3,
                            z: 0
                        },
                        {
                            name: 'Scout',
                            classId: 'scout',
                            isLeader: false,
                            alive: true,
                            hp: 90,
                            hpMax: 90,
                            x: 3,
                            y: 4,
                            z: 1
                        }
                    ]
                }
            ];
        }
    });
    assert.strictEqual(snap.tickCount, 535);
    assert.strictEqual(snap.partyFloors, 'Guardian z0 · Scout z1');
    assert.strictEqual(snap.floorHopLog.length, 1);
    assert.strictEqual(snap.floorHopLog[0].tick, 535);
    assert.ok(/t535 Scout z0→1/.test(snap.floorHopLogText));
    assert.strictEqual(snap.parityTickLog.length, 1);
    assert.ok(/t536/.test(snap.parityTickLogText));
    assert.ok(/S@3,5,z1/.test(snap.parityTickLogText));
});

test('renderLivePanel wave row toggles with waveHud', () => {
    const waveRow = { hidden: true };
    const wave = { textContent: '' };
    renderLivePanel(
        { waveRow, wave },
        {
            sessionState: 'running',
            waveHud: '2/6 · active · Pack B',
            members: []
        }
    );
    assert.strictEqual(waveRow.hidden, false);
    assert.strictEqual(wave.textContent, '2/6 · active · Pack B');
    renderLivePanel(
        { waveRow, wave },
        { sessionState: 'running', waveHud: null, members: [] }
    );
    assert.strictEqual(waveRow.hidden, true);
});

test('renderPartyDetailsHtml includes spell casts by id and kind', () => {
    const html = renderPartyDetailsHtml({
        tickCount: 40,
        manaSpent: 12,
        spellsCast: 3,
        autoAttacks: 10,
        hits: 9,
        attacks: 13,
        spellsCastByKind: { spell: 2, heal: 1, auto: 10 },
        members: [
            {
                name: 'Mage',
                classId: 'sorcerer',
                isLeader: true,
                alive: true,
                hp: 40,
                hpMax: 50,
                damageDealt: 20,
                damageTaken: 2,
                kills: 1,
                expGained: 100,
                autoAttacks: 4,
                autoAttacksPerHour: 720,
                spellsCast: 3,
                spellsCastPerHour: 540,
                manaSpent: 12,
                aiState: 'engage',
                x: 10,
                y: 12,
                z: 7,
                spellsCastById: { ember_bolt: 2, heal_light: 1, wand_auto: 4 },
                spellsCastByKind: { spell: 2, heal: 1, auto: 4 }
            }
        ]
    });
    assert.ok(/ember_bolt/.test(html), 'expected spell id in table');
    assert.ok(/heal_light/.test(html), 'expected heal spell id');
    assert.ok(/wand_auto/.test(html), 'expected auto id in by-spell table');
    assert.ok(/By kind/.test(html), 'expected kind section');
    assert.ok(/spell: 2/.test(html), 'expected kind counts');
    assert.ok(/Mage/.test(html), 'expected member name');
    assert.ok(/Spells<\/span> 3/.test(html), 'expected non-auto spell total');
});

test('sortedCountEntries orders by count desc', () => {
    const rows = sortedCountEntries({ a: 1, b: 5, c: 5, d: 0 });
    assert.deepStrictEqual(
        rows.map((r) => r.id),
        ['b', 'c', 'a']
    );
});

test('buildBugReportPayload captures seed, party gear, and repro map', () => {
    const report = buildBugReportPayload({
        description: 'Party walks into wall',
        source: 'hunt',
        modeId: 'standard',
        seed: 42,
        huntId: 'cave_crawl_generated',
        partyId: 'test_cave_duo',
        createdAt: '2026-01-01T00:00:00.000Z',
        userAgent: 'test',
        members: [
            {
                enabled: true,
                name: 'Tank',
                classId: 'guardian',
                strategyId: 'guardian_aggro',
                level: 55,
                isLeader: true,
                equipment: { rightHand: 'steel_sword', armor: 'chain_armor' }
            },
            {
                enabled: false,
                name: 'Off',
                classId: 'scout',
                strategyId: 'scout_kite',
                level: 40,
                isLeader: false,
                equipment: { rightHand: 'bow' }
            },
            {
                enabled: true,
                name: 'Healer',
                classId: 'warden',
                strategyId: 'warden_support',
                level: 50,
                isLeader: false,
                equipment: { rightHand: 'staff_oak' }
            }
        ],
        timeSpeed: 2
    });
    assert.strictEqual(report.schemaVersion, BUG_REPORT_SCHEMA_VERSION);
    assert.strictEqual(report.schemaVersion, 2);
    assert.strictEqual(report.description, 'Party walks into wall');
    assert.strictEqual(report.seed, 42);
    assert.strictEqual(report.huntId, 'cave_crawl_generated');
    assert.strictEqual(report.party.members.length, 2, 'disabled slot dropped');
    assert.strictEqual(report.party.members[0].name, 'Tank');
    assert.strictEqual(
        report.party.members[0].equipment.rightHand,
        'steel_sword'
    );
    assert.strictEqual(report.party.members[1].name, 'Healer');
    // Class-only form rows materialize default starters (create-char) before report
    assert.strictEqual(report.party.membersHaveSkills, true);
    assert.strictEqual(report.party.allMembersHaveSkills, true);
    assert.ok(report.party.members[0].skills, 'Tank bound to guardian_starter skills');
    assert.strictEqual(report.party.members[0].profileId, 'guardian_starter');
    assert.strictEqual(report.party.members[1].profileId, 'warden_starter');
    assert.strictEqual(report.party.memberCount, 2);
    assert.strictEqual(report.session.timeSpeed, 2);
    assert.ok(Array.isArray(report.session.topSpells));
    assert.ok(Array.isArray(report.session.liveMembers));
    assert.strictEqual(report.session.waves, null);
    assert.strictEqual(report.repro.runner, 'hunt');
    assert.strictEqual(report.repro.seed, 42);
    assert.ok(Array.isArray(report.repro.members));
    assert.strictEqual(
        report.repro.membersHaveSkills,
        undefined,
        'diagnostics stay off repro'
    );

    const mapped = bugReportToRunnerInput(report);
    assert.strictEqual(mapped.kind, 'hunt');
    assert.strictEqual(mapped.modeId, 'standard');
    assert.strictEqual(mapped.input.seed, 42);
    assert.strictEqual(mapped.input.huntId, 'cave_crawl_generated');
    assert.strictEqual(mapped.input.members.length, 2);
});

test('buildBugReportPayload v2 skills flags + live session snapshot', () => {
    const fakeSim = {
        seed: 42,
        huntId: 'standard_arena_waves',
        sessionState: 'party_wipe',
        tickCount: 1974,
        floor: 0,
        spawnMode: 'eager',
        maxTicks: 9600,
        creatures: [],
        telemetry: {
            endReason: 'party_wipe',
            kills: 71,
            deaths: 4,
            expGained: 1000,
            damageDealt: 17573,
            damageTaken: 2919,
            manaSpent: 1035,
            spellsCast: 141,
            spellsCastById: {
                rockfall: 68,
                grand_fireburst: 53,
                rampage: 2
            },
            spellsCastByKind: { spell: 127, auto: 70, heal: 5 },
            attacks: 10,
            hits: 8,
            autoAttacks: 70,
            waves: {
                phase: 'active',
                waveIndex: 8,
                waveId: 'wave_boss',
                waveLabel: 'Wave 9 — boss',
                wavesCompleted: 8,
                totalWaves: 9
            }
        },
        floorHopLog: [
            {
                tick: 535,
                name: 'Scout',
                fromZ: 0,
                toZ: 1,
                x: 3,
                y: 4
            }
        ],
        getPartyPositions() {
            return [
                {
                    members: [
                        {
                            name: 'Guardian',
                            classId: 'guardian',
                            isLeader: true,
                            alive: false,
                            hp: 0,
                            hpMax: 815,
                            kills: 10,
                            damageDealt: 1000,
                            damageTaken: 800,
                            spellsCast: 5,
                            spellsCastById: { rampage: 2, heal_light: 3 },
                            manaSpent: 50,
                            aiState: 'engage',
                            x: 10,
                            y: 12,
                            z: 2
                        },
                        {
                            name: 'Adept',
                            classId: 'adept',
                            isLeader: false,
                            alive: false,
                            hp: 0,
                            hpMax: 395,
                            kills: 30,
                            damageDealt: 5000,
                            damageTaken: 600,
                            spellsCast: 53,
                            spellsCastById: { grand_fireburst: 53 },
                            manaSpent: 400,
                            aiState: 'engage',
                            x: 11,
                            y: 12,
                            z: 2
                        }
                    ]
                }
            ];
        }
    };

    const report = buildBugReportPayload({
        description: 'Expected wipe on boss mid tier',
        source: 'hunt',
        modeId: 'standard',
        seed: 42,
        huntId: 'standard_arena_waves',
        partyId: 'balance_quartet',
        createdAt: '2026-07-31T00:00:00.000Z',
        userAgent: 'test',
        members: [
            {
                enabled: true,
                name: 'Guardian',
                classId: 'guardian',
                strategyId: 'guardian_aggro',
                level: 50,
                isLeader: true,
                profileId: 'guardian_starter',
                skills: { sword: 60, shielding: 50, magicLevel: 0 },
                equipment: { rightHand: 'iron_longsword' }
            },
            {
                enabled: true,
                name: 'Adept',
                classId: 'adept',
                strategyId: 'adept_caster',
                level: 50,
                isLeader: false,
                profileId: 'adept_starter',
                skills: { magicLevel: 40, sword: 30 },
                equipment: { rightHand: 'iron_longsword' }
            }
        ],
        sim: fakeSim,
        timeSpeed: 1
    });

    assert.strictEqual(report.schemaVersion, 2);
    assert.strictEqual(report.party.membersHaveSkills, true);
    assert.strictEqual(report.party.membersHaveProfileId, true);
    assert.strictEqual(report.party.allMembersHaveSkills, true);
    assert.strictEqual(report.party.membersWithSkills, 2);
    assert.ok(report.party.members[0].skills);
    assert.strictEqual(report.party.members[0].profileId, 'guardian_starter');

    assert.strictEqual(report.session.state, 'party_wipe');
    assert.strictEqual(report.session.endReason, 'party_wipe');
    assert.strictEqual(report.session.kills, 71);
    assert.ok(report.session.waves);
    assert.strictEqual(report.session.waves.waveId, 'wave_boss');
    assert.strictEqual(report.session.waves.wavesCompleted, 8);
    assert.strictEqual(report.session.waves.totalWaves, 9);
    assert.ok(report.session.waveHud);
    assert.deepStrictEqual(report.session.topSpells[0], ['rockfall', 68]);
    assert.strictEqual(report.session.liveMembers.length, 2);
    assert.strictEqual(report.session.liveMembers[0].alive, false);
    assert.strictEqual(report.session.liveMembers[0].hpMax, 815);
    assert.strictEqual(report.session.liveMembers[0].z, 2);
    assert.strictEqual(report.session.liveMembers[0].x, 10);
    assert.strictEqual(report.session.partyFloors, 'Guardian z2 · Adept z2');
    assert.ok(Array.isArray(report.session.floorHopLog));
    assert.strictEqual(report.session.floorHopLog[0].tick, 535);
    assert.strictEqual(report.session.floorHopLog[0].name, 'Scout');
    assert.ok(
        report.session.liveMembers[1].topSpells.some(
            (row) => row[0] === 'grand_fireburst' && row[1] === 53
        )
    );

    const mapped = bugReportToRunnerInput(report);
    assert.strictEqual(mapped.input.members[0].skills.sword, 60);
    assert.strictEqual(mapped.input.partyId, 'balance_quartet');
});

test('bugReportToRunnerInput maps schema 1 reports without v2 fields', () => {
    const legacy = {
        schemaVersion: 1,
        source: 'hunt',
        seed: 9,
        modeId: 'standard',
        huntId: 'cave_crawl_generated',
        partyId: 'starter_duo',
        party: {
            id: 'starter_duo',
            members: [
                {
                    name: 'A',
                    classId: 'guardian',
                    level: 50,
                    isLeader: true,
                    equipment: {}
                }
            ]
        },
        repro: {
            runner: 'hunt',
            seed: 9,
            modeId: 'standard',
            huntId: 'cave_crawl_generated',
            partyId: 'starter_duo',
            members: [
                {
                    name: 'A',
                    classId: 'guardian',
                    level: 50,
                    isLeader: true,
                    equipment: {}
                }
            ]
        }
    };
    const mapped = bugReportToRunnerInput(legacy);
    assert.strictEqual(mapped.kind, 'hunt');
    assert.strictEqual(mapped.input.seed, 9);
    assert.strictEqual(mapped.input.huntId, 'cave_crawl_generated');
    assert.strictEqual(mapped.input.members[0].classId, 'guardian');
});

test('bugReportToRunnerInput maps scenario source', () => {
    const report = buildBugReportPayload({
        description: 'Leash stuck',
        source: 'scenario',
        seed: 7,
        scenarioId: 'leash_test',
        partyId: 'starter_duo',
        members: [
            {
                enabled: true,
                name: 'Solo',
                classId: 'guardian',
                strategyId: 'guardian_aggro',
                level: 50,
                isLeader: true,
                equipment: {}
            }
        ],
        scenarioSettings: { AI_CREATURE_LEASH: 6 },
        createdAt: '2026-01-01T00:00:00.000Z',
        userAgent: 'test'
    });
    const mapped = bugReportToRunnerInput(report);
    assert.strictEqual(mapped.kind, 'scenario');
    assert.strictEqual(mapped.input.scenarioId, 'leash_test');
    assert.strictEqual(mapped.input.scenarioSettings.AI_CREATURE_LEASH, 6);
    assert.strictEqual(mapped.input.members[0].classId, 'guardian');
});

async function runIntegration() {
    await testAsync('browser opts start generated 11.4/11.5 hunts', async () => {
        Settings.HEADLESS = true;
        for (const huntId of ['outskirts_camp_fixed', 'cave_crawl_generated']) {
            const hunt = loadHunt(huntId, { seed: 1 });
            const form = partyFormFromHunt(hunt);
            // Mirror game app: no continent mapPath when friction present
            const opts = buildSimulatorOpts({
                seed: 1,
                hunt,
                huntId,
                members: form.members,
                mapPath: null
            });
            assert.ok(opts.floorFriction, `${huntId}: floorFriction required`);
            const sim = new Simulator(opts);
            await sim.start();
            assert.ok(sim.parties && sim.parties.length >= 1, `${huntId}: party spawned`);
            const leader = sim.parties[0].members && sim.parties[0].members[0];
            assert.ok(leader, `${huntId}: leader present`);
            assert.ok(leader.alive !== false, `${huntId}: leader alive`);
            sim.destroy();
        }
    });

    await testAsync('multi-floor cameraTileZ follows leader floor', async () => {
        const prevHeadless = Settings.HEADLESS;
        const prevCam = {
            x: Settings.cameraTileX,
            y: Settings.cameraTileY,
            z: Settings.cameraTileZ
        };
        try {
            // Camera update only runs when not HEADLESS
            Settings.HEADLESS = false;
            Settings.cameraTileX = null;
            Settings.cameraTileY = null;
            Settings.cameraTileZ = null;

            const hunt = loadHunt('cave_crawl_multifloor', { seed: 5 });
            assert.ok(
                hunt.floorLayers && Object.keys(hunt.floorLayers).length >= 2,
                'multifloor hunt needs 2+ layers'
            );
            const form = partyFormFromHunt(hunt);
            const opts = buildSimulatorOpts({
                seed: 5,
                hunt,
                huntId: 'cave_crawl_multifloor',
                members: form.members,
                mapPath: null
            });
            const sim = new Simulator(opts);
            await sim.start();
            const party = sim.parties[0];
            const leader = party.getLeader() || party.members[0];
            assert.ok(leader && leader.tile, 'leader has tile');

            sim._updateCamera();
            assert.strictEqual(
                String(Settings.cameraTileZ),
                String(leader.tile.z),
                'camera z matches leader floor'
            );

            // Force hop to another floor key if present
            const zKeys = Object.keys(sim.tileMap.layers);
            const otherZ = zKeys.find((k) => String(k) !== String(leader.tile.z));
            if (otherZ != null) {
                const layer = sim.tileMap.getLayer(otherZ);
                assert.ok(layer, 'other floor layer');
                // Find a walkable tile on the other floor
                let placed = false;
                for (let y = 0; y < layer.rows && !placed; y++) {
                    for (let x = 0; x < layer.cols && !placed; x++) {
                        if (sim.tileMap.isWalkable(x, y, otherZ)) {
                            sim.tileMap.moveEntityToTile(leader, x, y, otherZ);
                            placed = true;
                        }
                    }
                }
                assert.ok(placed, 'placed leader on other floor');
                sim._updateCamera();
                assert.strictEqual(
                    String(Settings.cameraTileZ),
                    String(otherZ),
                    'camera z tracks floor hop'
                );

                const g = {
                    fillStyle: '',
                    fillRect() {},
                    drawImage() {}
                };
                sim.tileMap.render(g);
                assert.strictEqual(
                    String(sim.tileMap._viewZ),
                    String(otherZ),
                    'tilemap paints hopped floor'
                );
            }

            sim.destroy();
        } finally {
            Settings.HEADLESS = prevHeadless;
            Settings.cameraTileX = prevCam.x;
            Settings.cameraTileY = prevCam.y;
            Settings.cameraTileZ = prevCam.z;
        }
    });

    test('leaderFormSlot + enabledMemberIndexForSlot map Active view', () => {
        const members = [
            normalizeMember(
                { enabled: true, name: 'A', classId: 'guardian', isLeader: true },
                0
            ),
            normalizeMember(
                { enabled: true, name: 'B', classId: 'scout', isLeader: false },
                1
            ),
            normalizeMember(
                { enabled: false, name: 'C', classId: 'mystic', isLeader: false },
                2
            ),
            normalizeMember(
                { enabled: true, name: 'D', classId: 'adept', isLeader: false },
                3
            )
        ];
        ensureSingleLeader(members);
        assert.strictEqual(leaderFormSlot(members), 0);
        assert.strictEqual(enabledMemberIndexForSlot(members, 0), 0);
        assert.strictEqual(enabledMemberIndexForSlot(members, 1), 1);
        assert.strictEqual(enabledMemberIndexForSlot(members, 2), null);
        // Slot 3 is the 3rd enabled member (indices 0,1,2 among enabled)
        assert.strictEqual(enabledMemberIndexForSlot(members, 3), 2);
    });

    await testAsync('camera follows Set Active member across floors', async () => {
        const prevHeadless = Settings.HEADLESS;
        const prevCam = {
            x: Settings.cameraTileX,
            y: Settings.cameraTileY,
            z: Settings.cameraTileZ
        };
        try {
            Settings.HEADLESS = false;
            Settings.cameraTileX = null;
            Settings.cameraTileY = null;
            Settings.cameraTileZ = null;

            const hunt = loadHunt('cave_crawl_multifloor', { seed: 5 });
            const form = partyFormFromPartyId('test_cave_duo', { loadParty });
            const opts = buildSimulatorOpts({
                seed: 5,
                hunt,
                huntId: 'cave_crawl_multifloor',
                members: form.members,
                mapPath: null
            });
            const sim = new Simulator(opts);
            await sim.start();
            const party = sim.parties[0];
            assert.ok(party.members.length >= 2, 'duo party');
            const leader = party.getLeader() || party.members[0];
            const follower = party.members.find((m) => m !== leader) || party.members[1];
            assert.ok(leader && follower && follower.tile, 'leader + follower');

            // Default: camera on leader
            sim._updateCamera();
            assert.strictEqual(
                sim.getCameraFocusMember(),
                leader,
                'default focus is leader'
            );
            assert.strictEqual(
                String(Settings.cameraTileZ),
                String(leader.tile.z)
            );

            // Set Active → follower (party member index)
            const followIdx = party.members.indexOf(follower);
            sim.setCameraFocusMemberIndex(followIdx);
            // Move follower to another floor so camera z must track them
            const zKeys = Object.keys(sim.tileMap.layers);
            const otherZ = zKeys.find(
                (k) => String(k) !== String(follower.tile.z)
            );
            if (otherZ != null) {
                const layer = sim.tileMap.getLayer(otherZ);
                let placed = false;
                for (let y = 0; y < layer.rows && !placed; y++) {
                    for (let x = 0; x < layer.cols && !placed; x++) {
                        if (sim.tileMap.isWalkable(x, y, otherZ)) {
                            sim.tileMap.moveEntityToTile(
                                follower,
                                x,
                                y,
                                otherZ
                            );
                            placed = true;
                        }
                    }
                }
                assert.ok(placed, 'placed follower on other floor');
                sim._updateCamera();
                assert.strictEqual(
                    sim.getCameraFocusMember(),
                    follower,
                    'focus stays on active follower'
                );
                assert.strictEqual(
                    String(Settings.cameraTileZ),
                    String(otherZ),
                    'camera z follows active member floor, not leader'
                );
                // Leader still on original floor
                assert.notStrictEqual(
                    String(leader.tile.z),
                    String(otherZ),
                    'leader did not hop — proves focus is independent'
                );
            } else {
                // Single-floor fallback: offset follower tile and check xy
                const lx = leader.tile.x;
                const ly = leader.tile.y;
                const fx = follower.tile.x + 5;
                const fy = follower.tile.y + 3;
                if (sim.tileMap.isWalkable(fx, fy, follower.tile.z)) {
                    sim.tileMap.moveEntityToTile(
                        follower,
                        fx,
                        fy,
                        follower.tile.z
                    );
                }
                sim._updateCamera();
                assert.strictEqual(sim.getCameraFocusMember(), follower);
                // Camera origin should center near follower, not leader
                const tw = Settings.tileWidth || 32;
                const viewW = Math.max(
                    1,
                    Math.ceil((Settings.app && Settings.app.width) || 720) / tw
                );
                const expectedX =
                    (Number.isFinite(follower.x)
                        ? follower.x
                        : follower.tile.x) - Math.floor(viewW / 2);
                assert.ok(
                    Math.abs(Settings.cameraTileX - expectedX) < 1,
                    'camera x near follower'
                );
                assert.ok(
                    Math.abs(
                        (Number.isFinite(leader.x) ? leader.x : lx) -
                            (Number.isFinite(follower.x)
                                ? follower.x
                                : follower.tile.x)
                    ) > 0.5 ||
                        Math.abs(
                            (Number.isFinite(leader.y) ? leader.y : ly) -
                                (Number.isFinite(follower.y)
                                    ? follower.y
                                    : follower.tile.y)
                        ) > 0.5,
                    'leader and follower not stacked (when hop skipped)'
                );
            }

            // Clearing focus returns to leader
            sim.setCameraFocusMemberIndex(null);
            sim._updateCamera();
            assert.strictEqual(sim.getCameraFocusMember(), leader);

            sim.destroy();
        } finally {
            Settings.HEADLESS = prevHeadless;
            Settings.cameraTileX = prevCam.x;
            Settings.cameraTileY = prevCam.y;
            Settings.cameraTileZ = prevCam.z;
        }
    });

    await testAsync('snapshotFromSim after short headless hunt', async () => {
        Settings.HEADLESS = true;
        const hunt = loadHunt('cave_crawl_generated');
        const form = partyFormFromHunt(hunt);
        const opts = buildSimulatorOpts({
            seed: 7,
            hunt,
            huntId: 'cave_crawl_generated',
            members: form.members,
            mapPath: path.join(ROOT, 'assets/legacy/map/floor-07-path.png')
        });
        // inject Node loaders via Simulator defaults
        const sim = new Simulator(opts);
        await sim.start();
        sim.active = true;
        for (let i = 0; i < 40; i++) {
            Time.advanceFixedLogicStep();
            sim.updateAll();
        }
        const snap = snapshotFromSim(sim);
        assert.ok(snap.tickCount >= 40);
        assert.ok(Array.isArray(snap.members));
        assert.ok(snap.members.length >= 1);
        assert.ok(snap.members[0].name);
        sim.destroy();
        Settings.HEADLESS = false;
    });

    /**
     * docs/25 P0: browser-shaped opts for rising_pressure_macro seed 42 must
     * produce the same combat core as headless resolve when both run the
     * fixed-step loop (proves builder parity; live ApplicationLoop is separate).
     */
    await testAsync(
        'rising_pressure_macro seed 42 browser opts match headless outcome',
        async () => {
            const { setActiveMode, getActiveModeId } = require('../kernel/core/lib/modes.js');
            const {
                resolveHuntConfig
            } = require('../kernel/providers/simulator/headless_runner.js');
            const { huntToSimulatorOpts } = require('../kernel/providers/simulator/hunt_opts.js');
            const prevMode = getActiveModeId();
            setActiveMode('standard');
            const prevHeadless = Settings.HEADLESS;
            Settings.HEADLESS = true;
            try {
                const seed = 42;
                const resolved = resolveHuntConfig({
                    seed,
                    huntId: 'rising_pressure_macro',
                    partyId: 'rising_pressure_duo'
                });
                const headlessOpts = huntToSimulatorOpts(resolved, {
                    combatAi: true
                });

                const hunt = loadHunt('rising_pressure_macro', { seed });
                const form = partyFormFromPartyId('rising_pressure_duo');
                const members = form.members.filter((m) => m.enabled !== false);
                const browserOpts = buildSimulatorOpts({
                    seed,
                    hunt,
                    huntId: 'rising_pressure_macro',
                    partyId: 'rising_pressure_duo',
                    members,
                    mapPath: null
                });

                async function runToEnd(opts) {
                    Time.resetTimeSinceLevelLoad();
                    const sim = new Simulator(opts);
                    await sim.start();
                    sim.active = true;
                    const maxTicks = 4000;
                    for (let i = 0; i < maxTicks; i++) {
                        Time.advanceFixedLogicStep();
                        sim.updateAll();
                        if (
                            sim.sessionState !== 'running' &&
                            sim.sessionState !== 'idle'
                        ) {
                            break;
                        }
                    }
                    const tel = sim.telemetry || {};
                    const out = {
                        state: sim.sessionState,
                        kills: tel.kills || 0,
                        deaths: tel.deaths || 0,
                        damageTaken: tel.damageTaken || 0,
                        tickCount: sim.tickCount
                    };
                    if (typeof sim.destroy === 'function') sim.destroy();
                    return out;
                }

                const h = await runToEnd(headlessOpts);
                const b = await runToEnd(browserOpts);
                // Builder parity only: same opts path → same combat core.
                // Do not pin kills/deaths/ticks — pathing/balance changes shift
                // those; use `npm run browser:parity` + docs/25 for live demos.
                assert.strictEqual(b.state, h.state, 'sessionState');
                assert.strictEqual(b.kills, h.kills, 'kills');
                assert.strictEqual(b.deaths, h.deaths, 'deaths');
                assert.strictEqual(
                    b.damageTaken,
                    h.damageTaken,
                    'damageTaken'
                );
                assert.strictEqual(b.tickCount, h.tickCount, 'tickCount');
                assert.ok(
                    h.state !== 'running' && h.state !== 'idle',
                    `session should end, got ${h.state}`
                );
                assert.ok(h.kills >= 1, 'macro path gets combat');
            } finally {
                Settings.HEADLESS = prevHeadless;
                setActiveMode(prevMode || 'standard');
            }
        }
    );
}

test('combat_panel helper utilities', () => {
    const {
        hpFill,
        chebyshev,
        entityKey,
        engageRangeFor,
        escapeHtml,
        normalizeSortKey,
        sortCreatures,
        DEFAULT_SORT
    } = require('../kernel/apps/game/combat_panel.js');
    assert.strictEqual(hpFill(1.0), '#00ff00');
    assert.strictEqual(hpFill(0.5), '#ffff00');
    assert.strictEqual(hpFill(0.2), '#ff0000');
    assert.strictEqual(chebyshev({ x: 0, y: 0 }, { x: 3, y: 4 }), 4);

    assert.strictEqual(entityKey({ id: 12 }), 'id:12');
    assert.strictEqual(entityKey({ id: 0, uid: 'u9' }), 'uid:u9');
    assert.strictEqual(entityKey({ id: 0, creatureType: 'rat', name: 'A' }), 'fallback:rat:A');
    // Stable: never random
    assert.strictEqual(entityKey({ id: 0 }), entityKey({ id: 0 }));

    assert.strictEqual(engageRangeFor({ strategy: { engageRange: 9 } }), 9);
    assert.ok(engageRangeFor(null) >= 1);

    assert.strictEqual(escapeHtml('<x&"\'>'), '&lt;x&amp;&quot;&#39;&gt;');
    assert.strictEqual(normalizeSortKey('distance_desc'), 'distance_desc');
    assert.strictEqual(normalizeSortKey('nope'), DEFAULT_SORT);

    const times = new Map([
        ['id:1', 1],
        ['id:2', 2],
        ['id:3', 3]
    ]);
    const pack = (id, x, y, hp, name) => ({
        id,
        tile: { x, y, z: 0 },
        hp: { current: hp, max: 100 },
        name
    });
    const list = [pack(2, 5, 0, 80, 'B'), pack(1, 1, 0, 20, 'A'), pack(3, 3, 0, 50, 'C')];
    sortCreatures(list, 'distance_asc', times, { x: 0, y: 0 });
    assert.deepStrictEqual(
        list.map((c) => c.id),
        [1, 3, 2]
    );
    sortCreatures(list, 'hp_percent_asc', times, { x: 0, y: 0 });
    assert.deepStrictEqual(
        list.map((c) => c.id),
        [1, 3, 2]
    );
    sortCreatures(list, 'name_desc', times, { x: 0, y: 0 });
    assert.deepStrictEqual(
        list.map((c) => c.id),
        [3, 2, 1]
    );
    sortCreatures(list, 'display_time_asc', times, { x: 0, y: 0 });
    assert.deepStrictEqual(
        list.map((c) => c.id),
        [1, 2, 3]
    );
});

test('ui_state: target cursor mode and mouseControlMode transitions', () => {
    const {
        uiState,
        setMouseControlMode,
        enterTargetCursorMode,
        clearTargetCursorMode
    } = require('../kernel/apps/game/ui_state.js');
    assert.strictEqual(uiState.mouseControlMode, 1, 'default mouse control mode should be 1 (Classic)');
    assert.strictEqual(uiState.activeActionCursor, null, 'activeActionCursor defaults to null');

    setMouseControlMode(0);
    assert.strictEqual(uiState.mouseControlMode, 0, 'can set mouseControlMode to 0 (Regular)');
    setMouseControlMode(1);

    enterTargetCursorMode({ type: 'USE_ITEM_WITH', sourceUid: 'item_1', itemId: 'rune_of_fire' });
    assert.deepStrictEqual(uiState.activeActionCursor, {
        type: 'USE_ITEM_WITH',
        sourceUid: 'item_1',
        itemId: 'rune_of_fire'
    }, 'enterTargetCursorMode sets action cursor state');

    clearTargetCursorMode();
    assert.strictEqual(uiState.activeActionCursor, null, 'clearTargetCursorMode clears active action cursor');
});

test('ui_state: Cancel Action uses stopAutowalk hotkey (not Escape-only hardcode)', () => {
    const {
        uiState,
        enterTargetCursorMode,
        clearTargetCursorMode,
        getStopCancelHotkeys,
        isStopCancelHotkeyEvent,
        cancelTargetCursorIfActive
    } = require('../kernel/apps/game/ui_state.js');
    const { Settings } = require('../kernel/settings.js');

    clearTargetCursorMode();
    const defaults = getStopCancelHotkeys();
    assert.ok(defaults.includes('ESCAPE'), 'default stopAutowalk includes ESCAPE');

    // Rebind Stop Autowalk / Cancel Action away from Escape
    const prev = Settings.MANUAL_CONTROL_SHORTCUTS.stopAutowalk;
    Settings.MANUAL_CONTROL_SHORTCUTS.stopAutowalk = ['F9'];

    try {
        assert.deepStrictEqual(getStopCancelHotkeys(), ['F9']);
        assert.strictEqual(
            isStopCancelHotkeyEvent({ key: 'Escape', code: 'Escape' }),
            false,
            'Escape must not cancel when stopAutowalk was rebound'
        );
        assert.strictEqual(
            isStopCancelHotkeyEvent({ key: 'F9', code: 'F9' }),
            true,
            'rebound F9 matches Cancel Action'
        );

        enterTargetCursorMode({ type: 'USE_ITEM_WITH', itemId: 'x' });
        assert.ok(uiState.activeActionCursor);
        assert.strictEqual(cancelTargetCursorIfActive(), true);
        assert.strictEqual(uiState.activeActionCursor, null);
        assert.strictEqual(cancelTargetCursorIfActive(), false);
    } finally {
        Settings.MANUAL_CONTROL_SHORTCUTS.stopAutowalk = prev;
        clearTargetCursorMode();
    }
});

test('ui_state: suppress next canvas click (Stage 9 ground drag)', () => {
    const {
        armSuppressNextCanvasClick,
        consumeSuppressNextCanvasClick
    } = require('../kernel/apps/game/ui_state.js');
    // Drain any leftover from other tests
    while (consumeSuppressNextCanvasClick()) {
        /* empty */
    }
    assert.strictEqual(
        consumeSuppressNextCanvasClick(),
        false,
        'unarmed consume is false'
    );
    armSuppressNextCanvasClick();
    assert.strictEqual(
        consumeSuppressNextCanvasClick(),
        true,
        'armed consume is true once'
    );
    assert.strictEqual(
        consumeSuppressNextCanvasClick(),
        false,
        'second consume is false'
    );
});

test('ui_state: mouse controls normalize + apply (Stage 3)', () => {
    const {
        uiState,
        DEFAULT_MOUSE_CONTROLS,
        STORAGE_KEY_MOUSE_CONTROLS,
        normalizeMouseControls,
        applyMouseControls,
        snapshotMouseControls,
        setLootControlMode,
        setTalkOnRightClick
    } = require('../kernel/apps/game/ui_state.js');

    assert.strictEqual(STORAGE_KEY_MOUSE_CONTROLS, 'hdl_mouse_controls');
    assert.strictEqual(DEFAULT_MOUSE_CONTROLS.mouseControlMode, 1);
    assert.strictEqual(DEFAULT_MOUSE_CONTROLS.lootControlMode, 0);
    assert.strictEqual(DEFAULT_MOUSE_CONTROLS.talkOnRightClick, false);
    assert.strictEqual(DEFAULT_MOUSE_CONTROLS.moveStack, false);

    const empty = normalizeMouseControls(null);
    assert.deepStrictEqual(empty, {
        mouseControlMode: 1,
        lootControlMode: 0,
        talkOnRightClick: false,
        moveStack: false
    });

    const bag = normalizeMouseControls({
        mouseControlMode: 0,
        lootControlMode: 2,
        talkOnRightClick: true,
        moveStack: 1,
        junk: true
    });
    assert.strictEqual(bag.mouseControlMode, 0);
    assert.strictEqual(bag.lootControlMode, 2);
    assert.strictEqual(bag.talkOnRightClick, true);
    assert.strictEqual(bag.moveStack, false, 'strict boolean only');
    assert.strictEqual(bag.junk, undefined);

    // Mode 2 accepted for Stage 4 programmatic use; invalid modes → Classic
    assert.strictEqual(normalizeMouseControls({ mouseControlMode: 2 }).mouseControlMode, 2);
    assert.strictEqual(normalizeMouseControls({ mouseControlMode: 9 }).mouseControlMode, 1);
    assert.strictEqual(normalizeMouseControls({ lootControlMode: 7 }).lootControlMode, 0);

    const prev = snapshotMouseControls();
    try {
        applyMouseControls({
            mouseControlMode: 0,
            lootControlMode: 1,
            talkOnRightClick: false,
            moveStack: false
        });
        assert.strictEqual(uiState.mouseControlMode, 0);
        assert.strictEqual(uiState.lootControlMode, 1);
        setLootControlMode(2);
        assert.strictEqual(uiState.lootControlMode, 2);
        setTalkOnRightClick(true);
        assert.strictEqual(uiState.talkOnRightClick, true);
        setTalkOnRightClick(0);
        assert.strictEqual(uiState.talkOnRightClick, false, 'setter is strict boolean');
        setTalkOnRightClick(true);
        const snap = snapshotMouseControls();
        assert.strictEqual(snap.mouseControlMode, 0);
        assert.strictEqual(snap.lootControlMode, 2);
        assert.strictEqual(snap.talkOnRightClick, true);
    } finally {
        applyMouseControls(prev);
    }
});

test('manual_control: Auto Chase persists in localStorage and seeds members', () => {
    const {
        STORAGE_KEY_AUTO_CHASE,
        readPersistedAutoChase,
        writePersistedAutoChase
    } = require('../kernel/apps/game/ui_state.js');
    const {
        readActiveControlState,
        applyAutoChaseChange,
        applyPersistedAutoChaseToMembers
    } = require('../kernel/apps/game/manual_control.js');

    assert.strictEqual(STORAGE_KEY_AUTO_CHASE, 'hdl_auto_chase');

    const store = Object.create(null);
    const fake = {
        getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
        setItem: (k, v) => {
            store[k] = String(v);
        },
        removeItem: (k) => {
            delete store[k];
        }
    };
    const origLS = global.localStorage;
    const origWin = global.window;
    global.localStorage = fake;
    global.window = Object.assign({}, origWin || {}, { localStorage: fake });

    try {
        assert.strictEqual(readPersistedAutoChase(), false, 'missing key is false');
        writePersistedAutoChase(true);
        assert.strictEqual(store[STORAGE_KEY_AUTO_CHASE], 'true');
        assert.strictEqual(readPersistedAutoChase(), true);

        const idle = readActiveControlState({
            sessionLive: false,
            formMember: { autoChase: false, controlMode: 'manual' }
        });
        assert.strictEqual(
            idle.autoChase,
            true,
            'idle checkbox reads persist, not the form default false'
        );

        writePersistedAutoChase(false);
        const members = [
            { name: 'A', autoChase: false },
            { name: 'B', autoChase: false }
        ];
        applyAutoChaseChange({
            enabled: true,
            activeViewSlot: 0,
            formMembers: members,
            sessionLive: false
        });
        assert.strictEqual(readPersistedAutoChase(), true);
        assert.strictEqual(members[0].autoChase, true, 'toggle stamps every form member');
        assert.strictEqual(members[1].autoChase, true);

        members[0].autoChase = false;
        members[1].autoChase = false;
        applyPersistedAutoChaseToMembers(members);
        assert.strictEqual(members[0].autoChase, true, 'Play seed restores persist');
        assert.strictEqual(members[1].autoChase, true);

        const livePlayer = { autoChase: false, commandQueue: [] };
        applyAutoChaseChange({
            enabled: true,
            formMembers: members,
            sessionLive: true,
            livePlayer
        });
        assert.strictEqual(livePlayer.autoChase, true);
        assert.strictEqual(livePlayer.commandQueue[0].type, 'SET_AUTO_CHASE');
        assert.strictEqual(livePlayer.commandQueue[0].enabled, true);

        const liveState = readActiveControlState({
            sessionLive: true,
            livePlayer: { autoChase: false }
        });
        assert.strictEqual(
            liveState.autoChase,
            false,
            'live checkbox follows the player while a session is running'
        );
    } finally {
        if (origLS === undefined) delete global.localStorage;
        else global.localStorage = origLS;
        if (origWin === undefined) delete global.window;
        else global.window = origWin;
    }
});

test('buildSimulatorOpts keeps Auto Chase through profile expansion on Play', () => {
    const hunt = loadHunt('cave_crawl_generated', { seed: 42 });
    const form = partyFormFromHunt(hunt);
    for (let i = 0; i < form.members.length; i++) {
        if (form.members[i]) form.members[i].autoChase = true;
    }
    const opts = buildSimulatorOpts({
        seed: 42,
        hunt,
        huntId: 'cave_crawl_generated',
        members: form.members
    });
    const spawned = opts.parties[0] && opts.parties[0].members;
    assert.ok(spawned && spawned.length >= 1, 'Play party has members');
    for (let i = 0; i < spawned.length; i++) {
        assert.strictEqual(
            spawned[i].autoChase,
            true,
            `party member ${i} keeps Auto Chase after expandParties`
        );
    }
});

test('manual_control: Auto Chase click returns focus to the hunt canvas', () => {
    const { returnFocusToHuntCanvas } = require('../kernel/apps/game/manual_control.js');

    const calls = [];
    const chaseEl = {
        blur() {
            calls.push('blur');
        }
    };
    const canvas = {
        hasAttribute(name) {
            return name === 'tabindex';
        },
        setAttribute() {},
        focus(opts) {
            calls.push(opts && opts.preventScroll ? 'focus-noscroll' : 'focus');
        }
    };
    const origDoc = global.document;
    global.document = {
        getElementById(id) {
            if (id === 'autoChaseToggle') return chaseEl;
            if (id === 'gameCanvas') return canvas;
            return null;
        }
    };
    try {
        returnFocusToHuntCanvas();
        assert.deepStrictEqual(calls, ['blur', 'focus-noscroll']);
    } finally {
        if (origDoc === undefined) delete global.document;
        else global.document = origDoc;
    }
});

test('combat_panel target cycling and manual controls config', () => {
    const { cycleCombatTarget } = require('../kernel/apps/game/combat_panel.js');
    const { Settings } = require('../kernel/settings.js');
    assert.ok(Settings.MANUAL_CONTROL_SHORTCUTS, 'MANUAL_CONTROL_SHORTCUTS must exist in Settings');
    assert.ok(Array.isArray(Settings.MANUAL_CONTROL_SHORTCUTS.targetNext), 'targetNext should be an array of keys');
    assert.ok(Array.isArray(Settings.MANUAL_CONTROL_SHORTCUTS.targetPrev), 'targetPrev should be an array of keys');

    const player = { id: 99, alive: true, controlMode: 'manual', commandQueue: [], target: null, targetId: null };
    const sim = {};
    // Test that cycling with empty sorted creatures does not throw or crash
    cycleCombatTarget(sim, player, 1);
    assert.strictEqual(player.commandQueue.length, 0, 'no target set when combat list is empty');
});

/**
 * Regression: combat list used `String(range)` in the dirty signature but never
 * defined `range` — ReferenceError blanked the list whenever any creature was
 * in engage range (bug_20260808_191548: "combat list is not loading monsters").
 */
test('combat_panel paints engage-range creatures (no free range ReferenceError)', () => {
    const { bindCombatPanel } = require('../kernel/apps/game/combat_panel.js');
    const origDoc = global.document;
    const origWin = global.window;

    function makeEl(tag) {
        const el = {
            tagName: String(tag || 'div').toUpperCase(),
            style: {},
            classList: {
                add() {},
                remove() {},
                toggle() {},
                contains() {
                    return false;
                }
            },
            dataset: {},
            innerHTML: '',
            hidden: true,
            children: [],
            attributes: {},
            title: '',
            textContent: '',
            className: '',
            parentNode: null,
            appendChild(c) {
                c.parentNode = this;
                this.children.push(c);
                return c;
            },
            removeChild(c) {
                this.children = this.children.filter((x) => x !== c);
            },
            insertBefore(node, ref) {
                if (!ref) this.children.push(node);
                else {
                    const i = this.children.indexOf(ref);
                    if (i < 0) this.children.push(node);
                    else this.children.splice(i, 0, node);
                }
                node.parentNode = this;
                return node;
            },
            remove() {
                if (this.parentNode && this.parentNode.removeChild) {
                    this.parentNode.removeChild(this);
                }
            },
            addEventListener() {},
            removeEventListener() {},
            setAttribute(k, v) {
                this.attributes[k] = String(v);
            },
            getAttribute(k) {
                return this.attributes[k] !== undefined ? this.attributes[k] : null;
            },
            removeAttribute(k) {
                delete this.attributes[k];
            },
            querySelectorAll(sel) {
                if (sel === '.entity-list-row') {
                    return this.children.filter((c) =>
                        String(c.className || '').includes('entity-list-row')
                    );
                }
                return [];
            },
            querySelector() {
                return null;
            },
            closest() {
                return null;
            }
        };
        return el;
    }

    const listEl = makeEl('div');
    listEl.id = 'combatCreaturesList';
    const els = {
        combatCreaturesList: listEl,
        combatSortBtn: makeEl('button'),
        combatSortDropdown: makeEl('div')
    };
    global.document = {
        getElementById: (id) => els[id] || null,
        querySelectorAll: () => [],
        querySelector: () => null,
        createElement: (tag) => makeEl(tag),
        body: makeEl('body'),
        addEventListener() {},
        removeEventListener() {}
    };
    global.window = {
        localStorage: {
            getItem() {
                return null;
            },
            setItem() {}
        },
        addEventListener() {},
        removeEventListener() {}
    };

    try {
        const player = {
            id: 1,
            alive: true,
            controlMode: 'manual',
            tile: { x: 3, y: 10, z: 0 },
            target: null,
            targetId: null,
            name: 'Adept',
            commandQueue: []
        };
        const creatures = [];
        for (let i = 0; i < 4; i++) {
            creatures.push({
                id: 200 + i,
                alive: true,
                name: 'Trash' + i,
                tile: { x: 3 + i, y: 10, z: 0 },
                hp: { current: 40, max: 50 },
                type: 'creature'
            });
        }
        // Far creature (outside default 7×7 engage) must not appear
        creatures.push({
            id: 999,
            alive: true,
            name: 'Far',
            tile: { x: 50, y: 50, z: 0 },
            hp: { current: 10, max: 10 },
            type: 'creature'
        });
        const sim = {
            parties: [{ members: [player] }],
            creatures,
            Settings: { cameraTileZ: 0 },
            getCameraFocusMember: () => player
        };
        const ctl = bindCombatPanel({
            getSim: () => sim,
            isSessionLive: () => true,
            getGenre: () => 'rpg_fantasy',
            intervalMs: 0
        });
        assert.strictEqual(
            listEl.children.length,
            4,
            'engage-range creatures should paint as list rows'
        );
        const keys = listEl.children.map((r) => r.getAttribute('data-uid'));
        assert.ok(keys.includes('id:200'));
        assert.ok(!keys.includes('id:999'), 'far creature outside engage range');
        assert.ok(!listEl.dataset.state, 'no idle/empty placeholder while listing');
        // Second refresh must not throw (dirty-sig path)
        ctl.refresh();
        assert.strictEqual(listEl.children.length, 4);
        ctl.dispose();
    } finally {
        if (origDoc === undefined) delete global.document;
        else global.document = origDoc;
        if (origWin === undefined) delete global.window;
        else global.window = origWin;
    }
});

test('inventory_panel RMB on canvas empty tile moves character and prevents default context menu', () => {
    const { bindInventoryPanel } = require('../kernel/apps/game/inventory_panel.js');
    const listeners = {};
    const mockCanvas = {
        width: 720,
        height: 480,
        getContext: () => ({}),
        getBoundingClientRect: () => ({ left: 0, top: 0, right: 720, bottom: 480, width: 720, height: 480 }),
        addEventListener: (event, handler) => { listeners[event] = handler; },
        removeEventListener: () => {}
    };
    const origDoc = global.document;
    const origWin = global.window;
    const makeEl = () => ({
        style: {},
        classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
        dataset: {},
        appendChild: () => {},
        removeChild: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        setAttribute: () => {},
        removeAttribute: () => {}
    });
    global.document = {
        getElementById: () => null,
        querySelector: () => null,
        createElement: () => makeEl(),
        body: makeEl(),
        addEventListener: () => {},
        removeEventListener: () => {}
    };
    global.window = {
        addEventListener: () => {},
        removeEventListener: () => {}
    };
    try {
        const player = { id: 1, alive: true, controlMode: 'manual', tile: { x: 5, y: 5, z: 0 }, commandQueue: [] };
        const sim = {
            parties: [{ members: [player] }],
            getCameraFocusMember: () => player,
            tileMap: { _viewOriginX: 0, _viewOriginY: 0, _viewZ: 0 },
            creatures: [],
            groundItems: null
        };
        const ctl = bindInventoryPanel({
            canvas: mockCanvas,
            getSim: () => sim,
            isSessionLive: () => true,
            getItemDb: () => ({}),
            getGenre: () => 'rpg_fantasy',
            intervalMs: 10000
        });
        assert.ok(typeof listeners['contextmenu'] === 'function', 'should bind contextmenu handler to canvas');
        let defaultPrevented = false;
        const mockEvent = {
            clientX: 100, // 32px tile -> x=3
            clientY: 100, // 32px tile -> y=3
            preventDefault: () => { defaultPrevented = true; }
        };
        listeners['contextmenu'](mockEvent);
        assert.strictEqual(defaultPrevented, true, 'ev.preventDefault() must be called to suppress HTML default context menu');
        assert.strictEqual(player.commandQueue.length, 1, 'command should be queued');
        assert.deepStrictEqual(player.commandQueue[0], { type: 'START_AUTOWALK', dest: { x: 3, y: 3, z: 0 } }, 'should issue START_AUTOWALK to clicked empty tile');
        ctl.dispose();
    } finally {
        if (origDoc === undefined) delete global.document; else global.document = origDoc;
        if (origWin === undefined) delete global.window; else global.window = origWin;
    }
});

test('inventory_panel RMB on field-only tile autowalks (no fake Pick up item)', () => {
    const { bindInventoryPanel } = require('../kernel/apps/game/inventory_panel.js');
    const {
        createGroundStore
    } = require('../kernel/core/lib/character/ground_items.js');
    const {
        deployFieldToTile
    } = require('../kernel/core/lib/combat/elemental_fields.js');

    const listeners = {};
    const mockCanvas = {
        width: 720,
        height: 480,
        getContext: () => ({}),
        getBoundingClientRect: () => ({
            left: 0,
            top: 0,
            right: 720,
            bottom: 480,
            width: 720,
            height: 480
        }),
        addEventListener: (event, handler) => {
            listeners[event] = handler;
        },
        removeEventListener: () => {}
    };
    const origDoc = global.document;
    const origWin = global.window;
    const makeEl = () => ({
        style: {},
        classList: {
            add: () => {},
            remove: () => {},
            toggle: () => {},
            contains: () => false
        },
        dataset: {},
        appendChild: () => {},
        removeChild: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        setAttribute: () => {},
        removeAttribute: () => {},
        textContent: ''
    });
    /** @type {object[]} */
    const createdMenus = [];
    global.document = {
        getElementById: () => null,
        querySelector: () => null,
        createElement: (tag) => {
            const el = makeEl();
            if (tag === 'div') createdMenus.push(el);
            return el;
        },
        body: makeEl(),
        addEventListener: () => {},
        removeEventListener: () => {}
    };
    global.window = {
        addEventListener: () => {},
        removeEventListener: () => {}
    };
    try {
        const ground = createGroundStore();
        // Tile (3,3) under clientX/Y 100 with 32px tiles
        deployFieldToTile(ground, 3, 3, 0, {
            kind: 'fire',
            source: 'creature',
            createdAt: 0
        });
        const {
            createEmptyInventory
        } = require('../kernel/core/lib/character/inventory.js');
        // Full inventory so topPickableUid runs (fields are immovable → null).
        const player = {
            id: 1,
            alive: true,
            controlMode: 'manual',
            tile: { x: 5, y: 5, z: 0 },
            commandQueue: [],
            inventory: createEmptyInventory({ rootSlots: 10 }),
            level: 20,
            classId: 'guardian'
        };
        const sim = {
            parties: [{ members: [player] }],
            getCameraFocusMember: () => player,
            tileMap: { _viewOriginX: 0, _viewOriginY: 0, _viewZ: 0 },
            creatures: [],
            groundItems: ground
        };
        const ctl = bindInventoryPanel({
            canvas: mockCanvas,
            getSim: () => sim,
            isSessionLive: () => true,
            getItemDb: () => ({}),
            getGenre: () => 'rpg_fantasy',
            intervalMs: 10000
        });
        listeners['contextmenu']({
            clientX: 100,
            clientY: 100,
            preventDefault: () => {}
        });
        assert.strictEqual(
            player.commandQueue.length,
            1,
            'field-only tile should queue autowalk, not open pick menu'
        );
        assert.deepStrictEqual(
            player.commandQueue[0],
            { type: 'START_AUTOWALK', dest: { x: 3, y: 3, z: 0 } },
            'should walk onto field tile (hazard), not offer immovable pickup'
        );
        const pickMenus = createdMenus.filter(
            (el) => el.className === 'inv-context-menu'
        );
        assert.strictEqual(
            pickMenus.length,
            0,
            'must not open Pick up menu for fire_field'
        );
        ctl.dispose();
    } finally {
        if (origDoc === undefined) delete global.document;
        else global.document = origDoc;
        if (origWin === undefined) delete global.window;
        else global.window = origWin;
    }
});

test('ui_state continuous manual movement controls and SOCD resolution', () => {
    const {
        clearActiveMoveKeys,
        getMoveDeltaFromKey,
        getCombinedMoveDelta,
        feedManualMovementCommand,
        activeMoveKeys
    } = require('../kernel/apps/game/ui_state.js');

    clearActiveMoveKeys();
    assert.deepStrictEqual(getMoveDeltaFromKey('w', 'KeyW'), { dx: 0, dy: -1 }, 'W should map to up');
    assert.deepStrictEqual(getMoveDeltaFromKey('d', 'KeyD'), { dx: 1, dy: 0 }, 'D should map to right');
    assert.deepStrictEqual(getMoveDeltaFromKey('ArrowUp', 'ArrowUp'), { dx: 0, dy: -1 }, 'ArrowUp should map to up');
    // Digits / QEZC / numpad are not default movement keys (free for action bars)
    assert.strictEqual(getMoveDeltaFromKey('q', 'KeyQ'), null, 'Q is not a default diagonal');
    assert.strictEqual(getMoveDeltaFromKey('1', 'Digit1'), null, 'digit 1 is not a default move key');
    assert.strictEqual(getMoveDeltaFromKey('7', 'Numpad7'), null, 'numpad is not a default move key');

    // Simulate holding W (up)
    activeMoveKeys.set('KeyW', { dx: 0, dy: -1 });
    assert.deepStrictEqual(getCombinedMoveDelta(), { dx: 0, dy: -1 }, 'single key move');

    const player = { id: 1, alive: true, controlMode: 'manual', moveDelay: 0, commandQueue: [] };
    feedManualMovementCommand(player);
    assert.strictEqual(player.commandQueue.length, 1, 'should queue initial MOVE_STEP');
    assert.deepStrictEqual(player.commandQueue[0], { type: 'MOVE_STEP', dx: 0, dy: -1 }, 'initial step up');

    // Simulate pressing D (right) while W is still held → NE diagonal via combo
    activeMoveKeys.set('KeyD', { dx: 1, dy: 0 });
    assert.deepStrictEqual(getCombinedMoveDelta(), { dx: 1, dy: -1 }, 'combined diagonal move (W+D → NE)');
    feedManualMovementCommand(player);
    assert.strictEqual(player.commandQueue.length, 1, 'should not create duplicate MOVE_STEP command in queue');
    assert.deepStrictEqual(player.commandQueue[0], { type: 'MOVE_STEP', dx: 1, dy: -1 }, 'should update existing waiting command direction instantly');

    // W+A → NW diagonal combo
    clearActiveMoveKeys();
    activeMoveKeys.set('KeyW', { dx: 0, dy: -1 });
    activeMoveKeys.set('KeyA', { dx: -1, dy: 0 });
    assert.deepStrictEqual(getCombinedMoveDelta(), { dx: -1, dy: -1 }, 'W+A yields NW');

    // Simulate opposite direction SOCD latest-win (holding D right, then pressing A left)
    clearActiveMoveKeys();
    activeMoveKeys.set('KeyD', { dx: 1, dy: 0 });
    activeMoveKeys.set('KeyA', { dx: -1, dy: 0 });
    assert.deepStrictEqual(getCombinedMoveDelta(), { dx: -1, dy: 0 }, 'latest opposite key should take priority on axis');

    clearActiveMoveKeys();
    assert.deepStrictEqual(getCombinedMoveDelta(), { dx: 0, dy: 0 }, 'cleared keys produce zero delta');
});

test('sidebar_panels default order puts skills below combat', () => {
    const {
        DEFAULT_ORDER,
        defaultPrefs,
        loadPrefs,
        clampHeight,
        PREFS_KEY,
        MIN_PANEL_HEIGHT,
        MAX_PANEL_HEIGHT
    } = require('../kernel/apps/game/sidebar_panels.js');

    assert.deepStrictEqual(
        DEFAULT_ORDER,
        ['backpack', 'combat', 'skills', 'party'],
        'default order: backpack → combat → skills → party'
    );
    const prefs = defaultPrefs();
    assert.strictEqual(prefs.order.indexOf('skills'), prefs.order.indexOf('combat') + 1);
    assert.strictEqual(Object.keys(prefs.closed).length, 0, 'no panels closed by default');
    assert.ok(prefs.heights.skills > 0);

    // Fake localStorage empty → defaults (skills open, under combat)
    const store = Object.create(null);
    const origLS = global.localStorage;
    global.localStorage = {
        getItem: (k) => (k in store ? store[k] : null),
        setItem: (k, v) => {
            store[k] = String(v);
        },
        removeItem: (k) => {
            delete store[k];
        }
    };
    try {
        const loaded = loadPrefs();
        assert.deepStrictEqual(loaded.order, DEFAULT_ORDER.slice());
        assert.strictEqual(loaded.closed.skills, undefined);
        assert.strictEqual(clampHeight(10), MIN_PANEL_HEIGHT);
        assert.strictEqual(clampHeight(9999), MAX_PANEL_HEIGHT);
        assert.strictEqual(clampHeight(200), 200);
        assert.strictEqual(PREFS_KEY, 'hdl_sidebar_panels');
    } finally {
        if (origLS === undefined) delete global.localStorage;
        else global.localStorage = origLS;
    }
});

test('item details show catalog crit/leech as percent not pipeline units', () => {
    const html = buildEquipmentItemDetailHtml({
        id: 'crimson_coil',
        label: 'Crimson Coil',
        slot: 'rightHand',
        category: 'wand',
        lifeLeechChance: 100,
        lifeLeechAmount: 200,
        manaLeechChance: 100,
        manaLeechAmount: 100,
        critChance: 1000,
        critExtraDamage: 1200,
        skillBonuses: { magic: 5 }
    });
    assert.ok(html.includes('Life Leech: 100% / 2%'), 'life leech amount ÷ 100');
    assert.ok(html.includes('Mana Leech: 100% / 1%'), 'mana leech amount ÷ 100');
    assert.ok(html.includes('Crit Chance: 10%'), 'crit chance ÷ 100');
    assert.ok(html.includes('Crit Extra Dmg: 12%'), 'crit extra ÷ 100');
    assert.ok(!html.includes('Crit Chance: 1000%'), 'must not show pipeline crit');
    assert.ok(!html.includes('Life Leech: 100% / 200%'), 'must not show pipeline leech amount');
    assert.ok(html.includes('Magic: +5') || html.includes('magic: +5'), 'skill bonus still shown');
});

test('skills_panel readSkill resolves magic aliases', () => {
    const { readSkill, SKILL_ROWS } = require('../kernel/apps/game/skills_panel.js');
    assert.strictEqual(readSkill({ magicLevel: 12 }, 'magicLevel', ['magic']), 12);
    assert.strictEqual(readSkill({ magic: 7 }, 'magicLevel', ['magic']), 7);
    assert.strictEqual(readSkill({ sword: 55 }, 'sword'), 55);
    assert.strictEqual(readSkill({}, 'axe'), null);
    assert.ok(SKILL_ROWS.some((r) => r.key === 'sword'));
    assert.ok(SKILL_ROWS.some((r) => r.key === 'magicLevel'));
});

test('bindSkillsPanel paints active player skills (dirty-only)', () => {
    const { bindSkillsPanel } = require('../kernel/apps/game/skills_panel.js');
    const list = {
        id: 'skillsPanelList',
        innerHTML: '',
        dataset: {}
    };
    const origDoc = global.document;
    global.document = {
        getElementById: (id) => (id === 'skillsPanelList' ? list : null)
    };
    try {
        const player = {
            name: 'Tester',
            level: 42,
            skills: {
                sword: 60,
                axe: 10,
                club: 10,
                fist: 10,
                distance: 20,
                shielding: 50,
                magicLevel: 8,
                fishing: 10
            }
        };
        const ctl = bindSkillsPanel({
            getSim: () => ({
                parties: [{ members: [player] }],
                getCameraFocusMember: () => player
            }),
            isSessionLive: () => true,
            intervalMs: 0
        });
        ctl.refresh();
        assert.ok(list.innerHTML.includes('42'), 'shows level');
        assert.ok(list.innerHTML.includes('60'), 'shows sword skill');
        assert.ok(list.innerHTML.includes('Magic Level') || list.innerHTML.includes('8'));
        const html1 = list.innerHTML;
        ctl.refresh();
        assert.strictEqual(list.innerHTML, html1, 'dirty-only: unchanged skills skip rewrite');
        player.skills.sword = 61;
        ctl.refresh();
        assert.ok(list.innerHTML.includes('61'), 'updates when skill changes');
        ctl.dispose();
    } finally {
        if (origDoc === undefined) delete global.document;
        else global.document = origDoc;
    }
});

(async () => {
    clearPresetCache();
    try {
        await runIntegration();
    } catch (err) {
        failed += 1;
        console.error('FAIL integration wrapper', err);
    }

    if (failed) {
        console.error(`\nhunt_ui: ${failed} failed, ${passed} passed`);
        process.exit(1);
    }
    console.log(`hunt_ui: ${passed} passed`);
})();
