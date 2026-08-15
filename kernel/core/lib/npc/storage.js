/**
 * Per-player scenario storage for dialog gating (Phase C.1).
 * Hunt-scoped KV. Unset keys read as 0.
 * Shop / buy/sell re-check the same predicate (do not hide-only).
 */

'use strict';

const { countItemIdInInventoryTree } = require('../character/inventory.js');

const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * @param {*} key
 * @returns {string}
 */
function normalizeStorageKey(key) {
    const s = key != null ? String(key).trim() : '';
    if (!s || !KEY_RE.test(s)) return '';
    return s;
}

/**
 * Coerce a stored value. Booleans become 0/1. Invalid → null (skip / delete).
 * @param {*} value
 * @returns {number|string|null}
 */
function coerceStorageValue(value) {
    if (value == null) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }
    if (typeof value === 'string') {
        const t = value.trim();
        if (!t) return null;
        if (t !== 'true' && t !== 'false' && Number.isFinite(Number(t))) {
            return Number(t);
        }
        return t;
    }
    return null;
}

/**
 * Clone a storage bag. Drops invalid keys / values.
 * @param {object|null|undefined} raw
 * @returns {Record<string, number|string>}
 */
function cloneStorageBag(raw) {
    const out = Object.create(null);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    const keys = Object.keys(raw);
    for (let i = 0; i < keys.length; i++) {
        const k = normalizeStorageKey(keys[i]);
        if (!k) continue;
        const v = coerceStorageValue(raw[keys[i]]);
        if (v == null) continue;
        out[k] = v;
    }
    return out;
}

/**
 * Merge bags. Later args win. Returns a new bag.
 * @param {...(object|null|undefined)} bags
 * @returns {Record<string, number|string>}
 */
function mergeStorageBags() {
    const out = Object.create(null);
    for (let i = 0; i < arguments.length; i++) {
        const part = cloneStorageBag(arguments[i]);
        const keys = Object.keys(part);
        for (let j = 0; j < keys.length; j++) {
            out[keys[j]] = part[keys[j]];
        }
    }
    return out;
}

/**
 * @param {object|null|undefined} player
 * @returns {Record<string, number|string>|null}
 */
function ensureStorage(player) {
    if (!player || typeof player !== 'object') return null;
    if (!player.storage || typeof player.storage !== 'object' || Array.isArray(player.storage)) {
        player.storage = Object.create(null);
    }
    return player.storage;
}

/**
 * Unset keys read as 0.
 * @param {object|null|undefined} player
 * @param {string} key
 * @returns {number|string}
 */
function getStorage(player, key) {
    const k = normalizeStorageKey(key);
    if (!k) return 0;
    const bag =
        player && player.storage && typeof player.storage === 'object' && !Array.isArray(player.storage)
            ? player.storage
            : null;
    if (!bag || bag[k] == null) return 0;
    const v = coerceStorageValue(bag[k]);
    return v == null ? 0 : v;
}

/**
 * Set or delete (value null / undefined) one key.
 * @param {object|null|undefined} player
 * @param {string} key
 * @param {*} value
 * @returns {boolean}
 */
function setStorage(player, key, value) {
    const bag = ensureStorage(player);
    if (!bag) return false;
    const k = normalizeStorageKey(key);
    if (!k) return false;
    if (value == null) {
        delete bag[k];
        return true;
    }
    const v = coerceStorageValue(value);
    if (v == null) {
        delete bag[k];
        return true;
    }
    bag[k] = v;
    return true;
}

/**
 * Apply `{ key: value }` (null deletes).
 * @param {object|null|undefined} player
 * @param {object|null|undefined} patch
 * @returns {boolean}
 */
function applyStoragePatch(player, patch) {
    if (!player) return false;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return false;
    const keys = Object.keys(patch);
    if (!keys.length) return false;
    let any = false;
    for (let i = 0; i < keys.length; i++) {
        if (setStorage(player, keys[i], patch[keys[i]])) any = true;
    }
    return any;
}

/**
 * @param {*} a
 * @param {*} b
 * @returns {boolean}
 */
