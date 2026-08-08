/**
 * Pure exp / skill try math (Phase A) + party share / personal rates (Phase C)
 * + optional live skill tries (Phase D) + offline training cost/ETA helpers.
 *
 * Weapon skills: geometric series from floor 10 (legacy-compatible).
 * Magic level: mana steps from ML 0 with per-step floor (server-shaped).
 * Level exp: classic cubic totalExp / toNext (cached).
 * Party share: legacy vocation formula; personal rates = additive × mults.
 * Skill tries: blood bucket, distance 2/1/0, shield full-zero only, mana→ML.
 * Training ETA: try-budget + online/offline/exercise (no shop GP/TC).
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

/** Default skill session knobs (Phase D pins; stages/prey deferred). */
const DEFAULT_SKILL_SESSION_RATES = Object.freeze({
    stageMult: 1,
    skillPrey: 0
});

/** Blood / shield training bucket (server parity: 30). */
const BLOOD_HIT_BUCKET = 30;
const SHIELD_BLOCK_BUCKET = 30;

/** Skill bags that train from weapon autos. */
const WEAPON_SKILL_BAGS = Object.freeze([
    'sword',
    'axe',
    'club',
    'fist',
    'melee',
    'distance'
]);

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
 * Frozen hunt session config (set by Simulator at session start).
 * Makes Phase C/D flags/rates authoritative during combat without threading
 * sessionConfig through every tryAttack call.
 * @type {ReturnType<typeof freezeExpSessionConfig>|null}
 */
let _activeSessionConfig = null;

/**
 * Pin or clear the active hunt session progression config.
 * @param {object|null|undefined} cfg freezeExpSessionConfig result, or null to clear
 */
function setActiveSessionConfig(cfg) {
    if (cfg && typeof cfg === 'object') {
        _activeSessionConfig = {
            expProgression: !!cfg.expProgression,
            skillProgression: !!cfg.skillProgression,
            partyShareEnabled: cfg.partyShareEnabled !== false,
            expRates: normalizeExpRates(cfg.expRates),
            skillRates: normalizeSkillSessionRates(cfg.skillRates)
        };
    } else {
        _activeSessionConfig = null;
    }
}

/**
 * @returns {ReturnType<typeof freezeExpSessionConfig>|null}
 */
function getActiveSessionConfig() {
    return _activeSessionConfig;
}

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

// ---------------------------------------------------------------------------
// Training cost / ETA tooling (offline calc; mirrors legacy site skilling math
// without shop GP/TC). Not used by live combat — see estimateSkillTraining.
// ---------------------------------------------------------------------------

/**
 * Exercise-weapon point delivery (legacy calculator constants).
 * Primary melee + distance share the same wall-clock rate; shielding / magic differ.
 * Vocation rates still affect total points — only delivery rate is equalized.
 */
const EXERCISE_POINTS_PER_SEC = Object.freeze({
    /** (610 * 500) / (500 * 2) — magic exercise */
    magic: 305,
    /** 14.4 / 2 */
    shielding: 7.2,
    /** 7.2 / 2 — sword/axe/club/distance (and other non-magic defaults) */
    default: 3.6
});

/** Exercise dummy efficiency factor (points needed /= factor). */
const EXERCISE_DUMMY_FACTOR = 1.1;

/** Charge durations for exercise weapon pack counts (seconds). */
const EXERCISE_WEAPON_SECONDS = Object.freeze({
    exercise: 1000,
    durable: 3600,
    lasting: 8 * 3600
});

/** Offline training points per real day (legacy site; distance unconfirmed there). */
const OFFLINE_POINTS_PER_DAY = Object.freeze({
    magic: 21600,
    distance: 10800,
    default: 10800
});

/** Classic online melee try rate: 1 try / 2s. */
const ONLINE_MELEE_POINTS_PER_SEC = 0.5;

/** Cap absurd ETAs (~1000 years) like the legacy calculator. */
const TRAINING_ETA_SECONDS_CAP = 31536000000;

/**
 * Cumulative points (tries or mana) from floor to `skillLevel`.
 * @param {string} skill
 * @param {number} skillLevel
 * @param {object} [rates]
 * @returns {number}
 */
function totalTrainingPoints(skill, skillLevel, rates) {
    const key = normalizeSkillKey(skill);
    if (key === 'magic') return totalManaForMagicLevel(skillLevel, rates);
    return totalSkillTries(skill, skillLevel, rates);
}

/**
 * Points (tries or mana) needed to go from `fromLevel` → `toLevel` (exclusive of
 * progress already banked at `fromLevel`). Uses engine cumulative formulas.
 *
 * @param {string} skill
 * @param {number} fromLevel
 * @param {number} toLevel
 * @param {object} [rates]
 * @returns {number}
 */
