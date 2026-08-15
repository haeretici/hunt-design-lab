#!/usr/bin/env node
/**
 * Phase 1 — Tile roles: normalize, influence apply, stack composition.
 * Quiet on success; VERBOSE=1 for detail.
 */

'use strict';

const assert = require('assert');
const {
    normalizeTileRole,
    validateTileRole,
    applyInfluence,
    applyRole,
    bakeCellChannels,
    createBakeAccumulator,
    finalizeBakeCell,
    indexTileRoles,
    resolveTileRole,
    hopDirOffset,
    FRICTION_BLOCKED,
    SIGHT_BLOCKED,
    DEFAULT_OPEN_FRICTION,
    TILE_FLAG_NO_CAST,
    TILE_FLAG_STAIR,
    TILE_FLAG_LADDER,
    TILE_FLAG_HOLE,
    TILE_FLAG_ROPE_SPOT,
    TILE_FLAG_SHOVEL_SPOT,
    TILE_FLAG_NO_CREATURE,
    TILE_FLAG_PZ_PACKAGE
} = require('../kernel/core/lib/dungeon/tile_roles.js');
const {
    loadTileRole,
    listTileRoleIds,
    clearPresetCache
} = require('../kernel/core/lib/presets.js');
const { setActiveMode } = require('../kernel/core/lib/modes.js');

const VERBOSE = !!process.env.VERBOSE;

function log(...args) {
    if (VERBOSE) console.log(...args);
}

const STARTER_IDS = [
    'floor',
    'path',
    'wall',
    'void',
    'water',
    'grate',
    'protection',
    'scenery_blocking',
    'scenery_cover',
    'furniture_blocking',
    'stairs_up',
    'stairs_down',
    'ladder_up',
    'ladder_down',
    'hole',
    'rope_spot',
    'shovel_spot'
];

function testNormalizeRole() {
    assert.strictEqual(normalizeTileRole(null), null);
    assert.strictEqual(normalizeTileRole({}), null);
    assert.strictEqual(normalizeTileRole({ id: '' }), null);
    assert.strictEqual(normalizeTileRole({ id: '123bad' }), null);

    // Sanitize free-form labels into entity ids
    const sanitized = normalizeTileRole({ id: 'Bad Id!!' });
    assert.ok(sanitized);
    assert.strictEqual(sanitized.id, 'bad_id');

    const r = normalizeTileRole({
        id: 'Water_Deep',
        label: 'Deep Water',
        kindHints: ['tiles'],
        influence: {
            friction: 255,
            sight: 0,
            flags: 0,
            walkMode: 'block',
            sightMode: 'clear'
        }
    });
    assert.ok(r);
    assert.strictEqual(r.id, 'water_deep');
    assert.strictEqual(r.label, 'Deep Water');
    assert.strictEqual(r.influence.walkMode, 'block');
    assert.strictEqual(r.influence.sightMode, 'clear');
    assert.strictEqual(r.influence.friction, FRICTION_BLOCKED);
    assert.strictEqual(r.influence.sight, 0);
    assert.strictEqual(r.render.scale, 1);
    assert.strictEqual(r.render.anchor, 'middle_center');
    assert.strictEqual(r.vertical, null);

    // Infer modes from channel values when omitted
    const wall = normalizeTileRole({
        id: 'wall_x',
        influence: { friction: 255, sight: 255 }
    });
    assert.strictEqual(wall.influence.walkMode, 'block');
    assert.strictEqual(wall.influence.sightMode, 'block');

    // Object-only → bottom_center default
    const chest = normalizeTileRole({
        id: 'chest_role',
        kindHints: ['objects'],
        influence: { friction: 255, sight: 255, walkMode: 'block', sightMode: 'block' }
    });
    assert.strictEqual(chest.render.anchor, 'bottom_center');

    // Vertical stairs up
    const stairs = normalizeTileRole({
        id: 'stairs_up',
        influence: { friction: 100, sight: 0, flags: 2, walkMode: 'open', sightMode: 'clear' },
        vertical: { type: 'stairs', deltaZ: -1, defaultDir: 'north', registerStairLink: true }
    });
    assert.ok(stairs.vertical);
    assert.strictEqual(stairs.vertical.type, 'stairs');
    assert.strictEqual(stairs.vertical.deltaZ, -1);
    assert.strictEqual(stairs.vertical.defaultDir, 'north');
    assert.strictEqual(stairs.vertical.registerStairLink, true);

    const overlayPath = normalizeTileRole({
        id: 'path_overlay',
        kindHints: ['tiles', 'overlays'],
        catalogCategories: ['path', 'dirt', 'cobble'],
        influence: { friction: 100, walkMode: 'open', sightMode: 'clear' }
    });
    assert.ok(overlayPath.kindHints.indexOf('overlays') >= 0);
    assert.strictEqual(overlayPath.render.anchor, 'middle_center');
    assert.strictEqual(overlayPath.vertical, null);

    log('normalize role ok');
}

