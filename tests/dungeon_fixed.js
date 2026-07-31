#!/usr/bin/env node
/**
 * Stage 11.5 — Fixed layouts + cutouts.
 * - normalize cutout bbox/polygon; point-in-region
 * - same base friction across seeds; cutout spawns/events vary
 * - hunt expand → floorFriction + layout-filled spawns
 * - headless hunt on fixed profile
 * Quiet on success; VERBOSE=1 for detail.
 */

'use strict';

const assert = require('assert');
const {
    normalizeCutout,
    normalizeFixedProfile,
    normalizeBBox,
    pointInCutout,
    pointInPolygon,
    generateFixedLayout,
    resolveFixedHuntLayout,
    filterPointsOutsideCutouts
} = require('../kernel/core/lib/dungeon/layout/fixed.js');
const {
    resolveHuntLayout
} = require('../kernel/core/lib/dungeon/layout/procedural.js');
const {
    normalizePiecePack
} = require('../kernel/core/lib/dungeon/pieces.js');
const {
    canReach
} = require('../kernel/core/lib/dungeon/validate.js');
const {
    loadPiecePack,
    loadDungeonProfile,
    listDungeonProfileIds,
    expandHuntDefinition,
    loadPopulation,
    loadJson
} = require('../kernel/core/lib/presets.js');
const {
    runHeadlessHunt,
    resolveHuntConfig
} = require('../kernel/providers/simulator/headless_runner.js');
const { setActiveMode } = require('../kernel/core/lib/modes.js');
const { FRICTION_BLOCKED } = require('../kernel/core/entities/tilemap.js');

const VERBOSE = !!process.env.VERBOSE;

function log(...args) {
    if (VERBOSE) console.log(...args);
}

function loadCavePack() {
    setActiveMode('standard');
    return normalizePiecePack(loadPiecePack('cave_v1'));
}

function sampleFixedProfile() {
    return {
        id: 'unit_fixed',
        piecePack: 'cave_v1',
        populationId: 'cave_rats',
        floor: 0,
        placements: [
            { pieceId: 'hub_cross_01', x: 0, y: 0 },
            { pieceId: 'corr_ew_01', x: 7, y: 1 },
            { pieceId: 'hub_cross_01', x: 12, y: 0 }
        ],
        entrance: { x: 0, y: 3 },
        exit: { x: 18, y: 3 },
        waypoints: [
            { x: 0, y: 3 },
            { x: 9, y: 3 },
            { x: 18, y: 3 }
        ],
        cutouts: [
            {
                id: 'camp',
                bbox: { x: 12, y: 0, w: 7, h: 7 },
                events: ['camp_ambush', 'rest_well'],
                maxPacks: [1, 3]
            }
        ]
    };
}

function testNormalizeCutout() {
    const c = normalizeCutout(
        {
            id: 'p',
            bbox: { x: 2, y: 3, w: 4, h: 5 },
            events: ['a', 'b'],
            maxPacks: [1, 2]
        },
        0
    );
    assert.ok(c);
    assert.strictEqual(c.id, 'p');
    assert.deepStrictEqual(c.bbox, { x: 2, y: 3, w: 4, h: 5 });
    assert.deepStrictEqual(c.events, ['a', 'b']);
    assert.deepStrictEqual(c.maxPacks, [1, 2]);
    assert.ok(pointInCutout(2, 3, c));
    assert.ok(pointInCutout(5, 7, c));
    assert.ok(!pointInCutout(6, 3, c));
    assert.ok(!pointInCutout(2, 8, c));

    const poly = normalizeCutout(
        {
            id: 'tri',
            polygon: [
                [0, 0],
                [4, 0],
                [2, 4]
            ]
        },
        1
    );
    assert.ok(poly);
    assert.ok(poly.bbox);
    assert.ok(pointInPolygon(2, 1, poly.polygon));
    assert.ok(!pointInPolygon(0, 3, poly.polygon));

    const box = normalizeBBox([1, 2, 3, 4]);
    assert.deepStrictEqual(box, { x: 1, y: 2, w: 3, h: 4 });

    log('normalize cutout ok');
}

