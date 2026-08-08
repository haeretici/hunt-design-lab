/**
 * Delayed shaped casts (e.g. divine grenade fuse).
 *
 * Catalog:
 *   spell.delaySec > 0  → spend mana/CD on cast, deal damage after fuse
 *   spell.delayPlaceRange (default 4) → if primary Chebyshev ≤ N and same
 *     floor, plant on primary tile; else plant under caster (wiki Divine Grenade).
 *
 * Planted center is {x,y,z} at cast time. Detonation uses that center even if
 * the caster later changes floor or walks away (skipDelay + skipCasterLos).
 * Same floor-stick contract as elemental fields / barrier walls: world-owned
 * after plant; sim ticks fuse every frame regardless of caster.tile.z.
 * Caster must still be alive at detonate (legacy Player(id) check).
 *
 * Pending entries live on sim.pendingDelayedCasts when a sim is provided,
 * else on attacker.pendingDelayedCasts (unit tests / headless snippets).
 * Watch UI draws a slow blink on the plant floor from that store.
 */

'use strict';

/**
 * @param {object|null|undefined} spell
 * @returns {boolean}
 */
function spellHasDelay(spell) {
    if (!spell) return false;
    const d = Number(spell.delaySec);
    return Number.isFinite(d) && d > 0;
}

/**
 * @param {object|null|undefined} spell
 * @returns {number} seconds (0 if none)
 */
function resolveDelaySec(spell) {
    if (!spellHasDelay(spell)) return 0;
    return Number(spell.delaySec);
}

/**
 * Chebyshev tile distance.
 * @param {{x:number,y:number}|null|undefined} a
 * @param {{x:number,y:number}|null|undefined} b
 * @returns {number}
 */
