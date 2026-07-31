/**
 * Catalog creature → combat template (Stage 9).
 *
 * Resolution order for an id:
 *   1. Explicit presets/creatures/<id>.json (full combat template)
 *   2. assets/data/<genre>/creatures.json row + optional row.combat + defaults
 *   3. null (caller may fall back)
 *
 * Pure fill helpers work without disk; resolve* needs Node or injectors.
 */

'use strict';

const {
    DEFAULT_CREATURE_COMBAT,
    CREATURE_TIER_SCALES,
    CREATURE_COMBAT_KEYS
} = require('./defaults.js');
const { DEFAULT_RESISTS } = require('../character/stats.js');
const { DEFAULT_GENRE } = require('../../../settings.js');

/**
 * Infer tier scale from entry.combatTier or first matching tag.
 * @param {object} entry
 * @returns {number}
 */
function tierScaleFor(entry) {
    if (!entry) return 1;
    const tier =
        entry.combatTier ||
        (entry.combat && entry.combat.tier) ||
        null;
    if (tier && CREATURE_TIER_SCALES[tier] != null) {
        return CREATURE_TIER_SCALES[tier];
    }
    const tags = entry.tags;
    if (Array.isArray(tags)) {
        for (let i = 0; i < tags.length; i++) {
            const t = String(tags[i]).toLowerCase();
            if (CREATURE_TIER_SCALES[t] != null) return CREATURE_TIER_SCALES[t];
        }
    }
    return 1;
}

/**
 * Scale numeric combat fields by tier multiplier.
 * Kit offense: attacks[].min/max (+ condition.totalDamage).
 * @param {object} base
 * @param {number} scale
 * @returns {object}
 */
function applyTierScale(base, scale) {
    if (!scale || scale === 1) return base;
    const out = Object.assign({}, base);
    const keys = ['hp', 'hpMax', 'exp', 'armor', 'mitigation', 'lootValue'];
    for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (out[k] != null && typeof out[k] === 'number') {
            out[k] = Math.max(1, Math.round(out[k] * scale));
        }
    }
    if (Array.isArray(out.attacks)) {
        out.attacks = out.attacks.map((raw) => {
            if (!raw || typeof raw !== 'object') return raw;
            const a = Object.assign({}, raw);
            if (a.min != null && Number.isFinite(Number(a.min))) {
                a.min = Math.max(0, Math.round(Number(a.min) * scale));
            }
            if (a.max != null && Number.isFinite(Number(a.max))) {
                a.max = Math.max(0, Math.round(Number(a.max) * scale));
            }
            if (
                a.min != null &&
                a.max != null &&
                Number(a.max) < Number(a.min)
            ) {
                const t = a.min;
                a.min = a.max;
                a.max = t;
            }
            if (a.condition && typeof a.condition === 'object') {
                const c = Object.assign({}, a.condition);
                if (
                    c.totalDamage != null &&
                    Number.isFinite(Number(c.totalDamage))
                ) {
                    c.totalDamage = Math.max(
                        0,
                        Math.round(Number(c.totalDamage) * scale)
                    );
                }
                a.condition = c;
            }
            return a;
        });
    }
    return out;
}

/**
 * Merge combat partial over defaults (only known combat keys + resists).
 * @param {object} [partial]
 * @param {object} [base] defaults to DEFAULT_CREATURE_COMBAT
 * @returns {object}
 */
/**
 * Deep-clone a JSON-safe attacks/defenseSpells list (or return []).
 * @param {*} list
 * @returns {object[]}
 */
function cloneCombatList(list) {
    if (!Array.isArray(list)) return [];
    return JSON.parse(JSON.stringify(list));
}

function fillCreatureCombatDefaults(partial, base) {
    const src = partial && typeof partial === 'object' ? partial : {};
    const defaults = base || DEFAULT_CREATURE_COMBAT;
    /** @type {Record<string, any>} */
    const out = Object.create(null);

    for (let i = 0; i < CREATURE_COMBAT_KEYS.length; i++) {
        const k = CREATURE_COMBAT_KEYS[i];
        if (
            k === 'resists' ||
            k === 'attacks' ||
            k === 'defenseSpells' ||
            k === 'flags'
        ) {
            continue;
        }
        if (src[k] !== undefined && src[k] !== null) {
            out[k] = src[k];
        } else if (defaults[k] !== undefined) {
            out[k] = defaults[k];
        }
    }

    // Keep hp / hpMax in sync when only one side is author-supplied
    const srcHasHp = src.hp !== undefined && src.hp !== null;
    const srcHasHpMax = src.hpMax !== undefined && src.hpMax !== null;
    if (srcHasHp && !srcHasHpMax) out.hpMax = out.hp;
    else if (srcHasHpMax && !srcHasHp) out.hp = out.hpMax;
    else if (out.hpMax == null && out.hp != null) out.hpMax = out.hp;
    else if (out.hp == null && out.hpMax != null) out.hp = out.hpMax;

    out.resists = Object.assign(
        {},
        DEFAULT_RESISTS,
        defaults.resists || {},
        src.resists || {}
    );

    out.aggro = src.aggro !== undefined ? !!src.aggro : defaults.aggro !== false;
    out.canBlock =
        src.canBlock !== undefined ? !!src.canBlock : !!defaults.canBlock;

    // flags: shallow-merge defaults under author flags (targetDistance, etc.)
    const defFlags =
        defaults.flags && typeof defaults.flags === 'object'
            ? defaults.flags
            : null;
    const srcFlags =
        src.flags && typeof src.flags === 'object' ? src.flags : null;
    if (defFlags || srcFlags) {
        out.flags = Object.assign({}, defFlags || {}, srcFlags || {});
    }

    // Offense: explicit attacks[] wins (including empty = no hits). Missing →
    // weak default melee so catalog-only creatures are not inert shells.
    if (Array.isArray(src.attacks)) {
        out.attacks = cloneCombatList(src.attacks);
    } else if (Array.isArray(defaults.attacks)) {
        out.attacks = cloneCombatList(defaults.attacks);
    } else {
        out.attacks = [];
    }

    if (Array.isArray(src.defenseSpells)) {
        out.defenseSpells = cloneCombatList(src.defenseSpells);
    } else if (Array.isArray(src.defense_spells)) {
        out.defenseSpells = cloneCombatList(src.defense_spells);
    } else if (Array.isArray(defaults.defenseSpells)) {
        out.defenseSpells = cloneCombatList(defaults.defenseSpells);
    }

    return out;
}

