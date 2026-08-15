/**
 * mouse_dispatcher — Classic / Regular / Smart + Stage 5a stubs + Stage 6b talk + Stage 8 Browse Field.
 */

'use strict';

const assert = require('assert');
const {
    isImmovableGroundInst,
    topPickableUid,
    findCreatureAtTile,
    itemSupportsDetailsModal,
    resolveCanvasHit,
    processMouseAction,
    applyCommandIntents,
    allowGroundLmbDrag,
    isTalkableNpc,
    isCorpseLike,
    buildCanvasContextMenuEntries,
    buildLookIntent,
    isClassicLookChord,
    resolveStackMoveAmount,
    listBrowsableStackUids,
    hitHasBrowsableItems,
    isInBrowseOpenRange,
    buildBrowseFieldIntent,
    resolveBrowseFieldApproach,
    resolveApproach,
    npcHasDialogData,
    browseFieldTileKey,
    isBrowsableGroundInst,
    BROWSE_FIELD_CAPACITY,
    TALK_NPC_RANGE
} = require('../kernel/apps/game/mouse_dispatcher.js');
const { createGroundStore } = require('../kernel/core/lib/character/ground_items.js');
const {
    createEmptyInventory,
    createItemInstance,
    getItem
} = require('../kernel/core/lib/character/inventory.js');
const { TileMap } = require('../kernel/core/entities/tilemap.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        passed += 1;
        console.log('ok', name);
    } catch (err) {
        failed += 1;
        console.error('FAIL', name);
        console.error(err && err.stack ? err.stack : err);
    }
}

function makePlayer(overrides) {
    return Object.assign(
        {
            id: 'p1',
            alive: true,
            controlMode: 'manual',
            tile: { x: 5, y: 5, z: 0 },
            commandQueue: [],
            inventory: createEmptyInventory()
        },
        overrides || {}
    );
}

function makeSim(overrides) {
    return Object.assign(
        {
            creatures: [],
            groundItems: createGroundStore()
        },
        overrides || {}
    );
}

const itemDb = [
    { id: 'gold_coin', label: 'Gold Coin', weight: 0.1 },
    { id: 'sword', label: 'Sword', weight: 40, equipSlot: 'right_hand', slot: 'rightHand' },
    { id: 'fire_field', label: 'Fire Field', isField: true, immovable: true },
    { id: 'hp_potion', label: 'HP Potion', category: 'potion', usable: true, consumable: true },
    { id: 'blank_rune', label: 'Blank Rune', category: 'rune', multiUse: true },
    { id: 'bag', label: 'Bag', category: 'container', slot: 'backpack' },
    // Stage 5a test corpse template (content flag — no real corpse pipeline)
    { id: 'test_corpse', label: 'Test Corpse', isCorpse: true, weight: 50 }
];

function placeGround(store, x, y, z, itemId, extra) {
    const inv = store.inventory;
    const uid = createItemInstance(inv, itemId, itemDb, {});
    const inst = getItem(inv, uid);
    if (extra && typeof extra === 'object' && inst) {
        Object.assign(inst, extra);
    }
    const key = `${String(z)}:${Math.round(x)}:${Math.round(y)}`;
    if (!store.stacks[key]) store.stacks[key] = [];
    store.stacks[key].push(uid);
    return inst;
}

const SAMPLE_DIALOG = {
    greeting: 'Welcome, hunter.',
    start: 'start',
    nodes: {
        start: {
            text: 'Welcome, hunter.',
            replies: [{ label: 'Bye', action: 'close' }]
        }
    }
};

function baseInput(hit, extra) {
    return Object.assign(
        {
            hit,
            playerControlMode: 'manual',
            playerAlive: true,
            hasInventory: true,
            hasGroundItems: true,
            modifiers: {}
        },
        extra || {}
    );
}

// --- helpers ---

test('isImmovableGroundInst detects fields', () => {
    assert.strictEqual(isImmovableGroundInst(null, null), true);
    assert.strictEqual(isImmovableGroundInst({ isField: true }, null), true);
    assert.strictEqual(
        isImmovableGroundInst({ itemId: 'x' }, { immovable: true }),
        true
    );
    assert.strictEqual(
        isImmovableGroundInst({ itemId: 'gold_coin' }, itemDb[0]),
        false
    );
});

test('itemSupportsDetailsModal for equipment only', () => {
    assert.strictEqual(itemSupportsDetailsModal(itemDb[1]), true); // sword
    assert.strictEqual(itemSupportsDetailsModal(itemDb[0]), false); // gold
    assert.strictEqual(itemSupportsDetailsModal(itemDb[3]), false); // potion
});

test('topPickableUid skips immovable field on top', () => {
    const ground = createGroundStore();
    const coin = placeGround(ground, 1, 2, 0, 'gold_coin');
    placeGround(ground, 1, 2, 0, 'fire_field', {
        isField: true,
        immovable: true,
        name: 'Fire Field'
    });
    const uid = topPickableUid(ground, 1, 2, 0, itemDb);
    assert.strictEqual(uid, coin.uid);
});

test('findCreatureAtTile excludes self and dead', () => {
    const sim = makeSim({
        creatures: [
            { id: 'p1', alive: true, tile: { x: 3, y: 3, z: 0 } },
            { id: 'm1', alive: false, tile: { x: 3, y: 3, z: 0 } },
            { id: 'm2', alive: true, tile: { x: 3, y: 3, z: 0 } }
        ]
    });
    const c = findCreatureAtTile(sim, 3, 3, 0, 'p1');
    assert.ok(c);
    assert.strictEqual(c.id, 'm2');
});

// --- resolveCanvasHit ---

test('resolveCanvasHit empty tile', () => {
    const hit = resolveCanvasHit({
        sim: makeSim(),
        player: makePlayer(),
        tile: { x: 1, y: 1, z: 0 },
        itemDb
    });
    assert.ok(hit);
    assert.strictEqual(hit.creature, null);
    assert.strictEqual(hit.pickableUid, null);
    assert.strictEqual(hit.isPlayerTile, false);
});

test('resolveCanvasHit pickable under field', () => {
    const player = makePlayer();
    const sim = makeSim();
    const coin = placeGround(sim.groundItems, 2, 2, 0, 'gold_coin');
    placeGround(sim.groundItems, 2, 2, 0, 'fire_field', {
        isField: true,
        immovable: true
    });
    const hit = resolveCanvasHit({
        sim,
        player,
        tile: { x: 2, y: 2, z: 0 },
        itemDb
    });
    assert.strictEqual(hit.pickableUid, coin.uid);
    assert.strictEqual(hit.rawTopImmovable, true);
});

// --- LMB unshifted (both modes) ---

test('LMB creature → SET_TARGET (classic)', () => {
    const monster = { id: 'm9', alive: true, tile: { x: 4, y: 4, z: 0 } };
    const player = makePlayer();
    const sim = makeSim({ creatures: [monster] });
    const hit = resolveCanvasHit({
        sim,
        player,
        tile: { x: 4, y: 4, z: 0 },
        itemDb
    });
    const intents = processMouseAction(
        baseInput(hit, { button: 'left', mode: 1 })
    );
    assert.strictEqual(intents[0].type, 'SET_TARGET');
    assert.strictEqual(intents[0].targetId, 'm9');
});

test('LMB empty → START_AUTOWALK', () => {
    const hit = resolveCanvasHit({
        sim: makeSim(),
        player: makePlayer(),
        tile: { x: 9, y: 9, z: 0 },
        itemDb
    });
    const intents = processMouseAction(
        baseInput(hit, { button: 'left', mode: 0 })
    );
    assert.strictEqual(intents[0].type, 'START_AUTOWALK');
});

test('LMB self tile → STOP_AUTOWALK', () => {
    const player = makePlayer({ tile: { x: 5, y: 5, z: 0 } });
    const hit = resolveCanvasHit({
        sim: makeSim(),
        player,
        tile: { x: 5, y: 5, z: 0 },
        itemDb
    });
    const intents = processMouseAction(
        baseInput(hit, { button: 'left', mode: 1 })
    );
    assert.strictEqual(intents[0].type, 'STOP_AUTOWALK');
});

