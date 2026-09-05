#!/usr/bin/env node
/**
 * Stage 6b Phase 1 — NPC identity, spawn copy, AOI / attack gates.
 */

'use strict';

const assert = require('assert');
const {
    TileMap,
    TILE_FLAG_PZ_PACKAGE
} = require('../kernel/core/entities/tilemap.js');
const { Creature } = require('../kernel/core/entities/creature.js');
const { Player } = require('../kernel/core/entities/player.js');
const { Party } = require('../kernel/core/entities/party.js');
const { Simulator, findSpawnTile } = require('../kernel/providers/simulator/simulator.js');
const {
    isTalkableNpc,
    isAttackableCreature,
    copyNpcFields,
    hasNpcIdentity,
    isHostileNeverTalk
} = require('../kernel/core/lib/npc/flags.js');
const {
    ensureAoiFrame,
    invalidateAoiFrame,
    buildCtx,
    initPlayerAi,
    tickHuntAi
} = require('../kernel/core/lib/ai/hunt_ai.js');
const { isValidTarget } = require('../kernel/core/lib/ai/targeting.js');
const { Engage, changePlayerState } = require('../kernel/core/lib/ai/player_states.js');
const {
    resolveCanvasHit,
    buildCanvasContextMenuEntries
} = require('../kernel/apps/game/mouse_dispatcher.js');

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

function npcTemplate(extra) {
    return Object.assign(
        {
            id: 'town_guide',
            label: 'Guide',
            isNpc: true,
            kind: 'npc',
            hp: 80,
            hpMax: 80,
            dialog: {
                greeting: 'Welcome, hunter.',
                start: 'start',
                nodes: {
                    start: {
                        text: 'Welcome, hunter.',
                        replies: [{ label: 'Bye', action: 'close' }]
                    }
                }
            }
        },
        extra || {}
    );
}

function monsterTemplate(extra) {
    return Object.assign(
        {
            id: 'cave_rat',
            label: 'Cave Rat',
            hp: 20,
            hpMax: 20,
            attacks: [{ id: 'melee_0', kind: 'melee', min: 1, max: 4 }]
        },
        extra || {}
    );
}

test('flag matrix: 6a plus flags.isNpc / flags.talkable', () => {
    assert.strictEqual(isTalkableNpc(null), false);
    assert.strictEqual(isTalkableNpc({ id: 1 }), false);
    assert.strictEqual(isTalkableNpc({ isNpc: true }), true);
    assert.strictEqual(isTalkableNpc({ npc: true }), true);
    assert.strictEqual(isTalkableNpc({ talkable: true }), true);
    assert.strictEqual(isTalkableNpc({ kind: 'npc' }), true);
    assert.strictEqual(isTalkableNpc({ kind: 'NPC' }), true);
    assert.strictEqual(isTalkableNpc({ faction: 'npc' }), true);
    assert.strictEqual(isTalkableNpc({ flags: { isNpc: true } }), true);
    assert.strictEqual(isTalkableNpc({ flags: { talkable: true } }), true);
    assert.strictEqual(isTalkableNpc({ flags: { npc: true } }), true);
    assert.strictEqual(hasNpcIdentity({ isNpc: true, attackableNpc: true }), true);
});

test('Q6.2 hostile never-talk', () => {
    assert.strictEqual(isTalkableNpc({ isNpc: true, attackableNpc: true }), false);
    assert.strictEqual(
        isTalkableNpc({ isNpc: true, flags: { hostile: true } }),
        false
    );
    assert.strictEqual(
        isTalkableNpc({ kind: 'npc', flags: { attackableNpc: true } }),
        false
    );
    assert.strictEqual(isHostileNeverTalk({ attackableNpc: true }), true);
    assert.strictEqual(isHostileNeverTalk({ flags: { hostile: true } }), true);
    assert.ok(isAttackableCreature({ isNpc: true, attackableNpc: true }));
    assert.ok(!isAttackableCreature({ isNpc: true }));
    assert.ok(isAttackableCreature({ id: 9, alive: true }));
    const observer = { tile: { x: 0, y: 0, z: 0 } };
    assert.ok(
        !isValidTarget(observer, {
            isNpc: true,
            alive: true,
            hp: { current: 80 },
            tile: { x: 1, y: 0, z: 0 }
        }),
        'isValidTarget rejects talkable NPC'
    );
    assert.ok(
        isValidTarget(observer, {
            id: 9,
            alive: true,
            hp: { current: 10 },
            tile: { x: 1, y: 0, z: 0 }
        }),
        'isValidTarget keeps monsters'
    );
    assert.ok(
        isValidTarget(observer, {
            isNpc: true,
            attackableNpc: true,
            alive: true,
            hp: { current: 10 },
            tile: { x: 1, y: 0, z: 0 }
        }),
        'isValidTarget keeps attackableNpc'
    );
});

