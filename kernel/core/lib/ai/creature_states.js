/**
 * Creature hunt AI states (Stage 5 + creature kit port).
 * Idle → Aggro/Attack ↔ Retarget → Leash (home / despawn).
 *
 * Combat uses creature_kit: multi-attack table, weighted target strategies,
 * ideal stand-off (targetDistance) and low-HP flee posture (runHealth*).
 */

const { Settings } = require('../../../settings.js');
const { isValidTarget, distBetween } = require('./targeting.js');
const {
    stepToward,
    stepRandomAdjacent,
    pickMeleeMoveTile,
    pickCombatMoveTile,
    fleeTile,
    tryMeleeCircleStep
} = require('./combat_actions.js');
const {
    ensureCreatureKit,
    pickCreatureTarget,
    tryCreatureAttacks,
    idealStandDistance,
    loseTargetDistance,
    maxAttackRange,
    applyThreatDecay,
    armStrategyRetarget,
    clearStrategyRetarget,
    strategyRetargetDue,
    isPartyOwnedSummon
} = require('./creature_kit.js');

/**
 * Target candidate pool for creature AI.
 * Party-owned summons fight wild hostiles (ctx.enemies), not the party.
 * @param {object} owner
 * @param {object} ctx
 * @returns {{ list: object[], index: object|null|undefined }}
 */
function aggroPool(owner, ctx) {
    const c = ctx || {};
    if (isPartyOwnedSummon(owner, c.sim)) {
        return {
            list: c.enemies || [],
            index: c.creatureIndex || null
        };
    }
    return {
        list: c.players || [],
        index: c.playerIndex || null
    };
}
const {
    circleAttemptDue,
    armCircleRetry,
    clearCircleRetry
} = require('./cadence.js');
const { tileDistance } = require('../movement.js');

function leashRange() {
    return Settings.AI_CREATURE_LEASH != null ? Settings.AI_CREATURE_LEASH : 18;
}

/**
 * Max home distance at which a leashing creature may re-aggro.
 * LEASH − margin (floored at 0). Margin 0 keeps a single threshold.
 * @returns {number}
 */
function leashReaggroRange() {
    const leash = leashRange();
    const margin =
        Settings.AI_CREATURE_LEASH_REAGGRO_MARGIN != null
            ? Settings.AI_CREATURE_LEASH_REAGGRO_MARGIN
            : 2;
    return Math.max(0, leash - Math.max(0, margin));
}

function changeCreatureState(owner, next) {
    if (!owner.brain) return;
    owner.brain.changeState(next);
    owner.aiState = owner.brain.getNameOfCurrentState();
}

function clearTarget(owner) {
    owner.targetId = null;
    owner.target = null;
    clearCircleRetry(owner);
    clearStrategyRetarget(owner);
}

function setTarget(owner, t) {
    if (!t) {
        clearTarget(owner);
        return;
    }
    owner.targetId = t.id;
    owner.target = t;
}

function homeTile(owner) {
    return owner.homeTile || owner.spawnTile || null;
}

function beyondLeash(owner) {
    const home = homeTile(owner);
    if (!home || !owner.tile) return false;
    if (String(home.z) !== String(owner.tile.z)) return true;
    return tileDistance(owner.tile, home) > leashRange();
}

/**
 * True when the creature has walked far enough toward home that re-aggro
 * is safe (inside the leash hysteresis band, not on the exit edge).
 * @param {object} owner
 * @returns {boolean}
 */
function insideLeashReaggro(owner) {
    const home = homeTile(owner);
    if (!home || !owner.tile) return false;
    if (String(home.z) !== String(owner.tile.z)) return false;
    return tileDistance(owner.tile, home) <= leashReaggroRange();
}

function ensureKit(owner) {
    return ensureCreatureKit(owner);
}

function resolveTarget(owner, ctx) {
    if (owner.target && isValidTarget(owner, owner.target)) {
        const lose = loseTargetDistance(owner);
        if (distBetween(owner, owner.target) > lose) {
            clearTarget(owner);
            return null;
        }
        return owner.target;
    }
    if (owner.targetId != null && ctx.sim && ctx.sim.getEntityById) {
        const t = ctx.sim.getEntityById(owner.targetId);
        if (isValidTarget(owner, t)) {
            const lose = loseTargetDistance(owner);
            if (distBetween(owner, t) > lose) {
                clearTarget(owner);
                return null;
            }
            owner.target = t;
            return t;
        }
    }
    clearTarget(owner);
    return null;
}

/**
 * Approach / hold / back-off relative to ideal stand distance.
 *
 * Low-HP flee only raises ideal stand-off (`idealStandDistance` →
 * `fleeTargetDistance`). It must not force endless retreat: while d < want
 * back off, while d > want close in, while d === want hold (melee may orbit).
 *
 * Path failure while sticky target is valid: random adjacent step **without**
 * clearing target (legacy AttackTarget). Lose target is floor change or
 * distance > loseTargetDistance (default 10) in resolveTarget.
 *
 * @param {object} owner
 * @param {object} target
 * @param {object} ctx
 */
