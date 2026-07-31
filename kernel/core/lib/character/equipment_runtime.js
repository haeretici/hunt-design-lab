/**
 * Equipment duration / charges runtime (durationSec + charges decay).
 * Pure helpers: init from itemDb, tick durations, consume charges on hit.
 * When remaining hits ≤ 0 the slot is reported expired for the owner to unequip.
 */

'use strict';

const { normalizeEquipmentMap, findItem, EQUIPMENT_SLOTS } = require('./stats.js');

/**
 * @typedef {object} EquipmentSlotRuntime
 * @property {string} itemId
 * @property {string} slot
 * @property {number|null} remainingDurationSec null = not timed
 * @property {number|null} remainingCharges null = uncharged
 * @property {number|null} initialDurationSec
 * @property {number|null} initialCharges
 * @property {number|null} [regenHp]
 * @property {number|null} [regenHpTicksMs]
 * @property {number|null} [regenHpTimerMs]
 * @property {number|null} [regenMp]
 * @property {number|null} [regenMpTicksMs]
 * @property {number|null} [regenMpTimerMs]
 */

/**
 * @typedef {object} TickResult
 * @property {string[]} expiredSlots slots whose duration hit 0 this tick
 * @property {boolean} changed
 */

/**
 * @typedef {object} ChargeResult
 * @property {string[]} depletedSlots slots whose charges hit 0
 * @property {string[]} consumedSlots slots that lost at least one charge
 * @property {boolean} changed
 */

/**
 * Whether a template item participates in duration/charge runtime.
 * @param {object|null} item
 * @returns {boolean}
 */
function itemHasRuntimeBudget(item) {
    if (!item) return false;
    const d = item.durationSec;
    const c = item.charges;
    const hasDuration = d != null && Number.isFinite(Number(d)) && Number(d) > 0;
    const hasCharges = c != null && Number.isFinite(Number(c)) && Number(c) > 0;
    const r = item.regen;
    const hasRegen = r && typeof r === 'object' && (
        (Number.isFinite(Number(r.hp)) && Number(r.hp) !== 0 && Number.isFinite(Number(r.hpTicksMs)) && Number(r.hpTicksMs) > 0) ||
        (Number.isFinite(Number(r.mp)) && Number(r.mp) !== 0 && Number.isFinite(Number(r.mpTicksMs)) && Number(r.mpTicksMs) > 0)
    );
    return hasDuration || hasCharges || !!hasRegen;
}

/**
 * Build per-slot runtime state for equipped items that have durationSec and/or charges.
 * Slots without budget are omitted (no tick cost).
 *
 * @param {Record<string, string|number|null|undefined>|null|undefined} equipment
 * @param {object[]|Record<string, object>|null} itemDb
 * @param {Record<string, EquipmentSlotRuntime>|null|undefined} [previous]
 *        When re-equipping the same itemId on a slot, preserve remaining counters.
 * @returns {Record<string, EquipmentSlotRuntime>}
 */
function initEquipmentRuntime(equipment, itemDb, previous) {
    /** @type {Record<string, EquipmentSlotRuntime>} */
    const runtime = Object.create(null);
    const eq = normalizeEquipmentMap(equipment);
    const prev = previous && typeof previous === 'object' ? previous : null;
    const slots = Object.keys(eq);

    for (let i = 0; i < slots.length; i++) {
        const slot = slots[i];
        if (slot === 'backpack') continue;
        // Prefer standard combat slots; still allow free-form keys with timed gear
        const itemId = eq[slot];
        if (itemId == null || itemId === '') continue;
        const item = findItem(itemDb, itemId);
        if (!itemHasRuntimeBudget(item)) continue;

        const durationSec =
            item.durationSec != null && Number.isFinite(Number(item.durationSec))
                ? Math.max(0, Number(item.durationSec))
                : null;
        const charges =
            item.charges != null && Number.isFinite(Number(item.charges))
                ? Math.max(0, Math.floor(Number(item.charges)))
                : null;
        const r = item.regen && typeof item.regen === 'object' ? item.regen : null;
        const regenHp = r && Number.isFinite(Number(r.hp)) && Number(r.hp) !== 0 ? Number(r.hp) : null;
        const regenHpTicksMs = r && Number.isFinite(Number(r.hpTicksMs)) && Number(r.hpTicksMs) > 0 ? Number(r.hpTicksMs) : null;
        const regenMp = r && Number.isFinite(Number(r.mp)) && Number(r.mp) !== 0 ? Number(r.mp) : null;
        const regenMpTicksMs = r && Number.isFinite(Number(r.mpTicksMs)) && Number(r.mpTicksMs) > 0 ? Number(r.mpTicksMs) : null;

        /** @type {EquipmentSlotRuntime} */
        const entry = {
            itemId: String(itemId),
            slot,
            remainingDurationSec: durationSec != null && durationSec > 0 ? durationSec : null,
            remainingCharges: charges != null && charges > 0 ? charges : null,
            initialDurationSec: durationSec != null && durationSec > 0 ? durationSec : null,
            initialCharges: charges != null && charges > 0 ? charges : null,
            regenHp: (regenHp != null && regenHpTicksMs != null) ? regenHp : null,
            regenHpTicksMs: (regenHp != null && regenHpTicksMs != null) ? regenHpTicksMs : null,
            regenHpTimerMs: (regenHp != null && regenHpTicksMs != null) ? 0 : null,
            regenMp: (regenMp != null && regenMpTicksMs != null) ? regenMp : null,
            regenMpTicksMs: (regenMp != null && regenMpTicksMs != null) ? regenMpTicksMs : null,
            regenMpTimerMs: (regenMp != null && regenMpTicksMs != null) ? 0 : null
        };

        // Preserve remaining when same item stays equipped across re-apply
        if (prev && prev[slot] && prev[slot].itemId === entry.itemId) {
            if (
                entry.remainingDurationSec != null &&
                prev[slot].remainingDurationSec != null
            ) {
                entry.remainingDurationSec = Math.max(
                    0,
                    Number(prev[slot].remainingDurationSec)
                );
            }
            if (
                entry.remainingCharges != null &&
                prev[slot].remainingCharges != null
            ) {
                entry.remainingCharges = Math.max(
                    0,
                    Math.floor(Number(prev[slot].remainingCharges))
                );
            }
            if (entry.regenHpTimerMs != null && prev[slot].regenHpTimerMs != null) {
                entry.regenHpTimerMs = Math.max(0, Number(prev[slot].regenHpTimerMs));
            }
            if (entry.regenMpTimerMs != null && prev[slot].regenMpTimerMs != null) {
                entry.regenMpTimerMs = Math.max(0, Number(prev[slot].regenMpTimerMs));
            }
        }

        runtime[slot] = entry;
    }
    return runtime;
}