function skillTryCost(skill, fromLevel, toLevel, rates) {
    const key = normalizeSkillKey(skill);
    let from = Math.floor(Number(fromLevel));
    let to = Math.floor(Number(toLevel));
    if (!Number.isFinite(from)) from = key === 'magic' ? MAGIC_FLOOR : SKILL_FLOOR;
    if (!Number.isFinite(to)) to = from;
    if (to < from) {
        const tmp = from;
        from = to;
        to = tmp;
    }
    if (key === 'magic') {
        if (from < MAGIC_FLOOR) from = MAGIC_FLOOR;
        if (to < MAGIC_FLOOR) to = MAGIC_FLOOR;
    } else {
        if (from < SKILL_FLOOR) from = SKILL_FLOOR;
        if (to < SKILL_FLOOR) to = SKILL_FLOOR;
    }
    const raw = totalTrainingPoints(skill, to, rates) - totalTrainingPoints(skill, from, rates);
    return Math.max(0, Math.floor(raw));
}

/**
 * Apply loyalty % and optional double-skill event to a point budget.
 * @param {number} points
 * @param {{ loyalty?: number, double?: boolean }} [opts]
 * @returns {number} rounded points after modifiers
 */
function applyTrainingPointModifiers(points, opts) {
    const o = opts || {};
    let p = Math.max(0, Number(points) || 0);
    let loyalty = Math.floor(Number(o.loyalty) || 0);
    if (loyalty < 0) loyalty = 0;
    if (loyalty > 50) loyalty = 50;
    if (loyalty > 0) p = p / (1 + loyalty / 100);
    if (o.double) p = p / 2;
    return Math.round(p);
}

/**
 * @param {string} skill
 * @returns {number} exercise points per second
 */
function exercisePointsPerSec(skill) {
    const key = normalizeSkillKey(skill);
    if (key === 'magic') return EXERCISE_POINTS_PER_SEC.magic;
    if (key === 'shielding') return EXERCISE_POINTS_PER_SEC.shielding;
    return EXERCISE_POINTS_PER_SEC.default;
}

/**
 * Online points/s estimate (hunt / dummy style; not blood-accurate).
 * @param {string} skill
 * @param {{ accuracy?: number, hits?: number, manaPerSec?: number }} [opts]
 * @returns {number}
 */
function onlinePointsPerSec(skill, opts) {
    const o = opts || {};
    const key = normalizeSkillKey(skill);
    if (key === 'magic') {
        let mana = Math.floor(Number(o.manaPerSec) || 500);
        if (mana < 1) mana = 1;
        if (mana > 2000) mana = 2000;
        return mana;
    }
    if (key === 'shielding') {
        let hits = Math.floor(Number(o.hits) || 2);
        if (hits < 1) hits = 1;
        if (hits > 2) hits = 2;
        return hits / 2;
    }
    if (key === 'distance') {
        let acc = Math.floor(Number(o.accuracy) || 100);
        if (acc < 1) acc = 1;
        if (acc > 100) acc = 100;
        return acc / 100;
    }
    if (key === 'fishing') return 1;
    return ONLINE_MELEE_POINTS_PER_SEC;
}

/**
 * Offline points per real day.
 * @param {string} skill
 * @returns {number}
 */
function offlinePointsPerDay(skill) {
    const key = normalizeSkillKey(skill);
    if (key === 'magic') return OFFLINE_POINTS_PER_DAY.magic;
    if (key === 'distance') return OFFLINE_POINTS_PER_DAY.distance;
    if (key === 'fishing') return 0;
    return OFFLINE_POINTS_PER_DAY.default;
}

/**
 * Break seconds into y/d/h/m/s (legacy secondsToTime shape).
 * @param {number} inputSeconds
 * @returns {{ y: number, d: number, h: number, m: number, s: number }|null}
 */
function secondsToDuration(inputSeconds) {
    const total = Number(inputSeconds);
    if (!Number.isFinite(total) || total < 0) return null;
    if (total > TRAINING_ETA_SECONDS_CAP) return null;
    const secondsInAMinute = 60;
    const secondsInAnHour = 60 * secondsInAMinute;
    const secondsInADay = 24 * secondsInAnHour;
    const secondsInAYear = 365 * secondsInADay;
    const years = Math.floor(total / secondsInAYear);
    const daysSeconds = total % secondsInAYear;
    const days = Math.floor(daysSeconds / secondsInADay);
    const hourSeconds = total % secondsInADay;
    const hours = Math.floor(hourSeconds / secondsInAnHour);
    const minuteSeconds = hourSeconds % secondsInAnHour;
    const minutes = Math.floor(minuteSeconds / secondsInAMinute);
    const seconds = Math.ceil(minuteSeconds % secondsInAMinute);
    return {
        y: years,
        d: days,
        h: hours,
        m: minutes,
        s: seconds
    };
}

/**
 * Pack exercise charge counts for a wall-clock training duration (no shop prices).
 * @param {number} inputSeconds
 * @returns {{ lasting: number, durable: number, exercise: number }|null}
 */
function secondsToExerciseWeapons(inputSeconds) {
    const total = Number(inputSeconds);
    if (!Number.isFinite(total) || total < 0) return null;
    if (total > TRAINING_ETA_SECONDS_CAP) return null;
    const { exercise: exSec, durable: durSec, lasting: lastSec } = EXERCISE_WEAPON_SECONDS;
    const lasting = Math.floor(total / lastSec);
    const durableSeconds = total % lastSec;
    const durable = Math.floor(durableSeconds / durSec);
    const exerciseSeconds = durableSeconds % durSec;
    const exercise = Math.round((exerciseSeconds / exSec) * 1e5) / 1e5;
    return { lasting, durable, exercise };
}

