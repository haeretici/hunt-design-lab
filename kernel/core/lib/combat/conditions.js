/**
 * Lightweight combat conditions / buffs (DoTs + HoT + slow/haste/invisible + stances).
 *
 * Ported from legacy condition + defense_spell fields. Intentionally small —
 * not full stack parity. DoT kinds: poison, fire, ice, energy, bleed, curse, holy.
 * HoT kind: regen (legacy CONDITION_REGENERATION — fixed HP every interval for duration).
 * Stance kind: attributes (legacy CONDITION_ATTRIBUTES — skill%/damage%/defense).
 * Pooled absorb: mana_shield (legacy CONDITION_MANASHIELD — HP → mana against a pool).
 *
 * Entity shape:
 *   entity.conditions: ConditionInstance[]
 *   entity.baseSpeed: number (snapshot of unbuffed speed)
 *   entity.invisible: boolean (derived each tick / apply)
 *   entity.speed: effective move speed (recomputed from base + mods)
 *   entity.cannotAttack: boolean (derived — Stage-1 swift foot pacify)
 */

'use strict';

const { applyMitigation } = require('./damage.js');

/**
 * @typedef {object} ConditionDef
 * @property {string} type  poison | fire | ice | energy | bleed | curse | holy | freezing | slow | haste | invisible | regen | attributes | mana_shield
 * @property {number} [totalDamage]
 * @property {number} [intervalMs]
 * @property {number} [intervalSec]
 * @property {number} [durationSec]
 * @property {number} [durationMs]
 * @property {number} [speedChange]
 * @property {number} [healthGain] HoT HP restored per tick
 * @property {object[]} [schedule]
 * @property {boolean} [forceOverride]
 * @property {string} [subId] exclusive stance group (shared subId cancels peer)
 * @property {object} [skillPercent] skill key → percent (100 = baseline)
 * @property {number} [damageDealtPercent] outgoing damage mult (100 = baseline)
 * @property {number} [damageReceivedPercent] incoming damage mult (100 = baseline)
 * @property {boolean} [disableDefense] block shield / defense rolls
 * @property {boolean} [cannotAttack] pacify — block attack/auto casts
 * @property {object} [speedFormula] optional haste/slow formula (attributes stances)
 * @property {number} [poolRemaining] mana_shield live absorb pool
 * @property {number} [poolMax] mana_shield snapshot cap
 * @property {string} [poolFormula] e.g. legacy_mana_shield (resolved at apply)
 */

/**
 * @typedef {object} ConditionInstance
 * @property {string} id
 * @property {string} kind  poison | fire | ice | energy | bleed | curse | holy | slow | haste | invisible | regen | attributes | mana_shield
 * @property {number} [remainingDamage]
 * @property {number} [tickIntervalSec]
 * @property {number} [tickTimer]
 * @property {number} [durationSec]
 * @property {number} [speedChange]
 * @property {number} [healthGain] HoT HP per tick
 * @property {string} [element] damage element for DoT ticks
 * @property {string} [source] optional source label
 * @property {string} [subId]
 * @property {object} [skillPercent]
 * @property {number} [damageDealtPercent]
 * @property {number} [damageReceivedPercent]
 * @property {boolean} [disableDefense]
 * @property {boolean} [cannotAttack]
 * @property {number} [poolRemaining]
 * @property {number} [poolMax]
 */

/** Canonical DoT kinds (engine-stored). Aliases resolve here at normalize time. */
const DOT_KINDS = {
    poison: { kind: 'poison', element: 'earth' },
    condition_poison: { kind: 'poison', element: 'earth' },
    fire: { kind: 'fire', element: 'fire' },
    condition_fire: { kind: 'fire', element: 'fire' },
    freezing: { kind: 'ice', element: 'ice' },
    condition_freezing: { kind: 'ice', element: 'ice' },
    ice: { kind: 'ice', element: 'ice' },
    condition_ice: { kind: 'ice', element: 'ice' },
    // Electrification (monster pure-condition + future player utori vis)
    energy: { kind: 'energy', element: 'energy' },
    condition_energy: { kind: 'energy', element: 'energy' },
    electrification: { kind: 'energy', element: 'energy' },
    electrify: { kind: 'energy', element: 'energy' },
    // Bleeding
    bleed: { kind: 'bleed', element: 'physical' },
    bleeding: { kind: 'bleed', element: 'physical' },
    condition_bleeding: { kind: 'bleed', element: 'physical' },
    // Curse (death-element DoT)
    curse: { kind: 'curse', element: 'death' },
    cursed: { kind: 'curse', element: 'death' },
    condition_cursed: { kind: 'curse', element: 'death' },
    // Holy flash / dazzled (holy-element DoT)
    holy: { kind: 'holy', element: 'holy' },
    dazzled: { kind: 'holy', element: 'holy' },
    dazzle: { kind: 'holy', element: 'holy' },
    condition_dazzled: { kind: 'holy', element: 'holy' }
};

/** @type {ReadonlySet<string>} */
const DOT_KIND_SET = new Set([
    'poison',
    'fire',
    'ice',
    'energy',
    'bleed',
    'curse',
    'holy'
]);

/**
 * Normalize a legacy or engine condition payload into a ConditionDef.
 * @param {object|null|undefined} raw
 * @returns {ConditionDef|null}
 */
