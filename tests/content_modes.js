#!/usr/bin/env node
/**
 * Content mode packages (presets/<mode>/mode.json).
 *
 * Master ships `standard` only. Optional packs (e.g. historical `legacy` on the
 * legacy branch) are covered when present on disk.
 */

'use strict';

const assert = require('assert');
const path = require('path');
const {
    listModes,
    loadMode,
    setActiveMode,
    getActiveModeId,
    modePaths,
    getBrowserCatalog,
    setModeCache,
    DEFAULT_MODE_ID
} = require('../kernel/core/lib/modes.js');
const {
    listHuntIds,
    loadHunt,
    loadCreatureTemplate,
    listCreatureTemplateIds,
    clearPresetCache
} = require('../kernel/core/lib/presets.js');
const { PATHS } = require('../kernel/settings.js');
const {
    CONTENT_MODE_STORAGE_KEY,
    isValidContentModeId,
    getPreferredContentModeId,
    setPreferredContentModeId,
    resolvePreferredContentModeId
} = require('../kernel/core/lib/ui_preferences.js');
const { hasMode, withMode } = require('./helpers/modes.js');

let failed = 0;
let passed = 0;

/** Minimal localStorage for Node tests of shared content-mode prefs. */
function installMockLocalStorage() {
    const map = new Map();
    const store = {
        getItem(k) {
            return map.has(k) ? map.get(k) : null;
        },
        setItem(k, v) {
            map.set(String(k), String(v));
        },
        removeItem(k) {
            map.delete(k);
        },
        clear() {
            map.clear();
        }
    };
    global.localStorage = store;
    return store;
}

function test(name, fn) {
    try {
        fn();
        passed += 1;
    } catch (err) {
        failed += 1;
        console.error('FAIL', name);
        console.error(err && err.stack ? err.stack : err);
    }
}

