#!/usr/bin/env node
/**
 * P3a — overlays kind + Wang-16 generate roster.
 * P3b — family-of / mask / 1-ring helpers.
 * Quiet on success; VERBOSE=1 for detail.
 */

'use strict';

const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const {
    ASSET_KINDS,
    getAssetKind,
    genrePaths,
    listKindIds,
    normalizeStampKind,
    subjectLineFor
} = require('../kernel/settings.js');
const {
    generateWangFamilyRoster,
    parseWangId,
    wangCatalogId,
    wangInnerCatalogId,
    wangFamilyOf,
    wangMaskFromCardinals,
    expandWangRing,
    emptyWangInners,
    resolveWangOverlay,
    WANG_MASK_COUNT,
    WANG_BITS,
    WANG_INNERS,
    OVERLAY_WANG_FAMILIES
} = require('../kernel/core/lib/overlay_wang.js');
const { generateAssetNames } = require('../kernel/core/lib/asset_names.js');
const { buildBatch, formatGenerateCommand } = require('../kernel/core/lib/batch_builder.js');
const { resolveOpaqueAlpha, upsertCreature, emptyCatalog, loadCatalog } = require(
    '../kernel/core/lib/creature_manifest.js'
);
const { idToFileStem } = require('../kernel/core/lib/creature_sprites.js');
const { addPaletteEntry, normalizePaletteEntry } = require(
    '../kernel/core/lib/dungeon/tilemap_bake.js'
);
const { resolvePlacementRender } = require('../kernel/core/lib/tile_draw.js');

const ROOT = path.resolve(__dirname, '..');
const VERBOSE = !!process.env.VERBOSE;

function log(...args) {
    if (VERBOSE) console.log(...args);
}

let failed = 0;
let passed = 0;

/**
 * @param {string} name
 * @param {() => void} fn
 */
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

test('rpg_fantasy ships debug dirt + water overlays', () => {
    const catalog = loadCatalog('rpg_fantasy', { kind: 'overlays' });
    const dirt = catalog.creatures.filter((c) => c.wangFamily === 'dirt');
    const water = catalog.creatures.filter((c) => c.wangFamily === 'water');
    assert.strictEqual(dirt.length, WANG_MASK_COUNT + WANG_INNERS.length);
    assert.strictEqual(water.length, WANG_MASK_COUNT + WANG_INNERS.length);
    const inner = catalog.creatures.find((c) => c.id === 'dirt_wang_inner_nw');
    assert.ok(inner && inner.wangInner === 'nw');
    const paths = genrePaths('rpg_fantasy', 'overlays');
    const samples = ['dirt_wang_00', 'dirt_wang_15', 'dirt_wang_inner_nw', 'water_wang_10'];
    for (let i = 0; i < samples.length; i++) {
        const stem = idToFileStem(samples[i]);
        assert.ok(
            fs.existsSync(path.join(paths.icon, stem + '.png')),
            'missing icon ' + stem
        );
        assert.ok(
            fs.existsSync(path.join(paths.small, stem + '.png')),
            'missing small ' + stem
        );
        assert.ok(
            fs.existsSync(path.join(paths.original, stem + '.png')),
            'missing original ' + stem
        );
    }
});

test('overlays is a registered kind', () => {
    assert.ok(listKindIds().includes('overlays'));
    const k = getAssetKind('overlays');
    assert.strictEqual(k.folder, 'overlays');
    assert.strictEqual(k.manifestFileName, 'overlays.json');
    assert.strictEqual(k.compose, 'overlay');
    assert.strictEqual(k.usesGreenKey, false);
    assert.deepStrictEqual(k.categories, ['dirt', 'water', 'cobble']);
    const paths = genrePaths('rpg_fantasy', 'overlays');
    assert.ok(paths.kindRoot.endsWith(path.join('overlays')));
    assert.ok(paths.manifest.endsWith(path.join('rpg_fantasy', 'overlays.json')));
    assert.ok(subjectLineFor('rpg_fantasy', 'overlays').toLowerCase().includes('overlay'));
    assert.strictEqual(ASSET_KINDS.tiles.compose, 'tile');
});

test('normalizeStampKind accepts overlays', () => {
    assert.strictEqual(normalizeStampKind('overlays'), 'overlays');
    assert.strictEqual(normalizeStampKind('objects'), 'objects');
    assert.strictEqual(normalizeStampKind('tiles'), 'tiles');
    assert.strictEqual(normalizeStampKind('nope'), 'tiles');
    assert.strictEqual(normalizeStampKind(null), 'tiles');
});