function normalizeConditionDef(raw) {
    if (!raw || typeof raw !== 'object') return null;
    let type = String(raw.type || raw.kind || raw.name || '')
        .toLowerCase()
        .replace(/^condition_/, '');
    // Accept CONDITION_POISON style
    type = type.replace(/^condition_/, '');
    if (raw.type && /^condition_/i.test(String(raw.type))) {
        type = String(raw.type)
            .toLowerCase()
            .replace(/^condition_/, '');
    }

    if (type === 'speed') {
        const sc = Number(raw.speedChange);
        if (!Number.isFinite(sc) || sc === 0) return null;
        type = sc < 0 ? 'slow' : 'haste';
    }
    // Paralyze is a heavy slow (legacy CONDITION_PARALYZE); store as slow.
    if (type === 'paralyze' || type === 'paralysis' || type === 'paralysed') {
        type = 'slow';
    }

    const durationSec =
        raw.durationSec != null
            ? Math.max(0, Number(raw.durationSec) || 0)
            : raw.durationMs != null
              ? Math.max(0, (Number(raw.durationMs) || 0) / 1000)
              : raw.duration != null
                ? Math.max(0, (Number(raw.duration) || 0) / 1000)
                : 0;

    const intervalSec =
        raw.intervalSec != null
            ? Math.max(0.05, Number(raw.intervalSec) || 1)
            : raw.intervalMs != null
              ? Math.max(0.05, (Number(raw.intervalMs) || 4000) / 1000)
              : raw.interval != null
                ? (() => {
                      const n = Number(raw.interval) || 4000;
                      // Legacy stores ms (typically 2000–9000)
                      return n > 20
                          ? Math.max(0.05, n / 1000)
                          : Math.max(0.05, n);
                  })()
                : 4;

    let totalDamage =
        raw.totalDamage != null
            ? Math.max(0, Math.abs(Number(raw.totalDamage) || 0))
            : raw.damage != null
              ? Math.max(0, Math.abs(Number(raw.damage) || 0))
              : 0;

    const speedChange =
        raw.speedChange != null ? Number(raw.speedChange) || 0 : 0;

    const dotMeta =
        DOT_KINDS[type] || DOT_KINDS[type.replace(/^condition_/, '')] || null;
    if (dotMeta || DOT_KIND_SET.has(type)) {
        const kind = dotMeta ? dotMeta.kind : type;
        let schedule = null;
        if (Array.isArray(raw.schedule) && raw.schedule.length > 0) {
            schedule = raw.schedule.map((s) => Object.assign({}, s));
            if (!(totalDamage > 0)) {
                totalDamage = schedule.reduce((sum, st) => sum + (Number(st.turns || 0) * Number(st.damage || 0)), 0);
            }
        }
        if (!(totalDamage > 0)) return null;
        return {
            type: kind,
            totalDamage,
            intervalSec,
            intervalMs: Math.round(intervalSec * 1000),
            schedule,
            forceOverride: !!raw.forceOverride
        };
    }

    if (type === 'slow' || type === 'haste') {
        // speedChange may be resolved later via speedFormula in conditionDefFromSpell;
        // allow 0 here only when formula will fill it (normalize alone needs nonzero).
        if (!Number.isFinite(speedChange) || speedChange === 0) {
            if (!raw.speedFormula) return null;
            // Placeholder; conditionDefFromSpell overwrites before apply.
            return {
                type,
                speedChange: type === 'slow' ? -1 : 1,
                durationSec: durationSec > 0 ? durationSec : 5,
                speedFormula: raw.speedFormula
            };
        }
        return {
            type,
            speedChange,
            durationSec: durationSec > 0 ? durationSec : 5
        };
    }

    if (type === 'invisible' || type === 'invisibility') {
        return {
            type: 'invisible',
            durationSec: durationSec > 0 ? durationSec : 2
        };
    }

    // HoT / spell regeneration (legacy CONDITION_REGENERATION)
    // Fixed healthGain every intervalSec for durationSec — no ML/level scale.
    if (
        type === 'regen' ||
        type === 'regeneration' ||
        type === 'hot' ||
        type === 'recovery'
    ) {
        const healthGain = Math.max(
            0,
            Number(
                raw.healthGain != null
                    ? raw.healthGain
                    : raw.heal != null
                      ? raw.heal
                      : raw.hp != null
                        ? raw.hp
                        : 0
            ) || 0
        );
        if (!(healthGain > 0)) return null;
        const hotInterval =
            raw.intervalSec != null
                ? Math.max(0.05, Number(raw.intervalSec) || 3)
                : raw.intervalMs != null
                  ? Math.max(0.05, (Number(raw.intervalMs) || 3000) / 1000)
                  : raw.healthTicks != null
                    ? Math.max(0.05, (Number(raw.healthTicks) || 3000) / 1000)
                    : intervalSec > 0
                      ? intervalSec
                      : 3;
        const hotDuration =
            durationSec > 0
                ? durationSec
                : raw.ticks != null
                  ? Math.max(0, (Number(raw.ticks) || 0) / 1000)
                  : 60;
        if (!(hotDuration > 0)) return null;
        return {
            type: 'regen',
            healthGain,
            intervalSec: hotInterval,
            intervalMs: Math.round(hotInterval * 1000),
            durationSec: hotDuration
        };
    }

    // Stance / attribute buffs (legacy CONDITION_ATTRIBUTES)
    if (
        type === 'attributes' ||
        type === 'attribute' ||
        type === 'stance'
    ) {
        /** @type {object|null} */
        let skillPercent = null;
        const rawSkills =
            raw.skillPercent || raw.skills || raw.skillPercents || null;
        if (rawSkills && typeof rawSkills === 'object') {
            skillPercent = {};
            const keys = Object.keys(rawSkills);
            for (let i = 0; i < keys.length; i++) {
                const k = keys[i];
                const v = Number(rawSkills[k]);
                if (Number.isFinite(v) && v > 0) skillPercent[k] = v;
            }
            if (!Object.keys(skillPercent).length) skillPercent = null;
        }
        const damageDealtPercent =
            raw.damageDealtPercent != null
                ? Number(raw.damageDealtPercent)
                : raw.buffDamageDealt != null
                  ? Number(raw.buffDamageDealt)
                  : null;
        const damageReceivedPercent =
            raw.damageReceivedPercent != null
                ? Number(raw.damageReceivedPercent)
                : raw.buffDamageReceived != null
                  ? Number(raw.buffDamageReceived)
                  : null;
        const subId =
            raw.subId != null && String(raw.subId).trim() !== ''
                ? String(raw.subId).trim()
                : raw.subid != null && String(raw.subid).trim() !== ''
                  ? String(raw.subid).trim()
                  : null;
        const hasMods =
            skillPercent ||
            (damageDealtPercent != null &&
                Number.isFinite(damageDealtPercent)) ||
            (damageReceivedPercent != null &&
                Number.isFinite(damageReceivedPercent)) ||
            !!raw.disableDefense ||
            !!raw.cannotAttack ||
            (Number.isFinite(speedChange) && speedChange !== 0) ||
            !!raw.speedFormula;
        if (!hasMods) return null;
        /** @type {ConditionDef} */
        const def = {
            type: 'attributes',
            durationSec: durationSec > 0 ? durationSec : 10
        };
        if (subId) def.subId = subId;
        if (skillPercent) def.skillPercent = skillPercent;
        if (damageDealtPercent != null && Number.isFinite(damageDealtPercent)) {
            def.damageDealtPercent = damageDealtPercent;
        }
        if (
            damageReceivedPercent != null &&
            Number.isFinite(damageReceivedPercent)
        ) {
            def.damageReceivedPercent = damageReceivedPercent;
        }
        if (raw.disableDefense) def.disableDefense = true;
        if (raw.cannotAttack) def.cannotAttack = true;
        if (Number.isFinite(speedChange) && speedChange !== 0) {
            def.speedChange = speedChange;
        }
        if (raw.speedFormula) def.speedFormula = raw.speedFormula;
        return def;
    }

    // Pooled mana absorb (legacy CONDITION_MANASHIELD). Recast always overwrites.
    if (isManaShieldType(type)) {
        const pool = readManaShieldPool(raw);
        return {
            type: 'mana_shield',
            durationSec: durationSec > 0 ? durationSec : 180,
            poolRemaining: pool.poolRemaining,
            poolMax: pool.poolMax,
            poolFormula: raw.poolFormula || undefined
        };
    }

    return null;
}

