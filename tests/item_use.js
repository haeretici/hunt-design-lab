#!/usr/bin/env node
/**
 * Potion / item use effect resolution (catalog is source of truth).
 */

'use strict';

const assert = require('assert');
const {
    resolveItemUseEffect,
    resolveUseForItemId,
    applyItemUseEffect,
    applyManaDelta,
    rollRange
} = require('../kernel/core/lib/character/item_use.js');
const itemUse = require('../kernel/core/lib/character/item_use.js');
const presets = require('../kernel/core/lib/presets.js');

function log(msg, extra) {
    if (process.env.VERBOSE) {
        console.log(msg, extra != null ? extra : '');
    }
}

function loadItems() {
    const eq = presets.loadEquipment();
    return eq.items || eq;
}

function testNoHardcodedTable() {
    assert.strictEqual(itemUse.POTION_EFFECTS, undefined, 'no POTION_EFFECTS');
    assert.strictEqual(itemUse.effectFromNameHint, undefined, 'no name hints');
    const orphan = resolveItemUseEffect(null, 'health_potion');
    assert.strictEqual(orphan.heal, null, 'id-only does not invent heal');
    assert.strictEqual(orphan.mana, null);
    assert.deepStrictEqual(orphan.dispel, []);
    assert.strictEqual(orphan.condition, null);
    assert.strictEqual(orphan.known, false);
    log('no hardcoded table ok');
}

function testCatalogIsSourceOfTruth() {
    const items = loadItems();
    const potions = items.filter((i) => i && i.category === 'potion');
    assert.ok(potions.length >= 4, 'standard potions present');

    const named = {
        mana_potion: { restoreMana: [75, 125] },
        ultimate_dual_potion: { heal: [420, 580], restoreMana: [250, 350] },
        antidote_potion: { dispel: ['poison'] },
        magic_shield_potion: {
            condition: {
                type: 'mana_shield',
                durationSec: 60,
                poolFormula: 'legacy_mana_shield'
            }
        }
    };

    for (const id of Object.keys(named)) {
        const row = items.find((i) => i && i.id === id);
        assert.ok(row, `${id} in equipment.json`);
        const expect = named[id];
        if (expect.heal) assert.deepStrictEqual(row.heal, expect.heal, `${id}.heal`);
        if (expect.restoreMana) {
            assert.deepStrictEqual(row.restoreMana, expect.restoreMana, `${id}.restoreMana`);
        }
        if (expect.dispel) assert.deepStrictEqual(row.dispel, expect.dispel, `${id}.dispel`);
        if (expect.condition) {
            assert.strictEqual(row.condition.type, expect.condition.type);
            assert.strictEqual(row.condition.durationSec, expect.condition.durationSec);
            assert.strictEqual(row.condition.poolFormula, expect.condition.poolFormula);
        }
    }

    for (let i = 0; i < potions.length; i++) {
        const p = potions[i];
        const e = resolveUseForItemId(p.id, items);
        assert.ok(e.item, `${p.id} looked up`);
        if (p.heal) assert.deepStrictEqual(e.heal, p.heal, `${p.id} heal matches catalog`);
        else assert.strictEqual(e.heal, null, `${p.id} no invented heal`);
        if (p.restoreMana) {
            assert.deepStrictEqual(e.mana, p.restoreMana, `${p.id} mana matches catalog`);
        } else {
            assert.strictEqual(e.mana, null, `${p.id} no invented mana`);
        }
        if (Array.isArray(p.dispel)) {
            assert.deepStrictEqual(e.dispel, p.dispel.map((x) => String(x).toLowerCase()));
        } else {
            assert.deepStrictEqual(e.dispel, [], `${p.id} no invented dispel`);
        }
        if (p.condition) {
            assert.ok(e.condition, `${p.id} condition`);
            assert.strictEqual(e.condition.type, p.condition.type);
            if (p.condition.durationSec != null) {
                assert.strictEqual(e.condition.durationSec, p.condition.durationSec);
            }
            if (p.condition.poolFormula) {
                assert.strictEqual(e.condition.poolFormula, p.condition.poolFormula);
            }
            assert.ok(e.known, `${p.id} known via condition`);
        }
    }

    const missing = resolveUseForItemId('great_spirit_potion', items);
    assert.strictEqual(missing.item, null, 'spirit alias not in catalog');
    assert.strictEqual(missing.known, false);
    log('catalog source of truth ok', potions.length);
}

