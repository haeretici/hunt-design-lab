/**
 * Character / equipment stat rollup (Stage 4).
 * Pure functions: class definition + gear → effective combat stats.
 * No window / DOM; safe in headless.
 */

const EQUIPMENT_SLOTS = [
    'amulet',
    'helmet',
    'armor',
    'legs',
    'boots',
    'rightHand',
    'leftHand',
    'ring'
];

/**
 * Designer / profile slot names → engine combat slots used by rollup.
 * Profile JSON and player_profiles.schema use head/chest/weapon/shield;
 * hunts and party editor use helmet/armor/rightHand/leftHand.
 * @type {Readonly<Record<string, string>>}
 */
const EQUIPMENT_SLOT_ALIASES = Object.freeze({
    head: 'helmet',
    helmet: 'helmet',
    chest: 'armor',
    body: 'armor',
    armor: 'armor',
    weapon: 'rightHand',
    righthand: 'rightHand',
    rightHand: 'rightHand',
    shield: 'leftHand',
    lefthand: 'leftHand',
    leftHand: 'leftHand',
    legs: 'legs',
    boots: 'boots',
    feet: 'boots',
    amulet: 'amulet',
    necklace: 'amulet',
    neck: 'amulet',
    ring: 'ring',
    backpack: 'backpack',
    bag: 'backpack',
    container: 'backpack'
});

const DEFAULT_RESISTS = {
    physical: 0,
    fire: 0,
    ice: 0,
    energy: 0,
    earth: 0,
    holy: 0,
    death: 0
};

/** Untrained floors: weapon bags 10, magic 0 (legacy vocation start). */
const DEFAULT_SKILLS = {
    melee: 10,
    distance: 10,
    shielding: 10,
    magic: 0
    // fist is optional: when unset, unarmed primary skill falls back to melee
};

/**
 * Legacy unarmed right-hand defaults (no weapon equipped).
 * Matches legacy PlayerStats.getBaseStats: atk 7, weaponDefense 5, fist.
 */
const UNARMED_ATK = 7;
const UNARMED_WEAPON_DEFENSE = 5;
/** Rollup marker for empty right hand; effective attack family is still melee. */
const UNARMED_WEAPON_TYPE = 'fist';

/**
 * Equipment catalog stores crit extra / leech *amount* as pipeline units.
 * Divide by this to get percent: 1000 = 10%, 1800 = 18%.
 * Leech *chance* is already 0–100 (100 = always).
 */
const COMBAT_PIPELINE_PER_PERCENT = 100;

/**
 * Catalog pipeline units → percent.
 * @param {unknown} n
 * @returns {number}
 */
function pipelineToPercent(n) {
    return (Number(n) || 0) / COMBAT_PIPELINE_PER_PERCENT;
}

/**
 * Compact percent number for UI (no % suffix). 1000 → "10", 50 → "0.5".
 * @param {unknown} n
 * @returns {string}
 */
function formatPipelinePercent(n) {
    const v = pipelineToPercent(n);
    if (!Number.isFinite(v)) return '0';
    return String(Math.round(v * 1000) / 1000);
}

/**
 * Player-facing crit / leech lines for a catalog equipment or spell row.
 * Converts pipeline units; leech chance and already-percent aliases stay as stored.
 * @param {object|null|undefined} item
 * @returns {string[]}
 */
function catalogSpecialBonusLines(item) {
    const row = item && typeof item === 'object' ? item : {};
    const lines = [];
    if (row.lifeLeech) lines.push(`Life Leech: ${row.lifeLeech}%`);
    if (row.lifeLeechChance != null && row.lifeLeechAmount != null) {
        lines.push(
            `Life Leech: ${row.lifeLeechChance}% / ${formatPipelinePercent(row.lifeLeechAmount)}%`
        );
    }
    if (row.manaLeech) lines.push(`Mana Leech: ${row.manaLeech}%`);
    if (row.manaLeechChance != null && row.manaLeechAmount != null) {
        lines.push(
            `Mana Leech: ${row.manaLeechChance}% / ${formatPipelinePercent(row.manaLeechAmount)}%`
        );
    }
    if (row.critChance) {
        lines.push(`Crit Chance: ${formatPipelinePercent(row.critChance)}%`);
    }
    if (row.critDamage) lines.push(`Crit Damage: ${row.critDamage}%`);
    if (row.critExtraDamage != null) {
        lines.push(`Crit Extra Dmg: ${formatPipelinePercent(row.critExtraDamage)}%`);
    }
    return lines;
}

/** Profile / legacy skill keys that collapse into engine `melee`. */
const MELEE_SKILL_ALIASES = ['sword', 'axe', 'club', 'fist'];

/**
 * Melee skill subtypes used by formula / skillKey (legacy weapon skill names).
 * Combat primary value: prefer bag[subtype] when present; else collapsed skills.melee.
 * Fist prefers skills.fist, then melee. See resolvePrimarySkillValue + docs/27 §D.2.
 */
const MELEE_WEAPON_SKILLS = ['sword', 'axe', 'club', 'fist'];

/** Item categories that count as a right-hand weapon (not unarmed). */
const WEAPON_CATEGORIES = [
    'sword',
    'axe',
    'club',
    'mace',
    'dagger',
    'bow',
    'crossbow',
    'spear',
    'staff',
    'wand',
    'rod',
    'fist',
    'throwing'
];

/** Distance weapons that use ammo atk + weapon atk as a modifier (legacy bow/xbow). */
const DISTANCE_AMMO_WEAPON_CATEGORIES = ['bow', 'crossbow'];

/**
 * Flat defense used for mitigation when wielding a bow/crossbow without a shield
 * (classic distance set contribution; not used for shield block).
 */
const BOW_MITIGATION_DEFENSE = 18;

/** Max successful block attempts per shielding window (legacy). */
const SHIELD_BLOCK_MAX_PER_WINDOW = 2;
/** Shielding window length in seconds before the block counter resets. */
const SHIELD_BLOCK_WINDOW_SEC = 2;

/**
 * Whether an item is ammunition (temporary: equippable in leftHand like quivers).
 * @param {object|null|undefined} item
 * @returns {boolean}
 */
function itemIsAmmo(item) {
    if (!item) return false;
    if (item.category === 'ammo' || item.category === 'ammunition') return true;
    if (Array.isArray(item.type) && item.type.indexOf('ammunition') >= 0) {
        return true;
    }
    return false;
}

/**
 * Normalize free-form ammo type tokens to `'arrow'` | `'bolt'` | null.
 * @param {unknown} raw
 * @returns {'arrow'|'bolt'|null}
 */
function normalizeAmmoTypeToken(raw) {
    if (raw == null) return null;
    // Fast path: exact catalog values (no alloc)
    if (raw === 'arrow' || raw === 'bolt') return raw;
    const a = String(raw).toLowerCase().trim();
    if (a === 'bolt' || a === 'bolts') return 'bolt';
    if (a === 'arrow' || a === 'arrows') return 'arrow';
    return null;
}

/**
 * Ammo family for bow/crossbow matching: `'arrow'` | `'bolt'` | null.
 * Prefer explicit `ammoType` (`arrow`/`bolt` — O(1)), then `type[]`, then
 * id/label heuristics for legacy rows without the field.
 * @param {object|null|undefined} item
 * @returns {'arrow'|'bolt'|null}
 */
function itemAmmoKind(item) {
    if (!itemIsAmmo(item)) return null;
    // Hot path: catalog ammoType
    const fromField = normalizeAmmoTypeToken(item.ammoType);
    if (fromField) return fromField;
    if (Array.isArray(item.type)) {
        for (let i = 0; i < item.type.length; i++) {
            const k = normalizeAmmoTypeToken(item.type[i]);
            if (k) return k;
        }
    }
    const s = `${item.id || ''} ${item.label || item.name || ''}`.toLowerCase();
    if (s.indexOf('bolt') >= 0) return 'bolt';
    if (s.indexOf('arrow') >= 0) return 'arrow';
    return null;
}

