#!/usr/bin/env node
/**
 * Form getValue() must not change combat when Save drops hidden keys or
 * invents enum / tuple defaults (creatures, equipment, spells).
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
    preserveLiveEntity
} = require('../kernel/apps/designer-ui/live_value_preserve.js');

const ROOT = path.resolve(__dirname, '..');

function test(name, fn) {
    try {
        fn();
        console.log('ok', name);
    } catch (err) {
        console.error('FAIL', name);
        console.error(err && err.stack ? err.stack : err);
        process.exitCode = 1;
    }
}

function clone(v) {
    return JSON.parse(JSON.stringify(v));
}

/** Simulate json-editor getValue() under the old kind-gated widgets. */
function simulateLeakyGetValue(entity) {
    const out = clone(entity);
    if (!Array.isArray(out.attacks)) return out;
    out.attacks = out.attacks.map((atk) => {
        const row = { ...atk };
        const kind = row.kind;
        if (kind !== 'ranged' && kind !== 'area') delete row.range;
        if (kind !== 'area') delete row.radius;
        if (kind !== 'wave') {
            delete row.length;
            delete row.spread;
        }
        if (kind !== 'ranged' && kind !== 'area') delete row.shootEffect;
        if ((kind === 'ranged' || kind === 'area') && row.shootEffect == null) {
            row.shootEffect = '31';
        }
        if (row.effect == null) row.effect = '158';
        if (row.range == null && (kind === 'ranged' || kind === 'area')) {
            row.range = 0;
        }
        return row;
    });
    return out;
}

test('restores melee range / wave range / firefield radius / melee shootEffect', () => {
    const loaded = {
        id: 'demon',
        attacks: [
            { id: 'melee_0', kind: 'melee', range: 1, min: 0, max: 402 },
            { id: 'ranged_1', kind: 'ranged', range: 7, element: 'manadrain' },
            {
                id: 'firefield_3',
                kind: 'ranged',
                range: 7,
                radius: 1,
                statusOnly: true,
                shootEffect: 'ani_fire'
            },
            {
                id: 'wave_4',
                kind: 'wave',
                range: 4,
                length: 8,
                spread: 0,
                element: 'lifedrain'
            },
            {
                id: 'melee_5',
                kind: 'melee',
                range: 1,
                element: 'energy',
                shootEffect: 'ani_energy'
            },
            {
                id: 'slow_6',
                kind: 'status',
                range: 4,
                radius: 1,
                condition: { type: 'slow', durationSec: 30, speedChange: -700 }
            }
        ]
    };
    const form = simulateLeakyGetValue(loaded);
    assert.strictEqual(form.attacks[0].range, undefined);
    assert.strictEqual(form.attacks[1].shootEffect, '31');
    assert.strictEqual(form.attacks[2].radius, undefined);
    assert.strictEqual(form.attacks[3].range, undefined);
    assert.strictEqual(form.attacks[4].shootEffect, undefined);
    const saved = preserveLiveEntity(loaded, form);
    assert.strictEqual(saved.attacks[0].range, 1);
    assert.ok(!Object.prototype.hasOwnProperty.call(saved.attacks[1], 'shootEffect'));
    assert.strictEqual(saved.attacks[2].radius, 1);
    assert.strictEqual(saved.attacks[2].shootEffect, 'ani_fire');
    assert.strictEqual(saved.attacks[3].range, 4);
    assert.strictEqual(saved.attacks[3].spread, 0);
    assert.strictEqual(saved.attacks[4].shootEffect, 'ani_energy');
    assert.strictEqual(saved.attacks[5].range, 4);
    assert.strictEqual(saved.attacks[5].radius, 1);
    assert.strictEqual(saved.attacks[5].condition.speedChange, -700);
});

test('does not resurrect an attack row the author deleted', () => {
    const loaded = {
        attacks: [
            { id: 'melee_0', kind: 'melee', range: 1 },
            { id: 'ranged_1', kind: 'ranged', range: 7 }
        ]
    };
    const form = { attacks: [{ id: 'ranged_1', kind: 'ranged', range: 7 }] };
    const saved = preserveLiveEntity(loaded, form);
    assert.strictEqual(saved.attacks.length, 1);
    assert.strictEqual(saved.attacks[0].id, 'ranged_1');
});

test('matches reordered attacks by id', () => {
    const loaded = {
        attacks: [
            { id: 'melee_0', kind: 'melee', range: 1 },
            { id: 'wave_4', kind: 'wave', range: 4, length: 8 }
        ]
    };
    const form = {
        attacks: [
            { id: 'wave_4', kind: 'wave', length: 8 },
            { id: 'melee_0', kind: 'melee' }
        ]
    };
    const saved = preserveLiveEntity(loaded, form);
    assert.strictEqual(saved.attacks[0].id, 'wave_4');
    assert.strictEqual(saved.attacks[0].range, 4);
    assert.strictEqual(saved.attacks[1].range, 1);
});

