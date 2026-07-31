/**
 * Player hunt AI states (Stage 5).
 * FollowWaypoint, FollowLeader, Engage, Reposition, Flee, ReturnToRoute.
 */

const {
    entitiesWithinRange,
    queryWithinRange,
    findNearest,
    isValidTarget,
    distBetween
} = require('./targeting.js');
const {
    hpPercent,
    pickSpellId
} = require('./strategy.js');
const {
    getSpell,
    canCast,
    isSpellInRange,
    tryAttack,
    tryAutoAttack,
    tryHeal,
    stepToward,
    repositionTile,
    pickCombatMoveTile,
    pickMeleeMoveTile,
    fleeTile,
    resolveAutoAttackId,
    resolveSpellRange,
    hasAmmo
} = require('./combat_actions.js');
const { Time } = require('../time.js');
const {
    applyThinkPad,
    evaluateEngageWant,
    targetDistancePolicy,
    softRetargetDue
} = require('./cadence.js');
const { hasLineOfSight } = require('../shapes.js');

/**
 * @typedef {object} HuntCtx
 * @property {import('../../entities/tilemap.js').TileMap} tileMap
 * @property {object} sim Simulator
 * @property {object[]} enemies Living hostile creatures
 * @property {object[]} allies Living party members
 * @property {Record<string, object>} spellBook
 * @property {() => number} [rng]
 * @property {object} [hooks]
 */

function getStrategy(owner) {
    return owner.strategy || {
        aggression: 0.75,
        engageRange: 7,
        keepDistance: 1,
        fleeHpPercent: 0.15,
        monstersToEngage: 1,
        returnToRoute: true,
        spellPriority: []
    };
}

/**
 * Hostiles in engage range of this player.
 * Etapa 4: prefer per-origin SpatialIndex query when ctx.creatureIndex is set
 * (avoids scanning the full multi-bubble enemy union for sparse parties).
 * Falls back to linear refine of ctx.enemies.
 *
 * @param {object} owner
 * @param {HuntCtx} ctx
 * @returns {object[]}
 */
function nearbyEnemies(owner, ctx) {
    const st = getStrategy(owner);
    const range = st.engageRange;
    const c = ctx || {};
    let near;
    if (c.creatureIndex) {
        near = queryWithinRange(owner, range, {
            index: c.creatureIndex,
            excludeSelf: true
        });
    } else {
        near = entitiesWithinRange(owner, c.enemies || [], range);
    }
    // Require Line of Sight to avoid aggro across solid dungeon walls
    if (c.tileMap && owner && owner.tile && near && near.length > 0) {
        near = near.filter((e) => {
            if (!e || !e.tile) return false;
            return hasLineOfSight(
                owner.tile.x,
                owner.tile.y,
                owner.tile.z,
                e.tile.x,
                e.tile.y,
                e.tile.z,
                c.tileMap
            );
        });
    }
    if (owner) {
        owner.hasMonstersInEngage = near && near.length > 0;
    }
    return near;
}

function clearCombat(owner) {
    owner.targetId = null;
    owner.target = null;
    owner.inBattle = false;
    owner.hasMonstersInEngage = false;
    owner.battleWP = null;
    owner.standingCounter = 0;
}

/**
 * Clear sticky target only (keep battleWP / inBattle for re-pick).
 * @param {object} owner
 */
function clearTargetOnly(owner) {
    owner.targetId = null;
    owner.target = null;
}

function setTarget(owner, enemy) {
    if (!enemy) {
        clearCombat(owner);
        return;
    }
    owner.targetId = enemy.id;
    owner.target = enemy;
    owner.inBattle = true;
    // Soft anchor for combat footing (legacy battleWP) — set once per fight
    if (!owner.battleWP && owner.tile) {
        owner.battleWP = {
            x: owner.tile.x,
            y: owner.tile.y,
            z: owner.tile.z
        };
    }
}

/**
 * Track whether a step was taken this tick for anti-still bias.
 * @param {object} owner
 * @param {boolean} moved
 */
function noteCombatStanding(owner, moved) {
    if (moved) {
        owner.standingCounter = 0;
        return;
    }
    const dt =
        Time && typeof Time.deltaTime === 'number' && Time.deltaTime > 0
            ? Time.deltaTime
            : 0.05;
    owner.standingCounter = (owner.standingCounter || 0) + dt;
}