/**
 * Tick remainingDurationSec by dt seconds. Slots that reach ≤ 0 are expired.
 * Does not mutate equipment map — caller clears slots and re-rolls stats.
 *
 * @param {Record<string, EquipmentSlotRuntime>|null|undefined} runtime
 * @param {number} dtSec
 * @returns {TickResult}
 */
function tickEquipmentDurations(runtime, dtSec) {
    /** @type {string[]} */
    const expiredSlots = [];
    if (!runtime || typeof runtime !== 'object') {
        return { expiredSlots, changed: false };
    }
    const dt = Number(dtSec);
    if (!Number.isFinite(dt) || dt <= 0) {
        return { expiredSlots, changed: false };
    }

    let changed = false;
    const keys = Object.keys(runtime);
    for (let i = 0; i < keys.length; i++) {
        const slot = keys[i];
        const entry = runtime[slot];
        if (!entry || entry.remainingDurationSec == null) continue;
        const before = entry.remainingDurationSec;
        entry.remainingDurationSec = Math.max(0, before - dt);
        if (entry.remainingDurationSec !== before) changed = true;
        if (entry.remainingDurationSec <= 0) {
            expiredSlots.push(slot);
        }
    }
    return { expiredSlots, changed: changed || expiredSlots.length > 0 };
}

/**
 * Tick independent equipment regeneration timers by dt seconds.
 * Returns accumulated HP and MP regenerated across all equipped slots this tick.
 *
 * @param {Record<string, EquipmentSlotRuntime>|null|undefined} runtime
 * @param {number} dtSec
 * @returns {{ hpDelta: number, mpDelta: number, changed: boolean }}
 */
function tickEquipmentRegen(runtime, dtSec) {
    let hpDelta = 0;
    let mpDelta = 0;
    if (!runtime || typeof runtime !== 'object') {
        return { hpDelta, mpDelta, changed: false };
    }
    const dt = Number(dtSec);
    if (!Number.isFinite(dt) || dt <= 0) {
        return { hpDelta, mpDelta, changed: false };
    }
    const dtMs = dt * 1000;
    let changed = false;
    const keys = Object.keys(runtime);
    for (let i = 0; i < keys.length; i++) {
        const entry = runtime[keys[i]];
        if (!entry) continue;
        if (entry.regenHp != null && entry.regenHpTicksMs != null && entry.regenHpTicksMs > 0) {
            entry.regenHpTimerMs = (entry.regenHpTimerMs || 0) + dtMs;
            while (entry.regenHpTimerMs >= entry.regenHpTicksMs) {
                entry.regenHpTimerMs -= entry.regenHpTicksMs;
                hpDelta += entry.regenHp;
                changed = true;
            }
        }
        if (entry.regenMp != null && entry.regenMpTicksMs != null && entry.regenMpTicksMs > 0) {
            entry.regenMpTimerMs = (entry.regenMpTimerMs || 0) + dtMs;
            while (entry.regenMpTimerMs >= entry.regenMpTicksMs) {
                entry.regenMpTimerMs -= entry.regenMpTicksMs;
                mpDelta += entry.regenMp;
                changed = true;
            }
        }
    }
    return { hpDelta, mpDelta, changed };
}

