/**
 * W6 harvest: USE bush/ore → give + optional transform / cooldown / storage.
 * Reuses NPC evalWhen / commitItemTransfer / applyStoragePatch. No Lua.
 */

'use strict';

const { getItem } = require('../character/inventory.js');
const { evalWhen, applyStoragePatch } = require('../npc/storage.js');
const {
    normalizeItemSpec,
    commitItemTransfer,
    takeItemFromPlayer,
    transferFailText,
    resolveItemDb
} = require('../npc/items.js');
const { applyChestTransform } = require('./world_pin_chest.js');

const DEFAULT_HARVEST_EMPTY_TEXT = 'You find nothing.';

/**
 * @param {object|null|undefined} pin
 * @returns {string}
 */
function harvestEmptyText(pin) {
    const t = pin && pin.emptyText != null ? String(pin.emptyText).trim() : '';
    return t || DEFAULT_HARVEST_EMPTY_TEXT;
}

/**
 * @param {object|null|undefined} inst
 * @param {object|null|undefined} explicit
 * @returns {object|null}
 */
function pinFromInst(inst, explicit) {
    if (explicit && typeof explicit === 'object') return explicit;
    if (!inst) return null;
    return {
        id: inst.worldPinId,
        kind: inst.worldPinKind,
        shared: !!inst.worldShared,
        once: inst.worldPinOnce || null,
        when: inst.worldPinWhen || null,
        give: inst.worldPinGive || [],
        set: inst.worldPinSet || null,
        emptyText: inst.worldPinEmptyText || '',
        transformTo: inst.worldPinTransformTo || '',
        transformOnUse: inst.worldPinTransformOnUse || null,
        cooldown: inst.worldPinCooldown
    };
}

/**
 * @param {object|null|undefined} player
 * @param {object[]} given
 */
function rollbackGives(player, given) {
    if (!player || !given || !given.length) return;
    for (let i = given.length - 1; i >= 0; i--) {
        takeItemFromPlayer(player, given[i]);
    }
    if (typeof player.applyInventoryMutation === 'function') {
        player.applyInventoryMutation();
    }
}

/**
 * Hunt USE on `kind: harvest`. Caller enforces Chebyshev ≤ 1.
 *
 * @param {object|null|undefined} player
 * @param {object|null|undefined} inst
 * @param {{
 *   itemDb?: object[]|Record<string, object>|null,
 *   pin?: object|null,
 *   time?: number
 * }} [opts]
 * @returns {{
 *   ok: boolean,
 *   reason?: string,
 *   text?: string,
 *   gave?: object[],
 *   transformed?: string|null
 * }}
 */
function useWorldHarvest(player, inst, opts) {
    const o = opts || {};
    if (!inst || inst.worldPinKind !== 'harvest') {
        return {
            ok: false,
            reason: 'not_harvest',
            text: 'You cannot use this object.'
        };
    }
    const pin = pinFromInst(inst, o.pin);
    const now = o.time != null ? Number(o.time) : 0;
    if (
        inst.worldPinHarvestReadyAt != null &&
        Number.isFinite(Number(inst.worldPinHarvestReadyAt)) &&
        now < Number(inst.worldPinHarvestReadyAt)
    ) {
        return { ok: false, reason: 'empty', text: harvestEmptyText(pin) };
    }
    if (inst.worldPinUsed) {
        return { ok: false, reason: 'empty', text: harvestEmptyText(pin) };
    }
    if (!evalWhen(player, pin.once) || !evalWhen(player, pin.when)) {
        return { ok: false, reason: 'empty', text: harvestEmptyText(pin) };
    }
    const itemDb = o.itemDb || resolveItemDb(player, o);
    const giveRaw = Array.isArray(pin.give) ? pin.give : [];
    /** @type {object[]} */
    const specs = [];
    for (let i = 0; i < giveRaw.length; i++) {
        const spec = normalizeItemSpec(giveRaw[i]);
        if (spec) specs.push(spec);
    }
    /** @type {object[]} */
    const given = [];
    for (let i = 0; i < specs.length; i++) {
        const moved = commitItemTransfer(
            player,
            { give: specs[i], take: null },
            itemDb
        );
        if (!moved.ok) {
            rollbackGives(player, given);
            return {
                ok: false,
                reason: moved.reason,
                text: transferFailText(moved.reason) || 'You cannot take that.',
                itemId: moved.itemId,
                count: moved.count
            };
        }
        given.push(specs[i]);
    }
    if (pin.set) applyStoragePatch(player, pin.set);
    const cooldown =
        pin.cooldown != null && Number.isFinite(Number(pin.cooldown))
            ? Number(pin.cooldown)
            : 0;
    if (pin.shared === true || inst.worldShared === true) {
        inst.worldPinUsed = true;
    }
    if (cooldown > 0) {
        inst.worldPinHarvestReadyAt = now + cooldown;
    }
    const transformTo =
        pin.transformTo != null && String(pin.transformTo).trim()
            ? String(pin.transformTo).trim()
            : typeof pin.transformOnUse === 'string'
              ? String(pin.transformOnUse).trim()
              : '';
    if (transformTo) applyChestTransform(inst, transformTo, itemDb);
    return {
        ok: true,
        gave: given,
        transformed: transformTo || null
    };
}

/**
 * When cooldown is due: restore catalog and allow another harvest.
 * @param {object|null|undefined} ground
 * @param {number} nowSec
 * @param {{ itemDb?: object[]|Record<string, object>|null }} [opts]
 * @returns {number}
 */
function tickWorldPinHarvest(ground, nowSec, opts) {
    if (!ground || !ground.inventory || !ground.inventory.items) return 0;
    const now = Number(nowSec);
    if (!Number.isFinite(now)) return 0;
    const itemDb = opts && opts.itemDb ? opts.itemDb : null;
    const ids = Object.keys(ground.inventory.items);
    let n = 0;
    for (let i = 0; i < ids.length; i++) {
        const inst = ground.inventory.items[ids[i]];
        if (!inst || inst.worldPinKind !== 'harvest') continue;
        if (inst.worldPinHarvestReadyAt == null) continue;
        const ready = Number(inst.worldPinHarvestReadyAt);
        if (!Number.isFinite(ready) || now < ready) continue;
        delete inst.worldPinHarvestReadyAt;
        inst.worldPinUsed = false;
        const base = inst.worldPinBaseCatalog || '';
        if (base && inst.itemId !== base) {
            applyChestTransform(inst, String(base), itemDb);
        }
        n += 1;
    }
    return n;
}

/**
 * @param {object|null|undefined} player
 * @param {object|null|undefined} ground
 * @param {string} uid
 * @param {{ itemDb?: object[]|Record<string, object>|null, pin?: object|null, time?: number }} [opts]
 * @returns {ReturnType<typeof useWorldHarvest>}
 */
function useWorldHarvestAt(player, ground, uid, opts) {
    if (!ground || !ground.inventory || uid == null || String(uid) === '') {
        return {
            ok: false,
            reason: 'not_harvest',
            text: 'You cannot use this object.'
        };
    }
    const inst = getItem(ground.inventory, uid);
    return useWorldHarvest(player, inst, opts);
}

module.exports = {
    DEFAULT_HARVEST_EMPTY_TEXT,
    harvestEmptyText,
    useWorldHarvest,
    useWorldHarvestAt,
    tickWorldPinHarvest
};