/**
 * Combat movement pass (legacy: attack and move are independent).
 * Melee (keepDistance ≤ 1): path to free adjacent of target + micro-pack.
 * Ranged/kite (keepDistance > 1): continuous tile scoring every tick.
 *
 * @param {object} owner
 * @param {object} target
 * @param {object} st strategy
 * @param {HuntCtx} ctx
 * @returns {boolean} true if a step was taken
 */
function combatMove(owner, target, st, ctx) {
    if (!owner || !target || !ctx || !ctx.tileMap) return false;
    if (!owner.canStep || !owner.canStep()) return false;

    const keep = st && st.keepDistance != null ? st.keepDistance : 1;
    let dest = null;
    if (keep > 1) {
        dest = pickCombatMoveTile(
            owner,
            target,
            {
                keepDistance: keep,
                standingCounter: owner.standingCounter || 0,
                battleWP: owner.battleWP || null
            },
            ctx.tileMap
        );
    } else {
        dest = pickMeleeMoveTile(owner, target, ctx.tileMap);
    }
    if (!dest) return false;
    if (
        dest.x === owner.tile.x &&
        dest.y === owner.tile.y &&
        String(dest.z) === String(owner.tile.z)
    ) {
        return false;
    }
    return stepToward(owner, dest, ctx.tileMap);
}

function resolveTarget(owner, ctx) {
    let sticky = null;
    if (owner.target && isValidTarget(owner, owner.target)) {
        sticky = owner.target;
    } else if (owner.targetId != null && ctx.sim && ctx.sim.getEntityById) {
        const t = ctx.sim.getEntityById(owner.targetId);
        if (isValidTarget(owner, t)) {
            owner.target = t;
            sticky = t;
        }
    }

    if (sticky) {
        const policy = targetDistancePolicy(owner, sticky);
        if (policy === 'hold') return sticky;
        // Soft retarget only: throttle expensive findNearest when many hostiles.
        // Lose always re-scans immediately (target is no longer usable).
        if (policy === 'retarget' && !softRetargetDue(owner)) {
            return sticky;
        }
        // lose / retarget due / invalid → drop sticky and re-pick nearest
        clearTargetOnly(owner);
    }

    const near = nearbyEnemies(owner, ctx);
    const nearest = findNearest(owner, near);
    if (nearest) setTarget(owner, nearest);
    else clearCombat(owner);
    return owner.target;
}

function changePlayerState(owner, next) {
    if (!owner.brain) return;
    owner.brain.changeState(next);
    owner.aiState = owner.brain.getNameOfCurrentState();
}

function maybeStartCombat(owner, ctx) {
    const st = getStrategy(owner);
    const near = nearbyEnemies(owner, ctx);
    if (
        !evaluateEngageWant(
            owner,
            near.length,
            st,
            ctx.rng || Math.random
        )
    ) {
        return false;
    }
    const nearest = findNearest(owner, near);
    if (!nearest) return false;
    setTarget(owner, nearest);
    changePlayerState(owner, Engage);
    return true;
}

/**
 * Cast self-heal when below healHpPercent (before flee / engage actions).
 * Returns true when a heal was cast this tick (caller should stop).
 * @param {object} owner
 * @param {HuntCtx} ctx
 * @returns {boolean}
 */
function maybeHeal(owner, ctx) {
    const st = getStrategy(owner);
    const result = tryHeal({
        attacker: owner,
        strategy: st,
        ctx
    });
    return !!(result && result.ok && result.hit);
}

function maybeFlee(owner, ctx) {
    const st = getStrategy(owner);
    if (hpPercent(owner) > st.fleeHpPercent) return false;
    const threat =
        (owner.target && isValidTarget(owner, owner.target) && owner.target) ||
        findNearest(owner, nearbyEnemies(owner, ctx));
    owner._fleeThreat = threat;
    changePlayerState(owner, Flee);
    return true;
}

/** Shared waypoint step via party. */
function stepWaypoint(owner, ctx) {
    const party = owner.party || (ctx.sim && ctx.sim.findPartyOf(owner));
    if (!party || !ctx.tileMap) return;
    if (typeof party.stepMember === 'function') {
        party.stepMember(ctx.tileMap, owner, ctx.hooks);
    }
}

