/**
 * Ground item stacks — drop from inventory to floor, pick up into backpack.
 *
 * World store is independent of any player inventory. Nested bags keep their
 * contents via a transfer of the full item tree. Stacks are bottom→top
 * (last index = top of pile). Watch mode renders at most MAX_GROUND_RENDER
 * items from the top of each stack.
 *
 * Drop rules: target walkable, Chebyshev ≤ engage range, path exists.
 * Pickup rules: item on player tile or adjacent (Chebyshev ≤ 1), same floor.
 */

'use strict';

const { Utils } = require('../utils.js');
const { findPath } = require('../pathfinder.js');
const {
    resolveEngageRange,
    engageQueryRadius,
    isWithinEngageRange,
    DEFAULT_ENGAGE_AXIS
} = require('../ai/engage_range.js');
const { findItem } = require('./stats.js');
const {
    createEmptyInventory,
    destroyItem,
    getItem,
    getContainer,
    firstFreeSlot,
    findFirstFreeSlotBfs,
    placeInContainer,
    placeInEquipment,
    syncRootToEquippedBackpack,
    itemIsBackpackEquip,
    itemIsStackable,
    createItemInstance,
    setStackCount,
    getStackCount,
    itemSubtreeWeight,
    totalCarriedWeight,
    canCarryAdditional,
    isInsideSubtree,
    ensureItemContainer
} = require('./inventory.js');

/** Max items drawn per tile stack (top of pile). */
const MAX_GROUND_RENDER = 10;

/** Default engage axis when strategy / settings omit it (square). */
const DEFAULT_ENGAGE_RANGE = DEFAULT_ENGAGE_AXIS;

/**
 * @typedef {object} GroundStore
 * @property {import('./inventory.js').Inventory} inventory
 * @property {Record<string, string[]>} stacks tileKey → uid[] bottom→top
 */

/**
 * @param {number} x
 * @param {number} y
 * @param {string|number} z
 * @returns {string}
 */
function tileKey(x, y, z) {
    return `${String(z)}:${Math.round(x)}:${Math.round(y)}`;
}

/**
 * @returns {GroundStore}
 */
function createGroundStore() {
    const inv = createEmptyInventory({ rootSlots: 0 });
    // Synthetic root unused for ground placement; keep capacity 0.
    if (inv.containers[inv.rootUid]) {
        inv.containers[inv.rootUid].capacity = 0;
        inv.containers[inv.rootUid].slots = [];
    }
    return {
        inventory: inv,
        stacks: Object.create(null)
    };
}

/**
 * Engage query radius for drop distance (max of X/Y box axes).
 * @param {object|null|undefined} player
 * @returns {number}
 */
function engageRangeOf(player) {
    return Math.max(1, engageQueryRadius(resolveEngageRange(player)));
}

/**
 * Engage box for drop distance (strategy → Settings → 7×7).
 * @param {object|null|undefined} player
 * @returns {{ x: number, y: number }}
 */
function engageRangeXYOf(player) {
    return resolveEngageRange(player);
}

/**
 * @param {object|null|undefined} player
 * @returns {{ x: number, y: number, z: string|number }|null}
 */
function playerTileOf(player) {
    if (!player || !player.tile) return null;
    return {
        x: Math.round(player.tile.x),
        y: Math.round(player.tile.y),
        z: player.tile.z !== undefined && player.tile.z !== null ? player.tile.z : 0
    };
}

/**
 * @param {GroundStore|null|undefined} store
 * @param {number} x
 * @param {number} y
 * @param {string|number} z
 * @returns {string[]}
 */
function getStack(store, x, y, z) {
    if (!store || !store.stacks) return [];
    const stack = store.stacks[tileKey(x, y, z)];
    return Array.isArray(stack) ? stack : [];
}

/**
 * Top-of-stack uid, or null.
 * @param {GroundStore|null|undefined} store
 * @param {number} x
 * @param {number} y
 * @param {string|number} z
 * @returns {string|null}
 */
function peekTop(store, x, y, z) {
    const stack = getStack(store, x, y, z);
    if (!stack.length) return null;
    return stack[stack.length - 1] || null;
}

/**
 * Uids to render (at most MAX_GROUND_RENDER from the top), bottom→top order.
 * @param {GroundStore|null|undefined} store
 * @param {number} x
 * @param {number} y
 * @param {string|number} z
 * @param {number} [maxRender]
 * @returns {string[]}
 */
function getRenderableStack(store, x, y, z, maxRender) {
    const stack = getStack(store, x, y, z);
    const max =
        maxRender != null && Number.isFinite(Number(maxRender))
            ? Math.max(0, Math.floor(Number(maxRender)))
            : MAX_GROUND_RENDER;
    if (stack.length <= max) return stack.slice();
    return stack.slice(stack.length - max);
}

/**
 * Deep-copy an item tree into dstInv (fresh uids). Does not remove from src.
 * Nested container slot wiring is preserved.
 *
 * @param {import('./inventory.js').Inventory} srcInv
 * @param {import('./inventory.js').Inventory} dstInv
 * @param {string} rootUid
 * @returns {string|null} new root uid in dst
 */
