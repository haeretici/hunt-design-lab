/**
 * Pure combat damage pipeline (Stage 4).
 *
 * Pipeline order (fixed, document once — see docs/09_combat_and_classes.md):
 *   1. Roll raw from min/max (melee/distance auto non-crit = gaussian;
 *      other curves uniform). Crit: ST melee/distance auto raises the floor
 *      (`auto_st`); everything else multiplies after the same non-crit roll.
 *   1c. Fatal (player weapon `tier` > 0): independent roll after crit;
 *      `raw + round(raw × 0.6)`. Heal / miss skip.
 *   2. Mitigation (% of raw)
 *   3. Element resist (% of remaining after mitigation)
 *   4. Shield block (optional; physical + melee only; ≤2 per 2s window)
 *   5. Armor reduction (physical only; legacy [ceil(a/2), ceil(a/2)*2-1])
 *   6. Floor at 0, integer final
 *
 * Weapon auto (melee/fist + distance) follows classic stepped levelBonus and
 * skill×atk curves. Strikes (melee_strike / magic_strike) use mean damage from
 * basePower coefficients (option B) ± spell damageAmplitude.
 */

const { Settings } = require('../../../settings.js');

/** ST melee/distance auto: raise floor then uniform in the band. */
const CRIT_BAND_AUTO_ST = 'auto_st';
/** Default: same non-crit generator, then × (1 + critDamage/100). */
const CRIT_BAND_MULTIPLY = 'multiply';
/** Floor fraction of max for `auto_st` (Q3: then max with min). */
const AUTO_ST_CRIT_FLOOR = 0.65;
/** Fatal chance `A t² + B t + C` percent (weapon `tier` t > 0). */
const FATAL_CHANCE_A = 0.05;
const FATAL_CHANCE_B = 0.4;
const FATAL_CHANCE_C = 0.05;
/** Extra fraction of post-crit raw on a fatal proc. */
const FATAL_DAMAGE_BONUS = 0.6;

/** @typedef {'physical'|'fire'|'ice'|'energy'|'earth'|'holy'|'death'|'healing'} DamageElement */

/**
 * @typedef {{ min: { x: number, y: number }, max: { x: number, y: number } }} SpellParams
 */

/** Cache of spell coefficient params by basePower (integers). */
const spellParamCache = {
    magic: Object.create(null),
    melee: Object.create(null)
};

/**
 * Round to 4 decimal places (legacy toFixed(4) as number).
 * @param {number} n
 * @returns {number}
 */
function round4(n) {
    return Math.round(Number(n) * 1e4) / 1e4;
}

/**
 * Clamp damageAmplitude (half-width fraction). Missing/invalid → 0.
 * @param {number|null|undefined} amplitude
 * @returns {number}
 */
function normalizeDamageAmplitude(amplitude) {
    if (amplitude == null || amplitude === '') return 0;
    const a = Number(amplitude);
    if (!Number.isFinite(a) || a <= 0) return 0;
    return Math.min(0.95, a);
}

/**
 * Default weapon-auto skill×atk factor (melee/fist + distance). +20% vs classic 0.085.
 * @returns {number}
 */
function weaponAutoFactor() {
    return Settings.COMBAT_MELEE_AUTO_FACTOR != null
        ? Settings.COMBAT_MELEE_AUTO_FACTOR
        : 0.102;
}

/**
 * Classic stepped level contribution to damage floor/ceiling.
 *
 * Bands of width (step × 100), starting step 5 (+1 dmg every 5 levels to 500),
 * then step 6 (501–1100), 7 (1101–1800), … continuing the same pattern.
 *
 * @param {number} level
 * @returns {number}
 */
function levelBonus(level) {
    let remaining = Math.max(0, Math.floor(Number(level) || 0));
    let bonus = 0;
    let step = 5;
    while (remaining > 0) {
        const bandSize = step * 100;
        const inBand = Math.min(remaining, bandSize);
        bonus += Math.floor(inBand / step);
        remaining -= inBand;
        step += 1;
    }
    return bonus;
}

/**
 * Magic spell min/max coefficients from basePower (legacy polynomial).
 * Cached per basePower.
 *
 * @param {number} basePower
 * @returns {SpellParams}
 */
