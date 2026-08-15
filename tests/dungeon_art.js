#!/usr/bin/env node
/**
 * Stage 11.9 — Art tile binding (artSet → genre tiles on friction).
 * TileMap Phase 3 — slim packs, roleId / kind / scale / anchor, bindArtFromRoles.
 * Quiet on success; VERBOSE=1 for detail.
 */

'use strict';

const { installedModes } = require('./helpers/modes.js');

const assert = require('assert');
const {
    normalizeArtSetPack,
    normalizeRoleEntry,
    listArtSetTileIds,
    artSetVolume,
    evaluateArtSetVolume,
    MIN_ART_SET_VOLUME,
    TARGET_ART_SET_VOLUME,
    MAX_ART_SET_PER_ROLE,
    bindArtFromRoles,
    bindArtToFriction,
    bindHuntArt,
    resolveArtSetId,
    artSeed,
    tileIdAtXY
} = require('../kernel/core/lib/dungeon/art.js');
const { FRICTION_BLOCKED } = require('../kernel/core/entities/tilemap.js');
const {
    loadArtSet,
    listArtSetIds,
    expandHuntDefinition,
    loadJson,
    clearPresetCache
} = require('../kernel/core/lib/presets.js');
const { setActiveMode } = require('../kernel/core/lib/modes.js');
const { TileMap } = require('../kernel/core/entities/tilemap.js');
const {
    resolveHuntConfig
} = require('../kernel/providers/simulator/headless_runner.js');

/** Shipped biome art packs (slim volume policy). */
const SLIM_ART_SETS = ['cave', 'crypt', 'swamp', 'ice', 'ruins'];

const VERBOSE = !!process.env.VERBOSE;

function log(...args) {
    if (VERBOSE) console.log(...args);
}

function testNormalizePack() {
    const p = normalizeArtSetPack({
        id: 'Cave',
        genre: 'rpg_fantasy',
        roles: {
            floor: ['damp_dirt_floor', { id: 'damp_moss_floor', weight: 2 }],
            wall: [{ id: 'damp_cave_wall', weight: 1 }]
        },
        rules: { blockedEdgeOnly: true, pathMix: 0.2 }
    });
    assert.ok(p);
    assert.strictEqual(p.id, 'cave');
    assert.strictEqual(p.genre, 'rpg_fantasy');
    assert.strictEqual(p.roles.floor.length, 2);
    assert.strictEqual(p.roles.floor[0].id, 'damp_dirt_floor');
    assert.strictEqual(p.roles.floor[0].weight, 1);
    assert.strictEqual(p.roles.floor[0].roleId, 'floor');
    assert.strictEqual(p.roles.floor[1].weight, 2);
    assert.strictEqual(p.rules.blockedEdgeOnly, true);
    assert.strictEqual(p.rules.pathMix, 0.2);
    assert.ok(listArtSetTileIds(p).indexOf('damp_dirt_floor') >= 0);
    assert.strictEqual(normalizeArtSetPack({ id: 'x' }), null);
    log('normalize pack ok');
}

function testNormalizeRoleAwareness() {
    const p = normalizeArtSetPack({
        id: 'unit_roles',
        genre: 'rpg_fantasy',
        kind: 'tiles',
        roles: {
            floor: [
                {
                    id: 'damp_dirt_floor',
                    weight: 12,
                    roleId: 'floor',
                    scale: 1
                }
            ],
            path: [{ id: 'polished_dirt_path', weight: 3, roleId: 'path' }],
            wall: [{ id: 'damp_cave_wall', weight: 12, roleId: 'wall' }],
            water: [{ id: 'damp_deep_water', weight: 4, roleId: 'water' }],
            stairs_up: [
                {
                    id: 'broken_cave_stairs',
                    weight: 5,
                    roleId: 'stairs_up',
                    anchor: 'bottom_center'
                }
            ],
            scenery: [
                {
                    id: 'simple_dead_tree',
                    weight: 2,
                    roleId: 'scenery_blocking',
                    kind: 'objects',
                    scale: 1.4,
                    anchor: 'bottom_center'
                }
            ]
        },
        rules: { blockedEdgeOnly: true, pathMix: 0.18 }
    });
    assert.ok(p);
    // water → void for procedural bind
    assert.ok(p.roles.void.length >= 1);
    assert.strictEqual(p.roles.void[0].id, 'damp_deep_water');
    assert.strictEqual(p.roles.void[0].roleId, 'water');
    // stairs_up → stairs for bind
    assert.ok(p.roles.stairs.length >= 1);
    assert.strictEqual(p.roles.stairs[0].id, 'broken_cave_stairs');
    assert.strictEqual(p.roles.stairs[0].anchor, 'bottom_center');
    // scenery kept for palette, not terrain volume-only list when terrainOnly
    assert.ok(p.roles.scenery && p.roles.scenery.length === 1);
    assert.strictEqual(p.roles.scenery[0].kind, 'objects');
    assert.strictEqual(p.roles.scenery[0].scale, 1.4);
    const terrainIds = listArtSetTileIds(p, { terrainOnly: true });
    assert.ok(terrainIds.indexOf('simple_dead_tree') < 0);
    assert.ok(listArtSetTileIds(p).indexOf('simple_dead_tree') >= 0);
    log('normalize role awareness ok');
}

