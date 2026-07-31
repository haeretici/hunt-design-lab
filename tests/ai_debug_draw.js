/**
 * Stage 12B — AI debug flags, HEADLESS skip, draw no-ops, bridge patch merge.
 * Quiet by default; VERBOSE=1 for detail.
 */

'use strict';

const assert = require('assert');
const { Settings } = require('../kernel/settings.js');
const {
    ensureDebugAI,
    isAiDebugActive,
    drawAiDebugOverlays,
    mergeDebugAI,
    applyDebugAIPatch,
    snapshotDebugAI,
    DEBUG_AI_DEFAULTS,
    DEBUG_AI_FLAG_KEYS,
    tileToScreen,
    classifyTileType
} = require('../kernel/core/lib/ai_debug_draw.js');
const {
    mergeTweaksPatch,
    ENGINE_TWEAKS_CHANNEL,
    ENGINE_TWEAKS_WINDOW_NAME
} = require('../html/widgets/engine_tweakings/parent_bridge.js');
const {
    ENGINE_TWEAKS_CHANNEL: PROTO_CHANNEL
} = require('../html/widgets/engine_tweakings/protocol.js');

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

function makeMockG() {
    const calls = [];
    const g = {
        calls,
        save() {
            calls.push('save');
        },
        restore() {
            calls.push('restore');
        },
        beginPath() {
            calls.push('beginPath');
        },
        arc() {
            calls.push('arc');
        },
        fill() {
            calls.push('fill');
        },
        stroke() {
            calls.push('stroke');
        },
        moveTo() {},
        lineTo() {},
        closePath() {},
        fillText() {
            calls.push('fillText');
        },
        strokeText() {},
        rect() {},
        fillRect() {},
        strokeRect() {
            calls.push('strokeRect');
        },
        setLineDash() {},
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 1,
        font: '',
        globalAlpha: 1
    };
    return g;
}

function makeSim() {
    return {
        tileMap: {
            _viewOriginX: 0,
            _viewOriginY: 0,
            _viewCols: 40,
            _viewRows: 30
        },
        parties: [
            {
                members: [
                    {
                        type: 'player',
                        alive: true,
                        isLeader: true,
                        aiState: 'engage',
                        tile: { x: 5, y: 5, z: 0 },
                        path: [
                            { x: 6, y: 5 },
                            { x: 7, y: 5 }
                        ],
                        target: {
                            tile: { x: 10, y: 5, z: 0 }
                        },
                        strategy: { engageRange: 7 }
                    }
                ]
            }
        ],
        creatures: [
            {
                type: 'creature',
                alive: true,
                aiState: 'aggro',
                tile: { x: 10, y: 5, z: 0 },
                path: [{ x: 9, y: 5 }],
                target: {
                    tile: { x: 5, y: 5, z: 0 }
                },
                homeTile: { x: 12, y: 5, z: 0 }
            }
        ],
        _spawnConfigs: [{ x: 12, y: 5, creatureId: 'cave_rat' }]
    };
}

// Reset defaults between cases
function resetDebug() {
    Settings.debugAI = Object.assign({}, DEBUG_AI_DEFAULTS);
    Settings.HEADLESS = false;
    Settings.tileWidth = 16;
    Settings.tileHeight = 16;
}

test('defaults inactive', () => {
    resetDebug();
    assert.strictEqual(isAiDebugActive(), false);
});

test('enabled + layer active', () => {
    resetDebug();
    Settings.debugAI.enabled = true;
    Settings.debugAI.states = true;
    assert.strictEqual(isAiDebugActive(), true);
});

test('HEADLESS suppresses debug', () => {
    resetDebug();
    Settings.debugAI.enabled = true;
    Settings.debugAI.states = true;
    Settings.HEADLESS = true;
    assert.strictEqual(isAiDebugActive(), false);
});

test('master alone not enough', () => {
    resetDebug();
    Settings.debugAI.enabled = true;
    assert.strictEqual(isAiDebugActive(), false);
});

