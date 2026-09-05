/**
 * Party — roster + shared waypoints (soccer Team analogue).
 * Stage 3: ghost-walk; Stage 5: AI-driven hunt + minimal exp/loot counters.
 */

const { GameObject } = require('./gameobject.js');
const { tileDistance } = require('../lib/movement.js');
const { Settings } = require('../../settings.js');
const {
    partySharePerMember,
    applyPersonalExpRates,
    resolveExpSessionConfig,
    applyExpProgression,
    seedPlayerExperience
} = require('../lib/character/progression.js');

class Party extends GameObject {
    /**
     * @param {object} [opts]
     * @param {string} [opts.name]
     * @param {number|string} [opts.id]
     * @param {boolean} [opts.enabled]
     * @param {{ x: number, y: number, z?: string|number }[]} [opts.waypoints]
     * @param {boolean} [opts.loopWaypoints] When true, restart at wp 0 after last
     *   (arena patrol). Route never completes while looping.
     * @param {{ from: {x,y,z}, to: {x,y,z} }[]} [opts.stairLinks] Stage 11.8 multi-floor
     */
    constructor(opts = {}) {
        super(opts.name || 'Party');
        this.id = opts.id != null ? opts.id : this.name;
        this.enabled = opts.enabled !== false;
        /** @type {import('./player.js').Player[]} */
        this.members = [];
        /** @type {{ x: number, y: number, z: string|number }[]} */
        this.waypoints = normalizeWaypoints(opts.waypoints || []);
        /**
         * Arena / patrol: wrap waypoint index instead of marking route complete.
         * Lets hunts author one lap instead of repeating the path many times.
         * @type {boolean}
         */
        this.loopWaypoints = !!opts.loopWaypoints;
        /**
         * Stage 11.8: stair pads that teleport between floors when arrived.
         * @type {{ from: {x:number,y:number,z:string|number}, to: {x:number,y:number,z:string|number} }[]}
         */
        this.stairLinks = Array.isArray(opts.stairLinks)
            ? opts.stairLinks.map((L) => ({
                  from: {
                      x: Math.round(L.from.x),
                      y: Math.round(L.from.y),
                      z: L.from.z
                  },
                  to: {
                      x: Math.round(L.to.x),
                      y: Math.round(L.to.y),
                      z: L.to.z
                  }
              }))
            : [];
        this.routeComplete = false;
        /** Party-wide hunt counters */
        /** Sum of awarded exp (after personal rates) to members. */
        this.expGained = 0;
        /**
         * Sum of per-member raw exp (party share only; before prey/stamina/…).
         * @type {number}
         */
        this.rawExpGained = 0;
        this.lootGained = 0;
        this.kills = 0;
        this.deaths = 0;
        this.damageDealt = 0;
        this.damageTaken = 0;
        /** Levels gained while expProgression was on. */
        this.levelUps = 0;
        /** Phase D: sum of member skill tries (optional rollup). */
        this.skillTriesGained = 0;
        this.skillLevelsGained = 0;
        this.magicLevelsGained = 0;
        this.manaSpentTowardMagic = 0;
    }

    /**
     * @param {import('./player.js').Player} player
     */
    addMember(player) {
        if (!player) return;
        this.members.push(player);
        player.party = this;
        this.insertChild(player);
    }

    /**
     * Living members (hp > 0).
     * @returns {import('./player.js').Player[]}
     */
    livingMembers() {
        const out = [];
        for (let i = 0; i < this.members.length; i++) {
            const m = this.members[i];
            if (m && m.alive && m.hp && m.hp.current > 0) out.push(m);
        }
        return out;
    }

    /**
     * True when every member is dead (or roster empty).
     * @returns {boolean}
     */
    isWiped() {
        if (!this.members.length) return true;
        return this.livingMembers().length === 0;
    }

