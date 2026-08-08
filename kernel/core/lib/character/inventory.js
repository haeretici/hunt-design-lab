/**
 * Character inventory — backpack slots, nested containers, equip/unequip.
 *
 * Pure helpers (no DOM). The **equipped backpack** is the main open inventory
 * (slots from `item.volume`). Nested bags open as separate panels.
 * When no backpack is equipped, a synthetic `ROOT_UID` exists with **0 slots**
 * (panel empty). Only templates with `slot: "backpack"` equip into the character
 * backpack slot; other containers (bags nested, quivers) only nest on pickup.
 * Carried weight (equipped gear + backpack tree) reduces Cap.
 */

'use strict';

const {
    findItem,
    canonicalEquipmentSlot,
    EQUIPMENT_SLOTS,
    normalizeEquipmentMap,
    itemIsAmmo,
    itemIsShield,
    itemAmmoKind,
    weaponRequiredAmmoKind,
    itemIsTwoHanded,
    itemIsQuiver,
    itemIsBowOrCrossbowWeapon
} = require('./stats.js');

/** Default slot count for the character root backpack. */
const DEFAULT_ROOT_SLOTS = 20;

/** Max units per stackable instance (arrows/bolts/throwing weapons). */
const MAX_STACK_SIZE = 100;

/**
 * Stable uid for the synthetic fallback container (not an item instance).
 * Used only when no backpack is equipped; otherwise `inv.rootUid` points at
 * the equipped backpack item instance.
 */
const ROOT_UID = 'root';

/** Default template id for the starter backpack when profiles omit one. */
const DEFAULT_BACKPACK_ITEM_ID = 'backpack';

/** Designer slot keys used by the equipment card UI. */
const DESIGNER_EQUIP_SLOTS = Object.freeze([
    'head',
    'chest',
    'legs',
    'boots',
    'weapon',
    'shield',
    'amulet',
    'ring',
    'backpack'
]);

/** Engine combat/equip slot → designer card slot. */
const ENGINE_TO_DESIGNER = Object.freeze({
    helmet: 'head',
    armor: 'chest',
    rightHand: 'weapon',
    leftHand: 'shield',
    amulet: 'amulet',
    ring: 'ring',
    legs: 'legs',
    boots: 'boots',
    backpack: 'backpack'
});

/** Designer card slot → engine slot. */
const DESIGNER_TO_ENGINE = Object.freeze({
    head: 'helmet',
    chest: 'armor',
    weapon: 'rightHand',
    shield: 'leftHand',
    amulet: 'amulet',
    ring: 'ring',
    legs: 'legs',
    boots: 'boots',
    backpack: 'backpack'
});

/**
 * @typedef {{ kind: 'equipment', slot: string }} EquipLocation
 * @typedef {{ kind: 'container', containerUid: string, index: number }} ContainerLocation
 * @typedef {EquipLocation|ContainerLocation} ItemLocation
 *
 * @typedef {object} InventoryItem
 * @property {string} uid
 * @property {string} itemId
 * @property {ItemLocation|null} location
 * @property {number} [count] stack size (default 1); only >1 for stackable templates
 * @property {number} [remainingDurationSec] timed gear budget left (legacy stopduration)
 * @property {number} [remainingCharges] absorb gear charges left
 *
 * @typedef {object} InventoryContainer
 * @property {number} capacity
 * @property {(string|null)[]} slots
 * @property {boolean} [isRoot]
 *
 * @typedef {object} Inventory
 * @property {number} nextUid
 * @property {Record<string, InventoryItem>} items
 * @property {Record<string, InventoryContainer>} containers
 * @property {string} rootUid
 * @property {Record<string, string>} equipment engine slot → uid
 *
 * @typedef {object} SeedPlaceReport
 * @property {number} placed
 * @property {number} failed
 * @property {Array<{ itemId: string, error: string, count?: number }>} errors
 */

/**
 * @param {number} n
 * @returns {(null)[]}
 */
function emptySlots(n) {
    /** @type {(null)[]} */
    const slots = [];
    const cap = Math.max(0, Math.floor(n) || 0);
    for (let i = 0; i < cap; i++) slots.push(null);
    return slots;
}

/**
 * Whether a template is a nestable container (backpack/bag/chest/…).
 * Quivers count (volume + ammo storage).
 * @param {object|null|undefined} item
 * @returns {boolean}
 */
function itemIsContainer(item) {
    if (!item || typeof item !== 'object') return false;
    if (itemIsQuiver(item)) return true;
    const cat = item.category != null ? String(item.category).toLowerCase() : '';
    if (
        cat === 'container' ||
        cat === 'backpack' ||
        cat === 'bag' ||
        cat === 'quiver'
    ) {
        return true;
    }
    const slot = item.slot != null ? String(item.slot).toLowerCase() : '';
    if (slot === 'backpack' || slot === 'container' || slot === 'bag') {
        return true;
    }
    if (Array.isArray(item.type)) {
        for (let i = 0; i < item.type.length; i++) {
            const t = String(item.type[i]).toLowerCase();
            if (
                t === 'container' ||
                t === 'backpack' ||
                t === 'bag' ||
                t === 'quiver'
            ) {
                return true;
            }
        }
    }
    if (item.volume != null && Number.isFinite(Number(item.volume)) && Number(item.volume) > 0) {
        // Explicit volume on non-weapon items → treat as container
        if (!item.atk && !item.armor && cat !== 'ammo' && cat !== 'ammunition') {
            return true;
        }
    }
    return false;
}

/**
 * Slot capacity for a container template (item.volume, default 20).
 * @param {object|string|null|undefined} itemOrId
 * @param {object[]|Record<string, object>|null} [itemDb]
 * @returns {number}
 */
function containerCapacity(itemOrId, itemDb) {
    const item =
        typeof itemOrId === 'string' || typeof itemOrId === 'number'
            ? findItem(itemDb, itemOrId)
            : itemOrId;
    if (item && item.volume != null && Number.isFinite(Number(item.volume))) {
        return Math.max(1, Math.floor(Number(item.volume)));
    }
    return DEFAULT_ROOT_SLOTS;
}

/**
 * Create an empty inventory. Synthetic root defaults to **0 slots** (no backpack
 * equipped). Pass `rootSlots` only for tests / ground stores that need a grid.
 * @param {{ rootSlots?: number }} [opts]
 * @returns {Inventory}
 */
function createEmptyInventory(opts) {
    const o = opts || {};
    const capacity =
        o.rootSlots != null && Number.isFinite(Number(o.rootSlots))
            ? Math.max(0, Math.floor(Number(o.rootSlots)))
            : 0;
    /** @type {Inventory} */
    const inv = {
        nextUid: 1,
        items: Object.create(null),
        containers: Object.create(null),
        rootUid: ROOT_UID,
        equipment: Object.create(null)
    };
    inv.containers[ROOT_UID] = {
        capacity,
        slots: emptySlots(capacity),
        isRoot: true
    };
    return inv;
}

/**
 * @param {Inventory} inv
 * @returns {string}
 */
function allocUid(inv) {
    const uid = 'i' + inv.nextUid;
    inv.nextUid += 1;
    return uid;
}

/**
 * Whether a template may stack (same itemId shares one container slot with count).
 * Driven by equipment `stackable: true` (arrows/bolts/throwing weapons).
 * @param {object|null|undefined} item
 * @returns {boolean}
 */
function itemIsStackable(item) {
    if (!item || typeof item !== 'object') return false;
    return item.stackable === true;
}

/**
 * Hand-thrown distance weapons (category spear / type throwing).
 * These equip in rightHand, stack, and may break on throw via `breakChance`.
 * @param {object|null|undefined} item
 * @returns {boolean}
 */
function itemIsThrowingWeapon(item) {
    if (!item || typeof item !== 'object') return false;
    const cat = item.category != null ? String(item.category).toLowerCase() : '';
    if (cat === 'spear' || cat === 'throwing') return true;
    const types = item.type;
    if (Array.isArray(types)) {
        for (let i = 0; i < types.length; i++) {
            if (String(types[i]).toLowerCase() === 'throwing') return true;
        }
    } else if (types != null && String(types).toLowerCase() === 'throwing') {
        return true;
    }
    return false;
}

/**
 * Break chance percent (0–100) for a throwing weapon template.
 * Missing / invalid → null (no break rolls).
 * @param {object|null|undefined} item
 * @returns {number|null}
 */
function itemBreakChance(item) {
    if (!item || item.breakChance == null || item.breakChance === '') return null;
    const n = Number(item.breakChance);
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.min(100, n);
}

/**
 * Parse a seed equipment value into `{ itemId, count }`.
 * Stackable templates default to a full stack (`MAX_STACK_SIZE`) when count is omitted.
 * @param {*} raw
 * @param {object[]|Record<string, object>|null} [itemDb]
 * @returns {{ itemId: string, count: number }|null}
 */
function parseEquipmentSeedEntry(raw, itemDb) {
    if (raw == null || raw === '') return null;
    let itemId = null;
    let count = null;
    if (typeof raw === 'object') {
        itemId =
            raw.itemId != null
                ? String(raw.itemId)
                : raw.id != null
                  ? String(raw.id)
                  : null;
        if (raw.count != null && Number.isFinite(Number(raw.count))) {
            count = Math.max(1, Math.floor(Number(raw.count)));
        }
    } else {
        itemId = String(raw).trim() || null;
    }
    if (!itemId) return null;
    const template = findItem(itemDb, itemId);
    if (itemIsStackable(template)) {
        if (count == null) count = MAX_STACK_SIZE;
        count = Math.min(MAX_STACK_SIZE, Math.max(1, count));
    } else {
        count = 1;
    }
    return { itemId, count };
}

/**
 * Stack size for an instance. Missing/invalid `count` → 1; explicit 0 allowed
 * (empty stack about to be destroyed).
 * @param {InventoryItem|null|undefined} inst
 * @returns {number}
 */
function getStackCount(inst) {
    if (!inst) return 0;
    if (inst.count == null || inst.count === '') return 1;
    const n = Math.floor(Number(inst.count));
    if (!Number.isFinite(n)) return 1;
    return Math.max(0, n);
}

/**
 * Free units until `MAX_STACK_SIZE` on this instance.
 * @param {InventoryItem|null|undefined} inst
 * @returns {number}
 */
function stackRoom(inst) {
    return Math.max(0, MAX_STACK_SIZE - getStackCount(inst));
}

/**
 * @param {InventoryItem|null|undefined} inst
 * @param {number} count
 */
function setStackCount(inst, count) {
    if (!inst) return;
    const n = Math.floor(Number(count) || 0);
    if (n < 1) {
        inst.count = 0;
        return;
    }
    inst.count = Math.min(MAX_STACK_SIZE, n);
}

/**
 * Unit weight × stack count for one instance (no nested walk).
 * @param {InventoryItem|null|undefined} inst
 * @param {object|null|undefined} item template
 * @returns {number}
 */
function instanceWeight(inst, item) {
    if (!inst) return 0;
    const unit = item && item.weight != null ? Number(item.weight) || 0 : 0;
    return unit * getStackCount(inst);
}