/**
 * Build a combat template from a catalog creature row (art metadata).
 * Uses entry.combat (if present) + tier scale + defaults.
 *
 * @param {object} entry catalog row (id, alias, technical, combat?, tags?, …)
 * @param {object} [opts]
 * @param {number} [opts.tierScale] override scale
 * @returns {object} combat template (id, label, sprites?, source, …stats)
 */
function catalogEntryToCombatTemplate(entry, opts) {
    if (!entry || !entry.id) {
        throw new Error('catalogEntryToCombatTemplate: entry.id required');
    }
    const options = opts || {};
    const combatSrc = entry.combat && typeof entry.combat === 'object' ? entry.combat : {};
    // Top-level combat keys on the row also count (optional convenience)
    const partial = Object.assign({}, combatSrc);
    for (let i = 0; i < CREATURE_COMBAT_KEYS.length; i++) {
        const k = CREATURE_COMBAT_KEYS[i];
        if (k === 'resists') continue;
        if (entry[k] !== undefined && partial[k] === undefined) {
            partial[k] = entry[k];
        }
    }
    if (entry.resists && !partial.resists) partial.resists = entry.resists;
    if (
        Array.isArray(entry.attacks) &&
        !Array.isArray(partial.attacks)
    ) {
        partial.attacks = entry.attacks;
    }
    if (
        Array.isArray(entry.defenseSpells) &&
        !Array.isArray(partial.defenseSpells)
    ) {
        partial.defenseSpells = entry.defenseSpells;
    }
    if (
        entry.flags &&
        typeof entry.flags === 'object' &&
        !(partial.flags && typeof partial.flags === 'object')
    ) {
        partial.flags = entry.flags;
    }

    let filled = fillCreatureCombatDefaults(partial);
    const scale =
        options.tierScale != null ? options.tierScale : tierScaleFor(entry);
    filled = applyTierScale(filled, scale);

    /** @type {Record<string, any>} */
    const meta = {
        id: entry.id,
        label: entry.alias || entry.technical || entry.id,
        technical: entry.technical || null,
        genre: entry.genre || null,
        sprites: entry.sprites || null,
        tags: Array.isArray(entry.tags) ? entry.tags.slice() : [],
        source: 'catalog',
        combatTier:
            entry.combatTier ||
            (combatSrc.tier != null ? combatSrc.tier : null)
    };
    // Species visual size (presentation); not a combat key.
    const ds =
        entry.displayScale != null
            ? Number(entry.displayScale)
            : combatSrc.displayScale != null
              ? Number(combatSrc.displayScale)
              : null;
    if (ds != null && Number.isFinite(ds) && ds > 0) {
        meta.displayScale = ds;
    } else {
        meta.displayScale = 1;
    }

    return Object.assign(meta, filled);
}

/**
 * Find a catalog entry by id in one or more genre catalogs.
 * @param {string} creatureId
 * @param {{ genre?: string, genres?: string[], loadCatalog?: Function, findById?: Function }} [opts]
 * @returns {object|null}
 */
function findCatalogCreature(creatureId, opts) {
    const options = opts || {};
    if (!creatureId) return null;

    let loadCatalog = options.loadCatalog;
    let findById = options.findById;
    if (!loadCatalog || !findById) {
        try {
            const manifest = require('../creature_manifest.js');
            loadCatalog = loadCatalog || manifest.loadCatalog;
            findById = findById || manifest.findById;
        } catch (_) {
            return null;
        }
    }

    const genres =
        Array.isArray(options.genres) && options.genres.length
            ? options.genres
            : [options.genre || DEFAULT_GENRE];

    for (let i = 0; i < genres.length; i++) {
        const catalog = loadCatalog(genres[i], { kind: 'creatures' });
        const entry = findById(catalog, creatureId);
        if (entry) return entry;
    }
    return null;
}

/**
 * Resolve combat template: preset file → catalog + defaults → null.
 *
 * Callers (presets.js) should pass `loadPresetTemplate` that reads only
 * `presets/creatures/<id>.json` (no catalog recursion).
 *
 * @param {string} creatureId
 * @param {{
 *   genre?: string,
 *   genres?: string[],
 *   loadPresetTemplate?: (id: string) => object|null,
 *   loadCatalog?: Function,
 *   findById?: Function
 * }} [opts]
 * @returns {object|null}
 */
function resolveCreatureTemplate(creatureId, opts) {
    const options = opts || {};
    if (!creatureId) return null;

    if (typeof options.loadPresetTemplate === 'function') {
        try {
            const preset = options.loadPresetTemplate(creatureId);
            if (preset) return preset;
        } catch (_) {
            /* try catalog */
        }
    }

    const entry = findCatalogCreature(creatureId, options);
    if (!entry) return null;
    return catalogEntryToCombatTemplate(entry);
}

module.exports = {
    tierScaleFor,
    applyTierScale,
    fillCreatureCombatDefaults,
    catalogEntryToCombatTemplate,
    findCatalogCreature,
    resolveCreatureTemplate
};
