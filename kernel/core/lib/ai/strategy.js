/**
 * Strategy presets for player hunt AI (Stage 5).
 * Aggression, spell priority, keep-distance, flee thresholds.
 *
 * Weapon auto-attack is a content-mode feature (mode.features.autoAttack),
 * not an entry in spellPriority — see resolveAutoAttackId / tryAutoAttack.
 */

const { Settings } = require('../../../settings.js');

/** Built-in fallback when presets file is missing / browser cache empty. */
const DEFAULT_STRATEGIES = {
    version: 2,
    strategies: [
        {
            id: 'balanced',
            label: 'Balanced',
            aggression: 0.75,
            engageRange: 7,
            keepDistance: 1,
            fleeHpPercent: 0.15,
            healHpPercent: 0.35,
            healSpellId: 'heal_light',
            monstersToEngage: 1,
            returnToRoute: true,
            spellPriority: []
        },
        {
            id: 'guardian_aggro',
            label: 'Guardian Aggro',
            aggression: 0.95,
            engageRange: 7,
            keepDistance: 1,
            fleeHpPercent: 0.12,
            healHpPercent: 0.3,
            healSpellId: 'heal_light',
            monstersToEngage: 1,
            returnToRoute: true,
            spellPriority: ['front_sweep']
        },
        {
            id: 'scout_kite',
            label: 'Scout Kite',
            aggression: 0.7,
            engageRange: 8,
            keepDistance: 3,
            fleeHpPercent: 0.25,
            healHpPercent: 0.4,
            healSpellId: 'heal_light',
            monstersToEngage: 1,
            returnToRoute: true,
            spellPriority: ['piercing_shot']
        },
        {
            id: 'mystic_combo',
            label: 'Mystic Combo',
            aggression: 0.85,
            engageRange: 7,
            keepDistance: 1,
            fleeHpPercent: 0.2,
            healHpPercent: 0.35,
            healSpellId: 'heal_light',
            monstersToEngage: 1,
            returnToRoute: true,
            spellPriority: ['flurry_of_blows', 'double_jab']
        },
        {
            id: 'adept_caster',
            label: 'Adept Caster',
            aggression: 0.8,
            engageRange: 7,
            keepDistance: 3,
            fleeHpPercent: 0.3,
            healHpPercent: 0.45,
            healSpellId: 'heal_light',
            monstersToEngage: 1,
            returnToRoute: true,
            spellPriority: ['ember_bolt']
        },
        {
            id: 'warden_support',
            label: 'Warden Support',
            aggression: 0.75,
            engageRange: 7,
            keepDistance: 3,
            fleeHpPercent: 0.3,
            healHpPercent: 0.5,
            healSpellId: 'heal_light',
            monstersToEngage: 1,
            returnToRoute: true,
            spellPriority: ['ice_strike']
        }
    ]
};

/**
 * Normalize a strategy bag with Settings defaults.
 * @param {object|null} raw
 * @returns {object}
 */
function normalizeStrategy(raw) {
    const s = raw || {};
    const engageDefault =
        Settings.AI_ENGAGE_RANGE != null ? Settings.AI_ENGAGE_RANGE : 7;
    const fleeDefault =
        Settings.AI_FLEE_HP_PERCENT != null ? Settings.AI_FLEE_HP_PERCENT : 0.15;
    const rawPriority = Array.isArray(s.spellPriority)
        ? s.spellPriority.slice()
        : [];
    // Auto ids belong to mode feature, not strategy priority lists.
    const spellPriority = rawPriority.filter((id) => !isAutoAttackId(id));
    return {
        id: s.id || 'balanced',
        label: s.label || s.id || 'Balanced',
        aggression: clamp01(
            s.aggression != null ? s.aggression : 0.75
        ),
        engageRange:
            s.engageRange != null ? Math.max(1, s.engageRange | 0) : engageDefault,
        keepDistance:
            s.keepDistance != null
                ? Math.max(1, s.keepDistance | 0)
                : 1,
        fleeHpPercent: clamp01(
            s.fleeHpPercent != null ? s.fleeHpPercent : fleeDefault
        ),
        healHpPercent: clamp01(
            s.healHpPercent != null ? s.healHpPercent : 0.35
        ),
        healSpellId:
            s.healSpellId != null
                ? String(s.healSpellId)
                : s.healSpell != null
                  ? String(s.healSpell)
                  : 'heal_light',
        monstersToEngage:
            s.monstersToEngage != null
                ? Math.max(1, s.monstersToEngage | 0)
                : 1,
        returnToRoute: s.returnToRoute !== false,
        spellPriority
    };
}

/**
 * @param {number} v
 * @returns {number}
 */
function clamp01(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
}

/**
 * Current HP fraction 0–1.
 * @param {object} entity
 * @returns {number}
 */
