/**
 * Creature combat kit: multi-attack data, target strategies, range/flee flags.
 *
 * Data-driven port of legacy creature brain bits, with cleaner shapes:
 *  - normalize template → runtime kit once (applyTemplate / ensureCreatureKit)
 *  - offensive power is **fixed min/max on attacks[] only** (no player power
 *    curves, no implicit melee_auto when the table is empty)
 *  - stand-off is flags.targetDistance only
 *  - attacks fire through resolveAttack
 *  - strategiesTarget weighted pick (nearest | health | damage | random)
 *  - flags: targetDistance, runHealth, runHealthPercent, staticAttackChance,
 *    loseTargetDistance, aggroRange, threatDecayHalflifeSec
 *  - threat table damageTakenBy decays by half-life (lazy apply)
 *  - mid-combat strategy re-roll from changeTarget {interval ms, chance %}
 *    (overrides AI_CREATURE_RETARGET_INTERVAL)
 *
 * Legacy field aliases accepted (interval ms, minDamage/maxDamage, name, type).
 * Affix `atkMult` scales kit min/max via applyKitDamageMult (spawn path).
 */

'use strict';

const { Settings } = require('../../../settings.js');
const { Time } = require('../time.js');
const { resolveAttack, applyHpDelta } = require('../combat/resolve.js');
const {
    spellHasShape,
    resolveShapedAttack
} = require('../combat/area.js');
const { getFieldKind } = require('../combat/elemental_fields.js');
const {
    applyCondition,
    hasHaste,
    isInvisible
} = require('../combat/conditions.js');
const {
    queryWithinRange,
    findNearest,
    distBetween,
    isValidTarget,
    isProtectedTarget
} = require('./targeting.js');
const { hasLineOfSight } = require('../shapes.js');
const {
    spellBookFromCtx,
    recordAttackResult,
    isModeMonsterSummonsEnabled
} = require('./combat_actions.js');

/** @typedef {'melee'|'ranged'|'area'|'wave'|'status'} AttackKind */
/** @typedef {'nearest'|'health'|'damage'|'random'} TargetStrategyId */

/**
 * @typedef {object} NormalizedAttack
 * @property {string} id
 * @property {AttackKind} kind
 * @property {number} intervalSec
 * @property {number} chance 1–100
 * @property {number} range Chebyshev
 * @property {number} radius area/wave radius (0 = single)
 * @property {number} [length] wave length in tiles
 * @property {number} [spread] wave spread
 * @property {string} element
 * @property {number} min fixed damage min
 * @property {number} max fixed damage max
 * @property {number} basePower
 * @property {boolean} isMelee
 * @property {boolean} needsTarget
 * @property {number} hitChance
 * @property {number|null} moveLock
 */

/**
 * @typedef {object} CreatureFlags
 * @property {number} targetDistance ideal stand-off (1 = melee hug)
 * @property {number} runHealth absolute HP ≤ this → flee stand-off
 * @property {number} runHealthPercent 0–1 alternate flee threshold (0 = off)
 * @property {number} staticAttackChance 1–100 chance to attempt any attack this think
 * @property {number} loseTargetDistance hard clear target beyond this
 * @property {number} aggroRange idle scan radius
 * @property {number} fleeTargetDistance stand-off while low-HP fleeing
 * @property {number} threatDecayHalflifeSec half-life of damageTakenBy threat (0 = no decay)
 */

/** Drop threat entries below this after decay (absolute damage units). */
const THREAT_EPS = 0.01;

/** Host field: next logic-time allowed for mid-combat strategy re-roll. */
const STRATEGY_RETARGET_AT_KEY = '_strategyRetargetNextAt';

/**
 * @typedef {object} CreatureKit
 * @property {CreatureFlags} flags
 * @property {Record<string, number>} strategiesTarget
 * @property {NormalizedAttack[]} attacks
 * @property {{ intervalSec: number|null, chance: number|null }} changeTarget
 */

const DEFAULT_STRATEGIES = Object.freeze({ nearest: 100 });

/**
 * @param {string} key
 * @param {*} fallback
 */
function setting(key, fallback) {
    if (Settings[key] === undefined || Settings[key] === null) return fallback;
    return Settings[key];
}

/**
 * Weighted key pick. Weights are relative (need not sum to 100).
 * @param {Record<string, number>|null|undefined} weights
 * @param {() => number} [rng] [0,1)
 * @returns {string|null}
 */
function pickWeightedKey(weights, rng) {
    if (!weights || typeof weights !== 'object') return null;
    const keys = Object.keys(weights);
    if (!keys.length) return null;
    let total = 0;
    for (let i = 0; i < keys.length; i++) {
        const w = Number(weights[keys[i]]) || 0;
        if (w > 0) total += w;
    }
    if (total <= 0) return keys[keys.length - 1];
    const r =
        (typeof rng === 'function' ? rng() : Math.random()) * total;
    let acc = 0;
    for (let i = 0; i < keys.length; i++) {
        const w = Number(weights[keys[i]]) || 0;
        if (w <= 0) continue;
        acc += w;
        if (r < acc) return keys[i];
    }
    return keys[keys.length - 1];
}

/**
 * @param {object[]} candidates
 * @param {'lowest'|'highest'} mode
 * @param {(e: object) => number} scoreFn
 * @returns {object|null}
 */
function pickExtreme(candidates, mode, scoreFn) {
    if (!candidates || !candidates.length) return null;
    let best = null;
    let bestScore = mode === 'lowest' ? Infinity : -Infinity;
    for (let i = 0; i < candidates.length; i++) {
        const e = candidates[i];
        if (!e) continue;
        const s = scoreFn(e);
        if (mode === 'lowest' ? s < bestScore : s > bestScore) {
            bestScore = s;
            best = e;
        }
    }
    return best;
}

/**
 * Pick a living player by strategy id.
 * @param {object} owner creature
 * @param {object[]} candidates
 * @param {TargetStrategyId|string} strategy
 * @param {() => number} [rng]
 * @returns {object|null}
 */
function pickByStrategy(owner, candidates, strategy, rng) {
    const list = candidates || [];
    if (!list.length) return null;
    const id = String(strategy || 'nearest').toLowerCase();
    switch (id) {
        case 'health':
        case 'lowest_hp':
            return (
                pickExtreme(list, 'lowest', (e) =>
                    e.hp && e.hp.current != null ? e.hp.current : Infinity
                ) || findNearest(owner, list)
            );
        case 'damage':
        case 'highest_damage': {
            applyThreatDecay(owner);
            const bag = owner && owner.damageTakenBy;
            const byDmg = pickExtreme(list, 'highest', (e) => {
                if (!bag || e.id == null) return 0;
                return Number(bag[e.id] || bag[String(e.id)] || 0);
            });
            // No damage yet → random among near (legacy fallback)
            if (
                !byDmg ||
                !bag ||
                !(Number(bag[byDmg.id] || bag[String(byDmg.id)] || 0) > 0)
            ) {
                const r =
                    typeof rng === 'function' ? rng() : Math.random();
                return list[Math.floor(r * list.length)] || null;
            }
            return byDmg;
        }
        case 'random': {
            const r = typeof rng === 'function' ? rng() : Math.random();
            return list[Math.floor(r * list.length)] || null;
        }
        case 'nearest':
        default:
            return findNearest(owner, list);
    }
}

/**
 * @param {object|null|undefined} raw
 * @returns {Record<string, number>}
 */
function normalizeStrategiesTarget(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return Object.assign({}, DEFAULT_STRATEGIES);
    }
    const out = Object.create(null);
    let any = false;
    for (const k of Object.keys(raw)) {
        const w = Number(raw[k]);
        if (Number.isFinite(w) && w > 0) {
            out[k] = w;
            any = true;
        }
    }
    return any ? out : Object.assign({}, DEFAULT_STRATEGIES);
}

