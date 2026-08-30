#!/usr/bin/env node
/**
 * D1 — empty corpse spawn on wild death.
 * D2 — roll loot into the corpse; overflow under corpse; loot FCT.
 * D3 — OPEN_CORPSE adapter (walk-then-open); QUICKLOOT stub maps to open.
 * D4 — features.corpseLoot; worth on bag insert; headless scalar.
 * Quiet on success; VERBOSE=1 for detail.
 */

'use strict';

const assert = require('assert');
const { TileMap } = require('../kernel/core/entities/tilemap.js');
const { Creature } = require('../kernel/core/entities/creature.js');
const { Player } = require('../kernel/core/entities/player.js');
const { Party } = require('../kernel/core/entities/party.js');
const { Simulator } = require('../kernel/providers/simulator/simulator.js');
const { Settings } = require('../kernel/settings.js');
const {
    getStack,
    peekTop,
    fillCorpse,
    spawnGroundItem,
    pickupItemFromGround
} = require('../kernel/core/lib/character/ground_items.js');
const {
    getItem,
    getContainer,
    getStackCount,
    createEmptyInventory,
    buildInventoryFromSeed
} = require('../kernel/core/lib/character/inventory.js');
const {
    huntToSimulatorOpts,
    resolveCorpseLootFlag
} = require('../kernel/providers/simulator/hunt_opts.js');
const {
    isCorpseLike,
    resolveCanvasHit
} = require('../kernel/apps/game/mouse_dispatcher.js');
const { bindInventoryPanel } = require('../kernel/apps/game/inventory_panel.js');

const verbose = process.env.VERBOSE === '1';
function log(...args) {
    if (verbose) console.log(...args);
}

let passed = 0;
let failed = 0;

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

const ITEM_DB = [
    {
        id: 'monster_corpse',
        label: 'Dead creature',
        category: 'container',
        volume: 20,
        weight: 5000,
        isCorpse: true
    },
    {
        id: 'backpack',
        label: 'Backpack',
        category: 'container',
        slot: 'backpack',
        volume: 20,
        weight: 1
    },
    {
        id: 'gold_coin',
        label: 'Gold Coin',
        stackable: true,
        weight: 1,
        worth: 1
    },
    {
        id: 'tiny_corpse',
        label: 'Tiny corpse',
        category: 'container',
        volume: 1,
        weight: 500,
        isCorpse: true
    },
    {
        id: 'chain_armor',
        label: 'Chain Armor',
        weight: 100
    },
    {
        id: 'fishing_rod',
        label: 'Fishing Rod',
        weight: 80
    }
];

function rgbaFromPixels(cols, rows, pixels) {
    const out = new Uint8Array(cols * rows * 4);
    for (let i = 0; i < cols * rows; i++) {
        const p = pixels[i];
        const o = i * 4;
        out[o] = p[0];
        out[o + 1] = p[1];
        out[o + 2] = p[2];
        out[o + 3] = 255;
    }
    return out;
}

function openFloor(cols, rows, gray) {
    const g = gray !== undefined ? gray : 100;
    const pixels = [];
    for (let i = 0; i < cols * rows; i++) pixels.push([g, g, g]);
    const map = new TileMap();
    map.loadFloorFromRgba(0, cols, rows, rgbaFromPixels(cols, rows, pixels));
    return map;
}

function monsterTemplate(extra) {
    return Object.assign(
        {
            id: 'cave_rat',
            label: 'Cave Rat',
            hp: 20,
            hpMax: 20,
            lootValue: 7,
            loot: [],
            attacks: [{ id: 'melee_0', kind: 'melee', min: 1, max: 4 }]
        },
        extra || {}
    );
}

/**
 * @param {{ corpseLoot?: boolean }} [opts]
 */
