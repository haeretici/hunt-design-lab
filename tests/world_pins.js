#!/usr/bin/env node
/**
 * World pin normalize / editor helpers / hybrid roundtrip (W0+W1).
 * Quiet on success; VERBOSE=1 for detail.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const wp = require('../kernel/core/lib/dungeon/world_pins.js');
const {
    seedWorldPinsOntoGround,
    groundUidForWorldPin,
    tickWorldPinDecay
} = require('../kernel/core/lib/dungeon/world_pin_seed.js');
const {
    useWorldChest,
    DEFAULT_CHEST_EMPTY_TEXT
} = require('../kernel/core/lib/dungeon/world_pin_chest.js');
const { applyCellPatch } = require('../kernel/core/lib/dungeon/cell_patch.js');
const { useWorldLever } = require('../kernel/core/lib/dungeon/world_pin_lever.js');
const {
    useWorldHarvest,
    tickWorldPinHarvest,
    DEFAULT_HARVEST_EMPTY_TEXT
} = require('../kernel/core/lib/dungeon/world_pin_harvest.js');
const {
    onWorldPinStep,
    tickWorldPinTrap
} = require('../kernel/core/lib/dungeon/world_pin_trap.js');
const { SpawnManager } = require('../kernel/core/lib/spawn_manager.js');
const {
    WaveController,
    normalizeWavesConfig
} = require('../kernel/core/lib/wave_manager.js');
const { getFieldOnTile } = require('../kernel/core/lib/combat/elemental_fields.js');
const {
    useWorldDoor,
    DOOR_LOCKED_TEXT,
    DOOR_CANNOT_PASS_TEXT
} = require('../kernel/core/lib/dungeon/world_pin_door.js');
const {
    useWorldTeleport,
    TELEPORT_NO_DEST_TEXT,
    TELEPORT_NO_WAY_TEXT,
    TELEPORT_CANNOT_TEXT
} = require('../kernel/core/lib/dungeon/world_pin_teleport.js');
const {
    useWorldToolWith,
    resolveToolRole
} = require('../kernel/core/lib/dungeon/world_pin_tool.js');
const { TileMap } = require('../kernel/core/entities/tilemap.js');
const { Player } = require('../kernel/core/entities/player.js');
const { getStorage } = require('../kernel/core/lib/npc/storage.js');
const { countPlayerItem, giveItemToPlayer } = require('../kernel/core/lib/npc/items.js');
const {
    createEmptyTileMapFloor,
    normalizeHybridPack,
    serializeHybridPack,
    deserializeHybridPack,
    writeHybridMapDir,
    tryResolveHybridMapPack,
    mergeLoadedHybridPacks
} = require('../kernel/core/lib/dungeon/tilemap_bake.js');
const { createEditorSession } = require('../kernel/core/lib/dungeon/tilemap_editor.js');
const { fillMinimapRgba } = require('../kernel/core/lib/dungeon/map_editor_workflow.js');
const {
    DEFAULT_OPEN_FRICTION,
    FRICTION_BLOCKED,
    TILE_FLAG_ROPE_SPOT,
    TILE_FLAG_SHOVEL_SPOT
} = require('../kernel/core/lib/dungeon/tile_roles.js');
const {
    createGroundStore,
    pickupItemFromGround,
    getStack
} = require('../kernel/core/lib/character/ground_items.js');
const {
    getItem,
    getContainer,
    createEmptyInventory
} = require('../kernel/core/lib/character/inventory.js');
const { Simulator } = require('../kernel/providers/simulator/simulator.js');

const VERBOSE = !!process.env.VERBOSE;

function log(...args) {
    if (VERBOSE) console.log(...args);
}

function testNormalizePin() {
    assert.strictEqual(wp.normalizeWorldPin(null), null);
    assert.strictEqual(wp.normalizeWorldPin({ catalogId: 'crate' }), null);
    const pin = wp.normalizeWorldPin({
        catalogId: 'jubilee_backpack',
        catalogKind: 'equipment',
        x: 10.4,
        y: 12.6,
        z: 7,
        kind: 'container',
        items: [{ item: 'gold_coin', count: 12 }, { item: '', count: 1 }]
    });
    assert.ok(pin);
    assert.strictEqual(pin.x, 10);
    assert.strictEqual(pin.y, 13);
    assert.strictEqual(pin.kind, 'container');
    assert.strictEqual(pin.pickupable, true);
    assert.strictEqual(pin.blocking, false);
    assert.strictEqual(pin.shared, true);
    assert.strictEqual(pin.capacity, 20);
    assert.strictEqual(pin.items.length, 1);
    assert.strictEqual(pin.items[0].item, 'gold_coin');
    assert.strictEqual(pin.items[0].count, 12);
    assert.ok(pin.id);
    log('normalize container ok');
}

function testKindsAndIds() {
    const used = [];
    const a = wp.allocWorldPinId(used, 'container', 1, 2, 7);
    used.push(a);
    const b = wp.allocWorldPinId(used, 'container', 1, 2, 7);
    assert.notStrictEqual(a, b);
    assert.strictEqual(wp.normalizeWorldKind('CHEST'), 'chest');
    assert.strictEqual(wp.normalizeWorldKind(''), 'container');
    assert.strictEqual(wp.normalizeWorldKind('nope'), 'nope');
    const door = wp.normalizeWorldPin({
        catalogId: 'oak_door',
        kind: 'door',
        x: 0,
        y: 0,
        z: 0
    });
    assert.strictEqual(door.blocking, true);
    assert.strictEqual(door.pickupable, false);
    const stub = wp.normalizeWorldPin({
        catalogId: 'bed_frame',
        kind: 'bed',
        x: 1,
        y: 1,
        z: 7
    });
    assert.strictEqual(stub.kind, 'bed');
    assert.strictEqual(stub.pickupable, false);
    assert.strictEqual(stub.blocking, false);
    assert.strictEqual(wp.worldPinUseReady('bed'), false);
    assert.strictEqual(wp.worldPinUseReady('harvest'), true);
    assert.strictEqual(wp.worldPinUseReady('trap'), false);
    const trap = wp.normalizeWorldPin({
        catalogId: 'spike_trap',
        kind: 'trap',
        x: 1,
        y: 1,
        z: 7
    });
    assert.strictEqual(trap.blocking, false);
    assert.strictEqual(trap.pickupable, false);
    assert.strictEqual(trap.shared, true);
    const harvest = wp.normalizeWorldPin({
        catalogId: 'bush',
        kind: 'harvest',
        x: 2,
        y: 2,
        z: 7
    });
    assert.strictEqual(harvest.pickupable, false);
    assert.strictEqual(harvest.shared, true);
    log('kinds + ids ok');
}

function testNestedItems() {
    const pin = wp.normalizeWorldPin({
        catalogId: 'crate',
        kind: 'container',
        x: 1,
        y: 1,
        z: 0,
        items: [
            {
                item: 'backpack',
                count: 1,
                items: [{ item: 'torch', count: 2 }]
            }
        ]
    });
    assert.strictEqual(pin.items[0].items[0].item, 'torch');
    log('nested items ok');
}

function testClipboardAndTile() {
    const a = wp.makeEditorWorldPin(
        { catalogId: 'crate', kind: 'container', x: 4, y: 5, z: 7, items: [{ item: 'gold_coin', count: 3 }] },
        null,
        { z: 7 }
    );
    const b = wp.makeEditorWorldPin(
        { catalogId: 'lever_left', kind: 'lever', x: 6, y: 5, z: 7 },
        null,
        { z: 7, usedIds: [a.id] }
    );
    assert.strictEqual(wp.worldPinAtTile([a, b], 6, 5), b);
    const frac = wp.normalizeWorldPin({
        catalogId: 'crate',
        kind: 'container',
        x: 10.6,
        y: 5.4,
        z: 7
    });
    assert.strictEqual(frac.x, 11);
    assert.strictEqual(frac.y, 5);
    assert.strictEqual(wp.worldPinAtTile([frac], 10.6, 5.4), frac);
    const clip = wp.copyWorldPins([a, b]);
    assert.ok(clip);
    assert.strictEqual(clip.pins.length, 2);
    const pasted = wp.pasteWorldPins(clip, { x: 20, y: 30, z: 8 }, null, [a, b]);
    assert.strictEqual(pasted.length, 2);
    assert.strictEqual(pasted[0].x, 20);
    assert.strictEqual(pasted[0].z, 8);
    assert.notStrictEqual(pasted[0].id, a.id);
    assert.strictEqual(pasted[0].items[0].item, 'gold_coin');
    log('clipboard ok');
}

function testFindAndBaseline() {
    const pins = wp.normalizeWorldList([
        { catalogId: 'crate', kind: 'container', x: 1, y: 1, z: 7, id: 'crate_a', items: [{ item: 'gold_coin', count: 1 }] },
        { catalogId: 'missing_art', kind: 'lever', x: 2, y: 1, z: 7 }
    ]);
    wp.markWorldBaseline(pins);
    assert.strictEqual(wp.isModifiedWorld(pins[0]), false);
    pins[0].capacity = 8;
    assert.strictEqual(wp.isModifiedWorld(pins[0]), true);
    const hits = wp.findWorldHits([{ floor: '07', world: pins }], { query: 'gold_coin' });
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].pin.id, 'crate_a');
    const unknown = wp.filterEditorWorld(pins, {
        issue: 'unknown',
        catalogs: { crate: { id: 'crate' } }
    });
    assert.strictEqual(unknown.length, 1);
    assert.strictEqual(unknown[0].catalogId, 'missing_art');
    log('find + baseline ok');
}

function testFloorMove() {
    const pin = wp.normalizeWorldPin({ catalogId: 'crate', x: 1, y: 1, z: 7, kind: 'container' });
    const from = [pin];
    const dest = [];
    const plan = wp.planWorldFloorMove(7, 8);
    assert.ok(plan.ok);
    const moved = wp.applyWorldFloorMove(from, dest, pin, 8);
    assert.ok(moved);
    assert.strictEqual(moved.fromList.length, 0);
    assert.strictEqual(moved.destList[0].z, 8);
    log('floor move ok');
}

function testHybridRoundtrip() {
    const cols = 4;
    const rows = 4;
    const n = cols * rows;
    const floor = createEmptyTileMapFloor(cols, rows, { z: 6 });
    floor.friction = new Uint8Array(n).fill(DEFAULT_OPEN_FRICTION);
    floor.sight = new Uint8Array(n);
    floor.flags = new Uint8Array(n);
    const world = wp.normalizeWorldList([
        {
            id: 'crate_east',
            kind: 'container',
            catalogId: 'jubilee_backpack',
            catalogKind: 'equipment',
            x: 1,
            y: 2,
            z: 6,
            capacity: 25,
            items: [{ item: 'gold_coin', count: 12 }]
        }
    ]);
    const pack = normalizeHybridPack({
        id: 'floor_06',
        floors: [floor],
        spawns: [{ creatureId: 'frost_imp', x: 0, y: 0, z: 6, respawn: 60 }],
        world
    });
    assert.ok(Array.isArray(pack.world));
    assert.strictEqual(pack.world[0].items[0].count, 12);
    const { meta, blobs } = serializeHybridPack(pack);
    assert.ok(Array.isArray(meta.world));
    const again = deserializeHybridPack(meta, blobs);
    assert.strictEqual(again.world.length, 1);
    assert.strictEqual(again.world[0].id, 'crate_east');
    assert.strictEqual(again.spawns[0].creatureId, 'frost_imp');

    const mapsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hybrid-world-'));
    try {
        writeHybridMapDir(path.join(mapsRoot, 'hybrid', 'floor-06'), pack);
        const merged = tryResolveHybridMapPack([6], { mapsRoot });
        assert.ok(merged);
        assert.ok(Array.isArray(merged.world));
        assert.strictEqual(merged.world[0].catalogId, 'jubilee_backpack');
        log('hybrid roundtrip ok');
    } finally {
        fs.rmSync(mapsRoot, { recursive: true, force: true });
    }
}

function testSessionTransport() {
    const session = createEditorSession({ cols: 4, rows: 4, z: 7 });
    const world = wp.normalizeWorldList([
        { catalogId: 'crate', kind: 'container', x: 1, y: 1, z: 7, items: [{ item: 'torch', count: 1 }] }
    ]);
    const transport = session.toHybridBinaryTransport({
        id: 'floor_07',
        spawns: null,
        world
    });
    assert.ok(Array.isArray(transport.meta.world));
    assert.strictEqual(transport.meta.world[0].items[0].item, 'torch');
    log('session transport ok');
}

function testMinimapWorldDots() {
    const destW = 8;
    const destH = 8;
    const rgba = new Uint8Array(destW * destH * 4);
    fillMinimapRgba(rgba, {
        cols: 8,
        rows: 8,
        destW,
        destH,
        spawns: [{ creatureId: 'frost_imp', x: 0, y: 0 }],
        world: [{ catalogId: 'crate', x: 7, y: 7, kind: 'container' }]
    });
    const idx = 7 * destW + 7;
    assert.strictEqual(rgba[idx * 4], 80);
    assert.strictEqual(rgba[idx * 4 + 1], 220);
    assert.strictEqual(rgba[idx * 4 + 2], 110);
    log('minimap world dots ok');
}

function testMissingWorldIsNull() {
    const floor = createEmptyTileMapFloor(2, 2, { z: 0 });
    const pack = normalizeHybridPack({ id: 'empty_world', floors: [floor] });
    assert.strictEqual(pack.world, null);
    const { meta } = serializeHybridPack(pack);
    assert.strictEqual(meta.world, null);
    log('missing world is null ok');
}

const SEED_DB = [
    {
        id: 'bag',
        label: 'Bag',
        category: 'container',
        slot: 'backpack',
        volume: 8,
        stackable: false
    },
    {
        id: 'crate',
        label: 'Wooden Crate',
        category: 'container',
        volume: 10
    },
    { id: 'gold_coin', label: 'Gold Coin', stackable: true, weight: 1 },
    { id: 'albino_plate', label: 'Albino Plate', weight: 80 },
    { id: 'wooden_chest', label: 'Wooden Chest' },
    { id: 'wooden_chest_open', label: 'Open Chest' },
    { id: 'torch', label: 'Torch', weight: 50 },
    { id: 'anvil', label: 'Anvil', weight: 500000 },
    {
        id: 'backpack',
        label: 'Backpack',
        category: 'container',
        slot: 'backpack',
        volume: 20,
        weight: 100
    },
    { id: 'stone_lever', label: 'Stone Lever' },
    { id: 'oak_door', label: 'Oak Door' },
    { id: 'oak_door_open', label: 'Open Oak Door' },
    { id: 'silver_key', label: 'Silver Key', weight: 1 },
    { id: 'magic_pad', label: 'Magic Pad' },
    { id: 'stone_lever_on', label: 'Stone Lever On' },
    { id: 'rubble', label: 'Rubble' },
    { id: 'rope', label: 'Rope', category: 'tool' },
    { id: 'shovel', label: 'Shovel', category: 'tool' },
    { id: 'elven_rope', label: 'Elven Rope', category: 'tool' },
    { id: 'strange_amulet', label: 'Strange Amulet', category: 'amulet', slot: 'amulet', weight: 600 },
    { id: 'blueberry', label: 'Blueberry', stackable: true, weight: 1 },
    { id: 'bush', label: 'Bush' },
    { id: 'bush_empty', label: 'Empty Bush' },
    { id: 'spike_trap', label: 'Spike Trap' }
];

function walkableFloor(z) {
    const floor = createEmptyTileMapFloor(4, 4, { z: z });
    const n = 4 * 4;
    floor.friction = new Uint8Array(n);
    floor.sight = new Uint8Array(n);
    floor.flags = new Uint8Array(n);
    floor.fields = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        floor.friction[i] = DEFAULT_OPEN_FRICTION;
        floor.sight[i] = 0;
        floor.flags[i] = 0;
    }
    return floor;
}

function testHuntSeedGround() {
    const ground = createGroundStore();
    const n = seedWorldPinsOntoGround(
        ground,
        [
            {
                id: 'crate_east',
                kind: 'container',
                catalogId: 'bag',
                catalogKind: 'equipment',
                x: 1,
                y: 2,
                z: 6,
                pickupable: true,
                capacity: 8,
                shared: true,
                items: [
                    { item: 'gold_coin', count: 3 },
                    { item: 'albino_plate', count: 1 }
                ]
            }
        ],
        { itemDb: SEED_DB }
    );
    assert.strictEqual(n, 1);
    const uid = groundUidForWorldPin(ground, 'crate_east');
    assert.ok(uid);
    const inst = getItem(ground.inventory, uid);
    assert.strictEqual(inst.itemId, 'bag');
    assert.strictEqual(inst.worldPinKind, 'container');
    assert.strictEqual(inst.worldPinCatalogKind, 'equipment');
    assert.strictEqual(inst.immovable, undefined);
    assert.strictEqual(inst.pickupable, true);
    const stack = getStack(ground, 1, 2, 6);
    assert.strictEqual(stack[stack.length - 1], uid);
    const cont = getContainer(ground.inventory, uid);
    assert.ok(cont);
    assert.strictEqual(cont.capacity, 8);
    const ids = cont.slots.filter(Boolean).map((s) => ground.inventory.items[s].itemId);
    assert.ok(ids.indexOf('gold_coin') >= 0);
    assert.ok(ids.indexOf('albino_plate') >= 0);
    const coinUid = cont.slots.find(
        (s) => s && ground.inventory.items[s].itemId === 'gold_coin'
    );
    assert.strictEqual(ground.inventory.items[coinUid].count, 3);
    log('hunt seed container slots ok');
}

function testHuntSeedMissingWorld() {
    const ground = createGroundStore();
    assert.strictEqual(seedWorldPinsOntoGround(ground, null, { itemDb: SEED_DB }), 0);
    assert.strictEqual(seedWorldPinsOntoGround(ground, [], { itemDb: SEED_DB }), 0);
    assert.strictEqual(Object.keys(ground.stacks).length, 0);
    log('hunt seed missing world ok');
}

function testHuntSeedPickupableVsCrate() {
    const ground = createGroundStore();
    seedWorldPinsOntoGround(
        ground,
        [
            {
                kind: 'container',
                catalogId: 'bag',
                x: 0,
                y: 0,
                z: 0,
                pickupable: true,
                items: []
            },
            {
                id: 'crate_fix',
                kind: 'container',
                catalogId: 'crate',
                x: 1,
                y: 0,
                z: 0,
                pickupable: false,
                items: [{ item: 'gold_coin', count: 1 }]
            }
        ],
        { itemDb: SEED_DB }
    );
    const bagUid = getStack(ground, 0, 0, 0)[0];
    const crateUid = groundUidForWorldPin(ground, 'crate_fix');
    assert.ok(bagUid && crateUid);
    assert.strictEqual(getItem(ground.inventory, crateUid).immovable, true);

    const player = {
        tile: { x: 0, y: 0, z: 0 },
        level: 50,
        classId: null
    };
    const bagPick = pickupItemFromGround({
        ground,
        uid: bagUid,
        playerInv: createEmptyInventory(),
        player,
        itemDb: SEED_DB
    });
    assert.ok(bagPick.ok, bagPick.error);
    assert.ok(bagPick.equipped);

    const cratePick = pickupItemFromGround({
        ground,
        uid: crateUid,
        playerInv: createEmptyInventory(),
        player: { tile: { x: 1, y: 0, z: 0 }, level: 50 },
        itemDb: SEED_DB
    });
    assert.strictEqual(cratePick.ok, false);
    assert.strictEqual(cratePick.error, 'immovable_item');
    log('hunt seed pickupable vs crate ok');
}

async function testHuntSeedSimulator() {
    const floor = walkableFloor(6);
    const pack = normalizeHybridPack({
        id: 'world_seed_sim',
        floors: [floor],
        world: [
            {
                id: 'container_6_1_1',
                kind: 'container',
                catalogId: 'bag',
                catalogKind: 'equipment',
                x: 1,
                y: 1,
                z: 6,
                pickupable: true,
                capacity: 8,
                shared: true,
                items: [{ item: 'gold_coin', count: 2 }]
            },
            {
                id: 'chest_6_2_2',
                kind: 'chest',
                catalogId: 'wooden_chest',
                x: 2,
                y: 2,
                z: 6,
                blocking: true,
                pickupable: false
            }
        ]
    });
    const sim = new Simulator({
        hybridMapPack: pack,
        floor: 6,
        floors: [6],
        seed: 1,
        itemDb: SEED_DB,
        autoHybridMap: false
    });
    await sim.loadMaps();
    const bagUid = groundUidForWorldPin(sim.groundItems, 'container_6_1_1');
    assert.ok(bagUid, 'container pin must seed onto ground');
    const cont = getContainer(sim.groundItems.inventory, bagUid);
    assert.ok(cont);
    const coin = cont.slots.find(
        (s) => s && sim.groundItems.inventory.items[s].itemId === 'gold_coin'
    );
    assert.ok(coin);
    assert.strictEqual(sim.groundItems.inventory.items[coin].count, 2);
    assert.strictEqual(sim.tileMap.getFriction(1, 1, 6), DEFAULT_OPEN_FRICTION);
    assert.strictEqual(
        sim.tileMap.getFriction(2, 2, 6),
        FRICTION_BLOCKED,
        'blocking chest patches walk'
    );
    const chest = getItem(
        sim.groundItems.inventory,
        groundUidForWorldPin(sim.groundItems, 'chest_6_2_2')
    );
    assert.ok(chest);
    assert.strictEqual(chest.immovable, true);
    assert.strictEqual(chest.worldPinKind, 'chest');

    const emptyFloor = walkableFloor(7);
    const emptyPack = normalizeHybridPack({
        id: 'geometry_only',
        floors: [emptyFloor]
    });
    const simEmpty = new Simulator({
        hybridMapPack: emptyPack,
        floor: 7,
        floors: [7],
        seed: 1,
        itemDb: SEED_DB,
        autoHybridMap: false
    });
    await simEmpty.loadMaps();
    assert.strictEqual(Object.keys(simEmpty.groundItems.stacks).length, 0);
    log('hunt seed simulator ok');
}

/**
 * Hunt Play calls `start()`, which wipes ground before `loadMaps`. Seed must
 * still land (do not mark `_worldPinsSeeded` on the empty pre-load wipe).
 */