/**
 * Authored changeTarget {interval ms, chance %} → seconds + 0–100 chance.
 * interval 0 / omitted interval → no periodic retarget from this object.
 * @param {object|null|undefined} template
 * @returns {{ intervalSec: number|null, chance: number|null }}
 */
function changeTargetFromTemplate(template) {
    const ct = template && template.changeTarget;
    if (!ct || typeof ct !== 'object') {
        return { intervalSec: null, chance: null };
    }
    let intervalSec = null;
    if (ct.interval != null && ct.interval !== '') {
        const ms = Number(ct.interval);
        if (Number.isFinite(ms)) intervalSec = Math.max(0, ms / 1000);
    }
    let chance = null;
    if (ct.chance != null && ct.chance !== '') {
        const n = Number(ct.chance);
        if (Number.isFinite(n)) chance = Math.max(0, Math.min(100, n));
    }
    return { intervalSec, chance };
}

/**
 * @param {object|null|undefined} flagsRaw
 * @param {object|null|undefined} template top-level fallbacks
 * @returns {CreatureFlags}
 */
function normalizeFlags(flagsRaw, template) {
    const f = flagsRaw && typeof flagsRaw === 'object' ? flagsRaw : {};
    const t = template && typeof template === 'object' ? template : {};
    const aggroDefault = setting('AI_CREATURE_AGGRO_RANGE', 7);
    const loseDefault = setting('AI_CREATURE_LOSE_TARGET_DIST', 10);
    const fleeStand = setting('AI_CREATURE_FLEE_STAND_DIST', 10);

    const targetDistance =
        f.targetDistance != null ? Number(f.targetDistance) : 1;

    const out = {
        targetDistance: Math.max(1, targetDistance | 0 || 1),
        runHealth:
            f.runHealth != null
                ? Math.max(0, Number(f.runHealth) || 0)
                : 0,
        runHealthPercent:
            f.runHealthPercent != null
                ? Math.max(0, Math.min(1, Number(f.runHealthPercent) || 0))
                : t.runHealthPercent != null
                  ? Math.max(0, Math.min(1, Number(t.runHealthPercent) || 0))
                  : 0,
        staticAttackChance: Math.max(
            0,
            Math.min(
                100,
                f.staticAttackChance != null
                    ? Number(f.staticAttackChance)
                    : setting('AI_CREATURE_STATIC_ATTACK_CHANCE', 100)
            )
        ),
        loseTargetDistance: Math.max(
            1,
            (f.loseTargetDistance != null
                ? Number(f.loseTargetDistance)
                : loseDefault) | 0
        ),
        aggroRange: Math.max(
            1,
            (f.aggroRange != null
                ? Number(f.aggroRange)
                : t.aggroRange != null
                  ? Number(t.aggroRange)
                  : aggroDefault) | 0
        ),
        fleeTargetDistance: Math.max(
            1,
            (f.fleeTargetDistance != null
                ? Number(f.fleeTargetDistance)
                : fleeStand) | 0
        ),
        /** When true, Idle wanders a free adjacent tile if no players in aggro. */
        idleWander: f.idleWander === true || f.idleWander === 1,
        /**
         * Half-life (logic seconds) of damageTakenBy threat for "damage" strategy.
         * 0 = no decay. Template flag overrides setting.
         */
        threatDecayHalflifeSec: Math.max(
            0,
            f.threatDecayHalflifeSec != null
                ? Number(f.threatDecayHalflifeSec) || 0
                : t.threatDecayHalflifeSec != null
                  ? Number(t.threatDecayHalflifeSec) || 0
                  : Number(
                        setting('AI_CREATURE_THREAT_DECAY_HALFLIFE_SEC', 10)
                    ) || 0
        )
    };
    // Kit rebuild must not drop NPC identity (Stage 6b / Q6.2).
    if (f.isNpc === true) out.isNpc = true;
    if (f.npc === true) out.npc = true;
    if (f.talkable === true) out.talkable = true;
    if (f.hostile === true) out.hostile = true;
    if (f.attackableNpc === true || t.attackableNpc === true) {
        out.attackableNpc = true;
    }
    return out;
}

/**
 * Logic clock for threat decay / retarget gates.
 * @returns {number}
 */
function logicNow() {
    return Time && typeof Time.timeSinceLevelLoad === 'number'
        ? Time.timeSinceLevelLoad
        : 0;
}

/**
 * Resolved threat half-life for a creature (kit flags after normalize).
 * @param {object} creature
 * @returns {number} seconds; 0 = no decay
 */
function threatDecayHalflife(creature) {
    const kit =
        creature && creature.kit
            ? creature.kit
            : creature
              ? ensureCreatureKit(creature)
              : null;
    const f = kit && kit.flags;
    if (f && f.threatDecayHalflifeSec != null) {
        return Math.max(0, Number(f.threatDecayHalflifeSec) || 0);
    }
    return Math.max(
        0,
        Number(setting('AI_CREATURE_THREAT_DECAY_HALFLIFE_SEC', 10)) || 0
    );
}

/**
 * Lazy exponential decay of damageTakenBy (half-life). No-op when half-life is 0.
 * Safe to call every think / record; tracks last apply time on the creature.
 *
 * @param {object} creature
 * @param {number} [now] Time.timeSinceLevelLoad
 * @returns {void}
 */
function applyThreatDecay(creature, now) {
    if (!creature) return;
    if (!creature.damageTakenBy || typeof creature.damageTakenBy !== 'object') {
        creature.damageTakenBy = Object.create(null);
    }
    const t =
        typeof now === 'number' && Number.isFinite(now) ? now : logicNow();
    const last = creature._threatDecayAt;
    if (last == null || !Number.isFinite(last)) {
        creature._threatDecayAt = t;
        return;
    }
    const dt = t - last;
    if (!(dt > 0)) return;
    creature._threatDecayAt = t;

    const half = threatDecayHalflife(creature);
    if (!(half > 0)) return;

    const factor = Math.pow(0.5, dt / half);
    if (!(factor < 1) || !Number.isFinite(factor)) return;

    const bag = creature.damageTakenBy;
    const keys = Object.keys(bag);
    for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        const v = Number(bag[k]) * factor;
        if (!Number.isFinite(v) || v < THREAT_EPS) {
            delete bag[k];
        } else {
            bag[k] = v;
        }
    }
}

/**
 * Mid-combat strategy re-roll interval (0 = sticky forever until lose).
 * changeTarget.interval (ms) wins; else AI_CREATURE_RETARGET_INTERVAL.
 * @param {object} owner
 * @returns {number}
 */
function retargetIntervalSec(owner) {
    const kit =
        owner && owner.kit ? owner.kit : owner ? ensureCreatureKit(owner) : null;
    const ct = kit && kit.changeTarget;
    if (ct && ct.intervalSec != null) {
        return Math.max(0, Number(ct.intervalSec) || 0);
    }
    return Math.max(
        0,
        Number(setting('AI_CREATURE_RETARGET_INTERVAL', 0)) || 0
    );
}

/**
 * Percent chance to switch target when the retarget interval elapses.
 * changeTarget.chance wins; default 100 when only an interval is authored.
 * @param {object} owner
 * @returns {number} 0–100; 100 = always
 */
function retargetChance(owner) {
    const kit =
        owner && owner.kit ? owner.kit : owner ? ensureCreatureKit(owner) : null;
    const ct = kit && kit.changeTarget;
    if (ct && ct.chance != null) {
        return Math.max(0, Math.min(100, Number(ct.chance) || 0));
    }
    return 100;
}

/**
 * Arm full retarget interval after an initial strategy pick (avoid re-roll
 * on the very next think). Interval 0 clears the gate.
 * @param {object} owner
 * @param {number} [now]
 */
