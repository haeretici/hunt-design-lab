#!/usr/bin/env node
/**
 * Stage 12G.1 — Logic regulators (TickRegulator, LogicTimeCooldown).
 * Decision throttles are logic-time only — independent of TIME_SPEED / wall clock.
 * Quiet on success; VERBOSE=1 for detail.
 */

'use strict';

const assert = require('assert');
const { Settings } = require('../kernel/settings.js');
const { Time, LOGIC_DT } = require('../kernel/core/lib/time.js');
const {
    TickRegulator,
    LogicTimeCooldown,
    getTickRegulator,
    isTickDue,
    getLogicCooldown,
    isLogicIntervalDue,
    forceDue
} = require('../kernel/core/lib/logic_regulator.js');
const { softRetargetDue, clearEngageSticky } = require('../kernel/core/lib/ai/cadence.js');
const { TileMap } = require('../kernel/core/entities/tilemap.js');

const VERBOSE = !!process.env.VERBOSE;

function log(...args) {
    if (VERBOSE) console.log(...args);
}

/** All-gray walkable floor. */
function openFloor(cols, rows) {
    const pixels = new Uint8Array(cols * rows * 4);
    for (let i = 0; i < cols * rows; i++) {
        const o = i * 4;
        pixels[o] = 100;
        pixels[o + 1] = 100;
        pixels[o + 2] = 100;
        pixels[o + 3] = 255;
    }
    const map = new TileMap();
    map.loadFloorFromRgba(0, cols, rows, pixels);
    return map;
}

function testTickRegulator() {
    const reg = new TickRegulator(3);
    assert.strictEqual(reg.isReady(), true);
    assert.strictEqual(reg.isReady(), false);
    assert.strictEqual(reg.isReady(), false);
    assert.strictEqual(reg.isReady(), true);
    reg.forceReady();
    assert.strictEqual(reg.isReady(), true);
    log('PASS TickRegulator interval + forceReady');
}

function testLogicTimeCooldown() {
    const cd = new LogicTimeCooldown(0.2);
    cd.start();
    assert.ok(cd.active);
    assert.strictEqual(cd.ready, false);
    assert.strictEqual(cd.tick(0.1), false);
    assert.strictEqual(cd.tick(0.1), true);
    assert.ok(cd.ready);
    assert.ok(!cd.active);
    cd.start(0.15);
    assert.strictEqual(cd.tick(0.05), false);
    assert.strictEqual(cd.tick(0.2), true);
    log('PASS LogicTimeCooldown');
}

function testHostHelpers() {
    const host = {};
    assert.strictEqual(isTickDue(host, '_reg', 1), true);
    assert.strictEqual(isTickDue(host, '_reg', 0), true);
    assert.strictEqual(isTickDue(host, '_reg', 3), true);
    assert.strictEqual(isTickDue(host, '_reg', 3), false);
    assert.strictEqual(isTickDue(host, '_reg', 3), false);
    assert.strictEqual(isTickDue(host, '_reg', 3), true);
    forceDue(host, '_reg');
    assert.strictEqual(isTickDue(host, '_reg', 3), true);

    const cd = getLogicCooldown(host, '_cd', 0.5);
    assert.ok(cd instanceof LogicTimeCooldown);
    cd.start();
    assert.ok(cd.active);

    assert.strictEqual(isLogicIntervalDue(host, '_nextAt', 0.25, 0), true);
    assert.strictEqual(isLogicIntervalDue(host, '_nextAt', 0.25, 0.1), false);
    assert.strictEqual(isLogicIntervalDue(host, '_nextAt', 0.25, 0.25), true);
    assert.strictEqual(isLogicIntervalDue(host, '_nextAt', 0, 1), true);
    log('PASS host helpers isTickDue / isLogicIntervalDue');
}

function testLogicTimeIndependentOfTimeSpeed() {
    // Same summed LOGIC_DT advances the cooldown whether wall play is 1× or 10×.
    const cd = new LogicTimeCooldown(0.2);
    cd.start();
    assert.strictEqual(cd.tick(LOGIC_DT), false);
    assert.strictEqual(cd.tick(LOGIC_DT), false);
    assert.strictEqual(cd.tick(LOGIC_DT), false);
    // 4 × 0.05s logic time clears 0.2s (allow one more if float residue)
    let ready = cd.tick(LOGIC_DT);
    if (!ready) ready = cd.tick(LOGIC_DT);
    assert.strictEqual(ready, true, 'ready after logic seconds');
    Settings.TIME_SPEED = 10;
    cd.start(0.1);
    assert.strictEqual(cd.tick(LOGIC_DT), false);
    assert.strictEqual(cd.tick(LOGIC_DT), true);
    Settings.TIME_SPEED = 1;
    log('PASS cooldowns depend on summed LOGIC_DT, not TIME_SPEED');
}

