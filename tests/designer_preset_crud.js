#!/usr/bin/env node
/**
 * Designer Phase 2–4: PHP PresetCrud catalog, folder, nested piece-pack round-trips,
 * soft refs (hunts), and validate (pieces / biomes / dungeons layout|stress).
 * Uses standard mode; inserts disposable test rows/files, then deletes them.
 */

'use strict';

const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TEST_SPELL_ID = 'zz_designer_poc_spell';
const TEST_CLASS_ID = 'zz_designer_poc_class';
const TEST_EQUIP_ID = 'zz_designer_poc_equip';
const TEST_STRAT_ID = 'zz_designer_poc_strat';
const TEST_POP_ID = 'zz_designer_poc_pop';
const TEST_CREATURE_ID = 'zz_designer_poc_creature';
const TEST_CREATURE_RENAME_TO = 'zz_designer_poc_creature_renamed';
const TEST_PIECE_PACK_ID = 'zz_designer_poc_pieces';
const TEST_PROFILE_ID = 'zz_designer_poc_profile';
const TEST_PARTY_ID = 'zz_designer_poc_party';
const TEST_TILE_ROLE_ID = 'zz_designer_poc_role';
const TEST_TILE_ROLE_RENAME_TO = 'zz_designer_poc_role_renamed';
const TEST_ART_SET_ID = 'zz_designer_poc_art';
const TEST_DIALOG_ID = 'zz_designer_poc_dialog';
const TEST_DIALOG_RENAME_TO = 'zz_designer_poc_dialog_renamed';
const TEST_WAYPOINT_ID = 'zz_designer_poc_waypoints';
const TEST_WAYPOINT_RENAME_TO = 'zz_designer_poc_waypoints_renamed';
const TEST_HUNT_WP_ID = 'zz_designer_poc_hunt_wp';

/**
 * @param {string} phpBody
 * @returns {unknown}
 */
function phpEval(phpBody) {
    const php = `
require '${ROOT.replace(/\\/g, '/')}/php/bootstrap.php';
${phpBody}
`;
    const out = execFileSync('php', ['-r', php], {
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
        cwd: ROOT
    });
    return JSON.parse(out);
}

/**
 * @param {string} name
 * @param {() => void} fn
 */
let failed = 0;
let passed = 0;

function test(name, fn) {
    try {
        fn();
        passed += 1;
        console.log('ok', name);
    } catch (err) {
        failed += 1;
        console.error('FAIL', name);
        console.error(err && err.stack ? err.stack : err);
    }
}

function cleanup() {
    try {
        phpEval(`
foreach ([
  ['spells', ${JSON.stringify(TEST_SPELL_ID)}],
  ['classes', ${JSON.stringify(TEST_CLASS_ID)}],
  ['equipment', ${JSON.stringify(TEST_EQUIP_ID)}],
  ['strategies', ${JSON.stringify(TEST_STRAT_ID)}],
  ['populations', ${JSON.stringify(TEST_POP_ID)}],
  ['creatures', ${JSON.stringify(TEST_CREATURE_ID)}],
  ['creatures', ${JSON.stringify(TEST_CREATURE_RENAME_TO)}],
  ['pieces', ${JSON.stringify(TEST_PIECE_PACK_ID)}],
  ['player_profiles', ${JSON.stringify(TEST_PROFILE_ID)}],
  ['parties', ${JSON.stringify(TEST_PARTY_ID)}],
  ['tile_roles', ${JSON.stringify(TEST_TILE_ROLE_ID)}],
  ['tile_roles', ${JSON.stringify(TEST_TILE_ROLE_RENAME_TO)}],
  ['art_sets', ${JSON.stringify(TEST_ART_SET_ID)}],
  ['dialogs', ${JSON.stringify(TEST_DIALOG_ID)}],
  ['dialogs', ${JSON.stringify(TEST_DIALOG_RENAME_TO)}],
  ['waypoints', ${JSON.stringify(TEST_WAYPOINT_ID)}],
  ['waypoints', ${JSON.stringify(TEST_WAYPOINT_RENAME_TO)}],
] as $pair) {
  try { \\De\\PresetCrud::delete('standard', $pair[0], $pair[1]); } catch (Throwable $e) {}
}
echo json_encode(['ok' => true]);
`);
    } catch (_) {
        /* ignore */
    }
    const huntPath = path.join(
        ROOT,
        'presets/standard/hunts',
        TEST_HUNT_WP_ID + '.json'
    );
    try {
        if (fs.existsSync(huntPath)) fs.unlinkSync(huntPath);
    } catch (_) {
        /* ignore */
    }
}

