/**
 * Talkable NPC wander + idle voices (Phase C.4).
 * Cardinal steps inside walkRadius of homeTile. Voices FCT when a spectator
 * is nearby. Any open talk session freezes walk (not voices).
 */

'use strict';

const { Time } = require('../time.js');
const { isTileFieldHazardForEntity } = require('../combat/elemental_fields.js');

/** Fallback spectator Chebyshev when AI tick radius is not a positive number. */
const SPECTATOR_RANGE = 8;

const CARDINALS = Object.freeze([
    { x: 0, y: -1 },
    { x: -1, y: 0 },
    { x: 1, y: 0 },
    { x: 0, y: 1 }
]);

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
 * @returns {number}
 */
function chancePct(raw) {
    const n = nonNegInt(raw);
    return n > 100 ? 100 : n;
}

/**
 * @param {*} raw
 * @returns {{ text: string, yell: boolean }[]}
 */
function normalizeVoices(raw) {
    const list = Array.isArray(raw) ? raw : [];
    const out = [];
    for (let i = 0; i < list.length; i++) {
        const row = list[i];
        if (row == null) continue;
        if (typeof row === 'string') {
            const text = row.trim();
            if (text) out.push({ text, yell: false });
            continue;
        }
        if (typeof row !== 'object') continue;
        const text = String(row.text != null ? row.text : '').trim();
        if (!text) continue;
        out.push({
            text,
            yell: row.yell === true || row.yellText === true
        });
    }
    return out;
}

/**
 * Copy wander / voice fields from a template onto a live creature.
 * @param {object} creature
 * @param {object} template
 * @returns {object} creature
 */
function copyNpcWanderFields(creature, template) {
    if (!creature || !template || typeof template !== 'object') return creature;
    if (template.walkInterval != null) {
        creature.walkInterval = nonNegInt(template.walkInterval);
    }
    if (template.walkRadius != null) {
        creature.walkRadius = nonNegInt(template.walkRadius);
    }
    const rawVoices =
        template.voices != null
            ? template.voices
            : template.voiceVector != null
              ? template.voiceVector
              : null;
    if (rawVoices != null) {
        creature.voices = normalizeVoices(rawVoices);
    }
    const intervalRaw =
        template.voiceInterval != null
            ? template.voiceInterval
            : template.yellSpeedTicks;
    if (intervalRaw != null) {
        creature.voiceInterval = nonNegInt(intervalRaw);
    }
    const chanceRaw =
        template.voiceChance != null
            ? template.voiceChance
            : template.yellChance;
    if (chanceRaw != null) {
        creature.voiceChance = chancePct(chanceRaw);
    }
    return creature;
}

/**
 * @param {object|null|undefined} npc
 * @returns {boolean}
 */
function hasNpcIdle(npc) {
    if (!npc) return false;
    if (npc.walkInterval > 0) return true;
    return !!(
        npc.voiceInterval > 0 &&
        npc.voices &&
        npc.voices.length
    );
}

/**
 * Chebyshev box around home (same floor). walkRadius 0 is never in-zone.
 * @param {{ x?: number, y?: number, z?: * }|null|undefined} home
 * @param {{ x?: number, y?: number, z?: * }|null|undefined} dest
 * @param {number} radius
 * @returns {boolean}
 */
function inWalkZone(home, dest, radius) {
    if (!home || !dest || !(radius > 0)) return false;
    if (home.x == null || home.y == null || dest.x == null || dest.y == null) {
        return false;
    }
    if (String(home.z != null ? home.z : 0) !== String(dest.z != null ? dest.z : 0)) {
        return false;
    }
    return (
        Math.abs(dest.x - home.x) <= radius &&
        Math.abs(dest.y - home.y) <= radius
    );
}

/**
 * @param {object} npc
 * @returns {{ x: number, y: number, z: * }|null}
 */
function ensureHomeTile(npc) {
    if (!npc) return null;
    if (npc.homeTile && npc.homeTile.x != null && npc.homeTile.y != null) {
        return npc.homeTile;
    }
    if (npc.tile && npc.tile.x != null && npc.tile.y != null) {
        npc.homeTile = {
            x: npc.tile.x,
            y: npc.tile.y,
            z: npc.tile.z != null ? npc.tile.z : 0
        };
        return npc.homeTile;
    }
    return null;
}

/**
 * @param {object|null|undefined} npc
 * @param {object[]|null|undefined} players
 * @returns {boolean}
 */
