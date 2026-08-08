#!/usr/bin/env node
/**
 * Browser preset pack: PHP resolves FS + Stage 11 layout deps;
 * kernel expands hunts from injected files (browser path).
 */

'use strict';

const { hasMode } = require('./helpers/modes.js');

const assert = require('assert');
const { execFileSync } = require('child_process');
const path = require('path');
const {
    setActiveMode,
    setModeCache
} = require('../kernel/core/lib/modes.js');
const {
    clearPresetCache,
    setPresetCache,
    expandHuntDefinition,
    cacheHas,
    listPartyIds,
    loadParty
} = require('../kernel/core/lib/presets.js');

const ROOT = path.resolve(__dirname, '..');

function buildPack(modeId) {
    const php = `
require '${ROOT.replace(/\\/g, '/')}/php/bootstrap.php';
echo json_encode(\\De\\BrowserPresetPack::build(${JSON.stringify(modeId)}), JSON_UNESCAPED_SLASHES);
`;
    const out = execFileSync('php', ['-r', php], {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        cwd: ROOT
    });
    return JSON.parse(out);
}

function inject(files) {
    const keys = Object.keys(files || {});
    for (let i = 0; i < keys.length; i++) {
        setPresetCache(keys[i], files[keys[i]]);
    }
}

let failed = 0;
let passed = 0;

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
    test('standard pack includes layout deps', () => {
        const pack = buildPack('standard');
        assert.strictEqual(pack.packVersion, 1);
        assert.strictEqual(pack.modeId, 'standard');
        assert.ok(pack.files['classes.json']);
        assert.ok(pack.files['hunts/cave_crawl_generated.json']);
        assert.ok(pack.files['dungeons/small_crawl.json']);
        assert.ok(pack.files['pieces/cave_v1.json']);
        assert.ok(pack.files['markers/cave_clickies.json']);
        assert.ok(pack.files['populations/cave_rats.json']);
        assert.ok(pack.deps.dungeons.indexOf('small_crawl') >= 0);
        assert.ok(pack.deps.pieces.indexOf('cave_v1') >= 0);
        // Stage 11.9 art set packs
        assert.ok(
            pack.files['art_sets/cave.json'],
            'standard pack includes art_sets/cave.json'
        );
        assert.ok(
            pack.deps.art_sets && pack.deps.art_sets.indexOf('cave') >= 0,
            'deps.art_sets lists cave'
        );
        assert.strictEqual((pack.missing || []).length, 0);
        assert.ok(
            pack.files['parties/starter_duo.json'],
            'standard pack includes parties/starter_duo.json'
        );
        assert.ok(
            pack.files['player_profiles/guardian_starter.json'],
            'standard pack includes player_profiles/guardian_starter.json'
        );
        assert.ok(
            Array.isArray(pack.deps.parties) && pack.deps.parties.length >= 2,
            'deps.parties lists more than starter_duo'
        );
        assert.ok(
            pack.deps.parties.indexOf('balance_quartet') >= 0,
            'deps.parties includes balance_quartet'
        );
        // Arena ↔ rest chain shells + packs (standard_arena_rest_chain)
        assert.ok(
            pack.files['dungeons/arena_combat_shell.json'],
            'standard pack includes arena_combat_shell for arena_rest_chain'
        );
        assert.ok(
            pack.files['dungeons/rest_area_shell.json'],
            'standard pack includes rest_area_shell for arena_rest_chain'
        );
        assert.ok(
            pack.files['pieces/arena_combat_v1.json'],
            'standard pack includes arena_combat_v1 piece pack'
        );
        assert.ok(
            pack.files['pieces/rest_area_v1.json'],
            'standard pack includes rest_area_v1 piece pack'
        );
        assert.ok(
            pack.deps.dungeons.indexOf('arena_combat_shell') >= 0,
            'deps.dungeons lists arena_combat_shell'
        );
    });

    test('injected pack lists parties from cache (browser fs shim path)', () => {
        const pack = buildPack('standard');
        clearPresetCache();
        setModeCache('standard', pack.mode);
        setActiveMode('standard');
        inject(pack.files);

        // Mimic browser: parties must resolve without mode.browser.parties.
        assert.ok(
            !pack.mode.browser ||
                !Array.isArray(pack.mode.browser.parties) ||
                pack.mode.browser.parties.length === 0,
            'mode.json leaves browser.parties empty (pack deps own the list)'
        );

        const ids = listPartyIds();
        assert.ok(ids.length >= 2, `expected multiple parties, got ${ids.join(',')}`);
        assert.ok(ids.indexOf('starter_duo') >= 0);
        assert.ok(ids.indexOf('balance_quartet') >= 0);
        assert.ok(
            ids.indexOf('balance_quartet_novice') >= 0,
            'deps include I4 novice tier party'
        );
        assert.ok(
            ids.indexOf('balance_quartet_veteran') >= 0,
            'deps include I4 veteran tier party'
        );

        const duo = loadParty('starter_duo');
        assert.ok(duo && Array.isArray(duo.members) && duo.members.length >= 2);
        assert.strictEqual(duo.members[0].name, 'Guardian');
        assert.strictEqual(duo.members[0].classId, 'guardian');
        assert.strictEqual(duo.members[1].name, 'Scout');
        assert.strictEqual(duo.members[1].classId, 'scout');
        assert.ok(
            duo.members[0].equipment &&
                Object.keys(duo.members[0].equipment).length > 0,
            'starter_duo expands profile equipment'
        );
    });

    test('optional legacy pack includes generated cave deps when installed', () => {
        if (!hasMode('legacy')) return;
        const pack = buildPack('legacy');
        assert.strictEqual(pack.modeId, 'legacy');
        assert.ok(pack.files['hunts/cave_crawl_generated.json']);
        assert.ok(pack.files['dungeons/small_crawl.json']);
        assert.ok(pack.files['pieces/cave_v1.json']);
    });

    test('injected pack expands generated hunts without disk layout reads', () => {
        const pack = buildPack('standard');
        clearPresetCache();
        setModeCache('standard', pack.mode);
        setActiveMode('standard');
        inject(pack.files);

        assert.ok(cacheHas('dungeons/small_crawl.json'));
        assert.ok(cacheHas('pieces/cave_v1.json'));

        const raw = pack.files['hunts/cave_crawl_generated.json'];
        const exp = expandHuntDefinition(raw, { seed: 1 });
        assert.ok(!exp.layoutSkipped, exp.layoutSkipped || 'ok');
        assert.ok(exp.layoutMeta && exp.layoutMeta.reason === 'ok');
        assert.ok(Array.isArray(exp.spawns) && exp.spawns.length > 0);

        const fixed = expandHuntDefinition(
            pack.files['hunts/outskirts_camp_fixed.json'],
            { seed: 1 }
        );
        assert.ok(!fixed.layoutSkipped, fixed.layoutSkipped || 'ok');
        assert.ok(fixed.layoutMeta && fixed.layoutMeta.reason === 'ok');
    });

    console.log(
        failed
            ? `browser_preset_pack: ${failed} failed, ${passed} passed`
            : `browser_preset_pack: ${passed} passed`
    );
    process.exit(failed ? 1 : 0);
}

main();
