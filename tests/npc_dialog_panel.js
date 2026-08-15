#!/usr/bin/env node
/**
 * Stage 6b — floating NPC dialog panel + TALK_NPC adapter (Phase 5).
 */

'use strict';

const assert = require('assert');
const { Creature } = require('../kernel/core/entities/creature.js');
const { Player } = require('../kernel/core/entities/player.js');
const presets = require('../kernel/core/lib/presets.js');
const { getTalkSession } = require('../kernel/core/lib/npc/session.js');
const { getStorage } = require('../kernel/core/lib/npc/storage.js');
const { countPlayerItem, giveItemToPlayer } = require('../kernel/core/lib/npc/items.js');
const {
    npcLabel,
    nodeBodyText,
    createNpcDialogPanel
} = require('../kernel/apps/game/npc_dialog_panel.js');
const { bindInventoryPanel } = require('../kernel/apps/game/inventory_panel.js');

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

function matchesSel(node, sel) {
    const raw = String(sel || '').trim();
    if (!raw || !node) return false;
    if (raw.charAt(0) === '.') {
        return String(node.className || '')
            .split(/\s+/)
            .includes(raw.slice(1));
    }
    if (raw.charAt(0) === '#') return node.id === raw.slice(1);
    return String(node.tagName || '').toLowerCase() === raw.toLowerCase();
}

function walk(node, visit) {
    visit(node);
    const kids = node.childNodes || [];
    for (let i = 0; i < kids.length; i++) walk(kids[i], visit);
}

function makeNode(tag) {
    const node = {
        tagName: String(tag || 'div').toUpperCase(),
        className: '',
        id: '',
        style: {},
        dataset: {},
        childNodes: [],
        parentNode: null,
        textContent: '',
        hidden: false,
        disabled: false,
        type: tag === 'button' ? 'button' : '',
        offsetLeft: 100,
        offsetTop: 140,
        _listeners: {},
        setAttribute(name, value) {
            if (name === 'class') node.className = String(value);
            if (name === 'id') node.id = String(value);
            if (name === 'aria-label') node['aria-label'] = String(value);
            if (String(name).indexOf('data-') === 0) {
                const key = String(name)
                    .slice(5)
                    .replace(/-([a-z])/g, (_, c) => c.toUpperCase());
                node.dataset[key] = String(value);
            }
        },
        appendChild(child) {
            child.parentNode = node;
            node.childNodes.push(child);
            return child;
        },
        removeChild(child) {
            node.childNodes = node.childNodes.filter((c) => c !== child);
            child.parentNode = null;
            return child;
        },
        remove() {
            if (node.parentNode) node.parentNode.removeChild(node);
        },
        contains(other) {
            if (other === node) return true;
            for (let i = 0; i < node.childNodes.length; i++) {
                if (node.childNodes[i].contains(other)) return true;
            }
            return false;
        },
        closest(sel) {
            let cur = node;
            while (cur) {
                if (matchesSel(cur, sel)) return cur;
                cur = cur.parentNode;
            }
            return null;
        },
        querySelector(sel) {
            let hit = null;
            walk(node, (n) => {
                if (!hit && n !== node && matchesSel(n, sel)) hit = n;
            });
            return hit;
        },
        querySelectorAll(sel) {
            const out = [];
            walk(node, (n) => {
                if (n !== node && matchesSel(n, sel)) out.push(n);
            });
            return out;
        },
        addEventListener(type, fn) {
            if (!node._listeners[type]) node._listeners[type] = [];
            node._listeners[type].push(fn);
        },
        removeEventListener(type, fn) {
            node._listeners[type] = (node._listeners[type] || []).filter(
                (f) => f !== fn
            );
        },
        click() {
            const ev = {
                target: node,
                preventDefault() {},
                stopPropagation() {}
            };
            (node._listeners.click || []).forEach((fn) => fn(ev));
        }
    };
    Object.defineProperty(node, 'firstChild', {
        get() {
            return node.childNodes[0] || null;
        }
    });
    node.classList = {
        add(...cs) {
            const set = new Set(String(node.className).split(/\s+/).filter(Boolean));
            cs.forEach((c) => set.add(c));
            node.className = Array.from(set).join(' ');
        },
        remove(...cs) {
            const set = new Set(String(node.className).split(/\s+/).filter(Boolean));
            cs.forEach((c) => set.delete(c));
            node.className = Array.from(set).join(' ');
        },
        contains(c) {
            return String(node.className).split(/\s+/).includes(c);
        },
        toggle(c, on) {
            if (on === undefined) on = !node.classList.contains(c);
            if (on) node.classList.add(c);
            else node.classList.remove(c);
        }
    };
    return node;
}

