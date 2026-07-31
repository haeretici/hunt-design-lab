/**
 * Item use effects (potions, food, simple consumables).
 *
 * Potion restore ranges follow the reference server fluid table
 * (`legacy/server/data/scripts/actions/items/potions.lua`) with
 * engine-native commercial ids. Dual potions replace legacy "spirit"
 * (HP + MP in one drink).
 *
 * Template fields (any of):
 *   heal / healMin+healMax / use.heal — HP restore range or scalar
 *   restoreMana / mana / manaMin+manaMax / use.mana — MP restore
 *   dispel / use.dispel — condition kinds to clear (e.g. ["poison"])
 *   consumable: true — always remove on successful use path
 */

'use strict';

const { applyHpDelta } = require('../combat/resolve.js');
const { findItem } = require('./stats.js');

/**
 * Built-in catalog keyed by item id (and common aliases).
 * Ranges are [min, max] inclusive integer rolls.
 * @type {Record<string, { heal?: number|[number, number], mana?: number|[number, number], dispel?: string[] }>}
 */
const POTION_EFFECTS = Object.freeze({
    small_health_potion: { heal: [60, 90] },
    health_potion: { heal: [125, 175] },
    strong_health_potion: { heal: [250, 350] },
    great_health_potion: { heal: [425, 575] },
    ultimate_health_potion: { heal: [650, 850] },
    supreme_health_potion: { heal: [875, 1125] },

    mana_potion: { mana: [75, 125] },
    strong_mana_potion: { mana: [115, 185] },
    great_mana_potion: { mana: [150, 250] },
    ultimate_mana_potion: { mana: [425, 575] },

    // Dual = HP + MP (commercial rename of spirit potions)
    dual_potion: { heal: [250, 350], mana: [100, 200] },
    great_dual_potion: { heal: [250, 350], mana: [100, 200] },
    ultimate_dual_potion: { heal: [420, 580], mana: [250, 350] },
    // Aliases for any residual spirit ids / labels
    spirit_potion: { heal: [250, 350], mana: [100, 200] },
    great_spirit_potion: { heal: [250, 350], mana: [100, 200] },
    ultimate_spirit_potion: { heal: [420, 580], mana: [250, 350] },

    antidote_potion: { dispel: ['poison'] },

    // Attribute buffs from the reference table are not ticked yet — consume is a no-op effect
    // (item still removed) so action bars / inventory use do not hard-fail.
    berserk_potion: {},
    savant_potion: {},
    mastermind_potion: {},
    marksman_potion: {},
    bullseye_potion: {},
    transcendence_potion: {},
    magic_shield_potion: {}
});

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
 * Resolve use effect from a template and/or builtin catalog.
 * @param {object|null|undefined} item
 * @param {string} [itemId]
 * @returns {{
 *   heal: [number, number]|null,
 *   mana: [number, number]|null,
 *   dispel: string[],
 *   known: boolean
 * }}
 */
function resolveItemUseEffect(item, itemId) {
    const id = normalizeItemId(
        (item && (item.id || item.itemId)) || itemId || ''
    );
    const use = item && item.use && typeof item.use === 'object' ? item.use : null;

    let heal =
        asRange(item && item.heal) ||
        asRange(item && item.healMin != null ? [item.healMin, item.healMax != null ? item.healMax : item.healMin] : null) ||
        asRange(use && use.heal) ||
        null;
    let mana =
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

    const builtin = id ? POTION_EFFECTS[id] : null;
    if (builtin) {
        if (!heal && builtin.heal) heal = asRange(builtin.heal);
        if (!mana && builtin.mana) mana = asRange(builtin.mana);
        if (!dispel.length && builtin.dispel) {
            dispel = builtin.dispel.slice();
        }
    }

    // Label / id heuristics when no explicit fields (loot strings, free-typed slots)
    if (!heal && !mana && !dispel.length && id) {
        const fromName = effectFromNameHint(id);
        if (fromName) {
            heal = fromName.heal || null;
            mana = fromName.mana || null;
            dispel = fromName.dispel || [];
        }
    }

    const known = !!(heal || mana || dispel.length || (builtin && Object.keys(builtin).length === 0));
    return { heal, mana, dispel, known };
}

/**
 * Map free-text / slug ids that contain potion tier words onto catalog ranges.
 * @param {string} id
 * @returns {{ heal?: [number, number], mana?: [number, number], dispel?: string[] }|null}
 */
