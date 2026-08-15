#!/usr/bin/env node
/**
 * Phase C.4 — NPC wander + idle voices.
 */

'use strict';

const assert = require('assert');
const presets = require('../kernel/core/lib/presets.js');
const { TileMap } = require('../kernel/core/entities/tilemap.js');
const { Creature } = require('../kernel/core/entities/creature.js');
const { Player } = require('../kernel/core/entities/player.js');
const { Party } = require('../kernel/core/entities/party.js');
const { Simulator } = require('../kernel/providers/simulator/simulator.js');
const { Time } = require('../kernel/core/lib/time.js');
const { isTalkableNpc } = require('../kernel/core/lib/npc/flags.js');
const {
    SPECTATOR_RANGE,
    normalizeVoices,
    copyNpcWanderFields,
    hasNpcIdle,
    inWalkZone,
    npcIsInConversation,
    hasNearbySpectator,
    canNpcWalkTo,
    tickNpcWander,
    tickNpcVoices,
    tickNpcIdle
} = require('../kernel/core/lib/npc/wander.js');
const {
    tickHuntAi,
    initPlayerAi,
    invalidateAoiFrame
} = require('../kernel/core/lib/ai/hunt_ai.js');

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

function makeNpc(opts) {
    const o = opts || {};
    const tile = o.tile || { x: 5, y: 5, z: 0 };
    const npc = new Creature({
        id: o.id != null ? o.id : 21,
        name: o.name || 'Guide',
        tile,
        homeTile: o.homeTile || tile,
        hp: 80,
        hpMax: 80,
        speed: o.speed != null ? o.speed : 80,
        aggro: o.aggro !== undefined ? !!o.aggro : false
    });
    npc.isNpc = true;
    npc.kind = 'npc';
    npc.walkInterval = o.walkInterval != null ? o.walkInterval : 2000;
    npc.walkRadius = o.walkRadius != null ? o.walkRadius : 2;
    npc.voices = o.voices != null ? o.voices : [];
    npc.voiceInterval = o.voiceInterval != null ? o.voiceInterval : 0;
    npc.voiceChance = o.voiceChance != null ? o.voiceChance : 0;
    npc.alive = o.alive !== undefined ? !!o.alive : true;
    return npc;
}

function occupy(map, entity) {
    map.tryOccupy(entity.tile.x, entity.tile.y, entity.tile.z, entity);
}

test('normalizeVoices + copy aliases', () => {
    assert.deepStrictEqual(normalizeVoices(['Hi', '  ', { text: 'Yo', yellText: true }]), [
        { text: 'Hi', yell: false },
        { text: 'Yo', yell: true }
    ]);
    const dest = {};
    copyNpcWanderFields(dest, {
        walkInterval: 2000,
        walkRadius: 3,
        voiceVector: [{ text: 'A', yellText: true }],
        yellSpeedTicks: 9000,
        yellChance: 40
    });
    assert.strictEqual(dest.walkInterval, 2000);
    assert.strictEqual(dest.walkRadius, 3);
    assert.strictEqual(dest.voiceInterval, 9000);
    assert.strictEqual(dest.voiceChance, 40);
    assert.deepStrictEqual(dest.voices, [{ text: 'A', yell: true }]);
    assert.strictEqual(hasNpcIdle(dest), true);
    assert.strictEqual(hasNpcIdle({}), false);
    assert.strictEqual(SPECTATOR_RANGE, 8);
});

test('inWalkZone is Chebyshev box on same floor', () => {
    const home = { x: 5, y: 5, z: 0 };
    assert.strictEqual(inWalkZone(home, { x: 6, y: 6, z: 0 }, 1), true);
    assert.strictEqual(inWalkZone(home, { x: 7, y: 5, z: 0 }, 1), false);
    assert.strictEqual(inWalkZone(home, { x: 5, y: 5, z: 1 }, 2), false);
    assert.strictEqual(inWalkZone(home, { x: 5, y: 5, z: 0 }, 0), false);
});

test('no wander when interval / speed / radius is 0', () => {
    const map = openFloor(16, 16);
    const player = { id: 1, alive: true, tile: { x: 5, y: 6, z: 0 } };
    const ctx = { tileMap: map, players: [player], rng: () => 0 };
    const still = makeNpc({ walkInterval: 0 });
    occupy(map, still);
    assert.strictEqual(tickNpcWander(still, ctx, 5000).walked, false);

    const slow = makeNpc({ speed: 0 });
    occupy(map, slow);
    assert.strictEqual(tickNpcWander(slow, ctx, 5000).walked, false);

    const pinned = makeNpc({ walkRadius: 0 });
    occupy(map, pinned);
    assert.strictEqual(tickNpcWander(pinned, ctx, 5000).walked, false);
    assert.strictEqual(canNpcWalkTo(pinned, { x: 1, y: 0 }, map), false);
});

