#!/usr/bin/env node
/**
 * Map editor Phase A: dock stamp filter / RAW Apply / World picker Apply.
 */

'use strict';

const assert = require('assert');
const { createEditorSession } = require('../kernel/core/lib/dungeon/tilemap_editor.js');
const {
    defaultRawKindForSubLayer,
    stampMatchesFilter,
    filterStamps,
    stampDockLabel,
    makeRawCatalogStamp,
    worldPaletteItemFromPick,
    upsertWorldPalette,
    pickStoredArtSetId,
    mergeArtSetByMap,
    collectPaletteCatalogEntries,
    upsertRawRecent,
    collectWorldCatalogItems,
    seedWorldPaletteFromPins
} = require('../kernel/core/lib/dungeon/map_editor_picker.js');

function testFilterAndLabels() {
    const stamps = [
        { catalogId: 'overgrown_grass_floor', label: 'overgrown_grass_floor', kind: 'tiles', roleId: 'floor' },
        { catalogId: 'dirt_wang_15', label: 'dirt', kind: 'overlays', wangFamily: 'dirt', roleId: 'path' },
        { catalogId: 'stone_wall_pole', label: 'stone_wall', kind: 'objects', wallFamily: 'stone_wall', roleId: 'wall' }
    ];
    assert.strictEqual(filterStamps(stamps, '').length, 3);
    assert.strictEqual(filterStamps(stamps, 'grass').length, 1);
    assert.strictEqual(filterStamps(stamps, 'dirt').length, 1);
    assert.strictEqual(filterStamps(stamps, 'stone_wall').length, 1);
    assert.ok(stampMatchesFilter(stamps[1], 'family') === false);
    assert.ok(stampMatchesFilter(stamps[1], 'overlays'));
    assert.strictEqual(stampDockLabel(stamps[0]), 'grass_floor');
    assert.strictEqual(stampDockLabel(stamps[1]), 'dirt');
    assert.strictEqual(stampDockLabel(stamps[2]), 'stone_wall');
}

function testRawKindDefaults() {
    assert.strictEqual(defaultRawKindForSubLayer('path'), 'overlays');
    assert.strictEqual(defaultRawKindForSubLayer('ground'), 'tiles');
    assert.strictEqual(defaultRawKindForSubLayer('vertical'), 'objects');
    assert.strictEqual(defaultRawKindForSubLayer('furniture'), 'objects');
}

