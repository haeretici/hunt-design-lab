#!/usr/bin/env node
/**
 * Pure creature loot roller (D0). Quiet on success; VERBOSE=1 for detail.
 */

'use strict';

const assert = require('assert');
const {
    MAX_LOOT_CHANCE,
    rollCreatureLoot,
    formatLootMessage
} = require('../kernel/core/lib/character/loot_roll.js');

const verbose = process.env.VERBOSE === '1';
function log(...args) {
    if (verbose) console.log(...args);
}

/** Mute expected skip warns so the file stays quiet on success. */
function quiet(fn) {
    const orig = console.warn;
    console.warn = verbose ? orig : () => {};
    try {
        return fn();
    } finally {
        console.warn = orig;
    }
}

const ITEM_DB = [
    { id: 'gold_coin', label: 'Gold Coin', stackable: true },
    { id: 'chain_armor', label: 'Chain Armor' },
    { id: 'fishing_rod', label: 'Fishing Rod' }
];

/** @param {number[]} values */
function seqRng(values) {
    let i = 0;
    return () => {
        const v = values[i];
        i += 1;
        return v == null ? 0 : v;
    };
}

function alwaysHit() {
    return 0;
}

function testAlwaysHitKnownId() {
    const out = rollCreatureLoot(
        [{ id: 'gold_coin', chance: MAX_LOOT_CHANCE }],
        ITEM_DB,
        alwaysHit
    );
    assert.strictEqual(out.items.length, 1, 'always 1 row');
    assert.deepStrictEqual(out.items[0], { itemId: 'gold_coin', count: 1 });
    assert.deepStrictEqual(out.skipped, []);
    log('chance 100000 known id ok');
}

function testChanceZeroNever() {
    const out = rollCreatureLoot(
        [{ id: 'gold_coin', chance: 0 }],
        ITEM_DB,
        alwaysHit
    );
    assert.deepStrictEqual(out.items, []);
    log('chance 0 never ok');
}

function testStubRngVsScale() {
    const row = [{ id: 'gold_coin', chance: 50000 }];
    const miss = rollCreatureLoot(row, ITEM_DB, seqRng([0.5]));
    assert.deepStrictEqual(miss.items, [], 'floor(0.5 * 1e5) === 50000 not < 50000');
    const hit = rollCreatureLoot(row, ITEM_DB, seqRng([0]));
    assert.deepStrictEqual(hit.items, [{ itemId: 'gold_coin', count: 1 }]);
    log('stub rng vs 1e5 ok');
}

function testCountZeroSkips() {
    const out = rollCreatureLoot(
        [{ id: 'gold_coin', chance: MAX_LOOT_CHANCE, minCount: 0, maxCount: 2 }],
        ITEM_DB,
        seqRng([0, 0])
    );
    assert.deepStrictEqual(out.items, []);
    assert.ok(
        out.skipped.some((s) => s.reason === 'count_zero'),
        'count 0 is skipped'
    );
    log('minCount 0 roll 0 skip ok');
}

function testUnknownAndNameMiss() {
    const out = quiet(() =>
        rollCreatureLoot(
            [
                { id: 'no_such_item_d0', chance: MAX_LOOT_CHANCE },
                { name: 'totally unknown loot', chance: MAX_LOOT_CHANCE }
            ],
            ITEM_DB,
            alwaysHit
        )
    );
    assert.deepStrictEqual(out.items, []);
    assert.strictEqual(out.skipped.length, 2);
    assert.strictEqual(out.skipped[0].reason, 'unknown_item');
    assert.strictEqual(out.skipped[0].id, 'no_such_item_d0');
    assert.strictEqual(out.skipped[1].reason, 'unknown_item');
    assert.strictEqual(out.skipped[1].name, 'totally unknown loot');
    log('unknown id / name-only miss ok');
}

function testChildIgnoredParentRolls() {
    const out = quiet(() =>
        rollCreatureLoot(
            [
                {
                    id: 'gold_coin',
                    chance: MAX_LOOT_CHANCE,
                    child: [{ id: 'chain_armor', chance: MAX_LOOT_CHANCE }]
                }
            ],
            ITEM_DB,
            alwaysHit
        )
    );
    assert.deepStrictEqual(out.items, [{ itemId: 'gold_coin', count: 1 }]);
    assert.ok(
        out.skipped.some((s) => s.reason === 'child_ignored'),
        'child noted'
    );
    assert.ok(
        !out.items.some((it) => it.itemId === 'chain_armor'),
        'child not rolled'
    );
    log('child ignored, parent rolls ok');
}