/**
 * Create an item instance (and nested container slots when applicable).
 * Does not place the item anywhere.
 *
 * @param {Inventory} inv
 * @param {string} itemId
 * @param {object[]|Record<string, object>|null} [itemDb]
 * @param {{ count?: number }} [opts]
 * @returns {string} uid
 */
function createItemInstance(inv, itemId, itemDb, opts) {
    if (!inv || itemId == null || String(itemId).trim() === '') {
        throw new Error('createItemInstance: inv and itemId required');
    }
    const id = String(itemId).trim();
    const uid = allocUid(inv);
    const o = opts && typeof opts === 'object' ? opts : {};
    let count = 1;
    if (o.count != null && Number.isFinite(Number(o.count))) {
        count = Math.max(1, Math.floor(Number(o.count)));
    }
    const item = findItem(itemDb, id);
    // Non-stackable templates cannot carry multi-count on one instance
    if (count > 1 && !itemIsStackable(item)) {
        count = 1;
    }
    // One instance never exceeds max stack (seed paths split larger totals)
    if (itemIsStackable(item) && count > MAX_STACK_SIZE) {
        count = MAX_STACK_SIZE;
    }
    /** @type {InventoryItem} */
    const inst = { uid, itemId: id, location: null };
    if (count > 1) inst.count = count;
    // Seed remaining budgets so backpack/action-bar UI can show charges/duration
    // before the first equip (runtime still re-seeds on equip from template max).
    if (item && item.charges != null && Number.isFinite(Number(item.charges))) {
        const c = Math.floor(Number(item.charges));
        if (c > 0) inst.remainingCharges = c;
    }
    if (
        item &&
        item.durationSec != null &&
        Number.isFinite(Number(item.durationSec))
    ) {
        const d = Number(item.durationSec);
        if (d > 0) inst.remainingDurationSec = d;
    }
    inv.items[uid] = inst;
    if (itemIsContainer(item)) {
        const cap = containerCapacity(item, itemDb);
        inv.containers[uid] = {
            capacity: cap,
            slots: emptySlots(cap),
            isRoot: false
        };
    }
    return uid;
}

/**
 * Whether two instances can merge into one stack.
 * @param {Inventory} inv
 * @param {string} uidA
 * @param {string} uidB
 * @param {object[]|Record<string, object>|null} [itemDb]
 * @returns {boolean}
 */
function canMergeStacks(inv, uidA, uidB, itemDb) {
    if (!inv || !uidA || !uidB || uidA === uidB) return false;
    const a = inv.items[uidA];
    const b = inv.items[uidB];
    if (!a || !b) return false;
    if (a.itemId !== b.itemId) return false;
    // Containers never stack
    if (inv.containers[uidA] || inv.containers[uidB]) return false;
    const item = findItem(itemDb, a.itemId);
    if (!itemIsStackable(item)) return false;
    // Room on dest (or either order — caller merges source→dest)
    return stackRoom(b) > 0;
}

/**
 * Absorb as much of `sourceUid` into `destUid` as fits under MAX_STACK_SIZE.
 * Destroys source when fully absorbed; leaves remainder when capped.
 * @param {Inventory} inv
 * @param {string} sourceUid
 * @param {string} destUid
 * @returns {boolean} true if any units moved
 */
function mergeStacks(inv, sourceUid, destUid) {
    if (!inv || !sourceUid || !destUid || sourceUid === destUid) return false;
    const src = inv.items[sourceUid];
    const dst = inv.items[destUid];
    if (!src || !dst) return false;
    const room = stackRoom(dst);
    if (room <= 0) return false;
    const take = Math.min(getStackCount(src), room);
    if (take <= 0) return false;
    setStackCount(dst, getStackCount(dst) + take);
    const left = getStackCount(src) - take;
    if (left <= 0) {
        destroyItem(inv, sourceUid);
    } else {
        setStackCount(src, left);
    }
    return true;
}

/**
 * Find an existing stack of `itemId` with free room inside a container.
 * Prefers the stack with the most remaining room (fills fuller stacks first).
 * @param {Inventory} inv
 * @param {string} containerUid
 * @param {string} itemId
 * @param {string|null|undefined} [exceptUid]
 * @returns {string|null} uid
 */
function findStackInContainer(inv, containerUid, itemId, exceptUid) {
    const cont = inv.containers[containerUid];
    if (!cont || !itemId) return null;
    const id = String(itemId);
    /** @type {string|null} */
    let best = null;
    let bestRoom = 0;
    for (let i = 0; i < cont.slots.length; i++) {
        const uid = cont.slots[i];
        if (!uid || uid === exceptUid) continue;
        const inst = inv.items[uid];
        if (!inst || inst.itemId !== id || inv.containers[uid]) continue;
        const room = stackRoom(inst);
        if (room > bestRoom) {
            bestRoom = room;
            best = uid;
        }
    }
    return best;
}

/**
 * Whether an ammo template matches an optional kind filter.
 * Uses `item.ammoType === kind` when present (`arrow`/`bolt`) for O(1) checks
 * while scanning quiver slots during fire/consume (skips id/label heuristics).
 * @param {object|null|undefined} item
 * @param {'arrow'|'bolt'|null|undefined} [kind]
 * @returns {boolean}
 */
function ammoMatchesKind(item, kind) {
    if (!itemIsAmmo(item)) return false;
    if (kind == null || kind === '') return true;
    // Fast path: explicit catalog field
    const at = item.ammoType;
    if (at === kind) return true;
    if (at === 'arrow' || at === 'bolt') return false;
    // Legacy rows without ammoType (or non-canonical tokens)
    return itemAmmoKind(item) === kind;
}

/**
 * First ammunition instance uid inside a container (left→right).
 * Optional `kind` filters to arrows or bolts only.
 * @param {Inventory|null|undefined} inv
 * @param {string} containerUid
 * @param {object[]|Record<string, object>|null} [itemDb]
 * @param {'arrow'|'bolt'|null} [kind]
 * @returns {string|null}
 */
function findFirstAmmoUid(inv, containerUid, itemDb, kind) {
    const cont = inv && inv.containers[containerUid];
    if (!cont) return null;
    for (let i = 0; i < cont.slots.length; i++) {
        const uid = cont.slots[i];
        if (!uid) continue;
        const inst = inv.items[uid];
        if (!inst) continue;
        const item = findItem(itemDb, inst.itemId);
        if (ammoMatchesKind(item, kind)) return uid;
    }
    return null;
}

/**
 * Total ammo units (stack counts) in a container.
 * @param {Inventory|null|undefined} inv
 * @param {string} containerUid
 * @param {object[]|Record<string, object>|null} [itemDb]
 * @param {'arrow'|'bolt'|null} [kind]
 * @returns {number}
 */
function countAmmoInContainer(inv, containerUid, itemDb, kind) {
    const cont = inv && inv.containers[containerUid];
    if (!cont) return 0;
    let total = 0;
    for (let i = 0; i < cont.slots.length; i++) {
        const uid = cont.slots[i];
        if (!uid) continue;
        const inst = inv.items[uid];
        if (!inst) continue;
        const item = findItem(itemDb, inst.itemId);
        if (ammoMatchesKind(item, kind)) total += getStackCount(inst);
    }
    return total;
}

/**
 * Sum stack counts of `itemId` across the backpack tree (BFS from root).
 * Walks `inv.rootUid` and every nested container; does not scan equipment slots
 * outside the tree (quiver-only ammo stays separate).
 *
 * @param {Inventory|null|undefined} inv
 * @param {string} itemId
 * @param {string} [startUid] default inv.rootUid
 * @returns {number}
 */
function countItemIdInInventoryTree(inv, itemId, startUid) {
    if (!inv || !itemId) return 0;
    const want = String(itemId);
    const start =
        startUid != null && String(startUid) !== ''
            ? String(startUid)
            : inv.rootUid;
    if (!start) return 0;
    /** @type {string[]} */
    const queue = [start];
    /** @type {Set<string>} */
    const seen = new Set();
    let total = 0;
    while (queue.length) {
        const cuid = queue.shift();
        if (!cuid || seen.has(cuid)) continue;
        seen.add(cuid);
        const cont = inv.containers[cuid];
        if (!cont || !Array.isArray(cont.slots)) continue;
        for (let i = 0; i < cont.slots.length; i++) {
            const uid = cont.slots[i];
            if (!uid) continue;
            const inst = inv.items[uid];
            if (!inst) continue;
            if (String(inst.itemId) === want) {
                total += getStackCount(inst);
            }
            if (inv.containers[uid]) queue.push(uid);
        }
    }
    return total;
}

/**
 * Consume up to `amount` units of `itemId` from the backpack tree (BFS slot order).
 * Decrements the first matching stacks left-to-right; destroys empty stacks.
 *
 * @param {Inventory|null|undefined} inv
 * @param {string} itemId
 * @param {number} amount
 * @param {string} [startUid] default inv.rootUid
 * @returns {{ ok: boolean, spent: number, changed: boolean, itemId: string|null }}
 */
function consumeItemIdFromInventory(inv, itemId, amount, startUid) {
    let need = Math.max(0, Math.floor(Number(amount) || 0));
    let spent = 0;
    let changed = false;
    if (!inv || !itemId || need <= 0) {
        return {
            ok: need <= 0,
            spent: 0,
            changed: false,
            itemId: itemId ? String(itemId) : null
        };
    }
    const want = String(itemId);
    const start =
        startUid != null && String(startUid) !== ''
            ? String(startUid)
            : inv.rootUid;
    if (!start) {
        return { ok: false, spent: 0, changed: false, itemId: want };
    }
    /** @type {string[]} */
    const queue = [start];
    /** @type {Set<string>} */
    const seen = new Set();
    while (queue.length && need > 0) {
        const cuid = queue.shift();
        if (!cuid || seen.has(cuid)) continue;
        seen.add(cuid);
        const cont = inv.containers[cuid];
        if (!cont || !Array.isArray(cont.slots)) continue;
        for (let i = 0; i < cont.slots.length && need > 0; i++) {
            const uid = cont.slots[i];
            if (!uid) continue;
            const inst = inv.items[uid];
            if (!inst) continue;
            if (inv.containers[uid]) queue.push(uid);
            if (String(inst.itemId) !== want) continue;
            const have = getStackCount(inst);
            const take = Math.min(have, need);
            if (take <= 0) continue;
            setStackCount(inst, have - take);
            need -= take;
            spent += take;
            changed = true;
            if (getStackCount(inst) <= 0) {
                destroyItem(inv, uid);
            }
        }
    }
    return { ok: need <= 0, spent, changed, itemId: want };
}

/**
 * Consume up to `amount` ammo units from a container (first matching stacks first).
 * Destroys empty stacks.
 * @param {Inventory} inv
 * @param {string} containerUid
 * @param {number} amount
 * @param {object[]|Record<string, object>|null} [itemDb]
 * @param {'arrow'|'bolt'|null} [kind]
 * @returns {{ ok: boolean, spent: number, changed: boolean, ammoItemId: string|null }}
 */
