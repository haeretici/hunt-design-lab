/**
 * Pure exp / skill try math (Phase A) + party share / personal rates (Phase C).
 *
 * Weapon skills: geometric series from floor 10 (legacy-compatible).
 * Magic level: mana steps from ML 0 with per-step floor (server-shaped).
 * Level exp: classic cubic totalExp / toNext (cached).
 * Party share: legacy vocation formula; personal rates = additive × mults.
 *
 * @see docs/27_exp_skill_progression_plan.md
 */

'use strict';

/** Precomputed totalExp(level) for hot award / level-up paths. */
const EXP_LEVEL_CACHE_MAX = 2000;
/** @type {number[]} */
const EXP_FOR_LEVEL_CACHE = new Array(EXP_LEVEL_CACHE_MAX + 1);

function _fillExpForLevelCache() {
    EXP_FOR_LEVEL_CACHE[0] = 0;
    EXP_FOR_LEVEL_CACHE[1] = 0;
    for (let L = 2; L <= EXP_LEVEL_CACHE_MAX; L++) {
        EXP_FOR_LEVEL_CACHE[L] = Math.floor(
            (50 / 3) * (L * L * L - 6 * L * L + 17 * L - 12)
        );
    }
}
_fillExpForLevelCache();

/** Default personal exp rate bag (all neutral). */
const DEFAULT_EXP_RATES = Object.freeze({
    baseRate: 1,
    eventMult: 1,
    staminaMult: 1,
    additiveBonus: 0,
    prey: 0,
    xpBoost: 0
});

/** Tries base constants (legacy skillBase / skillConstants). */
const SKILL_BASE = Object.freeze({
    fist: 50,
    club: 50,
    sword: 50,
    axe: 50,
    melee: 50,
    distance: 30,
    shielding: 100,
    shield: 100,
    fishing: 20
});

/** Mana points per ML step base (legacy). */
const MAGIC_MANA_BASE = 1600;

/** Weapon skill floor (untrained). */
const SKILL_FLOOR = 10;

/** Magic level floor (untrained). */
const MAGIC_FLOOR = 0;

/**
 * Normalize skill bag key for rate / base lookup.
 * @param {string} skill
 * @returns {string}
 */
function normalizeSkillKey(skill) {
    const k = skill != null ? String(skill).toLowerCase() : '';
    if (k === 'shield' || k === 'shielding') return 'shielding';
    if (k === 'sword' || k === 'axe' || k === 'club') return 'melee';
    if (k === 'magiclevel' || k === 'magic_level' || k === 'ml') return 'magic';
    return k;
}

/**
 * Resolve vocation skill multiplier from a rates object.
 * @param {string} skill
 * @param {object} [rates] class skillRates { melee, fist, distance, shielding, magic }
 * @returns {number}
 */
function skillMultiplier(skill, rates) {
    const key = normalizeSkillKey(skill);
    const r = rates && typeof rates === 'object' ? rates : {};
    if (key === 'magic') {
        const m = r.magic != null ? Number(r.magic) : 1.1;
        return m > 1 ? m : 1.1;
    }
    if (key === 'fist') {
        const m = r.fist != null ? Number(r.fist) : r.melee != null ? Number(r.melee) : 1.1;
        return m > 1 ? m : 1.1;
    }
    if (key === 'distance') {
        const m = r.distance != null ? Number(r.distance) : 1.1;
        return m > 1 ? m : 1.1;
    }
    if (key === 'shielding') {
        const m = r.shielding != null ? Number(r.shielding) : 1.1;
        return m > 1 ? m : 1.1;
    }
    if (key === 'fishing') {
        const m = r.fishing != null ? Number(r.fishing) : 1.1;
        return m > 1 ? m : 1.1;
    }
    // melee / sword / axe / club
    const m = r.melee != null ? Number(r.melee) : 1.1;
    return m > 1 ? m : 1.1;
}

/**
 * Base try constant for a skill bag.
 * @param {string} skill
 * @returns {number}
 */
