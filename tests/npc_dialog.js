#!/usr/bin/env node
/**
 * Stage 6b + C.1 + C.2 + C.3 — dialog, session, storage / when, give/take, shop.
 */

'use strict';

const assert = require('assert');
const presets = require('../kernel/core/lib/presets.js');
const { Creature } = require('../kernel/core/entities/creature.js');
const { Player } = require('../kernel/core/entities/player.js');
const { loadScenario, scenarioToInput } = require('../kernel/core/lib/hunt_scenarios.js');
const { resolveSessionParties } = require('../kernel/core/lib/character/party_resolve.js');
const { isTalkableNpc, isAttackableCreature } = require('../kernel/core/lib/npc/flags.js');
const {
    isDialogTree,
    resolveDialog,
    resolveNode,
    listReplies,
    applyReply,
    loadDialogById
} = require('../kernel/core/lib/npc/dialog.js');
const {
    getStorage,
    setStorage,
    evalWhen,
    replyMatchesWhen,
    mergeStorageBags
} = require('../kernel/core/lib/npc/storage.js');
const {
    countPlayerItem,
    giveItemToPlayer,
    takeItemFromPlayer,
    transferFailText
} = require('../kernel/core/lib/npc/items.js');
const {
    resolveShop,
    listShopRows,
    buyFromShop,
    sellToShop,
    shopFailText
} = require('../kernel/core/lib/npc/shop.js');
const {
    countItemIdInInventoryTree,
    createItemInstance,
    placeInContainer
} = require('../kernel/core/lib/character/inventory.js');
const {
    TALK_RANGE,
    chebyshevSameFloor,
    canTalkToNpc,
    getTalkSession,
    openTalk,
    gotoTalk,
    closeTalk,
    openShop,
    closeShop,
    takeReply,
    parseNpcDialogCommand,
    executeNpcDialog
} = require('../kernel/core/lib/npc/session.js');

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

function startTree() {
    return {
        greeting: 'Welcome, hunter. Need directions?',
        start: 'start',
        nodes: {
            start: {
                text: 'Welcome, hunter. Need directions?',
                replies: [
                    { label: 'Arena', goto: 'arena' },
                    { label: 'Bye', action: 'close' }
                ]
            },
            arena: {
                text: 'The arena portal is north of the fountain.',
                replies: [{ label: 'Thanks', action: 'close' }]
            }
        }
    };
}

test('resolve start node from inline dialog', () => {
    const resolved = resolveDialog({ dialog: startTree() });
    assert.strictEqual(resolved.ok, true);
    assert.strictEqual(resolved.source, 'inline');
    const node = resolveNode(resolved.dialog);
    assert.strictEqual(node.ok, true);
    assert.strictEqual(node.nodeId, 'start');
    assert.strictEqual(node.node.text, 'Welcome, hunter. Need directions?');
    const replies = listReplies(node.node);
    assert.strictEqual(replies.length, 2);
    assert.strictEqual(replies[0].action, 'goto');
    assert.strictEqual(replies[0].goto, 'arena');
    assert.strictEqual(replies[1].action, 'close');
});

test('missing dialog', () => {
    assert.deepStrictEqual(resolveDialog(null), { ok: false, reason: 'missing' });
    assert.deepStrictEqual(resolveDialog({}), { ok: false, reason: 'missing' });
    assert.deepStrictEqual(resolveDialog({ isNpc: true }), {
        ok: false,
        reason: 'missing'
    });
    assert.deepStrictEqual(resolveDialog({ dialogId: 'no_such_dialog' }), {
        ok: false,
        reason: 'missing'
    });
    assert.deepStrictEqual(resolveNode(null), { ok: false, reason: 'missing' });
});

test('invalid dialog (no usable nodes)', () => {
    assert.deepStrictEqual(resolveDialog({ dialog: { greeting: 'x' } }), {
        ok: false,
        reason: 'invalid'
    });
    assert.deepStrictEqual(resolveDialog({ dialog: { nodes: {} } }), {
        ok: false,
        reason: 'invalid'
    });
    assert.ok(!isDialogTree({ nodes: {} }));
});

test('unknown goto', () => {
    const resolved = resolveDialog(startTree());
    assert.ok(resolved.ok);
    const bad = applyReply(resolved.dialog, {
        label: 'Nope',
        goto: 'does_not_exist'
    });
    assert.deepStrictEqual(bad, { ok: false, reason: 'unknown_goto' });
    const missingTarget = applyReply(resolved.dialog, {
        label: 'Empty',
        action: 'goto'
    });
    assert.deepStrictEqual(missingTarget, { ok: false, reason: 'unknown_goto' });
    const unknownNode = resolveNode(resolved.dialog, 'ghost');
    assert.deepStrictEqual(unknownNode, { ok: false, reason: 'unknown_node' });
});

