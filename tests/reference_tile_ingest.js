#!/usr/bin/env node
/**
 * Phase B — placeholder tile ingest (nearest scale + catalog extras).
 * Quiet on success; VERBOSE=1 for detail.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PNG } = require('pngjs');

const {
    SOURCES,
    emptyCatalog,
    findById,
    loadCatalog,
    upsertCreature
} = require('../kernel/core/lib/creature_manifest.js');
const { idToFileStem } = require('../kernel/core/lib/creature_sprites.js');
const {
    DEFAULT_NATIVE_PX,
    nearestScaleRgba,
    writePng,
    loadManifest,
    ingestReferenceTiles,
    defaultManifestPath
} = require('../kernel/core/lib/reference_tile_ingest.js');

const ROOT = path.resolve(__dirname, '..');
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

function makeRgba(w, h, rgba) {
    const out = new Uint8Array(w * h * 4);
    for (let i = 0; i < out.length; i += 4) {
        out[i] = rgba[0];
        out[i + 1] = rgba[1];
        out[i + 2] = rgba[2];
        out[i + 3] = rgba[3];
    }
    return out;
}

function pngSize(abs) {
    const png = PNG.sync.read(fs.readFileSync(abs));
    return { width: png.width, height: png.height, data: png.data };
}

test('nearestScaleRgba 83→32 and 83→256 keeps a corner pixel', () => {
    const src = makeRgba(83, 83, [10, 20, 30, 255]);
    src[0] = 200;
    src[1] = 10;
    src[2] = 10;
    src[3] = 255;
    const icon = nearestScaleRgba(src, 83, 83, 32, 32);
    assert.strictEqual(icon.length, 32 * 32 * 4);
    assert.strictEqual(icon[0], 200);
    assert.strictEqual(icon[1], 10);
    const orig = nearestScaleRgba(src, 83, 83, 256, 256);
    assert.strictEqual(orig.length, 256 * 256 * 4);
    assert.strictEqual(orig[0], 200);
    const step = Math.floor(256 / 83);
    assert.ok(step >= 3);
    const di = (step * 256 + step) * 4;
    assert.strictEqual(orig[di], 200);
});

test('upsert keeps placeholder extras on later merge', () => {
    const catalog = emptyCatalog('rpg_fantasy', 'tiles');
    const rec = upsertCreature(catalog, {
        id: 'ref_grass_fill',
        technical: 'Ref Grass Fill',
        kind: 'tiles',
        category: 'floor',
        opaqueAlpha: true,
        scaleFilter: 'nearest',
        source: SOURCES.REFERENCE_PLACEHOLDER,
        replaceable: true,
        sourcePack: 'mobile_ref',
        sourceFolder: 'grass_ground_walkable',
        sourceStem: '2561',
        nativePx: 83,
        autoTile: { kind: 'variation', family: 'grass', slot: 'fill' }
    });
    assert.strictEqual(rec.source, 'reference_placeholder');
    assert.strictEqual(rec.replaceable, true);
    assert.strictEqual(rec.sourcePack, 'mobile_ref');
    assert.strictEqual(rec.nativePx, 83);
    assert.deepStrictEqual(rec.autoTile, {
        kind: 'variation',
        family: 'grass',
        slot: 'fill'
    });
    const kept = upsertCreature(catalog, {
        id: 'ref_grass_fill',
        kind: 'tiles',
        alias: 'Grass Fill'
    });
    assert.strictEqual(kept.source, 'reference_placeholder');
    assert.strictEqual(kept.replaceable, true);
    assert.strictEqual(kept.sourceFolder, 'grass_ground_walkable');
    assert.deepStrictEqual(kept.autoTile.family, 'grass');
});

test('ingest writes original 256 + icon 32 into a temp tree', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdl-tile-ingest-'));
    const dumpDir = path.join(tmp, 'grass_ground_walkable');
    fs.mkdirSync(dumpDir, { recursive: true });
    const src = makeRgba(83, 83, [40, 120, 40, 255]);
    src[0] = 90;
    src[1] = 160;
    src[2] = 50;
    src[3] = 255;
    writePng(path.join(dumpDir, '2561.png'), 83, 83, src);
    const manifest = {
        version: 1,
        genre: 'rpg_fantasy',
        dumpRoot: tmp,
        nativePx: 83,
        originalPx: 256,
        iconPx: 32,
        source: 'reference_placeholder',
        sourcePack: 'mobile_ref',
        items: [
            {
                id: 'ref_grass_fill',
                folder: 'grass_ground_walkable',
                stem: '2561',
                kind: 'tiles',
                category: 'floor',
                autoTile: { kind: 'variation', family: 'grass', slot: 'fill' }
            }
        ]
    };
    const spriteRoot = path.join(tmp, 'sprites');
    const catalog = emptyCatalog('rpg_fantasy', 'tiles');
    const result = ingestReferenceTiles({
        manifest,
        dumpRoot: tmp,
        spriteRoot,
        catalogByKind: { tiles: catalog },
        force: true,
        save: false
    });
    assert.strictEqual(result.catalogUpserts, 1);
    assert.strictEqual(result.wrote, 2);
    const stem = idToFileStem('ref_grass_fill');
    const originalAbs = path.join(spriteRoot, 'tiles', 'original', `${stem}.png`);
    const iconAbs = path.join(spriteRoot, 'tiles', 'icon', `${stem}.png`);
    const original = pngSize(originalAbs);
    const icon = pngSize(iconAbs);
    assert.strictEqual(original.width, 256);
    assert.strictEqual(original.height, 256);
    assert.strictEqual(icon.width, 32);
    assert.strictEqual(icon.height, 32);
    assert.strictEqual(icon.data[0], 90);
    assert.strictEqual(icon.data[1], 160);
    const rec = findById(catalog, 'ref_grass_fill');
    assert.ok(rec);
    assert.strictEqual(rec.source, 'reference_placeholder');
    assert.strictEqual(rec.replaceable, true);
    assert.strictEqual(rec.scaleFilter, 'nearest');
    assert.strictEqual(rec.nativePx, DEFAULT_NATIVE_PX);
    assert.strictEqual(rec.autoTile.kind, 'variation');
    assert.strictEqual(rec.autoTile.slot, 'fill');
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('ingest writes extra anim frames as Stem_N.png', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdl-tile-anim-ingest-'));
    const dumpDir = path.join(tmp, 'water_anim_1');
    fs.mkdirSync(dumpDir, { recursive: true });
    const colors = [
        [10, 20, 200, 255],
        [20, 30, 210, 255],
        [30, 40, 220, 255],
        [40, 50, 230, 255]
    ];
    for (let fi = 0; fi < 4; fi++) {
        const src = makeRgba(83, 83, colors[fi]);
        src[0] = colors[fi][0];
        src[1] = colors[fi][1];
        src[2] = colors[fi][2];
        src[3] = 255;
        const name = fi === 0 ? '5806.png' : `5806_${fi}.png`;
        writePng(path.join(dumpDir, name), 83, 83, src);
    }
    const manifest = {
        version: 1,
        genre: 'rpg_fantasy',
        dumpRoot: tmp,
        nativePx: 83,
        originalPx: 256,
        iconPx: 32,
        source: 'reference_placeholder',
        sourcePack: 'mobile_ref',
        items: [
            {
                id: 'ref_water_fill',
                folder: 'water_anim_1',
                stem: '5806',
                kind: 'tiles',
                category: 'water',
                autoTile: { kind: 'border12', family: 'beach', slot: 'fill' },
                anim: { frames: 4, fps: 4 }
            }
        ]
    };
    const spriteRoot = path.join(tmp, 'sprites');
    const catalog = emptyCatalog('rpg_fantasy', 'tiles');
    const result = ingestReferenceTiles({
        manifest,
        dumpRoot: tmp,
        spriteRoot,
        catalogByKind: { tiles: catalog },
        force: true,
        save: false
    });
    assert.strictEqual(result.wrote, 8, '4 frames × original+icon');
    const stem = idToFileStem('ref_water_fill');
    const f1 = pngSize(path.join(spriteRoot, 'tiles', 'icon', `${stem}_1.png`));
    assert.strictEqual(f1.width, 32);
    assert.strictEqual(f1.data[0], 20);
    assert.strictEqual(f1.data[2], 210);
    const f3 = pngSize(path.join(spriteRoot, 'tiles', 'original', `${stem}_3.png`));
    assert.strictEqual(f3.width, 256);
    assert.strictEqual(f3.data[0], 40);
    const rec = findById(catalog, 'ref_water_fill');
    assert.strictEqual(rec.anim.frames, 4);
    assert.strictEqual(rec.anim.fps, 4);
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('committed manifest lists firstlight fills with ref_ ids', () => {
    const file = defaultManifestPath();
    assert.ok(fs.existsSync(file), 'other/tiles/ingest_manifest.json');
    const manifest = loadManifest(file);
    const ids = manifest.items.map((it) => it.id);
    assert.ok(ids.indexOf('ref_grass_fill') >= 0);
    assert.ok(ids.indexOf('ref_grass_06') >= 0);
    assert.ok(ids.indexOf('ref_sand_fill') >= 0);
    assert.ok(ids.indexOf('ref_dirt_fill') >= 0);
    assert.ok(ids.indexOf('ref_water_fill') >= 0);
    assert.strictEqual(manifest.items.length, 113);
    const water = manifest.items.find((it) => it.id === 'ref_water_fill');
    assert.strictEqual(water.kind, 'tiles');
    assert.strictEqual(water.category, 'water');
    assert.strictEqual(water.autoTile.kind, 'border12');
    assert.strictEqual(water.folder, 'water_anim_1');
    assert.strictEqual(water.stem, '5806');
    const dump = path.join(ROOT, manifest.dumpRootRel, water.folder, `${water.stem}.png`);
    assert.ok(fs.existsSync(dump), dump);
    assert.ok(water.anim && water.anim.frames === 4);
    const dumpF1 = path.join(ROOT, manifest.dumpRootRel, water.folder, `${water.stem}_1.png`);
    assert.ok(fs.existsSync(dumpF1), dumpF1);
    const north = manifest.items.find((it) => it.id === 'ref_beach_n');
    assert.ok(north);
    assert.strictEqual(north.kind, 'overlays');
    assert.strictEqual(north.autoTile.slot, 'n');
    assert.strictEqual(north.stem, '5810');
    const east = manifest.items.find((it) => it.id === 'ref_beach_e');
    assert.strictEqual(east.stem, '5807');
    const south = manifest.items.find((it) => it.id === 'ref_beach_s');
    assert.strictEqual(south.stem, '5809');
    const west = manifest.items.find((it) => it.id === 'ref_beach_w');
    assert.strictEqual(west.stem, '5808');
    const frontMid = manifest.items.find((it) => it.id === 'ref_village_front_mid');
    assert.ok(frontMid);
    assert.strictEqual(frontMid.kind, 'objects');
    assert.strictEqual(frontMid.category, 'wall');
    assert.strictEqual(frontMid.folder, 'walls_front_1');
    assert.strictEqual(frontMid.stem, '2624');
    assert.strictEqual(frontMid.autoTile.kind, 'wallFront');
    assert.strictEqual(frontMid.autoTile.family, 'village_front');
    assert.strictEqual(frontMid.autoTile.slot, 'mid');
    assert.strictEqual(frontMid.opaqueAlpha, false);
    const frontLeft = manifest.items.find((it) => it.id === 'ref_village_front_left');
    assert.strictEqual(frontLeft.stem, '2623');
    const frontRight = manifest.items.find((it) => it.id === 'ref_village_front_right');
    assert.strictEqual(frontRight.stem, '2625');
    const statue = manifest.items.find((it) => it.id === 'ref_village_front_left_statue');
    assert.strictEqual(statue.stem, '2620');
    const squareC = manifest.items.find((it) => it.id === 'ref_square_c');
    assert.ok(squareC);
    assert.strictEqual(squareC.kind, 'overlays');
    assert.strictEqual(squareC.folder, 'square_details_1');
    assert.strictEqual(squareC.stem, '5999');
    assert.strictEqual(squareC.autoTile.kind, 'rect9');
    assert.strictEqual(squareC.autoTile.family, 'square');
    assert.strictEqual(squareC.autoTile.slot, 'c');
    const squareNw = manifest.items.find((it) => it.id === 'ref_square_nw');
    assert.strictEqual(squareNw.stem, '5995');
    const fenceV = manifest.items.find((it) => it.id === 'ref_fence_v');
    assert.ok(fenceV);
    assert.strictEqual(fenceV.kind, 'objects');
    assert.strictEqual(fenceV.category, 'deco');
    assert.strictEqual(fenceV.folder, 'fences_1');
    assert.strictEqual(fenceV.autoTile.kind, 'none');
    assert.strictEqual(fenceV.autoTile.family, 'fence');
    const mountain = manifest.items.find((it) => it.id === 'ref_mountain_01');
    assert.ok(mountain);
    assert.strictEqual(mountain.category, 'rock');
    assert.strictEqual(mountain.folder, 'mountains');
    assert.strictEqual(mountain.stem, '5377');
    const lake = manifest.items.find((it) => it.id === 'ref_lake_single');
    assert.ok(lake);
    assert.strictEqual(lake.folder, '');
    assert.strictEqual(lake.stem, 'lake_single');
    const dumpLake = path.join(ROOT, manifest.dumpRootRel, `${lake.stem}.png`);
    assert.ok(fs.existsSync(dumpLake), dumpLake);
});

test('live rpg_fantasy ref_ rows keep autoTile after pixel replace', () => {
    const catalog = loadCatalog('rpg_fantasy', { kind: 'tiles' });
    const grass = findById(catalog, 'ref_grass_fill');
    const water = findById(catalog, 'ref_water_fill');
    assert.ok(grass, 'ref_grass_fill catalog row');
    assert.ok(water, 'ref_water_fill catalog row');
    assert.strictEqual(grass.source, 'pipeline');
    assert.strictEqual(grass.replaceable, false);
    assert.strictEqual(grass.nativePx, 32);
    assert.strictEqual(grass.scaleFilter, 'nearest');
    assert.strictEqual(grass.autoTile.family, 'grass');
    assert.strictEqual(water.category, 'water');
    assert.strictEqual(water.autoTile.kind, 'border12');
    assert.ok(water.anim && water.anim.frames === 4);
    const waterIcon1 = path.join(
        ROOT,
        'assets/sprites/rpg_fantasy/tiles/icon',
        `${idToFileStem('ref_water_fill')}_1.png`
    );
    assert.ok(fs.existsSync(waterIcon1), waterIcon1);
    const overlays = loadCatalog('rpg_fantasy', { kind: 'overlays' });
    const beachN = findById(overlays, 'ref_beach_n');
    assert.ok(beachN, 'ref_beach_n catalog row');
    assert.strictEqual(beachN.autoTile.kind, 'border12');
    assert.strictEqual(beachN.autoTile.slot, 'n');
    assert.strictEqual(beachN.opaqueAlpha, false);
    assert.strictEqual(beachN.scaleFilter, 'nearest');
    const orig = path.join(ROOT, grass.sprites.original);
    assert.ok(fs.existsSync(orig), grass.sprites.original);
    const size = pngSize(orig);
    assert.strictEqual(size.width, 256);
    assert.strictEqual(size.height, 256);
    const objects = loadCatalog('rpg_fantasy', { kind: 'objects' });
    const front = findById(objects, 'ref_village_front_mid');
    assert.ok(front, 'ref_village_front_mid catalog row');
    assert.strictEqual(front.source, 'pipeline');
    assert.strictEqual(front.replaceable, false);
    assert.strictEqual(front.kind, 'objects');
    assert.strictEqual(front.category, 'wall');
    assert.strictEqual(front.opaqueAlpha, false);
    assert.strictEqual(front.scaleFilter, 'nearest');
    assert.strictEqual(front.autoTile.kind, 'wallFront');
    assert.strictEqual(front.autoTile.slot, 'mid');
    const frontOrig = path.join(ROOT, front.sprites.original);
    assert.ok(fs.existsSync(frontOrig), front.sprites.original);
    const overlaysAfter = overlays;
    const square = findById(overlaysAfter, 'ref_square_c');
    assert.ok(square, 'ref_square_c catalog row');
    assert.strictEqual(square.autoTile.kind, 'rect9');
    assert.strictEqual(square.autoTile.slot, 'c');
    assert.strictEqual(square.opaqueAlpha, false);
    const fence = findById(objects, 'ref_fence_v');
    assert.ok(fence, 'ref_fence_v catalog row');
    assert.strictEqual(fence.autoTile.kind, 'none');
    assert.strictEqual(fence.category, 'deco');
    const mt = findById(objects, 'ref_mountain_01');
    assert.ok(mt, 'ref_mountain_01 catalog row');
    assert.strictEqual(mt.category, 'rock');
    const lakeRow = findById(objects, 'ref_lake_single');
    assert.ok(lakeRow, 'ref_lake_single catalog row');
    assert.strictEqual(lakeRow.autoTile.slot, 'single');
});

if (failed) {
    console.error(`reference_tile_ingest: ${failed} failed, ${passed} passed`);
    process.exit(1);
}
log(`reference_tile_ingest: ${passed} passed`);
