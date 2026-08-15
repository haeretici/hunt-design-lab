/**
 * Phase 6 — tile_draw pure helpers + tall-prop order + authoring cache fingerprint.
 */
'use strict';

const assert = require('assert');
const path = require('path');

const {
    resolveTileDrawBox,
    resolvePlacementRender,
    compareDrawOrder,
    sortDrawables,
    collectTallPropsFromFloor,
    DRAW_SUB_PROP,
    DRAW_SUB_ENTITY,
    normalizeAnchor
} = require('../kernel/core/lib/tile_draw.js');

const { TileMap } = require('../kernel/core/entities/tilemap.js');
const {
    loadHybridOntoTileMap,
    createEmptyTileMapFloor,
    setSubLayerCell,
    normalizePaletteEntry
} = require('../kernel/core/lib/dungeon/tilemap_bake.js');
const { Settings } = require('../kernel/settings.js');

function log(msg) {
    console.log(`  ✓ ${msg}`);
}

function testResolveTileDrawBox() {
    // middle_center scale 1 on 32×32 with 32×32 image → fill tile
    const mid = resolveTileDrawBox(0, 0, 32, 32, 32, 32, 1, 'middle_center');
    assert.ok(Math.abs(mid.dx - 0) < 1e-9, `mid dx ${mid.dx}`);
    assert.ok(Math.abs(mid.dy - 0) < 1e-9, `mid dy ${mid.dy}`);
    assert.ok(Math.abs(mid.dw - 32) < 1e-9);
    assert.ok(Math.abs(mid.dh - 32) < 1e-9);

    // bottom_center scale 1.4: feet on tile bottom, taller than tile
    const tree = resolveTileDrawBox(100, 200, 32, 32, 16, 32, 1.4, 'bottom_center');
    assert.strictEqual(tree.anchor, 'bottom_center');
    assert.ok(Math.abs(tree.dh - 32 * 1.4) < 1e-9, `tree dh ${tree.dh}`);
    // pivot at bottom center of tile → dy = tile bottom - dh
    assert.ok(
        Math.abs(tree.dy - (200 + 32 - tree.dh)) < 1e-6,
        `tree dy ${tree.dy}`
    );
    // horizontal center
    assert.ok(
        Math.abs(tree.dx + tree.dw / 2 - (100 + 16)) < 1e-6,
        `tree center x`
    );

    // top_left scale 2
    const tl = resolveTileDrawBox(10, 20, 32, 32, 32, 32, 2, 'top_left');
    assert.ok(Math.abs(tl.dx - 10) < 1e-9);
    assert.ok(Math.abs(tl.dy - 20) < 1e-9);
    assert.ok(Math.abs(tl.dw - 64) < 1e-9);

    assert.strictEqual(normalizeAnchor('BOTTOM_CENTER'), 'bottom_center');
    assert.strictEqual(normalizeAnchor('nope', 'middle_center'), 'middle_center');
    log('resolveTileDrawBox anchors + scale');
}

function testResolvePlacementRender() {
    const role = { render: { scale: 1.2, anchor: 'bottom_center' } };
    const fromRole = resolvePlacementRender(
        { catalogId: 'oak', kind: 'objects', roleId: 'scenery_blocking' },
        role
    );
    assert.strictEqual(fromRole.catalogId, 'oak');
    assert.strictEqual(fromRole.kind, 'objects');
    assert.ok(Math.abs(fromRole.scale - 1.2) < 1e-9);
    assert.strictEqual(fromRole.anchor, 'bottom_center');

    const override = resolvePlacementRender(
        {
            catalogId: 'oak',
            kind: 'objects',
            scale: 1.4,
            anchor: 'middle_center'
        },
        role
    );
    assert.ok(Math.abs(override.scale - 1.4) < 1e-9);
    assert.strictEqual(override.anchor, 'middle_center');
    log('resolvePlacementRender override beats role');
}

function testDrawOrder() {
    const a = { sortY: 5, subOrder: DRAW_SUB_PROP, stableKey: 'p' };
    const b = { sortY: 5, subOrder: DRAW_SUB_ENTITY, stableKey: 'e' };
    const c = { sortY: 3, subOrder: DRAW_SUB_ENTITY, stableKey: 'n' };
    // north entity before south prop; same Y prop before entity
    assert.ok(compareDrawOrder(c, a) < 0, 'north before south');
    assert.ok(compareDrawOrder(a, b) < 0, 'prop under entity same Y');

    const list = [
        { sortY: 2, subOrder: DRAW_SUB_ENTITY, stableKey: 'e2' },
        { sortY: 1, subOrder: DRAW_SUB_PROP, stableKey: 'p1' },
        { sortY: 1, subOrder: DRAW_SUB_ENTITY, stableKey: 'e1' },
        { sortY: 2, subOrder: DRAW_SUB_PROP, stableKey: 'p2' }
    ];
    sortDrawables(list);
    assert.deepStrictEqual(
        list.map((d) => d.stableKey),
        ['p1', 'e1', 'p2', 'e2'],
        'y-sort order'
    );
    log('compareDrawOrder / sortDrawables');
}