test('after interval, steps a cardinal tile inside radius', () => {
    const map = openFloor(16, 16);
    const npc = makeNpc({ tile: { x: 5, y: 5, z: 0 }, walkRadius: 1 });
    occupy(map, npc);
    const player = { id: 1, alive: true, tile: { x: 5, y: 6, z: 0 } };
    const ctx = { tileMap: map, players: [player], rng: () => 0 };
    const wait = tickNpcWander(npc, ctx, 1999);
    assert.strictEqual(wait.walked, false);
    assert.strictEqual(npc.tile.x, 5);
    assert.strictEqual(npc.tile.y, 5);
    const step = tickNpcWander(npc, ctx, 1);
    assert.strictEqual(step.walked, true);
    const d = Math.max(Math.abs(npc.tile.x - 5), Math.abs(npc.tile.y - 5));
    assert.strictEqual(d, 1);
    assert.ok(
        (npc.tile.x === 5) !== (npc.tile.y === 5),
        'cardinal, not diagonal'
    );
});

test('never leaves walkRadius of homeTile', () => {
    const map = openFloor(16, 16);
    const home = { x: 5, y: 5, z: 0 };
    const npc = makeNpc({ tile: { x: 6, y: 5, z: 0 }, homeTile: home, walkRadius: 1 });
    occupy(map, npc);
    const player = { id: 1, alive: true, tile: { x: 5, y: 5, z: 0 } };
    let n = 0;
    const ctx = {
        tileMap: map,
        players: [player],
        rng: () => {
            n += 1;
            return (n % 7) / 7;
        }
    };
    for (let i = 0; i < 20; i++) {
        npc.moveDelay = 0;
        tickNpcWander(npc, ctx, 2000);
        assert.ok(
            inWalkZone(home, npc.tile, 1),
            'stayed in radius at ' + npc.tile.x + ',' + npc.tile.y
        );
        assert.strictEqual(npc.tile.z, 0);
    }
});

test('talk session freezes wander', () => {
    const map = openFloor(16, 16);
    const npc = makeNpc();
    occupy(map, npc);
    const player = {
        id: 1,
        alive: true,
        tile: { x: 5, y: 6, z: 0 },
        _npcTalk: { npcId: npc.id, nodeId: 'start' }
    };
    assert.strictEqual(npcIsInConversation(npc, [player]), true);
    const ctx = { tileMap: map, players: [player], rng: () => 0 };
    const out = tickNpcWander(npc, ctx, 5000);
    assert.strictEqual(out.walked, false);
    assert.strictEqual(out.frozen, true);
    assert.strictEqual(npc.tile.x, 5);
    assert.strictEqual(npc.tile.y, 5);
    assert.strictEqual(npc._npcWalkTicks, 0);
});

test('no wander / voice without a nearby spectator', () => {
    const map = openFloor(16, 16);
    const npc = makeNpc({
        voices: [{ text: 'Hey', yell: false }],
        voiceInterval: 1000,
        voiceChance: 100
    });
    occupy(map, npc);
    assert.strictEqual(hasNearbySpectator(npc, [], 8), false);
    const far = { id: 1, alive: true, tile: { x: 15, y: 15, z: 0 } };
    assert.strictEqual(hasNearbySpectator(npc, [far], 8), false);
    const otherFloor = { id: 2, alive: true, tile: { x: 5, y: 6, z: 1 } };
    assert.strictEqual(hasNearbySpectator(npc, [otherFloor], 8), false);
    const ctx = { tileMap: map, players: [far], rng: () => 0, aiTickRadius: 8 };
    assert.strictEqual(tickNpcWander(npc, ctx, 5000).walked, false);
    assert.strictEqual(tickNpcVoices(npc, ctx, 5000).spoke, false);
    assert.strictEqual(npc.tile.x, 5);
    assert.strictEqual(npc.tile.y, 5);
});

