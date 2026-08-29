/**
 * Patch baked TileMap channels in place (one cell). Used by World pins
 * (lever / door). Do not invent nested data[z][y][x]; do not rebake.
 */

'use strict';

/**
 * @param {*} v
 * @returns {number|null}
 */
function clampByte(v) {
    const n = Math.floor(Number(v));
    if (!Number.isFinite(n)) return null;
    if (n < 0) return 0;
    if (n > 255) return 255;
    return n;
}

/**
 * Ensure a Uint8 channel the same length as friction.
 * @param {object} layer
 * @param {'sight'|'flags'|'fields'} name
 * @returns {Uint8Array|null}
 */
function ensureChannel(layer, name) {
    if (!layer || !layer.friction) return null;
    const n = layer.friction.length;
    let buf = layer[name];
    if (!buf || buf.length < n) {
        buf = new Uint8Array(n);
        layer[name] = buf;
    }
    return buf;
}

/**
 * Patch one baked cell. Missing channels in `patch` are left unchanged.
 * Invalidates the watch terrain cache when a byte changes.
 *
 * @param {object|null|undefined} tileMap
 * @param {{
 *   x: number,
 *   y: number,
 *   z?: string|number,
 *   friction?: number,
 *   sight?: number,
 *   flags?: number,
 *   fields?: number
 * }} patch
 * @returns {{
 *   ok: boolean,
 *   reason?: string,
 *   changed?: boolean,
 *   prev?: { friction: number, sight: number, flags: number, fields: number }
 * }}
 */
function applyCellPatch(tileMap, patch) {
    if (!tileMap || !patch || typeof tileMap.getLayer !== 'function') {
        return { ok: false, reason: 'bad_args' };
    }
    const x = Math.round(Number(patch.x));
    const y = Math.round(Number(patch.y));
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return { ok: false, reason: 'bad_args' };
    }
    const z = patch.z !== undefined && patch.z !== null ? patch.z : 0;
    const layer = tileMap.getLayer(z);
    if (!layer || !layer.friction) return { ok: false, reason: 'no_layer' };
    if (x < 0 || y < 0 || x >= layer.cols || y >= layer.rows) {
        return { ok: false, reason: 'oob' };
    }
    const idx =
        typeof tileMap.index === 'function'
            ? tileMap.index(x, y, layer.cols)
            : y * layer.cols + x;
    const prev = {
        friction: layer.friction[idx] & 0xff,
        sight: layer.sight ? layer.sight[idx] & 0xff : 0,
        flags: layer.flags ? layer.flags[idx] & 0xff : 0,
        fields: layer.fields ? layer.fields[idx] & 0xff : 0
    };
    let changed = false;
    if (patch.friction != null) {
        const v = clampByte(patch.friction);
        if (v != null && layer.friction[idx] !== v) {
            layer.friction[idx] = v;
            changed = true;
        }
    }
    if (patch.sight != null) {
        const v = clampByte(patch.sight);
        const buf = ensureChannel(layer, 'sight');
        if (v != null && buf && buf[idx] !== v) {
            buf[idx] = v;
            changed = true;
        }
    }
    if (patch.flags != null) {
        const v = clampByte(patch.flags);
        const buf = ensureChannel(layer, 'flags');
        if (v != null && buf && buf[idx] !== v) {
            buf[idx] = v;
            changed = true;
        }
    }
    if (patch.fields != null) {
        const v = clampByte(patch.fields);
        const buf = ensureChannel(layer, 'fields');
        if (v != null && buf && buf[idx] !== v) {
            buf[idx] = v;
            changed = true;
        }
    }
    if (changed && typeof tileMap.invalidateRenderCache === 'function') {
        tileMap.invalidateRenderCache();
    }
    return { ok: true, changed, prev };
}

module.exports = {
    applyCellPatch,
    clampByte
};