test('LMB with action cursor → RESOLVE + CLEAR', () => {
    const hit = resolveCanvasHit({
        sim: makeSim(),
        player: makePlayer(),
        tile: { x: 1, y: 2, z: 0 },
        itemDb
    });
    const intents = processMouseAction(
        baseInput(hit, {
            button: 'left',
            mode: 1,
            activeCursor: {
                type: 'USE_ITEM_WITH',
                sourceUid: 'u1',
                itemId: 'rune_x'
            }
        })
    );
    assert.strictEqual(intents[0].type, 'RESOLVE_ACTION_CURSOR');
    assert.strictEqual(intents[0].target.kind, 'tile');
    assert.strictEqual(intents[1].type, 'CLEAR_ACTION_CURSOR');
});

test('LMB action cursor single-target empty tile → keep crosshair (no resolve)', () => {
    const hit = resolveCanvasHit({
        sim: makeSim(),
        player: makePlayer(),
        tile: { x: 1, y: 2, z: 0 },
        itemDb
    });
    const intents = processMouseAction(
        baseInput(hit, {
            button: 'left',
            mode: 1,
            activeCursor: {
                type: 'USE_ITEM_WITH',
                sourceUid: 'u1',
                itemId: 'fireburst_rune',
                allowTileAim: false
            }
        })
    );
    assert.deepStrictEqual(intents, [], 'single-target needs creature; empty tile no-op');
});

test('LMB action cursor single-target on creature → RESOLVE entity', () => {
    const sim = makeSim({
        creatures: [
            { id: 'mob1', alive: true, tile: { x: 2, y: 2, z: 0 }, name: 'Rat' }
        ]
    });
    const hit = resolveCanvasHit({
        sim,
        player: makePlayer(),
        tile: { x: 2, y: 2, z: 0 },
        itemDb
    });
    assert.ok(hit.creature, 'creature hit');
    const intents = processMouseAction(
        baseInput(hit, {
            button: 'left',
            mode: 1,
            activeCursor: {
                type: 'USE_ITEM_WITH',
                itemId: 'fireburst_rune',
                allowTileAim: false
            }
        })
    );
    assert.strictEqual(intents[0].type, 'RESOLVE_ACTION_CURSOR');
    assert.deepStrictEqual(intents[0].target, { kind: 'entity', id: 'mob1' });
    assert.strictEqual(intents[1].type, 'CLEAR_ACTION_CURSOR');
});

test('LMB action cursor AoE allowTileAim on empty tile → tile target', () => {
    const hit = resolveCanvasHit({
        sim: makeSim(),
        player: makePlayer(),
        tile: { x: 4, y: 4, z: 0 },
        itemDb
    });
    const intents = processMouseAction(
        baseInput(hit, {
            button: 'left',
            mode: 1,
            activeCursor: {
                type: 'USE_ITEM_WITH',
                itemId: 'blaze_bomb_rune',
                allowTileAim: true
            }
        })
    );
    assert.strictEqual(intents[0].type, 'RESOLVE_ACTION_CURSOR');
    assert.deepStrictEqual(intents[0].target, {
        kind: 'tile',
        x: 4,
        y: 4,
        z: 0
    });
});

test('LMB AI player → no intents', () => {
    const hit = resolveCanvasHit({
        sim: makeSim(),
        player: makePlayer({ controlMode: 'ai' }),
        tile: { x: 1, y: 1, z: 0 },
        itemDb
    });
    const intents = processMouseAction(
        baseInput(hit, {
            button: 'left',
            mode: 1,
            playerControlMode: 'ai'
        })
    );
    assert.deepStrictEqual(intents, []);
});

// --- Classic RMB ---

test('Classic RMB creature → SET_TARGET', () => {
    const monster = { id: 'm1', alive: true, tile: { x: 2, y: 2, z: 0 } };
    const player = makePlayer();
    const sim = makeSim({ creatures: [monster] });
    const hit = resolveCanvasHit({
        sim,
        player,
        tile: { x: 2, y: 2, z: 0 },
        itemDb
    });
    const intents = processMouseAction(
        baseInput(hit, { button: 'right', mode: 1 })
    );
    assert.strictEqual(intents[0].type, 'SET_TARGET');
});

test('Classic RMB pickable gold → PICKUP (after useThing fallthrough)', () => {
    const player = makePlayer();
    const sim = makeSim();
    const coin = placeGround(sim.groundItems, 3, 3, 0, 'gold_coin');
    const hit = resolveCanvasHit({
        sim,
        player,
        tile: { x: 3, y: 3, z: 0 },
        itemDb
    });
    const intents = processMouseAction(
        baseInput(hit, { button: 'right', mode: 1 })
    );
    assert.strictEqual(intents.length, 1);
    assert.strictEqual(intents[0].type, 'PICKUP');
    assert.strictEqual(intents[0].pickableUid, coin.uid);
});

test('Classic RMB bag → OPEN_CONTAINER ground (not menu, not pickup)', () => {
    const player = makePlayer();
    const sim = makeSim();
    const bag = placeGround(sim.groundItems, 3, 3, 0, 'bag');
    const hit = resolveCanvasHit({
        sim,
        player,
        tile: { x: 3, y: 3, z: 0 },
        itemDb
    });
    const intents = processMouseAction(
        baseInput(hit, { button: 'right', mode: 1 })
    );
    assert.strictEqual(intents.length, 1);
    assert.strictEqual(intents[0].type, 'OPEN_CONTAINER');
    assert.strictEqual(intents[0].ground, true);
    assert.strictEqual(intents[0].sourceUid, bag.uid);
});

test('Classic RMB usable potion → USE_ITEM', () => {
    const player = makePlayer();
    const sim = makeSim();
    const pot = placeGround(sim.groundItems, 3, 3, 0, 'hp_potion');
    const hit = resolveCanvasHit({
        sim,
        player,
        tile: { x: 3, y: 3, z: 0 },
        itemDb
    });
    const intents = processMouseAction(
        baseInput(hit, { button: 'right', mode: 1 })
    );
    assert.strictEqual(intents[0].type, 'USE_ITEM');
    assert.strictEqual(intents[0].sourceUid, pot.uid);
});

test('Classic RMB multi-use rune → ENTER_USE_WITH', () => {
    const player = makePlayer();
    const sim = makeSim();
    const rune = placeGround(sim.groundItems, 3, 3, 0, 'blank_rune');
    const hit = resolveCanvasHit({
        sim,
        player,
        tile: { x: 3, y: 3, z: 0 },
        itemDb
    });
    const intents = processMouseAction(
        baseInput(hit, { button: 'right', mode: 1 })
    );
    assert.strictEqual(intents[0].type, 'ENTER_USE_WITH');
    assert.strictEqual(intents[0].sourceUid, rune.uid);
});

test('Classic RMB empty → START_AUTOWALK', () => {
    const hit = resolveCanvasHit({
        sim: makeSim(),
        player: makePlayer(),
        tile: { x: 8, y: 8, z: 0 },
        itemDb
    });
    const intents = processMouseAction(
        baseInput(hit, { button: 'right', mode: 1 })
    );
    assert.strictEqual(intents[0].type, 'START_AUTOWALK');
});

test('Classic RMB self empty → STOP_AUTOWALK', () => {
    const player = makePlayer({ tile: { x: 5, y: 5, z: 0 } });
    const hit = resolveCanvasHit({
        sim: makeSim(),
        player,
        tile: { x: 5, y: 5, z: 0 },
        itemDb
    });
    const intents = processMouseAction(
        baseInput(hit, { button: 'right', mode: 1 })
    );
    assert.strictEqual(intents[0].type, 'STOP_AUTOWALK');
});

test('Classic Ctrl+RMB empty → OPEN_CONTEXT_MENU', () => {
    const hit = resolveCanvasHit({
        sim: makeSim(),
        player: makePlayer(),
        tile: { x: 8, y: 8, z: 0 },
        itemDb
    });
    const intents = processMouseAction(
        baseInput(hit, {
            button: 'right',
            mode: 1,
            modifiers: { ctrl: true }
        })
    );
    assert.strictEqual(intents[0].type, 'OPEN_CONTEXT_MENU');
    assert.ok(Array.isArray(intents[0].entries));
    assert.ok(intents[0].entries.some((e) => e.id === 'look'));
});