test('Wang-16 roster is 16 masks for one family', () => {
    const items = generateWangFamilyRoster({ genre: 'rpg_fantasy', category: 'dirt' });
    assert.strictEqual(items.length, WANG_MASK_COUNT);
    assert.strictEqual(items[0].technical, 'Dirt Wang 00');
    assert.strictEqual(items[5].alias, 'Dirt 05');
    assert.strictEqual(items[5].wangFamily, 'dirt');
    assert.strictEqual(items[5].wangMask, 5);
    assert.strictEqual(items[5].opaqueAlpha, false);
    assert.strictEqual(wangCatalogId('dirt', 5), 'dirt_wang_05');
    assert.deepStrictEqual(parseWangId('Dirt_Wang_05'), { family: 'dirt', mask: 5 });
    assert.deepStrictEqual(parseWangId('dirt wang 15'), { family: 'dirt', mask: 15 });
    assert.strictEqual(parseWangId('ancient_ash_floor'), null);
    assert.deepStrictEqual(WANG_INNERS, ['nw', 'ne', 'se', 'sw']);
    assert.strictEqual(wangInnerCatalogId('dirt', 'nw'), 'dirt_wang_inner_nw');
    assert.deepStrictEqual(parseWangId('dirt_wang_inner_se'), {
        family: 'dirt',
        mask: 15,
        inner: 'se'
    });
    assert.deepStrictEqual(parseWangId('Dirt Wang Inner NW'), {
        family: 'dirt',
        mask: 15,
        inner: 'nw'
    });
    assert.strictEqual(wangFamilyOf('cobble_wang_inner_sw'), 'cobble');
});

test('generateAssetNames overlays skips a completed family', () => {
    const dirt = generateAssetNames({
        genre: 'rpg_fantasy',
        kind: 'overlays',
        category: 'dirt',
        count: 16
    });
    assert.strictEqual(dirt.length, 16);
    assert.ok(dirt.every((c) => c.wangFamily === 'dirt'));

    const next = generateAssetNames({
        genre: 'rpg_fantasy',
        kind: 'overlays',
        count: 16,
        exclude: dirt.map((c) => c.technical)
    });
    assert.strictEqual(next[0].wangFamily, 'water');
    assert.strictEqual(next.length, 16);

    assert.throws(
        () =>
            generateAssetNames({
                genre: 'rpg_fantasy',
                kind: 'overlays',
                category: 'dirt',
                count: 16,
                exclude: dirt.map((c) => c.technical)
            }),
        /already on the done list/
    );
    assert.throws(
        () =>
            generateAssetNames({
                genre: 'rpg_fantasy',
                kind: 'overlays',
                count: 4
            }),
        /Wang-16/
    );
    assert.deepStrictEqual(OVERLAY_WANG_FAMILIES, ['dirt', 'water', 'cobble']);
});