async function testHuntSeedSimulatorStartSeedsWorld() {
    const floor = walkableFloor(6);
    const pack = normalizeHybridPack({
        id: 'world_seed_start',
        floors: [floor],
        world: [
            {
                id: 'container_6_1_1',
                kind: 'container',
                catalogId: 'bag',
                catalogKind: 'equipment',
                x: 1,
                y: 1,
                z: 6,
                pickupable: true,
                capacity: 8,
                shared: true,
                items: [{ item: 'gold_coin', count: 2 }]
            }
        ]
    });
    const sim = new Simulator({
        hybridMapPack: pack,
        floor: 6,
        floors: [6],
        seed: 1,
        itemDb: SEED_DB,
        autoHybridMap: false
    });
    await sim.start();
    const bagUid = groundUidForWorldPin(sim.groundItems, 'container_6_1_1');
    assert.ok(bagUid, 'start() must seed world pins (Play path)');
    const cont = getContainer(sim.groundItems.inventory, bagUid);
    assert.ok(cont);
    log('hunt seed simulator start() ok');
}

function testHuntSeedBrowserMergeKeepsWorld() {
    const pack6 = normalizeHybridPack({
        id: 'f6',
        floors: [walkableFloor(6)],
        spawns: [{ creatureId: 'mountain_troll', x: 0, y: 0, z: 6, respawn: 60 }],
        world: [
            {
                id: 'container_6_294_911',
                kind: 'container',
                catalogId: 'bag',
                catalogKind: 'equipment',
                x: 294,
                y: 911,
                z: 6,
                pickupable: true,
                capacity: 15,
                items: [{ item: 'albino_plate', count: 1 }]
            }
        ]
    });
    const pack7 = normalizeHybridPack({
        id: 'f7',
        floors: [walkableFloor(7)]
    });
    const dropped = normalizeHybridPack({
        id: 'browser_hybrid',
        label: 'Browser hybrid packs',
        floors: [pack6.floors['6'], pack7.floors['7']],
        spawns: pack6.spawns
    });
    assert.strictEqual(
        dropped.world,
        null,
        'floors+spawns-only merge (old browser path) drops world'
    );
    const merged = mergeLoadedHybridPacks([pack6, pack7], {
        id: 'browser_hybrid',
        label: 'Browser hybrid packs'
    });
    assert.ok(merged);
    assert.ok(merged.floors['6']);
    assert.ok(merged.floors['7']);
    assert.ok(Array.isArray(merged.world));
    assert.strictEqual(merged.world.length, 1);
    assert.strictEqual(merged.world[0].id, 'container_6_294_911');
    assert.strictEqual(merged.world[0].items[0].item, 'albino_plate');
    log('hunt seed browser merge keeps world ok');
}