function getMagicSpellParameters(basePower) {
    const bp = Math.max(0, Number(basePower) || 0);
    const key = String(bp);
    if (spellParamCache.magic[key] !== undefined) {
        return spellParamCache.magic[key];
    }
    const x1 =
        -3.096 * Math.pow(10, -8) * Math.pow(bp, 3) +
        5.304 * Math.pow(10, -5) * Math.pow(bp, 2) +
        0.01499 * bp +
        0.705;
    const x2 =
        x1 *
        Math.max(
            7.383 * Math.pow(10, -8) * Math.pow(bp, 3) -
                6.507 * Math.pow(10, -5) * Math.pow(bp, 2) +
                0.01571 * bp +
                0.747,
            1.5
        );
    const params = {
        min: {
            x: round4(x1),
            y: Math.max(Math.round(0.203 * bp - 4.34), 2)
        },
        max: {
            x: round4(x2),
            y: Math.max(Math.round(0.302 * bp), 3)
        }
    };
    spellParamCache.magic[key] = params;
    return params;
}

/**
 * Melee spell min/max coefficients from basePower (legacy polynomial).
 * Cached per basePower.
 *
 * @param {number} basePower
 * @returns {SpellParams}
 */
function getMeleeSpellParameters(basePower) {
    const bp = Math.max(0, Number(basePower) || 0);
    const key = String(bp);
    if (spellParamCache.melee[key] !== undefined) {
        return spellParamCache.melee[key];
    }
    const x1 =
        -0.01567 +
        0.002391 * bp -
        0.000041 * (bp * bp) +
        0.000000268 * Math.pow(bp, 3);
    const x2 = x1 * 1.77;
    const params = {
        min: {
            x: round4(x1),
            y: Math.max(Math.round(0.203 * bp - 4.34), 2)
        },
        max: {
            x: round4(x2),
            y: Math.max(Math.round(0.302 * bp), 3)
        }
    };
    spellParamCache.melee[key] = params;
    return params;
}

/**
 * Mean coefficients (option B): average of min/max x and y.
 * @param {SpellParams} params
 * @returns {{ x: number, y: number }}
 */
function meanCoefficients(params) {
    return {
        x: (params.min.x + params.max.x) / 2,
        y: (params.min.y + params.max.y) / 2
    };
}

/**
 * Legacy magic raw min/max (for amplitude calibration / reference).
 *   min = round(lb + magic * min.x + min.y)
 *   max = round(lb + magic * max.x + max.y)
 *
 * @param {{ level?: number, magic?: number }} attacker
 * @param {number} basePower
 * @returns {{ min: number, max: number }}
 */
function computeLegacyMagicStrikeRange(attacker, basePower) {
    const lb = levelBonus(attacker && attacker.level);
    const magic = Math.max(0, Number(attacker && attacker.magic) || 0);
    const p = getMagicSpellParameters(basePower);
    const min = Math.round(lb + magic * p.min.x + p.min.y);
    const max = Math.round(lb + magic * p.max.x + p.max.y);
    return { min, max: Math.max(min, max) };
}

/**
 * Legacy melee strike raw min/max (for amplitude calibration / reference).
 *   min = lb + ceil(skill * atk * min.x) + min.y
 *   max = lb + ceil(skill * atk * max.x) + max.y
 *
 * @param {{ level?: number, atk?: number, skill?: number }} attacker
 * @param {number} basePower
 * @returns {{ min: number, max: number }}
 */
function computeLegacyMeleeStrikeRange(attacker, basePower) {
    const lb = levelBonus(attacker && attacker.level);
    const atk = Math.max(0, Number(attacker && attacker.atk) || 0);
    const skill = Math.max(0, Number(attacker && attacker.skill) || 0);
    const p = getMeleeSpellParameters(basePower);
    const min = lb + Math.ceil(skill * atk * p.min.x) + p.min.y;
    const max = lb + Math.ceil(skill * atk * p.max.x) + p.max.y;
    return { min, max: Math.max(min, max) };
}

/**
 * Magic mean damage (option B).
 *   mean = lb + magic * x̄ + ȳ
 *
 * @param {{ level?: number, magic?: number }} attacker
 * @param {number} basePower
 * @returns {number}
 */
function computeMagicMean(attacker, basePower) {
    const lb = levelBonus(attacker && attacker.level);
    const magic = Math.max(0, Number(attacker && attacker.magic) || 0);
    const mid = meanCoefficients(getMagicSpellParameters(basePower));
    return lb + magic * mid.x + mid.y;
}

