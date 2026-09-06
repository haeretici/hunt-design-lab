#!/usr/bin/env node
/**
 * Phase C — 12-piece border12 resolve + variation helpers.
 * Quiet on success; VERBOSE=1 for detail.
 */

'use strict';

const assert = require('assert');

const {
    BORDER12_SLOTS,
    border12CatalogId,
    parseAutoTileId,
    autoTileOf,
    isBorder12Fill,
    isBorder12Edge,
    resolveBorder12Slot,
    pickVariationId,
    variationIds,
    buildAutoTileIndex,
    BORDER12_FILL_ALIASES
} = require('../kernel/core/lib/overlay_border.js');

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

test('border12CatalogId / parseAutoTileId round-trip slots', () => {
    assert.strictEqual(BORDER12_SLOTS.length, 12);
    for (let i = 0; i < BORDER12_SLOTS.length; i++) {
        const slot = BORDER12_SLOTS[i];
        const id = border12CatalogId('beach', slot);
        const parsed = parseAutoTileId(id);
        assert.ok(parsed);
        assert.strictEqual(parsed.kind, 'border12');
        assert.strictEqual(parsed.family, 'beach');
        assert.strictEqual(parsed.slot, slot);
    }
});

test('ref_water_fill aliases border12 beach fill', () => {
    assert.strictEqual(BORDER12_FILL_ALIASES.ref_water_fill, 'beach');
    const parsed = parseAutoTileId('ref_water_fill');
    assert.deepStrictEqual(parsed, { kind: 'border12', family: 'beach', slot: 'fill' });
    assert.ok(isBorder12Fill('ref_water_fill'));
    assert.ok(!isBorder12Edge('ref_water_fill'));
    assert.ok(isBorder12Edge('ref_beach_n'));
});

test('variation ids parse fill and alts', () => {
    assert.deepStrictEqual(parseAutoTileId('ref_grass_fill'), {
        kind: 'variation',
        family: 'grass',
        slot: 'fill'
    });
    assert.deepStrictEqual(parseAutoTileId('ref_grass_03'), {
        kind: 'variation',
        family: 'grass',
        slot: '03'
    });
});

test('resolveBorder12Slot 1×1 island neighbors', () => {
    assert.strictEqual(resolveBorder12Slot({ s: true }), 's');
    assert.strictEqual(resolveBorder12Slot({ w: true }), 'w');
    assert.strictEqual(resolveBorder12Slot({ n: true }), 'n');
    assert.strictEqual(resolveBorder12Slot({ e: true }), 'e');
    assert.strictEqual(resolveBorder12Slot({ se: true }), 'cse');
    assert.strictEqual(resolveBorder12Slot({ sw: true }), 'csw');
    assert.strictEqual(resolveBorder12Slot({ nw: true }), 'cnw');
    assert.strictEqual(resolveBorder12Slot({ ne: true }), 'cne');
});

test('resolveBorder12Slot inner / cardinal / empty', () => {
    assert.strictEqual(resolveBorder12Slot({ n: true, w: true, nw: true }), 'dnw');
    assert.strictEqual(resolveBorder12Slot({ n: true, e: true }), 'dne');
    assert.strictEqual(resolveBorder12Slot({ s: true, e: true }), 'dse');
    assert.strictEqual(resolveBorder12Slot({ s: true, w: true }), 'dsw');
    assert.strictEqual(resolveBorder12Slot({ s: true, se: true, sw: true }), 's');
    assert.strictEqual(resolveBorder12Slot({ w: true, nw: true, sw: true }), 'w');
    assert.strictEqual(resolveBorder12Slot({}), null);
    assert.strictEqual(resolveBorder12Slot(null), null);
});