test('applyReply goto / close / stub', () => {
    const resolved = resolveDialog(startTree());
    const arena = applyReply(resolved.dialog, { label: 'Arena', goto: 'arena' });
    assert.strictEqual(arena.ok, true);
    assert.strictEqual(arena.kind, 'goto');
    assert.strictEqual(arena.nodeId, 'arena');
    assert.ok(String(arena.node.text).indexOf('arena portal') >= 0);

    const bye = applyReply(resolved.dialog, { label: 'Bye', action: 'close' });
    assert.deepStrictEqual(bye, { ok: true, kind: 'close' });

    const trade = applyReply(resolved.dialog, {
        label: 'Trade',
        action: 'open_shop'
    });
    assert.deepStrictEqual(trade, { ok: true, kind: 'open_shop', next: 'stay' });

    const custom = applyReply(resolved.dialog, {
        label: 'Do',
        action: 'custom',
        command: 'noop'
    });
    assert.deepStrictEqual(custom, {
        ok: true,
        kind: 'custom',
        command: 'noop'
    });
});

test('extracted dialogId loads from presets/dialogs', () => {
    const raw = loadDialogById('town_guide');
    assert.ok(raw && raw.nodes && raw.nodes.start);
    const resolved = resolveDialog({ dialogId: 'town_guide' });
    assert.strictEqual(resolved.ok, true);
    assert.strictEqual(resolved.source, 'dialogId');
    assert.strictEqual(resolved.dialog.start, 'start');
    const byString = resolveDialog('town_guide');
    assert.strictEqual(byString.ok, true);
    assert.strictEqual(byString.source, 'dialogId');
});

test('sample JSON loads through presets.loadCreatureTemplate', () => {
    const tpl = presets.loadCreatureTemplate('town_guide');
    assert.strictEqual(tpl.id, 'town_guide');
    assert.strictEqual(tpl.isNpc, true);
    assert.strictEqual(tpl.kind, 'npc');
    assert.strictEqual(tpl.aggro, false);
    assert.ok(Array.isArray(tpl.attacks) && tpl.attacks.length === 0);
    assert.strictEqual(tpl.dialogId, 'town_guide');
    assert.ok(!tpl.dialog, 'sample creature stores dialogId only');

    const resolved = resolveDialog(tpl);
    assert.strictEqual(resolved.ok, true);
    assert.strictEqual(resolved.source, 'dialogId');
    const start = resolveNode(resolved.dialog, 'start');
    assert.ok(start.ok);
    assert.strictEqual(
        listReplies(start.node).length,
        3,
        'without a player, when-gated replies stay hidden'
    );
    const seeded = { storage: { 'town_guide.mission': 0 } };
    const visible = listReplies(start.node, seeded).map((r) => r.label);
    assert.deepStrictEqual(visible, ['Arena', 'Mission', 'Trade', 'Bye']);
    const done = listReplies(start.node, {
        storage: { 'town_guide.mission': 1 }
    }).map((r) => r.label);
    assert.deepStrictEqual(done, ['Arena', 'How goes the hunt?', 'Trade', 'Bye']);
    assert.ok(tpl.shop && Array.isArray(tpl.shop.items));
    assert.strictEqual(resolveShop(tpl).currency, 'gold_coin');

    const c = new Creature({ id: 21, name: 'Creature' });
    c.applyTemplate(tpl);
    assert.strictEqual(c.isNpc, true);
    assert.strictEqual(c.name, 'Guide');
    assert.strictEqual(c.dialogId, 'town_guide');
    assert.ok(!c.dialog, 'spawned NPC has no inline tree');
    assert.ok(c.shop && c.shop.items && c.shop.items.length >= 2, 'shop copied');
    assert.ok(isTalkableNpc(c));
    assert.ok(!isAttackableCreature(c));

    const fromSpawned = resolveDialog(c);
    assert.strictEqual(fromSpawned.ok, true);
    assert.strictEqual(fromSpawned.dialog.greeting, 'Welcome, hunter. Need directions?');
});

test('npc_talk_lab scenario places town_guide (not a golden hunt)', () => {
    const scenario = loadScenario('npc_talk_lab');
    assert.strictEqual(scenario.id, 'npc_talk_lab');
    assert.strictEqual(scenario.baseHuntId, 'outskirts_camp_fixed');
    assert.ok(Array.isArray(scenario.spawns));
    assert.ok(scenario.spawns.some((s) => s && s.creatureId === 'town_guide'));
    assert.ok(scenario.spawns.every((s) => s.creatureId !== 'cave_rat'));
    assert.strictEqual(scenario.members[0].controlMode, 'manual');
});

test('scenario storage seed is copied onto the party bag', () => {
    const input = scenarioToInput({
        id: 'seed_lab',
        baseHuntId: 'outskirts_camp_fixed',
        storage: { 'town_guide.mission': 1 },
        members: [
            {
                profileId: 'guardian_starter',
                name: 'Talk Tester',
                isLeader: true,
                storage: { extra: 4 }
            }
        ]
    });
    assert.strictEqual(input.storage['town_guide.mission'], 1);
    const parties = resolveSessionParties(input, { skipSkillSourceAssert: true });
    assert.strictEqual(parties[0].storage['town_guide.mission'], 1);
    const p = new Player({
        name: 'Talk Tester',
        storage: mergeStorageBags(parties[0].storage, input.members[0].storage)
    });
    assert.strictEqual(getStorage(p, 'town_guide.mission'), 1);
    assert.strictEqual(getStorage(p, 'extra'), 4);
});