test('Classic Ctrl+LMB any tile → OPEN_CONTEXT_MENU', () => {
    const hit = resolveCanvasHit({
        sim: makeSim(),
        player: makePlayer(),
        tile: { x: 1, y: 1, z: 0 },
        itemDb
    });
    const intents = processMouseAction(
        baseInput(hit, {
            button: 'left',
            mode: 1,
            modifiers: { ctrl: true }
        })
    );
    assert.strictEqual(intents[0].type, 'OPEN_CONTEXT_MENU');
});

// --- Regular RMB ---

test('Regular RMB empty → OPEN_CONTEXT_MENU (no walk)', () => {
    const hit = resolveCanvasHit({
        sim: makeSim(),
        player: makePlayer(),
        tile: { x: 8, y: 8, z: 0 },
        itemDb
    });
    const intents = processMouseAction(
        baseInput(hit, { button: 'right', mode: 0 })
    );
    assert.strictEqual(intents[0].type, 'OPEN_CONTEXT_MENU');
    assert.ok(!intents.some((x) => x.type === 'START_AUTOWALK'));
});

test('Regular RMB creature → OPEN_CONTEXT_MENU with Attack', () => {
    const monster = {
        id: 'm1',
        name: 'Rat',
        alive: true,
        tile: { x: 2, y: 2, z: 0 }
    };
    const player = makePlayer();
    const sim = makeSim({ creatures: [monster] });
    const hit = resolveCanvasHit({
        sim,
        player,
        tile: { x: 2, y: 2, z: 0 },
        itemDb
    });
    const intents = processMouseAction(
        baseInput(hit, { button: 'right', mode: 0 })
    );
    assert.strictEqual(intents[0].type, 'OPEN_CONTEXT_MENU');
    const ids = intents[0].entries.map((e) => e.id);
    assert.ok(ids.includes('look'));
    assert.ok(ids.includes('attack'));
});

test('Regular RMB pickable → menu with pickup (not direct pickup)', () => {
    const player = makePlayer();
    const sim = makeSim();
    placeGround(sim.groundItems, 3, 3, 0, 'gold_coin');
    const hit = resolveCanvasHit({
        sim,
        player,
        tile: { x: 3, y: 3, z: 0 },
        itemDb
    });
    const intents = processMouseAction(
        baseInput(hit, { button: 'right', mode: 0 })
    );
    assert.strictEqual(intents[0].type, 'OPEN_CONTEXT_MENU');
    assert.ok(intents[0].entries.some((e) => e.id === 'pickup'));
    assert.ok(!intents.some((x) => x.type === 'PICKUP'));
});

// --- Shared modifiers ---

test('Shift+LMB equipment → LOOK modal', () => {
    const player = makePlayer();
    const sim = makeSim();
    placeGround(sim.groundItems, 3, 3, 0, 'sword');
    const hit = resolveCanvasHit({
        sim,
        player,
        tile: { x: 3, y: 3, z: 0 },
        itemDb
    });
    const intents = processMouseAction(
        baseInput(hit, {
            button: 'left',
            mode: 1,
            modifiers: { shift: true }
        })
    );
    assert.strictEqual(intents[0].type, 'LOOK');
    assert.strictEqual(intents[0].style, 'modal');
});

test('Shift+RMB gold → LOOK fct', () => {
    const player = makePlayer();
    const sim = makeSim();
    placeGround(sim.groundItems, 3, 3, 0, 'gold_coin');
    const hit = resolveCanvasHit({
        sim,
        player,
        tile: { x: 3, y: 3, z: 0 },
        itemDb
    });
    const intents = processMouseAction(
        baseInput(hit, {
            button: 'right',
            mode: 0,
            modifiers: { shift: true }
        })
    );
    assert.strictEqual(intents[0].type, 'LOOK');
    assert.strictEqual(intents[0].style, 'fct');
    assert.ok(String(intents[0].text).toLowerCase().includes('gold'));
});

test('Shift+LMB creature → LOOK fct name', () => {
    const monster = {
        id: 'm1',
        name: 'Dragon',
        alive: true,
        tile: { x: 2, y: 2, z: 0 }
    };
    const hit = resolveCanvasHit({
        sim: makeSim({ creatures: [monster] }),
        player: makePlayer(),
        tile: { x: 2, y: 2, z: 0 },
        itemDb
    });
    const intents = processMouseAction(
        baseInput(hit, {
            button: 'left',
            mode: 1,
            modifiers: { shift: true }
        })
    );
    assert.strictEqual(intents[0].type, 'LOOK');
    assert.strictEqual(intents[0].style, 'fct');
    assert.strictEqual(intents[0].text, 'Dragon');
});

test('Shift+LMB empty tile → LOOK fct coords', () => {
    const hit = resolveCanvasHit({
        sim: makeSim(),
        player: makePlayer(),
        tile: { x: 7, y: 9, z: 0 },
        itemDb
    });
    const intents = processMouseAction(
        baseInput(hit, {
            button: 'left',
            mode: 0,
            modifiers: { shift: true }
        })
    );
    assert.strictEqual(intents[0].type, 'LOOK');
    assert.ok(intents[0].text.includes('7'));
    assert.ok(intents[0].text.includes('9'));
});

test('Alt+RMB creature → SET_TARGET (both modes)', () => {
    const monster = { id: 'm1', alive: true, tile: { x: 2, y: 2, z: 0 } };
    const hit = resolveCanvasHit({
        sim: makeSim({ creatures: [monster] }),
        player: makePlayer(),
        tile: { x: 2, y: 2, z: 0 },
        itemDb
    });
    for (const mode of [0, 1]) {
        const intents = processMouseAction(
            baseInput(hit, {
                button: 'right',
                mode,
                modifiers: { alt: true }
            })
        );
        assert.strictEqual(intents[0].type, 'SET_TARGET', 'mode ' + mode);
    }
});

test('Alt+LMB empty → no intents', () => {
    const hit = resolveCanvasHit({
        sim: makeSim(),
        player: makePlayer(),
        tile: { x: 1, y: 1, z: 0 },
        itemDb
    });
    const intents = processMouseAction(
        baseInput(hit, {
            button: 'left',
            mode: 1,
            modifiers: { alt: true }
        })
    );
    assert.deepStrictEqual(intents, []);
});

// --- Regular Ctrl use ---

test('Regular Ctrl+LMB multiuse → ENTER_USE_WITH', () => {
    const player = makePlayer();
    const sim = makeSim();
    placeGround(sim.groundItems, 3, 3, 0, 'blank_rune');
    const hit = resolveCanvasHit({
        sim,
        player,
        tile: { x: 3, y: 3, z: 0 },
        itemDb
    });
    const intents = processMouseAction(
        baseInput(hit, {
            button: 'left',
            mode: 0,
            modifiers: { ctrl: true }
        })
    );
    assert.strictEqual(intents[0].type, 'ENTER_USE_WITH');
});

test('Regular Ctrl+RMB usable → USE_ITEM', () => {
    const player = makePlayer();
    const sim = makeSim();
    placeGround(sim.groundItems, 3, 3, 0, 'hp_potion');
    const hit = resolveCanvasHit({
        sim,
        player,
        tile: { x: 3, y: 3, z: 0 },
        itemDb
    });
    const intents = processMouseAction(
        baseInput(hit, {
            button: 'right',
            mode: 0,
            modifiers: { ctrl: true }
        })
    );
    assert.strictEqual(intents[0].type, 'USE_ITEM');
});

test('Regular Ctrl empty → OPEN_CONTEXT_MENU fallback', () => {
    const hit = resolveCanvasHit({
        sim: makeSim(),
        player: makePlayer(),
        tile: { x: 1, y: 1, z: 0 },
        itemDb
    });
    const intents = processMouseAction(
        baseInput(hit, {
            button: 'left',
            mode: 0,
            modifiers: { ctrl: true }
        })
    );
    assert.strictEqual(intents[0].type, 'OPEN_CONTEXT_MENU');
});

// --- Menu builder ---

test('buildCanvasContextMenuEntries empty has Look', () => {
    const hit = resolveCanvasHit({
        sim: makeSim(),
        player: makePlayer(),
        tile: { x: 1, y: 1, z: 0 },
        itemDb
    });
    const entries = buildCanvasContextMenuEntries(hit);
    assert.ok(entries.some((e) => e.id === 'look'));
    assert.ok(!entries.some((e) => e.id === 'pickup'));
});