function installDom() {
    const body = makeNode('body');
    const listeners = {};
    const doc = {
        body,
        hidden: false,
        getElementById(id) {
            let hit = null;
            walk(body, (n) => {
                if (!hit && n.id === id) hit = n;
            });
            return hit;
        },
        querySelector(sel) {
            if (sel === '.game-backpack-panel') return null;
            return body.querySelector(sel);
        },
        createElement: makeNode,
        addEventListener(type, fn) {
            if (!listeners[type]) listeners[type] = [];
            listeners[type].push(fn);
        },
        removeEventListener(type, fn) {
            listeners[type] = (listeners[type] || []).filter((f) => f !== fn);
        },
        dispatch(type, ev) {
            (listeners[type] || []).forEach((fn) => fn(ev));
        }
    };
    const origDoc = global.document;
    const origWin = global.window;
    global.document = doc;
    global.window = {
        innerWidth: 1280,
        innerHeight: 720,
        addEventListener() {},
        removeEventListener() {}
    };
    return {
        doc,
        body,
        restore() {
            if (origDoc === undefined) delete global.document;
            else global.document = origDoc;
            if (origWin === undefined) delete global.window;
            else global.window = origWin;
        }
    };
}

function makeTalkPair() {
    const template = presets.loadCreatureTemplate('town_guide');
    const npc = new Creature({
        id: 21,
        name: 'Guide',
        tile: { x: 4, y: 2, z: 0 },
        hp: 80,
        hpMax: 80
    });
    npc.applyTemplate(template);
    const player = {
        id: 1,
        alive: true,
        tile: { x: 2, y: 2, z: 0 },
        commandQueue: [],
        _npcTalk: null
    };
    const ctx = {
        entityById: new Map([[npc.id, npc]]),
        creatures: [npc]
    };
    return { player, npc, ctx };
}

test('npcLabel prefers label then name', () => {
    assert.strictEqual(npcLabel({ label: 'Guide', name: 'X' }), 'Guide');
    assert.strictEqual(npcLabel({ name: 'Guide' }), 'Guide');
    assert.strictEqual(npcLabel(null), 'NPC');
});

test('nodeBodyText falls back to greeting', () => {
    assert.strictEqual(
        nodeBodyText({ greeting: 'Hi' }, { text: 'Node text' }),
        'Node text'
    );
    assert.strictEqual(nodeBodyText({ greeting: 'Hi' }, {}), 'Hi');
    assert.strictEqual(nodeBodyText(null, null), '');
});

test('openForTest shows start node name, text, and replies', () => {
    const dom = installDom();
    try {
        const { player, npc, ctx } = makeTalkPair();
        const root = makeNode('div');
        root.id = 'inventoryFloatRoot';
        dom.body.appendChild(root);
        const panel = createNpcDialogPanel({
            floatRoot: root,
            getPlayer: () => player,
            getCtx: () => ctx
        });
        const opened = panel.openForTest(npc, player, ctx);
        assert.strictEqual(opened.ok, true, 'open in range');
        assert.strictEqual(panel.isOpen(), true);
        const el = panel.getElement();
        assert.ok(el, 'panel element');
        assert.ok(
            String(el.className).indexOf('inv-npc-dialog-panel') >= 0,
            'dialog chrome class'
        );
        assert.strictEqual(el.querySelector('.inv-panel-title').textContent, 'Guide');
        assert.strictEqual(
            el.querySelector('.inv-npc-dialog-text').textContent,
            'Welcome, hunter. Need directions?'
        );
        const replies = el.querySelectorAll('.inv-npc-dialog-reply');
        assert.strictEqual(replies.length, 4);
        assert.strictEqual(replies[0].textContent, 'Arena');
        assert.strictEqual(replies[1].textContent, 'Mission');
        assert.strictEqual(replies[2].textContent, 'Trade');
        assert.strictEqual(replies[3].textContent, 'Bye');
        assert.strictEqual(getTalkSession(player).nodeId, 'start');
        panel.dispose();
    } finally {
        dom.restore();
    }
});

