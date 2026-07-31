/**
 * Unit smoke for dungeon profile editor pure helpers (no DOM / JSONEditor).
 */
'use strict';

const assert = require('assert');
const {
    normalizeRuleRow,
    normalizePlacements,
    normalizeCutouts,
    pairCount,
    starterRules
} = require('../kernel/apps/designer-ui/dungeon_profile_editor.js');

function testPairCount() {
    assert.deepStrictEqual(pairCount(3), [3, 3]);
    assert.deepStrictEqual(pairCount([2, 5]), [2, 5]);
    assert.deepStrictEqual(pairCount([5, 2]), [2, 5]);
    assert.deepStrictEqual(pairCount({ min: 1, max: 4 }), [1, 4]);
}

function testNormalizeRuleRow() {
    const r = normalizeRuleRow({
        op: 'add_room',
        tags: ['room'],
        count: [2, 4]
    });
    assert.strictEqual(r.op, 'AddRoom');
    assert.deepStrictEqual(r.tags, ['room']);
    assert.deepStrictEqual(r.count, [2, 4]);

    const ev = normalizeRuleRow({
        type: 'event',
        events: ['champion_room'],
        count: 1
    });
    assert.strictEqual(ev.op, 'SelectEvent');
    assert.deepStrictEqual(ev.events, ['champion_room']);
}

function testNormalizePlacements() {
    const p = normalizePlacements([
        { pieceId: 'hub_cross_01', x: 0, y: 0 },
        { id: 'corr_ew_01', x: 7, y: 1 },
        { pieceId: '', x: 1, y: 1 },
        null
    ]);
    assert.strictEqual(p.length, 2);
    assert.deepStrictEqual(p[0], { pieceId: 'hub_cross_01', x: 0, y: 0 });
    assert.deepStrictEqual(p[1], { pieceId: 'corr_ew_01', x: 7, y: 1 });
}

function testNormalizeCutouts() {
    const c = normalizeCutouts([
        {
            id: 'camp_pocket',
            bbox: { x: 12, y: 0, w: 7, h: 7 },
            events: ['camp_ambush'],
            maxPacks: [1, 3],
            useSockets: true
        }
    ]);
    assert.strictEqual(c.length, 1);
    assert.strictEqual(c[0].id, 'camp_pocket');
    assert.deepStrictEqual(c[0].bbox, { x: 12, y: 0, w: 7, h: 7 });
    assert.deepStrictEqual(c[0].maxPacks, [1, 3]);
}

function testStarterRules() {
    const rules = starterRules();
    assert.ok(rules.length >= 4);
    assert.strictEqual(rules[0].op, 'AddHub');
    assert.ok(rules.some((r) => r.op === 'AddExit'));
}

testPairCount();
testNormalizeRuleRow();
testNormalizePlacements();
testNormalizeCutouts();
testStarterRules();
console.log('dungeon_profile_editor helpers: ok');