function makeTalkPair(opts) {
    const o = opts || {};
    const player = {
        id: o.playerId != null ? o.playerId : 1,
        alive: o.playerAlive !== undefined ? o.playerAlive : true,
        tile: o.playerTile || { x: 2, y: 2, z: 0 },
        _npcTalk: null
    };
    const npc = new Creature({
        id: o.npcId != null ? o.npcId : 21,
        name: 'Guide',
        tile: o.npcTile || { x: 4, y: 2, z: 0 },
        hp: 80,
        hpMax: 80
    });
    const tpl = presets.loadCreatureTemplate('town_guide');
    npc.applyTemplate(tpl);
    if (o.hostile) npc.attackableNpc = true;
    if (o.dead) {
        npc.alive = false;
        npc.hp.current = 0;
    }
    if (o.noDialog) {
        delete npc.dialog;
        delete npc.dialogId;
    }
    return { player, npc };
}

test('session open / goto / close in range', () => {
    assert.strictEqual(TALK_RANGE, 3);
    assert.strictEqual(
        chebyshevSameFloor({ x: 2, y: 2, z: 0 }, { x: 4, y: 2, z: 0 }),
        2
    );
    const { player, npc } = makeTalkPair();
    const opened = openTalk(player, npc);
    assert.strictEqual(opened.ok, true);
    assert.strictEqual(opened.nodeId, 'start');
    assert.ok(opened.node && String(opened.node.text).indexOf('Welcome') >= 0);
    assert.deepStrictEqual(getTalkSession(player), {
        npcId: npc.id,
        dialogId: 'town_guide',
        nodeId: 'start'
    });

    const jumped = gotoTalk(player, npc, 'arena');
    assert.strictEqual(jumped.ok, true);
    assert.strictEqual(player._npcTalk.nodeId, 'arena');
    assert.ok(String(jumped.node.text).indexOf('arena portal') >= 0);

    const closed = closeTalk(player);
    assert.strictEqual(closed.ok, true);
    assert.strictEqual(player._npcTalk, null);
    assert.strictEqual(closed.closed.nodeId, 'arena');
});

test('session no-op: out of range / wrong floor / hostile / dead / missing dialog', () => {
    const oor = makeTalkPair({ npcTile: { x: 8, y: 2, z: 0 } });
    assert.deepStrictEqual(canTalkToNpc(oor.player, oor.npc), {
        ok: false,
        reason: 'out_of_range'
    });
    assert.strictEqual(openTalk(oor.player, oor.npc).ok, false);
    assert.strictEqual(oor.player._npcTalk, null);

    const floor = makeTalkPair({ npcTile: { x: 4, y: 2, z: 1 } });
    assert.deepStrictEqual(canTalkToNpc(floor.player, floor.npc), {
        ok: false,
        reason: 'wrong_floor'
    });

    const hostile = makeTalkPair({ hostile: true });
    assert.strictEqual(canTalkToNpc(hostile.player, hostile.npc).reason, 'hostile');
    assert.ok(!isTalkableNpc(hostile.npc));
    assert.strictEqual(openTalk(hostile.player, hostile.npc).ok, false);

    const dead = makeTalkPair({ dead: true });
    assert.strictEqual(canTalkToNpc(dead.player, dead.npc).reason, 'dead');
    assert.strictEqual(openTalk(dead.player, dead.npc).ok, false);

    const mute = makeTalkPair({ noDialog: true });
    assert.strictEqual(canTalkToNpc(mute.player, mute.npc).ok, true);
    assert.deepStrictEqual(openTalk(mute.player, mute.npc), {
        ok: false,
        reason: 'missing'
    });
    assert.strictEqual(mute.player._npcTalk, null);
});

test('unknown goto leaves session unchanged', () => {
    const { player, npc } = makeTalkPair();
    assert.ok(openTalk(player, npc).ok);
    const bad = gotoTalk(player, npc, 'does_not_exist');
    assert.deepStrictEqual(bad, { ok: false, reason: 'unknown_node' });
    assert.strictEqual(player._npcTalk.nodeId, 'start');
});

test('parseNpcDialogCommand object + string forms', () => {
    assert.deepStrictEqual(
        parseNpcDialogCommand({
            command: 'npc_dialog',
            args: { npcId: 21, nodeId: 'start' }
        }),
        { action: 'talk', npcId: 21, nodeId: 'start' }
    );
    assert.deepStrictEqual(
        parseNpcDialogCommand({ command: 'npc_dialog 21 arena' }),
        { action: 'talk', npcId: 21, nodeId: 'arena' }
    );
    assert.deepStrictEqual(
        parseNpcDialogCommand({ command: 'npc_dialog', args: { action: 'close' } }),
        { action: 'close', npcId: null }
    );
    assert.deepStrictEqual(parseNpcDialogCommand({ command: 'npc_dialog close' }), {
        action: 'close',
        npcId: null
    });
    assert.deepStrictEqual(
        parseNpcDialogCommand({
            command: 'npc_dialog',
            args: { npcId: 21, action: 'buy', itemId: 'bread', count: 2 }
        }),
        { action: 'buy', npcId: 21, itemId: 'bread', count: 2 }
    );
    assert.deepStrictEqual(parseNpcDialogCommand({ command: 'npc_dialog 21 shop' }), {
        action: 'open_shop',
        npcId: 21
    });
    assert.deepStrictEqual(
        parseNpcDialogCommand({ command: 'npc_dialog 21 sell bread 3' }),
        { action: 'sell', npcId: 21, itemId: 'bread', count: 3 }
    );
    assert.strictEqual(parseNpcDialogCommand({ command: 'heal_friend' }), null);
    assert.strictEqual(parseNpcDialogCommand({ command: 'xyzzy_not_a_macro' }), null);
});