/**
 * Consume charges on damaging hits (e.g. Might Ring absorb charges).
 * Each hit decrements every charged slot by `amount` (default 1).
 * Slots that reach 0 are depleted.
 *
 * @param {Record<string, EquipmentSlotRuntime>|null|undefined} runtime
 * @param {number} [amount=1]
 * @returns {ChargeResult}
 */
function consumeEquipmentCharges(runtime, amount) {
    /** @type {string[]} */
    const depletedSlots = [];
    /** @type {string[]} */
    const consumedSlots = [];
    if (!runtime || typeof runtime !== 'object') {
        return { depletedSlots, consumedSlots, changed: false };
    }
    const n = Math.max(0, Math.floor(Number(amount) || 0));
    if (n <= 0) {
        return { depletedSlots, consumedSlots, changed: false };
    }

    let changed = false;
    const keys = Object.keys(runtime);
    for (let i = 0; i < keys.length; i++) {
        const slot = keys[i];
        const entry = runtime[slot];
        if (!entry || entry.remainingCharges == null) continue;
        if (entry.remainingCharges <= 0) {
            depletedSlots.push(slot);
            continue;
        }
        entry.remainingCharges = Math.max(0, entry.remainingCharges - n);
        consumedSlots.push(slot);
        changed = true;
        if (entry.remainingCharges <= 0) {
            depletedSlots.push(slot);
        }
    }
    return { depletedSlots, consumedSlots, changed };
}

/**
 * Drop runtime entries and clear equipment map slots for expired/depleted gear.
 *
 * @param {Record<string, string|number|null|undefined>|null|undefined} equipment
 * @param {Record<string, EquipmentSlotRuntime>|null|undefined} runtime
 * @param {string[]} slots
 * @returns {{ equipment: Record<string, string>, runtime: Record<string, EquipmentSlotRuntime> }}
 */
function clearExpiredEquipmentSlots(equipment, runtime, slots) {
    const eq = equipment && typeof equipment === 'object' ? Object.assign({}, equipment) : {};
    const rt =
        runtime && typeof runtime === 'object'
            ? Object.assign(Object.create(null), runtime)
            : Object.create(null);
    if (!Array.isArray(slots) || !slots.length) {
        return { equipment: eq, runtime: rt };
    }
    for (let i = 0; i < slots.length; i++) {
        const slot = slots[i];
        if (!slot) continue;
        delete eq[slot];
        delete rt[slot];
    }
    return { equipment: eq, runtime: rt };
}

/**
 * Convenience: tick durations then clear any expired slots.
 *
 * @param {Record<string, string|number|null|undefined>} equipment
 * @param {Record<string, EquipmentSlotRuntime>} runtime
 * @param {number} dtSec
 * @returns {{ equipment: Record<string, string>, runtime: Record<string, EquipmentSlotRuntime>, expiredSlots: string[], changed: boolean }}
 */
function advanceEquipmentRuntime(equipment, runtime, dtSec) {
    const tick = tickEquipmentDurations(runtime, dtSec);
    if (!tick.expiredSlots.length) {
        return {
            equipment: equipment || {},
            runtime: runtime || Object.create(null),
            expiredSlots: [],
            changed: tick.changed
        };
    }
    const cleared = clearExpiredEquipmentSlots(equipment, runtime, tick.expiredSlots);
    return {
        equipment: cleared.equipment,
        runtime: cleared.runtime,
        expiredSlots: tick.expiredSlots,
        changed: true
    };
}

/**
 * Convenience: consume charges on hit then clear depleted slots.
 *
 * @param {Record<string, string|number|null|undefined>} equipment
 * @param {Record<string, EquipmentSlotRuntime>} runtime
 * @param {number} [amount=1]
 * @returns {{ equipment: Record<string, string>, runtime: Record<string, EquipmentSlotRuntime>, depletedSlots: string[], consumedSlots: string[], changed: boolean }}
 */
function applyHitChargeConsumption(equipment, runtime, amount) {
    const hit = consumeEquipmentCharges(runtime, amount);
    if (!hit.depletedSlots.length) {
        return {
            equipment: equipment || {},
            runtime: runtime || Object.create(null),
            depletedSlots: [],
            consumedSlots: hit.consumedSlots,
            changed: hit.changed
        };
    }
    const cleared = clearExpiredEquipmentSlots(equipment, runtime, hit.depletedSlots);
    return {
        equipment: cleared.equipment,
        runtime: cleared.runtime,
        depletedSlots: hit.depletedSlots,
        consumedSlots: hit.consumedSlots,
        changed: true
    };
}

/**
 * List standard combat slots (re-export convenience for callers).
 * @returns {readonly string[]}
 */
function combatEquipmentSlots() {
    return EQUIPMENT_SLOTS;
}

module.exports = {
    itemHasRuntimeBudget,
    initEquipmentRuntime,
    tickEquipmentDurations,
    tickEquipmentRegen,
    consumeEquipmentCharges,
    clearExpiredEquipmentSlots,
    advanceEquipmentRuntime,
    applyHitChargeConsumption,
    combatEquipmentSlots
};