function consumeAmmoFromContainer(inv, containerUid, amount, itemDb, kind) {
    let need = Math.max(0, Math.floor(Number(amount) || 0));
    let spent = 0;
    let changed = false;
    /** @type {string|null} */
    let ammoItemId = null;
    if (!inv || need <= 0) {
        return { ok: need <= 0, spent: 0, changed: false, ammoItemId: null };
    }
    const cont = inv.containers[containerUid];
    if (!cont) {
        return { ok: false, spent: 0, changed: false, ammoItemId: null };
    }
    for (let i = 0; i < cont.slots.length && need > 0; i++) {
        const uid = cont.slots[i];
        if (!uid) continue;
        const inst = inv.items[uid];
        if (!inst) continue;
        const item = findItem(itemDb, inst.itemId);
        if (!ammoMatchesKind(item, kind)) continue;
        if (!ammoItemId) ammoItemId = inst.itemId;
        const have = getStackCount(inst);
        const take = Math.min(have, need);
        if (take <= 0) continue;
        setStackCount(inst, have - take);
        need -= take;
        spent += take;
        changed = true;
        if (getStackCount(inst) <= 0) {
            destroyItem(inv, uid);
        }
    }
    return { ok: need <= 0, spent, changed, ammoItemId };
}

/**
 * Required ammo kind for the equipped rightHand weapon (bow→arrow, xbow→bolt).
 * @param {Inventory|null|undefined} inv
 * @param {object[]|Record<string, object>|null} [itemDb]
 * @returns {'arrow'|'bolt'|null}
 */
function equippedWeaponAmmoKind(inv, itemDb) {
    if (!inv || !inv.equipment) return null;
    const wUid = inv.equipment.rightHand;
    if (!wUid || !inv.items[wUid]) return null;
    const weapon = findItem(itemDb, inv.items[wUid].itemId);
    return weaponRequiredAmmoKind(weapon);
}

/**
 * Ammo available in the equipped leftHand container (quiver).
 * When `kind` is omitted, filters by equipped weapon (bow/crossbow) if present.
 * @param {Inventory|null|undefined} inv
 * @param {object[]|Record<string, object>|null} [itemDb]
 * @param {'arrow'|'bolt'|null} [kind]
 * @returns {number}
 */
function countEquippedQuiverAmmo(inv, itemDb, kind) {
    if (!inv || !inv.equipment) return 0;
    const qUid = inv.equipment.leftHand;
    if (!qUid || !inv.containers[qUid]) return 0;
    const k = kind !== undefined ? kind : equippedWeaponAmmoKind(inv, itemDb);
    return countAmmoInContainer(inv, qUid, itemDb, k);
}

/**
 * Consume ammo from the equipped leftHand quiver container.
 * When `kind` is omitted, filters by equipped weapon (bow/crossbow) if present.
 * @param {Inventory|null|undefined} inv
 * @param {number} amount
 * @param {object[]|Record<string, object>|null} [itemDb]
 * @param {'arrow'|'bolt'|null} [kind]
 * @returns {{ ok: boolean, spent: number, changed: boolean, ammoItemId: string|null, error?: string }}
 */
function consumeEquippedQuiverAmmo(inv, amount, itemDb, kind) {
    if (!inv || !inv.equipment) {
        return {
            ok: false,
            spent: 0,
            changed: false,
            ammoItemId: null,
            error: 'no_inventory'
        };
    }
    const qUid = inv.equipment.leftHand;
    if (!qUid || !inv.containers[qUid]) {
        return {
            ok: false,
            spent: 0,
            changed: false,
            ammoItemId: null,
            error: 'no_quiver'
        };
    }
    const k = kind !== undefined ? kind : equippedWeaponAmmoKind(inv, itemDb);
    return consumeAmmoFromContainer(inv, qUid, amount, itemDb, k);
}

/**
 * Template for the item currently in rightHand, if any.
 * @param {Inventory|null|undefined} inv
 * @param {object[]|Record<string, object>|null} [itemDb]
 * @returns {object|null}
 */
function equippedRightHandItem(inv, itemDb) {
    if (!inv || !inv.equipment) return null;
    const uid = inv.equipment.rightHand;
    if (!uid || !inv.items[uid]) return null;
    return findItem(itemDb, inv.items[uid].itemId);
}

/**
 * Stack count of the rightHand instance (0 if empty).
 * @param {Inventory|null|undefined} inv
 * @returns {number}
 */
function equippedRightHandCount(inv) {
    if (!inv || !inv.equipment) return 0;
    const uid = inv.equipment.rightHand;
    if (!uid || !inv.items[uid]) return 0;
    return getStackCount(inv.items[uid]);
}

/**
 * Whether rightHand holds a throwing weapon template.
 * @param {Inventory|null|undefined} inv
 * @param {object[]|Record<string, object>|null} [itemDb]
 * @returns {boolean}
 */
function equippedIsThrowingWeapon(inv, itemDb) {
    return itemIsThrowingWeapon(equippedRightHandItem(inv, itemDb));
}

/**
 * Roll break chance on the equipped throwing weapon and remove one unit on break.
 * Empty stacks are destroyed (rightHand clears). Cap weight drops with count.
 *
 * @param {Inventory} inv
 * @param {object[]|Record<string, object>|null} [itemDb]
 * @param {() => number} [rng]
 * @returns {{
 *   attempted: boolean,
 *   broke: boolean,
 *   changed: boolean,
 *   itemId: string|null,
 *   remaining: number,
 *   breakChance: number|null
 * }}
 */
function tryBreakEquippedThrowingWeapon(inv, itemDb, rng) {
    const empty = {
        attempted: false,
        broke: false,
        changed: false,
        itemId: null,
        remaining: 0,
        breakChance: null
    };
    if (!inv || !inv.equipment) return empty;
    const uid = inv.equipment.rightHand;
    if (!uid || !inv.items[uid]) return empty;
    const inst = inv.items[uid];
    const item = findItem(itemDb, inst.itemId);
    if (!itemIsThrowingWeapon(item)) return empty;
    const chance = itemBreakChance(item);
    const itemId = inst.itemId != null ? String(inst.itemId) : null;
    const remainingBefore = getStackCount(inst);
    if (chance == null) {
        return {
            attempted: false,
            broke: false,
            changed: false,
            itemId,
            remaining: remainingBefore,
            breakChance: null
        };
    }
    let roll = 0;
    if (chance >= 100) {
        roll = 0;
    } else if (chance <= 0) {
        return {
            attempted: true,
            broke: false,
            changed: false,
            itemId,
            remaining: remainingBefore,
            breakChance: chance
        };
    } else {
        const r = typeof rng === 'function' ? Number(rng()) : Math.random();
        roll = (Number.isFinite(r) ? r : Math.random()) * 100;
        if (!(roll < chance)) {
            return {
                attempted: true,
                broke: false,
                changed: false,
                itemId,
                remaining: remainingBefore,
                breakChance: chance
            };
        }
    }
    // Break: remove one unit from the hand stack
    const left = remainingBefore - 1;
    if (left <= 0) {
        destroyItem(inv, uid);
        return {
            attempted: true,
            broke: true,
            changed: true,
            itemId,
            remaining: 0,
            breakChance: chance
        };
    }
    setStackCount(inst, left);
    return {
        attempted: true,
        broke: true,
        changed: true,
        itemId,
        remaining: left,
        breakChance: chance
    };
}

/**
 * @param {Inventory|null|undefined} inv
 * @param {string} uid
 * @returns {InventoryItem|null}
 */
function getItem(inv, uid) {
    if (!inv || !uid) return null;
    return inv.items[uid] || null;
}

/**
 * @param {Inventory|null|undefined} inv
 * @param {string} containerUid
 * @returns {InventoryContainer|null}
 */
function getContainer(inv, containerUid) {
    if (!inv || !containerUid) return null;
    return inv.containers[containerUid] || null;
}

/**
 * Ensure a container template instance has a `containers[uid]` entry
 * (repairs missing slots so Open works on equipped quivers/bags).
 * @param {Inventory} inv
 * @param {string} uid
 * @param {object[]|Record<string, object>|null} [itemDb]
 * @returns {InventoryContainer|null}
 */
function ensureItemContainer(inv, uid, itemDb) {
    if (!inv || !uid) return null;
    if (inv.containers[uid]) return inv.containers[uid];
    const inst = inv.items[uid];
    if (!inst) return null;
    const item = findItem(itemDb, inst.itemId);
    if (!itemIsContainer(item)) return null;
    const cap = containerCapacity(item, itemDb);
    inv.containers[uid] = {
        capacity: cap,
        slots: emptySlots(cap),
        isRoot: false
    };
    return inv.containers[uid];
}

/**
 * Detach item from its current location (does not destroy the instance).
 * @param {Inventory} inv
 * @param {string} uid
 * @returns {boolean}
 */
function detachItem(inv, uid) {
    const inst = inv.items[uid];
    if (!inst) return false;
    const loc = inst.location;
    if (!loc) return true;
    if (loc.kind === 'equipment') {
        if (inv.equipment[loc.slot] === uid) {
            delete inv.equipment[loc.slot];
        }
    } else if (loc.kind === 'container') {
        const cont = inv.containers[loc.containerUid];
        if (cont && cont.slots[loc.index] === uid) {
            cont.slots[loc.index] = null;
        }
    }
    inst.location = null;
    return true;
}

/**
 * Destroy an instance and all nested contents.
 * @param {Inventory} inv
 * @param {string} uid
 * @returns {boolean}
 */
function destroyItem(inv, uid) {
    const inst = inv.items[uid];
    if (!inst) return false;
    const cont = inv.containers[uid];
    if (cont) {
        for (let i = 0; i < cont.slots.length; i++) {
            const child = cont.slots[i];
            if (child) destroyItem(inv, child);
        }
        delete inv.containers[uid];
    }
    detachItem(inv, uid);
    delete inv.items[uid];
    return true;
}

/**
 * First free index in a container, or -1.
 * @param {InventoryContainer|null|undefined} cont
 * @returns {number}
 */
function firstFreeSlot(cont) {
    if (!cont || !Array.isArray(cont.slots)) return -1;
    for (let i = 0; i < cont.slots.length; i++) {
        if (cont.slots[i] == null) return i;
    }
    return -1;
}

/**
 * BFS from `startUid`: first free slot in that container or any nested container.
 * Order: root left-to-right, then each child container in slot order.
 *
 * @param {Inventory} inv
 * @param {string} [startUid] default inv.rootUid
 * @returns {{ containerUid: string, index: number }|null}
 */
function findFirstFreeSlotBfs(inv, startUid) {
    if (!inv) return null;
    const start =
        startUid != null && String(startUid) !== ''
            ? String(startUid)
            : inv.rootUid;
    /** @type {string[]} */
    const queue = [start];
    /** @type {Set<string>} */
    const seen = new Set();
    while (queue.length) {
        const cuid = queue.shift();
        if (!cuid || seen.has(cuid)) continue;
        seen.add(cuid);
        const cont = inv.containers[cuid];
        if (!cont) continue;
        const free = firstFreeSlot(cont);
        if (free >= 0) {
            return { containerUid: cuid, index: free };
        }
        for (let i = 0; i < cont.slots.length; i++) {
            const child = cont.slots[i];
            if (child && inv.containers[child]) queue.push(child);
        }
    }
    return null;
}