/**
 * Melee strike mean damage (option B).
 *   mean = lb + skill * atk * x̄ + ȳ
 *
 * @param {{ level?: number, atk?: number, skill?: number }} attacker
 * @param {number} basePower
 * @returns {number}
 */
function computeMeleeMean(attacker, basePower) {
    const lb = levelBonus(attacker && attacker.level);
    const atk = Math.max(0, Number(attacker && attacker.atk) || 0);
    const skill = Math.max(0, Number(attacker && attacker.skill) || 0);
    const mid = meanCoefficients(getMeleeSpellParameters(basePower));
    return lb + skill * atk * mid.x + mid.y;
}

/**
 * Build min/max from mean and half-width amplitude.
 * amplitude 0 → min === max === round(mean).
 *
 * @param {number} mean
 * @param {number|null|undefined} amplitude
 * @returns {{ min: number, max: number }}
 */
function rangeFromMean(mean, amplitude) {
    const m = Math.max(0, Number(mean) || 0);
    const a = normalizeDamageAmplitude(amplitude);
    if (a <= 0) {
        const v = Math.max(0, Math.round(m));
        return { min: v, max: v };
    }
    let min = Math.round(m * (1 - a));
    let max = Math.round(m * (1 + a));
    if (min < 0) min = 0;
    if (max < min) max = min;
    return { min, max };
}

/**
 * Amplitude that matches legacy half-width around option-B mean.
 *   a = (legacyMax - legacyMin) / (2 * meanB)
 *
 * @param {number} legacyMin
 * @param {number} legacyMax
 * @param {number} meanB
 * @returns {number} rounded to 4 decimals, clamped
 */
function amplitudeFromLegacySpread(legacyMin, legacyMax, meanB) {
    const mean = Number(meanB) || 0;
    if (!(mean > 0)) return 0;
    const lo = Number(legacyMin) || 0;
    const hi = Number(legacyMax) || 0;
    const span = Math.max(0, hi - lo);
    if (span <= 0) return 0;
    return normalizeDamageAmplitude(round4(span / (2 * mean)));
}

/**
 * Weapon auto-attack raw min/max (melee, fist/unarmed, and distance).
 *   min = levelBonus
 *   max = ceil(factor × atk × skill + levelBonus)
 * Distance uses effective atk (ammo + weapon mod) already resolved on the
 * attacker bag.
 *
 * @param {{ level?: number, atk?: number, skill?: number }} attacker
 * @returns {{ min: number, max: number }}
 */
function computeMeleeAutoRange(attacker) {
    const lb = levelBonus(attacker.level);
    const atk = Math.max(0, Number(attacker.atk) || 0);
    const skill = Math.max(0, Number(attacker.skill) || 0);
    const factor = weaponAutoFactor();
    const min = lb;
    const max = Math.ceil(factor * atk * skill + lb);
    return { min, max: Math.max(min, max) };
}

/** Alias — same formula; atk on the bag is already distance-effective. */
const computeDistanceAutoRange = computeMeleeAutoRange;

/**
 * Melee strike spell raw min/max: option-B mean ± damageAmplitude.
 *
 * @param {{ level?: number, atk?: number, skill?: number }} attacker
 * @param {number} basePower
 * @param {number} [damageAmplitude=0]
 * @returns {{ min: number, max: number }}
 */
function computeMeleeStrikeRange(attacker, basePower, damageAmplitude) {
    const mean = computeMeleeMean(attacker, basePower);
    return rangeFromMean(mean, damageAmplitude);
}

/**
 * Magic / elemental strike raw min/max: option-B mean ± damageAmplitude.
 *
 * @param {{ level?: number, magic?: number }} attacker
 * @param {number} basePower
 * @param {number} [damageAmplitude=0]
 * @returns {{ min: number, max: number }}
 */
function computeMagicStrikeRange(attacker, basePower, damageAmplitude) {
    const mean = computeMagicMean(attacker, basePower);
    return rangeFromMean(mean, damageAmplitude);
}

/**
 * Power curve dispatch.
 * @param {string} curveId
 * @param {object} attacker Stat bag for formulas
 * @param {number} [basePower]
 * @param {number} [damageAmplitude]
 * @returns {{ min: number, max: number }}
 */