/**
 * Required ammo family for a weapon template.
 * Bows (category `bow`/`bows`) → arrows; crossbows → bolts; else null.
 * @param {object|null|undefined} weapon
 * @returns {'arrow'|'bolt'|null}
 */
function weaponRequiredAmmoKind(weapon) {
    if (!weapon) return null;
    const cat =
        weapon.category != null ? String(weapon.category).toLowerCase() : '';
    if (cat === 'bow' || cat === 'bows') return 'arrow';
    if (cat === 'crossbow' || cat === 'crossbows') return 'bolt';
    if (Array.isArray(weapon.type)) {
        for (let i = 0; i < weapon.type.length; i++) {
            const t = String(weapon.type[i]).toLowerCase();
            if (t === 'bow' || t === 'bows') return 'arrow';
            if (t === 'crossbow' || t === 'crossbows') return 'bolt';
        }
    }
    return null;
}

/**
 * Whether an equipment template is two-handed.
 * @param {object|null|undefined} item
 * @returns {boolean}
 */
function itemIsTwoHanded(item) {
    if (!item) return false;
    return (
        item.twoHanded === true ||
        item.twoHanded === 'true' ||
        item.twoHanded === 1
    );
}

/**
 * Whether a template is a quiver (leftHand ammo container).
 * @param {object|null|undefined} item
 * @returns {boolean}
 */
function itemIsQuiver(item) {
    if (!item) return false;
    const cat =
        item.category != null ? String(item.category).toLowerCase() : '';
    if (cat === 'quiver') return true;
    if (Array.isArray(item.type)) {
        for (let i = 0; i < item.type.length; i++) {
            if (String(item.type[i]).toLowerCase() === 'quiver') return true;
        }
    }
    return false;
}

/**
 * Whether a weapon is bow or crossbow (ammo-fed distance category).
 * @param {object|null|undefined} item weapon template
 * @returns {boolean}
 */
function itemIsBowOrCrossbowWeapon(item) {
    return weaponRequiredAmmoKind(item) != null;
}

/**
 * Whether an item is a shield / spellbook defense piece (not ammo or quiver).
 * @param {object|null|undefined} item
 * @returns {boolean}
 */
function itemIsShield(item) {
    if (!item || itemIsAmmo(item)) return false;
    if (itemIsQuiver(item)) return false;
    if (item.weaponType === 'shield' || item.category === 'shield') return true;
    if (item.category === 'spellbook') return true;
    if (item.tags && item.tags.indexOf('shield') >= 0) return true;
    return false;
}

/**
 * Map a free-form category / type token to an engine weapon skill key.
 * @param {string|null|undefined} token
 * @returns {string|null} sword|axe|club|fist|distance|magic|melee|null
 */
function mapTokenToWeaponSkill(token) {
    if (token == null || token === '') return null;
    const k = String(token).toLowerCase();
    if (k === 'sword' || k === 'axe' || k === 'club' || k === 'fist') return k;
    // legacy: maces → club skill, daggers → sword skill
    if (k === 'mace') return 'club';
    if (k === 'dagger') return 'sword';
    if (k === 'bow' || k === 'crossbow' || k === 'spear' || k === 'throwing') {
        return 'distance';
    }
    if (k === 'wand' || k === 'rod' || k === 'staff') return 'magic';
    if (k === 'distance' || k === 'ranged') return 'distance';
    if (k === 'magic') return 'magic';
    if (k === 'melee') return 'melee';
    return null;
}

/**
 * Resolve the combat skill driven by a weapon item (legacy parity).
 * Prefer single `category` (port taxonomy); fall back to `type[]` then family.
 *
 * @param {object|null|undefined} item
 * @returns {string|null} skill key for skillKey / primary skill selection
 */
function resolveWeaponSkillFromItem(item) {
    if (!item || typeof item !== 'object') return null;

    const fromCat = mapTokenToWeaponSkill(item.category);
    if (fromCat) return fromCat;

    const types = Array.isArray(item.type)
        ? item.type
        : item.type != null && item.type !== ''
          ? [item.type]
          : [];
    for (let i = 0; i < types.length; i++) {
        const fromType = mapTokenToWeaponSkill(types[i]);
        // Prefer concrete melee subtypes over generic family tokens if mixed
        if (fromType && MELEE_WEAPON_SKILLS.indexOf(fromType) >= 0) return fromType;
        if (fromType === 'distance' || fromType === 'magic') return fromType;
    }
    for (let i = 0; i < types.length; i++) {
        const fromType = mapTokenToWeaponSkill(types[i]);
        if (fromType) return fromType;
    }

    return mapTokenToWeaponSkill(item.weaponType);
}

/**
 * Normalize a skill bag (class, profile, or overrides) to engine keys.
 * Profile standard: sword/axe/club/fist kept when present (subtype-first combat);
 * collapsed `melee` = explicit melee or max of subtypes (compat / class floors);
 * magicLevel → magic; distance/shielding pass through.
 *
 * @param {object|null|undefined} skills
 * @returns {Record<string, number>|null} only keys that were present / derived
 */
function normalizeSkillBag(skills) {
    if (!skills || typeof skills !== 'object') return null;
    /** @type {Record<string, number>} */
    const out = Object.create(null);

    // Fist is first-class (unarmed skillKey) and also feeds the melee max.
    if (skills.fist != null && skills.fist !== '') {
        const f = Math.max(0, Number(skills.fist) || 0);
        if (Number.isFinite(f)) out.fist = f;
    }

    // Preserve sword/axe/club separately when authored or trained (Phase D).
    for (let i = 0; i < MELEE_SKILL_ALIASES.length; i++) {
        const k = MELEE_SKILL_ALIASES[i];
        if (k === 'fist') continue;
        if (skills[k] == null || skills[k] === '') continue;
        const n = Number(skills[k]);
        if (Number.isFinite(n)) out[k] = Math.max(0, n);
    }

    if (skills.melee != null && skills.melee !== '') {
        out.melee = Math.max(0, Number(skills.melee) || 0);
    } else {
        let best = null;
        for (let i = 0; i < MELEE_SKILL_ALIASES.length; i++) {
            const k = MELEE_SKILL_ALIASES[i];
            if (skills[k] == null || skills[k] === '') continue;
            const n = Number(skills[k]);
            if (!Number.isFinite(n)) continue;
            if (best == null || n > best) best = n;
        }
        if (best != null) out.melee = Math.max(0, best);
    }

    // Collapsed melee at least max of preserved subtypes
    if (out.melee != null) {
        for (const k of ['sword', 'axe', 'club']) {
            if (out[k] != null) out.melee = Math.max(out.melee, out[k]);
        }
    }

    if (skills.distance != null && skills.distance !== '') {
        out.distance = Math.max(0, Number(skills.distance) || 0);
    }
    if (skills.shielding != null && skills.shielding !== '') {
        out.shielding = Math.max(0, Number(skills.shielding) || 0);
    }
    if (skills.magic != null && skills.magic !== '') {
        out.magic = Math.max(0, Number(skills.magic) || 0);
    } else if (skills.magicLevel != null && skills.magicLevel !== '') {
        out.magic = Math.max(0, Number(skills.magicLevel) || 0);
    }

    return Object.keys(out).length ? out : null;
}

/**
 * Empty equipment rollup accumulator.
 * @returns {object}
 */
