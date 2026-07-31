/**
 * Catalog equipment → combat item stats (Stage 9).
 *
 * Resolution:
 *   1. Explicit presets/equipment.json item (full combat stats) wins by id
 *   2. assets/data/<genre>/equipment.json row + category defaults + row.combat
 *
 * buildItemDb() merges both for rollup / party editors.
 */

'use strict';

const {
    EQUIPMENT_CATEGORY_DEFAULTS,
    EQUIPMENT_COMBAT_KEYS
} = require('./defaults.js');
const { DEFAULT_GENRE } = require('../../../settings.js');

/**
 * Look up category default bag.
 * @param {string|null|undefined} category
 * @returns {object|null}
 */
function categoryDefaults(category) {
    if (!category) return null;
    const key = String(category).toLowerCase();
    return EQUIPMENT_CATEGORY_DEFAULTS[key] || null;
}

/**
 * Fill missing combat fields from category defaults + optional combat partial.
 *
 * @param {object} item partial item (must have id; ideally category)
 * @param {object} [opts]
 * @param {object} [opts.categoryTable] override EQUIPMENT_CATEGORY_DEFAULTS
 * @returns {object} combat-ready item (new object)
 */
function fillEquipmentCombatDefaults(item, opts) {
    if (!item || !item.id) {
        throw new Error('fillEquipmentCombatDefaults: item.id required');
    }
    const options = opts || {};
    const table = options.categoryTable || EQUIPMENT_CATEGORY_DEFAULTS;
    const cat = item.category ? String(item.category).toLowerCase() : null;
    const fromCat = (cat && table[cat]) || null;
    const combatSrc =
        item.combat && typeof item.combat === 'object' ? item.combat : {};

    /** @type {Record<string, any>} */
    const out = {
        id: item.id,
        label: item.label || item.alias || item.technical || item.id,
        technical: item.technical || null,
        alias: item.alias || null,
        genre: item.genre || null,
        category: item.category || (fromCat && fromCat.category) || null,
        tags: Array.isArray(item.tags) ? item.tags.slice() : [],
        sprites: item.sprites || null,
        source: item.source || 'catalog'
    };

    // Layer: category defaults → top-level combat keys → combat object
    if (fromCat) {
        for (let i = 0; i < EQUIPMENT_COMBAT_KEYS.length; i++) {
            const k = EQUIPMENT_COMBAT_KEYS[i];
            if (fromCat[k] !== undefined) {
                out[k] =
                    typeof fromCat[k] === 'object' && fromCat[k] !== null
                        ? Object.assign({}, fromCat[k])
                        : fromCat[k];
            }
        }
    }

    for (let i = 0; i < EQUIPMENT_COMBAT_KEYS.length; i++) {
        const k = EQUIPMENT_COMBAT_KEYS[i];
        if (item[k] !== undefined && item[k] !== null) {
            out[k] =
                typeof item[k] === 'object' && !Array.isArray(item[k])
                    ? Object.assign({}, item[k])
                    : item[k];
        }
    }

    for (let i = 0; i < EQUIPMENT_COMBAT_KEYS.length; i++) {
        const k = EQUIPMENT_COMBAT_KEYS[i];
        if (combatSrc[k] !== undefined && combatSrc[k] !== null) {
            out[k] =
                typeof combatSrc[k] === 'object' && !Array.isArray(combatSrc[k])
                    ? Object.assign({}, combatSrc[k])
                    : combatSrc[k];
        }
    }

    // Slot fallback from category if still missing
    if (!out.slot && fromCat && fromCat.slot) out.slot = fromCat.slot;
    if (!out.weaponType && fromCat && fromCat.weaponType) {
        out.weaponType = fromCat.weaponType;
    }

    // Numeric zeros
    if (out.atk == null) out.atk = 0;
    if (out.armor == null) out.armor = 0;
    if (out.defense == null) out.defense = 0;
    if (out.speed == null) out.speed = 0;
    if (out.weight == null) out.weight = 0;

    return out;
}

/**
 * Catalog equipment row → combat item.
 * @param {object} entry
 * @param {object} [opts]
 * @returns {object}
 */