function makeChestPlayer(opts) {
    const o = opts || {};
    const player = new Player({
        id: o.id != null ? o.id : 1,
        name: o.name || 'Hunter',
        tile: o.tile || { x: 1, y: 1, z: 0 },
        itemDb: SEED_DB,
        storage: o.storage,
        level: o.level != null ? o.level : 1
    });
    player.alive = true;
    player._loadoutItemDb = SEED_DB;
    player.initInventory(
        {
            equipment: { backpack: 'backpack' },
            backpack: o.backpack || []
        },
        SEED_DB
    );
    return player;
}

function seedQuestChest(extra) {
    const ground = createGroundStore();
    const pin = Object.assign(
        {
            id: 'quest_chest_east',
            kind: 'chest',
            catalogId: 'wooden_chest',
            x: 1,
            y: 1,
            z: 0,
            blocking: true,
            pickupable: false,
            once: { storage: 'quest.demo.chest', equals: 0 },
            give: [{ item: 'gold_coin', count: 50 }],
            set: { 'quest.demo.chest': 1 },
            emptyText: 'The chest is empty.',
            transformTo: 'wooden_chest_open'
        },
        extra || {}
    );
    const n = seedWorldPinsOntoGround(ground, [pin], { itemDb: SEED_DB });
    assert.strictEqual(n, 1);
    const uid = groundUidForWorldPin(ground, pin.id);
    const inst = getItem(ground.inventory, uid);
    assert.ok(inst);
    return { ground, pin: wp.normalizeWorldPin(pin), inst, uid };
}

function testNormalizeChest() {
    const pin = wp.normalizeWorldPin({
        id: 'quest_chest_east',
        kind: 'chest',
        catalogId: 'wooden_chest',
        x: 10,
        y: 10,
        z: 7,
        once: { storage: 'quest.demo.chest', equals: 0 },
        give: [{ item: 'gold_coin', count: 50 }],
        set: { 'quest.demo.chest': 1 },
        emptyText: 'The chest is empty.',
        transformTo: 'wooden_chest_open'
    });
    assert.ok(pin);
    assert.strictEqual(pin.kind, 'chest');
    assert.strictEqual(pin.blocking, true);
    assert.strictEqual(pin.pickupable, false);
    assert.strictEqual(pin.shared, false);
    assert.deepStrictEqual(pin.once, { storage: 'quest.demo.chest', eq: 0 });
    assert.strictEqual(pin.give[0].item, 'gold_coin');
    assert.strictEqual(pin.give[0].count, 50);
    assert.strictEqual(pin.set['quest.demo.chest'], 1);
    assert.strictEqual(pin.transformTo, 'wooden_chest_open');
    const hits = wp.findWorldHits([{ floor: '07', world: [pin] }], {
        query: 'gold_coin'
    });
    assert.strictEqual(hits.length, 1);
    log('normalize chest ok');
}

function testQuestChestFirstUseThenEmpty() {
    const { inst } = seedQuestChest();
    const player = makeChestPlayer();
    const first = useWorldChest(player, inst, { itemDb: SEED_DB });
    assert.strictEqual(first.ok, true, first.reason);
    assert.strictEqual(countPlayerItem(player, 'gold_coin'), 50);
    assert.strictEqual(getStorage(player, 'quest.demo.chest'), 1);
    assert.strictEqual(inst.itemId, 'wooden_chest_open');
    const second = useWorldChest(player, inst, { itemDb: SEED_DB });
    assert.strictEqual(second.ok, false);
    assert.strictEqual(second.reason, 'empty');
    assert.strictEqual(second.text, DEFAULT_CHEST_EMPTY_TEXT);
    assert.strictEqual(countPlayerItem(player, 'gold_coin'), 50);
    log('quest chest first use then empty ok');
}

function testQuestChestCapFailNoStorage() {
    const { inst } = seedQuestChest({
        give: [{ item: 'anvil', count: 1 }],
        transformTo: undefined
    });
    const player = makeChestPlayer();
    const r = useWorldChest(player, inst, { itemDb: SEED_DB });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'not_enough_cap');
    assert.strictEqual(getStorage(player, 'quest.demo.chest'), 0);
    assert.strictEqual(countPlayerItem(player, 'anvil'), 0);
    assert.strictEqual(inst.itemId, 'wooden_chest');
    log('quest chest cap fail no storage ok');
}

function testQuestChestWhenItemGate() {
    const { inst } = seedQuestChest({
        give: [{ item: 'torch', count: 1 }],
        when: { item: 'gold_coin', min: 1 },
        transformTo: undefined
    });
    const player = makeChestPlayer();
    const denied = useWorldChest(player, inst, { itemDb: SEED_DB });
    assert.strictEqual(denied.ok, false);
    assert.strictEqual(denied.reason, 'empty');
    assert.strictEqual(countPlayerItem(player, 'torch'), 0);
    assert.strictEqual(getStorage(player, 'quest.demo.chest'), 0);
    assert.ok(giveItemToPlayer(player, { itemId: 'gold_coin', count: 1 }, SEED_DB).ok);
    const ok = useWorldChest(player, inst, { itemDb: SEED_DB });
    assert.strictEqual(ok.ok, true, ok.reason);
    assert.strictEqual(countPlayerItem(player, 'torch'), 1);
    assert.strictEqual(getStorage(player, 'quest.demo.chest'), 1);
    log('quest chest when.item gate ok');
}