test('buildBatch overlays is 16-cell alpha family, never green / opaque', () => {
    const batch = buildBatch({
        genre: 'rpg_fantasy',
        kind: 'overlays',
        category: 'dirt',
        doneFile: path.join(ROOT, 'var', 'does-not-exist-overlays-done.txt')
    });
    assert.strictEqual(batch.kindId, 'overlays');
    assert.strictEqual(batch.count, 16);
    assert.strictEqual(batch.opaqueAlpha, false);
    assert.strictEqual(batch.items[15].wangMask, 15);
    assert.strictEqual(batch.items[15].wangFamily, 'dirt');
    assert.ok(batch.prompt.includes('MUST NOT use pure green #00FF00'));
    assert.ok(!/pure green #00FF00 key/.test(batch.prompt));
    assert.ok(batch.prompt.toLowerCase().includes('wang'));
    assert.ok(batch.prompt.includes('mask 5:'));
    assert.ok(batch.prompt.includes('magenta') || batch.prompt.includes('transparent'));
    assert.ok(!formatGenerateCommand(batch).includes('--opaque-alpha'));
    assert.strictEqual(resolveOpaqueAlpha(undefined, 'overlays'), false);
    assert.strictEqual(resolveOpaqueAlpha(undefined, 'tiles'), true);

    assert.throws(
        () =>
            buildBatch({
                genre: 'rpg_fantasy',
                kind: 'overlays',
                category: 'dirt',
                opaqueAlpha: true,
                doneFile: path.join(ROOT, 'var', 'does-not-exist-overlays-done.txt')
            }),
        /MUST NOT use --opaque-alpha/
    );
});

test('catalog upsert stamps wangFamily / wangMask', () => {
    const catalog = emptyCatalog('rpg_fantasy', 'overlays');
    const rec = upsertCreature(catalog, {
        technical: 'Dirt Wang 05',
        alias: 'Dirt 05',
        genre: 'rpg_fantasy',
        kind: 'overlays',
        category: 'dirt',
        wangFamily: 'dirt',
        wangMask: 5,
        opaqueAlpha: false
    });
    assert.strictEqual(rec.id, 'dirt_wang_05');
    assert.strictEqual(rec.wangFamily, 'dirt');
    assert.strictEqual(rec.wangMask, 5);
    assert.strictEqual(rec.opaqueAlpha, false);

    const inner = upsertCreature(catalog, {
        technical: 'Dirt Wang Inner NW',
        alias: 'Dirt Inner NW',
        genre: 'rpg_fantasy',
        kind: 'overlays',
        category: 'dirt',
        wangFamily: 'dirt',
        wangMask: 15,
        wangInner: 'nw',
        opaqueAlpha: false
    });
    assert.strictEqual(inner.id, 'dirt_wang_inner_nw');
    assert.strictEqual(inner.wangFamily, 'dirt');
    assert.strictEqual(inner.wangMask, 15);
    assert.strictEqual(inner.wangInner, 'nw');
});

test('tile draw keeps overlay kind and tile-like anchor', () => {
    const r = resolvePlacementRender({
        catalogId: 'dirt_wang_05',
        kind: 'overlays',
        roleId: 'path'
    });
    assert.strictEqual(r.kind, 'overlays');
    assert.strictEqual(r.anchor, 'middle_center');
    assert.strictEqual(r.catalogId, 'dirt_wang_05');
});

test('family + mask helpers (P3b resolve)', () => {
    assert.strictEqual(wangFamilyOf('dirt_wang_05'), 'dirt');
    assert.strictEqual(wangFamilyOf({ catalogId: 'water_wang_15', kind: 'overlays' }), 'water');
    assert.strictEqual(wangFamilyOf({ wangFamily: 'cobble', catalogId: 'x' }), 'cobble');
    assert.strictEqual(wangFamilyOf({ wallFamily: 'stone_wall', catalogId: 'x' }), null);
    assert.strictEqual(wangFamilyOf('ancient_ash_floor'), null);
    assert.strictEqual(wangMaskFromCardinals(true, false, true, false), WANG_BITS.N | WANG_BITS.S);
    assert.strictEqual(wangMaskFromCardinals(true, true, true, true), 15);
    assert.strictEqual(wangMaskFromCardinals(false, false, false, false), 0);
    const ring = expandWangRing(8, 8, [3 * 8 + 3]);
    assert.ok(ring.has(3 * 8 + 3));
    assert.ok(ring.has(2 * 8 + 3));
    assert.ok(ring.has(3 * 8 + 4));
    assert.ok(ring.has(4 * 8 + 3));
    assert.ok(ring.has(3 * 8 + 2));
    assert.strictEqual(ring.size, 5);
    assert.strictEqual(expandWangRing(8, 8, [0]).size, 3);
    const ring8 = expandWangRing(8, 8, [3 * 8 + 3], { diagonals: true });
    assert.strictEqual(ring8.size, 9);
    assert.ok(ring8.has(2 * 8 + 2));
    assert.ok(ring8.has(4 * 8 + 4));
    assert.strictEqual(expandWangRing(8, 8, [0], { diagonals: true }).size, 4);
});

test('inner-corner resolve (mask 15 + one empty diagonal)', () => {
    assert.deepStrictEqual(emptyWangInners(true, true, true, true), []);
    assert.deepStrictEqual(emptyWangInners(false, true, true, true), ['nw']);
    assert.deepStrictEqual(emptyWangInners(false, true, false, true), ['nw', 'se']);
    const fill = resolveWangOverlay('dirt', 15, []);
    assert.strictEqual(fill.catalogId, 'dirt_wang_15');
    assert.strictEqual(fill.wangInner, null);
    const inner = resolveWangOverlay('dirt', 15, ['ne']);
    assert.strictEqual(inner.catalogId, 'dirt_wang_inner_ne');
    assert.strictEqual(inner.wangMask, 15);
    assert.strictEqual(inner.wangInner, 'ne');
    const two = resolveWangOverlay('water', 15, ['nw', 'se']);
    assert.strictEqual(two.catalogId, 'water_wang_15');
    assert.strictEqual(two.wangInner, null);
    const edge = resolveWangOverlay('cobble', 6, ['nw']);
    assert.strictEqual(edge.catalogId, 'cobble_wang_06');
    assert.strictEqual(edge.wangInner, null);
});

test('intern keeps kind overlays', () => {
    const pe = normalizePaletteEntry({
        catalogId: 'dirt_wang_05',
        kind: 'overlays',
        roleId: 'path'
    });
    assert.ok(pe);
    assert.strictEqual(pe.kind, 'overlays');
    const floor = { palette: [null] };
    const idx = addPaletteEntry(floor, {
        catalogId: 'dirt_wang_00',
        kind: 'overlays',
        roleId: 'path'
    });
    assert.strictEqual(floor.palette[idx].kind, 'overlays');
    const innerPe = normalizePaletteEntry({
        catalogId: 'dirt_wang_inner_nw',
        kind: 'overlays',
        roleId: 'path',
        wangFamily: 'dirt',
        wangMask: 15,
        wangInner: 'nw'
    });
    assert.strictEqual(innerPe.wangInner, 'nw');
    assert.strictEqual(innerPe.wangMask, 15);
});

test('process_sprites treats overlays/original as non-opaque', () => {
    const py = `
import sys
sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'bin'))})
from process_sprites import is_overlays_original
print(is_overlays_original('/tmp/assets/sprites/rpg_fantasy/overlays/original'))
print(is_overlays_original('/tmp/assets/sprites/rpg_fantasy/tiles/original'))
`;
    const out = execFileSync('python3', ['-c', py], { encoding: 'utf8' }).trim().split('\n');
    assert.strictEqual(out[0], 'True');
    assert.strictEqual(out[1], 'False');
});

if (failed) {
    console.error(`overlay_kind: ${failed} failed, ${passed} passed`);
    process.exit(1);
}
console.log(`overlay_kind: ${passed} passed`);