function armStrategyRetarget(owner, now) {
    if (!owner) return;
    const interval = retargetIntervalSec(owner);
    if (!(interval > 0)) {
        owner[STRATEGY_RETARGET_AT_KEY] = null;
        return;
    }
    const t =
        typeof now === 'number' && Number.isFinite(now) ? now : logicNow();
    owner[STRATEGY_RETARGET_AT_KEY] = t + interval;
}

/**
 * Clear strategy retarget gate (target lost / leave combat).
 * @param {object} owner
 */
function clearStrategyRetarget(owner) {
    if (!owner) return;
    owner[STRATEGY_RETARGET_AT_KEY] = null;
}

/**
 * Whether a mid-combat strategiesTarget re-roll may run this think.
 * Interval 0 → always false (sticky). First call after arm waits full interval.
 * When the interval elapses the gate always re-arms; changeTarget.chance then
 * decides whether the switch actually happens (0 = stay sticky).
 *
 * @param {object} owner
 * @param {number} [now]
 * @param {() => number} [rng] [0,1)
 * @returns {boolean}
 */
function strategyRetargetDue(owner, now, rng) {
    if (!owner) return false;
    const interval = retargetIntervalSec(owner);
    if (!(interval > 0)) return false;
    const t =
        typeof now === 'number' && Number.isFinite(now) ? now : logicNow();
    const nextAt = owner[STRATEGY_RETARGET_AT_KEY];
    if (nextAt != null && Number.isFinite(nextAt) && t < nextAt) {
        return false;
    }
    owner[STRATEGY_RETARGET_AT_KEY] = t + interval;
    const chance = retargetChance(owner);
    if (!(chance > 0)) return false;
    if (chance >= 100) return true;
    const r = typeof rng === 'function' ? rng() : Math.random();
    return r * 100 < chance;
}

/**
 * Map legacy attack.name / kind strings.
 * @param {object} raw
 * @returns {AttackKind}
 */
function inferKind(raw) {
    if (!raw) return 'melee';
    const k = String(raw.kind || raw.name || '').toLowerCase();
    if (k === 'status' || k === 'speed' || k === 'slow' || k === 'haste') {
        return 'status';
    }
    // Geometry first: statusOnly pure-condition area/wave/ranged must keep shape.
    if (k === 'wave' || (raw.length != null && Number(raw.length) > 0)) {
        return 'wave';
    }
    if (
        k === 'area' ||
        k === 'combat' ||
        (raw.radius != null && Number(raw.radius) > 1)
    ) {
        // Legacy "combat" with radius>1 is area; radius 1 is single-target bolt
        if (k === 'combat' && !(Number(raw.radius) > 1) && !raw.length) {
            return Number(raw.range) > 1 ? 'ranged' : 'melee';
        }
        if (Number(raw.radius) > 1 || k === 'area') return 'area';
    }
    if (k === 'ranged' || k === 'distance' || k === 'bolt') return 'ranged';
    if (k === 'melee') return 'melee';
    if (raw.range != null && Number(raw.range) > 1) return 'ranged';
    // Condition-only with no geometry → status (single-target apply)
    if (raw.statusOnly && raw.condition && !raw.min && !raw.max) {
        return 'status';
    }
    return 'melee';
}

/**
 * Interval: prefer seconds; accept legacy ms when value looks like ms (> 20 and no unit).
 * @param {object} raw
 * @returns {number} seconds
 */
function normalizeIntervalSec(raw) {
    if (!raw) return 2;
    if (raw.intervalSec != null) return Math.max(0.05, Number(raw.intervalSec) || 2);
    if (raw.cooldown != null) return Math.max(0.05, Number(raw.cooldown) || 2);
    if (raw.intervalMs != null) {
        return Math.max(0.05, (Number(raw.intervalMs) || 2000) / 1000);
    }
    if (raw.interval != null) {
        const n = Number(raw.interval) || 2000;
        // Legacy stored ms (typically 1000–5000)
        if (n > 20) return Math.max(0.05, n / 1000);
        return Math.max(0.05, n);
    }
    return 2;
}

/**
 * @param {object} raw
 * @param {number} index
 * @param {object} [template]
 * @returns {NormalizedAttack|null}
 */
function normalizeAttack(raw, index, template) {
    if (!raw || typeof raw !== 'object') return null;
    const kind = inferKind(raw);
    const range =
        raw.range != null
            ? Math.max(0, Number(raw.range) | 0)
            : kind === 'melee'
              ? 1
              : 4;
    const radius =
        raw.radius != null ? Math.max(0, Number(raw.radius) | 0) : 0;
    const element = String(
        raw.element || raw.type || 'physical'
    ).toLowerCase();
    let min =
        raw.min != null
            ? Number(raw.min)
            : raw.minDamage != null
              ? Number(raw.minDamage)
              : null;
    let max =
        raw.max != null
            ? Number(raw.max)
            : raw.maxDamage != null
              ? Number(raw.maxDamage)
              : null;
    if (min != null && !Number.isFinite(min)) min = null;
    if (max != null && !Number.isFinite(max)) max = null;
    // Legacy OTBM dumps often store damage as negative (maxDamage: -10 → 10 dmg)
    if (
        min != null &&
        max != null &&
        min <= 0 &&
        max <= 0 &&
        (min < 0 || max < 0)
    ) {
        min = Math.abs(min);
        max = Math.abs(max);
    } else {
        if (min != null && min < 0) min = Math.abs(min);
        if (max != null && max < 0) max = Math.abs(max);
    }
    if (min != null && max == null) max = min;
    if (max != null && min == null) min = 0;
    if (min != null && max != null && max < min) {
        const t = min;
        min = max;
        max = t;
    }

    const hasFixed = min != null && max != null;
    // Status / condition-only rows need no damage band.
    const statusOnly =
        !!raw.statusOnly ||
        kind === 'status' ||
        (!hasFixed &&
            raw.condition &&
            typeof raw.condition === 'object');

    // Monster offense is fixed min/max only (or status/condition-only).
    if (!hasFixed && !statusOnly) {
        return null;
    }

    const isMelee =
        raw.isMelee != null
            ? !!raw.isMelee
            : kind === 'melee' && element === 'physical';

    const id =
        raw.id ||
        (raw.name ? String(raw.name) + '_' + index : 'atk_' + index);

    /** @type {object} */
    const atk = {
        id: String(id),
        kind,
        intervalSec: normalizeIntervalSec(raw),
        chance: Math.max(
            0,
            Math.min(100, raw.chance != null ? Number(raw.chance) : 100)
        ),
        range,
        radius,
        length:
            raw.length != null ? Math.max(0, Number(raw.length) | 0) : 0,
        spread:
            raw.spread != null ? Math.max(0, Number(raw.spread) | 0) : 0,
        element,
        min: hasFixed ? min : 0,
        max: hasFixed ? max : 0,
        basePower: 0,
        isMelee: statusOnly ? false : isMelee,
        needsTarget: raw.target !== false && raw.needsTarget !== false,
        hitChance:
            raw.hitChance != null ? Number(raw.hitChance) : 100,
        moveLock: raw.moveLock != null ? Number(raw.moveLock) : null,
        statusOnly: !!statusOnly
    };
    const fk = getFieldKind(raw.deploysField || raw.field || id || null);
    if (fk) {
        atk.field = fk;
        atk.deploysField = fk;
    }
    if (raw.condition && typeof raw.condition === 'object') {
        atk.condition = raw.condition;
    }
    return atk;
}

/**
 * Normalize defense_spells row (heal / haste / invisible).
 * @param {object} raw
 * @param {number} index
 * @returns {object|null}
 */