test('buildCanvasContextMenuEntries sword has View details + pickup', () => {
    const player = makePlayer();
    const sim = makeSim();
    placeGround(sim.groundItems, 1, 1, 0, 'sword');
    const hit = resolveCanvasHit({
        sim,
        player,
        tile: { x: 1, y: 1, z: 0 },
        itemDb
    });
    const entries = buildCanvasContextMenuEntries(hit);
    assert.ok(entries.some((e) => e.id === 'view_details'));
    assert.ok(entries.some((e) => e.id === 'pickup'));
    const browse = entries.find((e) => e.id === 'browse_field');
    assert.ok(browse, 'browse_field enabled when ground item present');
    assert.ok(!browse.stub && !browse.disabled);
    assert.strictEqual(browse.x, 1);
    assert.strictEqual(browse.y, 1);
});

test('buildLookIntent field uses fct', () => {
    const player = makePlayer();
    const sim = makeSim();
    placeGround(sim.groundItems, 1, 1, 0, 'fire_field', {
        isField: true,
        immovable: true,
        name: 'Fire Field'
    });
    const hit = resolveCanvasHit({
        sim,
        player,
        tile: { x: 1, y: 1, z: 0 },
        itemDb
    });
    const look = buildLookIntent(hit);
    assert.strictEqual(look.style, 'fct');
    assert.ok(String(look.text).toLowerCase().includes('fire'));
});

// --- applyCommandIntents ---

test('applyCommandIntents queues SET_TARGET and leaves menu', () => {
    const player = makePlayer();
    const monster = { id: 'mx', alive: true };
    const remaining = applyCommandIntents(
        player,
        [
            { type: 'SET_TARGET', targetId: 'mx', creature: monster },
            {
                type: 'OPEN_CONTEXT_MENU',
                pickableUid: 'u1',
                tile: { x: 1, y: 1, z: 0 },
                entries: []
            }
        ],
        {}
    );
    assert.strictEqual(player.commandQueue[0].type, 'SET_TARGET');
    assert.strictEqual(remaining[0].type, 'OPEN_CONTEXT_MENU');
});

test('applyCommandIntents USE_STAIR queues command', () => {
    const player = makePlayer();
    const remaining = applyCommandIntents(
        player,
        [{ type: 'USE_STAIR', dest: { x: 2, y: 3, z: 0 } }],
        {}
    );
    assert.strictEqual(remaining.length, 0);
    assert.strictEqual(player.commandQueue[0].type, 'USE_STAIR');
    assert.deepStrictEqual(player.commandQueue[0].dest, { x: 2, y: 3, z: 0 });
});

test('ladder pad hit is Use (not hop-on-step); stair pad is not', () => {
    const player = makePlayer({ tile: { x: 2, y: 2, z: 0 } });
    const map = new TileMap('mouse_ladders');
    const open = new Uint8Array(25);
    open.fill(100);
    map.loadFloorFromFriction(0, 5, 5, open);
    map.addStair(
        { x: 1, y: 1, z: 0 },
        { x: 1, y: 1, z: 1 },
        { type: 'ladder' }
    );
    map.addStair(
        { x: 3, y: 1, z: 0 },
        { x: 3, y: 1, z: 1 },
        { type: 'stairs' }
    );
    const sim = makeSim({ tileMap: map });

    const ladderHit = resolveCanvasHit({
        sim,
        player,
        tile: { x: 1, y: 1, z: 0 },
        itemDb
    });
    assert.strictEqual(ladderHit.useStair, true);
    const ladderEntries = buildCanvasContextMenuEntries(ladderHit);
    assert.ok(ladderEntries.some((e) => e.id === 'use_stair'));

    const classicRmb = processMouseAction(
        baseInput(ladderHit, { button: 'right', mode: 1 })
    );
    assert.strictEqual(classicRmb[0].type, 'USE_STAIR');

    const smartLmb = processMouseAction(
        baseInput(ladderHit, { button: 'left', mode: 2 })
    );
    assert.strictEqual(smartLmb[0].type, 'USE_STAIR');

    const regularCtrl = processMouseAction(
        baseInput(ladderHit, {
            button: 'left',
            mode: 0,
            modifiers: { ctrl: true }
        })
    );
    assert.strictEqual(regularCtrl[0].type, 'USE_STAIR');

    const stairHit = resolveCanvasHit({
        sim,
        player,
        tile: { x: 3, y: 1, z: 0 },
        itemDb
    });
    assert.strictEqual(stairHit.useStair, false);
    assert.ok(
        !buildCanvasContextMenuEntries(stairHit).some((e) => e.id === 'use_stair')
    );
});

test('applyCommandIntents USE_ITEM queues command', () => {
    const player = makePlayer();
    const remaining = applyCommandIntents(
        player,
        [
            {
                type: 'USE_ITEM',
                sourceUid: 's1',
                itemId: 'hp_potion',
                target: { kind: 'self' }
            }
        ],
        {}
    );
    assert.strictEqual(remaining.length, 0);
    assert.strictEqual(player.commandQueue[0].type, 'USE_ITEM');
});

test('applyCommandIntents leaves PICKUP and LOOK for adapter', () => {
    const player = makePlayer();
    const remaining = applyCommandIntents(
        player,
        [
            { type: 'PICKUP', pickableUid: 'u1', tile: { x: 1, y: 1, z: 0 } },
            { type: 'LOOK', style: 'fct', text: 'Hi' }
        ],
        {}
    );
    assert.strictEqual(remaining.length, 2);
});

test('Shift wins over Alt when both held', () => {
    const monster = {
        id: 'm1',
        name: 'Orc',
        alive: true,
        tile: { x: 2, y: 2, z: 0 }
    };
    const hit = resolveCanvasHit({
        sim: makeSim({ creatures: [monster] }),
        player: makePlayer(),
        tile: { x: 2, y: 2, z: 0 },
        itemDb
    });
    const intents = processMouseAction(
        baseInput(hit, {
            button: 'left',
            mode: 1,
            modifiers: { shift: true, alt: true }
        })
    );
    assert.strictEqual(intents[0].type, 'LOOK');
});

// --- Stage 4: Left Smart-Click (mode 2) ---

test('isTalkableNpc flags', () => {
    assert.strictEqual(isTalkableNpc(null), false);
    assert.strictEqual(isTalkableNpc({ id: 'm1' }), false);
    assert.strictEqual(isTalkableNpc({ isNpc: true }), true);
    assert.strictEqual(isTalkableNpc({ kind: 'npc' }), true);
    assert.strictEqual(isTalkableNpc({ flags: { isNpc: true } }), true);
    assert.strictEqual(
        isTalkableNpc({ isNpc: true, attackableNpc: true }),
        false,
        'Q6.2 hostile never-talk'
    );
});

test('Smart LMB creature → SET_TARGET', () => {
    const monster = { id: 'm2', alive: true, tile: { x: 4, y: 4, z: 0 } };
    const player = makePlayer();
    const hit = resolveCanvasHit({
        sim: makeSim({ creatures: [monster] }),
        player,
        tile: { x: 4, y: 4, z: 0 },
        itemDb
    });
    const intents = processMouseAction(
        baseInput(hit, { button: 'left', mode: 2, playerTile: player.tile })
    );
    assert.strictEqual(intents[0].type, 'SET_TARGET');
    assert.strictEqual(intents[0].targetId, 'm2');
});

test('Smart LMB mixed creature + loot → attack first (Q4.1)', () => {
    const monster = { id: 'm3', alive: true, tile: { x: 3, y: 3, z: 0 } };
    const player = makePlayer();
    const sim = makeSim({ creatures: [monster] });
    placeGround(sim.groundItems, 3, 3, 0, 'gold_coin');
    const hit = resolveCanvasHit({
        sim,
        player,
        tile: { x: 3, y: 3, z: 0 },
        itemDb
    });
    assert.ok(hit.pickableUid, 'loot present on tile');
    const intents = processMouseAction(
        baseInput(hit, { button: 'left', mode: 2, playerTile: player.tile })
    );
    assert.strictEqual(intents[0].type, 'SET_TARGET');
    assert.strictEqual(intents[0].targetId, 'm3');
});

