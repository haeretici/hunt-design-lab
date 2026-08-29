/**
 * W4 teleport pad: USE hops to `to`. Same-hunt floors only. No reverse pad
 * unless a second pin exists. Use, not step-on.
 */

'use strict';

const { getItem } = require('../character/inventory.js');

const TELEPORT_NO_DEST_TEXT = 'There is no destination.';
const TELEPORT_NO_WAY_TEXT = 'There is no way.';
const TELEPORT_CANNOT_TEXT = 'You cannot use this object.';

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
        to: inst.worldPinTo || null
    };
}

/**
 * @param {object|null|undefined} inst
 * @param {object|null|undefined} pin
 * @returns {{ x: number, y: number, z: string|number }|null}
 */
function resolveTeleportTo(inst, pin) {
    const src =
        (pin && pin.to) || (inst && inst.worldPinTo) || null;
    if (!src || typeof src !== 'object') return null;
    const x = Math.round(Number(src.x));
    const y = Math.round(Number(src.y));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const z =
        src.z !== undefined && src.z !== null
            ? src.z
            : inst && inst.location && inst.location.z != null
              ? inst.location.z
              : 0;
    return { x, y, z };
}

/**
 * Hunt USE on `kind: teleport`. Caller enforces Chebyshev ≤ 1. Lands on the
 * exact dest (stair hop occupancy). Dest floor must already be on the hunt map.
 *
 * @param {object|null|undefined} player
 * @param {object|null|undefined} inst
 * @param {{ tileMap?: object|null, pin?: object|null }} [opts]
 * @returns {{
 *   ok: boolean,
 *   reason?: string,
 *   text?: string,
 *   to?: { x: number, y: number, z: string|number }
 * }}
 */
function useWorldTeleport(player, inst, opts) {
    const o = opts || {};
    if (!player || !inst || inst.worldPinKind !== 'teleport') {
        return {
            ok: false,
            reason: 'not_teleport',
            text: TELEPORT_CANNOT_TEXT
        };
    }
    const pin = pinFromInst(inst, o.pin);
    const to = resolveTeleportTo(inst, pin);
    if (!to) {
        return { ok: false, reason: 'no_dest', text: TELEPORT_NO_DEST_TEXT };
    }
    const tileMap = o.tileMap || null;
    if (
        !tileMap ||
        typeof tileMap.getLayer !== 'function' ||
        typeof tileMap.moveEntityToTile !== 'function'
    ) {
        return { ok: false, reason: 'no_dest', text: TELEPORT_NO_DEST_TEXT };
    }
    if (!tileMap.getLayer(to.z)) {
        return { ok: false, reason: 'no_dest', text: TELEPORT_NO_DEST_TEXT };
    }
    const hopped = tileMap.moveEntityToTile(player, to.x, to.y, to.z, {
        reason: 'stair'
    });
    if (!hopped) {
        return { ok: false, reason: 'blocked', text: TELEPORT_NO_WAY_TEXT };
    }
    if (Array.isArray(player.path)) player.path = [];
    return { ok: true, to };
}

/**
 * @param {object|null|undefined} player
 * @param {object|null|undefined} ground
 * @param {string} uid
 * @param {{ tileMap?: object|null, pin?: object|null }} [opts]
 * @returns {ReturnType<typeof useWorldTeleport>}
 */
function useWorldTeleportAt(player, ground, uid, opts) {
    if (!ground || !ground.inventory || uid == null || String(uid) === '') {
        return {
            ok: false,
            reason: 'not_teleport',
            text: TELEPORT_CANNOT_TEXT
        };
    }
    const inst = getItem(ground.inventory, uid);
    const o = opts || {};
    return useWorldTeleport(player, inst, {
        tileMap: o.tileMap || ground.tileMap || null,
        pin: o.pin || null
    });
}

module.exports = {
    TELEPORT_NO_DEST_TEXT,
    TELEPORT_NO_WAY_TEXT,
    TELEPORT_CANNOT_TEXT,
    resolveTeleportTo,
    useWorldTeleport,
    useWorldTeleportAt
};