function normalizeDefenseSpell(raw, index) {
    if (!raw || typeof raw !== 'object') return null;
    const kind = String(raw.kind || raw.name || '').toLowerCase();
    if (kind !== 'heal' && kind !== 'haste' && kind !== 'invisible') {
        return null;
    }
    /** @type {object} */
    const spell = {
        id: raw.id != null ? String(raw.id) : `${kind}_${index}`,
        kind,
        intervalSec: normalizeIntervalSec(raw),
        chance: Math.max(
            0,
            Math.min(100, raw.chance != null ? Number(raw.chance) : 100)
        )
    };
    if (kind === 'heal') {
        let min =
            raw.min != null
                ? Math.abs(Number(raw.min) || 0)
                : raw.minDamage != null
                  ? Math.abs(Number(raw.minDamage) || 0)
                  : 0;
        let max =
            raw.max != null
                ? Math.abs(Number(raw.max) || 0)
                : raw.maxDamage != null
                  ? Math.abs(Number(raw.maxDamage) || 0)
                  : min;
        if (max < min) {
            const t = min;
            min = max;
            max = t;
        }
        if (!(max > 0)) return null;
        spell.min = min;
        spell.max = max;
        spell.hpBelow =
            raw.hpBelow != null ? Number(raw.hpBelow) : 0.7;
    } else if (kind === 'haste') {
        const sc = Number(raw.speedChange) || 0;
        if (!(sc > 0)) return null;
        spell.speedChange = sc;
        spell.durationSec =
            raw.durationSec != null
                ? Math.max(0.1, Number(raw.durationSec) || 5)
                : raw.duration != null
                  ? Math.max(0.1, (Number(raw.duration) || 5000) / 1000)
                  : 5;
    } else if (kind === 'invisible') {
        spell.durationSec =
            raw.durationSec != null
                ? Math.max(0.1, Number(raw.durationSec) || 2)
                : raw.duration != null
                  ? Math.max(0.1, (Number(raw.duration) || 2000) / 1000)
                  : 2;
    }
    if (raw.effect) spell.effect = String(raw.effect);
    return spell;
}

/**
 * Normalize template `summon` block for runtime auto-summon AI.
 * Accepts ported JSON: `{ maxSummons, summons: [{ id, name, chance, interval, count }] }`.
 * @param {object|null|undefined} raw
 * @returns {{ maxSummons: number, summons: object[] }|null}
 */
function normalizeSummonConfig(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const list = Array.isArray(raw.summons) ? raw.summons : [];
    if (!list.length) return null;
    /** @type {object[]} */
    const summons = [];
    for (let i = 0; i < list.length; i++) {
        const row = list[i];
        if (!row || typeof row !== 'object') continue;
        const id =
            row.id != null
                ? String(row.id).trim()
                : row.name != null
                  ? String(row.name)
                        .trim()
                        .toLowerCase()
                        .replace(/[^a-z0-9]+/g, '_')
                        .replace(/^_|_$/g, '')
                  : '';
        if (!id) continue;
        const intervalMs =
            row.intervalMs != null
                ? Number(row.intervalMs)
                : row.interval != null
                  ? Number(row.interval)
                  : 2000;
        const intervalSec = Math.max(
            0.05,
            (Number.isFinite(intervalMs) ? intervalMs : 2000) / 1000
        );
        summons.push({
            id,
            name:
                row.name != null
                    ? String(row.name)
                    : id
                          .split('_')
                          .map((w) =>
                              w ? w.charAt(0).toUpperCase() + w.slice(1) : w
                          )
                          .join(' '),
            chance: Math.max(
                0,
                Math.min(100, row.chance != null ? Number(row.chance) : 100)
            ),
            intervalSec,
            count: Math.max(
                1,
                Math.round(row.count != null ? Number(row.count) || 1 : 1)
            ),
            force: !!row.force
        });
    }
    if (!summons.length) return null;
    const maxSummons =
        raw.maxSummons != null && Number.isFinite(Number(raw.maxSummons))
            ? Math.max(0, Math.round(Number(raw.maxSummons) || 0))
            : summons.reduce((acc, s) => acc + (Number(s.count) || 1), 0);
    if (!(maxSummons > 0)) return null;
    return { maxSummons, summons };
}

/**
 * @param {object|null|undefined} template
 * @returns {CreatureKit}
 */
function normalizeCreatureKit(template) {
    const t = template || {};
    const flags = normalizeFlags(t.flags, t);
    const changeTarget = changeTargetFromTemplate(t);
    const strategiesTarget = normalizeStrategiesTarget(
        t.strategiesTarget || t.targetStrategies
    );
    /** @type {NormalizedAttack[]} */
    const attacks = [];
    const rawList = Array.isArray(t.attacks) ? t.attacks : [];
    for (let i = 0; i < rawList.length; i++) {
        const a = normalizeAttack(rawList[i], i, t);
        if (a) attacks.push(a);
    }
    // Empty attacks[] → no offense (bridge defaults supply a weak melee when missing).
    /** @type {object[]} */
    const defenseSpells = [];
    const rawDef = Array.isArray(t.defenseSpells)
        ? t.defenseSpells
        : Array.isArray(t.defense_spells)
          ? t.defense_spells
          : [];
    for (let i = 0; i < rawDef.length; i++) {
        const d = normalizeDefenseSpell(rawDef[i], i);
        if (d) defenseSpells.push(d);
    }
    const summon = normalizeSummonConfig(t.summon);
    return { flags, strategiesTarget, attacks, defenseSpells, summon, changeTarget };
}

/**
 * Scale offensive kit damage by affix mult (spawn `atkMult`).
 * Mutates attacks on creature.attacks, creature.kit, and creature._kitTemplate.
 * Also scales on-hit condition totalDamage when present.
 *
 * @param {object} creature
 * @param {number} mult
 */
function applyKitDamageMult(creature, mult) {
    const m = Number(mult);
    if (!creature || !(m > 0) || m === 1) return;

    /**
     * @param {object[]|null|undefined} list
     */
    function scaleList(list) {
        if (!Array.isArray(list)) return;
        for (let i = 0; i < list.length; i++) {
            const a = list[i];
            if (!a || typeof a !== 'object') continue;
            if (a.min != null && Number.isFinite(Number(a.min))) {
                a.min = Math.round(Number(a.min) * m);
            }
            if (a.max != null && Number.isFinite(Number(a.max))) {
                a.max = Math.round(Number(a.max) * m);
            }
            if (
                a.min != null &&
                a.max != null &&
                Number(a.max) < Number(a.min)
            ) {
                const t = a.min;
                a.min = a.max;
                a.max = t;
            }
            if (
                a.condition &&
                typeof a.condition === 'object' &&
                a.condition.totalDamage != null &&
                Number.isFinite(Number(a.condition.totalDamage))
            ) {
                a.condition.totalDamage = Math.round(
                    Number(a.condition.totalDamage) * m
                );
            }
        }
    }

    // creature.attacks and kit.attacks are often the same array after
    // ensureCreatureKit — scale each distinct list only once.
    const seen = new Set();
    const lists = [
        creature.attacks,
        creature.kit && creature.kit.attacks,
        creature._kitTemplate && creature._kitTemplate.attacks
    ];
    for (let i = 0; i < lists.length; i++) {
        const list = lists[i];
        if (!list || seen.has(list)) continue;
        seen.add(list);
        scaleList(list);
    }
}
/**
 * Attach / refresh kit on a creature instance.
 * @param {object} creature
 * @param {object} [template]
 * @returns {CreatureKit}
 */