function computeDamageRange(curveId, attacker, basePower, damageAmplitude) {
    switch (curveId) {
        case 'melee_auto':
        case 'distance_auto':
            return computeMeleeAutoRange(attacker);
        case 'melee_strike':
            return computeMeleeStrikeRange(
                attacker,
                basePower,
                damageAmplitude
            );
        case 'magic_strike':
            return computeMagicStrikeRange(
                attacker,
                basePower,
                damageAmplitude
            );
        default:
            // Fixed range fallback (tests / dummy attacks)
            return {
                min: Math.max(0, Number(attacker.min) || 0),
                max: Math.max(
                    Number(attacker.min) || 0,
                    Number(attacker.max) || 0
                )
            };
    }
}

/**
 * Roll hit success. v1: simple percent chance (default 100 = always).
 * @param {number} [hitChance=100] 0–100
 * @param {() => number} [rng] returns [0,1); defaults to Math.random
 * @returns {boolean}
 */
function rollHit(hitChance, rng) {
    const chance = hitChance == null ? 100 : Number(hitChance);
    if (chance >= 100) return true;
    if (chance <= 0) return false;
    const r = typeof rng === 'function' ? rng() : Math.random();
    return r * 100 < chance;
}

/**
 * Whether a critical lands (critChance is 0–100).
 * @param {number} critChance
 * @param {() => number} [rng]
 * @returns {boolean}
 */
function rollCritical(critChance, rng) {
    const c = Math.max(0, Number(critChance) || 0);
    if (c <= 0) return false;
    if (c >= 100) return true;
    const r = typeof rng === 'function' ? rng() : Math.random();
    return r * 100 < c;
}

/**
 * Fatal chance in percent from weapon classification `tier`.
 * `t <= 0` or missing → 0. `t == 1` → 0.5.
 * @param {number|null|undefined} tier
 * @returns {number}
 */
function fatalChanceFromTier(tier) {
    const t = Math.floor(Number(tier) || 0);
    if (t <= 0) return 0;
    return FATAL_CHANCE_A * t * t + FATAL_CHANCE_B * t + FATAL_CHANCE_C;
}

/**
 * Independent fatal proc. `uniform[0, 10000] / 100 < fatalChance`.
 * Chance 0 skips rng.
 * @param {number} fatalChance percent
 * @param {() => number} [rng]
 * @returns {boolean}
 */
function rollFatal(fatalChance, rng) {
    const c = Number(fatalChance) || 0;
    if (!(c > 0)) return false;
    const r = typeof rng === 'function' ? rng() : Math.random();
    const sample = Math.floor(r * 10001);
    return sample / 100 < c;
}

/**
 * +60% of already-crit (or non-crit) raw.
 * @param {number} raw
 * @returns {number}
 */
function applyFatalBonus(raw) {
    const n = Math.max(0, Number(raw) || 0);
    return n + Math.round(n * FATAL_DAMAGE_BONUS);
}

function elementAllowsFatal(element) {
    const el = element || 'physical';
    return el !== 'healing' && el !== 'manadrain' && el !== 'undefined';
}

/**
 * N(0,1) via Marsaglia polar method. `rng` must return [0,1).
 * Guard breaks a degenerate constant-rng loop (tests / stuck LCG).
 * @param {() => number} rng
 * @returns {number}
 */
function sampleStandardNormal(rng) {
    let u;
    let v;
    let s;
    let guard = 0;
    do {
        u = 2 * rng() - 1;
        v = 2 * rng() - 1;
        s = u * u + v * v;
        if (++guard > 32) return 0;
    } while (s === 0 || s >= 1);
    return u * Math.sqrt((-2 * Math.log(s)) / s);
}

/**
 * Reference-server auto raw: sample N(μ=0.5, σ=0.25), reject outside [0,1],
 * map onto [min, max] inclusive.
 *
 * @param {number} min
 * @param {number} max
 * @param {() => number} [rng]
 * @returns {number}
 */
function normalRandom(min, max, rng) {
    const a = Math.min(Number(min) || 0, Number(max) || 0);
    const b = Math.max(Number(min) || 0, Number(max) || 0);
    if (a === b) return a;
    const rand = typeof rng === 'function' ? rng : Math.random;
    let unit;
    let guard = 0;
    do {
        unit = 0.5 + 0.25 * sampleStandardNormal(rand);
        if (++guard > 64) {
            unit = 0.5;
            break;
        }
    } while (unit < 0 || unit > 1);
    return a + Math.round(unit * (b - a));
}

