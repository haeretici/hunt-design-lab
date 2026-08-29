/**
 * W5 tool Use-with: rope on ROPE_SPOT, shovel on SHOVEL_SPOT.
 * Flags are enough; optional pin `tag` / `to` / `transformOnUse`.
 * Do not consume the tool. Same-hunt floors only. Not step-on.
 */

'use strict';

const { countPlayerItem } = require('../npc/items.js');
const { applyChestTransform } = require('./world_pin_chest.js');
const { worldPinInstAtTile } = require('./world_pin_seed.js');
const {
    TILE_FLAG_ROPE_SPOT,
    TILE_FLAG_SHOVEL_SPOT
} = require('./tile_roles.js');
const {
    TELEPORT_NO_DEST_TEXT,
    TELEPORT_NO_WAY_TEXT,
    TELEPORT_CANNOT_TEXT
} = require('./world_pin_teleport.js');

const TOOL_ROLES = Object.freeze({
    rope: { flag: TILE_FLAG_ROPE_SPOT, deltaZ: -1 },
    shovel: { flag: TILE_FLAG_SHOVEL_SPOT, deltaZ: 1 }
});

const TOOL_RANGE = 1;

/**
 * @param {string|null|undefined} itemId
 * @returns {'rope'|'shovel'|null}
 */
function resolveToolRole(itemId) {
    const id = itemId != null ? String(itemId).trim().toLowerCase() : '';
    if (!id) return null;
    if (id === 'rope' || id === 'shovel') return id;
    if (/(^|_)rope(_|$)/.test(id)) return 'rope';
    if (/(^|_)shovel(_|$)/.test(id)) return 'shovel';
    return null;
}

/**
 * @param {string|null|undefined} itemId
 * @returns {boolean}
 */
function isWorldToolItem(itemId) {
    return resolveToolRole(itemId) != null;
}

/**
 * @param {{ x?: number, y?: number, z?: string|number }|null|undefined} a
 * @param {{ x?: number, y?: number, z?: string|number }|null|undefined} b
 * @returns {number}
 */
function chebyshevSameFloor(a, b) {
    if (!a || !b) return Infinity;
    const az = a.z != null ? a.z : 0;
    const bz = b.z != null ? b.z : 0;
    if (String(az) !== String(bz)) return Infinity;
    const dx = Math.abs(Math.round(Number(a.x)) - Math.round(Number(b.x)));
    const dy = Math.abs(Math.round(Number(a.y)) - Math.round(Number(b.y)));
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return Infinity;
    return Math.max(dx, dy);
}

/**
 * @param {object|null|undefined} inst
 * @param {string} role
 * @returns {boolean}
 */
function pinMatchesTool(inst, role) {
    if (!inst || !role) return false;
    const tag = inst.worldPinTag != null ? String(inst.worldPinTag).trim().toLowerCase() : '';
    return tag === role;
}

/**
 * @param {object|null|undefined} inst
 * @returns {{ x: number, y: number, z: string|number }|null}
 */
function pinToolTo(inst) {
    const src = inst && inst.worldPinTo;
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
 * Hunt Use-with on a rope/shovel spot. Caller may pass a ground pin on the
 * tile (`tag` matches role without flags; `to` overrides dest).
 *
 * @param {object|null|undefined} player
 * @param {{ itemId?: string, x?: number, y?: number, z?: string|number }} cmd
 * @param {{
 *   tileMap?: object|null,
 *   ground?: object|null,
 *   itemDb?: object[]|Record<string, object>|null
 * }} [opts]
 * @returns {{
 *   ok: boolean,
 *   reason?: string,
 *   text?: string,
 *   role?: string,
 *   to?: { x: number, y: number, z: string|number }
 * }}
 */
function useWorldToolWith(player, cmd, opts) {
    const o = opts || {};
    const role = resolveToolRole(cmd && cmd.itemId);
    if (!role) {
        return { ok: false, reason: 'not_tool', text: TELEPORT_CANNOT_TEXT };
    }
    if (!player) {
        return { ok: false, reason: 'no_player', text: TELEPORT_CANNOT_TEXT };
    }
    const heldId = String(cmd.itemId).trim();
    if (countPlayerItem(player, heldId) < 1) {
        return { ok: false, reason: 'no_item', text: TELEPORT_CANNOT_TEXT };
    }
    const x = Math.round(Number(cmd && cmd.x));
    const y = Math.round(Number(cmd && cmd.y));
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return { ok: false, reason: 'no_tile', text: TELEPORT_CANNOT_TEXT };
    }
    const z = cmd && cmd.z != null ? cmd.z : player.tile && player.tile.z != null ? player.tile.z : 0;
    if (chebyshevSameFloor(player.tile, { x, y, z }) > TOOL_RANGE) {
        return { ok: false, reason: 'too_far', text: TELEPORT_CANNOT_TEXT };
    }
    const tileMap = o.tileMap || null;
    const ground = o.ground || null;
    const inst = worldPinInstAtTile(ground, x, y, z);
    const spec = TOOL_ROLES[role];
    const flags =
        tileMap && typeof tileMap.getTileFlags === 'function'
            ? tileMap.getTileFlags(x, y, z) | 0
            : 0;
    const flagged = !!(spec && (flags & spec.flag));
    if (!flagged && !pinMatchesTool(inst, role)) {
        return { ok: false, reason: 'no_spot', text: TELEPORT_CANNOT_TEXT };
    }
    let to = pinToolTo(inst);
    if (!to) {
        const delta = spec && spec.deltaZ != null ? spec.deltaZ : 0;
        const zNum = Number(z);
        to = {
            x,
            y,
            z: Number.isFinite(zNum) ? zNum + delta : z
        };
    }
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
    const reveal =
        inst && inst.worldPinTransformOnUse != null
            ? inst.worldPinTransformOnUse
            : '';
    if (typeof reveal === 'string' && reveal.trim()) {
        applyChestTransform(inst, reveal.trim(), o.itemDb || null);
    }
    return { ok: true, role, to };
}

module.exports = {
    TOOL_ROLES,
    TOOL_RANGE,
    resolveToolRole,
    isWorldToolItem,
    useWorldToolWith,
    TELEPORT_NO_DEST_TEXT,
    TELEPORT_NO_WAY_TEXT,
    TELEPORT_CANNOT_TEXT
};