function cloneItemTree(srcInv, dstInv, rootUid) {
    if (!srcInv || !dstInv || !rootUid) return null;
    const root = srcInv.items[rootUid];
    if (!root) return null;

    /** @type {Record<string, string>} oldUid → newUid */
    const map = Object.create(null);

    /**
     * @param {string} uid
     */
    function walkCreate(uid) {
        const inst = srcInv.items[uid];
        if (!inst) return;
        const newUid = 'i' + dstInv.nextUid;
        dstInv.nextUid += 1;
        map[uid] = newUid;
        /** @type {import('./inventory.js').InventoryItem} */
        const copy = {
            uid: newUid,
            itemId: inst.itemId,
            location: null
        };
        if (inst.count != null && Number(inst.count) > 1) {
            copy.count = Math.floor(Number(inst.count));
        }
        dstInv.items[newUid] = copy;
        const cont = srcInv.containers[uid];
        if (cont) {
            /** @type {(string|null)[]} */
            const slots = [];
            for (let i = 0; i < cont.capacity; i++) slots.push(null);
            dstInv.containers[newUid] = {
                capacity: cont.capacity,
                slots,
                isRoot: false
            };
            for (let i = 0; i < cont.slots.length; i++) {
                const child = cont.slots[i];
                if (child) walkCreate(child);
            }
        }
    }

    walkCreate(rootUid);

    /**
     * @param {string} oldUid
     */
    function walkWire(oldUid) {
        const newUid = map[oldUid];
        const srcCont = srcInv.containers[oldUid];
        if (!srcCont || !newUid) return;
        const dstCont = dstInv.containers[newUid];
        for (let i = 0; i < srcCont.slots.length; i++) {
            const childOld = srcCont.slots[i];
            if (!childOld) continue;
            const childNew = map[childOld];
            if (!childNew) continue;
            dstCont.slots[i] = childNew;
            dstInv.items[childNew].location = {
                kind: 'container',
                containerUid: newUid,
                index: i
            };
            walkWire(childOld);
        }
    }

    walkWire(rootUid);
    return map[rootUid] || null;
}

/**
 * Clone tree into dst then destroy source tree.
 * @param {import('./inventory.js').Inventory} srcInv
 * @param {import('./inventory.js').Inventory} dstInv
 * @param {string} rootUid
 * @returns {string|null}
 */
function transferItemTree(srcInv, dstInv, rootUid) {
    const newUid = cloneItemTree(srcInv, dstInv, rootUid);
    if (!newUid) return null;
    destroyItem(srcInv, rootUid);
    return newUid;
}

/**
 * Whether drop target is legal (walkable, range, path). Pure check.
 *
 * @param {object} player
 * @param {object} tileMap
 * @param {number} x
 * @param {number} y
 * @param {string|number} [z]
 * @returns {{ ok: boolean, error?: string }}
 */
function canDropToTile(player, tileMap, x, y, z) {
    const pt = playerTileOf(player);
    if (!pt) return { ok: false, error: 'no_player_tile' };
    if (!tileMap) return { ok: false, error: 'no_map' };

    const tx = Math.round(x);
    const ty = Math.round(y);
    const tz = z !== undefined && z !== null ? z : pt.z;

    if (String(tz) !== String(pt.z)) {
        return { ok: false, error: 'wrong_floor' };
    }
    if (typeof tileMap.inBounds === 'function' && !tileMap.inBounds(tx, ty, tz)) {
        return { ok: false, error: 'out_of_bounds' };
    }
    if (!tileMap.isWalkable(tx, ty, tz)) {
        return { ok: false, error: 'not_walkable' };
    }

    const box = engageRangeXYOf(player);
    const range = engageQueryRadius(box);
    const dist = Utils.distanceMax(pt.x, pt.y, tx, ty);
    if (!isWithinEngageRange(pt, { x: tx, y: ty, z: tz }, box)) {
        return { ok: false, error: 'out_of_range' };
    }

    // Same tile or path exists (ignore occupancy so drops work under creatures)
    if (dist === 0) return { ok: true };
    const path = findPath(
        tileMap,
        { x: pt.x, y: pt.y, z: pt.z },
        { x: tx, y: ty, z: tz },
        {
            checkOccupied: false,
            maxDistance: Math.max(range, dist) + 1,
            maxIterations: 512
        }
    );
    if (!path || !path.length) {
        return { ok: false, error: 'no_path' };
    }
    return { ok: true };
}

/**
 * Whether player may pick up from tile (Chebyshev ≤ 1, same floor).
 *
 * @param {object} player
 * @param {number} x
 * @param {number} y
 * @param {string|number} [z]
 * @returns {{ ok: boolean, error?: string }}
 */
function canPickupFromTile(player, x, y, z) {
    const pt = playerTileOf(player);
    if (!pt) return { ok: false, error: 'no_player_tile' };
    const tx = Math.round(x);
    const ty = Math.round(y);
    const tz = z !== undefined && z !== null ? z : pt.z;
    if (String(tz) !== String(pt.z)) {
        return { ok: false, error: 'wrong_floor' };
    }
    const dist = Utils.distanceMax(pt.x, pt.y, tx, ty);
    if (dist > 1) {
        return { ok: false, error: 'out_of_range' };
    }
    return { ok: true };
}