test('executeNpcDialog is headless (no UI) and re-checks range', () => {
    const { player, npc } = makeTalkPair();
    const ctx = {
        entityById: new Map([[npc.id, npc]]),
        sim: { entityById: new Map([[npc.id, npc]]), creatures: [npc] }
    };
    const opened = executeNpcDialog(
        player,
        { command: 'npc_dialog', args: { npcId: npc.id } },
        ctx
    );
    assert.strictEqual(opened.ok, true);
    assert.strictEqual(player._npcTalk.nodeId, 'start');

    const jumped = executeNpcDialog(
        player,
        { command: `npc_dialog ${npc.id} arena` },
        ctx
    );
    assert.strictEqual(jumped.ok, true);
    assert.strictEqual(player._npcTalk.nodeId, 'arena');

    npc.tile = { x: 12, y: 2, z: 0 };
    const oor = executeNpcDialog(
        player,
        { command: 'npc_dialog', args: { npcId: npc.id, nodeId: 'start' } },
        ctx
    );
    assert.strictEqual(oor.ok, false);
    assert.strictEqual(oor.reason, 'out_of_range');
    assert.strictEqual(player._npcTalk.nodeId, 'arena', 'failed goto is a no-op');

    const closed = executeNpcDialog(
        player,
        { command: 'npc_dialog', args: { action: 'close' } },
        ctx
    );
    assert.strictEqual(closed.ok, true);
    assert.strictEqual(player._npcTalk, null);
});

test('storage unset reads as 0; set / eq / min / AND when', () => {
    const p = new Player({ name: 'Talker' });
    assert.strictEqual(getStorage(p, 'town_guide.mission'), 0);
    assert.strictEqual(
        evalWhen(p, { storage: 'town_guide.mission', eq: 0 }),
        true
    );
    assert.strictEqual(
        evalWhen(p, { storage: 'town_guide.mission', min: 1 }),
        false
    );
    setStorage(p, 'town_guide.mission', 1);
    assert.strictEqual(getStorage(p, 'town_guide.mission'), 1);
    assert.strictEqual(
        evalWhen(p, { key: 'town_guide.mission', min: 1 }),
        true
    );
    assert.strictEqual(
        evalWhen(p, [
            { storage: 'town_guide.mission', min: 1 },
            { storage: 'town_guide.mission', max: 1 }
        ]),
        true
    );
    assert.strictEqual(
        evalWhen(p, { storage: 'town_guide.mission', neq: 1 }),
        false
    );
    assert.ok(
        replyMatchesWhen(p, {
            label: 'X',
            when: { storage: 'town_guide.mission', min: 1 }
        })
    );
    assert.ok(
        !replyMatchesWhen(null, {
            label: 'X',
            when: { storage: 'town_guide.mission', eq: 0 }
        }),
        'gated reply without a player is hidden'
    );
});

test('listReplies filters when; applyReply re-checks', () => {
    const tree = {
        start: 'start',
        nodes: {
            start: {
                text: 'Hi',
                replies: [
                    { label: 'Open', goto: 'next', when: { storage: 'q', eq: 0 } },
                    { label: 'Done', goto: 'next', when: { storage: 'q', min: 1 } }
                ]
            },
            next: { text: 'Ok', replies: [] }
        }
    };
    const dialog = resolveDialog(tree).dialog;
    const start = resolveNode(dialog, 'start').node;
    const player = { storage: {} };
    assert.deepStrictEqual(
        listReplies(start, player).map((r) => r.label),
        ['Open']
    );
    const denied = applyReply(
        dialog,
        { label: 'Done', goto: 'next', when: { storage: 'q', min: 1 } },
        player
    );
    assert.deepStrictEqual(denied, { ok: false, reason: 'when' });
    setStorage(player, 'q', 2);
    assert.deepStrictEqual(
        listReplies(start, player).map((r) => r.label),
        ['Done']
    );
    const ok = applyReply(
        dialog,
        { label: 'Done', goto: 'next', when: { storage: 'q', min: 1 } },
        player
    );
    assert.strictEqual(ok.ok, true);
    assert.strictEqual(ok.kind, 'goto');
});