/**
 * Map legacy CONDITION_* / free-text type → engine kind + element.
 * @param {string} type
 */
function resolveDotMeta(type) {
    const t = String(type || '')
        .toLowerCase()
        .replace(/^condition_/, '');
    return DOT_KINDS[t] || DOT_KINDS['condition_' + t] || null;
}

/**
 * @param {object} entity
 */
function ensureConditionList(entity) {
    if (!entity) return [];
    if (!Array.isArray(entity.conditions)) entity.conditions = [];
    return entity.conditions;
}

/**
 * Snapshot unbuffed speed once.
 * @param {object} entity
 */
function ensureBaseSpeed(entity) {
    if (!entity) return;
    if (entity.baseSpeed == null || !Number.isFinite(Number(entity.baseSpeed))) {
        entity.baseSpeed =
            entity.speed != null && Number.isFinite(Number(entity.speed))
                ? Number(entity.speed)
                : 100;
    }
}

/**
 * Recompute entity.speed, entity.invisible, entity.cannotAttack from conditions
 * and equipment ability flags (e.g. stealth_ring → combatStats.flags.invisible).
 * @param {object} entity
 */
function recomputeDerived(entity) {
    if (!entity) return;
    ensureBaseSpeed(entity);
    const list = ensureConditionList(entity);
    let speedMod = 0;
    let invisible = false;
    let cannotAttack = false;
    for (let i = 0; i < list.length; i++) {
        const c = list[i];
        if (!c) continue;
        if (c.kind === 'slow' || c.kind === 'haste' || c.kind === 'attributes') {
            speedMod += Number(c.speedChange) || 0;
        }
        if (c.kind === 'invisible') invisible = true;
        if (c.kind === 'attributes' && c.cannotAttack) cannotAttack = true;
    }
    // Gear abilities while equipped (legacy CONDITION_INVISIBLE from item abilities).
    // Duration of the invis is the item's durationSec budget, not a condition timer.
    const gearFlags = entity.combatStats && entity.combatStats.flags;
    if (gearFlags && gearFlags.invisible) invisible = true;
    entity.speed = Math.max(0, Number(entity.baseSpeed) + speedMod);
    entity.invisible = invisible;
    entity.cannotAttack = cannotAttack;
}

/**
 * Apply (or refresh) a condition on an entity.
 * DoTs stack by replacing same kind if new remaining ≥ old (keep stronger).
 * Buffs (haste/slow/invis) refresh duration / overwrite same kind.
 * HoT (regen): always overwrite same kind — duration + healthGain + interval
 * reset to the new spell (legacy recast of CONDITION_REGENERATION).
 * mana_shield: always overwrite same kind — duration + pool snapshot reset.
 *
 * @param {object} entity
 * @param {ConditionDef|object} def
 * @param {{ source?: string }} [opts]
 * @returns {ConditionInstance|null}
 */