function ensureCreatureKit(creature, template) {
    if (!creature) {
        return normalizeCreatureKit(template);
    }
    const src =
        template ||
        creature._kitTemplate ||
        (creature.kit && creature.kit._source) ||
        null;
    const kit = normalizeCreatureKit(
        src || {
            attacks: creature.attacks,
            defenseSpells: creature.defenseSpells,
            flags: creature.flags,
            strategiesTarget: creature.strategiesTarget,
            changeTarget: creature.changeTarget,
            runHealthPercent: creature.runHealthPercent,
            aggroRange: creature.aggroRange,
            summon: creature.summon
        }
    );
    creature.kit = kit;
    creature.flags = kit.flags;
    creature.strategiesTarget = kit.strategiesTarget;
    creature.attacks = kit.attacks;
    creature.defenseSpells = kit.defenseSpells;
    creature.summon = kit.summon;
    // Per-attack ready timers (seconds remaining until next try window)
    if (
        !Array.isArray(creature._attackReadyIn) ||
        creature._attackReadyIn.length !== kit.attacks.length
    ) {
        creature._attackReadyIn = kit.attacks.map(() => 0);
    }
    if (
        !Array.isArray(creature._defenseReadyIn) ||
        creature._defenseReadyIn.length !== kit.defenseSpells.length
    ) {
        creature._defenseReadyIn = kit.defenseSpells.map(() => 0);
    }
    const summonLen = kit.summon && kit.summon.summons
        ? kit.summon.summons.length
        : 0;
    if (
        !Array.isArray(creature._summonReadyIn) ||
        creature._summonReadyIn.length !== summonLen
    ) {
        creature._summonReadyIn = Array(summonLen).fill(0);
    }
    if (!Array.isArray(creature.summonIds)) {
        creature.summonIds = [];
    }
    if (!creature.damageTakenBy || typeof creature.damageTakenBy !== 'object') {
        creature.damageTakenBy = Object.create(null);
    }
    return kit;
}

/**
 * True when this unit is another creature's summon.
 * @param {object} creature
 * @returns {boolean}
 */
function isSummon(creature) {
    return !!(creature && creature.masterId != null && creature.masterId > 0);
}

/**
 * Whether this unit auto-attacks (legacy setAttackedCreature).
 * Non-hostile wild animals still follow / flee; summons attack even when
 * template `aggro` is false.
 * @param {object|null|undefined} owner
 * @returns {boolean}
 */
function creatureAutoAttacks(owner) {
    if (!owner) return false;
    if (isSummon(owner)) return true;
    return owner.aggro !== false;
}

/**
 * True when a summon's master is a party player (player-cast summon creature).
 * Used to keep ally summons out of the hostile enemy list and retarget them
 * at wild creatures instead of the party.
 *
 * @param {object|null|undefined} creature
 * @param {object|null|undefined} sim
 * @returns {boolean}
 */
function isPartyOwnedSummon(creature, sim) {
    if (!isSummon(creature)) return false;
    if (creature.partyOwned === true || creature.allySummon === true) return true;
    if (!sim) return false;
    let master = null;
    if (typeof sim.getEntityById === 'function') {
        master = sim.getEntityById(creature.masterId);
    } else if (sim.entityById && typeof sim.entityById.get === 'function') {
        master = sim.entityById.get(creature.masterId);
    }
    return !!(master && (master.type === 'player' || master.isPlayer === true));
}

/**
 * Prune dead/missing ids from master.summonIds and return living summon entities.
 * @param {object} master
 * @param {object} [ctx]
 * @returns {object[]}
 */
function livingSummonsOf(master, ctx) {
    if (!master || !Array.isArray(master.summonIds) || !master.summonIds.length) {
        return [];
    }
    const sim = ctx && ctx.sim;
    const resolve =
        (sim && typeof sim.getEntityById === 'function' &&
            ((id) => sim.getEntityById(id))) ||
        (sim && sim.entityById && typeof sim.entityById.get === 'function' &&
            ((id) => sim.entityById.get(id))) ||
        (ctx && typeof ctx.resolveEntity === 'function' && ctx.resolveEntity) ||
        null;
    if (!resolve) {
        // Without a resolver keep ids but report empty (cannot verify life).
        return [];
    }
    /** @type {object[]} */
    const living = [];
    /** @type {number[]} */
    const keep = [];
    for (let i = 0; i < master.summonIds.length; i++) {
        const id = master.summonIds[i];
        const ent = resolve(id);
        if (!ent || ent.alive === false || (ent.hp && ent.hp.current <= 0)) {
            continue;
        }
        living.push(ent);
        keep.push(id);
    }
    master.summonIds = keep;
    return living;
}

/**
 * Tick summon ready timers.
 * @param {object} owner
 * @param {number} [dt]
 */
function tickSummonTimers(owner, dt) {
    if (!owner || !Array.isArray(owner._summonReadyIn)) return;
    const step =
        dt != null
            ? Number(dt)
            : Time && Time.deltaTime != null
              ? Time.deltaTime
              : 0.05;
    for (let i = 0; i < owner._summonReadyIn.length; i++) {
        if (owner._summonReadyIn[i] > 0) {
            owner._summonReadyIn[i] = Math.max(
                0,
                owner._summonReadyIn[i] - step
            );
        }
    }
}

/**
 * Attempt monster auto-summon (Legacy onThinkDefense summon path).
 * Does not block offense. Requires feature flag, combat engagement, and
 * `ctx.sim.spawnSummon` (or `ctx.spawnSummon`).
 *
 * @param {object} owner
 * @param {object} [ctx]
 * @param {object|null} [primaryTarget]
 * @returns {{ fired: boolean, summonId?: string, entity?: object }}
 */
function tryMonsterSummons(owner, ctx, primaryTarget) {
    const c = ctx || {};
    if (!isModeMonsterSummonsEnabled(c)) {
        return { fired: false };
    }
    if (!owner || owner.alive === false) return { fired: false };
    // Summons do not nest (Legacy !isSummon())
    if (isSummon(owner)) return { fired: false };

    ensureCreatureKit(owner);
    const kit = owner.kit;
    const cfg = kit && kit.summon;
    if (!cfg || !cfg.summons || !cfg.summons.length || !(cfg.maxSummons > 0)) {
        return { fired: false };
    }

    // In combat: sticky target, inBattle, or explicit engaged flag
    const engaged =
        c.engaged === true ||
        !!owner.inBattle ||
        !!(
            primaryTarget &&
            primaryTarget.alive !== false &&
            primaryTarget.hp &&
            primaryTarget.hp.current > 0
        ) ||
        !!(owner.target && owner.target.alive !== false);
    if (!engaged) return { fired: false };

    const spawnFn =
        (typeof c.spawnSummon === 'function' && c.spawnSummon) ||
        (c.sim && typeof c.sim.spawnSummon === 'function' &&
            ((entry) => c.sim.spawnSummon(entry))) ||
        null;
    if (!spawnFn) return { fired: false };

    tickSummonTimers(owner);
    const living = livingSummonsOf(owner, c);
    if (living.length >= cfg.maxSummons) {
        return { fired: false };
    }

    const rng = typeof c.rng === 'function' ? c.rng : Math.random;
    const ready = owner._summonReadyIn;

    for (let i = 0; i < cfg.summons.length; i++) {
        const entry = cfg.summons[i];
        if (livingSummonsOf(owner, c).length >= cfg.maxSummons) {
            break;
        }
        if (ready[i] > 0) continue;

        // Open window then roll chance (same order as attack/defense kit)
        ready[i] = entry.intervalSec;
        if (entry.chance < 100 && rng() * 100 >= entry.chance) {
            continue;
        }

        // Cap per summon type (entry.count)
        let typeCount = 0;
        const current = livingSummonsOf(owner, c);
        for (let j = 0; j < current.length; j++) {
            const s = current[j];
            if (
                s &&
                (s.creatureType === entry.id ||
                    s.creatureType === entry.name ||
                    (s.name &&
                        String(s.name).toLowerCase() ===
                            String(entry.name).toLowerCase()))
            ) {
                typeCount += 1;
            }
        }
        if (typeCount >= entry.count) continue;

        const spawned = spawnFn({
            creatureId: entry.id,
            master: owner,
            force: entry.force,
            x: owner.tile && owner.tile.x,
            y: owner.tile && owner.tile.y,
            z: owner.tile && owner.tile.z
        });
        if (spawned) {
            return {
                fired: true,
                summonId: entry.id,
                entity: spawned
            };
        }
    }

    return { fired: false };
}

