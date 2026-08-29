/**
 * W2 quest chest: USE → evalWhen + give (all-or-nothing) + storage set.
 * Reuses NPC storage / item transfer. No Lua. Do not delete the pin.
 */

'use strict';

const { findItem } = require('../character/stats.js');
const { getItem } = require('../character/inventory.js');
const { evalWhen, applyStoragePatch } = require('../npc/storage.js');
const {
    normalizeItemSpec,
    commitItemTransfer,
    takeItemFromPlayer,
    transferFailText,
    resolveItemDb
} = require('../npc/items.js');

const DEFAULT_CHEST_EMPTY_TEXT = 'The chest is empty.';

/**
 * @param {object|null|undefined} pin
 * @returns {string}
 */
function chestEmptyText(pin) {
    const t = pin && pin.emptyText != null ? String(pin.emptyText).trim() : '';
    return t || DEFAULT_CHEST_EMPTY_TEXT;
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
        transformOnUse: inst.worldPinTransformOnUse || null
    };
}

/**
 * Swap ground-instance catalog art. Does not mutate hybrid `world[]`.
 * @param {object} inst
 * @param {string} catalogId
 * @param {object[]|Record<string, object>|null} itemDb
 * @returns {boolean}
 */
function applyChestTransform(inst, catalogId, itemDb) {
    const id = catalogId != null ? String(catalogId).trim() : '';
    if (!id || !inst) return false;
    inst.itemId = id;
    const template = findItem(itemDb, id);
    if (template) {
        const label = template.label || template.name;
        if (label) inst.name = label;
    }
    return true;
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
 * Hunt USE on `kind: chest`. Caller enforces Chebyshev ≤ 1.
 *
 * Fail once/when/shared-used → emptyText. Cap/room fail → no storage write.
 * Success → all give specs, then set, then optional transformTo.
 *
 * @param {object|null|undefined} player
 * @param {object|null|undefined} inst
 * @param {{ itemDb?: object[]|Record<string, object>|null, pin?: object|null }} [opts]
 * @returns {{
 *   ok: boolean,
 *   reason?: string,
 *   text?: string,
 *   gave?: object[],
 *   transformed?: string|null
 * }}
 */
function useWorldChest(player, inst, opts) {
    const o = opts || {};
    if (!inst || inst.worldPinKind !== 'chest') {
        return {
            ok: false,
            reason: 'not_chest',
            text: 'You cannot use this object.'
        };
    }
    const pin = pinFromInst(inst, o.pin);
    if (inst.worldPinUsed) {
        return { ok: false, reason: 'empty', text: chestEmptyText(pin) };
    }
    if (!evalWhen(player, pin.once) || !evalWhen(player, pin.when)) {
        return { ok: false, reason: 'empty', text: chestEmptyText(pin) };
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
    if (pin.shared === true || inst.worldShared === true) {
        inst.worldPinUsed = true;
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
 * @param {object|null|undefined} player
 * @param {object|null|undefined} ground
 * @param {string} uid
 * @param {{ itemDb?: object[]|Record<string, object>|null, pin?: object|null }} [opts]
 * @returns {ReturnType<typeof useWorldChest>}
 */
function useWorldChestAt(player, ground, uid, opts) {
    if (!ground || !ground.inventory || uid == null || String(uid) === '') {
        return {
            ok: false,
            reason: 'not_chest',
            text: 'You cannot use this object.'
        };
    }
    const inst = getItem(ground.inventory, uid);
    return useWorldChest(player, inst, opts);
}

module.exports = {
    DEFAULT_CHEST_EMPTY_TEXT,
    chestEmptyText,
    useWorldChest,
    useWorldChestAt,
    applyChestTransform
};
