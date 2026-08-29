/**
 * Hunt seed: hybrid `world[]` pins → ground items before tick 0.
 * Editor helpers stay in world_pins.js. No Lua; furniture stamps stay art.
 */

'use strict';

const { findItem } = require('../character/stats.js');
const {
    createItemInstance,
    getItem,
    getContainer,
    placeInContainer,
    itemIsContainer,
    itemIsStackable,
    destroyItem
} = require('../character/inventory.js');
const { tileKey, getStack } = require('../character/ground_items.js');
const {
    normalizeWorldList,
    DEFAULT_CONTAINER_CAPACITY,
    MAX_ITEM_NEST
} = require('./world_pins.js');
const { FRICTION_BLOCKED } = require('./tile_roles.js');
const { applyCellPatch } = require('./cell_patch.js');
const { applyChestTransform } = require('./world_pin_chest.js');

/**
 * @param {number} n
 * @returns {(null)[]}
 */
function emptySlots(n) {
    const cap = Math.max(0, Math.floor(n) || 0);
    /** @type {(null)[]} */
    const slots = [];
    for (let i = 0; i < cap; i++) slots.push(null);
    return slots;
}

/**
 * @param {object} inv
 * @param {string} uid
 * @param {number} capacity
 * @returns {object}
 */
function forceContainer(inv, uid, capacity) {
    const cap =
        Number.isFinite(Number(capacity)) && Number(capacity) >= 1
            ? Math.floor(Number(capacity))
            : DEFAULT_CONTAINER_CAPACITY;
    const existing = inv.containers[uid];
    if (existing) {
        existing.capacity = cap;
        if (!Array.isArray(existing.slots)) existing.slots = emptySlots(cap);
        while (existing.slots.length < cap) existing.slots.push(null);
        if (existing.slots.length > cap) existing.slots.length = cap;
        return existing;
    }
    inv.containers[uid] = {
        capacity: cap,
        slots: emptySlots(cap),
        isRoot: false
    };
    return inv.containers[uid];
}

/**
 * Walk-block a tile (friction 255). Sight unchanged. Occupancy stays creature-only.
 * @param {object|null|undefined} tileMap
 * @param {object} inst
 * @param {number} x
 * @param {number} y
 * @param {string|number} z
 */
function applyWorldPinWalkBlock(tileMap, inst, x, y, z) {
    if (!inst || !tileMap || typeof tileMap.getLayer !== 'function') return;
    const layer = tileMap.getLayer(z);
    if (!layer || !layer.friction) return;
    const ix = Math.round(x);
    const iy = Math.round(y);
    if (ix < 0 || iy < 0 || ix >= layer.cols || iy >= layer.rows) return;
    const idx =
        typeof tileMap.index === 'function'
            ? tileMap.index(ix, iy, layer.cols)
            : iy * layer.cols + ix;
    if (layer.friction[idx] === FRICTION_BLOCKED) return;
    const r = applyCellPatch(tileMap, {
        x: ix,
        y: iy,
        z,
        friction: FRICTION_BLOCKED
    });
    if (!r.ok) return;
    inst.savedFriction = r.prev.friction;
    inst.worldPinFrictionPatched = true;
}

/**
 * Restore walk if this instance owns the friction patch.
 * @param {object|null|undefined} tileMap
 * @param {object|null|undefined} inst
 * @param {number} x
 * @param {number} y
 * @param {string|number} z
 */
function restoreWorldPinWalkBlock(tileMap, inst, x, y, z) {
    if (!inst || !inst.worldPinFrictionPatched) return;
    if (!tileMap || typeof tileMap.getLayer !== 'function') {
        inst.worldPinFrictionPatched = false;
        return;
    }
    const layer = tileMap.getLayer(z);
    if (!layer || !layer.friction) {
        inst.worldPinFrictionPatched = false;
        return;
    }
    const ix = Math.round(x);
    const iy = Math.round(y);
    if (ix < 0 || iy < 0 || ix >= layer.cols || iy >= layer.rows) {
        inst.worldPinFrictionPatched = false;
        return;
    }
    const idx =
        typeof tileMap.index === 'function'
            ? tileMap.index(ix, iy, layer.cols)
            : iy * layer.cols + ix;
    if (
        layer.friction[idx] === FRICTION_BLOCKED &&
        inst.savedFriction != null &&
        Number.isFinite(Number(inst.savedFriction))
    ) {
        applyCellPatch(tileMap, {
            x: ix,
            y: iy,
            z,
            friction: Number(inst.savedFriction)
        });
    }
    inst.worldPinFrictionPatched = false;
}