function valuesEqual(a, b) {
    if (a === b) return true;
    const na = Number(a);
    const nb = Number(b);
    const aNum = Number.isFinite(na) && a !== '' && a !== true && a !== false;
    const bNum = Number.isFinite(nb) && b !== '' && b !== true && b !== false;
    if (aNum && bNum && typeof a !== 'boolean' && typeof b !== 'boolean') {
        if (typeof a === 'string' && String(a).trim() === '') return false;
        if (typeof b === 'string' && String(b).trim() === '') return false;
        return na === nb;
    }
    return String(a) === String(b);
}

/**
 * Backpack-tree count for `when.item` / `when.itemId`. Missing inv → 0.
 * @param {object|null|undefined} player
 * @param {string} itemId
 * @returns {number}
 */
function countWhenItem(player, itemId) {
    if (!player || !player.inventory || itemId == null || String(itemId) === '') {
        return 0;
    }
    return countItemIdInInventoryTree(player.inventory, String(itemId));
}

/**
 * One `{ storage|key, eq?, neq?, min?, max? }` or `{ item|itemId, … }` clause.
 * Item clauses count the backpack tree (not equipped). Missing operators → value is non-zero.
 * @param {object|null|undefined} player
 * @param {object} clause
 * @returns {boolean}
 */
function evalWhenClause(player, clause) {
    if (!clause || typeof clause !== 'object' || Array.isArray(clause)) return false;
    const itemId =
        clause.item != null
            ? String(clause.item).trim()
            : clause.itemId != null
              ? String(clause.itemId).trim()
              : '';
    if (itemId) {
        return compareWhenValue(countWhenItem(player, itemId), clause);
    }
    const key =
        clause.storage != null
            ? clause.storage
            : clause.key != null
              ? clause.key
              : '';
    const k = normalizeStorageKey(key);
    if (!k) return false;
    const value = getStorage(player, k);
    return compareWhenValue(value, clause);
}

/**
 * @param {number|string} value
 * @param {object} clause
 * @returns {boolean}
 */
function compareWhenValue(value, clause) {
    let anyOp = false;
    if (clause.eq !== undefined) {
        anyOp = true;
        const rhs = coerceStorageValue(clause.eq);
        if (!valuesEqual(value, rhs == null ? clause.eq : rhs)) return false;
    }
    if (clause.neq !== undefined) {
        anyOp = true;
        const rhs = coerceStorageValue(clause.neq);
        if (valuesEqual(value, rhs == null ? clause.neq : rhs)) return false;
    }
    if (clause.min !== undefined) {
        anyOp = true;
        const min = Number(clause.min);
        if (!Number.isFinite(min) || Number(value) < min) return false;
    }
    if (clause.max !== undefined) {
        anyOp = true;
        const max = Number(clause.max);
        if (!Number.isFinite(max) || Number(value) > max) return false;
    }
    if (!anyOp) return Number(value) !== 0 && value !== '' && value !== 0;
    return true;
}

/**
 * Reply / row `when`. Array = AND. Missing `when` → allow.
 * @param {object|null|undefined} player
 * @param {object|object[]|null|undefined} when
 * @returns {boolean}
 */
function evalWhen(player, when) {
    if (when == null) return true;
    if (Array.isArray(when)) {
        if (!when.length) return true;
        for (let i = 0; i < when.length; i++) {
            if (!evalWhenClause(player, when[i])) return false;
        }
        return true;
    }
    if (typeof when === 'object') return evalWhenClause(player, when);
    return false;
}

/**
 * Visible reply gate. No `when` → show. `when` without a player → hide.
 * @param {object|null|undefined} player
 * @param {object|null|undefined} reply
 * @returns {boolean}
 */
function replyMatchesWhen(player, reply) {
    if (!reply || typeof reply !== 'object') return false;
    if (reply.when == null) return true;
    if (!player) return false;
    return evalWhen(player, reply.when);
}

module.exports = {
    normalizeStorageKey,
    coerceStorageValue,
    cloneStorageBag,
    mergeStorageBags,
    ensureStorage,
    getStorage,
    setStorage,
    applyStoragePatch,
    evalWhen,
    replyMatchesWhen
};
