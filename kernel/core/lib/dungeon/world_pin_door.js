/**
 * W3 free door + W4 gated door: USE toggles closed/open catalog + walk block.
 * Gated: evalWhen / player.level / lockId (require, consume if authored).
 */

'use strict';

const { getItem } = require('../character/inventory.js');
const { evalWhen } = require('../npc/storage.js');
const { countPlayerItem, takeItemFromPlayer } = require('../npc/items.js');
const { applyChestTransform } = require('./world_pin_chest.js');
const {
    applyWorldPinWalkBlock,
    restoreWorldPinWalkBlock
} = require('./world_pin_seed.js');

const DOOR_LOCKED_TEXT = 'The door is locked.';
const DOOR_CANNOT_PASS_TEXT = 'You cannot pass yet.';

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
        closedId: inst.worldPinClosedId || '',
        openId: inst.worldPinOpenId || '',
        gate: inst.worldPinGate || null,
        lockId: inst.worldPinLockId || '',
        consume: !!inst.worldPinConsume
    };
}

/**
 * @param {object|null|undefined} player
 * @returns {number}
 */
function playerLevel(player) {
    const n = player && player.level != null ? Number(player.level) : 1;
    return Number.isFinite(n) ? n : 1;
}

/**
 * @param {object|null|undefined} inst
 * @param {object|null|undefined} pin
 * @returns {boolean}
 */
function doorIsGated(inst, pin) {
    const src = pin || inst;
    if (!src) return false;
    if (src.gate || src.worldPinGate) return true;
    const lock =
        src.lockId != null
            ? String(src.lockId).trim()
            : src.worldPinLockId != null
              ? String(src.worldPinLockId).trim()
              : '';
    return !!lock;
}

/**
 * @param {object|null|undefined} inst
 * @returns {boolean}
 */
function isDoorOpen(inst) {
    return !!(inst && inst.worldPinDoorOpen);
}

/**
 * @param {object|null|undefined} player
 * @param {object|null|undefined} inst
 * @param {object|null|undefined} pin
 * @returns {{
 *   ok: boolean,
 *   reason?: string,
 *   text?: string,
 *   lockId?: string,
 *   consume?: boolean,
 *   unlocked?: boolean
 * }}
 */
function evalDoorGates(player, inst, pin) {
    const src = pin || pinFromInst(inst, null) || {};
    const gate = src.gate || (inst && inst.worldPinGate) || null;
    if (gate && typeof gate === 'object') {
        const when =
            gate.when != null
                ? gate.when
                : gate.storage != null ||
                    gate.item != null ||
                    gate.itemId != null ||
                    gate.key != null
                  ? gate
                  : null;
        if (when != null && !evalWhen(player, when)) {
            return {
                ok: false,
                reason: 'cannot_pass',
                text: DOOR_CANNOT_PASS_TEXT
            };
        }
        if (gate.level != null) {
            const need = Math.floor(Number(gate.level));
            if (Number.isFinite(need) && playerLevel(player) < need) {
                return {
                    ok: false,
                    reason: 'cannot_pass',
                    text: DOOR_CANNOT_PASS_TEXT
                };
            }
        }
    }
    const lockId =
        src.lockId != null
            ? String(src.lockId).trim()
            : inst && inst.worldPinLockId
              ? String(inst.worldPinLockId).trim()
              : '';
    const consume = src.consume === true || !!(inst && inst.worldPinConsume);
    const unlocked = !!(inst && inst.worldPinUnlocked);
    if (lockId && !unlocked) {
        if (countPlayerItem(player, lockId) < 1) {
            return { ok: false, reason: 'locked', text: DOOR_LOCKED_TEXT };
        }
    }
    return { ok: true, lockId, consume, unlocked };
}

/**
 * Open or close a seeded door instance (friction + catalog). Occupancy stays
 * creature-only; walk is the baked friction channel.
 *
 * @param {object|null|undefined} inst
 * @param {boolean} open
 * @param {{ tileMap?: object|null, itemDb?: object|null }} [opts]
 * @returns {{ ok: boolean, reason?: string, changed?: boolean, open?: boolean }}
 */