test('Smart LMB multi-use → ENTER_USE_WITH (Q4.2)', () => {
    const player = makePlayer();
    const sim = makeSim();
    const rune = placeGround(sim.groundItems, 2, 2, 0, 'blank_rune');
    const hit = resolveCanvasHit({
        sim,
        player,
        tile: { x: 2, y: 2, z: 0 },
        itemDb
    });
    const intents = processMouseAction(
        baseInput(hit, { button: 'left', mode: 2, playerTile: player.tile })
    );
    assert.strictEqual(intents[0].type, 'ENTER_USE_WITH');
    assert.strictEqual(intents[0].sourceUid, rune.uid);
});

test('Smart LMB usable potion → USE_ITEM', () => {
    const player = makePlayer();
    const sim = makeSim();
    const pot = placeGround(sim.groundItems, 2, 2, 0, 'hp_potion');
    const hit = resolveCanvasHit({
        sim,
        player,
        tile: { x: 2, y: 2, z: 0 },
        itemDb
    });
    const intents = processMouseAction(
        baseInput(hit, { button: 'left', mode: 2, playerTile: player.tile })
    );
    assert.strictEqual(intents[0].type, 'USE_ITEM');
    assert.strictEqual(intents[0].sourceUid, pot.uid);
    assert.deepStrictEqual(intents[0].target, { kind: 'self' });
});

test('Smart LMB container → OPEN_CONTAINER ground', () => {
    const player = makePlayer();
    const sim = makeSim();
    const bag = placeGround(sim.groundItems, 2, 2, 0, 'bag');
    const hit = resolveCanvasHit({
        sim,
        player,
        tile: { x: 2, y: 2, z: 0 },
        itemDb
    });
    const intents = processMouseAction(
        baseInput(hit, { button: 'left', mode: 2, playerTile: player.tile })
    );
    assert.strictEqual(intents[0].type, 'OPEN_CONTAINER');
    assert.strictEqual(intents[0].ground, true);
    assert.strictEqual(intents[0].sourceUid, bag.uid);
});

test('Smart LMB pickable gold → PICKUP', () => {
    const player = makePlayer();
    const sim = makeSim();
    const coin = placeGround(sim.groundItems, 2, 2, 0, 'gold_coin');
    const hit = resolveCanvasHit({
        sim,
        player,
        tile: { x: 2, y: 2, z: 0 },
        itemDb
    });
    const intents = processMouseAction(
        baseInput(hit, { button: 'left', mode: 2, playerTile: player.tile })
    );
    assert.strictEqual(intents[0].type, 'PICKUP');
    assert.strictEqual(intents[0].pickableUid, coin.uid);
});

test('Smart LMB empty → START_AUTOWALK', () => {
    const player = makePlayer();
    const hit = resolveCanvasHit({
        sim: makeSim(),
        player,
        tile: { x: 9, y: 9, z: 0 },
        itemDb
    });
    const intents = processMouseAction(
        baseInput(hit, { button: 'left', mode: 2, playerTile: player.tile })
    );
    assert.strictEqual(intents[0].type, 'START_AUTOWALK');
});

test('Smart LMB NPC in range with dialog → TALK_NPC (not stub)', () => {
    const npc = {
        id: 'npc1',
        isNpc: true,
        alive: true,
        dialog: SAMPLE_DIALOG,
        tile: { x: 6, y: 5, z: 0 }
    };
    const player = makePlayer({ tile: { x: 5, y: 5, z: 0 } });
    const hit = resolveCanvasHit({
        sim: makeSim({ creatures: [npc] }),
        player,
        tile: { x: 6, y: 5, z: 0 },
        itemDb
    });
    const intents = processMouseAction(
        baseInput(hit, { button: 'left', mode: 2, playerTile: player.tile })
    );
    assert.strictEqual(intents[0].type, 'TALK_NPC');
    assert.strictEqual(intents[0].stub, false);
    assert.strictEqual(intents[0].creatureId, 'npc1');
});

test('Smart LMB NPC in range without dialog → TALK_NPC stub', () => {
    const npc = {
        id: 'npc1b',
        isNpc: true,
        alive: true,
        tile: { x: 6, y: 5, z: 0 }
    };
    const player = makePlayer({ tile: { x: 5, y: 5, z: 0 } });
    const hit = resolveCanvasHit({
        sim: makeSim({ creatures: [npc] }),
        player,
        tile: { x: 6, y: 5, z: 0 },
        itemDb
    });
    const intents = processMouseAction(
        baseInput(hit, { button: 'left', mode: 2, playerTile: player.tile })
    );
    assert.strictEqual(intents[0].type, 'TALK_NPC');
    assert.strictEqual(intents[0].stub, true);
});

test('Smart LMB NPC out of range → TALK_NPC (adapter walks, never attack)', () => {
    const npc = {
        id: 'npc2',
        isNpc: true,
        alive: true,
        dialog: SAMPLE_DIALOG,
        tile: { x: 12, y: 12, z: 0 }
    };
    const player = makePlayer({ tile: { x: 5, y: 5, z: 0 } });
    const hit = resolveCanvasHit({
        sim: makeSim({ creatures: [npc] }),
        player,
        tile: { x: 12, y: 12, z: 0 },
        itemDb
    });
    const intents = processMouseAction(
        baseInput(hit, { button: 'left', mode: 2, playerTile: player.tile })
    );
    assert.strictEqual(intents[0].type, 'TALK_NPC');
    assert.strictEqual(intents[0].stub, false);
    assert.notStrictEqual(intents[0].type, 'SET_TARGET');
});

test('Smart unshifted RMB → OPEN_CONTEXT_MENU', () => {
    const player = makePlayer();
    const hit = resolveCanvasHit({
        sim: makeSim(),
        player,
        tile: { x: 1, y: 1, z: 0 },
        itemDb
    });
    const intents = processMouseAction(
        baseInput(hit, { button: 'right', mode: 2 })
    );
    assert.strictEqual(intents[0].type, 'OPEN_CONTEXT_MENU');
});

test('Smart Ctrl on bag → OPEN_CONTAINER', () => {
    const player = makePlayer();
    const sim = makeSim();
    placeGround(sim.groundItems, 2, 2, 0, 'bag');
    const hit = resolveCanvasHit({
        sim,
        player,
        tile: { x: 2, y: 2, z: 0 },
        itemDb
    });
    const intents = processMouseAction(
        baseInput(hit, {
            button: 'left',
            mode: 2,
            modifiers: { ctrl: true }
        })
    );
    assert.strictEqual(intents[0].type, 'OPEN_CONTAINER');
});

test('Smart Ctrl on empty / non-container → menu', () => {
    const player = makePlayer();
    const sim = makeSim();
    placeGround(sim.groundItems, 2, 2, 0, 'gold_coin');
    const hit = resolveCanvasHit({
        sim,
        player,
        tile: { x: 2, y: 2, z: 0 },
        itemDb
    });
    const intents = processMouseAction(
        baseInput(hit, {
            button: 'right',
            mode: 2,
            modifiers: { ctrl: true }
        })
    );
    assert.strictEqual(intents[0].type, 'OPEN_CONTEXT_MENU');
});

test('allowGroundLmbDrag mode 2 blocks creature + use items', () => {
    const monster = { id: 'm9', alive: true, tile: { x: 2, y: 2, z: 0 } };
    const player = makePlayer();
    const sim = makeSim({ creatures: [monster] });
    placeGround(sim.groundItems, 2, 2, 0, 'gold_coin');
    const hitMixed = resolveCanvasHit({
        sim,
        player,
        tile: { x: 2, y: 2, z: 0 },
        itemDb
    });
    assert.strictEqual(
        allowGroundLmbDrag({ hit: hitMixed, mode: 2, modifiers: {} }),
        false,
        'creature blocks drag'
    );

    const sim2 = makeSim();
    placeGround(sim2.groundItems, 1, 1, 0, 'blank_rune');
    const hitRune = resolveCanvasHit({
        sim: sim2,
        player,
        tile: { x: 1, y: 1, z: 0 },
        itemDb
    });
    assert.strictEqual(
        allowGroundLmbDrag({ hit: hitRune, mode: 2 }),
        false,
        'multi-use blocks drag'
    );

    const sim3 = makeSim();
    placeGround(sim3.groundItems, 1, 1, 0, 'gold_coin');
    const hitGold = resolveCanvasHit({
        sim: sim3,
        player,
        tile: { x: 1, y: 1, z: 0 },
        itemDb
    });
    assert.strictEqual(
        allowGroundLmbDrag({ hit: hitGold, mode: 2 }),
        true,
        'pure pickupable allows drag'
    );

    assert.strictEqual(
        allowGroundLmbDrag({
            hit: hitGold,
            mode: 2,
            modifiers: { shift: true }
        }),
        false,
        'Shift never starts drag'
    );

    // Modes 0/1 still allow drag pipeline for pickables
    assert.strictEqual(
        allowGroundLmbDrag({ hit: hitGold, mode: 1 }),
        true
    );
});