/**
 * Offline try-budget + approximate ETAs (online / offline / exercise).
 * Does **not** model blood buckets or live combat — lab/authoring only.
 * No shop GP/TC.
 *
 * @param {object} opts
 * @param {string} opts.skill
 * @param {number} opts.from
 * @param {number} opts.to
 * @param {object} [opts.rates] class skillRates
 * @param {number} [opts.loyalty=0] 0–50
 * @param {boolean} [opts.double=false] double-skill event
 * @param {boolean} [opts.dummy=false] exercise dummy (+10% efficiency)
 * @param {number} [opts.accuracy=100] online distance hit %
 * @param {number} [opts.hits=2] online shield hits per 2s window (1–2)
 * @param {number} [opts.manaPerSec=500] online mana spent per second
 * @returns {object}
 */
function estimateSkillTraining(opts) {
    const o = opts || {};
    const skillInput = o.skill != null ? String(o.skill) : 'melee';
    const skill = normalizeSkillKey(skillInput);
    const unit = skill === 'magic' ? 'mana' : 'tries';
    const rates = o.rates && typeof o.rates === 'object' ? o.rates : {};
    const from = o.from;
    const to = o.to;

    const rawPoints = skillTryCost(skill, from, to, rates);
    const points = applyTrainingPointModifiers(rawPoints, {
        loyalty: o.loyalty,
        double: o.double
    });
    const mult = skillMultiplier(skill, rates);

    const onlinePps = onlinePointsPerSec(skill, o);
    const onlineSeconds = onlinePps > 0 ? points / onlinePps : null;
    const online =
        onlineSeconds != null && onlineSeconds <= TRAINING_ETA_SECONDS_CAP
            ? {
                  pointsPerSec: onlinePps,
                  totalSeconds: onlineSeconds,
                  duration: secondsToDuration(onlineSeconds)
              }
            : {
                  pointsPerSec: onlinePps,
                  totalSeconds: null,
                  duration: null,
                  overflow: true
              };

    let offline = null;
    let exercise = null;
    const offlineDay = offlinePointsPerDay(skill);
    const supportsExercise =
        skill === 'magic' ||
        skill === 'shielding' ||
        skill === 'distance' ||
        skill === 'melee' ||
        skill === 'fist';

    if (supportsExercise && offlineDay > 0) {
        const offlinePps = offlineDay / 86400;
        const offlineSeconds = points / offlinePps;
        const offlineNoRegenSeconds = offlineSeconds / 2;
        offline = {
            pointsPerDay: offlineDay,
            pointsPerSec: offlinePps,
            totalSeconds:
                offlineSeconds <= TRAINING_ETA_SECONDS_CAP ? offlineSeconds : null,
            duration: secondsToDuration(offlineSeconds),
            noRegenTotalSeconds:
                offlineNoRegenSeconds <= TRAINING_ETA_SECONDS_CAP
                    ? offlineNoRegenSeconds
                    : null,
            noRegenDuration: secondsToDuration(offlineNoRegenSeconds)
        };

        let exercisePoints = points;
        if (o.dummy) {
            exercisePoints = Math.round(points / EXERCISE_DUMMY_FACTOR);
        }
        const exPps = exercisePointsPerSec(skill);
        const exSeconds = exPps > 0 ? exercisePoints / exPps : null;
        exercise = {
            pointsPerSec: exPps,
            points: exercisePoints,
            dummy: !!o.dummy,
            dummyFactor: o.dummy ? EXERCISE_DUMMY_FACTOR : 1,
            totalSeconds:
                exSeconds != null && exSeconds <= TRAINING_ETA_SECONDS_CAP
                    ? exSeconds
                    : null,
            duration: secondsToDuration(exSeconds),
            weapons: secondsToExerciseWeapons(exSeconds)
        };
    }

    return {
        skill,
        skillInput,
        from: Math.floor(Number(from)),
        to: Math.floor(Number(to)),
        unit,
        multiplier: mult,
        base: skillBase(skill),
        rawPoints,
        points,
        loyalty: Math.min(50, Math.max(0, Math.floor(Number(o.loyalty) || 0))),
        double: !!o.double,
        online,
        offline,
        exercise,
        note:
            'Approximate lab ETA (legacy-shaped). Live skillProgression uses combat grants; exercise rates equalize delivery across primary weapon families, not vocation try totals.'
    };
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
 * Normalize skill session knobs (stage mult + prey pin).
 * @param {object|null|undefined} raw
 * @returns {{ stageMult: number, skillPrey: number }}
 */
function normalizeSkillSessionRates(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const stage =
        r.stageMult != null
            ? _finiteOr(r.stageMult, DEFAULT_SKILL_SESSION_RATES.stageMult)
            : r.skillRateStages != null
              ? _finiteOr(r.skillRateStages, DEFAULT_SKILL_SESSION_RATES.stageMult)
              : DEFAULT_SKILL_SESSION_RATES.stageMult;
    const prey = _finiteOr(
        r.skillPrey != null ? r.skillPrey : r.prey,
        DEFAULT_SKILL_SESSION_RATES.skillPrey
    );
    return {
        stageMult: stage > 0 ? stage : DEFAULT_SKILL_SESSION_RATES.stageMult,
        skillPrey: prey >= 0 ? prey : DEFAULT_SKILL_SESSION_RATES.skillPrey
    };
}

/**
 * effectiveTries = floor(raw × stageMult × (1 + skillPrey))
 * @param {number} rawTries
 * @param {object|null|undefined} rates
 * @returns {number}
 */
function applySkillTryRates(rawTries, rates) {
    const raw = Math.max(0, Math.floor(Number(rawTries) || 0));
    const r = normalizeSkillSessionRates(rates);
    return Math.floor(raw * r.stageMult * (1 + r.skillPrey));
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
 *   expRates: ReturnType<typeof normalizeExpRates>,
 *   skillRates: ReturnType<typeof normalizeSkillSessionRates>
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
            expRates: normalizeExpRates(sc.expRates),
            skillRates: normalizeSkillSessionRates(sc.skillRates)
        };
    }

    // Hunt session freeze (Simulator) wins over Settings/mode for determinism
    if (_activeSessionConfig) {
        return {
            expProgression: _activeSessionConfig.expProgression,
            skillProgression: _activeSessionConfig.skillProgression,
            partyShareEnabled: _activeSessionConfig.partyShareEnabled,
            expRates: Object.assign({}, _activeSessionConfig.expRates),
            skillRates: Object.assign({}, _activeSessionConfig.skillRates)
        };
    }

    /** @type {object|null} */
    let settingsFeatures = null;
    /** @type {object|null} */
    let settingsRates = null;
    /** @type {object|null} */
    let settingsSkillRates = null;
    try {
        const { Settings } = require('../../../settings.js');
        if (Settings) {
            if (Settings.features && typeof Settings.features === 'object') {
                settingsFeatures = Settings.features;
            }
            if (Settings.expRates && typeof Settings.expRates === 'object') {
                settingsRates = Settings.expRates;
            }
            if (Settings.skillRates && typeof Settings.skillRates === 'object') {
                settingsSkillRates = Settings.skillRates;
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
    const skillRatesRaw =
        o.skillRates && typeof o.skillRates === 'object'
            ? o.skillRates
            : settingsSkillRates;

    return {
        expProgression: resolveFlag('expProgression', false),
        skillProgression: resolveFlag('skillProgression', false),
        partyShareEnabled: resolveFlag('partyShareEnabled', true),
        expRates: normalizeExpRates(ratesRaw),
        skillRates: normalizeSkillSessionRates(skillRatesRaw)
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
        expRates: Object.assign({}, cfg.expRates),
        skillRates: Object.assign({}, cfg.skillRates)
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
 * Skills are not changed here (Phase C). Rebuilds combat loadout on level change.
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
        rebuildPlayerCombatAfterProgression(player, { level: newLevel });
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

/**
 * Rebuild combat stats after level/skill change.
 * @param {object} player
 * @param {object} [skillOrLevelPatch]
 */
function rebuildPlayerCombatAfterProgression(player, skillOrLevelPatch) {
    if (!player) return;
    const patch = skillOrLevelPatch || {};
    if (player._loadoutOpts && typeof player._loadoutOpts === 'object') {
        if (patch.level != null) player._loadoutOpts.level = patch.level;
        if (player.skills) {
            player._loadoutOpts.baseSkills = Object.assign(
                {},
                player._loadoutOpts.baseSkills || {},
                player.skills
            );
            player._loadoutOpts.skills = player._loadoutOpts.baseSkills;
        }
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
            Object.assign({}, player._loadoutOpts || {}, patch)
        );
    }
}

/**
 * Class vocation skillRates for try→level curves.
 * @param {object|null|undefined} player
 * @returns {object|null}
 */
function resolvePlayerVocationSkillRates(player) {
    if (!player) return null;
    if (
        player._loadoutClassDef &&
        player._loadoutClassDef.skillRates &&
        typeof player._loadoutClassDef.skillRates === 'object'
    ) {
        return player._loadoutClassDef.skillRates;
    }
    if (player.skillRates && typeof player.skillRates === 'object') {
        return player.skillRates;
    }
    const classId = player.classId != null ? String(player.classId) : '';
    if (!classId) return null;
    try {
        const presets = require('../presets.js');
        const cls = presets.getClass(classId);
        if (cls && cls.skillRates) return cls.skillRates;
    } catch (_) {
        /* optional */
    }
    return null;
}

/**
 * Current skill level on player bag (subtype → melee fallback).
 * @param {object|null|undefined} player
 * @param {string} skill
 * @returns {number}
 */
function getPlayerSkillLevel(player, skill) {
    const key = skill != null ? String(skill).toLowerCase() : '';
    if (key === 'magic' || key === 'magiclevel' || key === 'ml') {
        const bag = player && player.skills;
        return Math.max(
            MAGIC_FLOOR,
            Math.floor(Number(bag && bag.magic) || MAGIC_FLOOR)
        );
    }
    const bag = player && player.skills;
    if (key === 'sword' || key === 'axe' || key === 'club') {
        if (bag && bag[key] != null) {
            return Math.max(SKILL_FLOOR, Math.floor(Number(bag[key]) || SKILL_FLOOR));
        }
        if (bag && bag.melee != null) {
            return Math.max(SKILL_FLOOR, Math.floor(Number(bag.melee) || SKILL_FLOOR));
        }
        return SKILL_FLOOR;
    }
    if (key === 'shield' || key === 'shielding') {
        return Math.max(
            SKILL_FLOOR,
            Math.floor(Number(bag && bag.shielding) || SKILL_FLOOR)
        );
    }
    if (key === 'fist') {
        if (bag && bag.fist != null) {
            return Math.max(SKILL_FLOOR, Math.floor(Number(bag.fist) || SKILL_FLOOR));
        }
        if (bag && bag.melee != null) {
            return Math.max(SKILL_FLOOR, Math.floor(Number(bag.melee) || SKILL_FLOOR));
        }
        return SKILL_FLOOR;
    }
    if (key === 'distance') {
        return Math.max(
            SKILL_FLOOR,
            Math.floor(Number(bag && bag.distance) || SKILL_FLOOR)
        );
    }
    // melee / unknown
    return Math.max(
        SKILL_FLOOR,
        Math.floor(Number(bag && bag.melee) || SKILL_FLOOR)
    );
}

/**
 * Write skill level onto player.skills (preserves sword/axe/club separately).
 * @param {object} player
 * @param {string} skill
 * @param {number} level
 */
function setPlayerSkillLevel(player, skill, level) {
    if (!player) return;
    if (!player.skills || typeof player.skills !== 'object') {
        player.skills = {};
    }
    const key = skill != null ? String(skill).toLowerCase() : '';
    const lv = Math.max(0, Math.floor(Number(level) || 0));
    if (key === 'magic' || key === 'magiclevel' || key === 'ml') {
        player.skills.magic = lv;
        return;
    }
    if (key === 'shield' || key === 'shielding') {
        player.skills.shielding = Math.max(SKILL_FLOOR, lv);
        return;
    }
    if (key === 'sword' || key === 'axe' || key === 'club') {
        player.skills[key] = Math.max(SKILL_FLOOR, lv);
        // Keep collapsed melee as max of subtypes + existing melee for old paths
        let best = player.skills.melee != null ? Number(player.skills.melee) || 0 : 0;
        for (const k of ['sword', 'axe', 'club', 'fist']) {
            if (player.skills[k] != null) {
                best = Math.max(best, Number(player.skills[k]) || 0);
            }
        }
        player.skills.melee = Math.max(SKILL_FLOOR, best);
        return;
    }
    if (key === 'fist') {
        player.skills.fist = Math.max(SKILL_FLOOR, lv);
        return;
    }
    if (key === 'distance') {
        player.skills.distance = Math.max(SKILL_FLOOR, lv);
        return;
    }
    player.skills.melee = Math.max(SKILL_FLOOR, lv);
}

/**
 * Ensure session counter bags exist on a player.
 * @param {object} player
 */
function ensureSkillCounterBags(player) {
    if (!player) return;
    if (!player.skillTriesGained || typeof player.skillTriesGained !== 'object') {
        player.skillTriesGained = Object.create(null);
    }
    if (player.skillTriesGained.total == null) player.skillTriesGained.total = 0;
    if (!player._skillTryProgress || typeof player._skillTryProgress !== 'object') {
        player._skillTryProgress = Object.create(null);
    }
    if (player.manaSpentTowardMagic == null) player.manaSpentTowardMagic = 0;
    if (player._manaTowardMagic == null) player._manaTowardMagic = 0;
    if (player.skillLevelsGained == null) player.skillLevelsGained = 0;
    if (player.magicLevelsGained == null) player.magicLevelsGained = 0;
    if (player.bloodHitCount == null) player.bloodHitCount = 0;
    if (player.shieldBlockCount == null) player.shieldBlockCount = 0;
}

/**
 * Credit raw skill tries (honest counters always). Advance skill levels only
 * when skillProgression is true.
 *
 * @param {object} player
 * @param {string} skill
 * @param {number} rawTries
 * @param {{
 *   skillProgression?: boolean,
 *   sessionConfig?: object,
 *   skillRates?: object,
 *   vocationRates?: object
 * }} [opts]
 * @returns {{
 *   rawTries: number,
 *   effectiveTries: number,
 *   levelsGained: number,
 *   oldLevel: number,
 *   newLevel: number,
 *   skill: string
 * }}
 */
function applySkillTries(player, skill, rawTries, opts) {
    const o = opts || {};
    const skillKey = skill != null ? String(skill).toLowerCase() : 'melee';
    const empty = {
        rawTries: 0,
        effectiveTries: 0,
        levelsGained: 0,
        oldLevel: getPlayerSkillLevel(player, skillKey),
        newLevel: getPlayerSkillLevel(player, skillKey),
        skill: skillKey
    };
    if (!player) return empty;

    const cfg = resolveExpSessionConfig(o);
    const sessionSkillRates = o.skillRates
        ? normalizeSkillSessionRates(o.skillRates)
        : cfg.skillRates;
    const raw = Math.max(0, Math.floor(Number(rawTries) || 0));
    const effective = applySkillTryRates(raw, sessionSkillRates);
    ensureSkillCounterBags(player);

    if (effective > 0) {
        player.skillTriesGained[skillKey] =
            (player.skillTriesGained[skillKey] || 0) + effective;
        player.skillTriesGained.total =
            (player.skillTriesGained.total || 0) + effective;
    }

    const oldLevel = getPlayerSkillLevel(player, skillKey);
    if (!cfg.skillProgression || effective <= 0) {
        return {
            rawTries: raw,
            effectiveTries: effective,
            levelsGained: 0,
            oldLevel,
            newLevel: oldLevel,
            skill: skillKey
        };
    }

    const vocationRates =
        o.vocationRates || resolvePlayerVocationSkillRates(player);
    let remaining = effective;
    let level = oldLevel;
    let progress = Math.max(
        0,
        Math.floor(Number(player._skillTryProgress[skillKey]) || 0)
    );

    // Cap multi-level loops (lab safety)
    let guard = 0;
    while (remaining > 0 && guard < 500) {
        guard += 1;
        const need = getReqSkillTries(skillKey, level + 1, vocationRates);
        if (need <= 0) {
            // At or above formula floor next — still allow advance with base
            const baseNeed = skillBase(skillKey);
            if (baseNeed <= 0) break;
            if (progress + remaining >= baseNeed) {
                remaining -= baseNeed - progress;
                progress = 0;
                level += 1;
                continue;
            }
            progress += remaining;
            remaining = 0;
            break;
        }
        if (progress + remaining >= need) {
            remaining -= need - progress;
            progress = 0;
            level += 1;
        } else {
            progress += remaining;
            remaining = 0;
        }
    }
    player._skillTryProgress[skillKey] = progress;
    const levelsGained = Math.max(0, level - oldLevel);
    if (levelsGained > 0) {
        setPlayerSkillLevel(player, skillKey, level);
        player.skillLevelsGained =
            (player.skillLevelsGained || 0) + levelsGained;
        rebuildPlayerCombatAfterProgression(player);
    }
    return {
        rawTries: raw,
        effectiveTries: effective,
        levelsGained,
        oldLevel,
        newLevel: level,
        skill: skillKey
    };
}

/**
 * Credit mana spent toward magic level. Counters always; ML up only if flag on.
 *
 * @param {object} player
 * @param {number} manaSpent
 * @param {{
 *   skillProgression?: boolean,
 *   sessionConfig?: object,
 *   skillRates?: object,
 *   vocationRates?: object
 * }} [opts]
 * @returns {{
 *   mana: number,
 *   levelsGained: number,
 *   oldLevel: number,
 *   newLevel: number
 * }}
 */
function applyManaTowardMagic(player, manaSpent, opts) {
    const o = opts || {};
    const empty = {
        mana: 0,
        levelsGained: 0,
        oldLevel: getPlayerSkillLevel(player, 'magic'),
        newLevel: getPlayerSkillLevel(player, 'magic')
    };
    if (!player) return empty;
    const mana = Math.max(0, Math.floor(Number(manaSpent) || 0));
    if (mana <= 0) return empty;

    const cfg = resolveExpSessionConfig(o);
    const sessionSkillRates = o.skillRates
        ? normalizeSkillSessionRates(o.skillRates)
        : cfg.skillRates;
    // Mana steps use same stage/prey pins as tries (effective mana credit)
    const effective = applySkillTryRates(mana, sessionSkillRates);
    ensureSkillCounterBags(player);
    player.manaSpentTowardMagic =
        (player.manaSpentTowardMagic || 0) + effective;

    const oldLevel = getPlayerSkillLevel(player, 'magic');
    if (!cfg.skillProgression || effective <= 0) {
        return {
            mana: effective,
            levelsGained: 0,
            oldLevel,
            newLevel: oldLevel
        };
    }

    const vocationRates =
        o.vocationRates || resolvePlayerVocationSkillRates(player);
    let remaining = effective;
    let ml = oldLevel;
    let progress = Math.max(
        0,
        Math.floor(Number(player._manaTowardMagic) || 0)
    );
    let guard = 0;
    while (remaining > 0 && guard < 500) {
        guard += 1;
        const need = getReqMana(ml + 1, vocationRates);
        if (need <= 0) break;
        if (progress + remaining >= need) {
            remaining -= need - progress;
            progress = 0;
            ml += 1;
        } else {
            progress += remaining;
            remaining = 0;
        }
    }
    player._manaTowardMagic = progress;
    const levelsGained = Math.max(0, ml - oldLevel);
    if (levelsGained > 0) {
        setPlayerSkillLevel(player, 'magic', ml);
        player.magicLevelsGained =
            (player.magicLevelsGained || 0) + levelsGained;
        rebuildPlayerCombatAfterProgression(player);
    }
    return {
        mana: effective,
        levelsGained,
        oldLevel,
        newLevel: ml
    };
}

/**
 * Classify hit outcome for skill training (server-shaped block types).
 * @param {object} result resolveAttack-like { hit, final, breakdown }
 * @returns {'miss'|'none'|'defense'|'armor'|'immunity'}
 */
function classifyAttackBlockType(result) {
    if (!result || !result.hit) return 'miss';
    const final = Math.max(0, Number(result.final) || 0);
    if (final > 0) return 'none';
    const bd = result.breakdown || {};
    if ((Number(bd.shieldBlock) || 0) > 0) return 'defense';
    if ((Number(bd.armorReduction) || 0) > 0) return 'armor';
    return 'immunity';
}

/**
 * Weapon skill bag for an auto spell + attacker loadout.
 * Wand/rod → null (mana only). Non-auto → null.
 *
 * @param {object|null|undefined} attacker
 * @param {object|null|undefined} spell
 * @returns {string|null}
 */
function resolveWeaponSkillBag(attacker, spell) {
    if (!spell || typeof spell !== 'object') return null;
    const kind = spell.kind != null ? String(spell.kind) : '';
    const id = spell.id != null ? String(spell.id) : '';
    // Only weapon autos train attack skills
    if (kind && kind !== 'auto') return null;
    if (id === 'wand_auto') return null;
    if (id === 'distance_auto') return 'distance';
    if (
        spell.powerCurve === 'distance_auto' ||
        (spell.requiresAmmo && id !== 'melee_auto')
    ) {
        return 'distance';
    }

    const stats =
        (attacker && (attacker.combatStats || attacker.effectiveStats)) || null;
    const ws = stats
        ? stats.weaponSkill != null
            ? String(stats.weaponSkill)
            : stats.skillKey != null
              ? String(stats.skillKey)
              : ''
        : '';

    if (ws === 'magic') return null;
    if (ws === 'distance') return 'distance';
    if (
        ws === 'sword' ||
        ws === 'axe' ||
        ws === 'club' ||
        ws === 'fist' ||
        ws === 'melee'
    ) {
        return ws;
    }
    if (
        id === 'melee_auto' ||
        spell.isMelee ||
        spell.powerCurve === 'melee_auto'
    ) {
        return ws || 'fist';
    }
    // Unknown auto without weapon skill → no bag
    if (kind === 'auto') return ws || null;
    return null;
}

/**
 * Whether defender currently trains shield (has shield equipped).
 * @param {object|null|undefined} defender
 * @returns {boolean}
 */
function defenderHasShield(defender) {
    if (!defender) return false;
    const stats =
        defender.combatStats || defender.effectiveStats || null;
    if (stats && stats.hasShield === true) return true;
    if (stats && stats.hasShield === false) return false;
    // Fallback: maxBlock path with shield flag missing — check equipment bag
    if (defender.equipment && typeof defender.equipment === 'object') {
        try {
            const { hasShieldDefense, rollupEquipment } = require('./stats.js');
            const gear = rollupEquipment(
                defender.equipment,
                defender._loadoutItemDb || null
            );
            return hasShieldDefense(gear);
        } catch (_) {
            /* optional */
        }
    }
    return false;
}

/**
 * After a resolved attack: blood bucket, weapon tries, shield full-zero tries.
 * Counters always; skill level mutations follow skillProgression.
 *
 * @param {object|null} attacker
 * @param {object|null} defender
 * @param {object} result resolveAttack result
 * @param {{
 *   sessionConfig?: object,
 *   skillProgression?: boolean,
 *   skillRates?: object,
 *   grantWeaponSkillTry?: boolean,
 *   blockChargeSpent?: boolean
 * }} [opts]
 * @returns {{
 *   weaponTries: number,
 *   shieldTries: number,
 *   blockType: string,
 *   weaponSkill: string|null,
 *   weaponAdvance: object|null,
 *   shieldAdvance: object|null
 * }}
 */
function processAttackSkillProgression(attacker, defender, result, opts) {
    const o = opts || {};
    const out = {
        weaponTries: 0,
        shieldTries: 0,
        blockType: 'miss',
        weaponSkill: null,
        weaponAdvance: null,
        shieldAdvance: null
    };
    if (!result || !result.ok) return out;

    const blockType = classifyAttackBlockType(result);
    out.blockType = blockType;
    const cfg = resolveExpSessionConfig(o);
    const sessionOpts = {
        sessionConfig: o.sessionConfig,
        skillProgression:
            typeof o.skillProgression === 'boolean'
                ? o.skillProgression
                : cfg.skillProgression,
        skillRates: o.skillRates || cfg.skillRates
    };

    // Design D.3: full damage on a training defender refills their shield bucket
    // (any attacker — tank can train after taking blood hits).
    if (
        result.hit &&
        blockType === 'none' &&
        defender &&
        defender.type === 'player'
    ) {
        ensureSkillCounterBags(defender);
        defender.shieldBlockCount = SHIELD_BLOCK_BUCKET;
    }

    // --- Attacker: blood bucket + weapon tries (players only) ---
    const grantWeapon = o.grantWeaponSkillTry !== false;
    if (
        grantWeapon &&
        attacker &&
        attacker.type === 'player' &&
        result.spell
    ) {
        ensureSkillCounterBags(attacker);
        const skillBag = resolveWeaponSkillBag(attacker, result.spell);
        out.weaponSkill = skillBag;

        let allowWeapon = false;
        if (result.hit && skillBag) {
            if (blockType === 'none') {
                // Full damage applied: draw blood
                attacker.bloodHitCount = BLOOD_HIT_BUCKET;
                allowWeapon = true;
            } else if (blockType === 'defense' || blockType === 'armor') {
                if ((attacker.bloodHitCount || 0) > 0) {
                    allowWeapon = true;
                    attacker.bloodHitCount = Math.max(
                        0,
                        (attacker.bloodHitCount || 0) - 1
                    );
                }
            }
            // immunity / miss → no weapon try
        }

        let rawTries = 0;
        if (allowWeapon && skillBag) {
            if (skillBag === 'distance') {
                if (blockType === 'none') rawTries = 2;
                else if (blockType === 'defense' || blockType === 'armor') {
                    rawTries = 1;
                }
            } else if (WEAPON_SKILL_BAGS.indexOf(skillBag) >= 0) {
                rawTries = 1;
            }
        }
        out.weaponTries = rawTries;
        if (rawTries > 0) {
            out.weaponAdvance = applySkillTries(
                attacker,
                skillBag,
                rawTries,
                sessionOpts
            );
        }
    }

    // --- Defender: shield try (full-zero + charge spent + shield equipped) ---
    if (
        defender &&
        defender.type === 'player' &&
        result.hit &&
        result.final === 0 &&
        o.blockChargeSpent
    ) {
        ensureSkillCounterBags(defender);
        if (
            defenderHasShield(defender) &&
            (defender.shieldBlockCount || 0) > 0
        ) {
            defender.shieldBlockCount = Math.max(
                0,
                (defender.shieldBlockCount || 0) - 1
            );
            out.shieldTries = 1;
            out.shieldAdvance = applySkillTries(
                defender,
                'shielding',
                1,
                sessionOpts
            );
        }
    }

    return out;
}

/**
 * Mana spent → magic level progression (hit not required).
 * @param {object|null} attacker
 * @param {number} manaCost
 * @param {object} [opts] same as applyManaTowardMagic
 * @returns {ReturnType<typeof applyManaTowardMagic>|null}
 */
function processManaSkillProgression(attacker, manaCost, opts) {
    if (!attacker || attacker.type !== 'player') return null;
    const cost = Math.max(0, Math.floor(Number(manaCost) || 0));
    if (cost <= 0) return null;
    return applyManaTowardMagic(attacker, cost, opts || {});
}

module.exports = {
    SKILL_BASE,
    MAGIC_MANA_BASE,
    SKILL_FLOOR,
    MAGIC_FLOOR,
    EXP_LEVEL_CACHE_MAX,
    DEFAULT_EXP_RATES,
    DEFAULT_SKILL_SESSION_RATES,
    BLOOD_HIT_BUCKET,
    SHIELD_BLOCK_BUCKET,
    WEAPON_SKILL_BAGS,
    EXERCISE_POINTS_PER_SEC,
    EXERCISE_DUMMY_FACTOR,
    EXERCISE_WEAPON_SECONDS,
    OFFLINE_POINTS_PER_DAY,
    ONLINE_MELEE_POINTS_PER_SEC,
    normalizeSkillKey,
    skillMultiplier,
    skillBase,
    getReqSkillTries,
    totalSkillTries,
    getReqMana,
    totalManaForMagicLevel,
    skillTryCost,
    applyTrainingPointModifiers,
    exercisePointsPerSec,
    onlinePointsPerSec,
    offlinePointsPerDay,
    secondsToDuration,
    secondsToExerciseWeapons,
    estimateSkillTraining,
    getExpForLevel,
    expToNext,
    levelFromExp,
    vocationKey,
    uniqueVocationCount,
    partyShareMultiplier,
    partySharePerMember,
    normalizeExpRates,
    applyPersonalExpRates,
    normalizeSkillSessionRates,
    applySkillTryRates,
    resolveExpSessionConfig,
    freezeExpSessionConfig,
    setActiveSessionConfig,
    getActiveSessionConfig,
    seedPlayerExperience,
    applyExpProgression,
    getPlayerSkillLevel,
    setPlayerSkillLevel,
    applySkillTries,
    applyManaTowardMagic,
    classifyAttackBlockType,
    resolveWeaponSkillBag,
    defenderHasShield,
    processAttackSkillProgression,
    processManaSkillProgression,
    resolvePlayerVocationSkillRates,
    ensureSkillCounterBags,
    rebuildPlayerCombatAfterProgression
};