/**
 * Sum weight of an item instance and all nested contents.
 * @param {Inventory|null|undefined} inv
 * @param {string} uid
 * @param {object[]|Record<string, object>|null} [itemDb]
 * @returns {number}
 */
function itemSubtreeWeight(inv, uid, itemDb) {
    if (!inv || !uid) return 0;
    let w = 0;
    /** @type {Set<string>} */
    const seen = new Set();

    /**
     * @param {string|null|undefined} id
     */
    function walk(id) {
        if (!id || seen.has(id)) return;
        seen.add(id);
        const inst = inv.items[id];
        if (!inst) return;
        const item = findItem(itemDb, inst.itemId);
        w += instanceWeight(inst, item);
        const cont = inv.containers[id];
        if (cont) {
            for (let i = 0; i < cont.slots.length; i++) {
                if (cont.slots[i]) walk(cont.slots[i]);
            }
        }
    }

    walk(uid);
    return w;
}

/**
 * Whether adding `addWeight` still fits Cap (same units as totalCarriedWeight).
 * @param {number} level
 * @param {number} currentWeight
 * @param {number} addWeight
 * @param {string|null|undefined} [classId]
 * @returns {boolean}
 */
function canCarryAdditional(level, currentWeight, addWeight, classId) {
    const after =
        (Number(currentWeight) || 0) + (Number(addWeight) || 0);
    return (
        Math.floor(baseCapacity(level, classId) - after / 100) >= 0
    );
}

/**
 * Template equips in the character backpack slot only when `item.slot` is backpack
 * (not category bag/container alone; not quiver).
 * @param {object|null|undefined} item
 * @returns {boolean}
 */
function itemIsBackpackEquip(item) {
    if (!item || item.slot == null) return false;
    const raw = String(item.slot).toLowerCase().trim();
    if (raw === 'backpack') return true;
    return canonicalEquipmentSlot(item.slot) === 'backpack';
}

/**
 * Whether `containerUid` is inside the item tree of `ancestorUid` (cycle guard).
 * Walks parent containers; stops at synthetic root or equipment location.
 * @param {Inventory} inv
 * @param {string} containerUid
 * @param {string} ancestorUid
 * @returns {boolean}
 */
function isInsideSubtree(inv, containerUid, ancestorUid) {
    if (!containerUid || !ancestorUid) return false;
    if (containerUid === ancestorUid) return true;
    // Synthetic fallback is never "inside" another item
    if (containerUid === ROOT_UID) return false;
    const inst = inv.items[containerUid];
    if (!inst || !inst.location) return false;
    if (inst.location.kind === 'container') {
        return isInsideSubtree(inv, inst.location.containerUid, ancestorUid);
    }
    // Equipped containers sit outside any bag tree
    return false;
}

/**
 * Point `inv.rootUid` at the equipped backpack container (main open panel).
 * Falls back to the synthetic ROOT with **0 slots** when the backpack slot is empty.
 * @param {Inventory} inv
 * @returns {string} active root uid
 */
function syncRootToEquippedBackpack(inv) {
    if (!inv) return ROOT_UID;
    const bpUid = inv.equipment && inv.equipment.backpack;
    if (bpUid && inv.containers[bpUid]) {
        inv.rootUid = bpUid;
        inv.containers[bpUid].isRoot = true;
        if (inv.containers[ROOT_UID] && ROOT_UID !== bpUid) {
            inv.containers[ROOT_UID].isRoot = false;
        }
        return bpUid;
    }
    inv.rootUid = ROOT_UID;
    if (!inv.containers[ROOT_UID]) {
        inv.containers[ROOT_UID] = {
            capacity: 0,
            slots: emptySlots(0),
            isRoot: true
        };
    } else {
        // Empty backpack equip → no phantom slots
        inv.containers[ROOT_UID].capacity = 0;
        inv.containers[ROOT_UID].slots = emptySlots(0);
        inv.containers[ROOT_UID].isRoot = true;
    }
    return ROOT_UID;
}

/**
 * Ensure a backpack is equipped so the main inventory panel has a real
 * parent container (counts toward Cap, cannot be nested into itself).
 * @param {Inventory} inv
 * @param {object[]|Record<string, object>|null} [itemDb]
 * @param {string} [itemId]
 * @returns {string|null} backpack item uid
 */
function ensureEquippedBackpack(inv, itemDb, itemId) {
    if (!inv) return null;
    if (inv.equipment && inv.equipment.backpack) {
        syncRootToEquippedBackpack(inv);
        return inv.equipment.backpack;
    }
    const id =
        itemId != null && String(itemId).trim() !== ''
            ? String(itemId).trim()
            : DEFAULT_BACKPACK_ITEM_ID;
    const template = findItem(itemDb, id);
    if (!template || !itemIsContainer(template)) {
        syncRootToEquippedBackpack(inv);
        return null;
    }
    const uid = createItemInstance(inv, id, itemDb);
    const r = placeInEquipment(inv, uid, 'backpack', itemDb);
    if (!r.ok) {
        destroyItem(inv, uid);
        syncRootToEquippedBackpack(inv);
        return null;
    }
    syncRootToEquippedBackpack(inv);
    return uid;
}

/**
 * Preferred engine equip slot for a template item.
 * @param {object|null|undefined} item
 * @returns {string|null}
 */
function preferredEquipSlot(item) {
    if (!item) return null;
    // Ammo lives only in containers (quiver); ignore template slot: leftHand.
    if (itemIsAmmo(item)) return null;
    if (item.slot != null && String(item.slot).trim() !== '') {
        const c = canonicalEquipmentSlot(item.slot);
        if (c) return c;
    }
    const cat = item.category != null ? String(item.category).toLowerCase() : '';
    if (cat === 'helmet' || cat === 'head') return 'helmet';
    if (cat === 'armor' || cat === 'chest' || cat === 'body') return 'armor';
    if (cat === 'legs' || cat === 'legs armor') return 'legs';
    if (cat === 'boots' || cat === 'feet') return 'boots';
    if (cat === 'amulet' || cat === 'necklace' || cat === 'neck') return 'amulet';
    if (cat === 'ring') return 'ring';
    if (cat === 'shield' || cat === 'spellbook' || cat === 'quiver') return 'leftHand';
    if (cat === 'container' || cat === 'backpack' || cat === 'bag') return 'backpack';
    if (itemIsShield(item)) return 'leftHand';
    if (item.atk != null || item.weaponType) return 'rightHand';
    return null;
}

/**
 * Whether the item may be equipped in the given engine slot.
 * Backpack slot requires explicit `item.slot === 'backpack'` (not quiver / bag-by-category).
 * Ammo is never equippable (store in a quiver container).
 * @param {object|null|undefined} item
 * @param {string} engineSlot
 * @returns {boolean}
 */
function canEquipInSlot(item, engineSlot) {
    if (!item || !engineSlot) return false;
    if (itemIsAmmo(item)) return false;
    const slot = canonicalEquipmentSlot(engineSlot) || engineSlot;
    if (slot === 'backpack') {
        return itemIsBackpackEquip(item);
    }
    const preferred = preferredEquipSlot(item);
    if (!preferred) return false;
    if (preferred === slot) return true;
    // Two-handed / dual-slot flexibility is out of scope
    return false;
}

/**
 * Whether a template is a multi-use item requiring a secondary target (runes, tools).
 * @param {object|null|undefined} item
 * @returns {boolean}
 */
function itemIsMultiUse(item) {
    if (!item || typeof item !== 'object') return false;
    if (item.multiUse === true) return true;
    const cat = item.category != null ? String(item.category).toLowerCase() : '';
    if (cat === 'rune' || cat === 'tool') return true;
    if (Array.isArray(item.type)) {
        for (let i = 0; i < item.type.length; i++) {
            const t = String(item.type[i]).toLowerCase();
            if (t === 'rune' || t === 'tool') return true;
        }
    }
    const id = item.id != null ? String(item.id).toLowerCase() : '';
    if (id === 'rope' || id === 'shovel' || id === 'machete' || id === 'pick') return true;
    return false;
}

/**
 * Whether a template is directly usable on self (potions, scrolls, food).
 * Containers and multi-use items return false here to separate interaction behaviors.
 * @param {object|null|undefined} item
 * @returns {boolean}
 */
function itemIsUsable(item) {
    if (!item || typeof item !== 'object') return false;
    if (itemIsContainer(item) || itemIsMultiUse(item)) return false;
    if (item.usable === true || item.consumable === true) return true;
    const cat = item.category != null ? String(item.category).toLowerCase() : '';
    if (cat === 'potion' || cat === 'consumable' || cat === 'food' || cat === 'scroll') return true;
    if (Array.isArray(item.type)) {
        for (let i = 0; i < item.type.length; i++) {
            const t = String(item.type[i]).toLowerCase();
            if (t === 'potion' || t === 'consumable' || t === 'food' || t === 'scroll') return true;
        }
    }
    if (item.heal != null || item.restoreMana != null || item.effect != null) return true;
    return false;
}

/**
 * Whether a template is standard equipable gear (weapons, armor, amulets, shields, bags/quiver).
 * @param {object|null|undefined} item
 * @returns {boolean}
 */
function itemIsEquipable(item) {
    if (!item || typeof item !== 'object') return false;
    if (itemIsAmmo(item)) return false;
    return preferredEquipSlot(item) != null || item.slot != null;
}

/**
 * Place a detached item into a container slot.
 * When `index` is null/omitted and the item is stackable, merges into an existing
 * same-itemId stack in that container when present.
 *
 * @param {Inventory} inv
 * @param {string} uid
 * @param {string} containerUid
 * @param {number|null|undefined} [index] null = first free (or merge)
 * @param {object[]|Record<string, object>|null} [itemDb]
 * @returns {{ ok: boolean, error?: string, index?: number, merged?: boolean, uid?: string }}
 */