/**
 * Walk parent containers to the tile-stack root of a ground-store item.
 * Works for stack tops (`location.kind === 'ground'`) and nested bag contents.
 *
 * @param {GroundStore|null|undefined} ground
 * @param {string} uid
 * @returns {{ x: number, y: number, z: string|number, rootUid: string }|null}
 */
function groundRootLocation(ground, uid) {
    if (!ground || !ground.inventory || !uid) return null;
    /** @type {Set<string>} */
    const seen = new Set();
    let cur = String(uid);
    while (cur && !seen.has(cur)) {
        seen.add(cur);
        const inst = ground.inventory.items[cur];
        if (!inst || !inst.location) return null;
        if (inst.location.kind === 'ground') {
            return {
                x: Math.round(Number(inst.location.x) || 0),
                y: Math.round(Number(inst.location.y) || 0),
                z:
                    inst.location.z !== undefined && inst.location.z !== null
                        ? inst.location.z
                        : 0,
                rootUid: cur
            };
        }
        if (inst.location.kind === 'container') {
            cur = String(inst.location.containerUid || '');
            continue;
        }
        return null;
    }
    return null;
}

/**
 * Whether uid lives in the ground store (stack or nested under a ground bag).
 * @param {GroundStore|null|undefined} ground
 * @param {string} uid
 * @returns {boolean}
 */
function isGroundStoreItem(ground, uid) {
    return !!(ground && ground.inventory && uid && ground.inventory.items[uid]);
}

/**
 * Remove uid from its ground tile stack if it is a stack top (not nested).
 * Nested container children are detached only via destroyItem / place.
 * @param {GroundStore} ground
 * @param {string} uid
 * @param {number} x
 * @param {number} y
 * @param {string|number} z
 */
function removeFromTileStack(ground, uid, x, y, z) {
    const key = tileKey(x, y, z);
    const stack = ground.stacks[key];
    if (!Array.isArray(stack)) return;
    const idx = stack.indexOf(uid);
    if (idx >= 0) stack.splice(idx, 1);
    if (stack.length === 0) delete ground.stacks[key];
}

/**
 * Place a ground-store item uid onto a tile stack (updates location).
 * Caller must already detach it from any parent container.
 * @param {GroundStore} ground
 * @param {string} uid
 * @param {number} x
 * @param {number} y
 * @param {string|number} z
 */
function pushToTileStack(ground, uid, x, y, z) {
    const key = tileKey(x, y, z);
    if (!ground.stacks[key]) ground.stacks[key] = [];
    ground.stacks[key].push(uid);
    ground.inventory.items[uid].location = {
        kind: 'ground',
        x: Math.round(x),
        y: Math.round(y),
        z: z !== undefined && z !== null ? z : 0
    };
}

/**
 * Detach nested item from its parent container slots (does not destroy).
 * @param {import('./inventory.js').Inventory} inv
 * @param {string} uid
 * @returns {boolean}
 */
/**
 * Restore walk when a blocking World pin leaves a tile (pickup / move).
 * Sight is never patched by Hunt seed; occupancy stays creature-only.
 * @param {GroundStore} ground
 * @param {object|null|undefined} inst
 * @param {number} x
 * @param {number} y
 * @param {string|number} z
 */
function restoreWorldPinWalkIfNeeded(ground, inst, x, y, z) {
    if (!inst || !inst.worldPinFrictionPatched) return;
    const tileMap = ground && ground.tileMap;
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
        layer.friction[idx] === 255 &&
        inst.savedFriction != null &&
        Number.isFinite(Number(inst.savedFriction))
    ) {
        layer.friction[idx] = Number(inst.savedFriction);
        if (typeof tileMap.invalidateRenderCache === 'function') {
            tileMap.invalidateRenderCache();
        }
    }
    inst.worldPinFrictionPatched = false;
}

/**
 * Re-apply walk-block after a blocking World pin lands on a new tile.
 * @param {GroundStore} ground
 * @param {object|null|undefined} inst
 * @param {number} x
 * @param {number} y
 * @param {string|number} z
 */
function applyWorldPinWalkIfNeeded(ground, inst, x, y, z) {
    if (!inst || !inst.worldPinBlocking) return;
    const tileMap = ground && ground.tileMap;
    if (!tileMap || typeof tileMap.getLayer !== 'function') return;
    const layer = tileMap.getLayer(z);
    if (!layer || !layer.friction) return;
    const ix = Math.round(x);
    const iy = Math.round(y);
    if (ix < 0 || iy < 0 || ix >= layer.cols || iy >= layer.rows) return;
    const idx =
        typeof tileMap.index === 'function'
            ? tileMap.index(ix, iy, layer.cols)
            : iy * layer.cols + ix;
    if (layer.friction[idx] === 255) return;
    inst.savedFriction = layer.friction[idx];
    layer.friction[idx] = 255;
    inst.worldPinFrictionPatched = true;
    if (typeof tileMap.invalidateRenderCache === 'function') {
        tileMap.invalidateRenderCache();
    }
}