test('copyNpcFields + applyTemplate keep NPC identity after spawn', () => {
    const dest = {};
    copyNpcFields(
        dest,
        npcTemplate({
            dialogId: 'town_guide',
            faction: 'npc',
            shop: { currency: 'gold_coin', items: [{ item: 'bread', buy: 4 }] },
            walkInterval: 2000,
            walkRadius: 2,
            voices: [{ text: 'Need directions?', yell: false }],
            voiceInterval: 15000,
            voiceChance: 25
        })
    );
    assert.strictEqual(dest.isNpc, true);
    assert.strictEqual(dest.kind, 'npc');
    assert.strictEqual(dest.faction, 'npc');
    assert.strictEqual(dest.dialogId, 'town_guide');
    assert.strictEqual(dest.dialog.greeting, 'Welcome, hunter.');
    assert.ok(dest.shop && dest.shop.items && dest.shop.items[0].item === 'bread');
    assert.strictEqual(dest.walkInterval, 2000);
    assert.strictEqual(dest.walkRadius, 2);
    assert.strictEqual(dest.voiceInterval, 15000);
    assert.strictEqual(dest.voiceChance, 25);
    assert.deepStrictEqual(dest.voices, [{ text: 'Need directions?', yell: false }]);

    dest.dialog.greeting = 'mutated';
    const src = npcTemplate();
    assert.strictEqual(src.dialog.greeting, 'Welcome, hunter.', 'clone, not alias');

    const c = new Creature({ id: 2, name: 'Creature' });
    c.applyTemplate(
        npcTemplate({
            dialogId: 'town_guide',
            walkInterval: 2000,
            walkRadius: 2,
            voiceVector: [{ text: 'Hello', yellText: true }],
            yellSpeedTicks: 8000,
            yellChance: 10
        })
    );
    assert.strictEqual(c.isNpc, true);
    assert.strictEqual(c.kind, 'npc');
    assert.strictEqual(c.dialogId, 'town_guide');
    assert.ok(c.dialog && c.dialog.nodes && c.dialog.nodes.start);
    assert.strictEqual(c.name, 'Guide');
    assert.ok(isTalkableNpc(c));
    assert.ok(!isAttackableCreature(c));
    assert.strictEqual(c.walkInterval, 2000);
    assert.strictEqual(c.walkRadius, 2);
    assert.strictEqual(c.voiceInterval, 8000);
    assert.strictEqual(c.voiceChance, 10);
    assert.deepStrictEqual(c.voices, [{ text: 'Hello', yell: true }]);

    const flagged = new Creature({ id: 3 });
    flagged.applyTemplate({
        id: 'flag_guide',
        flags: { isNpc: true },
        hp: 10
    });
    assert.ok(flagged.flags && flagged.flags.isNpc === true);
    assert.ok(isTalkableNpc(flagged));
});

test('monster applyTemplate stays attackable (no NPC fields)', () => {
    const c = new Creature({ id: 4, name: 'Creature' });
    c.applyTemplate(monsterTemplate());
    assert.strictEqual(c.isNpc, undefined);
    assert.strictEqual(c.kind, undefined);
    assert.strictEqual(c.dialog, undefined);
    assert.ok(!isTalkableNpc(c));
    assert.ok(isAttackableCreature(c));
    assert.strictEqual(c.aggro, true);
});