function makeHunt(opts) {
    const o = opts || {};
    const map = openFloor(16, 16, 100);
    const simOpts = {
        seed: 41,
        combatAi: false,
        itemDb: ITEM_DB
    };
    if (typeof o.corpseLoot === 'boolean') simOpts.corpseLoot = o.corpseLoot;
    const sim = new Simulator(simOpts);
    sim.setTileMap(map);
    sim.floor = 0;
    const party = new Party({ name: 'CorpseLoot' });
    const player = new Player({
        id: sim.allocEntityId(),
        name: 'Lead',
        classId: 'guardian',
        isLeader: true,
        tile: { x: 2, y: 2, z: 0 }
    });
    map.tryOccupy(2, 2, 0, player);
    party.addMember(player);
    sim.parties.push(party);
    sim.insertChild(party);
    sim.entityById.set(player.id, player);
    return { sim, map, party, player };
}

function spawnMob(sim, x, y, extra) {
    return sim.spawnFromTable({
        creatureId: 'cave_rat',
        x,
        y,
        z: 0,
        template: monsterTemplate(extra)
    });
}

function kill(sim, attacker, defender) {
    defender.hp.current = 0;
    defender.alive = false;
    sim.recordAttack(attacker, defender, {
        ok: true,
        hit: true,
        final: 20,
        fatal: true
    });
}

function corpseOnTile(sim, x, y, z) {
    const uid = peekTop(sim.groundItems, x, y, z);
    if (!uid) return null;
    return getItem(sim.groundItems.inventory, uid);
}

function captureFct(sim) {
    const texts = [];
    sim.emitCombatText = (opts) => {
        texts.push(opts);
    };
    return texts;
}

function containerItemIds(inv, containerUid) {
    const cont = getContainer(inv, containerUid);
    if (!cont || !Array.isArray(cont.slots)) return [];
    const ids = [];
    for (let i = 0; i < cont.slots.length; i++) {
        const uid = cont.slots[i];
        if (!uid) continue;
        const inst = getItem(inv, uid);
        if (inst) ids.push(inst.itemId);
    }
    return ids;
}

function quiet(fn) {
    const orig = console.warn;
    console.warn = verbose ? orig : () => {};
    try {
        return fn();
    } finally {
        console.warn = orig;
    }
}

test('applyTemplate copies loot slice and corpseId', () => {
    const rows = [{ id: 'gold_coin', chance: 100000, maxCount: 4 }];
    const c = new Creature({ id: 2, name: 'Creature' });
    c.applyTemplate(
        monsterTemplate({
            loot: rows,
            corpseId: 'monster_corpse'
        })
    );
    assert.ok(Array.isArray(c.loot));
    assert.strictEqual(c.loot.length, 1);
    assert.strictEqual(c.loot[0].id, 'gold_coin');
    assert.notStrictEqual(c.loot, rows);
    c.loot.push({ id: 'mutated' });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(c.corpseId, 'monster_corpse');
});

test('flag off, kill: no ground corpse; lootValue award unchanged', () => {
    const { sim, party, player } = makeHunt({ corpseLoot: false });
    try {
        const mob = spawnMob(sim, 5, 5);
        assert.ok(mob);
        const before = party.lootGained;
        kill(sim, player, mob);
        assert.strictEqual(party.lootGained, before + 7);
        assert.strictEqual(getStack(sim.groundItems, 5, 5, 0).length, 0);
        assert.ok(!corpseOnTile(sim, 5, 5, 0));
    } finally {
        sim.destroy();
    }
});

test('flag on, wild kill: empty isCorpse container; occupancy released', () => {
    const { sim, map, party, player } = makeHunt({ corpseLoot: true });
    try {
        const mob = spawnMob(sim, 5, 5);
        assert.ok(mob);
        const occupant = map.getOccupant(5, 5, 0);
        assert.ok(occupant);
        const before = party.lootGained;
        kill(sim, player, mob);
        assert.strictEqual(party.lootGained, before);
        assert.strictEqual(map.getOccupant(5, 5, 0), 0);
        const stack = getStack(sim.groundItems, 5, 5, 0);
        assert.strictEqual(stack.length, 1);
        const inst = getItem(sim.groundItems.inventory, stack[0]);
        assert.ok(inst);
        assert.strictEqual(inst.isCorpse, true);
        assert.strictEqual(inst.itemId, 'monster_corpse');
        assert.strictEqual(inst.name, 'Dead Cave Rat');
        const cont = getContainer(sim.groundItems.inventory, stack[0]);
        assert.ok(cont);
        assert.strictEqual(cont.capacity, 20);
        assert.ok(cont.slots.every((s) => s == null), 'empty container');
        const hit = resolveCanvasHit({
            sim,
            player,
            tile: { x: 5, y: 5, z: 0 },
            itemDb: ITEM_DB
        });
        assert.strictEqual(hit.isCorpse, true);
        assert.ok(isCorpseLike(hit));
        assert.strictEqual(isCorpseLike({ isCorpse: true }), true);
    } finally {
        sim.destroy();
    }
});