function detachFromParentContainer(inv, uid) {
    const inst = getItem(inv, uid);
    if (!inst || !inst.location || inst.location.kind !== 'container') {
        return false;
    }
    const cont = inv.containers[inst.location.containerUid];
    if (cont && Array.isArray(cont.slots)) {
        const idx = Math.floor(Number(inst.location.index));
        if (cont.slots[idx] === uid) cont.slots[idx] = null;
        else {
            const found = cont.slots.indexOf(uid);
            if (found >= 0) cont.slots[found] = null;
        }
    }
    inst.location = null;
    return true;
}

/**
 * Drop an inventory item onto a ground tile stack (top).
 *
 * @param {object} opts
 * @param {import('./inventory.js').Inventory} opts.playerInv
 * @param {string} opts.uid item in player inventory
 * @param {GroundStore} opts.ground
 * @param {object} opts.player
 * @param {object} opts.tileMap
 * @param {number} opts.x
 * @param {number} opts.y
 * @param {string|number} [opts.z]
 * @param {number} [opts.count] partial stack drop (stackables only; default full)
 * @param {object[]|Record<string, object>|null} [opts.itemDb]
 * @returns {{ ok: boolean, error?: string, groundUid?: string }}
 */
function dropItemToGround(opts) {
    const o = opts || {};
    const playerInv = o.playerInv;
    const ground = o.ground;
    const uid = o.uid;
    if (!playerInv || !ground || !uid) {
        return { ok: false, error: 'bad_args' };
    }
    const inst = getItem(playerInv, uid);
    if (!inst) return { ok: false, error: 'unknown_item' };

    const check = canDropToTile(o.player, o.tileMap, o.x, o.y, o.z);
    if (!check.ok) return check;

    const pt = playerTileOf(o.player);
    const tx = Math.round(o.x);
    const ty = Math.round(o.y);
    const tz =
        o.z !== undefined && o.z !== null
            ? o.z
            : pt
              ? pt.z
              : 0;

    const total =
        inst.count != null && Number.isFinite(Number(inst.count))
            ? Math.max(1, Math.floor(Number(inst.count)))
            : 1;
    let dropCount = total;
    if (o.count != null && Number.isFinite(Number(o.count))) {
        dropCount = Math.max(1, Math.floor(Number(o.count)));
        if (dropCount > total) dropCount = total;
    }
    const partial = dropCount < total;

    // Partial stackable drop: leave remainder in inventory, place only N units
    if (partial) {
        const template = findItem(o.itemDb, inst.itemId);
        if (itemIsStackable(template)) {
            const groundUid = createItemInstance(
                ground.inventory,
                inst.itemId,
                o.itemDb,
                { count: dropCount }
            );
            if (!groundUid) return { ok: false, error: 'transfer_failed' };
            setStackCount(inst, getStackCount(inst) - dropCount);
            const key = tileKey(tx, ty, tz);
            if (!ground.stacks[key]) ground.stacks[key] = [];
            ground.stacks[key].push(groundUid);
            ground.inventory.items[groundUid].location = {
                kind: 'ground',
                x: tx,
                y: ty,
                z: tz
            };
            syncRootToEquippedBackpack(playerInv);
            return { ok: true, groundUid };
        }
        // Non-stackable always full-drop below
    }

    // Clone first so a failed copy never orphans the player instance
    const groundUid = cloneItemTree(playerInv, ground.inventory, uid);
    if (!groundUid) {
        return { ok: false, error: 'transfer_failed' };
    }
    // destroyItem detaches equipment/container refs and removes nested tree
    destroyItem(playerInv, uid);

    const key = tileKey(tx, ty, tz);
    if (!ground.stacks[key]) ground.stacks[key] = [];
    ground.stacks[key].push(groundUid);
    ground.inventory.items[groundUid].location = {
        kind: 'ground',
        x: tx,
        y: ty,
        z: tz
    };

    // Equipped backpack may have been dropped — re-point main panel root
    syncRootToEquippedBackpack(playerInv);

    return { ok: true, groundUid };
}

/**
 * Pick a ground item into the player inventory.
 *
 * Default (auto) path:
 *   1. Cap check on full item tree weight
 *   2. If backpack equip empty and template `slot === 'backpack'` → equip
 *   3. Else BFS first free slot from equipped root (nested containers)
 *   4. No room → `not_enough_room`
 *
 * Explicit targets:
 *   - `equipmentSlot: 'backpack'` — equip if empty; if occupied, fall through to auto nest
 *   - `containerUid` + optional `index` — place in that slot only (still Cap-checked)
 *
 * Supports **tile stack tops** and **nested items inside open ground bags**
 * (range uses the bag's tile root, Chebyshev ≤ 1).
 *
 * Non-backpack gear and quivers never auto-equip on pickup (nest only).
 *
 * @param {object} opts
 * @param {GroundStore} opts.ground
 * @param {string} opts.uid ground item uid (stack top or nested in ground bag)
 * @param {import('./inventory.js').Inventory} opts.playerInv
 * @param {object} opts.player
 * @param {object[]|Record<string, object>|null} [opts.itemDb]
 * @param {string} [opts.containerUid] explicit player container (disables auto equip)
 * @param {number|null} [opts.index] explicit index when containerUid set
 * @param {string} [opts.equipmentSlot] e.g. 'backpack' (equip if empty, else nest)
 * @returns {{ ok: boolean, error?: string, playerUid?: string, equipped?: boolean }}
 */