/**
 * @param {object} ground
 * @returns {Record<string, true>}
 */
function existingWorldPinIds(ground) {
    /** @type {Record<string, true>} */
    const taken = Object.create(null);
    if (!ground || !ground.inventory || !ground.inventory.items) return taken;
    const ids = Object.keys(ground.inventory.items);
    for (let i = 0; i < ids.length; i++) {
        const inst = ground.inventory.items[ids[i]];
        if (inst && inst.worldPinId) taken[String(inst.worldPinId)] = true;
    }
    return taken;
}

/**
 * @param {object} inv
 * @param {string} containerUid
 * @param {object[]} items
 * @param {object[]|Record<string, object>|null|undefined} itemDb
 * @param {number} depth
 */
function fillContainerFromWorldItems(inv, containerUid, items, itemDb, depth) {
    const d = depth | 0;
    if (d > MAX_ITEM_NEST) return;
    const cont = getContainer(inv, containerUid);
    if (!cont || !Array.isArray(items) || !items.length) return;
    for (let i = 0; i < items.length; i++) {
        const row = items[i];
        if (!row || !row.item) continue;
        const template = findItem(itemDb, row.item);
        const nested = Array.isArray(row.items) && row.items.length;
        const wantCount =
            row.count != null && Number.isFinite(Number(row.count))
                ? Math.max(1, Math.floor(Number(row.count)))
                : 1;
        const split =
            wantCount > 1 && !itemIsStackable(template) && !nested
                ? wantCount
                : 1;
        const per = split === 1 ? wantCount : 1;
        for (let n = 0; n < split; n++) {
            const childUid = createItemInstance(inv, row.item, itemDb, {
                count: per
            });
            if (!childUid) continue;
            if (nested) {
                const childCap =
                    getContainer(inv, childUid) &&
                    getContainer(inv, childUid).capacity
                        ? getContainer(inv, childUid).capacity
                        : DEFAULT_CONTAINER_CAPACITY;
                forceContainer(inv, childUid, childCap);
                fillContainerFromWorldItems(
                    inv,
                    childUid,
                    row.items,
                    itemDb,
                    d + 1
                );
            }
            const placed = placeInContainer(
                inv,
                childUid,
                containerUid,
                null,
                itemDb
            );
            if (!placed.ok) destroyItem(inv, childUid);
        }
    }
}

/**
 * Stamp pin metadata onto a ground instance (Look / dispatcher / pickup).
 * @param {object} inst
 * @param {object} pin
 * @param {object|null|undefined} template
 */