function skillBase(skill) {
    const key = normalizeSkillKey(skill);
    if (key === 'magic') return MAGIC_MANA_BASE;
    return SKILL_BASE[key] != null ? SKILL_BASE[key] : SKILL_BASE.melee;
}

/**
 * Tries required to advance from (skillLevel - 1) → skillLevel.
 * Skill levels ≤ 10 need 0 (already at floor).
 *
 * Formula: base × multiplier^(skillLevel − 11)  for skillLevel > 10
 *
 * @param {string} skill
 * @param {number} skillLevel target skill after advance
 * @param {object} [rates]
 * @returns {number} integer tries
 */
function getReqSkillTries(skill, skillLevel, rates) {
    const level = Math.floor(Number(skillLevel) || 0);
    if (level <= SKILL_FLOOR) return 0;
    const base = skillBase(skill);
    const m = skillMultiplier(skill, rates);
    return Math.floor(base * Math.pow(m, level - 11));
}

/**
 * Cumulative tries from skill floor (10) to reach `skillLevel`.
 * Geometric sum: base × (m^(S−10) − 1) / (m − 1)
 *
 * @param {string} skill
 * @param {number} skillLevel
 * @param {object} [rates]
 * @returns {number}
 */
function totalSkillTries(skill, skillLevel, rates) {
    const level = Math.floor(Number(skillLevel) || 0);
    if (level <= SKILL_FLOOR) return 0;
    const base = skillBase(skill);
    const m = skillMultiplier(skill, rates);
    if (m <= 1) return Math.floor(base * (level - SKILL_FLOOR));
    return Math.floor((base * (Math.pow(m, level - SKILL_FLOOR) - 1)) / (m - 1));
}

/**
 * Mana required to advance from (ml - 1) → ml (server-shaped floor).
 * @param {number} magicLevel target ML after advance
 * @param {object} [rates] uses rates.magic as mana multiplier
 * @returns {number}
 */
function getReqMana(magicLevel, rates) {
    const ml = Math.floor(Number(magicLevel) || 0);
    if (ml <= MAGIC_FLOOR) return 0;
    const mult = skillMultiplier('magic', rates);
    return Math.floor(MAGIC_MANA_BASE * Math.pow(mult, ml - 1));
}

/**
 * Cumulative mana from ML 0 to reach `magicLevel` (sum of floored steps).
 * @param {number} magicLevel
 * @param {object} [rates]
 * @returns {number}
 */
function totalManaForMagicLevel(magicLevel, rates) {
    const ml = Math.floor(Number(magicLevel) || 0);
    if (ml <= MAGIC_FLOOR) return 0;
    let total = 0;
    for (let i = 1; i <= ml; i++) {
        total += getReqMana(i, rates);
    }
    return total;
}

/**
 * Total experience required to *be* at `level` (level 1 → 0).
 * Classic cubic: (50/3) × (L³ − 6L² + 17L − 12)
 *
 * @param {number} level
 * @returns {number}
 */
function getExpForLevel(level) {
    const L = Math.floor(Number(level) || 0);
    if (L <= 1) return 0;
    if (L <= EXP_LEVEL_CACHE_MAX) return EXP_FOR_LEVEL_CACHE[L];
    return Math.floor((50 / 3) * (L * L * L - 6 * L * L + 17 * L - 12));
}

/**
 * Exp needed to go from `level` → `level + 1`.
 * Closed form: 50L² − 150L + 200
 *
 * @param {number} level current level
 * @returns {number}
 */
function expToNext(level) {
    const L = Math.floor(Number(level) || 0);
    if (L < 1) return getExpForLevel(2);
    return 50 * L * L - 150 * L + 200;
}

/**
 * Highest level whose totalExp ≤ experience.
 * @param {number} experience
 * @returns {number}
 */