test('summon death: no corpse', () => {
    const { sim, player } = makeHunt({ corpseLoot: true });
    try {
        const summon = spawnMob(sim, 6, 5);
        assert.ok(summon);
        summon.masterId = player.id;
        kill(sim, player, summon);
        assert.strictEqual(getStack(sim.groundItems, 6, 5, 0).length, 0);
    } finally {
        sim.destroy();
    }
});

test('empty loot still spawns empty corpse', () => {
    const { sim, player } = makeHunt({ corpseLoot: true });
    try {
        const mob = spawnMob(sim, 4, 4, { loot: [] });
        assert.ok(Array.isArray(mob.loot));
        assert.strictEqual(mob.loot.length, 0);
        kill(sim, player, mob);
        const inst = corpseOnTile(sim, 4, 4, 0);
        assert.ok(inst);
        assert.strictEqual(inst.isCorpse, true);
        const uid = peekTop(sim.groundItems, 4, 4, 0);
        const cont = getContainer(sim.groundItems.inventory, uid);
        assert.ok(cont.slots.every((s) => s == null));
    } finally {
        sim.destroy();
    }
});

test('Settings.features.corpseLoot true enables spawn when ctor omitted', () => {
    const prev = Settings.features.corpseLoot;
    Settings.features.corpseLoot = true;
    const { sim, player } = makeHunt();
    try {
        const mob = spawnMob(sim, 3, 7);
        kill(sim, player, mob);
        const inst = corpseOnTile(sim, 3, 7, 0);
        assert.ok(inst);
        assert.strictEqual(inst.isCorpse, true);
    } finally {
        Settings.features.corpseLoot = prev;
        sim.destroy();
    }
});

test('always-hit gold: corpse contains gold_coin; FCT lists it; roll does not add lootGained', () => {
    const { sim, party, player } = makeHunt({ corpseLoot: true });
    try {
        const mob = spawnMob(sim, 5, 5, {
            loot: [{ id: 'gold_coin', chance: 100000, minCount: 20, maxCount: 20 }]
        });
        const before = party.lootGained;
        const fcts = captureFct(sim);
        kill(sim, player, mob);
        assert.strictEqual(party.lootGained, before);
        const corpseUid = peekTop(sim.groundItems, 5, 5, 0);
        assert.ok(corpseUid);
        const ids = containerItemIds(sim.groundItems.inventory, corpseUid);
        assert.deepStrictEqual(ids, ['gold_coin']);
        const cont = getContainer(sim.groundItems.inventory, corpseUid);
        const gold = getItem(sim.groundItems.inventory, cont.slots[0]);
        assert.strictEqual(getStackCount(gold), 20);
        const lootLine = fcts.find((e) => e && String(e.text).indexOf('Loot of') === 0);
        assert.ok(lootLine, 'loot FCT emitted');
        assert.strictEqual(lootLine.text, 'Loot of Cave Rat: 20 Gold Coin');
        assert.strictEqual(lootLine.x, player.tile.x);
        assert.strictEqual(lootLine.y, player.tile.y);
        assert.strictEqual(getStack(sim.groundItems, 5, 5, 0).length, 1);
    } finally {
        sim.destroy();
    }
});