// --- Stage 5a: loot / quickloot / open corpse stubs ---

function placeCorpse(sim, x, y, z) {
    return placeGround(sim.groundItems, x, y, z, 'test_corpse');
}

test('isCorpseLike + resolveCanvasHit.isCorpse', () => {
    assert.strictEqual(isCorpseLike(null), false);
    assert.strictEqual(isCorpseLike({ isCorpse: true }), true);
    const player = makePlayer();
    const sim = makeSim();
    placeCorpse(sim, 2, 2, 0);
    const hit = resolveCanvasHit({
        sim,
        player,
        tile: { x: 2, y: 2, z: 0 },
        itemDb
    });
    assert.strictEqual(hit.isCorpse, true);
    assert.strictEqual(isCorpseLike(hit), true);
    const goldSim = makeSim();
    placeGround(goldSim.groundItems, 1, 1, 0, 'gold_coin');
    const goldHit = resolveCanvasHit({
        sim: goldSim,
        player,
        tile: { x: 1, y: 1, z: 0 },
        itemDb
    });
    assert.strictEqual(goldHit.isCorpse, false);
});

test('Classic lootMode 0 unshifted RMB corpse → QUICKLOOT stub', () => {
    const player = makePlayer();
    const sim = makeSim();
    placeCorpse(sim, 3, 3, 0);
    const hit = resolveCanvasHit({
        sim,
        player,
        tile: { x: 3, y: 3, z: 0 },
        itemDb
    });
    const intents = processMouseAction(
        baseInput(hit, {
            button: 'right',
            mode: 1,
            lootMode: 0,
            playerTile: player.tile
        })
    );
    assert.strictEqual(intents[0].type, 'QUICKLOOT');
    assert.strictEqual(intents[0].stub, true);
});

test('Classic lootMode 0 Shift+RMB corpse → OPEN_CORPSE stub', () => {
    const player = makePlayer();
    const sim = makeSim();
    placeCorpse(sim, 3, 3, 0);
    const hit = resolveCanvasHit({
        sim,
        player,
        tile: { x: 3, y: 3, z: 0 },
        itemDb
    });
    const intents = processMouseAction(
        baseInput(hit, {
            button: 'right',
            mode: 1,
            lootMode: 0,
            modifiers: { shift: true }
        })
    );
    assert.strictEqual(intents[0].type, 'OPEN_CORPSE');
    assert.strictEqual(intents[0].stub, true);
});

test('Classic lootMode 1 unshifted RMB corpse → OPEN_CORPSE; Shift → QUICKLOOT', () => {
    const player = makePlayer();
    const sim = makeSim();
    placeCorpse(sim, 3, 3, 0);
    const hit = resolveCanvasHit({
        sim,
        player,
        tile: { x: 3, y: 3, z: 0 },
        itemDb
    });
    const open = processMouseAction(
        baseInput(hit, { button: 'right', mode: 1, lootMode: 1 })
    );
    assert.strictEqual(open[0].type, 'OPEN_CORPSE');
    const ql = processMouseAction(
        baseInput(hit, {
            button: 'right',
            mode: 1,
            lootMode: 1,
            modifiers: { shift: true }
        })
    );
    assert.strictEqual(ql[0].type, 'QUICKLOOT');
});

test('Classic lootMode 2 LMB corpse → QUICKLOOT; RMB → OPEN_CORPSE', () => {
    const player = makePlayer();
    const sim = makeSim();
    placeCorpse(sim, 3, 3, 0);
    const hit = resolveCanvasHit({
        sim,
        player,
        tile: { x: 3, y: 3, z: 0 },
        itemDb
    });
    const left = processMouseAction(
        baseInput(hit, {
            button: 'left',
            mode: 1,
            lootMode: 2,
            playerTile: player.tile
        })
    );
    assert.strictEqual(left[0].type, 'QUICKLOOT');
    const right = processMouseAction(
        baseInput(hit, { button: 'right', mode: 1, lootMode: 2 })
    );
    assert.strictEqual(right[0].type, 'OPEN_CORPSE');
});

test('Classic lootMode does not change non-corpse behavior', () => {
    const player = makePlayer();
    const sim = makeSim();
    placeGround(sim.groundItems, 2, 2, 0, 'gold_coin');
    const hit = resolveCanvasHit({
        sim,
        player,
        tile: { x: 2, y: 2, z: 0 },
        itemDb
    });
    const intents = processMouseAction(
        baseInput(hit, { button: 'right', mode: 1, lootMode: 0 })
    );
    assert.strictEqual(intents[0].type, 'PICKUP', 'gold still picks up');
    const empty = resolveCanvasHit({
        sim: makeSim(),
        player,
        tile: { x: 8, y: 8, z: 0 },
        itemDb
    });
    const walk = processMouseAction(
        baseInput(empty, { button: 'right', mode: 1, lootMode: 2 })
    );
    assert.strictEqual(walk[0].type, 'START_AUTOWALK');
});

test('Smart LMB corpse → QUICKLOOT stub (priority slot 4)', () => {
    const player = makePlayer();
    const sim = makeSim();
    placeCorpse(sim, 2, 2, 0);
    const hit = resolveCanvasHit({
        sim,
        player,
        tile: { x: 2, y: 2, z: 0 },
        itemDb
    });
    const intents = processMouseAction(
        baseInput(hit, { button: 'left', mode: 2, playerTile: player.tile })
    );
    assert.strictEqual(intents[0].type, 'QUICKLOOT');
    assert.strictEqual(intents[0].stub, true);
});

test('Context menu corpse stubs disabled; no false success fields', () => {
    const player = makePlayer();
    const sim = makeSim();
    placeCorpse(sim, 2, 2, 0);
    const hit = resolveCanvasHit({
        sim,
        player,
        tile: { x: 2, y: 2, z: 0 },
        itemDb
    });
    const entries = buildCanvasContextMenuEntries(hit);
    const loot = entries.find((e) => e.id === 'loot_corpse');
    const ql = entries.find((e) => e.id === 'quickloot');
    assert.ok(loot && loot.disabled === true && loot.stub === true);
    assert.ok(ql && ql.disabled === true && ql.stub === true);
});

test('QUICKLOOT / OPEN_CORPSE remain adapter intents (not command queue)', () => {
    const player = makePlayer();
    const remaining = applyCommandIntents(
        player,
        [
            { type: 'QUICKLOOT', stub: true },
            { type: 'OPEN_CORPSE', stub: true },
            { type: 'TALK_NPC', stub: true }
        ],
        {}
    );
    assert.strictEqual(remaining.length, 3);
    assert.strictEqual(player.commandQueue.length, 0);
});

// --- Stage 6a: NPC talk proximity stubs ---

test('Classic RMB NPC in range with dialog → TALK_NPC (not stub)', () => {
    const npc = {
        id: 'npc_c1',
        isNpc: true,
        alive: true,
        dialog: SAMPLE_DIALOG,
        tile: { x: 6, y: 5, z: 0 }
    };
    const player = makePlayer({ tile: { x: 5, y: 5, z: 0 } });
    const hit = resolveCanvasHit({
        sim: makeSim({ creatures: [npc] }),
        player,
        tile: { x: 6, y: 5, z: 0 },
        itemDb
    });
    assert.strictEqual(hit.isNpc, true);
    const intents = processMouseAction(
        baseInput(hit, {
            button: 'right',
            mode: 1,
            playerTile: player.tile
        })
    );
    assert.strictEqual(intents[0].type, 'TALK_NPC');
    assert.strictEqual(intents[0].stub, false);
});