function testNormalizeProfile() {
    const p = normalizeFixedProfile(sampleFixedProfile());
    assert.ok(p);
    assert.strictEqual(p.type, 'fixed');
    assert.strictEqual(p.placements.length, 3);
    assert.strictEqual(p.cutouts.length, 1);
    assert.strictEqual(p.piecePack, 'cave_v1');
    assert.ok(p.entrance && p.exit);

    const empty = normalizeFixedProfile({ id: 'x' });
    assert.strictEqual(empty, null);

    log('normalize profile ok');
}

function frictionEqual(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

function testSeedStableBaseVariesCutouts() {
    setActiveMode('standard');
    const pack = loadCavePack();
    const profile = sampleFixedProfile();

    const a = generateFixedLayout({
        profile,
        pack,
        seed: 42,
        loadPopulation
    });
    const b = generateFixedLayout({
        profile,
        pack,
        seed: 42,
        loadPopulation
    });
    const c = generateFixedLayout({
        profile,
        pack,
        seed: 7,
        loadPopulation
    });

    assert.ok(a.ok, a.error && a.error.message);
    assert.ok(b.ok, b.error && b.error.message);
    assert.ok(c.ok, c.error && c.error.message);

    assert.strictEqual(a.cols, b.cols);
    assert.strictEqual(a.rows, b.rows);
    assert.ok(frictionEqual(a.friction, b.friction), 'same seed friction');
    assert.ok(frictionEqual(a.friction, c.friction), 'cross-seed friction identical');

    // Same seed → same cutout spawns + event
    assert.strictEqual(a.cutouts[0].eventId, b.cutouts[0].eventId);
    assert.strictEqual(a.spawns.length, b.spawns.length);
    for (let i = 0; i < a.spawns.length; i++) {
        assert.strictEqual(a.spawns[i].x, b.spawns[i].x);
        assert.strictEqual(a.spawns[i].y, b.spawns[i].y);
        assert.strictEqual(a.spawns[i].creatureId, b.spawns[i].creatureId);
    }

    // All spawns inside cutout bbox
    const box = a.cutouts[0].bbox;
    for (let i = 0; i < a.spawns.length; i++) {
        const s = a.spawns[i];
        assert.ok(s.x >= box.x && s.x < box.x + box.w, `spawn x ${s.x}`);
        assert.ok(s.y >= box.y && s.y < box.y + box.h, `spawn y ${s.y}`);
        assert.notStrictEqual(
            a.friction[s.y * a.cols + s.x],
            FRICTION_BLOCKED
        );
    }

    // Pathing outside cutouts: entrance→exit walkable and same friction
    const reach = canReach(
        a.friction,
        a.cols,
        a.rows,
        a.entrance,
        a.exit
    );
    assert.ok(reach.ok, 'entrance→exit');

    // Outside-cutout sockets should not receive cutout spawns
    const outside = filterPointsOutsideCutouts(
        a.sockets.spawns,
        [{ bbox: box, polygon: null }]
    );
    for (let i = 0; i < a.spawns.length; i++) {
        const s = a.spawns[i];
        const hit = outside.some((o) => o.x === s.x && o.y === s.y);
        assert.ok(!hit, `spawn should not be outside cutout ${s.x},${s.y}`);
    }

    log('seed-stable base ok', {
        cols: a.cols,
        rows: a.rows,
        spawnsA: a.spawns.length,
        spawnsC: c.spawns.length,
        eventA: a.cutouts[0].eventId,
        eventC: c.cutouts[0].eventId
    });
}

function testInlineFrictionBase() {
    const profile = {
        id: 'inline',
        populationId: 'cave_rats',
        friction: [
            '#####',
            '#...#',
            '#...#',
            '#...#',
            '#####'
        ],
        sockets: {
            spawns: [
                { x: 1, y: 1 },
                { x: 2, y: 2 },
                { x: 3, y: 3 }
            ],
            waypoints: [
                { x: 1, y: 2 },
                { x: 3, y: 2 }
            ]
        },
        entrance: { x: 1, y: 2 },
        exit: { x: 3, y: 2 },
        cutouts: [
            {
                id: 'mid',
                bbox: { x: 2, y: 1, w: 2, h: 3 },
                events: ['x'],
                maxPacks: [1, 1]
            }
        ]
    };
    setActiveMode('standard');
    const gen = generateFixedLayout({
        profile,
        seed: 3,
        loadPopulation
    });
    assert.ok(gen.ok, gen.error && gen.error.message);
    assert.strictEqual(gen.cols, 5);
    assert.strictEqual(gen.rows, 5);
    assert.ok(gen.spawns.length >= 1);
    for (let i = 0; i < gen.spawns.length; i++) {
        assert.ok(gen.spawns[i].x >= 2);
    }
    log('inline friction base ok', { spawns: gen.spawns.length });
}

function testHuntExpandFixed() {
    setActiveMode('standard');
    const ids = listDungeonProfileIds();
    assert.ok(ids.indexOf('outskirts_camp') >= 0);

    const hunt = loadJson('hunts/outskirts_camp_fixed.json');
    const expanded = expandHuntDefinition(hunt, { seed: 42 });
    assert.ok(expanded.floorFriction, 'floorFriction');
    assert.ok(expanded.layoutMeta && expanded.layoutMeta.reason === 'ok');
    assert.strictEqual(expanded.layoutMeta.type, 'fixed');
    assert.ok(expanded.layoutMeta.spawnsFilled === true);
    assert.ok(Array.isArray(expanded.spawns));
    assert.ok(expanded.spawns.length >= 1);
    assert.ok(Array.isArray(expanded.waypoints) && expanded.waypoints.length >= 2);
    assert.strictEqual(expanded.populationSkipped, 'layout_filled');

    const e2 = expandHuntDefinition(hunt, { seed: 42 });
    assert.ok(
        frictionEqual(
            expanded.floorFriction.friction,
            e2.floorFriction.friction
        )
    );
    assert.strictEqual(expanded.spawns.length, e2.spawns.length);

    // Different seed: friction same, cutout meta may differ
    const e3 = expandHuntDefinition(hunt, { seed: 11 });
    assert.ok(
        frictionEqual(
            expanded.floorFriction.friction,
            e3.floorFriction.friction
        )
    );

    const resolved = resolveHuntConfig({
        huntId: 'outskirts_camp_fixed',
        seed: 42
    });
    assert.ok(resolved.floorLayers);
    assert.ok(resolved.waypoints.length >= 2);
    assert.ok(resolved.spawns.length >= 1);

    // Dispatch via resolveHuntLayout
    const dispatched = resolveHuntLayout(
        {
            layout: { type: 'fixed', profileId: 'outskirts_camp' }
        },
        {
            seed: 5,
            loadDungeonProfile,
            loadPiecePack,
            loadPopulation,
            normalizePiecePack
        }
    );
    assert.ok(dispatched.floorFriction);
    assert.strictEqual(dispatched.layoutMeta.type, 'fixed');

    log('hunt expand fixed ok', {
        cols: expanded.floorFriction.cols,
        spawns: expanded.spawns.length,
        cutouts: expanded.layoutMeta.cutoutCount,
        props: (expanded.props || []).length
    });
}

async function testHeadlessFixedHunt() {
    setActiveMode('standard');
    const summary = await runHeadlessHunt({
        huntId: 'outskirts_camp_fixed',
        seed: 42,
        frames: 400
    });
    assert.ok(summary);
    assert.ok(
        summary.endReason === 'route_complete' ||
            summary.endReason === 'timeout' ||
            summary.endReason === 'party_wipe' ||
            summary.endReason === 'kill_cap' ||
            summary.sessionState,
        `unexpected end ${summary.endReason}`
    );
    assert.ok(summary.tickCount > 0 || summary.frames > 0);
    log('headless fixed hunt ok', {
        endReason: summary.endReason,
        ticks: summary.tickCount,
        kills: summary.kills
    });
}

function testProfileFixtureLoad() {
    setActiveMode('standard');
    const raw = loadDungeonProfile('outskirts_camp');
    const p = normalizeFixedProfile(raw);
    assert.ok(p);
    assert.strictEqual(p.id, 'outskirts_camp');
    assert.ok(p.cutouts.length >= 1);
    const pack = loadCavePack();
    const gen = generateFixedLayout({
        profile: raw,
        pack,
        seed: 1,
        loadPopulation
    });
    assert.ok(gen.ok, gen.error && gen.error.message);
    log('profile fixture ok', {
        pieces: gen.meta.pieceCount,
        cutouts: gen.cutouts.length
    });
}

async function main() {
    testNormalizeCutout();
    testNormalizeProfile();
    testSeedStableBaseVariesCutouts();
    testInlineFrictionBase();
    testProfileFixtureLoad();
    testHuntExpandFixed();
    await testHeadlessFixedHunt();
    console.log('dungeon_fixed: ok');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
