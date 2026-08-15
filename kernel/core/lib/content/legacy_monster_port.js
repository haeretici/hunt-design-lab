/**
 * Pure converters: legacy monsters.json → hunt-design-lab combat templates.
 *
 * Legacy shape (OTBM/wiki dump):
 *   health, experience, speed, defenses.{armor,mitigation}, elements (100 = normal),
 *   flags.{targetDistance,runHealth,staticAttackChance}, strategiesTarget,
 *   attacks[] with name/type/minDamage/maxDamage (damage often negative).
 *
 * Engine shape: presets/creatures/<id>.json (see creature_kit + docs/09).
 */

'use strict';

const { DEFAULT_CREATURE_COMBAT } = require('./defaults.js');

/** Elements we map into combat resists. */
const COMBAT_ELEMENTS = [
    'physical',
    'fire',
    'ice',
    'energy',
    'earth',
    'holy',
    'death'
];

/** Attack names that are not direct damage (port as metadata only / skip damage). */
const NON_DAMAGE_ATTACK_NAMES = new Set([
    'speed',
    'drunk',
    'condition',
    'outfit',
    'invisible',
    'paralyze'
]);

/** Engine DoT condition kinds (must match conditions.js DOT_KIND_SET). */
const DOT_CONDITION_TYPES = new Set([
    'poison',
    'fire',
    'ice',
    'energy',
    'bleed',
    'curse'
]);

/**
 * Normalize legacy CONDITION_* / free-text type → engine condition kind.
 * @param {string} raw
 * @returns {string|null}
 */
function mapConditionType(raw) {
    let t = String(raw || '')
        .toLowerCase()
        .replace(/^condition_/, '');
    if (t === 'freezing') t = 'ice';
    if (t === 'bleeding') t = 'bleed';
    if (t === 'cursed') t = 'curse';
    if (t === 'electrification' || t === 'electrify') t = 'energy';
    if (DOT_CONDITION_TYPES.has(t)) return t;
    if (t === 'slow' || t === 'haste' || t === 'invisible' || t === 'invisibility') {
        return t === 'invisibility' ? 'invisible' : t;
    }
    return null;
}

/**
 * Combat element for a condition kind (VFX / kit element field).
 * @param {string} kind
 * @returns {string}
 */
function conditionKindToElement(kind) {
    switch (String(kind || '')) {
        case 'poison':
            return 'earth';
        case 'fire':
            return 'fire';
        case 'ice':
            return 'ice';
        case 'energy':
            return 'energy';
        case 'bleed':
            return 'physical';
        case 'curse':
            return 'death';
        default:
            return 'physical';
    }
}

/**
 * Map legacy CONDITION_* / condition_poison style type → engine condition def.
 * @param {object|string|null|undefined} raw
 * @returns {{ type: string, totalDamage?: number, intervalMs?: number, speedChange?: number, durationSec?: number }|null}
 */
function convertCondition(raw) {
    if (raw == null) return null;
    if (typeof raw === 'string') {
        const kind = mapConditionType(raw);
        if (kind && DOT_CONDITION_TYPES.has(kind)) {
            return { type: kind };
        }
        return null;
    }
    if (typeof raw !== 'object') return null;

    let type = String(raw.type || raw.kind || raw.name || '')
        .toLowerCase()
        .replace(/^condition_/, '');
    if (!type && raw.speedChange != null) {
        const sc = Number(raw.speedChange) || 0;
        if (sc === 0) return null;
        type = sc < 0 ? 'slow' : 'haste';
    }

    /** @type {object} */
    const out = {};
    if (type === 'speed') {
        const sc = Number(raw.speedChange) || 0;
        if (sc === 0) return null;
        out.type = sc < 0 ? 'slow' : 'haste';
    } else {
        const kind = mapConditionType(type);
        if (!kind) return null;
        out.type = kind;
    }

    if (raw.totalDamage != null) {
        out.totalDamage = Math.max(0, Math.abs(Number(raw.totalDamage) || 0));
    }
    if (raw.interval != null || raw.intervalMs != null) {
        const n =
            raw.intervalMs != null
                ? Number(raw.intervalMs)
                : Number(raw.interval);
        if (Number.isFinite(n) && n > 0) {
            out.intervalMs = n > 20 ? Math.round(n) : Math.round(n * 1000);
        }
    }
    if (raw.speedChange != null) {
        out.speedChange = Number(raw.speedChange) || 0;
    }
    if (raw.duration != null || raw.durationSec != null || raw.durationMs != null) {
        if (raw.durationSec != null) {
            out.durationSec = Math.max(0, Number(raw.durationSec) || 0);
        } else if (raw.durationMs != null) {
            out.durationSec = Math.max(0, (Number(raw.durationMs) || 0) / 1000);
        } else {
            out.durationSec = Math.max(0, (Number(raw.duration) || 0) / 1000);
        }
    }

    // DoT requires damage; haste/slow need speedChange; invisible needs duration
    if (DOT_CONDITION_TYPES.has(out.type) && !(out.totalDamage > 0)) {
        return null;
    }
    if (
        (out.type === 'slow' || out.type === 'haste') &&
        !(out.speedChange && out.speedChange !== 0)
    ) {
        return null;
    }
    return out;
}

/**
 * Map legacy element / condition_poison type string → combat element.
 * @param {string} raw
 * @returns {string}
 */
function mapAttackElement(raw) {
    const element = String(raw || 'physical')
        .toLowerCase()
        .replace(/^me_/, '')
        .replace(/^condition_/, '');
    if (COMBAT_ELEMENTS.includes(element)) return element;
    if (element === 'lifedrain' || element === 'manadrain') return element;
    if (element === 'poison' || element === 'earth') return 'earth';
    if (element === 'freezing') return 'ice';
    if (element === 'bleeding' || element === 'bleed') return 'physical';
    if (element === 'cursed' || element === 'curse') return 'death';
    if (element === 'electrification' || element === 'electrify') return 'energy';
    return 'physical';
}

/**
 * Convert one legacy defense_spells row → engine defenseSpell (heal/haste/invis).
 * Skips outfit, summon, armor buff, and unnamed custom scripts without numbers.
 * @param {object} raw
 * @param {number} index
 * @returns {object|null}
 */
function convertDefenseSpell(raw, index) {
    if (!raw || typeof raw !== 'object') return null;
    const name = String(raw.name || '').toLowerCase();
    const type = String(raw.type || '').toLowerCase();
    const intervalMs =
        raw.interval != null
            ? Math.max(50, Number(raw.interval) || 2000)
            : raw.intervalMs != null
              ? Math.max(50, Number(raw.intervalMs) || 2000)
              : 2000;
    const chance =
        raw.chance != null
            ? Math.max(0, Math.min(100, Number(raw.chance) || 0))
            : 100;
    const effect = raw.effect != null ? String(raw.effect) : undefined;

    // Self-heal: type healing with damage range (most common: name "combat")
    const isHeal =
        type === 'healing' ||
        (name.includes('heal') && absDamageRange(raw));
    if (isHeal) {
        const dmg = absDamageRange(raw);
        if (!dmg || (dmg.min <= 0 && dmg.max <= 0)) return null;
        /** @type {object} */
        const spell = {
            id: `heal_${index}`,
            kind: 'heal',
            intervalMs,
            chance,
            min: dmg.min,
            max: dmg.max,
            // Cast when current HP fraction is below this (legacy-ish urgency)
            hpBelow: 0.7
        };
        if (effect) spell.effect = effect;
        if (raw.name) spell.legacyName = String(raw.name);
        return spell;
    }

    // Haste / self-speed (name speed|haste with positive speedChange)
    if (name === 'speed' || name === 'haste') {
        const sc = Number(raw.speedChange) || 0;
        if (!(sc > 0)) return null;
        const durationSec =
            raw.duration != null
                ? Math.max(0.1, (Number(raw.duration) || 5000) / 1000)
                : 5;
        /** @type {object} */
        const spell = {
            id: `haste_${index}`,
            kind: 'haste',
            intervalMs,
            chance,
            speedChange: sc,
            durationSec
        };
        if (effect) spell.effect = effect;
        if (raw.name) spell.legacyName = String(raw.name);
        return spell;
    }

    // Self invisible
    if (name === 'invisible' || name === 'invisibility') {
        const durationSec =
            raw.duration != null
                ? Math.max(0.1, (Number(raw.duration) || 2000) / 1000)
                : 2;
        /** @type {object} */
        const spell = {
            id: `invisible_${index}`,
            kind: 'invisible',
            intervalMs,
            chance,
            durationSec
        };
        if (effect) spell.effect = effect;
        if (raw.name) spell.legacyName = String(raw.name);
        return spell;
    }

    return null;
}

/**
 * Stable slug id from monster display name.
 * "Cave Rat" → "cave_rat", "a weak spot" → "a_weak_spot"
 * @param {string} name
 * @returns {string}
 */
