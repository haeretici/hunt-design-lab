#!/usr/bin/env node
/**
 * Phase 5 — TileMap editor session: paint → bake → undo → hybrid transport.
 * Quiet on success; VERBOSE=1 for detail.
 */

'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { setActiveMode } = require('../kernel/core/lib/modes.js');
const {
    loadTileRole,
    listTileRoleIds,
    loadArtSet,
    clearPresetCache
} = require('../kernel/core/lib/presets.js');
const {
    indexTileRoles,
    FRICTION_BLOCKED,
    SIGHT_BLOCKED,
    DEFAULT_OPEN_FRICTION,
    TILE_FLAG_PZ_PACKAGE,
    TILE_FLAG_STAIR
} = require('../kernel/core/lib/dungeon/tile_roles.js');
const {
    createEditorSession,
    buildStampsFromArtSet,
    MAP_FIELD_DEFAULT_TTL_SEC,
    UI_SUB_LAYER_ORDER,
    flagPaletteEntries,
    SUB_LAYER_IDS
} = require('../kernel/core/lib/dungeon/tilemap_editor.js');
const {
    writeHybridMapDir,
    readHybridMapDir,
    isHybridMapDir
} = require('../kernel/core/lib/dungeon/tilemap_bake.js');

const VERBOSE = !!process.env.VERBOSE;

function log(...args) {
    if (VERBOSE) console.log(...args);
}

function roleCatalog() {
    setActiveMode('standard');
    clearPresetCache();
    return indexTileRoles(listTileRoleIds().map((id) => loadTileRole(id)));
}

function testUiOrderAndFlags() {
    assert.deepStrictEqual(UI_SUB_LAYER_ORDER, [
        'vertical',
        'furniture',
        'scenery',
        'path',
        'ground'
    ]);
    assert.ok(MAP_FIELD_DEFAULT_TTL_SEC >= 7 * 24 * 3600);
    const flags = flagPaletteEntries();
    const pz = flags.find((f) => f.id === 'pz');
    assert.ok(pz && pz.package);
    assert.strictEqual(pz.bits, TILE_FLAG_PZ_PACKAGE);
    assert.strictEqual(pz.icon, 'fa-shield-halved');
    for (const f of flags) {
        if (f.id === 'none') {
            assert.ok(!f.icon, 'none has no icon');
            continue;
        }
        assert.ok(f.icon && String(f.icon).indexOf('fa-') === 0, f.id + ' has FA icon');
    }
    log('ui order + flags package ok');
}

function testArtSetStamps() {
    const roles = roleCatalog();
    const art = loadArtSet('cave_simple');
    const stamps = buildStampsFromArtSet(art, roles);
    assert.ok(stamps.length >= 4, 'cave_simple should yield stamps');
    const floor = stamps.find((s) => s.roleId === 'floor' || s.artRole === 'floor');
    const waterTile = stamps.find(
        (s) => (s.roleId === 'water' || s.artRole === 'water') && s.kind !== 'overlays'
    );
    const waterOverlay = stamps.find((s) => s.wangFamily === 'water');
    const dirt = stamps.find((s) => s.wangFamily === 'dirt');
    const wallFace = stamps.find((s) => s.wallFamily === 'stone_wall');
    const tree = stamps.find((s) => s.roleId === 'scenery_blocking' || s.artRole === 'scenery');
    const stairs = stamps.find((s) => s.roleId === 'stairs_up' || s.artRole === 'stairs_up');
    assert.ok(floor && floor.subLayer === 'ground');
    assert.ok(waterTile && waterTile.subLayer === 'ground');
    assert.ok(waterOverlay && waterOverlay.subLayer === 'path');
    assert.strictEqual(waterOverlay.catalogId, 'water_wang_15');
    assert.ok(dirt && dirt.subLayer === 'path');
    assert.strictEqual(dirt.catalogId, 'dirt_wang_15');
    assert.ok(wallFace && wallFace.subLayer === 'vertical' && !wallFace.hop);
    assert.strictEqual(wallFace.catalogId, 'stone_wall_pole');
    assert.ok(tree && tree.subLayer === 'scenery');
    assert.ok(stairs && stairs.subLayer === 'vertical' && stairs.hop);
    log('art set stamps', stamps.length);
}

