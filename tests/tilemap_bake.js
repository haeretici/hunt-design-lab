#!/usr/bin/env node
/**
 * Phase 4 — TileMap bake pipeline + hybrid load/save + PNG bootstrap/export.
 * Quiet on success; VERBOSE=1 for detail.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { setActiveMode } = require('../kernel/core/lib/modes.js');
const {
    loadTileRole,
    listTileRoleIds,
    clearPresetCache
} = require('../kernel/core/lib/presets.js');
const {
    indexTileRoles,
    FRICTION_BLOCKED,
    SIGHT_BLOCKED,
    DEFAULT_OPEN_FRICTION,
    TILE_FLAG_PZ_PACKAGE,
    TILE_FLAG_NO_CAST,
    TILE_FLAG_STAIR,
    TILE_FLAG_HOLE
} = require('../kernel/core/lib/dungeon/tile_roles.js');
const {
    SUB_LAYER_DEFS,
    SUB_LAYER_IDS,
    OVERRIDE_FRICTION,
    OVERRIDE_SIGHT,
    OVERRIDE_FLAGS,
    createEmptyTileMapFloor,
    addPaletteEntry,
    setSubLayerCell,
    bakeTileMapFloor,
    bakeCellFromFloor,
    diffOverrides,
    applyBakeToTileMap,
    normalizeHybridPack,
    serializeHybridPack,
    deserializeHybridPack,
    writeHybridMapDir,
    readHybridMapDir,
    gzipBytes,
    isHybridMapDir,
    bakeHybridPack,
    loadHybridOntoTileMap,
    resolveEditorStairLink,
    isExplicitEditorStairDest,
    collectHybridStairDestFloors,
    bootstrapFloorFromPathPng,
    resolveMapLoad,
    exportChannelsToPngBuffer,
    exportChannelsToPngFile,
    tryResolveHybridMapPack
} = require('../kernel/core/lib/dungeon/tilemap_bake.js');
const {
    TileMap,
    registerVerticalFromPlacement
} = require('../kernel/core/entities/tilemap.js');
const { Simulator } = require('../kernel/providers/simulator/simulator.js');
const { mapPathPng } = require('../kernel/settings.js');

const VERBOSE = !!process.env.VERBOSE;
const FIXTURE_DIR = path.join(
    __dirname,
    'fixtures',
    'hybrid_map',
    'phase4_room'
);

function log(...args) {
    if (VERBOSE) console.log(...args);
}

function roleCatalog() {
    setActiveMode('standard');
    clearPresetCache();
    return indexTileRoles(listTileRoleIds().map((id) => loadTileRole(id)));
}

/**
 * Golden stacks — bake composition in docs/08 (walk OR, topmost friction, sight OR).
 */