function testQuestChestSharedLocksHunt() {
    const { inst } = seedQuestChest({ shared: true, transformTo: undefined });
    const a = makeChestPlayer({ id: 1, name: 'A' });
    const b = makeChestPlayer({ id: 2, name: 'B' });
    const first = useWorldChest(a, inst, { itemDb: SEED_DB });
    assert.strictEqual(first.ok, true, first.reason);
    assert.strictEqual(countPlayerItem(a, 'gold_coin'), 50);
    const second = useWorldChest(b, inst, { itemDb: SEED_DB });
    assert.strictEqual(second.ok, false);
    assert.strictEqual(second.reason, 'empty');
    assert.strictEqual(countPlayerItem(b, 'gold_coin'), 0);
    assert.strictEqual(getStorage(b, 'quest.demo.chest'), 0);
    log('quest chest shared locks hunt ok');
}

function testQuestChestPartialGiveRollback() {
    const { inst } = seedQuestChest({
        give: [
            { item: 'gold_coin', count: 2 },
            { item: 'anvil', count: 1 }
        ],
        transformTo: undefined
    });
    const player = makeChestPlayer();
    const r = useWorldChest(player, inst, { itemDb: SEED_DB });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'not_enough_cap');
    assert.strictEqual(countPlayerItem(player, 'gold_coin'), 0);
    assert.strictEqual(getStorage(player, 'quest.demo.chest'), 0);
    log('quest chest partial give rollback ok');
}

function makeFlatMap(cols, rows, z, blockedIndex) {
    const map = new TileMap();
    const friction = new Uint8Array(cols * rows);
    friction.fill(DEFAULT_OPEN_FRICTION);
    if (blockedIndex != null) friction[blockedIndex] = FRICTION_BLOCKED;
    map.loadFloorFromFriction(z, cols, rows, friction);
    return map;
}

function testApplyCellPatchAstar() {
    const map = makeFlatMap(3, 1, 0, 1);
    assert.strictEqual(
        map.search({ x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }, { allowDiagonal: false }),
        null
    );
    const r = applyCellPatch(map, { x: 1, y: 0, z: 0, friction: DEFAULT_OPEN_FRICTION });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.prev.friction, FRICTION_BLOCKED);
    const path = map.search(
        { x: 0, y: 0, z: 0 },
        { x: 2, y: 0, z: 0 },
        { allowDiagonal: false }
    );
    assert.ok(path && path.length >= 3);
    applyCellPatch(map, { x: 1, y: 0, z: 0, friction: FRICTION_BLOCKED });
    assert.strictEqual(
        map.search({ x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }, { allowDiagonal: false }),
        null
    );
    log('applyCellPatch A* ok');
}

function testNormalizeLeverAndDoor() {
    const lever = wp.normalizeWorldPin({
        id: 'lever_bridge',
        kind: 'lever',
        catalogId: 'stone_lever',
        tag: 'east_gate',
        x: 5,
        y: 8,
        z: 7,
        effects: [
            { type: 'cell', x: 12, y: 8, z: 7, friction: 100 },
            { type: 'door', id: 'oak_door_east', open: true }
        ]
    });
    assert.ok(lever);
    assert.deepStrictEqual(lever.states, ['off', 'on']);
    assert.strictEqual(lever.effects.length, 2);
    assert.strictEqual(lever.effects[0].friction, 100);
    assert.strictEqual(lever.effects[1].id, 'oak_door_east');
    assert.strictEqual(lever.effects[1].open, true);
    const door = wp.normalizeWorldPin({
        id: 'oak_door_east',
        kind: 'door',
        catalogId: 'oak_door',
        closedId: 'oak_door',
        openId: 'oak_door_open',
        x: 12,
        y: 8,
        z: 7
    });
    assert.strictEqual(door.blocking, true);
    assert.strictEqual(door.closedId, 'oak_door');
    const hits = wp.findWorldHits([{ floor: '07', world: [lever] }], {
        query: 'oak_door_east'
    });
    assert.strictEqual(hits.length, 1);
    log('normalize lever + door ok');
}

function seedLeverScene(opts) {
    const o = opts || {};
    const z = o.z != null ? o.z : 7;
    const map = makeFlatMap(3, 1, z, 1);
    const ground = createGroundStore();
    const pins = o.pins || [
        {
            id: 'lever_bridge',
            kind: 'lever',
            catalogId: 'stone_lever',
            x: 0,
            y: 0,
            z,
            effects: [
                { type: 'cell', x: 1, y: 0, z, friction: DEFAULT_OPEN_FRICTION }
            ]
        }
    ];
    seedWorldPinsOntoGround(ground, pins, { itemDb: SEED_DB, tileMap: map });
    return { ground, map, z };
}

function testLeverUsePatchesFrictionThenToggleBack() {
    const { ground, map } = seedLeverScene();
    const inst = getItem(
        ground.inventory,
        groundUidForWorldPin(ground, 'lever_bridge')
    );
    const player = makeChestPlayer();
    assert.strictEqual(map.getFriction(1, 0, 7), FRICTION_BLOCKED);
    assert.strictEqual(
        map.search({ x: 0, y: 0, z: 7 }, { x: 2, y: 0, z: 7 }, { allowDiagonal: false }),
        null
    );
    const first = useWorldLever(player, inst, {
        ground,
        tileMap: map,
        itemDb: SEED_DB
    });
    assert.strictEqual(first.ok, true, first.reason);
    assert.strictEqual(first.state, 'on');
    assert.strictEqual(map.getFriction(1, 0, 7), DEFAULT_OPEN_FRICTION);
    const path = map.search(
        { x: 0, y: 0, z: 7 },
        { x: 2, y: 0, z: 7 },
        { allowDiagonal: false }
    );
    assert.ok(path && path.length >= 3);
    const second = useWorldLever(player, inst, {
        ground,
        tileMap: map,
        itemDb: SEED_DB
    });
    assert.strictEqual(second.ok, true);
    assert.strictEqual(second.state, 'off');
    assert.strictEqual(map.getFriction(1, 0, 7), FRICTION_BLOCKED);
    assert.strictEqual(
        map.search({ x: 0, y: 0, z: 7 }, { x: 2, y: 0, z: 7 }, { allowDiagonal: false }),
        null
    );
    log('lever use patches friction then toggle back ok');
}

function testDoorUseTogglesBlocking() {
    const z = 7;
    const map = makeFlatMap(3, 1, z, null);
    const ground = createGroundStore();
    seedWorldPinsOntoGround(
        ground,
        [
            {
                id: 'oak_door_east',
                kind: 'door',
                catalogId: 'oak_door',
                closedId: 'oak_door',
                openId: 'oak_door_open',
                x: 1,
                y: 0,
                z,
                blocking: true
            }
        ],
        { itemDb: SEED_DB, tileMap: map }
    );
    const inst = getItem(
        ground.inventory,
        groundUidForWorldPin(ground, 'oak_door_east')
    );
    const player = makeChestPlayer();
    assert.strictEqual(map.getFriction(1, 0, z), FRICTION_BLOCKED);
    const open = useWorldDoor(player, inst, { tileMap: map, itemDb: SEED_DB });
    assert.strictEqual(open.ok, true, open.reason);
    assert.strictEqual(open.open, true);
    assert.strictEqual(map.getFriction(1, 0, z), DEFAULT_OPEN_FRICTION);
    assert.strictEqual(inst.itemId, 'oak_door_open');
    const path = map.search(
        { x: 0, y: 0, z },
        { x: 2, y: 0, z },
        { allowDiagonal: false }
    );
    assert.ok(path && path.length >= 3);
    const close = useWorldDoor(player, inst, { tileMap: map, itemDb: SEED_DB });
    assert.strictEqual(close.open, false);
    assert.strictEqual(map.getFriction(1, 0, z), FRICTION_BLOCKED);
    assert.strictEqual(inst.itemId, 'oak_door');
    log('door use toggles blocking ok');
}

function testLeverOpensDoorById() {
    const z = 7;
    const map = makeFlatMap(3, 1, z, null);
    const ground = createGroundStore();
    seedWorldPinsOntoGround(
        ground,
        [
            {
                id: 'lever_bridge',
                kind: 'lever',
                catalogId: 'stone_lever',
                x: 0,
                y: 0,
                z,
                effects: [{ type: 'door', id: 'oak_door_east', open: true }]
            },
            {
                id: 'oak_door_east',
                kind: 'door',
                catalogId: 'oak_door',
                closedId: 'oak_door',
                openId: 'oak_door_open',
                x: 1,
                y: 0,
                z,
                blocking: true
            }
        ],
        { itemDb: SEED_DB, tileMap: map }
    );
    const lever = getItem(
        ground.inventory,
        groundUidForWorldPin(ground, 'lever_bridge')
    );
    const door = getItem(
        ground.inventory,
        groundUidForWorldPin(ground, 'oak_door_east')
    );
    const player = makeChestPlayer();
    assert.strictEqual(map.getFriction(1, 0, z), FRICTION_BLOCKED);
    useWorldLever(player, lever, { ground, tileMap: map, itemDb: SEED_DB });
    assert.strictEqual(door.worldPinDoorOpen, true);
    assert.strictEqual(map.getFriction(1, 0, z), DEFAULT_OPEN_FRICTION);
    assert.strictEqual(door.itemId, 'oak_door_open');
    useWorldLever(player, lever, { ground, tileMap: map, itemDb: SEED_DB });
    assert.strictEqual(door.worldPinDoorOpen, false);
    assert.strictEqual(map.getFriction(1, 0, z), FRICTION_BLOCKED);
    log('lever opens door by id ok');
}

