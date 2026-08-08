/**
 * Party FollowLeader trail destinations (legacy path-slot style).
 *
 * Same-floor only: pick a tile N steps *before* the raw goal on the A* path
 * so followers do not all clamp onto the leader tile. Cross-floor remains
 * Party.stepTowardFloor in player_states (not handled here).
 *
 * rawGoal is isolated in resolveFollowRawGoal so peaceful-WP can plug in later
 * without changing trail math or FollowLeader wiring.
 */

'use strict';

const { Settings } = require('../../../settings.js');

/**
 * Living non-leader party members in party.members order → 1-based slot.
 * @param {object} owner
 * @param {object|null|undefined} party
 * @returns {number} ≥ 1
 */
function partyFollowSlot(owner, party) {
    if (!owner || !party || !Array.isArray(party.members)) return 1;
    let slot = 0;
    for (let i = 0; i < party.members.length; i++) {
        const m = party.members[i];
        if (!m || !m.alive || m.isLeader) continue;
        slot += 1;
        if (m === owner || (m.id != null && m.id === owner.id)) {
            return Math.max(1, slot);
        }
    }
    return 1;
}

/**
 * Raw A* goal for follow trail. v1 = leader tile only.
 *
 * Peaceful-WP (v1.1) plugs in here: when quiet + near + same-floor waypoint,
 * return party.waypoints[leader.currentWaypoint] instead of leader.tile.
 * Keep z same-floor as owner or fall back to leader.tile.
 *
 * @param {object} owner follower
 * @param {object|null|undefined} leader
 * @param {object|null|undefined} party
 * @returns {{ x: number, y: number, z: string|number }|null}
 */
function resolveFollowRawGoal(owner, leader, party) {
    void party; // reserved for peaceful-WP / waypoint index
    if (!leader || !leader.tile) return null;
    // --- peaceful-WP hook (v1.1) ---
    // if (Settings.AI_FOLLOW_PEACEFUL_WP && owner && leader && !owner.inBattle && !leader.inBattle) {
    //   const d = chebyshev(owner.tile, leader.tile);
    //   if (d <= 6 && party && party.waypoints && leader.currentWaypoint != null) {
    //     const wp = party.waypoints[leader.currentWaypoint];
    //     if (wp && String(wp.z) === String(leader.tile.z) && String(wp.z) === String(owner.tile.z)) {
    //       return { x: wp.x, y: wp.y, z: wp.z };
    //     }
    //   }
    // }
    return {
        x: Math.round(leader.tile.x),
        y: Math.round(leader.tile.y),
        z: leader.tile.z
    };
}

/**
 * Pick trail point on inclusive path (path[0]=start, path[end]=goal).
 * Slot 1 → one spacing step before end; slot 2 → two, etc. Short path falls
 * back to one before end (legacy path[len-2]).
 *
 * @param {{ x: number, y: number, z?: * }[]|null|undefined} path
 * @param {number} slot 1-based follower slot
 * @param {{ x: number, y: number, z?: * }} rawGoal
 * @param {number} [spacing=1]
 * @returns {{ x: number, y: number, z: string|number }}
 */
function pickTrailPoint(path, slot, rawGoal, spacing) {
    const z =
        rawGoal && rawGoal.z !== undefined && rawGoal.z !== null
            ? rawGoal.z
            : 0;
    if (!rawGoal) {
        return { x: 0, y: 0, z };
    }
    if (!path || path.length === 0) {
        return { x: rawGoal.x, y: rawGoal.y, z };
    }
    const endIdx = path.length - 1;
    const space = Math.max(1, Math.floor(Number(spacing) || 1));
    const s = Math.max(1, Math.floor(Number(slot) || 1));
    let idx = endIdx - s * space;
    if (idx < 0) {
        idx = endIdx >= 1 ? endIdx - 1 : endIdx;
    }
    const p = path[idx];
    if (!p) {
        return { x: rawGoal.x, y: rawGoal.y, z };
    }
    return {
        x: Math.round(p.x),
        y: Math.round(p.y),
        z
    };
}