test('setTalk applies node set; takeReply rejects hidden replies', () => {
    const { player, npc } = makeTalkPair();
    assert.strictEqual(getStorage(player, 'town_guide.mission'), 0);
    const opened = openTalk(player, npc);
    assert.strictEqual(opened.ok, true);
    const startNode = opened.node;
    const hidden = takeReply(player, npc, {
        label: 'How goes the hunt?',
        action: 'goto',
        goto: 'mission_done',
        when: { storage: 'town_guide.mission', min: 1 }
    });
    assert.deepStrictEqual(hidden, { ok: false, reason: 'when' });
    assert.strictEqual(player._npcTalk.nodeId, 'start');

    const took = takeReply(player, npc, {
        label: 'Mission',
        action: 'goto',
        goto: 'mission'
    });
    assert.strictEqual(took.ok, true);
    assert.strictEqual(took.nodeId, 'mission');
    assert.strictEqual(
        getStorage(player, 'town_guide.mission'),
        1,
        'landing on mission writes node set'
    );

    closeTalk(player);
    assert.ok(openTalk(player, npc).ok);
    const labels = listReplies(startNode, player).map((r) => r.label);
    assert.ok(labels.indexOf('Mission') < 0);
    assert.ok(labels.indexOf('How goes the hunt?') >= 0);
});

test('executeNpcDialog TAS jump applies destination node set', () => {
    const { player, npc } = makeTalkPair();
    const ctx = {
        entityById: new Map([[npc.id, npc]]),
        sim: { entityById: new Map([[npc.id, npc]]), creatures: [npc] }
    };
    const jumped = executeNpcDialog(
        player,
        { command: 'npc_dialog', args: { npcId: npc.id, nodeId: 'mission' } },
        ctx
    );
    assert.strictEqual(jumped.ok, true);
    assert.strictEqual(player._npcTalk.nodeId, 'mission');
    assert.strictEqual(getStorage(player, 'town_guide.mission'), 1);
});

const ITEM_DB = [
    {
        id: 'backpack',
        label: 'Backpack',
        category: 'container',
        slot: 'backpack',
        volume: 20,
        weight: 100
    },
    {
        id: 'gold_coin',
        label: 'Gold Coin',
        category: 'currency',
        stackable: true,
        weight: 10
    },
    {
        id: 'iron_longsword',
        label: 'Iron Longsword',
        slot: 'rightHand',
        weight: 5400
    },
    {
        id: 'anvil',
        label: 'Anvil',
        weight: 500000
    },
    {
        id: 'pebble',
        label: 'Pebble',
        weight: 1
    },
    {
        id: 'bread',
        label: 'Bread',
        category: 'food',
        stackable: true,
        weight: 10
    },
    {
        id: 'cookie',
        label: 'Cookie',
        category: 'food',
        stackable: true,
        weight: 10
    },
    {
        id: 'torch',
        label: 'Torch',
        weight: 50
    }
];

function tradeTree() {
    return {
        start: 'start',
        nodes: {
            start: {
                text: 'Need a coin?',
                replies: [
                    {
                        label: 'Yes',
                        action: 'give_item',
                        item: 'gold_coin',
                        count: 3,
                        goto: 'given',
                        set: { 'guide.gift': 1 }
                    },
                    {
                        label: 'Pay',
                        action: 'take_item',
                        item: 'gold_coin',
                        count: 1,
                        goto: 'paid',
                        when: { item: 'gold_coin', min: 1 }
                    },
                    { label: 'Bye', action: 'close' }
                ]
            },
            given: {
                text: 'Here.',
                replies: [{ label: 'Ok', action: 'close' }]
            },
            paid: {
                text: 'Thanks.',
                replies: [{ label: 'Ok', action: 'close' }]
            }
        }
    };
}

function makeInvTalkPair(opts) {
    const o = opts || {};
    const player = new Player({
        id: o.playerId != null ? o.playerId : 1,
        name: 'Talker',
        tile: o.playerTile || { x: 2, y: 2, z: 0 },
        itemDb: ITEM_DB,
        storage: o.storage
    });
    player.alive = o.playerAlive !== undefined ? o.playerAlive : true;
    player._loadoutItemDb = ITEM_DB;
    player.initInventory(
        {
            equipment: { backpack: 'backpack' },
            backpack: o.backpack || []
        },
        ITEM_DB
    );
    player._npcTalk = null;
    const npc = new Creature({
        id: o.npcId != null ? o.npcId : 21,
        name: 'Guide',
        tile: o.npcTile || { x: 4, y: 2, z: 0 },
        hp: 80,
        hpMax: 80
    });
    npc.isNpc = true;
    npc.kind = 'npc';
    npc.dialog = o.dialog || tradeTree();
    if (o.shop) npc.shop = o.shop;
    return { player, npc };
}

function sampleShop() {
    return {
        currency: 'gold_coin',
        items: [
            { item: 'bread', buy: 4, sell: 1 },
            { item: 'cookie', buy: 2, sell: 1 },
            {
                item: 'torch',
                buy: 8,
                when: { storage: 'town_guide.mission', min: 1 }
            }
        ]
    };
}