function testLeverTagSharesEffects() {
    const { ground, map } = seedLeverScene({
        pins: [
            {
                id: 'lever_a',
                kind: 'lever',
                tag: 'east_gate',
                catalogId: 'stone_lever',
                x: 0,
                y: 0,
                z: 7,
                effects: [
                    { type: 'cell', x: 1, y: 0, z: 7, friction: DEFAULT_OPEN_FRICTION }
                ]
            },
            {
                id: 'lever_b',
                kind: 'lever',
                tag: 'east_gate',
                catalogId: 'stone_lever',
                x: 2,
                y: 0,
                z: 7
            }
        ]
    });
    const b = getItem(ground.inventory, groundUidForWorldPin(ground, 'lever_b'));
    const a = getItem(ground.inventory, groundUidForWorldPin(ground, 'lever_a'));
    const player = makeChestPlayer();
    const r = useWorldLever(player, b, { ground, tileMap: map, itemDb: SEED_DB });
    assert.strictEqual(r.ok, true, r.reason);
    assert.strictEqual(map.getFriction(1, 0, 7), DEFAULT_OPEN_FRICTION);
    assert.strictEqual(a.worldPinState, 'on');
    assert.strictEqual(b.worldPinState, 'on');
    log('lever tag shares effects ok');
}