    /**
     * Award kill exp to living members (Phase C).
     *
     * Pipeline:
     *   monsterExp → party share (raw per member) → personal rates (awarded)
     *   → always credit expGained / rawExpGained counters
     *   → if expProgression: credit player.experience + level-ups
     *
     * Raw = party composition share only (before prey/stamina/baseRate/…).
     *
     * @param {number} exp monster experience value
     * @param {number} [loot=0]
     * @param {{
     *   expConfig?: object,
     *   sessionConfig?: object,
     *   expProgression?: boolean,
     *   expRates?: object,
     *   partyShareEnabled?: boolean
     * }} [opts]
     * @returns {{
     *   monsterExp: number,
     *   personalRaw: number,
     *   shareMul: number,
     *   rawTotal: number,
     *   awardedTotal: number,
     *   levelUps: number,
     *   partySize: number,
     *   uniqueVocations: number
     * }}
     */
    awardKill(exp, loot, opts) {
        const monsterExp = Math.max(0, Number(exp) || 0);
        const l = Math.max(0, Number(loot) || 0);
        this.kills += 1;
        this.lootGained += l;

        const living = this.livingMembers();
        const empty = {
            monsterExp,
            personalRaw: 0,
            shareMul: 1,
            rawTotal: 0,
            awardedTotal: 0,
            levelUps: 0,
            partySize: living.length,
            uniqueVocations: 1
        };
        if (!living.length || monsterExp <= 0) return empty;

        // opts: frozen session bag, { sessionConfig }, or partial overrides
        const cfg = resolveExpSessionConfig(opts || {});

        const share = partySharePerMember(monsterExp, {
            members: living,
            partySize: living.length,
            partyShareEnabled: cfg.partyShareEnabled
        });
        const personalRaw = share.personalRaw;
        let rawTotal = 0;
        let awardedTotal = 0;
        let levelUps = 0;

        for (let i = 0; i < living.length; i++) {
            const m = living[i];
            const awarded = applyPersonalExpRates(personalRaw, cfg.expRates);
            m.rawExpGained = (m.rawExpGained || 0) + personalRaw;
            m.expGained = (m.expGained || 0) + awarded;
            m.kills = (m.kills || 0) + 1;
            rawTotal += personalRaw;
            awardedTotal += awarded;

            if (cfg.expProgression) {
                seedPlayerExperience(m);
                const prog = applyExpProgression(m, awarded);
                levelUps += prog.levelUps || 0;
                m.levelUps = (m.levelUps || 0) + (prog.levelUps || 0);
            }
        }

        this.rawExpGained = (this.rawExpGained || 0) + rawTotal;
        this.expGained = (this.expGained || 0) + awardedTotal;
        this.levelUps = (this.levelUps || 0) + levelUps;

        return {
            monsterExp,
            personalRaw,
            shareMul: share.shareMul,
            rawTotal,
            awardedTotal,
            levelUps,
            partySize: share.partySize,
            uniqueVocations: share.uniqueVocations
        };
    }

    /**
     * @returns {import('./player.js').Player|null}
     */
    getLeader() {
        for (let i = 0; i < this.members.length; i++) {
            if (this.members[i].isLeader) return this.members[i];
        }
        return this.members[0] || null;
    }

    /**
     * Whether a living member is under player control.
     * Manual play must not trip `route_complete` (logic freeze).
     * @returns {boolean}
     */
    hasLivingManualControl() {
        for (let i = 0; i < this.members.length; i++) {
            const m = this.members[i];
            if (m && m.alive && m.controlMode === 'manual') return true;
        }
        return false;
    }

    /**
     * Whether every living member finished the waypoint list.
     * Looping parties never complete (patrol continues until session ends).
     * A living `controlMode: 'manual'` member also blocks completion.
     * @returns {boolean}
     */
    allRoutesComplete() {
        if (this.loopWaypoints) return false;
        if (this.hasLivingManualControl()) return false;
        if (!this.members.length) return true;
        for (let i = 0; i < this.members.length; i++) {
            const m = this.members[i];
            if (m.alive && !m.routeComplete) return false;
        }
        return true;
    }

    /**
     * Hunt AI: mark followers near a finished leader as route-complete.
     * Same-tile stack is legal; d ≤ 3 still finishes lagging members.
     * Manual members are skipped — they are not on the AI route.
     * Call from combat session only — not ghost-walk.
     */
    syncFollowerRouteComplete() {
        const leader = this.getLeader();
        if (!leader || !leader.routeComplete || !leader.tile) return;
        for (let i = 0; i < this.members.length; i++) {
            const m = this.members[i];
            if (!m || !m.alive || m.isLeader || m.routeComplete) continue;
            if (m.controlMode === 'manual') continue;
            if (!m.tile || String(m.tile.z) !== String(leader.tile.z)) continue;
            if (tileDistance(m.tile, leader.tile) <= 3) {
                m.routeComplete = true;
                m.currentWaypoint = this.waypoints.length;
                m.path = [];
            }
        }
        this.routeComplete = this.allRoutesComplete();
    }