test('applyReply give_item is not a stub; open_shop is not a stub', () => {
    const dialog = resolveDialog(tradeTree()).dialog;
    const gift = applyReply(dialog, {
        label: 'Yes',
        action: 'give_item',
        item: 'gold_coin',
        count: 3,
        goto: 'given'
    });
    assert.strictEqual(gift.ok, true);
    assert.strictEqual(gift.kind, 'give_item');
    assert.strictEqual(gift.itemId, 'gold_coin');
    assert.strictEqual(gift.count, 3);
    assert.strictEqual(gift.next, 'goto');
    assert.strictEqual(gift.nodeId, 'given');
    const shop = applyReply(dialog, { label: 'Shop', action: 'open_shop' });
    assert.deepStrictEqual(shop, { ok: true, kind: 'open_shop', next: 'stay' });
    const shopGoto = applyReply(dialog, {
        label: 'Wares',
        action: 'open_shop',
        goto: 'given'
    });
    assert.strictEqual(shopGoto.ok, true);
    assert.strictEqual(shopGoto.kind, 'open_shop');
    assert.strictEqual(shopGoto.next, 'goto');
    assert.strictEqual(shopGoto.nodeId, 'given');
    const bad = applyReply(dialog, { label: 'Yes', action: 'give_item' });
    assert.deepStrictEqual(bad, { ok: false, reason: 'invalid_item' });
});

test('when.item hides take until the backpack has the stack', () => {
    const { player, npc } = makeInvTalkPair();
    assert.ok(openTalk(player, npc).ok);
    const start = resolveNode(npc.dialog, 'start').node;
    assert.deepStrictEqual(
        listReplies(start, player).map((r) => r.label),
        ['Yes', 'Bye']
    );
    assert.strictEqual(
        evalWhen(player, { item: 'gold_coin', min: 1 }),
        false
    );
    assert.ok(giveItemToPlayer(player, { itemId: 'gold_coin', count: 1 }, ITEM_DB).ok);
    assert.strictEqual(countPlayerItem(player, 'gold_coin'), 1);
    assert.strictEqual(evalWhen(player, { item: 'gold_coin', min: 1 }), true);
    assert.deepStrictEqual(
        listReplies(start, player).map((r) => r.label),
        ['Yes', 'Pay', 'Bye']
    );
});

test('takeReply give_item adds to backpack then goto; set after success', () => {
    const { player, npc } = makeInvTalkPair();
    assert.ok(openTalk(player, npc).ok);
    assert.strictEqual(countPlayerItem(player, 'gold_coin'), 0);
    const took = takeReply(player, npc, {
        label: 'Yes',
        action: 'give_item',
        goto: 'given'
    });
    assert.strictEqual(took.ok, true);
    assert.strictEqual(took.kind, 'give_item');
    assert.strictEqual(took.next, 'goto');
    assert.strictEqual(took.nodeId, 'given');
    assert.strictEqual(took.transferred, true);
    assert.strictEqual(countPlayerItem(player, 'gold_coin'), 3);
    assert.strictEqual(getStorage(player, 'guide.gift'), 1);
});

test('takeReply take_item consumes; missing stack is a no-op', () => {
    const { player, npc } = makeInvTalkPair();
    assert.ok(openTalk(player, npc).ok);
    const hidden = takeReply(player, npc, {
        label: 'Pay',
        action: 'take_item',
        goto: 'paid'
    });
    assert.deepStrictEqual(hidden, { ok: false, reason: 'when' });
    assert.strictEqual(player._npcTalk.nodeId, 'start');

    assert.ok(giveItemToPlayer(player, { itemId: 'gold_coin', count: 2 }, ITEM_DB).ok);
    const paid = takeReply(player, npc, {
        label: 'Pay',
        action: 'take_item',
        goto: 'paid'
    });
    assert.strictEqual(paid.ok, true);
    assert.strictEqual(paid.nodeId, 'paid');
    assert.strictEqual(countPlayerItem(player, 'gold_coin'), 1);

    closeTalk(player);
    assert.ok(openTalk(player, npc).ok);
    takeItemFromPlayer(player, { itemId: 'gold_coin', count: 1 });
    const again = takeReply(player, npc, {
        label: 'Pay',
        action: 'take_item',
        goto: 'paid'
    });
    assert.deepStrictEqual(again, { ok: false, reason: 'when' });
});

test('give fail (cap / room) does not write set or change node', () => {
    const { player, npc } = makeInvTalkPair();
    npc.dialog = {
        start: 'start',
        nodes: {
            start: {
                text: 'Heavy',
                replies: [
                    {
                        label: 'Anvil',
                        action: 'give_item',
                        item: 'anvil',
                        count: 1,
                        goto: 'done',
                        set: { 'guide.anvil': 1 }
                    }
                ]
            },
            done: { text: 'Done', replies: [] }
        }
    };
    assert.ok(openTalk(player, npc).ok);
    const cap = takeReply(player, npc, {
        label: 'Anvil',
        action: 'give_item',
        goto: 'done'
    });
    assert.strictEqual(cap.ok, false);
    assert.strictEqual(cap.reason, 'not_enough_cap');
    assert.strictEqual(player._npcTalk.nodeId, 'start');
    assert.strictEqual(getStorage(player, 'guide.anvil'), 0);
    assert.strictEqual(countPlayerItem(player, 'anvil'), 0);
    assert.strictEqual(transferFailText('not_enough_cap'), 'Not enough cap');
    assert.strictEqual(transferFailText('no_item'), 'You do not have that.');

    npc.dialog.nodes.start.replies[0].item = 'pebble';
    for (let i = 0; i < 20; i++) {
        const uid = createItemInstance(player.inventory, 'pebble', ITEM_DB);
        assert.ok(
            placeInContainer(player.inventory, uid, player.inventory.rootUid, null, ITEM_DB)
                .ok
        );
    }
    const room = takeReply(player, npc, {
        label: 'Anvil',
        action: 'give_item',
        goto: 'done'
    });
    assert.strictEqual(room.ok, false);
    assert.strictEqual(room.reason, 'not_enough_room');
    assert.strictEqual(player._npcTalk.nodeId, 'start');
    assert.strictEqual(countItemIdInInventoryTree(player.inventory, 'pebble'), 20);
});