test('unknown loot id: skipped; empty corpse still spawned', () => {
    const { sim, player } = makeHunt({ corpseLoot: true });
    try {
        const mob = spawnMob(sim, 5, 6, {
            loot: [{ id: 'no_such_item_d2', chance: 100000 }]
        });
        const fcts = captureFct(sim);
        quiet(() => kill(sim, player, mob));
        const corpseUid = peekTop(sim.groundItems, 5, 6, 0);
        assert.ok(corpseUid);
        const inst = getItem(sim.groundItems.inventory, corpseUid);
        assert.strictEqual(inst.isCorpse, true);
        const ids = containerItemIds(sim.groundItems.inventory, corpseUid);
        assert.deepStrictEqual(ids, []);
        const lootLine = fcts.find((e) => e && String(e.text).indexOf('Loot of') === 0);
        assert.ok(lootLine);
        assert.strictEqual(lootLine.text, 'Loot of Cave Rat: nothing');
    } finally {
        sim.destroy();
    }
});

test('overfill: extra uids on same tile, corpse stays top', () => {
    const { sim, player } = makeHunt({ corpseLoot: true });
    try {
        const mob = spawnMob(sim, 8, 8, {
            corpseId: 'tiny_corpse',
            loot: [
                { id: 'chain_armor', chance: 100000 },
                { id: 'fishing_rod', chance: 100000 }
            ]
        });
        kill(sim, player, mob);
        const stack = getStack(sim.groundItems, 8, 8, 0);
        assert.strictEqual(stack.length, 2);
        const topUid = peekTop(sim.groundItems, 8, 8, 0);
        const top = getItem(sim.groundItems.inventory, topUid);
        assert.ok(top);
        assert.strictEqual(top.isCorpse, true);
        assert.strictEqual(top.itemId, 'tiny_corpse');
        const inside = containerItemIds(sim.groundItems.inventory, topUid);
        assert.deepStrictEqual(inside, ['chain_armor']);
        const underUid = stack[0];
        assert.notStrictEqual(underUid, topUid);
        const under = getItem(sim.groundItems.inventory, underUid);
        assert.ok(under);
        assert.strictEqual(under.itemId, 'fishing_rod');
        assert.strictEqual(under.location && under.location.kind, 'ground');
    } finally {
        sim.destroy();
    }
});

test('empty loot FCT says nothing; container stays empty', () => {
    const { sim, player } = makeHunt({ corpseLoot: true });
    try {
        const mob = spawnMob(sim, 4, 5, { loot: [] });
        const fcts = captureFct(sim);
        kill(sim, player, mob);
        const corpseUid = peekTop(sim.groundItems, 4, 5, 0);
        assert.ok(corpseUid);
        assert.deepStrictEqual(
            containerItemIds(sim.groundItems.inventory, corpseUid),
            []
        );
        const lootLine = fcts.find((e) => e && String(e.text).indexOf('Loot of') === 0);
        assert.ok(lootLine);
        assert.strictEqual(lootLine.text, 'Loot of Cave Rat: nothing');
    } finally {
        sim.destroy();
    }
});

test('fillCorpse overflow helper keeps corpse on top', () => {
    const { sim } = makeHunt({ corpseLoot: true });
    try {
        const ground = sim.groundItems;
        const corpseUid = spawnGroundItem({
            ground,
            itemId: 'tiny_corpse',
            x: 1,
            y: 1,
            z: 0,
            itemDb: ITEM_DB,
            instFlags: { isCorpse: true, name: 'Dead fixture' }
        });
        const out = fillCorpse({
            ground,
            corpseUid,
            items: [
                { itemId: 'chain_armor', count: 1 },
                { itemId: 'fishing_rod', count: 1 }
            ],
            itemDb: ITEM_DB,
            x: 1,
            y: 1,
            z: 0
        });
        assert.strictEqual(out.placed.length, 1);
        assert.strictEqual(out.overflow.length, 1);
        assert.strictEqual(peekTop(ground, 1, 1, 0), corpseUid);
        assert.deepStrictEqual(containerItemIds(ground.inventory, corpseUid), [
            'chain_armor'
        ]);
        const stack = getStack(ground, 1, 1, 0);
        assert.strictEqual(stack.length, 2);
        assert.strictEqual(
            getItem(ground.inventory, stack[0]).itemId,
            'fishing_rod'
        );
    } finally {
        sim.destroy();
    }
});