/**
 * Whether low-HP flee posture is active.
 * @param {object} owner
 * @param {CreatureFlags} [flags]
 * @returns {boolean}
 */
function isFleeing(owner, flags) {
    const f = flags || (owner && owner.kit && owner.kit.flags) || null;
    if (!owner || !f) return false;
    // Legacy: challenge focus / force-melee suppress flee (challengeFocusDuration / challengeMeleeDuration).
    try {
        const {
            isCreatureChallenged,
            isForceMeleeActive
        } = require('../combat/resolve.js');
        if (isCreatureChallenged(owner) || isForceMeleeActive(owner)) {
            return false;
        }
    } catch (_) {
        /* resolve optional at load edge */
    }
    const hp = owner.hp && owner.hp.current != null ? owner.hp.current : 0;
    const max = owner.hp && owner.hp.max != null ? owner.hp.max : 0;
    if (f.runHealth > 0 && hp <= f.runHealth) return true;
    if (f.runHealthPercent > 0 && max > 0 && hp / max <= f.runHealthPercent) {
        return true;
    }
    return false;
}

/**
 * Ideal stand-off distance for movement (1 = adjacent melee).
 * Honors temporary force-melee from chivalrous_challenge / divine_dazzle.
 * @param {object} owner
 * @returns {number}
 */
function idealStandDistance(owner) {
    const kit = owner && owner.kit ? owner.kit : ensureCreatureKit(owner);
    const f = kit.flags;
    if (isFleeing(owner, f)) return f.fleeTargetDistance;
    try {
        const { getForcedTargetDistance } = require('../combat/resolve.js');
        const forced = getForcedTargetDistance(owner);
        if (forced != null) return forced;
    } catch (_) {
        /* resolve optional at load edge */
    }
    return Math.max(1, f.targetDistance | 0);
}

/**
 * Hard lose distance (may stretch while fleeing).
 * @param {object} owner
 * @returns {number}
 */
function loseTargetDistance(owner) {
    const kit = owner && owner.kit ? owner.kit : ensureCreatureKit(owner);
    const f = kit.flags;
    if (isFleeing(owner, f)) {
        return Math.max(f.loseTargetDistance, f.fleeTargetDistance);
    }
    return f.loseTargetDistance;
}

/**
 * @param {object} owner
 * @param {object[]} players fallback list when no spatial index
 * @param {object} [opts]
 * @param {() => number} [opts.rng]
 * @param {number} [opts.range] override aggro range
 * @param {object} [opts.index] SpatialIndex of players (Etapa 5)
 * @returns {object|null}
 */
function pickCreatureTarget(owner, players, opts) {
    const o = opts || {};
    const kit = owner && owner.kit ? owner.kit : ensureCreatureKit(owner);
    const range =
        o.range != null ? o.range : kit.flags.aggroRange;
    // Prefer player spatial index (O(local chunks)); else linear over list.
    const near = queryWithinRange(owner, range, {
        index: o.index || null,
        candidates: players || []
    });
    if (!near.length) return null;
    // Attack selection only (legacy isTarget / canSeeCreature). Invisible players
    // stay out of combat focus but may still count as living presence for idle
    // random walk — see hasLivingPresence in creature_states.
    const tileMap = o.tileMap || (o.sim && o.sim.tileMap) || null;
    const targetOpts = { tileMap };
    const attackable = [];
    for (let i = 0; i < near.length; i++) {
        if (isValidTarget(owner, near[i], targetOpts)) attackable.push(near[i]);
    }
    if (!attackable.length) return null;
    const strategy = pickWeightedKey(kit.strategiesTarget, o.rng);
    return pickByStrategy(owner, attackable, strategy || 'nearest', o.rng);
}

/**
 * Record damage a player dealt to this creature (for "damage" targeting).
 * Applies pending threat decay before adding so older hits age correctly.
 * @param {object} creature
 * @param {object} attacker
 * @param {number} amount
 */
function recordDamageTakenBy(creature, attacker, amount) {
    if (!creature || !attacker || !(amount > 0)) return;
    if (attacker.type === 'creature') return;
    const id = attacker.id;
    if (id == null) return;
    applyThreatDecay(creature);
    if (!creature.damageTakenBy) creature.damageTakenBy = Object.create(null);
    const key = id;
    creature.damageTakenBy[key] =
        (Number(creature.damageTakenBy[key]) || 0) + amount;
}

/**
 * Current threat score for a player id after lazy decay (0 if none).
 * @param {object} creature
 * @param {string|number} playerId
 * @returns {number}
 */
function threatOf(creature, playerId) {
    if (!creature || playerId == null) return 0;
    applyThreatDecay(creature);
    const bag = creature.damageTakenBy;
    if (!bag) return 0;
    return Number(bag[playerId] || bag[String(playerId)] || 0) || 0;
}

/**
 * Build a synthetic spell def for one kit attack.
 * Wave/area include `shape` so resolveShapedAttack + watch VFX use the same
 * legacy matrices as player spells (WAVE_SPREAD_MAP / area codes).
 * @param {NormalizedAttack} atk
 * @returns {object}
 */
function attackToSpell(atk) {
    const kind = atk.kind || 'melee';
    const length =
        atk.length != null ? Math.max(0, Number(atk.length) | 0) : 0;
    const spread =
        atk.spread != null ? Math.max(0, Number(atk.spread) | 0) : 0;
    const radius =
        atk.radius != null ? Math.max(0, Number(atk.radius) | 0) : 0;
    // Wave facing/centroid scan should cover the full breath length
    let range = atk.range != null ? Number(atk.range) : 1;
    if (kind === 'wave' && length > range) range = length;

    const spell = {
        id: atk.id,
        label: atk.id,
        kind: kind === 'melee' ? 'auto' : 'spell',
        // Preserve kit shape for watch VFX (area/wave footprint, range)
        attackKind: kind,
        radius,
        length,
        spread,
        element: atk.element || 'physical',
        range,
        mana: 0,
        hitChance: atk.hitChance != null ? atk.hitChance : 100,
        isMelee: !!atk.isMelee,
        basePower: atk.basePower || 0,
        // Per-attack gate only (no shared primary.attack) so multi-hit kits work
        cooldowns: {
            spell: { [atk.id]: atk.intervalSec }
        }
    };
    // Field kits (firefield_*, poisonfield_*, energyfield_*) deploy terrain hazards.
    const fk = getFieldKind(atk.deploysField || atk.field || atk.id || null);
    if (fk) {
        spell.field = fk;
        spell.deploysField = fk;
    }
    if (atk.moveLock != null) spell.moveLock = atk.moveLock;
    // Creature kit: fixed damage only (no player-style power curves).
    spell.min = atk.min != null ? Number(atk.min) : 0;
    spell.max = atk.max != null ? Number(atk.max) : 0;
    if (spell.max < spell.min) {
        const t = spell.min;
        spell.min = spell.max;
        spell.max = t;
    }
    spell.powerCurve = undefined;

    // Legacy: radius is the area matrix code; length+spread is a wave.
    if (kind === 'wave' && length > 0) {
        spell.shape = { type: 'wave', length, spread };
    } else if (kind === 'area' && radius > 0) {
        spell.shape = { type: 'area', code: radius };
    } else if (!spell.shape && fk) {
        spell.shape = { type: 'area', code: Math.max(1, radius) };
    }
    return spell;
}

/**
 * Fire a shaped kit attack (wave / area) via the shared multi-target path.
 * Uses kit timers (skipCooldown); records multi hits + footprint for VFX.
 *
 * @param {object} owner
 * @param {object|null} primaryTarget
 * @param {NormalizedAttack} atk
 * @param {object} ctx
 * @param {object[]} players
 * @param {() => number} rng
 * @returns {{ fired: boolean, attackId?: string, results?: object[], shaped?: object }}
 */
