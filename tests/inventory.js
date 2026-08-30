/**
 * Character inventory — nested bags, equip/swap, weight/Cap.
 */

'use strict';

const assert = require('assert');
const {
    DEFAULT_ROOT_SLOTS,
    ROOT_UID,
    MAX_STACK_SIZE,
    itemIsContainer,
    itemIsMultiUse,
    itemIsUsable,
    itemIsEquipable,
    itemIsBackpackEquip,
    itemIsStackable,
    getStackCount,
    containerCapacity,
    createEmptyInventory,
    createItemInstance,
    placeInContainer,
    placeInEquipment,
    moveItem,
    moveItemAmount,
    equipItem,
    unequipItem,
    totalCarriedWeight,
    remainingCapacity,
    baseCapacity,
    resolveCapBand,
    equipmentMapFromInventory,
    buildInventoryFromSeed,
    buildInventorySandboxSeed,
    getContainer,
    getItem,
    ensureItemContainer,
    destroyItem,
    syncRootToEquippedBackpack,
    findFirstFreeSlotBfs,
    itemSubtreeWeight,
    canCarryAdditional,
    canEquipInSlot,
    preferredEquipSlot,
    countEquippedQuiverAmmo,
    consumeEquippedQuiverAmmo,
    countItemIdInInventoryTree,
    consumeItemIdFromInventory,
    findFirstAmmoUid,
    placeSeedContents,
    itemIsThrowingWeapon,
    itemBreakChance,
    parseEquipmentSeedEntry,
    equippedRightHandCount,
    tryBreakEquippedThrowingWeapon,
    instanceWeight
} = require('../kernel/core/lib/character/inventory.js');
const {
    itemAmmoKind,
    weaponRequiredAmmoKind
} = require('../kernel/core/lib/character/stats.js');
const {
    MAX_GROUND_RENDER,
    createGroundStore,
    dropItemToGround,
    pickupItemFromGround,
    placePlayerItemIntoGroundContainer,
    moveGroundItemIntoContainer,
    moveGroundItemToTile,
    groundRootLocation,
    isGroundContainerOpenable,
    canDropToTile,
    canPickupFromTile,
    getStack,
    peekTop,
    getRenderableStack,
    spawnGroundItem,
    fillCorpse
} = require('../kernel/core/lib/character/ground_items.js');
const { Player } = require('../kernel/core/entities/player.js');

const VERBOSE = process.env.VERBOSE === '1';
const log = (...args) => {
    if (VERBOSE) console.log(...args);
};

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

/** Minimal itemDb for unit tests */
const ITEM_DB = [
    {
        id: 'backpack',
        label: 'Backpack',
        category: 'container',
        slot: 'backpack',
        volume: 20,
        weight: 1800
    },
    {
        id: 'bag',
        label: 'Bag',
        category: 'container',
        slot: 'backpack',
        volume: 8,
        weight: 800
    },
    {
        id: 'big_bag',
        label: 'Big Bag',
        category: 'container',
        slot: 'backpack',
        volume: 32,
        weight: 1200
    },
    {
        id: 'iron_longsword',
        label: 'Iron Longsword',
        slot: 'rightHand',
        category: 'sword',
        atk: 42,
        weight: 5400
    },
    {
        id: 'oak_shield',
        label: 'Oak Shield',
        slot: 'leftHand',
        category: 'shield',
        defense: 28,
        weight: 4800
    },
    {
        id: 'steel_helm',
        label: 'Steel Helm',
        slot: 'helmet',
        category: 'helmet',
        armor: 6,
        weight: 3200
    },
    {
        id: 'leather_boots',
        label: 'Leather Boots',
        slot: 'boots',
        category: 'boots',
        armor: 2,
        weight: 900
    },
    {
        id: 'steel_boots',
        label: 'Steel Boots',
        slot: 'boots',
        category: 'boots',
        armor: 3,
        weight: 2900
    },
    {
        id: 'blaze_field_rune',
        label: 'Blaze Field Rune',
        category: 'rune',
        stackable: true,
        weight: 21,
        type: ['rune']
    },
    {
        id: 'blaze_bomb_rune',
        label: 'Fire Bomb Rune',
        category: 'rune',
        stackable: true,
        weight: 52,
        type: ['rune']
    },
    {
        id: 'purge_field_rune',
        label: 'Purge Field Rune',
        category: 'rune',
        stackable: true,
        weight: 21,
        type: ['rune']
    },
    {
        id: 'grand_fireburst_rune',
        label: 'Grand Fireburst Rune',
        category: 'rune',
        stackable: true,
        weight: 70,
        type: ['rune']
    },
    {
        id: 'deathburst_rune',
        label: 'Deathburst Rune',
        category: 'rune',
        stackable: true,
        weight: 70,
        type: ['rune']
    },
    {
        id: 'adventurer_backpack',
        label: 'Adventurer Backpack',
        category: 'container',
        slot: 'backpack',
        volume: 22,
        weight: 1800
    },
    {
        id: 'jubilee_backpack',
        label: 'Jubilee Backpack',
        category: 'container',
        slot: 'backpack',
        volume: 25,
        weight: 1700
    },
    {
        id: 'steel_plate',
        label: 'Steel Plate',
        slot: 'armor',
        category: 'armor',
        armor: 11,
        weight: 8400
    },
    {
        id: 'steel_greaves',
        label: 'Steel Greaves',
        slot: 'legs',
        category: 'legs',
        armor: 8,
        weight: 2800
    },
    {
        id: 'unicorn_quiver',
        label: 'Unicorn Quiver',
        category: 'quiver',
        slot: 'leftHand',
        volume: 12,
        weight: 2000
    },
    {
        id: 'hunting_arrow',
        label: 'Hunting Arrow',
        category: 'ammo',
        ammoType: 'arrow',
        stackable: true,
        atk: 25,
        maxHitChance: 90,
        weight: 70
    },
    {
        id: 'steel_bolt',
        label: 'Steel Bolt',
        category: 'ammo',
        ammoType: 'bolt',
        stackable: true,
        atk: 30,
        maxHitChance: 90,
        weight: 80
    },
    {
        id: 'lead_anvil',
        label: 'Lead Anvil',
        category: 'other',
        weight: 90000
    },
    {
        id: 'hunter_bow',
        label: 'Hunter Bow',
        slot: 'rightHand',
        category: 'bow',
        weaponType: 'distance',
        twoHanded: true,
        atk: 28,
        weight: 3200
    },
    {
        id: 'scout_crossbow',
        label: 'Scout Crossbow',
        slot: 'rightHand',
        category: 'crossbow',
        weaponType: 'distance',
        twoHanded: true,
        atk: 30,
        weight: 4000
    },
    {
        id: 'nightshade_star',
        label: 'Nightshade Star',
        slot: 'rightHand',
        category: 'spear',
        weaponType: 'distance',
        type: ['throwing'],
        stackable: true,
        breakChance: 33,
        atk: 65,
        weight: 200
    },
    {
        id: 'snowball',
        label: 'Snowball',
        slot: 'rightHand',
        category: 'spear',
        weaponType: 'distance',
        type: ['throwing'],
        stackable: true,
        breakChance: 100,
        weight: 80
    },
    {
        id: 'two_hand_sword',
        label: 'Two-Hand Sword',
        slot: 'rightHand',
        category: 'sword',
        weaponType: 'melee',
        twoHanded: true,
        atk: 50,
        weight: 7000
    },
    {
        id: 'monster_corpse',
        label: 'Dead creature',
        category: 'container',
        volume: 20,
        weight: 5000,
        isCorpse: true
    },
    {
        id: 'rock',
        label: 'Rock',
        weight: 100
    }
];

test('empty inventory has 0 synthetic root slots (no backpack)', () => {
    const inv = createEmptyInventory();
    assert.strictEqual(inv.rootUid, ROOT_UID);
    const root = getContainer(inv, ROOT_UID);
    assert.ok(root);
    assert.strictEqual(root.capacity, 0);
    assert.strictEqual(root.slots.length, 0);
});

test('createEmptyInventory rootSlots override for tests', () => {
    const inv = createEmptyInventory({ rootSlots: DEFAULT_ROOT_SLOTS });
    assert.strictEqual(getContainer(inv, ROOT_UID).capacity, DEFAULT_ROOT_SLOTS);
});

test('container volume from item template', () => {
    assert.strictEqual(containerCapacity({ volume: 32 }, ITEM_DB), 32);
    assert.strictEqual(containerCapacity('bag', ITEM_DB), 8);
    assert.ok(itemIsContainer(ITEM_DB.find((i) => i.id === 'bag')));
    assert.ok(!itemIsContainer(ITEM_DB.find((i) => i.id === 'iron_longsword')));
});

test('nested bags and cycle guard', () => {
    const inv = createEmptyInventory({ rootSlots: 20 });
    const bagA = createItemInstance(inv, 'bag', ITEM_DB);
    const bagB = createItemInstance(inv, 'bag', ITEM_DB);
    assert.ok(placeInContainer(inv, bagA, ROOT_UID, 0).ok);
    assert.ok(placeInContainer(inv, bagB, bagA, 0).ok);

    // Cannot put bagA inside bagB (cycle)
    const sword = createItemInstance(inv, 'iron_longsword', ITEM_DB);
    assert.ok(placeInContainer(inv, sword, bagB, 0).ok);

    const r = moveItem(
        inv,
        { kind: 'container', containerUid: ROOT_UID, index: 0 },
        { kind: 'container', containerUid: bagB, index: 1 },
        ITEM_DB
    );
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'cycle');
});

test('equipped backpack is main root and counts on Cap', () => {
    const inv = buildInventoryFromSeed(
        {
            equipment: {
                rightHand: 'iron_longsword',
                backpack: 'backpack'
            },
            backpack: ['steel_helm']
        },
        ITEM_DB
    );
    const bpUid = inv.equipment.backpack;
    assert.ok(bpUid);
    assert.strictEqual(inv.rootUid, bpUid, 'rootUid follows equipped backpack');
    const root = getContainer(inv, inv.rootUid);
    assert.ok(root);
    assert.strictEqual(root.capacity, 20);
    assert.strictEqual(getItem(inv, root.slots[0]).itemId, 'steel_helm');
    // Cannot move main backpack into its own free slot
    const intoSelf = moveItem(
        inv,
        { kind: 'equipment', slot: 'backpack' },
        { kind: 'container', containerUid: bpUid, index: 1 },
        ITEM_DB
    );
    assert.strictEqual(intoSelf.ok, false);
    assert.strictEqual(intoSelf.error, 'cycle');
    // Nested bag inside main backpack — cannot stow main pack into child
    const bagUid = createItemInstance(inv, 'bag', ITEM_DB);
    assert.ok(placeInContainer(inv, bagUid, bpUid, 2).ok);
    const intoChild = moveItem(
        inv,
        { kind: 'equipment', slot: 'backpack' },
        { kind: 'container', containerUid: bagUid, index: 0 },
        ITEM_DB
    );
    assert.strictEqual(intoChild.ok, false);
    assert.strictEqual(intoChild.error, 'cycle');
    // Cap includes backpack weight (1800) + sword + helm
    const w = totalCarriedWeight(inv, ITEM_DB);
    assert.strictEqual(w, 1800 + 5400 + 3200 + 800);
});

test('equip nested bag into backpack slot stows old pack inside new', () => {
    const inv = buildInventoryFromSeed(
        {
            equipment: { backpack: 'backpack' },
            backpack: [{ itemId: 'bag', contents: ['steel_helm'] }]
        },
        ITEM_DB
    );
    const oldBp = inv.equipment.backpack;
    const bagUid = getContainer(inv, inv.rootUid).slots[0];
    assert.ok(bagUid);
    const r = equipItem(inv, bagUid, ITEM_DB, 'backpack');
    assert.ok(r.ok, r.error);
    assert.strictEqual(inv.equipment.backpack, bagUid);
    assert.strictEqual(inv.rootUid, bagUid);
    // Old backpack lives inside the newly equipped bag
    const newRoot = getContainer(inv, bagUid);
    assert.ok(newRoot.slots.some((u) => u === oldBp));
    assert.strictEqual(getItem(inv, oldBp).itemId, 'backpack');
});