/**
 * True while TileMap ally-pass hold is active (leader just passed us).
 * @param {object} owner
 * @returns {boolean}
 */
function isAllyPassHoldActive(owner) {
    if (!owner || owner._allyPassHoldUntil == null) return false;
    const now =
        Time && Time.timeSinceLevelLoad != null
            ? Number(Time.timeSinceLevelLoad)
            : 0;
    return now < Number(owner._allyPassHoldUntil);
}

// ── States ──────────────────────────────────────────────────────────

const FollowWaypoint = {
    id: 'follow_waypoint',
    enter(owner) {
        owner.inBattle = false;
    },
    execute(owner, ctx) {
        if (!owner.alive) return;
        if (maybeHeal(owner, ctx)) return;
        if (maybeFlee(owner, ctx)) return;
        if (maybeStartCombat(owner, ctx)) return;
        if (owner.routeComplete) {
            changePlayerState(owner, ReturnToRoute);
            return;
        }
        stepWaypoint(owner, ctx);
    },
    exit() {}
};

const FollowLeader = {
    id: 'follow_leader',
    enter(owner) {
        owner.inBattle = false;
    },
    execute(owner, ctx) {
        if (!owner.alive) return;
        if (maybeHeal(owner, ctx)) return;
        if (maybeFlee(owner, ctx)) return;

        const party = owner.party || (ctx.sim && ctx.sim.findPartyOf(owner));
        const leader = party && party.getLeader ? party.getLeader() : null;

        // Engage only when leader is fighting or pack is dense
        const near = nearbyEnemies(owner, ctx);
        const leaderFighting = leader && leader.inBattle;
        if (
            (leaderFighting || near.length >= getStrategy(owner).monstersToEngage) &&
            near.length > 0
        ) {
            if (maybeStartCombat(owner, ctx)) return;
        }

        // After the leader swaps/yields past us, stand still briefly so we do
        // not re-clog the corridor on the next free tick (TileMap ally-pass hold).
        if (isAllyPassHoldActive(owner)) {
            return;
        }

        // Cross-floor: local A* cannot climb. Walk to stair pad → hop toward
        // leader floor (Party.stepTowardFloor). Keep WP index from lagging so
        // after landing we rejoin the route near the leader.
        if (
            leader &&
            leader.tile &&
            owner.tile &&
            ctx.tileMap &&
            String(owner.tile.z) !== String(leader.tile.z)
        ) {
            if (leader.currentWaypoint != null && party) {
                owner.currentWaypoint = Math.max(
                    owner.currentWaypoint || 0,
                    Math.min(
                        leader.currentWaypoint,
                        (party.waypoints || []).length
                    )
                );
            }
            if (party && typeof party.stepTowardFloor === 'function') {
                party.stepTowardFloor(ctx.tileMap, owner, leader.tile.z, {
                    preferNear: leader.tile,
                    hooks: ctx.hooks
                });
            }
            return;
        }

        // Leader finished route and follower is nearby (same floor) → complete
        // (v1 occupancy forbids stacking on the leader tile). Cross-floor is
        // handled above so a finished leader still draws followers upstairs.
        if (leader && leader.routeComplete) {
            const d = leader.tile ? distBetween(owner, leader) : Infinity;
            if (d <= 3) {
                owner.routeComplete = true;
                if (party && party.waypoints) {
                    owner.currentWaypoint = party.waypoints.length;
                }
                owner.path = [];
                return;
            }
        }

        // Same-floor path toward leader; prefer free adjacent (no stack).
        // Far catch-up may use navmesh long path (stepToward allowLongPath).
        // followPath ally-pass swaps past other followers; followers never swap
        // the leader off their tile (TileMap._tryAllyPass).
        if (leader && leader.tile && ctx.tileMap) {
            const d = distBetween(owner, leader);
            if (d > 1) {
                const dest =
                    freeAdjacentTo(leader, owner, ctx.tileMap) || leader.tile;
                stepToward(owner, dest, ctx.tileMap, { allowLongPath: true });
                return;
            }
        }

        // Catch up waypoints when already adjacent to leader
        if (!owner.routeComplete) {
            if (leader && leader.currentWaypoint != null) {
                // Keep follower index from lagging forever behind a finished leader path
                owner.currentWaypoint = Math.max(
                    owner.currentWaypoint || 0,
                    Math.min(leader.currentWaypoint, (party.waypoints || []).length)
                );
            }
            stepWaypoint(owner, ctx);
        }
    },
    exit() {}
};

