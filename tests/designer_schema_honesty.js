#!/usr/bin/env node
/**
 * D0 schema honesty: declared keys exist, duplicate property keys are gone,
 * and live files the form must round-trip still validate.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/**
 * @param {string} jsonText
 * @param {string} label
 */
function assertNoDuplicateKeys(jsonText, label) {
    const stack = [new Set()];
    let i = 0;
    const n = jsonText.length;
    let inStr = false;
    let escape = false;
    let pendingKey = false;

    while (i < n) {
        const ch = jsonText[i];
        if (inStr) {
            if (escape) {
                escape = false;
            } else if (ch === '\\') {
                escape = true;
            } else if (ch === '"') {
                inStr = false;
            }
            i += 1;
            continue;
        }
        if (ch === '"') {
            const start = i;
            i += 1;
            let esc = false;
            while (i < n) {
                const c = jsonText[i];
                if (esc) {
                    esc = false;
                } else if (c === '\\') {
                    esc = true;
                } else if (c === '"') {
                    break;
                }
                i += 1;
            }
            const raw = jsonText.slice(start + 1, i);
            i += 1;
            let j = i;
            while (j < n && /\s/.test(jsonText[j])) j += 1;
            if (jsonText[j] === ':') {
                const keys = stack[stack.length - 1];
                assert.ok(
                    !keys.has(raw),
                    `${label} duplicate key "${raw}"`
                );
                keys.add(raw);
                pendingKey = true;
                i = j + 1;
            }
            continue;
        }
        if (ch === '{') {
            stack.push(new Set());
            pendingKey = false;
        } else if (ch === '}') {
            stack.pop();
            pendingKey = false;
        } else if (ch === '[') {
            stack.push(new Set());
            pendingKey = false;
        } else if (ch === ']') {
            stack.pop();
            pendingKey = false;
        }
        i += 1;
    }
}

/**
 * @param {string} rel
 * @returns {object}
 */
