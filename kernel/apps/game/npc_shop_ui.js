/**
 * NPC shop panel helpers (Hunt UI). Amount steps match the legacy client
 * scrollbar: Shift ±10, Ctrl ±100, Shift+Ctrl ±1000 (clamped to deal max).
 */

'use strict';

const { shopItemLabel } = require('../../core/lib/npc/shop.js');

const SHOP_AMOUNT_STEP = 1;
const SHOP_AMOUNT_STEP_SHIFT = 10;
const SHOP_AMOUNT_STEP_CTRL = 100;
const SHOP_AMOUNT_STEP_SHIFT_CTRL = 1000;

/**
 * @param {{ shiftKey?: boolean, ctrlKey?: boolean, metaKey?: boolean, shift?: boolean, ctrl?: boolean }|null|undefined} ev
 * @returns {number}
 */
function shopAmountStep(ev) {
    const shift = !!(ev && (ev.shiftKey || ev.shift));
    const ctrl = !!(ev && (ev.ctrlKey || ev.metaKey || ev.ctrl));
    if (shift && ctrl) return SHOP_AMOUNT_STEP_SHIFT_CTRL;
    if (ctrl) return SHOP_AMOUNT_STEP_CTRL;
    if (shift) return SHOP_AMOUNT_STEP_SHIFT;
    return SHOP_AMOUNT_STEP;
}

/**
 * @param {*} n
 * @param {number} [min]
 * @param {number} [max]
 * @returns {number}
 */
function clampShopAmount(n, min, max) {
    const lo = Math.max(1, Math.floor(Number(min) || 1));
    const hi = Math.max(lo, Math.floor(Number(max) || lo));
    const v = Math.floor(Number(n));
    if (!Number.isFinite(v)) return lo;
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
}

/**
 * @param {*} current
 * @param {number} direction +1 or -1
 * @param {object|null|undefined} ev
 * @param {number} [min]
 * @param {number} [max]
 * @returns {number}
 */
function applyShopAmountDelta(current, direction, ev, min, max) {
    const dir = direction < 0 ? -1 : 1;
    const base = Number(current);
    const from = Number.isFinite(base) ? base : 1;
    return clampShopAmount(from + dir * shopAmountStep(ev), min, max);
}

/**
 * Buy defaults to 1; sell defaults to the full sellable stack.
 * @param {'buy'|'sell'|string|null|undefined} side
 * @param {number} max
 * @returns {number}
 */
function defaultShopAmount(side, max) {
    const cap = Math.max(1, Math.floor(Number(max) || 1));
    if (side === 'sell') return cap;
    return 1;
}

/**
 * Case-insensitive substring on item label or id.
 * @param {object[]} rows
 * @param {string|null|undefined} query
 * @param {object[]|Record<string, object>|null} [itemDb]
 * @returns {object[]}
 */
function filterShopRowsByName(rows, query, itemDb) {
    const list = Array.isArray(rows) ? rows : [];
    const q = query != null ? String(query).trim().toLowerCase() : '';
    if (!q) return list.slice();
    const out = [];
    for (let i = 0; i < list.length; i++) {
        const row = list[i];
        if (!row) continue;
        const id = row.itemId != null ? String(row.itemId).toLowerCase() : '';
        const label = shopItemLabel(row.itemId, itemDb).toLowerCase();
        if (id.indexOf(q) >= 0 || label.indexOf(q) >= 0) out.push(row);
    }
    return out;
}

module.exports = {
    SHOP_AMOUNT_STEP,
    SHOP_AMOUNT_STEP_SHIFT,
    SHOP_AMOUNT_STEP_CTRL,
    SHOP_AMOUNT_STEP_SHIFT_CTRL,
    shopAmountStep,
    clampShopAmount,
    applyShopAmountDelta,
    defaultShopAmount,
    filterShopRowsByName
};
