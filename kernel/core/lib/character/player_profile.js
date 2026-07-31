/**
 * Player profile → party member expansion (Phase 5).
 * Profiles use designer slot names (head/chest/weapon/shield); combat uses
 * engine slots (helmet/armor/rightHand/leftHand). Pure helpers + optional loaders.
 */

'use strict';

const { normalizeEquipmentMap } = require('./stats.js');

/**
 * Trim a non-empty string field, else null.
 * @param {*} v
 * @returns {string|null}
 */
function trimId(v) {
    if (v == null) return null;
    const s = String(v).trim();
    return s ? s : null;
}

/**
 * Resolve watch-mode art for a party member / player.
 * Priority: profile/member customSprite → vocation baseSprite → none (polygon).
 *
 * @param {object|null|undefined} member party member bag (may carry customSprite)
 * @param {object|null|undefined} classDef classes.json entry (may carry baseSprite)
 * @returns {{ spriteId: string|null, spriteGenre: string|null }}
 */
function resolvePlayerSpriteArt(member, classDef) {
    const m = member && typeof member === 'object' ? member : {};
    const cls = classDef && typeof classDef === 'object' ? classDef : {};

    const custom =
        trimId(m.customSprite) || trimId(m.spriteId) || null;
    if (custom) {
        return {
            spriteId: custom,
            spriteGenre:
                trimId(m.customSpriteGenre) ||
                trimId(m.spriteGenre) ||
                null
        };
    }

    const base = trimId(cls.baseSprite);
    if (base) {
        return {
            spriteId: base,
            spriteGenre: trimId(cls.baseSpriteGenre) || null
        };
    }

    return { spriteId: null, spriteGenre: null };
}

/**
 * Build a simulator/party member bag from a player_profiles entity.
 * Does not load files — pass the profile object.
 *
 * @param {object|null|undefined} profile
 * @param {object} [overrides] party member fields (name, isLeader, level, …)
 * @returns {object|null}
 */
function memberFromPlayerProfile(profile, overrides) {
    if (!profile || typeof profile !== 'object') return null;
    const o = overrides && typeof overrides === 'object' ? overrides : {};

    const classId =
        o.classId != null && String(o.classId) !== ''
            ? String(o.classId)
            : o.vocation != null && String(o.vocation) !== ''
              ? String(o.vocation)
              : profile.vocation != null && String(profile.vocation) !== ''
                ? String(profile.vocation)
                : profile.classId != null
                  ? String(profile.classId)
                  : 'adventurer';

    const level =
        o.level != null && Number.isFinite(Number(o.level))
            ? Math.max(1, Math.floor(Number(o.level)))
            : profile.level != null && Number.isFinite(Number(profile.level))
              ? Math.max(1, Math.floor(Number(profile.level)))
              : 50;

    const strategyId =
        o.strategyId != null && String(o.strategyId) !== ''
            ? String(o.strategyId)
            : profile.strategyId != null && String(profile.strategyId) !== ''
              ? String(profile.strategyId)
              : null;

    // Member-level equipment overrides profile; both are normalized to engine slots.
    const profileEq = normalizeEquipmentMap(profile.equipment);
    const overrideEq = normalizeEquipmentMap(o.equipment);
    const equipment = Object.assign({}, profileEq, overrideEq);

    const name =
        o.name != null && String(o.name).trim() !== ''
            ? String(o.name).trim()
            : profile.label != null && String(profile.label).trim() !== ''
              ? String(profile.label).trim()
              : profile.id != null
                ? String(profile.id)
                : 'Member';

    /** @type {Record<string, any>} */
    const member = {
        name,
        classId,
        level,
        isLeader: !!o.isLeader,
        promoted: o.promoted != null ? !!o.promoted : !!profile.promoted,
        controlMode: o.controlMode != null && String(o.controlMode) !== ''
            ? String(o.controlMode)
            : profile.controlMode != null && String(profile.controlMode) !== ''
              ? String(profile.controlMode)
              : 'ai',
        equipment
    };
    if (strategyId) member.strategyId = strategyId;
    if (o.profileId != null) member.profileId = String(o.profileId);
    else if (profile.id != null) member.profileId = String(profile.id);

    // Watch-mode art: profile customSprite (member override wins)
    const customSprite =
        trimId(o.customSprite) ||
        trimId(o.spriteId) ||
        trimId(profile.customSprite) ||
        trimId(profile.spriteId);
    if (customSprite) {
        member.customSprite = customSprite;
        member.spriteId = customSprite;
    }
    const customSpriteGenre =
        trimId(o.customSpriteGenre) ||
        trimId(o.spriteGenre) ||
        trimId(profile.customSpriteGenre) ||
        trimId(profile.spriteGenre);
    if (customSpriteGenre) {
        member.customSpriteGenre = customSpriteGenre;
        member.spriteGenre = customSpriteGenre;
    }

    // Character skills (profile or member override) → buildEffectiveStats baseSkills
    const profileSkills =
        profile.skills && typeof profile.skills === 'object' ? profile.skills : null;
    const overrideSkills =
        o.skills && typeof o.skills === 'object' ? o.skills : null;
    if (overrideSkills || profileSkills) {
        member.skills = Object.assign({}, profileSkills || {}, overrideSkills || {});
    }

    // Optional combat extras from profile.stats when present
    if (profile.stats && typeof profile.stats === 'object') {
        if (profile.stats.critChance != null && o.critChance == null) {
            member.critChance = Number(profile.stats.critChance) || 0;
        }
        if (profile.stats.critDamage != null && o.critDamage == null) {
            member.critDamage = Number(profile.stats.critDamage) || 0;
        }
    }
    if (o.critChance != null) member.critChance = Number(o.critChance) || 0;
    if (o.critDamage != null) member.critDamage = Number(o.critDamage) || 0;
    if (o.strategy != null) member.strategy = o.strategy;
    if (o.combatStats != null) member.combatStats = o.combatStats;
    if (o.classDef != null) member.classDef = o.classDef;
    if (o.speed != null) member.speed = o.speed;
    if (o.hp != null) member.hp = o.hp;
    if (o.hpMax != null) member.hpMax = o.hpMax;
    // Inventory seed (root backpack & container contents / sandbox flag) — passed to Simulator spawn
    if (o.inventory != null) member.inventory = o.inventory;
    else if (profile.inventory != null) member.inventory = profile.inventory;
    if (o.backpack != null) member.backpack = o.backpack;
    else if (profile.backpack != null) member.backpack = profile.backpack;
    if (o.inventorySandbox === true || profile.inventorySandbox === true) member.inventorySandbox = true;

    return member;
}