function testRawApplySetsSelectedStamp() {
    const colors = { path: '#8b7355', floor: '#5a8f3c', wall: '#555555' };
    const overlay = makeRawCatalogStamp({
        catalogId: 'dirt_wang_05',
        kind: 'overlays',
        subLayer: 'ground',
        previewColors: colors
    });
    assert.ok(overlay);
    assert.strictEqual(overlay.catalogId, 'dirt_wang_05');
    assert.strictEqual(overlay.kind, 'overlays');
    assert.strictEqual(overlay.subLayer, 'path');
    assert.strictEqual(overlay.wangFamily, 'dirt');
    assert.strictEqual(overlay.wangMask, 5);
    assert.strictEqual(overlay.wangLocked, true);
    assert.strictEqual(overlay.wangResolve, false);

    const grass = makeRawCatalogStamp({
        catalogId: 'overgrown_grass_floor',
        kind: 'tiles',
        subLayer: 'ground',
        previewColors: colors
    });
    assert.ok(grass);
    assert.strictEqual(grass.wangLocked, false);
    assert.strictEqual(grass.subLayer, 'ground');
    assert.strictEqual(grass.roleId, 'floor');

    const wall = makeRawCatalogStamp({
        catalogId: 'stone_wall_corner',
        kind: 'objects',
        subLayer: 'furniture',
        previewColors: colors
    });
    assert.ok(wall);
    assert.strictEqual(wall.wangLocked, true);
    assert.strictEqual(wall.subLayer, 'vertical');
    assert.strictEqual(wall.wallFamily, 'stone_wall');

    const session = createEditorSession({ cols: 8, rows: 8, z: 7 });
    session.selectStamp(overlay);
    assert.strictEqual(session.selectedStamp, overlay);
    assert.strictEqual(session.selectedStamp.wangLocked, true);
    session.selectStamp(grass);
    assert.strictEqual(session.selectedStamp.catalogId, 'overgrown_grass_floor');

    const waterFill = makeRawCatalogStamp({
        catalogId: 'ref_water_fill',
        kind: 'tiles',
        subLayer: 'path',
        previewColors: colors
    });
    assert.ok(waterFill);
    assert.strictEqual(waterFill.autoTile.kind, 'border12');
    assert.strictEqual(waterFill.autoTile.family, 'beach');
    assert.strictEqual(waterFill.autoTile.slot, 'fill');
    assert.strictEqual(waterFill.subLayer, 'ground');
    assert.strictEqual(waterFill.roleId, 'water');
    assert.strictEqual(waterFill.wangLocked, false);
    const waterAnim = makeRawCatalogStamp({
        catalogId: 'ref_water_fill',
        kind: 'tiles',
        subLayer: 'ground',
        anim: { frames: 4, fps: 4 },
        previewColors: colors
    });
    assert.strictEqual(waterAnim.anim.frames, 4);
    assert.strictEqual(waterAnim.anim.fps, 4);

    const beachEdge = makeRawCatalogStamp({
        catalogId: 'ref_beach_n',
        kind: 'overlays',
        subLayer: 'ground',
        previewColors: colors
    });
    assert.ok(beachEdge);
    assert.strictEqual(beachEdge.kind, 'overlays');
    assert.strictEqual(beachEdge.subLayer, 'path');
    assert.strictEqual(beachEdge.borderLocked, true);
    assert.strictEqual(beachEdge.wangLocked, true);

    const grassFill = makeRawCatalogStamp({
        catalogId: 'ref_grass_fill',
        kind: 'tiles',
        subLayer: 'ground',
        previewColors: colors
    });
    assert.strictEqual(grassFill.autoTile.kind, 'variation');
    assert.strictEqual(grassFill.wangLocked, false);
    const grassAlt = makeRawCatalogStamp({
        catalogId: 'ref_grass_03',
        kind: 'tiles',
        subLayer: 'ground',
        previewColors: colors
    });
    assert.strictEqual(grassAlt.wangLocked, true);

    const frontMid = makeRawCatalogStamp({
        catalogId: 'ref_village_front_mid',
        kind: 'objects',
        subLayer: 'furniture',
        previewColors: colors
    });
    assert.ok(frontMid);
    assert.strictEqual(frontMid.autoTile.kind, 'wallFront');
    assert.strictEqual(frontMid.autoTile.family, 'village_front');
    assert.strictEqual(frontMid.subLayer, 'vertical');
    assert.strictEqual(frontMid.roleId, 'wall');
    assert.strictEqual(frontMid.kind, 'objects');
    assert.strictEqual(frontMid.wangLocked, false);
    assert.ok(!frontMid.wallFamily);
    const frontStatue = makeRawCatalogStamp({
        catalogId: 'ref_village_front_left_statue',
        kind: 'objects',
        subLayer: 'ground',
        previewColors: colors
    });
    assert.strictEqual(frontStatue.wangLocked, true);
    assert.strictEqual(frontStatue.subLayer, 'vertical');
    assert.strictEqual(frontStatue.autoTile.slot, 'left_statue');

    const squareC = makeRawCatalogStamp({
        catalogId: 'ref_square_c',
        kind: 'overlays',
        subLayer: 'ground',
        previewColors: colors
    });
    assert.ok(squareC);
    assert.strictEqual(squareC.autoTile.kind, 'rect9');
    assert.strictEqual(squareC.autoTile.slot, 'c');
    assert.strictEqual(squareC.subLayer, 'path');
    assert.strictEqual(squareC.kind, 'overlays');
    assert.strictEqual(squareC.wangLocked, false);
    const squareN = makeRawCatalogStamp({
        catalogId: 'ref_square_n',
        kind: 'overlays',
        subLayer: 'ground',
        autoTile: { kind: 'rect9', family: 'square', slot: 'n' },
        previewColors: colors
    });
    assert.strictEqual(squareN.wangLocked, true);
    assert.strictEqual(squareN.subLayer, 'path');
    const fence = makeRawCatalogStamp({
        catalogId: 'ref_fence_v',
        kind: 'objects',
        subLayer: 'ground',
        category: 'deco',
        autoTile: { kind: 'none', family: 'fence', slot: 'v' },
        previewColors: colors
    });
    assert.strictEqual(fence.kind, 'objects');
    assert.strictEqual(fence.subLayer, 'scenery');
    assert.strictEqual(fence.roleId, 'scenery_cover');
    assert.strictEqual(fence.wangLocked, false);
    const mountain = makeRawCatalogStamp({
        catalogId: 'ref_mountain_01',
        kind: 'objects',
        category: 'rock',
        autoTile: { kind: 'none', family: 'mountain', slot: '01' },
        previewColors: colors
    });
    assert.strictEqual(mountain.roleId, 'scenery_blocking');
    assert.strictEqual(mountain.subLayer, 'scenery');
}

