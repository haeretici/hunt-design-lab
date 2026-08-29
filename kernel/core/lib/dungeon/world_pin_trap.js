/**
 * W6 trap: step-on pin → damage and/or elemental field.
 * Fires from tile finalize (not Use). Pin + dispatcher — not a separate entity type.
 */

'use strict';

const { getItem } = require('../character/inventory.js');
const { getStack } = require('../character/ground_items.js');
const { evalWhen, applyStoragePatch } = require('../npc/storage.js');
const { deployFieldAndTriggerOccupants } = require('../combat/elemental_fields.js');
const { applyChestTransform } = require('./world_pin_chest.js');

/**
 * @param {object|null|undefined} inst
 * @returns {object}
 */
function pinFromInst(inst) {
    if (!inst) return {};
    return {
        once: inst.worldPinOnce || null,
        when: inst.worldPinWhen || null,
        set: inst.worldPinSet || null,
        shared: !!inst.worldShared,
        damage: inst.worldPinDamage,
        field: inst.worldPinField,
        element: inst.worldPinElement,
        transformTo: inst.worldPinTransformTo || '',
        cooldown: inst.worldPinCooldown
    };
}

/**
 * @param {object} entity
 * @param {object} inst
 * @param {number} now
 * @returns {boolean}
 */
function trapReady(entity, inst, now) {
    if (!inst || inst.worldPinKind !== 'trap') return false;
    if (inst.worldPinUsed) return false;
    if (
        inst.worldPinTrapReadyAt != null &&
        Number.isFinite(Number(inst.worldPinTrapReadyAt)) &&
        now < Number(inst.worldPinTrapReadyAt)
    ) {
        return false;
    }
    if (!evalWhen(entity, inst.worldPinOnce) || !evalWhen(entity, inst.worldPinWhen)) {
        return false;
    }
    return true;
}

/**
 * Fire one trap instance on the stepper.
 *
 * @param {object} entity
 * @param {object} inst
 * @param {object} ground
 * @param {number} now
 * @param {{ itemDb?: object[]|Record<string, object>|null }} [opts]
 * @returns {{
 *   ok: boolean,
 *   damage?: number,
 *   field?: string|null,
 *   transformed?: string|null
 * }}
 */
function triggerWorldTrap(entity, inst, ground, now, opts) {
    const o = opts || {};
    if (!trapReady(entity, inst, now)) {
        return { ok: false };
    }
    const pin = pinFromInst(inst);
    const loc = inst.location && typeof inst.location === 'object' ? inst.location : {};
    const x = loc.x;
    const y = loc.y;
    const z = loc.z != null ? loc.z : 0;
    let damage = 0;
    const amount = pin.damage != null ? Math.floor(Number(pin.damage)) : 0;
    const element = pin.element ? String(pin.element) : 'physical';
    if (amount >= 1 && entity && entity.alive) {
        if (typeof entity.applyHpDelta === 'function') {
            entity.applyHpDelta(amount, element);
        } else if (entity.hp) {
            entity.hp.current = Math.max(0, (entity.hp.current || 0) - amount);
            if (entity.hp.current <= 0) entity.alive = false;
        }
        damage = amount;
    }
    let fieldKind = pin.field ? String(pin.field) : '';
    if (fieldKind && ground && x != null && y != null) {
        deployFieldAndTriggerOccupants(
            ground,
            x,
            y,
            z,
            { kind: fieldKind, source: 'scenario', createdAt: now },
            [entity],
            now
        );
    } else {
        fieldKind = '';
    }
    if (pin.set) applyStoragePatch(entity, pin.set);
    const cooldown =
        pin.cooldown != null && Number.isFinite(Number(pin.cooldown))
            ? Number(pin.cooldown)
            : 0;
    if (pin.shared === true || inst.worldShared === true) {
        inst.worldPinUsed = true;
    }
    if (cooldown > 0) inst.worldPinTrapReadyAt = now + cooldown;
    const transformTo =
        pin.transformTo != null && String(pin.transformTo).trim()
            ? String(pin.transformTo).trim()
            : '';
    if (transformTo) applyChestTransform(inst, transformTo, o.itemDb || null);
    return {
        ok: true,
        damage,
        field: fieldKind || null,
        transformed: transformTo || null
    };
}

/**
 * Step-on dispatcher. Exact tile, same z. Skip spawn-in-place (no prev).
 *
 * @param {object|null|undefined} entity
 * @param {{ x: number, y: number, z?: * }|null|undefined} prevTile
 * @param {{ x: number, y: number, z?: * }|null|undefined} nextTile
 * @param {object|null|undefined} ground
 * @param {number} [currentTime]
 * @param {{ itemDb?: object[]|Record<string, object>|null }} [opts]
 * @returns {number} traps fired
 */
function onWorldPinStep(entity, prevTile, nextTile, ground, currentTime, opts) {
    if (!entity || !entity.alive || !nextTile || !ground) return 0;
    if (!ground.inventory || !ground.inventory.items || !ground.stacks) return 0;
    if (!prevTile) return 0;
    const nx = Math.round(Number(nextTile.x));
    const ny = Math.round(Number(nextTile.y));
    const nz = nextTile.z != null ? nextTile.z : 0;
    const px = Math.round(Number(prevTile.x));
    const py = Math.round(Number(prevTile.y));
    const pz = prevTile.z != null ? prevTile.z : 0;
    if (
        !Number.isFinite(nx) ||
        !Number.isFinite(ny) ||
        (nx === px && ny === py && String(nz) === String(pz))
    ) {
        return 0;
    }
    const now = currentTime != null ? Number(currentTime) : 0;
    const stack = getStack(ground, nx, ny, nz);
    if (!stack.length) return 0;
    let n = 0;
    for (let i = 0; i < stack.length; i++) {
        const inst = getItem(ground.inventory, stack[i]);
        if (!inst || inst.worldPinKind !== 'trap') continue;
        const r = triggerWorldTrap(entity, inst, ground, now, opts);
        if (r.ok) n += 1;
    }
    return n;
}

/**
 * When cooldown is due: restore catalog and allow another trigger.
 * @param {object|null|undefined} ground
 * @param {number} nowSec
 * @param {{ itemDb?: object[]|Record<string, object>|null }} [opts]
 * @returns {number}
 */
function tickWorldPinTrap(ground, nowSec, opts) {
    if (!ground || !ground.inventory || !ground.inventory.items) return 0;
    const now = Number(nowSec);
    if (!Number.isFinite(now)) return 0;
    const itemDb = opts && opts.itemDb ? opts.itemDb : null;
    const ids = Object.keys(ground.inventory.items);
    let n = 0;
    for (let i = 0; i < ids.length; i++) {
        const inst = ground.inventory.items[ids[i]];
        if (!inst || inst.worldPinKind !== 'trap') continue;
        if (inst.worldPinTrapReadyAt == null) continue;
        const ready = Number(inst.worldPinTrapReadyAt);
        if (!Number.isFinite(ready) || now < ready) continue;
        delete inst.worldPinTrapReadyAt;
        inst.worldPinUsed = false;
        const base = inst.worldPinBaseCatalog || '';
        if (base && inst.itemId !== base) {
            applyChestTransform(inst, String(base), itemDb);
        }
        n += 1;
    }
    return n;
}

module.exports = {
    onWorldPinStep,
    triggerWorldTrap,
    tickWorldPinTrap
};