test('dialog panel opens to the right of the live NPC tile', () => {
    const dom = installDom();
    try {
        const { player, npc, ctx } = makeTalkPair();
        ctx.sim = { tileMap: { _viewOriginX: 0, _viewOriginY: 0, _viewZ: 0 } };
        const canvas = {
            width: 720,
            height: 480,
            getBoundingClientRect: () => ({
                left: 100,
                top: 50,
                right: 820,
                bottom: 530,
                width: 720,
                height: 480
            })
        };
        const root = makeNode('div');
        root.id = 'inventoryFloatRoot';
        dom.body.appendChild(root);
        const panel = createNpcDialogPanel({
            floatRoot: root,
            getPlayer: () => player,
            getCtx: () => ctx,
            getCanvas: () => canvas,
            getTileSize: () => ({ w: 32, h: 32 })
        });
        panel.openForTest(npc, player, ctx);
        const el = panel.getElement();
        // tile (4,2) → client right = 100 + 5*32 = 260; prefer 260 + 8
        assert.strictEqual(el.style.left, '268px');
        assert.strictEqual(el.style.top, '114px');
        panel.dispose();
    } finally {
        dom.restore();
    }
});

test('Arena reply navigates and enqueues npc_dialog goto', () => {
    const dom = installDom();
    try {
        const { player, npc, ctx } = makeTalkPair();
        const root = makeNode('div');
        dom.body.appendChild(root);
        const panel = createNpcDialogPanel({
            floatRoot: root,
            getPlayer: () => player,
            getCtx: () => ctx
        });
        panel.openForTest(npc, player, ctx);
        player.commandQueue = [];
        panel.getElement().querySelectorAll('.inv-npc-dialog-reply')[0].click();
        assert.strictEqual(getTalkSession(player).nodeId, 'arena');
        assert.strictEqual(
            panel.getElement().querySelector('.inv-npc-dialog-text').textContent,
            'The arena portal is north of the fountain.'
        );
        const thanks = panel.getElement().querySelectorAll('.inv-npc-dialog-reply');
        assert.strictEqual(thanks.length, 1);
        assert.strictEqual(thanks[0].textContent, 'Thanks');
        assert.strictEqual(player.commandQueue.length, 1);
        assert.strictEqual(player.commandQueue[0].type, 'CUSTOM_COMMAND');
        assert.strictEqual(player.commandQueue[0].command, 'npc_dialog');
        assert.strictEqual(player.commandQueue[0].args.nodeId, 'arena');
        panel.dispose();
    } finally {
        dom.restore();
    }
});

test('Mission reply writes storage and swaps the gated start replies', () => {
    const dom = installDom();
    try {
        const { player, npc, ctx } = makeTalkPair();
        const root = makeNode('div');
        dom.body.appendChild(root);
        const panel = createNpcDialogPanel({
            floatRoot: root,
            getPlayer: () => player,
            getCtx: () => ctx
        });
        panel.openForTest(npc, player, ctx);
        player.commandQueue = [];
        const mission = panel
            .getElement()
            .querySelectorAll('.inv-npc-dialog-reply')
            .find((b) => b.textContent === 'Mission');
        assert.ok(mission, 'Mission visible when storage is unset');
        mission.click();
        assert.strictEqual(getTalkSession(player).nodeId, 'mission');
        assert.strictEqual(getStorage(player, 'town_guide.mission'), 1);
        assert.strictEqual(
            panel.getElement().querySelector('.inv-npc-dialog-text').textContent,
            'Clear the north trail, then come back.'
        );
        panel.getElement().querySelector('.inv-panel-close').click();
        panel.openForTest(npc, player, ctx);
        const labels = panel
            .getElement()
            .querySelectorAll('.inv-npc-dialog-reply')
            .map((b) => b.textContent);
        assert.deepStrictEqual(labels, ['Arena', 'How goes the hunt?', 'Trade', 'Bye']);
        panel.dispose();
    } finally {
        dom.restore();
    }
});