function applyCondition(entity, def, opts) {
    if (!entity || !entity.alive) return null;
    const incoming =
        def && isManaShieldType(def.type || def.kind || def.name)
            ? resolveManaShieldDef(def, entity)
            : def;
    const norm = normalizeConditionDef(incoming);
    if (!norm) return null;
    // Respect immunities.paralyze (and other kind keys) before applying.
    if (isImmuneToCondition(entity, norm.type)) return null;
    if (
        (norm.type === 'slow' || norm.type === 'haste') &&
        isImmuneToCondition(entity, 'paralyze') &&
        norm.type === 'slow'
    ) {
        return null;
    }
    const list = ensureConditionList(entity);
    const o = opts || {};

    /** @type {ConditionInstance} */
    let inst;
    if (DOT_KIND_SET.has(norm.type)) {
        const meta = resolveDotMeta(norm.type) || {
            kind: norm.type,
            element:
                norm.type === 'poison'
                    ? 'earth'
                    : norm.type === 'bleed'
                      ? 'physical'
                      : norm.type === 'curse'
                        ? 'death'
                        : norm.type
        };
        inst = {
            id: meta.kind,
            kind: meta.kind,
            remainingDamage: norm.totalDamage,
            tickIntervalSec: norm.intervalSec || 4,
            tickTimer: 0, // first tick after one interval (legacy-ish)
            element: meta.element,
            source: o.source || null
        };
        if (norm.schedule && Array.isArray(norm.schedule)) {
            inst.schedule = norm.schedule.map((s) => Object.assign({}, s));
            inst.scheduleIndex = 0;
            inst.scheduleTurnsRemaining = inst.schedule[0] ? Number(inst.schedule[0].turns || 0) : 0;
            if (inst.schedule[0] && inst.schedule[0].intervalSec != null) {
                inst.tickIntervalSec = Number(inst.schedule[0].intervalSec);
            }
        }
        // Replace weaker/same kind DoT (or if forced by field override rules)
        const idx = list.findIndex((c) => c && c.kind === inst.kind);
        if (idx >= 0) {
            const old = list[idx];
            const force = o.forceOverride || norm.forceOverride;
            if (
                !force &&
                (old.remainingDamage || 0) > (inst.remainingDamage || 0)
            ) {
                return old;
            }
            list[idx] = inst;
        } else {
            list.push(inst);
        }
    } else if (norm.type === 'regen') {
        // Always replace — weaker or stronger, duration fully reset (legacy recast).
        inst = {
            id: 'regen',
            kind: 'regen',
            healthGain: Math.max(0, Number(norm.healthGain) || 0),
            tickIntervalSec: norm.intervalSec > 0 ? Number(norm.intervalSec) : 3,
            tickTimer: 0, // first heal after one full interval
            durationSec: norm.durationSec > 0 ? Number(norm.durationSec) : 60,
            source: o.source || null
        };
        if (!(inst.healthGain > 0) || !(inst.durationSec > 0)) return null;
        const idx = list.findIndex((c) => c && c.kind === 'regen');
        if (idx >= 0) list[idx] = inst;
        else list.push(inst);
        recomputeDerived(entity);
        return inst;
    } else if (norm.type === 'slow' || norm.type === 'haste') {
        inst = {
            id: norm.type,
            kind: norm.type,
            durationSec: norm.durationSec || 5,
            speedChange: norm.speedChange,
            source: o.source || null
        };
        const idx = list.findIndex((c) => c && c.kind === inst.kind);
        if (idx >= 0) list[idx] = inst;
        else list.push(inst);
        recomputeDerived(entity);
        return inst;
    } else if (norm.type === 'invisible') {
        inst = {
            id: 'invisible',
            kind: 'invisible',
            durationSec: norm.durationSec || 2,
            source: o.source || null
        };
        const idx = list.findIndex((c) => c && c.kind === 'invisible');
        if (idx >= 0) list[idx] = inst;
        else list.push(inst);
        recomputeDerived(entity);
        return inst;
    } else if (norm.type === 'attributes') {
        // Exclusive subId: remove any attributes sharing the same group first
        // (blood_rage ↔ protector; refresh same stance also replaces).
        const subId = norm.subId || null;
        if (subId) {
            for (let i = list.length - 1; i >= 0; i--) {
                const c = list[i];
                if (c && c.kind === 'attributes' && c.subId === subId) {
                    list.splice(i, 1);
                }
            }
        }
        inst = {
            id: o.source || 'attributes',
            kind: 'attributes',
            durationSec: norm.durationSec > 0 ? norm.durationSec : 10,
            source: o.source || null
        };
        if (subId) inst.subId = subId;
        if (norm.skillPercent) {
            inst.skillPercent = Object.assign({}, norm.skillPercent);
        }
        if (norm.damageDealtPercent != null) {
            inst.damageDealtPercent = Number(norm.damageDealtPercent);
        }
        if (norm.damageReceivedPercent != null) {
            inst.damageReceivedPercent = Number(norm.damageReceivedPercent);
        }
        if (norm.disableDefense) inst.disableDefense = true;
        if (norm.cannotAttack) inst.cannotAttack = true;
        if (norm.speedChange != null && Number.isFinite(Number(norm.speedChange))) {
            inst.speedChange = Number(norm.speedChange);
        }
        // No same-kind singleton — subId exclusivity handles pairs; different
        // subIds (or no subId) may coexist (rare). Replace by source id if present.
        const src = o.source || null;
        if (src) {
            const idx = list.findIndex(
                (c) => c && c.kind === 'attributes' && c.source === src
            );
            if (idx >= 0) list[idx] = inst;
            else list.push(inst);
        } else {
            list.push(inst);
        }
        recomputeDerived(entity);
        return inst;
    } else if (norm.type === 'mana_shield') {
        // Always replace — weaker or stronger, duration + pool fully reset.
        const poolRemaining = Math.max(
            0,
            Math.floor(Number(norm.poolRemaining) || 0)
        );
        let poolMax = Math.max(0, Math.floor(Number(norm.poolMax) || 0));
        if (poolMax < poolRemaining) poolMax = poolRemaining;
        inst = {
            id: 'mana_shield',
            kind: 'mana_shield',
            durationSec: norm.durationSec > 0 ? Number(norm.durationSec) : 180,
            poolRemaining,
            poolMax,
            source: o.source || null
        };
        const idx = list.findIndex((c) => c && c.kind === 'mana_shield');
        if (idx >= 0) list[idx] = inst;
        else list.push(inst);
        recomputeDerived(entity);
        return inst;
    } else {
        return null;
    }

    recomputeDerived(entity);
    return inst;
}

/**
 * Tick all conditions: DoT damage + expire duration buffs.
 * @param {object} entity
 * @param {number} dtSec
 * @param {{ applyHpDelta?: Function, skipResistance?: boolean }} [hooks] optional; default mutates hp directly
 * @returns {{ ticks: object[], expired: string[] }}
 */
function tickConditions(entity, dtSec, hooks) {
    const result = { ticks: [], expired: [] };
    if (!entity || !entity.alive) return result;
    const dt = Number(dtSec) || 0;
    if (!(dt > 0)) return result;
    const list = ensureConditionList(entity);
    if (!list.length) return result;

    const applyHp =
        hooks && typeof hooks.applyHpDelta === 'function'
            ? hooks.applyHpDelta
            : null;

    for (let i = list.length - 1; i >= 0; i--) {
        const c = list[i];
        if (!c) {
            list.splice(i, 1);
            continue;
        }

        // HoT / regeneration (legacy ConditionRegeneration — heal then expire by duration)
        if (c.kind === 'regen') {
            const interval = c.tickIntervalSec > 0 ? c.tickIntervalSec : 3;
            const gain = Math.max(0, Math.floor(Number(c.healthGain) || 0));
            c.tickTimer = (c.tickTimer || 0) + dt;
            while (c.tickTimer >= interval && gain > 0 && entity.alive) {
                c.tickTimer -= interval;
                let healed = gain;
                if (applyHp) {
                    // hooks may be damage-oriented; prefer healing element path via applyHpDelta
                    if (entity.applyHpDelta) {
                        healed = Math.abs(
                            Number(entity.applyHpDelta(gain, 'healing')) || 0
                        );
                    } else if (entity.hp) {
                        const before = entity.hp.current || 0;
                        const max =
                            entity.hp.max != null ? entity.hp.max : before + gain;
                        entity.hp.current = Math.min(max, before + gain);
                        healed = entity.hp.current - before;
                    }
                } else if (entity.applyHpDelta) {
                    healed = Math.abs(
                        Number(entity.applyHpDelta(gain, 'healing')) || 0
                    );
                } else if (entity.hp) {
                    const before = entity.hp.current || 0;
                    const max =
                        entity.hp.max != null ? entity.hp.max : before + gain;
                    entity.hp.current = Math.min(max, before + gain);
                    healed = entity.hp.current - before;
                }
                result.ticks.push({
                    kind: 'regen',
                    heal: healed,
                    healthGain: gain,
                    remainingDuration: c.durationSec
                });
            }
            if (c.durationSec != null) {
                c.durationSec -= dt;
                if (c.durationSec <= 0) {
                    result.expired.push('regen');
                    list.splice(i, 1);
                }
            }
            continue;
        }

        // Duration buffs (haste / slow / invisible / mana_shield / attributes)
        if (c.durationSec != null) {
            c.durationSec -= dt;
            if (c.durationSec <= 0) {
                result.expired.push(c.kind);
                list.splice(i, 1);
            }
            continue;
        }

        // DoT
        if (c.remainingDamage != null && c.remainingDamage > 0) {
            c.tickTimer = (c.tickTimer || 0) + dt;
            let interval = c.tickIntervalSec > 0 ? c.tickIntervalSec : 4;
            while (c.tickTimer >= interval && c.remainingDamage > 0) {
                c.tickTimer -= interval;
                let chunk = 1;
                if (c.schedule && Array.isArray(c.schedule) && c.scheduleIndex < c.schedule.length) {
                    const stage = c.schedule[c.scheduleIndex];
                    chunk = Math.max(0, Number(stage.damage || 0));
                    c.scheduleTurnsRemaining = (c.scheduleTurnsRemaining || 0) - 1;
                    if (c.scheduleTurnsRemaining <= 0) {
                        c.scheduleIndex++;
                        if (c.scheduleIndex < c.schedule.length) {
                            const nextStage = c.schedule[c.scheduleIndex];
                            c.scheduleTurnsRemaining = Number(nextStage.turns || 0);
                            c.tickIntervalSec = nextStage.intervalSec > 0 ? Number(nextStage.intervalSec) : interval;
                        }
                    }
                    if (c.scheduleIndex >= c.schedule.length && c.scheduleTurnsRemaining <= 0) {
                        c.remainingDamage = Math.min(c.remainingDamage, chunk);
                    }
                } else {
                    // Decaying chunk (~10% of remaining, min 1) — simple classic poison
                    chunk = Math.max(
                        1,
                        Math.ceil(c.remainingDamage / 10)
                    );
                }
                const rawDmg = Math.min(c.remainingDamage, chunk);
                c.remainingDamage -= rawDmg;
                const element = c.element || 'earth';
                // Same pipeline as any elemental hit: mitigation % + resists + floor.
                // Physical DoTs would also roll armor/block; field DoTs are elemental.
                let dmg = rawDmg;
                if (!hooks || !hooks.skipResistance) {
                    const mit = applyMitigation(rawDmg, element, entity);
                    dmg = mit.final;
                } else {
                    dmg = Math.max(0, Math.floor(rawDmg));
                }
                if (dmg > 0) {
                    if (applyHp) {
                        applyHp(entity, dmg, element);
                    } else if (entity.applyHpDelta) {
                        entity.applyHpDelta(dmg, element);
                    } else if (entity.hp) {
                        entity.hp.current = Math.max(
                            0,
                            (entity.hp.current || 0) - dmg
                        );
                        if (entity.hp.current <= 0) entity.alive = false;
                    }
                }
                result.ticks.push({
                    kind: c.kind,
                    damage: dmg,
                    rawDamage: rawDmg,
                    element,
                    remaining: c.remainingDamage
                });
                if (!entity.alive) break;
                interval = c.tickIntervalSec > 0 ? c.tickIntervalSec : 4;
            }
            if (c.remainingDamage <= 0) {
                result.expired.push(c.kind);
                list.splice(i, 1);
            }
        } else {
            list.splice(i, 1);
        }
    }

    recomputeDerived(entity);
    return result;
}