test('buildAutoTileIndex groups fill / alts / slots', () => {
    const index = buildAutoTileIndex([
        { id: 'ref_grass_fill', autoTile: { kind: 'variation', family: 'grass', slot: 'fill' } },
        { id: 'ref_grass_01', autoTile: { kind: 'variation', family: 'grass', slot: '01' } },
        { id: 'ref_grass_02', autoTile: { kind: 'variation', family: 'grass', slot: '02' } },
        { id: 'ref_water_fill', autoTile: { kind: 'border12', family: 'beach', slot: 'fill' } },
        { id: 'ref_beach_n', autoTile: { kind: 'border12', family: 'beach', slot: 'n' } }
    ]);
    assert.strictEqual(index.byId.ref_grass_fill.kind, 'variation');
    assert.strictEqual(index.families.grass.fillId, 'ref_grass_fill');
    assert.deepStrictEqual(index.families.grass.alts, ['ref_grass_01', 'ref_grass_02']);
    assert.strictEqual(index.families.beach.fillId, 'ref_water_fill');
    assert.strictEqual(index.families.beach.slots.n, 'ref_beach_n');
    assert.deepStrictEqual(variationIds('grass', index), ['ref_grass_01', 'ref_grass_02']);
    const a = pickVariationId(index.families.grass.alts, 1, 1);
    const b = pickVariationId(index.families.grass.alts, 1, 1);
    assert.strictEqual(a, b);
    assert.ok(index.families.grass.alts.indexOf(a) >= 0);
});

test('parseAutoTileId wallFront slots and index grouping', () => {
    const parsed = parseAutoTileId('ref_village_front_left');
    assert.deepStrictEqual(parsed, {
        kind: 'wallFront',
        family: 'village_front',
        slot: 'left'
    });
    const index = buildAutoTileIndex([
        {
            id: 'ref_village_front_mid',
            autoTile: { kind: 'wallFront', family: 'village_front', slot: 'mid' }
        },
        {
            id: 'ref_village_front_left',
            autoTile: { kind: 'wallFront', family: 'village_front', slot: 'left' }
        },
        {
            id: 'ref_village_front_right',
            autoTile: { kind: 'wallFront', family: 'village_front', slot: 'right' }
        }
    ]);
    assert.strictEqual(index.families.village_front.kind, 'wallFront');
    assert.strictEqual(index.families.village_front.fillId, 'ref_village_front_mid');
    assert.strictEqual(index.families.village_front.slots.left, 'ref_village_front_left');
    assert.strictEqual(autoTileOf('ref_village_front_mid_window').slot, 'mid_window');
});

test('parseAutoTileId rect9 unique slots and index grouping', () => {
    assert.deepStrictEqual(parseAutoTileId('ref_square_c'), {
        kind: 'rect9',
        family: 'square',
        slot: 'c'
    });
    assert.deepStrictEqual(parseAutoTileId('ref_square_nw'), {
        kind: 'rect9',
        family: 'square',
        slot: 'nw'
    });
    assert.strictEqual(parseAutoTileId('ref_square_n').kind, 'border12', 'cardinal n stays border12 without catalog');
    const index = buildAutoTileIndex([
        { id: 'ref_square_c', autoTile: { kind: 'rect9', family: 'square', slot: 'c' } },
        { id: 'ref_square_n', autoTile: { kind: 'rect9', family: 'square', slot: 'n' } },
        { id: 'ref_square_nw', autoTile: { kind: 'rect9', family: 'square', slot: 'nw' } },
        {
            id: 'ref_fence_v',
            autoTile: { kind: 'none', family: 'fence', slot: 'v' }
        }
    ]);
    assert.strictEqual(index.families.square.kind, 'rect9');
    assert.strictEqual(index.families.square.fillId, 'ref_square_c');
    assert.strictEqual(index.families.square.slots.n, 'ref_square_n');
    assert.strictEqual(autoTileOf('ref_square_n', index).kind, 'rect9');
    assert.strictEqual(index.byId.ref_fence_v.kind, 'none');
    assert.ok(!index.families.fence);
});

test('autoTileOf prefers stamped autoTile over id parse', () => {
    const stamped = autoTileOf({
        catalogId: 'ref_water_fill',
        autoTile: { kind: 'border12', family: 'beach', slot: 'fill' }
    });
    assert.strictEqual(stamped.family, 'beach');
    assert.strictEqual(autoTileOf('ancient_ash_floor'), null);
});

if (failed) {
    console.error(`overlay_border: ${failed} failed, ${passed} passed`);
    process.exit(1);
}
log(`overlay_border: ${passed} passed`);