function chebyshev(a, b) {
    if (!a || !b) return Infinity;
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/**
 * Wiki Divine Grenade placement: target feet when within delayPlaceRange,
 * otherwise under caster.
 *
 * @param {object} attacker
 * @param {object|null|undefined} primary
 * @param {object} spell
 * @returns {{x:number,y:number,z?:*}|null}
 */
function resolveDelayedPlaceCenter(attacker, primary, spell) {
    if (!attacker || !attacker.tile) return null;
    const placeRange =
        spell && spell.delayPlaceRange != null
            ? Number(spell.delayPlaceRange)
            : 4;
    const at = attacker.tile;
    const az = at.z !== undefined && at.z !== null ? at.z : 0;

    if (
        primary &&
        primary.tile &&
        Number.isFinite(placeRange) &&
        placeRange >= 0
    ) {
        const pt = primary.tile;
        const pz = pt.z !== undefined && pt.z !== null ? pt.z : 0;
        if (String(pz) === String(az) && chebyshev(at, pt) <= placeRange) {
            return { x: pt.x, y: pt.y, z: pz };
        }
    }

    return { x: at.x, y: at.y, z: az };
}

/**
 * @param {object|null|undefined} sim
 * @param {object|null|undefined} attacker
 * @param {object[]|null|undefined} explicit
 * @returns {object[]}
 */
function getDelayedCastStore(sim, attacker, explicit) {
    if (Array.isArray(explicit)) return explicit;
    if (sim) {
        if (!Array.isArray(sim.pendingDelayedCasts)) {
            sim.pendingDelayedCasts = [];
        }
        return sim.pendingDelayedCasts;
    }
    if (attacker) {
        if (!Array.isArray(attacker.pendingDelayedCasts)) {
            attacker.pendingDelayedCasts = [];
        }
        return attacker.pendingDelayedCasts;
    }
    return [];
}

/**
 * @param {object[]} store
 * @param {{
 *   remainingSec: number,
 *   spell: object,
 *   center: {x:number,y:number,z?:*},
 *   attacker: object,
 *   direction?: {x:number,y:number},
 *   spellBook?: object,
 *   sessionConfig?: *,
 *   skillProgression?: *
 * }} entry
 */
function scheduleDelayedCast(store, entry) {
    if (!Array.isArray(store) || !entry) return;
    const remaining = Number(entry.remainingSec);
    if (!(remaining > 0) || !entry.spell || !entry.center || !entry.attacker) {
        return;
    }
    store.push({
        remainingSec: remaining,
        spell: entry.spell,
        center: {
            x: entry.center.x,
            y: entry.center.y,
            z: entry.center.z
        },
        attacker: entry.attacker,
        direction: entry.direction || { x: 1, y: 0 },
        spellBook: entry.spellBook || null,
        sessionConfig: entry.sessionConfig,
        skillProgression: entry.skillProgression
    });
}

/**
 * Tick fuses; call explodeFn(entry) for each that reaches 0.
 * explodeFn may return a result object (collected).
 *
 * @param {object[]} store
 * @param {number} dtSec
 * @param {(entry: object) => *} [explodeFn]
 * @returns {{ fired: object[], remaining: number }}
 */
function tickDelayedCasts(store, dtSec, explodeFn) {
    if (!Array.isArray(store) || !store.length) {
        return { fired: [], remaining: 0 };
    }
    const dt = Number(dtSec);
    if (!(dt > 0)) {
        return { fired: [], remaining: store.length };
    }

    /** @type {object[]} */
    const fired = [];
    let write = 0;
    for (let i = 0; i < store.length; i++) {
        const e = store[i];
        if (!e) continue;
        e.remainingSec = Number(e.remainingSec) - dt;
        if (e.remainingSec > 1e-9) {
            store[write++] = e;
            continue;
        }
        // Detonate
        let result = null;
        if (typeof explodeFn === 'function') {
            try {
                result = explodeFn(e);
            } catch (_err) {
                result = { ok: false, reason: 'explode_error' };
            }
        }
        fired.push({ entry: e, result });
    }
    store.length = write;
    return { fired, remaining: store.length };
}

/**
 * Build living combat candidates from a sim (party members + creatures).
 * @param {object|null|undefined} sim
 * @param {object|null|undefined} attacker exclude self
 * @returns {object[]}
 */
function candidatesFromSim(sim, attacker) {
    /** @type {object[]} */
    const out = [];
    if (!sim) return out;
    const push = (e) => {
        if (!e || e === attacker || e.alive === false) return;
        if (e.hp && e.hp.current <= 0) return;
        if (!e.tile) return;
        out.push(e);
    };
    if (Array.isArray(sim.creatures)) {
        for (let i = 0; i < sim.creatures.length; i++) push(sim.creatures[i]);
    }
    if (Array.isArray(sim.parties)) {
        for (let p = 0; p < sim.parties.length; p++) {
            const members =
                sim.parties[p] && sim.parties[p].members
                    ? sim.parties[p].members
                    : [];
            for (let m = 0; m < members.length; m++) push(members[m]);
        }
    }
    if (Array.isArray(sim.players)) {
        for (let i = 0; i < sim.players.length; i++) push(sim.players[i]);
    }
    return out;
}

/**
 * Explode a pending delayed cast via resolveShapedAttack (skip CD/mana/delay).
 *
 * @param {object} entry
 * @param {object} opts
 * @param {function} opts.resolveShapedAttack
 * @param {object|null} [opts.tileMap]
 * @param {object[]} [opts.candidates]
 * @param {object|null} [opts.sim]
 * @param {() => number} [opts.rng]
 * @returns {object}
 */
function explodeDelayedCast(entry, opts) {
    const o = opts || {};
    const resolveShapedAttack = o.resolveShapedAttack;
    if (!entry || !resolveShapedAttack) {
        return { ok: false, reason: 'missing_explode' };
    }
    const attacker = entry.attacker;
    if (!attacker || attacker.alive === false) {
        return { ok: false, reason: 'attacker_gone' };
    }
    const sim = o.sim || null;
    const candidates =
        o.candidates ||
        candidatesFromSim(sim, attacker);

    return resolveShapedAttack({
        attacker,
        primary: null,
        spell: entry.spell,
        candidates,
        tileMap: o.tileMap || (sim && sim.tileMap) || null,
        sim,
        spellBook: entry.spellBook || null,
        rng: o.rng || Math.random,
        center: entry.center,
        direction: entry.direction,
        skipCooldown: true,
        skipMana: true,
        skipDelay: true,
        sessionConfig: entry.sessionConfig,
        skillProgression: entry.skillProgression
    });
}

module.exports = {
    spellHasDelay,
    resolveDelaySec,
    resolveDelayedPlaceCenter,
    getDelayedCastStore,
    scheduleDelayedCast,
    tickDelayedCasts,
    candidatesFromSim,
    explodeDelayedCast,
    chebyshev
};