function testGoldenStacks() {
    const roles = roleCatalog();
    const floor = createEmptyTileMapFloor(8, 8, { z: 0 });

    const iFloor = addPaletteEntry(floor, {
        catalogId: 'test_grass',
        roleId: 'floor'
    });
    const iWater = addPaletteEntry(floor, {
        catalogId: 'test_water',
        roleId: 'water'
    });
    const iTree = addPaletteEntry(floor, {
        catalogId: 'test_tree',
        roleId: 'scenery_blocking',
        kind: 'objects'
    });
    const iChest = addPaletteEntry(floor, {
        catalogId: 'test_chest',
        roleId: 'furniture_blocking',
        kind: 'objects'
    });
    const iPath = addPaletteEntry(floor, {
        catalogId: 'test_path',
        roleId: 'path'
    });
    const iPz = addPaletteEntry(floor, {
        catalogId: 'test_pz',
        roleId: 'protection'
    });
    const iStairs = addPaletteEntry(floor, {
        catalogId: 'test_stairs',
        roleId: 'stairs_up',
        hop: { dir: 'north', deltaZ: -1 }
    });
    const iHole = addPaletteEntry(floor, {
        catalogId: 'test_hole',
        roleId: 'hole'
    });
    const iGrate = addPaletteEntry(floor, {
        catalogId: 'test_grate',
        roleId: 'grate'
    });

    // T1 grass only (1,1)
    setSubLayerCell(floor, 'ground', 1, 1, iFloor);
    // T2 water (2,1)
    setSubLayerCell(floor, 'ground', 2, 1, iWater);
    // T3 grass + tree (3,1)
    setSubLayerCell(floor, 'ground', 3, 1, iFloor);
    setSubLayerCell(floor, 'scenery', 3, 1, iTree);
    // grass + chest (4,1)
    setSubLayerCell(floor, 'ground', 4, 1, iFloor);
    setSubLayerCell(floor, 'furniture', 4, 1, iChest);
    // path over floor (5,1)
    setSubLayerCell(floor, 'ground', 5, 1, iFloor);
    setSubLayerCell(floor, 'path', 5, 1, iPath);
    // PZ (6,1)
    setSubLayerCell(floor, 'ground', 6, 1, iPz);
    // stairs up with hop north (1,2)
    setSubLayerCell(floor, 'ground', 1, 2, iFloor);
    setSubLayerCell(floor, 'vertical', 1, 2, iStairs);
    // hole down (2,2)
    setSubLayerCell(floor, 'ground', 2, 2, iFloor);
    setSubLayerCell(floor, 'vertical', 2, 2, iHole);
    // grate (3,2)
    setSubLayerCell(floor, 'ground', 3, 2, iGrate);

    const baked = bakeTileMapFloor(floor, { roleCatalog: roles });
    const at = (x, y) => {
        const i = y * 8 + x;
        return {
            f: baked.friction[i],
            s: baked.sight[i],
            fl: baked.flags[i],
            cell: baked.cells[i]
        };
    };

    // Empty → void
    const empty = at(0, 0);
    assert.strictEqual(empty.f, FRICTION_BLOCKED);
    assert.strictEqual(empty.s, SIGHT_BLOCKED);

    // T1
    const t1 = at(1, 1);
    assert.strictEqual(t1.f, DEFAULT_OPEN_FRICTION);
    assert.strictEqual(t1.s, 0);

    // T2 water: walk block, sight clear
    const t2 = at(2, 1);
    assert.strictEqual(t2.f, FRICTION_BLOCKED);
    assert.strictEqual(t2.s, 0);

    // T3 tree stack
    const t3 = at(3, 1);
    assert.strictEqual(t3.f, FRICTION_BLOCKED);
    assert.strictEqual(t3.s, SIGHT_BLOCKED);

    // chest
    const chest = at(4, 1);
    assert.strictEqual(chest.f, FRICTION_BLOCKED);
    assert.strictEqual(chest.s, SIGHT_BLOCKED);

    // path over floor
    const pathCell = at(5, 1);
    assert.strictEqual(pathCell.f, DEFAULT_OPEN_FRICTION);
    assert.strictEqual(pathCell.s, 0);

    // PZ package
    const pz = at(6, 1);
    assert.strictEqual(pz.f, DEFAULT_OPEN_FRICTION);
    assert.strictEqual(pz.fl, TILE_FLAG_PZ_PACKAGE);

    // stairs
    const st = at(1, 2);
    assert.strictEqual(st.f, DEFAULT_OPEN_FRICTION);
    assert.ok((st.fl & TILE_FLAG_STAIR) !== 0);
    assert.ok(st.cell.vertical);
    assert.strictEqual(st.cell.vertical.deltaZ, -1);
    assert.ok(st.cell.hop);
    assert.strictEqual(st.cell.hop.dir, 'north');

    // hole
    const hole = at(2, 2);
    assert.ok((hole.fl & TILE_FLAG_HOLE) !== 0);
    assert.strictEqual(hole.cell.vertical.deltaZ, 1);

    // grate
    const gr = at(3, 2);
    assert.strictEqual(gr.f, DEFAULT_OPEN_FRICTION);
    assert.strictEqual(gr.s, SIGHT_BLOCKED);

    // verticals collected for registerStairLink roles
    assert.ok(baked.verticals.length >= 2, 'stairs + hole in verticals');
    const stairV = baked.verticals.find((v) => v.x === 1 && v.y === 2);
    assert.ok(stairV);
    assert.strictEqual(stairV.placement.hop.dir, 'north');

    // Remove tree: re-paint scenery empty and re-bake cell
    setSubLayerCell(floor, 'scenery', 3, 1, 0);
    const after = bakeCellFromFloor(floor, 3, 1, roles);
    assert.strictEqual(after.friction, DEFAULT_OPEN_FRICTION);
    assert.strictEqual(after.sight, 0);

    log('golden stacks ok');
}

function testDiffOverrides() {
    const n = 4;
    const baked = {
        friction: new Uint8Array([100, 100, 100, 100]),
        sight: new Uint8Array([0, 0, 0, 0]),
        flags: new Uint8Array([0, 0, 0, 0])
    };
    const previous = {
        friction: new Uint8Array([40, 40, 40, 40]),
        sight: new Uint8Array([255, 255, 255, 255]),
        flags: new Uint8Array([1, 1, 1, 1])
    };
    const mask = new Uint8Array([
        OVERRIDE_FRICTION,
        OVERRIDE_SIGHT,
        OVERRIDE_FLAGS,
        OVERRIDE_FRICTION | OVERRIDE_SIGHT | OVERRIDE_FLAGS
    ]);
    const m = diffOverrides(baked, previous, mask);
    assert.strictEqual(m.friction[0], 40);
    assert.strictEqual(m.sight[0], 0);
    assert.strictEqual(m.friction[1], 100);
    assert.strictEqual(m.sight[1], 255);
    assert.strictEqual(m.flags[2], 1);
    assert.strictEqual(m.friction[3], 40);
    assert.strictEqual(m.sight[3], 255);
    assert.strictEqual(m.flags[3], 1);
    log('diffOverrides ok');
}