function pickupItemFromGround(opts) {
    const o = opts || {};
    const ground = o.ground;
    const playerInv = o.playerInv;
    const uid = o.uid;
    const itemDb = o.itemDb || null;
    if (!ground || !playerInv || !uid) {
        return { ok: false, error: 'bad_args' };
    }
    const gInst = getItem(ground.inventory, uid);
    if (!gInst) return { ok: false, error: 'unknown_item' };
    if (!gInst.location) {
        return { ok: false, error: 'not_on_ground' };
    }
    if (gInst.isField || gInst.immovable || gInst.immovableField) {
        return { ok: false, error: 'immovable_item' };
    }

    const onTileStack = gInst.location.kind === 'ground';
    const nestedInBag = gInst.location.kind === 'container';
    if (!onTileStack && !nestedInBag) {
        return { ok: false, error: 'not_on_ground' };
    }

    let x;
    let y;
    let z;
    if (onTileStack) {
        x = gInst.location.x;
        y = gInst.location.y;
        z = gInst.location.z;
    } else {
        const root = groundRootLocation(ground, uid);
        if (!root) return { ok: false, error: 'not_on_ground' };
        // Cannot pick the bag into itself path — root bag tile anchors range
        x = root.x;
        y = root.y;
        z = root.z;
    }

    const rangeCheck = canPickupFromTile(o.player, x, y, z);
    if (!rangeCheck.ok) return rangeCheck;

    const template = findItem(itemDb, gInst.itemId);
    if (template && (template.isField || template.immovable || template.immovableField)) {
        return { ok: false, error: 'immovable_item' };
    }

    const treeW = itemSubtreeWeight(ground.inventory, uid, itemDb);
    const player = o.player;
    if (player) {
        const level = player.level != null ? player.level : 1;
        const classId = player.classId != null ? player.classId : null;
        const current = totalCarriedWeight(playerInv, itemDb);
        if (!canCarryAdditional(level, current, treeW, classId)) {
            return { ok: false, error: 'not_enough_cap' };
        }
    }
    const explicitContainer =
        o.containerUid != null && String(o.containerUid) !== '';
    const wantEquipSlot =
        o.equipmentSlot != null && String(o.equipmentSlot).trim() !== ''
            ? String(o.equipmentSlot).trim()
            : null;

    /**
     * @param {string} playerUid
     * @param {boolean} [equipped]
     * @returns {{ ok: boolean, error?: string, playerUid?: string, equipped?: boolean }}
     */
    function commitSuccess(playerUid, equipped) {
        if (onTileStack) {
            restoreWorldPinWalkIfNeeded(ground, gInst, x, y, z);
            removeFromTileStack(ground, uid, x, y, z);
        }
        destroyItem(ground.inventory, uid);
        syncRootToEquippedBackpack(playerInv);
        /** @type {{ ok: boolean, playerUid: string, equipped?: boolean }} */
        const out = { ok: true, playerUid };
        if (equipped) out.equipped = true;
        return out;
    }

    /**
     * Try equip into empty backpack slot.
     * @param {string} playerUid
     * @returns {{ ok: boolean, error?: string }|null} null = skip (not applicable)
     */
    function tryEquipBackpack(playerUid) {
        if (!itemIsBackpackEquip(template)) return null;
        if (playerInv.equipment && playerInv.equipment.backpack) return null;
        const r = placeInEquipment(playerInv, playerUid, 'backpack', itemDb);
        if (!r.ok) return r;
        return { ok: true };
    }

    /**
     * Nest via BFS from root (or fail not_enough_room).
     * @param {string} playerUid
     * @returns {{ ok: boolean, error?: string }}
     */
    function tryNestBfs(playerUid) {
        syncRootToEquippedBackpack(playerInv);
        // Prefer stack merge / first free per container (BFS), not a free slot that
        // skips an existing same-item stack in an earlier bag.
        /** @type {string[]} */
        const queue = [playerInv.rootUid];
        /** @type {Set<string>} */
        const seen = new Set();
        while (queue.length) {
            const cuid = queue.shift();
            if (!cuid || seen.has(cuid)) continue;
            seen.add(cuid);
            const placed = placeInContainer(
                playerInv,
                playerUid,
                cuid,
                null,
                itemDb
            );
            if (placed.ok) {
                return { ok: true, playerUid: placed.uid || playerUid };
            }
            const cont = getContainer(playerInv, cuid);
            if (!cont) continue;
            for (let i = 0; i < cont.slots.length; i++) {
                const child = cont.slots[i];
                if (child && playerInv.containers[child]) queue.push(child);
            }
        }
        return { ok: false, error: 'not_enough_room' };
    }

    // Clone into player inv first; only then remove from ground
    const playerUid = cloneItemTree(ground.inventory, playerInv, uid);
    if (!playerUid) {
        return { ok: false, error: 'transfer_failed' };
    }

    // ── Explicit container slot (drag onto bag cell) ─────────────────────────
    if (explicitContainer) {
        const containerUid = String(o.containerUid);
        const cont = getContainer(playerInv, containerUid);
        if (!cont) {
            destroyItem(playerInv, playerUid);
            return { ok: false, error: 'unknown_container' };
        }
        let index =
            o.index != null && Number.isFinite(Number(o.index))
                ? Math.floor(Number(o.index))
                : firstFreeSlot(cont);
        if (index < 0 || index >= cont.capacity) {
            destroyItem(playerInv, playerUid);
            return { ok: false, error: 'not_enough_room' };
        }
        if (cont.slots[index] != null) {
            destroyItem(playerInv, playerUid);
            return { ok: false, error: 'occupied' };
        }
        const placed = placeInContainer(
            playerInv,
            playerUid,
            containerUid,
            index,
            itemDb
        );
        if (!placed.ok) {
            destroyItem(playerInv, playerUid);
            return { ok: false, error: placed.error || 'place_failed' };
        }
        return commitSuccess(placed.uid || playerUid, false);
    }

    // ── Explicit equipment target (drag onto backpack equip slot) ────────────
    if (wantEquipSlot === 'backpack') {
        if (
            itemIsBackpackEquip(template) &&
            !(playerInv.equipment && playerInv.equipment.backpack)
        ) {
            const er = placeInEquipment(
                playerInv,
                playerUid,
                'backpack',
                itemDb
            );
            if (er.ok) return commitSuccess(playerUid, true);
            // fall through to nest on unexpected equip failure
        }
        // Slot occupied or not a backpack-slot item → nest like auto pickup
        const nest = tryNestBfs(playerUid);
        if (!nest.ok) {
            destroyItem(playerInv, playerUid);
            return nest;
        }
        return commitSuccess(nest.playerUid || playerUid, false);
    }

    // ── Auto path: equip empty backpack if eligible, else BFS nest ───────────
    const eq = tryEquipBackpack(playerUid);
    if (eq && eq.ok) {
        return commitSuccess(playerUid, true);
    }
    // tryEquipBackpack returned null (not eligible) or failed → nest
    if (eq && !eq.ok && eq.error && eq.error !== 'occupied') {
        // wrong_slot etc. — still try nest
    }
    const nest = tryNestBfs(playerUid);
    if (!nest.ok) {
        destroyItem(playerInv, playerUid);
        return nest;
    }
    return commitSuccess(nest.playerUid || playerUid, false);
}