test('equip from backpack swaps existing gear', () => {
    const inv = buildInventoryFromSeed(
        {
            equipment: {
                rightHand: 'iron_longsword',
                boots: 'leather_boots',
                backpack: 'backpack'
            },
            backpack: ['steel_boots']
        },
        ITEM_DB
    );
    const root = getContainer(inv, inv.rootUid);
    const spareUid = root.slots[0];
    assert.ok(spareUid);
    const r = equipItem(inv, spareUid, ITEM_DB);
    assert.ok(r.ok, r.error);
    assert.strictEqual(equipmentMapFromInventory(inv).boots, 'steel_boots');
    // leather_boots returned to backpack
    assert.strictEqual(getItem(inv, r.swappedUid).itemId, 'leather_boots');
});

test('unequip weapon into backpack', () => {
    const inv = buildInventoryFromSeed(
        {
            equipment: { rightHand: 'iron_longsword', backpack: 'backpack' },
            backpack: []
        },
        ITEM_DB
    );
    const r = unequipItem(inv, 'rightHand', ITEM_DB);
    assert.ok(r.ok, r.error);
    assert.ok(!inv.equipment.rightHand);
    const root = getContainer(inv, inv.rootUid);
    const found = root.slots.some((uid) => {
        const it = uid && getItem(inv, uid);
        return it && it.itemId === 'iron_longsword';
    });
    assert.ok(found);
});

test('move between container slots', () => {
    const inv = buildInventoryFromSeed(
        {
            equipment: { backpack: 'backpack' },
            backpack: ['steel_helm', 'oak_shield']
        },
        ITEM_DB
    );
    const rootUid = inv.rootUid;
    const r = moveItem(
        inv,
        { kind: 'container', containerUid: rootUid, index: 0 },
        { kind: 'container', containerUid: rootUid, index: 5 },
        ITEM_DB
    );
    assert.ok(r.ok);
    const root = getContainer(inv, rootUid);
    assert.strictEqual(root.slots[0], null);
    assert.ok(root.slots[5]);
    assert.strictEqual(getItem(inv, root.slots[5]).itemId, 'steel_helm');
});

test('drop onto bag icon nests into that bag (not swap)', () => {
    const inv = buildInventoryFromSeed(
        {
            equipment: { backpack: 'backpack' },
            backpack: [
                { itemId: 'bag', contents: ['steel_helm'] },
                { itemId: 'bag', contents: [] },
                'oak_shield'
            ]
        },
        ITEM_DB
    );
    const rootUid = inv.rootUid;
    const root = getContainer(inv, rootUid);
    const bagA = root.slots[0];
    const bagB = root.slots[1];
    assert.ok(bagA && bagB);

    // Drop bag B onto bag A icon → B goes inside A (classic nest)
    const nestBag = moveItem(
        inv,
        { kind: 'container', containerUid: rootUid, index: 1 },
        { kind: 'container', containerUid: rootUid, index: 0 },
        ITEM_DB
    );
    assert.ok(nestBag.ok, nestBag.error);
    assert.strictEqual(root.slots[1], null, 'source slot cleared');
    assert.strictEqual(root.slots[0], bagA, 'destination bag stays put');
    const insideA = getContainer(inv, bagA).slots;
    assert.ok(
        insideA.some((uid) => uid === bagB),
        'bag B nested inside bag A'
    );

    // Drop non-container onto bag A icon → item goes inside A
    const nestShield = moveItem(
        inv,
        { kind: 'container', containerUid: rootUid, index: 2 },
        { kind: 'container', containerUid: rootUid, index: 0 },
        ITEM_DB
    );
    assert.ok(nestShield.ok, nestShield.error);
    assert.strictEqual(root.slots[2], null);
    assert.ok(
        getContainer(inv, bagA).slots.some(
            (uid) => uid && getItem(inv, uid).itemId === 'oak_shield'
        ),
        'shield nested inside bag A'
    );

    // Cycle: drop parent bag onto a bag nested inside it
    const inv2 = buildInventoryFromSeed(
        {
            equipment: { backpack: 'backpack' },
            backpack: [{ itemId: 'bag', contents: [{ itemId: 'bag', contents: [] }] }]
        },
        ITEM_DB
    );
    const r2 = getContainer(inv2, inv2.rootUid);
    const parent = r2.slots[0];
    const child = getContainer(inv2, parent).slots[0];
    // Place parent and child as siblings would require extract; drop parent bag
    // icon location onto child by using child's slot as target with child uid
    // (simulate drop-on-child-icon while parent is still the root entry).
    const cycle = moveItem(
        inv2,
        { kind: 'container', containerUid: inv2.rootUid, index: 0 },
        { kind: 'container', containerUid: parent, index: 0 },
        ITEM_DB
    );
    assert.strictEqual(cycle.ok, false);
    assert.strictEqual(cycle.error, 'cycle');
    // child still there
    assert.strictEqual(getContainer(inv2, parent).slots[0], child);
});

test('weight and Cap include nested bag contents + equipped backpack', () => {
    const inv = buildInventoryFromSeed(
        {
            equipment: {
                rightHand: 'iron_longsword',
                backpack: 'backpack'
            },
            backpack: [
                {
                    itemId: 'bag',
                    contents: ['oak_shield', 'steel_helm']
                }
            ]
        },
        ITEM_DB
    );
    const w = totalCarriedWeight(inv, ITEM_DB);
    // equipped backpack 1800 + sword 5400 + bag 800 + shield 4800 + helm 3200
    assert.strictEqual(w, 1800 + 5400 + 800 + 4800 + 3200);
    const level = 50;
    const classId = 'guardian';
    const cap = remainingCapacity(level, w, classId);
    assert.strictEqual(
        cap,
        Math.max(0, Math.floor(baseCapacity(level, classId) - w / 100))
    );
});

test('baseCapacity: L1=600 L8=670 then vocation gains', () => {
    // Pre-vocation: same +10/lvl for every class (engine L1 floor 600)
    const cap1to8 = [600, 610, 620, 630, 640, 650, 660, 670];
    for (const cls of ['adventurer', 'guardian', 'scout', 'adept', 'warden', 'mystic']) {
        for (let lv = 1; lv <= 8; lv++) {
            assert.strictEqual(baseCapacity(lv, cls), cap1to8[lv - 1], cls + ' L' + lv);
        }
        assert.strictEqual(baseCapacity(2, cls) - baseCapacity(1, cls), 10);
    }
    // After 8: +10 / +20 / +25
    assert.strictEqual(baseCapacity(9, 'adept') - baseCapacity(8, 'adept'), 10);
    assert.strictEqual(baseCapacity(9, 'warden') - baseCapacity(8, 'warden'), 10);
    assert.strictEqual(baseCapacity(9, 'adventurer') - baseCapacity(8, 'adventurer'), 10);
    assert.strictEqual(baseCapacity(9, 'scout') - baseCapacity(8, 'scout'), 20);
    assert.strictEqual(baseCapacity(9, 'guardian') - baseCapacity(8, 'guardian'), 25);
    assert.strictEqual(baseCapacity(9, 'mystic') - baseCapacity(8, 'mystic'), 25);
    // Closed forms at L50 (reference +200 vs classic 400/470 curve)
    assert.strictEqual(baseCapacity(50, 'adept'), 10 * (50 + 59)); // 1090
    assert.strictEqual(baseCapacity(50, 'scout'), 10 * (2 * 50 - 8 + 59)); // 1510
    assert.strictEqual(baseCapacity(50, 'guardian'), 5 * (5 * 50 - 5 * 8 + 134)); // 1720
    // Legacy vocation aliases
    assert.strictEqual(resolveCapBand('knight'), 'guardian');
    assert.strictEqual(resolveCapBand('paladin'), 'scout');
    assert.strictEqual(resolveCapBand('sorcerer'), 'adept');
    assert.strictEqual(baseCapacity(50, 'knight'), baseCapacity(50, 'guardian'));
});

test('Player.getRemainingCapacity uses classId', () => {
    const p = new Player({
        level: 50,
        classId: 'guardian',
        equipment: { rightHand: 'iron_longsword' },
        itemDb: ITEM_DB
    });
    p.initInventory({ equipment: p.equipment }, ITEM_DB);
    const w = totalCarriedWeight(p.inventory, ITEM_DB);
    assert.strictEqual(
        p.getRemainingCapacity(),
        remainingCapacity(50, w, 'guardian')
    );
    p.classId = 'adept';
    assert.strictEqual(
        p.getRemainingCapacity(),
        remainingCapacity(50, w, 'adept')
    );
    assert.ok(p.getRemainingCapacity() < remainingCapacity(50, w, 'guardian'));
});

test('big bag has more than 20 slots', () => {
    const inv = createEmptyInventory({ rootSlots: 20 });
    const uid = createItemInstance(inv, 'big_bag', ITEM_DB);
    placeInContainer(inv, uid, ROOT_UID, 0);
    const cont = getContainer(inv, uid);
    assert.strictEqual(cont.capacity, 32);
    assert.strictEqual(cont.slots.length, 32);
});

test('sandbox seed nests multiple bags + gear', () => {
    const inv = buildInventorySandboxSeed(
        {
            helmet: 'steel_helm',
            rightHand: 'iron_longsword',
            leftHand: 'oak_shield',
            boots: 'leather_boots',
            backpack: 'backpack'
        },
        ITEM_DB
    );
    const eq = equipmentMapFromInventory(inv);
    assert.strictEqual(eq.helmet, 'steel_helm');
    assert.strictEqual(eq.rightHand, 'iron_longsword');
    assert.ok(eq.backpack, 'starter backpack equipped');
    assert.strictEqual(inv.rootUid, inv.equipment.backpack);
    const root = getContainer(inv, inv.rootUid);
    const bagCount = root.slots.filter((uid) => {
        if (!uid) return false;
        const it = getItem(inv, uid);
        return (
            it &&
            (it.itemId === 'bag' ||
                it.itemId === 'adventurer_backpack' ||
                it.itemId === 'jubilee_backpack' ||
                it.itemId === 'backpack')
        );
    }).length;
    // main pack contents: bag, bag, adventurer_backpack, jubilee_backpack, + loose bag
    assert.ok(bagCount >= 4, 'expected nested bags in root, got ' + bagCount);
    // bag[1] has nested bag with shields (when templates resolve)
    const outerBag = root.slots[1];
    assert.ok(outerBag);
    const outerCont = getContainer(inv, outerBag);
    assert.ok(outerCont && outerCont.capacity >= 8);
    const nestedBagUid = outerCont.slots[0];
    assert.ok(nestedBagUid, 'expected nested bag inside second root bag');
    assert.ok(getContainer(inv, nestedBagUid), 'nested bag is a container');
});

test('Player.initInventory + equip mutates combat equipment', () => {
    const player = new Player({
        name: 'Tester',
        classId: 'guardian',
        level: 50,
        equipment: {
            rightHand: 'iron_longsword',
            boots: 'leather_boots',
            backpack: 'backpack'
        }
    });
    player._loadoutItemDb = ITEM_DB;
    player.initInventory(
        {
            equipment: player.equipment,
            backpack: ['steel_boots']
        },
        ITEM_DB
    );
    assert.ok(player.inventory);
    assert.strictEqual(
        player.inventory.rootUid,
        player.inventory.equipment.backpack
    );
    const root = getContainer(player.inventory, player.inventory.rootUid);
    const spare = root.slots[0];
    assert.ok(spare);
    const r = equipItem(player.inventory, spare, ITEM_DB);
    assert.ok(r.ok);
    player.applyInventoryMutation();
    assert.strictEqual(player.equipment.boots, 'steel_boots');
});

test('destroyItem removes nested tree', () => {
    const inv = buildInventoryFromSeed(
        {
            equipment: { backpack: 'backpack' },
            backpack: [{ itemId: 'bag', contents: ['steel_helm'] }]
        },
        ITEM_DB
    );
    const root = getContainer(inv, inv.rootUid);
    const bagUid = root.slots[0];
    const before = Object.keys(inv.items).length;
    destroyItem(inv, bagUid);
    assert.ok(Object.keys(inv.items).length < before);
    assert.strictEqual(root.slots[0], null);
});