function combatMove(owner, target, ctx) {
    if (!owner || !target || !ctx || !ctx.tileMap) return;
    if (!(owner.speed > 0)) return;
    if (owner.canStep && !owner.canStep()) return;

    const want = idealStandDistance(owner);
    const d = distBetween(owner, target);
    const rng = ctx.rng;

    if (d < want) {
        // Too close for current posture (melee hug, ranged kite, or flee stand-off)
        const tile =
            fleeTile(owner, target, ctx.tileMap) ||
            pickCombatMoveTile(
                owner,
                target,
                {
                    keepDistance: want,
                    standingCounter: owner.standingCounter || 0
                },
                ctx.tileMap
            );
        if (
            tile &&
            (tile.x !== owner.tile.x || tile.y !== owner.tile.y)
        ) {
            if (!stepToward(owner, tile, ctx.tileMap)) {
                stepRandomAdjacent(owner, ctx.tileMap, rng);
            }
        }
        return;
    }

    if (d > want) {
        // Close to ideal stand-off: melee uses adjacent pathing; ranged walks toward.
        // No path / blocked step → randomMove, keep target.
        let moved = false;
        if (want <= 1) {
            const dest = pickMeleeMoveTile(owner, target, ctx.tileMap);
            if (dest) moved = stepToward(owner, dest, ctx.tileMap);
            else moved = stepToward(owner, target.tile, ctx.tileMap);
        } else {
            const dest = pickCombatMoveTile(
                owner,
                target,
                {
                    keepDistance: want,
                    standingCounter: owner.standingCounter || 0
                },
                ctx.tileMap
            );
            if (
                dest &&
                (dest.x !== owner.tile.x || dest.y !== owner.tile.y)
            ) {
                moved = stepToward(owner, dest, ctx.tileMap);
            } else {
                moved = stepToward(owner, target.tile, ctx.tileMap);
            }
        }
        if (!moved) {
            stepRandomAdjacent(owner, ctx.tileMap, rng);
        }
        return;
    }

    // d === want: hold and cast. Melee (want ≤ 1) may circle around the player.
    if (want <= 1 && d <= 1) {
        tryMeleeCircleStep(owner, target, ctx.tileMap, {
            rng,
            isDue: () => circleAttemptDue(owner),
            onNoMove: () => armCircleRetry(owner)
        });
    }
}

/**
 * Attack-only pass for engaged creatures (sticky target).
 * Used when moveDelay gates the full FSM so kit CDs still tick and spells
 * can fire while the body is mid-step / kiting away.
 *
 * @param {object} owner
 * @param {object} ctx
 * @returns {{ fired: boolean, attackId?: string }|null}
 */
function tryEngagedAttacks(owner, ctx) {
    if (!owner || !owner.alive) return null;
    ensureKit(owner);
    const target = resolveTarget(owner, ctx);
    if (!target) return null;
    return tryCreatureAttacks(owner, target, ctx);
}

/**
 * Shared combat tick: attack kit then move (legacy AttackTarget order).
 * @param {object} owner
 * @param {object} ctx
 * @returns {'ok'|'no_target'|'leash'}
 */
function runCombatTick(owner, ctx) {
    if (!owner.alive) return 'no_target';
    ensureKit(owner);

    if (beyondLeash(owner)) return 'leash';

    // Age threat table even while sticky so damage-strategy re-rolls see decay.
    applyThreatDecay(owner);

    const pool = aggroPool(owner, ctx);
    let target = resolveTarget(owner, ctx);
    if (!target) {
        target = pickCreatureTarget(owner, pool.list, {
            rng: ctx.rng,
            index: pool.index
        });
        if (target) {
            setTarget(owner, target);
            // Full interval before first mid-combat strategy re-roll.
            armStrategyRetarget(owner);
        }
    } else if (strategyRetargetDue(owner)) {
        // flags.retargetIntervalSec / AI_CREATURE_RETARGET_INTERVAL: re-apply
        // weighted strategiesTarget without requiring lose-target first.
        const next = pickCreatureTarget(owner, pool.list, {
            rng: ctx.rng,
            index: pool.index
        });
        if (next) {
            setTarget(owner, next);
            target = next;
        }
    }
    if (!target) return 'no_target';

    setTarget(owner, target);

    // Attack before movement (legacy) — casting is not blocked by moveDelay;
    // combatMove itself no-ops when canStep() is false.
    tryCreatureAttacks(owner, target, ctx);

    // Still valid after hits?
    if (!isValidTarget(owner, target)) {
        clearTarget(owner);
        return 'no_target';
    }

    combatMove(owner, target, ctx);
    return 'ok';
}