/**
 * Move a player inventory item into a container that lives on the ground
 * (open bag / future corpse). Range: Chebyshev ≤ 1 to the bag's tile root.
 *
 * @param {object} opts
 * @param {import('./inventory.js').Inventory} opts.playerInv
 * @param {string} opts.uid item in player inventory
 * @param {GroundStore} opts.ground
 * @param {string} opts.containerUid ground-store container
 * @param {number|null} [opts.index] slot index (null = first free / stack merge)
 * @param {object} opts.player
 * @param {object[]|Record<string, object>|null} [opts.itemDb]
 * @returns {{ ok: boolean, error?: string, groundUid?: string }}
 */
function placePlayerItemIntoGroundContainer(opts) {
    const o = opts || {};
    const playerInv = o.playerInv;
    const ground = o.ground;
    const uid = o.uid;
    const containerUid = o.containerUid;
    const itemDb = o.itemDb || null;
    if (!playerInv || !ground || !uid || !containerUid) {
        return { ok: false, error: 'bad_args' };
    }
    const pInst = getItem(playerInv, uid);
    if (!pInst) return { ok: false, error: 'unknown_item' };

    const root = groundRootLocation(ground, containerUid);
    if (!root) return { ok: false, error: 'not_on_ground' };
    // Container must exist (repair missing slots like equip open)
    let cont =
        getContainer(ground.inventory, containerUid) ||
        ensureItemContainer(ground.inventory, containerUid, itemDb);
    if (!cont) return { ok: false, error: 'unknown_container' };

    const rangeCheck = canPickupFromTile(o.player, root.x, root.y, root.z);
    if (!rangeCheck.ok) return rangeCheck;

    // Cannot nest a bag into a container that is currently inside that bag
    // after transfer — cycle check on ground tree using post-clone uid is hard;
    // pre-check: if player item is a container, reject placing into ground
    // container that already contains… no cross-store cycle. Only reject if
    // containerUid somehow equals uid (impossible across stores).
    if (String(uid) === String(containerUid)) {
        return { ok: false, error: 'cycle' };
    }

    const groundUid = cloneItemTree(playerInv, ground.inventory, uid);
    if (!groundUid) return { ok: false, error: 'transfer_failed' };

    // Cycle guard if ground bag is somehow nested under transferred tree (N/A)
    // and placeInto own child after transfer:
    if (isInsideSubtree(ground.inventory, containerUid, groundUid)) {
        destroyItem(ground.inventory, groundUid);
        return { ok: false, error: 'cycle' };
    }

    let index =
        o.index != null && Number.isFinite(Number(o.index))
            ? Math.floor(Number(o.index))
            : null;
    const placed = placeInContainer(
        ground.inventory,
        groundUid,
        containerUid,
        index,
        itemDb
    );
    if (!placed.ok) {
        destroyItem(ground.inventory, groundUid);
        return { ok: false, error: placed.error || 'place_failed' };
    }
    destroyItem(playerInv, uid);
    syncRootToEquippedBackpack(playerInv);
    return { ok: true, groundUid: placed.uid || groundUid };
}