    /**
     * Advance members one step toward their current waypoint (when moveDelay allows).
     * Must run after Creature.update has ticked delays for this frame, or tick here
     * if members are not in the scene-graph yet — prefer members as children.
     *
     * @param {import('./tilemap.js').TileMap} tileMap
     * @param {{ onStep?: (member: import('./player.js').Player, from: object, to: object) => void }} [hooks]
     */
    tickMovement(tileMap, hooks) {
        if (!this.enabled || !tileMap) return;
        if (!this.waypoints.length) {
            if (!this.loopWaypoints) {
                this.routeComplete = true;
                for (const m of this.members) m.routeComplete = true;
            }
            return;
        }

        for (let i = 0; i < this.members.length; i++) {
            const member = this.members[i];
            if (!member.alive || member.routeComplete) continue;
            // Delay is ticked in Creature.update via scene graph; only step when ready
            if (!member.canStep()) continue;
            if (!member.tile) continue;

            this.stepMember(tileMap, member, hooks);
        }

        this.routeComplete = this.allRoutesComplete();
    }

    /**
     * Public: advance one member one step toward current waypoint (used by AI).
     * @param {import('./tilemap.js').TileMap} tileMap
     * @param {import('./player.js').Player} member
     * @param {{ onStep?: Function }} [hooks]
     */
    stepMember(tileMap, member, hooks) {
        this._stepMember(tileMap, member, hooks);
    }

    /**
     * Cross-floor catch-up for followers: hop if already on a stair pad that
     * leads to `targetZ`, otherwise walk toward the nearest such pad.
     * Same-floor requests are no-ops (caller uses followPath / followLongPath).
     *
     * @param {import('./tilemap.js').TileMap} tileMap
     * @param {import('./player.js').Player} member
     * @param {string|number} targetZ
     * @param {{
     *   preferNear?: { x: number, y: number, z?: string|number },
     *   hooks?: { onStep?: Function }
     * }} [opts]
     * @returns {boolean} true when a hop or pad-approach step was taken
     */
    stepTowardFloor(tileMap, member, targetZ, opts) {
        if (!tileMap || !member || !member.tile || targetZ == null) return false;
        if (String(member.tile.z) === String(targetZ)) return false;

        const prefer =
            opts && opts.preferNear
                ? opts.preferNear
                : { x: member.tile.x, y: member.tile.y };
        const target = {
            x: prefer.x != null ? Math.round(prefer.x) : member.tile.x,
            y: prefer.y != null ? Math.round(prefer.y) : member.tile.y,
            z: targetZ
        };
        const from = {
            x: member.tile.x,
            y: member.tile.y,
            z: member.tile.z
        };
        const hooks = opts && opts.hooks;

        if (this._tryStairHop(tileMap, member, target)) {
            if (typeof member.syncPositionFromTile === 'function') {
                member.syncPositionFromTile();
            }
            this._emitStep(hooks, member, from);
            return true;
        }
        if (this._approachStairPad(tileMap, member, target)) {
            if (typeof member.syncPositionFromTile === 'function') {
                member.syncPositionFromTile();
            }
            this._emitStep(hooks, member, from);
            return true;
        }
        return false;
    }

