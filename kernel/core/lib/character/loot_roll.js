/**
 * Creature loot roller. Pure: `loot[]` + itemDb + rng → dropped items.
 * No world mutation (death fill lives in ground_items / simulator).
 *
 * Chance scale is 1e5: drop if `floor(rng() * 100000) < chance`.
 * Unknown ids are skipped (once-per-session warn). Nested `child` / `childLoot`
 * is ignored v1 (parent still rolls).
 */

'use strict';

const { findItem } = require('./stats.js');

/** LootBlock chance denominator (0 never, 100000 always). */
const MAX_LOOT_CHANCE = 100000;

const warnedUnknown = new Set();
let warnedChild = false;

/**
 * @param {*} v
 * @param {number} fallback
 * @returns {number}
 */
function asInt(v, fallback) {
    if (v == null || v === '') return fallback;
    const n = Math.floor(Number(v));
    return Number.isFinite(n) ? n : fallback;
}

/**
 * @param {*} raw
 * @returns {number}
 */
function parseChance(raw) {
    const n = asInt(raw, 0);
    if (n <= 0) return 0;
    if (n >= MAX_LOOT_CHANCE) return MAX_LOOT_CHANCE;
    return n;
}

/**
 * @param {string} s
 * @returns {string}
 */
function slugName(s) {
    return String(s)
        .toLowerCase()
        .trim()
        .replace(/\s+/g, '_');
}

/**
 * @param {object[]|Record<string, object>|null|undefined} itemDb
 * @param {function(object): void} fn
 */
function forEachItem(itemDb, fn) {
    if (!itemDb) return;
    if (Array.isArray(itemDb)) {
        for (let i = 0; i < itemDb.length; i++) {
            if (itemDb[i]) fn(itemDb[i]);
        }
        return;
    }
    const keys = Object.keys(itemDb);
    for (let i = 0; i < keys.length; i++) {
        const row = itemDb[keys[i]];
        if (row) fn(row);
    }
}

/**
 * Name fallback when `row.id` is missing. Tries id, slug, then label/name.
 * @param {object[]|Record<string, object>|null|undefined} itemDb
 * @param {string} name
 * @returns {object|null}
 */
function findItemByName(itemDb, name) {
    const key = String(name).trim();
    if (!key) return null;
    const byId = findItem(itemDb, key);
    if (byId) return byId;
    const slug = slugName(key);
    if (slug && slug !== key) {
        const bySlug = findItem(itemDb, slug);
        if (bySlug) return bySlug;
    }
    const want = key.toLowerCase();
    let found = null;
    forEachItem(itemDb, (row) => {
        if (found) return;
        const label = row.label != null ? String(row.label).trim() : '';
        const nm = row.name != null ? String(row.name).trim() : '';
        if (label.toLowerCase() === want || nm.toLowerCase() === want) found = row;
    });
    return found;
}

/**
 * `row.id` else `name` → template. Id present but unknown does not fall through.
 * @param {object} row
 * @param {object[]|Record<string, object>|null|undefined} itemDb
 * @returns {object|null}
 */
function resolveLootItem(row, itemDb) {
    const id = row.id != null && String(row.id).trim() !== '' ? String(row.id).trim() : '';
    if (id) return findItem(itemDb, id) || null;
    const name =
        row.name != null && String(row.name).trim() !== '' ? String(row.name).trim() : '';
    if (!name) return null;
    return findItemByName(itemDb, name);
}

/**
 * @param {string} key
 */
function warnUnknown(key) {
    if (warnedUnknown.has(key)) return;
    warnedUnknown.add(key);
    if (typeof console === 'undefined' || typeof console.warn !== 'function') return;
    console.warn(`[loot_roll] unknown item, skipped: ${key}`);
}

function warnChild() {
    if (warnedChild) return;
    warnedChild = true;
    if (typeof console === 'undefined' || typeof console.warn !== 'function') return;
    console.warn('[loot_roll] nested child loot ignored');
}

/**
 * @param {string} reason
 * @param {object} row
 * @param {object} [extra]
 * @returns {object}
 */
function skipNote(reason, row, extra) {
    const note = { reason };
    if (row && row.id != null && String(row.id).trim() !== '') note.id = row.id;
    if (row && row.name != null && String(row.name).trim() !== '') note.name = row.name;
    if (extra) Object.assign(note, extra);
    return note;
}