// --- D3 adapter (OPEN_CORPSE + stub QUICKLOOT → open) ---

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
        innerHTML: '',
        offsetLeft: 100,
        offsetTop: 140,
        _listeners: {},
        setAttribute(name, value) {
            if (name === 'class') node.className = String(value);
            if (name === 'id') node.id = String(value);
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
        addEventListener() {},
        removeEventListener() {},
        setPointerCapture() {},
        getBoundingClientRect() {
            return {
                left: 0,
                top: 0,
                right: 200,
                bottom: 80,
                width: 200,
                height: 80
            };
        }
    };
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
        }
    };
    return node;
}

function installDom() {
    const body = makeNode('body');
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
        addEventListener() {},
        removeEventListener() {}
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
        restore() {
            if (origDoc === undefined) delete global.document;
            else global.document = origDoc;
            if (origWin === undefined) delete global.window;
            else global.window = origWin;
        }
    };
}

function bindCorpseAdapter(player, sim) {
    player.controlMode = 'manual';
    player.alive = true;
    if (!player.inventory) player.inventory = createEmptyInventory();
    if (typeof sim.getCameraFocusMember !== 'function') {
        sim.getCameraFocusMember = () => player;
    }
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
        getItemDb: () => ITEM_DB,
        getGenre: () => 'rpg_fantasy',
        intervalMs: 10000
    });
    return ctl;
}

function spawnFilledCorpse(sim, x, y) {
    const corpseUid = spawnGroundItem({
        ground: sim.groundItems,
        itemId: 'monster_corpse',
        x,
        y,
        z: 0,
        itemDb: ITEM_DB,
        instFlags: { isCorpse: true, name: 'Dead Cave Rat' }
    });
    fillCorpse({
        ground: sim.groundItems,
        corpseUid,
        items: [{ itemId: 'gold_coin', count: 8 }],
        itemDb: ITEM_DB,
        x,
        y,
        z: 0
    });
    return corpseUid;
}

test('OPEN_CORPSE in range opens ground panel with instance name', () => {
    const dom = installDom();
    const { sim, player } = makeHunt({ corpseLoot: true });
    try {
        player.tile = { x: 4, y: 4, z: 0 };
        const corpseUid = spawnFilledCorpse(sim, 4, 5);
        const ctl = bindCorpseAdapter(player, sim);
        ctl.handleCanvasAdapterIntent(
            {
                type: 'OPEN_CORPSE',
                sourceUid: corpseUid,
                pickableUid: corpseUid,
                ground: true,
                tile: { x: 4, y: 5, z: 0 },
                isCorpse: true
            },
            { player, sim }
        );
        const root = dom.doc.getElementById('inventoryFloatRoot');
        assert.ok(root, 'float root');
        const title = root.querySelector('.inv-panel-title');
        assert.ok(title, 'panel title');
        assert.strictEqual(title.textContent, 'Dead Cave Rat');
        assert.deepStrictEqual(
            containerItemIds(sim.groundItems.inventory, corpseUid),
            ['gold_coin'],
            'open does not vacuum'
        );
        ctl.dispose();
    } finally {
        sim.destroy();
        dom.restore();
    }
});

test('stub QUICKLOOT with corpse uid opens panel and does not vacuum', () => {
    const dom = installDom();
    const { sim, player } = makeHunt({ corpseLoot: true });
    try {
        player.tile = { x: 4, y: 4, z: 0 };
        const corpseUid = spawnFilledCorpse(sim, 4, 5);
        const before = containerItemIds(sim.groundItems.inventory, corpseUid);
        const ctl = bindCorpseAdapter(player, sim);
        ctl.handleCanvasAdapterIntent(
            {
                type: 'QUICKLOOT',
                stub: true,
                pickableUid: corpseUid,
                tile: { x: 4, y: 5, z: 0 },
                isCorpse: true
            },
            { player, sim }
        );
        const root = dom.doc.getElementById('inventoryFloatRoot');
        const title = root && root.querySelector('.inv-panel-title');
        assert.ok(title, 'adapter opened panel');
        assert.strictEqual(title.textContent, 'Dead Cave Rat');
        assert.deepStrictEqual(
            containerItemIds(sim.groundItems.inventory, corpseUid),
            before
        );
        assert.strictEqual(player.commandQueue.length, 0);
        ctl.dispose();
    } finally {
        sim.destroy();
        dom.restore();
    }
});