function levelFromExp(experience) {
    const exp = Math.max(0, Math.floor(Number(experience) || 0));
    if (exp <= 0) return 1;
    let lo = 1;
    let hi = EXP_LEVEL_CACHE_MAX;
    while (lo < hi) {
        const mid = Math.floor((lo + hi + 1) / 2);
        if (getExpForLevel(mid) <= exp) lo = mid;
        else hi = mid - 1;
    }
    // Beyond cache: extend linearly with closed form
    if (lo >= EXP_LEVEL_CACHE_MAX && getExpForLevel(EXP_LEVEL_CACHE_MAX) <= exp) {
        let L = EXP_LEVEL_CACHE_MAX;
        while (getExpForLevel(L + 1) <= exp && L < 10000) L += 1;
        return L;
    }
    return lo;
}

/**
 * Base vocation key for party share diversity (standard class id).
 * @param {object|string|null|undefined} memberOrClassId
 * @returns {string}
 */
function vocationKey(memberOrClassId) {
    if (memberOrClassId == null) return 'adventurer';
    if (typeof memberOrClassId === 'string') {
        const s = memberOrClassId.trim().toLowerCase();
        return s || 'adventurer';
    }
    const id =
        memberOrClassId.classId != null
            ? memberOrClassId.classId
            : memberOrClassId.vocation != null
              ? memberOrClassId.vocation
              : memberOrClassId.class;
    const s = id != null ? String(id).trim().toLowerCase() : '';
    return s || 'adventurer';
}

/**
 * Unique base vocations among members (capped at 4, legacy-shaped).
 * @param {Array<object|string>} members
 * @returns {number} 1..4
 */
function uniqueVocationCount(members) {
    const set = new Set();
    const list = Array.isArray(members) ? members : [];
    for (let i = 0; i < list.length; i++) {
        if (set.size >= 4) break;
        const m = list[i];
        if (!m) continue;
        set.add(vocationKey(m));
    }
    return Math.max(1, set.size);
}

/**
 * Party shared-exp pot multiplier (before ÷N).
 * Legacy: (0.1·V²) − (0.2·V) + 1.3; if N≥4 subtract 0.1.
 *
 * @param {number} uniqueVocations V in 1..4
 * @param {number} partySize N ≥ 1
 * @returns {number}
 */
function partyShareMultiplier(uniqueVocations, partySize) {
    const V = Math.max(1, Math.min(4, Math.floor(Number(uniqueVocations) || 1)));
    const N = Math.max(1, Math.floor(Number(partySize) || 1));
    let mul = 0.1 * V * V - 0.2 * V + 1.3;
    if (N >= 4) mul -= 0.1;
    return mul;
}

/**
 * Per-member **raw** exp after party composition formula, before personal rates.
 * Solo (N=1): full monster exp. N≥2: ceil(monsterExp × shareMul / N).
 * When partyShareEnabled is false and N≥2: ceil(monsterExp / N).
 *
 * @param {number} monsterExp
 * @param {{
 *   partySize: number,
 *   uniqueVocations?: number,
 *   members?: Array<object|string>,
 *   partyShareEnabled?: boolean
 * }} opts
 * @returns {{ personalRaw: number, shareMul: number, partySize: number, uniqueVocations: number }}
 */
function partySharePerMember(monsterExp, opts) {
    const o = opts || {};
    const exp = Math.max(0, Number(monsterExp) || 0);
    const N = Math.max(
        1,
        Math.floor(
            o.partySize != null
                ? Number(o.partySize)
                : Array.isArray(o.members)
                  ? o.members.length
                  : 1
        ) || 1
    );
    const V =
        o.uniqueVocations != null
            ? Math.max(1, Math.min(4, Math.floor(Number(o.uniqueVocations) || 1)))
            : Array.isArray(o.members)
              ? uniqueVocationCount(o.members)
              : 1;
    const shareOn = o.partyShareEnabled !== false;

    if (N === 1) {
        return {
            personalRaw: Math.ceil(exp),
            shareMul: 1,
            partySize: 1,
            uniqueVocations: V
        };
    }
    if (!shareOn) {
        return {
            personalRaw: Math.ceil(exp / N),
            shareMul: 1,
            partySize: N,
            uniqueVocations: V
        };
    }
    const shareMul = partyShareMultiplier(V, N);
    return {
        personalRaw: Math.ceil((exp * shareMul) / N),
        shareMul,
        partySize: N,
        uniqueVocations: V
    };
}