test('Bye / close / Escape / click-outside clear session', () => {
    const dom = installDom();
    try {
        const { player, npc, ctx } = makeTalkPair();
        const root = makeNode('div');
        dom.body.appendChild(root);
        const panel = createNpcDialogPanel({
            floatRoot: root,
            getPlayer: () => player,
            getCtx: () => ctx
        });

        panel.openForTest(npc, player, ctx);
        player.commandQueue = [];
        const bye = panel
            .getElement()
            .querySelectorAll('.inv-npc-dialog-reply')
            .find((b) => b.textContent === 'Bye');
        assert.ok(bye, 'Bye reply');
        bye.click();
        assert.strictEqual(getTalkSession(player), null);
        assert.strictEqual(panel.isOpen(), false);
        assert.strictEqual(player.commandQueue[0].args.action, 'close');

        panel.openForTest(npc, player, ctx);
        player.commandQueue = [];
        panel.getElement().querySelector('.inv-panel-close').click();
        assert.strictEqual(getTalkSession(player), null);
        assert.strictEqual(panel.isOpen(), false);

        panel.openForTest(npc, player, ctx);
        player.commandQueue = [];
        dom.doc.dispatch('keydown', {
            key: 'Escape',
            preventDefault() {},
            stopPropagation() {}
        });
        assert.strictEqual(getTalkSession(player), null);
        assert.strictEqual(panel.isOpen(), false);

        panel.openForTest(npc, player, ctx);
        player.commandQueue = [];
        const outside = makeNode('div');
        dom.body.appendChild(outside);
        dom.doc.dispatch('pointerdown', {
            target: outside,
            preventDefault() {},
            stopPropagation() {}
        });
        assert.strictEqual(getTalkSession(player), null);
        assert.strictEqual(panel.isOpen(), false);
        panel.dispose();
    } finally {
        dom.restore();
    }
});

test('sync with no session leaves the float root empty', () => {
    const dom = installDom();
    try {
        const { player, ctx } = makeTalkPair();
        const root = makeNode('div');
        dom.body.appendChild(root);
        const panel = createNpcDialogPanel({
            floatRoot: root,
            getPlayer: () => player,
            getCtx: () => ctx
        });
        panel.sync(player, ctx);
        assert.strictEqual(panel.isOpen(), false);
        assert.strictEqual(root.childNodes.length, 0);
        panel.dispose();
    } finally {
        dom.restore();
    }
});

test('out of range openForTest is a no-op', () => {
    const dom = installDom();
    try {
        const { player, npc, ctx } = makeTalkPair();
        npc.tile = { x: 20, y: 20, z: 0 };
        const root = makeNode('div');
        dom.body.appendChild(root);
        const panel = createNpcDialogPanel({
            floatRoot: root,
            getPlayer: () => player,
            getCtx: () => ctx
        });
        const opened = panel.openForTest(npc, player, ctx);
        assert.strictEqual(opened.ok, false);
        assert.strictEqual(opened.reason, 'out_of_range');
        assert.strictEqual(panel.isOpen(), false);
        assert.strictEqual(getTalkSession(player), null);
        panel.dispose();
    } finally {
        dom.restore();
    }
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
        id: 'bread',
        label: 'Bread',
        category: 'food',
        stackable: true,
        weight: 10
    }
];