function testSceneryDefaultsToObjects() {
    const omitted = normalizeRoleEntry(
        { id: 'simple_dead_tree', weight: 2, roleId: 'scenery_blocking' },
        'scenery',
        'tiles'
    );
    assert.ok(omitted);
    assert.strictEqual(omitted.kind, 'objects');

    const asString = normalizeRoleEntry('simple_dead_tree', 'scenery', 'tiles');
    assert.ok(asString);
    assert.strictEqual(asString.kind, 'objects');

    const explicit = normalizeRoleEntry(
        { id: 'odd_tile', kind: 'tiles' },
        'scenery',
        'tiles'
    );
    assert.ok(explicit);
    assert.strictEqual(explicit.kind, 'tiles');

    const floor = normalizeRoleEntry({ id: 'damp_dirt_floor' }, 'floor', 'tiles');
    assert.ok(floor);
    assert.strictEqual(floor.kind, 'tiles');

    const overlay = normalizeRoleEntry(
        { id: 'dirt_wang_15', kind: 'overlays', roleId: 'path' },
        'path',
        'tiles'
    );
    assert.ok(overlay);
    assert.strictEqual(overlay.kind, 'overlays');
    log('scenery defaults to objects ok');
}

function testBindFrictionDeterministic() {
    // 5x5 room: walls around, walkable center
    const cols = 5;
    const rows = 5;
    const friction = new Uint8Array(cols * rows);
    for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
            const edge = x === 0 || y === 0 || x === cols - 1 || y === rows - 1;
            friction[y * cols + x] = edge ? FRICTION_BLOCKED : 100;
        }
    }
    const pack = normalizeArtSetPack({
        id: 'unit',
        genre: 'rpg_fantasy',
        roles: {
            floor: [{ id: 'floor_a', weight: 1 }],
            wall: [{ id: 'wall_a', weight: 1 }],
            stairs: [{ id: 'stair_a', weight: 1 }],
            scenery: [
                {
                    id: 'should_not_paint',
                    weight: 99,
                    kind: 'objects',
                    roleId: 'scenery_blocking'
                }
            ]
        },
        rules: { blockedEdgeOnly: true, pathMix: 0 }
    });
    const a = bindArtFromRoles({
        friction,
        cols,
        rows,
        artSet: pack,
        seed: 42,
        z: 0,
        stairs: [{ x: 2, y: 2, z: 0 }]
    });
    const b = bindArtToFriction({
        friction,
        cols,
        rows,
        artSet: pack,
        seed: 42,
        z: 0,
        stairs: [{ x: 2, y: 2, z: 0 }]
    });
    assert.ok(a && a.ok);
    assert.ok(b && b.ok);
    assert.deepStrictEqual(Array.from(a.cells), Array.from(b.cells));
    assert.strictEqual(tileIdAtXY(a, 2, 2), 'stair_a');
    assert.strictEqual(tileIdAtXY(a, 2, 1), 'floor_a');
    assert.strictEqual(tileIdAtXY(a, 0, 1), 'wall_a'); // edge wall
    // Scenery never appears in palette from procedural bind
    assert.ok(a.palette.indexOf('should_not_paint') < 0);
    assert.ok(a.stats.floor >= 1);
    assert.ok(a.stats.wall >= 1);
    assert.ok(a.stats.stairs >= 1);
    const c = bindArtFromRoles({
        friction,
        cols,
        rows,
        artSet: pack,
        seed: 99,
        z: 0
    });
    assert.ok(c && c.ok);
    log('bind friction deterministic ok', a.stats);
}

