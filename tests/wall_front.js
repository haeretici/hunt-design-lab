#!/usr/bin/env node
/**
 * Phase D — ¾ wallFront strip resolve helpers.
 * Quiet on success; VERBOSE=1 for detail.
 */

'use strict';

const assert = require('assert');

const {
    WALL_FRONT_SLOTS,
    WALL_FRONT_RESOLVE_SLOTS,
    wallFrontCatalogId,
    parseWallFrontId,
    resolveWallFrontSlot,
    isWallFrontFamilySlot,
    isWallFrontResolveSlot
} = require('../kernel/core/lib/wall_front.js');

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

test('wallFrontCatalogId / parseWallFrontId round-trip slots', () => {
    assert.strictEqual(WALL_FRONT_RESOLVE_SLOTS.length, 3);
    assert.strictEqual(WALL_FRONT_SLOTS.length, 6);
    for (let i = 0; i < WALL_FRONT_SLOTS.length; i++) {
        const slot = WALL_FRONT_SLOTS[i];
        const id = wallFrontCatalogId('village_front', slot);
        const parsed = parseWallFrontId(id);
        assert.ok(parsed, id);
        assert.strictEqual(parsed.kind, 'wallFront');
        assert.strictEqual(parsed.family, 'village_front');
        assert.strictEqual(parsed.slot, slot);
    }
});

test('parseWallFrontId prefers longest slot (mid_window vs mid)', () => {
    assert.deepStrictEqual(parseWallFrontId('ref_village_front_mid_window'), {
        kind: 'wallFront',
        family: 'village_front',
        slot: 'mid_window'
    });
    assert.deepStrictEqual(parseWallFrontId('ref_village_front_left_statue'), {
        kind: 'wallFront',
        family: 'village_front',
        slot: 'left_statue'
    });
    assert.strictEqual(parseWallFrontId('ref_beach_n'), null);
    assert.strictEqual(parseWallFrontId('stone_wall_pole'), null);
    assert.strictEqual(parseWallFrontId('ref_grass_fill'), null);
});

test('resolveWallFrontSlot horizontal-run caps + mid', () => {
    assert.strictEqual(resolveWallFrontSlot({}), 'mid');
    assert.strictEqual(resolveWallFrontSlot(null), 'mid');
    assert.strictEqual(resolveWallFrontSlot({ e: true }), 'left');
    assert.strictEqual(resolveWallFrontSlot({ w: true }), 'right');
    assert.strictEqual(resolveWallFrontSlot({ e: true, w: true }), 'mid');
    assert.strictEqual(resolveWallFrontSlot({ e: true, n: true, s: true }), 'left');
});

test('family brush is mid; extras are not resolve slots', () => {
    assert.ok(isWallFrontFamilySlot('mid'));
    assert.ok(!isWallFrontFamilySlot('left'));
    assert.ok(!isWallFrontFamilySlot('left_statue'));
    assert.ok(isWallFrontResolveSlot('left'));
    assert.ok(!isWallFrontResolveSlot('left_statue'));
    assert.ok(!isWallFrontResolveSlot('mid_window'));
});

if (failed) {
    console.error(`wall_front: ${failed} failed, ${passed} passed`);
    process.exit(1);
}
log(`wall_front: ${passed} passed`);