const Idle = {
    id: 'idle',
    enter(owner) {
        clearTarget(owner);
        owner.path = [];
        ensureKit(owner);
    },
    execute(owner, ctx) {
        if (!owner.alive) return;
        ensureKit(owner);
        // Static / speed 0 training dummies never aggro
        if (owner.speed <= 0 && owner.aggro === false) return;
        if (owner.aggro === false) return;

        const idlePool = aggroPool(owner, ctx);
        const t = pickCreatureTarget(owner, idlePool.list, {
            rng: ctx.rng,
            index: idlePool.index
        });
        if (t) {
            setTarget(owner, t);
            armStrategyRetarget(owner);
            changeCreatureState(owner, Aggro);
            return;
        }

        // Optional wander (flags.idleWander) — off by default so corridor hunts stay stable
        if (
            owner.kit &&
            owner.kit.flags &&
            owner.kit.flags.idleWander &&
            owner.speed > 0 &&
            ctx.tileMap
        ) {
            stepRandomAdjacent(owner, ctx.tileMap, ctx.rng);
        }
    },
    exit() {}
};

const Aggro = {
    id: 'aggro',
    enter(owner) {
        ensureKit(owner);
    },
    execute(owner, ctx) {
        const status = runCombatTick(owner, ctx);
        if (status === 'leash') {
            changeCreatureState(owner, Leash);
            return;
        }
        if (status === 'no_target') {
            changeCreatureState(owner, Retarget);
            return;
        }
        // Once in weapon reach, label as Attack (telemetry / debug)
        const target = owner.target;
        if (target && distBetween(owner, target) <= maxAttackRange(owner)) {
            changeCreatureState(owner, Attack);
        }
    },
    exit() {}
};

const Attack = {
    id: 'attack',
    enter(owner) {
        ensureKit(owner);
    },
    execute(owner, ctx) {
        const status = runCombatTick(owner, ctx);
        if (status === 'leash') {
            changeCreatureState(owner, Leash);
            return;
        }
        if (status === 'no_target') {
            changeCreatureState(owner, Retarget);
            return;
        }
        const target = owner.target;
        if (
            target &&
            distBetween(owner, target) > maxAttackRange(owner) + 1
        ) {
            changeCreatureState(owner, Aggro);
        }
    },
    exit() {}
};

const Retarget = {
    id: 'retarget',
    enter() {},
    execute(owner, ctx) {
        if (!owner.alive) return;
        ensureKit(owner);
        clearTarget(owner);

        if (beyondLeash(owner)) {
            changeCreatureState(owner, Leash);
            return;
        }

        const retargetPool = aggroPool(owner, ctx);
        const t = pickCreatureTarget(owner, retargetPool.list, {
            rng: ctx.rng,
            index: retargetPool.index
        });
        if (t) {
            setTarget(owner, t);
            armStrategyRetarget(owner);
            changeCreatureState(owner, Aggro);
            return;
        }

        const home = homeTile(owner);
        if (
            home &&
            owner.tile &&
            (owner.tile.x !== home.x ||
                owner.tile.y !== home.y ||
                String(owner.tile.z) !== String(home.z))
        ) {
            changeCreatureState(owner, Leash);
        } else {
            changeCreatureState(owner, Idle);
        }
    },
    exit() {}
};

const Leash = {
    id: 'leash',
    enter(owner) {
        clearTarget(owner);
        owner.path = [];
        owner._leashTicks = 0;
    },
    execute(owner, ctx) {
        if (!owner.alive) return;
        owner._leashTicks = (owner._leashTicks || 0) + 1;

        const home = homeTile(owner);
        if (!home) {
            changeCreatureState(owner, Idle);
            return;
        }

        const despawnAfter =
            owner.despawnLeashTicks != null
                ? owner.despawnLeashTicks
                : Settings.AI_DESPAWN_LEASH_TICKS != null
                  ? Settings.AI_DESPAWN_LEASH_TICKS
                  : 0;
        if (
            despawnAfter > 0 &&
            owner._leashTicks > despawnAfter &&
            typeof ctx.sim.despawnCreature === 'function'
        ) {
            ctx.sim.despawnCreature(owner);
            return;
        }

        if (
            owner.tile &&
            owner.tile.x === home.x &&
            owner.tile.y === home.y &&
            String(owner.tile.z) === String(home.z)
        ) {
            if (owner.hp && owner.hp.max) {
                owner.hp.current = owner.hp.max;
                owner.alive = true;
            }
            changeCreatureState(owner, Idle);
            return;
        }

        if (owner.speed > 0) {
            stepToward(owner, home, ctx.tileMap);
        } else {
            changeCreatureState(owner, Idle);
        }

        // Opportunistic re-aggro only after walking deeper inside the leash
        // (hysteresis). Using the same edge as beyondLeash thrashs attack↔leash
        // when the player dances on the boundary.
        if (insideLeashReaggro(owner)) {
            ensureKit(owner);
            const leashPool = aggroPool(owner, ctx);
            const t = pickCreatureTarget(owner, leashPool.list, {
                rng: ctx.rng,
                index: leashPool.index
            });
            if (t) {
                setTarget(owner, t);
                armStrategyRetarget(owner);
                changeCreatureState(owner, Aggro);
            }
        }
    },
    exit() {}
};

function initialCreatureState() {
    return Idle;
}

module.exports = {
    Idle,
    Aggro,
    Attack,
    Retarget,
    Leash,
    initialCreatureState,
    changeCreatureState,
    runCombatTick,
    combatMove,
    tryEngagedAttacks,
    beyondLeash,
    insideLeashReaggro,
    leashReaggroRange
};