/**
 * @param {unknown} n
 * @param {number} fallback
 * @returns {number}
 */
function _finiteOr(n, fallback) {
    const v = Number(n);
    return Number.isFinite(v) ? v : fallback;
}

/**
 * Normalize personal exp rate knobs.
 * @param {object|null|undefined} raw
 * @returns {{
 *   baseRate: number,
 *   eventMult: number,
 *   staminaMult: number,
 *   additiveBonus: number,
 *   prey: number,
 *   xpBoost: number
 * }}
 */
function normalizeExpRates(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const pos = (v, d) => {
        const n = _finiteOr(v, d);
        return n > 0 ? n : d;
    };
    const nonNeg = (v, d) => {
        const n = _finiteOr(v, d);
        return n >= 0 ? n : d;
    };
    return {
        baseRate: pos(r.baseRate, DEFAULT_EXP_RATES.baseRate),
        eventMult: pos(r.eventMult, DEFAULT_EXP_RATES.eventMult),
        staminaMult: pos(r.staminaMult, DEFAULT_EXP_RATES.staminaMult),
        additiveBonus: nonNeg(r.additiveBonus, DEFAULT_EXP_RATES.additiveBonus),
        prey: nonNeg(r.prey, DEFAULT_EXP_RATES.prey),
        xpBoost: nonNeg(r.xpBoost, DEFAULT_EXP_RATES.xpBoost)
    };
}

/**
 * Apply personal rate bag to party-share raw exp.
 * awarded = floor(raw × (1 + additiveBonus + prey + xpBoost) × baseRate × eventMult × staminaMult)
 *
 * @param {number} personalRaw
 * @param {object|null|undefined} rates
 * @returns {number}
 */
function applyPersonalExpRates(personalRaw, rates) {
    const raw = Math.max(0, Number(personalRaw) || 0);
    const r = normalizeExpRates(rates);
    const additiveFactor = 1 + r.additiveBonus + r.prey + r.xpBoost;
    const mult = r.baseRate * r.eventMult * r.staminaMult;
    return Math.floor(raw * additiveFactor * mult);
}

/**
 * Resolve progression feature + rates.
 * Priority: explicit opts → Settings override → mode.features → default false/1.
 * Prefer a frozen `sessionConfig` when awarding inside a hunt (determinism).
 *
 * @param {object|null|undefined} [opts]
 * @returns {{
 *   expProgression: boolean,
 *   skillProgression: boolean,
 *   partyShareEnabled: boolean,
 *   expRates: ReturnType<typeof normalizeExpRates>
 * }}
 */
function resolveExpSessionConfig(opts) {
    const o = opts || {};
    if (o.sessionConfig && typeof o.sessionConfig === 'object') {
        const sc = o.sessionConfig;
        return {
            expProgression: !!sc.expProgression,
            skillProgression: !!sc.skillProgression,
            partyShareEnabled: sc.partyShareEnabled !== false,
            expRates: normalizeExpRates(sc.expRates)
        };
    }

    /** @type {object|null} */
    let settingsFeatures = null;
    /** @type {object|null} */
    let settingsRates = null;
    try {
        const { Settings } = require('../../../settings.js');
        if (Settings) {
            if (Settings.features && typeof Settings.features === 'object') {
                settingsFeatures = Settings.features;
            }
            if (Settings.expRates && typeof Settings.expRates === 'object') {
                settingsRates = Settings.expRates;
            }
        }
    } catch (_) {
        /* Settings optional */
    }

    /** @type {object|null} */
    let modeFeatures = null;
    try {
        const { getActiveMode } = require('../modes.js');
        const m = getActiveMode();
        if (m && m.features && typeof m.features === 'object') {
            modeFeatures = m.features;
        }
    } catch (_) {
        /* modes optional */
    }

    function resolveFlag(name, defaultValue) {
        if (typeof o[name] === 'boolean') return o[name];
        if (settingsFeatures && typeof settingsFeatures[name] === 'boolean') {
            return settingsFeatures[name];
        }
        if (modeFeatures && typeof modeFeatures[name] === 'boolean') {
            return modeFeatures[name];
        }
        return defaultValue;
    }

    const ratesRaw =
        o.expRates && typeof o.expRates === 'object'
            ? o.expRates
            : settingsRates;

    return {
        expProgression: resolveFlag('expProgression', false),
        skillProgression: resolveFlag('skillProgression', false),
        partyShareEnabled: resolveFlag('partyShareEnabled', true),
        expRates: normalizeExpRates(ratesRaw)
    };
}