function catalogItemToCombatItem(entry, opts) {
    return fillEquipmentCombatDefaults(entry, opts);
}

/**
 * Index items by id (last wins).
 * @param {object[]} items
 * @returns {Record<string, object>}
 */
function indexById(items) {
    /** @type {Record<string, object>} */
    const map = Object.create(null);
    if (!Array.isArray(items)) return map;
    for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it && it.id) map[it.id] = it;
    }
    return map;
}

/**
 * Merge preset combat gear with catalog-derived items.
 * Preset entries win on id collision (they already have tuned stats).
 *
 * @param {object} [opts]
 * @param {object[]} [opts.presetItems] from presets/equipment.json
 * @param {object[]} [opts.catalogItems] raw catalog rows (or pre-filled)
 * @param {boolean} [opts.fillCatalog=true] apply category defaults to catalog
 * @param {string} [opts.genre]
 * @param {boolean} [opts.loadCatalogFromDisk=false]
 * @returns {object[]} merged combat items
 */
function buildItemDb(opts) {
    const options = opts || {};
    /** @type {object[]} */
    let catalogRows = Array.isArray(options.catalogItems)
        ? options.catalogItems
        : [];

    if (
        (!catalogRows.length && options.loadCatalogFromDisk !== false) ||
        options.loadCatalogFromDisk === true
    ) {
        // Only auto-load when caller did not pass catalogItems and disk wanted
        if (!Array.isArray(options.catalogItems)) {
            try {
                const { loadCatalog } = require('../creature_manifest.js');
                const genre = options.genre || DEFAULT_GENRE;
                const cat = loadCatalog(genre, { kind: 'equipment' });
                catalogRows = cat.creatures || [];
            } catch (_) {
                catalogRows = [];
            }
        }
    }

    const fill = options.fillCatalog !== false;
    /** @type {Record<string, object>} */
    const byId = Object.create(null);

    for (let i = 0; i < catalogRows.length; i++) {
        const row = catalogRows[i];
        if (!row || !row.id) continue;
        byId[row.id] = fill
            ? catalogItemToCombatItem(row, options)
            : Object.assign({}, row);
    }

    const presets = Array.isArray(options.presetItems) ? options.presetItems : [];
    for (let i = 0; i < presets.length; i++) {
        const it = presets[i];
        if (!it || !it.id) continue;
        // Preset wins; still ensure label
        byId[it.id] = Object.assign(
            {
                label: it.label || it.id,
                source: it.source || 'preset'
            },
            it
        );
    }

    return Object.keys(byId).map((k) => byId[k]);
}

/**
 * Resolve one item by id from merged db or live load.
 * @param {string} itemId
 * @param {{
 *   itemDb?: object[]|Record<string, object>,
 *   getPresetItem?: (id: string) => object|null,
 *   genre?: string
 * }} [opts]
 * @returns {object|null}
 */
function resolveEquipmentItem(itemId, opts) {
    if (!itemId) return null;
    const options = opts || {};

    if (options.itemDb) {
        const db = options.itemDb;
        if (Array.isArray(db)) {
            for (let i = 0; i < db.length; i++) {
                if (db[i] && db[i].id === itemId) return db[i];
            }
        } else if (db[itemId]) {
            return db[itemId];
        }
    }

    if (typeof options.getPresetItem === 'function') {
        const p = options.getPresetItem(itemId);
        if (p) return Object.assign({ source: 'preset' }, p);
    }

    try {
        const { loadCatalog, findById } = require('../creature_manifest.js');
        const genre = options.genre || DEFAULT_GENRE;
        const cat = loadCatalog(genre, { kind: 'equipment' });
        const entry = findById(cat, itemId);
        if (entry) return catalogItemToCombatItem(entry);
    } catch (_) {
        /* ignore */
    }
    return null;
}

module.exports = {
    categoryDefaults,
    fillEquipmentCombatDefaults,
    catalogItemToCombatItem,
    indexById,
    buildItemDb,
    resolveEquipmentItem
};