function testCollectTallProps() {
    const floor = createEmptyTileMapFloor(4, 4, { z: 0 });
    floor.palette = [
        null,
        normalizePaletteEntry({
            catalogId: 'damp_moss_floor',
            kind: 'tiles',
            roleId: 'floor'
        }),
        normalizePaletteEntry({
            catalogId: 'simple_dead_tree',
            kind: 'objects',
            roleId: 'scenery_blocking',
            scale: 1.4,
            anchor: 'bottom_center'
        }),
        normalizePaletteEntry({
            catalogId: 'broken_cave_stairs',
            kind: 'tiles',
            roleId: 'stairs_up'
        })
    ];
    setSubLayerCell(floor, 'ground', 1, 1, 1);
    setSubLayerCell(floor, 'scenery', 2, 2, 2);
    setSubLayerCell(floor, 'vertical', 0, 3, 3);

    const props = collectTallPropsFromFloor(floor, { z: 0 });
    assert.strictEqual(props.length, 2, 'ground excluded; scenery+vertical');
    const tree = props.find((p) => p.catalogId === 'simple_dead_tree');
    const stair = props.find((p) => p.catalogId === 'broken_cave_stairs');
    assert.ok(tree, 'tree prop');
    assert.ok(stair, 'stair prop');
    assert.strictEqual(tree.tileX, 2);
    assert.strictEqual(tree.tileY, 2);
    assert.ok(Math.abs(tree.scale - 1.4) < 1e-9);
    assert.strictEqual(tree.anchor, 'bottom_center');
    assert.strictEqual(tree.subOrder, DRAW_SUB_PROP);

    // Region filter
    const region = collectTallPropsFromFloor(floor, {
        x0: 2,
        y0: 2,
        x1: 2,
        y1: 2
    });
    assert.strictEqual(region.length, 1);
    assert.strictEqual(region[0].catalogId, 'simple_dead_tree');
    log('collectTallPropsFromFloor excludes terrain');
}

function testAuthoringCacheFingerprint() {
    const prevHeadless = Settings.HEADLESS;
    Settings.HEADLESS = false;
    try {
        const map = new TileMap();
        map.loadFloorFromFriction(0, 8, 8, new Uint8Array(64).fill(100));

        // Fake canvas path: no offscreen → direct paint, but setAuthoringFloor
        // still dirties cache fingerprint fields we can observe.
        assert.strictEqual(map._renderCacheDirty, true);
        map._renderCacheDirty = false;
        map._renderCache = {
            mode: 'full',
            zKey: '0',
            hasArt: false,
            hasAuthoring: false,
            pendingSprites: false
        };

        const floor = createEmptyTileMapFloor(8, 8, { z: 0 });
        floor.palette = [
            null,
            normalizePaletteEntry({
                catalogId: 'damp_moss_floor',
                kind: 'tiles',
                roleId: 'floor'
            })
        ];
        setSubLayerCell(floor, 'ground', 0, 0, 1);
        map.setAuthoringFloor(0, floor);
        assert.strictEqual(map._renderCacheDirty, true, 'authoring dirties cache');
        assert.strictEqual(map._renderCache, null, 'invalidate clears cache object');
        assert.ok(map.getAuthoringFloor(0), 'authoring stored');

        const props = map.collectTallProps(0);
        assert.strictEqual(props.length, 0, 'no tall props on ground-only floor');

        setSubLayerCell(floor, 'scenery', 3, 3, 1);
        // Mutating in place without setAuthoringFloor would not dirty — re-set does
        map.setAuthoringFloor(0, floor);
        assert.strictEqual(map.collectTallProps(0).length, 1);

        map.clearAuthoringFloors();
        assert.strictEqual(map.getAuthoringFloor(0), null);
        assert.strictEqual(map._renderCacheDirty, true);
        log('authoring floor cache invalidation');
    } finally {
        Settings.HEADLESS = prevHeadless;
    }
}

function testHybridLoadAttachesAuthoring() {
    const fixture = path.join(
        __dirname,
        'fixtures',
        'hybrid_map',
        'phase4_room'
    );
    const map = new TileMap();
    const { pack } = loadHybridOntoTileMap(map, fixture, { forceBake: true });
    assert.ok(pack, 'pack loaded');
    const auth = map.getAuthoringFloor(0);
    assert.ok(auth, 'authoring floor attached');
    assert.ok(Array.isArray(auth.subLayers), 'subLayers present');
    const props = map.collectTallProps(0);
    assert.ok(props.length >= 1, 'fixture has tall props (tree/stairs)');
    const tree = props.find((p) => p.catalogId === 'simple_dead_tree');
    assert.ok(tree, 'dead tree prop from fixture');
    assert.ok(Math.abs(tree.scale - 1.4) < 1e-9, 'scale 1.4 from palette');
    // Prop south of entity sorts after
    const entityNorth = {
        sortY: tree.tileY - 1,
        subOrder: DRAW_SUB_ENTITY,
        stableKey: 'e'
    };
    const entitySame = {
        sortY: tree.tileY,
        subOrder: DRAW_SUB_ENTITY,
        stableKey: 'e2'
    };
    assert.ok(compareDrawOrder(entityNorth, tree) < 0, 'entity north of tree first');
    assert.ok(compareDrawOrder(tree, entitySame) < 0, 'tree under entity same row');
    log('hybrid load authoring + prop order sample');
}

function main() {
    console.log('tile_draw / Phase 6 render helpers');
    testResolveTileDrawBox();
    testResolvePlacementRender();
    testDrawOrder();
    testCollectTallProps();
    testAuthoringCacheFingerprint();
    testHybridLoadAttachesAuthoring();
    console.log('All tile_draw tests passed.');
}

main();