/**
 * Move a ground-store item into another ground-store container (same inv).
 * Source may be a tile stack top or nested in another bag.
 * Range: both source root and dest bag root must be Chebyshev ≤ 1.
 *
 * @param {object} opts
 * @param {GroundStore} opts.ground
 * @param {string} opts.uid
 * @param {string} opts.containerUid
 * @param {number|null} [opts.index]
 * @param {object} opts.player
 * @param {object[]|Record<string, object>|null} [opts.itemDb]
 * @returns {{ ok: boolean, error?: string }}
 */
function moveGroundItemIntoContainer(opts) {
    const o = opts || {};
    const ground = o.ground;
    const uid = o.uid;
    const containerUid = o.containerUid;
    const itemDb = o.itemDb || null;
    if (!ground || !uid || !containerUid) {
        return { ok: false, error: 'bad_args' };
    }
    if (String(uid) === String(containerUid)) {
        return { ok: false, error: 'cycle' };
    }
    const gInst = getItem(ground.inventory, uid);
    if (!gInst || !gInst.location) return { ok: false, error: 'unknown_item' };

    const srcRoot = groundRootLocation(ground, uid);
    if (!srcRoot) return { ok: false, error: 'not_on_ground' };
    const dstRoot = groundRootLocation(ground, containerUid);
    if (!dstRoot) return { ok: false, error: 'not_on_ground' };

    const r1 = canPickupFromTile(o.player, srcRoot.x, srcRoot.y, srcRoot.z);
    if (!r1.ok) return r1;
    const r2 = canPickupFromTile(o.player, dstRoot.x, dstRoot.y, dstRoot.z);
    if (!r2.ok) return r2;

    let cont =
        getContainer(ground.inventory, containerUid) ||
        ensureItemContainer(ground.inventory, containerUid, itemDb);
    if (!cont) return { ok: false, error: 'unknown_container' };

    if (isInsideSubtree(ground.inventory, containerUid, uid)) {
        return { ok: false, error: 'cycle' };
    }

    // Already in this container at same index → no-op success
    if (
        gInst.location.kind === 'container' &&
        gInst.location.containerUid === containerUid &&
        o.index != null &&
        Math.floor(Number(o.index)) === Math.floor(Number(gInst.location.index))
    ) {
        return { ok: true };
    }

    const onTile = gInst.location.kind === 'ground';
    if (onTile) {
        restoreWorldPinWalkIfNeeded(
            ground,
            gInst,
            gInst.location.x,
            gInst.location.y,
            gInst.location.z
        );
        removeFromTileStack(
            ground,
            uid,
            gInst.location.x,
            gInst.location.y,
            gInst.location.z
        );
        gInst.location = null;
    } else if (gInst.location.kind === 'container') {
        detachFromParentContainer(ground.inventory, uid);
    } else {
        return { ok: false, error: 'not_on_ground' };
    }

    const index =
        o.index != null && Number.isFinite(Number(o.index))
            ? Math.floor(Number(o.index))
            : null;
    const placed = placeInContainer(
        ground.inventory,
        uid,
        containerUid,
        index,
        itemDb
    );
    if (!placed.ok) {
        // Best-effort restore to source tile root
        pushToTileStack(ground, uid, srcRoot.x, srcRoot.y, srcRoot.z);
        return { ok: false, error: placed.error || 'place_failed' };
    }
    return { ok: true };
}

/**
 * Move a ground-store item onto a walkable tile stack (from another tile or
 * from inside a ground bag). Range uses drop rules (engage + path).
 * Optional `count` splits stackables (remainder stays at source).
 *
 * @param {object} opts
 * @param {GroundStore} opts.ground
 * @param {string} opts.uid
 * @param {object} opts.player
 * @param {object} opts.tileMap
 * @param {number} opts.x
 * @param {number} opts.y
 * @param {string|number} [opts.z]
 * @param {number} [opts.count] partial stack amount (stackables only)
 * @param {object[]|Record<string, object>|null} [opts.itemDb] required for partial split
 * @returns {{ ok: boolean, error?: string, movedUid?: string }}
 */