function hpPercent(entity) {
    if (!entity || !entity.hp) return 0;
    const max = entity.hp.max > 0 ? entity.hp.max : 1;
    return Math.max(0, entity.hp.current) / max;
}

/**
 * Whether aggression roll allows engaging given nearby count.
 * Deterministic when Math.random is seeded: higher aggression → more likely.
 * Always true when nearby >= monstersToEngage and aggression >= 1.
 *
 * @param {object} strategy
 * @param {number} nearbyCount
 * @param {() => number} [rng]
 * @returns {boolean}
 */
function shouldEngage(strategy, nearbyCount, rng) {
    const st = strategy || normalizeStrategy(null);
    if (nearbyCount < (st.monstersToEngage || 1)) return false;
    if (st.aggression >= 1) return true;
    if (st.aggression <= 0) return false;
    const roll = typeof rng === 'function' ? rng() : Math.random();
    // Scale slightly by pack size so denser packs engage more often
    const boost = Math.min(0.2, (nearbyCount - 1) * 0.05);
    return roll <= Math.min(1, st.aggression + boost);
}

/**
 * Whether an id is a weapon auto swing (auto.attack bucket).
 * @param {string|null|undefined} id
 * @returns {boolean}
 */
function isAutoAttackId(id) {
    if (!id) return false;
    return (
        id === 'melee_auto' ||
        id === 'distance_auto' ||
        id === 'wand_auto' ||
        id === 'auto'
    );
}

/**
 * Pick first usable spell id from priority list.
 * Never returns auto-attack ids (mode feature handles those via tryAutoAttack).
 *
 * When `opts.canReach` is provided, spells that fail reach (including self-AoE
 * with no hostiles on the footprint) are skipped so later priority entries can
 * fire — e.g. radiant_crater out of blast range must not block spirit_javelin.
 *
 * @param {object} strategy
 * @param {object} attacker
 * @param {(spellId: string) => object|null} getSpell
 * @param {(attacker: object, spell: object) => boolean} canCast
 * @param {{ skipAuto?: boolean, canReach?: (attacker: object, spell: object) => boolean }} [opts]
 * @returns {string|null} spell id
 */
function pickSpellId(strategy, attacker, getSpell, canCast, opts) {
    const st = strategy || normalizeStrategy(null);
    const list = st.spellPriority || [];
    const canReach =
        opts && typeof opts.canReach === 'function' ? opts.canReach : null;
    for (let i = 0; i < list.length; i++) {
        const id = list[i];
        if (!id || isAutoAttackId(id)) continue;
        const spell = typeof getSpell === 'function' ? getSpell(id) : null;
        if (!spell) continue;
        if (typeof canCast === 'function' && !canCast(attacker, spell)) {
            continue;
        }
        if (canReach && !canReach(attacker, spell)) {
            continue;
        }
        return id;
    }
    return null;
}

/**
 * Index strategies array/object by id.
 * @param {object[]|Record<string, object>|{ strategies?: object[] }|null} data
 * @returns {Record<string, object>}
 */
function indexStrategies(data) {
    const out = Object.create(null);
    if (!data) return out;
    const list = Array.isArray(data)
        ? data
        : Array.isArray(data.strategies)
          ? data.strategies
          : data;
    if (Array.isArray(list)) {
        for (let i = 0; i < list.length; i++) {
            const s = list[i];
            if (s && s.id) out[s.id] = normalizeStrategy(s);
        }
        return out;
    }
    for (const k of Object.keys(list)) {
        const s = list[k];
        if (!s) continue;
        const id = s.id || k;
        out[id] = normalizeStrategy(Object.assign({ id }, s));
    }
    return out;
}

/**
 * Look up strategy by id with fallback chain.
 * @param {string|null} id
 * @param {Record<string, object>|null} table
 * @param {string} [classId] map class → default strategy id
 * @returns {object}
 */
function resolveStrategy(id, table, classId) {
    const t = table || indexStrategies(DEFAULT_STRATEGIES);
    if (id && t[id]) return t[id];
    const byClass = {
        guardian: 'guardian_aggro',
        scout: 'scout_kite',
        mystic: 'mystic_combo',
        adept: 'adept_caster',
        warden: 'warden_support',
        adventurer: 'balanced'
    };
    const mapped = classId && byClass[classId];
    if (mapped && t[mapped]) return t[mapped];
    if (t.balanced) return t.balanced;
    return normalizeStrategy(DEFAULT_STRATEGIES.strategies[0]);
}

module.exports = {
    DEFAULT_STRATEGIES,
    normalizeStrategy,
    hpPercent,
    shouldEngage,
    isAutoAttackId,
    pickSpellId,
    indexStrategies,
    resolveStrategy
};