/**
 * Expand a party member that may reference `profileId`.
 * Profile fields fill gaps; explicit member fields win.
 * Always normalizes equipment slots.
 *
 * @param {object|null|undefined} rawMember
 * @param {{ loadPlayerProfile?: (id: string) => object|null }} [opts]
 * @returns {object|null}
 */
function expandPartyMember(rawMember, opts) {
    if (!rawMember || typeof rawMember !== 'object') return null;
    const options = opts || {};
    const profileId =
        rawMember.profileId != null
            ? String(rawMember.profileId)
            : rawMember.profile != null
              ? String(rawMember.profile)
              : null;

    let profile = null;
    if (profileId && typeof options.loadPlayerProfile === 'function') {
        try {
            profile = options.loadPlayerProfile(profileId);
        } catch (_) {
            profile = null;
        }
    }

    if (profile) {
        const overrides = Object.assign({}, rawMember, {
            profileId,
            // Keep empty equipment so profile gear is used unless member sets items
            equipment:
                rawMember.equipment && typeof rawMember.equipment === 'object'
                    ? rawMember.equipment
                    : {}
        });
        // inventory / backpack / inventorySandbox already on rawMember → overrides
        return memberFromPlayerProfile(profile, overrides);
    }

    // No profile: still normalize equipment aliases on inline members
    const equipment = normalizeEquipmentMap(rawMember.equipment);
    const out = Object.assign({ controlMode: 'ai' }, rawMember, { equipment });
    if (profileId) out.profileId = profileId;
    if (out.classId == null && out.vocation != null) {
        out.classId = String(out.vocation);
    }
    // Normalize optional art override aliases
    const customSprite = trimId(out.customSprite) || trimId(out.spriteId);
    if (customSprite) {
        out.customSprite = customSprite;
        out.spriteId = customSprite;
    }
    const customSpriteGenre =
        trimId(out.customSpriteGenre) || trimId(out.spriteGenre);
    if (customSpriteGenre) {
        out.customSpriteGenre = customSpriteGenre;
        out.spriteGenre = customSpriteGenre;
    }
    return out;
}

/**
 * Expand all members on a party (or array of members).
 *
 * @param {object|null|undefined} party party with members[], or members array
 * @param {{ loadPlayerProfile?: (id: string) => object|null }} [opts]
 * @returns {object|object[]|null}
 */
function expandPartyMembers(party, opts) {
    if (!party) return party;
    if (Array.isArray(party)) {
        return party.map((m) => expandPartyMember(m, opts)).filter(Boolean);
    }
    if (typeof party !== 'object') return party;
    const members = Array.isArray(party.members) ? party.members : [];
    return Object.assign({}, party, {
        members: members.map((m) => expandPartyMember(m, opts)).filter(Boolean)
    });
}

/**
 * Expand profileId / slot aliases on every party in a list.
 * @param {object[]|null|undefined} parties
 * @param {{ loadPlayerProfile?: (id: string) => object|null }} [opts]
 * @returns {object[]}
 */
function expandParties(parties, opts) {
    if (!Array.isArray(parties)) return [];
    return parties.map((p) => expandPartyMembers(p, opts)).filter(Boolean);
}

module.exports = {
    trimId,
    resolvePlayerSpriteArt,
    memberFromPlayerProfile,
    expandPartyMember,
    expandPartyMembers,
    expandParties
};