function moveGroundItemToTile(opts) {
    const o = opts || {};
    const ground = o.ground;
    const uid = o.uid;
    if (!ground || !uid) return { ok: false, error: 'bad_args' };
    const gInst = getItem(ground.inventory, uid);
    if (!gInst || !gInst.location) return { ok: false, error: 'unknown_item' };
    if (gInst.isField || gInst.immovable || gInst.immovableField) {
        return { ok: false, error: 'immovable_item' };
    }

    const check = canDropToTile(o.player, o.tileMap, o.x, o.y, o.z);
    if (!check.ok) return check;

    const pt = playerTileOf(o.player);
    const tx = Math.round(o.x);
    const ty = Math.round(o.y);
    const tz =
        o.z !== undefined && o.z !== null
            ? o.z
            : pt
              ? pt.z
              : 0;

    const total = getStackCount(gInst);
    let moveCount = total;
    if (o.count != null && Number.isFinite(Number(o.count))) {
        moveCount = Math.max(1, Math.floor(Number(o.count)));
        if (moveCount > total) moveCount = total;
    }
    const partial = moveCount < total;
    const template = partial ? findItem(o.itemDb, gInst.itemId) : null;
    if (partial && !itemIsStackable(template)) {
        moveCount = total;
    }
    const doPartial = moveCount < total && itemIsStackable(template);

    if (gInst.location.kind === 'ground') {
        const ox = Math.round(gInst.location.x);
        const oy = Math.round(gInst.location.y);
        const oz =
            gInst.location.z !== undefined && gInst.location.z !== null
                ? gInst.location.z
                : 0;
        if (ox === tx && oy === ty && String(oz) === String(tz)) {
            return { ok: true, movedUid: uid }; // already there
        }
        if (doPartial) {
            const newUid = createItemInstance(
                ground.inventory,
                gInst.itemId,
                o.itemDb,
                { count: moveCount }
            );
            if (!newUid) return { ok: false, error: 'transfer_failed' };
            setStackCount(gInst, total - moveCount);
            pushToTileStack(ground, newUid, tx, ty, tz);
            applyWorldPinWalkIfNeeded(
                ground,
                getItem(ground.inventory, newUid),
                tx,
                ty,
                tz
            );
            return { ok: true, movedUid: newUid };
        }
        restoreWorldPinWalkIfNeeded(ground, gInst, ox, oy, oz);
        removeFromTileStack(ground, uid, ox, oy, oz);
        pushToTileStack(ground, uid, tx, ty, tz);
        applyWorldPinWalkIfNeeded(ground, gInst, tx, ty, tz);
        return { ok: true, movedUid: uid };
    }

    if (gInst.location.kind === 'container') {
        // Source bag must still be in pickup range (acting on open container)
        const root = groundRootLocation(ground, uid);
        if (!root) return { ok: false, error: 'not_on_ground' };
        const rangeCheck = canPickupFromTile(o.player, root.x, root.y, root.z);
        if (!rangeCheck.ok) return rangeCheck;
        if (doPartial) {
            const newUid = createItemInstance(
                ground.inventory,
                gInst.itemId,
                o.itemDb,
                { count: moveCount }
            );
            if (!newUid) return { ok: false, error: 'transfer_failed' };
            setStackCount(gInst, total - moveCount);
            pushToTileStack(ground, newUid, tx, ty, tz);
            return { ok: true, movedUid: newUid };
        }
        if (!detachFromParentContainer(ground.inventory, uid)) {
            return { ok: false, error: 'detach_failed' };
        }
        pushToTileStack(ground, uid, tx, ty, tz);
        return { ok: true, movedUid: uid };
    }

    return { ok: false, error: 'not_on_ground' };
}

/**
 * Whether a ground-store container uid is still openable (exists under a tile).
 * @param {GroundStore|null|undefined} ground
 * @param {string} containerUid
 * @returns {boolean}
 */
function isGroundContainerOpenable(ground, containerUid) {
    if (!ground || !containerUid) return false;
    if (!getItem(ground.inventory, containerUid)) return false;
    return !!groundRootLocation(ground, containerUid);
}

/**
 * List all non-empty ground tile keys (for render / debug).
 * @param {GroundStore|null|undefined} store
 * @returns {string[]}
 */
function listGroundTiles(store) {
    if (!store || !store.stacks) return [];
    return Object.keys(store.stacks).filter(
        (k) => Array.isArray(store.stacks[k]) && store.stacks[k].length > 0
    );
}

/**
 * Parse tileKey back to coords.
 * @param {string} key
 * @returns {{ x: number, y: number, z: string }|null}
 */
function parseTileKey(key) {
    if (!key || typeof key !== 'string') return null;
    const parts = key.split(':');
    if (parts.length < 3) return null;
    // z may contain ':' in theory — join remainder of z is unused; our z is simple
    const z = parts[0];
    const x = parseInt(parts[1], 10);
    const y = parseInt(parts[2], 10);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y, z };
}

module.exports = {
    MAX_GROUND_RENDER,
    DEFAULT_ENGAGE_RANGE,
    tileKey,
    parseTileKey,
    createGroundStore,
    engageRangeOf,
    engageRangeXYOf,
    playerTileOf,
    getStack,
    peekTop,
    getRenderableStack,
    listGroundTiles,
    cloneItemTree,
    transferItemTree,
    canDropToTile,
    canPickupFromTile,
    groundRootLocation,
    isGroundStoreItem,
    isGroundContainerOpenable,
    dropItemToGround,
    pickupItemFromGround,
    placePlayerItemIntoGroundContainer,
    moveGroundItemIntoContainer,
    moveGroundItemToTile
};
