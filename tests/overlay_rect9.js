#!/usr/bin/env node
/**
 * Phase E — 9-piece rect9 resolve helpers.
 * Quiet on success; VERBOSE=1 for detail.
 */

'use strict';

const assert = require('assert');

const {
    RECT9_SLOTS,
    RECT9_UNIQUE_ID_SLOTS,
    rect9CatalogId,
    parseRect9Id,
    resolveRect9Slot,
    isRect9FamilySlot
} = require('../kernel/core/lib/overlay_rect9.js');

const VERBOSE = !!process.env.VERBOSE;

function log(...args) {
    if (VERBOSE) console.log(...args);
}

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

test('rect9CatalogId / parseRect9Id round-trip slots', () => {
    assert.strictEqual(RECT9_SLOTS.length, 9);
    for (let i = 0; i < RECT9_SLOTS.length; i++) {
        const slot = RECT9_SLOTS[i];
        const id = rect9CatalogId('square', slot);
        const parsed = parseRect9Id(id);
        assert.ok(parsed, id);
        assert.strictEqual(parsed.kind, 'rect9');
        assert.strictEqual(parsed.family, 'square');
        assert.strictEqual(parsed.slot, slot);
    }
});

test('parseRect9Id prefers longest slot (nw vs n)', () => {
    assert.deepStrictEqual(parseRect9Id('ref_square_nw'), {
        kind: 'rect9',
        family: 'square',
        slot: 'nw'
    });
    assert.deepStrictEqual(parseRect9Id('ref_square_c'), {
        kind: 'rect9',
        family: 'square',
        slot: 'c'
    });
    assert.strictEqual(parseRect9Id('ref_village_front_mid'), null);
    assert.strictEqual(parseRect9Id('ref_grass_fill'), null);
    assert.ok(RECT9_UNIQUE_ID_SLOTS.c);
    assert.ok(!RECT9_UNIQUE_ID_SLOTS.n);
});

test('resolveRect9Slot isolated / strip / rectangle', () => {
    assert.strictEqual(resolveRect9Slot({}), 'c');
    assert.strictEqual(resolveRect9Slot(null), 'c');
    assert.strictEqual(resolveRect9Slot({ e: true }), 'w');
    assert.strictEqual(resolveRect9Slot({ w: true }), 'e');
    assert.strictEqual(resolveRect9Slot({ e: true, w: true }), 'c');
    assert.strictEqual(resolveRect9Slot({ s: true }), 'n');
    assert.strictEqual(resolveRect9Slot({ n: true }), 's');
    assert.strictEqual(resolveRect9Slot({ n: true, s: true }), 'c');
    assert.strictEqual(resolveRect9Slot({ e: true, s: true }), 'nw');
    assert.strictEqual(resolveRect9Slot({ w: true, s: true }), 'ne');
    assert.strictEqual(resolveRect9Slot({ e: true, n: true }), 'sw');
    assert.strictEqual(resolveRect9Slot({ w: true, n: true }), 'se');
    assert.strictEqual(resolveRect9Slot({ e: true, w: true, s: true }), 'n');
    assert.strictEqual(resolveRect9Slot({ e: true, w: true, n: true }), 's');
    assert.strictEqual(resolveRect9Slot({ n: true, s: true, e: true }), 'w');
    assert.strictEqual(resolveRect9Slot({ n: true, s: true, w: true }), 'e');
    assert.strictEqual(resolveRect9Slot({ n: true, e: true, s: true, w: true }), 'c');
});

test('family brush is center', () => {
    assert.ok(isRect9FamilySlot('c'));
    assert.ok(!isRect9FamilySlot('nw'));
    assert.ok(!isRect9FamilySlot('n'));
});

if (failed) {
    console.error(`overlay_rect9: ${failed} failed, ${passed} passed`);
    process.exit(1);
}
log(`overlay_rect9: ${passed} passed`);