function emptyEquipmentRollup() {
    return {
        atk: 0,
        extraAtk: 0,
        extraAtkElement: null,
        /** Weapon extraAtk that carries extraAtkElement (split on weapon auto). */
        elementalAtk: 0,
        armor: 0,
        defense: 0,
        /** Weapon extradef / defense modifier; applied only when shield defense > 0 */
        defenseBonus: 0,
        weaponDefense: 0,
        /**
         * Equipped weapon family, or null until a right-hand weapon is folded in.
         * After rollup, unarmed fills fist defaults (see applyUnarmedWeaponDefaults).
         * Family values: melee | distance | magic; unarmed marker may be `fist`.
         */
        weaponType: null,
        /**
         * Skill subtype driven by the weapon (legacy parity).
         * sword | axe | club | fist | distance | magic | melee | null
         * Unarmed → fist. Used by buildEffectiveStats skillKey.
         */
        weaponSkill: null,
        /** True when a non-shield weapon was rolled into the right hand / weapon stats. */
        hasWeapon: false,
        /**
         * Ammunition in leftHand (temporary inventory stand-in).
         * Distance bows/crossbows: effective atk = ammoAtk + weapon atk (mod).
         */
        ammoAtk: 0,
        /** Base hit% from ammo `maxHitChance` (0–100); null when no ammo equipped. */
        ammoHitChance: null,
        /** Equipped ammo item id (leftHand stand-in), or null. */
        ammoId: null,
        /**
         * Watch-mode projectile art for ammo (customSprite → spriteId → id).
         * Null when no ammo or no art id is set.
         */
        ammoSprite: null,
        /** Optional catalog genre for ammoSprite when different from mode genre. */
        ammoSpriteGenre: null,
        /** Weapon hit% modifier (bow/xbow `hitChance` field, legacy attack hit mod). */
        weaponHitChanceMod: 0,
        /**
         * Weapon-native hit% when ammo is not used (throwing/spear `maxHitChance`).
         * null = default 100 for non-distance / unknown.
         */
        weaponHitChance: null,
        /**
         * Equipped weapon attack range (tiles), when authored on the item.
         * Used by wand_auto; null when weapon has no range field.
         */
        weaponRange: null,
        /**
         * Weapon classification rank (0 = none / omit). Fatal chance uses this.
         */
        weaponTier: 0,
        /** Weapon category when known (bow/crossbow/spear/…). */
        weaponCategory: null,
        speed: 0,
        weight: 0,
        skillBonuses: {
            melee: 0,
            distance: 0,
            shielding: 0,
            magic: 0,
            fist: 0
        },
        resists: Object.assign({}, DEFAULT_RESISTS),
        /**
         * Display summary of equipped item regen (summed amounts + shortest tick).
         * Combat applies per-item timers in equipment_runtime.tickEquipmentRegen.
         */
        regen: {
            hp: 0,
            mp: 0,
            hpTicksMs: null,
            mpTicksMs: null
        },
        /** OR of equipped item flags (combat consumers optional) */
        flags: {
            manaShield: false,
            invisible: false
        },
        /**
         * Catalog pipeline units (additive). 1000 critChance = +10%.
         * Converted to percent in buildEffectiveStats.
         */
        critChance: 0,
        critExtraDamage: 0,
        /** Life/mana leech chance is already 0–100 percent (100 = always). */
        lifeLeechChance: 0,
        /** Catalog pipeline units (additive). 1800 = 18% of real HP damage. */
        lifeLeechAmount: 0,
        manaLeechChance: 0,
        manaLeechAmount: 0,
        /** Additive percent lists per element (multiplicative product at end) */
        _resistStacks: null
    };
}

/**
 * Whether an item counts as a wielded weapon (not shield / ammo / pure armor).
 * @param {object} item
 * @param {string|null|undefined} [slot] engine slot being filled
 * @returns {boolean}
 */
function itemIsWeapon(item, slot) {
    if (!item) return false;
    if (itemIsAmmo(item) || itemIsShield(item)) return false;
    if (item.category === 'quiver') return false;
    if (slot === 'leftHand' && !WEAPON_CATEGORIES.includes(item.category)) {
        return false;
    }
    if (item.slot === 'leftHand' && !WEAPON_CATEGORIES.includes(item.category)) {
        return false;
    }
    if (slot === 'rightHand' || item.slot === 'rightHand' || item.slot === 'weapon') {
        return true;
    }
    if (item.weaponType && item.weaponType !== 'shield') return true;
    if (item.category && WEAPON_CATEGORIES.indexOf(item.category) >= 0) return true;
    return false;
}

/**
 * Apply legacy unarmed right-hand defaults when no weapon was equipped.
 * Sets atk/weaponDefense/weaponType/weaponSkill; does not replace shield defense.
 * @param {object} rollup
 * @returns {object} same rollup (mutated)
 */
function applyUnarmedWeaponDefaults(rollup) {
    if (!rollup || rollup.hasWeapon) return rollup;
    rollup.atk = UNARMED_ATK;
    rollup.weaponDefense = UNARMED_WEAPON_DEFENSE;
    rollup.weaponType = UNARMED_WEAPON_TYPE;
    rollup.weaponSkill = 'fist';
    rollup.hasWeapon = false;
    return rollup;
}

/**
 * Map a single slot key to the engine combat vocabulary.
 * Unknown keys pass through unchanged (free-form / future slots).
 * @param {string|null|undefined} slot
 * @returns {string|null}
 */
function canonicalEquipmentSlot(slot) {
    if (slot == null || slot === '') return null;
    const raw = String(slot);
    if (Object.prototype.hasOwnProperty.call(EQUIPMENT_SLOT_ALIASES, raw)) {
        return EQUIPMENT_SLOT_ALIASES[raw];
    }
    const lower = raw.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(EQUIPMENT_SLOT_ALIASES, lower)) {
        return EQUIPMENT_SLOT_ALIASES[lower];
    }
    return raw;
}

/**
 * Rewrite equipment slot keys to engine names (head→helmet, weapon→rightHand, …).
 * When both an alias and a canonical key set the same slot, the **canonical**
 * engine key wins if non-empty; otherwise the alias fills it.
 *
 * @param {Record<string, string|number|null|undefined>|null|undefined} equipment
 * @returns {Record<string, string>} plain map of non-empty equipped ids
 */
/**
 * Resolve an equipment map value to a template id.
 * Accepts plain ids or `{ itemId|id, count? }` seed objects.
 * @param {*} v
 * @returns {string|null}
 */
function equipmentEntryItemId(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'object') {
        const id =
            v.itemId != null
                ? v.itemId
                : v.id != null
                  ? v.id
                  : null;
        if (id == null || id === '') return null;
        return String(id);
    }
    const s = String(v).trim();
    return s ? s : null;
}

function normalizeEquipmentMap(equipment) {
    /** @type {Record<string, string>} */
    const out = Object.create(null);
    if (!equipment || typeof equipment !== 'object') return out;

    // First pass: engine-native keys (and keys that already canonical-equal themselves)
    for (const key of Object.keys(equipment)) {
        const v = equipment[key];
        const itemId = equipmentEntryItemId(v);
        if (!itemId) continue;
        const canon = canonicalEquipmentSlot(key);
        if (!canon) continue;
        // Prefer explicit engine key when the raw key already is the canonical name
        if (key === canon || EQUIPMENT_SLOTS.indexOf(key) >= 0) {
            out[canon] = itemId;
        }
    }
    // Second pass: designer aliases fill gaps only
    for (const key of Object.keys(equipment)) {
        const v = equipment[key];
        const itemId = equipmentEntryItemId(v);
        if (!itemId) continue;
        const canon = canonicalEquipmentSlot(key);
        if (!canon) continue;
        if (key === canon || EQUIPMENT_SLOTS.indexOf(key) >= 0) continue;
        if (out[canon] == null || out[canon] === '') {
            out[canon] = itemId;
        }
    }
    return out;
}

