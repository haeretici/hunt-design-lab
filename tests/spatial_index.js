#!/usr/bin/env node
/**
 * SpatialIndex unit tests (AI scale Etapa 1).
 * Quiet on success; VERBOSE=1 for detail.
 */

'use strict';

const assert = require('assert');
const {
    SpatialIndex,
    entityPos,
    compareIds
} = require('../kernel/core/lib/spatial_index.js');

const VERBOSE = !!process.env.VERBOSE;

function log(...args) {
    if (VERBOSE) console.log(...args);
}

function ent(id, x, y, z) {
    return { id, tile: { x, y, z: z != null ? z : 0 } };
}

function testInsertRemoveUpdate() {
    const idx = new SpatialIndex({ chunkSize: 10 });
    const a = ent(1, 5, 5, 0);
    const b = ent(2, 15, 5, 0);
    assert.ok(idx.insert(a));
    assert.ok(idx.insert(b));
    assert.strictEqual(idx.size, 2);
    assert.strictEqual(idx.get(1), a);
    assert.ok(idx.has(2));

    // Move across chunk boundary
    a.tile = { x: 25, y: 5, z: 0 };
    idx.update(a);
    assert.strictEqual(idx.size, 2);
    const nearOrigin = idx.queryChunkCandidates(5, 5, 0, 5);
    assert.ok(!nearOrigin.some((e) => e.id === 1), 'left old chunk');
    const nearNew = idx.queryChunkCandidates(25, 5, 0, 5);
    assert.ok(nearNew.some((e) => e.id === 1), 'in new chunk');

    assert.ok(idx.remove(2));
    assert.strictEqual(idx.size, 1);
    assert.ok(!idx.has(2));
    log('insert/remove/update ok');
}

function testQueryNearObservers() {
    const idx = new SpatialIndex({ chunkSize: 32 });
    // Local around (10,10)
    for (let i = 0; i < 5; i++) {
        idx.insert(ent(100 + i, 10 + i, 10, 0));
    }
    // Far cluster
    for (let i = 0; i < 20; i++) {
        idx.insert(ent(200 + i, 200 + i, 200, 0));
    }
    // Other floor
    idx.insert(ent(300, 10, 10, 1));

    const observers = [{ tile: { x: 10, y: 10, z: 0 } }];
    const near = idx.queryNearObservers(observers, 10);
    assert.ok(near.length >= 5);
    assert.ok(
        near.every((e) => e.id >= 100 && e.id < 200),
        'only local z0 cluster'
    );
    assert.ok(!near.some((e) => e.id === 300), 'other z excluded');
    assert.ok(!near.some((e) => e.id >= 200 && e.id < 300), 'far cluster excluded');

    // Deterministic order by id
    for (let i = 1; i < near.length; i++) {
        assert.ok(compareIds(near[i - 1].id, near[i].id) <= 0);
    }
    log('queryNearObservers ok', { n: near.length });
}

function testRebuildAndStats() {
    const idx = new SpatialIndex({ chunkSize: 8 });
    const list = [ent(1, 0, 0, 0), ent(2, 20, 20, 0), { id: 3 }]; // last skipped
    const n = idx.rebuild(list);
    assert.strictEqual(n, 2);
    assert.strictEqual(idx.size, 2);
    const st = idx.stats();
    assert.strictEqual(st.size, 2);
    assert.strictEqual(st.chunkSize, 8);
    assert.ok(st.chunks >= 1);
    idx.clear();
    assert.strictEqual(idx.size, 0);
    log('rebuild/stats ok');
}

function testEntityPos() {
    assert.deepStrictEqual(entityPos({ tile: { x: 1, y: 2, z: 3 } }), {
        x: 1,
        y: 2,
        z: 3
    });
    assert.deepStrictEqual(entityPos({ x: 4, y: 5 }), { x: 4, y: 5, z: 0 });
    assert.strictEqual(entityPos(null), null);
    log('entityPos ok');
}

/**
 * Etapa 4: exact Chebyshev refine + multi-observer exact union.
 */
function testQueryChebyshevExact() {
    const idx = new SpatialIndex({ chunkSize: 32 });
    // Exact radius 5: include d=5, exclude d=6
    idx.insert(ent(1, 10, 10, 0));
    idx.insert(ent(2, 15, 10, 0)); // d=5
    idx.insert(ent(3, 16, 10, 0)); // d=6
    idx.insert(ent(4, 10, 10, 1)); // other floor
    idx.insert({
        id: 5,
        tile: { x: 11, y: 10, z: 0 },
        alive: false,
        hp: { current: 0, max: 10 }
    });

    const near = idx.queryChebyshev(10, 10, 0, 5);
    const ids = near.map((e) => e.id);
    assert.ok(ids.includes(1));
    assert.ok(ids.includes(2));
    assert.ok(!ids.includes(3), 'outside exact radius');
    assert.ok(!ids.includes(4), 'other z');
    assert.ok(!ids.includes(5), 'dead excluded by default');

    const around = idx.queryAround({ tile: { x: 10, y: 10, z: 0 } }, 5);
    assert.deepStrictEqual(
        around.map((e) => e.id).sort(),
        near.map((e) => e.id).sort()
    );

    // Multi-observer exact: second bubble far away
    idx.insert(ent(10, 100, 100, 0));
    idx.insert(ent(11, 200, 200, 0)); // far from both
    const obs = [
        { tile: { x: 10, y: 10, z: 0 } },
        { tile: { x: 100, y: 100, z: 0 } }
    ];
    const multi = idx.queryNearObserversExact(obs, 5);
    const mids = multi.map((e) => e.id);
    assert.ok(mids.includes(1));
    assert.ok(mids.includes(10));
    assert.ok(!mids.includes(11));
    assert.ok(!mids.includes(3));
    for (let i = 1; i < multi.length; i++) {
        assert.ok(compareIds(multi[i - 1].id, multi[i].id) <= 0);
    }
    log('queryChebyshev / queryNearObserversExact ok', { near: ids, multi: mids });
}

function main() {
    testInsertRemoveUpdate();
    testQueryNearObservers();
    testRebuildAndStats();
    testEntityPos();
    testQueryChebyshevExact();
    console.log('spatial_index: ok');
}

main();
