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
 * @property {boolean} [consumeChargesOnHit] true for absorb-style gear (resists)
 * @property {Record<string, number>|null} [absorbResists] positive resists that spend a charge
 * @property {number|null} [regenHp]
 * @property {number|null} [regenHpTicksMs]
 * @property {number|null} [regenHpTimerMs]
 * @property {number|null} [regenMp]
 * @property {number|null} [regenMpTicksMs]
 * @property {number|null} [regenMpTimerMs]
 */

/**
 * @typedef {object} SlotBudgetSeed
 * @property {number|null} [remainingDurationSec]
 * @property {number|null} [remainingCharges]
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
 * Positive absorb resists that spend a charge on hit (legacy absorbPercent).
 * @param {object|null|undefined} item
 * @returns {{ consume: boolean, resists: Record<string, number>|null }}
 */
function absorbChargeProfile(item) {
    const raw = item && item.resists && typeof item.resists === 'object' ? item.resists : null;
    if (!raw) return { consume: false, resists: null };
    /** @type {Record<string, number>} */
    const positive = Object.create(null);
    let any = false;
    const keys = Object.keys(raw);
    for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        const v = Number(raw[k]);
        if (Number.isFinite(v) && v > 0) {
            positive[k] = v;
            any = true;
        }
    }
    return { consume: any, resists: any ? positive : null };
}

/**
 * Build per-slot runtime state for equipped items that have durationSec and/or charges.
 * Slots without budget are omitted (no tick cost).
 *
 * Duration only ticks while equipped (caller runs tickEquipmentDurations on the
 * wearer). Remaining budgets survive unequip when written onto inventory
 * instances and re-seeded via `slotBudgets` (legacy stopduration).
 *
 * @param {Record<string, string|number|null|undefined>|null|undefined} equipment
 * @param {object[]|Record<string, object>|null} itemDb
 * @param {Record<string, EquipmentSlotRuntime>|null|undefined} [previous]
 *        When re-equipping the same itemId on a slot, preserve remaining counters.
 * @param {Record<string, SlotBudgetSeed>|null|undefined} [slotBudgets]
 *        Per-slot remaining from inventory instances (after unequip/re-equip).
 * @returns {Record<string, EquipmentSlotRuntime>}
 */