/**
 * Look up item by id in a list or map.
 * @param {object[]|Record<string, object>|null} itemDb
 * @param {string|number|null} id
 * @returns {object|null}
 */
/**
 * Whether a catalog row matches `key` by id or `aliases[]`.
 * @param {object|null|undefined} item
 * @param {string} key
 * @returns {boolean}
 */
function itemMatchesId(item, key) {
    if (!item || key == null) return false;
    if (String(item.id) === key) return true;
    const aliases = item.aliases;
    if (!Array.isArray(aliases)) return false;
    for (let i = 0; i < aliases.length; i++) {
        if (aliases[i] != null && String(aliases[i]) === key) return true;
    }
    return false;
}

function findItem(itemDb, id) {
    if (id == null || id === '' || !itemDb) return null;
    const key = String(id);
    if (!Array.isArray(itemDb)) {
        if (itemDb[key] || itemDb[id]) return itemDb[key] || itemDb[id];
        const vals = Object.keys(itemDb);
        for (let i = 0; i < vals.length; i++) {
            const row = itemDb[vals[i]];
            if (itemMatchesId(row, key)) return row;
        }
        return null;
    }
    for (let i = 0; i < itemDb.length; i++) {
        if (itemMatchesId(itemDb[i], key)) return itemDb[i];
    }
    return null;
}

/**
 * Fold one item into a rollup (mutates rollup).
 * @param {object} rollup
 * @param {object} item
 * @param {string|null|undefined} [slot] engine slot key (e.g. rightHand)
 */
/**
 * Additive crit / leech from one equipped item (catalog pipeline units).
 * @param {object} rollup
 * @param {object} item
 */
function addProcStatsToRollup(rollup, item) {
    if (!rollup || !item) return;
    rollup.critChance += Number(item.critChance) || 0;
    rollup.critExtraDamage += Number(item.critExtraDamage) || 0;
    rollup.lifeLeechChance += Number(item.lifeLeechChance) || 0;
    rollup.lifeLeechAmount += Number(item.lifeLeechAmount) || 0;
    rollup.manaLeechChance += Number(item.manaLeechChance) || 0;
    rollup.manaLeechAmount += Number(item.manaLeechAmount) || 0;
}

function addItemToRollup(rollup, item, slot) {
    if (!item) return;
    if (slot === 'leftHandAmmo' && !itemIsAmmo(item)) return;
    addProcStatsToRollup(rollup, item);
    const isAmmo = itemIsAmmo(item);
    const isWeapon = !isAmmo && itemIsWeapon(item, slot);
    if (isWeapon) {
        rollup.hasWeapon = true;
    }

    // Ammo (leftHand stand-in): contributes distance atk/hit only — never melee atk
    if (isAmmo) {
        if (item.atk != null) rollup.ammoAtk = Number(item.atk) || 0;
        if (item.maxHitChance != null) {
            rollup.ammoHitChance = Number(item.maxHitChance);
        } else if (item.hitChance != null && item.hitChance > 1) {
            // Treat values > 1 as absolute % when maxHitChance is missing
            rollup.ammoHitChance = Number(item.hitChance);
        }
        if (item.id != null && String(item.id).trim()) {
            rollup.ammoId = String(item.id).trim();
        }
        // Projectile art for watch-mode distance shots (prefer designer customSprite)
        const ammoArt =
            (item.customSprite != null && String(item.customSprite).trim()) ||
            (item.spriteId != null && String(item.spriteId).trim()) ||
            (item.id != null && String(item.id).trim()) ||
            null;
        if (ammoArt) rollup.ammoSprite = ammoArt;
        const ammoGenre =
            (item.customSpriteGenre != null &&
                String(item.customSpriteGenre).trim()) ||
            (item.spriteGenre != null && String(item.spriteGenre).trim()) ||
            null;
        if (ammoGenre) rollup.ammoSpriteGenre = ammoGenre;
        rollup.weight += Number(item.weight) || 0;
        return;
    }

    // Weapon atk/def replace unarmed placeholders (legacy: set, not stack on fist base)
    if (isWeapon) {
        if (item.atk != null) rollup.atk = Number(item.atk) || 0;
        else rollup.atk += Number(item.atk) || 0;
        // Bow/xbow hitChance field is a +mod; throwing/spear may carry maxHitChance
        if (item.maxHitChance != null) {
            rollup.weaponHitChance = Number(item.maxHitChance);
        }
        if (item.hitChance != null) {
            const hc = Number(item.hitChance) || 0;
            // Absolute % on throwing weapons is rare; small values are legacy hit mods
            if (item.maxHitChance == null && hc > 20) {
                rollup.weaponHitChance = hc;
            } else {
                rollup.weaponHitChanceMod = hc;
            }
        }
        if (item.category) rollup.weaponCategory = item.category;
        if (item.range != null && item.range !== '') {
            const wr = Number(item.range);
            if (Number.isFinite(wr) && wr >= 0) rollup.weaponRange = wr;
        }
        if (item.tier != null && item.tier !== '') {
            const t = Math.floor(Number(item.tier));
            if (Number.isFinite(t) && t > 0) rollup.weaponTier = t;
        }
    }
    // Non-weapon non-ammo atk (e.g. rings) still stacks as extra
    if (!isWeapon && !isAmmo && item.atk != null) {
        rollup.extraAtk += Number(item.atk) || 0;
    }
    const extraAtk = Number(item.extraAtk) || 0;
    rollup.extraAtk += extraAtk;
    if (item.extraAtkElement) {
        rollup.extraAtkElement = item.extraAtkElement;
        if (extraAtk > 0) rollup.elementalAtk += extraAtk;
    }
    rollup.armor += Number(item.armor) || 0;
    rollup.speed += Number(item.speed) || 0;
    rollup.weight += Number(item.weight) || 0;
    rollup.defenseBonus += Number(item.defenseBonus) || 0;

    const def = Number(item.defense) || 0;
    const isShield = itemIsShield(item);
    if (isShield || (def > 0 && !item.atk && !isWeapon)) {
        rollup.defense += def;
    } else if (def > 0) {
        // Weapon defense replaces (not stacks) prior weaponDefense
        if (isWeapon) rollup.weaponDefense = def;
        else rollup.weaponDefense += def;
    }

    if (item.weaponType && item.weaponType !== 'shield') {
        rollup.weaponType = item.weaponType;
    } else if (
        item.category &&
        ['sword', 'axe', 'club', 'mace', 'dagger', 'fist'].indexOf(item.category) >= 0
    ) {
        rollup.weaponType = 'melee';
    } else if (
        item.category === 'bow' ||
        item.category === 'crossbow' ||
        item.category === 'spear' ||
        item.category === 'throwing'
    ) {
        rollup.weaponType = 'distance';
    } else if (
        item.category === 'staff' ||
        item.category === 'wand' ||
        item.category === 'rod'
    ) {
        rollup.weaponType = 'magic';
    } else if (isWeapon && !rollup.weaponType) {
        rollup.weaponType = 'melee';
    }

    // Right-hand / weapon skill subtype (category preferred over type[])
    if (isWeapon) {
        const ws = resolveWeaponSkillFromItem(item);
        if (ws) rollup.weaponSkill = ws;
    }

    const bonuses = item.skillBonuses || item.skills;
    if (bonuses && typeof bonuses === 'object') {
        for (const k of Object.keys(rollup.skillBonuses)) {
            if (bonuses[k] != null) {
                rollup.skillBonuses[k] += Number(bonuses[k]) || 0;
            }
        }
        // Map legacy skill names into engine bags (fist already counted above — do not re-add)
        if (
            bonuses.sword != null ||
            bonuses.axe != null ||
            bonuses.club != null ||
            bonuses.fist != null
        ) {
            rollup.skillBonuses.melee +=
                (Number(bonuses.sword) || 0) +
                (Number(bonuses.axe) || 0) +
                (Number(bonuses.club) || 0) +
                (Number(bonuses.fist) || 0);
        }
        if (bonuses.magicLevel != null) {
            rollup.skillBonuses.magic += Number(bonuses.magicLevel) || 0;
        }
    }

    const resists = item.resists || item.resistances;
    if (resists && typeof resists === 'object') {
        if (!rollup._resistStacks) rollup._resistStacks = {};
        for (const el of Object.keys(DEFAULT_RESISTS)) {
            const v = resists[el];
            if (v == null) continue;
            if (!rollup._resistStacks[el]) rollup._resistStacks[el] = [];
            if (Array.isArray(v)) {
                for (const n of v) rollup._resistStacks[el].push(Number(n) || 0);
            } else {
                rollup._resistStacks[el].push(Number(v) || 0);
            }
        }
    }

    // Display summary only: sum amounts; keep shortest positive tick interval.
    // Independent combat ticks live in equipment_runtime.tickEquipmentRegen.
    const regen = item.regen;
    if (regen && typeof regen === 'object') {
        rollup.regen.hp += Number(regen.hp) || 0;
        rollup.regen.mp += Number(regen.mp) || 0;
        if (regen.hpTicksMs != null) {
            const t = Number(regen.hpTicksMs);
            if (Number.isFinite(t) && t > 0) {
                if (rollup.regen.hpTicksMs == null || t < rollup.regen.hpTicksMs) {
                    rollup.regen.hpTicksMs = t;
                }
            }
        }
        if (regen.mpTicksMs != null) {
            const t = Number(regen.mpTicksMs);
            if (Number.isFinite(t) && t > 0) {
                if (rollup.regen.mpTicksMs == null || t < rollup.regen.mpTicksMs) {
                    rollup.regen.mpTicksMs = t;
                }
            }
        }
    }

    const flags = item.flags;
    if (flags && typeof flags === 'object') {
        if (flags.manaShield) rollup.flags.manaShield = true;
        if (flags.invisible) rollup.flags.invisible = true;
    }
}

