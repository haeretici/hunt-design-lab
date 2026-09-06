#!/usr/bin/env node
/**
 * Phase F — Hunt tile animation helpers (frame index, stems, catalog index).
 * Quiet on success; VERBOSE=1 for detail.
 */

'use strict';

const assert = require('assert');
const {
    DEFAULT_TILE_ANIM_FPS,
    normalizeTileAnim,
    isCyclingTileAnim,
    tileAnimFrameIndex,
    tileAnimDumpStem,
    tileAnimFileStem,
    animOf,
    buildTileAnimIndex,
    enrichPaletteAnim
} = require('../kernel/core/lib/tile_anim.js');

const VERBOSE = !!process.env.VERBOSE;

function log(...args) {
    if (VERBOSE) console.log(...args);
}

function testNormalizeAndIndex() {
    assert.strictEqual(DEFAULT_TILE_ANIM_FPS, 4);
    assert.strictEqual(normalizeTileAnim(null), null);
    assert.strictEqual(normalizeTileAnim({ frames: 0, fps: 4 }), null);
    const a = normalizeTileAnim({ frames: 4 });
    assert.strictEqual(a.frames, 4);
    assert.strictEqual(a.fps, 4, 'missing fps defaults to 4');
    const b = normalizeTileAnim({ frames: 6, fps: 8 });
    assert.strictEqual(b.fps, 8);
    assert.strictEqual(isCyclingTileAnim({ frames: 1, fps: 4 }), false);
    assert.strictEqual(isCyclingTileAnim({ frames: 4, fps: 4 }), true);
    log('normalize ok');
}

function testFrameIndex() {
    const anim = { frames: 4, fps: 4 };
    assert.strictEqual(tileAnimFrameIndex(null, 1), 0);
    assert.strictEqual(tileAnimFrameIndex({ frames: 1, fps: 4 }, 1), 0);
    assert.strictEqual(tileAnimFrameIndex(anim, 0), 0);
    assert.strictEqual(tileAnimFrameIndex(anim, 0.24), 0);
    assert.strictEqual(tileAnimFrameIndex(anim, 0.25), 1);
    assert.strictEqual(tileAnimFrameIndex(anim, 0.5), 2);
    assert.strictEqual(tileAnimFrameIndex(anim, 0.75), 3);
    assert.strictEqual(tileAnimFrameIndex(anim, 1), 0, 'wraps');
    const fast = { frames: 4, fps: 8 };
    assert.strictEqual(tileAnimFrameIndex(fast, 0.125), 1);
    log('frame index ok');
}

function testStems() {
    assert.strictEqual(tileAnimDumpStem('5806', 0), '5806');
    assert.strictEqual(tileAnimDumpStem('5806', 1), '5806_1');
    assert.strictEqual(tileAnimDumpStem('5806.png', 2), '5806_2');
    assert.strictEqual(tileAnimFileStem('ref_water_fill', 0), 'Ref_Water_Fill');
    assert.strictEqual(tileAnimFileStem('ref_water_fill', 1), 'Ref_Water_Fill_1');
    assert.strictEqual(tileAnimFileStem('ref_beach_n', 3), 'Ref_Beach_N_3');
    log('stems ok');
}

function testAnimOfAndIndex() {
    const interned = { catalogId: 'ref_water_fill', anim: { frames: 4, fps: 4 } };
    assert.strictEqual(animOf(interned).frames, 4);
    const index = buildTileAnimIndex({
        creatures: [
            { id: 'ref_water_fill', anim: { frames: 4, fps: 4 } },
            { id: 'ref_grass_fill' },
            { id: 'ref_beach_n', anim: { frames: 4, fps: 4 } }
        ]
    });
    assert.strictEqual(index.ref_water_fill.frames, 4);
    assert.strictEqual(index.ref_beach_n.fps, 4);
    assert.strictEqual(index.ref_grass_fill, undefined);
    assert.strictEqual(animOf({ catalogId: 'ref_beach_n' }, index).frames, 4);
    assert.strictEqual(animOf('ref_water_fill', index).fps, 4);
    const pal = [null, { catalogId: 'ref_water_fill' }, { catalogId: 'ref_grass_fill' }];
    assert.strictEqual(enrichPaletteAnim(pal, index), 1);
    assert.deepStrictEqual(pal[1].anim, { frames: 4, fps: 4 });
    assert.strictEqual(pal[2].anim, undefined);
    assert.strictEqual(enrichPaletteAnim(pal, index), 0, 'does not overwrite');
    log('index / enrich ok');
}

function main() {
    testNormalizeAndIndex();
    testFrameIndex();
    testStems();
    testAnimOfAndIndex();
    console.log('tile_anim: ok');
}

main();