test('give_item reply is clickable and adds coins; take fail floats', () => {
    const dom = installDom();
    try {
        const npc = new Creature({
            id: 21,
            name: 'Guide',
            tile: { x: 4, y: 2, z: 0 },
            hp: 80,
            hpMax: 80
        });
        npc.isNpc = true;
        npc.kind = 'npc';
        npc.dialog = {
            start: 'start',
            nodes: {
                start: {
                    text: 'Coin?',
                    replies: [
                        {
                            label: 'Yes',
                            action: 'give_item',
                            item: 'gold_coin',
                            count: 2,
                            goto: 'given'
                        },
                        {
                            label: 'Pay',
                            action: 'take_item',
                            item: 'gold_coin',
                            count: 5
                        }
                    ]
                },
                given: {
                    text: 'Here.',
                    replies: [{ label: 'Ok', action: 'close' }]
                }
            }
        };
        const player = new Player({
            id: 1,
            name: 'Talker',
            tile: { x: 2, y: 2, z: 0 },
            itemDb: ITEM_DB
        });
        player.alive = true;
        player._loadoutItemDb = ITEM_DB;
        player.initInventory({ equipment: { backpack: 'backpack' } }, ITEM_DB);
        player._npcTalk = null;
        player.commandQueue = [];
        const ctx = {
            entityById: new Map([[npc.id, npc]]),
            creatures: [npc],
            itemDb: ITEM_DB
        };
        const floats = [];
        const root = makeNode('div');
        dom.body.appendChild(root);
        const panel = createNpcDialogPanel({
            floatRoot: root,
            getPlayer: () => player,
            getCtx: () => ctx,
            onSystemFloat: (_p, text) => floats.push(text)
        });
        panel.openForTest(npc, player, ctx);
        const buttons = panel.getElement().querySelectorAll('.inv-npc-dialog-reply');
        const yes = buttons.find((b) => b.textContent === 'Yes');
        const pay = buttons.find((b) => b.textContent === 'Pay');
        assert.ok(yes && !yes.disabled, 'give_item is not a stub');
        assert.ok(pay && !pay.disabled, 'take_item is not a stub');
        pay.click();
        assert.strictEqual(floats[0], 'You do not have that.');
        assert.strictEqual(getTalkSession(player).nodeId, 'start');
        assert.strictEqual(countPlayerItem(player, 'gold_coin'), 0);
        yes.click();
        assert.strictEqual(getTalkSession(player).nodeId, 'given');
        assert.strictEqual(countPlayerItem(player, 'gold_coin'), 2);
        assert.ok(
            player.commandQueue.some(
                (c) =>
                    c &&
                    c.command === 'npc_dialog' &&
                    c.args &&
                    c.args.nodeId === 'given'
            ),
            'give then goto still enqueues npc_dialog for TAS'
        );
        assert.strictEqual(
            panel.getElement().querySelector('.inv-npc-dialog-text').textContent,
            'Here.'
        );
        panel.dispose();
    } finally {
        dom.restore();
    }
});

test('Trade reply opens shop; buy fail floats; buy then Back', () => {
    const dom = installDom();
    try {
        const npc = new Creature({
            id: 21,
            name: 'Guide',
            tile: { x: 4, y: 2, z: 0 },
            hp: 80,
            hpMax: 80
        });
        npc.isNpc = true;
        npc.kind = 'npc';
        npc.shop = {
            currency: 'gold_coin',
            items: [{ item: 'bread', buy: 4, sell: 1 }]
        };
        npc.dialog = {
            start: 'start',
            nodes: {
                start: {
                    text: 'Wares?',
                    replies: [
                        { label: 'Trade', action: 'open_shop' },
                        { label: 'Bye', action: 'close' }
                    ]
                }
            }
        };
        const player = new Player({
            id: 1,
            name: 'Talker',
            tile: { x: 2, y: 2, z: 0 },
            itemDb: ITEM_DB
        });
        player.alive = true;
        player._loadoutItemDb = ITEM_DB;
        player.initInventory({ equipment: { backpack: 'backpack' } }, ITEM_DB);
        player._npcTalk = null;
        player.commandQueue = [];
        const ctx = {
            entityById: new Map([[npc.id, npc]]),
            creatures: [npc],
            itemDb: ITEM_DB
        };
        const floats = [];
        const root = makeNode('div');
        dom.body.appendChild(root);
        const panel = createNpcDialogPanel({
            floatRoot: root,
            getPlayer: () => player,
            getCtx: () => ctx,
            onSystemFloat: (_p, text) => floats.push(text)
        });
        panel.openForTest(npc, player, ctx);
        const trade = panel
            .getElement()
            .querySelectorAll('.inv-npc-dialog-reply')
            .find((b) => b.textContent === 'Trade');
        assert.ok(trade && !trade.disabled, 'open_shop is not a stub');
        trade.click();
        assert.strictEqual(getTalkSession(player).shop, true);
        const el = panel.getElement();
        assert.ok(String(el.className).indexOf('is-shop') >= 0, 'shop chrome');
        assert.strictEqual(
            el.querySelector('.inv-npc-shop-currency').textContent,
            'Gold Coin: 0'
        );
        const buy = el.querySelector('.inv-npc-shop-buy');
        assert.ok(buy, 'buy button');
        assert.strictEqual(buy.dataset.itemId, 'bread');
        buy.click();
        assert.strictEqual(floats[0], 'You cannot afford that.');
        assert.strictEqual(countPlayerItem(player, 'bread'), 0);

        assert.ok(giveItemToPlayer(player, { itemId: 'gold_coin', count: 10 }, ITEM_DB).ok);
        panel.sync(player, ctx);
        el.querySelector('.inv-npc-shop-buy').click();
        assert.strictEqual(countPlayerItem(player, 'bread'), 1);
        assert.strictEqual(countPlayerItem(player, 'gold_coin'), 6);
        assert.strictEqual(
            panel.getElement().querySelector('.inv-npc-shop-currency').textContent,
            'Gold Coin: 6'
        );

        panel.getElement().querySelector('.inv-npc-shop-back').click();
        assert.strictEqual(getTalkSession(player).shop, undefined);
        const labels = panel
            .getElement()
            .querySelectorAll('.inv-npc-dialog-reply')
            .map((b) => b.textContent);
        assert.deepStrictEqual(labels, ['Trade', 'Bye']);
        assert.ok(
            player.commandQueue.some(
                (c) =>
                    c &&
                    c.command === 'npc_dialog' &&
                    c.args &&
                    c.args.action === 'open_shop'
            ),
            'open_shop is queued for TAS'
        );
        panel.dispose();
    } finally {
        dom.restore();
    }
});

