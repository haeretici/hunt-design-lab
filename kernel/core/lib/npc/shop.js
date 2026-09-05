/**
 * Vendor-lite shop (Phase C.3).
 * Currency is an inventory item (default gold_coin). Buy/sell vs backpack.
 * shop.when / row.when are re-checked at open and at click (not hide-only).
 */

'use strict';

const { findItem } = require('../character/stats.js');
const { evalWhen } = require('./storage.js');
const {
    normalizeItemSpec,
    countPlayerItem,
    commitItemTransfer,
    resolveItemDb,
    transferFailText
} = require('./items.js');

const DEFAULT_CURRENCY = 'gold_coin';
const MAX_DEAL_COUNT = 100;

/**
 * @typedef {{
 *   itemId: string,
 *   buy: number,
 *   sell: number,
 *   when?: *
 * }} ShopRow
 * @typedef {{
 *   currency: string,
 *   when?: *,
 *   denyText?: string,
 *   items: ShopRow[]
 * }} Shop
 */

/**
 * @param {*} raw
 * @returns {number}
 */
function nonNegInt(raw) {
    if (raw == null || raw === '') return 0;
    const n = Math.floor(Number(raw));
    return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * @param {*} raw
 * @param {number} [fallback]
 * @returns {number}
 */
function dealCount(raw, fallback) {
    const base = fallback != null && Number.isFinite(Number(fallback)) ? Number(fallback) : 1;
    const n = raw != null && raw !== '' ? Math.floor(Number(raw)) : Math.floor(base);
    if (!Number.isFinite(n) || n < 1) return 1;
    return Math.min(MAX_DEAL_COUNT, n);
}

/**
 * Normalize a shop object. Null when unusable.
 * @param {object|null|undefined} raw
 * @returns {Shop|null}
 */
function normalizeShop(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const currencySpec = normalizeItemSpec(
        raw.currency != null ? raw.currency : DEFAULT_CURRENCY,
        1
    );
    const currency = currencySpec ? currencySpec.itemId : DEFAULT_CURRENCY;
    /** @type {ShopRow[]} */
    const items = [];
    const list = Array.isArray(raw.items) ? raw.items : [];
    for (let i = 0; i < list.length; i++) {
        const row = list[i];
        if (!row || typeof row !== 'object') continue;
        const spec = normalizeItemSpec(
            row.itemId != null ? row.itemId : row.item,
            1
        );
        if (!spec) continue;
        if (spec.itemId === currency) continue;
        const buy = nonNegInt(row.buy);
        const sell = nonNegInt(row.sell);
        if (buy < 1 && sell < 1) continue;
        /** @type {ShopRow} */
        const out = { itemId: spec.itemId, buy, sell };
        if (row.when != null) out.when = JSON.parse(JSON.stringify(row.when));
        items.push(out);
    }
    /** @type {Shop} */
    const shop = { currency, items };
    if (raw.when != null) shop.when = JSON.parse(JSON.stringify(raw.when));
    if (raw.denyText != null && String(raw.denyText).trim()) {
        shop.denyText = String(raw.denyText).trim();
    }
    return shop;
}

/**
 * Creature `shop` wins, then inline `dialog.shop`.
 * @param {object|null|undefined} source
 * @returns {Shop|null}
 */
function resolveShop(source) {
    if (!source || typeof source !== 'object') return null;
    if (source.shop != null) {
        const shop = normalizeShop(source.shop);
        if (shop) return shop;
    }
    if (source.dialog && typeof source.dialog === 'object' && source.dialog.shop) {
        return normalizeShop(source.dialog.shop);
    }
    if (Array.isArray(source.items) || source.currency != null) {
        return normalizeShop(source);
    }
    return null;
}

/**
 * Open-shop gate. Missing `when` → allow. No player + `when` → deny.
 * @param {object|null|undefined} player
 * @param {Shop|null|undefined} shop
 * @returns {boolean}
 */
function shopMatchesWhen(player, shop) {
    if (!shop) return false;
    if (shop.when == null) return true;
    if (!player) return false;
    return evalWhen(player, shop.when);
}

/**
 * @param {Shop|null|undefined} shop
 * @param {string} itemId
 * @returns {ShopRow|null}
 */
function findShopRow(shop, itemId) {
    if (!shop || !Array.isArray(shop.items) || itemId == null) return null;
    const id = String(itemId).trim();
    if (!id) return null;
    for (let i = 0; i < shop.items.length; i++) {
        const row = shop.items[i];
        if (row && row.itemId === id) return row;
    }
    return null;
}

/**
 * Visible shop rows. `when` hides unless the player matches (no player → hide).
 * @param {Shop|null|undefined} shop
 * @param {object|null|undefined} [player]
 * @param {{ side?: 'buy'|'sell'|'all' }} [opts]
 * @returns {ShopRow[]}
 */
function listShopRows(shop, player, opts) {
    if (!shop || !Array.isArray(shop.items)) return [];
    const side = opts && opts.side ? String(opts.side) : 'all';
    const out = [];
    for (let i = 0; i < shop.items.length; i++) {
        const row = shop.items[i];
        if (!row) continue;
        if (side === 'buy' && row.buy < 1) continue;
        if (side === 'sell' && row.sell < 1) continue;
        if (row.when != null) {
            if (!player || !evalWhen(player, row.when)) continue;
        }
        out.push(row);
    }
    return out;
}

/**
 * Slider / deal cap for one row. Always ≥ 1 so the amount control still works
 * when the player cannot currently afford / does not own the item (click still
 * re-checks and FCT-fails). Buy is limited by currency; sell by backpack count.
 * @param {object|null|undefined} player
 * @param {Shop|null|undefined} shop
 * @param {ShopRow|null|undefined} row
 * @param {'buy'|'sell'|string|null|undefined} side
 * @returns {number}
 */
function shopDealMax(player, shop, row, side) {
    if (!row) return 1;
    if (side === 'sell') {
        const have = countPlayerItem(player, row.itemId);
        if (have < 1) return 1;
        return Math.min(MAX_DEAL_COUNT, have);
    }
    const unit = row.buy;
    if (!(unit > 0)) return 1;
    const money = shop ? countPlayerItem(player, shop.currency) : 0;
    const byMoney = Math.floor(money / unit);
    if (byMoney < 1) return 1;
    return Math.min(MAX_DEAL_COUNT, byMoney);
}

/**
 * @param {object|null|undefined} player
 * @param {ShopRow|null|undefined} row
 * @returns {boolean}
 */
function rowMatchesWhen(player, row) {
    if (!row) return false;
    if (row.when == null) return true;
    if (!player) return false;
    return evalWhen(player, row.when);
}

/**
 * Player buys `count` of itemId (pays currency * buy).
 * Re-checks row.when. All-or-nothing.
 * @param {object|null|undefined} player
 * @param {Shop|null|undefined} shop
 * @param {string} itemId
 * @param {number} [count]
 * @param {object[]|Record<string, object>|null} [itemDb]
 * @returns {{ ok: boolean, reason?: string, itemId?: string, count?: number, paid?: number }}
 */
function buyFromShop(player, shop, itemId, count, itemDb) {
    if (!shop) return { ok: false, reason: 'no_shop' };
    const row = findShopRow(shop, itemId);
    if (!row || row.buy < 1) {
        return { ok: false, reason: 'not_sold', itemId: itemId != null ? String(itemId) : '' };
    }
    if (!rowMatchesWhen(player, row)) {
        return { ok: false, reason: 'row_when', itemId: row.itemId };
    }
    const n = dealCount(count, 1);
    const paid = row.buy * n;
    if (countPlayerItem(player, shop.currency) < paid) {
        return {
            ok: false,
            reason: 'cannot_afford',
            itemId: row.itemId,
            count: n,
            paid
        };
    }
    const moved = commitItemTransfer(
        player,
        {
            take: { itemId: shop.currency, count: paid },
            give: { itemId: row.itemId, count: n }
        },
        itemDb || resolveItemDb(player, null)
    );
    if (!moved.ok) return moved;
    return { ok: true, itemId: row.itemId, count: n, paid };
}

/**
 * Player sells `count` of itemId (receives currency * sell).
 * Re-checks row.when. All-or-nothing. Backpack only.
 * @param {object|null|undefined} player
 * @param {Shop|null|undefined} shop
 * @param {string} itemId
 * @param {number} [count]
 * @param {object[]|Record<string, object>|null} [itemDb]
 * @returns {{ ok: boolean, reason?: string, itemId?: string, count?: number, earned?: number }}
 */
function sellToShop(player, shop, itemId, count, itemDb) {
    if (!shop) return { ok: false, reason: 'no_shop' };
    const row = findShopRow(shop, itemId);
    if (!row || row.sell < 1) {
        return { ok: false, reason: 'not_bought', itemId: itemId != null ? String(itemId) : '' };
    }
    if (!rowMatchesWhen(player, row)) {
        return { ok: false, reason: 'row_when', itemId: row.itemId };
    }
    const n = dealCount(count, 1);
    if (countPlayerItem(player, row.itemId) < n) {
        return {
            ok: false,
            reason: 'no_item',
            itemId: row.itemId,
            count: n
        };
    }
    const earned = row.sell * n;
    const moved = commitItemTransfer(
        player,
        {
            take: { itemId: row.itemId, count: n },
            give: { itemId: shop.currency, count: earned }
        },
        itemDb || resolveItemDb(player, null)
    );
    if (!moved.ok) return moved;
    return { ok: true, itemId: row.itemId, count: n, earned };
}

/**
 * Honest FCT for shop open / buy / sell. Null when the reason is not a shop fail.
 * @param {string|null|undefined} reason
 * @param {{ text?: string, side?: string }|null|undefined} [extra]
 * @returns {string|null}
 */
function shopFailText(reason, extra) {
    const r = reason != null ? String(reason) : '';
    if (r === 'no_shop') return 'Nothing to sell.';
    if (r === 'shop_when') {
        if (extra && extra.text != null && String(extra.text).trim()) {
            return String(extra.text).trim();
        }
        return 'I do not trade with you.';
    }
    if (r === 'row_when') {
        return extra && extra.side === 'sell'
            ? 'I cannot buy that.'
            : 'I cannot sell you that.';
    }
    if (r === 'not_sold') return 'I do not sell that.';
    if (r === 'not_bought') return 'I do not buy that.';
    if (r === 'cannot_afford') return 'You cannot afford that.';
    if (r === 'unknown_item') {
        return extra && extra.side === 'sell'
            ? 'I cannot buy that.'
            : 'I cannot sell you that.';
    }
    return transferFailText(r);
}

/**
 * Display label for an item id.
 * @param {string} itemId
 * @param {object[]|Record<string, object>|null} [itemDb]
 * @returns {string}
 */
function shopItemLabel(itemId, itemDb) {
    const id = itemId != null ? String(itemId) : '';
    if (!id) return '';
    const item = findItem(itemDb, id);
    if (item && item.label != null && String(item.label).trim()) {
        return String(item.label).trim();
    }
    return id;
}

module.exports = {
    DEFAULT_CURRENCY,
    MAX_DEAL_COUNT,
    normalizeShop,
    resolveShop,
    shopMatchesWhen,
    findShopRow,
    listShopRows,
    shopDealMax,
    rowMatchesWhen,
    buyFromShop,
    sellToShop,
    shopFailText,
    shopItemLabel,
    dealCount
};