function testNameFallbackAndIdWins() {
    const byName = rollCreatureLoot(
        [{ name: 'Gold Coin', chance: MAX_LOOT_CHANCE }],
        ITEM_DB,
        alwaysHit
    );
    assert.deepStrictEqual(byName.items, [{ itemId: 'gold_coin', count: 1 }]);

    const slug = rollCreatureLoot(
        [{ name: 'fishing rod', chance: MAX_LOOT_CHANCE }],
        ITEM_DB,
        alwaysHit
    );
    assert.deepStrictEqual(slug.items, [{ itemId: 'fishing_rod', count: 1 }]);

    const idWins = quiet(() =>
        rollCreatureLoot(
            [{ id: 'no_such_item_id_wins', name: 'Gold Coin', chance: MAX_LOOT_CHANCE }],
            ITEM_DB,
            alwaysHit
        )
    );
    assert.deepStrictEqual(idWins.items, []);
    assert.strictEqual(idWins.skipped[0].reason, 'unknown_item');
    log('name fallback / id wins ok');
}

function testStackableVsCopies() {
    const stack = rollCreatureLoot(
        [{ id: 'gold_coin', chance: MAX_LOOT_CHANCE, minCount: 3, maxCount: 3 }],
        ITEM_DB,
        alwaysHit
    );
    assert.deepStrictEqual(stack.items, [{ itemId: 'gold_coin', count: 3 }]);

    const copies = rollCreatureLoot(
        [{ id: 'chain_armor', chance: MAX_LOOT_CHANCE, minCount: 2, maxCount: 2 }],
        ITEM_DB,
        alwaysHit
    );
    assert.deepStrictEqual(copies.items, [
        { itemId: 'chain_armor', count: 1 },
        { itemId: 'chain_armor', count: 1 }
    ]);
    log('stackable one row / non-stackable copies ok');
}

function testMissingChanceNever() {
    const out = rollCreatureLoot([{ id: 'gold_coin' }], ITEM_DB, alwaysHit);
    assert.deepStrictEqual(out.items, []);
    log('missing chance → 0 ok');
}

function testCountminAlias() {
    const out = rollCreatureLoot(
        [{ id: 'gold_coin', chance: MAX_LOOT_CHANCE, countmin: 4, countmax: 4 }],
        ITEM_DB,
        alwaysHit
    );
    assert.deepStrictEqual(out.items, [{ itemId: 'gold_coin', count: 4 }]);
    log('countmin/countmax alias ok');
}

function testEmptyAndNull() {
    assert.deepStrictEqual(rollCreatureLoot([], ITEM_DB, alwaysHit), {
        items: [],
        skipped: []
    });
    assert.deepStrictEqual(rollCreatureLoot(null, ITEM_DB, alwaysHit), {
        items: [],
        skipped: []
    });
    log('empty/null loot ok');
}

function testUnknownDoesNotConsumeRng() {
    const out = quiet(() =>
        rollCreatureLoot(
            [
                { id: 'no_such_item_rng', chance: MAX_LOOT_CHANCE },
                { id: 'gold_coin', chance: 50000 }
            ],
            ITEM_DB,
            seqRng([0.5])
        )
    );
    assert.deepStrictEqual(out.items, [], 'unknown skip then 0.5 miss');
    log('unknown does not consume rng ok');
}

function testWarnOnce() {
    const orig = console.warn;
    const calls = [];
    console.warn = (...args) => {
        calls.push(args.map(String).join(' '));
    };
    try {
        const row = [{ id: 'warn_once_unique_d0', chance: MAX_LOOT_CHANCE }];
        rollCreatureLoot(row, ITEM_DB, alwaysHit);
        rollCreatureLoot(row, ITEM_DB, alwaysHit);
        const hits = calls.filter((c) => c.indexOf('warn_once_unique_d0') !== -1);
        assert.strictEqual(hits.length, 1, 'unknown warn once per session');
    } finally {
        console.warn = orig;
    }
    log('warn once ok');
}

function testFormatLootMessage() {
    assert.strictEqual(
        formatLootMessage('Cave Rat', [], ITEM_DB),
        'Loot of Cave Rat: nothing'
    );
    assert.strictEqual(
        formatLootMessage('Cave Rat', [{ itemId: 'gold_coin', count: 20 }], ITEM_DB),
        'Loot of Cave Rat: 20 Gold Coin'
    );
    assert.strictEqual(
        formatLootMessage(
            'Minotaur Guard',
            [
                { itemId: 'gold_coin', count: 1 },
                { itemId: 'chain_armor', count: 1 }
            ],
            ITEM_DB
        ),
        'Loot of Minotaur Guard: Gold Coin, Chain Armor'
    );
    assert.strictEqual(
        formatLootMessage('', [{ itemId: 'missing_id', count: 1 }], ITEM_DB),
        'Loot of creature: missing_id'
    );
    log('formatLootMessage ok');
}

function main() {
    testAlwaysHitKnownId();
    testChanceZeroNever();
    testStubRngVsScale();
    testCountZeroSkips();
    testUnknownAndNameMiss();
    testChildIgnoredParentRolls();
    testNameFallbackAndIdWins();
    testStackableVsCopies();
    testMissingChanceNever();
    testCountminAlias();
    testEmptyAndNull();
    testUnknownDoesNotConsumeRng();
    testWarnOnce();
    testFormatLootMessage();
    console.log('loot_roll: ok');
}

main();
