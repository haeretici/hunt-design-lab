#!/usr/bin/env node
/**
 * P4 — wall Wang-16 on vertical: 4-face roster, remapped tables, hop skip.
 * Quiet on success; VERBOSE=1 for detail.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
    generateWallFamilyRoster,
    parseWallId,
    wallCatalogId,
    wallFamilyOf,
    wallAlignOf,
    isWallWang,
    isHopStamp,
    resolveWallAlign,
    WALL_ALIGN_COUNT,
    WALL_ALIGN_SHIPPED,
    WALL_ALIGN_ALL,
    WALL_ALIGN_FULL,
    WALL_ALIGN_HALF,
    maskForWallAlign,
    buildWallFamilyFullRoster
} = require('../kernel/core/lib/wall_wang.js');
const { generateAssetNames } = require('../kernel/core/lib/asset_names.js');
const { buildBatch } = require('../kernel/core/lib/batch_builder.js');
const { upsertCreature, emptyCatalog, loadCatalog } = require('../kernel/core/lib/creature_manifest.js');
const { genrePaths } = require('../kernel/settings.js');
const { idToFileStem } = require('../kernel/core/lib/creature_sprites.js');
const { PNG } = require('pngjs');
const { addPaletteEntry, normalizePaletteEntry } = require(
    '../kernel/core/lib/dungeon/tilemap_bake.js'
);
const { preferredSubLayer } = require('../kernel/core/lib/dungeon/tilemap_editor.js');

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

test('4-face roster for one family', () => {
    const items = generateWallFamilyRoster({ genre: 'rpg_fantasy', wallFamily: 'stone_wall' });
    assert.strictEqual(items.length, WALL_ALIGN_COUNT);
    assert.deepStrictEqual(
        items.map((it) => it.wallAlign),
        WALL_ALIGN_SHIPPED.slice()
    );
    assert.strictEqual(items[0].kind, 'objects');
    assert.strictEqual(items[0].category, 'wall');
    assert.strictEqual(items[0].opaqueAlpha, false);
    assert.strictEqual(items[0].wallFamily, 'stone_wall');
    assert.strictEqual(items[0].wangFamily, undefined);
    assert.strictEqual(wallCatalogId('stone_wall', 'pole'), 'stone_wall_pole');
    assert.deepStrictEqual(parseWallId('Stone_Wall_Horizontal'), {
        family: 'stone_wall',
        align: 'horizontal'
    });
    assert.deepStrictEqual(parseWallId('stone_wall_northwest_diagonal'), {
        family: 'stone_wall',
        align: 'corner'
    });
    assert.strictEqual(parseWallId('damp_cave_wall'), null);
    assert.strictEqual(parseWallId('dirt_wang_05'), null);
});

test('generateAssetNames wall family is 4 faces', () => {
    const faces = generateAssetNames({
        genre: 'rpg_fantasy',
        kind: 'objects',
        category: 'wall',
        wallFamily: 'brick_wall',
        count: 4
    });
    assert.strictEqual(faces.length, 4);
    assert.ok(faces.every((c) => c.wallFamily === 'brick_wall'));
    assert.ok(faces.every((c) => c.category === 'wall'));
    assert.throws(
        () =>
            generateAssetNames({
                genre: 'rpg_fantasy',
                kind: 'objects',
                wallFamily: 'brick_wall',
                count: 16
            }),
        /4 faces/
    );
    assert.throws(
        () =>
            generateWallFamilyRoster({
                genre: 'rpg_fantasy',
                wallFamily: 'stone_wall',
                exclude: ['Stone Wall Pole']
            }),
        /already on the done list/
    );
});

test('buildBatch wall family is 4-cell alpha, never opaque', () => {
    const batch = buildBatch({
        genre: 'rpg_fantasy',
        kind: 'objects',
        category: 'wall',
        wallFamily: 'stone_wall',
        rows: 2,
        cols: 2,
        doneFile: path.join(ROOT, 'var', 'does-not-exist-wall-done.txt')
    });
    assert.strictEqual(batch.kindId, 'objects');
    assert.strictEqual(batch.count, 4);
    assert.strictEqual(batch.opaqueAlpha, false);
    assert.strictEqual(batch.wallFamily, 'stone_wall');
    assert.strictEqual(batch.wangFamily, undefined);
    assert.strictEqual(batch.items[0].wallAlign, 'pole');
    assert.strictEqual(batch.items[1].wallAlign, 'horizontal');
    assert.strictEqual(batch.items[2].wallAlign, 'vertical');
    assert.strictEqual(batch.items[3].wallAlign, 'corner');
    assert.throws(
        () =>
            buildBatch({
                genre: 'rpg_fantasy',
                kind: 'objects',
                wallFamily: 'stone_wall',
                rows: 2,
                cols: 2,
                opaqueAlpha: true,
                doneFile: path.join(ROOT, 'var', 'does-not-exist-wall-done.txt')
            }),
        /MUST NOT use --opaque-alpha/
    );
    assert.throws(
        () =>
            buildBatch({
                genre: 'rpg_fantasy',
                kind: 'objects',
                wallFamily: 'stone_wall',
                rows: 4,
                cols: 4,
                doneFile: path.join(ROOT, 'var', 'does-not-exist-wall-done.txt')
            }),
        /4 faces/
    );
});

test('full roster is 16 faces; mask 9 is corner', () => {
    const items = buildWallFamilyFullRoster('stone_wall', 'rpg_fantasy');
    assert.strictEqual(items.length, WALL_ALIGN_ALL.length);
    assert.strictEqual(maskForWallAlign('pole'), 0);
    assert.strictEqual(maskForWallAlign('corner'), 9);
    assert.strictEqual(maskForWallAlign('intersection'), 15);
    assert.strictEqual(maskForWallAlign('east_end'), 8);
    assert.strictEqual(WALL_ALIGN_FULL[6], 'southeast_diagonal');
});

test('rpg_fantasy ships playable stone_wall faces', () => {
    const catalog = loadCatalog('rpg_fantasy', { kind: 'objects' });
    const faces = catalog.creatures.filter((c) => c.wallFamily === 'stone_wall');
    assert.strictEqual(faces.length, WALL_ALIGN_ALL.length);
    assert.ok(
        faces.every((c) => c.scaleFilter === 'nearest'),
        'playable stone_wall stamps scaleFilter=nearest'
    );
    assert.deepStrictEqual(
        faces.map((c) => c.wallAlign).sort(),
        WALL_ALIGN_ALL.slice().sort()
    );
    const paths = genrePaths('rpg_fantasy', 'objects');
    for (let i = 0; i < WALL_ALIGN_ALL.length; i++) {
        const id = wallCatalogId('stone_wall', WALL_ALIGN_ALL[i]);
        const stem = idToFileStem(id);
        assert.ok(fs.existsSync(path.join(paths.icon, stem + '.png')), 'missing icon ' + stem);
        assert.ok(fs.existsSync(path.join(paths.small, stem + '.png')), 'missing small ' + stem);
        assert.ok(
            fs.existsSync(path.join(paths.original, stem + '.png')),
            'missing original ' + stem
        );
        const icon = PNG.sync.read(fs.readFileSync(path.join(paths.icon, stem + '.png')));
        const original = PNG.sync.read(
            fs.readFileSync(path.join(paths.original, stem + '.png'))
        );
        assert.strictEqual(icon.width, 32, stem + ' icon size');
        assert.strictEqual(original.width, 256, stem + ' original size');
        const scale = original.width / icon.width;
        for (let y = 0; y < icon.height; y++) {
            for (let x = 0; x < icon.width; x++) {
                const si = (y * icon.width + x) * 4;
                const oi =
                    (Math.floor(y * scale) * original.width + Math.floor(x * scale)) * 4;
                if (
                    icon.data[si] !== original.data[oi] ||
                    icon.data[si + 1] !== original.data[oi + 1] ||
                    icon.data[si + 2] !== original.data[oi + 2] ||
                    icon.data[si + 3] !== original.data[oi + 3]
                ) {
                    assert.fail(stem + ' icon is not nearest of original at ' + x + ',' + y);
                }
            }
        }
    }
});

test('catalog upsert stamps wallFamily / wallAlign', () => {
    const catalog = emptyCatalog('rpg_fantasy', 'objects');
    const rec = upsertCreature(catalog, {
        technical: 'Stone Wall Pole',
        alias: 'Stone Wall Pole',
        genre: 'rpg_fantasy',
        kind: 'objects',
        category: 'wall',
        wallFamily: 'stone_wall',
        wallAlign: 'pole',
        opaqueAlpha: false
    });
    assert.strictEqual(rec.id, 'stone_wall_pole');
    assert.strictEqual(rec.wallFamily, 'stone_wall');
    assert.strictEqual(rec.wallAlign, 'pole');
    assert.strictEqual(rec.opaqueAlpha, false);
    assert.strictEqual(rec.wangFamily, undefined);
    assert.strictEqual(rec.scaleFilter, undefined);
    const nearest = upsertCreature(catalog, {
        technical: 'Stone Wall Pole',
        kind: 'objects',
        category: 'wall',
        wallFamily: 'stone_wall',
        wallAlign: 'pole',
        scaleFilter: 'nearest'
    });
    assert.strictEqual(nearest.scaleFilter, 'nearest');
});

test('family / align / hop helpers', () => {
    assert.strictEqual(wallFamilyOf('stone_wall_pole'), 'stone_wall');
    assert.strictEqual(wallFamilyOf({ catalogId: 'brick_wall_corner', kind: 'objects' }), 'brick_wall');
    assert.strictEqual(wallFamilyOf({ wallFamily: 'stone_wall', catalogId: 'x' }), 'stone_wall');
    assert.strictEqual(wallFamilyOf({ wangFamily: 'dirt', kind: 'overlays' }), null);
    assert.strictEqual(wallFamilyOf('ancient_ash_floor'), null);
    assert.strictEqual(wallAlignOf('stone_wall_horizontal'), 'horizontal');
    assert.ok(isWallWang({ wallFamily: 'stone_wall', kind: 'objects' }));
    assert.ok(!isWallWang({ wangFamily: 'stone_wall', kind: 'objects' }));
    assert.ok(!isWallWang({ catalogId: 'damp_cave_wall', kind: 'tiles' }));

    const roles = {
        wall: { id: 'wall', vertical: null },
        stairs_up: {
            id: 'stairs_up',
            vertical: { type: 'stairs', deltaZ: -1, registerStairLink: true }
        }
    };
    assert.ok(!isHopStamp({ catalogId: 'stone_wall_pole', roleId: 'wall' }, roles));
    assert.ok(isHopStamp({ catalogId: 'stairs', roleId: 'stairs_up' }, roles));
    assert.ok(isHopStamp({ catalogId: 'pad', hop: { dir: 'north', deltaZ: -1 } }, roles));
    assert.ok(!isHopStamp({ catalogId: 'stone_wall_pole', wallFamily: 'stone_wall' }, roles));
});

test('full[] then half[] fallback (P3 bits)', () => {
    const four = (a) => WALL_ALIGN_SHIPPED.includes(a);
    assert.strictEqual(resolveWallAlign(0, four), 'pole');
    assert.strictEqual(resolveWallAlign(5, four), 'vertical');
    assert.strictEqual(resolveWallAlign(10, four), 'horizontal');
    assert.strictEqual(resolveWallAlign(9, four), 'corner');
    assert.strictEqual(resolveWallAlign(15, four), 'corner', 'intersection → half corner');
    assert.strictEqual(resolveWallAlign(1, four), 'vertical', 'N-only → half vertical');
    assert.strictEqual(resolveWallAlign(8, four), 'horizontal', 'W-only → half horizontal');
    assert.strictEqual(resolveWallAlign(2, four), 'pole', 'E-only → half pole');
    assert.strictEqual(WALL_ALIGN_FULL[15], 'intersection');
    assert.strictEqual(WALL_ALIGN_HALF[15], 'corner');
    assert.strictEqual(resolveWallAlign(15, (a) => a === 'intersection' || four(a)), 'intersection');
});

test('intern keeps wallAlign; objects wall lands on vertical', () => {
    const pe = normalizePaletteEntry({
        catalogId: 'stone_wall_pole',
        kind: 'objects',
        roleId: 'wall',
        wallFamily: 'stone_wall',
        wallAlign: 'pole'
    });
    assert.ok(pe);
    assert.strictEqual(pe.kind, 'objects');
    assert.strictEqual(pe.wallFamily, 'stone_wall');
    assert.strictEqual(pe.wallAlign, 'pole');
    const floor = { palette: [null] };
    const idx = addPaletteEntry(floor, {
        catalogId: 'stone_wall_horizontal',
        kind: 'objects',
        roleId: 'wall',
        wallFamily: 'stone_wall',
        wallAlign: 'horizontal'
    });
    assert.strictEqual(floor.palette[idx].wallFamily, 'stone_wall');
    assert.strictEqual(floor.palette[idx].wallAlign, 'horizontal');
    assert.strictEqual(
        preferredSubLayer('wall', 'wall', 'objects', { wallFamily: 'stone_wall' }),
        'vertical'
    );
    assert.strictEqual(preferredSubLayer('wall', 'wall', 'tiles'), 'ground');
});

if (failed) {
    console.error(`wall_wang: ${failed} failed, ${passed} passed`);
    process.exit(1);
}
console.log(`wall_wang: ${passed} passed`);