function npcIsInConversation(npc, players) {
    if (!npc || npc.id == null || !Array.isArray(players)) return false;
    for (let i = 0; i < players.length; i++) {
        const p = players[i];
        const talk = p && p._npcTalk;
        if (talk && talk.npcId === npc.id) return true;
    }
    return false;
}

/**
 * Living same-floor spectator within Chebyshev range.
 * @param {object|null|undefined} npc
 * @param {object[]|null|undefined} players
 * @param {number} [range]
 * @returns {boolean}
 */
function hasNearbySpectator(npc, players, range) {
    if (!npc || !npc.tile || !Array.isArray(players) || !players.length) {
        return false;
    }
    const r = range != null ? Number(range) : SPECTATOR_RANGE;
    if (!Number.isFinite(r) || r < 0) return false;
    const nz = String(npc.tile.z != null ? npc.tile.z : 0);
    for (let i = 0; i < players.length; i++) {
        const p = players[i];
        if (!p || !p.tile) continue;
        if (p.alive === false) continue;
        if (p.hp && typeof p.hp === 'object' && p.hp.current <= 0) continue;
        if (String(p.tile.z != null ? p.tile.z : 0) !== nz) continue;
        const d = Math.max(
            Math.abs((p.tile.x || 0) - npc.tile.x),
            Math.abs((p.tile.y || 0) - npc.tile.y)
        );
        if (d <= r) return true;
    }
    return false;
}

/**
 * @param {object} ctx
 * @returns {number}
 */
function spectatorRangeFromCtx(ctx) {
    const r = ctx && ctx.aiTickRadius != null ? Number(ctx.aiTickRadius) : NaN;
    if (Number.isFinite(r) && r > 0) return r;
    return SPECTATOR_RANGE;
}

/**
 * @param {object} ctx
 * @returns {() => number}
 */
function rngFromCtx(ctx) {
    return ctx && typeof ctx.rng === 'function' ? ctx.rng : Math.random;
}

/**
 * @param {() => number} rng
 * @returns {{ x: number, y: number }[]}
 */
function shuffledCardinals(rng) {
    const dirs = CARDINALS.slice();
    const rand = typeof rng === 'function' ? rng : Math.random;
    for (let i = dirs.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        const tmp = dirs[i];
        dirs[i] = dirs[j];
        dirs[j] = tmp;
    }
    return dirs;
}

/**
 * Cardinal dest that stays in walkRadius, walkable, not a field hazard.
 * @param {object} npc
 * @param {{ x: number, y: number }} dir
 * @param {object} tileMap
 * @returns {boolean}
 */
function canNpcWalkTo(npc, dir, tileMap) {
    if (!npc || !npc.tile || !dir || !tileMap) return false;
    const radius = nonNegInt(npc.walkRadius);
    if (!(radius > 0)) return false;
    const home = ensureHomeTile(npc);
    if (!home) return false;
    const z = npc.tile.z;
    const dest = { x: npc.tile.x + dir.x, y: npc.tile.y + dir.y, z };
    if (!inWalkZone(home, dest, radius)) return false;
    if (!tileMap.canEnter(dest.x, dest.y, dest.z, npc)) return false;
    if (isTileFieldHazardForEntity(tileMap, dest.x, dest.y, dest.z, npc)) {
        return false;
    }
    return true;
}

/**
 * @param {object} ctx
 * @param {number} [dtMs]
 * @returns {number}
 */
function resolveDtMs(ctx, dtMs) {
    if (dtMs != null && Number.isFinite(Number(dtMs))) {
        return Math.max(0, Number(dtMs));
    }
    if (ctx && ctx.dtMs != null && Number.isFinite(Number(ctx.dtMs))) {
        return Math.max(0, Number(ctx.dtMs));
    }
    const s = Time.deltaTime;
    if (!Number.isFinite(s) || s <= 0) return 0;
    return s * 1000;
}

/**
 * Interval cardinal wander. Frozen while any party member is talking.
 * @param {object} npc
 * @param {object} ctx
 * @param {number} [dtMs]
 * @returns {{ walked: boolean, frozen?: boolean }}
 */