function testSoftRetargetDue() {
    const prev = Settings.AI_RETARGET_INTERVAL;
    Settings.AI_RETARGET_INTERVAL = 0;
    const owner = {};
    Time.timeSinceLevelLoad = 1;
    assert.strictEqual(softRetargetDue(owner), true);

    Settings.AI_RETARGET_INTERVAL = 0.25;
    Time.timeSinceLevelLoad = 0;
    assert.strictEqual(softRetargetDue(owner), true);
    assert.strictEqual(softRetargetDue(owner), false);
    Time.timeSinceLevelLoad = 0.2;
    assert.strictEqual(softRetargetDue(owner), false);
    Time.timeSinceLevelLoad = 0.25;
    assert.strictEqual(softRetargetDue(owner), true);

    clearEngageSticky(owner);
    assert.strictEqual(softRetargetDue(owner), true);

    Settings.AI_RETARGET_INTERVAL = prev;
    log('PASS softRetargetDue + clearEngageSticky');
}

/**
 * Count A* searches during followPath under AI_REPATH_INTERVAL_TICKS.
 * Allow steps so blocked-step repath does not fire; pre-seed long paths
 * so the buffer stays non-empty while the goal tile moves.
 */
function testRepathThrottle() {
    const prev = Settings.AI_REPATH_INTERVAL_TICKS;
    Settings.AI_REPATH_INTERVAL_TICKS = 3;

    const map = openFloor(12, 12);
    let searchCount = 0;
    const origSearch = map.search.bind(map);
    map.search = function (...args) {
        searchCount += 1;
        return origSearch(...args);
    };

    const entity = {
        id: 1,
        tile: { x: 1, y: 1, z: 0 },
        path: []
    };

    // Empty path → always repath
    map.followPath(entity, 8, 1, 0);
    assert.ok(entity.path.length > 0, 'empty path always repaths');
    const afterEmpty = searchCount;
    assert.ok(afterEmpty >= 1, 'empty path ran A*');

    // Goal moved, path still non-empty: first needRepath is due (interval 3)
    map.followPath(entity, 9, 1, 0);
    const afterFirstMove = searchCount;
    assert.ok(afterFirstMove > afterEmpty, 'first goal change runs A*');
    assert.ok(entity.path.length > 0, 'path remains after repath+step');

    // Next two goal-change calls while path non-empty: regulator not ready → no A*
    const pathLenBeforeSkip = entity.path.length;
    map.followPath(entity, 10, 1, 0);
    map.followPath(entity, 11, 1, 0);
    assert.strictEqual(searchCount, afterFirstMove, 'throttled ticks skip A*');
    // Path end should still be the pre-throttle goal (9,1), unless fully consumed
    if (entity.path.length > 0) {
        const lastB = entity.path[entity.path.length - 1];
        assert.strictEqual(lastB.x, 9, 'stale path end while throttled');
        assert.strictEqual(lastB.y, 1);
    } else {
        assert.ok(pathLenBeforeSkip >= 0, 'path may empty via steps only');
    }

    // Next due tick → A* resumes toward latest goal
    map.followPath(entity, 11, 1, 0);
    assert.ok(searchCount > afterFirstMove, 'A* resumes when regulator due');
    if (entity.path.length > 0) {
        const lastC = entity.path[entity.path.length - 1];
        assert.strictEqual(lastC.x, 11);
        assert.strictEqual(lastC.y, 1);
    }

    // Empty path forces repath even if regulator not ready
    entity.path = [];
    getTickRegulator(entity, '_repathReg', 5);
    entity._repathReg.ticksUntilReady = 4;
    const beforeEmpty = searchCount;
    map.followPath(entity, 4, 4, 0);
    assert.ok(searchCount > beforeEmpty, 'empty path repaths despite regulator');
    assert.ok(entity.path.length > 0);

    Settings.AI_REPATH_INTERVAL_TICKS = prev;
    log('PASS repath throttle in followPath');
}

