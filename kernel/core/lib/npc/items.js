/**
 * NPC give_item / take_item (Phase C.2).
 * Uses backpack-tree inventory APIs. Preview-safe helpers stay pure;
 * commitItemTransfer is the only writer. All-or-nothing (rollback on fail).
 */

'use strict';

const { findItem } = require('../character/stats.js');
const {
    MAX_STACK_SIZE,
    itemIsStackable,
    createItemInstance,
    placeInContainer,
    getContainer,
    destroyItem,
    countItemIdInInventoryTree,
    consumeItemIdFromInventory,
    totalCarriedWeight,
    canCarryAdditional,
    syncRootToEquippedBackpack
} = require('../character/inventory.js');

/**
 * @typedef {{ itemId: string, count: number }} ItemSpec
 * @typedef {{ give: ItemSpec|null, take: ItemSpec|null }} ItemTransfer
 */

/**
 * Normalize a string / `{ itemId|id|item, count }` spec. Invalid → null.
 * @param {*} raw
 * @param {number} [fallbackCount]
 * @returns {ItemSpec|null}
 */
function normalizeItemSpec(raw, fallbackCount) {
    if (raw == null) return null;
    let itemId = '';
    let count = fallbackCount;
    if (typeof raw === 'string' || typeof raw === 'number') {
        itemId = String(raw).trim();
    } else if (typeof raw === 'object' && !Array.isArray(raw)) {
        if (raw.itemId != null) itemId = String(raw.itemId).trim();
        else if (raw.id != null) itemId = String(raw.id).trim();
        else if (raw.item != null) itemId = String(raw.item).trim();
        if (raw.count != null) count = raw.count;
    } else {
        return null;
    }
    if (!itemId) return null;
    let n = count != null && Number.isFinite(Number(count)) ? Math.floor(Number(count)) : 1;
    if (n < 1) return null;
    return { itemId, count: n };
}

/**
 * @param {object|null|undefined} player
 * @param {object|null|undefined} ctx
 * @returns {object[]|Record<string, object>|null}
 */
function resolveItemDb(player, ctx) {
    if (player && player._loadoutItemDb) return player._loadoutItemDb;
    if (ctx && ctx.itemDb) return ctx.itemDb;
    if (ctx && ctx.sim) {
        if (ctx.sim.itemDb) return ctx.sim.itemDb;
        if (ctx.sim._itemDb) return ctx.sim._itemDb;
    }
    return null;
}

/**
 * Backpack-tree count (not equipped slots). Missing inv → 0.
 * @param {object|null|undefined} player
 * @param {string} itemId
 * @returns {number}
 */
function countPlayerItem(player, itemId) {
    if (!player || !player.inventory || itemId == null || String(itemId) === '') {
        return 0;
    }
    return countItemIdInInventoryTree(player.inventory, String(itemId));
}

/**
 * Reply give/take + give_item / take_item actions.
 * @param {object|null|undefined} reply
 * @returns {ItemTransfer}
 */
function transferFromReply(reply) {
    /** @type {ItemTransfer} */
    const empty = { give: null, take: null };
    if (!reply || typeof reply !== 'object') return empty;
    const action =
        reply.action != null && String(reply.action).trim()
            ? String(reply.action).trim()
            : '';
    let give = normalizeItemSpec(reply.give, reply.count);
    let take = normalizeItemSpec(reply.take, reply.count);
    if (!give && action === 'give_item') {
        give = normalizeItemSpec(
            reply.itemId != null ? reply.itemId : reply.item,
            reply.count
        );
    }
    if (!take && action === 'take_item') {
        take = normalizeItemSpec(
            reply.itemId != null ? reply.itemId : reply.item,
            reply.count
        );
    }
    return { give, take };
}

/**
 * @param {object} inv
 * @param {string} uid
 * @param {object[]|Record<string, object>|null} itemDb
 * @returns {{ ok: true, uid: string } | { ok: false, reason: string }}
 */
function tryNestBfs(inv, uid, itemDb) {
    syncRootToEquippedBackpack(inv);
    /** @type {string[]} */
    const queue = [inv.rootUid];
    /** @type {Set<string>} */
    const seen = new Set();
    while (queue.length) {
        const cuid = queue.shift();
        if (!cuid || seen.has(cuid)) continue;
        seen.add(cuid);
        const placed = placeInContainer(inv, uid, cuid, null, itemDb);
        if (placed.ok) {
            return { ok: true, uid: placed.uid || uid };
        }
        const cont = getContainer(inv, cuid);
        if (!cont || !Array.isArray(cont.slots)) continue;
        for (let i = 0; i < cont.slots.length; i++) {
            const child = cont.slots[i];
            if (child && inv.containers[child]) queue.push(child);
        }
    }
    return { ok: false, reason: 'not_enough_room' };
}

/**
 * @param {object[]|Record<string, object>|null} created
 * @param {object} inv
 */
function destroyCreated(inv, created) {
    if (!inv || !created) return;
    for (let i = 0; i < created.length; i++) {
        destroyItem(inv, created[i]);
    }
}

/**
 * NPC → player. All-or-nothing. Does not write storage.
 * @param {object|null|undefined} player
 * @param {ItemSpec|null|undefined} spec
 * @param {object[]|Record<string, object>|null} [itemDb]
 * @returns {{ ok: boolean, reason?: string, itemId?: string, count?: number }}
 */
