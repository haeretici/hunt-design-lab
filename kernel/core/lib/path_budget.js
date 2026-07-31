/**
 * Per-logic-frame budget for optional A* repaths (Etapa 5).
 *
 * Empty path / blocked-step repaths are critical and always run.
 * Moving-goal repaths (stale path still walkable) consume
 * AI_PATH_BUDGET_PER_FRAME; when exhausted they keep the stale path.
 * 0 / unset = unlimited (default — hunt determinism unchanged).
 */

'use strict';

const { Settings } = require('../../settings.js');
const { Time } = require('./time.js');

/** @type {number|null} */
let _stamp = null;
let _used = 0;
let _repaths = 0;
let _criticalRepaths = 0;
let _budgetSkips = 0;

/**
 * Reset counters when the logic stamp advances.
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
        _repaths += 1;
        return true;
    }
    const limit = resolvePathBudgetLimit();
    if (limit <= 0) {
        _repaths += 1;
        return true;
    }
    if (_used >= limit) {
        _budgetSkips += 1;
        return false;
    }
    _used += 1;
    _repaths += 1;
    return true;
}

/**
 * Snapshot for telemetry / tests (accumulates within the current process;
 * per-frame fields reset usage on stamp change but totals keep growing).
 * @returns {{
 *   stamp: number|null,
 *   used: number,
 *   limit: number,
 *   repaths: number,
 *   criticalRepaths: number,
 *   budgetSkips: number
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
        budgetSkips: _budgetSkips
    };
}

/**
 * Clear cumulative counters (tests).
 */
function resetPathBudgetStats() {
    _stamp = null;
    _used = 0;
    _repaths = 0;
    _criticalRepaths = 0;
    _budgetSkips = 0;
}

module.exports = {
    takePathBudget,
    pathBudgetStats,
    resetPathBudgetStats,
    resolvePathBudgetLimit
};
