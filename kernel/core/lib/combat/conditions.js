/**
 * Lightweight combat conditions / buffs (poison DoT, fire DoT, slow, haste, invisible).
 *
 * Ported from legacy OTBM condition + defense_spell fields. Intentionally small:
 * no full condition stack parity — just the 2–3 kinds that move combat feel.
 *
 * Entity shape:
 *   entity.conditions: ConditionInstance[]
 *   entity.baseSpeed: number (snapshot of unbuffed speed)
 *   entity.invisible: boolean (derived each tick / apply)
 *   entity.speed: effective move speed (recomputed from base + mods)
 */

'use strict';

const { applyMitigation } = require('./damage.js');

/**
 * @typedef {object} ConditionDef
 * @property {string} type  poison | fire | freezing | ice | slow | haste | invisible
 * @property {number} [totalDamage]
 * @property {number} [intervalMs]
 * @property {number} [intervalSec]
 * @property {number} [durationSec]
 * @property {number} [durationMs]
 * @property {number} [speedChange]
 * @property {object[]} [schedule]
 * @property {boolean} [forceOverride]
 */

/**
 * @typedef {object} ConditionInstance
 * @property {string} id
 * @property {string} kind  poison | fire | ice | slow | haste | invisible
 * @property {number} [remainingDamage]
 * @property {number} [tickIntervalSec]
 * @property {number} [tickTimer]
 * @property {number} [durationSec]
 * @property {number} [speedChange]
 * @property {string} [element] damage element for DoT ticks
 * @property {string} [source] optional source label
 */

const DOT_KINDS = {
    poison: { kind: 'poison', element: 'earth' },
    condition_poison: { kind: 'poison', element: 'earth' },
    fire: { kind: 'fire', element: 'fire' },
    condition_fire: { kind: 'fire', element: 'fire' },
    freezing: { kind: 'ice', element: 'ice' },
    condition_freezing: { kind: 'ice', element: 'ice' },
    ice: { kind: 'ice', element: 'ice' },
    condition_ice: { kind: 'ice', element: 'ice' }
};

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

    if (DOT_KINDS[type] || type === 'poison' || type === 'fire' || type === 'ice') {
        const meta = DOT_KINDS[type] || DOT_KINDS[type.replace(/^condition_/, '')];
        const kind = meta ? meta.kind : type;
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
        if (!Number.isFinite(speedChange) || speedChange === 0) return null;
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
 * Recompute entity.speed and entity.invisible from active conditions.
 * @param {object} entity
 */
function recomputeDerived(entity) {
    if (!entity) return;
    ensureBaseSpeed(entity);
    const list = ensureConditionList(entity);
    let speedMod = 0;
    let invisible = false;
    for (let i = 0; i < list.length; i++) {
        const c = list[i];
        if (!c) continue;
        if (c.kind === 'slow' || c.kind === 'haste') {
            speedMod += Number(c.speedChange) || 0;
        }
        if (c.kind === 'invisible') invisible = true;
    }
    entity.speed = Math.max(0, Number(entity.baseSpeed) + speedMod);
    entity.invisible = invisible;
}

/**
 * Apply (or refresh) a condition on an entity.
 * DoTs stack by replacing same kind if new remaining ≥ old (keep stronger).
 * Buffs (haste/slow/invis) refresh duration / overwrite same kind.
 *
 * @param {object} entity
 * @param {ConditionDef|object} def
 * @param {{ source?: string }} [opts]
 * @returns {ConditionInstance|null}
 */
function applyCondition(entity, def, opts) {
    if (!entity || !entity.alive) return null;
    const norm = normalizeConditionDef(def);
    if (!norm) return null;
    const list = ensureConditionList(entity);
    const o = opts || {};

    /** @type {ConditionInstance} */
    let inst;
    if (norm.type === 'poison' || norm.type === 'fire' || norm.type === 'ice') {
        const meta = resolveDotMeta(norm.type) || {
            kind: norm.type,
            element: norm.type === 'poison' ? 'earth' : norm.type
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

        // Duration buffs (haste / slow / invisible)
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

module.exports = {
    normalizeConditionDef,
    applyCondition,
    tickConditions,
    isInvisible,
    getEffectiveSpeed,
    hasHaste,
    recomputeDerived,
    ensureBaseSpeed,
    DOT_KINDS
};