function placeInContainer(inv, uid, containerUid, index, itemDb) {
    const inst = inv.items[uid];
    if (!inst) return { ok: false, error: 'unknown_item' };
    if (inst.location) {
        return { ok: false, error: 'still_attached' };
    }
    const cont = inv.containers[containerUid];
    if (!cont) return { ok: false, error: 'unknown_container' };

    // Cannot place a container inside itself or its descendants
    if (inv.containers[uid] && isInsideSubtree(inv, containerUid, uid)) {
        return { ok: false, error: 'cycle' };
    }

    const explicitIndex =
        index != null && Number.isFinite(Number(index))
            ? Math.floor(Number(index))
            : null;

    // Auto-merge stackable into existing stacks (respect MAX_STACK_SIZE)
    if (explicitIndex == null && itemDb != null) {
        const item = findItem(itemDb, inst.itemId);
        if (itemIsStackable(item)) {
            /** @type {string|null} */
            let lastMerged = null;
            while (inv.items[uid] && getStackCount(inv.items[uid]) > 0) {
                const existing = findStackInContainer(
                    inv,
                    containerUid,
                    inst.itemId,
                    uid
                );
                if (!existing || !canMergeStacks(inv, uid, existing, itemDb)) {
                    break;
                }
                mergeStacks(inv, uid, existing);
                lastMerged = existing;
                if (!inv.items[uid]) {
                    const dest = inv.items[existing];
                    const destIndex =
                        dest &&
                        dest.location &&
                        dest.location.kind === 'container'
                            ? dest.location.index
                            : undefined;
                    return {
                        ok: true,
                        merged: true,
                        uid: existing,
                        index: destIndex
                    };
                }
            }
            // Remainder (or full stack with no merge target) falls through to free slot
            if (lastMerged && !inv.items[uid]) {
                return { ok: true, merged: true, uid: lastMerged };
            }
        }
    }

    let idx =
        explicitIndex != null ? explicitIndex : firstFreeSlot(cont);
    if (idx < 0 || idx >= cont.capacity) {
        return {
            ok: false,
            error: explicitIndex != null ? 'invalid_index' : 'full'
        };
    }
    if (cont.slots[idx] != null) {
        // Explicit slot occupied by same stackable → merge (possibly partial)
        const occ = cont.slots[idx];
        if (occ && canMergeStacks(inv, uid, occ, itemDb)) {
            mergeStacks(inv, uid, occ);
            if (!inv.items[uid]) {
                return { ok: true, merged: true, uid: occ, index: idx };
            }
            // Remainder needs another free slot
            idx = firstFreeSlot(cont);
            if (idx < 0) return { ok: false, error: 'full' };
        } else if (explicitIndex == null) {
            idx = firstFreeSlot(cont);
            if (idx < 0) return { ok: false, error: 'full' };
        } else {
            return { ok: false, error: 'occupied' };
        }
    }
    // Re-read inst in case merge partially absorbed (still same object if left)
    const live = inv.items[uid];
    if (!live) {
        return { ok: true, merged: true, uid: null, index: idx };
    }
    cont.slots[idx] = uid;
    live.location = { kind: 'container', containerUid, index: idx };
    return { ok: true, index: idx, uid };
}

/**
 * Place a detached item into an equipment slot (must be empty).
 * @param {Inventory} inv
 * @param {string} uid
 * @param {string} engineSlot
 * @param {object[]|Record<string, object>|null} [itemDb]
 * @returns {{ ok: boolean, error?: string }}
 */
function placeInEquipment(inv, uid, engineSlot, itemDb) {
    const inst = inv.items[uid];
    if (!inst) return { ok: false, error: 'unknown_item' };
    if (inst.location) return { ok: false, error: 'still_attached' };
    const slot = canonicalEquipmentSlot(engineSlot) || engineSlot;
    if (!slot) return { ok: false, error: 'invalid_slot' };
    const item = findItem(itemDb, inst.itemId);
    if (!canEquipInSlot(item, slot)) {
        return { ok: false, error: 'wrong_slot' };
    }
    if (inv.equipment[slot]) {
        return { ok: false, error: 'occupied' };
    }
    inv.equipment[slot] = uid;
    inst.location = { kind: 'equipment', slot };
    return { ok: true };
}

/**
 * Move `amount` units of a stackable instance from `from` to `to`.
 * When amount ≥ stack size (or item is non-stackable) → full {@link moveItem}.
 * Partial moves never swap with a non-mergeable occupant (place/merge only).
 *
 * @param {Inventory} inv
 * @param {ItemLocation} from
 * @param {ItemLocation} to
 * @param {number} amount
 * @param {object[]|Record<string, object>|null} [itemDb]
 * @returns {{ ok: boolean, error?: string, splitUid?: string, merged?: boolean }}
 */
function moveItemAmount(inv, from, to, amount, itemDb) {
    if (!inv || !from || !to) return { ok: false, error: 'bad_args' };
    const uidFrom = resolveLocationUid(inv, from);
    if (!uidFrom) return { ok: false, error: 'empty_source' };
    const src = inv.items[uidFrom];
    if (!src) return { ok: false, error: 'unknown_item' };

    const total = getStackCount(src);
    let n = Math.floor(Number(amount));
    if (!Number.isFinite(n) || n < 1) n = 1;
    if (n > total) n = total;
    if (n >= total) return moveItem(inv, from, to, itemDb);

    const template = findItem(itemDb, src.itemId);
    if (!itemIsStackable(template)) {
        return moveItem(inv, from, to, itemDb);
    }

    // Same location no-op
    if (locationsEqual(from, to)) return { ok: true };

    // Drop onto container *instance* → nest into first free (merge-aware) slot
    const uidToPeek = resolveLocationUid(inv, to);
    if (to.kind === 'container' && uidToPeek && inv.containers[uidToPeek]) {
        if (uidFrom === uidToPeek) return { ok: false, error: 'cycle' };
        if (inv.containers[uidFrom] && isInsideSubtree(inv, uidToPeek, uidFrom)) {
            return { ok: false, error: 'cycle' };
        }
        const free = firstFreeSlot(inv.containers[uidToPeek]);
        // Prefer merge into existing stack inside that bag
        const existing = findStackInContainer(
            inv,
            uidToPeek,
            src.itemId,
            uidFrom
        );
        if (existing && canMergeStacks(inv, uidFrom, existing, itemDb)) {
            // split path still needed for partial merge from source
        } else if (free < 0 && !existing) {
            return { ok: false, error: 'full' };
        }
        return moveItemAmount(
            inv,
            from,
            existing
                ? {
                      kind: 'container',
                      containerUid: uidToPeek,
                      index:
                          inv.items[existing] &&
                          inv.items[existing].location &&
                          inv.items[existing].location.kind === 'container'
                              ? inv.items[existing].location.index
                              : free >= 0
                                ? free
                                : 0
                  }
                : {
                      kind: 'container',
                      containerUid: uidToPeek,
                      index: free
                  },
            n,
            itemDb
        );
    }

    // Equipment partial: only into empty valid slot
    if (to.kind === 'equipment') {
        if (!canEquipInSlot(template, to.slot)) {
            return { ok: false, error: 'wrong_slot' };
        }
        if (inv.equipment[to.slot]) {
            const occ = inv.equipment[to.slot];
            if (occ && canMergeStacks(inv, uidFrom, occ, itemDb)) {
                // fall through to split+merge
            } else {
                return { ok: false, error: 'occupied' };
            }
        }
    }

    if (to.kind === 'container') {
        const cont = inv.containers[to.containerUid];
        if (!cont) return { ok: false, error: 'unknown_container' };
        if (to.index < 0 || to.index >= cont.capacity) {
            return { ok: false, error: 'invalid_index' };
        }
        const occ = cont.slots[to.index];
        if (occ && !canMergeStacks(inv, uidFrom, occ, itemDb)) {
            // Partial never swaps
            return { ok: false, error: 'occupied' };
        }
    }

    // Split: reduce source, create detached stack of n, place at to
    const prevCount = total;
    setStackCount(src, total - n);
    let splitUid;
    try {
        splitUid = createItemInstance(inv, src.itemId, itemDb, { count: n });
    } catch (e) {
        setStackCount(src, prevCount);
        return { ok: false, error: 'split_failed' };
    }
    const splitInst = inv.items[splitUid];
    if (!splitInst) {
        setStackCount(src, prevCount);
        return { ok: false, error: 'split_failed' };
    }
    // Ensure detached
    splitInst.location = null;

    let placeResult;
    if (to.kind === 'equipment') {
        const occUid = inv.equipment[to.slot];
        if (occUid && canMergeStacks(inv, splitUid, occUid, itemDb)) {
            mergeStacks(inv, splitUid, occUid);
            return {
                ok: true,
                splitUid: inv.items[splitUid] ? splitUid : undefined,
                merged: true
            };
        }
        placeResult = placeInEquipment(inv, splitUid, to.slot, itemDb);
    } else {
        placeResult = placeInContainer(
            inv,
            splitUid,
            to.containerUid,
            to.index,
            itemDb
        );
    }

    if (!placeResult || !placeResult.ok) {
        // Rollback: destroy split remnant, restore source count
        if (inv.items[splitUid]) destroyItem(inv, splitUid);
        setStackCount(src, prevCount);
        return {
            ok: false,
            error: (placeResult && placeResult.error) || 'place_failed'
        };
    }
    return {
        ok: true,
        splitUid: inv.items[splitUid] ? splitUid : undefined,
        merged: !!placeResult.merged
    };
}

/**
 * Move / swap two locations. Empty target → move; occupied non-container →
 * swap; occupied **container instance** → nest into that bag’s first free
 * slot (classic drop-on-bag). Cycle guards reject putting a bag into itself
 * or a descendant.
 *
 * @param {Inventory} inv
 * @param {ItemLocation} from
 * @param {ItemLocation} to
 * @param {object[]|Record<string, object>|null} [itemDb]
 * @returns {{ ok: boolean, error?: string }}
 */