test('syncRootToEquippedBackpack falls back when unequipped externally', () => {
    const inv = buildInventoryFromSeed(
        { equipment: { backpack: 'backpack' }, backpack: [] },
        ITEM_DB
    );
    const bpUid = inv.equipment.backpack;
    assert.strictEqual(inv.rootUid, bpUid);
    // Simulate external detach without moveItem (edge path)
    delete inv.equipment.backpack;
    getItem(inv, bpUid).location = null;
    syncRootToEquippedBackpack(inv);
    assert.strictEqual(inv.rootUid, ROOT_UID);
});

// ─── Ground drop / pickup ───────────────────────────────────────────────────

/**
 * Minimal open 9×9 walkable map; (4,4) blocked corridor option via opts.block.
 * @param {{ block?: {x:number,y:number}[] }} [opts]
 */
function makeTestMap(opts) {
    const o = opts || {};
    const cols = 9;
    const rows = 9;
    const friction = new Uint8Array(cols * rows);
    // all walkable (0) except pure blocked list
    const blocked = o.block || [];
    for (let i = 0; i < blocked.length; i++) {
        const b = blocked[i];
        friction[b.y * cols + b.x] = 255;
    }
    const occupancy = new Int16Array(cols * rows);
    const layer = { cols, rows, friction, occupancy };
    return {
        getLayer: (z) => layer,
        getFriction: (x, y) => {
            const ix = Math.round(x);
            const iy = Math.round(y);
            if (ix < 0 || iy < 0 || ix >= cols || iy >= rows) return 255;
            return friction[iy * cols + ix];
        },
        isWalkable: (x, y) => {
            const ix = Math.round(x);
            const iy = Math.round(y);
            if (ix < 0 || iy < 0 || ix >= cols || iy >= rows) return false;
            return friction[iy * cols + ix] !== 255;
        },
        inBounds: (x, y) => {
            const ix = Math.round(x);
            const iy = Math.round(y);
            return ix >= 0 && iy >= 0 && ix < cols && iy < rows;
        },
        getOccupant: () => 0,
        index: (x, y, c) => y * c + x
    };
}

function makePlayerAt(x, y, z, strategy) {
    const s = strategy && typeof strategy === 'object' ? strategy : {};
    return {
        tile: { x, y, z: z != null ? z : 0 },
        strategy: {
            engageRange:
                s.engageRange != null ? s.engageRange : 7
        },
        level: s.level != null ? s.level : 50,
        classId: s.classId != null ? s.classId : 'guardian'
    };
}

test('drop item at feet and pick up preserves nested bag', () => {
    const inv = buildInventoryFromSeed(
        {
            equipment: { backpack: 'backpack' },
            backpack: [
                { itemId: 'bag', contents: ['steel_helm', 'oak_shield'] }
            ]
        },
        ITEM_DB
    );
    const root = getContainer(inv, inv.rootUid);
    const bagUid = root.slots[0];
    assert.ok(bagUid);
    const ground = createGroundStore();
    const player = makePlayerAt(4, 4, 0);
    const map = makeTestMap();

    const drop = dropItemToGround({
        playerInv: inv,
        uid: bagUid,
        ground,
        player,
        tileMap: map,
        x: 4,
        y: 4,
        z: 0
    });
    assert.ok(drop.ok, drop.error);
    assert.strictEqual(root.slots[0], null);
    assert.strictEqual(getStack(ground, 4, 4, 0).length, 1);
    const gUid = peekTop(ground, 4, 4, 0);
    assert.ok(gUid);
    const gBag = ground.inventory.containers[gUid];
    assert.ok(gBag);
    assert.ok(gBag.slots[0], 'nested steel_helm survived drop');
    assert.ok(gBag.slots[1], 'nested oak_shield survived drop');

    const pick = pickupItemFromGround({
        ground,
        uid: gUid,
        playerInv: inv,
        player,
        itemDb: ITEM_DB
    });
    assert.ok(pick.ok, pick.error);
    assert.strictEqual(getStack(ground, 4, 4, 0).length, 0);
    const backUid = root.slots.find((u) => u);
    assert.ok(backUid);
    const backCont = getContainer(inv, backUid);
    assert.ok(backCont);
    assert.ok(backCont.slots[0]);
    assert.ok(backCont.slots[1]);
});

test('drop rejects not_walkable / out_of_range / no_path', () => {
    const inv = buildInventoryFromSeed(
        {
            equipment: { backpack: 'backpack' },
            backpack: ['iron_longsword']
        },
        ITEM_DB
    );
    const root = getContainer(inv, inv.rootUid);
    const swordUid = root.slots[0];
    const ground = createGroundStore();
    const player = makePlayerAt(1, 1, 0, { engageRange: 3 });
    // Wall at (2,1) blocking path to (3,1) if we seal corridor — use full wall line
    const map = makeTestMap({
        block: [
            { x: 2, y: 0 },
            { x: 2, y: 1 },
            { x: 2, y: 2 },
            { x: 2, y: 3 },
            { x: 2, y: 4 },
            { x: 2, y: 5 },
            { x: 2, y: 6 },
            { x: 2, y: 7 },
            { x: 2, y: 8 }
        ]
    });

    assert.strictEqual(
        canDropToTile(player, map, 2, 1, 0).error,
        'not_walkable'
    );
    assert.strictEqual(
        canDropToTile(player, map, 8, 8, 0).error,
        'out_of_range'
    );
    // In range beyond wall, no path
    assert.strictEqual(canDropToTile(player, map, 3, 1, 0).error, 'no_path');

    const bad = dropItemToGround({
        playerInv: inv,
        uid: swordUid,
        ground,
        player,
        tileMap: map,
        x: 2,
        y: 1,
        z: 0
    });
    assert.ok(!bad.ok);
    assert.strictEqual(root.slots[0], swordUid, 'item stays in bag on failed drop');
});

test('drop within engage range with path succeeds; stacks on same tile', () => {
    const inv = buildInventoryFromSeed(
        {
            equipment: { backpack: 'backpack' },
            backpack: ['iron_longsword', 'oak_shield', 'steel_helm']
        },
        ITEM_DB
    );
    const root = getContainer(inv, inv.rootUid);
    const ground = createGroundStore();
    const player = makePlayerAt(1, 1, 0, { engageRange: 7 });
    const map = makeTestMap();

    for (let i = 0; i < 3; i++) {
        const uid = root.slots.find((u) => u);
        assert.ok(uid);
        const r = dropItemToGround({
            playerInv: inv,
            uid,
            ground,
            player,
            tileMap: map,
            x: 3,
            y: 1,
            z: 0
        });
        assert.ok(r.ok, r.error);
    }
    assert.strictEqual(getStack(ground, 3, 1, 0).length, 3);
});

test('pickup requires Chebyshev ≤ 1', () => {
    const inv = buildInventoryFromSeed(
        {
            equipment: { backpack: 'backpack' },
            backpack: ['iron_longsword']
        },
        ITEM_DB
    );
    const root = getContainer(inv, inv.rootUid);
    const swordUid = root.slots[0];
    const ground = createGroundStore();
    const player = makePlayerAt(1, 1, 0);
    const map = makeTestMap();

    const drop = dropItemToGround({
        playerInv: inv,
        uid: swordUid,
        ground,
        player,
        tileMap: map,
        x: 4,
        y: 1,
        z: 0
    });
    assert.ok(drop.ok);
    const gUid = drop.groundUid;

    assert.strictEqual(canPickupFromTile(player, 4, 1, 0).error, 'out_of_range');
    const far = pickupItemFromGround({
        ground,
        uid: gUid,
        playerInv: inv,
        player,
        itemDb: ITEM_DB
    });
    assert.ok(!far.ok);
    assert.strictEqual(far.error, 'out_of_range');

    // Step adjacent
    player.tile = { x: 3, y: 1, z: 0 };
    assert.ok(canPickupFromTile(player, 4, 1, 0).ok);
    const near = pickupItemFromGround({
        ground,
        uid: gUid,
        playerInv: inv,
        player,
        itemDb: ITEM_DB
    });
    assert.ok(near.ok, near.error);
    assert.ok(root.slots.some((u) => u === near.playerUid));
});

test('getRenderableStack caps at MAX_GROUND_RENDER from top', () => {
    const ground = createGroundStore();
    const inv = buildInventoryFromSeed(
        {
            equipment: { backpack: 'backpack' },
            backpack: []
        },
        ITEM_DB
    );
    const player = makePlayerAt(0, 0, 0);
    const map = makeTestMap();
    for (let i = 0; i < 15; i++) {
        const uid = createItemInstance(inv, 'iron_longsword', ITEM_DB);
        placeInContainer(inv, uid, inv.rootUid, null);
        const r = dropItemToGround({
            playerInv: inv,
            uid,
            ground,
            player,
            tileMap: map,
            x: 0,
            y: 0,
            z: 0
        });
        assert.ok(r.ok, r.error);
    }
    const full = getStack(ground, 0, 0, 0);
    assert.strictEqual(full.length, 15);
    const visible = getRenderableStack(ground, 0, 0, 0);
    assert.strictEqual(visible.length, MAX_GROUND_RENDER);
    assert.strictEqual(visible[0], full[full.length - MAX_GROUND_RENDER]);
    assert.strictEqual(visible[visible.length - 1], full[full.length - 1]);
});

// ─── Pickup equip / nest / Cap ──────────────────────────────────────────────

test('itemIsBackpackEquip requires slot backpack; quiver is not', () => {
    assert.ok(itemIsBackpackEquip(ITEM_DB.find((i) => i.id === 'backpack')));
    assert.ok(itemIsBackpackEquip(ITEM_DB.find((i) => i.id === 'bag')));
    assert.ok(!itemIsBackpackEquip(ITEM_DB.find((i) => i.id === 'unicorn_quiver')));
    assert.ok(!itemIsBackpackEquip(ITEM_DB.find((i) => i.id === 'iron_longsword')));
});

test('drop equipped backpack clears equip slot and synthetic root has 0 slots', () => {
    const inv = buildInventoryFromSeed(
        {
            equipment: { backpack: 'backpack' },
            backpack: ['iron_longsword']
        },
        ITEM_DB
    );
    const bpUid = inv.equipment.backpack;
    assert.ok(bpUid);
    const ground = createGroundStore();
    const player = makePlayerAt(4, 4, 0);
    const map = makeTestMap();
    const drop = dropItemToGround({
        playerInv: inv,
        uid: bpUid,
        ground,
        player,
        tileMap: map,
        x: 4,
        y: 4,
        z: 0
    });
    assert.ok(drop.ok, drop.error);
    assert.ok(!inv.equipment.backpack);
    assert.strictEqual(inv.rootUid, ROOT_UID);
    const root = getContainer(inv, ROOT_UID);
    assert.strictEqual(root.capacity, 0);
    assert.strictEqual(root.slots.length, 0);
});

test('pickup backpack with empty equip slot equips it (auto)', () => {
    const inv = buildInventoryFromSeed(
        { equipment: { backpack: 'backpack' }, backpack: [] },
        ITEM_DB
    );
    const bpUid = inv.equipment.backpack;
    const ground = createGroundStore();
    const player = makePlayerAt(4, 4, 0);
    const map = makeTestMap();
    assert.ok(
        dropItemToGround({
            playerInv: inv,
            uid: bpUid,
            ground,
            player,
            tileMap: map,
            x: 4,
            y: 4,
            z: 0
        }).ok
    );
    const gUid = peekTop(ground, 4, 4, 0);
    const pick = pickupItemFromGround({
        ground,
        uid: gUid,
        playerInv: inv,
        player,
        itemDb: ITEM_DB
    });
    assert.ok(pick.ok, pick.error);
    assert.ok(pick.equipped);
    assert.ok(inv.equipment.backpack);
    assert.strictEqual(inv.rootUid, inv.equipment.backpack);
    assert.strictEqual(getStack(ground, 4, 4, 0).length, 0);
});

test('pickup second backpack nests (no swap) when equip occupied', () => {
    const inv = buildInventoryFromSeed(
        {
            equipment: { backpack: 'backpack' },
            backpack: ['adventurer_backpack']
        },
        ITEM_DB
    );
    const root = getContainer(inv, inv.rootUid);
    const spareUid = root.slots[0];
    assert.ok(spareUid);
    const ground = createGroundStore();
    const player = makePlayerAt(4, 4, 0);
    const map = makeTestMap();
    assert.ok(
        dropItemToGround({
            playerInv: inv,
            uid: spareUid,
            ground,
            player,
            tileMap: map,
            x: 4,
            y: 4,
            z: 0
        }).ok
    );
    const gUid = peekTop(ground, 4, 4, 0);
    const equippedBefore = inv.equipment.backpack;
    const pick = pickupItemFromGround({
        ground,
        uid: gUid,
        playerInv: inv,
        player,
        itemDb: ITEM_DB
    });
    assert.ok(pick.ok, pick.error);
    assert.ok(!pick.equipped);
    assert.strictEqual(inv.equipment.backpack, equippedBefore);
    assert.ok(root.slots.some((u) => u === pick.playerUid));
});

