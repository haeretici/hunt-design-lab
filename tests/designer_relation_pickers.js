#!/usr/bin/env node
/**
 * Designer catalog picker context (art-set role → tiles vs objects).
 */

'use strict';

const assert = require('assert');
const {
    inferCategoryFromPath,
    resolveAssetKind,
    resolvePickerContext
} = require('../kernel/apps/designer-ui/relation_pickers.js');
const {
    defaultCatalogKindForRole,
    inferRoleKeyFromPath,
    catalogCategoryForRole,
    normalizeCatalogKind,
    artSetPickFields
} = require('../kernel/core/lib/dungeon/art_set_context.js');

function fakeEditor(path, parentVal, rootVal) {
    return {
        path,
        parent: { getValue: () => parentVal },
        jsoneditor: { getValue: () => rootVal }
    };
}

function testRoleKeyAndKind() {
    assert.strictEqual(inferRoleKeyFromPath('root.roles.scenery.0.id'), 'scenery');
    assert.strictEqual(inferRoleKeyFromPath('root.roles.stairs_up.0.id'), 'stairs_up');
    assert.strictEqual(defaultCatalogKindForRole('scenery'), 'objects');
    assert.strictEqual(defaultCatalogKindForRole('furniture'), 'objects');
    assert.strictEqual(defaultCatalogKindForRole('floor'), 'tiles');
    assert.strictEqual(
        defaultCatalogKindForRole('wall', 'scenery_blocking'),
        'objects'
    );
    assert.strictEqual(catalogCategoryForRole('tiles', 'floor'), 'floor');
    assert.strictEqual(catalogCategoryForRole('tiles', 'stairs_up'), 'special');
    assert.strictEqual(catalogCategoryForRole('objects', 'scenery'), '');
    assert.strictEqual(catalogCategoryForRole('objects', 'furniture'), 'furniture');
    assert.strictEqual(catalogCategoryForRole('objects', 'wall'), 'wall');
    assert.strictEqual(catalogCategoryForRole('overlays', 'path'), 'dirt');
    assert.strictEqual(catalogCategoryForRole('overlays', 'water'), 'water');
    assert.strictEqual(normalizeCatalogKind('overlays'), 'overlays');
    assert.strictEqual(normalizeCatalogKind('overlay'), 'overlays');
    assert.strictEqual(
        defaultCatalogKindForRole('path'),
        'tiles',
        'omitted path kind stays tiles (existing packs)'
    );
}

function testPickerIgnoresPackKind() {
    const pack = {
        id: 'cave',
        kind: 'tiles',
        roles: { scenery: [{ id: 'simple_dead_tree', kind: 'objects' }] }
    };
    const entry = {
        id: 'simple_dead_tree',
        weight: 2,
        roleId: 'scenery_blocking',
        kind: 'objects'
    };
    const ed = fakeEditor('root.roles.scenery.0.id', entry, pack);
    const ctx = resolvePickerContext(ed, ed.path, 'tiles');
    assert.strictEqual(ctx.assetKind, 'objects');
    assert.strictEqual(ctx.category, '');
    assert.strictEqual(resolveAssetKind(ed, 'tiles'), 'objects');
}

function testPickerRoleWhenKindOmitted() {
    const pack = { id: 'cave', kind: 'tiles', roles: {} };
    const entry = { id: 'simple_dead_tree', weight: 2, roleId: 'scenery_blocking' };
    const ed = fakeEditor('root.roles.scenery.0.id', entry, pack);
    const ctx = resolvePickerContext(ed, ed.path, 'tiles');
    assert.strictEqual(ctx.assetKind, 'objects', 'role key wins over pack kind');
    assert.strictEqual(inferCategoryFromPath(ed.path), '');
}

function testFloorStaysTiles() {
    const pack = { id: 'cave', kind: 'tiles', roles: {} };
    const entry = { id: 'damp_dirt_floor', weight: 12, roleId: 'floor' };
    const ed = fakeEditor('root.roles.floor.0.id', entry, pack);
    const ctx = resolvePickerContext(ed, ed.path, 'tiles');
    assert.strictEqual(ctx.assetKind, 'tiles');
    assert.strictEqual(ctx.category, 'floor');
    assert.strictEqual(inferCategoryFromPath(ed.path), 'floor');
}