function moveItem(inv, from, to, itemDb) {
    if (!inv || !from || !to) return { ok: false, error: 'bad_args' };

    const uidFrom = resolveLocationUid(inv, from);
    if (!uidFrom) return { ok: false, error: 'empty_source' };

    // Same location no-op
    if (locationsEqual(from, to)) return { ok: true };

    const uidTo = resolveLocationUid(inv, to);

    // Drop onto same stackable item → merge stacks
    if (uidTo && canMergeStacks(inv, uidFrom, uidTo, itemDb)) {
        mergeStacks(inv, uidFrom, uidTo);
        return { ok: true, merged: true };
    }

    // Drop onto a container *instance* (bag icon) → nest into first free slot.
    // Classic tile-RPG: drop on bag puts the item inside; swap only with
    // non-containers. Without this, dropping bag A on bag B merely swaps them
    // and nested bags appear "unusable" as destinations unless opened first.
    if (to.kind === 'container' && uidTo && inv.containers[uidTo]) {
        if (uidFrom === uidTo) return { ok: false, error: 'cycle' };
        // Cannot put a bag into itself or a bag that lives inside it
        if (inv.containers[uidFrom] && isInsideSubtree(inv, uidTo, uidFrom)) {
            return { ok: false, error: 'cycle' };
        }
        const free = firstFreeSlot(inv.containers[uidTo]);
        if (free < 0) return { ok: false, error: 'full' };
        return moveItem(
            inv,
            from,
            { kind: 'container', containerUid: uidTo, index: free },
            itemDb
        );
    }

    // Validate equip constraints before mutating
    if (to.kind === 'equipment') {
        const inst = inv.items[uidFrom];
        const item = findItem(itemDb, inst.itemId);
        if (!canEquipInSlot(item, to.slot)) {
            return { ok: false, error: 'wrong_slot' };
        }
        // Two-handed into rightHand: free leftHand (except bow/xbow + quiver)
        if (to.slot === 'rightHand') {
            const prep = prepareLeftHandForTwoHandedEquip(inv, item, itemDb);
            if (!prep.ok) return prep;
        }
        // Into leftHand while rightHand holds a non-bow 2H (or bow + non-quiver):
        // free rightHand so shield/spellbook never dual-occupies with a 2H weapon.
        if (to.slot === 'leftHand') {
            const prep = prepareRightHandForLeftHandEquip(inv, item, itemDb);
            if (!prep.ok) return prep;
        }
    }
    if (from.kind === 'equipment' && uidTo) {
        // Swapping: item at target must fit source equip slot
        const instTo = inv.items[uidTo];
        const itemTo = findItem(itemDb, instTo.itemId);
        if (!canEquipInSlot(itemTo, from.slot)) {
            return { ok: false, error: 'wrong_slot_swap' };
        }
    }
    if (to.kind === 'container') {
        const cont = inv.containers[to.containerUid];
        if (!cont) return { ok: false, error: 'unknown_container' };
        if (to.index < 0 || to.index >= cont.capacity) {
            return { ok: false, error: 'invalid_index' };
        }
        // Cycle: moving a bag into itself / descendant (main backpack cannot
        // go into its own slots or a nested child bag).
        if (inv.containers[uidFrom] && isInsideSubtree(inv, to.containerUid, uidFrom)) {
            return { ok: false, error: 'cycle' };
        }
    }
    // Displacing a container into `from` would cycle if `from` is inside it —
    // unless we equip-swap into the newly equipped bag (handled below).
    const swapIntoNewBag =
        to.kind === 'equipment' &&
        from.kind === 'container' &&
        !!uidTo &&
        !!inv.containers[uidTo] &&
        !!inv.containers[uidFrom] &&
        isInsideSubtree(inv, from.containerUid, uidTo);

    if (
        from.kind === 'container' &&
        uidTo &&
        inv.containers[uidTo] &&
        !swapIntoNewBag
    ) {
        if (isInsideSubtree(inv, from.containerUid, uidTo)) {
            return { ok: false, error: 'cycle' };
        }
    }
    if (swapIntoNewBag) {
        const free = firstFreeSlot(inv.containers[uidFrom]);
        if (free < 0) return { ok: false, error: 'full' };
    }

    detachItem(inv, uidFrom);
    if (uidTo) detachItem(inv, uidTo);

    if (to.kind === 'equipment') {
        const r = placeInEquipment(inv, uidFrom, to.slot, itemDb);
        if (!r.ok) {
            // rollback best-effort
            placeAtLocation(inv, uidFrom, from, itemDb);
            if (uidTo) placeAtLocation(inv, uidTo, to, itemDb);
            return r;
        }
    } else {
        const r = placeInContainer(
            inv,
            uidFrom,
            to.containerUid,
            to.index,
            itemDb
        );
        if (!r.ok) {
            placeAtLocation(inv, uidFrom, from, itemDb);
            if (uidTo) placeAtLocation(inv, uidTo, to, itemDb);
            return r;
        }
        // Merged into existing stack — nothing to swap back
        if (r.merged) return { ok: true, merged: true };
    }

    if (uidTo) {
        if (from.kind === 'equipment') {
            const r = placeInEquipment(inv, uidTo, from.slot, itemDb);
            if (!r.ok) {
                placeAtLocation(inv, uidTo, from, itemDb);
            }
        } else if (swapIntoNewBag) {
            // Equip bag B from inside backpack A → A (parent) goes into B
            const free = firstFreeSlot(inv.containers[uidFrom]);
            const r = placeInContainer(inv, uidTo, uidFrom, free, itemDb);
            if (!r.ok) {
                placeInContainer(
                    inv,
                    uidTo,
                    from.containerUid,
                    from.index,
                    itemDb
                );
            }
        } else {
            placeInContainer(
                inv,
                uidTo,
                from.containerUid,
                from.index,
                itemDb
            );
        }
    }

    // Main open panel follows the equipped backpack slot
    if (
        (to.kind === 'equipment' && to.slot === 'backpack') ||
        (from.kind === 'equipment' && from.slot === 'backpack')
    ) {
        syncRootToEquippedBackpack(inv);
    }

    return { ok: true };
}

/**
 * @param {Inventory} inv
 * @param {ItemLocation} loc
 * @returns {string|null}
 */
function resolveLocationUid(inv, loc) {
    if (!loc) return null;
    if (loc.kind === 'equipment') {
        return inv.equipment[loc.slot] || null;
    }
    if (loc.kind === 'container') {
        const cont = inv.containers[loc.containerUid];
        if (!cont) return null;
        return cont.slots[loc.index] || null;
    }
    return null;
}

/**
 * @param {ItemLocation} a
 * @param {ItemLocation} b
 * @returns {boolean}
 */
function locationsEqual(a, b) {
    if (!a || !b || a.kind !== b.kind) return false;
    if (a.kind === 'equipment') return a.slot === b.slot;
    return a.containerUid === b.containerUid && a.index === b.index;
}

/**
 * @param {Inventory} inv
 * @param {string} uid
 * @param {ItemLocation} loc
 * @param {object[]|Record<string, object>|null} [itemDb]
 */
function placeAtLocation(inv, uid, loc, itemDb) {
    if (!loc) return;
    if (loc.kind === 'equipment') {
        placeInEquipment(inv, uid, loc.slot, itemDb);
    } else {
        placeInContainer(inv, uid, loc.containerUid, loc.index, itemDb);
    }
}

/**
 * When equipping a two-handed weapon into rightHand, free leftHand unless
 * the weapon is a bow/crossbow and leftHand holds a quiver.
 * @param {Inventory} inv
 * @param {object|null|undefined} weaponItem
 * @param {object[]|Record<string, object>|null} [itemDb]
 * @returns {{ ok: boolean, error?: string }}
 */
function prepareLeftHandForTwoHandedEquip(inv, weaponItem, itemDb) {
    if (!inv || !itemIsTwoHanded(weaponItem)) return { ok: true };
    const leftUid = inv.equipment && inv.equipment.leftHand;
    if (!leftUid) return { ok: true };
    const leftInst = inv.items[leftUid];
    const leftItem = leftInst
        ? findItem(itemDb, leftInst.itemId)
        : null;
    // Bow/crossbow + quiver: keep leftHand
    if (
        itemIsBowOrCrossbowWeapon(weaponItem) &&
        itemIsQuiver(leftItem)
    ) {
        return { ok: true };
    }
    const root = inv.containers[inv.rootUid];
    if (!root || firstFreeSlot(root) < 0) {
        return { ok: false, error: 'no_room' };
    }
    const un = unequipItem(inv, 'leftHand', itemDb, {
        containerUid: inv.rootUid
    });
    if (!un.ok) {
        return {
            ok: false,
            error: un.error === 'full' ? 'no_room' : un.error || 'no_room'
        };
    }
    return { ok: true };
}

/**
 * When equipping into leftHand while rightHand holds a two-handed weapon,
 * free rightHand unless the weapon is a bow/crossbow and the new left item
 * is a quiver (allowed dual occupancy for distance loadouts).
 * @param {Inventory} inv
 * @param {object|null|undefined} leftItem item being equipped into leftHand
 * @param {object[]|Record<string, object>|null} [itemDb]
 * @returns {{ ok: boolean, error?: string }}
 */
function prepareRightHandForLeftHandEquip(inv, leftItem, itemDb) {
    if (!inv) return { ok: true };
    const rightUid = inv.equipment && inv.equipment.rightHand;
    if (!rightUid) return { ok: true };
    const rightInst = inv.items[rightUid];
    const rightItem = rightInst
        ? findItem(itemDb, rightInst.itemId)
        : null;
    if (!itemIsTwoHanded(rightItem)) return { ok: true };
    // Bow/crossbow + quiver: keep rightHand
    if (
        itemIsBowOrCrossbowWeapon(rightItem) &&
        itemIsQuiver(leftItem)
    ) {
        return { ok: true };
    }
    const root = inv.containers[inv.rootUid];
    if (!root || firstFreeSlot(root) < 0) {
        return { ok: false, error: 'no_room' };
    }
    const un = unequipItem(inv, 'rightHand', itemDb, {
        containerUid: inv.rootUid
    });
    if (!un.ok) {
        return {
            ok: false,
            error: un.error === 'full' ? 'no_room' : un.error || 'no_room'
        };
    }
    return { ok: true };
}

/**
 * Equip item from a container into its preferred (or given) slot, swapping if needed.
 *
 * Two-handed weapons: leftHand is unequipped into the backpack unless the
 * weapon is a bow/crossbow and leftHand is a quiver. Fails with `no_room`
 * when the backpack cannot accept the displaced leftHand item.
 *
 * Inverse: equipping leftHand (shield/spellbook/…) while rightHand holds a
 * two-handed weapon stows that weapon into the backpack (same bow+quiver
 * exception). Fails with `no_room` when the backpack is full.
 *
 * @param {Inventory} inv
 * @param {string} uid
 * @param {object[]|Record<string, object>|null} [itemDb]
 * @param {string|null} [engineSlot]
 * @returns {{ ok: boolean, error?: string, swappedUid?: string|null }}
 */
function equipItem(inv, uid, itemDb, engineSlot) {
    const inst = inv.items[uid];
    if (!inst) return { ok: false, error: 'unknown_item' };
    const item = findItem(itemDb, inst.itemId);
    const slot =
        engineSlot != null
            ? canonicalEquipmentSlot(engineSlot) || engineSlot
            : preferredEquipSlot(item);
    if (!slot || !canEquipInSlot(item, slot)) {
        return { ok: false, error: 'not_equippable' };
    }
    if (!inst.location || inst.location.kind !== 'container') {
        // Already equipped or free
        if (inst.location && inst.location.kind === 'equipment') {
            return { ok: true, swappedUid: null };
        }
        return { ok: false, error: 'not_in_container' };
    }
    // Two-handed prep (both directions) runs inside moveItem
    const from = Object.assign({}, inst.location);
    const to = { kind: 'equipment', slot };
    const r = moveItem(inv, from, to, itemDb);
    if (!r.ok) return r;
    return { ok: true, swappedUid: resolveLocationUid(inv, from) };
}

/**
 * Unequip a slot into a container (default: main backpack first free).
 * The equipped main backpack cannot be stowed into itself or a nested child.
 *
 * @param {Inventory} inv
 * @param {string} engineSlot
 * @param {object[]|Record<string, object>|null} [itemDb]
 * @param {{ containerUid?: string, index?: number|null }} [dest]
 * @returns {{ ok: boolean, error?: string }}
 */
function unequipItem(inv, engineSlot, itemDb, dest) {
    const slot = canonicalEquipmentSlot(engineSlot) || engineSlot;
    const uid = inv.equipment[slot];
    if (!uid) return { ok: false, error: 'empty_slot' };
    const d = dest || {};
    const containerUid = d.containerUid || inv.rootUid;
    if (slot === 'backpack') {
        if (containerUid === uid || isInsideSubtree(inv, containerUid, uid)) {
            return { ok: false, error: 'cycle' };
        }
    }
    const cont = inv.containers[containerUid];
    if (!cont) return { ok: false, error: 'unknown_container' };
    let index = d.index != null ? d.index : firstFreeSlot(cont);
    if (index < 0) return { ok: false, error: 'full' };
    return moveItem(
        inv,
        { kind: 'equipment', slot },
        { kind: 'container', containerUid, index },
        itemDb
    );
}