function setDoorOpen(inst, open, opts) {
    if (!inst || inst.worldPinKind !== 'door') {
        return { ok: false, reason: 'not_door' };
    }
    const want = !!open;
    if (!!inst.worldPinDoorOpen === want) {
        return { ok: true, changed: false, open: want };
    }
    const o = opts || {};
    const loc = inst.location || {};
    const x = loc.x;
    const y = loc.y;
    const z = loc.z !== undefined && loc.z !== null ? loc.z : 0;
    const tileMap = o.tileMap || null;
    const itemDb = o.itemDb || null;
    if (want) {
        restoreWorldPinWalkBlock(tileMap, inst, x, y, z);
        inst.worldPinBlocking = false;
        const openId =
            inst.worldPinOpenId != null ? String(inst.worldPinOpenId).trim() : '';
        if (openId) applyChestTransform(inst, openId, itemDb);
    } else {
        applyWorldPinWalkBlock(tileMap, inst, x, y, z);
        inst.worldPinBlocking = true;
        const closedId =
            inst.worldPinClosedId != null
                ? String(inst.worldPinClosedId).trim()
                : '';
        if (closedId) applyChestTransform(inst, closedId, itemDb);
    }
    inst.worldPinDoorOpen = want;
    return { ok: true, changed: true, open: want };
}

/**
 * Hunt USE on `kind: door`. Free toggle if no gate/lockId. Gated open evaluates
 * when/level/key; closing is always free. Caller enforces Chebyshev ≤ 1.
 *
 * @param {object|null|undefined} player
 * @param {object|null|undefined} inst
 * @param {{ tileMap?: object|null, itemDb?: object|null, pin?: object|null }} [opts]
 * @returns {{ ok: boolean, reason?: string, text?: string, open?: boolean }}
 */
function useWorldDoor(player, inst, opts) {
    const o = opts || {};
    if (!inst || inst.worldPinKind !== 'door') {
        return {
            ok: false,
            reason: 'not_door',
            text: 'You cannot use this object.'
        };
    }
    const pin = pinFromInst(inst, o.pin);
    const opening = !inst.worldPinDoorOpen;
    if (opening && doorIsGated(inst, pin)) {
        const gate = evalDoorGates(player, inst, pin);
        if (!gate.ok) {
            return { ok: false, reason: gate.reason, text: gate.text };
        }
        if (gate.lockId && gate.consume && !gate.unlocked) {
            const taken = takeItemFromPlayer(player, {
                itemId: gate.lockId,
                count: 1
            });
            if (!taken.ok) {
                return { ok: false, reason: 'locked', text: DOOR_LOCKED_TEXT };
            }
            if (typeof player.applyInventoryMutation === 'function') {
                player.applyInventoryMutation();
            }
            inst.worldPinUnlocked = true;
        }
    }
    const next = !inst.worldPinDoorOpen;
    const r = setDoorOpen(inst, next, o);
    return { ok: r.ok, open: next, changed: r.changed };
}

/**
 * @param {object|null|undefined} player
 * @param {object|null|undefined} ground
 * @param {string} uid
 * @param {{ tileMap?: object|null, itemDb?: object|null, pin?: object|null }} [opts]
 * @returns {ReturnType<typeof useWorldDoor>}
 */
function useWorldDoorAt(player, ground, uid, opts) {
    if (!ground || !ground.inventory || uid == null || String(uid) === '') {
        return {
            ok: false,
            reason: 'not_door',
            text: 'You cannot use this object.'
        };
    }
    const inst = getItem(ground.inventory, uid);
    const o = opts || {};
    return useWorldDoor(player, inst, {
        tileMap: o.tileMap || ground.tileMap || null,
        itemDb: o.itemDb || null,
        pin: o.pin || null
    });
}

module.exports = {
    DOOR_LOCKED_TEXT,
    DOOR_CANNOT_PASS_TEXT,
    doorIsGated,
    isDoorOpen,
    evalDoorGates,
    setDoorOpen,
    useWorldDoor,
    useWorldDoorAt
};
