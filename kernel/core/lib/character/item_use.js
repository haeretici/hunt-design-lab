/**
 * Item use effects (potions, food, simple consumables).
 *
 * Source of truth is the equipment catalog row
 * (`presets/<mode>/equipment.json`). Runtime reads only those fields —
 * no built-in potion table and no id/name heuristic.
 *
 * Template fields (any of):
 *   heal / healMin+healMax / use.heal — HP restore range or scalar
 *   restoreMana / mana / manaMin+manaMax / use.mana — MP restore
 *   dispel / use.dispel — condition kinds to clear (e.g. ["poison"])
 *   condition / use.condition — apply a combat condition (e.g. mana_shield)
 *   consumable: true — always remove on successful use path
 */

'use strict';

const { applyHpDelta, applyManaDelta } = require('../combat/resolve.js');
const { findItem } = require('./stats.js');

/**
 * @param {unknown} v
 * @returns {[number, number]|null}
 */
function asRange(v) {
    if (v == null) return null;
    if (Array.isArray(v) && v.length >= 2) {
        const a = Number(v[0]);
        const b = Number(v[1]);
        if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
        return a <= b ? [a, b] : [b, a];
    }
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return null;
    return [n, n];
}

/**
 * Pass-through combat condition bag (mana_shield, haste, …).
 * @param {unknown} v
 * @returns {object|null}
 */
function asCondition(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const type = String(v.type || v.kind || '').trim();
    if (!type) return null;
    return Object.assign({}, v, { type });
}

/**
 * @param {string} id
 * @returns {string}
 */
function normalizeItemId(id) {
    return String(id || '')
        .toLowerCase()
        .trim()
        .replace(/\s+/g, '_');
}

/**
 * Resolve use effect from a catalog / template row.
 * Id alone (no item) is unknown — lookup via resolveUseForItemId + itemDb.
 * @param {object|null|undefined} item
 * @param {string} [itemId]
 * @returns {{
 *   heal: [number, number]|null,
 *   mana: [number, number]|null,
 *   dispel: string[],
 *   condition: object|null,
 *   known: boolean
 * }}
 */
function resolveItemUseEffect(item, _itemId) {
    const use = item && item.use && typeof item.use === 'object' ? item.use : null;

    const heal =
        asRange(item && item.heal) ||
        asRange(item && item.healMin != null ? [item.healMin, item.healMax != null ? item.healMax : item.healMin] : null) ||
        asRange(use && use.heal) ||
        null;
    const mana =
        asRange(item && item.restoreMana) ||
        asRange(item && item.mana) ||
        asRange(item && item.manaMin != null ? [item.manaMin, item.manaMax != null ? item.manaMax : item.manaMin] : null) ||
        asRange(use && use.mana) ||
        null;

    /** @type {string[]} */
    let dispel = [];
    if (item && Array.isArray(item.dispel)) {
        dispel = item.dispel.map((x) => String(x).toLowerCase());
    } else if (use && Array.isArray(use.dispel)) {
        dispel = use.dispel.map((x) => String(x).toLowerCase());
    }

    const condition =
        asCondition(item && item.condition) ||
        asCondition(use && use.condition) ||
        null;

    const known = !!(heal || mana || dispel.length || condition);
    return { heal, mana, dispel, condition, known };
}

/**
 * @param {[number, number]} range
 * @param {() => number} [rng]
 * @returns {number}
 */
function rollRange(range, rng) {
    if (!range) return 0;
    const lo = Math.floor(range[0]);
    const hi = Math.floor(range[1]);
    if (hi <= lo) return Math.max(0, lo);
    const r = typeof rng === 'function' ? rng() : Math.random();
    const u = Number.isFinite(r) ? Math.min(1, Math.max(0, r)) : Math.random();
    return lo + Math.floor(u * (hi - lo + 1));
}

/**
 * Clear matching condition kinds (e.g. poison for antidote).
 * Delegates to conditions.removeConditions (shared with cure spells).
 * @param {object} entity
 * @param {string[]} kinds
 * @returns {number} removed count
 */
function dispelConditions(entity, kinds) {
    if (!entity || !Array.isArray(kinds) || !kinds.length) return 0;
    try {
        const { removeConditions } = require('../combat/conditions.js');
        return removeConditions(entity, kinds);
    } catch (_) {
        return 0;
    }
}

/**
 * Apply a resolved use effect to a target.
 * @param {object} target
 * @param {{ heal: [number, number]|null, mana: [number, number]|null, dispel: string[], condition?: object|null }} effect
 * @param {{ rng?: () => number }} [opts]
 * @returns {{ hpDelta: number, mpDelta: number, dispelled: number, healRoll: number, manaRoll: number, conditionApplied: object|null }}
 */
function applyItemUseEffect(target, effect, opts) {
    const rng = opts && opts.rng;
    const healRoll = effect.heal ? rollRange(effect.heal, rng) : 0;
    const manaRoll = effect.mana ? rollRange(effect.mana, rng) : 0;
    let hpDelta = 0;
    let mpDelta = 0;
    if (healRoll > 0) {
        hpDelta = applyHpDelta(target, healRoll, 'healing');
    }
    if (manaRoll > 0) {
        mpDelta = applyManaDelta(target, manaRoll);
    }
    const dispelled =
        effect.dispel && effect.dispel.length
            ? dispelConditions(target, effect.dispel)
            : 0;
    let conditionApplied = null;
    if (effect.condition) {
        try {
            const { applyCondition } = require('../combat/conditions.js');
            conditionApplied = applyCondition(target, effect.condition) || null;
        } catch (_) {
            conditionApplied = null;
        }
    }
    return { hpDelta, mpDelta, dispelled, healRoll, manaRoll, conditionApplied };
}

/**
 * Look up item template from itemDb (or null).
 * @param {object[]|Record<string, object>|null|undefined} itemDb
 * @param {string} itemId
 * @returns {object|null}
 */
function lookupItem(itemDb, itemId) {
    if (!itemId) return null;
    try {
        return findItem(itemDb, itemId) || null;
    } catch (_) {
        return null;
    }
}

/**
 * Full resolve: equipment catalog row only.
 * @param {string} itemId
 * @param {object[]|Record<string, object>|null|undefined} itemDb
 * @returns {ReturnType<typeof resolveItemUseEffect> & { item: object|null }}
 */
function resolveUseForItemId(itemId, itemDb) {
    const item = lookupItem(itemDb, itemId);
    const effect = resolveItemUseEffect(item, itemId);
    return Object.assign({ item }, effect);
}

module.exports = {
    resolveItemUseEffect,
    resolveUseForItemId,
    applyItemUseEffect,
    applyManaDelta,
    dispelConditions,
    rollRange,
    normalizeItemId
};