/**
 * True when `inv` is a runtime Inventory (uid maps), not a profile/scenario
 * seed like `{ backpack: [...] }`.
 * @param {unknown} inv
 * @returns {boolean}
 */
function isRuntimeInventory(inv) {
    return !!(
        inv &&
        typeof inv === 'object' &&
        /** @type {{ items?: unknown }} */ (inv).items &&
        typeof /** @type {{ items?: unknown }} */ (inv).items === 'object' &&
        /** @type {{ containers?: unknown }} */ (inv).containers &&
        typeof /** @type {{ containers?: unknown }} */ (inv).containers ===
            'object'
    );
}

/**
 * Sum weight of all equipped items + root backpack tree (each instance once).
 * Safe on null/seed inventories (returns 0).
 * @param {Inventory|null|undefined} inv
 * @param {object[]|Record<string, object>|null} [itemDb]
 * @returns {number}
 */
function totalCarriedWeight(inv, itemDb) {
    if (!isRuntimeInventory(inv)) return 0;
    let w = 0;
    /** @type {Set<string>} */
    const seen = new Set();
    const items = inv.items;
    const containers = inv.containers;
    const equipment =
        inv.equipment && typeof inv.equipment === 'object'
            ? inv.equipment
            : null;

    /**
     * @param {string|null|undefined} uid
     */
    function walk(uid) {
        if (!uid || seen.has(uid)) return;
        seen.add(uid);
        const inst = items[uid];
        if (!inst) return;
        const item = findItem(itemDb, inst.itemId);
        w += instanceWeight(inst, item);
        const cont = containers[uid];
        if (cont && Array.isArray(cont.slots)) {
            for (let i = 0; i < cont.slots.length; i++) {
                if (cont.slots[i]) walk(cont.slots[i]);
            }
        }
    }

    if (equipment) {
        const eqKeys = Object.keys(equipment);
        for (let i = 0; i < eqKeys.length; i++) {
            walk(equipment[eqKeys[i]]);
        }
    }
    const root =
        inv.rootUid != null && containers ? containers[inv.rootUid] : null;
    if (root && Array.isArray(root.slots)) {
        for (let i = 0; i < root.slots.length; i++) {
            if (root.slots[i]) walk(root.slots[i]);
        }
    }
    return w;
}

/**
 * Cap curve (oz):
 *   Level 1 = 600, +10/level through level 8 → 670 for every vocation.
 *   After level 8, gain depends on class (mapped from classic vocations):
 *     guardian / mystic (knight / monk): +25
 *     scout (paladin):                     +20
 *     adept / warden / adventurer:         +10
 *
 * Closed forms (level ≥ 8; pre-8 always uses the +10 curve):
 *   mage / none:  10 * (level + 59)
 *   scout:        10 * (2 * level - 8 + 59)
 *   guardian/mystic: 5 * (5 * level - 5 * 8 + 134)
 *
 * Classic reference used base 400@1 / 470@8 (constants 39 / 94);
 * we raise the floor by +200 → 59 / 134.
 */

/** @type {Readonly<Record<string, string>>} engine class / legacy id → Cap band */
const CAP_CLASS_BAND = Object.freeze({
    guardian: 'guardian',
    knight: 'guardian',
    mystic: 'mystic',
    monk: 'mystic',
    scout: 'scout',
    paladin: 'scout',
    adept: 'adept',
    sorcerer: 'adept',
    warden: 'warden',
    druid: 'warden',
    adventurer: 'adventurer',
    none: 'adventurer'
});

/**
 * Resolve Cap band id from engine classId or legacy vocation string.
 * @param {string|null|undefined} classId
 * @returns {'guardian'|'mystic'|'scout'|'adept'|'warden'|'adventurer'}
 */
function resolveCapBand(classId) {
    const raw = String(classId != null ? classId : 'adventurer')
        .toLowerCase()
        .trim();
    if (CAP_CLASS_BAND[raw]) return CAP_CLASS_BAND[raw];
    // fuzzy match for profile labels ("Guardian", "Elite Knight", …)
    if (raw.includes('knight') || raw.includes('guardian')) return 'guardian';
    if (raw.includes('monk') || raw.includes('mystic')) return 'mystic';
    if (raw.includes('paladin') || raw.includes('scout') || raw.includes('ranger')) {
        return 'scout';
    }
    if (raw.includes('sorcerer') || raw.includes('adept') || raw.includes('mage')) {
        return 'adept';
    }
    if (raw.includes('druid') || raw.includes('warden')) return 'warden';
    return 'adventurer';
}

/**
 * Base Cap before weight (oz). Depends on level + vocation/class.
 * @param {number} level
 * @param {string|null|undefined} [classId] engine class id or legacy vocation
 * @returns {number}
 */
function baseCapacity(level, classId) {
    const lv = Math.max(1, Math.floor(Number(level) || 1));
    // Levels 1–7: every vocation gains +10 from a 600 baseline.
    if (lv < 8) {
        return 10 * (lv + 59);
    }
    const band = resolveCapBand(classId);
    switch (band) {
        case 'guardian':
        case 'mystic':
            return 5 * (5 * lv - 5 * 8 + 134);
        case 'scout':
            return 10 * (2 * lv - 8 + 59);
        case 'adept':
        case 'warden':
        case 'adventurer':
        default:
            return 10 * (lv + 59);
    }
}

/**
 * Remaining Cap after carried weight (weight is in centi-units; /100 → oz).
 * @param {number} level
 * @param {number} weight
 * @param {string|null|undefined} [classId]
 * @returns {number}
 */
function remainingCapacity(level, weight, classId) {
    return Math.max(
        0,
        Math.floor(baseCapacity(level, classId) - (Number(weight) || 0) / 100)
    );
}

/**
 * Equipment map of item ids for combat rollup (engine slots).
 * When leftHand holds a container (quiver), surfaces the first **matching**
 * ammo piece as `leftHandAmmo` (bow→arrow, crossbow→bolt; skips non-ammo).
 *
 * @param {Inventory|null|undefined} inv
 * @param {object[]|Record<string, object>|null} [itemDb] required to classify ammo
 * @returns {Record<string, string>}
 */
function equipmentMapFromInventory(inv, itemDb) {
    /** @type {Record<string, string>} */
    const out = Object.create(null);
    if (!inv) return out;
    const ammoKind = equippedWeaponAmmoKind(inv, itemDb);
    const keys = Object.keys(inv.equipment);
    for (let i = 0; i < keys.length; i++) {
        const slot = keys[i];
        const uid = inv.equipment[slot];
        const inst = uid ? inv.items[uid] : null;
        if (inst && inst.itemId) {
            out[slot] = inst.itemId;
            if (slot === 'leftHand' && inv.containers[uid]) {
                const ammoUid = findFirstAmmoUid(inv, uid, itemDb, ammoKind);
                if (ammoUid && inv.items[ammoUid]) {
                    out.leftHandAmmo = inv.items[ammoUid].itemId;
                }
            }
        }
    }
    return out;
}

/**
 * @returns {SeedPlaceReport}
 */
function emptySeedReport() {
    return { placed: 0, failed: 0, errors: [] };
}

/**
 * Seed entry: string itemId or { itemId, slotIndex?, contents?, count? }.
 * Stackable templates place as a single instance with `count` (merge when possible).
 * Non-stackable `count` creates that many separate instances.
 * Failures (full container, etc.) are recorded on the report — not silent.
 *
 * @param {Inventory} inv
 * @param {string} containerUid
 * @param {Array<string|object>|null|undefined} entries
 * @param {object[]|Record<string, object>|null} [itemDb]
 * @param {SeedPlaceReport} [report]
 * @returns {SeedPlaceReport}
 */
function placeSeedContents(inv, containerUid, entries, itemDb, report) {
    const rep = report || emptySeedReport();
    if (!Array.isArray(entries)) return rep;
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (entry == null) continue;
        let itemId;
        let slotIndex = null;
        let contents = null;
        let count = 1;
        if (typeof entry === 'string' || typeof entry === 'number') {
            itemId = String(entry);
        } else if (typeof entry === 'object') {
            itemId =
                entry.itemId != null
                    ? String(entry.itemId)
                    : entry.id != null
                      ? String(entry.id)
                      : '';
            if (entry.slotIndex != null) {
                slotIndex = Math.floor(Number(entry.slotIndex));
            }
            if (Array.isArray(entry.contents)) contents = entry.contents;
            if (entry.count != null && Number.isFinite(Number(entry.count))) {
                count = Math.max(1, Math.floor(Number(entry.count)));
            }
        } else {
            continue;
        }
        if (!itemId) continue;

        const template = findItem(itemDb, itemId);
        const stackable = itemIsStackable(template);

        /**
         * @param {string} uid
         * @param {number|null} idx
         * @returns {boolean}
         */
        function tryPlace(uid, idx) {
            let placed = placeInContainer(inv, uid, containerUid, idx, itemDb);
            if (!placed.ok && idx != null) {
                placed = placeInContainer(inv, uid, containerUid, null, itemDb);
            }
            if (!placed.ok) {
                destroyItem(inv, uid);
                rep.failed += 1;
                rep.errors.push({
                    itemId,
                    error: placed.error || 'place_failed',
                    count: 1
                });
                return false;
            }
            rep.placed += 1;
            const liveUid = placed.uid || uid;
            if (contents && inv.containers[liveUid]) {
                placeSeedContents(inv, liveUid, contents, itemDb, rep);
            } else if (contents && !inv.containers[liveUid] && !placed.merged) {
                // Nested contents requested but template is not a container
                rep.errors.push({
                    itemId,
                    error: 'not_a_container',
                    count: 0
                });
            }
            return true;
        }

        if (stackable) {
            // Split counts above MAX_STACK_SIZE into multiple stacks
            let remaining = count;
            let first = true;
            while (remaining > 0) {
                const chunk = Math.min(MAX_STACK_SIZE, remaining);
                const uid = createItemInstance(inv, itemId, itemDb, {
                    count: chunk
                });
                const idx = first ? slotIndex : null;
                first = false;
                if (!tryPlace(uid, idx)) break;
                remaining -= chunk;
            }
        } else {
            for (let c = 0; c < count; c++) {
                const uid = createItemInstance(inv, itemId, itemDb);
                const idx = c === 0 ? slotIndex : null;
                tryPlace(uid, idx);
            }
        }
    }
    return rep;
}

/**
 * Emit a console warning when seed placement lost items (capacity / slot).
 * @param {SeedPlaceReport|null|undefined} report
 * @param {string} [context]
 */
function warnSeedPlaceFailures(report, context) {
    if (!report || !report.failed) return;
    if (typeof console === 'undefined' || typeof console.warn !== 'function') {
        return;
    }
    const ctx = context ? ` (${context})` : '';
    const sample = report.errors
        .slice(0, 5)
        .map((e) => `${e.itemId}:${e.error}`)
        .join(', ');
    console.warn(
        `[inventory seed]${ctx} ${report.failed} placement(s) failed` +
            (sample ? ` — ${sample}` : '')
    );
}