test('resolveShop + listShopRows hide gated rows', () => {
    const shop = resolveShop({ shop: sampleShop() });
    assert.ok(shop);
    assert.strictEqual(shop.currency, 'gold_coin');
    const nobody = listShopRows(shop, null, { side: 'buy' }).map((r) => r.itemId);
    assert.deepStrictEqual(nobody, ['bread', 'cookie']);
    const locked = listShopRows(shop, { storage: {} }, { side: 'buy' }).map(
        (r) => r.itemId
    );
    assert.deepStrictEqual(locked, ['bread', 'cookie']);
    const unlocked = listShopRows(
        shop,
        { storage: { 'town_guide.mission': 1 } },
        { side: 'buy' }
    ).map((r) => r.itemId);
    assert.deepStrictEqual(unlocked, ['bread', 'cookie', 'torch']);
    assert.deepStrictEqual(
        listShopRows(shop, { storage: {} }, { side: 'sell' }).map((r) => r.itemId),
        ['bread', 'cookie']
    );
});

test('buyFromShop takes currency and gives the item; cannot afford is a no-op', () => {
    const { player } = makeInvTalkPair();
    const shop = resolveShop({ shop: sampleShop() });
    const broke = buyFromShop(player, shop, 'bread', 1, ITEM_DB);
    assert.strictEqual(broke.ok, false);
    assert.strictEqual(broke.reason, 'cannot_afford');
    assert.strictEqual(shopFailText('cannot_afford'), 'You cannot afford that.');
    assert.strictEqual(countPlayerItem(player, 'bread'), 0);

    assert.ok(giveItemToPlayer(player, { itemId: 'gold_coin', count: 10 }, ITEM_DB).ok);
    const bought = buyFromShop(player, shop, 'bread', 2, ITEM_DB);
    assert.strictEqual(bought.ok, true);
    assert.strictEqual(bought.paid, 8);
    assert.strictEqual(countPlayerItem(player, 'gold_coin'), 2);
    assert.strictEqual(countPlayerItem(player, 'bread'), 2);

    const gated = buyFromShop(player, shop, 'torch', 1, ITEM_DB);
    assert.strictEqual(gated.ok, false);
    assert.strictEqual(gated.reason, 'row_when');
    assert.strictEqual(countPlayerItem(player, 'torch'), 0);
    assert.strictEqual(countPlayerItem(player, 'gold_coin'), 2);
});

test('sellToShop takes the item and pays currency; missing stack is a no-op', () => {
    const { player } = makeInvTalkPair();
    const shop = resolveShop({ shop: sampleShop() });
    const none = sellToShop(player, shop, 'bread', 1, ITEM_DB);
    assert.strictEqual(none.ok, false);
    assert.strictEqual(none.reason, 'no_item');
    assert.ok(giveItemToPlayer(player, { itemId: 'bread', count: 2 }, ITEM_DB).ok);
    const sold = sellToShop(player, shop, 'bread', 2, ITEM_DB);
    assert.strictEqual(sold.ok, true);
    assert.strictEqual(sold.earned, 2);
    assert.strictEqual(countPlayerItem(player, 'bread'), 0);
    assert.strictEqual(countPlayerItem(player, 'gold_coin'), 2);
});

test('takeReply open_shop sets session.shop; shop.when deny skips set', () => {
    const { player, npc } = makeInvTalkPair({
        shop: {
            currency: 'gold_coin',
            when: { storage: 'town_guide.shop', min: 1 },
            denyText: 'Not yet.',
            items: [{ item: 'bread', buy: 4 }]
        },
        dialog: {
            start: 'start',
            nodes: {
                start: {
                    text: 'Hi',
                    replies: [
                        {
                            label: 'Trade',
                            action: 'open_shop',
                            set: { 'guide.shopped': 1 }
                        }
                    ]
                }
            }
        }
    });
    assert.ok(openTalk(player, npc).ok);
    const denied = takeReply(player, npc, { label: 'Trade', action: 'open_shop' });
    assert.strictEqual(denied.ok, false);
    assert.strictEqual(denied.reason, 'shop_when');
    assert.strictEqual(denied.text, 'Not yet.');
    assert.strictEqual(player._npcTalk.shop, undefined);
    assert.strictEqual(getStorage(player, 'guide.shopped'), 0);

    setStorage(player, 'town_guide.shop', 1);
    const opened = takeReply(player, npc, { label: 'Trade', action: 'open_shop' });
    assert.strictEqual(opened.ok, true);
    assert.strictEqual(opened.kind, 'open_shop');
    assert.strictEqual(player._npcTalk.shop, true);
    assert.strictEqual(getStorage(player, 'guide.shopped'), 1);
    const closed = closeShop(player);
    assert.strictEqual(closed.ok, true);
    assert.strictEqual(player._npcTalk.shop, undefined);
    assert.ok(player._npcTalk, 'talk stays open');
});