test('pickup quiver nests; does not equip backpack or leftHand', () => {
    const inv = buildInventoryFromSeed(
        {
            equipment: { backpack: 'backpack', leftHand: 'oak_shield' },
            backpack: []
        },
        ITEM_DB
    );
    // Place quiver on ground via temp inv
    const temp = buildInventoryFromSeed(
        { equipment: { backpack: 'backpack' }, backpack: ['unicorn_quiver'] },
        ITEM_DB
    );
    const tRoot = getContainer(temp, temp.rootUid);
    const qUid = tRoot.slots[0];
    const ground = createGroundStore();
    const player = makePlayerAt(4, 4, 0);
    const map = makeTestMap();
    assert.ok(
        dropItemToGround({
            playerInv: temp,
            uid: qUid,
            ground,
            player,
            tileMap: map,
            x: 4,
            y: 4,
            z: 0
        }).ok
    );
    const gUid = peekTop(ground, 4, 4, 0);
    const pick = pickupItemFromGround({
        ground,
        uid: gUid,
        playerInv: inv,
        player,
        itemDb: ITEM_DB
    });
    assert.ok(pick.ok, pick.error);
    assert.ok(!pick.equipped);
    assert.strictEqual(getItem(inv, inv.equipment.leftHand).itemId, 'oak_shield');
    assert.strictEqual(getItem(inv, inv.equipment.backpack).itemId, 'backpack');
    const root = getContainer(inv, inv.rootUid);
    assert.ok(root.slots.some((u) => u === pick.playerUid));
});

test('BFS nest uses nested bag when root is full', () => {
    // backpack volume 20 — fill all 20 slots; nested bag has free space
    const contents = [];
    for (let i = 0; i < 19; i++) contents.push('iron_longsword');
    contents.push({ itemId: 'bag', contents: [] });
    const inv = buildInventoryFromSeed(
        {
            equipment: { backpack: 'backpack' },
            backpack: contents
        },
        ITEM_DB
    );
    const root = getContainer(inv, inv.rootUid);
    assert.strictEqual(firstFreeOn(root), -1, 'root should be full');
    const bagUid = root.slots.find((u) => {
        const it = getItem(inv, u);
        return it && it.itemId === 'bag';
    });
    assert.ok(bagUid);
    const bagCont = getContainer(inv, bagUid);
    assert.ok(firstFreeOn(bagCont) >= 0);

    const temp = buildInventoryFromSeed(
        { equipment: { backpack: 'backpack' }, backpack: ['steel_helm'] },
        ITEM_DB
    );
    const helmUid = getContainer(temp, temp.rootUid).slots[0];
    const ground = createGroundStore();
    const player = makePlayerAt(4, 4, 0);
    const map = makeTestMap();
    assert.ok(
        dropItemToGround({
            playerInv: temp,
            uid: helmUid,
            ground,
            player,
            tileMap: map,
            x: 4,
            y: 4,
            z: 0
        }).ok
    );
    const gUid = peekTop(ground, 4, 4, 0);
    const free = findFirstFreeSlotBfs(inv, inv.rootUid);
    assert.ok(free);
    assert.strictEqual(free.containerUid, bagUid);

    const pick = pickupItemFromGround({
        ground,
        uid: gUid,
        playerInv: inv,
        player,
        itemDb: ITEM_DB
    });
    assert.ok(pick.ok, pick.error);
    assert.ok(bagCont.slots.some((u) => u === pick.playerUid));
});

/**
 * @param {{ slots: (string|null)[] }} cont
 * @returns {number}
 */
function firstFreeOn(cont) {
    if (!cont || !cont.slots) return -1;
    for (let i = 0; i < cont.slots.length; i++) {
        if (cont.slots[i] == null) return i;
    }
    return -1;
}

test('pickup without backpack and non-backpack item → not_enough_room', () => {
    const inv = createEmptyInventory();
    syncRootToEquippedBackpack(inv);
    const temp = buildInventoryFromSeed(
        { equipment: { backpack: 'backpack' }, backpack: ['iron_longsword'] },
        ITEM_DB
    );
    const swordUid = getContainer(temp, temp.rootUid).slots[0];
    const ground = createGroundStore();
    const player = makePlayerAt(4, 4, 0);
    const map = makeTestMap();
    assert.ok(
        dropItemToGround({
            playerInv: temp,
            uid: swordUid,
            ground,
            player,
            tileMap: map,
            x: 4,
            y: 4,
            z: 0
        }).ok
    );
    const gUid = peekTop(ground, 4, 4, 0);
    const pick = pickupItemFromGround({
        ground,
        uid: gUid,
        playerInv: inv,
        player,
        itemDb: ITEM_DB
    });
    assert.ok(!pick.ok);
    assert.strictEqual(pick.error, 'not_enough_room');
    assert.strictEqual(getStack(ground, 4, 4, 0).length, 1);
});

test('pickup Cap fail → not_enough_cap; item stays on ground', () => {
    const inv = buildInventoryFromSeed(
        {
            equipment: {
                backpack: 'backpack',
                rightHand: 'iron_longsword',
                armor: 'steel_plate'
            },
            backpack: ['steel_helm', 'oak_shield', 'steel_boots', 'steel_greaves']
        },
        ITEM_DB
    );
    // L1 guardian base Cap 600; fill almost full then try heavy anvil
    const player = makePlayerAt(4, 4, 0, { level: 1, classId: 'guardian' });
    const current = totalCarriedWeight(inv, ITEM_DB);
    assert.ok(
        canCarryAdditional(1, current, 100, 'guardian'),
        'sanity: tiny item would fit'
    );
    assert.ok(
        !canCarryAdditional(1, current, 90000, 'guardian'),
        'anvil should exceed Cap'
    );

    const temp = buildInventoryFromSeed(
        { equipment: { backpack: 'backpack' }, backpack: ['lead_anvil'] },
        ITEM_DB
    );
    const anvilUid = getContainer(temp, temp.rootUid).slots[0];
    const ground = createGroundStore();
    const map = makeTestMap();
    assert.ok(
        dropItemToGround({
            playerInv: temp,
            uid: anvilUid,
            ground,
            player,
            tileMap: map,
            x: 4,
            y: 4,
            z: 0
        }).ok
    );
    const gUid = peekTop(ground, 4, 4, 0);
    const treeW = itemSubtreeWeight(ground.inventory, gUid, ITEM_DB);
    assert.strictEqual(treeW, 90000);

    const pick = pickupItemFromGround({
        ground,
        uid: gUid,
        playerInv: inv,
        player,
        itemDb: ITEM_DB
    });
    assert.ok(!pick.ok);
    assert.strictEqual(pick.error, 'not_enough_cap');
    assert.strictEqual(getStack(ground, 4, 4, 0).length, 1);
});

test('equipmentSlot backpack on occupied falls through to nest', () => {
    const inv = buildInventoryFromSeed(
        {
            equipment: { backpack: 'backpack' },
            backpack: []
        },
        ITEM_DB
    );
    const temp = buildInventoryFromSeed(
        { equipment: { backpack: 'backpack' }, backpack: ['jubilee_backpack'] },
        ITEM_DB
    );
    const jUid = getContainer(temp, temp.rootUid).slots[0];
    const ground = createGroundStore();
    const player = makePlayerAt(4, 4, 0);
    const map = makeTestMap();
    assert.ok(
        dropItemToGround({
            playerInv: temp,
            uid: jUid,
            ground,
            player,
            tileMap: map,
            x: 4,
            y: 4,
            z: 0
        }).ok
    );
    const gUid = peekTop(ground, 4, 4, 0);
    const before = inv.equipment.backpack;
    const pick = pickupItemFromGround({
        ground,
        uid: gUid,
        playerInv: inv,
        player,
        itemDb: ITEM_DB,
        equipmentSlot: 'backpack'
    });
    assert.ok(pick.ok, pick.error);
    assert.ok(!pick.equipped);
    assert.strictEqual(inv.equipment.backpack, before);
    const root = getContainer(inv, inv.rootUid);
    assert.ok(root.slots.some((u) => u === pick.playerUid));
});

test('buildInventoryFromSeed supports container contents in shield (quiver) and backpack with counts', () => {
    const inv = buildInventoryFromSeed(
        {
            equipment: {
                shield: 'unicorn_quiver',
                backpack: 'backpack'
            },
            inventory: {
                shield: [{ itemId: 'hunting_arrow', count: 5 }],
                backpack: [{ itemId: 'iron_longsword', count: 1 }]
            }
        },
        ITEM_DB
    );
    const eq = equipmentMapFromInventory(inv, ITEM_DB);
    assert.strictEqual(eq.leftHand, 'unicorn_quiver');
    assert.strictEqual(eq.leftHandAmmo, 'hunting_arrow');

    const qUid = inv.equipment.leftHand;
    const qCont = getContainer(inv, qUid);
    assert.ok(qCont);
    // Stackable ammo → one slot with count 5
    const arrowUids = qCont.slots.filter(
        (u) => u && inv.items[u].itemId === 'hunting_arrow'
    );
    assert.strictEqual(arrowUids.length, 1);
    assert.strictEqual(getStackCount(inv.items[arrowUids[0]]), 5);
    assert.strictEqual(countEquippedQuiverAmmo(inv, ITEM_DB), 5);

    const bpCont = getContainer(inv, inv.rootUid);
    assert.ok(bpCont);
    const swordCount = bpCont.slots.filter(
        (u) => u && inv.items[u].itemId === 'iron_longsword'
    ).length;
    assert.strictEqual(swordCount, 1);
});

test('stackable ammo merges on place; weight scales with count', () => {
    assert.ok(itemIsStackable(ITEM_DB.find((i) => i.id === 'hunting_arrow')));
    const inv = buildInventoryFromSeed(
        {
            equipment: { backpack: 'backpack', shield: 'unicorn_quiver' },
            inventory: {
                shield: [{ itemId: 'hunting_arrow', count: 10 }]
            }
        },
        ITEM_DB
    );
    const qUid = inv.equipment.leftHand;
    const beforeW = totalCarriedWeight(inv, ITEM_DB);
    const extra = createItemInstance(inv, 'hunting_arrow', ITEM_DB, {
        count: 5
    });
    const placed = placeInContainer(inv, extra, qUid, null, ITEM_DB);
    assert.ok(placed.ok && placed.merged, 'second stack merges');
    assert.strictEqual(countEquippedQuiverAmmo(inv, ITEM_DB), 15);
    const afterW = totalCarriedWeight(inv, ITEM_DB);
    assert.strictEqual(afterW - beforeW, 5 * 70, 'weight +5×unit');
});

test('moveItemAmount splits stackable ammo between slots (Stage 7)', () => {
    const inv = buildInventoryFromSeed(
        {
            equipment: { backpack: 'backpack' },
            inventory: {
                backpack: [{ itemId: 'hunting_arrow', count: 20, slotIndex: 0 }]
            }
        },
        ITEM_DB
    );
    const root = inv.rootUid;
    const cont = getContainer(inv, root);
    const srcUid = cont.slots[0];
    assert.ok(srcUid);
    assert.strictEqual(getStackCount(inv.items[srcUid]), 20);

    const r = moveItemAmount(
        inv,
        { kind: 'container', containerUid: root, index: 0 },
        { kind: 'container', containerUid: root, index: 1 },
        7,
        ITEM_DB
    );
    assert.ok(r.ok, 'partial move ok');
    assert.strictEqual(getStackCount(inv.items[srcUid]), 13, 'source remainder');
    const destUid = cont.slots[1];
    assert.ok(destUid, 'dest occupied');
    assert.strictEqual(getStackCount(inv.items[destUid]), 7, 'dest amount');
    assert.strictEqual(inv.items[destUid].itemId, 'hunting_arrow');

    // Full move when amount >= total
    const r2 = moveItemAmount(
        inv,
        { kind: 'container', containerUid: root, index: 1 },
        { kind: 'container', containerUid: root, index: 2 },
        99,
        ITEM_DB
    );
    assert.ok(r2.ok);
    assert.strictEqual(cont.slots[1], null);
    assert.strictEqual(getStackCount(inv.items[cont.slots[2]]), 7);
});