function tickNpcWander(npc, ctx, dtMs) {
    if (!npc || !(npc.walkInterval > 0)) return { walked: false };
    if (!(npc.speed > 0)) return { walked: false };
    if (npc.aggro === true) return { walked: false };
    if (npc.alive === false) return { walked: false };
    const players = (ctx && ctx.players) || [];
    if (npcIsInConversation(npc, players)) {
        npc._npcWalkTicks = 0;
        return { walked: false, frozen: true };
    }
    const range = spectatorRangeFromCtx(ctx);
    if (!hasNearbySpectator(npc, players, range)) return { walked: false };

    const dt = resolveDtMs(ctx, dtMs);
    if (!(dt > 0)) return { walked: false };
    npc._npcWalkTicks = (npc._npcWalkTicks || 0) + dt;
    if (npc._npcWalkTicks < npc.walkInterval) return { walked: false };
    npc._npcWalkTicks = 0;

    const tileMap = ctx && ctx.tileMap;
    if (!tileMap) return { walked: false };
    if (npc.canStep && !npc.canStep()) return { walked: false };

    const dirs = shuffledCardinals(rngFromCtx(ctx));
    for (let i = 0; i < dirs.length; i++) {
        const dir = dirs[i];
        if (!canNpcWalkTo(npc, dir, tileMap)) continue;
        const dest = {
            x: npc.tile.x + dir.x,
            y: npc.tile.y + dir.y,
            z: npc.tile.z
        };
        if (tileMap.moveEntityToTile(npc, dest.x, dest.y, dest.z)) {
            return { walked: true };
        }
    }
    return { walked: false };
}

/**
 * @param {object} npc
 * @param {{ text: string, yell: boolean }} voice
 * @param {object|null|undefined} ctx
 */
function emitNpcVoice(npc, voice, ctx) {
    const sim = ctx && ctx.sim;
    if (!sim || typeof sim.emitCombatText !== 'function') return;
    const tile = npc.tile || {};
    sim.emitCombatText({
        x: tile.x,
        y: tile.y,
        z: tile.z,
        text: voice.text,
        color: voice.yell ? '#fbbf24' : '#fde68a',
        life: voice.yell ? 2.2 : 1.6
    });
}

/**
 * Interval + chance idle line. Requires a nearby spectator.
 * @param {object} npc
 * @param {object} ctx
 * @param {number} [dtMs]
 * @returns {{ spoke: boolean, text?: string, yell?: boolean }}
 */
function tickNpcVoices(npc, ctx, dtMs) {
    if (!npc || !(npc.voiceInterval > 0)) return { spoke: false };
    const voices = Array.isArray(npc.voices) ? npc.voices : [];
    if (!voices.length) return { spoke: false };
    if (npc.alive === false) return { spoke: false };
    const players = (ctx && ctx.players) || [];
    const range = spectatorRangeFromCtx(ctx);
    if (!hasNearbySpectator(npc, players, range)) return { spoke: false };

    const dt = resolveDtMs(ctx, dtMs);
    if (!(dt > 0)) return { spoke: false };
    npc._npcVoiceTicks = (npc._npcVoiceTicks || 0) + dt;
    if (npc._npcVoiceTicks < npc.voiceInterval) return { spoke: false };
    npc._npcVoiceTicks = 0;

    const chance = chancePct(npc.voiceChance);
    const rng = rngFromCtx(ctx);
    if (chance <= 0) return { spoke: false };
    const roll = Math.floor(rng() * 100) + 1;
    if (roll > chance) return { spoke: false };

    const pick = voices[Math.floor(rng() * voices.length)] || voices[0];
    if (!pick || !pick.text) return { spoke: false };
    emitNpcVoice(npc, pick, ctx);
    return { spoke: true, text: pick.text, yell: !!pick.yell };
}

/**
 * Wander + voices for one logic tick.
 * @param {object} npc
 * @param {object} ctx
 * @param {number} [dtMs]
 * @returns {{ walk: object, voice: object }}
 */
function tickNpcIdle(npc, ctx, dtMs) {
    const voice = tickNpcVoices(npc, ctx, dtMs);
    const walk = tickNpcWander(npc, ctx, dtMs);
    return { walk, voice };
}

module.exports = {
    SPECTATOR_RANGE,
    nonNegInt,
    normalizeVoices,
    copyNpcWanderFields,
    hasNpcIdle,
    inWalkZone,
    ensureHomeTile,
    npcIsInConversation,
    hasNearbySpectator,
    canNpcWalkTo,
    tickNpcWander,
    tickNpcVoices,
    tickNpcIdle
};