test('spawnFromTable: talkable defaults aggro false; monster stays true', () => {
    const map = openFloor(16, 16, 100);
    const sim = new Simulator({ seed: 31, combatAi: false });
    sim.setTileMap(map);
    sim.floor = 0;
    try {
        const guide = sim.spawnFromTable({
            creatureId: 'town_guide',
            x: 3,
            y: 3,
            z: 0,
            template: npcTemplate()
        });
        assert.ok(guide, 'NPC spawn');
        assert.strictEqual(guide.isNpc, true);
        assert.strictEqual(guide.kind, 'npc');
        assert.ok(guide.dialog && guide.dialog.nodes);
        assert.strictEqual(guide.aggro, false);
        assert.ok(isTalkableNpc(guide));
        assert.ok(!isAttackableCreature(guide));

        const forced = sim.spawnFromTable({
            creatureId: 'town_guide',
            x: 4,
            y: 3,
            z: 0,
            template: npcTemplate({ aggro: true })
        });
        assert.ok(forced);
        assert.strictEqual(forced.aggro, true, 'explicit aggro honored');

        const rat = sim.spawnFromTable({
            creatureId: 'cave_rat',
            x: 5,
            y: 3,
            z: 0,
            template: monsterTemplate()
        });
        assert.ok(rat, 'monster spawn');
        assert.strictEqual(rat.aggro, true);
        assert.ok(!isTalkableNpc(rat));
        assert.ok(isAttackableCreature(rat));
    } finally {
        sim.destroy();
    }
});

test('findSpawnTile: player + talkable NPC stay on PZ; monster displaces', () => {
    const map = openFloor(16, 16, 100);
    map.setTileFlags(3, 3, 0, TILE_FLAG_PZ_PACKAGE);
    const npcTile = findSpawnTile(map, 3, 3, 0, 0, { template: npcTemplate() });
    assert.deepStrictEqual(npcTile, { x: 3, y: 3 }, 'NPC spawn stays on PZ pin');
    const playerTile = findSpawnTile(map, 3, 3, 0, 0, { type: 'player' });
    assert.deepStrictEqual(playerTile, { x: 3, y: 3 }, 'player spawn stays on PZ');
    const ratTile = findSpawnTile(map, 3, 3, 0, 0, { template: monsterTemplate() });
    assert.ok(ratTile, 'monster finds a nearby tile');
    assert.ok(
        !(ratTile.x === 3 && ratTile.y === 3),
        'monster displaced off PZ'
    );
    const bare = findSpawnTile(map, 3, 3, 0, 0);
    assert.ok(bare, 'bare probe finds a nearby tile');
    assert.ok(!(bare.x === 3 && bare.y === 3), 'bare probe displaced off PZ');

    const sim = new Simulator({ seed: 31, combatAi: false });
    sim.setTileMap(map);
    sim.floor = 0;
    try {
        const guide = sim.spawnFromTable({
            creatureId: 'town_guide',
            x: 3,
            y: 3,
            z: 0,
            template: npcTemplate()
        });
        assert.ok(guide);
        assert.strictEqual(guide.tile.x, 3);
        assert.strictEqual(guide.tile.y, 3);
        const rat = sim.spawnFromTable({
            creatureId: 'cave_rat',
            x: 3,
            y: 3,
            z: 0,
            template: monsterTemplate()
        });
        assert.ok(rat);
        assert.ok(
            !(rat.tile.x === 3 && rat.tile.y === 3),
            'spawnFromTable monster not on occupied/PZ pin'
        );
    } finally {
        sim.destroy();
    }
});

test('AOI enemies skip talkable NPC; monster still listed', () => {
    const map = openFloor(24, 24, 100);
    const sim = new Simulator({ seed: 32, combatAi: false });
    sim.setTileMap(map);
    sim.floor = 0;
    try {
        const party = new Party({
            name: 'Flags',
            waypoints: [{ x: 5, y: 5, z: 0 }]
        });
        const player = new Player({
            id: sim.allocEntityId(),
            name: 'Lead',
            classId: 'guardian',
            isLeader: true,
            strategyId: 'pacifist',
            level: 20,
            tile: { x: 5, y: 5, z: 0 }
        });
        map.tryOccupy(5, 5, 0, player);
        party.addMember(player);
        initPlayerAi(player, { strategyId: 'pacifist' });
        sim.parties.push(party);
        sim.insertChild(party);
        sim.entityById.set(player.id, player);

        const guide = sim.spawnFromTable({
            creatureId: 'town_guide',
            x: 6,
            y: 5,
            z: 0,
            template: npcTemplate()
        });
        const rat = sim.spawnFromTable({
            creatureId: 'cave_rat',
            x: 7,
            y: 5,
            z: 0,
            template: monsterTemplate()
        });
        assert.ok(guide && rat);

        invalidateAoiFrame(sim);
        const frame = ensureAoiFrame(sim, [player], 10, null);
        const enemyIds = frame.enemies.map((c) => c.id);
        assert.ok(!enemyIds.includes(guide.id), 'talkable NPC not in enemies');
        assert.ok(enemyIds.includes(rat.id), 'monster still in enemies');

        const ctx = buildCtx(sim, null, null);
        assert.ok(!ctx.enemies.some((c) => c.id === guide.id));
        assert.ok(ctx.enemies.some((c) => c.id === rat.id));
    } finally {
        sim.destroy();
    }
});