test('leftHandAmmo is first ammo only; non-ammo contents are skipped', () => {
    const inv = buildInventoryFromSeed(
        {
            equipment: { shield: 'unicorn_quiver', backpack: 'backpack' }
        },
        ITEM_DB
    );
    const qUid = inv.equipment.leftHand;
    const junk = createItemInstance(inv, 'iron_longsword', ITEM_DB);
    assert.ok(placeInContainer(inv, junk, qUid, 0, ITEM_DB).ok);
    const bolt = createItemInstance(inv, 'steel_bolt', ITEM_DB, { count: 3 });
    assert.ok(placeInContainer(inv, bolt, qUid, 1, ITEM_DB).ok);
    const eq = equipmentMapFromInventory(inv, ITEM_DB);
    assert.strictEqual(eq.leftHandAmmo, 'steel_bolt');
    assert.strictEqual(findFirstAmmoUid(inv, qUid, ITEM_DB), bolt);
});

test('ammo cannot equip into leftHand', () => {
    const arrow = ITEM_DB.find((i) => i.id === 'hunting_arrow');
    assert.strictEqual(preferredEquipSlot(arrow), null);
    assert.strictEqual(canEquipInSlot(arrow, 'leftHand'), false);
    const inv = buildInventoryFromSeed(
        { equipment: { backpack: 'backpack' } },
        ITEM_DB
    );
    const uid = createItemInstance(inv, 'hunting_arrow', ITEM_DB);
    assert.ok(placeInContainer(inv, uid, inv.rootUid, null, ITEM_DB).ok);
    const r = equipItem(inv, uid, ITEM_DB, 'leftHand');
    assert.ok(!r.ok, 'ammo equip rejected');
});

test('seed capacity overflow reports failures without silent success', () => {
    // quiver volume 12; non-stackable swords count 20 → only 12 fit
    const inv = buildInventoryFromSeed(
        {
            equipment: { shield: 'unicorn_quiver', backpack: 'backpack' }
        },
        ITEM_DB
    );
    const rep = placeSeedContents(
        inv,
        inv.equipment.leftHand,
        [{ itemId: 'iron_longsword', count: 20 }],
        ITEM_DB
    );
    assert.strictEqual(rep.placed, 12);
    assert.strictEqual(rep.failed, 8);
    assert.ok(rep.errors.length >= 8);
});

test('consumeEquippedQuiverAmmo decrements stacks and clears empty', () => {
    const inv = buildInventoryFromSeed(
        {
            equipment: { shield: 'unicorn_quiver', backpack: 'backpack' },
            inventory: {
                shield: [{ itemId: 'hunting_arrow', count: 2 }]
            }
        },
        ITEM_DB
    );
    assert.strictEqual(countEquippedQuiverAmmo(inv, ITEM_DB), 2);
    const r1 = consumeEquippedQuiverAmmo(inv, 1, ITEM_DB);
    assert.ok(r1.ok && r1.changed);
    assert.strictEqual(countEquippedQuiverAmmo(inv, ITEM_DB), 1);
    const r2 = consumeEquippedQuiverAmmo(inv, 1, ITEM_DB);
    assert.ok(r2.ok);
    assert.strictEqual(countEquippedQuiverAmmo(inv, ITEM_DB), 0);
    const eq = equipmentMapFromInventory(inv, ITEM_DB);
    assert.ok(!eq.leftHandAmmo, 'no ammo after empty');
});

test('profile inventory.shield flatten shape seeds quiver stack', () => {
    // Mirrors simulator: Object.assign({}, def.inventory) → seed.shield = entries
    const inv = buildInventoryFromSeed(
        {
            equipment: {
                shield: 'unicorn_quiver',
                backpack: 'backpack',
                boots: 'leather_boots'
            },
            shield: [{ itemId: 'hunting_arrow', count: 20 }]
        },
        ITEM_DB
    );
    // stackable count 20 fits in one quiver slot regardless of volume
    assert.strictEqual(countEquippedQuiverAmmo(inv, ITEM_DB), 20);
    assert.strictEqual(
        equipmentMapFromInventory(inv, ITEM_DB).leftHandAmmo,
        'hunting_arrow'
    );
});

test('throwing weapons are stackable; Cap weight scales with count', () => {
    assert.ok(itemIsThrowingWeapon(ITEM_DB.find((i) => i.id === 'nightshade_star')));
    assert.strictEqual(itemBreakChance(ITEM_DB.find((i) => i.id === 'nightshade_star')), 33);
    assert.strictEqual(itemBreakChance(ITEM_DB.find((i) => i.id === 'snowball')), 100);

    // Default equip seeds full stack (100)
    const inv = buildInventoryFromSeed(
        {
            equipment: {
                weapon: 'nightshade_star',
                backpack: 'backpack'
            }
        },
        ITEM_DB
    );
    assert.strictEqual(equippedRightHandCount(inv), 100);
    const starUid = inv.equipment.rightHand;
    const starInst = inv.items[starUid];
    const starTpl = ITEM_DB.find((i) => i.id === 'nightshade_star');
    assert.strictEqual(instanceWeight(starInst, starTpl), 200 * 100);

    // Explicit count
    const inv2 = buildInventoryFromSeed(
        {
            equipment: {
                weapon: { itemId: 'snowball', count: 5 },
                backpack: 'backpack'
            }
        },
        ITEM_DB
    );
    assert.strictEqual(equippedRightHandCount(inv2), 5);
    const wBefore = totalCarriedWeight(inv2, ITEM_DB);

    // breakChance 100 always removes one
    const br = tryBreakEquippedThrowingWeapon(inv2, ITEM_DB, () => 0.99);
    assert.ok(br.broke);
    assert.strictEqual(br.remaining, 4);
    assert.strictEqual(equippedRightHandCount(inv2), 4);
    const wAfter = totalCarriedWeight(inv2, ITEM_DB);
    assert.strictEqual(wAfter, wBefore - 80, 'Cap weight drops by unit weight');

    // Drain to empty
    for (let i = 0; i < 4; i++) {
        tryBreakEquippedThrowingWeapon(inv2, ITEM_DB, () => 0);
    }
    assert.strictEqual(equippedRightHandCount(inv2), 0);
    assert.ok(!inv2.equipment.rightHand, 'empty stack clears rightHand');

    // Probabilistic: rng 0.5 → 50; chance 33 → no break
    const inv3 = buildInventoryFromSeed(
        {
            equipment: {
                weapon: { itemId: 'nightshade_star', count: 10 },
                backpack: 'backpack'
            }
        },
        ITEM_DB
    );
    const noBreak = tryBreakEquippedThrowingWeapon(inv3, ITEM_DB, () => 0.5);
    assert.ok(noBreak.attempted && !noBreak.broke);
    assert.strictEqual(noBreak.remaining, 10);
    const yesBreak = tryBreakEquippedThrowingWeapon(inv3, ITEM_DB, () => 0.1);
    assert.ok(yesBreak.broke);
    assert.strictEqual(yesBreak.remaining, 9);

    const parsed = parseEquipmentSeedEntry('nightshade_star', ITEM_DB);
    assert.deepStrictEqual(parsed, { itemId: 'nightshade_star', count: 100 });
});

test('MAX_STACK_SIZE is 100; merge and seed split respect cap', () => {
    assert.strictEqual(MAX_STACK_SIZE, 100);
    const inv = buildInventoryFromSeed(
        {
            equipment: { backpack: 'backpack' },
            backpack: [{ itemId: 'hunting_arrow', count: 150 }]
        },
        ITEM_DB
    );
    const root = getContainer(inv, inv.rootUid);
    const arrowUids = root.slots.filter(
        (u) => u && inv.items[u].itemId === 'hunting_arrow'
    );
    assert.strictEqual(arrowUids.length, 2, '150 arrows → 2 stacks');
    const counts = arrowUids
        .map((u) => getStackCount(inv.items[u]))
        .sort((a, b) => b - a);
    assert.deepStrictEqual(counts, [100, 50]);

    // Merge more onto a full stack is partial
    const extra = createItemInstance(inv, 'hunting_arrow', ITEM_DB, {
        count: 10
    });
    const fullUid = arrowUids.find(
        (u) => getStackCount(inv.items[u]) === 100
    );
    const r = placeInContainer(inv, extra, inv.rootUid, null, ITEM_DB);
    assert.ok(r.ok);
    // Full stack still 100; remainder merged into the 50 or new stack
    assert.strictEqual(getStackCount(inv.items[fullUid]), 100);
    let total = 0;
    for (let i = 0; i < root.slots.length; i++) {
        const u = root.slots[i];
        if (u && inv.items[u] && inv.items[u].itemId === 'hunting_arrow') {
            total += getStackCount(inv.items[u]);
        }
    }
    assert.strictEqual(total, 160);
});

test('bow only surfaces/consumes arrows; crossbow only bolts', () => {
    assert.strictEqual(
        itemAmmoKind(ITEM_DB.find((i) => i.id === 'hunting_arrow')),
        'arrow'
    );
    assert.strictEqual(
        itemAmmoKind(ITEM_DB.find((i) => i.id === 'steel_bolt')),
        'bolt'
    );
    assert.strictEqual(
        ITEM_DB.find((i) => i.id === 'hunting_arrow').ammoType,
        'arrow'
    );
    assert.strictEqual(
        ITEM_DB.find((i) => i.id === 'steel_bolt').ammoType,
        'bolt'
    );
    assert.strictEqual(
        weaponRequiredAmmoKind(ITEM_DB.find((i) => i.id === 'hunter_bow')),
        'arrow'
    );
    assert.strictEqual(
        weaponRequiredAmmoKind(ITEM_DB.find((i) => i.id === 'scout_crossbow')),
        'bolt'
    );

    const inv = buildInventoryFromSeed(
        {
            equipment: {
                shield: 'unicorn_quiver',
                backpack: 'backpack',
                weapon: 'hunter_bow'
            },
            inventory: {
                shield: [
                    { itemId: 'steel_bolt', count: 5 },
                    { itemId: 'hunting_arrow', count: 3 }
                ]
            }
        },
        ITEM_DB
    );
    // First slot is bolts, but bow needs arrows → leftHandAmmo is first valid arrow
    assert.strictEqual(
        equipmentMapFromInventory(inv, ITEM_DB).leftHandAmmo,
        'hunting_arrow'
    );
    assert.strictEqual(countEquippedQuiverAmmo(inv, ITEM_DB), 3);
    const c1 = consumeEquippedQuiverAmmo(inv, 1, ITEM_DB);
    assert.ok(c1.ok);
    assert.strictEqual(c1.ammoItemId, 'hunting_arrow');
    assert.strictEqual(countEquippedQuiverAmmo(inv, ITEM_DB), 2);
    // Bolts untouched
    assert.strictEqual(
        countEquippedQuiverAmmo(inv, ITEM_DB, 'bolt'),
        5
    );

    // Switch to crossbow via re-seed
    const inv2 = buildInventoryFromSeed(
        {
            equipment: {
                shield: 'unicorn_quiver',
                backpack: 'backpack',
                weapon: 'scout_crossbow'
            },
            inventory: {
                shield: [
                    { itemId: 'hunting_arrow', count: 4 },
                    { itemId: 'steel_bolt', count: 2 }
                ]
            }
        },
        ITEM_DB
    );
    assert.strictEqual(
        equipmentMapFromInventory(inv2, ITEM_DB).leftHandAmmo,
        'steel_bolt'
    );
    assert.strictEqual(countEquippedQuiverAmmo(inv2, ITEM_DB), 2);
    // Only bolts in quiver → bow has no usable ammo
    const inv3 = buildInventoryFromSeed(
        {
            equipment: {
                shield: 'unicorn_quiver',
                backpack: 'backpack',
                weapon: 'hunter_bow'
            },
            inventory: {
                shield: [{ itemId: 'steel_bolt', count: 10 }]
            }
        },
        ITEM_DB
    );
    assert.strictEqual(countEquippedQuiverAmmo(inv3, ITEM_DB), 0);
    assert.ok(!equipmentMapFromInventory(inv3, ITEM_DB).leftHandAmmo);
});