    /**
     * @param {import('./tilemap.js').TileMap} tileMap
     * @param {import('./player.js').Player} member
     * @param {{ onStep?: Function }} [hooks]
     * @private
     */
    _stepMember(tileMap, member, hooks) {
        // Clamp / finish if past end (loop wraps instead of completing)
        if (member.currentWaypoint >= this.waypoints.length) {
            if (this.loopWaypoints && this.waypoints.length) {
                member.currentWaypoint = 0;
                member.path = [];
                member.routeComplete = false;
            } else {
                member.routeComplete = true;
                member.path = [];
                return;
            }
        }

        let guard = 0;
        let wrappedThisStep = false;
        while (
            !wrappedThisStep &&
            member.currentWaypoint < this.waypoints.length &&
            this._hasArrived(tileMap, member, this.waypoints[member.currentWaypoint]) &&
            guard < this.waypoints.length + 2
        ) {
            member.currentWaypoint += 1;
            member.path = [];
            guard += 1;
            if (member.currentWaypoint >= this.waypoints.length) {
                if (this.loopWaypoints && this.waypoints.length) {
                    // Wrap once per step so standing on a closed-loop first
                    // tile (last === first) does not infinite-advance.
                    member.currentWaypoint = 0;
                    member.path = [];
                    member.routeComplete = false;
                    wrappedThisStep = true;
                } else {
                    member.routeComplete = true;
                    return;
                }
            }
        }

        if (member.currentWaypoint >= this.waypoints.length) {
            if (this.loopWaypoints && this.waypoints.length) {
                member.currentWaypoint = 0;
                member.path = [];
                member.routeComplete = false;
            } else {
                member.routeComplete = true;
                return;
            }
        }

        const wp = this.waypoints[member.currentWaypoint];
        const from = { x: member.tile.x, y: member.tile.y, z: member.tile.z };

        // Stage 11.8 / 12H: stair hop when next waypoint is on another floor
        if (String(member.tile.z) !== String(wp.z)) {
            if (this._tryStairHop(tileMap, member, wp)) {
                member.syncPositionFromTile();
                this._emitStep(hooks, member, from);
                return;
            }
            // Walk toward a stair pad on this floor that leads to the WP floor
            if (this._approachStairPad(tileMap, member, wp)) {
                member.syncPositionFromTile();
                this._emitStep(hooks, member, from);
                return;
            }
            // No valid stair — cannot path across floors with local A*
            return;
        }

        tileMap.followPath(member, wp.x, wp.y, wp.z);
        this._emitStep(hooks, member, from);
    }

    /**
     * @param {object|null|undefined} hooks
     * @param {import('./player.js').Player} member
     * @param {{ x: number, y: number, z: string|number }} from
     * @private
     */
    _emitStep(hooks, member, from) {
        if (
            hooks &&
            typeof hooks.onStep === 'function' &&
            (member.tile.x !== from.x ||
                member.tile.y !== from.y ||
                String(member.tile.z) !== String(from.z))
        ) {
            hooks.onStep(member, from, {
                x: member.tile.x,
                y: member.tile.y,
                z: member.tile.z
            });
        }
    }

    /**
     * Stage 12H: path to the nearest first-class (or party-link) stair pad
     * on the current floor that leads toward the waypoint floor.
     *
     * @param {import('./tilemap.js').TileMap} tileMap
     * @param {import('./player.js').Player} member
     * @param {{ x: number, y: number, z: string|number }} wp
     * @returns {boolean} true when a step toward a pad was taken
     * @private
     */
    _approachStairPad(tileMap, member, wp) {
        if (!member.tile || !wp || !tileMap) return false;

        let pad = null;
        if (typeof tileMap.findStairToward === 'function') {
            pad = tileMap.findStairToward(
                member.tile.z,
                wp.z,
                member.tile.x,
                member.tile.y
            );
        }

        // Fall back to party.stairLinks pads on this floor → wp floor
        if (!pad && this.stairLinks && this.stairLinks.length) {
            let bestD = Infinity;
            for (let i = 0; i < this.stairLinks.length; i++) {
                const L = this.stairLinks[i];
                if (!L || !L.from || !L.to) continue;
                const candidates = [
                    { from: L.from, to: L.to },
                    { from: L.to, to: L.from }
                ];
                for (let c = 0; c < candidates.length; c++) {
                    const row = candidates[c];
                    if (String(row.from.z) !== String(member.tile.z)) continue;
                    if (String(row.to.z) !== String(wp.z)) continue;
                    const d =
                        Math.abs(row.from.x - member.tile.x) +
                        Math.abs(row.from.y - member.tile.y);
                    if (d < bestD) {
                        bestD = d;
                        pad = {
                            x: row.from.x,
                            y: row.from.y,
                            z: row.from.z
                        };
                    }
                }
            }
        }

        if (!pad) return false;
        if (
            member.tile.x === pad.x &&
            member.tile.y === pad.y &&
            String(member.tile.z) === String(pad.z)
        ) {
            return false;
        }
        // Prefer long path when the pad is beyond local A* budget (P2).
        const cheb = Math.max(
            Math.abs(pad.x - member.tile.x),
            Math.abs(pad.y - member.tile.y)
        );
        const localCap =
            Settings && Settings.PATH_MAX_DISTANCE != null
                ? Number(Settings.PATH_MAX_DISTANCE)
                : 100;
        if (
            cheb > localCap &&
            typeof tileMap.followLongPath === 'function'
        ) {
            tileMap.followLongPath(member, pad.x, pad.y, pad.z, {
                enforceRequestCap: false,
                useNavmeshBeyondCap: true
            });
        } else {
            tileMap.followPath(member, pad.x, pad.y, pad.z);
        }
        return true;
    }