test('stub QUICKLOOT without uid stays Not available yet', () => {
    const dom = installDom();
    const { sim, player } = makeHunt({ corpseLoot: true });
    try {
        const floats = captureFct(sim);
        const ctl = bindCorpseAdapter(player, sim);
        ctl.handleCanvasAdapterIntent(
            { type: 'QUICKLOOT', stub: true },
            { player, sim }
        );
        assert.ok(
            floats.some((f) => f && f.text === 'Not available yet'),
            'FCT when no corpse uid'
        );
        const root = dom.doc.getElementById('inventoryFloatRoot');
        assert.ok(!root || !root.querySelector('.inv-panel-title'));
        ctl.dispose();
    } finally {
        sim.destroy();
        dom.restore();
    }
});

test('OPEN_CORPSE wrong floor → FCT, no panel', () => {
    const dom = installDom();
    const { sim, player } = makeHunt({ corpseLoot: true });
    try {
        player.tile = { x: 4, y: 4, z: 1 };
        const corpseUid = spawnFilledCorpse(sim, 4, 5);
        const floats = captureFct(sim);
        const ctl = bindCorpseAdapter(player, sim);
        ctl.handleCanvasAdapterIntent(
            {
                type: 'OPEN_CORPSE',
                sourceUid: corpseUid,
                pickableUid: corpseUid,
                ground: true,
                tile: { x: 4, y: 5, z: 0 }
            },
            { player, sim }
        );
        assert.ok(
            floats.some((f) => f && f.text === 'You cannot open that floor.'),
            'wrong-floor FCT'
        );
        const root = dom.doc.getElementById('inventoryFloatRoot');
        assert.ok(!root || !root.querySelector('.inv-ground-container-panel'));
        ctl.dispose();
    } finally {
        sim.destroy();
        dom.restore();
    }
});

test('OPEN_CORPSE out of range queues walk-then-open', () => {
    const dom = installDom();
    const { sim, player } = makeHunt({ corpseLoot: true });
    try {
        player.tile = { x: 2, y: 2, z: 0 };
        player.commandQueue = [];
        const corpseUid = spawnFilledCorpse(sim, 10, 10);
        const ctl = bindCorpseAdapter(player, sim);
        ctl.handleCanvasAdapterIntent(
            {
                type: 'OPEN_CORPSE',
                sourceUid: corpseUid,
                pickableUid: corpseUid,
                ground: true,
                tile: { x: 10, y: 10, z: 0 }
            },
            { player, sim }
        );
        assert.ok(
            player.commandQueue.some(
                (c) => c && c.type === 'START_AUTOWALK' && c.dest
            ),
            'autowalk queued'
        );
        const root = dom.doc.getElementById('inventoryFloatRoot');
        assert.ok(
            !root || !root.querySelector('.inv-ground-container-panel'),
            'panel deferred until adjacent'
        );
        ctl.dispose();
    } finally {
        sim.destroy();
        dom.restore();
    }
});

test('headless default: hunt opts pin false; kill keeps scalar lootValue', () => {
    const prevH = Settings.HEADLESS;
    const prevFeat = Settings.features.corpseLoot;
    Settings.HEADLESS = true;
    Settings.features.corpseLoot = null;
    try {
        assert.strictEqual(resolveCorpseLootFlag({}, { headless: true }), false);
        const opts = huntToSimulatorOpts(
            { seed: 41, floor: 0, parties: [], spawns: [] },
            { headless: true, combatAi: false, injectors: { itemDb: ITEM_DB } }
        );
        assert.strictEqual(opts.corpseLoot, false);
        const { sim, party, player } = makeHunt();
        try {
            const mob = spawnMob(sim, 5, 5);
            const before = party.lootGained;
            const telBefore = sim.telemetry ? sim.telemetry.lootGained || 0 : 0;
            kill(sim, player, mob);
            assert.strictEqual(party.lootGained, before + 7);
            if (sim.telemetry) {
                assert.strictEqual(sim.telemetry.lootGained, telBefore + 7);
            }
            assert.strictEqual(getStack(sim.groundItems, 5, 5, 0).length, 0);
        } finally {
            sim.destroy();
        }
    } finally {
        Settings.HEADLESS = prevH;
        Settings.features.corpseLoot = prevFeat;
    }
});