test('ammoType field wins over misleading id; first valid stack is consumed', () => {
    // Template with bolt id but ammoType arrow — catalog field is authoritative
    const weirdDb = ITEM_DB.concat([
        {
            id: 'misnamed_bolt_pack',
            label: 'Misnamed',
            category: 'ammo',
            ammoType: 'arrow',
            stackable: true,
            weight: 70
        }
    ]);
    assert.strictEqual(
        itemAmmoKind(weirdDb.find((i) => i.id === 'misnamed_bolt_pack')),
        'arrow'
    );

    // Explicit slotIndex avoids auto-merge so two arrow stacks stay distinct
    const inv = buildInventoryFromSeed(
        {
            equipment: {
                shield: 'unicorn_quiver',
                backpack: 'backpack',
                weapon: 'hunter_bow'
            },
            inventory: {
                shield: [
                    { itemId: 'steel_bolt', count: 8, slotIndex: 0 },
                    { itemId: 'hunting_arrow', count: 2, slotIndex: 1 },
                    { itemId: 'hunting_arrow', count: 4, slotIndex: 2 }
                ]
            }
        },
        ITEM_DB
    );
    // Two arrow stacks after bolts; consume drains the first valid stack first
    const qUid = inv.equipment.leftHand;
    const cont = getContainer(inv, qUid);
    const arrowSlots = cont.slots
        .map((u, idx) => ({ u, idx, c: u ? getStackCount(inv.items[u]) : 0 }))
        .filter((x) => x.u && inv.items[x.u].itemId === 'hunting_arrow');
    assert.strictEqual(arrowSlots.length, 2);
    assert.strictEqual(arrowSlots[0].c, 2);
    assert.strictEqual(arrowSlots[1].c, 4);

    assert.strictEqual(
        equipmentMapFromInventory(inv, ITEM_DB).leftHandAmmo,
        'hunting_arrow'
    );
    const c = consumeEquippedQuiverAmmo(inv, 2, ITEM_DB);
    assert.ok(c.ok);
    assert.strictEqual(c.spent, 2);
    assert.strictEqual(c.ammoItemId, 'hunting_arrow');
    // First arrow stack emptied/destroyed; second still 4; bolts untouched
    assert.strictEqual(countEquippedQuiverAmmo(inv, ITEM_DB, 'arrow'), 4);
    assert.strictEqual(countEquippedQuiverAmmo(inv, ITEM_DB, 'bolt'), 8);
    assert.strictEqual(countEquippedQuiverAmmo(inv, ITEM_DB), 4);
});

test('twoHanded bow keeps quiver; twoHanded sword unequips leftHand', () => {
    const inv = buildInventoryFromSeed(
        {
            equipment: {
                backpack: 'backpack',
                shield: 'unicorn_quiver',
                weapon: 'iron_longsword'
            },
            backpack: ['hunter_bow', 'two_hand_sword', 'oak_shield']
        },
        ITEM_DB
    );
    const bowUid = getContainer(inv, inv.rootUid).slots.find(
        (u) => u && inv.items[u].itemId === 'hunter_bow'
    );
    const rBow = equipItem(inv, bowUid, ITEM_DB, 'rightHand');
    assert.ok(rBow.ok, rBow.error);
    assert.strictEqual(inv.items[inv.equipment.leftHand].itemId, 'unicorn_quiver');
    assert.strictEqual(inv.items[inv.equipment.rightHand].itemId, 'hunter_bow');

    // Unequip bow, put shield in left, equip 2H sword → shield goes to backpack
    unequipItem(inv, 'rightHand', ITEM_DB, { containerUid: inv.rootUid });
    // left still quiver — swap to shield for this case
    unequipItem(inv, 'leftHand', ITEM_DB, { containerUid: inv.rootUid });
    const shieldUid = getContainer(inv, inv.rootUid).slots.find(
        (u) => u && inv.items[u].itemId === 'oak_shield'
    );
    assert.ok(equipItem(inv, shieldUid, ITEM_DB, 'leftHand').ok);
    const swordUid = getContainer(inv, inv.rootUid).slots.find(
        (u) => u && inv.items[u].itemId === 'two_hand_sword'
    );
    const rSw = equipItem(inv, swordUid, ITEM_DB, 'rightHand');
    assert.ok(rSw.ok, rSw.error);
    assert.strictEqual(inv.items[inv.equipment.rightHand].itemId, 'two_hand_sword');
    assert.ok(!inv.equipment.leftHand, 'leftHand cleared for non-bow 2H');
    const bp = getContainer(inv, inv.rootUid);
    assert.ok(
        bp.slots.some((u) => u && inv.items[u].itemId === 'oak_shield'),
        'shield stowed in backpack'
    );
});

test('equip shield while twoHanded sword stows the weapon', () => {
    const inv = buildInventoryFromSeed(
        {
            equipment: {
                backpack: 'backpack',
                weapon: 'two_hand_sword'
            },
            backpack: ['oak_shield']
        },
        ITEM_DB
    );
    assert.strictEqual(inv.items[inv.equipment.rightHand].itemId, 'two_hand_sword');
    assert.ok(!inv.equipment.leftHand);
    const shieldUid = getContainer(inv, inv.rootUid).slots.find(
        (u) => u && inv.items[u].itemId === 'oak_shield'
    );
    assert.ok(shieldUid);
    const r = equipItem(inv, shieldUid, ITEM_DB, 'leftHand');
    assert.ok(r.ok, r.error);
    assert.strictEqual(inv.items[inv.equipment.leftHand].itemId, 'oak_shield');
    assert.ok(!inv.equipment.rightHand, '2H weapon must leave rightHand');
    const bp = getContainer(inv, inv.rootUid);
    assert.ok(
        bp.slots.some((u) => u && inv.items[u].itemId === 'two_hand_sword'),
        '2H stowed in backpack'
    );
});

test('equip shield while bow stows the bow (not quiver exception)', () => {
    const inv = buildInventoryFromSeed(
        {
            equipment: {
                backpack: 'backpack',
                weapon: 'hunter_bow',
                shield: 'unicorn_quiver'
            },
            backpack: ['oak_shield']
        },
        ITEM_DB
    );
    assert.strictEqual(inv.items[inv.equipment.rightHand].itemId, 'hunter_bow');
    assert.strictEqual(inv.items[inv.equipment.leftHand].itemId, 'unicorn_quiver');
    const shieldUid = getContainer(inv, inv.rootUid).slots.find(
        (u) => u && inv.items[u].itemId === 'oak_shield'
    );
    const r = equipItem(inv, shieldUid, ITEM_DB, 'leftHand');
    assert.ok(r.ok, r.error);
    assert.strictEqual(inv.items[inv.equipment.leftHand].itemId, 'oak_shield');
    assert.ok(!inv.equipment.rightHand, 'bow must leave rightHand when equipping shield');
    const bp = getContainer(inv, inv.rootUid);
    assert.ok(
        bp.slots.some((u) => u && inv.items[u].itemId === 'hunter_bow'),
        'bow stowed in backpack'
    );
    assert.ok(
        bp.slots.some((u) => u && inv.items[u].itemId === 'unicorn_quiver'),
        'quiver swapped into backpack'
    );
});

test('equip quiver while bow keeps both hands', () => {
    const inv = buildInventoryFromSeed(
        {
            equipment: {
                backpack: 'backpack',
                weapon: 'hunter_bow'
            },
            backpack: ['unicorn_quiver']
        },
        ITEM_DB
    );
    const qUid = getContainer(inv, inv.rootUid).slots.find(
        (u) => u && inv.items[u].itemId === 'unicorn_quiver'
    );
    const r = equipItem(inv, qUid, ITEM_DB, 'leftHand');
    assert.ok(r.ok, r.error);
    assert.strictEqual(inv.items[inv.equipment.rightHand].itemId, 'hunter_bow');
    assert.strictEqual(inv.items[inv.equipment.leftHand].itemId, 'unicorn_quiver');
});

test('equip shield while twoHanded fails with no_room when backpack full', () => {
    const inv = buildInventoryFromSeed(
        {
            equipment: {
                backpack: 'backpack',
                weapon: 'two_hand_sword'
            }
        },
        ITEM_DB
    );
    const root = getContainer(inv, inv.rootUid);
    for (let i = 0; i < root.capacity; i++) {
        if (root.slots[i]) continue;
        const u = createItemInstance(inv, 'iron_longsword', ITEM_DB);
        assert.ok(placeInContainer(inv, u, inv.rootUid, i, ITEM_DB).ok);
    }
    // Free one slot for the shield itself, keep rest full so 2H cannot stow
    destroyItem(inv, root.slots[0]);
    const sh = createItemInstance(inv, 'oak_shield', ITEM_DB);
    assert.ok(placeInContainer(inv, sh, inv.rootUid, 0, ITEM_DB).ok);
    assert.ok(root.slots.every((s) => s), 'backpack full after placing shield');
    const r = equipItem(inv, sh, ITEM_DB, 'leftHand');
    assert.ok(!r.ok, 'must fail — no room to stow 2H');
    assert.strictEqual(r.error, 'no_room');
    assert.strictEqual(inv.items[inv.equipment.rightHand].itemId, 'two_hand_sword');
    assert.ok(!inv.equipment.leftHand, 'shield must not equip');
});

test('twoHanded equip fails with no_room when backpack full', () => {
    // backpack volume 20 — fill completely, equip shield on left, try 2H from... 
    // need 2H already in inventory somehow. Use tiny bag? Default backpack volume 20.
    // Fill 19 slots + leave 2H in last slot, equip shield left, then try equip 2H.
    const inv = buildInventoryFromSeed(
        {
            equipment: {
                backpack: 'backpack',
                shield: 'oak_shield'
            }
        },
        ITEM_DB
    );
    // Fill backpack completely
    const root = getContainer(inv, inv.rootUid);
    for (let i = 0; i < root.capacity; i++) {
        if (root.slots[i]) continue;
        const u = createItemInstance(inv, 'iron_longsword', ITEM_DB);
        assert.ok(placeInContainer(inv, u, inv.rootUid, i, ITEM_DB).ok);
    }
    assert.strictEqual(
        root.slots.filter((s) => s).length,
        root.capacity,
        'backpack full'
    );
    // Put 2H in a free sense: destroy one filler, place 2H
    destroyItem(inv, root.slots[0]);
    const th = createItemInstance(inv, 'two_hand_sword', ITEM_DB);
    assert.ok(placeInContainer(inv, th, inv.rootUid, 0, ITEM_DB).ok);
    // Backpack still full (every slot occupied)
    assert.ok(root.slots.every((s) => s));
    const r = equipItem(inv, th, ITEM_DB, 'rightHand');
    assert.ok(!r.ok, 'must fail');
    assert.strictEqual(r.error, 'no_room');
    assert.strictEqual(inv.items[inv.equipment.leftHand].itemId, 'oak_shield');
    assert.ok(!inv.equipment.rightHand || inv.equipment.rightHand !== th);
});

test('ensureItemContainer repairs missing quiver slots for Open', () => {
    const inv = buildInventoryFromSeed(
        {
            equipment: { backpack: 'backpack', shield: 'unicorn_quiver' }
        },
        ITEM_DB
    );
    const qUid = inv.equipment.leftHand;
    assert.ok(getContainer(inv, qUid));
    // Simulate broken state: drop container entry
    delete inv.containers[qUid];
    assert.ok(!getContainer(inv, qUid));
    const repaired = ensureItemContainer(inv, qUid, ITEM_DB);
    assert.ok(repaired);
    assert.ok(repaired.capacity > 0);
    assert.ok(getContainer(inv, qUid));
    assert.ok(itemIsContainer(ITEM_DB.find((i) => i.id === 'unicorn_quiver')));
});

