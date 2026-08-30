/**
 * Combat defaults for catalog → template bridges (Stage 9).
 * Art catalogs have no combat numbers; these fill gaps until rows gain a
 * `combat` object or an explicit presets/creatures|equipment override.
 */

'use strict';

const { DEFAULT_RESISTS } = require('../character/stats.js');

/**
 * Default offensive kit for catalog / bridge creatures with no attacks[].
 * Fixed min/max only — monsters never use player power curves.
 * Tuned as a weak pack hit (similar to cave_rat melee).
 */
const DEFAULT_CREATURE_MELEE_ATTACK = Object.freeze({
    id: 'melee_0',
    kind: 'melee',
    intervalMs: 2000,
    chance: 100,
    range: 1,
    element: 'physical',
    min: 0,
    max: 10
});

/**
 * Baseline combat template fields for any catalog creature without overrides.
 * Tuned as a weak pack mob (similar scale to cave_rat) so hunts stay short.
 * Offense lives in `attacks[]` only. Stand-off lives in `flags.targetDistance`.
 */
const DEFAULT_CREATURE_COMBAT = Object.freeze({
    hp: 50,
    hpMax: 50,
    /**
     * Absolute move speed (legacy monster `speed` field). Not scaled by
     * level or combat tier — only the template / catalog value applies.
     */
    speed: 100,
    /** Threat rank placeholder until measure+map; not an offense input. */
    level: 1,
    armor: 2,
    mitigation: 2,
    maxBlock: 0,
    exp: 15,
    lootValue: 1,
    aggro: true,
    canBlock: false,
    resists: Object.freeze(Object.assign({}, DEFAULT_RESISTS)),
    /** Ideal stand-off (melee hug = 1). */
    flags: Object.freeze({
        targetDistance: 1,
        runHealth: 0,
        staticAttackChance: 90,
        aggroRange: 7,
        loseTargetDistance: 12
    }),
    attacks: Object.freeze([DEFAULT_CREATURE_MELEE_ATTACK])
});

/**
 * Resolve creature movement speed from a template/opts value.
 * Finite numbers (including **0** for stationary dummies) are kept.
 * Missing / non-finite values fall back to DEFAULT_CREATURE_COMBAT.speed.
 * Creatures never gain speed from level — callers must not add level here.
 *
 * @param {number|string|null|undefined} value
 * @param {number} [fallback=DEFAULT_CREATURE_COMBAT.speed]
 * @returns {number}
 */
function resolveCreatureSpeed(value, fallback) {
    const def =
        fallback != null && Number.isFinite(Number(fallback))
            ? Math.max(0, Number(fallback))
            : DEFAULT_CREATURE_COMBAT.speed;
    if (value === undefined || value === null || value === '') {
        return def;
    }
    const n = Number(value);
    if (!Number.isFinite(n)) return def;
    return Math.max(0, n);
}

/**
 * Optional tier scales applied when catalog entry has `combatTier` or tag
 * matching a known tier id (tags take lower priority than combatTier field).
 * Multipliers apply to hp/exp/armor/mitigation and kit attack min/max
 * (not speed/level).
 */
const CREATURE_TIER_SCALES = Object.freeze({
    weak: 0.7,
    normal: 1,
    strong: 1.6,
    elite: 2.4,
    boss: 4
});

/**
 * Default combat stats by equipment category (assets/data catalog).
 * slot maps to character/stats EQUIPMENT_SLOTS naming.
 */
const EQUIPMENT_CATEGORY_DEFAULTS = Object.freeze({
    sword: Object.freeze({
        slot: 'rightHand',
        weaponType: 'melee',
        atk: 38,
        defense: 18,
        weight: 4500
    }),
    axe: Object.freeze({
        slot: 'rightHand',
        weaponType: 'melee',
        atk: 40,
        defense: 14,
        weight: 5200
    }),
    club: Object.freeze({
        slot: 'rightHand',
        weaponType: 'melee',
        atk: 36,
        defense: 16,
        weight: 5000
    }),
    mace: Object.freeze({
        slot: 'rightHand',
        weaponType: 'melee',
        atk: 37,
        defense: 15,
        weight: 5100
    }),
    dagger: Object.freeze({
        slot: 'rightHand',
        weaponType: 'melee',
        atk: 28,
        defense: 8,
        weight: 1200
    }),
    spear: Object.freeze({
        slot: 'rightHand',
        weaponType: 'distance',
        atk: 34,
        defense: 10,
        weight: 3000
    }),
    bow: Object.freeze({
        slot: 'rightHand',
        weaponType: 'distance',
        atk: 36,
        defense: 0,
        weight: 2800
    }),
    crossbow: Object.freeze({
        slot: 'rightHand',
        weaponType: 'distance',
        atk: 38,
        defense: 0,
        weight: 4200
    }),
    staff: Object.freeze({
        slot: 'rightHand',
        weaponType: 'magic',
        atk: 10,
        defense: 12,
        weight: 3000,
        skillBonuses: Object.freeze({ magic: 1 })
    }),
    wand: Object.freeze({
        slot: 'rightHand',
        weaponType: 'magic',
        atk: 8,
        defense: 6,
        weight: 1800,
        skillBonuses: Object.freeze({ magic: 2 })
    }),
    shield: Object.freeze({
        slot: 'leftHand',
        weaponType: 'shield',
        defense: 26,
        weight: 4500
    }),
    helmet: Object.freeze({
        slot: 'helmet',
        armor: 5,
        weight: 2800
    }),
    armor: Object.freeze({
        slot: 'armor',
        armor: 12,
        weight: 10000
    }),
    legs: Object.freeze({
        slot: 'legs',
        armor: 6,
        weight: 4000
    }),
    boots: Object.freeze({
        slot: 'boots',
        armor: 2,
        speed: 8,
        weight: 900
    }),
    ring: Object.freeze({
        slot: 'ring',
        armor: 0,
        weight: 90
    }),
    amulet: Object.freeze({
        slot: 'amulet',
        armor: 1,
        weight: 400
    }),
    tool: Object.freeze({
        weight: 2000
    })
});

/**
 * Combat field names copied from partial → template (when present).
 * @type {readonly string[]}
 */
const CREATURE_COMBAT_KEYS = Object.freeze([
    'hp',
    'hpMax',
    'speed',
    'level',
    'armor',
    'mitigation',
    'maxBlock',
    'exp',
    'lootValue',
    'aggro',
    'canBlock',
    'resists',
    'flags',
    'attacks',
    'defenseSpells'
]);

/**
 * Equipment combat field names that override category defaults when set.
 * @type {readonly string[]}
 */
const EQUIPMENT_COMBAT_KEYS = Object.freeze([
    'slot',
    'weaponType',
    'atk',
    'extraAtk',
    'extraAtkElement',
    'armor',
    'defense',
    'defenseBonus',
    'speed',
    'weight',
    'range',
    'skillBonuses',
    'resists',
    'durationSec',
    'charges',
    'regen',
    'flags'
]);

module.exports = {
    DEFAULT_CREATURE_MELEE_ATTACK,
    DEFAULT_CREATURE_COMBAT,
    resolveCreatureSpeed,
    CREATURE_TIER_SCALES,
    EQUIPMENT_CATEGORY_DEFAULTS,
    CREATURE_COMBAT_KEYS,
    EQUIPMENT_COMBAT_KEYS
};