/**
 * @param {object|null|undefined} entity
 * @returns {boolean}
 */
function isInvisible(entity) {
    if (!entity) return false;
    if (entity.invisible) return true;
    const gearFlags = entity.combatStats && entity.combatStats.flags;
    if (gearFlags && gearFlags.invisible) return true;
    const list = entity.conditions;
    if (!Array.isArray(list)) return false;
    for (let i = 0; i < list.length; i++) {
        if (list[i] && list[i].kind === 'invisible') return true;
    }
    return false;
}

/**
 * Effective movement speed (conditions applied).
 * @param {object|null|undefined} entity
 * @returns {number}
 */
function getEffectiveSpeed(entity) {
    if (!entity) return 0;
    if (Array.isArray(entity.conditions) && entity.conditions.length) {
        recomputeDerived(entity);
    }
    return entity.speed != null ? Number(entity.speed) : 0;
}

/**
 * Whether entity currently has a haste buff.
 * @param {object|null|undefined} entity
 */
function hasHaste(entity) {
    const list = entity && entity.conditions;
    if (!Array.isArray(list)) return false;
    return list.some((c) => c && c.kind === 'haste');
}

/**
 * Legacy ConditionSpeed formula → additive speedChange (delta on baseSpeed).
 *
 * Server (`ConditionSpeed::startCondition`):
 *   target = mina * (baseSpeed - 40) + minb   // (maxa/maxb same band when equal)
 *   speedDelta = target - baseSpeed
 * so effective speed becomes `target`, not `base + target`.
 *
 * When min≠max (rare for player haste — formulas are symmetric), mid-point is used
 * for determinism (legacy rolls uniform_random(min,max)).
 *
 * @param {number} baseSpeed
 * @param {{ mina?: number, minb?: number, maxa?: number, maxb?: number }|null|undefined} formula
 * @returns {number} delta to add to baseSpeed (may be negative for paralyze-like formulas)
 */
function hasteSpeedChangeFromFormula(baseSpeed, formula) {
    if (!formula || typeof formula !== 'object') return 0;
    const mina = Number(formula.mina);
    const minb = Number(formula.minb);
    if (!Number.isFinite(mina) || !Number.isFinite(minb)) return 0;
    const maxa =
        formula.maxa != null && Number.isFinite(Number(formula.maxa))
            ? Number(formula.maxa)
            : mina;
    const maxb =
        formula.maxb != null && Number.isFinite(Number(formula.maxb))
            ? Number(formula.maxb)
            : minb;
    const base = Number(baseSpeed);
    const b = Number.isFinite(base) ? base : 100;
    const difference = b - 40;
    const targetMin = mina * difference + minb;
    const targetMax = maxa * difference + maxb;
    // Integer target speed (legacy int32 from float mul); mid when band exists
    const target = Math.floor((targetMin + targetMax) / 2);
    return target - b;
}

/**
 * Whether a raw type / kind is the pooled mana-shield condition.
 * Accepts engine `mana_shield` plus legacy aliases (CONDITION_MANASHIELD).
 * @param {string|null|undefined} type
 * @returns {boolean}
 */
function isManaShieldType(type) {
    const t = String(type || '')
        .toLowerCase()
        .replace(/^condition_/, '');
    return t === 'mana_shield' || t === 'manashield' || t === 'mana-shield';
}

/**
 * Read explicit pool numbers from a condition bag (no formula eval).
 * @param {object} raw
 * @returns {{ poolRemaining: number, poolMax: number }}
 */