function bindTalkAdapter(player, npc, extraSim) {
    const floats = [];
    const sim = Object.assign(
        {
            parties: [{ members: [player] }],
            getCameraFocusMember: () => player,
            creatures: [npc],
            entityById: new Map([[npc.id, npc]]),
            tileMap: extraSim && extraSim.tileMap !== undefined
                ? extraSim.tileMap
                : null,
            groundItems: null,
            emitCombatText(payload) {
                floats.push(payload);
            }
        },
        extraSim || {}
    );
    if (!sim.entityById) sim.entityById = new Map([[npc.id, npc]]);
    const canvas = {
        width: 720,
        height: 480,
        getContext: () => ({}),
        getBoundingClientRect: () => ({
            left: 0,
            top: 0,
            right: 720,
            bottom: 480,
            width: 720,
            height: 480
        }),
        addEventListener() {},
        removeEventListener() {}
    };
    const ctl = bindInventoryPanel({
        canvas,
        getSim: () => sim,
        isSessionLive: () => true,
        getItemDb: () => ({}),
        getGenre: () => 'rpg_fantasy',
        intervalMs: 10000
    });
    return { ctl, sim, floats };
}

test('TALK_NPC in range opens panel and enqueues npc_dialog', () => {
    const dom = installDom();
    try {
        const { player, npc } = makeTalkPair();
        const { ctl, sim } = bindTalkAdapter(player, npc);
        ctl.handleCanvasAdapterIntent(
            {
                type: 'TALK_NPC',
                creature: npc,
                creatureId: npc.id,
                tile: npc.tile
            },
            { player, sim }
        );
        const session = getTalkSession(player);
        assert.ok(session, 'session opened');
        assert.strictEqual(session.nodeId, 'start');
        assert.strictEqual(player.commandQueue.length, 1);
        assert.strictEqual(player.commandQueue[0].type, 'CUSTOM_COMMAND');
        assert.strictEqual(player.commandQueue[0].command, 'npc_dialog');
        assert.strictEqual(player.commandQueue[0].args.npcId, npc.id);
        assert.strictEqual(player.commandQueue[0].args.nodeId, 'start');
        const root = dom.doc.getElementById('inventoryFloatRoot');
        assert.ok(root, 'float root');
        assert.ok(
            root.querySelector('.inv-npc-dialog-panel'),
            'dialog panel painted'
        );
        ctl.dispose();
    } finally {
        dom.restore();
    }
});

test('TALK_NPC without dialog → Nothing to say.', () => {
    const dom = installDom();
    try {
        const { player } = makeTalkPair();
        const mute = {
            id: 22,
            name: 'Mute',
            isNpc: true,
            kind: 'npc',
            alive: true,
            tile: { x: 3, y: 2, z: 0 }
        };
        player.tile = { x: 2, y: 2, z: 0 };
        const { ctl, sim, floats } = bindTalkAdapter(player, mute);
        ctl.handleCanvasAdapterIntent(
            {
                type: 'TALK_NPC',
                creature: mute,
                creatureId: mute.id,
                tile: mute.tile
            },
            { player, sim }
        );
        assert.strictEqual(getTalkSession(player), null);
        assert.strictEqual(player.commandQueue.length, 0);
        assert.ok(
            floats.some((f) => f && f.text === 'Nothing to say.'),
            'honest FCT'
        );
        ctl.dispose();
    } finally {
        dom.restore();
    }
});