function testLoadPackDualMode() {
    for (const mode of installedModes()) {
        setActiveMode(mode);
        clearPresetCache();
        const ids = listArtSetIds();
        assert.ok(ids.indexOf('cave') >= 0, mode + ' has cave art set');
        const raw = loadArtSet('cave');
        const pack = normalizeArtSetPack(raw);
        assert.ok(pack);
        assert.strictEqual(pack.id, 'cave');
        assert.ok(pack.roles.floor.length >= 1);
        assert.ok(pack.roles.wall.length >= 1);
        assert.ok(pack.roles.stairs.length >= 1);
        assert.ok(
            pack.roles.floor[0].roleId === 'floor' ||
                pack.roles.floor[0].roleId == null
        );
        log(mode, 'art set cave ok', listArtSetTileIds(pack).length, 'tiles');
    }
    setActiveMode('standard');
    clearPresetCache();
}

/**
 * Slim policy: not empty, within per-role max, soft whole-pack target.
 */
function testArtSetVolumeSlim() {
    for (const mode of installedModes()) {
        setActiveMode(mode);
        clearPresetCache();
        const listed = listArtSetIds();
        for (let i = 0; i < SLIM_ART_SETS.length; i++) {
            const id = SLIM_ART_SETS[i];
            assert.ok(
                listed.indexOf(id) >= 0,
                mode + ' lists art set ' + id
            );
            const pack = normalizeArtSetPack(loadArtSet(id));
            assert.ok(pack, mode + ' ' + id + ' normalizes');
            assert.strictEqual(pack.id, id);
            const vol = evaluateArtSetVolume(pack);
            assert.ok(
                vol.ok,
                mode + ' ' + id + ' volume not ok: ' + vol.message
            );
            assert.ok(
                vol.meetsMin,
                mode +
                    ' ' +
                    id +
                    ' volume ' +
                    vol.unique +
                    ' < min ' +
                    MIN_ART_SET_VOLUME
            );
            assert.ok(
                vol.withinRoleMax,
                mode +
                    ' ' +
                    id +
                    ' role over max ' +
                    MAX_ART_SET_PER_ROLE +
                    ' ' +
                    JSON.stringify(vol.roleCounts)
            );
            assert.ok(
                vol.meetsTarget,
                mode +
                    ' ' +
                    id +
                    ' not slim target unique=' +
                    vol.unique +
                    ' target=' +
                    TARGET_ART_SET_VOLUME
            );
            assert.strictEqual(artSetVolume(pack), vol.unique);
            assert.ok(pack.roles.floor.length >= 1, id + ' floor');
            assert.ok(pack.roles.wall.length >= 1, id + ' wall');
            assert.ok(pack.roles.floor.length <= MAX_ART_SET_PER_ROLE);
            assert.ok(pack.roles.wall.length <= MAX_ART_SET_PER_ROLE);
            assert.ok(pack.roles.path.length <= MAX_ART_SET_PER_ROLE);
            assert.ok(pack.roles.stairs.length <= MAX_ART_SET_PER_ROLE);
            log(mode, id, 'volume', vol.unique, vol.roleCounts);
        }
        // simple packs also listed
        for (const sid of ['cave_simple', 'ice_simple']) {
            if (listed.indexOf(sid) < 0) continue;
            const pack = normalizeArtSetPack(loadArtSet(sid));
            assert.ok(pack);
            const vol = evaluateArtSetVolume(pack);
            assert.ok(vol.ok && vol.withinRoleMax, sid + ' ' + vol.message);
        }
    }
    setActiveMode('standard');
    clearPresetCache();
}

function testVolumeMacroHunt(mode) {
    setActiveMode(mode);
    clearPresetCache();
    const hunt = expandHuntDefinition(loadJson('hunts/biome_volume_macro.json'), {
        seed: 19
    });
    assert.ok(hunt.layoutMeta && hunt.layoutMeta.reason === 'ok', 'layout ok');
    assert.ok(hunt.layoutMeta.macro, 'macro meta');
    assert.ok(hunt.artMeta && hunt.artMeta.reason === 'ok', 'art bound');
    assert.ok(hunt.artLayers);
    const zs = Object.keys(hunt.artLayers);
    assert.ok(zs.length >= 4, 'art on 4+ floors, got ' + zs.length);
    /** @type {Record<string, true>} */
    const artSets = Object.create(null);
    for (let i = 0; i < zs.length; i++) {
        const L = hunt.artLayers[zs[i]];
        assert.ok(L.cells && L.palette && L.palette.length > 1);
        if (L.artSet) artSets[L.artSet] = true;
    }
    const setCount = Object.keys(artSets).length;
    assert.ok(
        setCount >= 4,
        mode + ' volume macro art sets ' + setCount + ' ' + Object.keys(artSets).join(',')
    );
    // Seed stability
    const hunt2 = expandHuntDefinition(loadJson('hunts/biome_volume_macro.json'), {
        seed: 19
    });
    assert.deepStrictEqual(
        Array.from(hunt.artLayers[zs[0]].cells),
        Array.from(hunt2.artLayers[zs[0]].cells)
    );
    log(mode, 'biome_volume_macro ok', setCount, 'artSets', zs.length, 'floors');
}