function readManaShieldPool(raw) {
    const explicit =
        raw.poolRemaining != null
            ? Number(raw.poolRemaining)
            : raw.pool != null
              ? Number(raw.pool)
              : raw.poolMax != null
                ? Number(raw.poolMax)
                : 0;
    const remaining = Math.max(0, Math.floor(Number.isFinite(explicit) ? explicit : 0));
    const maxRaw =
        raw.poolMax != null ? Number(raw.poolMax) : remaining;
    let poolMax = Math.max(0, Math.floor(Number.isFinite(maxRaw) ? maxRaw : 0));
    if (poolMax < remaining) poolMax = remaining;
    return { poolRemaining: remaining, poolMax };
}

/**
 * Stage-1 pool (no Wheel 1.25×). floor(min(maxMana, 300 + 7.6*level + 7*magicLevel)).
 * @param {number} level
 * @param {number} magicLevel
 * @param {number} maxMana
 * @returns {number}
 */
function computeManaShieldPool(level, magicLevel, maxMana) {
    const lvl = Math.max(0, Number(level));
    const ml = Math.max(0, Number(magicLevel));
    const cap = Math.max(0, Number(maxMana));
    const L = Number.isFinite(lvl) ? lvl : 0;
    const M = Number.isFinite(ml) ? ml : 0;
    const C = Number.isFinite(cap) ? cap : 0;
    const raw = 300 + 7.6 * L + 7 * M;
    return Math.max(0, Math.floor(Math.min(C, raw)));
}

/**
 * Level / magic / maxMana snapshot for poolFormula evaluation.
 * @param {object|null|undefined} entity
 * @returns {{ level: number, magic: number, maxMana: number }}
 */
function manaShieldStatsFromEntity(entity) {
    if (!entity) return { level: 0, magic: 0, maxMana: 0 };
    const stats = entity.combatStats || null;
    const skills = entity.skills || (stats && stats.skills) || null;
    let level = 0;
    if (entity.level != null && Number.isFinite(Number(entity.level))) {
        level = Number(entity.level);
    } else if (stats && stats.level != null && Number.isFinite(Number(stats.level))) {
        level = Number(stats.level);
    }
    let magic = 0;
    if (entity.magic != null && Number.isFinite(Number(entity.magic))) {
        magic = Number(entity.magic);
    } else if (stats && stats.magic != null && Number.isFinite(Number(stats.magic))) {
        magic = Number(stats.magic);
    } else if (skills && skills.magic != null && Number.isFinite(Number(skills.magic))) {
        magic = Number(skills.magic);
    }
    let maxMana = 0;
    if (entity.mp && entity.mp.max != null && Number.isFinite(Number(entity.mp.max))) {
        maxMana = Number(entity.mp.max);
    } else if (stats && stats.mpMax != null && Number.isFinite(Number(stats.mpMax))) {
        maxMana = Number(stats.mpMax);
    } else if (entity.manaMax != null && Number.isFinite(Number(entity.manaMax))) {
        maxMana = Number(entity.manaMax);
    }
    return { level, magic, maxMana };
}

/**
 * Fill poolRemaining / poolMax from poolFormula when the bag has no explicit pool.
 * @param {object} raw
 * @param {object|null|undefined} entity
 * @returns {object}
 */
function resolveManaShieldDef(raw, entity) {
    const bag = Object.assign({}, raw);
    const hasExplicit =
        bag.poolRemaining != null || bag.poolMax != null || bag.pool != null;
    if (!hasExplicit && bag.poolFormula === 'legacy_mana_shield') {
        const snap = manaShieldStatsFromEntity(entity);
        const pool = computeManaShieldPool(snap.level, snap.magic, snap.maxMana);
        bag.poolRemaining = pool;
        bag.poolMax = pool;
    } else if (bag.pool != null && bag.poolRemaining == null) {
        bag.poolRemaining = bag.pool;
        if (bag.poolMax == null) bag.poolMax = bag.pool;
    }
    return bag;
}

/**
 * Current mana, or null when the entity has no MP bag.
 * @param {object|null|undefined} entity
 * @returns {number|null}
 */
function readCurrentMana(entity) {
    if (!entity) return null;
    if (entity.mp && entity.mp.current != null) {
        return Math.max(0, Math.floor(Number(entity.mp.current) || 0));
    }
    if (entity.mana != null) {
        return Math.max(0, Math.floor(Number(entity.mana) || 0));
    }
    return null;
}

/**
 * Drain mana (same mutation as resolve.spendMana; kept here to avoid a cycle).
 * @param {object} entity
 * @param {number} amount
 * @returns {number} actually drained
 */
function drainEntityMana(entity, amount) {
    const cost = Math.max(0, Math.floor(Number(amount) || 0));
    if (cost <= 0 || !entity) return 0;
    if (entity.mp && entity.mp.current != null) {
        const before = entity.mp.current;
        entity.mp.current = Math.max(0, before - cost);
        return before - entity.mp.current;
    }
    if (entity.mana != null) {
        const before = entity.mana;
        entity.mana = Math.max(0, before - cost);
        return before - entity.mana;
    }
    return 0;
}

/**
 * Active pooled mana_shield instance, or null.
 * @param {object|null|undefined} entity
 * @returns {object|null}
 */
function getPooledManaShield(entity) {
    const list = entity && Array.isArray(entity.conditions) ? entity.conditions : [];
    for (let i = 0; i < list.length; i++) {
        const c = list[i];
        if (!c) continue;
        if (normalizeKindKey(c.kind || c.type || c.id || '') === 'mana_shield') {
            return c;
        }
    }
    return null;
}

/**
 * Equipped gear unpooled absorb (combatStats.flags.manaShield).
 * @param {object|null|undefined} entity
 * @returns {boolean}
 */
function hasGearManaShield(entity) {
    const flags = entity && entity.combatStats && entity.combatStats.flags;
    return !!(flags && flags.manaShield);
}

/**
 * Combined shield snapshot (pooled condition + optional gear flag).
 * Pooled remaining > 0 wins over gear; gear stays after the pool is gone.
 *
 * @param {object|null|undefined} entity
 * @returns {{
 *   condition: object|null,
 *   pooled: boolean,
 *   poolRemaining: number,
 *   poolMax: number,
 *   gear: boolean,
 *   active: boolean
 * }}
 */
function getManaShieldState(entity) {
    const cond = getPooledManaShield(entity);
    const poolRemaining = cond
        ? Math.max(0, Math.floor(Number(cond.poolRemaining) || 0))
        : 0;
    const poolMax = cond
        ? Math.max(
              0,
              Math.floor(
                  Number(cond.poolMax != null ? cond.poolMax : cond.poolRemaining) || 0
              )
          )
        : 0;
    const gear = hasGearManaShield(entity);
    const pooled = !!(cond && poolRemaining > 0);
    return {
        condition: cond,
        pooled,
        poolRemaining,
        poolMax,
        gear,
        active: pooled || gear
    };
}

