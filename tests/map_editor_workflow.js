#!/usr/bin/env node
/**
 * Map editor P2 workflow: goto, find, copy/paste, NPC/modified filters, minimap.
 * Quiet on success; VERBOSE=1 for detail.
 */

'use strict';

const assert = require('assert');

const { FRICTION_BLOCKED } = require('../kernel/core/lib/dungeon/tile_roles.js');
const { createEditorSession } = require('../kernel/core/lib/dungeon/tilemap_editor.js');
const {
    parseGotoQuery,
    spawnPinSignature,
    markSpawnBaseline,
    isModifiedSpawn,
    spawnIsNpc,
    spawnMatchesQuery,
    classifySpawnPin,
    filterEditorSpawns,
    searchSpawns,
    findSpawnHits,
    copySpawnPins,
    pasteSpawnPins,
    spawnAtTile,
    mapToMinimap,
    minimapToMap,
    fillMinimapRgba,
    FIND_ISSUE_EMPTY,
    FIND_ISSUE_UNKNOWN,
    FIND_ISSUE_BLOCKED,
    FIND_ISSUE_OK,
    MINIMAP_DEFAULT_W,
    MINIMAP_DEFAULT_H
} = require('../kernel/core/lib/dungeon/map_editor_workflow.js');

const VERBOSE = !!process.env.VERBOSE;

function log(...args) {
    if (VERBOSE) console.log(...args);
}

const PRESETS = {
    frost_imp: { id: 'frost_imp', label: 'Frost Imp' },
    town_guide: { id: 'town_guide', label: 'Guide', isNpc: true, kind: 'npc' },
    cave_rat: { id: 'cave_rat', label: 'Cave Rat' }
};

function testParseGoto() {
    assert.strictEqual(parseGotoQuery(''), null);
    assert.strictEqual(parseGotoQuery('   '), null);
    assert.deepStrictEqual(parseGotoQuery('2099,26'), { kind: 'xyz', x: 2099, y: 26 });
    assert.deepStrictEqual(parseGotoQuery('2099, 26, 7'), { kind: 'xyz', x: 2099, y: 26, z: 7 });
    assert.deepStrictEqual(parseGotoQuery('10 20 3'), { kind: 'xyz', x: 10, y: 20, z: 3 });
    assert.deepStrictEqual(parseGotoQuery('x=4 y=5 z=2'), { kind: 'xyz', x: 4, y: 5, z: 2 });
    assert.deepStrictEqual(parseGotoQuery('frost_imp'), {
        kind: 'search',
        query: 'frost_imp'
    });
    assert.deepStrictEqual(parseGotoQuery('Frost Imp'), {
        kind: 'search',
        query: 'Frost Imp'
    });
    log('parseGotoQuery ok');
}

function testFindAndClassify() {
    const cols = 8;
    const rows = 4;
    const friction = new Uint8Array(cols * rows);
    friction[1 * cols + 1] = FRICTION_BLOCKED;
    const pins = [
        { creatureId: 'frost_imp', x: 0, y: 0, z: 7, respawn: 60 },
        { creatureId: 'no_such_mob', x: 2, y: 0, z: 7, respawn: 60 },
        { creatureId: 'cave_rat', x: 1, y: 1, z: 7, respawn: 60 },
        { creatureId: '', x: 3, y: 0, z: 7, respawn: 60 },
        { creatureId: 'town_guide', x: 4, y: 0, z: 7, respawn: 60 }
    ];
    assert.strictEqual(classifySpawnPin(pins[0], { presets: PRESETS }), FIND_ISSUE_OK);
    assert.strictEqual(
        classifySpawnPin(pins[1], { presets: PRESETS }),
        FIND_ISSUE_UNKNOWN
    );
    assert.strictEqual(
        classifySpawnPin(pins[2], { presets: PRESETS, friction, cols, rows }),
        FIND_ISSUE_BLOCKED
    );
    assert.strictEqual(classifySpawnPin(pins[3], { presets: PRESETS }), FIND_ISSUE_EMPTY);
    assert.ok(spawnMatchesQuery(pins[0], 'frost', PRESETS));
    assert.ok(spawnMatchesQuery(pins[0], 'Frost Imp', PRESETS));
    assert.ok(!spawnMatchesQuery(pins[0], 'guide', PRESETS));
    const unknown = filterEditorSpawns(pins, { issue: 'unknown', presets: PRESETS });
    assert.strictEqual(unknown.length, 2);
    const blocked = filterEditorSpawns(pins, {
        issue: 'blocked',
        presets: PRESETS,
        friction,
        cols,
        rows
    });
    assert.strictEqual(blocked.length, 1);
    assert.strictEqual(blocked[0].creatureId, 'cave_rat');
    const npcs = filterEditorSpawns(pins, { onlyNpcs: true, presets: PRESETS });
    assert.strictEqual(npcs.length, 1);
    assert.strictEqual(npcs[0].creatureId, 'town_guide');
    assert.ok(spawnIsNpc(pins[4], PRESETS));
    assert.ok(!spawnIsNpc(pins[0], PRESETS));
    const hits = findSpawnHits([{ floor: '07', spawns: pins }], {
        issue: 'unknown',
        presets: PRESETS
    });
    assert.strictEqual(hits.length, 2);
    assert.strictEqual(searchSpawns(pins, 'guide', PRESETS)[0].creatureId, 'town_guide');
    log('find + classify + npc filter ok');
}