function testValidateWallHopConflict() {
    setActiveMode('standard');
    clearPresetCache();

    const wallOk = validateTileRole(loadTileRole('wall'));
    assert.strictEqual(wallOk.ok, true, JSON.stringify(wallOk.errors));
    assert.strictEqual(wallOk.detail.vertical, null);

    const stairsOk = validateTileRole(loadTileRole('stairs_up'));
    assert.strictEqual(stairsOk.ok, true, JSON.stringify(stairsOk.errors));

    const bad = validateTileRole({
        id: 'face_wall',
        kindHints: ['objects'],
        catalogCategories: ['wall'],
        influence: {
            friction: 255,
            sight: 255,
            walkMode: 'block',
            sightMode: 'block'
        },
        vertical: { type: 'stairs', deltaZ: -1 }
    });
    assert.strictEqual(bad.ok, false);
    assert.ok(bad.errors.indexOf('vertical_hop_on_wall_face') >= 0);
}

function testApplyInfluence() {
    const acc = createBakeAccumulator();
    applyInfluence(acc, {
        friction: 100,
        sight: 0,
        flags: 0,
        walkMode: 'open',
        sightMode: 'clear'
    });
    let out = finalizeBakeCell(acc);
    assert.strictEqual(out.friction, 100);
    assert.strictEqual(out.sight, 0);
    assert.strictEqual(out.flags, 0);

    // Block walk OR's; open friction would not clear block
    applyInfluence(acc, {
        friction: 255,
        sight: 255,
        flags: TILE_FLAG_STAIR,
        walkMode: 'block',
        sightMode: 'block'
    });
    out = finalizeBakeCell(acc);
    assert.strictEqual(out.friction, FRICTION_BLOCKED);
    assert.strictEqual(out.sight, SIGHT_BLOCKED);
    assert.strictEqual(out.flags, TILE_FLAG_STAIR);

    log('apply influence ok');
}