test('strips empty effect / 0 range invented on a row that lacked them', () => {
    const loaded = {
        attacks: [{ id: 'melee_0', kind: 'melee', min: 0, max: 10 }]
    };
    const form = {
        attacks: [
            {
                id: 'melee_0',
                kind: 'melee',
                min: 0,
                max: 10,
                range: 0,
                effect: '',
                shootEffect: '',
                target: false
            }
        ]
    };
    const saved = preserveLiveEntity(loaded, form);
    assert.ok(!Object.prototype.hasOwnProperty.call(saved.attacks[0], 'range'));
    assert.ok(!Object.prototype.hasOwnProperty.call(saved.attacks[0], 'effect'));
    assert.ok(!Object.prototype.hasOwnProperty.call(saved.attacks[0], 'shootEffect'));
    assert.ok(!Object.prototype.hasOwnProperty.call(saved.attacks[0], 'target'));
});

test('keeps a user-set range that was not on disk', () => {
    const loaded = {
        attacks: [{ id: 'melee_0', kind: 'melee', min: 0, max: 10 }]
    };
    const form = {
        attacks: [{ id: 'melee_0', kind: 'melee', min: 0, max: 10, range: 7 }]
    };
    const saved = preserveLiveEntity(loaded, form);
    assert.strictEqual(saved.attacks[0].range, 7);
});

test('abyss + demon HEAD survive a leaky getValue()', () => {
    for (const rel of [
        'presets/standard/creatures/abyss_deceiver.json',
        'presets/standard/creatures/demon.json'
    ]) {
        const disk = JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
        const saved = preserveLiveEntity(disk, simulateLeakyGetValue(disk));
        assert.deepStrictEqual(
            saved.attacks,
            disk.attacks,
            `${rel} attacks must round-trip`
        );
    }
});

/** Invent optional enums / tuples / empty arrays the form would add. */
function inventMissingOptionals(entity, inventions) {
    const out = clone(entity);
    for (const [key, invented] of Object.entries(inventions)) {
        if (!Object.prototype.hasOwnProperty.call(out, key)) {
            out[key] = clone(invented);
        }
    }
    return out;
}

test('equipment: no slot / weaponType / heal / ammoType invented on currency', () => {
    const loaded = {
        id: 'gold_coin',
        category: 'currency',
        stackable: true,
        weight: 10,
        type: ['currency', 'stackable'],
        worth: 1
    };
    const form = inventMissingOptionals(loaded, {
        slot: '',
        weaponType: '',
        ammoType: '',
        heal: [0, 0],
        restoreMana: [0, 0],
        vocation: [],
        consumable: false,
        usable: false,
        twoHanded: false,
        level: 0,
        hitChance: 0,
        imbuementSlots: 0,
        condition: { type: '', durationSec: 0, poolFormula: '' }
    });
    const saved = preserveLiveEntity(loaded, form);
    assert.deepStrictEqual(saved, loaded);
});

test('equipment: potion keeps heal and does not gain a slot', () => {
    const loaded = {
        id: 'small_health_potion',
        category: 'potion',
        type: ['potion', 'consumable'],
        stackable: true,
        consumable: true,
        usable: true,
        heal: [60, 90]
    };
    const form = inventMissingOptionals(loaded, {
        slot: '',
        weaponType: '',
        ammoType: '',
        restoreMana: [0, 0]
    });
    const saved = preserveLiveEntity(loaded, form);
    assert.deepStrictEqual(saved.heal, [60, 90]);
    assert.ok(!Object.prototype.hasOwnProperty.call(saved, 'slot'));
    assert.ok(!Object.prototype.hasOwnProperty.call(saved, 'weaponType'));
    assert.ok(!Object.prototype.hasOwnProperty.call(saved, 'ammoType'));
    assert.ok(!Object.prototype.hasOwnProperty.call(saved, 'restoreMana'));
});

test('equipment: restores omitted maxHitChance / condition / leech', () => {
    const loaded = {
        id: 'arrow',
        category: 'ammo',
        slot: 'leftHand',
        ammoType: 'arrow',
        maxHitChance: 91,
        stackable: true
    };
    const form = {
        id: 'arrow',
        category: 'ammo',
        slot: 'leftHand',
        ammoType: 'arrow',
        stackable: true
    };
    const saved = preserveLiveEntity(loaded, form);
    assert.strictEqual(saved.maxHitChance, 91);
    assert.strictEqual(saved.ammoType, 'arrow');

    const potion = {
        id: 'magic_shield_potion',
        category: 'potion',
        condition: {
            type: 'mana_shield',
            durationSec: 60,
            poolFormula: 'legacy_mana_shield'
        }
    };
    const potionForm = { id: 'magic_shield_potion', category: 'potion' };
    const potionSaved = preserveLiveEntity(potion, potionForm);
    assert.deepStrictEqual(potionSaved.condition, potion.condition);
});