/**
 * Chebyshev distance on same floor (Infinity if missing / different z).
 * @param {{ x: number, y: number, z?: * }|null|undefined} a
 * @param {{ x: number, y: number, z?: * }|null|undefined} b
 * @returns {number}
 */
function chebyshevTiles(a, b) {
    if (!a || !b) return Infinity;
    if (String(a.z) !== String(b.z)) return Infinity;
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/**
 * Resolve same-floor follow destination (trail slot or leader tile).
 *
 * @param {object} owner
 * @param {object|null|undefined} leader
 * @param {object|null|undefined} party
 * @param {import('../../entities/tilemap.js').TileMap|null|undefined} tileMap
 * @param {object} [opts]
 * @param {boolean} [opts.trailSlots] override Settings.AI_FOLLOW_TRAIL_SLOTS
 * @param {number} [opts.slotSpacing] override Settings.AI_FOLLOW_SLOT_SPACING
 * @param {number} [opts.maxLag] override Settings.AI_FOLLOW_MAX_LAG
 * @returns {{
 *   dest: { x: number, y: number, z: string|number }|null,
 *   rawGoal: { x: number, y: number, z: string|number }|null,
 *   slot: number,
 *   allowLongPath: boolean,
 *   trail: boolean,
 *   lagCatchUp: boolean
 * }}
 */
function resolveFollowTrailDest(owner, leader, party, tileMap, opts) {
    const o = opts || {};
    const rawGoal = resolveFollowRawGoal(owner, leader, party);
    const empty = {
        dest: null,
        rawGoal,
        slot: 1,
        allowLongPath: false,
        trail: false,
        lagCatchUp: false
    };
    if (!rawGoal || !owner || !owner.tile) return empty;

    // Cross-floor: caller must use stepTowardFloor — do not invent dest.
    if (String(owner.tile.z) !== String(rawGoal.z)) {
        return empty;
    }

    const trailOn =
        o.trailSlots !== undefined
            ? !!o.trailSlots
            : Settings.AI_FOLLOW_TRAIL_SLOTS !== false;
    const spacing =
        o.slotSpacing != null
            ? Number(o.slotSpacing)
            : Settings.AI_FOLLOW_SLOT_SPACING != null
              ? Number(Settings.AI_FOLLOW_SLOT_SPACING)
              : 1;
    const maxLag =
        o.maxLag != null
            ? Number(o.maxLag)
            : Settings.AI_FOLLOW_MAX_LAG != null
              ? Number(Settings.AI_FOLLOW_MAX_LAG)
              : 12;

    const dLeader = chebyshevTiles(owner.tile, leader && leader.tile);
    const lagCatchUp =
        Number.isFinite(maxLag) && maxLag > 0 && dLeader > maxLag;

    // Far catch-up or trail off: path to rawGoal (leader tile in v1).
    if (!trailOn || lagCatchUp) {
        return {
            dest: { x: rawGoal.x, y: rawGoal.y, z: rawGoal.z },
            rawGoal,
            slot: partyFollowSlot(owner, party),
            allowLongPath: lagCatchUp || !trailOn,
            trail: false,
            lagCatchUp
        };
    }

    const slot = partyFollowSlot(owner, party);
    let path = null;
    if (tileMap && typeof tileMap.search === 'function') {
        const localCap =
            Settings.PATH_MAX_DISTANCE != null
                ? Number(Settings.PATH_MAX_DISTANCE)
                : 100;
        path = tileMap.search(owner.tile, rawGoal, {
            allowDiagonal: true,
            useStackPolicy: true,
            mover: owner,
            maxDistance: localCap
        });
    }
    const dest = pickTrailPoint(path, slot, rawGoal, spacing);
    return {
        dest,
        rawGoal,
        slot,
        allowLongPath: false,
        trail: true,
        lagCatchUp: false
    };
}

module.exports = {
    partyFollowSlot,
    resolveFollowRawGoal,
    pickTrailPoint,
    chebyshevTiles,
    resolveFollowTrailDest
};
