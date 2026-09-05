/**
 * Active-player equipment card + shared Character Profile Preview popup.
 *
 * Inline card lives under the hunt/scenario canvas. Details opens the same
 * profile_preview widget used by Designer base profiles (postMessage protocol).
 * During a live session the popup is refreshed ~1/s while open.
 */

'use strict';

const {
    normalizeEquipmentMap,
    findItem,
    catalogSpecialBonusLines
} = require('../../core/lib/character/stats.js');
const {
    totalCarriedWeight,
    remainingCapacity,
    isRuntimeInventory,
    getItem
} = require('../../core/lib/character/inventory.js');
const {
    resolveItemBudgetDisplay
} = require('../../core/lib/character/equipment_runtime.js');
const { appUrl } = require('../../core/lib/app_paths.js');
const { getManaShieldState } = require('../../core/lib/combat/conditions.js');

/** Shared popup window name (Designer + Hunt + Scenario Lab). */
const PROFILE_PREVIEW_WINDOW = 'hdl_profile_preview';

/** Designer-facing slot keys on the equipment card / profile JSON. */
const DESIGNER_SLOTS = [
    'head',
    'chest',
    'legs',
    'boots',
    'weapon',
    'shield',
    'amulet',
    'ring',
    'backpack'
];

/** Engine combat slot → designer profile slot. */
const ENGINE_TO_DESIGNER = Object.freeze({
    helmet: 'head',
    armor: 'chest',
    rightHand: 'weapon',
    leftHand: 'shield',
    amulet: 'amulet',
    ring: 'ring',
    legs: 'legs',
    boots: 'boots',
    backpack: 'backpack'
});

/** Designer profile slot → engine combat slot. */
const DESIGNER_TO_ENGINE = Object.freeze({
    head: 'helmet',
    chest: 'armor',
    weapon: 'rightHand',
    shield: 'leftHand',
    amulet: 'amulet',
    ring: 'ring',
    legs: 'legs',
    boots: 'boots',
    backpack: 'backpack'
});

/** Designer slot → placeholder icon HTML. */
const SLOT_PLACEHOLDERS = Object.freeze({
    head: '<i class="fa-solid fa-helmet-safety"></i>',
    chest: '<i class="fa-solid fa-vest"></i>',
    legs: '<i class="fa-solid fa-socks"></i>',
    boots: '<i class="fa-solid fa-shoe-prints"></i>',
    weapon: '<i class="fa-solid fa-hand-fist"></i>',
    shield: '<i class="fa-solid fa-shield"></i>',
    amulet: '<i class="fa-solid fa-gem"></i>',
    ring: '<i class="fa-solid fa-ring"></i>',
    backpack: '<i class="fa-solid fa-bag-shopping"></i>',
    light: '<i class="fa-solid fa-lightbulb"></i>'
});

/**
 * Font Awesome meta for engine condition kinds + tile-zone flags
 * (equipment status strip). Colors echo legacy client condition flag hues
 * (poison green, burn orange, …). PZ uses a house so it does not collide
 * with mana_shield (`fa-shield-halved`).
 * @type {Readonly<Record<string, { icon: string, color: string, label: string, title: string }>>}
 */
const STATUS_ICON_META = Object.freeze({
    protection_zone: {
        icon: 'fa-house',
        color: '#22c55e',
        label: 'Protection Zone',
        title: 'You are in a protection zone'
    },
    poison: {
        icon: 'fa-skull-crossbones',
        color: '#6bcb3f',
        label: 'Poisoned',
        title: 'You are poisoned'
    },
    fire: {
        icon: 'fa-fire',
        color: '#ff6b35',
        label: 'Burning',
        title: 'You are burning'
    },
    ice: {
        icon: 'fa-snowflake',
        color: '#7ec8ff',
        label: 'Freezing',
        title: 'You are freezing'
    },
    energy: {
        icon: 'fa-bolt',
        color: '#f0d030',
        label: 'Electrified',
        title: 'You are electrified'
    },
    bleed: {
        icon: 'fa-droplet',
        color: '#c41e3a',
        label: 'Bleeding',
        title: 'You are bleeding'
    },
    curse: {
        icon: 'fa-ghost',
        color: '#9b59b6',
        label: 'Cursed',
        title: 'You are cursed'
    },
    holy: {
        icon: 'fa-sun',
        color: '#ffe066',
        label: 'Dazzled',
        title: 'You are dazzled'
    },
    slow: {
        icon: 'fa-person-running',
        color: '#e74c3c',
        label: 'Slowed',
        title: 'You are paralysed'
    },
    haste: {
        icon: 'fa-person-running',
        color: '#2ecc71',
        label: 'Hasted',
        title: 'You are hasted'
    },
    invisible: {
        icon: 'fa-eye-slash',
        color: '#a0aec0',
        label: 'Invisible',
        title: 'You are invisible'
    },
    regen: {
        icon: 'fa-heart-pulse',
        color: '#48bb78',
        label: 'Regenerating',
        title: 'You are regenerating'
    },
    attributes: {
        icon: 'fa-dumbbell',
        color: '#63b3ed',
        label: 'Strengthened',
        title: 'You are strengthened'
    },
    mana_shield: {
        icon: 'fa-shield-halved',
        color: '#22d3ee',
        label: 'Magic Shield',
        title: 'You are protected by a magic shield'
    }
});

/** Stable display order for the status strip (zone flags, detriments, then buffs). */
const STATUS_ICON_ORDER = Object.freeze([
    'protection_zone',
    'poison',
    'fire',
    'energy',
    'bleed',
    'ice',
    'holy',
    'curse',
    'slow',
    'haste',
    'invisible',
    'mana_shield',
    'regen',
    'attributes'
]);

/**
 * Tile used for zone flags on the status strip.
 * Prefers `source.tile`; falls back to flat x/y/z on form stubs.
 *
 * @param {object|null|undefined} source
 * @returns {{ x: number, y: number, z: string|number }|null}
 */