function tryShapedKitAttack(owner, primaryTarget, atk, ctx, players, rng) {
    const c = ctx || {};
    const spell = attackToSpell(atk);
    if (!spellHasShape(spell)) {
        return { fired: false };
    }

    const tileMap = c.tileMap || (c.sim && c.sim.tileMap) || null;
    const targetOpts = { tileMap };
    const dPrimary =
        primaryTarget && isValidTarget(owner, primaryTarget, targetOpts)
            ? distBetween(owner, primaryTarget)
            : Infinity;

    if (atk.needsTarget) {
        if (!primaryTarget || !isValidTarget(owner, primaryTarget, targetOpts)) {
            return { fired: true, attackId: atk.id, results: [] };
        }
        if (dPrimary > atk.range) {
            return { fired: true, attackId: atk.id, results: [] };
        }
    } else if (atk.kind === 'wave' && (!owner || !owner.tile)) {
        return { fired: true, attackId: atk.id, results: [] };
    }
    // Local candidates for multi-hit footprint (Etapa 5: avoid O(P) at 1000 players).
    const shapeReach = Math.max(
        atk.range != null ? Number(atk.range) : 0,
        atk.length != null ? Number(atk.length) : 0,
        atk.radius != null ? Number(atk.radius) : 0,
        1
    );
    const candidates = c.playerIndex
        ? queryWithinRange(owner, shapeReach, {
              index: c.playerIndex,
              candidates: players || []
          })
        : players || [];
    const groundStore =
        c.groundStore ||
        (c.sim && (c.sim.groundItems || c.sim.groundStore)) ||
        (tileMap && (tileMap.groundStore || tileMap.groundItems)) ||
        null;
    const result = resolveShapedAttack({
        attacker: owner,
        primary: primaryTarget || null,
        spell,
        candidates,
        tileMap,
        groundStore,
        sim: c.sim || null,
        spellBook: spellBookFromCtx(c),
        rng: typeof rng === 'function' ? rng : Math.random,
        // Kit-managed per-attack timers — do not touch spell CD buckets
        skipCooldown: true,
        // Maximize multi-hit footprint among players in range (same as player AI)
        centerMode: 'maximize'
    });
    if (!result.ok) {
        return { fired: false };
    }

    recordAttackResult(owner, primaryTarget || null, result, c);
    return {
        fired: true,
        attackId: atk.id,
        results: result.results || [],
        shaped: result
    };
}

/**
 * Advance attack ready timers by dt (seconds). Call from creature brain free ticks.
 * @param {object} owner
 * @param {number} [dt]
 */
function tickAttackTimers(owner, dt) {
    if (!owner || !Array.isArray(owner._attackReadyIn)) return;
    const step =
        dt != null
            ? Number(dt)
            : Time && Time.deltaTime != null
              ? Time.deltaTime
              : 0.05;
    for (let i = 0; i < owner._attackReadyIn.length; i++) {
        if (owner._attackReadyIn[i] > 0) {
            owner._attackReadyIn[i] = Math.max(
                0,
                owner._attackReadyIn[i] - step
            );
        }
    }
}

/**
 * Cardinal direction from a toward b (for waves).
 * @param {{x:number,y:number}} from
 * @param {{x:number,y:number}} to
 * @returns {{x:number,y:number}}
 */
function cardinalToward(from, to) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    if (Math.abs(dx) >= Math.abs(dy)) {
        return { x: dx >= 0 ? 1 : -1, y: 0 };
    }
    return { x: 0, y: dy >= 0 ? 1 : -1 };
}

/**
 * Tiles covered by a simple wave (length × spread about the axis).
 * @param {{x:number,y:number,z?:*}} origin first tile in front of caster
 * @param {{x:number,y:number}} dir
 * @param {number} length
 * @param {number} spread
 * @returns {{x:number,y:number}[]}
 */
function waveTiles(origin, dir, length, spread) {
    const out = [];
    const len = Math.max(1, length | 0);
    const spr = Math.max(0, spread | 0);
    const perp = { x: -dir.y, y: dir.x };
    for (let i = 0; i < len; i++) {
        const cx = origin.x + dir.x * i;
        const cy = origin.y + dir.y * i;
        for (let s = -spr; s <= spr; s++) {
            out.push({ x: cx + perp.x * s, y: cy + perp.y * s });
        }
    }
    return out;
}

/**
 * Resolve one attack against one defender.
 * @param {object} owner
 * @param {object} defender
 * @param {NormalizedAttack} atk
 * @param {object} ctx
 * @returns {object|null}
 */
function resolveKitHit(owner, defender, atk, ctx) {
    if (!owner || !defender || !atk) return null;
    // Status-only (slow / pure condition): apply condition without damage roll
    if (atk.kind === 'status' || (atk.statusOnly && atk.condition)) {
        if (atk.condition) {
            applyCondition(defender, atk.condition, {
                source: owner.creatureType || owner.name || null
            });
        }
        const result = {
            ok: true,
            hit: true,
            final: 0,
            hpDelta: 0,
            spell: attackToSpell(atk),
            condition: atk.condition || null
        };
        if (ctx && ctx.sim && typeof ctx.sim.recordAttack === 'function') {
            ctx.sim.recordAttack(owner, defender, result);
        } else if (ctx && typeof ctx.onAttack === 'function') {
            ctx.onAttack(owner, defender, result);
        }
        return result;
    }
    const spell = attackToSpell(atk);
    const result = resolveAttack({
        attacker: owner,
        defender,
        spell,
        spellBook: spellBookFromCtx(ctx),
        rng: ctx && ctx.rng ? ctx.rng : Math.random,
        // Kit timers own recast; never use player auto/power-curve buckets.
        skipCooldown: true,
        // Kit is multiply-only (no ST auto 65% band).
        critBand: 'multiply'
    });
    if (
        result &&
        result.ok &&
        result.hit &&
        atk.condition &&
        defender &&
        defender.alive
    ) {
        applyCondition(defender, atk.condition, {
            source: owner.creatureType || owner.name || null
        });
        result.condition = atk.condition;
    }
    if (ctx && ctx.sim && typeof ctx.sim.recordAttack === 'function') {
        ctx.sim.recordAttack(owner, defender, result);
    } else if (ctx && typeof ctx.onAttack === 'function') {
        ctx.onAttack(owner, defender, result);
    }
    return result;
}

/**
 * Tick defense-spell ready timers.
 * @param {object} owner
 */
function tickDefenseTimers(owner, dt) {
    if (!owner || !Array.isArray(owner._defenseReadyIn)) return;
    const step =
        dt != null
            ? Number(dt)
            : Time && Time.deltaTime != null
              ? Time.deltaTime
              : 0.05;
    for (let i = 0; i < owner._defenseReadyIn.length; i++) {
        if (owner._defenseReadyIn[i] > 0) {
            owner._defenseReadyIn[i] = Math.max(
                0,
                owner._defenseReadyIn[i] - step
            );
        }
    }
}

/**
 * Attempt one defense spell (heal / haste / invisible). Max one success per think.
 * @param {object} owner
 * @param {object} [ctx]
 * @returns {{ fired: boolean, spellId?: string, kind?: string }}
 */