/**
 * Build inventory from equipment map + optional backpack and container seeds.
 *
 * The equipped backpack becomes the main open inventory (`rootUid`). Seed
 * `backpack` entries are placed into that container (not a synthetic ghost).
 * If equipment omits a backpack, a default `backpack` template is equipped
 * when present in itemDb so Cap and nesting rules always have a real parent.
 *
 * @param {object|null|undefined} seed
 * @param {Record<string, string|number|null|undefined>} [seed.equipment]
 * @param {Array<string|object>} [seed.backpack]
 * @param {Record<string, Array<string|object>>} [seed.inventory]
 * @param {number} [seed.rootSlots]
 * @param {object[]|Record<string, object>|null} [itemDb]
 * @returns {Inventory}
 */
function buildInventoryFromSeed(seed, itemDb) {
    const s = seed && typeof seed === 'object' ? seed : {};
    const inv = createEmptyInventory({ rootSlots: s.rootSlots });
    // Prefer raw seed entries so `{ itemId, count }` and stackable defaults survive.
    const rawEq = s.equipment && typeof s.equipment === 'object' ? s.equipment : {};
    const eqIds = normalizeEquipmentMap(rawEq);

    /** @type {Array<{ uid: string }>} */
    const pendingStash = [];

    const slots = Object.keys(eqIds);
    for (let i = 0; i < slots.length; i++) {
        const slot = slots[i];
        // Resolve count from the raw key that produced this engine slot
        let rawVal = rawEq[slot];
        if (rawVal == null) {
            // Designer alias may have been the source key
            const rawKeys = Object.keys(rawEq);
            for (let k = 0; k < rawKeys.length; k++) {
                const rk = rawKeys[k];
                const canon = canonicalEquipmentSlot(rk) || rk;
                if (canon === slot) {
                    rawVal = rawEq[rk];
                    break;
                }
            }
        }
        const parsed = parseEquipmentSeedEntry(
            rawVal != null ? rawVal : eqIds[slot],
            itemDb
        );
        if (!parsed) continue;
        const uid = createItemInstance(inv, parsed.itemId, itemDb, {
            count: parsed.count
        });
        const r = placeInEquipment(inv, uid, slot, itemDb);
        if (!r.ok) {
            // Template rejects slot — stash after main backpack is ready
            pendingStash.push({ uid });
        }
    }

    // Main inventory = equipped backpack (auto-create starter when missing)
    ensureEquippedBackpack(inv, itemDb);

    for (let i = 0; i < pendingStash.length; i++) {
        const stash = placeInContainer(
            inv,
            pendingStash[i].uid,
            inv.rootUid,
            null,
            itemDb
        );
        if (!stash.ok) destroyItem(inv, pendingStash[i].uid);
    }

    const seedReport = emptySeedReport();
    /** @type {Set<Array>} arrays already placed (avoid double-seed by ref) */
    const placedArrays = new Set();

    /**
     * @param {Array<string|object>|null|undefined} entries
     * @param {string} containerUid
     * @param {string} label
     */
    function seedInto(entries, containerUid, label) {
        if (!Array.isArray(entries) || entries.length === 0) return;
        if (placedArrays.has(entries)) return;
        placedArrays.add(entries);
        placeSeedContents(inv, containerUid, entries, itemDb, seedReport);
    }

    if (Array.isArray(s.backpack)) {
        seedInto(s.backpack, inv.rootUid, 'backpack');
    }

    // seed.inventory: { backpack|shield|leftHand|…: entries[] }
    if (s.inventory && typeof s.inventory === 'object') {
        const invKeys = Object.keys(s.inventory);
        for (let i = 0; i < invKeys.length; i++) {
            const key = invKeys[i];
            const entries = s.inventory[key];
            if (!Array.isArray(entries) || entries.length === 0) continue;
            if (key === 'backpack' || key === 'container') {
                seedInto(entries, inv.rootUid, `inventory.${key}`);
            } else {
                const canon = canonicalEquipmentSlot(key) || key;
                const contUid = inv.equipment[canon];
                if (contUid && inv.containers[contUid]) {
                    seedInto(entries, contUid, `inventory.${key}`);
                } else if (entries.length) {
                    seedReport.failed += 1;
                    seedReport.errors.push({
                        itemId: key,
                        error: contUid
                            ? 'slot_not_container'
                            : 'slot_empty',
                        count: entries.length
                    });
                }
            }
        }
    }

    // Top-level slot shorthands (seed.shield / seed.leftHand) — used when
    // simulator flattens profile.inventory onto the seed root.
    const seedKeys = Object.keys(s);
    for (let i = 0; i < seedKeys.length; i++) {
        const key = seedKeys[i];
        if (
            key === 'backpack' ||
            key === 'equipment' ||
            key === 'inventory' ||
            key === 'rootSlots' ||
            key === 'sandbox'
        ) {
            continue;
        }
        const entries = s[key];
        if (!Array.isArray(entries) || entries.length === 0) continue;
        const canon = canonicalEquipmentSlot(key) || key;
        const contUid = inv.equipment[canon];
        if (contUid && inv.containers[contUid]) {
            seedInto(entries, contUid, key);
        }
    }

    warnSeedPlaceFailures(seedReport, 'buildInventoryFromSeed');
    return inv;
}

/**
 * Scenario-lab demo loadout: nested bags + spare equippable gear inside the
 * equipped starter backpack (main open panel). Keeps profile gear equipped;
 * adds bags + swap fodder so drag/equip/reorganize can be exercised.
 *
 * Layout (equipped backpack, typically 20 slots):
 *   [0] bag → steel_boots, leather_boots, empty bag (nesting)
 *   [1] bag → bag(oak_shield, black_shield) + iron_longsword + amber_sabre
 *   [2] adventurer_backpack → spare steel set + ring/amulet swap fodder
 *   [3] jubilee_backpack (empty 25-slot organizer)
 *   [4] bag → stackable field/missile runes (tree-search / consume demos)
 *   [5+] loose gear for quick equip from main bag (boots, helm, weapon, shield)
 *
 * The equipped backpack itself counts toward Cap and cannot be moved into its
 * own slots or nested child bags (parent container).
 *
 * @param {Record<string, string|number|null|undefined>|null|undefined} equipment
 * @param {object[]|Record<string, object>|null} [itemDb]
 * @returns {Inventory}
 */
function buildInventorySandboxSeed(equipment, itemDb) {
    return buildInventoryFromSeed(
        {
            equipment: equipment || {},
            backpack: [
                {
                    itemId: 'bag',
                    contents: [
                        'steel_boots',
                        'leather_boots',
                        { itemId: 'bag', contents: [] }
                    ]
                },
                {
                    itemId: 'bag',
                    contents: [
                        {
                            itemId: 'bag',
                            contents: ['oak_shield', 'black_shield']
                        },
                        'iron_longsword',
                        'amber_sabre'
                    ]
                },
                {
                    itemId: 'adventurer_backpack',
                    contents: [
                        'steel_helm',
                        'steel_greaves',
                        'steel_plate',
                        'albino_plate',
                        'time_ring',
                        'ancient_amulet'
                    ]
                },
                'jubilee_backpack',
                {
                    itemId: 'bag',
                    contents: [
                        { itemId: 'blaze_field_rune', count: 10 },
                        { itemId: 'blaze_bomb_rune', count: 5 },
                        { itemId: 'purge_field_rune', count: 5 },
                        { itemId: 'grand_fireburst_rune', count: 8 },
                        { itemId: 'deathburst_rune', count: 5 }
                    ]
                },
                // Loose root gear — drag onto equipment card / into bags
                'badger_boots',
                'bandana',
                'assassin_dagger',
                'battle_shield',
                'blue_legs',
                { itemId: 'bag', contents: ['bast_legs'] }
            ]
        },
        itemDb
    );
}

/**
 * Snapshot for UI / tests (plain JSON).
 * @param {Inventory|null|undefined} inv
 * @returns {object|null}
 */
function serializeInventory(inv) {
    if (!inv) return null;
    return JSON.parse(JSON.stringify(inv));
}

/**
 * Resolve designer card slot → engine slot.
 * @param {string} designerSlot
 * @returns {string|null}
 */
function designerSlotToEngine(designerSlot) {
    if (!designerSlot) return null;
    if (DESIGNER_TO_ENGINE[designerSlot]) return DESIGNER_TO_ENGINE[designerSlot];
    return canonicalEquipmentSlot(designerSlot);
}

/**
 * Resolve engine slot → designer card slot.
 * @param {string} engineSlot
 * @returns {string}
 */
function engineSlotToDesigner(engineSlot) {
    if (!engineSlot) return engineSlot;
    return ENGINE_TO_DESIGNER[engineSlot] || engineSlot;
}

module.exports = {
    DEFAULT_ROOT_SLOTS,
    ROOT_UID,
    DEFAULT_BACKPACK_ITEM_ID,
    MAX_STACK_SIZE,
    DESIGNER_EQUIP_SLOTS,
    ENGINE_TO_DESIGNER,
    DESIGNER_TO_ENGINE,
    itemIsContainer,
    itemIsMultiUse,
    itemIsUsable,
    itemIsEquipable,
    itemIsBackpackEquip,
    itemIsStackable,
    itemIsThrowingWeapon,
    itemBreakChance,
    parseEquipmentSeedEntry,
    getStackCount,
    setStackCount,
    stackRoom,
    instanceWeight,
    canMergeStacks,
    mergeStacks,
    moveItemAmount,
    findStackInContainer,
    findFirstAmmoUid,
    countAmmoInContainer,
    consumeAmmoFromContainer,
    countItemIdInInventoryTree,
    consumeItemIdFromInventory,
    equippedWeaponAmmoKind,
    countEquippedQuiverAmmo,
    consumeEquippedQuiverAmmo,
    equippedRightHandItem,
    equippedRightHandCount,
    equippedIsThrowingWeapon,
    tryBreakEquippedThrowingWeapon,
    prepareLeftHandForTwoHandedEquip,
    containerCapacity,
    createEmptyInventory,
    isRuntimeInventory,
    createItemInstance,
    getItem,
    getContainer,
    ensureItemContainer,
    detachItem,
    destroyItem,
    firstFreeSlot,
    findFirstFreeSlotBfs,
    itemSubtreeWeight,
    canCarryAdditional,
    isInsideSubtree,
    syncRootToEquippedBackpack,
    ensureEquippedBackpack,
    preferredEquipSlot,
    canEquipInSlot,
    placeInContainer,
    placeInEquipment,
    moveItem,
    equipItem,
    unequipItem,
    resolveLocationUid,
    totalCarriedWeight,
    CAP_CLASS_BAND,
    resolveCapBand,
    baseCapacity,
    remainingCapacity,
    equipmentMapFromInventory,
    placeSeedContents,
    warnSeedPlaceFailures,
    buildInventoryFromSeed,
    buildInventorySandboxSeed,
    serializeInventory,
    designerSlotToEngine,
    engineSlotToDesigner,
    EQUIPMENT_SLOTS
};