test('creature: no race invented; strategiesTarget / dialog restored', () => {
    const loaded = {
        id: 'town_guide',
        isNpc: true,
        flags: { isNpc: true, hostile: false, attackable: false },
        strategiesTarget: { nearest: 70, health: 10 },
        dialog: { start: 'start', nodes: { start: { text: 'Hi' } } }
    };
    const form = {
        id: 'town_guide',
        isNpc: true,
        race: '',
        flags: {
            isNpc: true,
            hostile: false,
            attackable: false,
            targetDistance: 0,
            summonable: false
        }
    };
    const saved = preserveLiveEntity(loaded, form);
    assert.ok(!Object.prototype.hasOwnProperty.call(saved, 'race'));
    assert.deepStrictEqual(saved.strategiesTarget, loaded.strategiesTarget);
    assert.deepStrictEqual(saved.dialog, loaded.dialog);
    assert.ok(!Object.prototype.hasOwnProperty.call(saved.flags, 'targetDistance'));
    assert.ok(!Object.prototype.hasOwnProperty.call(saved.flags, 'summonable'));
});

test('spell: no source=rune / field=fire invented', () => {
    const loaded = {
        id: 'melee_auto',
        kind: 'auto',
        element: 'physical',
        powerCurve: 'melee_auto'
    };
    const form = inventMissingOptionals(loaded, {
        source: '',
        field: '',
        deploysField: '',
        vocations: []
    });
    const saved = preserveLiveEntity(loaded, form);
    assert.ok(!Object.prototype.hasOwnProperty.call(saved, 'source'));
    assert.ok(!Object.prototype.hasOwnProperty.call(saved, 'field'));
    assert.ok(!Object.prototype.hasOwnProperty.call(saved, 'deploysField'));
    assert.ok(!Object.prototype.hasOwnProperty.call(saved, 'vocations'));
    assert.strictEqual(saved.kind, 'auto');
});

function simulateCatalogLeaky(entity) {
    const form = simulateLeakyGetValue(entity);
    const inventions = {
        race: '',
        slot: '',
        weaponType: '',
        ammoType: '',
        source: '',
        field: '',
        deploysField: '',
        heal: [0, 0],
        restoreMana: [0, 0],
        vocation: [],
        vocations: [],
        consumable: false,
        usable: false,
        twoHanded: false,
        stackable: false,
        level: 0,
        worth: 0,
        volume: 0,
        hitChance: 0,
        imbuementSlots: 0,
        maxHitChance: 0,
        critChance: 0,
        critExtraDamage: 0,
        lifeLeechChance: 0,
        lifeLeechAmount: 0,
        manaLeechChance: 0,
        manaLeechAmount: 0,
        aliases: [],
        dispel: [],
        condition: { type: '', durationSec: 0, poolFormula: '' }
    };
    const leaked = inventMissingOptionals(form, inventions);
    if (isPlain(leaked.flags) && leaked.flags.targetDistance == null) {
        leaked.flags = { ...leaked.flags, targetDistance: 0 };
    }
    if (Array.isArray(leaked.attacks)) {
        leaked.attacks = leaked.attacks.map((atk) => {
            const row = { ...atk };
            if (row.condition == null) {
                row.condition = { type: '', totalDamage: 0, intervalMs: 0 };
            }
            return row;
        });
    }
    delete leaked.strategiesTarget;
    delete leaked.dialog;
    delete leaked.maxHitChance;
    delete leaked.critChance;
    delete leaked.critExtraDamage;
    delete leaked.lifeLeechChance;
    delete leaked.lifeLeechAmount;
    delete leaked.manaLeechChance;
    delete leaked.manaLeechAmount;
    delete leaked.aliases;
    delete leaked.dispel;
    if (entity && entity.condition) delete leaked.condition;
    return leaked;
}

function isPlain(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

function assertRoundTrip(label, disk) {
    const saved = preserveLiveEntity(disk, simulateCatalogLeaky(disk));
    assert.deepStrictEqual(saved, disk, label);
}

test('standard creature catalog survives leaky Save', () => {
    const dir = path.join(ROOT, 'presets/standard/creatures');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    assert.ok(files.length > 1000, 'expected full standard creature catalog');
    for (const f of files) {
        const disk = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        assertRoundTrip('creature ' + disk.id, disk);
    }
});

test('standard equipment catalog survives leaky Save', () => {
    const items = JSON.parse(
        fs.readFileSync(path.join(ROOT, 'presets/standard/equipment.json'), 'utf8')
    ).items;
    assert.ok(items.length > 1000, 'expected full standard equipment catalog');
    for (const item of items) {
        assertRoundTrip('equipment ' + item.id, item);
    }
});

test('standard spell catalog survives leaky Save', () => {
    const doc = JSON.parse(
        fs.readFileSync(path.join(ROOT, 'presets/standard/spells.json'), 'utf8')
    );
    const rows = doc.spells || doc.items || [];
    assert.ok(rows.length > 100, 'expected full standard spell catalog');
    for (const row of rows) {
        assertRoundTrip('spell ' + row.id, row);
    }
});
