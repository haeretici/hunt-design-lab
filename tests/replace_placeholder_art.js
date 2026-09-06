#!/usr/bin/env node
/**
 * Phase H — procedural replacement of ref_* placeholder pixels.
 * Quiet on success; VERBOSE=1 for detail.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PNG } = require('pngjs');

const { emptyCatalog, findById, upsertCreature, SOURCES } = require('../kernel/core/lib/creature_manifest.js');
const { idToFileStem } = require('../kernel/core/lib/creature_sprites.js');
const {
    ICON,
    ORIGINAL,
    getPx,
    paintGroundFill,
    paintWater,
    paintBeachEdge,
    paintRect9,
    paintWallFront,
    paintFence,
    paintMountain,
    paintLake,
    paintItem,
    inShore,
    isFoam,
    listPlaceholderItems,
    replacePlaceholderTiles
} = require('../kernel/core/lib/replace_placeholder_art.js');

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

function opaqueCount(data) {
    let n = 0;
    for (let i = 3; i < data.length; i += 4) {
        if (data[i] >= 16) n += 1;
    }
    return n;
}

function pngSize(abs) {
    const png = PNG.sync.read(fs.readFileSync(abs));
    return { width: png.width, height: png.height, data: png.data };
}

function differ(a, b) {
    let n = 0;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) n += 1;
    }
    return n;
}

test('grass fill is 32×32 fully opaque', () => {
    const t = paintGroundFill('grass', 0);
    assert.strictEqual(t.length, ICON * ICON * 4);
    assert.strictEqual(opaqueCount(t), ICON * ICON);
    const px = getPx(t, ICON, 4, 4);
    assert.ok(px[1] > px[0], 'grass is green-dominant');
});

test('grass alts differ from fill', () => {
    const fill = paintGroundFill('grass', 0);
    const alt = paintGroundFill('grass', 3);
    assert.ok(differ(fill, alt) > 20);
});

test('water frames differ and stay opaque', () => {
    const a = paintWater(0);
    const b = paintWater(1);
    assert.strictEqual(opaqueCount(a), ICON * ICON);
    assert.ok(differ(a, b) > 20);
    const px = getPx(a, ICON, 8, 8);
    assert.ok(px[2] > px[0], 'water is blue-dominant');
});

test('beach n is opaque on north, transparent on south', () => {
    const t = paintBeachEdge('n', 0);
    let north = 0;
    let south = 0;
    for (let x = 0; x < ICON; x++) {
        if (getPx(t, ICON, x, 1)[3] >= 16) north += 1;
        if (getPx(t, ICON, x, ICON - 2)[3] >= 16) south += 1;
    }
    assert.ok(north > 20, `north opaque ${north}`);
    assert.strictEqual(south, 0);
    assert.ok(inShore('n', 8, 1));
    assert.ok(!inShore('n', 8, 30));
});

test('beach cnw blob sits in the north-west corner', () => {
    const t = paintBeachEdge('cnw', 0);
    assert.ok(getPx(t, ICON, 1, 1)[3] >= 16);
    assert.strictEqual(getPx(t, ICON, 30, 30)[3], 0);
    assert.ok(opaqueCount(t) > 20);
    assert.ok(opaqueCount(t) < ICON * ICON * 0.4);
});

test('beach dnw is an L (north and west strips)', () => {
    const t = paintBeachEdge('dnw', 0);
    assert.ok(getPx(t, ICON, 8, 1)[3] >= 16);
    assert.ok(getPx(t, ICON, 1, 8)[3] >= 16);
    assert.strictEqual(getPx(t, ICON, 30, 30)[3], 0);
});

test('beach outer-corner foam stays a thin ring across frames', () => {
    const corners = ['cnw', 'cne', 'cse', 'csw'];
    for (let c = 0; c < corners.length; c++) {
        const slot = corners[c];
        const counts = [0, 1, 2, 3].map((fi) => {
            let n = 0;
            for (let y = 0; y < ICON; y++) {
                for (let x = 0; x < ICON; x++) {
                    if (isFoam(slot, x, y, fi)) n += 1;
                }
            }
            return n;
        });
        const max = Math.max.apply(null, counts);
        const min = Math.min.apply(null, counts);
        assert.ok(max < 28, `${slot} foam too large ${counts}`);
        assert.ok(max - min <= 6, `${slot} foam blink ${counts}`);
        const a = paintBeachEdge(slot, 0);
        const b = paintBeachEdge(slot, 1);
        let maskFlip = 0;
        let pixelDiff = 0;
        for (let i = 0; i < a.length; i += 4) {
            const aOn = a[i + 3] >= 16;
            const bOn = b[i + 3] >= 16;
            if (aOn !== bOn) maskFlip += 1;
            if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) {
                pixelDiff += 1;
            }
        }
        assert.strictEqual(maskFlip, 0, `${slot} opaque mask must not blink`);
        assert.ok(pixelDiff <= 12, `${slot} frame churn ${pixelDiff}`);
    }
    assert.ok(!isFoam('cnw', 3, 3, 0), 'blob body stays sand');
    assert.ok(!isFoam('cnw', 3, 3, 1));
});

test('beach opaque pixels stay sand-yellow', () => {
    const slots = [
        'n',
        'e',
        's',
        'w',
        'cnw',
        'cne',
        'cse',
        'csw',
        'dnw',
        'dne',
        'dse',
        'dsw'
    ];
    for (let s = 0; s < slots.length; s++) {
        for (let fi = 0; fi < 4; fi++) {
            const t = paintBeachEdge(slots[s], fi);
            for (let y = 0; y < ICON; y++) {
                for (let x = 0; x < ICON; x++) {
                    const p = getPx(t, ICON, x, y);
                    if (p[3] < 16) continue;
                    assert.ok(
                        p[0] - p[2] >= 40,
                        `${slots[s]} f${fi} @${x},${y} not sand ${p}`
                    );
                    assert.ok(
                        p[1] - p[2] >= 20,
                        `${slots[s]} f${fi} @${x},${y} not yellow ${p}`
                    );
                    assert.ok(p[2] <= 170, `${slots[s]} f${fi} @${x},${y} too pale ${p}`);
                }
            }
        }
    }
});

test('rect9 center is opaque; n has north trim', () => {
    const c = paintRect9('c');
    assert.strictEqual(opaqueCount(c), ICON * ICON);
    const n = paintRect9('n');
    const top = getPx(n, ICON, 16, 0);
    const mid = getPx(n, ICON, 16, 16);
    assert.ok(top[0] + top[1] > mid[0] + mid[1], 'north trim is lighter gold');
});

test('wallFront mid has alpha above the cap', () => {
    const t = paintWallFront('mid');
    assert.strictEqual(getPx(t, ICON, 16, 0)[3], 0);
    assert.ok(getPx(t, ICON, 16, 20)[3] >= 16);
    assert.ok(opaqueCount(t) > 400);
});

test('fence and mountain and lake keep real alpha', () => {
    const fence = paintFence('v');
    const mt = paintMountain('01');
    const lake = paintLake();
    assert.ok(opaqueCount(fence) < ICON * ICON);
    assert.ok(opaqueCount(mt) < ICON * ICON);
    assert.ok(opaqueCount(lake) < ICON * ICON);
    assert.ok(opaqueCount(fence) > 40);
    assert.ok(opaqueCount(mt) > 40);
    assert.ok(opaqueCount(lake) > 80);
    assert.strictEqual(getPx(fence, ICON, 0, 0)[3], 0);
});

test('paintItem dispatches variation / border12 fill', () => {
    const grass = paintItem({
        id: 'ref_grass_fill',
        autoTile: { kind: 'variation', family: 'grass', slot: 'fill' }
    });
    const water = paintItem(
        {
            id: 'ref_water_fill',
            autoTile: { kind: 'border12', family: 'beach', slot: 'fill' }
        },
        2
    );
    assert.strictEqual(opaqueCount(grass), ICON * ICON);
    assert.strictEqual(opaqueCount(water), ICON * ICON);
});

test('replace in a temp tree writes 32/256 and flips catalog extras', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdl-ph-'));
    const catalog = emptyCatalog('rpg_fantasy', 'tiles');
    upsertCreature(catalog, {
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
    upsertCreature(catalog, {
        id: 'ref_water_fill',
        technical: 'Ref Water Fill',
        kind: 'tiles',
        category: 'water',
        opaqueAlpha: true,
        scaleFilter: 'nearest',
        source: SOURCES.REFERENCE_PLACEHOLDER,
        replaceable: true,
        sourcePack: 'mobile_ref',
        sourceFolder: 'water_anim_1',
        sourceStem: '5806',
        nativePx: 83,
        autoTile: { kind: 'border12', family: 'beach', slot: 'fill' },
        anim: { frames: 4, fps: 4 }
    });
    const result = replacePlaceholderTiles({
        spriteRoot: tmp,
        catalogByKind: { tiles: catalog },
        force: true,
        save: false
    });
    assert.strictEqual(result.items.length, 2);
    assert.ok(result.wrote > 0);
    const grass = findById(catalog, 'ref_grass_fill');
    assert.strictEqual(grass.source, 'pipeline');
    assert.strictEqual(grass.replaceable, false);
    assert.strictEqual(grass.nativePx, 32);
    assert.deepStrictEqual(grass.autoTile, {
        kind: 'variation',
        family: 'grass',
        slot: 'fill'
    });
    assert.strictEqual(grass.sourcePack, 'mobile_ref');
    assert.strictEqual(grass.sourceStem, '2561');
    const icon = path.join(tmp, 'tiles', 'icon', `${idToFileStem('ref_grass_fill')}.png`);
    const orig = path.join(tmp, 'tiles', 'original', `${idToFileStem('ref_grass_fill')}.png`);
    assert.ok(fs.existsSync(icon), icon);
    assert.ok(fs.existsSync(orig), orig);
    const iconSz = pngSize(icon);
    const origSz = pngSize(orig);
    assert.strictEqual(iconSz.width, ICON);
    assert.strictEqual(origSz.width, ORIGINAL);
    const water1 = path.join(tmp, 'tiles', 'icon', `${idToFileStem('ref_water_fill')}_1.png`);
    assert.ok(fs.existsSync(water1), water1);
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('without --force existing PNGs are left and catalog is not flipped', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdl-ph-'));
    const catalog = emptyCatalog('rpg_fantasy', 'tiles');
    upsertCreature(catalog, {
        id: 'ref_grass_fill',
        kind: 'tiles',
        source: SOURCES.REFERENCE_PLACEHOLDER,
        replaceable: true,
        nativePx: 83,
        autoTile: { kind: 'variation', family: 'grass', slot: 'fill' }
    });
    const iconDir = path.join(tmp, 'tiles', 'icon');
    fs.mkdirSync(iconDir, { recursive: true });
    const origDir = path.join(tmp, 'tiles', 'original');
    fs.mkdirSync(origDir, { recursive: true });
    const stem = `${idToFileStem('ref_grass_fill')}.png`;
    const dummy = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    fs.writeFileSync(path.join(iconDir, stem), dummy);
    fs.writeFileSync(path.join(origDir, stem), dummy);
    const result = replacePlaceholderTiles({
        spriteRoot: tmp,
        catalogByKind: { tiles: catalog },
        force: false,
        save: false
    });
    assert.strictEqual(result.catalogUpserts, 0);
    assert.strictEqual(findById(catalog, 'ref_grass_fill').source, 'reference_placeholder');
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('live rpg_fantasy still has all ref_ autoTile rows', () => {
    const items = listPlaceholderItems();
    assert.ok(items.length >= 70, `expected ~74 ref_ rows, got ${items.length}`);
    const ids = new Set(items.map((it) => it.id));
    assert.ok(ids.has('ref_grass_fill'));
    assert.ok(ids.has('ref_water_fill'));
    assert.ok(ids.has('ref_beach_n'));
    assert.ok(ids.has('ref_village_front_mid'));
    assert.ok(ids.has('ref_square_c'));
    assert.ok(ids.has('ref_fence_v'));
    assert.ok(ids.has('ref_mountain_01'));
    assert.ok(ids.has('ref_lake_single'));
});

if (failed) {
    console.error(`replace_placeholder_art: ${failed} failed, ${passed} passed`);
    process.exit(1);
}
log(`replace_placeholder_art: ${passed} passed`);
