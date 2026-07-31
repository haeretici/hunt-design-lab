/**
 * Unit smoke for wave regions editor pure helpers (no DOM / JSONEditor).
 */
'use strict';

const assert = require('assert');
const {
    normalizeRegion,
    normalizeRegions,
    rectFromDrag,
    frictionRows,
    normalizePieceLite,
    normalizePlacements,
    compositeDungeonFloor
} = require('../kernel/apps/hunt-editor/wave_regions_editor.js');

function testNormalizeRegion() {
    const r = normalizeRegion(
        { id: 'arena', bbox: { x: 5, y: 3, w: 7, h: 9 }, z: 1 },
        0
    );
    assert.strictEqual(r.id, 'arena');
    assert.strictEqual(r.x, 5);
    assert.strictEqual(r.y, 3);
    assert.strictEqual(r.w, 7);
    assert.strictEqual(r.h, 9);
    assert.strictEqual(r.z, 1);

    const flat = normalizeRegion({ x: 1, y: 2, width: 3, height: 4 }, 2);
    assert.strictEqual(flat.id, 'region_3');
    assert.strictEqual(flat.w, 3);
    assert.strictEqual(flat.h, 4);
}

function testNormalizeRegions() {
    assert.deepStrictEqual(normalizeRegions(null), []);
    const list = normalizeRegions([{ x: 0, y: 0, w: 2, h: 2 }]);
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].w, 2);
}

function testRectFromDrag() {
    assert.deepStrictEqual(rectFromDrag({ x0: 5, y0: 5, x1: 5, y1: 5 }), {
        x: 5,
        y: 5,
        w: 1,
        h: 1
    });
    assert.deepStrictEqual(rectFromDrag({ x0: 10, y0: 8, x1: 4, y1: 12 }), {
        x: 4,
        y: 8,
        w: 7,
        h: 5
    });
}

function testFrictionAndPiece() {
    const rows = frictionRows(['#..', '.##'], 3, 2);
    assert.deepStrictEqual(rows, ['#..', '.##']);
    const lite = normalizePieceLite({
        id: 'room_01',
        size: { w: 3, h: 2 },
        friction: ['#..', '...']
    });
    assert.ok(lite);
    assert.strictEqual(lite.w, 3);
    assert.strictEqual(lite.h, 2);
    assert.strictEqual(lite.friction[0], '#..');
}

function testCompositeDungeonFloor() {
    const pieceIndex = new Map();
    pieceIndex.set('room_a', {
        id: 'room_a',
        w: 4,
        h: 3,
        friction: ['####', '#..#', '####']
    });
    const floor = compositeDungeonFloor(
        {
            placements: [{ pieceId: 'room_a', x: 2, y: 1 }],
            entrance: { x: 3, y: 2 },
            waypoints: [{ x: 3, y: 2 }]
        },
        pieceIndex
    );
    assert.ok(floor);
    // MAP_PAD = 1 around placements
    assert.strictEqual(floor.minX, 1);
    assert.strictEqual(floor.minY, 0);
    assert.strictEqual(floor.cols, 6);
    assert.strictEqual(floor.rows, 5);
    // World (3,2) is local (1,1) of piece → floor cell
    const lx = 3 - floor.minX;
    const ly = 2 - floor.minY;
    assert.strictEqual(floor.cells[ly * floor.cols + lx], '.');
    assert.ok(floor.entrance);
    assert.strictEqual(floor.entrance.x, 3);
    assert.strictEqual(floor.waypoints.length, 1);
}

function testNormalizePlacements() {
    const p = normalizePlacements([
        { pieceId: 'a', x: 0, y: 1 },
        { id: 'b', x: 2, y: 3 },
        null
    ]);
    assert.strictEqual(p.length, 2);
    assert.deepStrictEqual(p[1], { pieceId: 'b', x: 2, y: 3 });
}

testNormalizeRegion();
testNormalizeRegions();
testRectFromDrag();
testFrictionAndPiece();
testCompositeDungeonFloor();
testNormalizePlacements();
console.log('wave_regions_editor tests ok');