/**
 * Multiplicative stack: totalResist = 1 - Π(1 - r_i/100), stored as percent 0–100.
 * @param {number[]} stacks
 * @returns {number}
 */
function stackResists(stacks) {
    if (!stacks || !stacks.length) return 0;
    let remain = 1;
    for (let i = 0; i < stacks.length; i++) {
        remain *= 1 - (Number(stacks[i]) || 0) / 100;
    }
    return (1 - remain) * 100;
}

/**
 * Sum equipment stats from slot → itemId map.
 *
 * @param {Record<string, string|number|null|undefined>} equipment
 * @param {object[]|Record<string, object>|null} itemDb
 * @returns {object} rollup (plain; safe to mutate further)
 */
function rollupEquipment(equipment, itemDb) {
    const rollup = emptyEquipmentRollup();
    // Phase 5: profile designer slots (head/chest/weapon/shield) → engine slots
    const eq = normalizeEquipmentMap(equipment);
    for (let i = 0; i < EQUIPMENT_SLOTS.length; i++) {
        const slot = EQUIPMENT_SLOTS[i];
        const item = findItem(itemDb, eq[slot]);
        if (item) addItemToRollup(rollup, item, slot);
    }
    // Free-form keys not in the standard combat slot list (except backpack/container)
    for (const slot of Object.keys(eq)) {
        if (EQUIPMENT_SLOTS.indexOf(slot) >= 0) continue;
        if (slot === 'backpack') continue;
        const item = findItem(itemDb, eq[slot]);
        if (item) addItemToRollup(rollup, item, slot);
    }
    if (rollup._resistStacks) {
        for (const el of Object.keys(DEFAULT_RESISTS)) {
            rollup.resists[el] = stackResists(rollup._resistStacks[el]);
        }
        delete rollup._resistStacks;
    }
    // Empty right hand → legacy unarmed (atk 7 / def 5 / fist)
    applyUnarmedWeaponDefaults(rollup);
    return rollup;
}

/**
 * Total defense (shield preferred over weapon defense).
 * Legacy parity: weapon extradef (`defenseBonus`) only applies when a shield
 * contributes `defense > 0` (see legacy PlayerStats.getTotalDefense).
 * @param {object} rollup
 * @returns {number}
 */
function getTotalDefense(rollup) {
    if (!rollup) return 0;
    if ((rollup.defense || 0) > 0) {
        return (rollup.defense || 0) + (rollup.defenseBonus || 0);
    }
    return rollup.weaponDefense || 0;
}

/**
 * Whether the rollup has a shield / spellbook contributing defense.
 * @param {object|null|undefined} rollup
 * @returns {boolean}
 */
function hasShieldDefense(rollup) {
    return !!(rollup && (rollup.defense || 0) > 0);
}

/**
 * Whether the equipped weapon is a bow or crossbow (ammo-fed distance).
 * @param {object|null|undefined} rollup
 * @returns {boolean}
 */
function isBowOrCrossbow(rollup) {
    if (!rollup) return false;
    const cat = rollup.weaponCategory ? String(rollup.weaponCategory) : '';
    return DISTANCE_AMMO_WEAPON_CATEGORIES.indexOf(cat) >= 0;
}

/**
 * Whether the equipped weapon is a melee subtype (sword/axe/club/fist) or unarmed.
 * @param {object|null|undefined} rollup
 * @returns {boolean}
 */
function isMeleeWeaponLoadout(rollup) {
    if (!rollup) return true; // empty → unarmed fist
    if (!rollup.hasWeapon) return true;
    const ws = rollup.weaponSkill ? String(rollup.weaponSkill) : '';
    if (MELEE_WEAPON_SKILLS.indexOf(ws) >= 0) return true;
    if (ws === 'melee') return true;
    const cat = rollup.weaponCategory ? String(rollup.weaponCategory) : '';
    if (['sword', 'axe', 'club', 'mace', 'dagger', 'fist'].indexOf(cat) >= 0) {
        return true;
    }
    const wt = rollup.weaponType ? String(rollup.weaponType) : '';
    return wt === 'melee' || wt === 'fist';
}

/**
 * Defense + block-skill context for mitigation and maxBlock.
 *
 * Rules (no shield):
 * - Melee / fist / unarmed → weaponDefense + weapon skill for block; same def for mit
 * - Bow / crossbow → block def 0; mit def BOW_MITIGATION_DEFENSE (18); block skill unused
 * - Wand / other → def UNARMED_WEAPON_DEFENSE (5); block skill = shielding
 *
 * Mitigation skill is always shielding (caller uses skills.shielding).
 * With a shield: def = getTotalDefense; block skill = shielding.
 *
 * @param {object} rollup equipment rollup
 * @param {object} skills effective skills (after gear bonuses)
 * @returns {{
 *   hasShield: boolean,
 *   defenseForBlock: number,
 *   defenseForMitigation: number,
 *   blockSkill: number,
 *   blockSkillKey: string
 * }}
 */