/**
 * Watch-UI bar for an active mana shield (nameplate / party / combat list).
 * Pooled: remaining / snapshot max. Gear-only: current mana / max mana.
 *
 * @param {object|null|undefined} entity
 * @returns {{ mode: 'pooled'|'gear', remaining: number, max: number, frac: number }|null}
 */
function resolveManaShieldBar(entity) {
    const state = getManaShieldState(entity);
    if (!state || !state.active) return null;
    if (state.pooled) {
        const max = state.poolMax > 0 ? state.poolMax : state.poolRemaining;
        const remaining = state.poolRemaining;
        return {
            mode: 'pooled',
            remaining,
            max,
            frac: max > 0 ? Math.max(0, Math.min(1, remaining / max)) : 0
        };
    }
    const mana = readCurrentMana(entity);
    let maxMana = 0;
    if (entity && entity.mp && Number.isFinite(Number(entity.mp.max))) {
        maxMana = Math.max(0, Number(entity.mp.max));
    }
    const remaining = mana != null ? mana : 0;
    const max = maxMana > 0 ? maxMana : remaining;
    return {
        mode: 'gear',
        remaining,
        max,
        frac: max > 0 ? Math.max(0, Math.min(1, remaining / max)) : 0
    };
}

/**
 * Convert incoming post-mitigation HP into mana drain.
 * Pooled (spell/potion) caps at remaining; unpooled (gear) uses current mana only.
 * Clearing the pool / mana-dry never strips the gear flag.
 *
 * @param {object} entity
 * @param {number} incomingHp
 * @returns {{ absorbed: number, leftoverHp: number, cleared: boolean }}
 */
function absorbWithManaShield(entity, incomingHp) {
    const raw = Number(incomingHp);
    const original = Number.isFinite(raw) ? raw : 0;
    const incoming = Math.max(0, Math.floor(original));
    // Preserve the caller's amount when we skip (no floor change on unshielded hits).
    const none = { absorbed: 0, leftoverHp: original, cleared: false };
    if (!(incoming > 0) || !entity) return none;
    const mana = readCurrentMana(entity);
    if (mana == null) return none;
    const state = getManaShieldState(entity);
    if (!state.active) return none;

    let manaDamage = Math.min(mana, incoming);
    let remaining = state.poolRemaining;
    let cleared = false;
    const cond = state.condition;

    if (remaining > 0) {
        if (remaining > manaDamage) {
            remaining -= manaDamage;
            if (cond) cond.poolRemaining = remaining;
        } else {
            manaDamage = remaining;
            remaining = 0;
            if (cond) cond.poolRemaining = 0;
            removeCondition(entity, 'mana_shield');
            cleared = true;
        }
    }

    if (manaDamage > 0) {
        drainEntityMana(entity, manaDamage);
        const after = readCurrentMana(entity);
        if (after === 0 && remaining > 0) {
            removeCondition(entity, 'mana_shield');
            cleared = true;
            remaining = 0;
        }
    }

    return {
        absorbed: manaDamage,
        leftoverHp: incoming - manaDamage,
        cleared
    };
}

/**
 * Build a ConditionDef from a spell.condition payload (may include speedFormula).
 * Mutates nothing on the entity; returns a normalized def ready for applyCondition.
 *
 * @param {object|null|undefined} raw spell.condition bag
 * @param {object|null|undefined} entity target (for baseSpeed / formula)
 * @returns {ConditionDef|null}
 */
function conditionDefFromSpell(raw, entity) {
    if (!raw || typeof raw !== 'object') return null;
    /** @type {object} */
    const bag = Object.assign({}, raw);
    // Paralyze → slow before formula / normalize.
    const rawType = String(bag.type || bag.kind || '')
        .toLowerCase()
        .replace(/^condition_/, '');
    if (
        rawType === 'paralyze' ||
        rawType === 'paralysis' ||
        rawType === 'paralysed'
    ) {
        bag.type = 'slow';
    }
    if (isManaShieldType(rawType)) {
        Object.assign(bag, resolveManaShieldDef(bag, entity));
    }
    const needsSpeedFormula =
        (bag.type === 'haste' ||
            bag.type === 'slow' ||
            bag.kind === 'haste' ||
            bag.kind === 'slow' ||
            bag.type === 'attributes' ||
            bag.kind === 'attributes' ||
            bag.type === 'stance' ||
            bag.kind === 'stance') &&
        (bag.speedChange == null || !Number.isFinite(Number(bag.speedChange))) &&
        bag.speedFormula;
    if (needsSpeedFormula) {
        ensureBaseSpeed(entity);
        const base =
            entity && entity.baseSpeed != null
                ? Number(entity.baseSpeed)
                : entity && entity.speed != null
                  ? Number(entity.speed)
                  : 100;
        bag.speedChange = hasteSpeedChangeFromFormula(base, bag.speedFormula);
    }
    return normalizeConditionDef(bag);
}

/**
 * Aggregate active attribute-stance mods on an entity.
 * Skill percents multiply (135 → ×1.35). Damage percents multiply.
 * disableDefense / cannotAttack are OR across instances.
 *
 * @param {object|null|undefined} entity
 * @returns {{
 *   skillMult: Record<string, number>,
 *   damageDealtMult: number,
 *   damageReceivedMult: number,
 *   disableDefense: boolean,
 *   cannotAttack: boolean
 * }}
 */
function getAttributeMods(entity) {
    /** @type {Record<string, number>} */
    const skillMult = Object.create(null);
    let damageDealtMult = 1;
    let damageReceivedMult = 1;
    let disableDefense = false;
    let cannotAttack = false;
    const list = entity && Array.isArray(entity.conditions) ? entity.conditions : [];
    for (let i = 0; i < list.length; i++) {
        const c = list[i];
        if (!c || c.kind !== 'attributes') continue;
        if (c.skillPercent && typeof c.skillPercent === 'object') {
            const keys = Object.keys(c.skillPercent);
            for (let k = 0; k < keys.length; k++) {
                const key = keys[k];
                const pct = Number(c.skillPercent[key]);
                if (!Number.isFinite(pct) || pct <= 0) continue;
                const m = pct / 100;
                skillMult[key] = (skillMult[key] != null ? skillMult[key] : 1) * m;
            }
        }
        if (c.damageDealtPercent != null && Number.isFinite(Number(c.damageDealtPercent))) {
            damageDealtMult *= Number(c.damageDealtPercent) / 100;
        }
        if (
            c.damageReceivedPercent != null &&
            Number.isFinite(Number(c.damageReceivedPercent))
        ) {
            damageReceivedMult *= Number(c.damageReceivedPercent) / 100;
        }
        if (c.disableDefense) disableDefense = true;
        if (c.cannotAttack) cannotAttack = true;
    }
    return {
        skillMult,
        damageDealtMult,
        damageReceivedMult,
        disableDefense,
        cannotAttack
    };
}