test('count/consume itemId walks backpack tree including nested bags', () => {
    const inv = buildInventoryFromSeed(
        {
            equipment: { backpack: 'backpack' },
            backpack: [
                { itemId: 'blaze_field_rune', count: 3 },
                {
                    itemId: 'bag',
                    contents: [{ itemId: 'blaze_field_rune', count: 5 }]
                },
                { itemId: 'deathburst_rune', count: 2 }
            ]
        },
        ITEM_DB
    );
    assert.strictEqual(
        countItemIdInInventoryTree(inv, 'blaze_field_rune'),
        8,
        'root + nested bag stacks'
    );
    assert.strictEqual(countItemIdInInventoryTree(inv, 'deathburst_rune'), 2);
    assert.strictEqual(countItemIdInInventoryTree(inv, 'missing_rune'), 0);

    // Consume prefers BFS left-to-right: top-level stack first
    const r1 = consumeItemIdFromInventory(inv, 'blaze_field_rune', 1);
    assert.ok(r1.ok && r1.spent === 1 && r1.changed);
    assert.strictEqual(countItemIdInInventoryTree(inv, 'blaze_field_rune'), 7);

    // Drain remaining top-level (2) then into nested bag
    const r2 = consumeItemIdFromInventory(inv, 'blaze_field_rune', 4);
    assert.ok(r2.ok && r2.spent === 4);
    assert.strictEqual(countItemIdInInventoryTree(inv, 'blaze_field_rune'), 3);

    // Nested-only stock still counts and spends
    const invNest = buildInventoryFromSeed(
        {
            equipment: { backpack: 'backpack' },
            backpack: [
                {
                    itemId: 'bag',
                    contents: [{ itemId: 'blaze_field_rune', count: 2 }]
                }
            ]
        },
        ITEM_DB
    );
    assert.strictEqual(countItemIdInInventoryTree(invNest, 'blaze_field_rune'), 2);
    const r3 = consumeItemIdFromInventory(invNest, 'blaze_field_rune', 2);
    assert.ok(r3.ok && r3.spent === 2);
    assert.strictEqual(
        countItemIdInInventoryTree(invNest, 'blaze_field_rune'),
        0,
        'empty stacks removed'
    );
    const r4 = consumeItemIdFromInventory(invNest, 'blaze_field_rune', 1);
    assert.ok(!r4.ok && r4.spent === 0);
});

test('inventory sandbox seed includes nested rune pouch', () => {
    const inv = buildInventorySandboxSeed(
        { backpack: 'backpack', weapon: 'iron_longsword' },
        ITEM_DB
    );
    assert.ok(
        countItemIdInInventoryTree(inv, 'blaze_field_rune') >= 10,
        'sandbox seeds fire field runes'
    );
    assert.ok(
        countItemIdInInventoryTree(inv, 'grand_fireburst_rune') >= 8,
        'sandbox seeds great fireburst runes'
    );
});

test('adept_starter profile seeds combat runes in backpack', () => {
    const path = require('path');
    const fs = require('fs');
    const full = path.join(
        __dirname,
        '../presets/standard/player_profiles/adept_starter.json'
    );
    const profile = JSON.parse(fs.readFileSync(full, 'utf8'));
    const equipPack = JSON.parse(
        fs.readFileSync(
            path.join(__dirname, '../presets/standard/equipment.json'),
            'utf8'
        )
    );
    const itemDb = equipPack.items || equipPack;
    assert.ok(profile.inventory && Array.isArray(profile.inventory.backpack));
    const inv = buildInventoryFromSeed(
        {
            equipment: profile.equipment,
            inventory: profile.inventory
        },
        itemDb
    );
    assert.ok(
        countItemIdInInventoryTree(inv, 'grand_fireburst_rune') >= 30,
        'adept_starter seeds GFB runes'
    );
    assert.ok(
        countItemIdInInventoryTree(inv, 'blaze_field_rune') >= 12,
        'adept_starter seeds fire field runes'
    );
});

test('item behavioral helpers: itemIsMultiUse, itemIsUsable, itemIsEquipable', () => {
    assert.ok(itemIsMultiUse({ category: 'rune', id: 'blaze_field_rune' }), 'runes are multi-use');
    assert.ok(itemIsMultiUse({ id: 'rope', category: 'tool' }), 'tools like rope are multi-use');
    assert.ok(!itemIsMultiUse({ id: 'health_potion', category: 'potion' }), 'potions are not multi-use');
    
    assert.ok(itemIsUsable({ category: 'potion', id: 'health_potion' }), 'potions are usable');
    assert.ok(itemIsUsable({ id: 'antidote_potion', dispel: ['poison'] }), 'dispel is usable');
    assert.ok(
        itemIsUsable({ id: 'magic_shield_potion', condition: { type: 'mana_shield' } }),
        'condition is usable'
    );
    assert.ok(itemIsUsable({ id: 'apple', category: 'food' }), 'food is usable');
    assert.ok(!itemIsUsable({ category: 'rune', id: 'blaze_field_rune' }), 'runes are not in usable category');
    assert.ok(!itemIsUsable({ category: 'container', volume: 20 }), 'containers are not usable');

    assert.ok(itemIsEquipable({ id: 'iron_longsword', category: 'sword', slot: 'rightHand' }), 'sword is equipable');
    assert.ok(!itemIsEquipable({ id: 'blaze_field_rune', category: 'rune' }), 'rune is not equipable');

    const presets = require('../kernel/core/lib/presets.js');
    const live = presets.loadEquipment().items;
    const shovel = live.find((it) => it.id === 'shovel');
    const rope = live.find((it) => it.id === 'rope');
    const pick = live.find((it) => it.id === 'pick');
    const rod = live.find((it) => it.id === 'fishing_rod');
    const worm = live.find((it) => it.id === 'worm');
    assert.ok(shovel && rope && pick && rod && worm, 'shipped tool rows');
    assert.ok(itemIsMultiUse(shovel), 'shipped shovel is multi-use');
    assert.ok(itemIsMultiUse(rope), 'shipped rope is multi-use');
    assert.ok(itemIsMultiUse(pick), 'shipped pick is multi-use');
    assert.ok(!itemIsMultiUse(rod), 'fishing_rod is not multi-use');
    assert.ok(!itemIsMultiUse(worm), 'worm is not multi-use');
    assert.ok(!itemIsUsable(worm), 'worm is not food');
    assert.ok(!itemIsEquipable(shovel), 'tools are not equipable');
});

// --- Container-from-ground (open bag on tile) ---

test('groundRootLocation walks nested bag contents to tile root', () => {
    const inv = buildInventoryFromSeed(
        {
            equipment: { backpack: 'backpack' },
            backpack: [
                { itemId: 'bag', contents: ['steel_helm', 'oak_shield'] }
            ]
        },
        ITEM_DB
    );
    const root = getContainer(inv, inv.rootUid);
    const bagUid = root.slots[0];
    const ground = createGroundStore();
    const player = makePlayerAt(4, 4, 0);
    const map = makeTestMap();
    const drop = dropItemToGround({
        playerInv: inv,
        uid: bagUid,
        ground,
        player,
        tileMap: map,
        x: 4,
        y: 4,
        z: 0
    });
    assert.ok(drop.ok, drop.error);
    const gBag = drop.groundUid;
    const gCont = getContainer(ground.inventory, gBag);
    const childUid = gCont.slots[0];
    assert.ok(childUid);
    const loc = groundRootLocation(ground, childUid);
    assert.ok(loc);
    assert.strictEqual(loc.x, 4);
    assert.strictEqual(loc.y, 4);
    assert.strictEqual(loc.rootUid, gBag);
    assert.ok(isGroundContainerOpenable(ground, gBag));
});

test('pickup nested item from ground bag into player backpack', () => {
    const inv = buildInventoryFromSeed(
        {
            equipment: { backpack: 'backpack' },
            backpack: [
                { itemId: 'bag', contents: ['steel_helm'] },
                'oak_shield'
            ]
        },
        ITEM_DB
    );
    // Drop only the bag (with helm inside); leave shield in backpack
    const root = getContainer(inv, inv.rootUid);
    const bagUid = root.slots.find(
        (u) => u && inv.items[u] && inv.items[u].itemId === 'bag'
    );
    assert.ok(bagUid);
    const ground = createGroundStore();
    const player = makePlayerAt(4, 4, 0);
    const map = makeTestMap();
    assert.ok(
        dropItemToGround({
            playerInv: inv,
            uid: bagUid,
            ground,
            player,
            tileMap: map,
            x: 4,
            y: 4,
            z: 0
        }).ok
    );
    const gBag = peekTop(ground, 4, 4, 0);
    const gCont = getContainer(ground.inventory, gBag);
    const helmUid = gCont.slots[0];
    assert.ok(helmUid);
    const pick = pickupItemFromGround({
        ground,
        uid: helmUid,
        playerInv: inv,
        player,
        itemDb: ITEM_DB
    });
    assert.ok(pick.ok, pick.error);
    assert.ok(!getItem(ground.inventory, helmUid), 'helm left ground bag');
    assert.ok(getItem(inv, pick.playerUid), 'helm in player inv');
    // Bag still on ground, openable
    assert.ok(isGroundContainerOpenable(ground, gBag));
});

test('placePlayerItemIntoGroundContainer nests into open bag on tile', () => {
    const inv = buildInventoryFromSeed(
        {
            equipment: { backpack: 'backpack' },
            backpack: [{ itemId: 'bag', contents: [] }, 'steel_helm']
        },
        ITEM_DB
    );
    const root = getContainer(inv, inv.rootUid);
    const bagUid = root.slots.find(
        (u) => u && inv.items[u] && inv.items[u].itemId === 'bag'
    );
    const helmUid = root.slots.find(
        (u) => u && inv.items[u] && inv.items[u].itemId === 'steel_helm'
    );
    const ground = createGroundStore();
    const player = makePlayerAt(4, 4, 0);
    const map = makeTestMap();
    assert.ok(
        dropItemToGround({
            playerInv: inv,
            uid: bagUid,
            ground,
            player,
            tileMap: map,
            x: 4,
            y: 4,
            z: 0
        }).ok
    );
    const gBag = peekTop(ground, 4, 4, 0);
    const place = placePlayerItemIntoGroundContainer({
        playerInv: inv,
        uid: helmUid,
        ground,
        containerUid: gBag,
        player,
        itemDb: ITEM_DB
    });
    assert.ok(place.ok, place.error);
    assert.ok(!getItem(inv, helmUid));
    const gCont = getContainer(ground.inventory, gBag);
    assert.ok(gCont.slots.some((u) => u && ground.inventory.items[u]));
});

test('moveGroundItemIntoContainer: stack top into ground bag', () => {
    const inv = buildInventoryFromSeed(
        {
            equipment: { backpack: 'backpack' },
            backpack: [{ itemId: 'bag', contents: [] }, 'oak_shield']
        },
        ITEM_DB
    );
    const root = getContainer(inv, inv.rootUid);
    const bagUid = root.slots.find(
        (u) => u && inv.items[u] && inv.items[u].itemId === 'bag'
    );
    const shieldUid = root.slots.find(
        (u) => u && inv.items[u] && inv.items[u].itemId === 'oak_shield'
    );
    const ground = createGroundStore();
    const player = makePlayerAt(4, 4, 0);
    const map = makeTestMap();
    assert.ok(
        dropItemToGround({
            playerInv: inv,
            uid: bagUid,
            ground,
            player,
            tileMap: map,
            x: 4,
            y: 4,
            z: 0
        }).ok
    );
    assert.ok(
        dropItemToGround({
            playerInv: inv,
            uid: shieldUid,
            ground,
            player,
            tileMap: map,
            x: 4,
            y: 4,
            z: 0
        }).ok
    );
    // Top is shield; bag under
    const topUid = peekTop(ground, 4, 4, 0);
    const stack = getStack(ground, 4, 4, 0);
    const gBag = stack.find(
        (u) => ground.inventory.items[u].itemId === 'bag'
    );
    assert.ok(gBag);
    assert.strictEqual(ground.inventory.items[topUid].itemId, 'oak_shield');
    const r = moveGroundItemIntoContainer({
        ground,
        uid: topUid,
        containerUid: gBag,
        player,
        itemDb: ITEM_DB
    });
    assert.ok(r.ok, r.error);
    assert.ok(!getStack(ground, 4, 4, 0).includes(topUid));
    const gCont = getContainer(ground.inventory, gBag);
    assert.ok(gCont.slots.includes(topUid));
});