function testClassBaseSpriteUnchanged() {
    const cls = { id: 'knight', baseSprite: 'crystal_lizard_warrior' };
    const ed = fakeEditor('root.baseSprite', cls, cls);
    const ctx = resolvePickerContext(ed, ed.path, 'creatures');
    assert.strictEqual(ctx.assetKind, 'creatures');
    assert.strictEqual(ctx.category, '');
}

function testPathOverlayPickerFollowsEntryKind() {
    const pack = { id: 'cave', kind: 'tiles', roles: {} };
    const entry = {
        id: 'dirt_wang_15',
        kind: 'overlays',
        roleId: 'path',
        wangFamily: 'dirt'
    };
    const ed = fakeEditor('root.roles.path.0.id', entry, pack);
    const ctx = resolvePickerContext(ed, ed.path, 'tiles');
    assert.strictEqual(ctx.assetKind, 'overlays');
    assert.strictEqual(ctx.category, 'dirt');
}

function testWallObjectPickerFiltersWall() {
    const pack = { id: 'cave', kind: 'tiles', roles: {} };
    const entry = {
        id: 'stone_wall_pole',
        kind: 'objects',
        roleId: 'wall',
        wallFamily: 'stone_wall',
        wallAlign: 'pole'
    };
    const ed = fakeEditor('root.roles.wall.0.id', entry, pack);
    const ctx = resolvePickerContext(ed, ed.path, 'tiles');
    assert.strictEqual(ctx.assetKind, 'objects');
    assert.strictEqual(ctx.category, 'wall');
}

function testArtSetPickWritesFamilyRepresentative() {
    const overlay = artSetPickFields('dirt_wang_05', {
        assetKind: 'overlays',
        category: 'dirt'
    });
    assert.strictEqual(overlay.kind, 'overlays');
    assert.strictEqual(overlay.wangFamily, 'dirt');
    assert.strictEqual(overlay.id, 'dirt_wang_15');
    assert.strictEqual(overlay.wallFamily, '');

    const wall = artSetPickFields('stone_wall_corner', {
        assetKind: 'objects',
        category: 'wall'
    });
    assert.strictEqual(wall.kind, 'objects');
    assert.strictEqual(wall.wallFamily, 'stone_wall');
    assert.strictEqual(wall.wallAlign, 'pole');
    assert.strictEqual(wall.id, 'stone_wall_pole');
    assert.strictEqual(wall.wangFamily, '');

    const tile = artSetPickFields('polished_dirt_path', {
        assetKind: 'tiles',
        category: 'path'
    });
    assert.strictEqual(tile.kind, 'tiles');
    assert.strictEqual(tile.id, 'polished_dirt_path');
    assert.strictEqual(tile.wangFamily, '');
    assert.strictEqual(tile.wallFamily, '');
}

function testHonestySliceFallbackKinds() {
    const spellEd = fakeEditor('root.spells.0.customUISprite', {}, { spells: [] });
    assert.strictEqual(
        resolvePickerContext(spellEd, spellEd.path, 'ui').assetKind,
        'ui'
    );
    const objEd = fakeEditor('root.pools.B.objectIds.0', {}, { pools: {} });
    assert.strictEqual(
        resolvePickerContext(objEd, objEd.path, 'objects').assetKind,
        'objects'
    );
}

function main() {
    testRoleKeyAndKind();
    testPickerIgnoresPackKind();
    testPickerRoleWhenKindOmitted();
    testFloorStaysTiles();
    testPathOverlayPickerFollowsEntryKind();
    testWallObjectPickerFiltersWall();
    testArtSetPickWritesFamilyRepresentative();
    testClassBaseSpriteUnchanged();
    testHonestySliceFallbackKinds();
    console.log('designer relation pickers ok');
}

main();
