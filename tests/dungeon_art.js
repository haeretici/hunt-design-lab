#!/usr/bin/env node
/**
 * Stage 11.9 — Art tile binding (artSet → genre tiles on friction).
 * Quiet on success; VERBOSE=1 for detail.
 */

'use strict';

const { installedModes } = require('./helpers/modes.js');

const assert = require('assert');
const {
    normalizeArtSetPack,
    listArtSetTileIds,
    artSetVolume,
    evaluateArtSetVolume,
    MIN_ART_SET_VOLUME,
    TARGET_ART_SET_VOLUME,
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

/** Stage 11.11 dual-mode art packs (blueprint volume band). */
const VOLUME_ART_SETS = ['cave', 'crypt', 'swamp', 'ice', 'ruins'];

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
    assert.strictEqual(p.roles.floor[1].weight, 2);
    assert.strictEqual(p.rules.blockedEdgeOnly, true);
    assert.strictEqual(p.rules.pathMix, 0.2);
    assert.ok(listArtSetTileIds(p).indexOf('damp_dirt_floor') >= 0);
    assert.strictEqual(normalizeArtSetPack({ id: 'x' }), null);
    log('normalize pack ok');
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
            stairs: [{ id: 'stair_a', weight: 1 }]
        },
        rules: { blockedEdgeOnly: true, pathMix: 0 }
    });
    const a = bindArtToFriction({
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
    // Corner of wall ring is adjacent to walkable → wall; deep void N/A on this grid
    assert.ok(a.stats.floor >= 1);
    assert.ok(a.stats.wall >= 1);
    assert.ok(a.stats.stairs >= 1);
    // Different seed may differ when multiple weighted options — with weight 1 only, same
    const c = bindArtToFriction({
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
        assert.ok(pack.roles.floor.length >= 3);
        assert.ok(pack.roles.wall.length >= 3);
        assert.ok(pack.roles.stairs.length >= 1);
        log(mode, 'art set cave ok', listArtSetTileIds(pack).length, 'tiles');
    }
    setActiveMode('standard');
    clearPresetCache();
}

/**
 * Stage 11.11 — all shipped art sets meet blueprint min volume (18)
 * and the mid-range target (40 unique catalog ids).
 */
function testArtSetVolumeDualMode() {
    for (const mode of installedModes()) {
        setActiveMode(mode);
        clearPresetCache();
        const listed = listArtSetIds();
        for (let i = 0; i < VOLUME_ART_SETS.length; i++) {
            const id = VOLUME_ART_SETS[i];
            assert.ok(
                listed.indexOf(id) >= 0,
                mode + ' lists art set ' + id
            );
            const pack = normalizeArtSetPack(loadArtSet(id));
            assert.ok(pack, mode + ' ' + id + ' normalizes');
            assert.strictEqual(pack.id, id);
            const vol = evaluateArtSetVolume(pack);
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
                vol.meetsTarget,
                mode +
                    ' ' +
                    id +
                    ' volume ' +
                    vol.unique +
                    ' < target ' +
                    TARGET_ART_SET_VOLUME
            );
            assert.strictEqual(artSetVolume(pack), vol.unique);
            assert.ok(pack.roles.floor.length >= 6, id + ' floor depth');
            assert.ok(pack.roles.wall.length >= 6, id + ' wall depth');
            assert.ok(pack.roles.path.length >= 4, id + ' path depth');
            assert.ok(pack.roles.stairs.length >= 4, id + ' stairs depth');
            log(mode, id, 'volume', vol.unique, vol.roleCounts);
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
    const bound = bindArtToFriction({
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
    testBindFrictionDeterministic();
    testLoadPackDualMode();
    testArtSetVolumeDualMode();
    testResolveArtSetId();
    for (const mode of installedModes()) {
        testExpandHuntBindsArt(mode);
        testMultifloorArt(mode);
        testVolumeMacroHunt(mode);
    }
    testTileMapArtLayer();
    testResolveHuntConfigArt();
    console.log('dungeon_art: ok');
}

main();