function effectFromNameHint(id) {
    const s = String(id || '').toLowerCase().replace(/-/g, '_');
    if (!s.includes('potion') && !s.includes('flask')) return null;

    if (s.includes('antidote')) return { dispel: ['poison'] };

    const isDual =
        s.includes('dual') || s.includes('spirit') || s.includes('spirit_potion');
    const isMana = s.includes('mana') && !isDual;
    const isHealth =
        (s.includes('health') || s.includes('healing') || s.includes('hp')) &&
        !isMana &&
        !isDual;

    if (isDual) {
        if (s.includes('ultimate')) {
            return {
                heal: /** @type {[number, number]} */ ([420, 580]),
                mana: /** @type {[number, number]} */ ([250, 350])
            };
        }
        return {
            heal: /** @type {[number, number]} */ ([250, 350]),
            mana: /** @type {[number, number]} */ ([100, 200])
        };
    }

    if (isHealth) {
        if (s.includes('supreme')) return { heal: [875, 1125] };
        if (s.includes('ultimate')) return { heal: [650, 850] };
        if (s.includes('great')) return { heal: [425, 575] };
        if (s.includes('strong')) return { heal: [250, 350] };
        if (s.includes('small')) return { heal: [60, 90] };
        return { heal: [125, 175] };
    }

    if (isMana) {
        if (s.includes('ultimate')) return { mana: [425, 575] };
        if (s.includes('great')) return { mana: [150, 250] };
        if (s.includes('strong')) return { mana: [115, 185] };
        return { mana: [75, 125] };
    }

    // Generic "potion" / "potion_healing" → modest health
    if (s.includes('potion') || s.includes('healing')) {
        return { heal: [125, 175] };
    }
    return null;
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
 * Restore mana on an entity (player.mp or creature.mana).
 * @param {object} entity
 * @param {number} amount
 * @returns {number} actual delta
 */
function applyManaDelta(entity, amount) {
    const n = Math.max(0, Math.floor(Number(amount) || 0));
    if (!entity || n <= 0) return 0;
    if (entity.mp && entity.mp.current != null) {
        const max =
            entity.mp.max != null
                ? Number(entity.mp.max)
                : entity.mp.current + n;
        const before = entity.mp.current;
        entity.mp.current = Math.min(max, before + n);
        return entity.mp.current - before;
    }
    if (entity.mana != null) {
        const before = Number(entity.mana) || 0;
        const max =
            entity.manaMax != null
                ? Number(entity.manaMax)
                : entity.maxMana != null
                  ? Number(entity.maxMana)
                  : before + n;
        entity.mana = Math.min(max, before + n);
        return entity.mana - before;
    }
    return 0;
}

/**
 * Clear matching condition kinds (e.g. poison for antidote).
 * @param {object} entity
 * @param {string[]} kinds
 * @returns {number} removed count
 */
function dispelConditions(entity, kinds) {
    if (!entity || !Array.isArray(kinds) || !kinds.length) return 0;
    if (!Array.isArray(entity.conditions) || !entity.conditions.length) return 0;
    const want = new Set(kinds.map((k) => String(k).toLowerCase()));
    let removed = 0;
    const next = [];
    for (let i = 0; i < entity.conditions.length; i++) {
        const c = entity.conditions[i];
        if (c && want.has(String(c.kind || c.type || '').toLowerCase())) {
            removed += 1;
        } else {
            next.push(c);
        }
    }
    if (removed) {
        entity.conditions = next;
        try {
            const { recomputeDerived } = require('../combat/conditions.js');
            recomputeDerived(entity);
        } catch (_) {
            /* optional */
        }
    }
    return removed;
}

/**
 * Apply a resolved use effect to a target.
 * @param {object} target
 * @param {{ heal: [number, number]|null, mana: [number, number]|null, dispel: string[] }} effect
 * @param {{ rng?: () => number }} [opts]
 * @returns {{ hpDelta: number, mpDelta: number, dispelled: number, healRoll: number, manaRoll: number }}
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
    return { hpDelta, mpDelta, dispelled, healRoll, manaRoll };
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
 * Full resolve: template + builtin + name heuristics.
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
    POTION_EFFECTS,
    resolveItemUseEffect,
    resolveUseForItemId,
    applyItemUseEffect,
    applyManaDelta,
    dispelConditions,
    rollRange,
    effectFromNameHint,
    normalizeItemId
};