function testApplyToTileMapAndStairs() {
    const roles = roleCatalog();
    const floor = createEmptyTileMapFloor(4, 4, { z: 1 });
    const iFloor = addPaletteEntry(floor, {
        catalogId: 'g',
        roleId: 'floor'
    });
    const iStairs = addPaletteEntry(floor, {
        catalogId: 's',
        roleId: 'stairs_up',
        hop: { dir: 'east', deltaZ: -1 }
    });
    // walkable pad
    for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 4; x++) {
            setSubLayerCell(floor, 'ground', x, y, iFloor);
        }
    }
    setSubLayerCell(floor, 'vertical', 1, 1, iStairs);

    // Destination floor z=0 needed for hop target existence? addStair only stores link
    const map = new TileMap();
    // Pre-install destination floor so hop is usable later
    map.loadFloorFromFriction(0, 4, 4, new Uint8Array(16).fill(100));

    const baked = bakeTileMapFloor(floor, { roleCatalog: roles });
    applyBakeToTileMap(map, 1, baked, { registerVertical: true });

    assert.strictEqual(map.getFriction(1, 1, 1), DEFAULT_OPEN_FRICTION);
    assert.ok((map.getTileFlags(1, 1, 1) & TILE_FLAG_STAIR) !== 0);
    const stair = map.getStair(1, 1, 1);
    assert.ok(stair, 'stair registered');
    // hop east → dest x+1, z-1
    assert.strictEqual(stair.x, 2);
    assert.strictEqual(stair.y, 1);
    assert.strictEqual(String(stair.z), '0');
    assert.strictEqual(stair.dir, 'east');

    log('apply + stairs ok');
}