function testWorldPickerApply() {
    const crate = worldPaletteItemFromPick(
        { id: 'village_crate', label: 'Village Crate', assetKind: 'objects' },
        'objects'
    );
    assert.ok(crate);
    assert.strictEqual(crate.id, 'village_crate');
    assert.strictEqual(crate.name, 'Village Crate');
    assert.strictEqual(crate.catalogKind, 'objects');

    const eq = worldPaletteItemFromPick({ id: 'rope', label: 'Rope' }, 'equipment');
    assert.strictEqual(eq.catalogKind, 'equipment');

    let palette = [];
    let up = upsertWorldPalette(palette, crate);
    assert.strictEqual(up.added, true);
    assert.strictEqual(up.list.length, 1);
    palette = up.list;
    up = upsertWorldPalette(palette, {
        id: 'village_crate',
        name: 'Village Crate',
        catalogKind: 'objects'
    });
    assert.strictEqual(up.added, false);
    assert.strictEqual(up.list.length, 1);
    assert.strictEqual(up.item.id, 'village_crate');
}

function testArtSetStoragePick() {
    const allowed = [
        'cave_simple',
        'cave',
        'firstlight_isle'
    ];
    assert.strictEqual(
        pickStoredArtSetId({
            mapId: 'firstlight_isle',
            allowed,
            fallback: 'cave_simple'
        }),
        'firstlight_isle',
        'map id matching an art set is the default'
    );
    assert.strictEqual(
        pickStoredArtSetId({
            mapId: 'firstlight_isle',
            byMap: { firstlight_isle: 'cave' },
            lastId: 'cave_simple',
            allowed,
            fallback: 'cave_simple'
        }),
        'cave',
        'per-map store wins'
    );
    assert.strictEqual(
        pickStoredArtSetId({
            mapId: 'v01',
            lastId: 'firstlight_isle',
            allowed,
            fallback: 'cave_simple'
        }),
        'firstlight_isle',
        'reload uses last art set when the map has no stored set'
    );
    assert.strictEqual(
        pickStoredArtSetId({
            mapId: 'v01',
            lastId: 'firstlight_isle',
            keepId: 'cave',
            preferKeep: true,
            allowed,
            fallback: 'cave_simple'
        }),
        'cave',
        'map switch keeps the current set when the dest map has no store'
    );
    const merged = mergeArtSetByMap({ v01: 'cave' }, 'firstlight_isle', 'firstlight_isle');
    assert.strictEqual(merged.v01, 'cave');
    assert.strictEqual(merged.firstlight_isle, 'firstlight_isle');
}

function testHybridCatalogRecents() {
    const palette = [
        null,
        { catalogId: 'ref_grass_fill', kind: 'tiles', roleId: 'floor' },
        { catalogId: 'ref_grass_03', kind: 'tiles', wangLocked: true },
        { catalogId: 'ref_grass_fill', kind: 'tiles' }
    ];
    const entries = collectPaletteCatalogEntries(palette);
    assert.strictEqual(entries.length, 2);
    assert.strictEqual(entries[0].catalogId, 'ref_grass_fill');
    assert.strictEqual(entries[1].catalogId, 'ref_grass_03');
    assert.strictEqual(entries[1].wangLocked, true);

    let recents = [];
    recents = upsertRawRecent(recents, entries[0]).list;
    recents = upsertRawRecent(recents, {
        catalogId: 'ref_grass_fill',
        kind: 'tiles',
        wangLocked: true
    }).list;
    assert.strictEqual(recents.length, 1);
    assert.strictEqual(recents[0].wangLocked, true);

    const pins = [
        { id: 'crate_7_1_1', catalogId: 'village_crate', catalogKind: 'objects' },
        { id: 'chest_7_2_2', catalogId: 'village_crate', catalogKind: 'objects' },
        { id: 'bag_7_3_3', catalogId: 'jubilee_backpack', catalogKind: 'equipment' }
    ];
    const worldItems = collectWorldCatalogItems(pins);
    assert.strictEqual(worldItems.length, 2);
    assert.strictEqual(worldItems[0].id, 'village_crate');
    assert.strictEqual(worldItems[1].catalogKind, 'equipment');
    const seeded = seedWorldPaletteFromPins([{ id: 'rope', name: 'rope', catalogKind: 'equipment' }], pins);
    assert.strictEqual(seeded.length, 3);
    assert.ok(seeded.find((m) => m.id === 'rope'));
    assert.ok(seeded.find((m) => m.id === 'village_crate'));
}

function main() {
    testFilterAndLabels();
    testRawKindDefaults();
    testRawApplySetsSelectedStamp();
    testWorldPickerApply();
    testArtSetStoragePick();
    testHybridCatalogRecents();
    console.log('map editor picker ok');
}

main();
