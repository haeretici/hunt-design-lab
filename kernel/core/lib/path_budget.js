/**
 * Per-logic-frame budget for optional A* repaths (Etapa 5 / Phase F).
 *
 * Empty path / blocked-step repaths are critical and always run.
 * Moving-goal repaths (stale path still walkable) consume
 * AI_PATH_BUDGET_PER_FRAME; when exhausted they keep the stale path.
 * 0 / unset = unlimited (default — golden/CI/normal hunts; policy A).
 *
 * Counters: per-frame fields reset each logic stamp; cumulative totals grow
 * for stress runs. `noteFailBackoff` records fail-backoff arms (not A* runs).
 */

'use strict';

const { Settings } = require('../../settings.js');
const { Time } = require('./time.js');

/** @type {number|null} */
let _stamp = null;
let _used = 0;
/** Per-frame package counts (reset on stamp). */
let _repathsFrame = 0;
let _criticalFrame = 0;
let _optionalFrame = 0;
let _budgetSkipsFrame = 0;
let _failBackoffsFrame = 0;
/** Process-lifetime totals (stress / tests). */
let _repaths = 0;
let _criticalRepaths = 0;
let _optionalRepaths = 0;
let _budgetSkips = 0;
let _failBackoffs = 0;

/**
 * Reset per-frame counters when the logic stamp advances.
 * @private
 */
function _syncStamp() {
    const t =
        Time && typeof Time.timeSinceLevelLoad === 'number'
            ? Time.timeSinceLevelLoad
            : 0;
    if (_stamp !== t) {
        _stamp = t;
        _used = 0;
        _repathsFrame = 0;
        _criticalFrame = 0;
        _optionalFrame = 0;
        _budgetSkipsFrame = 0;
        _failBackoffsFrame = 0;
    }
}

/**
 * Resolved frame limit. ≤ 0 → unlimited.
 * @returns {number}
 */
function resolvePathBudgetLimit() {
    const n =
        Settings.AI_PATH_BUDGET_PER_FRAME != null
            ? Number(Settings.AI_PATH_BUDGET_PER_FRAME)
            : 0;
    if (!Number.isFinite(n) || n <= 0) return 0;
    return n | 0;
}

/**
 * Whether a full A* repath may run this call.
 * @param {{ critical?: boolean }} [opts]
 *   critical — empty path / blocked retry (always true)
 * @returns {boolean}
 */
function takePathBudget(opts) {
    const critical = !!(opts && opts.critical);
    _syncStamp();
    if (critical) {
        _criticalRepaths += 1;
        _criticalFrame += 1;
        _repaths += 1;
        _repathsFrame += 1;
        return true;
    }
    const limit = resolvePathBudgetLimit();
    if (limit <= 0) {
        _optionalRepaths += 1;
        _optionalFrame += 1;
        _repaths += 1;
        _repathsFrame += 1;
        return true;
    }
    if (_used >= limit) {
        _budgetSkips += 1;
        _budgetSkipsFrame += 1;
        return false;
    }
    _used += 1;
    _optionalRepaths += 1;
    _optionalFrame += 1;
    _repaths += 1;
    _repathsFrame += 1;
    return true;
}

/**
 * Record that a critical repath failed and fail-backoff was armed.
 * Call from followPath when setting `_repathFailBackoffUntil`.
 */
function noteFailBackoff() {
    _syncStamp();
    _failBackoffs += 1;
    _failBackoffsFrame += 1;
}

/**
 * Snapshot for telemetry / tests / aiPerf.
 * `*Frame` fields are this logic stamp only; bare totals are process-lifetime.
 * @returns {{
 *   stamp: number|null,
 *   used: number,
 *   limit: number,
 *   repaths: number,
 *   criticalRepaths: number,
 *   optionalRepaths: number,
 *   budgetSkips: number,
 *   failBackoffs: number,
 *   repathsFrame: number,
 *   criticalRepathsFrame: number,
 *   optionalRepathsFrame: number,
 *   budgetSkipsFrame: number,
 *   failBackoffsFrame: number
 * }}
 */
function pathBudgetStats() {
    _syncStamp();
    return {
        stamp: _stamp,
        used: _used,
        limit: resolvePathBudgetLimit(),
        repaths: _repaths,
        criticalRepaths: _criticalRepaths,
        optionalRepaths: _optionalRepaths,
        budgetSkips: _budgetSkips,
        failBackoffs: _failBackoffs,
        repathsFrame: _repathsFrame,
        criticalRepathsFrame: _criticalFrame,
        optionalRepathsFrame: _optionalFrame,
        budgetSkipsFrame: _budgetSkipsFrame,
        failBackoffsFrame: _failBackoffsFrame
    };
}

/**
 * Clear cumulative + frame counters (tests).
 */
function resetPathBudgetStats() {
    _stamp = null;
    _used = 0;
    _repathsFrame = 0;
    _criticalFrame = 0;
    _optionalFrame = 0;
    _budgetSkipsFrame = 0;
    _failBackoffsFrame = 0;
    _repaths = 0;
    _criticalRepaths = 0;
    _optionalRepaths = 0;
    _budgetSkips = 0;
    _failBackoffs = 0;
}

module.exports = {
    takePathBudget,
    noteFailBackoff,
    pathBudgetStats,
    resetPathBudgetStats,
    resolvePathBudgetLimit
};