test('Classic RMB NPC out of range → TALK_NPC (adapter walks, never attack)', () => {
    const npc = {
        id: 'npc_c2',
        isNpc: true,
        alive: true,
        dialog: SAMPLE_DIALOG,
        tile: { x: 12, y: 12, z: 0 }
    };
    const player = makePlayer({ tile: { x: 5, y: 5, z: 0 } });
    const hit = resolveCanvasHit({
        sim: makeSim({ creatures: [npc] }),
        player,
        tile: { x: 12, y: 12, z: 0 },
        itemDb
    });
    const intents = processMouseAction(
        baseInput(hit, {
            button: 'right',
            mode: 1,
            playerTile: player.tile
        })
    );
    assert.strictEqual(intents[0].type, 'TALK_NPC');
    assert.notStrictEqual(intents[0].type, 'SET_TARGET');
});

test('Regular/Classic LMB on NPC → walk (never SET_TARGET)', () => {
    const npc = {
        id: 'npc3',
        isNpc: true,
        alive: true,
        tile: { x: 6, y: 5, z: 0 }
    };
    const player = makePlayer({ tile: { x: 5, y: 5, z: 0 } });
    const hit = resolveCanvasHit({
        sim: makeSim({ creatures: [npc] }),
        player,
        tile: { x: 6, y: 5, z: 0 },
        itemDb
    });
    for (const mode of [0, 1]) {
        const intents = processMouseAction(
            baseInput(hit, {
                button: 'left',
                mode,
                playerTile: player.tile
            })
        );
        assert.strictEqual(
            intents[0].type,
            'START_AUTOWALK',
            'mode ' + mode + ' must not attack NPC'
        );
    }
});

test('Alt+RMB on NPC → no SET_TARGET', () => {
    const npc = {
        id: 'npc4',
        isNpc: true,
        alive: true,
        tile: { x: 6, y: 5, z: 0 }
    };
    const player = makePlayer({ tile: { x: 5, y: 5, z: 0 } });
    const hit = resolveCanvasHit({
        sim: makeSim({ creatures: [npc] }),
        player,
        tile: { x: 6, y: 5, z: 0 },
        itemDb
    });
    const intents = processMouseAction(
        baseInput(hit, {
            button: 'right',
            mode: 1,
            modifiers: { alt: true },
            playerTile: player.tile
        })
    );
    assert.strictEqual(intents.length, 0);
});

test('Smart Ctrl on corpse → OPEN_CORPSE stub', () => {
    const player = makePlayer();
    const sim = makeSim();
    placeCorpse(sim, 2, 2, 0);
    const hit = resolveCanvasHit({
        sim,
        player,
        tile: { x: 2, y: 2, z: 0 },
        itemDb
    });
    const intents = processMouseAction(
        baseInput(hit, {
            button: 'left',
            mode: 2,
            modifiers: { ctrl: true },
            playerTile: player.tile
        })
    );
    assert.strictEqual(intents[0].type, 'OPEN_CORPSE');
    assert.strictEqual(intents[0].stub, true);
});

test('Classic RMB hostile NPC → SET_TARGET, never TALK_NPC', () => {
    const npc = {
        id: 'boss_npc',
        isNpc: true,
        attackableNpc: true,
        alive: true,
        dialog: SAMPLE_DIALOG,
        tile: { x: 6, y: 5, z: 0 }
    };
    const player = makePlayer({ tile: { x: 5, y: 5, z: 0 } });
    const hit = resolveCanvasHit({
        sim: makeSim({ creatures: [npc] }),
        player,
        tile: { x: 6, y: 5, z: 0 },
        itemDb
    });
    assert.strictEqual(hit.isNpc, false, 'Q6.2: hostile is not talkable');
    const intents = processMouseAction(
        baseInput(hit, {
            button: 'right',
            mode: 1,
            playerTile: player.tile
        })
    );
    assert.strictEqual(intents[0].type, 'SET_TARGET');
    assert.notStrictEqual(intents[0].type, 'TALK_NPC');
});

test('Regular RMB talkOnRightClick NPC → TALK_NPC; default → menu', () => {
    const npc = {
        id: 'npc_r1',
        kind: 'npc',
        alive: true,
        dialog: SAMPLE_DIALOG,
        tile: { x: 5, y: 6, z: 0 }
    };
    const player = makePlayer({ tile: { x: 5, y: 5, z: 0 } });
    const hit = resolveCanvasHit({
        sim: makeSim({ creatures: [npc] }),
        player,
        tile: { x: 5, y: 6, z: 0 },
        itemDb
    });
    const withTalk = processMouseAction(
        baseInput(hit, {
            button: 'right',
            mode: 0,
            talkOnRightClick: true,
            playerTile: player.tile
        })
    );
    assert.strictEqual(withTalk[0].type, 'TALK_NPC');
    assert.strictEqual(withTalk[0].stub, false);
    const noTalk = processMouseAction(
        baseInput(hit, {
            button: 'right',
            mode: 0,
            talkOnRightClick: false,
            playerTile: player.tile
        })
    );
    assert.strictEqual(noTalk[0].type, 'OPEN_CONTEXT_MENU');
});

test('Context menu Talk entry for NPC (clickable; stub only without dialog)', () => {
    const npc = {
        id: 'npc_m1',
        isNpc: true,
        alive: true,
        dialog: SAMPLE_DIALOG,
        tile: { x: 5, y: 6, z: 0 }
    };
    const player = makePlayer();
    const hit = resolveCanvasHit({
        sim: makeSim({ creatures: [npc] }),
        player,
        tile: { x: 5, y: 6, z: 0 },
        itemDb
    });
    const entries = buildCanvasContextMenuEntries(hit);
    const talk = entries.find((e) => e.id === 'talk');
    assert.ok(talk, 'Talk entry present');
    assert.strictEqual(talk.disabled, undefined);
    assert.strictEqual(talk.stub, false);
    assert.strictEqual(talk.creatureId, 'npc_m1');
    assert.ok(
        !entries.some((e) => e.id === 'attack'),
        'Attack hidden for talkable NPC'
    );

    const mute = {
        id: 'npc_m2',
        isNpc: true,
        alive: true,
        tile: { x: 5, y: 6, z: 0 }
    };
    const muteHit = resolveCanvasHit({
        sim: makeSim({ creatures: [mute] }),
        player,
        tile: { x: 5, y: 6, z: 0 },
        itemDb
    });
    const muteTalk = buildCanvasContextMenuEntries(muteHit).find(
        (e) => e.id === 'talk'
    );
    assert.ok(muteTalk);
    assert.strictEqual(muteTalk.stub, true);
});

// --- Stage 7: Classic Look chord + moveStack amount rules ---

test('isClassicLookChord: Classic only, other button still pressed', () => {
    assert.strictEqual(
        isClassicLookChord({
            mode: 1,
            button: 'right',
            leftPressed: true,
            rightPressed: true
        }),
        true,
        'RMB with LMB held'
    );
    assert.strictEqual(
        isClassicLookChord({
            mode: 1,
            button: 'left',
            leftPressed: true,
            rightPressed: true
        }),
        true,
        'LMB with RMB held'
    );
    assert.strictEqual(
        isClassicLookChord({
            mode: 1,
            button: 'right',
            leftPressed: false,
            rightPressed: true
        }),
        false,
        'RMB alone'
    );
    assert.strictEqual(
        isClassicLookChord({
            mode: 0,
            button: 'right',
            leftPressed: true,
            rightPressed: true
        }),
        false,
        'Regular ignores chord'
    );
    assert.strictEqual(
        isClassicLookChord({
            mode: 2,
            button: 'right',
            leftPressed: true,
            rightPressed: true
        }),
        false,
        'Smart ignores chord'
    );
});

test('resolveStackMoveAmount: Shift / Ctrl XOR moveStack / modal', () => {
    assert.deepStrictEqual(
        resolveStackMoveAmount({ count: 1, shift: false, ctrl: false, moveStack: false }),
        { kind: 'amount', amount: 1 }
    );
    assert.deepStrictEqual(
        resolveStackMoveAmount({ count: 50, shift: true, ctrl: false, moveStack: false }),
        { kind: 'amount', amount: 1 },
        'Shift → 1'
    );
    // Default moveStack=false: Ctrl → full; plain → modal
    assert.deepStrictEqual(
        resolveStackMoveAmount({ count: 50, shift: false, ctrl: true, moveStack: false }),
        { kind: 'amount', amount: 50 },
        'Ctrl XOR false → full'
    );
    assert.deepStrictEqual(
        resolveStackMoveAmount({ count: 50, shift: false, ctrl: false, moveStack: false }),
        { kind: 'modal', max: 50 },
        'plain + moveStack false → modal'
    );
    // moveStack=true: plain → full; Ctrl → modal
    assert.deepStrictEqual(
        resolveStackMoveAmount({ count: 50, shift: false, ctrl: false, moveStack: true }),
        { kind: 'amount', amount: 50 },
        'plain + moveStack true → full'
    );
    assert.deepStrictEqual(
        resolveStackMoveAmount({ count: 50, shift: false, ctrl: true, moveStack: true }),
        { kind: 'modal', max: 50 },
        'Ctrl + moveStack true → modal'
    );
});