function testModifiedAndClipboard() {
    const a = { creatureId: 'frost_imp', x: 10, y: 20, z: 7, respawn: 60 };
    const b = { creatureId: 'cave_rat', x: 12, y: 21, z: 7, respawn: 30 };
    markSpawnBaseline([a, b]);
    assert.ok(!isModifiedSpawn(a));
    a.x = 11;
    assert.ok(isModifiedSpawn(a));
    const fresh = { creatureId: 'town_guide', x: 1, y: 1, z: 7, respawn: 60 };
    assert.ok(isModifiedSpawn(fresh));
    const clip = copySpawnPins([a, b]);
    assert.ok(clip);
    assert.deepStrictEqual(clip.origin, { x: 11, y: 20 });
    assert.strictEqual(clip.pins.length, 2);
    assert.strictEqual(clip.pins[0].dx, 0);
    assert.strictEqual(clip.pins[1].dx, 1);
    const pasted = pasteSpawnPins(clip, { x: 100, y: 200, z: 6 }, PRESETS);
    assert.strictEqual(pasted.length, 2);
    assert.strictEqual(pasted[0].creatureId, 'frost_imp');
    assert.strictEqual(pasted[0].x, 100);
    assert.strictEqual(pasted[0].y, 200);
    assert.strictEqual(pasted[0].z, 6);
    assert.strictEqual(pasted[0].respawn, 60);
    assert.strictEqual(pasted[1].x, 101);
    assert.strictEqual(pasted[1].y, 201);
    assert.ok(isModifiedSpawn(pasted[0]));
    assert.strictEqual(copySpawnPins([]), null);
    assert.deepStrictEqual(pasteSpawnPins(null, { x: 0, y: 0 }), []);
    assert.strictEqual(spawnAtTile([a, b], 12, 21), b);
    assert.strictEqual(spawnAtTile([a, b], 0, 0), null);
    assert.ok(spawnPinSignature(a));
    log('modified + clipboard ok');
}

function testMinimap() {
    const cols = 16;
    const rows = 8;
    const destW = 8;
    const destH = 4;
    const friction = new Uint8Array(cols * rows);
    friction[0] = FRICTION_BLOCKED;
    const rgba = new Uint8ClampedArray(destW * destH * 4);
    fillMinimapRgba(rgba, {
        cols,
        rows,
        friction,
        destW,
        destH,
        spawns: [
            { creatureId: 'frost_imp', x: 0, y: 0 },
            { creatureId: 'town_guide', x: 15, y: 7 }
        ],
        presets: PRESETS,
        viewRect: { x: 0, y: 0, w: 4, h: 2 }
    });
    assert.strictEqual(rgba[3], 255);
    // (0,0) spawn overwrites friction sample — creature orange
    assert.strictEqual(rgba[0], 220);
    const npc = mapToMinimap(15, 7, cols, rows, destW, destH);
    const np = (npc.y * destW + npc.x) * 4;
    assert.strictEqual(rgba[np], 68);
    assert.strictEqual(rgba[np + 1], 221);
    const back = minimapToMap(npc.x, npc.y, cols, rows, destW, destH);
    assert.ok(back.x >= 0 && back.x < cols);
    assert.ok(back.y >= 0 && back.y < rows);
    assert.strictEqual(MINIMAP_DEFAULT_W, 248);
    assert.strictEqual(MINIMAP_DEFAULT_H, 198);
    log('minimap ok');
}

function testSampleCellAt() {
    const session = createEditorSession({ cols: 8, rows: 8, z: 7 });
    const grass = {
        catalogId: 'cave_floor',
        roleId: 'floor',
        kind: 'tiles',
        subLayer: 'ground'
    };
    session.selectStamp(grass);
    session.beginStroke();
    session.paintAt(3, 4, { stamp: grass, subLayer: 'ground' });
    session.endStroke();
    const hit = session.sampleCellAt(3, 4);
    assert.ok(hit);
    assert.strictEqual(hit.kind, 'tilemap');
    assert.strictEqual(hit.subLayer, 'ground');
    assert.ok(hit.stamp);
    assert.strictEqual(hit.stamp.catalogId, 'cave_floor');
    const empty = session.sampleCellAt(0, 0);
    assert.strictEqual(empty.paletteIndex, 0);
    session.paintChannel('friction', 1, 1, 255);
    const fr = session.sampleCellAt(1, 1, { channel: 'friction' });
    assert.strictEqual(fr.kind, 'friction');
    assert.strictEqual(fr.value, 255);
    assert.strictEqual(session.sampleCellAt(-1, 0), null);
    log('sampleCellAt ok');
}

function main() {
    console.log('tests/map_editor_workflow.js');
    testParseGoto();
    testFindAndClassify();
    testModifiedAndClipboard();
    testMinimap();
    testSampleCellAt();
    console.log('map_editor_workflow: ok');
}

main();