    /**
     * Stage 11.8 / 12H: transfer entity across floors when standing on a stair
     * pad that links toward the target waypoint. Prefers TileMap first-class
     * stairs; falls back to party.stairLinks; free hop when neither is set.
     *
     * @param {import('./tilemap.js').TileMap} tileMap
     * @param {import('./player.js').Player} member
     * @param {{ x: number, y: number, z: string|number }} wp
     * @returns {boolean}
     * @private
     */
    _tryStairHop(tileMap, member, wp) {
        if (!member.tile || !wp || !tileMap) return false;

        // Stage 12H: first-class stair tiles on the map
        if (typeof tileMap.tryUseStair === 'function') {
            if (tileMap.tryUseStair(member, wp)) return true;
        }

        const links = this.stairLinks || [];
        if (links.length) {
            for (let i = 0; i < links.length; i++) {
                const L = links[i];
                if (!L || !L.from || !L.to) continue;
                const onPad =
                    member.tile.x === L.from.x &&
                    member.tile.y === L.from.y &&
                    String(member.tile.z) === String(L.from.z);
                const toTarget =
                    L.to.x === wp.x &&
                    L.to.y === wp.y &&
                    String(L.to.z) === String(wp.z);
                // Also allow reverse links (up then later down)
                const onPadRev =
                    member.tile.x === L.to.x &&
                    member.tile.y === L.to.y &&
                    String(member.tile.z) === String(L.to.z);
                const toTargetRev =
                    L.from.x === wp.x &&
                    L.from.y === wp.y &&
                    String(L.from.z) === String(wp.z);
                // Hop when on pad and destination floor matches next WP
                // (exact pad target or any WP on that floor after landing)
                const destFloorOk =
                    onPad && String(L.to.z) === String(wp.z);
                const destFloorOkRev =
                    onPadRev && String(L.from.z) === String(wp.z);
                if (onPad && (toTarget || destFloorOk)) {
                    return !!tileMap.moveEntityToTile(
                        member,
                        L.to.x,
                        L.to.y,
                        L.to.z
                    );
                }
                if (onPadRev && (toTargetRev || destFloorOkRev)) {
                    return !!tileMap.moveEntityToTile(
                        member,
                        L.from.x,
                        L.from.y,
                        L.from.z
                    );
                }
            }
            return false;
        }
        // No map stairs or party links: free hop for authored multi-z waypoints
        return !!tileMap.moveEntityToTile(member, wp.x, wp.y, wp.z);
    }

    /**
     * Exact tile match, or adjacent when the waypoint tile cannot be entered
     * (creature / full stack / noPlayerStack). Player–player stack is legal,
     * so an ally on the WP is not treated as “arrived early.”
     *
     * @param {import('./tilemap.js').TileMap} tileMap
     * @param {import('./player.js').Player} member
     * @param {{ x: number, y: number, z: string|number }} wp
     * @returns {boolean}
     * @private
     */
    _hasArrived(tileMap, member, wp) {
        if (!member.tile || !wp) return false;
        if (String(member.tile.z) !== String(wp.z)) return false;
        if (member.tile.x === wp.x && member.tile.y === wp.y) return true;

        // Blocked WP (creature, max stack, etc.): adjacent counts as arrived.
        if (
            typeof tileMap.canEnter === 'function' &&
            !tileMap.canEnter(wp.x, wp.y, wp.z, member)
        ) {
            return tileDistance(member.tile, wp) <= 1;
        }
        return false;
    }
}

/**
 * @param {{ x: number, y: number, z?: string|number }[]} list
 * @returns {{ x: number, y: number, z: string|number }[]}
 */
function normalizeWaypoints(list) {
    const out = [];
    for (let i = 0; i < list.length; i++) {
        const w = list[i];
        if (!w) continue;
        out.push({
            x: Math.round(w.x),
            y: Math.round(w.y),
            z: w.z !== undefined ? w.z : 0
        });
    }
    return out;
}

module.exports = { Party, normalizeWaypoints };
