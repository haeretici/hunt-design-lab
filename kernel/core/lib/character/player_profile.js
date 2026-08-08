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
    // Starting combat conditions (Scenario Lab status demos / scripted seeds)
    if (Array.isArray(o.conditions) && o.conditions.length) {
        member.conditions = o.conditions.slice();
    } else if (Array.isArray(profile.conditions) && profile.conditions.length) {
        member.conditions = profile.conditions.slice();
    }

    return member;
}

/**
 * Default product starter profile per vocation (create-char analog).
 * Used when a form/session row has classId but no profileId/skills bag.
 * Keys match classes.json ids that have standard starter profiles.
 */
const DEFAULT_STARTER_PROFILE_BY_CLASS = Object.freeze({
    guardian: 'guardian_starter',
    scout: 'scout_starter',
    adept: 'adept_starter',
    warden: 'warden_starter',
    // No mystic_* profiles in standard yet — materialize leaves mystic class-only
    // (assert fails until a profile is authored or skills are explicit).
    adventurer: 'test_weak_adventurer'
});

/**
 * @param {string|null|undefined} classId
 * @returns {string|null} profile id or null when no default starter exists
 */
function defaultProfileIdForClass(classId) {
    if (classId == null || String(classId).trim() === '') return null;
    const id = String(classId).trim().toLowerCase();
    return DEFAULT_STARTER_PROFILE_BY_CLASS[id] || null;
}

/**
 * True when a member bag has a non-empty authored skills object
 * (from profile expand or explicit member.skills).
 * @param {object|null|undefined} member
 * @returns {boolean}
 */
function memberHasAuthoredSkills(member) {
    if (!member || typeof member !== 'object') return false;
    const s = member.skills;
    if (!s || typeof s !== 'object') return false;
    return Object.keys(s).length > 0;
}

/**
 * Product gate (§7.2): every enabled member needs profile-derived or
 * explicit skills — class floors alone are not enough.
 *
 * Prefer materializePartyMember / materializePartyMembers first so lab
 * class-only rows become starter-profile characters before this runs.
 *
 * @param {object|object[]|null|undefined} partyOrMembers party bag or members[]
 * @param {{ context?: string, onlyEnabled?: boolean }} [opts]
 * @returns {object|object[]} same input on success
 * @throws {Error} when a member lacks authored skills
 */
function assertPartyMembersHaveSkillSource(partyOrMembers, opts) {
    const o = opts || {};
    const context = o.context ? String(o.context) : 'party';
    const onlyEnabled = o.onlyEnabled !== false;
    /** @type {object[]} */
    let members;
    if (Array.isArray(partyOrMembers)) {
        members = partyOrMembers;
    } else if (partyOrMembers && typeof partyOrMembers === 'object') {
        members = Array.isArray(partyOrMembers.members)
            ? partyOrMembers.members
            : [];
    } else {
        members = [];
    }
    for (let i = 0; i < members.length; i++) {
        const m = members[i];
        if (!m || typeof m !== 'object') continue;
        if (onlyEnabled && m.enabled === false) continue;
        if (memberHasAuthoredSkills(m)) continue;
        const name =
            m.name != null && String(m.name).trim() !== ''
                ? String(m.name).trim()
                : m.profileId != null
                  ? String(m.profileId)
                  : m.classId != null
                    ? String(m.classId)
                    : 'member';
        const classId =
            m.classId != null
                ? String(m.classId)
                : m.vocation != null
                  ? String(m.vocation)
                  : null;
        const starterHint = defaultProfileIdForClass(classId);
        const profileHint =
            m.profileId != null
                ? ` profileId="${m.profileId}" (missing or empty skills after resolve)`
                : starterHint
                  ? ` no profileId/skills; default starter "${starterHint}" did not resolve`
                  : ' no profileId and no explicit skills (no default starter for class)';
        throw new Error(
            `${context}: member[${i}] ("${name}") has no authored skills.` +
                `${profileHint}. Product parties require a resolvable profileId, ` +
                `an explicit non-empty skills bag, or a materializable starter ` +
                `profile (docs/27 §7.2).`
        );
    }
    return partyOrMembers;
}

/**
 * Create-char analog: expand profileId and, when still skill-less, bind the
 * default starter profile for the member's class (authored skills, not class floors).
 *
 * @param {object|null|undefined} rawMember
 * @param {{
 *   loadPlayerProfile?: (id: string) => object|null,
 *   autoStarterProfile?: boolean
 * }} [opts] autoStarterProfile defaults true
 * @returns {object|null}
 */
function materializePartyMember(rawMember, opts) {
    if (!rawMember || typeof rawMember !== 'object') return null;
    const options = opts || {};
    const autoStarter = options.autoStarterProfile !== false;
    let member = expandPartyMember(rawMember, options);
    if (!member) return null;
    if (memberHasAuthoredSkills(member)) return member;
    if (!autoStarter) return member;
    if (typeof options.loadPlayerProfile !== 'function') return member;

    const classId =
        member.classId != null
            ? String(member.classId)
            : member.vocation != null
              ? String(member.vocation)
              : rawMember.classId != null
                ? String(rawMember.classId)
                : rawMember.vocation != null
                  ? String(rawMember.vocation)
                  : null;
    const starterId = defaultProfileIdForClass(classId);
    if (!starterId) return member;

    // Already pointed at a starter that failed to load — do not loop
    if (member.profileId != null && String(member.profileId) === starterId) {
        return member;
    }

    const rebound = Object.assign({}, member, { profileId: starterId });
    // Drop empty/invalid skills so profile bag wins
    if (!memberHasAuthoredSkills(rebound)) {
        delete rebound.skills;
    }
    const expanded = expandPartyMember(rebound, options);
    return expanded || member;
}

/**
 * Materialize every member on a party bag or members array.
 *
 * @param {object|object[]|null|undefined} party
 * @param {{
 *   loadPlayerProfile?: (id: string) => object|null,
 *   autoStarterProfile?: boolean
 * }} [opts]
 * @returns {object|object[]|null}
 */
function materializePartyMembers(party, opts) {
    if (!party) return party;
    if (Array.isArray(party)) {
        return party.map((m) => materializePartyMember(m, opts)).filter(Boolean);
    }
    if (typeof party !== 'object') return party;
    const members = Array.isArray(party.members) ? party.members : [];
    return Object.assign({}, party, {
        members: members
            .map((m) => materializePartyMember(m, opts))
            .filter(Boolean)
    });
}

/**
 * Materialize each party in a list (session resolve / browser opts).
 * @param {object[]|null|undefined} parties
 * @param {{
 *   loadPlayerProfile?: (id: string) => object|null,
 *   autoStarterProfile?: boolean
 * }} [opts]
 * @returns {object[]}
 */
function materializeParties(parties, opts) {
    if (!Array.isArray(parties)) return [];
    return parties
        .map((p) => materializePartyMembers(p, opts))
        .filter(Boolean);
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
    DEFAULT_STARTER_PROFILE_BY_CLASS,
    defaultProfileIdForClass,
    memberHasAuthoredSkills,
    assertPartyMembersHaveSkillSource,
    materializePartyMember,
    materializePartyMembers,
    materializeParties,
    expandPartyMember,
    expandPartyMembers,
    expandParties
};