function loadJson(rel) {
    return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

function requiredProps(schema, keys, label) {
    const props = schema.properties || {};
    for (const key of keys) {
        assert.ok(props[key], `${label} missing properties.${key}`);
    }
}

function testDuplicateKeysGone() {
    const files = [
        'schemas/creatures.schema.json',
        'schemas/equipment.schema.json',
        'schemas/spells.schema.json',
        'schemas/populations.schema.json',
        'schemas/markers.schema.json',
        'schemas/pieces.schema.json'
    ];
    for (const rel of files) {
        assertNoDuplicateKeys(fs.readFileSync(path.join(ROOT, rel), 'utf8'), rel);
    }
}

function testDeclaredKeys() {
    const creatures = loadJson('schemas/creatures.schema.json');
    requiredProps(
        creatures,
        [
            'loot',
            'immunities',
            'changeTarget',
            'race',
            'maxBlock',
            'source',
            'flags'
        ],
        'creatures'
    );
    const flagProps = creatures.properties.flags.properties || {};
    for (const key of [
        'targetDistance',
        'runHealth',
        'canWalkOnFire',
        'hostile',
        'isNpc'
    ]) {
        assert.ok(flagProps[key], `creatures.flags missing ${key}`);
    }
    assert.ok(
        !flagProps.retargetIntervalSec && !flagProps.retargetChance,
        'retarget is changeTarget only, not flags'
    );
    const lootId = creatures.properties.loot.items.properties.id;
    assert.strictEqual(lootId.format, 'equipment_id');
    const shopItem = creatures.properties.shop.properties.items.items.properties.item;
    assert.strictEqual(shopItem.format, 'equipment_id');
    const summonId = creatures.properties.summon.properties.summons.items.properties.id;
    assert.strictEqual(summonId.format, 'creature_id');
    const cond = creatures.properties.attacks.items.properties.condition;
    assert.strictEqual(cond.type, 'object');
    assert.ok(cond.properties && cond.properties.type);
    const atkProps = creatures.properties.attacks.items.properties;
    for (const key of ['range', 'radius', 'length', 'spread', 'shootEffect']) {
        assert.ok(atkProps[key], `attacks.items missing ${key}`);
        const deps = atkProps[key].options && atkProps[key].options.dependencies;
        assert.ok(
            !deps,
            `attacks.${key} must not use options.dependencies (Save drops hidden live keys)`
        );
    }
    assert.ok(atkProps.effect.enum.includes(''));
    assert.ok(atkProps.shootEffect.enum.includes(''));
    assert.strictEqual(atkProps.effect.default, '');
    assert.strictEqual(atkProps.shootEffect.default, '');
    const condType = cond.properties.type;
    assert.ok(condType.enum.includes(''));
    assert.strictEqual(condType.default, '');
    assert.ok(creatures.properties.race.enum.includes(''));
    assert.strictEqual(creatures.properties.race.default, '');
    const defKind = creatures.properties.defenseSpells.items.properties.kind;
    assert.ok(defKind.enum.includes(''));
    assert.strictEqual(defKind.default, '');
    const st = creatures.properties.strategiesTarget.properties;
    assert.ok(st.nearest && st.damage && st.health && st.random);
    assert.strictEqual(creatures.properties.flags.properties.targetDistance.minimum, 0);

    const equipment = loadJson('schemas/equipment.schema.json');
    const item = equipment.definitions.equipmentItem;
    requiredProps(
        item,
        [
            'heal',
            'restoreMana',
            'worth',
            'volume',
            'imbuementSlots',
            'consumable',
            'usable',
            'type',
            'vocation',
            'level',
            'hitChance',
            'perfectShotDamage',
            'perfectShotRange',
            'slot',
            'category',
            'weaponType',
            'customSprite',
            'atk',
            'extraAtk',
            'extraAtkElement',
            'maxHitChance',
            'critChance',
            'critExtraDamage',
            'lifeLeechChance',
            'lifeLeechAmount',
            'manaLeechChance',
            'manaLeechAmount',
            'aliases',
            'dispel',
            'condition'
        ],
        'equipmentItem'
    );
    assert.ok(item.properties.slot.enum.includes('rightHand'));
    assert.ok(item.properties.slot.enum.includes(''));
    assert.strictEqual(item.properties.slot.default, '');
    assert.ok(item.properties.category.enum.includes('potion'));
    assert.ok(item.properties.weaponType.enum.includes('melee'));
    assert.ok(item.properties.weaponType.enum.includes(''));
    assert.strictEqual(item.properties.weaponType.default, '');
    assert.ok(item.properties.ammoType.enum.includes(''));
    assert.strictEqual(item.properties.ammoType.default, '');
    assert.ok(!Object.prototype.hasOwnProperty.call(item.properties.stackable, 'default'));
    assert.strictEqual(item.properties.heal.minItems, 2);
    assert.strictEqual(item.properties.heal.maxItems, 2);
    assert.strictEqual(item.properties.customSprite.format, 'catalog_asset_id');
    assert.ok(item.properties.condition.properties.type.enum.includes('mana_shield'));
    assert.ok(item.properties.condition.properties.type.enum.includes(''));
    assert.ok(item.properties.extraAtkElement.enum.includes(''));
    assert.ok(item.properties.extraAtkElement.enum.includes('fire'));
    assert.strictEqual(item.properties.extraAtkElement.default, '');
    const ct = creatures.properties.changeTarget.properties;
    assert.ok(ct.interval);
    assert.ok(ct.chance);
    assert.strictEqual(ct.interval.minimum, 0);
    assert.strictEqual(ct.chance.maximum, 100);

    const spells = loadJson('schemas/spells.schema.json');
    const spellProps = spells.definitions.spell.properties;
    const ui = spellProps.customUISprite;
    assert.strictEqual(ui.format, 'catalog_asset_id');
    assert.strictEqual(ui.options.assetKind, 'ui');
    for (const key of ['source', 'field', 'deploysField', 'element', 'powerCurve']) {
        assert.ok(spellProps[key].enum.includes(''), `spells.${key} needs empty enum`);
        assert.strictEqual(spellProps[key].default, '', `spells.${key} default`);
    }
    assert.ok(spellProps.shape.properties.type.enum.includes(''));
    assert.ok(spellProps.condition.properties.type.enum.includes(''));
    assert.ok(spellProps.notes);

    const pops = loadJson('schemas/populations.schema.json');
    requiredProps(pops, ['band', 'limits'], 'populations');
    assert.ok(pops.properties.band.properties.levelMin);
    assert.ok(pops.properties.limits.properties.totalPacks);

    const markers = loadJson('schemas/markers.schema.json');
    const pool = markers.properties.pools.additionalProperties;
    assert.ok(pool.properties.healAmount);
    assert.strictEqual(pool.properties.objectIds.items.format, 'catalog_asset_id');
    assert.strictEqual(pool.properties.objectIds.items.options.assetKind, 'objects');

    const pieces = loadJson('schemas/pieces.schema.json');
    const stair = pieces.definitions.stairPoint.properties;
    assert.deepStrictEqual(stair.dir.enum, ['', 'up', 'down']);
    assert.strictEqual(stair.dir.default, '');
    assert.ok(stair.link);
}

function compileAjv(schema) {
    let Ajv;
    try {
        Ajv = require('ajv');
    } catch (err) {
        console.log('skip live validate (ajv missing)');
        return null;
    }
    const AjvCtor = typeof Ajv === 'function' ? Ajv : Ajv.default || Ajv.Ajv;
    const ajv = new AjvCtor({ allErrors: true, strict: false, validateSchema: true });
    return ajv.compile(schema);
}

/**
 * @param {(data: object) => boolean} validate
 * @param {object} data
 * @param {string} label
 */
function assertValid(validate, data, label) {
    const ok = validate(data);
    if (!ok) {
        const errs = (validate.errors || [])
            .slice(0, 8)
            .map((e) => `${e.instancePath || '/'} ${e.message}`)
            .join('; ');
        assert.fail(`${label} schema fail: ${errs}`);
    }
}

function testLiveFilesValidate() {
    const creaturesValidate = compileAjv(loadJson('schemas/creatures.schema.json'));
    const popValidate = compileAjv(loadJson('schemas/populations.schema.json'));
    const markValidate = compileAjv(loadJson('schemas/markers.schema.json'));
    const eqValidate = compileAjv(loadJson('schemas/equipment.schema.json'));
    const spellValidate = compileAjv(loadJson('schemas/spells.schema.json'));
    if (!creaturesValidate) return;

    assertValid(
        creaturesValidate,
        loadJson('presets/standard/creatures/frost_giant.json'),
        'frost_giant'
    );
    assertValid(
        popValidate,
        loadJson('presets/standard/populations/cave_mid_mixed.json'),
        'cave_mid_mixed'
    );
    assertValid(
        markValidate,
        loadJson('presets/standard/markers/cave_clickies.json'),
        'cave_clickies'
    );
    assertValid(
        eqValidate,
        loadJson('presets/standard/equipment.json'),
        'equipment.json'
    );
    assertValid(
        spellValidate,
        loadJson('presets/standard/spells.json'),
        'spells.json'
    );

    const potion = loadJson('presets/standard/equipment.json').items.find(
        (it) => it.id === 'small_health_potion'
    );
    assert.ok(potion, 'small_health_potion');
    assert.deepStrictEqual(potion.heal, [60, 90]);
}

function testArtSetAcceptsOverlayAndWallFamily() {
    const schema = loadJson('schemas/art_sets.schema.json');
    const wt = schema.definitions.weightedTile.properties;
    assert.deepStrictEqual(wt.kind.enum, ['tiles', 'objects', 'overlays']);
    assert.ok(wt.wangFamily);
    assert.ok(wt.wallFamily);
    assert.ok(wt.wallAlign);
    assert.ok(wt.render, 'art-set row may override render');
    assert.ok(wt.influence, 'art-set row may override influence');
    assert.ok(!wt.scale && !wt.anchor && !wt.variant, 'no flat draw aliases');
    assert.ok(wt.wangFamily.enum.indexOf('dirt') >= 0);
    assert.ok(
        /tile_roles/.test(String(wt.roleId.description || '')),
        'roleId should be a tile_roles presets_ids relation'
    );
    const validate = compileAjv(schema);
    if (!validate) return;
    assertValid(
        validate,
        loadJson('presets/standard/art_sets/cave_simple.json'),
        'cave_simple'
    );
    assertValid(
        validate,
        {
            id: 'unit_overlay_pack',
            roles: {
                path: [
                    {
                        id: 'dirt_wang_15',
                        kind: 'overlays',
                        roleId: 'path',
                        wangFamily: 'dirt',
                        weight: 3
                    }
                ],
                water: [
                    {
                        id: 'water_wang_15',
                        kind: 'overlays',
                        roleId: 'water',
                        wangFamily: 'water',
                        weight: 4
                    }
                ],
                wall: [
                    {
                        id: 'stone_wall_pole',
                        kind: 'objects',
                        roleId: 'wall',
                        wallFamily: 'stone_wall',
                        wallAlign: 'pole',
                        weight: 12
                    }
                ]
            }
        },
        'overlay family rows'
    );
}

function testTileRoleKindHintsIncludeOverlays() {
    const schema = loadJson('schemas/tile_roles.schema.json');
    const hints = schema.properties.kindHints.items.enum;
    assert.ok(hints.indexOf('overlays') >= 0);
    assert.ok(hints.indexOf('tiles') >= 0);
    assert.ok(hints.indexOf('objects') >= 0);

    const pathRole = loadJson('presets/standard/tile_roles/path.json');
    assert.ok(pathRole.kindHints.indexOf('overlays') >= 0);
    assert.ok(pathRole.catalogCategories.indexOf('dirt') >= 0);
    assert.ok(pathRole.catalogCategories.indexOf('cobble') >= 0);
    assert.strictEqual(pathRole.vertical, null);

    const waterRole = loadJson('presets/standard/tile_roles/water.json');
    assert.ok(waterRole.kindHints.indexOf('overlays') >= 0);
    assert.ok(waterRole.catalogCategories.indexOf('water') >= 0);

    const wallRole = loadJson('presets/standard/tile_roles/wall.json');
    assert.strictEqual(wallRole.vertical, null);
    assert.ok(wallRole.kindHints.indexOf('objects') >= 0);

    const validate = compileAjv(schema);
    if (!validate) return;
    assertValid(validate, pathRole, 'path role');
    assertValid(validate, waterRole, 'water role');
    assertValid(validate, wallRole, 'wall role');
}

function testDialogsAndWaypointsSchemas() {
    const dialogSchema = loadJson('schemas/dialogs.schema.json');
    requiredProps(dialogSchema, ['id', 'greeting', 'start', 'nodes'], 'dialogs');
    assert.ok(dialogSchema.definitions.reply);
    assert.ok(dialogSchema.definitions.node);
    const town = loadJson('presets/standard/dialogs/town_guide.json');
    assert.strictEqual(town.id, 'town_guide');
    const dialogValidate = compileAjv(dialogSchema);
    if (dialogValidate) {
        assertValid(dialogValidate, town, 'town_guide dialog');
    }

    const creatures = loadJson('schemas/creatures.schema.json');
    assert.ok(
        /kind=dialogs/.test(String(creatures.properties.dialogId.description || '')),
        'dialogId should be a dialogs presets_ids relation'
    );
    assert.ok(
        /Deprecated/.test(String(creatures.properties.dialog.description || '')),
        'inline creature.dialog should be marked deprecated'
    );
    const townCreature = loadJson('presets/standard/creatures/town_guide.json');
    assert.strictEqual(townCreature.dialogId, 'town_guide');
    assert.ok(!townCreature.dialog, 'sample NPC must not duplicate the dialogs file');

    const wpSchema = loadJson('schemas/waypoints.schema.json');
    requiredProps(wpSchema, ['id', 'waypoints', 'floor', 'mapPath'], 'waypoints');
    const wpValidate = compileAjv(wpSchema);
    if (wpValidate) {
        assertValid(
            wpValidate,
            {
                id: 'unit_route',
                label: 'Unit',
                floor: 7,
                waypoints: [
                    { x: 1, y: 2, z: 7 },
                    { x: 3, y: 4 }
                ]
            },
            'waypoint pack'
        );
    }

    const hunts = loadJson('schemas/hunts.schema.json');
    assert.ok(
        /kind=waypoints/.test(String(hunts.properties.waypointPreset.description || '')),
        'waypointPreset should be a waypoints presets_ids relation'
    );

    const wpPack = loadJson('presets/standard/waypoints/wp_test_1.json');
    assert.strictEqual(wpPack.id, 'wp_test_1');
    assert.ok(Array.isArray(wpPack.waypoints) && wpPack.waypoints.length >= 2);
    if (wpValidate) {
        assertValid(wpValidate, wpPack, 'wp_test_1 pack');
    }
    const wpHunt = loadJson('presets/standard/hunts/wp_test_1.json');
    assert.strictEqual(wpHunt.waypointPreset, 'wp_test_1');
    assert.ok(
        !Array.isArray(wpHunt.waypoints) || wpHunt.waypoints.length === 0,
        'sample hunt must not duplicate the waypoints pack'
    );
}

function testHuntEditorWaypointPresetEnum() {
    const { enrichHuntSchema } = require('../kernel/apps/hunt-editor/app.js');
    const hunts = loadJson('schemas/hunts.schema.json');
    const empty = enrichHuntSchema(hunts, { waypoints: [] });
    assert.deepStrictEqual(empty.properties.waypointPreset.enum, ['']);
    assert.deepStrictEqual(empty.properties.waypointsId.enum, ['']);
    const filled = enrichHuntSchema(hunts, { waypoints: ['cave_loop'] });
    assert.deepStrictEqual(filled.properties.waypointPreset.enum, [
        '',
        'cave_loop'
    ]);
    assert.deepStrictEqual(filled.properties.waypointsId.enum, [
        '',
        'cave_loop'
    ]);
}

function testEmptyRelationEnumSurvives() {
    const {
        injectRelationEnums
    } = require('../kernel/apps/designer-ui/app.js');
    const schema = {
        type: 'object',
        properties: {
            vocation: { type: 'string' },
            equipment: {
                type: 'object',
                properties: {
                    amulet: { type: 'string', format: 'equipment_id' }
                }
            }
        }
    };
    const out = injectRelationEnums(
        schema,
        [
            { path: 'vocation', idsKind: 'classes' },
            { path: 'equipment.amulet', idsKind: 'eq_amulet' }
        ],
        {
            classes: ['guardian', 'scout'],
            eq_amulet: ['amethyst_necklace', 'fire_amulet']
        }
    );
    assert.deepStrictEqual(out.properties.vocation.enum, [
        '',
        'guardian',
        'scout'
    ]);
    assert.strictEqual(out.properties.vocation.default, '');
    assert.deepStrictEqual(out.properties.equipment.properties.amulet.enum, [
        '',
        'amethyst_necklace',
        'fire_amulet'
    ]);
    assert.strictEqual(out.properties.equipment.properties.amulet.default, '');

    const defOut = injectRelationEnums(
        {
            type: 'object',
            definitions: {
                weightedTile: {
                    type: 'object',
                    properties: {
                        roleId: { type: 'string' }
                    }
                }
            },
            properties: { roles: { type: 'object' } }
        },
        [{ path: 'roleId', idsKind: 'tile_roles', definition: 'weightedTile' }],
        { tile_roles: ['floor', 'path', 'wall'] }
    );
    assert.deepStrictEqual(
        defOut.definitions.weightedTile.properties.roleId.enum,
        ['', 'floor', 'path', 'wall']
    );

    const dialogOut = injectRelationEnums(
        loadJson('schemas/creatures.schema.json'),
        [{ path: 'dialogId', idsKind: 'dialogs' }],
        { dialogs: ['town_guide'] }
    );
    assert.deepStrictEqual(dialogOut.properties.dialogId.enum, [
        '',
        'town_guide'
    ]);
}

function main() {
    testDuplicateKeysGone();
    testDeclaredKeys();
    testLiveFilesValidate();
    testArtSetAcceptsOverlayAndWallFamily();
    testTileRoleKindHintsIncludeOverlays();
    testDialogsAndWaypointsSchemas();
    testHuntEditorWaypointPresetEnum();
    testEmptyRelationEnumSurvives();
    console.log('designer schema honesty ok');
}

main();
