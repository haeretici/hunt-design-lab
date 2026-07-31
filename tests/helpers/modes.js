/**
 * Content-mode helpers for tests.
 *
 * Master ships only `standard`. Optional packs (e.g. historical `legacy` on the
 * legacy branch) are detected at runtime so the same suite stays green with or
 * without extra presets/<mode>/ folders.
 */

'use strict';

const {
    listModes,
    setActiveMode,
    getActiveModeId,
    DEFAULT_MODE_ID
} = require('../../kernel/core/lib/modes.js');

/**
 * @param {string} id
 * @returns {boolean}
 */
function hasMode(id) {
    const want = String(id || '').trim().toLowerCase();
    if (!want) return false;
    return listModes().some((m) => m && m.id === want);
}

/**
 * Run fn under mode id, always restoring previous active mode.
 * Supports sync and Promise-returning fn.
 * @template T
 * @param {string} id
 * @param {() => T|Promise<T>} fn
 * @returns {T|Promise<T>}
 */
function withMode(id, fn) {
    const prev = getActiveModeId() || DEFAULT_MODE_ID;
    setActiveMode(id);

    const restore = () => {
        try {
            setActiveMode(prev);
        } catch (_) {
            setActiveMode(DEFAULT_MODE_ID);
        }
    };

    let out;
    try {
        out = fn();
    } catch (err) {
        restore();
        throw err;
    }

    if (out && typeof out.then === 'function') {
        return Promise.resolve(out).then(
            (v) => {
                restore();
                return v;
            },
            (err) => {
                restore();
                throw err;
            }
        );
    }

    restore();
    return out;
}

/**
 * Modes to exercise for dual-pack generator/parity checks.
 * Always includes standard; adds installed optional packs when present.
 * @param {string[]} [optionalIds]
 * @returns {string[]}
 */
function installedModes(optionalIds = ['legacy']) {
    const out = ['standard'];
    for (const id of optionalIds) {
        if (hasMode(id) && out.indexOf(id) < 0) out.push(id);
    }
    return out;
}

/**
 * Run fn only when mode is installed; otherwise no-op.
 * @param {string} id
 * @param {() => void|Promise<void>} fn
 * @returns {boolean|Promise<boolean>} true if ran
 */
function whenMode(id, fn) {
    if (!hasMode(id)) return false;
    const out = withMode(id, fn);
    if (out && typeof out.then === 'function') {
        return Promise.resolve(out).then(() => true);
    }
    return true;
}

module.exports = {
    hasMode,
    withMode,
    whenMode,
    installedModes
};