function tryDefenseSpells(owner, ctx) {
    const c = ctx || {};
    ensureCreatureKit(owner);
    const kit = owner.kit;
    if (!kit.defenseSpells || !kit.defenseSpells.length) {
        return { fired: false };
    }
    tickDefenseTimers(owner);

    const rng = typeof c.rng === 'function' ? c.rng : Math.random;
    const ready = owner._defenseReadyIn;
    const hp = owner.hp && owner.hp.current != null ? owner.hp.current : 0;
    const hpMax = owner.hp && owner.hp.max != null ? owner.hp.max : 0;
    const hpFrac = hpMax > 0 ? hp / hpMax : 1;

    for (let i = 0; i < kit.defenseSpells.length; i++) {
        const spell = kit.defenseSpells[i];
        if (ready[i] > 0) continue;

        ready[i] = spell.intervalSec;
        if (spell.chance < 100 && rng() * 100 >= spell.chance) {
            continue;
        }

        if (spell.kind === 'heal') {
            const below =
                spell.hpBelow != null ? Number(spell.hpBelow) : 0.7;
            if (!(hpFrac < below)) continue;
            if (!(hpMax > 0) || hp >= hpMax) continue;
            const min = Number(spell.min) || 0;
            const max = Number(spell.max) || min;
            const roll =
                max <= min
                    ? min
                    : min + Math.floor(rng() * (max - min + 1));
            if (!(roll > 0)) continue;
            applyHpDelta(owner, roll, 'healing');
            return { fired: true, spellId: spell.id, kind: 'heal' };
        }

        if (spell.kind === 'haste') {
            if (hasHaste(owner)) continue;
            applyCondition(
                owner,
                {
                    type: 'haste',
                    speedChange: spell.speedChange,
                    durationSec: spell.durationSec
                },
                { source: 'defense_spell' }
            );
            return { fired: true, spellId: spell.id, kind: 'haste' };
        }

        if (spell.kind === 'invisible') {
            if (isInvisible(owner)) continue;
            applyCondition(
                owner,
                {
                    type: 'invisible',
                    durationSec: spell.durationSec
                },
                { source: 'defense_spell' }
            );
            return {
                fired: true,
                spellId: spell.id,
                kind: 'invisible'
            };
        }
    }

    return { fired: false };
}

/**
 * Attempt multi-attack kit once (legacy: one successful attack max per think).
 * Advances internal ready timers; rolls staticAttackChance then per-attack chance.
 *
 * @param {object} owner
 * @param {object|null} primaryTarget sticky target
 * @param {object} ctx { players, sim, spellBook, rng, tileMap }
 * @returns {{ fired: boolean, attackId?: string, results?: object[] }}
 */
function tryCreatureAttacks(owner, primaryTarget, ctx) {
    const c = ctx || {};
    ensureCreatureKit(owner);
    const kit = owner.kit;
    tickAttackTimers(owner);

    // Self defense (heal/haste/invis) before offensive kit — legacy order-ish
    const def = tryDefenseSpells(owner, c);
    if (def.fired) {
        // Summons still roll on defense ticks (Legacy onThinkDefense)
        tryMonsterSummons(owner, c, primaryTarget);
        return {
            fired: true,
            attackId: def.spellId,
            defense: true,
            kind: def.kind,
            results: []
        };
    }

    // Auto-summon does not consume the offensive pass (Legacy separates ticks)
    tryMonsterSummons(owner, c, primaryTarget);

    // Non-hostile wild units follow / flee but do not setAttackedCreature.
    if (!creatureAutoAttacks(owner)) {
        return { fired: false };
    }

    const rng = typeof c.rng === 'function' ? c.rng : Math.random;
    const staticChance = kit.flags.staticAttackChance;
    if (staticChance < 100) {
        if (rng() * 100 >= staticChance) {
            return { fired: false };
        }
    }

    const players = c.players || [];
    const ready = owner._attackReadyIn;

    for (let i = 0; i < kit.attacks.length; i++) {
        const atk = kit.attacks[i];
        if (ready[i] > 0) continue;
        // Legacy canUseSpell: melee is suppressed while fleeing.
        if (
            (atk.isMelee || atk.kind === 'melee') &&
            isFleeing(owner, kit.flags)
        ) {
            continue;
        }

        // Window opened — reset interval then roll chance (legacy order)
        ready[i] = atk.intervalSec;
        if (atk.chance < 100 && rng() * 100 >= atk.chance) {
            continue;
        }

        // Wave / area / field deploying: legacy shape matrices + multi-target resolve (footprint VFX)
        const deploysField = !!(atk.deploysField || atk.field || getFieldKind(atk.id || ''));
        if (atk.kind === 'wave' || atk.kind === 'area' || deploysField) {
            const shaped = tryShapedKitAttack(
                owner,
                primaryTarget,
                atk,
                c,
                players,
                rng
            );
            if (shaped.fired) {
                // Apply condition from shaped hits if present
                if (
                    atk.condition &&
                    shaped.results &&
                    shaped.results.length
                ) {
                    for (let r = 0; r < shaped.results.length; r++) {
                        const row = shaped.results[r];
                        const defn =
                            row && (row.defender || row.target);
                        if (defn && defn.alive !== false) {
                            applyCondition(defn, atk.condition, {
                                source:
                                    owner.creatureType ||
                                    owner.name ||
                                    null
                            });
                        }
                    }
                }
                return shaped;
            }
            // No shape metadata (e.g. area radius 0): fall through to single-target
            if (atk.kind === 'wave') {
                // Wave without length should not soft-lock the kit pass
                return { fired: true, attackId: atk.id, results: [] };
            }
        }

        // melee / ranged / status single-target
        const tileMap = c.tileMap || (c.sim && c.sim.tileMap) || null;
        const target =
            primaryTarget && isValidTarget(owner, primaryTarget, { tileMap })
                ? primaryTarget
                : null;
        if (!target) {
            return { fired: true, attackId: atk.id, results: [] };
        }
        if (isProtectedTarget(target, tileMap)) {
            return { fired: true, attackId: atk.id, results: [] };
        }
        const reach =
            atk.kind === 'wave'
                ? Math.max(atk.range, atk.length || 0)
                : atk.range;
        const d = distBetween(owner, target);
        if (d > reach) {
            return { fired: true, attackId: atk.id, results: [] };
        }
        // Ranged (and any non-adjacent) kit hits need clear LoS — walls block.
        if (
            tileMap &&
            owner.tile &&
            target.tile &&
            !hasLineOfSight(
                owner.tile.x,
                owner.tile.y,
                owner.tile.z,
                target.tile.x,
                target.tile.y,
                target.tile.z,
                tileMap
            )
        ) {
            return { fired: true, attackId: atk.id, results: [] };
        }
        const r = resolveKitHit(owner, target, atk, c);
        return {
            fired: true,
            attackId: atk.id,
            results: r ? [r] : []
        };
    }

    return { fired: false };
}

/**
 * Max attack range from kit (for "in combat reach" checks).
 * @param {object} owner
 * @returns {number}
 */
function maxAttackRange(owner) {
    ensureCreatureKit(owner);
    let m = 1;
    const atks = owner.kit.attacks;
    for (let i = 0; i < atks.length; i++) {
        const a = atks[i];
        const r =
            a.kind === 'wave'
                ? Math.max(a.range, a.length || 0)
                : a.range;
        if (r > m) m = r;
    }
    return m;
}

module.exports = {
    DEFAULT_STRATEGIES,
    THREAT_EPS,
    STRATEGY_RETARGET_AT_KEY,
    pickWeightedKey,
    pickByStrategy,
    pickExtreme,
    normalizeStrategiesTarget,
    normalizeFlags,
    changeTargetFromTemplate,
    normalizeAttack,
    normalizeDefenseSpell,
    normalizeSummonConfig,
    normalizeCreatureKit,
    ensureCreatureKit,
    applyKitDamageMult,
    isFleeing,
    isSummon,
    creatureAutoAttacks,
    isPartyOwnedSummon,
    livingSummonsOf,
    idealStandDistance,
    loseTargetDistance,
    pickCreatureTarget,
    recordDamageTakenBy,
    applyThreatDecay,
    threatDecayHalflife,
    threatOf,
    retargetIntervalSec,
    retargetChance,
    armStrategyRetarget,
    clearStrategyRetarget,
    strategyRetargetDue,
    attackToSpell,
    tickAttackTimers,
    tickDefenseTimers,
    tickSummonTimers,
    tryDefenseSpells,
    tryMonsterSummons,
    tryCreatureAttacks,
    maxAttackRange,
    waveTiles,
    cardinalToward
};