function usesGaussianAutoRaw(powerCurve) {
    return powerCurve === 'melee_auto' || powerCurve === 'distance_auto';
}

/**
 * @param {{ critBand?: string }|null|undefined} opts
 * @returns {'auto_st'|'multiply'}
 */
function resolveCritBand(opts) {
    return opts && opts.critBand === CRIT_BAND_AUTO_ST
        ? CRIT_BAND_AUTO_ST
        : CRIT_BAND_MULTIPLY;
}

/**
 * Q3: `rollMin = max(min, floor(0.65 × max))`.
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function autoStCritRollMin(min, max) {
    const lo = Math.min(Number(min) || 0, Number(max) || 0);
    const hi = Math.max(Number(min) || 0, Number(max) || 0);
    const raised = Math.floor(AUTO_ST_CRIT_FLOOR * hi);
    const rollMin = Math.max(lo, raised);
    return rollMin > hi ? hi : rollMin;
}

/**
 * Roll raw in [min, max].
 *
 * `critBand: 'auto_st'` (ST melee/distance auto only): uniform in
 * `[autoStCritRollMin, max]`, then optional extra.
 * Default / `multiply`: same generator as a non-crit of that curve
 * (gaussian for melee/distance auto, else uniform), then optional extra.
 *
 * @param {number} min
 * @param {number} max
 * @param {boolean} [isCritical]
 * @param {number} [critDamageBonus=0] percent extra after roll
 * @param {() => number} [rng]
 * @param {{ powerCurve?: string, distribution?: string, critBand?: string }} [opts]
 * @returns {{ raw: number, critical: boolean }}
 */
function rollRawDamage(min, max, isCritical, critDamageBonus, rng, opts) {
    const lo = Math.min(Number(min) || 0, Number(max) || 0);
    const hi = Math.max(Number(min) || 0, Number(max) || 0);
    const useAutoStBand = !!isCritical && resolveCritBand(opts) === CRIT_BAND_AUTO_ST;
    const useGaussian =
        !useAutoStBand &&
        !!(
            opts &&
            (opts.distribution === 'gaussian' ||
                usesGaussianAutoRaw(opts.powerCurve))
        );
    let raw;
    if (useAutoStBand) {
        const rollMin = autoStCritRollMin(lo, hi);
        const rand = typeof rng === 'function' ? rng() : Math.random();
        raw = Math.floor(rollMin + rand * (hi - rollMin + 1));
        if (raw > hi) raw = hi;
    } else if (useGaussian) {
        raw = normalRandom(lo, hi, rng);
    } else {
        const rand = typeof rng === 'function' ? rng() : Math.random();
        raw = Math.floor(lo + rand * (hi - lo + 1));
        if (raw > hi) raw = hi;
    }
    if (isCritical && critDamageBonus) {
        raw = Math.floor(raw * (1 + (Number(critDamageBonus) || 0) / 100));
    }
    return { raw: Math.max(0, raw), critical: !!isCritical };
}

/**
 * Armor reduction roll (legacy reference / Utils.getArmorReduction):
 * uniform integer in [ceil(armor/2), ceil(armor/2)*2 − 1] when armor > 0.
 *
 * @param {number} armor
 * @param {() => number} [rng]
 * @returns {number}
 */
function rollArmorReduction(armor, rng) {
    const a = Math.max(0, Math.floor(Number(armor) || 0));
    if (a <= 0) return 0;
    const lo = Math.ceil(a / 2);
    const hi = lo * 2 - 1;
    if (lo >= hi) return lo;
    const rand = typeof rng === 'function' ? rng() : Math.random();
    return Math.floor(lo + rand * (hi - lo + 1));
}

/**
 * Shield block amount: uniform [0, maxBlock] when allowed.
 * @param {number} maxBlock
 * @param {() => number} [rng]
 * @returns {number}
 */
function rollShieldBlock(maxBlock, rng) {
    const m = Math.max(0, Math.floor(Number(maxBlock) || 0));
    if (m <= 0) return 0;
    const rand = typeof rng === 'function' ? rng() : Math.random();
    return Math.floor(rand * (m + 1));
}