test('player hunt AI does not target or attack talkable NPC', () => {
    const map = openFloor(24, 24, 100);
    const sim = new Simulator({ seed: 33, combatAi: true });
    sim.setTileMap(map);
    sim.floor = 0;
    try {
        const party = new Party({
            name: 'Aggro',
            waypoints: [
                { x: 5, y: 5, z: 0 },
                { x: 12, y: 5, z: 0 }
            ]
        });
        const player = new Player({
            id: sim.allocEntityId(),
            name: 'Lead',
            classId: 'guardian',
            isLeader: true,
            strategyId: 'guardian_aggro',
            level: 20,
            tile: { x: 5, y: 5, z: 0 }
        });
        map.tryOccupy(5, 5, 0, player);
        party.addMember(player);
        initPlayerAi(player, { strategyId: 'guardian_aggro' });
        // Stock guardian_aggro is 0.95 and tickHuntAi rolls Math.random —
        // a miss leaves _engageDecision false until Time advances.
        player.strategy.aggression = 1;
        sim.parties.push(party);
        sim.insertChild(party);
        sim.entityById.set(player.id, player);

        const guide = sim.spawnFromTable({
            creatureId: 'town_guide',
            x: 6,
            y: 5,
            z: 0,
            template: npcTemplate()
        });
        assert.ok(guide);
        const hp0 = guide.hp.current;

        const tickReady = () => {
            player.moveDelay = 0;
            invalidateAoiFrame(sim);
            tickHuntAi(sim);
        };

        tickReady();
        assert.ok(
            player.target !== guide && player.targetId !== guide.id,
            'AI must not sticky-target the NPC'
        );
        assert.ok(!player.inBattle, 'NPC must not start a fight');
        assert.strictEqual(guide.hp.current, hp0, 'NPC HP unchanged');
        assert.ok(
            player.aiState !== 'engage',
            'must not enter engage on NPC only'
        );

        changePlayerState(player, Engage);
        player.target = guide;
        player.targetId = guide.id;
        player.inBattle = true;
        tickReady();
        assert.ok(
            player.target !== guide && player.targetId !== guide.id,
            'stale NPC sticky must clear'
        );
        assert.ok(player.aiState !== 'engage', 'must leave engage when only NPC');
        assert.strictEqual(guide.hp.current, hp0, 'NPC HP still unchanged');

        const rat = sim.spawnFromTable({
            creatureId: 'cave_rat',
            x: 7,
            y: 5,
            z: 0,
            template: monsterTemplate()
        });
        tickReady();
        assert.ok(rat, 'rat spawned');
        assert.ok(player.target, 'AI should acquire the monster');
        assert.strictEqual(player.target.id, rat.id, 'AI still targets monster');
        assert.ok(player.target.id !== guide.id);
    } finally {
        sim.destroy();
    }
});

test('canvas menu: Attack hidden on talkable NPC, present on monster', () => {
    const npc = {
        id: 'npc_menu',
        isNpc: true,
        alive: true,
        tile: { x: 6, y: 5, z: 0 }
    };
    const monster = {
        id: 'mob_menu',
        alive: true,
        tile: { x: 7, y: 5, z: 0 }
    };
    const player = {
        id: 1,
        tile: { x: 5, y: 5, z: 0 },
        commandQueue: []
    };
    const npcHit = resolveCanvasHit({
        sim: { creatures: [npc], groundItems: null },
        player,
        tile: { x: 6, y: 5, z: 0 },
        itemDb: {}
    });
    const npcEntries = buildCanvasContextMenuEntries(npcHit);
    assert.ok(npcEntries.some((e) => e.id === 'talk'));
    assert.ok(!npcEntries.some((e) => e.id === 'attack'));

    const mobHit = resolveCanvasHit({
        sim: { creatures: [monster], groundItems: null },
        player,
        tile: { x: 7, y: 5, z: 0 },
        itemDb: {}
    });
    const mobEntries = buildCanvasContextMenuEntries(mobHit);
    assert.ok(mobEntries.some((e) => e.id === 'attack'));
    assert.ok(!mobEntries.some((e) => e.id === 'talk'));
});

if (failed) {
    console.error(`${failed} failed, ${passed} passed`);
    process.exit(1);
}
console.log(`${passed} passed`);
