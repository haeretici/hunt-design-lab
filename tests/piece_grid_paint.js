#!/usr/bin/env node
/**
 * Pure helpers for designer piece friction grid paint (flood / rect).
 */

'use strict';

const assert = require('assert');
const {
    floodFillFriction,
    rectFillFriction,
    normalizeFrictionRows,
    normalizeStairPoints,
    serializeStairPoint,
    clampDim
} = require('../kernel/apps/designer-ui/piece_grid_editor.js');

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

test('clampDim bounds', () => {
    assert.strictEqual(clampDim(0, 5), 1);
    assert.strictEqual(clampDim(99, 5), 32);
    assert.strictEqual(clampDim('7', 5), 7);
});

test('normalizeFrictionRows pads walls', () => {
    const rows = normalizeFrictionRows(['..', 'X'], 3, 3);
    assert.deepStrictEqual(rows, ['..#', '###', '###']);
});

test('floodFillFriction fills connected region only', () => {
    const rows = ['#####', '#...#', '#.#.#', '#...#', '#####'];
    const copy = rows.slice();
    const changed = floodFillFriction(copy, 1, 1, '#', 5, 5);
    assert.ok(changed.length >= 8);
    // Center wall island stays wall; outer walls stay wall; open ring becomes wall.
    assert.strictEqual(copy[2].charAt(2), '#'); // was already wall
    assert.strictEqual(copy[1].charAt(1), '#');
    assert.strictEqual(copy[1].charAt(2), '#');
    assert.strictEqual(copy[1].charAt(3), '#');
    // Diagonal-only cells are not 4-connected through the center wall:
    // the ring is connected around the center, so entire open area fills.
    assert.deepStrictEqual(copy, ['#####', '#####', '#####', '#####', '#####']);
});

test('floodFillFriction no-op when already target char', () => {
    const rows = ['###', '#.#', '###'];
    const changed = floodFillFriction(rows, 0, 0, '#', 3, 3);
    assert.strictEqual(changed.length, 0);
    assert.deepStrictEqual(rows, ['###', '#.#', '###']);
});

test('floodFillFriction opens a solid block from one seed', () => {
    const rows = ['#####', '#####', '#####', '#####', '#####'];
    const changed = floodFillFriction(rows, 2, 2, '.', 5, 5);
    assert.strictEqual(changed.length, 25);
    assert.deepStrictEqual(rows, ['.....', '.....', '.....', '.....', '.....']);
});

test('floodFillFriction does not cross walls', () => {
    const rows = ['.....', '..#..', '.....'];
    floodFillFriction(rows, 0, 0, '#', 5, 3);
    // Right of wall remains floor (connected via top/bottom around the single wall)
    assert.strictEqual(rows[0], '#####');
    assert.strictEqual(rows[1], '#####');
    assert.strictEqual(rows[2], '#####');
});

test('floodFillFriction stops at barrier wall', () => {
    const rows = ['..#..', '..#..', '..#..'];
    floodFillFriction(rows, 0, 0, '#', 5, 3);
    assert.deepStrictEqual(rows, ['###..', '###..', '###..']);
});

test('rectFillFriction inclusive box', () => {
    const rows = ['.....', '.....', '.....', '.....', '.....'];
    const changed = rectFillFriction(rows, 1, 1, 3, 3, '#', 5, 5);
    assert.strictEqual(changed.length, 9);
    assert.deepStrictEqual(rows, ['.....', '.###.', '.###.', '.###.', '.....']);
});

test('rectFillFriction swaps corners', () => {
    const rows = ['####', '####', '####'];
    rectFillFriction(rows, 3, 2, 0, 0, '.', 4, 3);
    assert.deepStrictEqual(rows, ['....', '....', '....']);
});

test('stair dir and link survive normalize + serialize (getValue)', () => {
    const loaded = normalizeStairPoints([
        { x: 2, y: 2, dir: 'down', link: 'main' },
        { x: 1, y: 1, dir: 'UP', id: 's1' },
        { x: 0, y: 0 },
        { x: 3, y: 3, dir: 'sideways', link: '' }
    ]);
    assert.strictEqual(loaded.length, 4);
    assert.deepStrictEqual(loaded[0], { x: 2, y: 2, dir: 'down', link: 'main' });
    assert.deepStrictEqual(loaded[1], { x: 1, y: 1, id: 's1', dir: 'up' });
    assert.deepStrictEqual(loaded[2], { x: 0, y: 0 });
    assert.deepStrictEqual(loaded[3], { x: 3, y: 3 });
    assert.deepStrictEqual(serializeStairPoint(loaded[0]), {
        x: 2,
        y: 2,
        dir: 'down',
        link: 'main'
    });
    assert.deepStrictEqual(serializeStairPoint(loaded[1]), {
        x: 1,
        y: 1,
        id: 's1',
        dir: 'up'
    });
});

if (!process.exitCode) {
    console.log('piece_grid_paint: ok');
}