function testPaintBakeRoom() {
    const roles = roleCatalog();
    const session = createEditorSession({
        cols: 32,
        rows: 32,
        z: 0,
        roleCatalog: roles
    });
    assert.strictEqual(session.cols, 32);
    assert.ok(SUB_LAYER_IDS.includes(session.activeSubLayer));

    const grass = {
        catalogId: 'test_grass',
        roleId: 'floor',
        kind: 'tiles',
        subLayer: 'ground'
    };
    const water = {
        catalogId: 'test_water',
        roleId: 'water',
        kind: 'tiles',
        subLayer: 'ground'
    };
    const tree = {
        catalogId: 'test_tree',
        roleId: 'scenery_blocking',
        kind: 'objects',
        subLayer: 'scenery'
    };
    const stairs = {
        catalogId: 'test_stairs',
        roleId: 'stairs_up',
        kind: 'tiles',
        subLayer: 'vertical',
        hop: { dir: 'north', deltaZ: -1 }
    };
    const pz = {
        catalogId: 'test_pz',
        roleId: 'protection',
        kind: 'tiles',
        subLayer: 'ground'
    };

    // Fill grass
    session.selectStamp(grass);
    session.setActiveSubLayer('ground');
    session.beginStroke();
    for (let y = 0; y < 32; y++) {
        for (let x = 0; x < 32; x++) {
            session.paintAt(x, y, { stamp: grass, subLayer: 'ground' });
        }
    }
    session.endStroke();

    const i = (x, y) => y * 32 + x;
    assert.strictEqual(session.floor.friction[i(5, 5)], DEFAULT_OPEN_FRICTION);

    // Water strip
    session.selectStamp(water);
    session.beginStroke();
    for (let x = 0; x < 8; x++) session.paintAt(x, 10, { stamp: water });
    session.endStroke();
    assert.strictEqual(session.floor.friction[i(3, 10)], FRICTION_BLOCKED);
    assert.strictEqual(session.floor.sight[i(3, 10)], 0); // water LoS clear

    // Tree on grass
    session.selectStamp(tree);
    session.setActiveSubLayer('scenery');
    session.beginStroke();
    session.paintAt(15, 15, { stamp: tree, subLayer: 'scenery' });
    session.endStroke();
    assert.strictEqual(session.floor.friction[i(15, 15)], FRICTION_BLOCKED);
    assert.strictEqual(session.floor.sight[i(15, 15)], SIGHT_BLOCKED);

    // Remove tree → grass again
    session.beginStroke();
    session.paintAt(15, 15, { erase: true, subLayer: 'scenery' });
    session.endStroke();
    assert.strictEqual(session.floor.friction[i(15, 15)], DEFAULT_OPEN_FRICTION);

    // Stairs
    session.selectStamp(stairs);
    session.setActiveSubLayer('vertical');
    session.beginStroke();
    session.paintAt(20, 20, { stamp: stairs, subLayer: 'vertical' });
    session.endStroke();
    assert.ok((session.floor.flags[i(20, 20)] & TILE_FLAG_STAIR) !== 0);
    assert.ok(session.floor.stairs.some((s) => s.x === 20 && s.y === 20 && s.deltaZ === -1));
    const stairRow = session.floor.stairs.find((s) => s.x === 20 && s.y === 20);
    assert.ok(stairRow && stairRow.to, 'editor stair persists computed dest');
    assert.strictEqual(stairRow.to.x, 20);
    assert.strictEqual(stairRow.to.y, 19);
    assert.strictEqual(String(stairRow.to.z), '-1');

    // PZ package via role
    session.selectStamp(pz);
    session.setActiveSubLayer('ground');
    session.beginStroke();
    session.paintAt(8, 8, { stamp: pz, subLayer: 'ground' });
    session.endStroke();
    assert.strictEqual(session.floor.flags[i(8, 8)] & TILE_FLAG_PZ_PACKAGE, TILE_FLAG_PZ_PACKAGE);

    // Flags package paint (override)
    const r = session.paintChannel('flags', 9, 9, 1, {
        packageBits: TILE_FLAG_PZ_PACKAGE
    });
    assert.ok(r.rect);
    assert.strictEqual(session.floor.flags[i(9, 9)] & TILE_FLAG_PZ_PACKAGE, TILE_FLAG_PZ_PACKAGE);
    assert.ok((session.floor.overrideMask[i(9, 9)] & 4) !== 0); // OVERRIDE_FLAGS

    // Fields independent + long TTL constant
    session.paintChannel('fields', 1, 1, 1); // fire bit-ish color value
    assert.strictEqual(session.floor.fields[i(1, 1)], 1);
    session.bakeAll();
    assert.strictEqual(session.floor.fields[i(1, 1)], 1, 'bake must not clear fields');

    log('paint bake room ok');
}

/**
 * Diagonal stroke must bake only dirty cells — not the bounding-box interior.
 * (Regression: AABB bake rewrote flags/friction on unpainted tiles in the square.)
 */
function testDiagonalBakeDoesNotFillAabb() {
    const roles = roleCatalog();
    const session = createEditorSession({
        cols: 16,
        rows: 16,
        z: 0,
        roleCatalog: roles
    });
    const grass = {
        catalogId: 'diag_grass',
        roleId: 'floor',
        kind: 'tiles',
        subLayer: 'ground'
    };
    const pz = {
        catalogId: 'diag_pz',
        roleId: 'protection',
        kind: 'tiles',
        subLayer: 'ground'
    };
    const i = (x, y) => y * 16 + x;

    // Fill open floor
    session.beginStroke();
    for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
            session.paintAt(x, y, { stamp: grass, subLayer: 'ground' });
        }
    }
    session.endStroke();
    const grassFlags = session.floor.flags[i(3, 1)] | 0;
    assert.strictEqual(session.floor.flags[i(3, 1)] & TILE_FLAG_PZ_PACKAGE, 0);

    // Diagonal PZ: (0,0) … (5,5)
    session.beginStroke();
    for (let t = 0; t <= 5; t++) {
        session.paintAt(t, t, { stamp: pz, subLayer: 'ground' });
    }
    session.endStroke();

    // Diagonal cells get PZ package
    for (let t = 0; t <= 5; t++) {
        assert.strictEqual(
            session.floor.flags[i(t, t)] & TILE_FLAG_PZ_PACKAGE,
            TILE_FLAG_PZ_PACKAGE,
            `diag cell (${t},${t}) should have PZ`
        );
    }
    // Interior of the AABB (e.g. 3,1) must keep grass — not rewritten by bake
    assert.strictEqual(
        session.floor.flags[i(3, 1)] & TILE_FLAG_PZ_PACKAGE,
        0,
        'AABB interior must not receive diagonal stamp flags'
    );
    assert.strictEqual(
        session.floor.flags[i(3, 1)] | 0,
        grassFlags,
        'AABB interior flags must be unchanged'
    );
    assert.strictEqual(
        session.floor.friction[i(3, 1)],
        DEFAULT_OPEN_FRICTION,
        'AABB interior friction must stay open floor'
    );

    log('diagonal bake sparse ok');
}

/**
 * Sparse paint over empty sub-layers must not void the AABB via full-rect bake.
 */