function main() {
    test('lists standard mode (default product pack)', () => {
        const modes = listModes();
        const ids = modes.map((m) => m.id);
        assert.ok(ids.indexOf('standard') >= 0);
        const std = modes.find((m) => m.id === 'standard');
        assert.ok(std && std.isDefault);
    });

    test('DEFAULT_MODE_ID is standard', () => {
        assert.strictEqual(DEFAULT_MODE_ID, 'standard');
    });

    test('standard mode.json browser catalog', () => {
        const m = loadMode('standard');
        // Browser catalog prefers generator-owned hunts (hand floor07_* retired).
        // docs/24 I2: product default is golden_cave_crawl (mid band + quartet).
        assert.ok(m.browser.hunts.indexOf('golden_cave_crawl') >= 0);
        assert.ok(m.browser.hunts.indexOf('standard_arena_waves') >= 0);
        assert.ok(m.browser.hunts.indexOf('rising_pressure_macro') >= 0);
        assert.ok(m.browser.hunts.indexOf('cave_crawl_generated') >= 0);
        assert.ok(m.browser.hunts.indexOf('floor07_sample') < 0);
        assert.ok(m.browser.catalogCreatures.length >= 1);
        assert.strictEqual(m.defaults.huntId, 'golden_cave_crawl');
        assert.strictEqual(m.defaults.scenarioId, 'golden_cave_crawl');
        assert.strictEqual(m.defaults.partyId, 'balance_quartet');
        assert.ok(m.browser.scenarios.indexOf('golden_cave_crawl') >= 0);
        assert.ok(m.browser.scenarios.indexOf('standard_arena_waves') >= 0);
        assert.ok(m.browser.scenarios.indexOf('rising_pressure_macro') >= 0);
        assert.strictEqual(m.features.legacySpawnSource, true);
        assert.strictEqual(m.features.autoAttack, true);
        assert.strictEqual(m.features.monsterSummons, true);
        assert.strictEqual(m.features.expProgression, false);
        assert.strictEqual(m.features.skillProgression, false);
    });

    test('optional legacy pack enables spawn source when installed', () => {
        if (!hasMode('legacy')) return;
        const m = loadMode('legacy');
        assert.strictEqual(m.features.legacySpawnSource, true);
        assert.strictEqual(m.features.autoAttack, true);
        assert.ok(m.assets.spawns);
        assert.ok(m.browser.hunts.indexOf('cave_crawl_generated') >= 0);
        assert.ok(m.browser.hunts.indexOf('legacy_rosh') < 0);
        assert.ok(m.browser.hunts.indexOf('floor07_legacy_corridor') < 0);
        assert.strictEqual(m.defaults.huntId, 'cave_crawl_generated');
        assert.strictEqual(m.defaults.scenarioId, 'legacy_cave_crawl');
    });

    test('setActiveMode switches hunt packages (standard + isolation)', () => {
        setActiveMode('standard');
        assert.strictEqual(getActiveModeId(), 'standard');
        const stdHunts = listHuntIds();
        assert.ok(stdHunts.indexOf('cave_crawl_generated') >= 0);
        assert.ok(stdHunts.indexOf('catalog_crawl_generated') >= 0);
        assert.ok(stdHunts.indexOf('floor07_sample') < 0);
        assert.ok(
            PATHS.presets.endsWith(`${path.sep}standard`) ||
                PATHS.presets.endsWith('/standard')
        );

        // Isolation: a hunt unique to standard must not resolve under a
        // synthetic empty second mode (no cross-mode fallback).
        clearPresetCache();
        setModeCache('fixture_iso', {
            id: 'fixture_iso',
            label: 'Fixture Iso',
            isDefault: false,
            version: 1,
            genre: 'rpg_fantasy',
            assets: {
                maps: 'assets/legacy/map',
                navmesh: 'assets/legacy/map/navmesh',
                spawns: null,
                sprites: 'assets/sprites',
                data: 'assets/data'
            },
            features: { legacySpawnSource: false, autoAttack: true },
            defaults: {},
            browser: { hunts: [], creatures: [], scenarios: [] }
        });
        setActiveMode('fixture_iso');
        assert.strictEqual(getActiveModeId(), 'fixture_iso');
        let threw = false;
        try {
            loadHunt('catalog_crawl_generated');
        } catch (_) {
            threw = true;
        }
        assert.ok(threw, 'standard-only hunt must not resolve in other mode');
        setModeCache('fixture_iso', null);
        clearPresetCache();

        setActiveMode('standard');
        const h = loadHunt('cave_crawl_generated');
        assert.strictEqual(h.id, 'cave_crawl_generated');
    });

    test('standard creature pack loads', () => {
        setActiveMode('standard');
        const stdIds = listCreatureTemplateIds({ includeCatalog: false });
        assert.ok(stdIds.indexOf('dummy') >= 0);
        assert.ok(stdIds.indexOf('cave_rat') >= 0);
        assert.ok(stdIds.length < 2000, 'standard creature count bound');
        const rat = loadCreatureTemplate('cave_rat');
        assert.ok(rat && rat.hp > 0);
    });

    test('optional legacy creature pack when installed', () => {
        if (!hasMode('legacy')) return;
        withMode('legacy', () => {
            const legIds = listCreatureTemplateIds({ includeCatalog: false });
            assert.ok(legIds.length > 1000);
            const rat = loadCreatureTemplate('cave_rat');
            assert.ok(rat && rat.hp > 0);
        });
    });

    test('modePaths maps still point at assets/legacy/map for v1', () => {
        setActiveMode('standard');
        const p = modePaths('standard');
        assert.ok(p.maps.includes('legacy'));
        assert.ok(p.mapsRel === 'assets/legacy/map');
        assert.strictEqual(getBrowserCatalog('standard').hunts.length >= 1, true);
    });

    test('shared content mode preference persists across shells', () => {
        const prev = global.localStorage;
        const store = installMockLocalStorage();
        try {
            assert.strictEqual(isValidContentModeId('legacy'), true);
            assert.strictEqual(isValidContentModeId('custom_pack'), true);
            assert.strictEqual(isValidContentModeId('Bad-Id'), false);
            assert.strictEqual(getPreferredContentModeId(null), null);
            assert.strictEqual(getPreferredContentModeId('standard'), 'standard');

            assert.strictEqual(setPreferredContentModeId('legacy'), true);
            assert.strictEqual(store.getItem(CONTENT_MODE_STORAGE_KEY), 'legacy');
            assert.strictEqual(getPreferredContentModeId('standard'), 'legacy');

            assert.strictEqual(
                resolvePreferredContentModeId({
                    fallback: 'standard',
                    availableIds: ['standard', 'legacy'],
                    defaultId: 'standard'
                }),
                'legacy'
            );
            assert.strictEqual(
                resolvePreferredContentModeId({
                    fallback: 'standard',
                    availableIds: ['standard'],
                    defaultId: 'standard'
                }),
                'standard',
                'preferred must be installed'
            );

            assert.strictEqual(setPreferredContentModeId('../x'), false);
            assert.strictEqual(getPreferredContentModeId(null), 'legacy');
        } finally {
            if (prev === undefined) {
                delete global.localStorage;
            } else {
                global.localStorage = prev;
            }
        }
    });

    if (failed) {
        console.error(`${failed} failed, ${passed} passed`);
        process.exit(1);
    }
    console.log(`content_modes: ${passed} passed`);
}

main();