function testGatedDoorUseLocked() {
    const z = 7;
    const map = makeFlatMap(3, 1, z, null);
    const ground = createGroundStore();
    seedWorldPinsOntoGround(
        ground,
        [
            {
                id: 'oak_door_east',
                kind: 'door',
                catalogId: 'oak_door',
                x: 1,
                y: 0,
                z,
                blocking: true,
                lockId: 'silver_key'
            }
        ],
        { itemDb: SEED_DB, tileMap: map }
    );
    const inst = getItem(
        ground.inventory,
        groundUidForWorldPin(ground, 'oak_door_east')
    );
    const r = useWorldDoor(makeChestPlayer(), inst, {
        tileMap: map,
        itemDb: SEED_DB
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'locked');
    assert.strictEqual(r.text, DOOR_LOCKED_TEXT);
    assert.strictEqual(map.getFriction(1, 0, z), FRICTION_BLOCKED);
    log('gated door use locked ok');
}

function seedDoorScene(extra) {
    const z = 7;
    const map = makeFlatMap(3, 1, z, null);
    const ground = createGroundStore();
    const pin = Object.assign(
        {
            id: 'oak_door_east',
            kind: 'door',
            catalogId: 'oak_door',
            closedId: 'oak_door',
            openId: 'oak_door_open',
            x: 1,
            y: 0,
            z,
            blocking: true
        },
        extra || {}
    );
    seedWorldPinsOntoGround(ground, [pin], { itemDb: SEED_DB, tileMap: map });
    const inst = getItem(
        ground.inventory,
        groundUidForWorldPin(ground, pin.id)
    );
    return { ground, map, z, inst, pin: wp.normalizeWorldPin(pin) };
}

function testNormalizeGatedDoorAndTeleport() {
    const door = wp.normalizeWorldPin({
        id: 'oak_door_east',
        kind: 'door',
        catalogId: 'oak_door',
        x: 1,
        y: 0,
        z: 7,
        lockId: 'silver_key',
        consume: true,
        gate: {
            when: { storage: 'quest.demo.door', equals: 1 },
            level: 20
        }
    });
    assert.strictEqual(door.lockId, 'silver_key');
    assert.strictEqual(door.consume, true);
    assert.deepStrictEqual(door.gate.when, {
        storage: 'quest.demo.door',
        eq: 1
    });
    assert.strictEqual(door.gate.level, 20);
    const bare = wp.normalizeWorldPin({
        id: 'oak_door_bare',
        kind: 'door',
        catalogId: 'oak_door',
        x: 2,
        y: 0,
        z: 7,
        gate: { storage: 'quest.demo.door', eq: 1 }
    });
    assert.deepStrictEqual(bare.gate, {
        when: { storage: 'quest.demo.door', eq: 1 }
    });
    const pad = wp.normalizeWorldPin({
        id: 'pad_to_crypt',
        kind: 'teleport',
        catalogId: 'magic_pad',
        x: 3,
        y: 3,
        z: 7,
        to: { x: 40.4, y: 12, z: 8 }
    });
    assert.deepStrictEqual(pad.to, { x: 40, y: 12, z: 8 });
    const hits = wp.findWorldHits([{ floor: '07', world: [door] }], {
        query: 'silver_key'
    });
    assert.strictEqual(hits.length, 1);
    log('normalize gated door + teleport ok');
}

function testKeyDoorRequireThenConsume() {
    const { inst, map, z } = seedDoorScene({ lockId: 'silver_key' });
    const player = makeChestPlayer();
    const denied = useWorldDoor(player, inst, { tileMap: map, itemDb: SEED_DB });
    assert.strictEqual(denied.ok, false);
    assert.strictEqual(denied.reason, 'locked');
    assert.ok(giveItemToPlayer(player, { itemId: 'silver_key', count: 1 }, SEED_DB).ok);
    const open = useWorldDoor(player, inst, { tileMap: map, itemDb: SEED_DB });
    assert.strictEqual(open.ok, true, open.reason);
    assert.strictEqual(open.open, true);
    assert.strictEqual(countPlayerItem(player, 'silver_key'), 1);
    assert.strictEqual(map.getFriction(1, 0, z), DEFAULT_OPEN_FRICTION);
    useWorldDoor(player, inst, { tileMap: map, itemDb: SEED_DB });
    assert.strictEqual(inst.worldPinDoorOpen, false);
    const { inst: consumeInst, map: consumeMap } = seedDoorScene({
        id: 'oak_door_consume',
        lockId: 'silver_key',
        consume: true
    });
    const spender = makeChestPlayer({ id: 2 });
    assert.ok(
        giveItemToPlayer(spender, { itemId: 'silver_key', count: 1 }, SEED_DB).ok
    );
    const first = useWorldDoor(spender, consumeInst, {
        tileMap: consumeMap,
        itemDb: SEED_DB
    });
    assert.strictEqual(first.ok, true, first.reason);
    assert.strictEqual(countPlayerItem(spender, 'silver_key'), 0);
    assert.strictEqual(consumeInst.worldPinUnlocked, true);
    useWorldDoor(spender, consumeInst, {
        tileMap: consumeMap,
        itemDb: SEED_DB
    });
    const reopen = useWorldDoor(spender, consumeInst, {
        tileMap: consumeMap,
        itemDb: SEED_DB
    });
    assert.strictEqual(reopen.ok, true, reopen.reason);
    assert.strictEqual(reopen.open, true);
    log('key door require then consume ok');
}

function testQuestAndLevelDoor() {
    const { inst, map } = seedDoorScene({
        gate: { when: { storage: 'quest.demo.door', equals: 1 } }
    });
    const player = makeChestPlayer();
    const denied = useWorldDoor(player, inst, { tileMap: map, itemDb: SEED_DB });
    assert.strictEqual(denied.ok, false);
    assert.strictEqual(denied.reason, 'cannot_pass');
    assert.strictEqual(denied.text, DOOR_CANNOT_PASS_TEXT);
    player.storage['quest.demo.door'] = 1;
    const ok = useWorldDoor(player, inst, { tileMap: map, itemDb: SEED_DB });
    assert.strictEqual(ok.ok, true, ok.reason);
    assert.strictEqual(ok.open, true);

    const { inst: lvlInst, map: lvlMap } = seedDoorScene({
        id: 'oak_door_level',
        gate: { level: 20 }
    });
    const low = makeChestPlayer({ id: 3, level: 8 });
    const lowDenied = useWorldDoor(low, lvlInst, {
        tileMap: lvlMap,
        itemDb: SEED_DB
    });
    assert.strictEqual(lowDenied.ok, false);
    assert.strictEqual(lowDenied.reason, 'cannot_pass');
    const high = makeChestPlayer({ id: 4, level: 20 });
    const highOk = useWorldDoor(high, lvlInst, {
        tileMap: lvlMap,
        itemDb: SEED_DB
    });
    assert.strictEqual(highOk.ok, true, highOk.reason);
    log('quest and level door ok');
}

function makeTwoFloorMap() {
    const map = new TileMap();
    const a = new Uint8Array(9);
    a.fill(DEFAULT_OPEN_FRICTION);
    const b = new Uint8Array(9);
    b.fill(DEFAULT_OPEN_FRICTION);
    map.loadFloorFromFriction(7, 3, 3, a);
    map.loadFloorFromFriction(8, 3, 3, b);
    return map;
}

function testTeleportUseHopsSameHuntFloor() {
    const map = makeTwoFloorMap();
    const ground = createGroundStore();
    seedWorldPinsOntoGround(
        ground,
        [
            {
                id: 'pad_to_crypt',
                kind: 'teleport',
                catalogId: 'magic_pad',
                x: 0,
                y: 0,
                z: 7,
                to: { x: 2, y: 2, z: 8 }
            }
        ],
        { itemDb: SEED_DB, tileMap: map }
    );
    const inst = getItem(
        ground.inventory,
        groundUidForWorldPin(ground, 'pad_to_crypt')
    );
    const player = makeChestPlayer({
        id: 7,
        tile: { x: 0, y: 0, z: 7 }
    });
    player.path = [{ x: 1, y: 0, z: 7 }];
    assert.ok(map.tryOccupy(0, 0, 7, player));
    const r = useWorldTeleport(player, inst, { tileMap: map });
    assert.strictEqual(r.ok, true, r.reason);
    assert.strictEqual(player.tile.x, 2);
    assert.strictEqual(player.tile.y, 2);
    assert.strictEqual(String(player.tile.z), '8');
    assert.strictEqual(map.getOccupant(0, 0, 7), 0);
    assert.strictEqual(map.getOccupant(2, 2, 8), 7);
    assert.deepStrictEqual(player.path, []);
    assert.ok(!worldPinInstAtDest(ground, 2, 2, 8));
    log('teleport use hops same-hunt floor ok');
}

function worldPinInstAtDest(ground, x, y, z) {
    const stack = getStack(ground, x, y, z);
    for (let i = 0; i < stack.length; i++) {
        const inst = getItem(ground.inventory, stack[i]);
        if (inst && inst.worldPinKind === 'teleport') return inst;
    }
    return null;
}

function testTeleportMissingFloorAndBlocked() {
    const one = makeFlatMap(3, 3, 7, null);
    const ground = createGroundStore();
    seedWorldPinsOntoGround(
        ground,
        [
            {
                id: 'pad_to_crypt',
                kind: 'teleport',
                catalogId: 'magic_pad',
                x: 0,
                y: 0,
                z: 7,
                to: { x: 1, y: 1, z: 8 }
            }
        ],
        { itemDb: SEED_DB, tileMap: one }
    );
    const inst = getItem(
        ground.inventory,
        groundUidForWorldPin(ground, 'pad_to_crypt')
    );
    const player = makeChestPlayer({ id: 7, tile: { x: 0, y: 0, z: 7 } });
    assert.ok(one.tryOccupy(0, 0, 7, player));
    const missing = useWorldTeleport(player, inst, { tileMap: one });
    assert.strictEqual(missing.ok, false);
    assert.strictEqual(missing.reason, 'no_dest');
    assert.strictEqual(missing.text, TELEPORT_NO_DEST_TEXT);
    assert.strictEqual(String(player.tile.z), '7');

    const two = makeTwoFloorMap();
    applyCellPatch(two, { x: 2, y: 2, z: 8, friction: FRICTION_BLOCKED });
    inst.worldPinTo = { x: 2, y: 2, z: 8 };
    const blocked = useWorldTeleport(player, inst, { tileMap: two });
    assert.strictEqual(blocked.ok, false);
    assert.strictEqual(blocked.reason, 'blocked');
    assert.strictEqual(blocked.text, TELEPORT_NO_WAY_TEXT);
    assert.strictEqual(String(player.tile.z), '7');
    log('teleport missing floor and blocked ok');
}

function testNormalizeTransformAndDecay() {
    const lever = wp.normalizeWorldPin({
        id: 'lever_bridge',
        kind: 'lever',
        catalogId: 'stone_lever',
        x: 0,
        y: 0,
        z: 7,
        transformOnUse: 'stone_lever_on',
        decay: { sec: 12, to: 'rubble' }
    });
    assert.strictEqual(lever.transformOnUse, 'stone_lever_on');
    assert.deepStrictEqual(lever.decay, { sec: 12, to: 'rubble' });
    const arr = wp.normalizeWorldPin({
        id: 'lever_arr',
        kind: 'lever',
        catalogId: 'stone_lever',
        x: 1,
        y: 0,
        z: 7,
        transformOnUse: ['stone_lever', 'stone_lever_on']
    });
    assert.deepStrictEqual(arr.transformOnUse, ['stone_lever', 'stone_lever_on']);
    const chest = wp.normalizeWorldPin({
        id: 'quest_chest_east',
        kind: 'chest',
        catalogId: 'wooden_chest',
        x: 2,
        y: 0,
        z: 7,
        transformOnUse: 'wooden_chest_open'
    });
    assert.strictEqual(chest.transformTo, 'wooden_chest_open');
    assert.ok(!chest.transformOnUse);
    const ticks = wp.normalizeWorldPin({
        id: 'bridge_plank',
        kind: 'container',
        catalogId: 'crate',
        x: 3,
        y: 0,
        z: 7,
        decay: { ticks: 4 }
    });
    assert.deepStrictEqual(ticks.decay, { sec: 4 });
    const hits = wp.findWorldHits([{ floor: '07', world: [lever] }], {
        query: 'rubble'
    });
    assert.strictEqual(hits.length, 1);
    log('normalize transformOnUse + decay ok');
}

function testLeverTransformOnUseSwapsArt() {
    const { ground, map } = seedLeverScene({
        pins: [
            {
                id: 'lever_bridge',
                kind: 'lever',
                catalogId: 'stone_lever',
                x: 0,
                y: 0,
                z: 7,
                transformOnUse: 'stone_lever_on',
                effects: [
                    { type: 'cell', x: 1, y: 0, z: 7, friction: DEFAULT_OPEN_FRICTION }
                ]
            }
        ]
    });
    const inst = getItem(
        ground.inventory,
        groundUidForWorldPin(ground, 'lever_bridge')
    );
    const player = makeChestPlayer();
    const first = useWorldLever(player, inst, {
        ground,
        tileMap: map,
        itemDb: SEED_DB
    });
    assert.strictEqual(first.ok, true, first.reason);
    assert.strictEqual(inst.itemId, 'stone_lever_on');
    const second = useWorldLever(player, inst, {
        ground,
        tileMap: map,
        itemDb: SEED_DB
    });
    assert.strictEqual(second.ok, true);
    assert.strictEqual(inst.itemId, 'stone_lever');
    log('lever transformOnUse swaps art ok');
}

function testDecayTransformThenRemove() {
    const z = 7;
    const map = makeFlatMap(3, 1, z, null);
    const ground = createGroundStore();
    seedWorldPinsOntoGround(
        ground,
        [
            {
                id: 'bridge_plank',
                kind: 'door',
                catalogId: 'oak_door',
                x: 1,
                y: 0,
                z,
                blocking: true,
                decay: { sec: 5, to: 'rubble' }
            },
            {
                id: 'crumb_crate',
                kind: 'container',
                catalogId: 'crate',
                x: 0,
                y: 0,
                z,
                blocking: true,
                pickupable: false,
                decay: { sec: 5 }
            }
        ],
        { itemDb: SEED_DB, tileMap: map }
    );
    const plank = getItem(
        ground.inventory,
        groundUidForWorldPin(ground, 'bridge_plank')
    );
    assert.strictEqual(map.getFriction(1, 0, z), FRICTION_BLOCKED);
    assert.strictEqual(map.getFriction(0, 0, z), FRICTION_BLOCKED);
    assert.strictEqual(tickWorldPinDecay(ground, 0, { tileMap: map, itemDb: SEED_DB }), 0);
    assert.strictEqual(plank.itemId, 'oak_door');
    assert.strictEqual(tickWorldPinDecay(ground, 5, { tileMap: map, itemDb: SEED_DB }), 2);
    assert.strictEqual(plank.itemId, 'rubble');
    assert.strictEqual(groundUidForWorldPin(ground, 'crumb_crate'), null);
    assert.strictEqual(map.getFriction(0, 0, z), DEFAULT_OPEN_FRICTION);
    assert.strictEqual(map.getFriction(1, 0, z), FRICTION_BLOCKED);
    log('decay transform then remove ok');
}

function giveTool(player, id) {
    assert.ok(giveItemToPlayer(player, { itemId: id, count: 1 }, SEED_DB).ok);
}

function makeThreeFloorMap() {
    const map = new TileMap();
    for (let z = 6; z <= 8; z++) {
        const a = new Uint8Array(9);
        a.fill(DEFAULT_OPEN_FRICTION);
        map.loadFloorFromFriction(z, 3, 3, a);
    }
    return map;
}

function testRopeShovelUseWithHop() {
    assert.strictEqual(resolveToolRole('rope'), 'rope');
    assert.strictEqual(resolveToolRole('elven_rope'), 'rope');
    assert.strictEqual(resolveToolRole('shovel_iron'), 'shovel');
    assert.strictEqual(resolveToolRole('torch'), null);
    const map = makeThreeFloorMap();
    map.setTileFlags(0, 0, 7, TILE_FLAG_ROPE_SPOT);
    map.setTileFlags(2, 2, 7, TILE_FLAG_SHOVEL_SPOT);
    const ground = createGroundStore();
    const player = makeChestPlayer({
        id: 11,
        tile: { x: 0, y: 0, z: 7 }
    });
    assert.ok(map.tryOccupy(0, 0, 7, player));
    const noItem = useWorldToolWith(
        player,
        { itemId: 'rope', x: 0, y: 0, z: 7 },
        { tileMap: map, ground, itemDb: SEED_DB }
    );
    assert.strictEqual(noItem.ok, false);
    assert.strictEqual(noItem.reason, 'no_item');
    giveTool(player, 'rope');
    giveTool(player, 'shovel');
    const miss = useWorldToolWith(
        player,
        { itemId: 'rope', x: 1, y: 1, z: 7 },
        { tileMap: map, ground, itemDb: SEED_DB }
    );
    assert.strictEqual(miss.ok, false);
    assert.strictEqual(miss.reason, 'no_spot');
    const hop = useWorldToolWith(
        player,
        { itemId: 'rope', x: 0, y: 0, z: 7 },
        { tileMap: map, ground, itemDb: SEED_DB }
    );
    assert.strictEqual(hop.ok, true, hop.reason);
    assert.strictEqual(player.tile.x, 0);
    assert.strictEqual(player.tile.y, 0);
    assert.strictEqual(String(player.tile.z), '6');
    assert.strictEqual(countPlayerItem(player, 'rope'), 1);
    const digger = makeChestPlayer({ id: 14, tile: { x: 2, y: 2, z: 7 } });
    giveTool(digger, 'shovel');
    assert.ok(map.tryOccupy(2, 2, 7, digger));
    const down = useWorldToolWith(
        digger,
        { itemId: 'shovel', x: 2, y: 2, z: 7 },
        { tileMap: map, ground, itemDb: SEED_DB }
    );
    assert.strictEqual(down.ok, true, down.reason);
    assert.strictEqual(String(digger.tile.z), '8');
    assert.strictEqual(countPlayerItem(digger, 'shovel'), 1);
    map.setTileFlags(1, 0, 7, TILE_FLAG_ROPE_SPOT);
    const climber = makeChestPlayer({ id: 15, tile: { x: 1, y: 0, z: 7 } });
    giveTool(climber, 'elven_rope');
    assert.ok(map.tryOccupy(1, 0, 7, climber));
    const variant = useWorldToolWith(
        climber,
        { itemId: 'elven_rope', x: 1, y: 0, z: 7 },
        { tileMap: map, ground, itemDb: SEED_DB }
    );
    assert.strictEqual(variant.ok, true, variant.reason);
    assert.strictEqual(String(climber.tile.z), '6');
    assert.strictEqual(countPlayerItem(climber, 'elven_rope'), 1);
    log('rope shovel use-with hop ok');
}

function testRopeMissingDestAndTagSpot() {
    const one = makeFlatMap(3, 3, 7, null);
    one.setTileFlags(0, 0, 7, TILE_FLAG_ROPE_SPOT);
    const player = makeChestPlayer({ id: 12, tile: { x: 0, y: 0, z: 7 } });
    giveTool(player, 'rope');
    assert.ok(one.tryOccupy(0, 0, 7, player));
    const missing = useWorldToolWith(
        player,
        { itemId: 'rope', x: 0, y: 0, z: 7 },
        { tileMap: one, itemDb: SEED_DB }
    );
    assert.strictEqual(missing.ok, false);
    assert.strictEqual(missing.reason, 'no_dest');
    assert.strictEqual(missing.text, TELEPORT_NO_DEST_TEXT);

    const map = makeTwoFloorMap();
    const ground = createGroundStore();
    seedWorldPinsOntoGround(
        ground,
        [
            {
                id: 'rope_tag',
                kind: 'teleport',
                catalogId: 'magic_pad',
                tag: 'rope',
                x: 1,
                y: 1,
                z: 7,
                to: { x: 2, y: 2, z: 8 }
            }
        ],
        { itemDb: SEED_DB, tileMap: map }
    );
    const tagged = makeChestPlayer({ id: 13, tile: { x: 1, y: 1, z: 7 } });
    giveTool(tagged, 'rope');
    assert.ok(map.tryOccupy(1, 1, 7, tagged));
    const hop = useWorldToolWith(
        tagged,
        { itemId: 'rope', x: 1, y: 1, z: 7 },
        { tileMap: map, ground, itemDb: SEED_DB }
    );
    assert.strictEqual(hop.ok, true, hop.reason);
    assert.strictEqual(tagged.tile.x, 2);
    assert.strictEqual(tagged.tile.y, 2);
    assert.strictEqual(String(tagged.tile.z), '8');
    assert.strictEqual(TELEPORT_CANNOT_TEXT, 'You cannot use this object.');
    log('rope missing dest and tag spot ok');
}

function testNormalizeW6EffectsAndPins() {
    const lever = wp.normalizeWorldPin({
        id: 'start_lever',
        kind: 'lever',
        catalogId: 'stone_lever',
        x: 0,
        y: 0,
        z: 7,
        when: { storage: 'quest.room', eq: 1 },
        effects: [
            { type: 'spawn', creatureId: 'rat', x: 2, y: 1, z: 7, count: 2, respawn: 12 },
            { type: 'wave', id: 'w1' },
            { type: 'unlock', id: 'oak_door_east' }
        ]
    });
    assert.ok(lever.when);
    assert.strictEqual(lever.effects.length, 2);
    assert.strictEqual(lever.effects[0].type, 'spawn');
    assert.strictEqual(lever.effects[0].creatureId, 'rat');
    assert.strictEqual(lever.effects[0].count, 2);
    assert.strictEqual(lever.effects[0].respawn, 12);
    assert.strictEqual(lever.effects[1].type, 'unlock');
    assert.strictEqual(lever.effects[1].id, 'oak_door_east');
    const waveFirst = wp.normalizeLeverEffects([
        { type: 'wave', id: 'w1' },
        { type: 'spawn', creatureId: 'rat', x: 1, y: 1, z: 7 }
    ]);
    assert.strictEqual(waveFirst.length, 1);
    assert.strictEqual(waveFirst[0].type, 'wave');
    assert.strictEqual(waveFirst[0].id, 'w1');
    const harvest = wp.normalizeWorldPin({
        id: 'bush_1',
        kind: 'harvest',
        catalogId: 'bush',
        x: 3,
        y: 3,
        z: 7,
        give: [{ item: 'blueberry', count: 3 }],
        transformTo: 'bush_empty',
        cooldown: 30,
        once: { storage: 'harvest.bush_1', eq: 0 },
        set: { 'harvest.bush_1': 1 }
    });
    assert.strictEqual(harvest.cooldown, 30);
    assert.strictEqual(harvest.give[0].item, 'blueberry');
    const trap = wp.normalizeWorldPin({
        id: 'spike_1',
        kind: 'trap',
        catalogId: 'spike_trap',
        x: 4,
        y: 4,
        z: 7,
        damage: 20,
        field: 'fire',
        cooldown: 5
    });
    assert.strictEqual(trap.damage, 20);
    assert.strictEqual(trap.field, 'fire');
    const hits = wp.findWorldHits([{ floor: '07', world: [lever] }], {
        query: 'rat'
    });
    assert.strictEqual(hits.length, 1);
    log('normalize W6 effects + pins ok');
}

function testLeverWhenGate() {
    const { ground, map } = seedLeverScene();
    const inst = getItem(
        ground.inventory,
        groundUidForWorldPin(ground, 'lever_bridge')
    );
    inst.worldPinWhen = { storage: 'quest.room', eq: 1 };
    const denied = useWorldLever(makeChestPlayer(), inst, {
        ground,
        tileMap: map,
        itemDb: SEED_DB
    });
    assert.strictEqual(denied.ok, false);
    assert.strictEqual(denied.reason, 'when');
    const okPlayer = makeChestPlayer({ storage: { 'quest.room': 1 } });
    const ok = useWorldLever(okPlayer, inst, {
        ground,
        tileMap: map,
        itemDb: SEED_DB
    });
    assert.strictEqual(ok.ok, true, ok.reason);
    log('lever when gate ok');
}

function testLeverSpawnEffect() {
    const { ground, map } = seedLeverScene({
        pins: [
            {
                id: 'lever_spawn',
                kind: 'lever',
                catalogId: 'stone_lever',
                x: 0,
                y: 0,
                z: 7,
                effects: [
                    {
                        type: 'spawn',
                        creatureId: 'rat',
                        x: 2,
                        y: 0,
                        z: 7,
                        count: 2
                    }
                ]
            }
        ]
    });
    const inst = getItem(
        ground.inventory,
        groundUidForWorldPin(ground, 'lever_spawn')
    );
    const sm = new SpawnManager({ mode: 'eager' });
    const living = new Map();
    let nid = 1;
    useWorldLever(makeChestPlayer(), inst, {
        ground,
        tileMap: map,
        itemDb: SEED_DB,
        spawnManager: sm,
        tickSpawn() {
            sm.tick({
                time: 1,
                observers: [],
                getEntity: (id) => living.get(id) || null,
                spawn(state) {
                    const e = {
                        id: nid++,
                        alive: true,
                        hp: { current: 10, max: 10 },
                        tile: { x: state.x, y: state.y, z: state.z },
                        creatureId: state.creatureId
                    };
                    living.set(e.id, e);
                    return e;
                }
            });
        }
    });
    assert.strictEqual(sm.size, 2);
    assert.strictEqual(sm.livingCount, 2);
    log('lever spawn effect ok');
}

function testLeverWaveUnlock() {
    const cfg = normalizeWavesConfig({
        holdUntilUnlock: true,
        list: [{ id: 'w1', entries: [{ creatureId: 'rat', count: 1 }] }]
    });
    assert.strictEqual(cfg.holdUntilUnlock, true);
    const wc = new WaveController(cfg);
    wc.begin(0);
    assert.strictEqual(wc.phase, 'waiting');
    assert.strictEqual(wc.readyAt, Infinity);
    const held = wc.tick({ time: 10, waveClear: false, tileMap: null });
    assert.strictEqual(held.spawnRows, null);
    const { ground, map } = seedLeverScene({
        pins: [
            {
                id: 'lever_wave',
                kind: 'lever',
                catalogId: 'stone_lever',
                x: 0,
                y: 0,
                z: 7,
                effects: [{ type: 'wave' }]
            }
        ]
    });
    const inst = getItem(
        ground.inventory,
        groundUidForWorldPin(ground, 'lever_wave')
    );
    const r = useWorldLever(makeChestPlayer(), inst, {
        ground,
        tileMap: map,
        itemDb: SEED_DB,
        waveController: wc,
        time: 10
    });
    assert.strictEqual(r.ok, true, r.reason);
    assert.strictEqual(wc.readyAt, 10);
    const go = wc.tick({ time: 10, waveClear: false, tileMap: null });
    assert.ok(go.spawnRows);
    assert.strictEqual(wc.phase, 'active');
    log('lever wave unlock ok');
}

function testLeverUnlockDoor() {
    const z = 7;
    const map = makeFlatMap(3, 1, z, null);
    const ground = createGroundStore();
    seedWorldPinsOntoGround(
        ground,
        [
            {
                id: 'lever_unlock',
                kind: 'lever',
                catalogId: 'stone_lever',
                x: 0,
                y: 0,
                z,
                effects: [{ type: 'unlock', id: 'oak_door_east' }]
            },
            {
                id: 'oak_door_east',
                kind: 'door',
                catalogId: 'oak_door',
                x: 1,
                y: 0,
                z,
                blocking: true,
                lockId: 'silver_key'
            }
        ],
        { itemDb: SEED_DB, tileMap: map }
    );
    const lever = getItem(
        ground.inventory,
        groundUidForWorldPin(ground, 'lever_unlock')
    );
    const door = getItem(
        ground.inventory,
        groundUidForWorldPin(ground, 'oak_door_east')
    );
    const player = makeChestPlayer();
    const locked = useWorldDoor(player, door, { tileMap: map, itemDb: SEED_DB });
    assert.strictEqual(locked.ok, false);
    useWorldLever(player, lever, { ground, tileMap: map, itemDb: SEED_DB });
    assert.strictEqual(door.worldPinUnlocked, true);
    const opened = useWorldDoor(player, door, { tileMap: map, itemDb: SEED_DB });
    assert.strictEqual(opened.ok, true, opened.reason);
    log('lever unlock door ok');
}

function testHarvestGiveThenCooldown() {
    const ground = createGroundStore();
    seedWorldPinsOntoGround(
        ground,
        [
            {
                id: 'bush_1',
                kind: 'harvest',
                catalogId: 'bush',
                x: 1,
                y: 1,
                z: 0,
                give: [{ item: 'blueberry', count: 2 }],
                transformTo: 'bush_empty',
                cooldown: 10,
                once: { storage: 'harvest.bush_1', eq: 0 },
                set: { 'harvest.bush_1': 1 }
            }
        ],
        { itemDb: SEED_DB }
    );
    const inst = getItem(ground.inventory, groundUidForWorldPin(ground, 'bush_1'));
    const player = makeChestPlayer();
    const first = useWorldHarvest(player, inst, { itemDb: SEED_DB, time: 0 });
    assert.strictEqual(first.ok, true, first.reason);
    assert.strictEqual(countPlayerItem(player, 'blueberry'), 2);
    assert.strictEqual(getStorage(player, 'harvest.bush_1'), 1);
    assert.strictEqual(inst.itemId, 'bush_empty');
    const second = useWorldHarvest(player, inst, { itemDb: SEED_DB, time: 5 });
    assert.strictEqual(second.ok, false);
    assert.strictEqual(second.text, DEFAULT_HARVEST_EMPTY_TEXT);
    assert.strictEqual(tickWorldPinHarvest(ground, 10, { itemDb: SEED_DB }), 1);
    assert.strictEqual(inst.itemId, 'bush');
    assert.strictEqual(inst.worldPinUsed, false);
    const other = makeChestPlayer({ id: 2 });
    const again = useWorldHarvest(other, inst, { itemDb: SEED_DB, time: 11 });
    assert.strictEqual(again.ok, true, again.reason);
    log('harvest give then cooldown ok');
}

function testHarvestToolDigNoHop() {
    assert.strictEqual(resolveToolRole('pick'), null);
    const ground = createGroundStore();
    seedWorldPinsOntoGround(
        ground,
        [
            {
                id: 'harvest_7_99_195',
                kind: 'harvest',
                catalogId: 'abandoned_meteor_rock',
                catalogKind: 'objects',
                x: 1,
                y: 1,
                z: 0,
                shared: false,
                when: { item: 'shovel', min: 1 },
                once: { storage: 'firstlight.morris.amulet', eq: 1 },
                give: [{ item: 'strange_amulet', count: 1 }],
                set: { 'firstlight.morris.amulet': 2 }
            }
        ],
        { itemDb: SEED_DB }
    );
    const inst = getItem(
        ground.inventory,
        groundUidForWorldPin(ground, 'harvest_7_99_195')
    );
    const player = makeChestPlayer({
        storage: { 'firstlight.morris.amulet': 1 }
    });
    const noTool = useWorldHarvest(player, inst, { itemDb: SEED_DB, time: 0 });
    assert.strictEqual(noTool.ok, false);
    assert.strictEqual(noTool.text, DEFAULT_HARVEST_EMPTY_TEXT);
    assert.ok(giveItemToPlayer(player, { itemId: 'shovel', count: 1 }, SEED_DB).ok);
    const dug = useWorldHarvest(player, inst, { itemDb: SEED_DB, time: 0 });
    assert.strictEqual(dug.ok, true, dug.reason);
    assert.strictEqual(countPlayerItem(player, 'strange_amulet'), 1);
    assert.strictEqual(countPlayerItem(player, 'shovel'), 1, 'shovel is not consumed');
    assert.strictEqual(getStorage(player, 'firstlight.morris.amulet'), 2);
    assert.ok(!inst.worldPinUsed, 'shared false does not lock the hunt');
    const again = useWorldHarvest(player, inst, { itemDb: SEED_DB, time: 1 });
    assert.strictEqual(again.ok, false);
    const other = makeChestPlayer({
        id: 3,
        storage: { 'firstlight.morris.amulet': 1 }
    });
    assert.ok(giveItemToPlayer(other, { itemId: 'shovel', count: 1 }, SEED_DB).ok);
    const otherDig = useWorldHarvest(other, inst, { itemDb: SEED_DB, time: 1 });
    assert.strictEqual(otherDig.ok, true, otherDig.reason);
    log('harvest tool dig no hop ok');
}

function testFirstlightAmuletHarvestPin() {
    const mapsRoot = path.join(__dirname, '..', 'assets', 'legacy', 'maps', 'firstlight_isle');
    const pack = tryResolveHybridMapPack(['07'], { mapsRoot, id: 'firstlight_isle' });
    assert.ok(pack && Array.isArray(pack.world), 'firstlight hybrid world');
    const pin = pack.world.find((row) => row && row.id === 'harvest_7_99_195');
    assert.ok(pin, 'south-beach harvest pin');
    assert.strictEqual(pin.kind, 'harvest');
    assert.strictEqual(pin.shared, false);
    assert.strictEqual(pin.x, 99);
    assert.strictEqual(pin.y, 195);
    assert.strictEqual(String(pin.z), '7');
    assert.ok(pin.when && pin.when.item === 'shovel');
    assert.ok(pin.once && pin.once.storage === 'firstlight.morris.amulet');
    assert.strictEqual(pin.once.eq, 1);
    assert.ok(pin.give && pin.give[0] && pin.give[0].item === 'strange_amulet');
    assert.strictEqual(pin.set['firstlight.morris.amulet'], 2);
    assert.ok(pin.tag !== 'shovel', 'must not be a shovel hop tag');
    log('firstlight amulet harvest pin ok');
}

function testTrapStepOnDamageAndField() {
    const z = 7;
    const map = makeFlatMap(3, 1, z, null);
    const ground = createGroundStore();
    seedWorldPinsOntoGround(
        ground,
        [
            {
                id: 'spike_1',
                kind: 'trap',
                catalogId: 'spike_trap',
                x: 1,
                y: 0,
                z,
                damage: 15,
                field: 'fire',
                shared: true
            }
        ],
        { itemDb: SEED_DB, tileMap: map }
    );
    const player = makeChestPlayer({
        id: 20,
        tile: { x: 0, y: 0, z }
    });
    player.hp = { current: 100, max: 100 };
    player.alive = true;
    const before = player.hp.current;
    const n = onWorldPinStep(
        player,
        { x: 0, y: 0, z },
        { x: 1, y: 0, z },
        ground,
        1
    );
    assert.strictEqual(n, 1);
    assert.ok(player.hp.current < before);
    const field = getFieldOnTile(ground, 1, 0, z);
    assert.ok(field);
    assert.strictEqual(field.fieldKind, 'fire');
    const inst = getItem(ground.inventory, groundUidForWorldPin(ground, 'spike_1'));
    assert.strictEqual(inst.worldPinUsed, true);
    const second = onWorldPinStep(
        player,
        { x: 0, y: 0, z },
        { x: 1, y: 0, z },
        ground,
        2
    );
    assert.strictEqual(second, 0);
    log('trap step-on damage and field ok');
}

function testTrapCooldownRestore() {
    const ground = createGroundStore();
    seedWorldPinsOntoGround(
        ground,
        [
            {
                id: 'spike_cd',
                kind: 'trap',
                catalogId: 'spike_trap',
                x: 0,
                y: 0,
                z: 0,
                damage: 5,
                cooldown: 8,
                transformTo: 'rubble'
            }
        ],
        { itemDb: SEED_DB }
    );
    const player = makeChestPlayer({ tile: { x: 1, y: 0, z: 0 } });
    player.hp = { current: 50, max: 50 };
    player.alive = true;
    onWorldPinStep(
        player,
        { x: 1, y: 0, z: 0 },
        { x: 0, y: 0, z: 0 },
        ground,
        0
    );
    const inst = getItem(
        ground.inventory,
        groundUidForWorldPin(ground, 'spike_cd')
    );
    assert.strictEqual(inst.itemId, 'rubble');
    assert.strictEqual(tickWorldPinTrap(ground, 8, { itemDb: SEED_DB }), 1);
    assert.strictEqual(inst.itemId, 'spike_trap');
    assert.strictEqual(inst.worldPinUsed, false);
    log('trap cooldown restore ok');
}

function testTrapStepViaTileMapMove() {
    const z = 7;
    const map = makeFlatMap(3, 1, z, null);
    const ground = createGroundStore();
    map.groundStore = ground;
    seedWorldPinsOntoGround(
        ground,
        [
            {
                id: 'spike_move',
                kind: 'trap',
                catalogId: 'spike_trap',
                x: 1,
                y: 0,
                z,
                damage: 9
            }
        ],
        { itemDb: SEED_DB, tileMap: map }
    );
    const player = makeChestPlayer({
        id: 21,
        tile: { x: 0, y: 0, z }
    });
    player.hp = { current: 40, max: 40 };
    player.alive = true;
    assert.ok(map.tryOccupy(0, 0, z, player));
    const before = player.hp.current;
    assert.ok(map.moveEntityToTile(player, 1, 0, z));
    assert.ok(player.hp.current < before);
    log('trap step via tilemap move ok');
}

async function main() {
    console.log('tests/world_pins.js');
    testNormalizePin();
    testKindsAndIds();
    testNestedItems();
    testClipboardAndTile();
    testFindAndBaseline();
    testFloorMove();
    testHybridRoundtrip();
    testSessionTransport();
    testMinimapWorldDots();
    testMissingWorldIsNull();
    testHuntSeedGround();
    testHuntSeedMissingWorld();
    testHuntSeedPickupableVsCrate();
    await testHuntSeedSimulator();
    await testHuntSeedSimulatorStartSeedsWorld();
    testHuntSeedBrowserMergeKeepsWorld();
    testNormalizeChest();
    testQuestChestFirstUseThenEmpty();
    testQuestChestCapFailNoStorage();
    testQuestChestWhenItemGate();
    testQuestChestSharedLocksHunt();
    testQuestChestPartialGiveRollback();
    testApplyCellPatchAstar();
    testNormalizeLeverAndDoor();
    testLeverUsePatchesFrictionThenToggleBack();
    testDoorUseTogglesBlocking();
    testLeverOpensDoorById();
    testLeverTagSharesEffects();
    testGatedDoorUseLocked();
    testNormalizeGatedDoorAndTeleport();
    testKeyDoorRequireThenConsume();
    testQuestAndLevelDoor();
    testTeleportUseHopsSameHuntFloor();
    testTeleportMissingFloorAndBlocked();
    testNormalizeTransformAndDecay();
    testLeverTransformOnUseSwapsArt();
    testDecayTransformThenRemove();
    testRopeShovelUseWithHop();
    testRopeMissingDestAndTagSpot();
    testNormalizeW6EffectsAndPins();
    testLeverWhenGate();
    testLeverSpawnEffect();
    testLeverWaveUnlock();
    testLeverUnlockDoor();
    testHarvestGiveThenCooldown();
    testHarvestToolDigNoHop();
    testFirstlightAmuletHarvestPin();
    testTrapStepOnDamageAndField();
    testTrapCooldownRestore();
    testTrapStepViaTileMapMove();
    console.log('world_pins: ok');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