function testHybridRoundTrip() {
    const roles = roleCatalog();
    const floor = createEmptyTileMapFloor(4, 3, { z: 0 });
    const iFloor = addPaletteEntry(floor, {
        catalogId: 'moss',
        roleId: 'floor'
    });
    const iWater = addPaletteEntry(floor, {
        catalogId: 'pool',
        roleId: 'water'
    });
    for (let y = 0; y < 3; y++) {
        for (let x = 0; x < 4; x++) {
            setSubLayerCell(floor, 'ground', x, y, iFloor);
        }
    }
    setSubLayerCell(floor, 'ground', 2, 1, iWater);

    let pack = normalizeHybridPack({
        id: 'unit_room',
        label: 'Unit Room',
        floors: [floor]
    });
    bakeHybridPack(pack, { roleCatalog: roles, force: true });

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hybrid-map-'));
    try {
        writeHybridMapDir(tmp, pack);
        assert.ok(isHybridMapDir(tmp));
        assert.ok(fs.existsSync(path.join(tmp, 'map.json')));

        // On-disk blobs are gzip-only (*.u8.gz / *.u16.gz)
        const frPath = path.join(tmp, 'floors', '0', 'friction.u8.gz');
        assert.ok(fs.existsSync(frPath), 'friction.u8.gz written');
        assert.ok(!fs.existsSync(path.join(tmp, 'floors', '0', 'friction.u8')), 'no raw .u8');
        const frHead = fs.readFileSync(frPath);
        assert.strictEqual(frHead[0], 0x1f);
        assert.strictEqual(frHead[1], 0x8b);
        assert.strictEqual(frHead.readUInt32LE(4), 0, 'gzip mtime is 0');
        const sample = new Uint8Array([1, 2, 3, 4]);
        assert.deepStrictEqual(
            Buffer.from(gzipBytes(sample)),
            Buffer.from(gzipBytes(sample)),
            'gzipBytes is byte-stable'
        );

        const loaded = readHybridMapDir(tmp);
        assert.strictEqual(loaded.id, 'unit_room');
        assert.ok(loaded.floors['0']);
        assert.strictEqual(loaded.floors['0'].cols, 4);
        assert.strictEqual(loaded.floors['0'].rows, 3);

        // Palette preserved
        assert.strictEqual(loaded.floors['0'].palette[1].roleId, 'floor');
        assert.strictEqual(loaded.floors['0'].palette[2].roleId, 'water');

        // Channels round-trip
        assert.strictEqual(loaded.floors['0'].friction[1 * 4 + 2], FRICTION_BLOCKED);
        assert.strictEqual(loaded.floors['0'].sight[1 * 4 + 2], 0);

        // In-memory serialize/deserialize (gzip blobs)
        const { meta, blobs } = serializeHybridPack(pack);
        assert.ok(meta.version >= 2);
        const frKey = Object.keys(blobs).find((k) => k.endsWith('friction.u8.gz'));
        assert.ok(frKey, 'serialize emits friction.u8.gz');
        assert.strictEqual(blobs[frKey][0], 0x1f);
        assert.strictEqual(blobs[frKey][1], 0x8b);
        const again = deserializeHybridPack(meta, blobs);
        assert.strictEqual(again.floors['0'].friction[0], DEFAULT_OPEN_FRICTION);

        // Load onto TileMap
        const map = new TileMap();
        loadHybridOntoTileMap(map, tmp, { roleCatalog: roles, forceBake: true });
        assert.strictEqual(map.getFriction(0, 0, 0), DEFAULT_OPEN_FRICTION);
        assert.strictEqual(map.getFriction(2, 1, 0), FRICTION_BLOCKED);
        assert.strictEqual(map.getSightBlock(2, 1, 0), 0);

        log('hybrid round-trip ok', tmp);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

function testOverrideMaskOnBake() {
    const roles = roleCatalog();
    const floor = createEmptyTileMapFloor(2, 1, { z: 0 });
    const iFloor = addPaletteEntry(floor, { catalogId: 'f', roleId: 'floor' });
    setSubLayerCell(floor, 'ground', 0, 0, iFloor);
    setSubLayerCell(floor, 'ground', 1, 0, iFloor);
    // Manual friction override on cell 0
    floor.friction = new Uint8Array([40, 100]);
    floor.sight = new Uint8Array([0, 0]);
    floor.flags = new Uint8Array([0, 0]);
    floor.overrideMask[0] = OVERRIDE_FRICTION;

    const baked = bakeTileMapFloor(floor, { roleCatalog: roles, applyOverrides: true });
    assert.strictEqual(baked.friction[0], 40, 'override keeps manual friction');
    assert.strictEqual(baked.friction[1], DEFAULT_OPEN_FRICTION);
    log('override mask ok');
}

async function testPngBootstrapAndExport() {
    const pathPng = mapPathPng('07');
    if (!fs.existsSync(pathPng)) {
        log('skip png bootstrap: no floor-07');
        return;
    }
    const { pack, floor } = await bootstrapFloorFromPathPng(7, pathPng);
    assert.ok(floor.cols > 0 && floor.rows > 0);
    assert.ok(floor.friction instanceof Uint8Array);
    assert.ok(floor.subLayers.length === SUB_LAYER_DEFS.length);
    // Sub-layers empty (no TileMap art yet)
    let anyPaint = false;
    for (let i = 0; i < floor.subLayers[0].cells.length; i++) {
        if (floor.subLayers[0].cells[i]) {
            anyPaint = true;
            break;
        }
    }
    assert.strictEqual(anyPaint, false);

    const resolved = await resolveMapLoad({ pathPng, z: 7 });
    assert.strictEqual(resolved.source, 'png');
    assert.ok(resolved.pack);

    // Export small synthetic
    const f = new Uint8Array([100, 255, 100, 255]);
    const s = new Uint8Array([0, 0, 255, 255]);
    const fl = new Uint8Array([0, 0, 0, TILE_FLAG_NO_CAST]);
    const buf = exportChannelsToPngBuffer(f, 2, 2, { sight: s, flags: fl });
    assert.ok(Buffer.isBuffer(buf) && buf.length > 32);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'png-export-'));
    try {
        const out = path.join(tmp, 'export-path.png');
        exportChannelsToPngFile(out, f, 2, 2, { sight: s, flags: fl });
        assert.ok(fs.existsSync(out));
        // Re-bootstrap from export
        const boot = await bootstrapFloorFromPathPng(0, out);
        assert.strictEqual(boot.floor.cols, 2);
        assert.strictEqual(boot.floor.rows, 2);
        assert.strictEqual(boot.floor.friction[0], 100);
        assert.strictEqual(boot.floor.friction[1], FRICTION_BLOCKED);
        log('png bootstrap + export ok');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

async function testSimulatorHybridLoad() {
    const roles = roleCatalog();
    const floor = createEmptyTileMapFloor(5, 5, { z: 0 });
    const iFloor = addPaletteEntry(floor, {
        catalogId: 'stone',
        roleId: 'floor'
    });
    for (let y = 0; y < 5; y++) {
        for (let x = 0; x < 5; x++) {
            setSubLayerCell(floor, 'ground', x, y, iFloor);
        }
    }
    // wall ring on edges via scenery_blocking
    const iWall = addPaletteEntry(floor, {
        catalogId: 'wall',
        roleId: 'wall'
    });
    for (let i = 0; i < 5; i++) {
        setSubLayerCell(floor, 'ground', i, 0, iWall);
        setSubLayerCell(floor, 'ground', i, 4, iWall);
        setSubLayerCell(floor, 'ground', 0, i, iWall);
        setSubLayerCell(floor, 'ground', 4, i, iWall);
    }
    // restore corners already wall; center walkable
    // Map-editor fields channel (fire at center)
    floor.fields = new Uint8Array(5 * 5);
    floor.fields[2 * 5 + 2] = 1; // fire

    const pack = normalizeHybridPack({
        id: 'sim_room',
        floors: [floor]
    });
    bakeHybridPack(pack, { roleCatalog: roles, force: true });

    const sim = new Simulator({
        hybridMapPack: pack,
        tileRoleCatalog: roles,
        floor: 0,
        seed: 1
    });
    await sim.loadMaps();
    assert.ok(sim.tileMap);
    assert.strictEqual(sim.tileMap.getFriction(2, 2, 0), DEFAULT_OPEN_FRICTION);
    assert.strictEqual(sim.tileMap.getFriction(0, 0, 0), FRICTION_BLOCKED);
    assert.ok(String(sim.mapPath).startsWith('hybrid://'));
    // loadMaps seeds ground fields from hybrid fields channel
    const {
        getFieldOnTile,
        MAP_FIELD_DEFAULT_TTL_SEC
    } = require('../kernel/core/lib/combat/elemental_fields.js');
    const field = getFieldOnTile(sim.groundItems, 2, 2, 0);
    assert.ok(field, 'map fire field must be seeded into ground store');
    assert.strictEqual(field.fieldKind, 'fire');
    assert.strictEqual(field.source, 'scenario');
    assert.strictEqual(field.durationSec, MAP_FIELD_DEFAULT_TTL_SEC);
    log('simulator hybrid load ok');

    // Path-PNG bootstrap style: stored channels, empty sub-layers. Simulator
    // must not forceBake (that would re-bake empty stacks → all blocked).
    const bootFloor = createEmptyTileMapFloor(4, 4, { z: 6 });
    const nBoot = 4 * 4;
    bootFloor.friction = new Uint8Array(nBoot);
    bootFloor.sight = new Uint8Array(nBoot);
    bootFloor.flags = new Uint8Array(nBoot);
    bootFloor.fields = new Uint8Array(nBoot);
    for (let i = 0; i < nBoot; i++) {
        bootFloor.friction[i] = DEFAULT_OPEN_FRICTION;
        bootFloor.sight[i] = 0;
        bootFloor.flags[i] = 0;
    }
    // One wall corner remains blocked in the stored channel only
    bootFloor.friction[0] = FRICTION_BLOCKED;
    bootFloor.sight[0] = SIGHT_BLOCKED;
    bootFloor.fields[1 * 4 + 1] = 1; // fire at (1,1)
    const bootPack = normalizeHybridPack({
        id: 'bootstrap_channels',
        floors: [bootFloor]
    });
    const simBoot = new Simulator({
        hybridMapPack: bootPack,
        floor: 6,
        floors: [6],
        seed: 1
    });
    await simBoot.loadMaps();
    assert.strictEqual(
        simBoot.tileMap.getFriction(1, 1, 6),
        DEFAULT_OPEN_FRICTION,
        'bootstrap hybrid keeps stored walkable friction'
    );
    assert.strictEqual(
        simBoot.tileMap.getFriction(0, 0, 6),
        FRICTION_BLOCKED,
        'bootstrap hybrid keeps stored blocked friction'
    );
    const bootField = getFieldOnTile(simBoot.groundItems, 1, 1, 6);
    assert.ok(bootField, 'bootstrap hybrid still seeds map fields');
    assert.strictEqual(bootField.fieldKind, 'fire');
    log('simulator hybrid bootstrap channels ok');
}

function buildPhase4RoomPack(roles) {
    const floor = createEmptyTileMapFloor(8, 8, { z: 0 });
    const iFloor = addPaletteEntry(floor, {
        catalogId: 'damp_moss_floor',
        roleId: 'floor'
    });
    const iWater = addPaletteEntry(floor, {
        catalogId: 'damp_deep_water',
        roleId: 'water'
    });
    const iTree = addPaletteEntry(floor, {
        catalogId: 'simple_dead_tree',
        roleId: 'scenery_blocking',
        kind: 'objects',
        scale: 1.4,
        anchor: 'bottom_center'
    });
    const iStairs = addPaletteEntry(floor, {
        catalogId: 'broken_cave_stairs',
        roleId: 'stairs_up',
        hop: { dir: 'north', deltaZ: -1 }
    });
    const iPz = addPaletteEntry(floor, {
        catalogId: 'polished_stone_floor',
        roleId: 'protection'
    });

    for (let y = 1; y < 7; y++) {
        for (let x = 1; x < 7; x++) {
            setSubLayerCell(floor, 'ground', x, y, iFloor);
        }
    }
    setSubLayerCell(floor, 'ground', 3, 3, iWater);
    setSubLayerCell(floor, 'ground', 4, 3, iWater);
    setSubLayerCell(floor, 'scenery', 2, 4, iTree);
    setSubLayerCell(floor, 'vertical', 5, 5, iStairs);
    setSubLayerCell(floor, 'ground', 1, 1, iPz);

    const pack = normalizeHybridPack({
        id: 'phase4_room',
        label: 'Phase 4 hand-authored room',
        floors: [floor]
    });
    bakeHybridPack(pack, { roleCatalog: roles, force: true });
    return pack;
}

function writePhase4RoomDir(dir, pack) {
    fs.mkdirSync(dir, { recursive: true });
    const floorsDir = path.join(dir, 'floors');
    if (fs.existsSync(floorsDir)) {
        fs.rmSync(floorsDir, { recursive: true, force: true });
    }
    writeHybridMapDir(dir, pack);
}

function assertPhase4RoomOnTileMap(map) {
    assert.strictEqual(map.getFriction(2, 2, 0), DEFAULT_OPEN_FRICTION);
    assert.strictEqual(map.getFriction(3, 3, 0), FRICTION_BLOCKED);
    assert.strictEqual(map.getSightBlock(3, 3, 0), 0);
    assert.strictEqual(map.getFriction(2, 4, 0), FRICTION_BLOCKED);
    assert.strictEqual(map.getSightBlock(2, 4, 0), SIGHT_BLOCKED);
    assert.strictEqual(map.getTileFlags(1, 1, 0), TILE_FLAG_PZ_PACKAGE);
    assert.ok(map.getStair(5, 5, 0), 'fixture stairs registered');
}

/**
 * Default: write pack to tmp + load committed golden.
 * Refresh committed blobs only with UPDATE_FIXTURE=1.
 */
function testPhase4RoomFixture() {
    const roles = roleCatalog();
    const pack = buildPhase4RoomPack(roles);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hybrid-phase4-'));
    try {
        writePhase4RoomDir(tmp, pack);
        const mapTmp = new TileMap();
        mapTmp.loadFloorFromFriction(-1, 8, 8, new Uint8Array(64).fill(100));
        loadHybridOntoTileMap(mapTmp, tmp, {
            roleCatalog: roles,
            forceBake: true
        });
        assertPhase4RoomOnTileMap(mapTmp);
        log('phase4 fixture tmp ok', tmp);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }

    assert.ok(isHybridMapDir(FIXTURE_DIR), 'committed hybrid fixture present');
    const map = new TileMap();
    map.loadFloorFromFriction(-1, 8, 8, new Uint8Array(64).fill(100));
    loadHybridOntoTileMap(map, FIXTURE_DIR, {
        roleCatalog: roles,
        forceBake: true
    });
    assertPhase4RoomOnTileMap(map);
    log('committed fixture load ok', FIXTURE_DIR);

    if (process.env.UPDATE_FIXTURE) {
        writePhase4RoomDir(FIXTURE_DIR, pack);
        log('committed fixture refreshed', FIXTURE_DIR);
    }
}

function testEditorStairsLoadWithoutRebake() {
    const roles = roleCatalog();
    const cols = 6;
    const rows = 6;
    const n = cols * rows;
    const floor = createEmptyTileMapFloor(cols, rows, { z: 6 });
    floor.friction = new Uint8Array(n).fill(DEFAULT_OPEN_FRICTION);
    floor.sight = new Uint8Array(n);
    floor.flags = new Uint8Array(n);
    floor.flags[4 * cols + 3] = TILE_FLAG_STAIR;
    floor.stairs = [
        {
            x: 3,
            y: 4,
            z: 6,
            dir: 'center',
            type: 'stairs',
            deltaZ: 1,
            to: null
        }
    ];
    const pack = normalizeHybridPack({
        id: 'editor_stairs',
        floors: [floor]
    });
    assert.deepStrictEqual(collectHybridStairDestFloors(pack), [7]);
    const resolved = resolveEditorStairLink(floor.stairs[0]);
    assert.ok(resolved);
    assert.strictEqual(resolved.to.x, 3);
    assert.strictEqual(resolved.to.y, 4);
    assert.strictEqual(resolved.to.z, 7);

    const map = new TileMap();
    map.loadFloorFromFriction(
        7,
        cols,
        rows,
        new Uint8Array(n).fill(DEFAULT_OPEN_FRICTION)
    );
    loadHybridOntoTileMap(map, pack, { roleCatalog: roles });
    assert.ok(
        map.isStair(3, 4, 6),
        'editor stair row must register without channel rebake'
    );
    const st = map.getStair(3, 4, 6);
    assert.ok(st);
    assert.strictEqual(st.x, 3);
    assert.strictEqual(st.y, 4);
    assert.strictEqual(String(st.z), '7');
    assert.strictEqual(resolved.bidirectional, false, 'editor row is one-way');
    assert.ok(
        !map.isStair(3, 4, 7),
        'dest tile has no invented reverse stair'
    );

    const e = { id: 1, tile: { x: 3, y: 4, z: 6 } };
    map.tryOccupy(3, 4, 6, e);
    assert.ok(map.tryUseStair(e, null), 'hop down to dest floor');
    assert.strictEqual(e.tile.z, 7);
    // Leave dest and step back onto it — must stay on dest floor.
    map.moveEntityToTile(e, 3, 5, 7);
    map.moveEntityToTile(e, 3, 4, 7);
    assert.strictEqual(e.tile.z, 7, 're-entering dest tile does not reverse-hop');
    assert.ok(!map.tryUseStair(e, null), 'no reverse pad after authored down stair');
    log('editor stairs load without rebake ok');
}

async function testSimulatorLoadsStairDestFloor() {
    const roles = roleCatalog();
    const cols = 6;
    const rows = 6;
    const n = cols * rows;
    const floor = createEmptyTileMapFloor(cols, rows, { z: 6 });
    floor.friction = new Uint8Array(n).fill(DEFAULT_OPEN_FRICTION);
    floor.sight = new Uint8Array(n);
    floor.flags = new Uint8Array(n);
    floor.flags[2 * cols + 2] = TILE_FLAG_STAIR;
    floor.stairs = [
        {
            x: 2,
            y: 2,
            z: 6,
            dir: 'center',
            type: 'stairs',
            deltaZ: 1,
            // Isolated dest z — do not collide with on-disk legacy floor-07.
            to: { x: 2, y: 2, z: 11 }
        }
    ];
    const pack = normalizeHybridPack({
        id: 'sim_stairs',
        floors: [floor]
    });
    const destFriction = new Uint8Array(n).fill(DEFAULT_OPEN_FRICTION);
    const sim = new Simulator({
        hybridMapPack: pack,
        tileRoleCatalog: roles,
        floor: 6,
        floors: [6],
        floorLayers: {
            11: { cols, rows, friction: destFriction }
        },
        seed: 1
    });
    await sim.loadMaps();
    assert.ok(sim.tileMap.isStair(2, 2, 6), 'sim registers editor stair');
    assert.ok(
        !sim.tileMap.isStair(2, 2, 11),
        'sim does not invent dest reverse stair'
    );
    assert.ok(sim.tileMap.getLayer(11), 'sim loads dest floor 11');
    assert.ok(sim.floors.some((f) => String(f) === '11'));
    const e = { id: 9, tile: { x: 2, y: 2, z: 6 } };
    sim.tileMap.tryOccupy(2, 2, 6, e);
    assert.ok(sim.tileMap.tryUseStair(e, null));
    assert.strictEqual(e.tile.z, 11);
    log('simulator dest floor from stair ok');
}

function testEditorStairExplicitBidirectional() {
    const roles = roleCatalog();
    const cols = 4;
    const rows = 4;
    const n = cols * rows;
    const floor = createEmptyTileMapFloor(cols, rows, { z: 6 });
    floor.friction = new Uint8Array(n).fill(DEFAULT_OPEN_FRICTION);
    floor.sight = new Uint8Array(n);
    floor.flags = new Uint8Array(n);
    floor.stairs = [
        {
            x: 1,
            y: 1,
            z: 6,
            dir: 'center',
            type: 'stairs',
            deltaZ: 1,
            bidirectional: true,
            to: null
        }
    ];
    const pack = normalizeHybridPack({
        id: 'editor_stairs_bi',
        floors: [floor]
    });
    const map = new TileMap();
    map.loadFloorFromFriction(
        7,
        cols,
        rows,
        new Uint8Array(n).fill(DEFAULT_OPEN_FRICTION)
    );
    loadHybridOntoTileMap(map, pack, { roleCatalog: roles });
    assert.ok(map.isStair(1, 1, 6), 'forward pad');
    assert.ok(map.isStair(1, 1, 7), 'explicit bidirectional dest pad');
    log('editor stair explicit bidirectional ok');
}

function testEditorStairCustomDest() {
    const center = resolveEditorStairLink({
        x: 4,
        y: 4,
        z: 7,
        dir: 'center',
        type: 'stairs',
        deltaZ: -1,
        to: null
    });
    assert.ok(center);
    assert.strictEqual(center.to.x, 4);
    assert.strictEqual(center.to.y, 4);
    assert.strictEqual(center.to.z, 6);

    const custom = resolveEditorStairLink({
        x: 4,
        y: 4,
        z: 7,
        dir: 'custom',
        type: 'stairs',
        deltaZ: 0,
        to: { x: 20, y: 8, z: 11 }
    });
    assert.ok(custom);
    assert.strictEqual(custom.dir, 'custom');
    assert.strictEqual(custom.to.x, 20);
    assert.strictEqual(custom.to.y, 8);
    assert.strictEqual(custom.to.z, 11);
    assert.strictEqual(custom.exitDx, 0);
    assert.strictEqual(custom.exitDy, 0);
    assert.strictEqual(custom.bidirectional, false);

    const missing = resolveEditorStairLink({
        x: 4,
        y: 4,
        z: 7,
        dir: 'custom',
        type: 'stairs',
        to: null
    });
    assert.strictEqual(missing, null, 'custom without to is not a hop');

    const sameTile = resolveEditorStairLink({
        x: 4,
        y: 4,
        z: 7,
        dir: 'custom',
        to: { x: 4, y: 4, z: 7 }
    });
    assert.strictEqual(sameTile, null);

    const sameFloor = resolveEditorStairLink({
        x: 4,
        y: 4,
        z: 7,
        dir: 'custom',
        to: { x: 1, y: 1, z: 7 }
    });
    assert.ok(sameFloor);
    assert.strictEqual(sameFloor.to.x, 1);
    assert.strictEqual(sameFloor.to.z, 7);

    assert.strictEqual(
        isExplicitEditorStairDest({
            x: 4,
            y: 4,
            z: 7,
            dir: 'north',
            deltaZ: -1,
            to: { x: 4, y: 3, z: 6 }
        }),
        false,
        'derived north dest is not locked'
    );
    assert.ok(
        isExplicitEditorStairDest({
            x: 4,
            y: 4,
            z: 7,
            dir: 'center',
            deltaZ: -1,
            to: { x: 20, y: 8, z: 11 }
        }),
        'non-offset to is treated as explicit'
    );
    assert.ok(
        isExplicitEditorStairDest({
            x: 4,
            y: 4,
            z: 7,
            dir: 'custom',
            to: { x: 20, y: 8, z: 11 }
        })
    );

    const roles = roleCatalog();
    const cols = 6;
    const rows = 6;
    const n = cols * rows;
    const floor = createEmptyTileMapFloor(cols, rows, { z: 7 });
    floor.friction = new Uint8Array(n).fill(DEFAULT_OPEN_FRICTION);
    floor.sight = new Uint8Array(n);
    floor.flags = new Uint8Array(n);
    floor.flags[4 * cols + 3] = TILE_FLAG_STAIR;
    floor.stairs = [
        {
            x: 3,
            y: 4,
            z: 7,
            dir: 'custom',
            type: 'stairs',
            deltaZ: 4,
            to: { x: 1, y: 2, z: 11 }
        }
    ];
    const pack = normalizeHybridPack({
        id: 'editor_custom',
        floors: [floor]
    });
    assert.deepStrictEqual(collectHybridStairDestFloors(pack), [11]);
    const map = new TileMap();
    map.loadFloorFromFriction(
        11,
        cols,
        rows,
        new Uint8Array(n).fill(DEFAULT_OPEN_FRICTION)
    );
    loadHybridOntoTileMap(map, pack, { roleCatalog: roles });
    const st = map.getStair(3, 4, 7);
    assert.ok(st);
    assert.strictEqual(st.x, 1);
    assert.strictEqual(st.y, 2);
    assert.strictEqual(String(st.z), '11');
    assert.ok(!map.isStair(1, 2, 11), 'custom dest is one-way');
    log('editor stair custom dest ok');
}

function testMergedPackKeepsSpawns() {
    const cols = 4;
    const rows = 4;
    const n = cols * rows;
    const floor = createEmptyTileMapFloor(cols, rows, { z: 6 });
    floor.friction = new Uint8Array(n).fill(DEFAULT_OPEN_FRICTION);
    floor.sight = new Uint8Array(n);
    floor.flags = new Uint8Array(n);
    const pins = [
        { creatureId: 'frost_imp', x: 1, y: 2, z: 6, respawn: 60 }
    ];
    const pack = normalizeHybridPack({
        id: 'floor_06',
        floors: [floor],
        spawns: pins
    });
    const mapsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hybrid-spawns-'));
    try {
        writeHybridMapDir(path.join(mapsRoot, 'hybrid', 'floor-06'), pack);
        const merged = tryResolveHybridMapPack([6], { mapsRoot });
        assert.ok(merged);
        assert.ok(merged.floors['6']);
        assert.ok(Array.isArray(merged.spawns));
        assert.strictEqual(merged.spawns.length, 1);
        assert.strictEqual(merged.spawns[0].creatureId, 'frost_imp');
        log('merged hybrid pack keeps spawns');
    } finally {
        fs.rmSync(mapsRoot, { recursive: true, force: true });
    }
}

function testSubLayerOrder() {
    assert.deepStrictEqual(SUB_LAYER_IDS, [
        'ground',
        'path',
        'scenery',
        'furniture',
        'vertical'
    ]);
    assert.strictEqual(SUB_LAYER_DEFS[0].zOrder, 0);
    assert.strictEqual(SUB_LAYER_DEFS[4].zOrder, 4);
    log('sub-layer order ok');
}

function testPlacementInfluenceBeatsRole() {
    const roles = roleCatalog();
    const floor = createEmptyTileMapFloor(4, 4, { z: 0 });
    const iSlick = addPaletteEntry(floor, {
        catalogId: 'ice_slick',
        roleId: 'floor',
        influence: { friction: 20 },
        scale: 1.25,
        variant: 'small'
    });
    setSubLayerCell(floor, 'ground', 1, 1, iSlick);
    const baked = bakeTileMapFloor(floor, { roleCatalog: roles });
    const i = 1 * 4 + 1;
    assert.strictEqual(baked.friction[i], 20, 'placement friction beats floor role');
    const pe = floor.palette[iSlick];
    assert.strictEqual(pe.scale, 1.25);
    assert.strictEqual(pe.variant, 'small');
    assert.ok(pe.influence);
    assert.strictEqual(pe.influence.friction, 20);
    log('placement influence beats role');
}

async function main() {
    testSubLayerOrder();
    testMergedPackKeepsSpawns();
    testGoldenStacks();
    testPlacementInfluenceBeatsRole();
    testDiffOverrides();
    testApplyToTileMapAndStairs();
    testHybridRoundTrip();
    testOverrideMaskOnBake();
    testEditorStairsLoadWithoutRebake();
    testEditorStairExplicitBidirectional();
    testEditorStairCustomDest();
    await testPngBootstrapAndExport();
    await testSimulatorHybridLoad();
    await testSimulatorLoadsStairDestFloor();
    testPhase4RoomFixture();
    console.log('tilemap_bake: ok');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
