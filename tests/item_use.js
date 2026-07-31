#!/usr/bin/env node
/**
 * Potion / item use effect resolution (Stage 11).
 */

'use strict';

const assert = require('assert');
const {
    resolveItemUseEffect,
    resolveUseForItemId,
    applyItemUseEffect,
    applyManaDelta,
    rollRange,
    POTION_EFFECTS,
    effectFromNameHint
} = require('../kernel/core/lib/character/item_use.js');

function log(msg, extra) {
    if (process.env.VERBOSE) {
        console.log(msg, extra != null ? extra : '');
    }
}

function testCatalogRanges() {
    const hp = resolveItemUseEffect(null, 'health_potion');
    assert.deepStrictEqual(hp.heal, [125, 175]);
    assert.strictEqual(hp.mana, null);
    assert.ok(hp.known);

    const dual = resolveItemUseEffect(null, 'great_dual_potion');
    assert.deepStrictEqual(dual.heal, [250, 350]);
    assert.deepStrictEqual(dual.mana, [100, 200]);

    const spiritAlias = resolveItemUseEffect(null, 'great_spirit_potion');
    assert.deepStrictEqual(spiritAlias.heal, dual.heal);
    assert.deepStrictEqual(spiritAlias.mana, dual.mana);

    const ult = resolveItemUseEffect(null, 'ultimate_dual_potion');
    assert.deepStrictEqual(ult.heal, [420, 580]);
    assert.deepStrictEqual(ult.mana, [250, 350]);

    const small = resolveItemUseEffect(null, 'small_health_potion');
    assert.deepStrictEqual(small.heal, [60, 90]);

    const supreme = resolveItemUseEffect(null, 'supreme_health_potion');
    assert.deepStrictEqual(supreme.heal, [875, 1125]);

    const mana = resolveItemUseEffect(null, 'ultimate_mana_potion');
    assert.deepStrictEqual(mana.mana, [425, 575]);

    const anti = resolveItemUseEffect(null, 'antidote_potion');
    assert.deepStrictEqual(anti.dispel, ['poison']);

    log('catalog ranges ok', Object.keys(POTION_EFFECTS).length);
}

function testTemplateOverrides() {
    const item = {
        id: 'custom_tonic',
        heal: [10, 10],
        restoreMana: [5, 5]
    };
    const e = resolveItemUseEffect(item);
    assert.deepStrictEqual(e.heal, [10, 10]);
    assert.deepStrictEqual(e.mana, [5, 5]);
    log('template overrides ok');
}

function testNameHints() {
    const h = effectFromNameHint('strong_health_potion');
    assert.deepStrictEqual(h.heal, [250, 350]);
    const d = effectFromNameHint('ultimate_spirit_potion');
    assert.deepStrictEqual(d.heal, [420, 580]);
    assert.deepStrictEqual(d.mana, [250, 350]);
    log('name hints ok');
}

function testApply() {
    const target = {
        hp: { current: 100, max: 1000 },
        mp: { current: 50, max: 500 },
        conditions: [{ kind: 'poison', remainingDamage: 40 }]
    };
    const effect = resolveItemUseEffect(
        {
            id: 'great_dual_potion',
            heal: [250, 250],
            restoreMana: [100, 100]
        },
        'great_dual_potion'
    );
    // Force deterministic rolls via fixed rng → always min when rng=0
    const r = applyItemUseEffect(target, effect, { rng: () => 0 });
    assert.strictEqual(r.healRoll, 250);
    assert.strictEqual(r.manaRoll, 100);
    assert.strictEqual(target.hp.current, 350);
    assert.strictEqual(target.mp.current, 150);

    const anti = resolveItemUseEffect(null, 'antidote_potion');
    const r2 = applyItemUseEffect(target, anti, { rng: () => 0 });
    assert.strictEqual(r2.dispelled, 1);
    assert.strictEqual(target.conditions.length, 0);

    assert.strictEqual(applyManaDelta(target, 50), 50);
    assert.strictEqual(target.mp.current, 200);
    log('apply ok');
}

function testRollRange() {
    assert.strictEqual(rollRange([5, 5], () => 0.9), 5);
    const n = rollRange([10, 20], () => 0);
    assert.strictEqual(n, 10);
    const n2 = rollRange([10, 20], () => 0.999);
    assert.strictEqual(n2, 20);
    log('rollRange ok');
}

function testEquipmentDbLookup() {
    try {
        const presets = require('../kernel/core/lib/presets.js');
        const eq = presets.loadEquipment();
        const items = eq.items || eq;
        const r = resolveUseForItemId('health_potion', items);
        assert.ok(r.item, 'health_potion in equipment.json');
        assert.deepStrictEqual(r.heal, [125, 175]);
        const dual = resolveUseForItemId('great_dual_potion', items);
        assert.ok(dual.item, 'great_dual_potion in equipment.json');
        assert.ok(dual.mana, 'dual has mana restore');
        log('equipment db lookup ok');
    } catch (e) {
        log('equipment db skip', e.message);
    }
}

function main() {
    testCatalogRanges();
    testTemplateOverrides();
    testNameHints();
    testApply();
    testRollRange();
    testEquipmentDbLookup();
    console.log('item_use: ok');
}

main();