function initEquipmentRuntime(equipment, itemDb, previous, slotBudgets) {
    /** @type {Record<string, EquipmentSlotRuntime>} */
    const runtime = Object.create(null);
    const eq = normalizeEquipmentMap(equipment);
    const prev = previous && typeof previous === 'object' ? previous : null;
    const seeds = slotBudgets && typeof slotBudgets === 'object' ? slotBudgets : null;
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
        const absorb = absorbChargeProfile(item);
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
            consumeChargesOnHit: !!(charges != null && charges > 0 && absorb.consume),
            absorbResists: absorb.resists,
            regenHp: (regenHp != null && regenHpTicksMs != null) ? regenHp : null,
            regenHpTicksMs: (regenHp != null && regenHpTicksMs != null) ? regenHpTicksMs : null,
            regenHpTimerMs: (regenHp != null && regenHpTicksMs != null) ? 0 : null,
            regenMp: (regenMp != null && regenMpTicksMs != null) ? regenMp : null,
            regenMpTicksMs: (regenMp != null && regenMpTicksMs != null) ? regenMpTicksMs : null,
            regenMpTimerMs: (regenMp != null && regenMpTicksMs != null) ? 0 : null
        };

        // Priority: live previous runtime (still equipped) → inventory seed (stopduration) → template max
        const prevEntry =
            prev && prev[slot] && prev[slot].itemId === entry.itemId ? prev[slot] : null;
        const seed =
            seeds && seeds[slot] && typeof seeds[slot] === 'object' ? seeds[slot] : null;

        if (entry.remainingDurationSec != null) {
            if (prevEntry && prevEntry.remainingDurationSec != null) {
                entry.remainingDurationSec = Math.max(0, Number(prevEntry.remainingDurationSec));
            } else if (seed && seed.remainingDurationSec != null && Number.isFinite(Number(seed.remainingDurationSec))) {
                entry.remainingDurationSec = Math.max(
                    0,
                    Math.min(entry.initialDurationSec || 0, Number(seed.remainingDurationSec))
                );
            }
        }
        if (entry.remainingCharges != null) {
            if (prevEntry && prevEntry.remainingCharges != null) {
                entry.remainingCharges = Math.max(0, Math.floor(Number(prevEntry.remainingCharges)));
            } else if (seed && seed.remainingCharges != null && Number.isFinite(Number(seed.remainingCharges))) {
                entry.remainingCharges = Math.max(
                    0,
                    Math.min(
                        entry.initialCharges || 0,
                        Math.floor(Number(seed.remainingCharges))
                    )
                );
            }
        }
        if (prevEntry) {
            if (entry.regenHpTimerMs != null && prevEntry.regenHpTimerMs != null) {
                entry.regenHpTimerMs = Math.max(0, Number(prevEntry.regenHpTimerMs));
            }
            if (entry.regenMpTimerMs != null && prevEntry.regenMpTimerMs != null) {
                entry.regenMpTimerMs = Math.max(0, Number(prevEntry.regenMpTimerMs));
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
 * Whether a charged slot should spend a charge for this damage element.
 * Legacy: absorb gear spends a charge when its absorbPercent applies for the
 * combat type. Weapons/other charged items are not spent on being hit.
 *
 * @param {EquipmentSlotRuntime} entry
 * @param {string|null|undefined} element
 * @returns {boolean}
 */
function slotSpendsChargeOnHit(entry, element) {
    if (!entry || entry.remainingCharges == null) return false;
    // Legacy path only tracks absorb-style gear (positive resists).
    if (!entry.consumeChargesOnHit) return false;
    const resists = entry.absorbResists;
    if (!resists) return false;
    if (element === 'healing') return false;
    // No element → any damaging hit (helpers / tests); live path passes combat element.
    if (element == null || element === '') return true;
    const el = String(element);
    if (Number(resists[el]) > 0) return true;
    // earth ↔ poison alias (legacy absorbpercentpoison)
    if (el === 'earth' && Number(resists.poison) > 0) return true;
    if (el === 'poison' && Number(resists.earth) > 0) return true;
    return false;
}

/**
 * Consume charges on damaging hits for absorb gear (e.g. Might Ring / power_band).
 * Only slots with positive resists for the hit element spend a charge.
 * Slots that reach 0 are depleted.
 *
 * @param {Record<string, EquipmentSlotRuntime>|null|undefined} runtime
 * @param {number} [amount=1]
 * @param {{ element?: string|null }} [opts]
 * @returns {ChargeResult}
 */
function consumeEquipmentCharges(runtime, amount, opts) {
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
    const element = opts && opts.element != null ? opts.element : null;

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
        if (!slotSpendsChargeOnHit(entry, element)) continue;
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
 * @param {{ element?: string|null }} [opts]
 * @returns {{ equipment: Record<string, string>, runtime: Record<string, EquipmentSlotRuntime>, depletedSlots: string[], consumedSlots: string[], changed: boolean }}
 */
function applyHitChargeConsumption(equipment, runtime, amount, opts) {
    const hit = consumeEquipmentCharges(runtime, amount, opts);
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

/**
 * Format remaining duration for item slot overlays (legacy client UIItem).
 * ≥1h → "XhYYm"; ≥1m → "XmYY"; else "Xs". Returns null when not positive.
 *
 * @param {number|null|undefined} secs
 * @returns {string|null}
 */
function formatDurationDisplay(secs) {
    if (secs == null || !Number.isFinite(Number(secs))) return null;
    const s = Math.max(0, Math.floor(Number(secs)));
    if (s <= 0) return null;
    if (s >= 3600) {
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        return `${h}h${String(m).padStart(2, '0')}m`;
    }
    if (s >= 60) {
        const m = Math.floor(s / 60);
        const r = s % 60;
        return `${m}m${String(r).padStart(2, '0')}`;
    }
    return `${s}s`;
}

/**
 * Resolve remaining charges/duration for UI overlays.
 * Priority: live equipment runtime → inventory instance → template max.
 * Floor duration to whole seconds for dirty signatures (1 Hz text updates).
 *
 * @param {{
 *   item?: object|null,
 *   instance?: { remainingCharges?: number|null, remainingDurationSec?: number|null }|null,
 *   runtime?: EquipmentSlotRuntime|null
 * }} [opts]
 * @returns {{
 *   charges: number|null,
 *   durationSec: number|null,
 *   durationText: string|null,
 *   sig: string
 * }}
 */
function resolveItemBudgetDisplay(opts) {
    const o = opts || {};
    const item = o.item && typeof o.item === 'object' ? o.item : null;
    const inst = o.instance && typeof o.instance === 'object' ? o.instance : null;
    const rt = o.runtime && typeof o.runtime === 'object' ? o.runtime : null;

    /** @type {number|null} */
    let charges = null;
    if (rt && rt.remainingCharges != null && Number.isFinite(Number(rt.remainingCharges))) {
        charges = Math.max(0, Math.floor(Number(rt.remainingCharges)));
    } else if (
        inst &&
        inst.remainingCharges != null &&
        Number.isFinite(Number(inst.remainingCharges))
    ) {
        charges = Math.max(0, Math.floor(Number(inst.remainingCharges)));
    } else if (item && item.charges != null && Number.isFinite(Number(item.charges))) {
        const c = Math.floor(Number(item.charges));
        if (c > 0) charges = c;
    }
    if (charges != null && charges <= 0) charges = null;

    /** @type {number|null} */
    let durationSec = null;
    if (
        rt &&
        rt.remainingDurationSec != null &&
        Number.isFinite(Number(rt.remainingDurationSec))
    ) {
        durationSec = Math.max(0, Number(rt.remainingDurationSec));
    } else if (
        inst &&
        inst.remainingDurationSec != null &&
        Number.isFinite(Number(inst.remainingDurationSec))
    ) {
        durationSec = Math.max(0, Number(inst.remainingDurationSec));
    } else if (
        item &&
        item.durationSec != null &&
        Number.isFinite(Number(item.durationSec))
    ) {
        const d = Number(item.durationSec);
        if (d > 0) durationSec = d;
    }
    if (durationSec != null && durationSec <= 0) durationSec = null;

    const durationFloor =
        durationSec != null ? Math.floor(durationSec) : null;
    const durationText =
        durationFloor != null ? formatDurationDisplay(durationFloor) : null;

    return {
        charges,
        durationSec: durationFloor,
        durationText,
        sig: `c${charges != null ? charges : ''}:d${durationFloor != null ? durationFloor : ''}`
    };
}

/**
 * Prefer equipped instance of `itemId`, else any inventory instance, for budget UI.
 *
 * @param {object|null|undefined} inv runtime inventory
 * @param {string|null|undefined} itemId
 * @param {object[]|Record<string, object>|null} [itemDb]
 * @param {Record<string, EquipmentSlotRuntime>|null|undefined} [equipmentRuntime]
 * @returns {{
 *   charges: number|null,
 *   durationSec: number|null,
 *   durationText: string|null,
 *   sig: string
 * }}
 */
function resolveItemIdBudgetDisplay(inv, itemId, itemDb, equipmentRuntime) {
    const id = itemId != null ? String(itemId).trim() : '';
    if (!id) {
        return { charges: null, durationSec: null, durationText: null, sig: 'c:d' };
    }
    const item = findItem(itemDb, id);
    let instance = null;
    /** @type {EquipmentSlotRuntime|null} */
    let runtime = null;

    if (inv && inv.equipment && inv.items) {
        const slots = Object.keys(inv.equipment);
        for (let i = 0; i < slots.length; i++) {
            const slot = slots[i];
            const uid = inv.equipment[slot];
            if (!uid) continue;
            const inst = inv.items[uid];
            if (!inst || inst.itemId !== id) continue;
            instance = inst;
            if (
                equipmentRuntime &&
                equipmentRuntime[slot] &&
                equipmentRuntime[slot].itemId === id
            ) {
                runtime = equipmentRuntime[slot];
            }
            break;
        }
    }
    if (!instance && inv && inv.items) {
        const uids = Object.keys(inv.items);
        for (let i = 0; i < uids.length; i++) {
            const inst = inv.items[uids[i]];
            if (inst && inst.itemId === id) {
                instance = inst;
                break;
            }
        }
    }
    return resolveItemBudgetDisplay({ item, instance, runtime });
}

module.exports = {
    itemHasRuntimeBudget,
    absorbChargeProfile,
    initEquipmentRuntime,
    tickEquipmentDurations,
    tickEquipmentRegen,
    slotSpendsChargeOnHit,
    consumeEquipmentCharges,
    clearExpiredEquipmentSlots,
    advanceEquipmentRuntime,
    applyHitChargeConsumption,
    combatEquipmentSlots,
    formatDurationDisplay,
    resolveItemBudgetDisplay,
    resolveItemIdBudgetDisplay
};