test('voices fire on interval + chance; skip chance 0', () => {
    const map = openFloor(16, 16);
    const npc = makeNpc({
        voices: [
            { text: 'Need directions?', yell: false },
            { text: 'North!', yell: true }
        ],
        voiceInterval: 1000,
        voiceChance: 100
    });
    occupy(map, npc);
    const spoken = [];
    const ctx = {
        tileMap: map,
        players: [{ id: 1, alive: true, tile: { x: 5, y: 6, z: 0 } }],
        rng: () => 0,
        sim: {
            emitCombatText(payload) {
                spoken.push(payload);
            }
        }
    };
    assert.strictEqual(tickNpcVoices(npc, ctx, 999).spoke, false);
    const fired = tickNpcVoices(npc, ctx, 1);
    assert.strictEqual(fired.spoke, true);
    assert.strictEqual(fired.text, 'Need directions?');
    assert.strictEqual(fired.yell, false);
    assert.strictEqual(spoken.length, 1);
    assert.strictEqual(spoken[0].text, 'Need directions?');
    assert.strictEqual(spoken[0].x, 5);
    assert.strictEqual(spoken[0].y, 5);

    npc.voiceChance = 0;
    npc._npcVoiceTicks = 0;
    assert.strictEqual(tickNpcVoices(npc, ctx, 2000).spoke, false);
});

test('town_guide template ships wander + voices', () => {
    const tpl = presets.loadCreatureTemplate('town_guide');
    assert.ok(tpl.walkInterval > 0);
    assert.ok(tpl.walkRadius > 0);
    assert.ok(tpl.speed > 0);
    assert.ok(Array.isArray(tpl.voices) && tpl.voices.length >= 1);
    assert.ok(tpl.voiceInterval > 0);
    const c = new Creature({ id: 9, name: 'Creature' });
    c.applyTemplate(tpl);
    assert.ok(isTalkableNpc(c));
    assert.strictEqual(c.walkInterval, tpl.walkInterval);
    assert.strictEqual(c.walkRadius, tpl.walkRadius);
    assert.ok(c.voices && c.voices.length);
    assert.ok(hasNpcIdle(c));
});

test('hunt_ai tick walks a talkable NPC when a spectator is near', () => {
    const map = openFloor(16, 16);
    const sim = new Simulator({ seed: 44, combatAi: false });
    sim.setTileMap(map);
    sim.floor = 0;
    const prevDt = Time.deltaTime;
    try {
        const party = new Party({
            name: 'Wander',
            waypoints: [{ x: 5, y: 6, z: 0 }]
        });
        const player = new Player({
            id: sim.allocEntityId(),
            name: 'Lead',
            classId: 'guardian',
            isLeader: true,
            strategyId: 'pacifist',
            level: 20,
            tile: { x: 5, y: 6, z: 0 }
        });
        occupy(map, player);
        party.addMember(player);
        initPlayerAi(player, { strategyId: 'pacifist' });
        sim.parties.push(party);
        sim.insertChild(party);
        sim.entityById.set(player.id, player);

        const tpl = presets.loadCreatureTemplate('town_guide');
        const guide = sim.spawnFromTable({
            creatureId: 'town_guide',
            x: 5,
            y: 5,
            z: 0,
            template: tpl
        });
        assert.ok(guide);
        assert.ok(isTalkableNpc(guide));
        assert.ok(guide.walkInterval > 0);
        const home = { x: guide.tile.x, y: guide.tile.y, z: guide.tile.z };
        Time.deltaTime = 2;
        invalidateAoiFrame(sim);
        tickHuntAi(sim);
        const moved =
            guide.tile.x !== home.x ||
            guide.tile.y !== home.y;
        assert.strictEqual(moved, true, 'guide stepped');
        assert.ok(inWalkZone(home, guide.tile, guide.walkRadius));
    } finally {
        Time.deltaTime = prevDt;
        sim.destroy();
    }
});

test('tickNpcIdle returns walk + voice bags', () => {
    const map = openFloor(16, 16);
    const npc = makeNpc({
        voices: [{ text: 'Hi', yell: false }],
        voiceInterval: 10,
        voiceChance: 100
    });
    occupy(map, npc);
    const out = tickNpcIdle(
        npc,
        {
            tileMap: map,
            players: [{ id: 1, alive: true, tile: { x: 5, y: 6, z: 0 } }],
            rng: () => 0
        },
        2000
    );
    assert.ok(out.walk && out.voice);
    assert.strictEqual(out.walk.walked, true);
    assert.strictEqual(out.voice.spoke, true);
    assert.strictEqual(out.voice.text, 'Hi');
});

if (failed) {
    console.error(failed + ' failed, ' + passed + ' passed');
    process.exit(1);
}
console.log(passed + ' passed');