function stampWorldPinInstance(inst, pin, template) {
    inst.worldPinId = pin.id;
    inst.worldPinKind = pin.kind;
    if (pin.catalogKind) inst.worldPinCatalogKind = pin.catalogKind;
    if (pin.tag) inst.worldPinTag = pin.tag;
    inst.worldShared = pin.shared === true;
    inst.pickupable = !!pin.pickupable;
    if (!pin.pickupable) inst.immovable = true;
    if (pin.blocking) inst.worldPinBlocking = true;
    const label =
        (template && (template.label || template.name)) ||
        String(pin.catalogId || '').replace(/_/g, ' ');
    if (label) inst.name = label;
    inst.worldPinBaseCatalog = pin.catalogId;
    if (pin.transformOnUse) inst.worldPinTransformOnUse = pin.transformOnUse;
    if (pin.decay && pin.decay.sec != null) {
        inst.worldPinDecaySec = pin.decay.sec;
        if (pin.decay.to) inst.worldPinDecayTo = pin.decay.to;
    }
    if (pin.kind === 'chest') {
        if (pin.once) inst.worldPinOnce = pin.once;
        if (pin.when) inst.worldPinWhen = pin.when;
        inst.worldPinGive = Array.isArray(pin.give) ? pin.give : [];
        if (pin.set) inst.worldPinSet = pin.set;
        if (pin.emptyText) inst.worldPinEmptyText = pin.emptyText;
        if (pin.transformTo) inst.worldPinTransformTo = pin.transformTo;
    } else if (pin.kind === 'lever' || pin.kind === 'switch') {
        inst.worldPinStates = Array.isArray(pin.states) ? pin.states : ['off', 'on'];
        inst.worldPinEffects = Array.isArray(pin.effects) ? pin.effects : [];
        inst.worldPinStateIndex = 0;
        inst.worldPinState = inst.worldPinStates[0] || 'off';
        if (pin.when) inst.worldPinWhen = pin.when;
    } else if (pin.kind === 'harvest') {
        if (pin.once) inst.worldPinOnce = pin.once;
        if (pin.when) inst.worldPinWhen = pin.when;
        inst.worldPinGive = Array.isArray(pin.give) ? pin.give : [];
        if (pin.set) inst.worldPinSet = pin.set;
        if (pin.emptyText) inst.worldPinEmptyText = pin.emptyText;
        if (pin.transformTo) inst.worldPinTransformTo = pin.transformTo;
        if (pin.cooldown != null) inst.worldPinCooldown = pin.cooldown;
    } else if (pin.kind === 'trap') {
        if (pin.once) inst.worldPinOnce = pin.once;
        if (pin.when) inst.worldPinWhen = pin.when;
        if (pin.set) inst.worldPinSet = pin.set;
        if (pin.transformTo) inst.worldPinTransformTo = pin.transformTo;
        if (pin.cooldown != null) inst.worldPinCooldown = pin.cooldown;
        if (pin.damage != null) inst.worldPinDamage = pin.damage;
        if (pin.field) inst.worldPinField = pin.field;
        if (pin.element) inst.worldPinElement = pin.element;
    } else if (pin.kind === 'door') {
        if (pin.closedId) inst.worldPinClosedId = pin.closedId;
        if (pin.openId) inst.worldPinOpenId = pin.openId;
        if (pin.gate) inst.worldPinGate = pin.gate;
        if (pin.lockId) inst.worldPinLockId = pin.lockId;
        if (pin.consume === true) inst.worldPinConsume = true;
        const openByArt =
            pin.openId &&
            pin.catalogId === pin.openId &&
            pin.catalogId !== pin.closedId;
        inst.worldPinDoorOpen = openByArt || !pin.blocking;
    } else if (pin.kind === 'teleport') {
        if (pin.to) inst.worldPinTo = pin.to;
    }
}

/**
 * Place one normalized pin onto the ground store.
 * @param {object} ground
 * @param {object} pin
 * @param {{ itemDb?: object[]|Record<string, object>|null, tileMap?: object|null }} [opts]
 * @returns {string|null} ground uid
 */
function seedWorldPinOntoGround(ground, pin, opts) {
    if (!ground || !ground.inventory || !pin || !pin.catalogId) return null;
    const o = opts || {};
    const itemDb = o.itemDb || null;
    const tileMap = o.tileMap || ground.tileMap || null;
    const uid = createItemInstance(ground.inventory, pin.catalogId, itemDb, {
        count: 1
    });
    if (!uid) return null;
    const inst = getItem(ground.inventory, uid);
    if (!inst) return null;
    const template = findItem(itemDb, pin.catalogId);
    stampWorldPinInstance(inst, pin, template);

    if (pin.kind === 'container') {
        const cap =
            pin.capacity != null && Number.isFinite(Number(pin.capacity))
                ? Math.floor(Number(pin.capacity))
                : template && itemIsContainer(template)
                  ? getContainer(ground.inventory, uid)
                      ? getContainer(ground.inventory, uid).capacity
                      : DEFAULT_CONTAINER_CAPACITY
                  : DEFAULT_CONTAINER_CAPACITY;
        forceContainer(ground.inventory, uid, cap);
        fillContainerFromWorldItems(
            ground.inventory,
            uid,
            pin.items || [],
            itemDb,
            0
        );
    }

    const x = Math.round(pin.x);
    const y = Math.round(pin.y);
    const z = pin.z !== undefined && pin.z !== null ? pin.z : 0;
    const key = tileKey(x, y, z);
    if (!ground.stacks[key]) ground.stacks[key] = [];
    ground.stacks[key].push(uid);
    inst.location = { kind: 'ground', x, y, z };

    if (pin.blocking && !(pin.kind === 'door' && inst.worldPinDoorOpen)) {
        applyWorldPinWalkBlock(tileMap, inst, x, y, z);
    }
    return uid;
}

/**
 * Seed hybrid `world` pins into the hunt ground store. Missing / empty → 0.
 * Skips pin ids already present (dest-floor concat / re-entry).
 *
 * @param {object} ground
 * @param {object[]|null|undefined} worldList
 * @param {{ itemDb?: object[]|Record<string, object>|null, tileMap?: object|null }} [opts]
 * @returns {number} pins spawned
 */