/**
 * Apply mitigation → element resist → optional shield → armor.
 *
 * Defender bag:
 *   mitigation: number (percent 0–100 of raw)
 *   resists: { [element]: number } percent 0–100 (100 = full absorb)
 *   armor: number
 *   maxBlock: number (shield max)
 *   canBlock: boolean (caller enforces 2-block / 2s window)
 *
 * @param {number} raw
 * @param {DamageElement|string} element
 * @param {object} defender
 * @param {{ isMelee?: boolean, rng?: () => number }} [opts]
 * @returns {{
 *   final: number,
 *   raw: number,
 *   mitigation: number,
 *   elementReduction: number,
 *   shieldBlock: number,
 *   armorReduction: number,
 *   element: string
 * }}
 */
function applyMitigation(raw, element, defender, opts) {
    const options = opts || {};
    const rng = options.rng;
    const el = element || 'physical';
    let dmg = Math.max(0, Number(raw) || 0);
    const initial = dmg;

    // Healing restores raw rolled amount (no armor / mit / shield / resist).
    if (el === 'healing') {
        return {
            final: Math.max(0, Math.floor(dmg)),
            raw: initial,
            mitigation: 0,
            elementReduction: 0,
            shieldBlock: 0,
            armorReduction: 0,
            element: el
        };
    }

    // Mitigation is a flat percent of raw.
    const mitPct = Math.max(0, Number(defender && defender.mitigation) || 0);
    const mitigation = dmg * (mitPct / 100);
    dmg -= mitigation;

    const resistPct = Math.max(
        0,
        Math.min(
            100,
            Number(
                (defender && defender.resists && defender.resists[el]) || 0
            )
        )
    );
    const elementReduction = dmg * (resistPct / 100);
    dmg -= elementReduction;

    let shieldBlock = 0;
    if (
        options.isMelee &&
        el === 'physical' &&
        defender &&
        defender.canBlock &&
        (defender.maxBlock || 0) > 0
    ) {
        shieldBlock = Math.min(rollShieldBlock(defender.maxBlock, rng), dmg);
        dmg -= shieldBlock;
    }

    let armorReduction = 0;
    if (el === 'physical' && defender && (defender.armor || 0) > 0) {
        armorReduction = Math.min(rollArmorReduction(defender.armor, rng), dmg);
        dmg -= armorReduction;
    }

    const final = Math.max(0, Math.floor(dmg));
    return {
        final,
        raw: initial,
        mitigation,
        elementReduction,
        shieldBlock,
        armorReduction,
        element: el
    };
}

/**
 * Full pure damage resolve: range → roll → mitigation pipeline.
 *
 * @param {object} params
 * @param {string} [params.powerCurve]
 * @param {number} [params.basePower]
 * @param {number} [params.damageAmplitude] half-width fraction; omit → 0
 * @param {object} [params.attacker] stats for range formulas
 * @param {object} params.defender
 * @param {DamageElement|string} [params.element='physical']
 * @param {boolean} [params.isMelee]
 * @param {number} [params.hitChance]
 * @param {boolean} [params.hit] skip the hit roll when boolean
 * @param {number} [params.critChance]
 * @param {number} [params.critDamage]
 * @param {string} [params.critBand] `auto_st` or `multiply` (default)
 * @param {boolean} [params.critical] skip the crit roll when boolean
 * @param {number} [params.fatalChance] percent; 0 skips
 * @param {boolean} [params.fatal] skip the fatal roll when boolean
 * @param {number} [params.min] fixed range override
 * @param {number} [params.max] fixed range override
 * @param {() => number} [params.rng]
 * @returns {{ hit: boolean, critical: boolean, fatal: boolean, range: {min:number,max:number}, breakdown: object|null, final: number }}
 */