test('executeNpcDialog buy/sell re-checks when; TAS jump does not open shop', () => {
    const { player, npc } = makeInvTalkPair({ shop: sampleShop() });
    const ctx = {
        entityById: new Map([[npc.id, npc]]),
        itemDb: ITEM_DB,
        sim: { entityById: new Map([[npc.id, npc]]), creatures: [npc], itemDb: ITEM_DB }
    };
    assert.ok(giveItemToPlayer(player, { itemId: 'gold_coin', count: 20 }, ITEM_DB).ok);
    const bought = executeNpcDialog(
        player,
        { command: 'npc_dialog', args: { npcId: npc.id, action: 'buy', itemId: 'bread', count: 1 } },
        ctx
    );
    assert.strictEqual(bought.ok, true);
    assert.strictEqual(countPlayerItem(player, 'bread'), 1);
    assert.strictEqual(countPlayerItem(player, 'gold_coin'), 16);

    const gated = executeNpcDialog(
        player,
        { command: `npc_dialog ${npc.id} buy torch` },
        ctx
    );
    assert.strictEqual(gated.ok, false);
    assert.strictEqual(gated.reason, 'row_when');
    assert.strictEqual(countPlayerItem(player, 'torch'), 0);

    setStorage(player, 'town_guide.mission', 1);
    const torch = executeNpcDialog(
        player,
        { command: `npc_dialog ${npc.id} buy torch 1` },
        ctx
    );
    assert.strictEqual(torch.ok, true);
    assert.strictEqual(countPlayerItem(player, 'torch'), 1);

    const jumped = executeNpcDialog(
        player,
        { command: 'npc_dialog', args: { npcId: npc.id, nodeId: 'given' } },
        ctx
    );
    assert.strictEqual(jumped.ok, true);
    assert.strictEqual(player._npcTalk.nodeId, 'given');
    assert.ok(!player._npcTalk.shop);

    const opened = openShop(player, npc);
    assert.strictEqual(opened.ok, true);
    assert.strictEqual(player._npcTalk.shop, true);
});

test('TAS node jump does not apply reply give_item', () => {
    const { player, npc } = makeInvTalkPair();
    const ctx = {
        entityById: new Map([[npc.id, npc]]),
        itemDb: ITEM_DB,
        sim: { entityById: new Map([[npc.id, npc]]), creatures: [npc] }
    };
    const jumped = executeNpcDialog(
        player,
        { command: 'npc_dialog', args: { npcId: npc.id, nodeId: 'given' } },
        ctx
    );
    assert.strictEqual(jumped.ok, true);
    assert.strictEqual(player._npcTalk.nodeId, 'given');
    assert.strictEqual(countPlayerItem(player, 'gold_coin'), 0);
    assert.strictEqual(getStorage(player, 'guide.gift'), 0);
});

test('outfitter_calder ships mapped shop prices', () => {
    const tpl = presets.loadCreatureTemplate('outfitter_calder');
    assert.strictEqual(tpl.isNpc, true);
    assert.strictEqual(tpl.dialogId, 'outfitter_calder');
    const shop = resolveShop(tpl);
    assert.ok(shop);
    assert.strictEqual(shop.currency, 'gold_coin');
    const rows = shop.items || [];
    const byId = {};
    for (let i = 0; i < rows.length; i++) {
        const id = rows[i].itemId || rows[i].item;
        byId[id] = rows[i];
    }
    assert.strictEqual(byId.shovel.buy, 10);
    assert.strictEqual(byId.shovel.sell, 2);
    assert.strictEqual(byId.rope.buy, 50);
    assert.strictEqual(byId.rope.sell, 8);
    assert.strictEqual(byId.pick.buy, 15);
    assert.ok(!byId.pick.sell);
    assert.strictEqual(byId.fishing_rod.buy, 150);
    assert.strictEqual(byId.fishing_rod.sell, 30);
    assert.strictEqual(byId.worm.buy, 1);
    const itemDb = presets.loadEquipment().items;
    const { player } = makeInvTalkPair({ shop: tpl.shop });
    assert.ok(giveItemToPlayer(player, { itemId: 'gold_coin', count: 10 }, itemDb).ok);
    const bought = buyFromShop(player, shop, 'shovel', 1, itemDb);
    assert.strictEqual(bought.ok, true, bought.reason);
    assert.strictEqual(countPlayerItem(player, 'shovel'), 1);
    assert.strictEqual(countPlayerItem(player, 'gold_coin'), 0);
    const raw = loadDialogById('outfitter_calder');
    assert.ok(raw && raw.nodes && raw.nodes.start);
    const trade = (raw.nodes.start.replies || []).some(
        (r) => r && r.action === 'open_shop'
    );
    assert.ok(trade, 'Trade opens shop');
});

if (failed) {
    console.error(`${failed} failed, ${passed} passed`);
    process.exit(1);
}
console.log(`${passed} passed`);