/**
 * Snapshot config for a hunt session (piano-roll / determinism input).
 * @param {object|null|undefined} [opts] same as resolveExpSessionConfig
 * @returns {ReturnType<typeof resolveExpSessionConfig>}
 */
function freezeExpSessionConfig(opts) {
    const cfg = resolveExpSessionConfig(opts);
    return {
        expProgression: cfg.expProgression,
        skillProgression: cfg.skillProgression,
        partyShareEnabled: cfg.partyShareEnabled,
        expRates: Object.assign({}, cfg.expRates)
    };
}

/**
 * Ensure player.experience is set from level when missing.
 * @param {object} player
 * @returns {number} experience
 */
function seedPlayerExperience(player) {
    if (!player) return 0;
    if (player.experience != null && Number.isFinite(Number(player.experience))) {
        return Math.max(0, Math.floor(Number(player.experience)));
    }
    const level = Math.max(1, Math.floor(Number(player.level) || 1));
    const exp = getExpForLevel(level);
    player.experience = exp;
    return exp;
}

/**
 * Credit awarded exp to player.experience and level-up when thresholds cross.
 * Skills are not changed (Phase C). Rebuilds combat loadout on level change.
 *
 * @param {object} player
 * @param {number} awarded
 * @returns {{ levelUps: number, oldLevel: number, newLevel: number, experience: number }}
 */
function applyExpProgression(player, awarded) {
    if (!player) {
        return { levelUps: 0, oldLevel: 1, newLevel: 1, experience: 0 };
    }
    seedPlayerExperience(player);
    const gain = Math.max(0, Math.floor(Number(awarded) || 0));
    player.experience = Math.max(0, Math.floor(Number(player.experience) || 0)) + gain;
    const oldLevel = Math.max(1, Math.floor(Number(player.level) || 1));
    const newLevel = levelFromExp(player.experience);
    if (newLevel > oldLevel) {
        player.level = newLevel;
        if (player._loadoutOpts && typeof player._loadoutOpts === 'object') {
            player._loadoutOpts.level = newLevel;
        }
        if (typeof player._rebuildCombatStatsFromLoadout === 'function') {
            player._rebuildCombatStatsFromLoadout();
        } else if (
            typeof player.applyClassLoadout === 'function' &&
            player._loadoutClassDef
        ) {
            player.applyClassLoadout(
                player._loadoutClassDef,
                player._loadoutItemDb,
                Object.assign({}, player._loadoutOpts || {}, { level: newLevel })
            );
        }
        return {
            levelUps: newLevel - oldLevel,
            oldLevel,
            newLevel,
            experience: player.experience
        };
    }
    return {
        levelUps: 0,
        oldLevel,
        newLevel: oldLevel,
        experience: player.experience
    };
}

module.exports = {
    SKILL_BASE,
    MAGIC_MANA_BASE,
    SKILL_FLOOR,
    MAGIC_FLOOR,
    EXP_LEVEL_CACHE_MAX,
    DEFAULT_EXP_RATES,
    normalizeSkillKey,
    skillMultiplier,
    skillBase,
    getReqSkillTries,
    totalSkillTries,
    getReqMana,
    totalManaForMagicLevel,
    getExpForLevel,
    expToNext,
    levelFromExp,
    vocationKey,
    uniqueVocationCount,
    partyShareMultiplier,
    partySharePerMember,
    normalizeExpRates,
    applyPersonalExpRates,
    resolveExpSessionConfig,
    freezeExpSessionConfig,
    seedPlayerExperience,
    applyExpProgression
};