function resolveDefenseBlockContext(rollup, skills) {
    const bag = skills || {};
    const shielding = Math.max(0, Number(bag.shielding) || 0);
    const gear = rollup || emptyEquipmentRollup();
    const hasShield = hasShieldDefense(gear);

    if (hasShield) {
        const def = getTotalDefense(gear);
        return {
            hasShield: true,
            defenseForBlock: def,
            defenseForMitigation: def,
            blockSkill: shielding,
            blockSkillKey: 'shielding'
        };
    }

    if (isBowOrCrossbow(gear)) {
        return {
            hasShield: false,
            defenseForBlock: 0,
            defenseForMitigation: BOW_MITIGATION_DEFENSE,
            blockSkill: shielding,
            blockSkillKey: 'shielding'
        };
    }

    if (isMeleeWeaponLoadout(gear)) {
        const def = getTotalDefense(gear);
        const skillKey = !gear.hasWeapon
            ? 'fist'
            : gear.weaponSkill
              ? String(gear.weaponSkill)
              : 'melee';
        const blockSkill = resolvePrimarySkillValue(skillKey, bag);
        return {
            hasShield: false,
            defenseForBlock: def,
            defenseForMitigation: def,
            blockSkill,
            blockSkillKey: skillKey === 'fist' ? 'fist' : skillKey
        };
    }

    // Wand / rod / staff / throwing / spear / other without shield
    return {
        hasShield: false,
        defenseForBlock: UNARMED_WEAPON_DEFENSE,
        defenseForMitigation: UNARMED_WEAPON_DEFENSE,
        blockSkill: shielding,
        blockSkillKey: 'shielding'
    };
}

/**
 * Mitigation percent from shielding skill + defense (simplified legacy fit).
 * Always uses shielding skill (with gear bonuses).
 * base ≈ -0.082 + 0.0089*shielding + 0.0163*defense  (clamped ≥ 0)
 *
 * @param {number} shieldingSkill
 * @param {number} defense
 * @returns {number} percent 0–100
 */
function computeMitigationPercent(shieldingSkill, defense) {
    const s = Math.max(0, Number(shieldingSkill) || 0);
    const d = Math.max(0, Number(defense) || 0);
    const base = -0.0817 + 0.008894 * s + 0.0163 * d;
    return Math.max(0, Math.min(80, base));
}

/**
 * Max shield block amount:
 *   ceil( defense × (blockSkill + 10) / 40 )
 *
 * `blockSkill` is shielding with a shield, or melee/fist skill without shield + melee weapon.
 *
 * @param {number} blockSkill shielding or weapon skill used for block
 * @param {number} defense DefTotalWithModifiers for block
 * @returns {number}
 */
function computeMaxBlock(blockSkill, defense) {
    const s = Math.max(0, Number(blockSkill) || 0);
    const d = Math.max(0, Number(defense) || 0);
    if (d <= 0) return 0;
    return Math.ceil(d * ((s + 10) / 40));
}

/**
 * Choose skillKey from weapon skill subtype (legacy) or class fallback.
 * @param {boolean} unarmed
 * @param {object} gear rollup
 * @param {string} gearFamily melee|distance|magic
 * @param {object} cls class def
 * @returns {string}
 */
function resolveSkillKeyFromGear(unarmed, gear, gearFamily, cls) {
    if (unarmed) return 'fist';
    const ws = gear && gear.weaponSkill ? String(gear.weaponSkill) : '';
    if (ws === 'fist' || ws === 'sword' || ws === 'axe' || ws === 'club') return ws;
    if (ws === 'distance') return 'distance';
    if (ws === 'magic') return 'magic';
    if (ws === 'melee') return 'melee';
    // No subtype on item: family then class
    if (gearFamily === 'distance') return 'distance';
    if (gearFamily === 'magic') return 'magic';
    return (cls && cls.skillKey) || 'melee';
}

/**
 * Map skillKey to numeric primary skill for damage / block formulas.
 *
 * **Standard policy (locked):** always prefer the weapon **subtype** bag when
 * present on the player/effective skills; only then fall back to collapsed
 * `skills.melee`. Product profiles author sword/axe/club (not melee alone).
 *
 * @param {string} skillKey
 * @param {object} skills effective skills bag
 * @returns {number}
 */
function resolvePrimarySkillValue(skillKey, skills) {
    const bag = skills || {};
    if (skillKey === 'magic') return bag.magic || 0;
    if (skillKey === 'distance') return bag.distance || 0;
    if (skillKey === 'fist') return bag.fist != null ? bag.fist : bag.melee || 0;
    if (skillKey === 'sword' || skillKey === 'axe' || skillKey === 'club') {
        if (bag[skillKey] != null) return bag[skillKey];
        return bag.melee || 0;
    }
    // melee | unknown — collapsed bag (compat / class floors)
    return bag.melee || 0;
}

/**
 * Build effective combat stats from class definition + equipment + level.
 *
 * Skill layering (low → high priority):
 * 1. DEFAULT_SKILLS (floors: weapons 10, magic 0)
 * 2. classDef.skills (vocation floors on class rows)
 * 3. opts.baseSkills / opts.skills (player profile or party member skills;
 *    profile keys sword/axe/… are normalized via normalizeSkillBag)
 * 4. + gear.skillBonuses
 * 5. opts.skillOverrides — absolute post-gear override (tests / debug)
 *
 * Class skillRates are not applied here (progression math / derive tooling only).
 *
 * skillKey (which bag feeds auto damage) comes from the **weapon**:
 * category fist → fist, sword/axe/club → that key (value from skills.melee),
 * bow/spear → distance, wand/rod → magic. Unarmed → fist. Class skillKey
 * only when the weapon has no resolvable subtype.
 *
 * @param {object} classDef from presets/classes.json entry
 * @param {object} [equipmentRollup] from rollupEquipment
 * @param {object} [opts]
 * @param {number} [opts.level=8]
 * @param {object} [opts.baseSkills] character skills before gear bonuses (profile)
 * @param {object} [opts.skills] alias of baseSkills
 * @param {object} [opts.skillOverrides] absolute final skill values (after gear)
 * @param {object} [opts.resistOverrides]
 * @param {number} [opts.critChance] profile extra percent; stacks on classDef.critChance; equipment adds pipeline/100
 * @param {number} [opts.critDamage] profile extra percent; stacks on classDef.critDamage; equipment adds pipeline/100
 * @param {number} [opts.lifeLeechChance] percent 0–100; equipment adds as-is
 * @param {number} [opts.lifeLeechAmount] percent; equipment adds pipeline/100
 * @param {number} [opts.lifeLeech] alias of lifeLeechAmount (profile.stats.lifeLeech)
 * @param {number} [opts.manaLeechChance]
 * @param {number} [opts.manaLeechAmount]
 * @param {number} [opts.manaLeech] alias of manaLeechAmount
 * @param {boolean} [opts.promoted]
 * @returns {object} effective stats bag used by combat modules
 */