function seedWorldPinsOntoGround(ground, worldList, opts) {
    if (!ground || !ground.inventory) return 0;
    const pins = normalizeWorldList(worldList);
    if (!pins.length) return 0;
    const taken = existingWorldPinIds(ground);
    let n = 0;
    for (let i = 0; i < pins.length; i++) {
        const pin = pins[i];
        if (!pin) continue;
        if (taken[pin.id]) continue;
        const uid = seedWorldPinOntoGround(ground, pin, opts);
        if (uid) {
            taken[pin.id] = true;
            n += 1;
        }
    }
    return n;
}

/**
 * Ground uid of a seeded pin, or null.
 * @param {object|null|undefined} ground
 * @param {string} pinId
 * @returns {string|null}
 */
function groundUidForWorldPin(ground, pinId) {
    if (!ground || !ground.inventory || !pinId) return null;
    const want = String(pinId);
    const ids = Object.keys(ground.inventory.items);
    for (let i = 0; i < ids.length; i++) {
        const inst = ground.inventory.items[ids[i]];
        if (inst && inst.worldPinId === want) return ids[i];
    }
    return null;
}

/**
 * Hunt tick: first seen arms `worldPinDecayAt = now + sec`. Due → transform
 * `to` or remove the instance (restore walk if this pin patched friction).
 * @param {object|null|undefined} ground
 * @param {number} nowSec
 * @param {{ tileMap?: object|null, itemDb?: object[]|Record<string, object>|null }} [opts]
 * @returns {number} pins transformed or removed
 */
function tickWorldPinDecay(ground, nowSec, opts) {
    if (!ground || !ground.inventory || !ground.inventory.items) return 0;
    const now = Number(nowSec);
    if (!Number.isFinite(now)) return 0;
    const o = opts || {};
    const tileMap = o.tileMap || ground.tileMap || null;
    const itemDb = o.itemDb || null;
    const ids = Object.keys(ground.inventory.items);
    let n = 0;
    for (let i = 0; i < ids.length; i++) {
        const uid = ids[i];
        const inst = ground.inventory.items[uid];
        if (!inst || inst.worldPinDecaySec == null) continue;
        const sec = Number(inst.worldPinDecaySec);
        if (!Number.isFinite(sec) || sec <= 0) continue;
        if (inst.worldPinDecayAt == null) inst.worldPinDecayAt = now + sec;
        if (now < inst.worldPinDecayAt) continue;
        const loc = inst.location && typeof inst.location === 'object' ? inst.location : {};
        const x = loc.x;
        const y = loc.y;
        const z = loc.z != null ? loc.z : 0;
        const to = inst.worldPinDecayTo != null ? String(inst.worldPinDecayTo).trim() : '';
        delete inst.worldPinDecaySec;
        delete inst.worldPinDecayTo;
        delete inst.worldPinDecayAt;
        if (to) {
            applyChestTransform(inst, to, itemDb);
            n += 1;
            continue;
        }
        restoreWorldPinWalkBlock(tileMap, inst, x, y, z);
        const key = tileKey(x, y, z);
        const stack = ground.stacks[key];
        if (Array.isArray(stack)) {
            const idx = stack.indexOf(uid);
            if (idx >= 0) stack.splice(idx, 1);
            if (!stack.length) delete ground.stacks[key];
        }
        destroyItem(ground.inventory, uid);
        n += 1;
    }
    return n;
}

/**
 * Top world-pin instance on a tile, or null.
 * @param {object|null|undefined} ground
 * @param {number} x
 * @param {number} y
 * @param {string|number} z
 * @returns {object|null}
 */
function worldPinInstAtTile(ground, x, y, z) {
    if (!ground || !ground.inventory) return null;
    const stack = getStack(ground, x, y, z);
    for (let i = stack.length - 1; i >= 0; i--) {
        const inst = getItem(ground.inventory, stack[i]);
        if (inst && inst.worldPinKind) return inst;
    }
    return null;
}

module.exports = {
    seedWorldPinsOntoGround,
    seedWorldPinOntoGround,
    applyWorldPinWalkBlock,
    restoreWorldPinWalkBlock,
    groundUidForWorldPin,
    worldPinInstAtTile,
    tickWorldPinDecay
};