test('each hunt layer flag activates', () => {
    resetDebug();
    Settings.debugAI.enabled = true;
    for (const flag of [
        'states',
        'paths',
        'targets',
        'ranges',
        'spawns',
        'hitSources',
        'tileTypes'
    ]) {
        Settings.debugAI[flag] = true;
        assert.strictEqual(isAiDebugActive(), true, flag);
        Settings.debugAI[flag] = false;
        assert.strictEqual(isAiDebugActive(), false, flag + ' off');
    }
});

test('ensureDebugAI fills missing keys', () => {
    Settings.debugAI = { enabled: true };
    const d = ensureDebugAI();
    for (const k of DEBUG_AI_FLAG_KEYS) {
        assert.ok(k in d, k);
    }
    assert.strictEqual(d.states, false);
});

test('mergeDebugAI + applyDebugAIPatch', () => {
    resetDebug();
    const merged = mergeDebugAI(null, { enabled: true, paths: true });
    assert.strictEqual(merged.enabled, true);
    assert.strictEqual(merged.paths, true);
    assert.strictEqual(merged.states, false);

    applyDebugAIPatch({ enabled: true, targets: true });
    assert.strictEqual(Settings.debugAI.targets, true);
    const snap = snapshotDebugAI();
    assert.strictEqual(snap.targets, true);
    assert.notStrictEqual(snap, Settings.debugAI);
});

test('tileToScreen uses camera + tile size', () => {
    Settings.tileWidth = 16;
    Settings.tileHeight = 16;
    const vp = { ox: 2, oy: 4, tw: 16, th: 16 };
    const s = tileToScreen(2, 4, vp);
    assert.strictEqual(s.x, 8);
    assert.strictEqual(s.y, 8);
});

test('drawAiDebugOverlays issues canvas commands', () => {
    resetDebug();
    Settings.debugAI = {
        enabled: true,
        states: true,
        paths: true,
        targets: true,
        ranges: true,
        spawns: true,
        hitSources: false
    };
    const g = makeMockG();
    drawAiDebugOverlays(g, makeSim());
    assert.ok(g.calls.includes('save'));
    assert.ok(g.calls.includes('restore'));
    assert.ok(g.calls.length > 4, `drew something (${g.calls.length} ops)`);
});

test('hitSources draws combat FX origins', () => {
    resetDebug();
    Settings.debugAI = {
        enabled: true,
        states: false,
        paths: false,
        targets: false,
        ranges: false,
        spawns: false,
        hitSources: true
    };
    const sim = makeSim();
    sim.combatEffects = {
        entries: [
            {
                type: 'melee',
                x0: 5,
                y0: 5,
                x1: 6,
                y1: 5,
                sx: 5,
                sy: 5,
                age: 0,
                life: 0.18
            },
            {
                type: 'projectile',
                x0: 5,
                y0: 5,
                x1: 10,
                y1: 5,
                sx: 5,
                sy: 5,
                age: 0,
                life: 0.2
            },
            {
                type: 'projectile',
                spellId: 'ember_bolt',
                x0: 5,
                y0: 6,
                x1: 12,
                y1: 6,
                sx: 5,
                sy: 6,
                age: 0,
                life: 0.2
            },
            {
                type: 'aoe',
                spellId: 'fire_bomb',
                x: 8,
                y: 8,
                sx: 5,
                sy: 5,
                radius: 2,
                age: 0,
                life: 0.35
            }
        ]
    };
    const g = makeMockG();
    const texts = [];
    g.fillText = function (text) {
        texts.push(String(text));
        g.calls.push('fillText');
    };
    g.closePath = function () {
        g.calls.push('closePath');
    };
    drawAiDebugOverlays(g, sim);
    assert.ok(g.calls.includes('save'));
    assert.ok(
        texts.some((t) => t === 'hit:melee'),
        'auto melee keeps plain type label'
    );
    assert.ok(
        texts.some((t) => t === 'hit:projectile'),
        'auto projectile keeps plain type label'
    );
    assert.ok(
        texts.some((t) => t === 'hit:projectile:ember_bolt'),
        'spell projectile includes spell id'
    );
    assert.ok(
        texts.some((t) => t === 'hit:aoe:fire_bomb'),
        'spell aoe includes spell id'
    );
});