function computeDamage(params) {
    const p = params || {};
    const rng = p.rng;
    const element = p.element || 'physical';

    const forcedHit = p.hit;
    if (forcedHit === false) {
        return {
            hit: false,
            critical: false,
            fatal: false,
            range: { min: 0, max: 0 },
            breakdown: null,
            final: 0
        };
    }
    if (
        forcedHit !== true &&
        !rollHit(p.hitChance != null ? p.hitChance : 100, rng)
    ) {
        return {
            hit: false,
            critical: false,
            fatal: false,
            range: { min: 0, max: 0 },
            breakdown: null,
            final: 0
        };
    }

    let range;
    if (p.min != null || p.max != null) {
        range = {
            min: Math.max(0, Number(p.min) || 0),
            max: Math.max(0, Number(p.max) || 0)
        };
        if (range.max < range.min) range.max = range.min;
    } else {
        range = computeDamageRange(
            p.powerCurve || 'fixed',
            Object.assign({}, p.attacker || {}, {
                min: p.min,
                max: p.max
            }),
            p.basePower,
            p.damageAmplitude
        );
    }

    const isCritical =
        p.critical === true || p.critical === false
            ? !!p.critical
            : rollCritical(p.critChance || 0, rng);
    const rolled = rollRawDamage(
        range.min,
        range.max,
        isCritical,
        p.critDamage || 0,
        rng,
        {
            powerCurve: p.powerCurve || 'fixed',
            critBand: p.critBand || CRIT_BAND_MULTIPLY
        }
    );

    let raw = rolled.raw;
    let isFatal = false;
    if (elementAllowsFatal(element)) {
        isFatal =
            p.fatal === true || p.fatal === false
                ? !!p.fatal
                : rollFatal(p.fatalChance || 0, rng);
        if (isFatal) raw = applyFatalBonus(raw);
    }

    const extraAtk =
        Number(
            p.extraAtk != null
                ? p.extraAtk
                : p.attacker && p.attacker.extraAtk
        ) || 0;
    const extraEl =
        p.extraAtkElement ||
        (p.attacker && p.attacker.extraAtkElement) ||
        null;
    const combinedAtk = Number(p.attacker && p.attacker.atk) || 0;
    if (extraAtk > 0 && extraEl && combinedAtk > 0) {
        const elemShare = Math.min(1, extraAtk / combinedAtk);
        const elemRaw = Math.round(raw * elemShare);
        const physRaw = Math.max(0, raw - elemRaw);
        const phys = applyMitigation(physRaw, element, p.defender || {}, {
            isMelee: !!p.isMelee,
            rng
        });
        const elemMit = applyMitigation(elemRaw, extraEl, p.defender || {}, {
            isMelee: false,
            rng
        });
        const final = phys.final + elemMit.final;
        return {
            hit: true,
            critical: rolled.critical,
            fatal: isFatal,
            range,
            breakdown: {
                raw,
                mitigation: phys.mitigation + elemMit.mitigation,
                elementReduction: phys.elementReduction + elemMit.elementReduction,
                shieldBlock: phys.shieldBlock,
                armorReduction: phys.armorReduction,
                element,
                extraAtkElement: extraEl,
                primary: phys,
                secondary: elemMit,
                final
            },
            final
        };
    }

    const breakdown = applyMitigation(raw, element, p.defender || {}, {
        isMelee: !!p.isMelee,
        rng
    });

    return {
        hit: true,
        critical: rolled.critical,
        fatal: isFatal,
        range,
        breakdown,
        final: breakdown.final
    };
}

module.exports = {
    CRIT_BAND_AUTO_ST,
    CRIT_BAND_MULTIPLY,
    AUTO_ST_CRIT_FLOOR,
    FATAL_CHANCE_A,
    FATAL_CHANCE_B,
    FATAL_CHANCE_C,
    FATAL_DAMAGE_BONUS,
    weaponAutoFactor,
    levelBonus,
    round4,
    normalizeDamageAmplitude,
    getMagicSpellParameters,
    getMeleeSpellParameters,
    meanCoefficients,
    computeMagicMean,
    computeMeleeMean,
    rangeFromMean,
    amplitudeFromLegacySpread,
    computeLegacyMagicStrikeRange,
    computeLegacyMeleeStrikeRange,
    computeMeleeAutoRange,
    computeDistanceAutoRange,
    computeMeleeStrikeRange,
    computeMagicStrikeRange,
    computeDamageRange,
    rollHit,
    rollCritical,
    fatalChanceFromTier,
    rollFatal,
    applyFatalBonus,
    normalRandom,
    usesGaussianAutoRaw,
    resolveCritBand,
    autoStCritRollMin,
    rollRawDamage,
    rollArmorReduction,
    rollShieldBlock,
    applyMitigation,
    computeDamage
};