function main() {
    cleanup();

    test('listKinds includes P0 combat + dungeon kinds + pieces', () => {
        const data = phpEval(`echo json_encode(\\De\\PresetCrud::listKinds());`);
        assert.ok(Array.isArray(data));
        const ids = data.map((k) => k.id);
        for (const k of [
            'spells',
            'classes',
            'equipment',
            'strategies',
            'creatures',
            'player_profiles',
            'parties',
            'populations',
            'markers',
            'biomes',
            'art_sets',
            'tile_roles',
            'dungeons',
            'pieces',
            'dialogs',
            'waypoints'
        ]) {
            assert.ok(ids.includes(k), 'missing kind ' + k);
        }
        assert.ok(!ids.includes('hunts'));
        const spells = data.find((k) => k.id === 'spells');
        assert.strictEqual(spells.shape, 'catalog');
        assert.strictEqual(spells.group, 'combat');
        const profiles = data.find((k) => k.id === 'player_profiles');
        assert.strictEqual(profiles.shape, 'folder');
        assert.strictEqual(profiles.group, 'combat');
        const pops = data.find((k) => k.id === 'populations');
        assert.strictEqual(pops.shape, 'folder');
        assert.strictEqual(pops.group, 'dungeon');
        const pieces = data.find((k) => k.id === 'pieces');
        assert.strictEqual(pieces.shape, 'nested_pack');
        assert.strictEqual(pieces.group, 'dungeon');
        const roles = data.find((k) => k.id === 'tile_roles');
        assert.strictEqual(roles.shape, 'folder');
        assert.strictEqual(roles.group, 'dungeon');
        const dialogs = data.find((k) => k.id === 'dialogs');
        assert.strictEqual(dialogs.shape, 'folder');
        assert.strictEqual(dialogs.group, 'combat');
        const waypoints = data.find((k) => k.id === 'waypoints');
        assert.strictEqual(waypoints.shape, 'folder');
        assert.strictEqual(waypoints.group, 'dungeon');
    });

    test('list standard spells has rows', () => {
        const data = phpEval(
            `echo json_encode(\\De\\PresetCrud::list('standard', 'spells'));`
        );
        assert.strictEqual(data.mode, 'standard');
        assert.strictEqual(data.kind, 'spells');
        assert.strictEqual(data.shape, 'catalog');
        assert.ok(data.count >= 1);
        assert.ok(data.total >= data.count);
        assert.ok(data.items.some((r) => r.id === 'melee_auto'));
    });

    test('list folder populations', () => {
        const data = phpEval(
            `echo json_encode(\\De\\PresetCrud::list('standard', 'populations'));`
        );
        assert.strictEqual(data.shape, 'folder');
        assert.ok(data.total >= 1);
        assert.ok(data.items.some((r) => r.id === 'cave_rats'));
    });

    test('creatures list is paginated by default', () => {
        // Use standard (small) — still returns limit/total fields.
        const data = phpEval(
            `echo json_encode(\\De\\PresetCrud::list('standard', 'creatures'));`
        );
        assert.strictEqual(data.shape, 'folder');
        assert.ok(typeof data.total === 'number');
        assert.ok(data.limit === 100 || data.limit === null || data.total <= 100);
        // Explicit page size
        const page = phpEval(
            `echo json_encode(\\De\\PresetCrud::list('standard', 'creatures', ['limit' => 1, 'offset' => 0]));`
        );
        assert.strictEqual(page.count, 1);
        assert.ok(page.total >= 1);
        assert.strictEqual(page.limit, 1);
    });

    test('get melee_auto spell and cave_rats population', () => {
        const spell = phpEval(
            `echo json_encode(\\De\\PresetCrud::get('standard', 'spells', 'melee_auto'));`
        );
        assert.strictEqual(spell.id, 'melee_auto');
        assert.strictEqual(spell.entity.id, 'melee_auto');

        const pop = phpEval(
            `echo json_encode(\\De\\PresetCrud::get('standard', 'populations', 'cave_rats'));`
        );
        assert.strictEqual(pop.shape, 'folder');
        assert.strictEqual(pop.entity.id, 'cave_rats');
        assert.ok(pop.entity.groups);
    });

    test('presets_ids returns spell and population ids', () => {
        const spells = phpEval(
            `echo json_encode(\\De\\PresetCrud::ids('standard', 'spells'));`
        );
        assert.ok(spells.ids.includes('melee_auto'));
        const pops = phpEval(
            `echo json_encode(\\De\\PresetCrud::ids('standard', 'populations'));`
        );
        assert.ok(pops.ids.includes('cave_rats'));
        const roles = phpEval(
            `echo json_encode(\\De\\PresetCrud::ids('standard', 'tile_roles'));`
        );
        assert.ok(roles.ids.includes('path'));
        assert.ok(roles.ids.includes('water'));
        assert.ok(roles.ids.includes('wall'));
        assert.ok(roles.ids.includes('stairs_up'));
        const dialogs = phpEval(
            `echo json_encode(\\De\\PresetCrud::ids('standard', 'dialogs'));`
        );
        assert.ok(dialogs.ids.includes('town_guide'));
        const waypoints = phpEval(
            `echo json_encode(\\De\\PresetCrud::ids('standard', 'waypoints'));`
        );
        assert.ok(Array.isArray(waypoints.ids));
        assert.ok(waypoints.ids.includes('wp_test_1'));
    });

    test('reject invalid entity id', () => {
        const data = phpEval(`
try {
  \\De\\PresetCrud::save([
    'mode' => 'standard',
    'kind' => 'spells',
    'id' => '../evil',
    'entity' => ['id' => '../evil', 'label' => 'x'],
  ]);
  echo json_encode(['ok' => true]);
} catch (Throwable $e) {
  echo json_encode(['ok' => false, 'error' => $e->getMessage()]);
}
`);
        assert.strictEqual(data.ok, false);
        assert.ok(/Invalid entity id/i.test(String(data.error || '')));
    });

    test('spell catalog round-trip create get delete', () => {
        const before = phpEval(
            `echo json_encode(\\De\\PresetCrud::list('standard', 'spells'));`
        );
        const beforeCount = before.total;

        const saved = phpEval(`
echo json_encode(\\De\\PresetCrud::save([
  'mode' => 'standard',
  'kind' => 'spells',
  'id' => ${JSON.stringify(TEST_SPELL_ID)},
  'entity' => [
    'id' => ${JSON.stringify(TEST_SPELL_ID)},
    'label' => 'Designer PoC Spell',
    'kind' => 'spell',
    'element' => 'energy',
    'powerCurve' => 'magic_strike',
    'basePower' => 11,
    'range' => 3,
    'mana' => 9,
    'hitChance' => 100,
    'isMelee' => false,
    'moveLock' => 0.05,
    'cooldowns' => new stdClass(),
  ],
]));
`);
        assert.strictEqual(saved.created, true);
        assert.strictEqual(saved.id, TEST_SPELL_ID);
        assert.strictEqual(saved.count, beforeCount + 1);

        const got = phpEval(
            `echo json_encode(\\De\\PresetCrud::get('standard', 'spells', ${JSON.stringify(TEST_SPELL_ID)}));`
        );
        assert.strictEqual(got.entity.label, 'Designer PoC Spell');
        assert.strictEqual(got.entity.basePower, 11);

        const updated = phpEval(`
echo json_encode(\\De\\PresetCrud::save([
  'mode' => 'standard',
  'kind' => 'spells',
  'id' => ${JSON.stringify(TEST_SPELL_ID)},
  'entity' => [
    'id' => ${JSON.stringify(TEST_SPELL_ID)},
    'label' => 'Designer PoC Spell v2',
    'kind' => 'spell',
    'element' => 'fire',
    'powerCurve' => 'magic_strike',
    'basePower' => 22,
    'range' => 4,
    'mana' => 12,
  ],
]));
`);
        assert.strictEqual(updated.created, false);
        const got2 = phpEval(
            `echo json_encode(\\De\\PresetCrud::get('standard', 'spells', ${JSON.stringify(TEST_SPELL_ID)}));`
        );
        assert.strictEqual(got2.entity.label, 'Designer PoC Spell v2');
        assert.strictEqual(got2.entity.basePower, 22);
        assert.strictEqual(got2.entity.element, 'fire');

        const del = phpEval(
            `echo json_encode(\\De\\PresetCrud::delete('standard', 'spells', ${JSON.stringify(TEST_SPELL_ID)}));`
        );
        assert.strictEqual(del.deleted, true);
        assert.strictEqual(del.count, beforeCount);
        assert.ok(Array.isArray(del.warnings));

        const after = phpEval(
            `echo json_encode(\\De\\PresetCrud::list('standard', 'spells'));`
        );
        assert.strictEqual(after.total, beforeCount);
        assert.ok(!after.items.some((r) => r.id === TEST_SPELL_ID));
    });

    test('equipment and strategies catalog round-trip', () => {
        const eq = phpEval(`
echo json_encode(\\De\\PresetCrud::save([
  'mode' => 'standard',
  'kind' => 'equipment',
  'id' => ${JSON.stringify(TEST_EQUIP_ID)},
  'entity' => [
    'id' => ${JSON.stringify(TEST_EQUIP_ID)},
    'label' => 'PoC Stick',
    'slot' => 'rightHand',
    'category' => 'sword',
    'weaponType' => 'melee',
    'atk' => 3,
    'defense' => 0,
    'weight' => 100,
  ],
]));
`);
        assert.strictEqual(eq.created, true);
        const st = phpEval(`
echo json_encode(\\De\\PresetCrud::save([
  'mode' => 'standard',
  'kind' => 'strategies',
  'id' => ${JSON.stringify(TEST_STRAT_ID)},
  'entity' => [
    'id' => ${JSON.stringify(TEST_STRAT_ID)},
    'label' => 'PoC Strat',
    'aggression' => 0.5,
    'engageRange' => 5,
    'spellPriority' => ['melee_auto'],
  ],
]));
`);
        assert.strictEqual(st.created, true);
        phpEval(
            `echo json_encode(\\De\\PresetCrud::delete('standard', 'equipment', ${JSON.stringify(TEST_EQUIP_ID)}));`
        );
        phpEval(
            `echo json_encode(\\De\\PresetCrud::delete('standard', 'strategies', ${JSON.stringify(TEST_STRAT_ID)}));`
        );
    });

    test('folder population and creature round-trip', () => {
        const popPath = path.join(
            ROOT,
            'presets/standard/populations',
            TEST_POP_ID + '.json'
        );
        const crPath = path.join(
            ROOT,
            'presets/standard/creatures',
            TEST_CREATURE_ID + '.json'
        );
        assert.ok(!fs.existsSync(popPath));
        assert.ok(!fs.existsSync(crPath));

        const pop = phpEval(`
echo json_encode(\\De\\PresetCrud::save([
  'mode' => 'standard',
  'kind' => 'populations',
  'id' => ${JSON.stringify(TEST_POP_ID)},
  'entity' => [
    'id' => ${JSON.stringify(TEST_POP_ID)},
    'notes' => 'designer test',
    'groups' => [
      'normal' => [
        'weight' => 100,
        'creatureIds' => ['cave_rat'],
        'packSize' => [1, 1],
      ],
    ],
  ],
]));
`);
        assert.strictEqual(pop.created, true);
        assert.strictEqual(pop.shape, 'folder');
        assert.ok(fs.existsSync(popPath));
        const modeAfterCreate = JSON.parse(
            fs.readFileSync(path.join(ROOT, 'presets/standard/mode.json'), 'utf8')
        );
        assert.ok(
            modeAfterCreate.browser.populations.includes(TEST_POP_ID),
            'create should add browser.populations entry'
        );

        const cr = phpEval(`
echo json_encode(\\De\\PresetCrud::save([
  'mode' => 'standard',
  'kind' => 'creatures',
  'id' => ${JSON.stringify(TEST_CREATURE_ID)},
  'entity' => [
    'id' => ${JSON.stringify(TEST_CREATURE_ID)},
    'label' => 'PoC Critter',
    'hp' => 9,
    'hpMax' => 9,
    'speed' => 80,
    'autoAttack' => 'melee_auto',
  ],
]));
`);
        assert.strictEqual(cr.created, true);
        assert.ok(fs.existsSync(crPath));

        const got = phpEval(
            `echo json_encode(\\De\\PresetCrud::get('standard', 'creatures', ${JSON.stringify(TEST_CREATURE_ID)}));`
        );
        assert.strictEqual(got.entity.label, 'PoC Critter');
        assert.strictEqual(got.entity.hp, 9);

        phpEval(
            `echo json_encode(\\De\\PresetCrud::delete('standard', 'populations', ${JSON.stringify(TEST_POP_ID)}));`
        );
        phpEval(
            `echo json_encode(\\De\\PresetCrud::delete('standard', 'creatures', ${JSON.stringify(TEST_CREATURE_ID)}));`
        );
        assert.ok(!fs.existsSync(popPath));
        assert.ok(!fs.existsSync(crPath));
        const modeAfterDelete = JSON.parse(
            fs.readFileSync(path.join(ROOT, 'presets/standard/mode.json'), 'utf8')
        );
        assert.ok(
            !modeAfterDelete.browser.populations.includes(TEST_POP_ID),
            'delete should remove browser.populations entry'
        );
    });

    test('player_profiles folder entity round-trip', () => {
        const profilePath = path.join(
            ROOT,
            'presets/standard/player_profiles',
            TEST_PROFILE_ID + '.json'
        );
        assert.ok(!fs.existsSync(profilePath));

        const saved = phpEval(`
echo json_encode(\\De\\PresetCrud::save([
  'mode' => 'standard',
  'kind' => 'player_profiles',
  'id' => ${JSON.stringify(TEST_PROFILE_ID)},
  'entity' => [
    'id' => ${JSON.stringify(TEST_PROFILE_ID)},
    'label' => 'PoC Guardian Profile',
    'vocation' => 'guardian',
    'level' => 80,
    'promoted' => true,
    'skills' => [
      'sword' => 80,
      'shielding' => 75,
    ],
    'stats' => [
      'lifeLeech' => 5.0,
      'manaLeech' => 3.0,
      'critChance' => 10,
      'critDamage' => 15,
    ],
    'equipment' => [
      'weapon' => 'jagged_sword',
    ],
    'strategyId' => 'melee_auto',
  ],
]));
`);
        assert.strictEqual(saved.created, true);
        assert.strictEqual(saved.shape, 'folder');
        assert.ok(fs.existsSync(profilePath));

        const got = phpEval(
            `echo json_encode(\\De\\PresetCrud::get('standard', 'player_profiles', ${JSON.stringify(TEST_PROFILE_ID)}));`
        );
        assert.strictEqual(got.entity.label, 'PoC Guardian Profile');
        assert.strictEqual(got.entity.level, 80);
        assert.strictEqual(got.entity.vocation, 'guardian');

        phpEval(
            `echo json_encode(\\De\\PresetCrud::delete('standard', 'player_profiles', ${JSON.stringify(TEST_PROFILE_ID)}));`
        );
        assert.ok(!fs.existsSync(profilePath));
    });

    test('parties folder entity round-trip', () => {
        const partyPath = path.join(
            ROOT,
            'presets/standard/parties',
            TEST_PARTY_ID + '.json'
        );
        assert.ok(!fs.existsSync(partyPath));

        const saved = phpEval(`
echo json_encode(\\De\\PresetCrud::save([
  'mode' => 'standard',
  'kind' => 'parties',
  'id' => ${JSON.stringify(TEST_PARTY_ID)},
  'entity' => [
    'id' => ${JSON.stringify(TEST_PARTY_ID)},
    'label' => 'PoC Party Trio',
    'members' => [
      [
        'profileId' => 'guardian_starter',
        'name' => 'Tank',
        'isLeader' => true,
      ],
      [
        'profileId' => 'adept_starter',
        'name' => 'Mage',
        'isLeader' => false,
      ],
    ],
    'notes' => 'Test party composition.',
  ],
]));
`);
        assert.strictEqual(saved.created, true);
        assert.strictEqual(saved.shape, 'folder');
        assert.ok(fs.existsSync(partyPath));

        const got = phpEval(
            `echo json_encode(\\De\\PresetCrud::get('standard', 'parties', ${JSON.stringify(TEST_PARTY_ID)}));`
        );
        assert.strictEqual(got.entity.label, 'PoC Party Trio');
        assert.strictEqual(got.entity.members.length, 2);
        assert.strictEqual(got.entity.members[0].profileId, 'guardian_starter');

        phpEval(
            `echo json_encode(\\De\\PresetCrud::delete('standard', 'parties', ${JSON.stringify(TEST_PARTY_ID)}));`
        );
        assert.ok(!fs.existsSync(partyPath));
    });

    test('soft refs warn for known spell usage', () => {
        // melee_auto is used by classes / strategies
        const data = phpEval(
            `echo json_encode(\\De\\PresetCrud::refs('standard', 'spells', 'melee_auto'));`
        );
        assert.ok(Array.isArray(data.warnings));
        assert.ok(data.warnings.length >= 1, 'expected at least one ref to melee_auto');
        assert.ok(data.refs.some((r) => r.kind === 'classes' || r.kind === 'strategies'));
    });

    test('creature save rename delete updates mode.json browser.creatures', () => {
        const modePath = path.join(ROOT, 'presets/standard/mode.json');
        const fromPath = path.join(
            ROOT,
            'presets/standard/creatures',
            TEST_CREATURE_ID + '.json'
        );
        const toPath = path.join(
            ROOT,
            'presets/standard/creatures',
            TEST_CREATURE_RENAME_TO + '.json'
        );
        for (const p of [fromPath, toPath]) {
            if (fs.existsSync(p)) fs.unlinkSync(p);
        }

        const before = JSON.parse(fs.readFileSync(modePath, 'utf8'));
        assert.ok(Array.isArray(before.browser.creatures));
        assert.ok(
            !before.browser.creatures.includes(TEST_CREATURE_ID),
            'test id should not be in browser list before create'
        );

        phpEval(`
echo json_encode(\\De\\PresetCrud::save([
  'mode' => 'standard',
  'kind' => 'creatures',
  'id' => ${JSON.stringify(TEST_CREATURE_ID)},
  'entity' => [
    'id' => ${JSON.stringify(TEST_CREATURE_ID)},
    'label' => 'PoC Browser List Creature',
    'hp' => 50,
    'hpMax' => 50,
  ],
]));
`);
        let mode = JSON.parse(fs.readFileSync(modePath, 'utf8'));
        assert.ok(
            mode.browser.creatures.includes(TEST_CREATURE_ID),
            'create should add browser.creatures entry'
        );

        phpEval(`
echo json_encode(\\De\\PresetCrud::rename([
  'mode' => 'standard',
  'kind' => 'creatures',
  'from' => ${JSON.stringify(TEST_CREATURE_ID)},
  'to' => ${JSON.stringify(TEST_CREATURE_RENAME_TO)},
  'updateRefs' => false,
]));
`);
        mode = JSON.parse(fs.readFileSync(modePath, 'utf8'));
        assert.ok(
            !mode.browser.creatures.includes(TEST_CREATURE_ID),
            'rename should drop old browser.creatures id'
        );
        assert.ok(
            mode.browser.creatures.includes(TEST_CREATURE_RENAME_TO),
            'rename should add new browser.creatures id'
        );

        phpEval(
            `echo json_encode(\\De\\PresetCrud::delete('standard', 'creatures', ${JSON.stringify(TEST_CREATURE_RENAME_TO)}));`
        );
        mode = JSON.parse(fs.readFileSync(modePath, 'utf8'));
        assert.ok(
            !mode.browser.creatures.includes(TEST_CREATURE_RENAME_TO),
            'delete should remove browser.creatures entry'
        );
        assert.ok(!fs.existsSync(fromPath));
        assert.ok(!fs.existsSync(toPath));
    });

    test('rename creature rewrites population soft refs', () => {
        const fromPath = path.join(
            ROOT,
            'presets/standard/creatures',
            TEST_CREATURE_ID + '.json'
        );
        const toPath = path.join(
            ROOT,
            'presets/standard/creatures',
            TEST_CREATURE_RENAME_TO + '.json'
        );
        const popPath = path.join(
            ROOT,
            'presets/standard/populations',
            TEST_POP_ID + '.json'
        );
        // Clean leftovers from a previous failed run.
        for (const p of [fromPath, toPath, popPath]) {
            if (fs.existsSync(p)) fs.unlinkSync(p);
        }

        phpEval(`
echo json_encode(\\De\\PresetCrud::save([
  'mode' => 'standard',
  'kind' => 'creatures',
  'id' => ${JSON.stringify(TEST_CREATURE_ID)},
  'entity' => [
    'id' => ${JSON.stringify(TEST_CREATURE_ID)},
    'label' => 'PoC Rename Creature',
    'hp' => 100,
    'hpMax' => 100,
  ],
]));
`);
        phpEval(`
echo json_encode(\\De\\PresetCrud::save([
  'mode' => 'standard',
  'kind' => 'populations',
  'id' => ${JSON.stringify(TEST_POP_ID)},
  'entity' => [
    'id' => ${JSON.stringify(TEST_POP_ID)},
    'label' => 'PoC Rename Pop',
    'groups' => [
      'main' => [
        'creatureIds' => [${JSON.stringify(TEST_CREATURE_ID)}, 'rat'],
        'weight' => 1,
      ],
    ],
  ],
]));
`);

        const refsBefore = phpEval(
            `echo json_encode(\\De\\PresetCrud::refs('standard', 'creatures', ${JSON.stringify(TEST_CREATURE_ID)}));`
        );
        assert.ok(
            refsBefore.refs.some(
                (r) => r.kind === 'populations' && r.id === TEST_POP_ID
            ),
            'population should reference creature before rename'
        );

        const renamed = phpEval(`
echo json_encode(\\De\\PresetCrud::rename([
  'mode' => 'standard',
  'kind' => 'creatures',
  'from' => ${JSON.stringify(TEST_CREATURE_ID)},
  'to' => ${JSON.stringify(TEST_CREATURE_RENAME_TO)},
  'updateRefs' => true,
]));
`);
        assert.strictEqual(renamed.id, TEST_CREATURE_RENAME_TO);
        assert.strictEqual(renamed.renamedFrom, TEST_CREATURE_ID);
        assert.ok(renamed.refsUpdatedCount >= 1, 'expected at least one ref rewrite');
        assert.ok(
            renamed.refsUpdated.some(
                (r) => r.kind === 'populations' && r.id === TEST_POP_ID
            )
        );
        assert.ok(!fs.existsSync(fromPath), 'old creature file removed');
        assert.ok(fs.existsSync(toPath), 'new creature file created');

        const pop = JSON.parse(fs.readFileSync(popPath, 'utf8'));
        assert.deepStrictEqual(pop.groups.main.creatureIds, [
            TEST_CREATURE_RENAME_TO,
            'rat'
        ]);

        const refsAfterOld = phpEval(
            `echo json_encode(\\De\\PresetCrud::refs('standard', 'creatures', ${JSON.stringify(TEST_CREATURE_ID)}));`
        );
        assert.strictEqual(
            refsAfterOld.refs.length,
            0,
            'old id should have no soft refs'
        );

        phpEval(
            `echo json_encode(\\De\\PresetCrud::delete('standard', 'populations', ${JSON.stringify(TEST_POP_ID)}));`
        );
        phpEval(
            `echo json_encode(\\De\\PresetCrud::delete('standard', 'creatures', ${JSON.stringify(TEST_CREATURE_RENAME_TO)}));`
        );
    });

    test('tile_roles list get save rename rewrites art-set roleId', () => {
        const listed = phpEval(
            `echo json_encode(\\De\\PresetCrud::list('standard', 'tile_roles'));`
        );
        assert.strictEqual(listed.shape, 'folder');
        assert.ok(listed.items.some((r) => r.id === 'path'));
        assert.ok(listed.items.some((r) => r.id === 'wall'));

        const pathRole = phpEval(
            `echo json_encode(\\De\\PresetCrud::get('standard', 'tile_roles', 'path'));`
        );
        assert.strictEqual(pathRole.entity.id, 'path');
        assert.ok(pathRole.entity.kindHints.includes('overlays'));
        assert.strictEqual(pathRole.entity.vertical, null);

        const wallRole = phpEval(
            `echo json_encode(\\De\\PresetCrud::get('standard', 'tile_roles', 'wall'));`
        );
        assert.strictEqual(wallRole.entity.vertical, null);
        assert.ok(wallRole.entity.kindHints.includes('objects'));

        const rolePath = path.join(
            ROOT,
            'presets/standard/tile_roles',
            TEST_TILE_ROLE_ID + '.json'
        );
        const roleToPath = path.join(
            ROOT,
            'presets/standard/tile_roles',
            TEST_TILE_ROLE_RENAME_TO + '.json'
        );
        const artPath = path.join(
            ROOT,
            'presets/standard/art_sets',
            TEST_ART_SET_ID + '.json'
        );
        for (const p of [rolePath, roleToPath, artPath]) {
            if (fs.existsSync(p)) fs.unlinkSync(p);
        }

        phpEval(`
echo json_encode(\\De\\PresetCrud::save([
  'mode' => 'standard',
  'kind' => 'tile_roles',
  'id' => ${JSON.stringify(TEST_TILE_ROLE_ID)},
  'entity' => [
    'id' => ${JSON.stringify(TEST_TILE_ROLE_ID)},
    'label' => 'PoC Role',
    'kindHints' => ['tiles'],
    'catalogCategories' => [],
    'influence' => [
      'friction' => 100,
      'sight' => 0,
      'flags' => 0,
      'walkMode' => 'open',
      'sightMode' => 'clear',
    ],
    'vertical' => null,
  ],
]));
`);
        phpEval(`
echo json_encode(\\De\\PresetCrud::save([
  'mode' => 'standard',
  'kind' => 'art_sets',
  'id' => ${JSON.stringify(TEST_ART_SET_ID)},
  'entity' => [
    'id' => ${JSON.stringify(TEST_ART_SET_ID)},
    'label' => 'PoC Art',
    'roles' => [
      'floor' => [
        [
          'id' => 'damp_dirt_floor',
          'roleId' => ${JSON.stringify(TEST_TILE_ROLE_ID)},
          'weight' => 1,
        ],
      ],
    ],
  ],
]));
`);

        const refsBefore = phpEval(
            `echo json_encode(\\De\\PresetCrud::refs('standard', 'tile_roles', ${JSON.stringify(TEST_TILE_ROLE_ID)}));`
        );
        assert.ok(
            refsBefore.refs.some(
                (r) => r.kind === 'art_sets' && r.id === TEST_ART_SET_ID
            ),
            'art set should reference tile role before rename'
        );

        const renamed = phpEval(`
echo json_encode(\\De\\PresetCrud::rename([
  'mode' => 'standard',
  'kind' => 'tile_roles',
  'from' => ${JSON.stringify(TEST_TILE_ROLE_ID)},
  'to' => ${JSON.stringify(TEST_TILE_ROLE_RENAME_TO)},
  'updateRefs' => true,
]));
`);
        assert.strictEqual(renamed.id, TEST_TILE_ROLE_RENAME_TO);
        assert.ok(renamed.refsUpdatedCount >= 1);
        assert.ok(
            renamed.refsUpdated.some(
                (r) => r.kind === 'art_sets' && r.id === TEST_ART_SET_ID
            )
        );

        const art = JSON.parse(fs.readFileSync(artPath, 'utf8'));
        assert.strictEqual(art.roles.floor[0].roleId, TEST_TILE_ROLE_RENAME_TO);
        assert.ok(!fs.existsSync(rolePath));
        assert.ok(fs.existsSync(roleToPath));

        phpEval(
            `echo json_encode(\\De\\PresetCrud::delete('standard', 'art_sets', ${JSON.stringify(TEST_ART_SET_ID)}));`
        );
        phpEval(
            `echo json_encode(\\De\\PresetCrud::delete('standard', 'tile_roles', ${JSON.stringify(TEST_TILE_ROLE_RENAME_TO)}));`
        );
    });

    test('dialogs list get save rename rewrites creature dialogId', () => {
        const listed = phpEval(
            `echo json_encode(\\De\\PresetCrud::list('standard', 'dialogs'));`
        );
        assert.strictEqual(listed.shape, 'folder');
        assert.ok(listed.items.some((r) => r.id === 'town_guide'));

        const town = phpEval(
            `echo json_encode(\\De\\PresetCrud::get('standard', 'dialogs', 'town_guide'));`
        );
        assert.strictEqual(town.entity.id, 'town_guide');
        assert.ok(town.entity.nodes && town.entity.nodes.start);
        assert.ok(Array.isArray(town.entity.nodes.start.replies));

        const dialogPath = path.join(
            ROOT,
            'presets/standard/dialogs',
            TEST_DIALOG_ID + '.json'
        );
        const dialogToPath = path.join(
            ROOT,
            'presets/standard/dialogs',
            TEST_DIALOG_RENAME_TO + '.json'
        );
        const creaturePath = path.join(
            ROOT,
            'presets/standard/creatures',
            TEST_CREATURE_ID + '.json'
        );
        for (const p of [dialogPath, dialogToPath, creaturePath]) {
            if (fs.existsSync(p)) fs.unlinkSync(p);
        }

        phpEval(`
echo json_encode(\\De\\PresetCrud::save([
  'mode' => 'standard',
  'kind' => 'dialogs',
  'id' => ${JSON.stringify(TEST_DIALOG_ID)},
  'entity' => [
    'id' => ${JSON.stringify(TEST_DIALOG_ID)},
    'label' => 'PoC Dialog',
    'greeting' => 'Hello.',
    'start' => 'start',
    'nodes' => [
      'start' => [
        'text' => 'Hello.',
        'replies' => [
          ['label' => 'Bye', 'action' => 'close'],
        ],
      ],
    ],
  ],
]));
`);
        phpEval(`
echo json_encode(\\De\\PresetCrud::save([
  'mode' => 'standard',
  'kind' => 'creatures',
  'id' => ${JSON.stringify(TEST_CREATURE_ID)},
  'entity' => [
    'id' => ${JSON.stringify(TEST_CREATURE_ID)},
    'label' => 'PoC Dialog NPC',
    'dialogId' => ${JSON.stringify(TEST_DIALOG_ID)},
    'hp' => 50,
    'hpMax' => 50,
  ],
]));
`);

        const refsBefore = phpEval(
            `echo json_encode(\\De\\PresetCrud::refs('standard', 'dialogs', ${JSON.stringify(TEST_DIALOG_ID)}));`
        );
        assert.ok(
            refsBefore.refs.some(
                (r) => r.kind === 'creatures' && r.id === TEST_CREATURE_ID
            ),
            'creature should reference dialog before rename'
        );

        const renamed = phpEval(`
echo json_encode(\\De\\PresetCrud::rename([
  'mode' => 'standard',
  'kind' => 'dialogs',
  'from' => ${JSON.stringify(TEST_DIALOG_ID)},
  'to' => ${JSON.stringify(TEST_DIALOG_RENAME_TO)},
  'updateRefs' => true,
]));
`);
        assert.strictEqual(renamed.id, TEST_DIALOG_RENAME_TO);
        assert.ok(renamed.refsUpdatedCount >= 1);
        assert.ok(
            renamed.refsUpdated.some(
                (r) => r.kind === 'creatures' && r.id === TEST_CREATURE_ID
            )
        );

        const creature = JSON.parse(fs.readFileSync(creaturePath, 'utf8'));
        assert.strictEqual(creature.dialogId, TEST_DIALOG_RENAME_TO);
        assert.ok(!fs.existsSync(dialogPath));
        assert.ok(fs.existsSync(dialogToPath));

        phpEval(
            `echo json_encode(\\De\\PresetCrud::delete('standard', 'creatures', ${JSON.stringify(TEST_CREATURE_ID)}));`
        );
        phpEval(
            `echo json_encode(\\De\\PresetCrud::delete('standard', 'dialogs', ${JSON.stringify(TEST_DIALOG_RENAME_TO)}));`
        );
    });

    test('waypoints list get save rename rewrites hunt waypointPreset', () => {
        const listed = phpEval(
            `echo json_encode(\\De\\PresetCrud::list('standard', 'waypoints'));`
        );
        assert.strictEqual(listed.shape, 'folder');
        assert.ok(listed.items.some((r) => r.id === 'wp_test_1'));

        const wpPath = path.join(
            ROOT,
            'presets/standard/waypoints',
            TEST_WAYPOINT_ID + '.json'
        );
        const wpToPath = path.join(
            ROOT,
            'presets/standard/waypoints',
            TEST_WAYPOINT_RENAME_TO + '.json'
        );
        const huntPath = path.join(
            ROOT,
            'presets/standard/hunts',
            TEST_HUNT_WP_ID + '.json'
        );
        for (const p of [wpPath, wpToPath, huntPath]) {
            if (fs.existsSync(p)) fs.unlinkSync(p);
        }

        phpEval(`
echo json_encode(\\De\\PresetCrud::save([
  'mode' => 'standard',
  'kind' => 'waypoints',
  'id' => ${JSON.stringify(TEST_WAYPOINT_ID)},
  'entity' => [
    'id' => ${JSON.stringify(TEST_WAYPOINT_ID)},
    'label' => 'PoC Route',
    'floor' => 7,
    'waypoints' => [
      ['x' => 1, 'y' => 2, 'z' => 7],
      ['x' => 3, 'y' => 4, 'z' => 7],
    ],
  ],
]));
`);

        fs.writeFileSync(
            huntPath,
            JSON.stringify(
                {
                    id: TEST_HUNT_WP_ID,
                    label: 'PoC Hunt WP',
                    waypointPreset: TEST_WAYPOINT_ID
                },
                null,
                2
            ) + '\n'
        );

        const refsBefore = phpEval(
            `echo json_encode(\\De\\PresetCrud::refs('standard', 'waypoints', ${JSON.stringify(TEST_WAYPOINT_ID)}));`
        );
        assert.ok(
            refsBefore.refs.some(
                (r) => r.kind === 'hunts' && r.id === TEST_HUNT_WP_ID
            ),
            'hunt should reference waypoint pack before rename'
        );

        const renamed = phpEval(`
echo json_encode(\\De\\PresetCrud::rename([
  'mode' => 'standard',
  'kind' => 'waypoints',
  'from' => ${JSON.stringify(TEST_WAYPOINT_ID)},
  'to' => ${JSON.stringify(TEST_WAYPOINT_RENAME_TO)},
  'updateRefs' => true,
]));
`);
        assert.strictEqual(renamed.id, TEST_WAYPOINT_RENAME_TO);
        assert.ok(renamed.refsUpdatedCount >= 1);
        assert.ok(
            renamed.refsUpdated.some(
                (r) => r.kind === 'hunts' && r.id === TEST_HUNT_WP_ID
            )
        );

        const hunt = JSON.parse(fs.readFileSync(huntPath, 'utf8'));
        assert.strictEqual(hunt.waypointPreset, TEST_WAYPOINT_RENAME_TO);
        assert.ok(!fs.existsSync(wpPath));
        assert.ok(fs.existsSync(wpToPath));

        fs.unlinkSync(huntPath);
        phpEval(
            `echo json_encode(\\De\\PresetCrud::delete('standard', 'waypoints', ${JSON.stringify(TEST_WAYPOINT_RENAME_TO)}));`
        );
    });

    test('blank templates for new kinds', () => {
        const eq = phpEval(
            `echo json_encode(\\De\\PresetCrud::blankTemplate('equipment', 'foo_eq'));`
        );
        assert.strictEqual(eq.id, 'foo_eq');
        assert.strictEqual(eq.slot, 'rightHand');
        const pop = phpEval(
            `echo json_encode(\\De\\PresetCrud::blankTemplate('populations', 'foo_pop'));`
        );
        assert.strictEqual(pop.id, 'foo_pop');
        assert.ok(pop.groups);
        const biome = phpEval(
            `echo json_encode(\\De\\PresetCrud::blankTemplate('biomes', 'foo_biome'));`
        );
        assert.strictEqual(biome.populationId, 'cave_rats');
        const pack = phpEval(
            `echo json_encode(\\De\\PresetCrud::blankTemplate('pieces', 'foo_pack'));`
        );
        assert.strictEqual(pack.id, 'foo_pack');
        assert.ok(Array.isArray(pack.pieces));
        assert.ok(pack.pieces.length >= 1);
        assert.ok(Array.isArray(pack.pieces[0].friction));
        const role = phpEval(
            `echo json_encode(\\De\\PresetCrud::blankTemplate('tile_roles', 'foo_role'));`
        );
        assert.strictEqual(role.id, 'foo_role');
        assert.strictEqual(role.vertical, null);
        assert.ok(role.influence);
        assert.deepStrictEqual(role.kindHints, ['tiles']);
        const dialog = phpEval(
            `echo json_encode(\\De\\PresetCrud::blankTemplate('dialogs', 'foo_dialog'));`
        );
        assert.strictEqual(dialog.id, 'foo_dialog');
        assert.strictEqual(dialog.start, 'start');
        assert.ok(dialog.nodes && dialog.nodes.start);
        const wp = phpEval(
            `echo json_encode(\\De\\PresetCrud::blankTemplate('waypoints', 'foo_route'));`
        );
        assert.strictEqual(wp.id, 'foo_route');
        assert.ok(Array.isArray(wp.waypoints));
        assert.ok(wp.waypoints.length >= 1);
    });

    test('piece pack nested_pack list get round-trip', () => {
        const packPath = path.join(
            ROOT,
            'presets/standard/pieces',
            TEST_PIECE_PACK_ID + '.json'
        );
        assert.ok(!fs.existsSync(packPath));

        const list = phpEval(
            `echo json_encode(\\De\\PresetCrud::list('standard', 'pieces'));`
        );
        assert.strictEqual(list.shape, 'nested_pack');
        assert.ok(list.items.some((r) => r.id === 'cave_v1'));

        const saved = phpEval(`
echo json_encode(\\De\\PresetCrud::save([
  'mode' => 'standard',
  'kind' => 'pieces',
  'id' => ${JSON.stringify(TEST_PIECE_PACK_ID)},
  'entity' => [
    'id' => ${JSON.stringify(TEST_PIECE_PACK_ID)},
    'biome' => 'cave',
    'notes' => 'designer phase 3 test pack',
    'pieces' => [
      [
        'id' => 'poc_room',
        'size' => ['w' => 3, 'h' => 3],
        'exits' => ['N' => true, 'S' => true, 'E' => false, 'W' => false],
        'friction' => ['#.#', '...', '#.#'],
        'sockets' => [
          'spawns' => [['x' => 1, 'y' => 1]],
          'markers' => [],
          'waypoints' => [['x' => 1, 'y' => 0], ['x' => 1, 'y' => 2]],
        ],
        'tags' => ['room', 'poc'],
      ],
    ],
  ],
]));
`);
        assert.strictEqual(saved.created, true);
        assert.strictEqual(saved.shape, 'nested_pack');
        assert.ok(fs.existsSync(packPath));

        const got = phpEval(
            `echo json_encode(\\De\\PresetCrud::get('standard', 'pieces', ${JSON.stringify(TEST_PIECE_PACK_ID)}));`
        );
        assert.strictEqual(got.shape, 'nested_pack');
        assert.strictEqual(got.entity.id, TEST_PIECE_PACK_ID);
        assert.strictEqual(got.entity.pieces.length, 1);
        assert.strictEqual(got.entity.pieces[0].id, 'poc_room');
        assert.deepStrictEqual(got.entity.pieces[0].friction, ['#.#', '...', '#.#']);

        const ids = phpEval(
            `echo json_encode(\\De\\PresetCrud::ids('standard', 'pieces'));`
        );
        assert.ok(ids.ids.includes(TEST_PIECE_PACK_ID));
        assert.ok(ids.ids.includes('cave_v1'));

        const del = phpEval(
            `echo json_encode(\\De\\PresetCrud::delete('standard', 'pieces', ${JSON.stringify(TEST_PIECE_PACK_ID)}));`
        );
        assert.strictEqual(del.deleted, true);
        assert.strictEqual(del.shape, 'nested_pack');
        assert.ok(!fs.existsSync(packPath));
    });

    test('piece pack soft refs for cave_v1', () => {
        const data = phpEval(
            `echo json_encode(\\De\\PresetCrud::refs('standard', 'pieces', 'cave_v1'));`
        );
        assert.ok(Array.isArray(data.warnings));
        // cave biome / dungeon profiles typically reference cave_v1
        assert.ok(
            data.refs.some((r) => r.kind === 'biomes' || r.kind === 'dungeons'),
            'expected biome or dungeon ref to cave_v1'
        );
    });

    test('presets_validate pieces cave_v1 and biomes', () => {
        const pack = phpEval(
            `echo json_encode(\\De\\PresetCrud::validate('standard', 'pieces', 'cave_v1'));`
        );
        assert.strictEqual(pack.kind, 'pieces');
        assert.strictEqual(pack.id, 'cave_v1');
        assert.ok(Array.isArray(pack.errors));
        assert.ok(Array.isArray(pack.warnings));
        assert.strictEqual(pack.ok, true, 'cave_v1 should validate: ' + JSON.stringify(pack.errors));
        assert.ok(pack.level === 'layout' || pack.level === 'stress');
        assert.ok(pack.durationMs == null || typeof pack.durationMs === 'number');

        const biomeList = phpEval(
            `echo json_encode(\\De\\PresetCrud::list('standard', 'biomes'));`
        );
        if (biomeList.total >= 1) {
            const biomeId = biomeList.items[0].id;
            const biome = phpEval(
                `echo json_encode(\\De\\PresetCrud::validate('standard', 'biomes', ${JSON.stringify(biomeId)}));`
            );
            assert.ok(typeof biome.ok === 'boolean');
            assert.ok(Array.isArray(biome.errors));
        }
    });

    test('presets_validate dungeons small_crawl layout', () => {
        const report = phpEval(
            `echo json_encode(\\De\\PresetCrud::validate('standard', 'dungeons', 'small_crawl', 'layout'));`
        );
        assert.strictEqual(report.kind, 'dungeons');
        assert.strictEqual(report.id, 'small_crawl');
        assert.strictEqual(report.level, 'layout');
        assert.ok(Array.isArray(report.errors));
        assert.ok(Array.isArray(report.warnings));
        assert.strictEqual(
            report.ok,
            true,
            'small_crawl layout should pass: ' + JSON.stringify(report.errors)
        );
        assert.ok(report.detail && typeof report.detail === 'object');
        assert.ok(
            report.detail.passed >= 1,
            'expected at least one passed seed'
        );
        assert.strictEqual(report.detail.failed, 0);
    });

    test('presets_validate tile_roles path water wall stairs_up', () => {
        for (const id of ['path', 'water', 'wall', 'stairs_up']) {
            const report = phpEval(
                `echo json_encode(\\De\\PresetCrud::validate('standard', 'tile_roles', ${JSON.stringify(id)}));`
            );
            assert.strictEqual(report.kind, 'tile_roles');
            assert.strictEqual(report.id, id);
            assert.strictEqual(
                report.ok,
                true,
                id + ' should validate: ' + JSON.stringify(report.errors)
            );
        }

        const badPath = path.join(
            ROOT,
            'presets/standard/tile_roles',
            TEST_TILE_ROLE_ID + '.json'
        );
        if (fs.existsSync(badPath)) fs.unlinkSync(badPath);
        phpEval(`
echo json_encode(\\De\\PresetCrud::save([
  'mode' => 'standard',
  'kind' => 'tile_roles',
  'id' => ${JSON.stringify(TEST_TILE_ROLE_ID)},
  'entity' => [
    'id' => ${JSON.stringify(TEST_TILE_ROLE_ID)},
    'label' => 'Bad Wall Hop',
    'kindHints' => ['objects'],
    'catalogCategories' => ['wall'],
    'influence' => [
      'friction' => 255,
      'sight' => 255,
      'flags' => 0,
      'walkMode' => 'block',
      'sightMode' => 'block',
    ],
    'vertical' => [
      'type' => 'stairs',
      'deltaZ' => -1,
    ],
  ],
]));
`);
        const bad = phpEval(
            `echo json_encode(\\De\\PresetCrud::validate('standard', 'tile_roles', ${JSON.stringify(TEST_TILE_ROLE_ID)}));`
        );
        assert.strictEqual(bad.ok, false);
        assert.ok(
            bad.errors.some((e) => /vertical_hop_on_wall_face/.test(String(e))),
            'expected wall+hop error: ' + JSON.stringify(bad.errors)
        );
        phpEval(
            `echo json_encode(\\De\\PresetCrud::delete('standard', 'tile_roles', ${JSON.stringify(TEST_TILE_ROLE_ID)}));`
        );
    });

    test('dungeon soft refs include hunts; equipment soft refs include profiles', () => {
        const dungeon = phpEval(
            `echo json_encode(\\De\\PresetCrud::refs('standard', 'dungeons', 'small_crawl'));`
        );
        assert.ok(
            dungeon.refs.some((r) => r.kind === 'hunts'),
            'small_crawl should be referenced by at least one hunt'
        );
        assert.ok(
            dungeon.refs.some((r) => r.kind === 'biomes'),
            'small_crawl should be referenced by biomes'
        );

        const equip = phpEval(
            `echo json_encode(\\De\\PresetCrud::refs('standard', 'equipment', 'iron_longsword'));`
        );
        // Parties no longer embed gear; loadouts live on player_profiles.
        assert.ok(
            equip.refs.some(
                (r) =>
                    r.kind === 'player_profiles' &&
                    /equipment/i.test(String(r.field || ''))
            ),
            'iron_longsword should appear on player_profiles equipment'
        );
    });

    test('unknown kind rejected (hunts, scenarios)', () => {
        for (const bad of ['hunts', 'scenarios']) {
            const data = phpEval(`
try {
  \\De\\PresetCrud::list('standard', ${JSON.stringify(bad)});
  echo json_encode(['ok' => true]);
} catch (Throwable $e) {
  echo json_encode(['ok' => false, 'error' => $e->getMessage()]);
}
`);
            assert.strictEqual(data.ok, false, bad + ' should be rejected');
            assert.ok(/unsupported kind/i.test(String(data.error || '')));
        }
    });

    test('catalog files still valid JSON after tests', () => {
        for (const rel of [
            'presets/standard/spells.json',
            'presets/standard/classes.json',
            'presets/standard/equipment.json',
            'presets/standard/strategies.json'
        ]) {
            const data = JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
            assert.ok(data && typeof data === 'object');
        }
        assert.ok(
            !fs.existsSync(
                path.join(ROOT, 'presets/standard/populations', TEST_POP_ID + '.json')
            )
        );
        assert.ok(
            !fs.existsSync(
                path.join(ROOT, 'presets/standard/pieces', TEST_PIECE_PACK_ID + '.json')
            )
        );
        assert.ok(
            !fs.existsSync(
                path.join(ROOT, 'presets/standard/creatures', TEST_CREATURE_ID + '.json')
            )
        );
    });

    cleanup();

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
}

main();