function sourceTileOf(source) {
    if (!source || typeof source !== 'object') return null;
    const t = source.tile;
    if (t && typeof t === 'object') {
        const x = Number(t.x);
        const y = Number(t.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        return { x, y, z: t.z != null ? t.z : 0 };
    }
    const x = Number(source.x);
    const y = Number(source.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y, z: source.z != null ? source.z : 0 };
}

/**
 * Full PZ package under the source tile (`NO_CAST | NO_CREATURE`).
 * NO_CAST-only (legacy green PNG) is not a protection zone.
 *
 * @param {object|null|undefined} source
 * @param {{ isProtectionZonePackage?: function }|null|undefined} tileMap
 * @returns {boolean}
 */
function isSourceOnProtectionZone(source, tileMap) {
    if (!tileMap || typeof tileMap.isProtectionZonePackage !== 'function') {
        return false;
    }
    const t = sourceTileOf(source);
    if (!t) return false;
    return !!tileMap.isProtectionZonePackage(t.x, t.y, t.z);
}

/**
 * Collect active condition kinds from a player/entity for the status strip.
 * Dedupes by kind; order follows STATUS_ICON_ORDER then unknowns alphabetically.
 * Protection zone is a tile flag (not a condition) and needs `opts.tileMap`.
 *
 * @param {object|null|undefined} source Player entity or form member
 * @param {{ tileMap?: { isProtectionZonePackage?: function }|null }} [opts]
 * @returns {{ kind: string, icon: string, color: string, label: string, title: string }[]}
 */
function listActiveStatusIcons(source, opts) {
    if (!source || typeof source !== 'object') return [];
    /** @type {Set<string>} */
    const kinds = new Set();
    const list = Array.isArray(source.conditions) ? source.conditions : [];
    for (let i = 0; i < list.length; i++) {
        const c = list[i];
        if (!c || typeof c !== 'object') continue;
        const kind = String(c.kind || c.type || c.id || '')
            .toLowerCase()
            .replace(/^condition_/, '')
            .trim();
        if (!kind) continue;
        // Normalize common aliases to engine kinds
        let k = kind;
        if (k === 'burning' || k === 'condition_fire') k = 'fire';
        else if (k === 'poisoned' || k === 'condition_poison') k = 'poison';
        else if (k === 'freezing' || k === 'condition_freezing') k = 'ice';
        else if (
            k === 'electrified' ||
            k === 'electrification' ||
            k === 'electrify'
        ) {
            k = 'energy';
        } else if (k === 'bleeding') k = 'bleed';
        else if (k === 'cursed') k = 'curse';
        else if (k === 'dazzled' || k === 'dazzle') k = 'holy';
        else if (k === 'paralyzed' || k === 'paralysed' || k === 'paralyze') {
            k = 'slow';
        } else if (k === 'invisibility') k = 'invisible';
        else if (
            k === 'manashield' ||
            k === 'mana-shield' ||
            k === 'magic_shield'
        ) {
            k = 'mana_shield';
        } else if (
            k === 'regeneration' ||
            k === 'hot' ||
            k === 'recovery'
        ) {
            k = 'regen';
        } else if (k === 'attribute' || k === 'stance' || k === 'strengthened') {
            k = 'attributes';
        }
        kinds.add(k);
    }
    // Gear stealth (stealth ring) shows as invisible without a condition row.
    const gearFlags = source.combatStats && source.combatStats.flags;
    if (source.invisible || (gearFlags && gearFlags.invisible)) {
        kinds.add('invisible');
    }
    // Gear mana shield (voltaic ring / spellbooks) without a pooled condition.
    if (gearFlags && gearFlags.manaShield) {
        kinds.add('mana_shield');
    }
    if (isSourceOnProtectionZone(source, opts && opts.tileMap)) {
        kinds.add('protection_zone');
    }

    /** @type {{ kind: string, icon: string, color: string, label: string, title: string }[]} */
    const out = [];
    for (let i = 0; i < STATUS_ICON_ORDER.length; i++) {
        const kind = STATUS_ICON_ORDER[i];
        if (!kinds.has(kind)) continue;
        const meta = STATUS_ICON_META[kind];
        if (!meta) continue;
        let title = meta.title;
        if (kind === 'mana_shield') {
            const state = getManaShieldState(source);
            if (state && state.pooled) {
                title = `${meta.title} (${state.poolRemaining} / ${state.poolMax})`;
            } else if (state && state.gear) {
                title = `${meta.title} (gear)`;
            }
        }
        out.push({
            kind,
            icon: meta.icon,
            color: meta.color,
            label: meta.label,
            title
        });
        kinds.delete(kind);
    }
    // Unknown kinds: still show a generic badge so designers see something.
    const rest = Array.from(kinds).sort();
    for (let i = 0; i < rest.length; i++) {
        const kind = rest[i];
        out.push({
            kind,
            icon: 'fa-circle-exclamation',
            color: '#cbd5e0',
            label: kind,
            title: kind
        });
    }
    return out;
}

/**
 * Stable signature of active status kinds (for dirty-only paint).
 * @param {object|null|undefined} source
 * @param {{ tileMap?: object|null }} [opts]
 * @returns {string}
 */
function statusIconsSignature(source, opts) {
    const icons = listActiveStatusIcons(source, opts);
    if (!icons.length) return '';
    return icons.map((x) => x.kind).join(',');
}

/**
 * Paint the miniature status strip under Soul/Cap.
 * @param {HTMLElement|null} barEl
 * @param {object|null|undefined} source
 * @param {{ force?: boolean, tileMap?: object|null }} [opts]
 */
function renderStatusBar(barEl, source, opts) {
    if (!barEl) return;
    const force = !!(opts && opts.force);
    const icons = listActiveStatusIcons(source, opts);
    // Include title so pooled remaining (tooltip) can refresh without a new kind.
    const sig = icons.map((x) => `${x.kind}:${x.title}`).join('|');
    if (!force && barEl.dataset.statusSig === sig) return;
    barEl.dataset.statusSig = sig;
    if (!icons.length) {
        barEl.innerHTML = '';
        barEl.hidden = true;
        barEl.setAttribute('aria-hidden', 'true');
        return;
    }
    barEl.hidden = false;
    barEl.setAttribute('aria-hidden', 'false');
    let html = '';
    for (let i = 0; i < icons.length; i++) {
        const ic = icons[i];
        html +=
            `<span class="eq-status-icon" data-status="${escapeHtml(ic.kind)}"` +
            ` style="color:${escapeHtml(ic.color)}"` +
            ` title="${escapeHtml(ic.title)}"` +
            ` aria-label="${escapeHtml(ic.label)}">` +
            `<i class="fa-solid ${escapeHtml(ic.icon)}" aria-hidden="true"></i>` +
            `</span>`;
    }
    barEl.innerHTML = html;
}

/**
 * Convert any equipment map (engine or designer keys) to designer slot ids.
 * @param {Record<string, string|number|null|undefined>|null|undefined} raw
 * @returns {Record<string, string>}
 */
function equipmentToDesignerSlots(raw) {
    const engine = normalizeEquipmentMap(raw);
    /** @type {Record<string, string>} */
    const out = Object.create(null);
    for (const engineKey of Object.keys(engine)) {
        const designer =
            ENGINE_TO_DESIGNER[engineKey] ||
            (DESIGNER_SLOTS.indexOf(engineKey) >= 0 ? engineKey : null);
        if (!designer) continue;
        const id = engine[engineKey];
        if (id != null && String(id).trim()) out[designer] = String(id).trim();
    }
    // Pass-through designer keys that normalizeEquipmentMap may keep as-is
    if (raw && typeof raw === 'object') {
        for (let i = 0; i < DESIGNER_SLOTS.length; i++) {
            const k = DESIGNER_SLOTS[i];
            if (out[k]) continue;
            const v = raw[k];
            if (v != null && String(v).trim()) out[k] = String(v).trim();
        }
    }
    return out;
}

/**
 * Read current/max HP-MP from a Player entity (`{current,max}`) or flat form row.
 * @param {object} source
 * @returns {{ hp: number|null, hpMax: number|null, mp: number|null, mpMax: number|null }}
 */
function readSourceVitals(source) {
    let hp = null;
    let hpMax = null;
    let mp = null;
    let mpMax = null;

    if (source.hp && typeof source.hp === 'object') {
        if (source.hp.current != null) hp = Number(source.hp.current);
        if (source.hp.max != null) hpMax = Number(source.hp.max);
    } else {
        if (source.hp != null) hp = Number(source.hp);
        if (source.hpMax != null) hpMax = Number(source.hpMax);
    }

    if (source.mp && typeof source.mp === 'object') {
        if (source.mp.current != null) mp = Number(source.mp.current);
        if (source.mp.max != null) mpMax = Number(source.mp.max);
    } else {
        if (source.mp != null) mp = Number(source.mp);
        if (source.mpMax != null) mpMax = Number(source.mpMax);
    }

    // Flat snapshot may only set one side
    if (hpMax == null && Number.isFinite(hp)) hpMax = hp;
    if (hp == null && Number.isFinite(hpMax)) hp = hpMax;
    if (mpMax == null && Number.isFinite(mp)) mpMax = mp;
    if (mp == null && Number.isFinite(mpMax)) mp = mpMax;

    return {
        hp: Number.isFinite(hp) ? hp : null,
        hpMax: Number.isFinite(hpMax) ? hpMax : null,
        mp: Number.isFinite(mp) ? mp : null,
        mpMax: Number.isFinite(mpMax) ? mpMax : null
    };
}

/**
 * Build a profile-shaped object for the shared preview popup / card.
 * Accepts a live Player entity or a form member row.
 *
 * @param {object|null|undefined} source
 * @param {{ live?: boolean, mode?: string }} [opts]
 * @returns {object|null}
 */
function buildPreviewProfile(source, opts) {
    if (!source || typeof source !== 'object') return null;
    const o = opts || {};
    const live = !!o.live;

    const classId =
        source.classId != null
            ? String(source.classId)
            : source.vocation != null
              ? String(source.vocation)
              : 'adventurer';
    const name =
        source.name != null
            ? String(source.name)
            : source.label != null
              ? String(source.label)
              : classId;
    const level =
        source.level != null && Number.isFinite(Number(source.level))
            ? Math.max(1, Math.floor(Number(source.level)))
            : 1;

    /** @type {Record<string, string>} */
    const equipment = equipmentToDesignerSlots(source.equipment);

    /** @type {object} */
    const profile = {
        id:
            source.profileId != null
                ? String(source.profileId)
                : source.id != null
                  ? String(source.id)
                  : name,
        label: name,
        vocation: classId,
        level,
        promoted: !!source.promoted,
        skills:
            source.skills && typeof source.skills === 'object'
                ? Object.assign({}, source.skills)
                : {},
        stats:
            source.stats && typeof source.stats === 'object'
                ? Object.assign({}, source.stats)
                : {},
        equipment,
        strategyId:
            source.strategyId != null
                ? String(source.strategyId)
                : source.strategy && source.strategy.id
                  ? String(source.strategy.id)
                  : null,
        notes: live
            ? 'Live session snapshot (active camera player).'
            : source.notes != null
              ? String(source.notes)
              : ''
    };

    const vitals = readSourceVitals(source);
    const hasHp = vitals.hp != null || vitals.hpMax != null;
    const hasMp = vitals.mp != null || vitals.mpMax != null;
    if (live || hasHp) {
        if (vitals.hp != null && vitals.hpMax != null) {
            profile.hp = vitals.hp;
            profile.hpMax = vitals.hpMax;
        }
    }
    if (live || hasMp) {
        if (vitals.mp != null && vitals.mpMax != null) {
            profile.mp = vitals.mp;
            profile.mpMax = vitals.mpMax;
        }
    }

    return profile;
}

/**
 * Resolve equipment sprite URL (mirrors profile_preview widget).
 * @param {object|string|null} item
 * @param {string} genre
 * @returns {string|null}
 */
function resolveUiSpriteUrl(spriteId, genre) {
    if (!spriteId) return null;
    const stem = String(spriteId)
        .trim()
        .replace(/\.png$/i, '')
        .split(/[_\s-]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
        .join('_');
    const g = genre || 'rpg_fantasy';
    return appUrl(`assets/sprites/${g}/ui/alpha/${stem}.png`);
}

function resolveItemSpriteUrl(item, genre) {
    if (!item) return null;
    if (typeof item === 'object') {
        if (item.sprites) {
            if (item.sprites.alpha) return appUrl(item.sprites.alpha);
            if (item.sprites.icon) return appUrl(item.sprites.icon);
            if (item.sprites.original) return appUrl(item.sprites.original);
        }
        if (item.sprite) {
            if (typeof item.sprite === 'string') return appUrl(item.sprite);
            if (item.sprite.legacy) return appUrl(item.sprite.legacy);
        }
    }
    const itemId =
        typeof item === 'string'
            ? item
            : item.customSprite || item.spriteId || item.id || '';
    if (!itemId) return null;
    const stem = String(itemId)
        .trim()
        .replace(/\.png$/i, '')
        .split(/[_\s-]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
        .join('_');
    const g = genre || 'rpg_fantasy';
    return appUrl(`assets/sprites/${g}/equipment/alpha/${stem}.png`);
}

/**
 * Resolve charges/duration overlay for one designer equipment slot.
 * Prefers live equipmentRuntime when the source is a Player entity.
 *
 * @param {string} slotKey designer slot id
 * @param {string} itemId
 * @param {object[]|Record<string, object>|null} itemDb
 * @param {object|null|undefined} source player or form member
 * @returns {{ charges: number|null, durationSec: number|null, durationText: string|null, sig: string }}
 */
function budgetForDesignerSlot(slotKey, itemId, itemDb, source) {
    const cleanId = itemId && String(itemId).trim() ? String(itemId).trim() : '';
    const item = cleanId ? findItem(itemDb, cleanId) : null;
    const engineSlot = DESIGNER_TO_ENGINE[slotKey] || slotKey;
    let instance = null;
    let runtime = null;
    if (source && isRuntimeInventory(source.inventory) && cleanId) {
        const uid =
            source.inventory.equipment && source.inventory.equipment[engineSlot];
        if (uid) {
            instance = getItem(source.inventory, uid);
            if (instance && instance.itemId !== cleanId) instance = null;
        }
        if (
            source.equipmentRuntime &&
            source.equipmentRuntime[engineSlot] &&
            source.equipmentRuntime[engineSlot].itemId === cleanId
        ) {
            runtime = source.equipmentRuntime[engineSlot];
        }
    }
    return resolveItemBudgetDisplay({ item, instance, runtime });
}

/**
 * Compact budget signature for all designer equipment slots (card-level dirty).
 * @param {object|null|undefined} source
 * @param {Record<string, string>} equipment designer map
 * @param {object[]|Record<string, object>|null} itemDb
 * @returns {string}
 */
function equipmentBudgetSignature(source, equipment, itemDb) {
    if (!equipment || typeof equipment !== 'object') return '';
    const parts = [];
    for (let i = 0; i < DESIGNER_SLOTS.length; i++) {
        const slotKey = DESIGNER_SLOTS[i];
        const id = equipment[slotKey];
        if (!id) continue;
        const b = budgetForDesignerSlot(slotKey, String(id), itemDb, source);
        if (b.sig !== 'c:d') parts.push(`${slotKey}:${b.sig}`);
    }
    return parts.join('|');
}

/**
 * Paint one equipment slot only when its painted key changed.
 * Key includes genre, itemId, and charges/duration (floored seconds) so timed
 * gear updates once per second without wiping images every poll tick.
 *
 * @param {HTMLElement} slotEl
 * @param {string} slotKey designer slot id
 * @param {string} itemId empty string = empty slot
 * @param {object[]|Record<string, object>|null} itemDb
 * @param {string} genre
 * @param {object|null|undefined} [source] player for live budgets
 * @returns {number} item weight (0 if empty / unknown)
 */
function paintEquipmentSlotIfDirty(slotEl, slotKey, itemId, itemDb, genre, source) {
    const cleanId = itemId && String(itemId).trim() ? String(itemId).trim() : '';
    const budget = cleanId
        ? budgetForDesignerSlot(slotKey, cleanId, itemDb, source)
        : { charges: null, durationSec: null, durationText: null, sig: 'c:d' };
    const paintKey = `${genre}::${cleanId}::${budget.sig}`;
    if (slotEl.dataset.paintedKey === paintKey) {
        if (!cleanId) return 0;
        const cached = findItem(itemDb, cleanId);
        return cached && cached.weight ? Number(cached.weight) || 0 : 0;
    }
    slotEl.dataset.paintedKey = paintKey;
    slotEl.innerHTML = '';
    if (!cleanId) {
        slotEl.innerHTML = `<span class="slot-placeholder">${SLOT_PLACEHOLDERS[slotKey] || ''}</span>`;
        return 0;
    }
    const item = findItem(itemDb, cleanId) || { id: cleanId, label: cleanId };
    const weight = item.weight ? Number(item.weight) || 0 : 0;
    const img = document.createElement('img');
    const primaryUrl = resolveItemSpriteUrl(item, genre);
    if (primaryUrl) img.src = primaryUrl;
    img.alt = item.label || cleanId;
    let title = `${item.label || cleanId} (${slotKey})`;
    if (budget.charges != null && budget.charges > 0) {
        title += ` · ${budget.charges} charges`;
    }
    if (budget.durationText) title += ` · ${budget.durationText}`;
    img.title = title;
    img.draggable = false;
    img.onerror = () => {
        const fallback = appUrl(
            `assets/sprites/${genre}/equipment/small/${cleanId}.png`
        );
        if (img.src !== fallback) {
            img.src = fallback;
        } else {
            slotEl.innerHTML = `<span class="small font-monospace" style="font-size:9px;">${cleanId.slice(0, 3)}</span>`;
        }
    };
    slotEl.appendChild(img);
    if (budget.charges != null && budget.charges > 0) {
        const ch = document.createElement('span');
        ch.className = 'item-charges-badge';
        ch.textContent = String(budget.charges);
        slotEl.appendChild(ch);
    }
    if (budget.durationText) {
        const dur = document.createElement('span');
        dur.className = 'item-duration-badge';
        dur.textContent = budget.durationText;
        slotEl.appendChild(dur);
    }
    return weight;
}

/**
 * Paint designer-slot equipment into a card root element.
 * Slot DOM is updated only when itemId/genre/charges/duration for that slot
 * change (dirty). Cap/soul text always refreshes when this is called.
 * Status strip paints from source.conditions plus tile-zone flags
 * (`opts.tileMap` → protection zone).
 *
 * @param {HTMLElement|null} cardEl
 * @param {object|null} profile from buildPreviewProfile
 * @param {{ itemDb?: object[]|Record<string, object>|null, genre?: string, soulEl?: HTMLElement|null, capEl?: HTMLElement|null, statusBarEl?: HTMLElement|null, carriedWeight?: number|null, force?: boolean, source?: object|null, tileMap?: object|null }} [opts]
 */
function renderEquipmentCard(cardEl, profile, opts) {
    if (!cardEl) return;
    const o = opts || {};
    const itemDb = o.itemDb || null;
    const genre = o.genre || 'rpg_fantasy';
    const force = !!o.force;
    const source = o.source || null;
    const equipment =
        profile && profile.equipment && typeof profile.equipment === 'object'
            ? profile.equipment
            : {};

    let totalWeight = 0;

    for (let i = 0; i < DESIGNER_SLOTS.length; i++) {
        const slotKey = DESIGNER_SLOTS[i];
        const slotEl = cardEl.querySelector(`[data-slot="${slotKey}"]`);
        if (!slotEl) continue;
        if (force) delete slotEl.dataset.paintedKey;
        const itemId = equipment[slotKey];
        const cleanId =
            itemId && String(itemId).trim() ? String(itemId).trim() : '';
        totalWeight += paintEquipmentSlotIfDirty(
            slotEl,
            slotKey,
            cleanId,
            itemDb,
            genre,
            source
        );
    }

    // Light / utility slot stays decorative for now
    const lightEl = cardEl.querySelector('[data-slot="light"]');
    if (lightEl) {
        if (force) delete lightEl.dataset.paintedKey;
        if (lightEl.dataset.paintedKey !== `${genre}::`) {
            lightEl.dataset.paintedKey = `${genre}::`;
            lightEl.innerHTML = `<span class="slot-placeholder">${SLOT_PLACEHOLDERS.light}</span>`;
        }
    }

    const level =
        profile && profile.level != null
            ? Math.max(1, parseInt(profile.level, 10) || 1)
            : 50;
    const classId =
        (profile && (profile.classId || profile.vocation || profile.class)) ||
        null;
    // Prefer full inventory weight (equipped + backpack tree) when provided
    if (o.carriedWeight != null && Number.isFinite(Number(o.carriedWeight))) {
        totalWeight = Number(o.carriedWeight);
    }
    const currentCap = remainingCapacity(level, totalWeight, classId);
    if (o.soulEl) o.soulEl.textContent = '100';
    if (o.capEl) o.capEl.textContent = currentCap.toLocaleString();

    const statusBarEl =
        o.statusBarEl ||
        cardEl.querySelector('.eq-status-bar') ||
        null;
    renderStatusBar(statusBarEl, source, { force, tileMap: o.tileMap || null });
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Human-readable equipment slot label + icon (matches profile_preview modal).
 * @param {string|null|undefined} slot
 * @returns {{ icon: string, label: string }}
 */
function formatSlotInfo(slot) {
    const s = String(slot || '').toLowerCase();
    if (s === 'head' || s === 'helmet') {
        return { icon: 'fa-solid fa-helmet-safety', label: 'Helmet (Head)' };
    }
    if (s === 'chest' || s === 'armor' || s === 'body') {
        return { icon: 'fa-solid fa-vest', label: 'Armor (Chest)' };
    }
    if (s === 'legs') return { icon: 'fa-solid fa-socks', label: 'Legs / Pants' };
    if (s === 'boots' || s === 'feet') {
        return { icon: 'fa-solid fa-shoe-prints', label: 'Boots (Feet)' };
    }
    if (s === 'righthand' || s === 'weapon') {
        return { icon: 'fa-solid fa-hand-fist', label: 'Weapon (Right Hand)' };
    }
    if (s === 'lefthand' || s === 'shield') {
        return { icon: 'fa-solid fa-shield', label: 'Shield (Left Hand)' };
    }
    if (s === 'amulet' || s === 'neck') {
        return { icon: 'fa-solid fa-gem', label: 'Amulet (Neck)' };
    }
    if (s === 'ring') return { icon: 'fa-solid fa-ring', label: 'Ring' };
    if (s === 'backpack' || s === 'container' || s === 'bag') {
        return { icon: 'fa-solid fa-bag-shopping', label: 'Backpack' };
    }
    return { icon: 'fa-solid fa-box', label: String(slot || 'Equipment') };
}

/**
 * @param {string|null|undefined} str
 * @returns {string}
 */
function formatPropLabel(str) {
    const s = String(str || '');
    return s.replace(/([A-Z])/g, ' $1').replace(/^./, (ch) => ch.toUpperCase());
}

/**
 * Build HTML for the equipment item stats body (profile_preview parity).
 *
 * @param {object|null|undefined} item
 * @param {{ slotKey?: string|null, genre?: string, spriteUrl?: string|null }} [opts]
 * @returns {string}
 */
function buildEquipmentItemDetailHtml(item, opts) {
    if (!item || typeof item !== 'object') {
        return '<p class="text-muted small mb-0">No item data.</p>';
    }
    const o = opts || {};
    const slotKey = o.slotKey != null ? o.slotKey : item.slot;
    const spriteUrl =
        o.spriteUrl != null
            ? o.spriteUrl
            : resolveItemSpriteUrl(item, o.genre || 'rpg_fantasy');
    const slotInfo = formatSlotInfo(slotKey);
    const title = escapeHtml(item.label || item.name || item.id || 'Item');
    const idStr = escapeHtml(item.id || '');

    let pillsHtml = '';
    if (
        item.twoHanded === true ||
        item.twoHanded === 'true' ||
        item.twoHanded === 1
    ) {
        pillsHtml +=
            '<span class="eq-pill" style="color:#d2a8ff;border-color:rgba(210,168,255,0.4)"><i class="fa-solid fa-hands"></i> 2-Handed (2h)</span>';
    } else if (item.category === 'weapon' || item.weaponType || item.atk != null || item.slot === 'weapon') {
        pillsHtml +=
            '<span class="eq-pill" style="color:#a8d2ff;border-color:rgba(168,210,255,0.4)"><i class="fa-solid fa-hand"></i> 1-Handed (1h)</span>';
    }
    if (item.imbuementSlots != null && Number(item.imbuementSlots) > 0) {
        pillsHtml += `<span class="eq-pill" style="color:#7bc8ff;border-color:rgba(123,200,255,0.4)"><i class="fa-solid fa-gem"></i> ${escapeHtml(String(item.imbuementSlots))} Imbuement Slots</span>`;
    }

    let statRows = '';
    /**
     * @param {string} icon
     * @param {string} label
     * @param {string} value
     * @param {string} [valClass]
     */
    const addRow = (icon, label, value, valClass) => {
        statRows += `
            <tr>
                <td class="eq-stat-label"><i class="${icon}"></i> ${escapeHtml(label)}</td>
                <td class="eq-stat-val ${valClass || ''}">${value}</td>
            </tr>
        `;
    };

    const lvl = item.level != null ? item.level : 1;
    addRow(
        'fa-solid fa-graduation-cap',
        'Required Level',
        `Lvl ${escapeHtml(String(lvl))}`,
        'text-info'
    );
    addRow(slotInfo.icon, 'Slot', escapeHtml(slotInfo.label), 'text-warning');

    if (item.category) {
        let catStr = String(item.category);
        if (item.weaponType) catStr += ` (${item.weaponType})`;
        addRow('fa-solid fa-layer-group', 'Category', escapeHtml(catStr), '');
    }

    if (item.vocation != null) {
        const vocStr = Array.isArray(item.vocation)
            ? item.vocation.join(', ')
            : String(item.vocation);
        if (vocStr) {
            addRow('fa-solid fa-user-shield', 'Vocation', escapeHtml(vocStr), '');
        }
    }

    if (item.volume != null && Number(item.volume) > 0) {
        addRow(
            'fa-solid fa-boxes-stacked',
            'Capacity',
            `${escapeHtml(String(Math.floor(Number(item.volume))))} slots`,
            'text-info'
        );
    }

    if (item.range != null && Number(item.range) > 0) {
        addRow(
            'fa-solid fa-crosshair',
            'Range',
            `${escapeHtml(String(item.range))} tiles`,
            ''
        );
    }

    if (item.min != null || item.max != null) {
        const lo = item.min != null ? Number(item.min) : Number(item.max);
        const hi = item.max != null ? Number(item.max) : Number(item.min);
        const span = lo === hi ? String(lo) : `${lo}–${hi}`;
        const el = item.element ? ` ${formatPropLabel(item.element)}` : '';
        addRow(
            'fa-solid fa-wand-magic-sparkles',
            'Attack',
            escapeHtml(`${span}${el}`),
            'text-danger fw-bold'
        );
    }

    if (item.manaGain != null && Number(item.manaGain) > 0) {
        addRow(
            'fa-solid fa-droplet',
            'Mana Gain',
            `+${escapeHtml(String(Math.floor(Number(item.manaGain))))} on damaging auto`,
            'text-info'
        );
    }

    if (item.atk != null && item.atk !== 0) {
        addRow(
            'fa-solid fa-burst',
            'Attack (Physical)',
            `+${escapeHtml(String(item.atk))}`,
            'text-danger fw-bold'
        );
    }

    if (item.extraAtk != null || item.extraAtkElement != null) {
        const valNum = Number(item.extraAtk) || 0;
        const elemStr = item.extraAtkElement
            ? formatPropLabel(item.extraAtkElement)
            : '';
        let extraVal = '';
        if (valNum > 0 && elemStr) extraVal = `+${valNum} (${elemStr})`;
        else if (valNum > 0) extraVal = `+${valNum}`;
        else if (elemStr) extraVal = elemStr;
        if (extraVal) {
            addRow(
                'fa-solid fa-fire',
                'Elemental Attack',
                escapeHtml(extraVal),
                'text-warning'
            );
        }
    }

    if (item.armor != null && item.armor !== 0) {
        addRow(
            'fa-solid fa-shield-halved',
            'Armor',
            `+${escapeHtml(String(item.armor))}`,
            'text-warning fw-bold'
        );
    }

    if (
        (item.defense != null && item.defense !== 0) ||
        (item.defenseBonus != null && item.defenseBonus !== 0)
    ) {
        const defBase = Number(item.defense) || 0;
        const defBonus = Number(item.defenseBonus) || 0;
        let defStr = String(defBase);
        if (defBonus > 0) defStr += ` (+${defBonus} bonus)`;
        else if (defBonus < 0) defStr += ` (${defBonus} bonus)`;
        addRow(
            'fa-solid fa-shield',
            'Defense',
            escapeHtml(defStr),
            'text-primary fw-bold'
        );
    }

    if (item.speed != null && item.speed !== 0) {
        const speedVal = Number(item.speed);
        const speedStr = speedVal >= 0 ? `+${speedVal}` : `${speedVal}`;
        addRow(
            'fa-solid fa-bolt',
            'Speed',
            escapeHtml(speedStr),
            'text-success'
        );
    }

    if (item.weight != null) {
        const weightOz = Math.round(Number(item.weight) / 100);
        addRow(
            'fa-solid fa-weight-hanging',
            'Weight',
            `${escapeHtml(String(weightOz))} oz (${escapeHtml(String(item.weight))} g)`,
            'text-muted'
        );
    }

    let specialPillsHtml = '';
    const specialLines = catalogSpecialBonusLines(item);
    for (let i = 0; i < specialLines.length; i++) {
        specialPillsHtml += `<span class="eq-pill eq-pill-bonus">${escapeHtml(specialLines[i])}</span>`;
    }

    let bonusPillsHtml = '';
    const bonusesObj = item.skillBonuses || item.skills || item.bonuses;
    if (bonusesObj && typeof bonusesObj === 'object') {
        const keys = Object.keys(bonusesObj);
        for (let i = 0; i < keys.length; i++) {
            const k = keys[i];
            const val = bonusesObj[k];
            if (val == null || val === 0) continue;
            const sign = Number(val) >= 0 ? '+' : '';
            bonusPillsHtml += `<span class="eq-pill eq-pill-bonus">${escapeHtml(formatPropLabel(k))}: ${escapeHtml(sign + String(val))}</span>`;
        }
    }

    let resistPillsHtml = '';
    const resistsObj = item.resists || item.resistances || item.elementalReduction;
    if (resistsObj && typeof resistsObj === 'object') {
        const keys = Object.keys(resistsObj);
        for (let i = 0; i < keys.length; i++) {
            const k = keys[i];
            const val = resistsObj[k];
            if (val == null || val === 0) continue;
            const sign = Number(val) >= 0 ? '+' : '';
            resistPillsHtml += `<span class="eq-pill eq-pill-resist">${escapeHtml(formatPropLabel(k))}: ${escapeHtml(sign + String(val))}%</span>`;
        }
    }

    const notes =
        item.notes != null
            ? String(item.notes)
            : item.description != null
              ? String(item.description)
              : '';

    const thumb = spriteUrl
        ? `<img src="${escapeHtml(spriteUrl)}" alt="${title}" onerror="this.style.display='none'">`
        : '';

    return `
        <div class="eq-modal-thumb">${thumb}</div>
        <div class="eq-modal-title">${title}</div>
        <div class="eq-modal-id">${idStr}</div>
        ${pillsHtml ? `<div class="text-center mb-3">${pillsHtml}</div>` : ''}
        <table class="eq-stat-table"><tbody>${statRows}</tbody></table>
        ${
            specialPillsHtml
                ? `<div class="mb-3">
                    <h6 class="small text-muted text-uppercase font-monospace mb-1"><i class="fa-solid fa-wand-magic-sparkles"></i> Special Bonuses</h6>
                    <div>${specialPillsHtml}</div>
                </div>`
                : ''
        }
        ${
            bonusPillsHtml
                ? `<div class="mb-3">
                    <h6 class="small text-muted text-uppercase font-monospace mb-1"><i class="fa-solid fa-wand-magic-sparkles"></i> Skill &amp; Stat Bonuses</h6>
                    <div>${bonusPillsHtml}</div>
                </div>`
                : ''
        }
        ${
            resistPillsHtml
                ? `<div class="mb-3">
                    <h6 class="small text-muted text-uppercase font-monospace mb-1"><i class="fa-solid fa-shield-virus"></i> Resists &amp; Reductions</h6>
                    <div>${resistPillsHtml}</div>
                </div>`
                : ''
        }
        ${
            notes
                ? `<div class="p-2 bg-dark rounded border border-secondary small text-muted font-monospace">${escapeHtml(notes)}</div>`
                : ''
        }
    `;
}

/**
 * Ensure the shared item-details modal shell exists (pure CSS, no Bootstrap JS).
 * @returns {{ root: HTMLElement, title: HTMLElement, body: HTMLElement }}
 */
function ensureItemDetailsModal() {
    let root = document.getElementById('itemDetailsModal');
    if (!root) {
        root = document.createElement('div');
        root.id = 'itemDetailsModal';
        root.className = 'party-details-modal item-details-modal';
        root.hidden = true;
        root.setAttribute('aria-hidden', 'true');
        root.setAttribute('role', 'dialog');
        root.setAttribute('aria-modal', 'true');
        root.setAttribute('aria-labelledby', 'itemDetailsTitle');
        root.innerHTML = `
            <div class="party-details-dialog item-details-dialog">
                <div class="party-details-header">
                    <h2 id="itemDetailsTitle" class="party-details-title">Item</h2>
                    <button type="button" class="btn btn-sm btn-outline-secondary" data-item-details-close aria-label="Close">
                        <i class="fa-solid fa-xmark" aria-hidden="true"></i>
                    </button>
                </div>
                <div id="itemDetailsBody" class="party-details-body item-details-body"></div>
            </div>
        `;
        document.body.appendChild(root);

        const close = () => hideItemDetailsModal();
        root.addEventListener('click', (ev) => {
            const t = /** @type {HTMLElement} */ (ev.target);
            if (t === root || (t && t.closest && t.closest('[data-item-details-close]'))) {
                close();
            }
        });
        document.addEventListener('keydown', (ev) => {
            if (ev.key === 'Escape' && root && !root.hidden) close();
        });
    }
    const title = /** @type {HTMLElement} */ (
        root.querySelector('#itemDetailsTitle')
    );
    const body = /** @type {HTMLElement} */ (
        root.querySelector('#itemDetailsBody')
    );
    return { root, title, body };
}

/**
 * Close the in-page item details modal.
 */
function hideItemDetailsModal() {
    const root = document.getElementById('itemDetailsModal');
    if (!root) return;
    root.hidden = true;
    root.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('item-details-open');
}

/**
 * Show equipment item stats in an in-page modal (same content as profile_preview
 * click-on-equipment modal). Used by inventory "View details".
 *
 * @param {object|null|undefined} item catalog item
 * @param {{ slotKey?: string|null, genre?: string }} [opts]
 * @returns {boolean}
 */
function showEquipmentItemModal(item, opts) {
    if (!item || typeof document === 'undefined') return false;
    const o = opts || {};
    const { root, title, body } = ensureItemDetailsModal();
    const label = item.label || item.name || item.id || 'Item';
    if (title) title.textContent = String(label);
    if (body) {
        body.innerHTML = buildEquipmentItemDetailHtml(item, {
            slotKey: o.slotKey,
            genre: o.genre
        });
    }
    root.hidden = false;
    root.setAttribute('aria-hidden', 'false');
    document.body.classList.add('item-details-open');
    return true;
}

/**
 * Post profile data into an open profile preview window.
 * @param {Window} win
 * @param {{ mode: string, profile: object, live?: boolean, source?: string }} payload
 */
function postProfilePreviewData(win, payload) {
    if (!win || win.closed || !payload || !payload.profile) return;
    try {
        win.postMessage(
            {
                type: 'PROFILE_PREVIEW_DATA',
                mode: payload.mode || 'standard',
                profile: payload.profile,
                live: !!payload.live,
                source: payload.source || 'hunt'
            },
            window.location.origin
        );
    } catch (_) {
        /* cross-origin / closed */
    }
}

/**
 * Open (or focus) the shared Character Profile Preview popup.
 *
 * @param {{ mode: string, profile: object, live?: boolean, source?: string }} payload
 * @returns {Window|null}
 */
function openProfilePreviewWindow(payload) {
    if (!payload || !payload.profile) return null;
    const mode = payload.mode || 'standard';
    const id = payload.profile.id || '';
    const url =
        appUrl('html/widgets/profile_preview/profile_preview.html') +
        '?mode=' +
        encodeURIComponent(mode) +
        '&id=' +
        encodeURIComponent(id) +
        (payload.live ? '&live=1' : '');

    const win = window.open(
        url,
        PROFILE_PREVIEW_WINDOW,
        'width=840,height=880,resizable=yes,scrollbars=yes'
    );
    if (!win) return null;
    try {
        win.focus();
    } catch (_) {}

    const send = () => postProfilePreviewData(win, payload);
    setTimeout(send, 200);
    setTimeout(send, 600);
    return win;
}

/**
 * Resolve the active (camera-focused) party member from a Simulator.
 * @param {object|null|undefined} sim
 * @returns {object|null}
 */
function getActivePlayerFromSim(sim) {
    if (!sim) return null;
    if (typeof sim.getCameraFocusMember === 'function') {
        const m = sim.getCameraFocusMember();
        if (m) return m;
    }
    const party = sim.parties && sim.parties[0];
    if (!party || !Array.isArray(party.members) || !party.members.length) {
        return null;
    }
    for (let i = 0; i < party.members.length; i++) {
        if (party.members[i] && party.members[i].isLeader) {
            return party.members[i];
        }
    }
    return party.members[0] || null;
}

/**
 * Wire the below-canvas equipment card + Details → shared preview popup.
 *
 * @param {object} opts
 * @param {() => object|null} opts.getSim
 * @param {() => object|null} [opts.getIdleMember] form member when no session
 * @param {() => object[]|Record<string, object>|null} opts.getItemDb
 * @param {() => string} opts.getModeId
 * @param {() => string} [opts.getGenre]
 * @param {() => boolean} [opts.isSessionLive]
 * @param {number} [opts.cardIntervalMs=400]
 * @param {number} [opts.previewIntervalMs=1000]
 * @returns {{ refresh: () => void, dispose: () => void, openDetails: () => void }}
 */
function bindEquipmentPanel(opts) {
    const o = opts || {};
    const cardEl = document.getElementById('activeEquipmentCard');
    const soulEl = document.getElementById('activeEqSoul');
    const capEl = document.getElementById('activeEqCap');
    const statusBarEl =
        document.getElementById('activeEqStatusBar') ||
        (cardEl ? cardEl.querySelector('.eq-status-bar') : null);
    const detailsBtn = document.getElementById('equipmentDetailsBtn');

    /** @type {Window|null} */
    let previewWin = null;
    /** @type {ReturnType<typeof setInterval>|null} */
    let cardTimer = null;
    /** @type {ReturnType<typeof setInterval>|null} */
    let previewTimer = null;
    /**
     * Card paint signature: gear + Cap + active condition kinds.
     * HP/MP change every combat tick and must NOT dirty the card (that
     * rebuilt <img> nodes and caused the equipment panel to flicker).
     * Condition kind set dirties when statuses appear/expire (not every DoT tick).
     * Mana-shield pool remaining updates the strip tooltip without rebuilding slots.
     * Preview popup still gets live vitals via pushPreview ~1/s.
     * null = never painted (so first empty idle still runs once).
     * @type {string|null}
     */
    let lastCardSig = null;

    const genreOf = () => {
        if (typeof o.getGenre === 'function') {
            const g = o.getGenre();
            if (g) return String(g);
        }
        return 'rpg_fantasy';
    };

    const resolveSource = () => {
        const sim = typeof o.getSim === 'function' ? o.getSim() : null;
        const live =
            typeof o.isSessionLive === 'function'
                ? !!o.isSessionLive()
                : !!sim;
        if (sim && live) {
            const player = getActivePlayerFromSim(sim);
            if (player) {
                return { source: player, live: true };
            }
        }
        if (typeof o.getIdleMember === 'function') {
            const idle = o.getIdleMember();
            if (idle) return { source: idle, live: false };
        }
        return { source: null, live: false };
    };

    const buildPayload = () => {
        const { source, live } = resolveSource();
        const profile = buildPreviewProfile(source, { live });
        if (!profile) return null;
        return {
            mode:
                typeof o.getModeId === 'function'
                    ? o.getModeId() || 'standard'
                    : 'standard',
            profile,
            live,
            source: live ? 'hunt' : 'form'
        };
    };

    /**
     * Stable signature for the inline equipment card (not preview popup).
     * Includes floored charges/duration so timed gear dirties ~1/s only.
     * Includes active condition kinds so the status strip appears/clears.
     * @param {object|null} payload
     * @param {number|null} carriedWeight
     * @param {string} genre
     * @param {string} budgetSig
     * @param {string} statusSig
     * @returns {string}
     */
    const cardSignature = (
        payload,
        carriedWeight,
        genre,
        budgetSig,
        statusSig
    ) => {
        if (!payload) return '';
        const p = payload.profile;
        return JSON.stringify({
            id: p.id,
            label: p.label,
            eq: p.equipment,
            level: p.level,
            vocation: p.vocation,
            live: payload.live,
            genre,
            capW: carriedWeight,
            budgets: budgetSig || '',
            status: statusSig || ''
        });
    };

    const paintCard = () => {
        const payload = buildPayload();
        const itemDb =
            typeof o.getItemDb === 'function' ? o.getItemDb() : null;
        const genre = genreOf();
        const { source } = resolveSource();
        let carriedWeight = null;
        // Form members may carry profile *seed* inventory (`{ backpack: [...] }`).
        // Only sum weight from a runtime Inventory (items/containers maps).
        if (source && isRuntimeInventory(source.inventory)) {
            carriedWeight = totalCarriedWeight(source.inventory, itemDb);
        }
        const budgetSig = equipmentBudgetSignature(
            source,
            payload && payload.profile ? payload.profile.equipment : null,
            itemDb
        );
        const sim = typeof o.getSim === 'function' ? o.getSim() : null;
        const tileMap = sim && sim.tileMap ? sim.tileMap : null;
        const statusOpts = { tileMap };
        const statusSig = statusIconsSignature(source, statusOpts);
        const sig = cardSignature(
            payload,
            carriedWeight,
            genre,
            budgetSig,
            statusSig
        );
        if (lastCardSig !== null && sig === lastCardSig) {
            // Kinds / gear / Cap unchanged — skip slot rebuild (HP/MP flicker).
            // Pool remaining still updates the status-strip tooltip.
            renderStatusBar(statusBarEl, source, statusOpts);
            return;
        }
        lastCardSig = sig;
        renderEquipmentCard(cardEl, payload ? payload.profile : null, {
            itemDb,
            genre,
            soulEl,
            capEl,
            statusBarEl,
            carriedWeight,
            source,
            tileMap
        });
    };

    const pushPreview = () => {
        if (!previewWin || previewWin.closed) {
            previewWin = null;
            return;
        }
        const payload = buildPayload();
        if (payload) postProfilePreviewData(previewWin, payload);
    };

    const openDetails = () => {
        const payload = buildPayload();
        if (!payload) return;
        const win = openProfilePreviewWindow(payload);
        if (win) previewWin = win;
    };

    if (detailsBtn) {
        detailsBtn.addEventListener('click', (ev) => {
            ev.preventDefault();
            openDetails();
        });
    }

    // Child READY → re-send current snapshot
    const onMessage = (ev) => {
        if (ev.origin !== window.location.origin) return;
        if (!ev.data || ev.data.type !== 'PROFILE_PREVIEW_READY') return;
        if (previewWin && !previewWin.closed) {
            pushPreview();
        }
    };
    window.addEventListener('message', onMessage);

    const cardMs = o.cardIntervalMs != null ? o.cardIntervalMs : 400;
    const cardIdleMs = o.cardIdleIntervalMs != null ? o.cardIdleIntervalMs : 2000;
    const previewMs =
        o.previewIntervalMs != null ? o.previewIntervalMs : 1000;
    let cardDisposed = false;

    const scheduleCardPaint = () => {
        if (cardDisposed || typeof setTimeout === 'undefined') return;
        if (cardTimer) {
            clearTimeout(cardTimer);
            cardTimer = null;
        }
        const hidden = typeof document !== 'undefined' && document.hidden;
        const live =
            typeof o.isSessionLive === 'function'
                ? !!o.isSessionLive()
                : !!(typeof o.getSim === 'function' && o.getSim());
        const ms = hidden ? 4000 : (live ? cardMs : cardIdleMs);
        cardTimer = setTimeout(() => {
            cardTimer = null;
            if (cardDisposed) return;
            if (!(typeof document !== 'undefined' && document.hidden)) {
                paintCard();
            }
            scheduleCardPaint();
        }, ms);
    };

    paintCard();
    scheduleCardPaint();
    previewTimer = setInterval(() => {
        if (typeof document !== 'undefined' && document.hidden) return;
        if (!previewWin || previewWin.closed) {
            previewWin = null;
            return;
        }
        const live =
            typeof o.isSessionLive === 'function'
                ? !!o.isSessionLive()
                : !!(typeof o.getSim === 'function' && o.getSim());
        // Live session: refresh ~1/s. Idle form uses refresh() on Active change.
        if (live) pushPreview();
    }, previewMs);

    return {
        refresh: () => {
            lastCardSig = null;
            // Force slot repaint after equip/unequip mutations
            if (cardEl) {
                const slots = cardEl.querySelectorAll('[data-slot]');
                for (let i = 0; i < slots.length; i++) {
                    delete /** @type {HTMLElement} */ (slots[i]).dataset
                        .paintedKey;
                }
            }
            paintCard();
            pushPreview();
        },
        openDetails,
        dispose: () => {
            cardDisposed = true;
            if (cardTimer) clearTimeout(cardTimer);
            if (previewTimer) clearInterval(previewTimer);
            cardTimer = null;
            previewTimer = null;
            window.removeEventListener('message', onMessage);
            previewWin = null;
        }
    };
}

module.exports = {
    PROFILE_PREVIEW_WINDOW,
    DESIGNER_SLOTS,
    ENGINE_TO_DESIGNER,
    DESIGNER_TO_ENGINE,
    STATUS_ICON_META,
    STATUS_ICON_ORDER,
    equipmentToDesignerSlots,
    listActiveStatusIcons,
    statusIconsSignature,
    isSourceOnProtectionZone,
    renderStatusBar,
    readSourceVitals,
    buildPreviewProfile,
    resolveItemSpriteUrl,
    resolveUiSpriteUrl,
    renderEquipmentCard,
    budgetForDesignerSlot,
    equipmentBudgetSignature,
    buildEquipmentItemDetailHtml,
    showEquipmentItemModal,
    hideItemDetailsModal,
    postProfilePreviewData,
    openProfilePreviewWindow,
    getActivePlayerFromSim,
    bindEquipmentPanel
};