test('moveGroundItemToTile: nested bag content onto floor', () => {
    const inv = buildInventoryFromSeed(
        {
            equipment: { backpack: 'backpack' },
            backpack: [
                { itemId: 'bag', contents: ['steel_helm'] }
            ]
        },
        ITEM_DB
    );
    const root = getContainer(inv, inv.rootUid);
    const bagUid = root.slots[0];
    const ground = createGroundStore();
    const player = makePlayerAt(4, 4, 0);
    const map = makeTestMap();
    assert.ok(
        dropItemToGround({
            playerInv: inv,
            uid: bagUid,
            ground,
            player,
            tileMap: map,
            x: 4,
            y: 4,
            z: 0
        }).ok
    );
    const gBag = peekTop(ground, 4, 4, 0);
    const helmUid = getContainer(ground.inventory, gBag).slots[0];
    const r = moveGroundItemToTile({
        ground,
        uid: helmUid,
        player,
        tileMap: map,
        x: 5,
        y: 4,
        z: 0
    });
    assert.ok(r.ok, r.error);
    assert.strictEqual(peekTop(ground, 5, 4, 0), helmUid);
    assert.ok(
        !getContainer(ground.inventory, gBag).slots.includes(helmUid)
    );
});

// --- Stage 9: ground stack → other SQM ---

test('moveGroundItemToTile: tile stack top to adjacent walkable SQM', () => {
    const inv = buildInventoryFromSeed(
        {
            equipment: { backpack: 'backpack' },
            backpack: ['iron_longsword', 'oak_shield']
        },
        ITEM_DB
    );
    const root = getContainer(inv, inv.rootUid);
    const swordUid = root.slots[0];
    const shieldUid = root.slots[1];
    const ground = createGroundStore();
    const player = makePlayerAt(4, 4, 0);
    const map = makeTestMap();
    assert.ok(
        dropItemToGround({
            playerInv: inv,
            uid: swordUid,
            ground,
            player,
            tileMap: map,
            x: 4,
            y: 4,
            z: 0
        }).ok
    );
    assert.ok(
        dropItemToGround({
            playerInv: inv,
            uid: shieldUid,
            ground,
            player,
            tileMap: map,
            x: 4,
            y: 4,
            z: 0
        }).ok
    );
    const topUid = peekTop(ground, 4, 4, 0);
    assert.ok(topUid);
    const r = moveGroundItemToTile({
        ground,
        uid: topUid,
        player,
        tileMap: map,
        x: 5,
        y: 4,
        z: 0
    });
    assert.ok(r.ok, r.error);
    assert.strictEqual(peekTop(ground, 5, 4, 0), topUid);
    assert.ok(!getStack(ground, 4, 4, 0).includes(topUid));
    assert.strictEqual(getStack(ground, 4, 4, 0).length, 1);
});

test('moveGroundItemToTile: same tile is no-op success', () => {
    const inv = buildInventoryFromSeed(
        {
            equipment: { backpack: 'backpack' },
            backpack: ['iron_longsword']
        },
        ITEM_DB
    );
    const root = getContainer(inv, inv.rootUid);
    const swordUid = root.slots[0];
    const ground = createGroundStore();
    const player = makePlayerAt(4, 4, 0);
    const map = makeTestMap();
    assert.ok(
        dropItemToGround({
            playerInv: inv,
            uid: swordUid,
            ground,
            player,
            tileMap: map,
            x: 4,
            y: 4,
            z: 0
        }).ok
    );
    const uid = peekTop(ground, 4, 4, 0);
    const r = moveGroundItemToTile({
        ground,
        uid,
        player,
        tileMap: map,
        x: 4,
        y: 4,
        z: 0
    });
    assert.ok(r.ok, r.error);
    assert.strictEqual(peekTop(ground, 4, 4, 0), uid);
});

test('moveGroundItemToTile: rejects out_of_range / not_walkable', () => {
    const inv = buildInventoryFromSeed(
        {
            equipment: { backpack: 'backpack' },
            backpack: ['iron_longsword']
        },
        ITEM_DB
    );
    const root = getContainer(inv, inv.rootUid);
    const swordUid = root.slots[0];
    const ground = createGroundStore();
    const player = makePlayerAt(1, 1, 0, { engageRange: 3 });
    const map = makeTestMap({
        block: [
            { x: 2, y: 0 },
            { x: 2, y: 1 },
            { x: 2, y: 2 },
            { x: 2, y: 3 },
            { x: 2, y: 4 },
            { x: 2, y: 5 },
            { x: 2, y: 6 },
            { x: 2, y: 7 },
            { x: 2, y: 8 }
        ]
    });
    assert.ok(
        dropItemToGround({
            playerInv: inv,
            uid: swordUid,
            ground,
            player,
            tileMap: map,
            x: 1,
            y: 1,
            z: 0
        }).ok
    );
    const uid = peekTop(ground, 1, 1, 0);
    assert.strictEqual(
        moveGroundItemToTile({
            ground,
            uid,
            player,
            tileMap: map,
            x: 2,
            y: 1,
            z: 0
        }).error,
        'not_walkable'
    );
    assert.strictEqual(
        moveGroundItemToTile({
            ground,
            uid,
            player,
            tileMap: map,
            x: 8,
            y: 8,
            z: 0
        }).error,
        'out_of_range'
    );
    assert.strictEqual(peekTop(ground, 1, 1, 0), uid);
});

test('moveGroundItemToTile: partial stack leaves remainder on source tile', () => {
    const inv = buildInventoryFromSeed(
        {
            equipment: { backpack: 'backpack' },
            backpack: [{ itemId: 'hunting_arrow', count: 20 }]
        },
        ITEM_DB
    );
    const root = getContainer(inv, inv.rootUid);
    const arrowUid = root.slots[0];
    const ground = createGroundStore();
    const player = makePlayerAt(4, 4, 0);
    const map = makeTestMap();
    assert.ok(
        dropItemToGround({
            playerInv: inv,
            uid: arrowUid,
            ground,
            player,
            tileMap: map,
            x: 4,
            y: 4,
            z: 0
        }).ok
    );
    const srcUid = peekTop(ground, 4, 4, 0);
    assert.strictEqual(getStackCount(getItem(ground.inventory, srcUid)), 20);
    const r = moveGroundItemToTile({
        ground,
        uid: srcUid,
        player,
        tileMap: map,
        x: 5,
        y: 4,
        z: 0,
        count: 7,
        itemDb: ITEM_DB
    });
    assert.ok(r.ok, r.error);
    assert.strictEqual(getStackCount(getItem(ground.inventory, srcUid)), 13);
    assert.ok(getStack(ground, 4, 4, 0).includes(srcUid));
    const destUid = peekTop(ground, 5, 4, 0);
    assert.ok(destUid);
    assert.notStrictEqual(destUid, srcUid);
    assert.strictEqual(getStackCount(getItem(ground.inventory, destUid)), 7);
});

test('picking up ground bag makes isGroundContainerOpenable false', () => {
    const inv = buildInventoryFromSeed(
        {
            equipment: { backpack: 'backpack' },
            backpack: [{ itemId: 'bag', contents: ['steel_helm'] }]
        },
        ITEM_DB
    );
    const root = getContainer(inv, inv.rootUid);
    const bagUid = root.slots[0];
    const ground = createGroundStore();
    const player = makePlayerAt(4, 4, 0);
    const map = makeTestMap();
    assert.ok(
        dropItemToGround({
            playerInv: inv,
            uid: bagUid,
            ground,
            player,
            tileMap: map,
            x: 4,
            y: 4,
            z: 0
        }).ok
    );
    const gBag = peekTop(ground, 4, 4, 0);
    assert.ok(isGroundContainerOpenable(ground, gBag));
    assert.ok(
        pickupItemFromGround({
            ground,
            uid: gBag,
            playerInv: inv,
            player,
            itemDb: ITEM_DB
        }).ok
    );
    assert.ok(!isGroundContainerOpenable(ground, gBag));
});

test('spawnGroundItem places container corpse on tile', () => {
    const ground = createGroundStore();
    const uid = spawnGroundItem({
        ground,
        itemId: 'monster_corpse',
        x: 3,
        y: 4,
        z: 0,
        itemDb: ITEM_DB,
        instFlags: { isCorpse: true, name: 'Dead Cave Rat' }
    });
    assert.ok(uid);
    assert.strictEqual(peekTop(ground, 3, 4, 0), uid);
    const inst = getItem(ground.inventory, uid);
    assert.strictEqual(inst.isCorpse, true);
    assert.strictEqual(inst.name, 'Dead Cave Rat');
    const cont = getContainer(ground.inventory, uid);
    assert.ok(cont);
    assert.strictEqual(cont.capacity, 20);
    assert.ok(cont.slots.every((s) => s == null));
});

test('pickup from corpse container into backpack (Cap-aware)', () => {
    const ground = createGroundStore();
    const corpseUid = spawnGroundItem({
        ground,
        itemId: 'monster_corpse',
        x: 4,
        y: 4,
        z: 0,
        itemDb: ITEM_DB,
        instFlags: { isCorpse: true, name: 'Dead Cave Rat' }
    });
    fillCorpse({
        ground,
        corpseUid,
        items: [{ itemId: 'steel_helm', count: 1 }],
        itemDb: ITEM_DB,
        x: 4,
        y: 4,
        z: 0
    });
    const inv = buildInventoryFromSeed(
        { equipment: { backpack: 'backpack' }, backpack: [] },
        ITEM_DB
    );
    const player = makePlayerAt(4, 4, 0, { level: 50, classId: 'guardian' });
    const helmUid = getContainer(ground.inventory, corpseUid).slots.find(Boolean);
    assert.ok(helmUid);
    const pick = pickupItemFromGround({
        ground,
        uid: helmUid,
        playerInv: inv,
        player,
        itemDb: ITEM_DB
    });
    assert.ok(pick.ok, pick.error);
    assert.ok(getItem(inv, pick.playerUid));
    assert.ok(!getItem(ground.inventory, helmUid));
    assert.ok(isGroundContainerOpenable(ground, corpseUid));
    assert.strictEqual(peekTop(ground, 4, 4, 0), corpseUid);
});

test('pickup from corpse Cap fail leaves item in corpse', () => {
    const ground = createGroundStore();
    const corpseUid = spawnGroundItem({
        ground,
        itemId: 'monster_corpse',
        x: 4,
        y: 4,
        z: 0,
        itemDb: ITEM_DB,
        instFlags: { isCorpse: true, name: 'Dead Cave Rat' }
    });
    fillCorpse({
        ground,
        corpseUid,
        items: [{ itemId: 'lead_anvil', count: 1 }],
        itemDb: ITEM_DB,
        x: 4,
        y: 4,
        z: 0
    });
    const inv = buildInventoryFromSeed(
        {
            equipment: {
                backpack: 'backpack',
                rightHand: 'iron_longsword',
                armor: 'steel_plate'
            },
            backpack: ['steel_helm', 'oak_shield', 'steel_boots', 'steel_greaves']
        },
        ITEM_DB
    );
    const player = makePlayerAt(4, 4, 0, { level: 1, classId: 'guardian' });
    const anvilUid = getContainer(ground.inventory, corpseUid).slots.find(Boolean);
    assert.ok(anvilUid);
    const pick = pickupItemFromGround({
        ground,
        uid: anvilUid,
        playerInv: inv,
        player,
        itemDb: ITEM_DB
    });
    assert.ok(!pick.ok);
    assert.strictEqual(pick.error, 'not_enough_cap');
    assert.ok(getItem(ground.inventory, anvilUid));
    assert.strictEqual(peekTop(ground, 4, 4, 0), corpseUid);
    const cont = getContainer(ground.inventory, corpseUid);
    assert.ok(cont.slots.includes(anvilUid));
});

test('spawnGroundItem forces container when isCorpse / volume', () => {
    const ground = createGroundStore();
    const uid = spawnGroundItem({
        ground,
        itemId: 'rock',
        x: 1,
        y: 1,
        z: 0,
        itemDb: ITEM_DB,
        instFlags: { isCorpse: true },
        volume: 4
    });
    assert.ok(uid);
    const inst = getItem(ground.inventory, uid);
    assert.strictEqual(inst.isCorpse, true);
    const cont = getContainer(ground.inventory, uid);
    assert.ok(cont);
    assert.strictEqual(cont.capacity, 4);
    assert.strictEqual(cont.slots.length, 4);
});

console.log(`inventory tests: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