test('ranges overlay labels box names + legend', () => {
    resetDebug();
    Settings.debugAI = {
        enabled: true,
        states: false,
        paths: false,
        targets: false,
        ranges: true,
        spawns: false,
        hitSources: false,
        tileTypes: false
    };
    const g = makeMockG();
    const texts = [];
    g.fillText = function (text) {
        texts.push(String(text));
        g.calls.push('fillText');
    };
    drawAiDebugOverlays(g, makeSim());
    assert.ok(texts.some((t) => t.startsWith('engage')), 'engage box tag');
    assert.ok(texts.some((t) => t.startsWith('aggro')), 'aggro box tag');
    assert.ok(texts.some((t) => t.startsWith('leash')), 'leash box tag');
    assert.ok(texts.includes('Ranges'), 'legend title');
    assert.ok(
        texts.some((t) => t.includes('engage') && t.includes('player')),
        'legend engage line'
    );
});

test('classifyTileType floor wall void stairs', () => {
    const blocked = 255;
    const cols = 3;
    const rows = 3;
    // Center walkable; edge-adjacent blocked = wall; far corner void
    // Layout:
    // B B B
    // B W B
    // B B V  — wait all blocked around walkable are walls
    // Better: 3x3 with only (1,1) walkable → all others wall (adjacent)
    // And a second layer check with isolated blocked interior in 5x5
    const friction = new Uint8Array([
        255, 255, 255,
        255, 100, 255,
        255, 255, 255
    ]);
    const layer = { cols, rows, friction };
    const map = {
        layers: { '0': layer },
        stairs: {},
        getStair() {
            return null;
        }
    };
    assert.strictEqual(
        classifyTileType(map, layer, 1, 1, '0', blocked),
        'floor'
    );
    // Cardinal neighbor of walkable → wall
    assert.strictEqual(
        classifyTileType(map, layer, 0, 1, '0', blocked),
        'wall'
    );
    // Diagonal-only neighbor (cardinal checks only) → void
    assert.strictEqual(
        classifyTileType(map, layer, 0, 0, '0', blocked),
        'void'
    );

    // 5x5: only (2,2) walkable → corner (0,0) is void (no cardinal walkable neighbor)
    const f5 = new Uint8Array(25);
    f5.fill(255);
    f5[2 * 5 + 2] = 100;
    const layer5 = { cols: 5, rows: 5, friction: f5 };
    const map5 = {
        layers: { '0': layer5 },
        stairs: {},
        getStair() {
            return null;
        }
    };
    assert.strictEqual(
        classifyTileType(map5, layer5, 0, 0, '0', blocked),
        'void'
    );
    assert.strictEqual(
        classifyTileType(map5, layer5, 2, 1, '0', blocked),
        'wall'
    );

    // Stair pad wins over walkable
    map.getStair = (x, y) => (x === 1 && y === 1 ? { x: 1, y: 1, z: 1 } : null);
    assert.strictEqual(
        classifyTileType(map, layer, 1, 1, '0', blocked),
        'stairs'
    );

    // Stairs art without hop registry (unpaired piece socket) still → stairs
    map.getStair = () => null;
    map.stairs = {};
    map.artLayers = {
        '0': {
            cols: 3,
            rows: 3,
            palette: ['', 'damp_dirt_floor', 'dark_stone_stairs'],
            cells: new Uint16Array([
                0, 0, 0,
                0, 2, 0, // center: stairs art
                0, 0, 0
            ])
        }
    };
    assert.strictEqual(
        classifyTileType(map, layer, 1, 1, '0', blocked),
        'stairs'
    );
    // Floor art stays floor
    map.artLayers['0'].cells[1 * 3 + 1] = 1;
    assert.strictEqual(
        classifyTileType(map, layer, 1, 1, '0', blocked),
        'floor'
    );
});