function buildEffectiveStats(classDef, equipmentRollup, opts) {
    const options = opts || {};
    const level = options.level != null ? options.level : classDef && classDef.defaultLevel != null ? classDef.defaultLevel : 8;
    const cls = classDef || {};
    const gear = equipmentRollup || emptyEquipmentRollup();
    // Safety: raw empty rollups still get legacy fist defaults
    if (!gear.hasWeapon) applyUnarmedWeaponDefaults(gear);

    const baseSkills = Object.assign({}, DEFAULT_SKILLS, cls.skills || {});
    const profileSkills = normalizeSkillBag(options.baseSkills || options.skills);
    if (profileSkills) Object.assign(baseSkills, profileSkills);

    // Fist: explicit profile/class value, else mirror melee (most packs only author melee)
    const fistBase =
        baseSkills.fist != null ? Number(baseSkills.fist) || 0 : baseSkills.melee;
    const meleeGear = gear.skillBonuses.melee || 0;
    const skills = {
        melee: baseSkills.melee + meleeGear,
        distance: baseSkills.distance + (gear.skillBonuses.distance || 0),
        shielding: baseSkills.shielding + (gear.skillBonuses.shielding || 0),
        magic: baseSkills.magic + (gear.skillBonuses.magic || 0),
        fist: fistBase + (gear.skillBonuses.fist || 0)
    };
    // Phase D: preserve trained sword/axe/club when present on profile bag
    for (const k of ['sword', 'axe', 'club']) {
        if (baseSkills[k] != null && baseSkills[k] !== '') {
            skills[k] = Math.max(0, Number(baseSkills[k]) || 0) + meleeGear;
            skills.melee = Math.max(skills.melee, skills[k]);
        }
    }
    const absoluteSkills = normalizeSkillBag(options.skillOverrides);
    if (absoluteSkills) {
        Object.assign(skills, absoluteSkills);
        if (absoluteSkills.fist == null && absoluteSkills.melee != null) {
            // Absolute melee without fist: keep fist in sync for unarmed
            skills.fist = absoluteSkills.melee;
        }
    } else if (options.skillOverrides && typeof options.skillOverrides === 'object') {
        // Back-compat: plain { melee: N } without going through aliases
        for (const k of Object.keys(DEFAULT_SKILLS)) {
            if (options.skillOverrides[k] != null) {
                skills[k] = Math.max(0, Number(options.skillOverrides[k]) || 0);
            }
        }
        if (
            options.skillOverrides.fist != null &&
            options.skillOverrides.fist !== ''
        ) {
            skills.fist = Math.max(0, Number(options.skillOverrides.fist) || 0);
        } else if (options.skillOverrides.melee != null) {
            skills.fist = skills.melee;
        }
    }

    const resists = Object.assign({}, DEFAULT_RESISTS, cls.resists || {}, gear.resists || {});
    if (options.resistOverrides) {
        Object.assign(resists, options.resistOverrides);
    }

    // Defense for display / total; block+mit use resolveDefenseBlockContext
    const defense = getTotalDefense(gear);
    const defCtx = resolveDefenseBlockContext(gear, skills);
    // Mitigation always uses shielding skill (with bonuses), never weapon skill
    const mitigation =
        cls.mitigation != null
            ? Number(cls.mitigation)
            : computeMitigationPercent(skills.shielding, defCtx.defenseForMitigation);
    const maxBlock =
        cls.maxBlock != null
            ? Number(cls.maxBlock)
            : computeMaxBlock(defCtx.blockSkill, defCtx.defenseForBlock);

    const baseSpeed = cls.baseSpeed != null ? cls.baseSpeed : 110;
    const baseHp = cls.baseHp != null ? cls.baseHp : 150;
    const baseMp = cls.baseMp != null ? cls.baseMp : 50;
    const hpPerLevel = cls.hpPerLevel != null ? cls.hpPerLevel : 15;
    const mpPerLevel = cls.mpPerLevel != null ? cls.mpPerLevel : 5;

    // Level 8 baseline matches class baseHp/baseMp; extra levels add per-level
    const levelsAbove = Math.max(0, level - 8);
    const hpMax = baseHp + levelsAbove * hpPerLevel + (Number(cls.hpBonus) || 0);
    const mpMax = baseMp + levelsAbove * mpPerLevel + (Number(cls.mpBonus) || 0);

    // Movement speed (legacy: 109 + level + equipment.speed).
    // baseSpeed is the class level-1 speed (default 110 ≈ 109+1); each level
    // above 1 adds +1. Gear speed and optional class speedBonus stack on top.
    const levelForSpeed = Math.max(1, Math.floor(Number(level) || 1));
    const speed =
        baseSpeed +
        (levelForSpeed - 1) +
        (gear.speed || 0) +
        (Number(cls.speedBonus) || 0);

    // Unarmed: always melee family + fist skill (ignore class bow/wand auto)
    const unarmed = !gear.hasWeapon;
    let gearFamily = 'melee';
    if (!unarmed) {
        const wt = gear.weaponType || cls.weaponType || 'melee';
        if (
            wt === 'distance' ||
            wt === 'ranged' ||
            wt === 'bow' ||
            wt === 'crossbow'
        ) {
            gearFamily = 'distance';
        } else if (
            wt === 'magic' ||
            wt === 'wand' ||
            wt === 'rod' ||
            wt === 'staff'
        ) {
            gearFamily = 'magic';
        } else {
            gearFamily = 'melee';
        }
    }

    // skillKey: weapon drives skill (legacy); class only when gear has no subtype
    const skillKey = resolveSkillKeyFromGear(unarmed, gear, gearFamily, cls);
    const primarySkill = resolvePrimarySkillValue(skillKey, skills);

    // Class + profile extras are already percent (stack). Equipment is
    // catalog pipeline (1000 = +10%) except leech chance, which is already 0–100.
    const critChance =
        (Number(cls.critChance) || 0) +
        (Number(options.critChance) || 0) +
        pipelineToPercent(gear.critChance);
    const critDamage =
        (Number(cls.critDamage) || 0) +
        (Number(options.critDamage) || 0) +
        pipelineToPercent(gear.critExtraDamage);
    const lifeLeechChance =
        (options.lifeLeechChance != null
            ? Number(options.lifeLeechChance) || 0
            : Number(cls.lifeLeechChance) || 0) + (Number(gear.lifeLeechChance) || 0);
    const lifeLeechAmount =
        (options.lifeLeechAmount != null
            ? Number(options.lifeLeechAmount) || 0
            : options.lifeLeech != null
              ? Number(options.lifeLeech) || 0
              : Number(cls.lifeLeech) || 0) + pipelineToPercent(gear.lifeLeechAmount);
    const manaLeechChance =
        (options.manaLeechChance != null
            ? Number(options.manaLeechChance) || 0
            : Number(cls.manaLeechChance) || 0) + (Number(gear.manaLeechChance) || 0);
    const manaLeechAmount =
        (options.manaLeechAmount != null
            ? Number(options.manaLeechAmount) || 0
            : options.manaLeech != null
              ? Number(options.manaLeech) || 0
              : Number(cls.manaLeech) || 0) + pipelineToPercent(gear.manaLeechAmount);

    let autoAttack = 'melee_auto';
    if (!unarmed) {
        if (gearFamily === 'distance') autoAttack = 'distance_auto';
        else if (gearFamily === 'magic') autoAttack = 'wand_auto';
        else if (
            cls.autoAttack === 'melee_auto' ||
            cls.autoAttack === 'distance_auto' ||
            cls.autoAttack === 'wand_auto'
        ) {
            // Class default only when it matches melee family (weapon is melee)
            autoAttack =
                cls.autoAttack === 'distance_auto' || cls.autoAttack === 'wand_auto'
                    ? 'melee_auto'
                    : cls.autoAttack;
        }
    }

    // Primary attack power for formulas (melee = weapon atk; distance = legacy effective)
    const weaponAtk = gear.atk || 0;
    const ammoAtk = gear.ammoAtk || 0;
    const hasAmmo = gear.ammoHitChance != null || ammoAtk > 0;
    const weaponCat = gear.weaponCategory || null;
    const isAmmoFedDistance =
        gearFamily === 'distance' &&
        (DISTANCE_AMMO_WEAPON_CATEGORIES.indexOf(weaponCat) >= 0 || hasAmmo);
    let formulaAtk;
    if (gearFamily === 'distance' && isAmmoFedDistance) {
        // Bows/crossbows: ammo atk + weapon attack modifier (legacy)
        formulaAtk = ammoAtk + weaponAtk;
    } else {
        // Melee / fist / throwing / magic weapon body atk
        formulaAtk = weaponAtk;
    }
    formulaAtk =
        formulaAtk + (gear.extraAtk || 0) + (Number(cls.atkBonus) || 0);

    // Distance hit%: ammo maxHitChance + weapon hit mod (capped 100); throwing uses weapon maxHitChance
    let hitChance = 100;
    if (gearFamily === 'distance') {
        if (gear.ammoHitChance != null) {
            hitChance = Math.min(
                100,
                Math.max(
                    0,
                    Number(gear.ammoHitChance) + (Number(gear.weaponHitChanceMod) || 0)
                )
            );
        } else if (gear.weaponHitChance != null) {
            hitChance = Math.min(
                100,
                Math.max(
                    0,
                    Number(gear.weaponHitChance) + (Number(gear.weaponHitChanceMod) || 0)
                )
            );
        }
    }

    return {
        classId: cls.id || 'adventurer',
        level,
        hpMax,
        mpMax,
        speed,
        atk: formulaAtk,
        /**
         * Weapon extra elemental atk (fire sword extraAtk). Combined into `atk`
         * for the auto formula, then split by extraAtk/atk on resolve.
         */
        extraAtk: Number(gear.elementalAtk) || 0,
        extraAtkElement: gear.extraAtkElement || null,
        /** Weapon-only atk (bow mod or melee body); excludes ammo. */
        weaponAtk,
        ammoAtk,
        /** Equipped ammo item id, or null. */
        ammoId: gear.ammoId || null,
        /** Watch projectile art id from ammo customSprite / spriteId / id. */
        ammoSprite: gear.ammoSprite || null,
        /** Optional genre for ammoSprite (cross-genre catalog art). */
        ammoSpriteGenre: gear.ammoSpriteGenre || null,
        armor: (gear.armor || 0) + (Number(cls.armorBonus) || 0),
        defense,
        /** Defense fed into maxBlock (0 for bow/xbow without shield). */
        defenseForBlock: defCtx.defenseForBlock,
        /** Defense fed into mitigation (18 for bow/xbow without shield). */
        defenseForMitigation: defCtx.defenseForMitigation,
        /** Skill value used in maxBlock (shielding or melee/fist without shield). */
        blockSkill: defCtx.blockSkill,
        blockSkillKey: defCtx.blockSkillKey,
        hasShield: defCtx.hasShield,
        defenseBonus: gear.defenseBonus || 0,
        weaponDefense: gear.weaponDefense || 0,
        /** Combat attack family: melee | distance | magic (unarmed → melee). */
        weaponType: gearFamily,
        /**
         * Weapon skill subtype from rollup (sword/axe/club/fist/distance/magic/melee).
         * Unarmed → fist. Mirrors skillKey for armed weapons with a known subtype.
         */
        weaponSkill: unarmed ? 'fist' : gear.weaponSkill || skillKey,
        /**
         * Equipped weapon range in tiles (from item.range). Wand auto uses this.
         * null when unarmed or weapon has no range field.
         */
        weaponRange: unarmed
            ? null
            : gear.weaponRange != null
              ? gear.weaponRange
              : null,
        /** Weapon classification rank; 0 unarmed or omit. Fatal uses this. */
        weaponTier: unarmed ? 0 : Math.max(0, Math.floor(Number(gear.weaponTier) || 0)),
        /** True when right hand is empty (legacy fist defaults applied). */
        unarmed: !!unarmed,
        /** Distance auto hit chance 0–100 (ammo + mods). Melee defaults 100. */
        hitChance,
        skills,
        skill: primarySkill,
        magic: skills.magic,
        mitigation,
        maxBlock,
        resists,
        // Display summary only (see rollupEquipment); combat ticks per item in equipment_runtime
        regen: {
            hp: (gear.regen && gear.regen.hp) || 0,
            mp: (gear.regen && gear.regen.mp) || 0,
            hpTicksMs: (gear.regen && gear.regen.hpTicksMs) || null,
            mpTicksMs: (gear.regen && gear.regen.mpTicksMs) || null
        },
        flags: {
            manaShield: !!(gear.flags && gear.flags.manaShield),
            invisible: !!(gear.flags && gear.flags.invisible)
        },
        critChance,
        critDamage,
        lifeLeechChance,
        lifeLeechAmount,
        manaLeechChance,
        manaLeechAmount,
        spells: Array.isArray(cls.spells) ? cls.spells.slice() : [],
        autoAttack,
        skillKey,
        promoted: !!(options.promoted || (options.profile && options.profile.promoted)),
        nativeRegen: {
            hp: Math.max(0, (options.promoted || (options.profile && options.profile.promoted))
                ? Number(cls.promotedRegenHp != null ? cls.promotedRegenHp : (cls.baseRegenHp || 0))
                : Number(cls.baseRegenHp || 0)),
            mp: Math.max(0, (options.promoted || (options.profile && options.profile.promoted))
                ? Number(cls.promotedRegenMp != null ? cls.promotedRegenMp : (cls.baseRegenMp || 0))
                : Number(cls.baseRegenMp || 0))
        }
    };
}