/**
 * Pick a free tile adjacent to leader for follower pathing (v1: no stacking).
 * @param {object} leader
 * @param {object} follower
 * @param {object} tileMap
 * @returns {{ x: number, y: number, z: string|number }|null}
 */
function freeAdjacentTo(leader, follower, tileMap) {
    if (!leader || !leader.tile || !tileMap) return null;
    const z = leader.tile.z;
    let best = null;
    let bestD = Infinity;
    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = leader.tile.x + dx;
            const ny = leader.tile.y + dy;
            if (!tileMap.canEnter(nx, ny, z, follower)) continue;
            if (!follower.tile) {
                best = { x: nx, y: ny, z };
                continue;
            }
            const d = Math.max(
                Math.abs(nx - follower.tile.x),
                Math.abs(ny - follower.tile.y)
            );
            if (d < bestD) {
                bestD = d;
                best = { x: nx, y: ny, z };
            }
        }
    }
    return best;
}

const Engage = {
    id: 'engage',
    enter(owner) {
        owner.inBattle = true;
        owner.standingCounter = owner.standingCounter || 0;
        // Anchor battleWP on first enter if not set by setTarget
        if (!owner.battleWP && owner.tile) {
            owner.battleWP = {
                x: owner.tile.x,
                y: owner.tile.y,
                z: owner.tile.z
            };
        }
    },
    execute(owner, ctx) {
        if (!owner.alive) return;
        if (maybeHeal(owner, ctx)) return;
        if (maybeFlee(owner, ctx)) return;

        const target = resolveTarget(owner, ctx);
        if (!target) {
            clearCombat(owner);
            changePlayerState(
                owner,
                owner.isLeader ? ReturnToRoute : FollowLeader
            );
            return;
        }

        const st = getStrategy(owner);

        // ── Action pass ────────────────────────────────────────────────────
        // Order: strategy spells → movement → weapon auto (mode feature).
        // A spell or step that sets moveDelay/moveLock wins the frame; auto
        // only fires when still free (own auto.attack CD + range/ammo/mana).
        let holdForAttack = false;

        // canReach skips out-of-range / empty self-AoE so lower priority fires.
        // canCast gets hunt ctx so runeConsumption / inventory gates apply.
        const spellId = pickSpellId(
            st,
            owner,
            (id) => getSpell(id, ctx),
            (attacker, spell) => canCast(attacker, spell, ctx),
            {
                canReach: (attacker, spell) =>
                    isSpellInRange(attacker, target, spell, ctx)
            }
        );
        if (spellId) {
            tryAttack({
                attacker: owner,
                defender: target,
                spellId,
                ctx
            });
            holdForAttack = true;
        }
        // Pad primary GCD only when ready (no-op after a successful strike).
        applyThinkPad(owner);

        // Target died this tick — retarget or leave combat
        if (!isValidTarget(owner, target)) {
            clearCombat(owner);
            const near = nearbyEnemies(owner, ctx);
            if (
                near.length &&
                evaluateEngageWant(
                    owner,
                    near.length,
                    st,
                    ctx.rng || Math.random
                )
            ) {
                setTarget(owner, findNearest(owner, near));
            } else {
                changePlayerState(
                    owner,
                    owner.isLeader ? ReturnToRoute : FollowLeader
                );
            }
            return;
        }

        const moveTarget = owner.target && isValidTarget(owner, owner.target)
            ? owner.target
            : target;

        // Check if auto attack is ready and we are in range
        if (!holdForAttack && owner.canStep && owner.canStep()) {
            const autoId = resolveAutoAttackId(owner);
            const autoSpell = getSpell(autoId, ctx);
            if (
                autoSpell &&
                canCast(owner, autoSpell, ctx) &&
                hasAmmo(owner, autoSpell, ctx)
            ) {
                const autoRange = resolveSpellRange(owner, autoSpell);
                const dAuto = distBetween(owner, moveTarget);
                if (dAuto <= autoRange) {
                    holdForAttack = true;
                }
            }
        }

        // Movement before auto so a step this frame plants and blocks auto.
        let moved = false;
        if (!holdForAttack) {
            moved = combatMove(owner, moveTarget, st, ctx);
        }
        noteCombatStanding(owner, moved);

        // Mode-gated weapon auto (melee / distance / wand from equipment).
        if (isValidTarget(owner, moveTarget)) {
            tryAutoAttack({
                attacker: owner,
                defender: moveTarget,
                ctx
            });
        }
    },
    exit() {}
};

