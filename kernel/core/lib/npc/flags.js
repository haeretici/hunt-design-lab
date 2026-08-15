/**
 * Shared NPC identity for mouse, AI, and spawn.
 * One matrix so dispatcher / hunt AI / combat list cannot drift.
 */

'use strict';

const { copyNpcWanderFields } = require('./wander.js');

/**
 * Content identity: this template/instance is marked as an NPC.
 * Does not apply Q6.2 (hostile never-talk).
 * @param {object|null|undefined} creature
 * @returns {boolean}
 */
function hasNpcIdentity(creature) {
    if (!creature || typeof creature !== 'object') return false;
    if (
        creature.isNpc === true ||
        creature.npc === true ||
        creature.talkable === true
    ) {
        return true;
    }
    const kind = creature.kind != null ? String(creature.kind).toLowerCase() : '';
    if (kind === 'npc') return true;
    const faction =
        creature.faction != null ? String(creature.faction).toLowerCase() : '';
    if (faction === 'npc') return true;
    const flags =
        creature.flags && typeof creature.flags === 'object' ? creature.flags : null;
    if (flags) {
        if (
            flags.isNpc === true ||
            flags.npc === true ||
            flags.talkable === true
        ) {
            return true;
        }
    }
    return false;
}

/**
 * Q6.2: attackable / hostile units never take the talk path.
 * @param {object|null|undefined} creature
 * @returns {boolean}
 */
function isHostileNeverTalk(creature) {
    if (!creature || typeof creature !== 'object') return false;
    if (creature.attackableNpc === true) return true;
    const flags =
        creature.flags && typeof creature.flags === 'object' ? creature.flags : null;
    if (flags) {
        if (flags.hostile === true) return true;
        if (flags.attackableNpc === true) return true;
    }
    return false;
}

/**
 * True if the unit is a talkable NPC (content flags + not hostile).
 * @param {object|null|undefined} creature
 * @returns {boolean}
 */
function isTalkableNpc(creature) {
    if (!hasNpcIdentity(creature)) return false;
    if (isHostileNeverTalk(creature)) return false;
    return true;
}

/**
 * True if the player / hunt AI may attack this unit.
 * Talkable non-hostiles are never attackable.
 * @param {object|null|undefined} creature
 * @param {object|null|undefined} [hit] optional canvas hit (`isNpc`)
 * @returns {boolean}
 */
function isAttackableCreature(creature, hit) {
    if (!creature) return false;
    if (isTalkableNpc(creature)) return false;
    if (hit && hit.isNpc === true) return false;
    return true;
}

/**
 * Copy NPC identity / dialog / shop / wander fields from a template onto a live creature.
 * Does not invent defaults (aggro stays a spawn concern).
 * @param {object} creature
 * @param {object} template
 * @returns {object} creature
 */
function copyNpcFields(creature, template) {
    if (!creature || !template || typeof template !== 'object') return creature;
    const flags =
        template.flags && typeof template.flags === 'object'
            ? template.flags
            : null;
    if (template.isNpc !== undefined) creature.isNpc = !!template.isNpc;
    else if (flags && flags.isNpc === true) creature.isNpc = true;
    if (template.npc !== undefined) creature.npc = !!template.npc;
    else if (flags && flags.npc === true) creature.npc = true;
    if (template.talkable !== undefined) creature.talkable = !!template.talkable;
    else if (flags && flags.talkable === true) creature.talkable = true;
    if (template.kind != null) creature.kind = template.kind;
    if (template.faction != null) creature.faction = template.faction;
    if (template.dialogId != null && String(template.dialogId).trim()) {
        creature.dialogId = String(template.dialogId).trim();
    }
    if (template.attackableNpc !== undefined) {
        creature.attackableNpc = !!template.attackableNpc;
    } else if (flags && flags.attackableNpc === true) {
        creature.attackableNpc = true;
    }
    if (template.dialog && typeof template.dialog === 'object') {
        creature.dialog = JSON.parse(JSON.stringify(template.dialog));
    }
    if (template.shop && typeof template.shop === 'object') {
        creature.shop = JSON.parse(JSON.stringify(template.shop));
    }
    copyNpcWanderFields(creature, template);
    return creature;
}

module.exports = {
    hasNpcIdentity,
    isHostileNeverTalk,
    isTalkableNpc,
    isAttackableCreature,
    copyNpcFields
};