/**
 * Defender bag for applyMitigation from effective stats + runtime flags.
 * @param {object} effective from buildEffectiveStats
 * @param {{ canBlock?: boolean }} [runtime]
 * @returns {object}
 */
function defenderBagFromStats(effective, runtime) {
    const r = runtime || {};
    return {
        mitigation: effective.mitigation || 0,
        resists: effective.resists || Object.assign({}, DEFAULT_RESISTS),
        armor: effective.armor || 0,
        maxBlock: effective.maxBlock || 0,
        canBlock: r.canBlock !== undefined ? !!r.canBlock : true
    };
}

/**
 * Attacker bag for damage range formulas.
 * @param {object} effective
 * @returns {object}
 */
function attackerBagFromStats(effective) {
    return {
        level: effective.level || 1,
        atk: effective.atk || 0,
        skill: effective.skill || 0,
        magic: effective.magic || 0,
        critChance: effective.critChance || 0,
        critDamage: effective.critDamage || 0,
        lifeLeechChance: effective.lifeLeechChance || 0,
        lifeLeechAmount: effective.lifeLeechAmount || 0,
        manaLeechChance: effective.manaLeechChance || 0,
        manaLeechAmount: effective.manaLeechAmount || 0,
        hitChance: effective.hitChance != null ? effective.hitChance : 100,
        extraAtk: Number(effective.extraAtk) || 0,
        extraAtkElement: effective.extraAtkElement || null,
        weaponTier: Math.max(0, Math.floor(Number(effective.weaponTier) || 0))
    };
}

module.exports = {
    EQUIPMENT_SLOTS,
    EQUIPMENT_SLOT_ALIASES,
    DEFAULT_RESISTS,
    DEFAULT_SKILLS,
    MELEE_SKILL_ALIASES,
    MELEE_WEAPON_SKILLS,
    DISTANCE_AMMO_WEAPON_CATEGORIES,
    BOW_MITIGATION_DEFENSE,
    SHIELD_BLOCK_MAX_PER_WINDOW,
    SHIELD_BLOCK_WINDOW_SEC,
    UNARMED_ATK,
    UNARMED_WEAPON_DEFENSE,
    UNARMED_WEAPON_TYPE,
    COMBAT_PIPELINE_PER_PERCENT,
    pipelineToPercent,
    formatPipelinePercent,
    catalogSpecialBonusLines,
    emptyEquipmentRollup,
    findItem,
    canonicalEquipmentSlot,
    equipmentEntryItemId,
    normalizeEquipmentMap,
    normalizeSkillBag,
    mapTokenToWeaponSkill,
    resolveWeaponSkillFromItem,
    resolveSkillKeyFromGear,
    resolvePrimarySkillValue,
    itemIsAmmo,
    itemAmmoKind,
    weaponRequiredAmmoKind,
    itemIsTwoHanded,
    itemIsQuiver,
    itemIsBowOrCrossbowWeapon,
    itemIsShield,
    itemIsWeapon,
    applyUnarmedWeaponDefaults,
    rollupEquipment,
    getTotalDefense,
    hasShieldDefense,
    isBowOrCrossbow,
    isMeleeWeaponLoadout,
    resolveDefenseBlockContext,
    computeMitigationPercent,
    computeMaxBlock,
    buildEffectiveStats,
    defenderBagFromStats,
    attackerBagFromStats,
    stackResists
};