test('tileTypes overlay paints + legend', () => {
    resetDebug();
    Settings.debugAI = {
        enabled: true,
        states: false,
        paths: false,
        targets: false,
        ranges: false,
        spawns: false,
        hitSources: false,
        tileTypes: true
    };
    const friction = new Uint8Array(8 * 6);
    friction.fill(255);
    // Walkable corridor
    for (let x = 0; x < 8; x++) friction[2 * 8 + x] = 100;
    const sim = {
        tileMap: {
            _viewOriginX: 0,
            _viewOriginY: 0,
            _viewCols: 8,
            _viewRows: 6,
            _viewZ: '0',
            layers: {
                '0': { cols: 8, rows: 6, friction }
            },
            stairs: {
                '3,2,0': { x: 3, y: 1, z: '1' }
            },
            getStair(x, y, z) {
                return this.stairs[`${x},${y},${z}`] || null;
            }
        },
        parties: [],
        creatures: []
    };
    const g = makeMockG();
    const texts = [];
    let fillRects = 0;
    g.fillText = function (text) {
        texts.push(String(text));
        g.calls.push('fillText');
    };
    g.fillRect = function () {
        fillRects += 1;
        g.calls.push('fillRect');
    };
    drawAiDebugOverlays(g, sim);
    assert.ok(fillRects >= 8 * 6, `painted tiles (${fillRects})`);
    assert.ok(texts.includes('Tile types'), 'legend title');
    assert.ok(
        texts.some((t) => t.includes('floor') && t.includes('walkable')),
        'legend floor line'
    );
    assert.ok(
        texts.some((t) => t.includes('stairs')),
        'legend stairs line'
    );
});

test('no draw when HEADLESS', () => {
    resetDebug();
    Settings.HEADLESS = true;
    Settings.debugAI.enabled = true;
    Settings.debugAI.states = true;
    const g = makeMockG();
    drawAiDebugOverlays(g, makeSim());
    assert.strictEqual(g.calls.length, 0);
});

test('no draw when master off', () => {
    resetDebug();
    Settings.debugAI.states = true;
    const g = makeMockG();
    drawAiDebugOverlays(g, makeSim());
    assert.strictEqual(g.calls.length, 0);
});

test('mergeTweaksPatch pure helper', () => {
    const state = {
        debugAI: Object.assign({}, DEBUG_AI_DEFAULTS),
        TIME_SPEED: 1,
        camera: { scale: 16 },
        session: {
            live: false,
            paused: false,
            seeking: false,
            status: 'READY',
            playback: { current: 0, max: 0 }
        }
    };
    const next = mergeTweaksPatch(state, {
        debugAI: { enabled: true, states: true },
        TIME_SPEED: 2.5,
        camera: { scale: 32 },
        session: {
            live: true,
            paused: true,
            status: 'PAUSED',
            playback: { current: 12, max: 40 }
        }
    });
    assert.strictEqual(next.debugAI.enabled, true);
    assert.strictEqual(next.debugAI.states, true);
    assert.strictEqual(next.debugAI.paths, false);
    assert.strictEqual(next.TIME_SPEED, 2.5);
    assert.strictEqual(next.camera.scale, 32);
    assert.strictEqual(next.session.live, true);
    assert.strictEqual(next.session.paused, true);
    assert.strictEqual(next.session.status, 'PAUSED');
    assert.strictEqual(next.session.playback.current, 12);
    assert.strictEqual(next.session.playback.max, 40);
    // Original unchanged for nested object assignment path
    assert.strictEqual(state.debugAI.enabled, false);
    assert.strictEqual(state.camera.scale, 16);
    assert.strictEqual(state.session.live, false);
});

test('mergeTweaksPatch clamps camera scale', () => {
    const low = mergeTweaksPatch({ camera: { scale: 16 } }, { camera: { scale: 2 } });
    assert.strictEqual(low.camera.scale, 8);
    const high = mergeTweaksPatch({ camera: { scale: 16 } }, { camera: { scale: 99 } });
    assert.strictEqual(high.camera.scale, 48);
});

test('protocol channel constants', () => {
    assert.strictEqual(ENGINE_TWEAKS_CHANNEL, 'hunt-design-lab-tweaks');
    assert.strictEqual(PROTO_CHANNEL, ENGINE_TWEAKS_CHANNEL);
    assert.strictEqual(ENGINE_TWEAKS_WINDOW_NAME, 'hunt_design_lab_tweakings');
});

// Leave clean for other suite runs in same process
resetDebug();
Settings.HEADLESS = true;

if (failed) {
    console.error(`\nai_debug_draw: ${failed} failed, ${passed} passed`);
    process.exit(1);
}
console.log(`ai_debug_draw: ${passed} passed`);