function slugifyMonsterName(name) {
    const s = String(name || '')
        .trim()
        .toLowerCase()
        .replace(/['’]/g, '')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .replace(/_+/g, '_');
    return s || 'unknown';
}

/**
 * Title-case label from name.
 * @param {string} name
 * @returns {string}
 */
function labelFromName(name) {
    const raw = String(name || '').trim();
    if (!raw) return 'Unknown';
    // Keep original casing when already mixed; otherwise title-case words
    if (/[A-Z]/.test(raw) && /[a-z]/.test(raw)) return raw;
    return raw.replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Legacy damage is usually signed negative (maxDamage: -10 means 10 dmg).
 * Returns non-negative { min, max } with min ≤ max, or null if no damage.
 * @param {object} raw attack row
 * @returns {{ min: number, max: number }|null}
 */
function absDamageRange(raw) {
    if (!raw || typeof raw !== 'object') return null;
    let min =
        raw.min != null
            ? Number(raw.min)
            : raw.minDamage != null
              ? Number(raw.minDamage)
              : null;
    let max =
        raw.max != null
            ? Number(raw.max)
            : raw.maxDamage != null
              ? Number(raw.maxDamage)
              : null;
    if (min != null && !Number.isFinite(min)) min = null;
    if (max != null && !Number.isFinite(max)) max = null;
    if (min == null && max == null) return null;

    // Both non-positive → OTBM convention (damage as negative)
    if (
        (min == null || min <= 0) &&
        (max == null || max <= 0) &&
        (min < 0 || max < 0)
    ) {
        min = min == null ? 0 : Math.abs(min);
        max = max == null ? min : Math.abs(max);
    } else {
        min = min == null ? 0 : Math.abs(min);
        max = max == null ? min : Math.abs(max);
    }
    if (max < min) {
        const t = min;
        min = max;
        max = t;
    }
    return { min, max };
}

/**
 * Map legacy attack row → engine attack def (positive min/max, kind, etc.).
 * Returns null for pure status attacks with no damage and no geometry.
 * @param {object} raw
 * @param {number} index
 * @returns {object|null}
 */
function convertAttack(raw, index) {
    if (!raw || typeof raw !== 'object') return null;
    const name = String(raw.name || 'attack').toLowerCase();
    const dmg = absDamageRange(raw);
    const isStatus = NON_DAMAGE_ATTACK_NAMES.has(name);
    const hasGeom =
        raw.range != null ||
        raw.radius != null ||
        raw.length != null ||
        raw.spread != null;

    // Pure slow/haste from name "speed" (no damage) — keep as status attack
    if (isStatus && !dmg && name === 'speed' && raw.speedChange != null) {
        const cond = convertCondition({
            type: 'speed',
            speedChange: raw.speedChange,
            duration: raw.duration
        });
        if (!cond) return null;
        /** @type {object} */
        const statusAtk = {
            id: `${cond.type}_${index}`,
            kind: 'status',
            intervalMs:
                raw.interval != null
                    ? Math.max(50, Number(raw.interval) || 2000)
                    : 2000,
            chance:
                raw.chance != null
                    ? Math.max(0, Math.min(100, Number(raw.chance) || 0))
                    : 100,
            range:
                raw.range != null
                    ? Math.max(0, Number(raw.range) | 0)
                    : raw.length != null
                      ? Math.max(0, Number(raw.length) | 0)
                      : 4,
            element: 'physical',
            min: 0,
            max: 0,
            statusOnly: true,
            condition: cond
        };
        if (raw.length != null) statusAtk.length = Math.max(0, Number(raw.length) | 0);
        if (raw.spread != null) statusAtk.spread = Math.max(0, Number(raw.spread) | 0);
        if (raw.radius != null) statusAtk.radius = Math.max(0, Number(raw.radius) | 0);
        if (raw.effect) statusAtk.effect = String(raw.effect);
        if (raw.target != null) statusAtk.target = !!raw.target;
        if (raw.name) statusAtk.legacyName = String(raw.name);
        return statusAtk;
    }

    // Pure condition DoT (legacy name "condition" + CONDITION_* type).
    // minDamage/maxDamage are condition totals (setConditionDamage), NOT combat hit damage.
    if (name === 'condition' && raw.type != null) {
        let totalDamage = 0;
        if (raw.totalDamage != null) {
            totalDamage = Math.max(0, Math.abs(Number(raw.totalDamage) || 0));
        } else if (dmg) {
            // Legacy condition list spans min..max; engine uses a single pool — use max.
            totalDamage = Math.max(dmg.min, dmg.max);
        }
        // Default DoT tick 2000ms (legacy getDamageCondition default); attack recast is separate.
        const condInterval =
            raw.tickInterval != null
                ? Number(raw.tickInterval)
                : raw.conditionInterval != null
                  ? Number(raw.conditionInterval)
                  : 2000;
        const cond = convertCondition({
            type: raw.type,
            totalDamage,
            interval:
                Number.isFinite(condInterval) && condInterval > 0
                    ? condInterval
                    : 2000
        });
        if (!cond) return null;

        let kind = 'status';
        if (raw.length != null && Number(raw.length) > 0) {
            kind = 'wave';
        } else if (raw.radius != null && Number(raw.radius) > 1) {
            kind = 'area';
        } else if (raw.range != null && Number(raw.range) > 1) {
            kind = 'ranged';
        } else if (hasGeom) {
            kind = raw.radius != null ? 'area' : 'ranged';
        }

        /** @type {object} */
        const condAtk = {
            id: `condition_${index}`,
            kind,
            intervalMs:
                raw.interval != null
                    ? Math.max(50, Number(raw.interval) || 2000)
                    : 2000,
            chance:
                raw.chance != null
                    ? Math.max(0, Math.min(100, Number(raw.chance) || 0))
                    : 100,
            range:
                raw.range != null
                    ? Math.max(0, Number(raw.range) | 0)
                    : kind === 'wave' && raw.length != null
                      ? Math.max(0, Number(raw.length) | 0)
                      : kind === 'melee' || kind === 'status'
                        ? 1
                        : 4,
            element: conditionKindToElement(cond.type),
            min: 0,
            max: 0,
            statusOnly: true,
            condition: cond
        };
        if (raw.length != null) condAtk.length = Math.max(0, Number(raw.length) | 0);
        if (raw.spread != null) condAtk.spread = Math.max(0, Number(raw.spread) | 0);
        if (raw.radius != null) condAtk.radius = Math.max(0, Number(raw.radius) | 0);
        if (raw.effect) condAtk.effect = String(raw.effect);
        if (raw.shootEffect) condAtk.shootEffect = String(raw.shootEffect);
        if (raw.target != null) condAtk.target = !!raw.target;
        if (raw.name) condAtk.legacyName = String(raw.name);
        return condAtk;
    }

    // Skip pure drunk/outfit/invisible/paralyze with no damage (not in scope)
    if (isStatus && !dmg) return null;

    let kind = 'melee';
    const n = name;
    if (n === 'melee') {
        kind = 'melee';
    } else if (raw.length != null && Number(raw.length) > 0) {
        kind = 'wave';
    } else if (raw.radius != null && Number(raw.radius) > 1) {
        kind = 'area';
    } else if (
        n === 'combat' ||
        n === 'ranged' ||
        n === 'distance' ||
        (raw.range != null && Number(raw.range) > 1)
    ) {
        kind =
            raw.radius != null && Number(raw.radius) > 1
                ? 'area'
                : raw.range != null && Number(raw.range) > 1
                  ? 'ranged'
                  : 'melee';
    } else if (dmg && raw.range != null && Number(raw.range) > 1) {
        kind = 'ranged';
    } else if (dmg && n !== 'melee') {
        // Named special (e.g. "brimstone bug wave") — infer from geometry
        if (raw.length != null) kind = 'wave';
        else if (raw.radius != null && Number(raw.radius) > 0) kind = 'area';
        else if (raw.range != null && Number(raw.range) > 1) kind = 'ranged';
        else kind = 'melee';
    }

    const element = mapAttackElement(raw.type || raw.element || 'physical');

    const idBase = n === 'combat' || n === 'melee' ? kind : slugifyMonsterName(n);
    /** @type {object} */
    const atk = {
        id: `${idBase}_${index}`,
        kind,
        intervalMs:
            raw.interval != null
                ? Math.max(50, Number(raw.interval) || 2000)
                : raw.intervalMs != null
                  ? Math.max(50, Number(raw.intervalMs) || 2000)
                  : 2000,
        chance:
            raw.chance != null
                ? Math.max(0, Math.min(100, Number(raw.chance) || 0))
                : 100,
        range:
            raw.range != null
                ? Math.max(0, Number(raw.range) | 0)
                : kind === 'melee'
                  ? 1
                  : 4,
        element
    };

    if (dmg) {
        atk.min = dmg.min;
        atk.max = dmg.max;
    }
    if (raw.radius != null) atk.radius = Math.max(0, Number(raw.radius) | 0);
    if (raw.length != null) atk.length = Math.max(0, Number(raw.length) | 0);
    if (raw.spread != null) atk.spread = Math.max(0, Number(raw.spread) | 0);
    if (raw.target != null) atk.target = !!raw.target;
    if (raw.effect) atk.effect = String(raw.effect);
    if (raw.shootEffect) atk.shootEffect = String(raw.shootEffect);
    if (raw.name && n !== kind) atk.legacyName = String(raw.name);

    // Nested condition (e.g. melee poison DoT). Pure name:"condition" handled above.
    const cond = convertCondition(raw.condition);
    if (cond) atk.condition = cond;

    // Status-only with geometry still kept if has dmg; else skip
    if (!dmg && !hasGeom && !cond) return null;
    if (!dmg) {
        // Geometry-only status (e.g. field) — keep for future FX, zero damage
        atk.min = 0;
        atk.max = 0;
        atk.statusOnly = true;
    }
    return atk;
}

/**
 * Legacy elements: 100 = take full dmg (0 resist), 0 = immune (100 resist),
 * 110 = weak (resist -10). Engine uses % reduction (may be negative).
 * @param {object|null|undefined} elements
 * @returns {Record<string, number>}
 */
function convertElementsToResists(elements) {
    /** @type {Record<string, number>} */
    const resists = {
        physical: 0,
        fire: 0,
        ice: 0,
        energy: 0,
        earth: 0,
        holy: 0,
        death: 0
    };
    if (!elements || typeof elements !== 'object') return resists;
    for (const el of COMBAT_ELEMENTS) {
        if (elements[el] == null) continue;
        const takePct = Number(elements[el]);
        if (!Number.isFinite(takePct)) continue;
        // resist = 100 - takePct  → 100 take → 0 resist; 0 take → 100 immune
        resists[el] = Math.round(100 - takePct);
    }
    return resists;
}

/**
 * Heuristic combat level from HP / bestiary stars (legacy has no vocation level).
 * @param {object} mon
 * @returns {number}
 */
function estimateLevel(mon) {
    const stars =
        mon.Bestiary && mon.Bestiary.Stars != null
            ? Number(mon.Bestiary.Stars)
            : 0;
    if (stars > 0) return Math.max(1, stars * 20);
    const hp = Number(mon.health || mon.maxHealth || 0);
    if (hp <= 50) return 5;
    if (hp <= 150) return 15;
    if (hp <= 500) return 30;
    if (hp <= 2000) return 50;
    if (hp <= 8000) return 80;
    return 120;
}

/**
 * Boolean flags copied from legacy dumps into engine templates.
 * (Combat stand-off fields stay separate: targetDistance / runHealth / staticAttackChance.)
 * @type {readonly string[]}
 */
const LEGACY_BOOL_FLAG_KEYS = Object.freeze([
    'summonable',
    'attackable',
    'hostile',
    'convinceable',
    'pushable',
    'rewardBoss',
    'illusionable',
    'canPushItems',
    'canPushCreatures',
    'healthHidden',
    'canWalkOnEnergy',
    'canWalkOnFire',
    'canWalkOnPoison'
]);

/**
 * Convert legacy Bestiary block → engine bestiary (all fields except Locations).
 * @param {object|null|undefined} raw
 * @returns {object|null}
 */
function convertBestiary(raw) {
    if (!raw || typeof raw !== 'object') return null;
    /** @type {object} */
    const out = {};
    if (raw.class != null && String(raw.class).trim() !== '') {
        out.class = String(raw.class);
    }
    if (raw.toKill != null && Number.isFinite(Number(raw.toKill))) {
        out.toKill = Math.max(0, Math.round(Number(raw.toKill)));
    }
    if (raw.FirstUnlock != null && Number.isFinite(Number(raw.FirstUnlock))) {
        out.firstUnlock = Math.max(0, Math.round(Number(raw.FirstUnlock)));
    } else if (
        raw.firstUnlock != null &&
        Number.isFinite(Number(raw.firstUnlock))
    ) {
        out.firstUnlock = Math.max(0, Math.round(Number(raw.firstUnlock)));
    }
    if (raw.SecondUnlock != null && Number.isFinite(Number(raw.SecondUnlock))) {
        out.secondUnlock = Math.max(0, Math.round(Number(raw.SecondUnlock)));
    } else if (
        raw.secondUnlock != null &&
        Number.isFinite(Number(raw.secondUnlock))
    ) {
        out.secondUnlock = Math.max(0, Math.round(Number(raw.secondUnlock)));
    }
    if (raw.CharmsPoints != null && Number.isFinite(Number(raw.CharmsPoints))) {
        out.charmsPoints = Math.max(0, Math.round(Number(raw.CharmsPoints)));
    } else if (
        raw.charmsPoints != null &&
        Number.isFinite(Number(raw.charmsPoints))
    ) {
        out.charmsPoints = Math.max(0, Math.round(Number(raw.charmsPoints)));
    }
    if (raw.Stars != null && Number.isFinite(Number(raw.Stars))) {
        out.stars = Math.max(0, Math.round(Number(raw.Stars)));
    } else if (raw.stars != null && Number.isFinite(Number(raw.stars))) {
        out.stars = Math.max(0, Math.round(Number(raw.stars)));
    }
    if (raw.Occurrence != null && Number.isFinite(Number(raw.Occurrence))) {
        out.occurrence = Math.max(0, Math.round(Number(raw.Occurrence)));
    } else if (
        raw.occurrence != null &&
        Number.isFinite(Number(raw.occurrence))
    ) {
        out.occurrence = Math.max(0, Math.round(Number(raw.occurrence)));
    }
    // Locations intentionally omitted (commercial-sensitive place names).
    return Object.keys(out).length ? out : null;
}

/**
 * Resolve a legacy creature display name via optional commercial-safe map.
 * @param {string} legacyName
 * @param {Map<string, { standardName: string, standardId: string }>|Record<string, { standardName: string, standardId: string }>|null|undefined} nameMap
 * @returns {{ name: string, id: string, mapped: boolean }}
 */
function resolveCreatureIdentity(legacyName, nameMap) {
    const raw = String(legacyName || '').trim();
    const key = raw.toLowerCase().replace(/\s+/g, ' ');
    let hit = null;
    if (nameMap) {
        if (typeof nameMap.get === 'function') {
            hit = nameMap.get(key) || nameMap.get(raw.toLowerCase()) || null;
        } else if (typeof nameMap === 'object') {
            hit = nameMap[key] || nameMap[raw.toLowerCase()] || null;
        }
    }
    if (hit && (hit.standardName || hit.standardId || hit.name || hit.id)) {
        const name = String(hit.standardName || hit.name || raw).trim();
        const id = String(
            hit.standardId || hit.id || slugifyMonsterName(name)
        ).trim();
        return { name: name || labelFromName(raw), id: id || slugifyMonsterName(raw), mapped: true };
    }
    return {
        name: labelFromName(raw),
        id: slugifyMonsterName(raw),
        mapped: false
    };
}

/**
 * Convert legacy summon block; maps each summons[].name when nameMap is provided.
 * When nameMap is present, entries without a CSV row are dropped (no slug fallback).
 * Without nameMap, names are title-cased and slugified (legacy pack path).
 * @param {object|null|undefined} raw
 * @param {Map<string, { standardName: string, standardId: string }>|Record<string, { standardName: string, standardId: string }>|null|undefined} [nameMap]
 * @returns {{ maxSummons: number, summons: object[] }|null}
 */
function convertSummon(raw, nameMap) {
    if (!raw || typeof raw !== 'object') return null;
    const list = Array.isArray(raw.summons) ? raw.summons : [];
    if (!list.length) return null;
    const requireMap = nameMap != null;
    /** @type {object[]} */
    const summons = [];
    for (let i = 0; i < list.length; i++) {
        const row = list[i];
        if (!row || typeof row !== 'object') continue;
        const legacyName = row.name != null ? String(row.name).trim() : '';
        if (!legacyName) continue;
        const identity = resolveCreatureIdentity(legacyName, nameMap);
        if (requireMap && !identity.mapped) continue;
        /** @type {object} */
        const entry = {
            name: identity.name,
            id: identity.id
        };
        if (row.chance != null && Number.isFinite(Number(row.chance))) {
            entry.chance = Math.max(0, Math.min(100, Number(row.chance) || 0));
        }
        if (row.interval != null && Number.isFinite(Number(row.interval))) {
            entry.interval = Math.max(0, Math.round(Number(row.interval) || 0));
        } else if (
            row.intervalMs != null &&
            Number.isFinite(Number(row.intervalMs))
        ) {
            entry.interval = Math.max(0, Math.round(Number(row.intervalMs) || 0));
        }
        if (row.count != null && Number.isFinite(Number(row.count))) {
            entry.count = Math.max(0, Math.round(Number(row.count) || 0));
        }
        summons.push(entry);
    }
    if (!summons.length) return null;
    const maxSummons =
        raw.maxSummons != null && Number.isFinite(Number(raw.maxSummons))
            ? Math.max(0, Math.round(Number(raw.maxSummons) || 0))
            : summons.reduce((acc, s) => acc + (Number(s.count) || 1), 0);
    return { maxSummons, summons };
}

/**
 * Copy legacy boolean flags + combat stand-off fields into engine flags shape.
 * Preserves aggroRange / loseTargetDistance defaults used by the engine.
 * @param {object} flagsRaw
 * @returns {object}
 */
function convertMonsterFlags(flagsRaw) {
    const raw = flagsRaw && typeof flagsRaw === 'object' ? flagsRaw : {};
    const targetDistance =
        raw.targetDistance != null
            ? Math.max(1, Number(raw.targetDistance) | 0)
            : 1;
    /** @type {object} */
    const flags = {
        targetDistance,
        runHealth: Math.max(0, Number(raw.runHealth) || 0),
        staticAttackChance:
            raw.staticAttackChance != null
                ? Math.max(
                      0,
                      Math.min(100, Number(raw.staticAttackChance) || 0)
                  )
                : 90,
        // Engine defaults for aggro / lose target (legacy used screen-ish)
        aggroRange: 7,
        loseTargetDistance: 12
    };
    for (let i = 0; i < LEGACY_BOOL_FLAG_KEYS.length; i++) {
        const key = LEGACY_BOOL_FLAG_KEYS[i];
        if (raw[key] === undefined || raw[key] === null) continue;
        flags[key] = !!raw[key];
    }
    return flags;
}

/**
 * Patch an existing standard/legacy creature template with metadata from a
 * legacy monsters.json row (bestiary, strategies, flags, manaCost, summon).
 * Does not touch combat stats (hp, attacks, resists, level, threat caches, art).
 *
 * @param {object} template existing creature JSON
 * @param {object} mon legacy monster row
 * @param {{ nameMap?: Map|Record|null }} [opts]
 * @returns {object} same template reference (mutated)
 */
function applyLegacyMonsterMetadata(template, mon, opts) {
    if (!template || typeof template !== 'object') return template;
    if (!mon || typeof mon !== 'object') return template;
    const options = opts || {};
    const flagsRaw =
        mon.flags && typeof mon.flags === 'object' ? mon.flags : {};

    if (mon.strategiesTarget && typeof mon.strategiesTarget === 'object') {
        template.strategiesTarget = Object.assign({}, mon.strategiesTarget);
    }

    if (mon.manaCost !== undefined && mon.manaCost !== null && mon.manaCost !== '') {
        template.manaCost = Math.max(0, Math.round(Number(mon.manaCost) || 0));
    }

    // Legacy isBlockable → engine canBlock (shield-block eligibility).
    if (flagsRaw.isBlockable !== undefined && flagsRaw.isBlockable !== null) {
        template.canBlock = !!flagsRaw.isBlockable;
    } else if (mon.canBlock !== undefined && mon.canBlock !== null) {
        template.canBlock = !!mon.canBlock;
    }

    const prevFlags =
        template.flags && typeof template.flags === 'object'
            ? template.flags
            : {};
    const nextFlags = Object.assign({}, prevFlags);
    // Stand-off / run fields when present on the dump
    if (flagsRaw.targetDistance != null) {
        nextFlags.targetDistance = Math.max(
            1,
            Number(flagsRaw.targetDistance) | 0
        );
    }
    if (flagsRaw.runHealth != null) {
        nextFlags.runHealth = Math.max(0, Number(flagsRaw.runHealth) || 0);
    }
    if (flagsRaw.staticAttackChance != null) {
        nextFlags.staticAttackChance = Math.max(
            0,
            Math.min(100, Number(flagsRaw.staticAttackChance) || 0)
        );
    }
    for (let i = 0; i < LEGACY_BOOL_FLAG_KEYS.length; i++) {
        const key = LEGACY_BOOL_FLAG_KEYS[i];
        if (flagsRaw[key] === undefined || flagsRaw[key] === null) continue;
        nextFlags[key] = !!flagsRaw[key];
    }
    // Keep engine defaults if missing
    if (nextFlags.aggroRange == null) nextFlags.aggroRange = 7;
    if (nextFlags.loseTargetDistance == null) nextFlags.loseTargetDistance = 12;
    template.flags = nextFlags;

    const bestiary = convertBestiary(mon.Bestiary || mon.bestiary);
    if (bestiary) {
        template.bestiary = bestiary;
    } else {
        delete template.bestiary;
    }

    const summon = convertSummon(mon.summon, options.nameMap);
    if (summon) {
        template.summon = summon;
    } else {
        delete template.summon;
    }

    return template;
}

/**
 * Convert one legacy monster record → engine combat template.
 * Offense is attacks[] min/max only.
 * @param {object} mon
 * @param {{ imageRel?: string|null, nameMap?: Map|Record|null }} [opts]
 * @returns {object|null}
 */
function convertMonsterToTemplate(mon, opts) {
    if (!mon || typeof mon !== 'object') return null;
    const name = mon.name != null ? String(mon.name) : '';
    if (!name.trim()) return null;
    const id = slugifyMonsterName(name);
    const options = opts || {};

    const attacks = [];
    const rawAttacks = Array.isArray(mon.attacks) ? mon.attacks : [];
    for (let i = 0; i < rawAttacks.length; i++) {
        const a = convertAttack(rawAttacks[i], i);
        if (a) attacks.push(a);
    }

    const defenseSpells = [];
    const rawDefense = Array.isArray(mon.defense_spells)
        ? mon.defense_spells
        : Array.isArray(mon.defenseSpells)
          ? mon.defenseSpells
          : [];
    for (let i = 0; i < rawDefense.length; i++) {
        const d = convertDefenseSpell(rawDefense[i], i);
        if (d) defenseSpells.push(d);
    }

    const defenses =
        mon.defenses && typeof mon.defenses === 'object' ? mon.defenses : {};
    const flagsRaw =
        mon.flags && typeof mon.flags === 'object' ? mon.flags : {};
    const hp = Math.max(1, Number(mon.health || mon.maxHealth) || 1);

    /** @type {Record<string, number>} */
    const strategiesTarget =
        mon.strategiesTarget && typeof mon.strategiesTarget === 'object'
            ? Object.assign({}, mon.strategiesTarget)
            : { nearest: 100 };

    const canBlock =
        flagsRaw.isBlockable != null
            ? !!flagsRaw.isBlockable
            : mon.canBlock != null
              ? !!mon.canBlock
              : false;

    const bestiary = convertBestiary(mon.Bestiary || mon.bestiary);
    const summon = convertSummon(mon.summon, options.nameMap);

    /** @type {object} */
    const template = {
        id,
        label: labelFromName(name),
        source: 'legacy',
        legacyName: name,
        // Species visual size vs standard humanoid; affix mults stack on top.
        displayScale: 1,
        notes:
            mon.description != null
                ? String(mon.description)
                : `Ported from legacy monsters.json (${name}).`,
        hp,
        hpMax: Math.max(hp, Number(mon.maxHealth) || hp),
        // Absolute monster speed (legacy field). Missing → combat default, not 0
        // (0 would freeze the unit). Explicit 0 is preserved when present.
        speed:
            mon.speed !== undefined && mon.speed !== null && mon.speed !== ''
                ? Math.max(0, Number(mon.speed) || 0)
                : DEFAULT_CREATURE_COMBAT.speed,
        level: estimateLevel(mon),
        armor: Math.max(0, Number(defenses.armor) || 0),
        // Legacy mitigation is already a percent-like number (e.g. 0.1, 2.51)
        mitigation: Math.max(0, Number(defenses.mitigation) || 0),
        maxBlock: 0,
        exp: Math.max(0, Number(mon.experience) || 0),
        lootValue: Math.max(0, Number(mon.average_loot) || 0),
        // Stand-off is flags.targetDistance only (no top-level attackRange / autoAttack).
        aggro: flagsRaw.hostile !== false && flagsRaw.attackable !== false,
        resists: convertElementsToResists(mon.elements),
        canBlock,
        strategiesTarget,
        flags: convertMonsterFlags(flagsRaw),
        attacks,
        defenseSpells: defenseSpells.length ? defenseSpells : undefined,
        race: mon.race != null ? String(mon.race) : undefined,
        bestiary: bestiary || undefined,
        manaCost:
            mon.manaCost !== undefined &&
            mon.manaCost !== null &&
            mon.manaCost !== ''
                ? Math.max(0, Math.round(Number(mon.manaCost) || 0))
                : undefined,
        summon: summon || undefined,
        loot: Array.isArray(mon.loot) ? mon.loot : undefined,
        changeTarget:
            mon.changeTarget && typeof mon.changeTarget === 'object'
                ? mon.changeTarget
                : undefined,
        immunities:
            mon.immunities && typeof mon.immunities === 'object'
                ? mon.immunities
                : undefined
    };

    if (options.imageRel) {
        template.sprite = {
            legacy: options.imageRel
        };
    }

    // Strip undefined keys for clean JSON
    for (const k of Object.keys(template)) {
        if (template[k] === undefined) delete template[k];
    }
    return template;
}

/**
 * Convert full monsters.json array → { templates: object[], byId, errors }
 * @param {object[]} list
 * @param {{ imagePathFor?: (slug: string, name: string) => string|null }} [opts]
 */
function convertMonsterList(list, opts) {
    const options = opts || {};
    /** @type {object[]} */
    const templates = [];
    /** @type {Record<string, object>} */
    const byId = Object.create(null);
    /** @type {string[]} */
    const errors = [];
    /** @type {Map<string, number>} */
    const idCount = new Map();

    const arr = Array.isArray(list) ? list : [];
    for (let i = 0; i < arr.length; i++) {
        const mon = arr[i];
        try {
            let id = slugifyMonsterName(mon && mon.name);
            const n = (idCount.get(id) || 0) + 1;
            idCount.set(id, n);
            if (n > 1) id = `${id}_${n}`;

            const imageRel = options.imagePathFor
                ? options.imagePathFor(id, mon && mon.name)
                : null;
            const t = convertMonsterToTemplate(mon, { imageRel });
            if (!t) {
                errors.push(`row ${i}: empty name`);
                continue;
            }
            // Re-apply unique id if collision
            t.id = id;
            templates.push(t);
            byId[id] = t;
        } catch (e) {
            errors.push(`row ${i} (${mon && mon.name}): ${e.message || e}`);
        }
    }
    return { templates, byId, errors };
}

/**
 * World (OTBM) marker coords → local tile coords using bounds.
 * @param {{ x: number, y: number, z?: number|string }} pt
 * @param {{ xMin: number, yMin: number }} bounds
 */
function worldToLocal(pt, bounds) {
    return {
        x: Number(pt.x) - Number(bounds.xMin),
        y: Number(pt.y) - Number(bounds.yMin),
        z:
            pt.z != null
                ? /^\d+$/.test(String(pt.z))
                    ? String(pt.z).padStart(2, '0')
                    : String(pt.z)
                : '00'
    };
}

/**
 * Normalize spawn row → engine-friendly shape with creatureId slug.
 * @param {object} spawn
 * @returns {object|null}
 */
function convertSpawn(spawn) {
    if (!spawn || spawn.name == null) return null;
    const name = String(spawn.name);
    return {
        creatureId: slugifyMonsterName(name),
        legacyName: name,
        x: Number(spawn.x) | 0,
        y: Number(spawn.y) | 0,
        z:
            spawn.z != null
                ? /^\d+$/.test(String(spawn.z))
                    ? Number(spawn.z)
                    : spawn.z
                : 0,
        respawn:
            spawn.spawntime != null
                ? Number(spawn.spawntime)
                : spawn.respawn != null
                  ? Number(spawn.respawn)
                  : 90
    };
}

/**
 * Convert map-spawn-v3 object (floor keys → arrays) → normalized by floor.
 * @param {Record<string, object[]>} raw
 * @returns {{ byFloor: Record<string, object[]>, total: number, creatureIds: string[] }}
 */
function convertSpawnTable(raw) {
    /** @type {Record<string, object[]>} */
    const byFloor = Object.create(null);
    /** @type {Set<string>} */
    const ids = new Set();
    let total = 0;
    const floors = raw && typeof raw === 'object' ? Object.keys(raw) : [];
    for (const f of floors) {
        const list = Array.isArray(raw[f]) ? raw[f] : [];
        const out = [];
        for (let i = 0; i < list.length; i++) {
            const s = convertSpawn(list[i]);
            if (!s) continue;
            out.push(s);
            ids.add(s.creatureId);
            total++;
        }
        byFloor[String(f).padStart(2, '0')] = out;
    }
    return {
        byFloor,
        total,
        creatureIds: Array.from(ids).sort()
    };
}

/**
 * Analyze navmesh for icons / teleport-like annotations.
 * Connections already encode walkable graph edges (including floor changes).
 * @param {{ points?: object[], connections?: number[][] }} mesh
 */
function analyzeNavmesh(mesh) {
    const points = (mesh && mesh.points) || [];
    const connections = (mesh && mesh.connections) || [];
    /** @type {Record<string, number>} */
    const icons = Object.create(null);
    /** @type {object[]} */
    const annotated = [];
    /** @type {Record<string, number>} */
    const byFloor = Object.create(null);

    for (let i = 0; i < points.length; i++) {
        const p = points[i];
        if (!p) continue;
        const z = p.z != null ? String(p.z).padStart(2, '0') : '00';
        byFloor[z] = (byFloor[z] || 0) + 1;
        const prop = p.properties || {};
        if (prop.icon) {
            const ic = String(prop.icon);
            icons[ic] = (icons[ic] || 0) + 1;
            annotated.push({
                index: i,
                x: p.x,
                y: p.y,
                z,
                icon: ic,
                description: prop.description || ''
            });
        }
    }

    /**
     * Icon semantics (legacy map editor conventions used in this dump).
     * Floor transitions are also present as graph edges between different z.
     */
    const iconLegend = {
        up: 'Stairs / hole up (floor change up)',
        down: 'Stairs / hole down (floor change down)',
        'red up': 'Levitate / special up',
        'red down': 'Levitate / special down',
        'red left': 'Special link west / levitate',
        'red right': 'Special link east / levitate',
        flag: 'Landmark / POI',
        star: 'Landmark / quest',
        bag: 'Loot / depot area',
        sword: 'Combat / hunting area',
        skull: 'Danger / boss area',
        mouth: 'NPC / speech',
        lock: 'Door / locked area',
        crossmark: 'Mark',
        checkmark: 'Mark',
        cross: 'Mark',
        '!': 'Alert / note',
        '?': 'Question / note',
        $: 'Economy / shop',
        spear: 'Combat note'
    };

    // Cross-floor edges (teleport/stair links encoded in the graph)
    let crossFloorEdges = 0;
    const crossFloorSamples = [];
    for (let e = 0; e < connections.length; e++) {
        const pair = connections[e];
        if (!pair || pair.length < 2) continue;
        const a = points[pair[0]];
        const b = points[pair[1]];
        if (!a || !b) continue;
        const za = String(a.z != null ? a.z : '0').padStart(2, '0');
        const zb = String(b.z != null ? b.z : '0').padStart(2, '0');
        if (za !== zb) {
            crossFloorEdges++;
            if (crossFloorSamples.length < 40) {
                crossFloorSamples.push({
                    a: { i: pair[0], x: a.x, y: a.y, z: za, icon: (a.properties && a.properties.icon) || null },
                    b: { i: pair[1], x: b.x, y: b.y, z: zb, icon: (b.properties && b.properties.icon) || null }
                });
            }
        }
    }

    return {
        version: 1,
        pointCount: points.length,
        connectionCount: connections.length,
        annotatedCount: annotated.length,
        crossFloorEdges,
        icons,
        iconLegend,
        pointsByFloor: byFloor,
        crossFloorSamples,
        /** Full annotated list is large; callers may write separately */
        annotated
    };
}

/**
 * True if icon marks a vertical / special floor link.
 * @param {string|null|undefined} icon
 */
function isStairIcon(icon) {
    if (!icon) return false;
    return /^(up|down|red up|red down|red left|red right)$/i.test(String(icon));
}

/**
 * Infer undirected cross-floor edges from stair/teleport icons.
 * Legacy merged graph often stores floors separately; icons mark links.
 * Strategy:
 *  1. Same (x,y), different z, both annotated (or one) with stair-like icon
 *  2. Nearby (Chebyshev ≤ maxDist), different z, complementary up/down icons
 *
 * @param {object[]} points
 * @param {number[][]} existingConnections
 * @param {{ maxDist?: number }} [opts]
 * @returns {{ connections: number[][], inferred: number, samples: object[] }}
 */
function inferCrossFloorConnections(points, existingConnections, opts) {
    const options = opts || {};
    const maxDist = options.maxDist != null ? options.maxDist : 2;
    /** @type {Set<string>} */
    const edgeKeys = new Set();
    const connections = (existingConnections || []).map((e) => {
        if (!e || e.length < 2) return e;
        const a = Math.min(e[0], e[1]);
        const b = Math.max(e[0], e[1]);
        edgeKeys.add(a + ':' + b);
        return [e[0], e[1]];
    });

    function addEdge(i, j, samples, meta) {
        if (i === j || i < 0 || j < 0) return;
        const a = Math.min(i, j);
        const b = Math.max(i, j);
        const k = a + ':' + b;
        if (edgeKeys.has(k)) return;
        edgeKeys.add(k);
        connections.push([a, b]);
        if (samples.length < 30) {
            samples.push(meta);
        }
    }

    /** @type {object[]} */
    const samples = [];
    let inferred = 0;

    // Group stair-like points by x,y
    /** @type {Map<string, number[]>} */
    const byXY = new Map();
    for (let i = 0; i < points.length; i++) {
        const p = points[i];
        if (!p) continue;
        const icon = p.properties && p.properties.icon;
        if (!isStairIcon(icon) && !(p.properties && p.properties.description)) {
            // Still consider exact xy multi-z for any annotated point
            if (!icon) continue;
        }
        if (!isStairIcon(icon)) continue;
        const key = (Number(p.x) | 0) + ',' + (Number(p.y) | 0);
        if (!byXY.has(key)) byXY.set(key, []);
        byXY.get(key).push(i);
    }

    for (const indices of byXY.values()) {
        if (indices.length < 2) continue;
        for (let a = 0; a < indices.length; a++) {
            for (let b = a + 1; b < indices.length; b++) {
                const ia = indices[a];
                const ib = indices[b];
                const pa = points[ia];
                const pb = points[ib];
                const za = String(pa.z);
                const zb = String(pb.z);
                if (za === zb) continue;
                const before = edgeKeys.size;
                addEdge(ia, ib, samples, {
                    reason: 'same_xy',
                    a: { i: ia, x: pa.x, y: pa.y, z: pa.z, icon: pa.properties && pa.properties.icon },
                    b: { i: ib, x: pb.x, y: pb.y, z: pb.z, icon: pb.properties && pb.properties.icon }
                });
                if (edgeKeys.size > before) inferred++;
            }
        }
    }

    // Nearby complementary icons (down ↔ up) on different floors
    const downs = [];
    const ups = [];
    for (let i = 0; i < points.length; i++) {
        const p = points[i];
        if (!p || !p.properties) continue;
        const ic = String(p.properties.icon || '').toLowerCase();
        if (ic === 'down' || ic === 'red down') downs.push(i);
        else if (ic === 'up' || ic === 'red up') ups.push(i);
    }
    for (let di = 0; di < downs.length; di++) {
        const i = downs[di];
        const pd = points[i];
        for (let ui = 0; ui < ups.length; ui++) {
            const j = ups[ui];
            const pu = points[j];
            if (String(pd.z) === String(pu.z)) continue;
            const dx = Math.abs((pd.x | 0) - (pu.x | 0));
            const dy = Math.abs((pd.y | 0) - (pu.y | 0));
            if (dx > maxDist || dy > maxDist) continue;
            // Prefer |Δz| = 1 when both numeric
            const za = Number(pd.z);
            const zb = Number(pu.z);
            if (Number.isFinite(za) && Number.isFinite(zb) && Math.abs(za - zb) > 2) {
                continue;
            }
            const before = edgeKeys.size;
            addEdge(i, j, samples, {
                reason: 'nearby_up_down',
                a: { i, x: pd.x, y: pd.y, z: pd.z, icon: pd.properties.icon },
                b: { i: j, x: pu.x, y: pu.y, z: pu.z, icon: pu.properties.icon }
            });
            if (edgeKeys.size > before) inferred++;
        }
    }

    return { connections, inferred, samples };
}

/**
 * Normalize navmesh points: z → number for engine when numeric, keep properties.
 * Optionally infers cross-floor stair edges from icons.
 * @param {object} mesh
 * @param {{ id?: string, label?: string, inferStairs?: boolean }} [meta]
 */
function normalizeNavmeshForEngine(mesh, meta) {
    const m = meta || {};
    const points = ((mesh && mesh.points) || []).map((p) => {
        const zRaw = p.z;
        let z = zRaw;
        if (zRaw != null && /^\d+$/.test(String(zRaw))) {
            z = Number(zRaw);
        }
        /** @type {object} */
        const out = { x: Number(p.x) | 0, y: Number(p.y) | 0, z };
        if (p.properties && Object.keys(p.properties).length) {
            out.properties = p.properties;
        }
        return out;
    });
    let connections = (mesh && mesh.connections) || [];
    let inferredStairs = 0;
    let inferredSamples = [];
    if (m.inferStairs !== false) {
        const inf = inferCrossFloorConnections(points, connections, {
            maxDist: m.stairMaxDist != null ? m.stairMaxDist : 2
        });
        connections = inf.connections;
        inferredStairs = inf.inferred;
        inferredSamples = inf.samples;
    }
    return {
        id: m.id || (mesh && mesh.id) || 'legacy_merged',
        label: m.label || (mesh && mesh.label) || 'Legacy merged navmesh',
        source: 'legacy',
        points,
        connections,
        meta: {
            inferredStairEdges: inferredStairs,
            inferredStairSamples: inferredSamples
        }
    };
}

/**
 * Convert waypoint-presets map → array of preset objects.
 * @param {Record<string, object[]>} raw
 */
function convertWaypointPresets(raw) {
    /** @type {object[]} */
    const out = [];
    if (!raw || typeof raw !== 'object') return out;
    for (const key of Object.keys(raw)) {
        const pts = Array.isArray(raw[key]) ? raw[key] : [];
        const waypoints = pts.map((p) => ({
            x: Number(p.x) | 0,
            y: Number(p.y) | 0,
            z:
                p.z != null && /^\d+$/.test(String(p.z))
                    ? Number(p.z)
                    : p.z != null
                      ? p.z
                      : 0
        }));
        const floors = [
            ...new Set(waypoints.map((w) => w.z).filter((z) => z != null))
        ];
        out.push({
            id: slugifyMonsterName(key),
            label: key,
            source: 'legacy',
            floor: floors.length === 1 ? floors[0] : floors[0] != null ? floors[0] : 7,
            floors,
            waypoints
        });
    }
    return out;
}

/**
 * Maps legacy vocation strings to new engine class ids.
 * sorcerer -> adept, knight -> guardian, monk -> mystic, paladin -> scout, druid -> warden.
 * Equipment without vocation requirements can be used by any vocation (returns null).
 * @param {string|null|undefined} vocationStr
 * @returns {string[]|null}
 */
function parseVocation(vocationStr) {
    if (!vocationStr) return null;
    const str = String(vocationStr).trim().toLowerCase();
    if (str === 'none' || str === 'without') return null;

    const list = [];
    if (/\b(knight|knights)\b/.test(str)) list.push('guardian');
    if (/\b(paladin|paladins)\b/.test(str)) list.push('scout');
    if (/\b(monk|monks)\b/.test(str)) list.push('mystic');
    if (/\b(sorcerer|sorcerers)\b/.test(str)) list.push('adept');
    if (/\b(druid|druids)\b/.test(str)) list.push('warden');

    return list.length > 0 ? list : null;
}

/**
 * Coerce wiki attributes field to a single parseable string.
 * @param {unknown} attributes
 * @returns {string}
 */
function attributesToString(attributes) {
    if (attributes == null || attributes === '') return '';
    if (typeof attributes === 'string') return attributes;
    if (Array.isArray(attributes)) return attributes.filter(Boolean).join(', ');
    if (typeof attributes === 'object') return Object.values(attributes).filter(Boolean).join(', ');
    return String(attributes);
}

/**
 * Parse equipment attribute skill bonuses from free-text wiki attributes.
 * @param {string} attributesStr
 * @returns {Record<string, number>|null}
 */
function parseSkillBonuses(attributesStr) {
    if (!attributesStr) return null;
    const bonuses = {};
    const regex =
        /(axe|sword|club|distance|fist|shielding|magic level)\s*(?:fighting)?\s*\+?(-?\d+)/gi;
    let match;
    while ((match = regex.exec(attributesStr)) !== null) {
        let key = match[1].toLowerCase();
        if (key === 'magic level') key = 'magic';
        bonuses[key] = Number(match[2]);
    }
    return Object.keys(bonuses).length > 0 ? bonuses : null;
}

/**
 * Skill bonuses from OTBM-style data.skill* / magiclevelpoints fields.
 * @param {object} data
 * @returns {Record<string, number>|null}
 */
function skillBonusesFromData(data) {
    if (!data || typeof data !== 'object') return null;
    const map = {
        skillaxe: 'axe',
        skillsword: 'sword',
        skillclub: 'club',
        skillfist: 'fist',
        skilldist: 'distance',
        skillshield: 'shielding',
        magiclevelpoints: 'magic'
    };
    const out = {};
    for (const src of Object.keys(map)) {
        if (data[src] == null || data[src] === '') continue;
        const n = Number(data[src]);
        if (!Number.isNaN(n) && n !== 0) out[map[src]] = n;
    }
    return Object.keys(out).length > 0 ? out : null;
}

/**
 * Merge skill bonus maps; later sources win on the same key (data > string).
 * @param {...(Record<string, number>|null|undefined)} sources
 * @returns {Record<string, number>|null}
 */
function mergeSkillBonusMaps() {
    const out = {};
    for (let i = 0; i < arguments.length; i++) {
        const src = arguments[i];
        if (!src || typeof src !== 'object') continue;
        for (const k of Object.keys(src)) {
            const n = Number(src[k]);
            if (!Number.isNaN(n) && n !== 0) out[k] = n;
        }
    }
    return Object.keys(out).length > 0 ? out : null;
}

/**
 * Parse equipment protection / resistance strings into percentage map.
 * @param {string} str
 * @returns {Record<string, number>|null}
 */
function parseResists(str) {
    if (!str) return null;
    const resists = {};
    const regex =
        /(?:protection\s+)?(physical|fire|ice|energy|earth|holy|death)\s*\+?(-?\d+)%/gi;
    let match;
    while ((match = regex.exec(str)) !== null) {
        resists[match[1].toLowerCase()] = Number(match[2]);
    }
    return Object.keys(resists).length > 0 ? resists : null;
}

/**
 * Resists from data.absorbpercent* (poison → earth).
 * @param {object} data
 * @returns {Record<string, number>|null}
 */
function resistsFromData(data) {
    if (!data || typeof data !== 'object') return null;
    const map = {
        absorbpercentphysical: 'physical',
        absorbpercentfire: 'fire',
        absorbpercentice: 'ice',
        absorbpercentenergy: 'energy',
        absorbpercentpoison: 'earth',
        absorbpercentearth: 'earth',
        absorbpercentholy: 'holy',
        absorbpercentdeath: 'death'
    };
    const out = {};
    for (const src of Object.keys(map)) {
        if (data[src] == null || data[src] === '') continue;
        const n = Number(data[src]);
        if (Number.isNaN(n) || n === 0) continue;
        const dest = map[src];
        // Keep the stronger value if both poison and earth absorb are present.
        if (out[dest] == null || Math.abs(n) > Math.abs(out[dest])) out[dest] = n;
    }
    return Object.keys(out).length > 0 ? out : null;
}

/**
 * Merge resist maps; later sources win (data > string).
 * @returns {Record<string, number>|null}
 */
function mergeResistMaps() {
    const out = {};
    for (let i = 0; i < arguments.length; i++) {
        const src = arguments[i];
        if (!src || typeof src !== 'object') continue;
        for (const k of Object.keys(src)) {
            const n = Number(src[k]);
            if (!Number.isNaN(n) && n !== 0) out[k] = n;
        }
    }
    return Object.keys(out).length > 0 ? out : null;
}

/**
 * Speed bonus from data.speed or attributes text ("speed +30").
 * @param {string} attributesStr
 * @param {object} data
 * @returns {number|null}
 */
function parseSpeedBonus(attributesStr, data) {
    if (data && data.speed != null && data.speed !== '') {
        const n = Number(data.speed);
        if (!Number.isNaN(n) && n !== 0) return n;
    }
    if (attributesStr) {
        const m = /speed\s*\+?(-?\d+)/i.exec(attributesStr);
        if (m) return Number(m[1]);
    }
    return null;
}

/**
 * Duration in seconds from data.duration (raw seconds) or human text
 * ("10 minutes", "7.5 minutes", "2 hours").
 * @param {object} wikiItem
 * @param {object} data
 * @returns {number|null}
 */
function parseDurationSec(wikiItem, data) {
    if (data && data.duration != null && data.duration !== '') {
        const n = Number(data.duration);
        if (!Number.isNaN(n) && n > 0) return n;
    }
    const raw = wikiItem && wikiItem.duration;
    if (raw == null || raw === '') return null;
    if (typeof raw === 'number' && raw > 0) return raw;
    const s = String(raw).trim().toLowerCase();
    let m = /^([\d.]+)\s*minutes?$/.exec(s);
    if (m) return Math.round(parseFloat(m[1]) * 60);
    m = /^([\d.]+)\s*hours?$/.exec(s);
    if (m) return Math.round(parseFloat(m[1]) * 3600);
    m = /^([\d.]+)\s*seconds?$/.exec(s);
    if (m) return Math.round(parseFloat(m[1]));
    const n = Number(s);
    if (!Number.isNaN(n) && n > 0) return n;
    return null;
}

/**
 * Imbuement slot count from wiki slots or data.imbuementslot (number or map).
 * @param {object} wikiItem
 * @param {object} data
 * @returns {number|null}
 */
function parseImbuementSlots(wikiItem, data) {
    if (wikiItem && wikiItem.slots != null && Number(wikiItem.slots) > 0) {
        return Number(wikiItem.slots);
    }
    const imb = data && data.imbuementslot;
    if (imb == null || imb === '') return null;
    if (typeof imb === 'number' || (typeof imb === 'string' && !Number.isNaN(Number(imb)))) {
        const n = Number(imb);
        return n > 0 ? n : null;
    }
    if (typeof imb === 'object') {
        const keys = Object.keys(imb)
            .map(Number)
            .filter((n) => !Number.isNaN(n) && n > 0);
        if (keys.length) return Math.max.apply(null, keys);
    }
    return null;
}

/**
 * Normalize item name key for catalog merge.
 * @param {string|null|undefined} name
 * @returns {string}
 */
function normalizeWikiItemName(name) {
    return String(name || '')
        .trim()
        .toLowerCase();
}

/**
 * Merge one v1 + one v2 wiki row (same display name).
 * Prefer v2 fields; fill holes from v1; deep-merge `data` with v2 winning keys.
 * @param {object|null|undefined} v1
 * @param {object|null|undefined} v2
 * @returns {object}
 */
function mergeWikiItemPair(v1, v2) {
    if (!v1 && !v2) return {};
    if (!v1) return Object.assign({}, v2);
    if (!v2) return Object.assign({}, v1);
    const base = Object.assign({}, v1, v2);
    const dataA = v1.data && typeof v1.data === 'object' ? v1.data : null;
    const dataB = v2.data && typeof v2.data === 'object' ? v2.data : null;
    if (dataA || dataB) {
        base.data = Object.assign({}, dataA || {}, dataB || {});
    }
    if ((base.attributes == null || base.attributes === '') && v1.attributes) {
        base.attributes = v1.attributes;
    }
    if ((base.resists == null || base.resists === '') && v1.resists) {
        base.resists = v1.resists;
    }
    if ((!base.proficiences || !Object.keys(base.proficiences).length) && v1.proficiences) {
        base.proficiences = v1.proficiences;
    }
    if (!base.name) base.name = v1.name || v2.name;
    return base;
}

/**
 * Union of wiki item catalogs keyed by lowercased name.
 * @param {object[]|Record<string, object>|null|undefined} list1 items.json
 * @param {object[]|Record<string, object>|null|undefined} list2 items-v2.json
 * @returns {object[]}
 */
function mergeWikiItemCatalogs(list1, list2) {
    const toList = (raw) => {
        if (!raw || typeof raw !== 'object') return [];
        return Array.isArray(raw) ? raw : Object.values(raw);
    };
    const byName = new Map();
    for (const it of toList(list1)) {
        if (!it || typeof it !== 'object') continue;
        const name = it.name || (it.data && it.data.name);
        if (!name) continue;
        const k = normalizeWikiItemName(name);
        const cur = byName.get(k) || {};
        cur.v1 = it;
        byName.set(k, cur);
    }
    for (const it of toList(list2)) {
        if (!it || typeof it !== 'object') continue;
        const name = it.name || (it.data && it.data.name);
        if (!name) continue;
        const k = normalizeWikiItemName(name);
        const cur = byName.get(k) || {};
        cur.v2 = it;
        byName.set(k, cur);
    }
    const merged = [];
    for (const pair of byName.values()) {
        merged.push(mergeWikiItemPair(pair.v1, pair.v2));
    }
    merged.sort((a, b) =>
        String(a.name || '').localeCompare(String(b.name || ''), 'en')
    );
    return merged;
}

/**
 * Convert raw Wiki equipment item into engine preset equipment shape.
 * Promotes combat fields from top-level wiki + nested `data`; drops raw
 * attributes/data blobs (no redundancy for the engine rollup path).
 * @param {object} wikiItem
 * @returns {object}
 */
function convertWikiEquipmentItem(wikiItem) {
    if (!wikiItem || typeof wikiItem !== 'object') {
        throw new Error('convertWikiEquipmentItem requires raw item object');
    }
    const data = wikiItem.data && typeof wikiItem.data === 'object' ? wikiItem.data : {};
    const name = wikiItem.name || data.name || 'Unknown Item';
    // entityId schema requires ^[a-z][a-z0-9_]* — prefix leading digits (e.g. "25 Years Backpack").
    let id = slugifyMonsterName(name);
    if (/^[0-9]/.test(id)) id = `item_${id}`;

    const rawTypes = Array.isArray(wikiItem.type)
        ? wikiItem.type
        : data.primarytype
          ? [data.primarytype]
          : [];
    const types = rawTypes.map((t) => String(t).toLowerCase());
    let category = 'other';

    // Order matters: more specific multi-type combos first (e.g. spellbook
    // before shield), then single-type matches. Mirrors the legacy
    // engine ItemsDB switch in playermanager.js.
    if (types.includes('axe') || types.includes('axes') || types.includes('axe weapons')) {
        category = 'axe';
    } else if (
        types.includes('sword') ||
        types.includes('swords') ||
        types.includes('sword weapons')
    ) {
        category = 'sword';
    } else if (
        types.includes('club') ||
        types.includes('clubs') ||
        types.includes('club weapons')
    ) {
        category = 'club';
    } else if (types.includes('bow') || types.includes('bows')) category = 'bow';
    else if (types.includes('crossbow') || types.includes('crossbows')) category = 'crossbow';
    else if (
        types.includes('rod') ||
        types.includes('rods') ||
        types.includes('wand') ||
        types.includes('wands')
    ) {
        category = 'wand';
    } else if (types.includes('spellbook') || types.includes('spellbooks')) {
        category = 'spellbook';
    } else if (types.includes('shield') || types.includes('shields')) category = 'shield';
    else if (types.includes('helmet') || types.includes('helmets')) category = 'helmet';
    else if (types.includes('armor') || types.includes('body equipment')) category = 'armor';
    else if (types.includes('legs')) category = 'legs';
    else if (types.includes('boots') || types.includes('feet')) category = 'boots';
    else if (types.includes('ring') || types.includes('rings')) category = 'ring';
    else if (
        types.includes('amulet') ||
        types.includes('amulets') ||
        types.includes('necklaces')
    ) {
        category = 'amulet';
    } else if (types.includes('ammunition')) category = 'ammo';
    else if (types.includes('quiver') || types.includes('quivers')) category = 'quiver';
    else if (types.includes('container') || types.includes('containers')) {
        category = 'container';
    } else if (types.includes('fist') || types.includes('fist weapons')) category = 'fist';
    else if (types.includes('throwing')) category = 'spear';
    else if (types.includes('light')) category = 'light';

    let weaponType = null;
    if (['sword', 'axe', 'club', 'fist'].includes(category)) weaponType = 'melee';
    else if (['bow', 'crossbow', 'spear'].includes(category)) weaponType = 'distance';
    else if (category === 'wand') weaponType = 'magic';
    else if (category === 'shield' || category === 'spellbook') weaponType = 'shield';

    // Slot mapping — matches the legacy engine (playermanager.js ItemsDB).
    let slot = null;
    if (category === 'helmet') slot = 'helmet';
    else if (category === 'armor') slot = 'armor';
    else if (category === 'legs') slot = 'legs';
    else if (category === 'boots') slot = 'boots';
    else if (category === 'ring') slot = 'ring';
    else if (category === 'amulet') slot = 'amulet';
    else if (category === 'ammo') slot = 'leftHand';
    else if (category === 'light') slot = 'ammunition';
    else if (category === 'shield' || category === 'quiver' || category === 'spellbook') {
        slot = 'leftHand';
    } else if (category === 'container') slot = 'backpack';
    else if (weaponType) slot = 'rightHand';

    let atk =
        Number(wikiItem.attack) ||
        Number(wikiItem['physical attack']) ||
        Number(data.attack) ||
        Number(data.physicalattack) ||
        0;
    let extraAtk = 0;
    let extraAtkElement = null;

    const elemKeys = ['fire', 'ice', 'earth', 'energy', 'holy', 'death'];
    const dataElemKeys = {
        fire: 'elementfire',
        ice: 'elementice',
        earth: 'elementearth',
        energy: 'elementenergy',
        holy: 'elementholy',
        death: 'elementdeath'
    };
    for (let i = 0; i < elemKeys.length; i++) {
        const el = elemKeys[i];
        const val =
            Number(wikiItem[`${el} attack`]) ||
            Number(data[`${el}attack`]) ||
            Number(data[dataElemKeys[el]]) ||
            0;
        if (val > 0) {
            if (atk > 0) {
                extraAtk = val;
                extraAtkElement = el;
            } else {
                atk = val;
                extraAtkElement = el;
            }
        }
    }

    const defense = Number(wikiItem.defense) || Number(data.defense) || 0;
    let defenseBonus = null;
    const rawDefMod =
        wikiItem['defense modifier'] != null
            ? wikiItem['defense modifier']
            : data.defensemodifier != null
              ? data.defensemodifier
              : data.extradef;
    if (rawDefMod != null && rawDefMod !== '') {
        defenseBonus = Number(String(rawDefMod).replace('+', '')) || 0;
    }

    const armor = Number(wikiItem.armor) || Number(data.armor) || 0;
    // Wiki top-level weight is ounces (0.9); data.weight is centi-ounces ("90").
    let weight = 0;
    if (wikiItem.weight != null && wikiItem.weight !== '') {
        weight = Math.round(Number(wikiItem.weight) * 100);
    } else if (data.weight != null && data.weight !== '') {
        weight = Math.round(Number(data.weight));
    }
    if (Number.isNaN(weight) || weight < 0) weight = 0;

    const rawRange = wikiItem.range != null ? wikiItem.range : data.range;
    const range = rawRange != null && rawRange !== '' ? Number(rawRange) : null;
    const rawLevel = wikiItem.level != null ? wikiItem.level : data.level;
    const level =
        rawLevel != null && rawLevel !== '' && Number(rawLevel) > 0
            ? Number(rawLevel)
            : null;
    const vocations = parseVocation(wikiItem.vocation || data.vocation);

    const attributesStr = attributesToString(wikiItem.attributes);
    const skillBonuses = mergeSkillBonusMaps(
        parseSkillBonuses(attributesStr),
        skillBonusesFromData(data)
    );

    const protectionStr = [wikiItem.protection, wikiItem.resists, attributesStr]
        .filter(Boolean)
        .join(', ');
    const resists = mergeResistMaps(parseResists(protectionStr), resistsFromData(data));

    const speed = parseSpeedBonus(attributesStr, data);
    const durationSec = parseDurationSec(wikiItem, data);

    const item = {
        id,
        label: name,
        category,
        slot,
        weight
    };

    if (types.length) item.type = types.slice();
    if (weaponType) item.weaponType = weaponType;
    if (atk > 0) item.atk = atk;
    if (extraAtk > 0) {
        item.extraAtk = extraAtk;
        if (extraAtkElement) item.extraAtkElement = extraAtkElement;
    } else if (extraAtkElement) {
        item.extraAtkElement = extraAtkElement;
    }
    if (defense > 0) item.defense = defense;
    if (defenseBonus != null && defenseBonus !== 0) item.defenseBonus = defenseBonus;
    if (armor > 0) item.armor = armor;
    if (speed != null) item.speed = speed;
    if (durationSec != null) item.durationSec = durationSec;
    if (range != null && range > 0) item.range = range;
    if (level != null) item.level = level;
    if (vocations) item.vocation = vocations;
    if (skillBonuses) item.skillBonuses = skillBonuses;
    if (resists) item.resists = resists;

    const imbSlots = parseImbuementSlots(wikiItem, data);
    if (imbSlots != null) item.imbuementSlots = imbSlots;
    if (wikiItem.hands === 'Two' || wikiItem.hands === 'two-handed') item.twoHanded = true;

    const chargesRaw =
        wikiItem.charges != null
            ? wikiItem.charges
            : data.charges != null
              ? data.charges
              : null;
    if (chargesRaw != null && chargesRaw !== '') {
        const charges = Number(chargesRaw);
        if (!Number.isNaN(charges) && charges > 0) item.charges = charges;
    }

    const hitChanceRaw =
        wikiItem.hitchance != null
            ? wikiItem.hitchance
            : data.hitchance != null
              ? data.hitchance
              : data.hitChance;
    if (hitChanceRaw != null && hitChanceRaw !== '') {
        const n = Number(hitChanceRaw);
        if (!Number.isNaN(n) && n !== 0) item.hitChance = n;
    }
    if (data.maxhitchance != null && data.maxhitchance !== '') {
        const n = Number(data.maxhitchance);
        if (!Number.isNaN(n) && n !== 0) item.maxHitChance = n;
    }
    if (data.lifeleechchance != null && data.lifeleechchance !== '') {
        const n = Number(data.lifeleechchance);
        if (!Number.isNaN(n) && n !== 0) item.lifeLeechChance = n;
    }
    if (data.lifeleechamount != null && data.lifeleechamount !== '') {
        const n = Number(data.lifeleechamount);
        if (!Number.isNaN(n) && n !== 0) item.lifeLeechAmount = n;
    }
    if (data.manaleechchance != null && data.manaleechchance !== '') {
        const n = Number(data.manaleechchance);
        if (!Number.isNaN(n) && n !== 0) item.manaLeechChance = n;
    }
    if (data.manaleechamount != null && data.manaleechamount !== '') {
        const n = Number(data.manaleechamount);
        if (!Number.isNaN(n) && n !== 0) item.manaLeechAmount = n;
    }
    if (data.criticalhitchance != null && data.criticalhitchance !== '') {
        const n = Number(data.criticalhitchance);
        if (!Number.isNaN(n) && n !== 0) item.critChance = n;
    }
    if (data.criticalhitdamage != null && data.criticalhitdamage !== '') {
        const n = Number(data.criticalhitdamage);
        if (!Number.isNaN(n) && n !== 0) item.critExtraDamage = n;
    }
    if (data.perfectshotdamage != null || data.perfectShotDamage != null) {
        const n = Number(data.perfectshotdamage != null ? data.perfectshotdamage : data.perfectShotDamage);
        if (!Number.isNaN(n) && n !== 0) item.perfectShotDamage = n;
    }
    if (data.perfectshotrange != null && data.perfectshotrange !== '') {
        const n = Number(data.perfectshotrange);
        if (!Number.isNaN(n) && n !== 0) item.perfectShotRange = n;
    }

    const hasRegen =
        (data.healthgain != null && data.healthgain !== '') ||
        (data.managain != null && data.managain !== '');
    if (hasRegen) {
        const regen = {};
        if (data.healthgain != null && data.healthgain !== '') {
            regen.hp = Number(data.healthgain);
        }
        if (data.healthticks != null && data.healthticks !== '') {
            regen.hpTicksMs = Number(data.healthticks);
        }
        if (data.managain != null && data.managain !== '') {
            regen.mp = Number(data.managain);
        }
        if (data.manaticks != null && data.manaticks !== '') {
            regen.mpTicksMs = Number(data.manaticks);
        }
        item.regen = regen;
    }

    const flags = {};
    if (
        data.manashield === '1' ||
        data.manashield === 1 ||
        data.manashield === true ||
        /\bmagic shield\b/i.test(attributesStr)
    ) {
        flags.manaShield = true;
    }
    if (
        data.invisible === '1' ||
        data.invisible === 1 ||
        data.invisible === true ||
        /\binvisibility\b/i.test(attributesStr)
    ) {
        flags.invisible = true;
    }
    if (Object.keys(flags).length) item.flags = flags;

    const volumeRaw =
        wikiItem.volume != null
            ? wikiItem.volume
            : data.containersize != null
              ? data.containersize
              : null;
    if (volumeRaw != null && volumeRaw !== '') {
        const n = Number(volumeRaw);
        if (!Number.isNaN(n) && n > 0) item.volume = n;
    }

    return item;
}

const SAMPLE_LEGACY_EQUIPMENT = [
    {
        id: 'iron_longsword',
        label: 'Iron Longsword',
        slot: 'rightHand',
        category: 'sword',
        weaponType: 'melee',
        atk: 42,
        defense: 20,
        weight: 5400
    },
    {
        id: 'oak_shield',
        label: 'Oak Shield',
        slot: 'leftHand',
        category: 'shield',
        weaponType: 'shield',
        defense: 28,
        weight: 4800
    },
    {
        id: 'steel_plate',
        label: 'Steel Plate',
        slot: 'armor',
        category: 'armor',
        armor: 14,
        weight: 12000
    },
    {
        id: 'steel_helm',
        label: 'Steel Helm',
        slot: 'helmet',
        category: 'helmet',
        armor: 6,
        weight: 3200
    },
    {
        id: 'steel_greaves',
        label: 'Steel Greaves',
        slot: 'legs',
        category: 'legs',
        armor: 7,
        weight: 4500
    },
    {
        id: 'leather_boots',
        label: 'Leather Boots',
        slot: 'boots',
        category: 'boots',
        armor: 2,
        speed: 10,
        weight: 900
    },
    {
        id: 'ember_wand',
        label: 'Ember Wand',
        slot: 'rightHand',
        category: 'wand',
        weaponType: 'magic',
        atk: 8,
        skillBonuses: { magic: 2 },
        weight: 1800
    },
    {
        id: 'hunter_bow',
        label: 'Hunter Bow',
        slot: 'rightHand',
        category: 'bow',
        weaponType: 'distance',
        atk: 28,
        weight: 3200
    },
    {
        id: 'fire_ring',
        label: 'Fire Ring',
        slot: 'ring',
        category: 'ring',
        resists: { fire: 10 },
        weight: 90
    }
];

/**
 * Convert full legacy items catalog(s) into engine equipment array.
 * When both v1 and v2 are passed, merges by name before convert so `data`
 * fields (speed, absorb, skills) are not dropped by first-seen slugging.
 *
 * @param {Record<string, object>|object[]|null} rawItems items.json or pre-merged
 * @param {Record<string, object>|object[]|null} [rawItemsV2] items-v2.json
 * @returns {object[]} converted items array
 */
function convertEquipmentList(rawItems, rawItemsV2) {
    let list;
    if (rawItemsV2 != null) {
        list = mergeWikiItemCatalogs(rawItems, rawItemsV2);
    } else if (!rawItems || typeof rawItems !== 'object') {
        return SAMPLE_LEGACY_EQUIPMENT.slice();
    } else {
        list = Array.isArray(rawItems) ? rawItems : Object.values(rawItems);
    }

    const converted = [];
    const seenIds = new Set();

    for (const raw of list) {
        if (!raw || typeof raw !== 'object') continue;
        const item = convertWikiEquipmentItem(raw);
        if (!seenIds.has(item.id)) {
            seenIds.add(item.id);
            converted.push(item);
        }
    }

    // Hand-tuned sample gear wins on id (stable combat fixtures: iron_longsword,
    // leather_boots speed/armor, fire_ring, …). Overlay wiki rows, then prepend
    // any sample ids still missing from the catalog.
    const sampleById = new Map();
    for (let i = 0; i < SAMPLE_LEGACY_EQUIPMENT.length; i++) {
        const sample = SAMPLE_LEGACY_EQUIPMENT[i];
        sampleById.set(sample.id, Object.assign({}, sample));
    }
    for (let i = 0; i < converted.length; i++) {
        const sid = converted[i] && converted[i].id;
        if (sid && sampleById.has(sid)) {
            converted[i] = sampleById.get(sid);
            sampleById.delete(sid);
        }
    }
    const samples = [];
    for (let i = 0; i < SAMPLE_LEGACY_EQUIPMENT.length; i++) {
        const sample = SAMPLE_LEGACY_EQUIPMENT[i];
        if (sampleById.has(sample.id)) {
            samples.push(Object.assign({}, sample));
            sampleById.delete(sample.id);
        }
    }
    return samples.concat(converted);
}

/**
 * Optional label rewrites applied when a ported equipment item has no row in
 * equipment_map.csv. Keep empty (or minimal) on master; fill when re-enabling
 * a legacy pack port. Prefer longer / multi-word patterns first.
 * Shape: [RegExp, replacementString]
 *
 * Placeholders for future ports:
 *   [/\bExample Relic Blade\b/gi, 'Relic Blade'],
 *   [/\bExample City\b/gi, 'Highland'],
 *   [/\bExample Boss\b/gi, 'Archfiend'],
 */
const LEGACY_EQUIPMENT_REPLACEMENTS = [];

/**
 * Sanitize equipment label to remove commercial / source-world-specific proprietary terms.
 * @param {string} label
 * @returns {string}
 */
function sanitizeEquipmentLabel(label) {
    let out = String(label || '');
    for (let i = 0; i < LEGACY_EQUIPMENT_REPLACEMENTS.length; i++) {
        const entry = LEGACY_EQUIPMENT_REPLACEMENTS[i];
        out = out.replace(entry[0], entry[1]);
    }
    return out;
}

/**
 * Ensure entity id matches equipment schema: ^[a-z][a-z0-9_]{0,79}$
 * @param {string} id
 * @returns {string}
 */
function ensureEntityId(id) {
    let out = String(id || 'unknown')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .replace(/_+/g, '_');
    if (!out) out = 'unknown';
    if (/^[0-9]/.test(out)) out = `item_${out}`;
    if (out.length > 80) out = out.slice(0, 80).replace(/_+$/g, '');
    return out || 'unknown';
}

/**
 * Parse equipment_map.csv rows (header: legacy_id,legacy_label,standard_id,standard_label).
 * Labels may contain commas — only the first three commas split fields; rest is label.
 * @param {string} csvText
 * @returns {Array<{legacy_id:string,legacy_label:string,standard_id:string,standard_label:string}>}
 */
function parseEquipmentMapCsv(csvText) {
    const lines = String(csvText || '')
        .replace(/^\uFEFF/, '')
        .split(/\r?\n/)
        .filter((ln) => ln.trim().length > 0);
    if (!lines.length) return [];
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        const c1 = line.indexOf(',');
        if (c1 < 0) continue;
        const c2 = line.indexOf(',', c1 + 1);
        if (c2 < 0) continue;
        const c3 = line.indexOf(',', c2 + 1);
        if (c3 < 0) continue;
        rows.push({
            legacy_id: line.slice(0, c1).trim(),
            legacy_label: line.slice(c1 + 1, c2),
            standard_id: line.slice(c2 + 1, c3).trim(),
            standard_label: line.slice(c3 + 1)
        });
    }
    return rows;
}

/**
 * Serialize equipment map rows to CSV text (LF).
 * @param {Array<{legacy_id:string,legacy_label:string,standard_id:string,standard_label:string}>} rows
 * @returns {string}
 */
function formatEquipmentMapCsv(rows) {
    const lines = ['legacy_id,legacy_label,standard_id,standard_label'];
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        lines.push(
            [
                r.legacy_id || '',
                r.legacy_label != null ? r.legacy_label : '',
                r.standard_id || '',
                r.standard_label != null ? r.standard_label : ''
            ].join(',')
        );
    }
    return lines.join('\n') + '\n';
}

/**
 * Name-ish keys that can fingerprint a legacy port if left on standard items.
 * Combat stats (atk, armor, …) are kept; identity always comes from the map.
 */
const EQUIPMENT_COPY_FINGERPRINT_KEYS = [
    'legacyName',
    'legacyId',
    'legacy_id',
    'legacy_label',
    'sourceName',
    'originalName',
    'originalId',
    'wikiName',
    'clientId',
    'serverId',
    'spriteId',
    'name'
];

/**
 * Map one legacy equipment item to a standard-mode item using a CSV row or sanitize fallback.
 *
 * **Commercial-safe identity:** always overwrites `id` and `label` from
 * `equipment_map.csv` (`standard_id` / `standard_label`) or from
 * {@link sanitizeEquipmentLabel} when unmapped. Legacy id/label never remain
 * on the standard item — they are the primary copy-fingerprint surface.
 *
 * @param {object} legacyItem
 * @param {{standard_id?:string,standard_label?:string}|null} mapRow
 * @param {Set<string>} seenStdIds
 * @returns {{item:object,mapRow:{legacy_id:string,legacy_label:string,standard_id:string,standard_label:string},generated:boolean}}
 */
function mapOneLegacyEquipmentToStandard(legacyItem, mapRow, seenStdIds) {
    const legId = legacyItem && legacyItem.id != null ? String(legacyItem.id) : 'unknown';
    const legLabel =
        legacyItem && legacyItem.label != null ? String(legacyItem.label) : legId;

    let standardId;
    let standardLabel;
    let generated = false;

    if (mapRow && mapRow.standard_id) {
        standardId = ensureEntityId(mapRow.standard_id);
        standardLabel =
            mapRow.standard_label != null && String(mapRow.standard_label).trim() !== ''
                ? String(mapRow.standard_label)
                : sanitizeEquipmentLabel(legLabel);
    } else {
        generated = true;
        standardLabel = sanitizeEquipmentLabel(legLabel);
        standardId = ensureEntityId(slugifyMonsterName(standardLabel));
    }

    if (seenStdIds.has(standardId)) {
        let n = 2;
        while (seenStdIds.has(`${standardId}_${n}`)) n++;
        standardId = `${standardId}_${n}`;
    }
    seenStdIds.add(standardId);

    // Start from combat payload, then force commercial-safe identity fields.
    const item = Object.assign({}, legacyItem, {
        id: standardId,
        label: standardLabel
    });
    // Drop any name/id fingerprints that would prove a 1:1 legacy catalog copy.
    for (let i = 0; i < EQUIPMENT_COPY_FINGERPRINT_KEYS.length; i++) {
        const k = EQUIPMENT_COPY_FINGERPRINT_KEYS[i];
        if (k !== 'id' && k !== 'label' && Object.prototype.hasOwnProperty.call(item, k)) {
            delete item[k];
        }
    }
    // Schema: slot is string when present — drop null leftovers.
    if (item.slot == null) delete item.slot;

    return {
        item,
        mapRow: {
            legacy_id: legId,
            legacy_label: legLabel,
            standard_id: standardId,
            standard_label: standardLabel
        },
        generated
    };
}

/**
 * Build standard equipment catalog from normalized legacy items + equipment_map.csv rows.
 * Prefer CSV ids/labels (commercial-safe names); generate via sanitize for unmapped legacy ids.
 * Order follows legacy items (easy side-by-side compare).
 *
 * @param {object[]} legacyItems from presets/legacy/equipment.json items[]
 * @param {Array<{legacy_id:string,legacy_label?:string,standard_id:string,standard_label?:string}>|null} [mapRows]
 * @returns {{
 *   items: object[],
 *   mapRows: Array<{legacy_id:string,legacy_label:string,standard_id:string,standard_label:string}>,
 *   stats: { total:number, fromMap:number, generated:number, remappedLegacyIds:number }
 * }}
 */
function mapLegacyEquipmentToStandard(legacyItems, mapRows) {
    const list = Array.isArray(legacyItems) ? legacyItems : [];
    const byLegacy = new Map();
    if (Array.isArray(mapRows)) {
        for (let i = 0; i < mapRows.length; i++) {
            const r = mapRows[i];
            if (!r || !r.legacy_id) continue;
            byLegacy.set(String(r.legacy_id), r);
        }
    }

    const seenStdIds = new Set();
    const items = [];
    const outMap = [];
    let fromMap = 0;
    let generated = 0;
    let remappedLegacyIds = 0;

    for (let i = 0; i < list.length; i++) {
        const leg = list[i];
        if (!leg || typeof leg !== 'object') continue;
        const legId = leg.id != null ? String(leg.id) : '';
        let row = legId ? byLegacy.get(legId) : null;

        // Phase-2 id fix: legacy `item_25_years_backpack` vs CSV `25_years_backpack`.
        if (!row && legId.indexOf('item_') === 0) {
            const bare = legId.slice(5);
            const bareRow = byLegacy.get(bare);
            if (bareRow) {
                row = Object.assign({}, bareRow, {
                    legacy_id: legId,
                    legacy_label: leg.label != null ? String(leg.label) : bareRow.legacy_label
                });
                remappedLegacyIds++;
            }
        }

        const mapped = mapOneLegacyEquipmentToStandard(leg, row, seenStdIds);
        if (mapped.generated) generated++;
        else fromMap++;
        items.push(mapped.item);
        outMap.push(mapped.mapRow);
    }

    return {
        items,
        mapRows: outMap,
        stats: {
            total: items.length,
            fromMap,
            generated,
            remappedLegacyIds
        }
    };
}

/**
 * Convert raw legacy equipment items into standard mode equipment presets.
 * Replaces proprietary/copyright terms with generic ones, slugifies IDs, and keeps all properties.
 * Prefer {@link mapLegacyEquipmentToStandard} when equipment_map.csv is available.
 * @param {object[]} equipList legacy equipment item array
 * @returns {object[]} standard mode equipment items
 */
function convertEquipmentListToStandard(equipList) {
    if (!Array.isArray(equipList)) return SAMPLE_LEGACY_EQUIPMENT.slice();
    // Without CSV: sanitize every label (legacy sample ids kept when they collide).
    const result = mapLegacyEquipmentToStandard(equipList, null);
    // Preserve combat-tuned samples first only if they were not already in the list.
    const seen = new Set(result.items.map((it) => it.id));
    const samples = [];
    for (let i = 0; i < SAMPLE_LEGACY_EQUIPMENT.length; i++) {
        const sample = SAMPLE_LEGACY_EQUIPMENT[i];
        if (!seen.has(sample.id)) {
            seen.add(sample.id);
            samples.push(Object.assign({}, sample));
        }
    }
    return samples.concat(result.items);
}

module.exports = {
    COMBAT_ELEMENTS,
    DOT_CONDITION_TYPES,
    LEGACY_BOOL_FLAG_KEYS,
    slugifyMonsterName,
    labelFromName,
    absDamageRange,
    convertAttack,
    convertCondition,
    mapConditionType,
    conditionKindToElement,
    convertDefenseSpell,
    mapAttackElement,
    convertElementsToResists,
    estimateLevel,
    convertBestiary,
    convertSummon,
    convertMonsterFlags,
    resolveCreatureIdentity,
    applyLegacyMonsterMetadata,
    convertMonsterToTemplate,
    convertMonsterList,
    worldToLocal,
    convertSpawn,
    convertSpawnTable,
    analyzeNavmesh,
    isStairIcon,
    inferCrossFloorConnections,
    normalizeNavmeshForEngine,
    convertWaypointPresets,
    parseVocation,
    parseSkillBonuses,
    parseResists,
    attributesToString,
    skillBonusesFromData,
    resistsFromData,
    parseSpeedBonus,
    parseDurationSec,
    mergeWikiItemPair,
    mergeWikiItemCatalogs,
    convertWikiEquipmentItem,
    convertEquipmentList,
    sanitizeEquipmentLabel,
    ensureEntityId,
    parseEquipmentMapCsv,
    formatEquipmentMapCsv,
    mapLegacyEquipmentToStandard,
    convertEquipmentListToStandard
};