function testDiagonalPaintDoesNotVoidBootstrapChannels() {
    const roles = roleCatalog();
    const session = createEditorSession({
        cols: 8,
        rows: 8,
        z: 0,
        roleCatalog: roles
    });
    const n = 64;
    const friction = new Uint8Array(n);
    const sight = new Uint8Array(n);
    const flags = new Uint8Array(n);
    friction.fill(DEFAULT_OPEN_FRICTION);
    // Bootstrap open channels with empty authoring stack
    session.bootstrapFromChannels({
        cols: 8,
        rows: 8,
        friction,
        sight,
        flags
    });
    const grass = {
        catalogId: 'boot_grass',
        roleId: 'floor',
        kind: 'tiles',
        subLayer: 'ground'
    };
    const i = (x, y) => y * 8 + x;

    session.beginStroke();
    for (let t = 0; t <= 4; t++) {
        session.paintAt(t, t, { stamp: grass, subLayer: 'ground' });
    }
    session.endStroke();

    // Cell inside AABB but not on diagonal must keep bootstrap open friction
    assert.strictEqual(
        session.floor.friction[i(3, 1)],
        DEFAULT_OPEN_FRICTION,
        'unpainted bootstrap cell must not become void from AABB bake'
    );
    assert.notStrictEqual(
        session.floor.friction[i(2, 2)],
        FRICTION_BLOCKED,
        'painted grass should not be blocked'
    );

    log('diagonal bootstrap sparse ok');
}

function testUndoRedo() {
    const roles = roleCatalog();
    const session = createEditorSession({ cols: 8, rows: 8, z: 0, roleCatalog: roles });
    const grass = { catalogId: 'g', roleId: 'floor', subLayer: 'ground' };
    session.beginStroke();
    session.paintAt(2, 2, { stamp: grass });
    session.endStroke();
    assert.strictEqual(session.floor.friction[2 * 8 + 2], DEFAULT_OPEN_FRICTION);
    assert.ok(session.canUndo);
    session.undo();
    // empty cell → void-ish blocked or default empty bake
    const f = session.floor.friction[2 * 8 + 2];
    assert.ok(f === FRICTION_BLOCKED || f === 0 || f === 255);
    session.redo();
    assert.strictEqual(session.floor.friction[2 * 8 + 2], DEFAULT_OPEN_FRICTION);
    log('undo redo ok');
}