/**
 * Whether entity is pacified / Stage-1 swift-foot (cannot cast attack autos).
 * @param {object|null|undefined} entity
 * @returns {boolean}
 */
function isCannotAttack(entity) {
    if (!entity) return false;
    if (entity.cannotAttack === true) return true;
    return getAttributeMods(entity).cannotAttack;
}

/**
 * Whether observer can see invisible creatures (legacy: monster immunity to CONDITION_INVISIBLE).
 * Players default false (no sense-invis gear model yet).
 *
 * @param {object|null|undefined} observer
 * @returns {boolean}
 */
function canSeeInvisibility(observer) {
    if (!observer) return false;
    if (observer.canSeeInvisibility === true) return true;
    const imm = observer.immunities;
    if (imm && (imm.invisible === true || imm.CONDITION_INVISIBLE === true)) {
        return true;
    }
    // Some ports stash immunities under flags
    const flags = observer.flags;
    if (flags && flags.seeInvisible === true) return true;
    return false;
}

/**
 * Whether entity is immune to a condition kind (template immunities bag).
 * Supports engine keys (`paralyze`, `slow`, `invisible`) and legacy
 * `CONDITION_*` aliases.
 *
 * @param {object|null|undefined} entity
 * @param {string} kind e.g. 'paralyze' | 'slow' | 'poison'
 * @returns {boolean}
 */
function isImmuneToCondition(entity, kind) {
    if (!entity || !kind) return false;
    const k = String(kind)
        .toLowerCase()
        .replace(/^condition_/, '');
    const bags = [];
    if (entity.immunities && typeof entity.immunities === 'object') {
        bags.push(entity.immunities);
    }
    if (
        entity.template &&
        entity.template.immunities &&
        typeof entity.template.immunities === 'object'
    ) {
        bags.push(entity.template.immunities);
    }
    if (entity.flags && typeof entity.flags === 'object') {
        bags.push(entity.flags);
    }
    for (let i = 0; i < bags.length; i++) {
        const imm = bags[i];
        if (imm[k] === true) return true;
        if (imm['CONDITION_' + k.toUpperCase()] === true) return true;
        // Paralyze is a heavy slow; immunities.paralyze covers both.
        if (
            (k === 'slow' || k === 'paralyze') &&
            (imm.paralyze === true || imm.CONDITION_PARALYZE === true)
        ) {
            return true;
        }
    }
    return false;
}

/**
 * Whether observer can currently perceive target (invis check only — not range/floor).
 * @param {object|null|undefined} observer
 * @param {object|null|undefined} target
 * @returns {boolean}
 */
function canSeeCreature(observer, target) {
    if (!target) return false;
    if (observer && observer === target) return true;
    if (!isInvisible(target)) return true;
    return canSeeInvisibility(observer);
}

/**
 * Normalize a kind key for lookup (aliases → engine kind).
 * @param {string} kind
 * @returns {string}
 */
function normalizeKindKey(kind) {
    let k = String(kind || '')
        .toLowerCase()
        .replace(/^condition_/, '');
    if (k === 'freezing') k = 'ice';
    if (k === 'bleeding') k = 'bleed';
    if (k === 'cursed') k = 'curse';
    if (k === 'electrification' || k === 'electrify') k = 'energy';
    if (k === 'dazzled' || k === 'dazzle') k = 'holy';
    if (k === 'invisibility') k = 'invisible';
    if (k === 'regeneration' || k === 'hot' || k === 'recovery') k = 'regen';
    if (k === 'manashield' || k === 'mana-shield') k = 'mana_shield';
    const meta = DOT_KINDS[k];
    if (meta) return meta.kind;
    return k;
}

/**
 * Whether entity currently has a condition of the given kind.
 * @param {object|null|undefined} entity
 * @param {string} kind
 * @returns {boolean}
 */
function hasCondition(entity, kind) {
    if (!entity || kind == null || kind === '') return false;
    const want = normalizeKindKey(kind);
    if (!want) return false;
    const list = entity.conditions;
    if (!Array.isArray(list) || !list.length) return false;
    for (let i = 0; i < list.length; i++) {
        const c = list[i];
        if (!c) continue;
        const ck = normalizeKindKey(c.kind || c.type || c.id || '');
        if (ck === want) return true;
    }
    return false;
}

/**
 * Remove one condition kind from the entity (all instances of that kind).
 * @param {object|null|undefined} entity
 * @param {string} kind  engine kind or alias (poison, fire, energy, bleed, curse, …)
 * @returns {number} number of instances removed
 */
function removeCondition(entity, kind) {
    if (!entity || kind == null || kind === '') return 0;
    const list = ensureConditionList(entity);
    if (!list.length) return 0;
    const want = normalizeKindKey(kind);
    if (!want) return 0;
    let removed = 0;
    for (let i = list.length - 1; i >= 0; i--) {
        const c = list[i];
        if (!c) {
            list.splice(i, 1);
            continue;
        }
        const ck = normalizeKindKey(c.kind || c.type || c.id || '');
        if (ck === want) {
            list.splice(i, 1);
            removed += 1;
        }
    }
    if (removed) recomputeDerived(entity);
    return removed;
}

/**
 * Remove any of the listed kinds. Returns total instances removed.
 * @param {object|null|undefined} entity
 * @param {string|string[]} kinds
 * @returns {number}
 */
function removeConditions(entity, kinds) {
    if (!entity) return 0;
    const arr = Array.isArray(kinds) ? kinds : kinds != null ? [kinds] : [];
    let total = 0;
    for (let i = 0; i < arr.length; i++) {
        total += removeCondition(entity, arr[i]);
    }
    return total;
}

module.exports = {
    normalizeConditionDef,
    applyCondition,
    tickConditions,
    removeCondition,
    removeConditions,
    hasCondition,
    isInvisible,
    getEffectiveSpeed,
    hasHaste,
    hasteSpeedChangeFromFormula,
    conditionDefFromSpell,
    canSeeInvisibility,
    canSeeCreature,
    isImmuneToCondition,
    recomputeDerived,
    ensureBaseSpeed,
    normalizeKindKey,
    getAttributeMods,
    isCannotAttack,
    computeManaShieldPool,
    getManaShieldState,
    resolveManaShieldBar,
    absorbWithManaShield,
    DOT_KINDS,
    DOT_KIND_SET
};
