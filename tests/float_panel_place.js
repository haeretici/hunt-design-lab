#!/usr/bin/env node
/**
 * Float panel placement — right of slot/tile, flip, canvas vs viewport clamp.
 */

'use strict';

const assert = require('assert');
const {
    GAP,
    NUDGE,
    VIEWPORT_PAD,
    viewportBounds,
    tileClientRect,
    computeFloatPosition,
    placeFloatPanel,
    boundsForOrigin
} = require('../kernel/apps/game/float_panel_place.js');

let passed = 0;
let failed = 0;

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

test('tileClientRect is the inverse of a 32px clientToTile mapping', () => {
    const canvas = {
        width: 720,
        height: 480,
        getBoundingClientRect: () => ({
            left: 100,
            top: 50,
            right: 820,
            bottom: 530,
            width: 720,
            height: 480
        })
    };
    const tileMap = { _viewOriginX: 2, _viewOriginY: 1 };
    const r = tileClientRect({ x: 5, y: 4 }, canvas, tileMap, 32, 32);
    assert.ok(r);
    assert.strictEqual(r.left, 100 + (5 - 2) * 32);
    assert.strictEqual(r.top, 50 + (4 - 1) * 32);
    assert.strictEqual(r.right - r.left, 32);
    assert.strictEqual(r.bottom - r.top, 32);
});

test('prefer right of anchor when it fits', () => {
    const pos = computeFloatPosition({
        panelW: 200,
        panelH: 80,
        anchor: { left: 200, top: 120, right: 232, bottom: 152 },
        bounds: { left: 100, top: 50, right: 820, bottom: 530 }
    });
    assert.strictEqual(pos.left, 232 + GAP);
    assert.strictEqual(pos.top, 120);
});

test('quiver at the right edge flips left of the slot (viewport clamp)', () => {
    const bounds = viewportBounds({ innerWidth: 1280, innerHeight: 720 });
    assert.strictEqual(bounds.left, VIEWPORT_PAD);
    assert.strictEqual(bounds.right, 1280 - VIEWPORT_PAD);
    const pos = computeFloatPosition({
        panelW: 200,
        panelH: 80,
        anchor: { left: 1200, top: 80, right: 1232, bottom: 112 },
        bounds
    });
    assert.strictEqual(pos.left, 1200 - 200 - GAP);
    assert.ok(pos.left + 200 <= bounds.right);
    assert.ok(pos.left >= bounds.left);
    assert.strictEqual(pos.top, 80);
});

test('canvas tile near the right edge flips then clamps to the canvas', () => {
    const canvas = { left: 200, top: 80, right: 920, bottom: 560 };
    const pos = computeFloatPosition({
        panelW: 200,
        panelH: 80,
        anchor: { left: 880, top: 200, right: 912, bottom: 232 },
        bounds: canvas
    });
    assert.strictEqual(pos.left, 880 - 200 - GAP);
    assert.ok(pos.left >= canvas.left);
    assert.ok(pos.left + 200 <= canvas.right);
});

test('Y clamps to the origin bounds', () => {
    const pos = computeFloatPosition({
        panelW: 180,
        panelH: 200,
        anchor: { left: 220, top: 500, right: 252, bottom: 532 },
        bounds: { left: 200, top: 80, right: 920, bottom: 560 }
    });
    assert.strictEqual(pos.top, 560 - 200);
});

test('overlap nudges by 16px', () => {
    const pos = computeFloatPosition({
        panelW: 200,
        panelH: 80,
        anchor: { left: 200, top: 120, right: 232, bottom: 152 },
        bounds: { left: 100, top: 50, right: 820, bottom: 530 },
        occupied: [{ left: 240, top: 120, right: 248, bottom: 128 }]
    });
    assert.strictEqual(pos.left, 232 + GAP + NUDGE);
    assert.strictEqual(pos.top, 120 + NUDGE);
});

test('slot origin uses the viewport, not the canvas', () => {
    const canvasEl = {
        getBoundingClientRect: () => ({
            left: 200,
            top: 80,
            right: 920,
            bottom: 560,
            width: 720,
            height: 480
        })
    };
    const canvas = boundsForOrigin('canvas', canvasEl, {
        innerWidth: 1280,
        innerHeight: 720
    });
    const slot = boundsForOrigin('slot', canvasEl, {
        innerWidth: 1280,
        innerHeight: 720
    });
    assert.strictEqual(canvas.left, 200);
    assert.strictEqual(canvas.right, 920);
    assert.strictEqual(slot.left, VIEWPORT_PAD);
    assert.strictEqual(slot.right, 1280 - VIEWPORT_PAD);
});

test('placeFloatPanel writes left/top and uses fallback size', () => {
    const panel = { style: {}, offsetWidth: 0, offsetHeight: 0 };
    const pos = placeFloatPanel(panel, {
        anchor: { left: 40, top: 60, right: 72, bottom: 92 },
        bounds: { left: 8, top: 8, right: 800, bottom: 600 },
        fallbackW: 180,
        fallbackH: 70
    });
    assert.ok(pos);
    assert.strictEqual(panel.style.left, 72 + GAP + 'px');
    assert.strictEqual(panel.style.top, '60px');
});

test('no anchor falls back to the bounds origin', () => {
    const pos = computeFloatPosition({
        panelW: 200,
        panelH: 80,
        bounds: { left: 200, top: 80, right: 920, bottom: 560 }
    });
    assert.strictEqual(pos.left, 200);
    assert.strictEqual(pos.top, 80);
});

if (failed) {
    console.error(failed + ' failed, ' + passed + ' passed');
    process.exit(1);
}
console.log(passed + ' passed');