function testExpandHuntBindsArt(mode) {
    setActiveMode(mode);
    clearPresetCache();
    const raw = loadJson('hunts/cave_crawl_generated.json');
    const hunt = expandHuntDefinition(raw, { seed: 7 });
    assert.ok(hunt.floorFriction && hunt.floorFriction.friction, 'has friction');
    assert.ok(hunt.artMeta && hunt.artMeta.reason === 'ok', 'art bound');
    assert.strictEqual(hunt.artSet, 'cave');
    assert.ok(hunt.floorArt && hunt.floorArt.cells);
    assert.ok(hunt.artLayers);
    assert.ok(hunt.artMeta.painted > 0);
    // Seed stable
    const hunt2 = expandHuntDefinition(loadJson('hunts/cave_crawl_generated.json'), {
        seed: 7
    });
    assert.deepStrictEqual(
        Array.from(hunt.floorArt.cells),
        Array.from(hunt2.floorArt.cells)
    );
    log(mode, 'expand cave_crawl_generated art ok', hunt.artMeta.painted);
}

function testMultifloorArt(mode) {
    setActiveMode(mode);
    clearPresetCache();
    const raw = loadJson('hunts/cave_crawl_multifloor.json');
    const hunt = expandHuntDefinition(raw, { seed: 11 });
    assert.ok(hunt.floorLayers);
    assert.ok(hunt.artMeta && hunt.artMeta.reason === 'ok');
    assert.ok(hunt.artLayers);
    const zs = Object.keys(hunt.artLayers);
    assert.ok(zs.length >= 2, 'art on multiple floors');
    for (let i = 0; i < zs.length; i++) {
        const L = hunt.artLayers[zs[i]];
        assert.ok(L.cells && L.palette);
        assert.ok(L.palette.length > 1);
    }
    log(mode, 'multifloor art ok', zs.join(','));
}

function testTileMapArtLayer() {
    const tm = new TileMap();
    const cols = 3;
    const rows = 3;
    const friction = new Uint8Array(9);
    friction.fill(100);
    friction[0] = FRICTION_BLOCKED;
    tm.loadFloorFromFriction(0, cols, rows, friction);
    const pack = normalizeArtSetPack({
        id: 't',
        roles: {
            floor: ['f1'],
            wall: ['w1']
        },
        rules: { blockedEdgeOnly: false, pathMix: 0 }
    });
    const bound = bindArtFromRoles({
        friction,
        cols,
        rows,
        artSet: pack,
        seed: 1,
        z: 0
    });
    tm.setArtLayer(0, bound);
    assert.strictEqual(tm.artTileIdAt(1, 1, 0), 'f1');
    assert.strictEqual(tm.artTileIdAt(0, 0, 0), 'w1');
    log('tilemap art layer ok');
}

function testResolveHuntConfigArt() {
    setActiveMode('standard');
    clearPresetCache();
    const resolved = resolveHuntConfig({
        huntId: 'cave_crawl_generated',
        seed: 3
    });
    assert.ok(resolved.floorLayers);
    assert.ok(resolved.artLayers, 'resolveHuntConfig exposes artLayers');
    assert.ok(resolved.floorArt || Object.keys(resolved.artLayers).length);
    log('resolveHuntConfig art ok');
}

function testResolveArtSetId() {
    assert.strictEqual(
        resolveArtSetId({ artSet: 'cave' }),
        'cave'
    );
    assert.strictEqual(
        resolveArtSetId({ layoutMeta: { artSet: 'cave' } }),
        'cave'
    );
    log('resolveArtSetId ok', artSeed(1));
}

function main() {
    testNormalizePack();
    testNormalizeRoleAwareness();
    testSceneryDefaultsToObjects();
    testBindFrictionDeterministic();
    testLoadPackDualMode();
    testArtSetVolumeSlim();
    testResolveArtSetId();
    for (const mode of installedModes()) {
        testExpandHuntBindsArt(mode);
        testMultifloorArt(mode);
        testVolumeMacroHunt(mode);
    }
    testTileMapArtLayer();
    testResolveHuntConfigArt();
    // bindHuntArt still exported
    assert.strictEqual(typeof bindHuntArt, 'function');
    console.log('dungeon_art: ok');
}

main();