/**
 * @param {object} template
 * @returns {boolean}
 */
function templateIsStackable(template) {
    return !!(template && template.stackable === true);
}

/**
 * Roll template `loot[]` into `{ itemId, count }` rows. Deterministic when `rng`
 * is a stub `() => number` in `[0, 1)`.
 *
 * @param {Array<object>|null|undefined} lootRows
 * @param {object[]|Record<string, object>|null|undefined} itemDb
 * @param {function(): number} [rng]
 * @returns {{ items: Array<{ itemId: string, count: number }>, skipped: object[] }}
 */
function rollCreatureLoot(lootRows, itemDb, rng) {
    const items = [];
    const skipped = [];
    const rand = typeof rng === 'function' ? rng : Math.random.bind(Math);
    if (!Array.isArray(lootRows)) return { items, skipped };

    for (let i = 0; i < lootRows.length; i++) {
        const row = lootRows[i];
        if (!row || typeof row !== 'object' || Array.isArray(row)) continue;

        if (row.child != null || row.childLoot != null) {
            skipped.push(skipNote('child_ignored', row));
            warnChild();
        }

        const template = resolveLootItem(row, itemDb);
        if (!template) {
            const key =
                row.id != null && String(row.id).trim() !== ''
                    ? String(row.id).trim()
                    : row.name != null && String(row.name).trim() !== ''
                      ? String(row.name).trim()
                      : '(empty)';
            skipped.push(skipNote('unknown_item', row));
            warnUnknown(key);
            continue;
        }

        const chance = parseChance(row.chance);
        const roll = Math.floor(rand() * MAX_LOOT_CHANCE);
        if (!(roll < chance)) continue;

        let minCount = asInt(
            row.minCount != null ? row.minCount : row.countmin,
            1
        );
        let maxCount = asInt(
            row.maxCount != null ? row.maxCount : row.countmax,
            minCount
        );
        if (minCount < 0) minCount = 0;
        if (maxCount < minCount) maxCount = minCount;

        const count =
            minCount === maxCount
                ? minCount
                : minCount + Math.floor(rand() * (maxCount - minCount + 1));
        if (count <= 0) {
            skipped.push(skipNote('count_zero', row, { itemId: String(template.id) }));
            continue;
        }

        const itemId = String(template.id);
        if (templateIsStackable(template)) {
            items.push({ itemId, count });
        } else {
            for (let n = 0; n < count; n++) {
                items.push({ itemId, count: 1 });
            }
        }
    }

    return { items, skipped };
}

/**
 * Watch FCT line: `Loot of {label}: {names}` or `…: nothing` when empty.
 * Count prefixes stack rows (`20 Gold Coin`). No color markup.
 *
 * @param {string|null|undefined} creatureLabel
 * @param {Array<{ itemId: string, count?: number }>|null|undefined} items
 * @param {object[]|Record<string, object>|null|undefined} itemDb
 * @returns {string}
 */
function formatLootMessage(creatureLabel, items, itemDb) {
    const label =
        creatureLabel != null && String(creatureLabel).trim()
            ? String(creatureLabel).trim()
            : 'creature';
    if (!Array.isArray(items) || items.length === 0) {
        return 'Loot of ' + label + ': nothing';
    }
    const names = [];
    for (let i = 0; i < items.length; i++) {
        const row = items[i];
        if (!row || row.itemId == null || String(row.itemId).trim() === '') continue;
        const itemId = String(row.itemId).trim();
        const template = findItem(itemDb, itemId);
        const name =
            (template && template.label != null && String(template.label).trim()) ||
            (template && template.name != null && String(template.name).trim()) ||
            itemId;
        let count = 1;
        if (row.count != null && Number.isFinite(Number(row.count))) {
            count = Math.max(1, Math.floor(Number(row.count)));
        }
        names.push(count > 1 ? count + ' ' + name : name);
    }
    if (!names.length) return 'Loot of ' + label + ': nothing';
    return 'Loot of ' + label + ': ' + names.join(', ');
}

module.exports = {
    MAX_LOOT_CHANCE,
    rollCreatureLoot,
    formatLootMessage
};