/**
 * Reposition kept for FSM compatibility; continuous kite now lives in Engage.
 * Still steps away when too close, then returns to Engage.
 */
const Reposition = {
    id: 'reposition',
    enter() {},
    execute(owner, ctx) {
        if (!owner.alive) return;
        if (maybeHeal(owner, ctx)) return;
        if (maybeFlee(owner, ctx)) return;

        const target = resolveTarget(owner, ctx);
        if (!target) {
            clearCombat(owner);
            changePlayerState(
                owner,
                owner.isLeader ? ReturnToRoute : FollowLeader
            );
            return;
        }

        const st = getStrategy(owner);
        const d = distBetween(owner, target);
        if (d >= st.keepDistance) {
            changePlayerState(owner, Engage);
            return;
        }

        // Prefer continuous combat footing; fall back to simple step-away
        const dest =
            pickCombatMoveTile(
                owner,
                target,
                {
                    keepDistance: st.keepDistance,
                    standingCounter: owner.standingCounter || 0,
                    battleWP: owner.battleWP || null
                },
                ctx.tileMap
            ) || repositionTile(owner, target, st.keepDistance, ctx.tileMap);

        if (
            dest &&
            (dest.x !== owner.tile.x ||
                dest.y !== owner.tile.y ||
                String(dest.z) !== String(owner.tile.z))
        ) {
            const moved = stepToward(owner, dest, ctx.tileMap);
            noteCombatStanding(owner, moved);
        } else {
            // Can't step away — fight in place
            changePlayerState(owner, Engage);
        }
    },
    exit() {}
};

const Flee = {
    id: 'flee',
    enter(owner) {
        owner.inBattle = false;
    },
    execute(owner, ctx) {
        if (!owner.alive) return;
        // Prefer heal while fleeing so HP can recover above flee threshold
        if (maybeHeal(owner, ctx)) return;
        const st = getStrategy(owner);
        // Recovered enough → return to route
        if (hpPercent(owner) > st.fleeHpPercent + 0.1) {
            clearCombat(owner);
            changePlayerState(
                owner,
                owner.isLeader ? ReturnToRoute : FollowLeader
            );
            return;
        }

        const threat =
            owner._fleeThreat ||
            findNearest(owner, nearbyEnemies(owner, ctx));
        const tile = fleeTile(owner, threat, ctx.tileMap);
        if (tile) {
            stepToward(owner, tile, ctx.tileMap);
        } else if (!owner.routeComplete) {
            stepWaypoint(owner, ctx);
        }
    },
    exit(owner) {
        owner._fleeThreat = null;
    }
};

const ReturnToRoute = {
    id: 'return_to_route',
    enter(owner) {
        clearCombat(owner);
        owner.path = [];
    },
    execute(owner, ctx) {
        if (!owner.alive) return;
        if (maybeHeal(owner, ctx)) return;
        if (maybeFlee(owner, ctx)) return;
        if (maybeStartCombat(owner, ctx)) return;

        if (owner.routeComplete) {
            // Idle at end of route; still react to hostiles
            return;
        }

        if (!owner.isLeader) {
            changePlayerState(owner, FollowLeader);
            return;
        }

        changePlayerState(owner, FollowWaypoint);
        stepWaypoint(owner, ctx);
    },
    exit() {}
};

/**
 * Initial state for a player based on role.
 * @param {object} player
 * @returns {object}
 */
function initialPlayerState(player) {
    return player && player.isLeader ? FollowWaypoint : FollowLeader;
}

module.exports = {
    FollowWaypoint,
    FollowLeader,
    Engage,
    Reposition,
    Flee,
    ReturnToRoute,
    initialPlayerState,
    changePlayerState,
    clearCombat,
    setTarget,
    maybeHeal,
    combatMove
};