function testCompositionCases() {
    setActiveMode('standard');
    clearPresetCache();

    const roles = indexTileRoles(
        listTileRoleIds().map((id) => loadTileRole(id))
    );

    function bake(...ids) {
        return bakeCellChannels(ids.map((id) => resolveTileRole(roles, id)));
    }

    // T1 grass / floor only
    const grass = bake('floor');
    assert.strictEqual(grass.friction, DEFAULT_OPEN_FRICTION);
    assert.strictEqual(grass.sight, 0);
    assert.strictEqual(grass.flags, 0);
    assert.strictEqual(grass.vertical, null);

    // T2 water
    const water = bake('water');
    assert.strictEqual(water.friction, FRICTION_BLOCKED);
    assert.strictEqual(water.sight, 0, 'water: LoS clear');

    // T3 grass + tree
    const treeStack = bake('floor', 'scenery_blocking');
    assert.strictEqual(treeStack.friction, FRICTION_BLOCKED);
    assert.strictEqual(treeStack.sight, SIGHT_BLOCKED);

    // Remove tree → floor only (re-bake)
    const afterRemove = bake('floor');
    assert.strictEqual(afterRemove.friction, DEFAULT_OPEN_FRICTION);
    assert.strictEqual(afterRemove.sight, 0);

    // T4 grass + chest
    const chest = bake('floor', 'furniture_blocking');
    assert.strictEqual(chest.friction, FRICTION_BLOCKED);
    assert.strictEqual(chest.sight, SIGHT_BLOCKED);

    // Grate: walk open, sight block
    const grate = bake('grate');
    assert.strictEqual(grate.friction, DEFAULT_OPEN_FRICTION);
    assert.strictEqual(grate.sight, SIGHT_BLOCKED);

    // Path over floor: topmost open friction (both 100 in starter set)
    const pathOver = bake('floor', 'path');
    assert.strictEqual(pathOver.friction, DEFAULT_OPEN_FRICTION);
    assert.strictEqual(pathOver.sight, 0);

    // Custom friction: topmost open wins
    const softPath = normalizeTileRole({
        id: 'soft_path',
        influence: { friction: 40, walkMode: 'open', sightMode: 'clear' }
    });
    const topFriction = bakeCellChannels([
        resolveTileRole(roles, 'floor'),
        softPath
    ]);
    assert.strictEqual(topFriction.friction, 40);

    // Scenery cover: block walk, clear sight
    const cover = bake('floor', 'scenery_cover');
    assert.strictEqual(cover.friction, FRICTION_BLOCKED);
    assert.strictEqual(cover.sight, 0);

    // Empty stack → void
    const empty = bakeCellChannels([]);
    assert.strictEqual(empty.friction, FRICTION_BLOCKED);
    assert.strictEqual(empty.sight, SIGHT_BLOCKED);

    // Wall
    const wall = bake('wall');
    assert.strictEqual(wall.friction, FRICTION_BLOCKED);
    assert.strictEqual(wall.sight, SIGHT_BLOCKED);

    // PZ package
    const pz = bake('protection');
    assert.strictEqual(pz.friction, DEFAULT_OPEN_FRICTION, 'PZ stays walkable');
    assert.strictEqual(pz.sight, 0);
    assert.strictEqual(pz.flags, TILE_FLAG_PZ_PACKAGE);
    assert.ok((pz.flags & TILE_FLAG_NO_CAST) !== 0);
    assert.ok((pz.flags & TILE_FLAG_NO_CREATURE) !== 0);

    // Floor under PZ still ORs package
    const floorPz = bake('floor', 'protection');
    assert.strictEqual(floorPz.flags, TILE_FLAG_PZ_PACKAGE);
    assert.strictEqual(floorPz.friction, DEFAULT_OPEN_FRICTION);

    // Stairs up: open pad + STAIR + vertical deltaZ -1
    const up = bake('floor', 'stairs_up');
    assert.strictEqual(up.friction, DEFAULT_OPEN_FRICTION);
    assert.strictEqual(up.sight, 0);
    assert.ok((up.flags & TILE_FLAG_STAIR) !== 0);
    assert.ok((up.flags & TILE_FLAG_NO_CREATURE) !== 0);
    assert.ok(up.vertical);
    assert.strictEqual(up.vertical.deltaZ, -1);
    assert.strictEqual(up.vertical.type, 'stairs');

    // Hole down
    const hole = bake('floor', 'hole');
    assert.ok((hole.flags & TILE_FLAG_HOLE) !== 0);
    assert.ok((hole.flags & TILE_FLAG_NO_CREATURE) !== 0);
    assert.strictEqual(hole.vertical.deltaZ, 1);
    assert.strictEqual(hole.vertical.type, 'hole');

    // Ladder up: Use-only pad
    const ladder = bake('floor', 'ladder_up');
    assert.ok((ladder.flags & TILE_FLAG_LADDER) !== 0);
    assert.ok((ladder.flags & TILE_FLAG_NO_CREATURE) !== 0);
    assert.strictEqual(ladder.vertical.type, 'ladder');
    assert.strictEqual(ladder.vertical.deltaZ, -1);

    // Topmost vertical wins
    const vertWin = bake('floor', 'stairs_up', 'hole');
    assert.strictEqual(vertWin.vertical.type, 'hole');
    assert.strictEqual(vertWin.vertical.deltaZ, 1);
    assert.ok((vertWin.flags & TILE_FLAG_STAIR) !== 0);
    assert.ok((vertWin.flags & TILE_FLAG_HOLE) !== 0);

    // Rope / shovel flags
    const rope = bake('rope_spot');
    assert.ok((rope.flags & TILE_FLAG_ROPE_SPOT) !== 0);
    const shovel = bake('shovel_spot');
    assert.ok((shovel.flags & TILE_FLAG_SHOVEL_SPOT) !== 0);

    // Placement hop meta on topmost vertical
    const withHop = bakeCellChannels([
        resolveTileRole(roles, 'floor'),
        {
            role: resolveTileRole(roles, 'stairs_up'),
            hop: { dir: 'north', deltaZ: -1 }
        }
    ]);
    assert.ok(withHop.hop);
    assert.strictEqual(withHop.hop.dir, 'north');
    assert.deepStrictEqual(hopDirOffset('north'), { dx: 0, dy: -1 });
    assert.deepStrictEqual(hopDirOffset('center'), { dx: 0, dy: 0 });
    assert.deepStrictEqual(hopDirOffset('custom'), { dx: 0, dy: 0 });

    log('composition cases ok');
}