test('watch huntToSimulatorOpts inherits mode corpseLoot true', () => {
    const prevH = Settings.HEADLESS;
    const prevFeat = Settings.features.corpseLoot;
    Settings.HEADLESS = false;
    Settings.features.corpseLoot = null;
    try {
        const opts = huntToSimulatorOpts(
            { seed: 1, floor: 0, parties: [], spawns: [] },
            { headless: false, combatAi: false }
        );
        assert.strictEqual(opts.corpseLoot, true);
        assert.strictEqual(resolveCorpseLootFlag({}, { headless: false }), true);
    } finally {
        Settings.HEADLESS = prevH;
        Settings.features.corpseLoot = prevFeat;
    }
});

test('flag on + take gold: lootGained += worth per coin', () => {
    const { sim, party, player } = makeHunt({ corpseLoot: true });
    try {
        player.tile = { x: 5, y: 5, z: 0 };
        player.inventory = buildInventoryFromSeed(
            { equipment: { backpack: 'backpack' }, backpack: [] },
            ITEM_DB
        );
        const mob = spawnMob(sim, 5, 5, {
            loot: [{ id: 'gold_coin', chance: 100000, minCount: 20, maxCount: 20 }]
        });
        const before = party.lootGained;
        const telBefore = sim.telemetry ? sim.telemetry.lootGained || 0 : 0;
        kill(sim, player, mob);
        assert.strictEqual(party.lootGained, before, 'roll does not credit');
        const corpseUid = peekTop(sim.groundItems, 5, 5, 0);
        assert.ok(corpseUid);
        const cont = getContainer(sim.groundItems.inventory, corpseUid);
        const goldUid = cont.slots[0];
        assert.ok(goldUid);
        const pick = pickupItemFromGround({
            ground: sim.groundItems,
            uid: goldUid,
            playerInv: player.inventory,
            player,
            itemDb: ITEM_DB,
            party,
            telemetry: sim.telemetry
        });
        assert.ok(pick.ok, pick.error);
        assert.strictEqual(pick.corpseLootWorth, 20);
        assert.strictEqual(party.lootGained, before + 20);
        if (sim.telemetry) {
            assert.strictEqual(sim.telemetry.lootGained, telBefore + 20);
        }
        assert.strictEqual(
            containerItemIds(sim.groundItems.inventory, corpseUid).length,
            0
        );
    } finally {
        sim.destroy();
    }
});

test('flag on + take armor: lootGained += 1 when worth missing', () => {
    const { sim, party, player } = makeHunt({ corpseLoot: true });
    try {
        player.tile = { x: 5, y: 5, z: 0 };
        player.inventory = buildInventoryFromSeed(
            { equipment: { backpack: 'backpack' }, backpack: [] },
            ITEM_DB
        );
        const mob = spawnMob(sim, 5, 5, {
            loot: [{ id: 'chain_armor', chance: 100000 }]
        });
        const before = party.lootGained;
        kill(sim, player, mob);
        assert.strictEqual(party.lootGained, before);
        const corpseUid = peekTop(sim.groundItems, 5, 5, 0);
        const cont = getContainer(sim.groundItems.inventory, corpseUid);
        const armorUid = cont.slots[0];
        const pick = pickupItemFromGround({
            ground: sim.groundItems,
            uid: armorUid,
            playerInv: player.inventory,
            player,
            itemDb: ITEM_DB,
            party
        });
        assert.ok(pick.ok, pick.error);
        assert.strictEqual(party.lootGained, before + 1);
    } finally {
        sim.destroy();
    }
});

console.log(`corpse_loot tests: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