test('TALK_NPC out of range walks then opens on arrival', () => {
    const dom = installDom();
    try {
        const { player, npc } = makeTalkPair();
        npc.tile = { x: 12, y: 2, z: 0 };
        player.tile = { x: 2, y: 2, z: 0 };
        const { ctl, sim } = bindTalkAdapter(player, npc);
        ctl.handleCanvasAdapterIntent(
            {
                type: 'TALK_NPC',
                creature: npc,
                creatureId: npc.id,
                tile: npc.tile
            },
            { player, sim }
        );
        assert.strictEqual(getTalkSession(player), null, 'not open while far');
        assert.strictEqual(player.commandQueue.length, 1);
        assert.strictEqual(player.commandQueue[0].type, 'START_AUTOWALK');
        const dest = player.commandQueue[0].dest;
        assert.ok(dest);
        assert.ok(
            Math.max(Math.abs(dest.x - 12), Math.abs(dest.y - 2)) <= 3,
            'walk dest within talk range'
        );

        player.tile = { x: 10, y: 2, z: 0 };
        player._manualDest = null;
        player.path = [];
        player.commandQueue = [];
        ctl.refresh();
        const session = getTalkSession(player);
        assert.ok(session, 'opens after walking into range');
        assert.strictEqual(session.nodeId, 'start');
        assert.strictEqual(player.commandQueue[0].type, 'CUSTOM_COMMAND');
        assert.strictEqual(player.commandQueue[0].command, 'npc_dialog');
        ctl.dispose();
    } finally {
        dom.restore();
    }
});

test('TALK_NPC pending survives paint before autowalk starts', () => {
    const dom = installDom();
    try {
        const { player, npc } = makeTalkPair();
        npc.tile = { x: 12, y: 2, z: 0 };
        player.tile = { x: 2, y: 2, z: 0 };
        const { ctl, sim } = bindTalkAdapter(player, npc);
        ctl.handleCanvasAdapterIntent(
            {
                type: 'TALK_NPC',
                creature: npc,
                creatureId: npc.id,
                tile: npc.tile
            },
            { player, sim }
        );
        ctl.refresh();
        assert.strictEqual(getTalkSession(player), null, 'still far after paint');
        assert.strictEqual(player.commandQueue[0].type, 'START_AUTOWALK');

        player.tile = { x: 10, y: 2, z: 0 };
        player._manualDest = null;
        player.path = [];
        player.commandQueue = [];
        ctl.refresh();
        assert.ok(getTalkSession(player), 'opens after arrival despite early paint');
        ctl.dispose();
    } finally {
        dom.restore();
    }
});

test('TALK_NPC pending drops when walk is cancelled far away', () => {
    const dom = installDom();
    try {
        const { player, npc } = makeTalkPair();
        npc.tile = { x: 12, y: 2, z: 0 };
        player.tile = { x: 2, y: 2, z: 0 };
        const { ctl, sim } = bindTalkAdapter(player, npc);
        ctl.handleCanvasAdapterIntent(
            {
                type: 'TALK_NPC',
                creature: npc,
                creatureId: npc.id,
                tile: npc.tile
            },
            { player, sim }
        );
        player.commandQueue = [];
        player._manualDest = null;
        player.path = [];
        ctl.refresh();
        player.tile = { x: 10, y: 2, z: 0 };
        ctl.refresh();
        assert.strictEqual(
            getTalkSession(player),
            null,
            'cancelled walk must not open talk on a later teleport'
        );
        ctl.dispose();
    } finally {
        dom.restore();
    }
});

test('TALK_NPC with no path → There is no way.', () => {
    const dom = installDom();
    try {
        const { player, npc } = makeTalkPair();
        npc.tile = { x: 12, y: 2, z: 0 };
        player.tile = { x: 2, y: 2, z: 0 };
        const { ctl, sim, floats } = bindTalkAdapter(player, npc, {
            tileMap: { isTileWalkable: () => false }
        });
        ctl.handleCanvasAdapterIntent(
            {
                type: 'TALK_NPC',
                creature: npc,
                creatureId: npc.id,
                tile: npc.tile
            },
            { player, sim }
        );
        assert.strictEqual(getTalkSession(player), null);
        assert.strictEqual(player.commandQueue.length, 0);
        assert.ok(
            floats.some((f) => f && f.text === 'There is no way.'),
            'cancel FCT'
        );
        ctl.dispose();
    } finally {
        dom.restore();
    }
});