function testPresetsLoader() {
    setActiveMode('standard');
    clearPresetCache();

    const ids = listTileRoleIds();
    for (const id of STARTER_IDS) {
        assert.ok(ids.indexOf(id) >= 0, 'missing starter role ' + id);
    }

    for (const id of STARTER_IDS) {
        const raw = loadTileRole(id);
        const role = normalizeTileRole(raw);
        assert.ok(role, 'normalize failed for ' + id);
        assert.strictEqual(role.id, id);
        assert.ok(role.influence);
        assert.ok(role.influence.walkMode === 'open' || role.influence.walkMode === 'block');
        assert.ok(role.influence.sightMode === 'clear' || role.influence.sightMode === 'block');
    }

    const prot = normalizeTileRole(loadTileRole('protection'));
    assert.strictEqual(prot.influence.flags, TILE_FLAG_PZ_PACKAGE);

    const up = normalizeTileRole(loadTileRole('stairs_up'));
    assert.strictEqual(up.vertical.deltaZ, -1);
    assert.strictEqual(up.influence.flags, TILE_FLAG_STAIR | TILE_FLAG_NO_CREATURE);

    const down = normalizeTileRole(loadTileRole('stairs_down'));
    assert.strictEqual(down.vertical.deltaZ, 1);
    assert.strictEqual(down.influence.flags, TILE_FLAG_STAIR | TILE_FLAG_NO_CREATURE);

    const lad = normalizeTileRole(loadTileRole('ladder_up'));
    assert.strictEqual(lad.vertical.type, 'ladder');
    assert.strictEqual(lad.influence.flags, TILE_FLAG_LADDER | TILE_FLAG_NO_CREATURE);

    // applyRole path
    const acc = createBakeAccumulator();
    applyRole(acc, normalizeTileRole(loadTileRole('floor')));
    applyRole(acc, normalizeTileRole(loadTileRole('scenery_blocking')));
    const baked = finalizeBakeCell(acc);
    assert.strictEqual(baked.friction, FRICTION_BLOCKED);
    assert.strictEqual(baked.sight, SIGHT_BLOCKED);

    log('presets loader ok');
}

function main() {
    testNormalizeRole();
    testValidateWallHopConflict();
    testApplyInfluence();
    testCompositionCases();
    testPresetsLoader();
    console.log('tile_roles: ok');
}

main();