function giveItemToPlayer(player, spec, itemDb) {
    const want = normalizeItemSpec(spec);
    if (!want) return { ok: false, reason: 'invalid_item' };
    if (!player || !player.inventory) {
        return { ok: false, reason: 'no_inventory', itemId: want.itemId, count: want.count };
    }
    const db = itemDb || resolveItemDb(player, null);
    const template = findItem(db, want.itemId);
    if (!template) {
        return { ok: false, reason: 'unknown_item', itemId: want.itemId, count: want.count };
    }
    const unit = template.weight != null ? Number(template.weight) || 0 : 0;
    const addWeight = unit * want.count;
    const level = player.level != null ? player.level : 1;
    const classId = player.classId != null ? player.classId : null;
    const current = totalCarriedWeight(player.inventory, db);
    if (!canCarryAdditional(level, current, addWeight, classId)) {
        return {
            ok: false,
            reason: 'not_enough_cap',
            itemId: want.itemId,
            count: want.count
        };
    }
    const stackable = itemIsStackable(template);
    /** @type {string[]} */
    const created = [];
    let remaining = want.count;
    while (remaining > 0) {
        const chunk = stackable ? Math.min(MAX_STACK_SIZE, remaining) : 1;
        let uid;
        try {
            uid = createItemInstance(player.inventory, want.itemId, db, {
                count: chunk
            });
        } catch (_) {
            destroyCreated(player.inventory, created);
            return {
                ok: false,
                reason: 'unknown_item',
                itemId: want.itemId,
                count: want.count
            };
        }
        created.push(uid);
        const placed = tryNestBfs(player.inventory, uid, db);
        if (!placed.ok) {
            destroyCreated(player.inventory, created);
            return {
                ok: false,
                reason: placed.reason || 'not_enough_room',
                itemId: want.itemId,
                count: want.count
            };
        }
        remaining -= chunk;
    }
    return { ok: true, itemId: want.itemId, count: want.count };
}

/**
 * Player → NPC. All-or-nothing. Backpack tree only (not equipped).
 * @param {object|null|undefined} player
 * @param {ItemSpec|null|undefined} spec
 * @returns {{ ok: boolean, reason?: string, itemId?: string, count?: number, spent?: number }}
 */
function takeItemFromPlayer(player, spec) {
    const want = normalizeItemSpec(spec);
    if (!want) return { ok: false, reason: 'invalid_item' };
    if (!player || !player.inventory) {
        return { ok: false, reason: 'no_inventory', itemId: want.itemId, count: want.count };
    }
    const have = countItemIdInInventoryTree(player.inventory, want.itemId);
    if (have < want.count) {
        return {
            ok: false,
            reason: 'no_item',
            itemId: want.itemId,
            count: want.count,
            spent: 0
        };
    }
    const spent = consumeItemIdFromInventory(
        player.inventory,
        want.itemId,
        want.count
    );
    if (!spent.ok || spent.spent < want.count) {
        return {
            ok: false,
            reason: 'no_item',
            itemId: want.itemId,
            count: want.count,
            spent: spent.spent
        };
    }
    return {
        ok: true,
        itemId: want.itemId,
        count: want.count,
        spent: spent.spent
    };
}

/**
 * Take then give. If give fails after take, restore the taken stack.
 * @param {object|null|undefined} player
 * @param {ItemTransfer|null|undefined} transfer
 * @param {object[]|Record<string, object>|null} [itemDb]
 * @returns {{ ok: boolean, reason?: string, gave?: ItemSpec|null, took?: ItemSpec|null }}
 */
function commitItemTransfer(player, transfer, itemDb) {
    if (!transfer || (!transfer.give && !transfer.take)) {
        return { ok: true, gave: null, took: null };
    }
    const db = itemDb || resolveItemDb(player, null);
    if (transfer.take) {
        const taken = takeItemFromPlayer(player, transfer.take);
        if (!taken.ok) return taken;
    }
    if (transfer.give) {
        const given = giveItemToPlayer(player, transfer.give, db);
        if (!given.ok) {
            if (transfer.take) {
                giveItemToPlayer(player, transfer.take, db);
            }
            return given;
        }
    }
    if (player && typeof player.applyInventoryMutation === 'function') {
        player.applyInventoryMutation();
    }
    return { ok: true, gave: transfer.give || null, took: transfer.take || null };
}

/**
 * Honest FCT for a failed give/take. Null when the reason is not a transfer fail.
 * @param {string|null|undefined} reason
 * @returns {string|null}
 */
function transferFailText(reason) {
    const r = reason != null ? String(reason) : '';
    if (r === 'not_enough_cap') return 'Not enough cap';
    if (r === 'not_enough_room' || r === 'full') return 'Not enough room';
    if (r === 'no_item') return 'You do not have that.';
    if (
        r === 'unknown_item' ||
        r === 'invalid_item' ||
        r === 'no_inventory' ||
        r === 'no_itemdb'
    ) {
        return 'You cannot take that.';
    }
    return null;
}

module.exports = {
    normalizeItemSpec,
    resolveItemDb,
    countPlayerItem,
    transferFromReply,
    giveItemToPlayer,
    takeItemFromPlayer,
    commitItemTransfer,
    transferFailText
};