function testHybridTransportAndDisk() {
    const roles = roleCatalog();
    const session = createEditorSession({ cols: 16, rows: 16, z: 7, roleCatalog: roles });
    const grass = { catalogId: 'g', roleId: 'floor', subLayer: 'ground' };
    const tree = {
        catalogId: 't',
        roleId: 'scenery_blocking',
        kind: 'objects',
        subLayer: 'scenery'
    };
    session.beginStroke();
    for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) session.paintAt(x, y, { stamp: grass });
    }
    session.endStroke();
    session.beginStroke();
    session.paintAt(4, 4, { stamp: tree, subLayer: 'scenery' });
    session.endStroke();

    const transport = session.toHybridTransport({ id: 'phase5_room' });
    assert.ok(transport.meta && transport.meta.floors);
    assert.ok(Object.keys(transport.blobsBase64).length > 0);

    const session2 = createEditorSession({ cols: 1, rows: 1, z: 0, roleCatalog: roles });
    session2.loadHybridTransport(transport.meta, transport.blobsBase64);
    assert.strictEqual(session2.cols, 16);
    assert.strictEqual(session2.floor.friction[4 * 16 + 4], FRICTION_BLOCKED);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hdl-phase5-'));
    try {
        const pack = session.toHybridPack({ id: 'phase5_room' });
        writeHybridMapDir(dir, pack);
        assert.ok(isHybridMapDir(dir));
        const loaded = readHybridMapDir(dir);
        assert.ok(loaded.floors['7'] || loaded.floors[7]);
        log('hybrid transport + disk ok', dir);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

/**
 * Regression: Save Map used to call bakeAll() inside toHybridPack, which
 * rewrote PNG-bootstrap open corridors to FRICTION_BLOCKED and dropped fields.
 * Hybrid serialize must keep channel data + map-seeded fields without stamps.
 */
function testHybridSavePreservesBootstrapAndFields() {
    const roles = roleCatalog();
    const cols = 8;
    const rows = 8;
    const n = cols * rows;
    const session = createEditorSession({ cols, rows, z: 6, roleCatalog: roles });
    const friction = new Uint8Array(n);
    friction.fill(FRICTION_BLOCKED);
    for (let y = 2; y < 6; y++) {
        for (let x = 2; x < 6; x++) {
            friction[y * cols + x] = DEFAULT_OPEN_FRICTION;
        }
    }
    session.bootstrapFromChannels({ cols, rows, friction, z: 6 });

    session.paintChannel('fields', 3, 3, 1); // fire
    session.paintChannel('fields', 4, 4, 2); // poison
    assert.strictEqual(session.floor.fields[3 * cols + 3], 1);
    assert.strictEqual(session.floor.fields[4 * cols + 4], 2);
    assert.strictEqual(session.floor.friction[3 * cols + 3], DEFAULT_OPEN_FRICTION);

    const transport = session.toHybridBinaryTransport({ id: 'boot_fields_06' });
    assert.ok(transport.meta && transport.meta.floors && transport.meta.floors[0]);
    const ch = transport.meta.floors[0].channels || {};
    assert.ok(ch.fields, 'non-zero fields must be serialized into hybrid channels');

    const session2 = createEditorSession({ cols: 1, rows: 1, z: 0, roleCatalog: roles });
    session2.loadHybridTransport(transport.meta, transport.blobs);

    assert.strictEqual(session2.cols, cols);
    assert.strictEqual(
        session2.floor.friction[3 * cols + 3],
        DEFAULT_OPEN_FRICTION,
        'bootstrap open friction must survive hybrid save (no full void bake)'
    );
    assert.strictEqual(
        session2.floor.friction[0],
        FRICTION_BLOCKED,
        'blocked cells must stay blocked'
    );
    assert.strictEqual(session2.floor.fields[3 * cols + 3], 1, 'fire field preserved');
    assert.strictEqual(session2.floor.fields[4 * cols + 4], 2, 'poison field preserved');

    let open = 0;
    for (let i = 0; i < n; i++) {
        if (session2.floor.friction[i] === DEFAULT_OPEN_FRICTION) open++;
    }
    assert.strictEqual(open, 16, 'open 4×4 corridor must not be wiped to void');

    log('hybrid bootstrap+fields ok');
}

function testBucketFill() {
    const roles = roleCatalog();
    // Default empty floor is all 0 — empty seed flood stays one walk class.
    const session = createEditorSession({ cols: 10, rows: 10, z: 0, roleCatalog: roles });
    const grass = { catalogId: 'g', roleId: 'floor', subLayer: 'ground' };
    const water = { catalogId: 'w', roleId: 'water', subLayer: 'ground' };
    session.bucketFill(0, 0, { stamp: grass });
    assert.strictEqual(session.floor.friction[0], DEFAULT_OPEN_FRICTION);
    assert.strictEqual(session.floor.friction[9 * 10 + 9], DEFAULT_OPEN_FRICTION);
    session.bucketFill(5, 5, { stamp: water });
    assert.strictEqual(session.floor.friction[5 * 10 + 5], FRICTION_BLOCKED);
    log('bucket ok');
}

/**
 * Empty (palette 0) bucket uses friction walk class so PNG-bootstrap corridors
 * do not flood the whole map; already-stamped regions match palette only.
 */
function testBucketFillFrictionMask() {
    const roles = roleCatalog();
    const cols = 8;
    const rows = 6;
    const session = createEditorSession({ cols, rows, z: 0, roleCatalog: roles });
    const n = cols * rows;
    // Solid blocked frame + open interior (like path-PNG rooms).
    for (let i = 0; i < n; i++) session.floor.friction[i] = FRICTION_BLOCKED;
    for (let y = 1; y < rows - 1; y++) {
        for (let x = 1; x < cols - 1; x++) {
            session.floor.friction[y * cols + x] = DEFAULT_OPEN_FRICTION;
        }
    }
    // Second open pocket, disconnected by blocked column at x=4.
    for (let y = 1; y < rows - 1; y++) {
        session.floor.friction[y * cols + 4] = FRICTION_BLOCKED;
    }
    // left pocket: x=1..3, right pocket: x=5..6

    const grass = { catalogId: 'g', roleId: 'floor', subLayer: 'ground' };
    const wall = { catalogId: 'wall', roleId: 'wall', subLayer: 'ground' };

    session.bucketFill(2, 2, { stamp: grass, subLayer: 'ground' });
    const ground = session.floor.subLayers.find((s) => s.id === 'ground');
    assert.ok(ground);
    // Left open pocket filled
    assert.ok((ground.cells[2 * cols + 2] & 0xffff) > 0, 'seed open cell stamped');
    assert.ok((ground.cells[1 * cols + 1] & 0xffff) > 0, 'connected open stamped');
    // Right open pocket not connected — still empty
    assert.strictEqual(ground.cells[2 * cols + 5] & 0xffff, 0, 'disconnected open not filled');
    // Blocked frame stays empty (different walk class)
    assert.strictEqual(ground.cells[0] & 0xffff, 0, 'blocked frame not filled from open seed');
    assert.strictEqual(ground.cells[2 * cols + 4] & 0xffff, 0, 'blocked separator not filled');

    // Seed on blocked empty → only blocked component
    session.bucketFill(0, 0, { stamp: wall, subLayer: 'ground' });
    assert.ok((ground.cells[0] & 0xffff) > 0, 'blocked seed stamped');
    assert.ok((ground.cells[2 * cols + 4] & 0xffff) > 0, 'connected blocked separator stamped');
    // Right open pocket still empty
    assert.strictEqual(ground.cells[2 * cols + 5] & 0xffff, 0, 'open pocket untouched by blocked fill');

    // ignoreFrictionMask: empty open right pocket fills even across... wait, wall stamps
    // occupy blocked cells; open right is still 0. With ignore, flood all palette-0.
    session.bucketFill(5, 2, { stamp: grass, subLayer: 'ground', ignoreFrictionMask: true });
    assert.ok(
        (ground.cells[2 * cols + 5] & 0xffff) > 0,
        'ignoreFrictionMask fills remaining empty open'
    );

    // Already-stamped region: replace connected grass by palette only (no friction re-gate).
    // Paint a single open cell next to grass with water via palette match path.
    const water = { catalogId: 'w2', roleId: 'water', subLayer: 'ground' };
    // Left pocket is grass; bucket water at (2,2) should replace grass region only.
    session.bucketFill(2, 2, { stamp: water, subLayer: 'ground' });
    assert.strictEqual(
        session.floor.friction[2 * cols + 2],
        FRICTION_BLOCKED,
        'water bake blocks walk'
    );
    // Wall-stamped blocked cell at (0,0) must not become water (different palette)
    const wallIdx = ground.cells[0] & 0xffff;
    const waterAtSeed = ground.cells[2 * cols + 2] & 0xffff;
    assert.ok(wallIdx > 0 && waterAtSeed > 0 && wallIdx !== waterAtSeed);

    log('bucket friction mask ok');
}

/**
 * Editor buffers start at 0. PNG bootstrap + one vertical stamp must not void
 * the rest of the floor (wiki: placing a stair painted the whole friction 255).
 */
function testBootstrapStairDoesNotVoidRest() {
    const roles = roleCatalog();
    const cols = 8;
    const rows = 8;
    const n = cols * rows;
    const session = createEditorSession({ cols, rows, z: 6, roleCatalog: roles });
    for (let i = 0; i < n; i++) {
        assert.strictEqual(session.floor.friction[i], 0, 'new session friction must be 0, not void');
    }

    const friction = new Uint8Array(n);
    friction.fill(DEFAULT_OPEN_FRICTION);
    friction[0] = FRICTION_BLOCKED;
    session.bootstrapFromChannels({ cols, rows, friction, z: 6 });

    const stairs = {
        catalogId: 'broken_cave_stairs',
        roleId: 'stairs_down',
        kind: 'tiles',
        subLayer: 'vertical',
        hop: { dir: 'center', deltaZ: 1 }
    };
    session.beginStroke();
    session.paintAt(3, 4, { stamp: stairs, subLayer: 'vertical' });
    session.endStroke();

    const i = (x, y) => y * cols + x;
    assert.ok((session.floor.flags[i(3, 4)] & TILE_FLAG_STAIR) !== 0, 'stair flag on painted cell');
    assert.strictEqual(session.floor.friction[0], FRICTION_BLOCKED, 'PNG blocked cell kept');
    assert.strictEqual(
        session.floor.friction[i(1, 1)],
        DEFAULT_OPEN_FRICTION,
        'unpainted PNG open cell must stay open'
    );
    let open = 0;
    for (let k = 0; k < n; k++) {
        if (session.floor.friction[k] === DEFAULT_OPEN_FRICTION) open++;
    }
    assert.ok(open >= n - 2, 'almost all PNG-open cells must survive a single stair stamp');

    log('bootstrap stair does not void rest ok');
}

/**
 * Hybrid reopen: stamps + existing friction must not rebake empty cells to 255.
 */
function testLoadFloorKeepsExistingFriction() {
    const roles = roleCatalog();
    const cols = 6;
    const rows = 6;
    const n = cols * rows;
    const session = createEditorSession({ cols, rows, z: 6, roleCatalog: roles });
    const friction = new Uint8Array(n);
    friction.fill(DEFAULT_OPEN_FRICTION);
    friction[1] = FRICTION_BLOCKED;
    session.bootstrapFromChannels({ cols, rows, friction, z: 6 });

    const stairs = {
        catalogId: 'broken_cave_stairs',
        roleId: 'stairs_down',
        kind: 'tiles',
        subLayer: 'vertical',
        hop: { dir: 'center', deltaZ: 1 }
    };
    session.beginStroke();
    session.paintAt(2, 2, { stamp: stairs, subLayer: 'vertical' });
    session.endStroke();

    const cloneSub = session.floor.subLayers.map((sl) => ({
        id: sl.id,
        zOrder: sl.zOrder,
        cells: new Uint16Array(sl.cells)
    }));
    const session2 = createEditorSession({ cols: 1, rows: 1, z: 0, roleCatalog: roles });
    session2.loadFloor({
        z: 6,
        cols,
        rows,
        palette: session.floor.palette.slice(),
        subLayers: cloneSub,
        friction: new Uint8Array(session.floor.friction),
        sight: new Uint8Array(session.floor.sight),
        flags: new Uint8Array(session.floor.flags),
        fields: new Uint8Array(session.floor.fields),
        overrideMask: new Uint8Array(session.floor.overrideMask),
        stairs: (session.floor.stairs || []).map((s) => Object.assign({}, s))
    });

    const i = (x, y) => y * cols + x;
    assert.strictEqual(
        session2.floor.friction[i(4, 4)],
        DEFAULT_OPEN_FRICTION,
        'loadFloor must not void unstamped PNG cells when friction already exists'
    );
    assert.strictEqual(session2.floor.friction[1], FRICTION_BLOCKED);
    assert.ok((session2.floor.flags[i(2, 2)] & TILE_FLAG_STAIR) !== 0);

    log('loadFloor keeps existing friction ok');
}

function pathCatalog(session, x, y) {
    const sl = session.floor.subLayers.find((s) => s && s.id === 'path');
    assert.ok(sl, 'path sub-layer');
    const pi = sl.cells[y * session.cols + x] & 0xffff;
    if (!pi) return null;
    const e = session.floor.palette[pi];
    return e ? e.catalogId : null;
}

function dirtFamily() {
    return {
        catalogId: 'dirt_wang_15',
        kind: 'overlays',
        roleId: 'path',
        wangFamily: 'dirt',
        wangResolve: true,
        subLayer: 'path'
    };
}

function testWangFamilyResolve() {
    const roles = roleCatalog();
    const session = createEditorSession({ cols: 12, rows: 12, z: 0, roleCatalog: roles });
    const dirt = dirtFamily();
    session.selectStamp(dirt);

    session.beginStroke();
    session.paintAt(5, 5, { stamp: dirt });
    session.endStroke();
    assert.strictEqual(pathCatalog(session, 5, 5), 'dirt_wang_00', 'isolated cell is mask 0');

    session.beginStroke();
    session.paintAt(6, 5, { stamp: dirt });
    session.endStroke();
    assert.strictEqual(pathCatalog(session, 5, 5), 'dirt_wang_02', 'west cell gains east neighbor (E=2)');
    assert.strictEqual(pathCatalog(session, 6, 5), 'dirt_wang_08', 'east cell gains west neighbor (W=8)');

    session.beginStroke();
    session.paintAt(5, 5, { erase: true, subLayer: 'path' });
    session.endStroke();
    assert.strictEqual(pathCatalog(session, 5, 5), null);
    assert.strictEqual(pathCatalog(session, 6, 5), 'dirt_wang_00', '1-ring re-resolve after erase');

    session.undo();
    assert.strictEqual(pathCatalog(session, 5, 5), 'dirt_wang_02');
    assert.strictEqual(pathCatalog(session, 6, 5), 'dirt_wang_08');

    const plus = createEditorSession({ cols: 8, rows: 8, z: 0, roleCatalog: roles });
    plus.beginStroke();
    plus.paintAt(3, 2, { stamp: dirt });
    plus.paintAt(2, 3, { stamp: dirt });
    plus.paintAt(3, 3, { stamp: dirt });
    plus.paintAt(4, 3, { stamp: dirt });
    plus.paintAt(3, 4, { stamp: dirt });
    plus.endStroke();
    assert.strictEqual(pathCatalog(plus, 3, 3), 'dirt_wang_15', 'plus center is mask 15');
    assert.strictEqual(pathCatalog(plus, 3, 2), 'dirt_wang_04', 'north arm S=4');
    assert.strictEqual(pathCatalog(plus, 4, 3), 'dirt_wang_08', 'east arm W=8');
    assert.strictEqual(pathCatalog(plus, 3, 4), 'dirt_wang_01', 'south arm N=1');
    assert.strictEqual(pathCatalog(plus, 2, 3), 'dirt_wang_02', 'west arm E=2');

    const sq = createEditorSession({ cols: 8, rows: 8, z: 0, roleCatalog: roles });
    sq.beginStroke();
    sq.paintAt(2, 2, { stamp: dirt });
    sq.paintAt(3, 2, { stamp: dirt });
    sq.paintAt(2, 3, { stamp: dirt });
    sq.paintAt(3, 3, { stamp: dirt });
    sq.endStroke();
    assert.strictEqual(pathCatalog(sq, 2, 2), 'dirt_wang_06', 'NW corner E+S=6');
    assert.strictEqual(pathCatalog(sq, 3, 2), 'dirt_wang_12', 'NE corner W+S=12');
    assert.strictEqual(pathCatalog(sq, 2, 3), 'dirt_wang_03', 'SW corner N+E=3');
    assert.strictEqual(pathCatalog(sq, 3, 3), 'dirt_wang_09', 'SE corner N+W=9');

    const blob = createEditorSession({ cols: 8, rows: 8, z: 0, roleCatalog: roles });
    blob.beginStroke();
    for (let y = 1; y <= 3; y++) {
        for (let x = 1; x <= 3; x++) {
            blob.paintAt(x, y, { stamp: dirt });
        }
    }
    blob.endStroke();
    assert.strictEqual(pathCatalog(blob, 2, 2), 'dirt_wang_15', '3×3 center is fill 15');

    blob.beginStroke();
    blob.paintAt(1, 1, { erase: true, subLayer: 'path' });
    blob.endStroke();
    assert.strictEqual(pathCatalog(blob, 2, 2), 'dirt_wang_inner_nw', 'one empty diagonal → inner-nw');
    assert.notStrictEqual(pathCatalog(blob, 3, 1), 'dirt_wang_15');

    blob.beginStroke();
    blob.paintAt(3, 3, { erase: true, subLayer: 'path' });
    blob.endStroke();
    assert.strictEqual(
        pathCatalog(blob, 2, 2),
        'dirt_wang_15',
        'two empty diagonals fall back to fill 15'
    );

    blob.undo();
    assert.strictEqual(pathCatalog(blob, 2, 2), 'dirt_wang_inner_nw');
    blob.beginStroke();
    blob.paintAt(1, 1, { stamp: dirt });
    blob.endStroke();
    assert.strictEqual(pathCatalog(blob, 2, 2), 'dirt_wang_15', 'filling the notch restores 15');

    log('wang family resolve ok');
}

function testWangEyedropperAndSubLayer() {
    const roles = roleCatalog();
    const art = {
        roles: {
            floor: [{ id: 'damp_dirt_floor', roleId: 'floor' }],
            path: [
                { id: 'dirt_wang_05', kind: 'overlays', roleId: 'path', wangFamily: 'dirt' },
                { id: 'dirt_wang_15', kind: 'overlays', roleId: 'path', wangFamily: 'dirt' }
            ],
            water: [{ id: 'water_wang_15', kind: 'overlays', roleId: 'water', wangFamily: 'water' }]
        }
    };
    const stamps = buildStampsFromArtSet(art, roles);
    const dirtStamps = stamps.filter((s) => s.wangFamily === 'dirt');
    assert.strictEqual(dirtStamps.length, 1, 'collapse 16-mask family to one brush');
    assert.strictEqual(dirtStamps[0].catalogId, 'dirt_wang_15');
    assert.strictEqual(dirtStamps[0].subLayer, 'path');
    const water = stamps.find((s) => s.wangFamily === 'water');
    assert.ok(water);
    assert.strictEqual(water.subLayer, 'path', 'water overlay lands on path, not ground');

    const session = createEditorSession({
        cols: 8,
        rows: 8,
        z: 0,
        roleCatalog: roles,
        artSet: art
    });
    const dirt = dirtStamps[0];
    session.selectStamp(dirt);
    assert.strictEqual(session.activeSubLayer, 'path');
    session.beginStroke();
    session.paintAt(1, 1, { stamp: dirt });
    session.paintAt(2, 1, { stamp: dirt });
    session.endStroke();
    const hit = session.sampleCellAt(1, 1, { subLayer: 'path' });
    assert.ok(hit && hit.stamp);
    assert.strictEqual(hit.stamp.wangFamily, 'dirt');
    assert.strictEqual(hit.stamp.catalogId, 'dirt_wang_15', 'eyedropper picks family, not mask');
    assert.notStrictEqual(pathCatalog(session, 1, 1), 'dirt_wang_15');

    log('wang eyedropper + overlay sub-layer ok');
}

function testWangBucketRawAndPaste() {
    const roles = roleCatalog();
    const dirt = dirtFamily();
    const water = {
        catalogId: 'water_wang_15',
        kind: 'overlays',
        roleId: 'water',
        wangFamily: 'water',
        wangResolve: true,
        subLayer: 'path'
    };
    const session = createEditorSession({ cols: 10, rows: 10, z: 0, roleCatalog: roles });
    session.beginStroke();
    session.paintAt(2, 2, { stamp: dirt });
    session.paintAt(3, 2, { stamp: dirt });
    session.paintAt(2, 3, { stamp: dirt });
    session.endStroke();
    session.bucketFill(2, 2, { stamp: water });
    assert.strictEqual(pathCatalog(session, 2, 2).indexOf('water_wang_'), 0);
    assert.strictEqual(pathCatalog(session, 3, 2).indexOf('water_wang_'), 0);
    assert.strictEqual(pathCatalog(session, 2, 3).indexOf('water_wang_'), 0);

    const raw = createEditorSession({ cols: 8, rows: 8, z: 0, roleCatalog: roles });
    const locked = {
        catalogId: 'dirt_wang_05',
        kind: 'overlays',
        roleId: 'path',
        wangFamily: 'dirt',
        wangLocked: true,
        wangResolve: false,
        subLayer: 'path'
    };
    raw.beginStroke();
    raw.paintAt(3, 3, { stamp: locked });
    raw.paintAt(4, 3, { stamp: dirt });
    raw.endStroke();
    assert.strictEqual(pathCatalog(raw, 3, 3), 'dirt_wang_05', 'RAW locked cell keeps mask 05');
    assert.strictEqual(pathCatalog(raw, 4, 3), 'dirt_wang_08', 'neighbor still resolves against locked cell');

    const src = createEditorSession({ cols: 8, rows: 8, z: 0, roleCatalog: roles });
    src.beginStroke();
    src.paintAt(1, 1, { stamp: dirt });
    src.paintAt(2, 1, { stamp: dirt });
    src.endStroke();
    src.setActiveSubLayer('path');
    const clip = src.copyTiles({ x0: 1, y0: 1, x1: 2, y1: 1 }, { subLayer: 'path' });
    assert.ok(clip && clip.cells.length >= 2);
    const dest = createEditorSession({ cols: 8, rows: 8, z: 0, roleCatalog: roles });
    dest.pasteTiles(clip, 4, 4);
    assert.strictEqual(pathCatalog(dest, 4, 4), 'dirt_wang_02');
    assert.strictEqual(pathCatalog(dest, 5, 4), 'dirt_wang_08');

    log('wang bucket / RAW / paste ok');
}

function verticalCatalog(session, x, y) {
    const sl = session.floor.subLayers.find((s) => s && s.id === 'vertical');
    assert.ok(sl, 'vertical sub-layer');
    const pi = sl.cells[y * session.cols + x] & 0xffff;
    if (!pi) return null;
    const e = session.floor.palette[pi];
    return e ? e.catalogId : null;
}

function stoneFamily() {
    return {
        catalogId: 'stone_wall_pole',
        kind: 'objects',
        roleId: 'wall',
        wallFamily: 'stone_wall',
        wangResolve: true,
        subLayer: 'vertical'
    };
}

function testWallWangResolve() {
    const roles = roleCatalog();
    const session = createEditorSession({ cols: 12, rows: 12, z: 0, roleCatalog: roles });
    const stone = stoneFamily();
    session.selectStamp(stone);

    session.beginStroke();
    session.paintAt(5, 5, { stamp: stone });
    session.endStroke();
    assert.strictEqual(verticalCatalog(session, 5, 5), 'stone_wall_pole', 'isolated cell is pole');
    assert.strictEqual(session.floor.friction[5 * 12 + 5], FRICTION_BLOCKED);
    assert.ok(!(session.floor.stairs || []).some((s) => s && s.x === 5 && s.y === 5));

    session.beginStroke();
    session.paintAt(6, 5, { stamp: stone });
    session.endStroke();
    assert.strictEqual(
        verticalCatalog(session, 5, 5),
        'stone_wall_west_end',
        'west cell is E-only → west_end (free side)'
    );
    assert.strictEqual(
        verticalCatalog(session, 6, 5),
        'stone_wall_east_end',
        'east cell is W-only → east_end (free side)'
    );

    const run = createEditorSession({ cols: 8, rows: 8, z: 0, roleCatalog: roles });
    run.beginStroke();
    run.paintAt(2, 4, { stamp: stone });
    run.paintAt(3, 4, { stamp: stone });
    run.paintAt(4, 4, { stamp: stone });
    run.endStroke();
    assert.strictEqual(verticalCatalog(run, 3, 4), 'stone_wall_horizontal', 'EW middle is mask 10');

    session.beginStroke();
    session.paintAt(5, 5, { erase: true, subLayer: 'vertical' });
    session.endStroke();
    assert.strictEqual(verticalCatalog(session, 5, 5), null);
    assert.strictEqual(verticalCatalog(session, 6, 5), 'stone_wall_pole', '1-ring re-resolve after erase');

    const ns = createEditorSession({ cols: 8, rows: 8, z: 0, roleCatalog: roles });
    ns.beginStroke();
    ns.paintAt(3, 2, { stamp: stone });
    ns.paintAt(3, 3, { stamp: stone });
    ns.endStroke();
    assert.strictEqual(
        verticalCatalog(ns, 3, 2),
        'stone_wall_north_end',
        'north cell is S-only → north_end (free side)'
    );
    assert.strictEqual(
        verticalCatalog(ns, 3, 3),
        'stone_wall_south_end',
        'south cell is N-only → south_end (free side)'
    );

    const plus = createEditorSession({ cols: 8, rows: 8, z: 0, roleCatalog: roles });
    plus.beginStroke();
    plus.paintAt(3, 2, { stamp: stone });
    plus.paintAt(2, 3, { stamp: stone });
    plus.paintAt(3, 3, { stamp: stone });
    plus.paintAt(4, 3, { stamp: stone });
    plus.paintAt(3, 4, { stamp: stone });
    plus.endStroke();
    assert.strictEqual(verticalCatalog(plus, 3, 3), 'stone_wall_intersection', '+ center is intersection');
    assert.strictEqual(verticalCatalog(plus, 3, 2), 'stone_wall_north_end', 'north arm is S-only → north_end');
    assert.strictEqual(verticalCatalog(plus, 4, 3), 'stone_wall_east_end', 'east arm is W-only → east_end');

    const room = createEditorSession({ cols: 8, rows: 8, z: 0, roleCatalog: roles });
    room.beginStroke();
    for (let y = 2; y <= 4; y++) {
        for (let x = 2; x <= 4; x++) {
            if (x === 3 && y === 3) continue;
            room.paintAt(x, y, { stamp: stone });
        }
    }
    room.endStroke();
    assert.strictEqual(verticalCatalog(room, 2, 2), 'stone_wall_southeast_diagonal', 'NW room corner');
    assert.strictEqual(verticalCatalog(room, 4, 2), 'stone_wall_southwest_diagonal', 'NE room corner');
    assert.strictEqual(verticalCatalog(room, 2, 4), 'stone_wall_northeast_diagonal', 'SW room corner');
    assert.strictEqual(verticalCatalog(room, 4, 4), 'stone_wall_corner', 'SE room corner is N+W');
    assert.strictEqual(verticalCatalog(room, 3, 2), 'stone_wall_horizontal', 'north wall mid');
    assert.strictEqual(verticalCatalog(room, 2, 3), 'stone_wall_vertical', 'west wall mid');

    log('wall wang resolve ok');
}

function testWallWangHopSkipAndEyedropper() {
    const roles = roleCatalog();
    const art = {
        roles: {
            wall: [
                { id: 'stone_wall_pole', kind: 'objects', roleId: 'wall', wallFamily: 'stone_wall' },
                { id: 'stone_wall_horizontal', kind: 'objects', roleId: 'wall', wallFamily: 'stone_wall' },
                { id: 'stone_wall_vertical', kind: 'objects', roleId: 'wall', wallFamily: 'stone_wall' },
                { id: 'stone_wall_corner', kind: 'objects', roleId: 'wall', wallFamily: 'stone_wall' },
                { id: 'damp_cave_wall', roleId: 'wall' }
            ],
            stairs_up: [{ id: 'worn_stone_stairs', roleId: 'stairs_up' }]
        }
    };
    const stamps = buildStampsFromArtSet(art, roles);
    const wallStamps = stamps.filter((s) => s.wallFamily === 'stone_wall');
    assert.strictEqual(wallStamps.length, 1, 'collapse 4 faces to one brush');
    assert.strictEqual(wallStamps[0].catalogId, 'stone_wall_pole');
    assert.strictEqual(wallStamps[0].subLayer, 'vertical');
    assert.ok(!wallStamps[0].hop, 'wall family has no hop');
    const cave = stamps.find((s) => s.catalogId === 'damp_cave_wall');
    assert.ok(cave && cave.subLayer === 'ground', 'tile cave wall stays on ground');
    const stairs = stamps.find((s) => s.roleId === 'stairs_up');
    assert.ok(stairs && stairs.hop && stairs.subLayer === 'vertical');

    const session = createEditorSession({
        cols: 8,
        rows: 8,
        z: 0,
        roleCatalog: roles,
        artSet: art
    });
    const stone = wallStamps[0];
    session.selectStamp(stone);
    assert.strictEqual(session.activeSubLayer, 'vertical');
    session.beginStroke();
    session.paintAt(2, 2, { stamp: stone });
    session.paintAt(3, 2, { stamp: stairs });
    session.endStroke();
    assert.strictEqual(
        verticalCatalog(session, 2, 2),
        'stone_wall_pole',
        'stair neighbor is not a wall edge'
    );
    assert.ok((session.floor.stairs || []).some((s) => s && s.x === 3 && s.y === 2));

    const hit = session.sampleCellAt(2, 2, { subLayer: 'vertical' });
    assert.ok(hit && hit.stamp);
    assert.strictEqual(hit.stamp.wallFamily, 'stone_wall');
    assert.strictEqual(hit.stamp.catalogId, 'stone_wall_pole', 'eyedropper picks family, not face');

    const dest = createEditorSession({ cols: 8, rows: 8, z: 0, roleCatalog: roles });
    session.setActiveSubLayer('vertical');
    const clip = session.copyTiles({ x0: 2, y0: 2, x1: 2, y1: 2 }, { subLayer: 'vertical' });
    dest.pasteTiles(clip, 4, 4);
    assert.strictEqual(verticalCatalog(dest, 4, 4), 'stone_wall_pole');

    log('wall wang hop skip + eyedropper ok');
}

function main() {
    testUiOrderAndFlags();
    testArtSetStamps();
    testPaintBakeRoom();
    testDiagonalBakeDoesNotFillAabb();
    testDiagonalPaintDoesNotVoidBootstrapChannels();
    testUndoRedo();
    testHybridTransportAndDisk();
    testHybridSavePreservesBootstrapAndFields();
    testBucketFill();
    testBucketFillFrictionMask();
    testBootstrapStairDoesNotVoidRest();
    testLoadFloorKeepsExistingFriction();
    testWangFamilyResolve();
    testWangEyedropperAndSubLayer();
    testWangBucketRawAndPaste();
    testWallWangResolve();
    testWallWangHopSkipAndEyedropper();
    console.log('tilemap_editor: ok');
}

main();