function testDefaultSettingsPreserveEagerRepath() {
    const prev = Settings.AI_REPATH_INTERVAL_TICKS;
    Settings.AI_REPATH_INTERVAL_TICKS = 1;

    const map = openFloor(10, 10);
    let searchCount = 0;
    const origSearch = map.search.bind(map);
    map.search = function (...args) {
        searchCount += 1;
        return origSearch(...args);
    };

    const entity = { id: 2, tile: { x: 0, y: 0, z: 0 }, path: [] };
    map.followPath(entity, 4, 0, 0);
    const n1 = searchCount;
    map.followPath(entity, 5, 0, 0);
    const n2 = searchCount;
    map.followPath(entity, 6, 0, 0);
    const n3 = searchCount;
    assert.ok(n2 > n1 && n3 > n2, 'default interval 1 repaths every goal change');

    Settings.AI_REPATH_INTERVAL_TICKS = prev;
    log('PASS default AI_REPATH_INTERVAL_TICKS=1 is eager');
}

/**
 * Etapa 5: AI_PATH_BUDGET_PER_FRAME caps optional moving-goal repaths;
 * empty-path repaths remain critical and always run.
 */
function testPathBudgetPerFrame() {
    const prevBudget = Settings.AI_PATH_BUDGET_PER_FRAME;
    const prevRepath = Settings.AI_REPATH_INTERVAL_TICKS;
    Settings.AI_PATH_BUDGET_PER_FRAME = 2;
    Settings.AI_REPATH_INTERVAL_TICKS = 1;

    const {
        resetPathBudgetStats,
        pathBudgetStats
    } = require('../kernel/core/lib/path_budget.js');
    const { Time } = require('../kernel/core/lib/time.js');
    resetPathBudgetStats();
    Time.advanceFixedLogicStep();

    const map = openFloor(20, 20);
    let searchCount = 0;
    const origSearch = map.search.bind(map);
    map.search = function (...args) {
        searchCount += 1;
        return origSearch(...args);
    };

    // Three entities with non-empty paths; each goal move is optional.
    const entities = [];
    for (let i = 0; i < 4; i++) {
        const e = {
            id: 100 + i,
            tile: { x: 1, y: 1 + i, z: 0 },
            path: [
                { x: 2, y: 1 + i },
                { x: 3, y: 1 + i },
                { x: 8, y: 1 + i }
            ]
        };
        entities.push(e);
    }

    // First two optional repaths consume budget; next two skip A*.
    for (let i = 0; i < 4; i++) {
        map.followPath(entities[i], 12, 1 + i, 0);
    }
    const afterOptional = searchCount;
    const stats1 = pathBudgetStats();
    assert.ok(afterOptional >= 2, 'at least two optional repaths ran A*');
    assert.ok(stats1.budgetSkips >= 2, 'budget skips optional repaths over limit');
    // Entities that skipped should still hold stale path end
    assert.ok(entities[3].path.length > 0, 'stale path kept when budget skips');

    // Empty path is critical — always repaths even when budget exhausted
    entities[0].path = [];
    const beforeCritical = searchCount;
    map.followPath(entities[0], 5, 1, 0);
    assert.ok(
        searchCount > beforeCritical,
        'empty path repaths despite exhausted budget'
    );
    assert.ok(entities[0].path.length > 0, 'critical repath fills path');

    // New logic stamp resets the frame budget
    Time.advanceFixedLogicStep();
    resetPathBudgetStats();
    searchCount = 0;
    // Re-seed paths so repath is optional
    for (let i = 0; i < 2; i++) {
        entities[i].path = [
            { x: 2, y: 1 + i },
            { x: 8, y: 1 + i }
        ];
        map.followPath(entities[i], 14, 1 + i, 0);
    }
    assert.ok(searchCount >= 2, 'new frame budget allows optional repaths again');

    Settings.AI_PATH_BUDGET_PER_FRAME = prevBudget;
    Settings.AI_REPATH_INTERVAL_TICKS = prevRepath;
    log('PASS path budget per frame', pathBudgetStats());
}

function main() {
    testTickRegulator();
    testLogicTimeCooldown();
    testHostHelpers();
    testLogicTimeIndependentOfTimeSpeed();
    testSoftRetargetDue();
    testRepathThrottle();
    testDefaultSettingsPreserveEagerRepath();
    testPathBudgetPerFrame();
    log('\nAll logic regulator tests passed.');
}

main();