function testTemplateFields() {
    const item = {
        id: 'custom_tonic',
        heal: [10, 10],
        restoreMana: [5, 5],
        dispel: ['poison'],
        condition: { type: 'haste', durationSec: 12 }
    };
    const e = resolveItemUseEffect(item);
    assert.deepStrictEqual(e.heal, [10, 10]);
    assert.deepStrictEqual(e.mana, [5, 5]);
    assert.deepStrictEqual(e.dispel, ['poison']);
    assert.strictEqual(e.condition.type, 'haste');
    assert.strictEqual(e.condition.durationSec, 12);
    assert.ok(e.known);
    log('template fields ok');
}

function testApply() {
    const items = loadItems();
    const target = {
        alive: true,
        hp: { current: 100, max: 1000 },
        mp: { current: 50, max: 500 },
        conditions: [{ kind: 'poison', remainingDamage: 40 }]
    };
    const dual = resolveUseForItemId('great_dual_potion', items);
    const dualFixed = resolveItemUseEffect({
        id: 'great_dual_potion',
        heal: [250, 250],
        restoreMana: [100, 100]
    });
    assert.ok(dual.item);
    assert.deepStrictEqual(dual.heal, [250, 350]);
    assert.deepStrictEqual(dual.mana, [100, 200]);
    const r = applyItemUseEffect(target, dualFixed, { rng: () => 0 });
    assert.strictEqual(r.healRoll, 250);
    assert.strictEqual(r.manaRoll, 100);
    assert.strictEqual(target.hp.current, 350);
    assert.strictEqual(target.mp.current, 150);

    const anti = resolveUseForItemId('antidote_potion', items);
    const r2 = applyItemUseEffect(target, anti, { rng: () => 0 });
    assert.strictEqual(r2.dispelled, 1);
    assert.strictEqual(target.conditions.length, 0);

    assert.strictEqual(applyManaDelta(target, 50), 50);
    assert.strictEqual(target.mp.current, 200);
    log('apply ok');
}

function testMagicShieldPotion() {
    const items = loadItems();
    const effect = resolveUseForItemId('magic_shield_potion', items);
    assert.ok(effect.item);
    assert.ok(effect.condition);
    assert.strictEqual(effect.condition.type, 'mana_shield');
    assert.strictEqual(effect.condition.durationSec, 60);
    assert.strictEqual(effect.condition.poolFormula, 'legacy_mana_shield');
    const target = {
        alive: true,
        level: 14,
        magic: 0,
        hp: { current: 500, max: 500 },
        mp: { current: 425, max: 425 },
        conditions: []
    };
    const r = applyItemUseEffect(target, effect, { rng: () => 0 });
    assert.ok(r.conditionApplied, 'mana_shield applied');
    assert.strictEqual(r.conditionApplied.kind, 'mana_shield');
    assert.strictEqual(r.conditionApplied.durationSec, 60);
    assert.strictEqual(r.conditionApplied.poolRemaining, 406);
    assert.strictEqual(r.conditionApplied.poolMax, 406);
    assert.strictEqual(target.conditions.length, 1);
    log('magic shield potion ok');
}

function testRollRange() {
    assert.strictEqual(rollRange([5, 5], () => 0.9), 5);
    const n = rollRange([10, 20], () => 0);
    assert.strictEqual(n, 10);
    const n2 = rollRange([10, 20], () => 0.999);
    assert.strictEqual(n2, 20);
    log('rollRange ok');
}

function main() {
    testNoHardcodedTable();
    testCatalogIsSourceOfTruth();
    testTemplateFields();
    testApply();
    testMagicShieldPotion();
    testRollRange();
    console.log('item_use: ok');
}

main();