// --- Stage 8: Browse Field ---

test('listBrowsableStackUids top-first and excludes fields', () => {
    const store = createGroundStore();
    placeGround(store, 2, 2, 0, 'gold_coin'); // bottom
    placeGround(store, 2, 2, 0, 'sword'); // middle
    placeGround(store, 2, 2, 0, 'fire_field', {
        isField: true,
        immovable: true
    }); // top field
    const uids = listBrowsableStackUids(store, 2, 2, 0, itemDb);
    assert.strictEqual(uids.length, 2, 'field excluded');
    // top-first among browsable: sword then gold
    const top = getItem(store.inventory, uids[0]);
    const bot = getItem(store.inventory, uids[1]);
    assert.strictEqual(top && top.itemId, 'sword');
    assert.strictEqual(bot && bot.itemId, 'gold_coin');
});

test('hitHasBrowsableItems false for field-only and empty', () => {
    const player = makePlayer();
    const sim = makeSim();
    placeGround(sim.groundItems, 1, 1, 0, 'fire_field', {
        isField: true,
        immovable: true
    });
    const fieldHit = resolveCanvasHit({
        sim,
        player,
        tile: { x: 1, y: 1, z: 0 },
        itemDb
    });
    assert.strictEqual(hitHasBrowsableItems(fieldHit), false);
    assert.ok(
        !buildCanvasContextMenuEntries(fieldHit).some((e) => e.id === 'browse_field')
    );

    const emptyHit = resolveCanvasHit({
        sim: makeSim(),
        player,
        tile: { x: 0, y: 0, z: 0 },
        itemDb
    });
    assert.strictEqual(hitHasBrowsableItems(emptyHit), false);
    assert.ok(
        !buildCanvasContextMenuEntries(emptyHit).some((e) => e.id === 'browse_field')
    );
});

test('isInBrowseOpenRange Chebyshev ≤ 1 same floor', () => {
    assert.strictEqual(
        isInBrowseOpenRange({ x: 5, y: 5, z: 0 }, { x: 5, y: 5, z: 0 }),
        true
    );
    assert.strictEqual(
        isInBrowseOpenRange({ x: 5, y: 5, z: 0 }, { x: 6, y: 6, z: 0 }),
        true
    );
    assert.strictEqual(
        isInBrowseOpenRange({ x: 5, y: 5, z: 0 }, { x: 7, y: 5, z: 0 }),
        false
    );
    assert.strictEqual(
        isInBrowseOpenRange({ x: 5, y: 5, z: 0 }, { x: 5, y: 5, z: 1 }),
        false
    );
});

test('buildBrowseFieldIntent payload', () => {
    const intent = buildBrowseFieldIntent({ x: 3, y: 4, z: 2 });
    assert.strictEqual(intent.type, 'BROWSE_FIELD');
    assert.strictEqual(intent.x, 3);
    assert.strictEqual(intent.y, 4);
    assert.strictEqual(intent.z, 2);
});

test('resolveBrowseFieldApproach in_range / wrong_floor / walk / no_path', () => {
    const near = resolveBrowseFieldApproach(
        { x: 5, y: 5, z: 0 },
        null,
        { x: 6, y: 5, z: 0 }
    );
    assert.strictEqual(near.status, 'in_range');

    const wrong = resolveBrowseFieldApproach(
        { x: 5, y: 5, z: 0 },
        null,
        { x: 6, y: 5, z: 1 }
    );
    assert.strictEqual(wrong.status, 'wrong_floor');

    // Without tileMap every adjacent tile is enterable → walk to nearest approach
    const far = resolveBrowseFieldApproach(
        { x: 0, y: 0, z: 0 },
        null,
        { x: 10, y: 10, z: 0 }
    );
    assert.strictEqual(far.status, 'walk');
    assert.ok(far.dest);
    assert.ok(
        Math.max(Math.abs(far.dest.x - 10), Math.abs(far.dest.y - 10)) <= 1
    );

    // Unwalkable tileMap → no_path
    const blockedMap = {
        isTileWalkable: () => false
    };
    const blocked = resolveBrowseFieldApproach(
        { x: 0, y: 0, z: 0 },
        blockedMap,
        { x: 10, y: 10, z: 0 }
    );
    assert.strictEqual(blocked.status, 'no_path');
});

test('npcHasDialogData and TALK_NPC_RANGE', () => {
    assert.strictEqual(TALK_NPC_RANGE, 3);
    assert.strictEqual(npcHasDialogData(null), false);
    assert.strictEqual(npcHasDialogData({ isNpc: true }), false);
    assert.strictEqual(npcHasDialogData({ dialogId: 'town_guide' }), true);
    assert.strictEqual(npcHasDialogData({ dialog: SAMPLE_DIALOG }), true);
    assert.strictEqual(npcHasDialogData({ dialog: { nodes: {} } }), false);
});

function openFloorMap(cols, rows) {
    const rgba = new Uint8Array(cols * rows * 4);
    for (let i = 0; i < cols * rows; i++) {
        rgba[i * 4] = 100;
        rgba[i * 4 + 1] = 100;
        rgba[i * 4 + 2] = 100;
        rgba[i * 4 + 3] = 255;
    }
    const map = new TileMap();
    map.loadFloorFromRgba(0, cols, rows, rgba);
    return map;
}

test('resolveApproach talk maxDist 3 vs browse 1', () => {
    const at3 = resolveApproach(
        { x: 5, y: 5, z: 0 },
        null,
        { x: 8, y: 5, z: 0 },
        3
    );
    assert.strictEqual(at3.status, 'in_range');

    const at4 = resolveApproach(
        { x: 5, y: 5, z: 0 },
        null,
        { x: 9, y: 5, z: 0 },
        3
    );
    assert.strictEqual(at4.status, 'walk');
    assert.deepStrictEqual(
        at4.dest,
        { x: 6, y: 5, z: 0 },
        'no-map dest is the on-axis tile that first enters range'
    );

    const browseFar = resolveApproach(
        { x: 5, y: 5, z: 0 },
        null,
        { x: 8, y: 5, z: 0 },
        1
    );
    assert.strictEqual(browseFar.status, 'walk');
    assert.deepStrictEqual(browseFar.dest, { x: 7, y: 5, z: 0 });
});

test('resolveApproach prefers corridor over equal-length NW alcove', () => {
    const map = openFloorMap(10, 7);
    const got = resolveApproach(
        { x: 0, y: 3, z: 0 },
        map,
        { x: 6, y: 3, z: 0 },
        3
    );
    assert.strictEqual(got.status, 'walk');
    assert.deepStrictEqual(
        got.dest,
        { x: 3, y: 3, z: 0 },
        'npc_talk_lab-shaped open floor must not pick alcove (3,0)'
    );
});

test('browseFieldTileKey stable and BROWSE_FIELD_CAPACITY is 30', () => {
    assert.strictEqual(browseFieldTileKey(1, 2, 0), '0:1:2');
    assert.strictEqual(BROWSE_FIELD_CAPACITY, 30);
    assert.strictEqual(
        isBrowsableGroundInst({ itemId: 'sword' }, itemDb[1]),
        true
    );
    assert.strictEqual(
        isBrowsableGroundInst({ isField: true }, { isField: true }),
        false
    );
});

test('applyCommandIntents leaves BROWSE_FIELD for adapter', () => {
    const player = makePlayer();
    const remaining = applyCommandIntents(
        player,
        [buildBrowseFieldIntent({ x: 1, y: 2, z: 0 })],
        {}
    );
    assert.strictEqual(remaining.length, 1);
    assert.strictEqual(remaining[0].type, 'BROWSE_FIELD');
});

console.log(`\nmouse_dispatcher: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
